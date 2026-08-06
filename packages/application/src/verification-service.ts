// @trustcircle/application — VERIFICATION SERVICE: enforce all nine Verified Closure Gate conditions
// and independent-verifier rules (Phase 5 / User Story 3 / FR-022, data-model "Verified Closure
// Gate").
//
// This service is the ONLY path by which an integrity case (or a repair / rollback / migration) may
// reach VERIFIED CLOSURE. It composes the injected gate FACTS into the nine `ClosureGate` results,
// applies the independence rule, and constructs a durable `VerificationRecord` whose `result` is
// `passed` ONLY when every one of the nine gates passes AND the verifier is independent. A
// source-reported `done` or a repair's own `succeeded_unverified` outcome can NEVER satisfy this
// gate: the result is a function of the checked gate facts, not of any source value.
//
// The nine gates (data-model):
//   1. originals + derivatives present and integrity-verified;
//   2. applicable rule/control tests pass against the current version;
//   3. desired ⇄ observed state reconciles with no uncertain remote outcome;
//   4. decision / policy / repair-or-rollback / custody / audit evidence complete;
//   5. no unresolved critical/high dependency blocks closure;
//   6. residual risk zero OR covered by a current approved Exception;
//   7. verifier independent of the repairer/owner where policy requires;
//   8. all tenant + central review gates current;
//   9. the closure transition + this VerificationRecord commit with an AuditEvent.
//
// The service is pure and clock-free. It grants no authority: the independence verdict and the gate
// facts are resolved elsewhere and threaded in. A failing gate leaves the subject UN-closed and is
// the honest, durable reason closure did not occur.

import { type Uuid, type EpochMillis, type TenantId, makeReason, type Reason } from '@trustcircle/domain';
import {
  makeVerificationRecord,
  verificationRecordDigest,
  verifiedClosureResult,
  CLOSURE_GATES,
  type VerificationRecord,
  type VerificationResult,
  type VerificationSubjectType,
  type VerificationType,
  type ClosureGate,
  type GateResult,
} from '@trustcircle/domain';

/** The nine boolean gate FACTS the service folds into gate results. Each maps 1:1 to a ClosureGate. */
export interface ClosureGateFacts {
  readonly originalsAndDerivativesPresent: boolean;
  readonly ruleControlTestsPass: boolean;
  readonly stateReconciledNoUncertainty: boolean;
  readonly evidenceComplete: boolean;
  readonly noUnresolvedCriticalDependency: boolean;
  readonly residualRiskZeroOrExcepted: boolean;
  readonly verifierIndependent: boolean;
  readonly tenantAndCentralReviewsCurrent: boolean;
  readonly closureTransitionAudited: boolean;
}

/** Map each gate fact to its `ClosureGate` key, preserving the canonical nine-gate order. */
const GATE_OF_FACT: Readonly<Record<ClosureGate, keyof ClosureGateFacts>> = Object.freeze({
  originals_and_derivatives_present: 'originalsAndDerivativesPresent',
  rule_control_tests_pass: 'ruleControlTestsPass',
  state_reconciled_no_uncertainty: 'stateReconciledNoUncertainty',
  evidence_complete: 'evidenceComplete',
  no_unresolved_critical_dependency: 'noUnresolvedCriticalDependency',
  residual_risk_zero_or_excepted: 'residualRiskZeroOrExcepted',
  verifier_independent: 'verifierIndependent',
  tenant_and_central_reviews_current: 'tenantAndCentralReviewsCurrent',
  closure_transition_audited: 'closureTransitionAudited',
});

export interface VerifyCommand {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly subjectType: VerificationSubjectType;
  readonly subjectId: Uuid;
  readonly subjectVersion: number;
  readonly verificationType?: VerificationType;
  readonly verifierPrincipalId: Uuid;
  readonly independenceCheckId: Uuid;
  readonly evidenceManifestId: Uuid;
  readonly ruleControlVersions?: readonly string[];
  readonly expectedState?: Record<string, unknown>;
  readonly observedState?: Record<string, unknown>;
  readonly reconciliationId?: Uuid;
  readonly dependencyCheck?: Record<string, unknown>;
  readonly residualRiskCheck?: Record<string, unknown>;
  readonly facts: ClosureGateFacts;
  readonly verifiedAt: EpochMillis;
}

export interface VerifyOutcome {
  readonly record: VerificationRecord;
  readonly result: VerificationResult;
  /** True iff the subject may transition to verified closure (result === 'passed'). */
  readonly closurePermitted: boolean;
  /** The gates that did not pass — the honest reasons closure did not occur (empty when passed). */
  readonly failingGates: readonly ClosureGate[];
}

/** Build the nine ordered gate results from the boolean facts. */
export function gateResultsFrom(facts: ClosureGateFacts): readonly GateResult[] {
  return Object.freeze(
    CLOSURE_GATES.map((gate): GateResult => {
      const pass = facts[GATE_OF_FACT[gate]];
      return Object.freeze({
        gate,
        result: (pass ? 'passed' : 'failed') as VerificationResult,
      });
    }),
  );
}

/**
 * Verify a subject against the Verified Closure Gate. Produces exactly one durable
 * `VerificationRecord`. The record's `result` is computed by the domain oracle
 * (`verifiedClosureResult`) from the gate facts + independence — never asserted by the caller — so a
 * `passed` result provably means all nine gates held and the verifier was independent.
 */
export function verifyClosure(cmd: VerifyCommand): VerifyOutcome {
  const gateResults = gateResultsFrom(cmd.facts);
  const result = verifiedClosureResult({
    gateResults,
    verifierIndependent: cmd.facts.verifierIndependent,
  });
  const failingGates = CLOSURE_GATES.filter((gate) => !cmd.facts[GATE_OF_FACT[gate]]);
  const reason: Reason =
    result === 'passed'
      ? makeReason('verified_closure', 'all nine Verified Closure Gate conditions passed with an independent verifier')
      : makeReason(
          'closure_gate_unmet',
          `verified closure withheld: ${failingGates.length} gate(s) unmet [${failingGates.join(', ') || 'independence'}]`,
        );

  const record = makeVerificationRecord({
    id: cmd.id,
    tenantId: cmd.tenantId,
    subjectType: cmd.subjectType,
    subjectId: cmd.subjectId,
    subjectVersion: cmd.subjectVersion,
    ...(cmd.verificationType !== undefined ? { verificationType: cmd.verificationType } : {}),
    verifierPrincipalId: cmd.verifierPrincipalId,
    independenceCheckId: cmd.independenceCheckId,
    verifierIndependent: cmd.facts.verifierIndependent,
    ...(cmd.ruleControlVersions !== undefined ? { ruleControlVersions: cmd.ruleControlVersions } : {}),
    evidenceManifestId: cmd.evidenceManifestId,
    ...(cmd.expectedState !== undefined ? { expectedState: cmd.expectedState } : {}),
    ...(cmd.observedState !== undefined ? { observedState: cmd.observedState } : {}),
    ...(cmd.reconciliationId !== undefined ? { reconciliationId: cmd.reconciliationId } : {}),
    ...(cmd.dependencyCheck !== undefined ? { dependencyCheck: cmd.dependencyCheck } : {}),
    ...(cmd.residualRiskCheck !== undefined ? { residualRiskCheck: cmd.residualRiskCheck } : {}),
    gateResults,
    result,
    reason,
    verifiedAt: cmd.verifiedAt,
  });

  return {
    record,
    result,
    closurePermitted: result === 'passed',
    failingGates: Object.freeze(failingGates),
  };
}

export { verificationRecordDigest };
