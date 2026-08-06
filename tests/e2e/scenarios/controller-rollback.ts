// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — CONTROLLER ROLLBACK acceptance runner (T182 · FR-028 · NS-011 · SC-010).
//
// Restoring a preserved preimage is itself a GOVERNED act that must never destroy newer legitimate work.
// This runner reads the rollback verdict off the projected OperationDetail model for the `rollback_conflict`
// scenario (whose remote holds a newer, legitimate revision) and drives the REAL `decideControllerRollback`
// application service to prove the two load-bearing rules:
//
//   * PROTECT NEWER STATE (NS-011). A rollback whose observed revision no longer matches what the operation
//     produced is REFUSED as a conflict — newer state protected, scope stays degraded, escalate. The
//     presenter surfaces `rollback_refused_newer_state`, never a plain success.
//   * VERIFIED FULL RESTORE (FR-028). Only a restoration verified by a DIRECT remote read clears an operation.
//
// The negative control is a fully-clean rollback context, which DOES clear — proving the refusal is driven
// by the drifted revision, not a blanket refusal.
//
// Pure, deterministic: the real domain/application oracle + a projected model field, never a mutation echo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import {
  decideControllerRollback,
  type ControllerRollbackContext,
} from '@trustcircle/application';

import { seedOperationDetailModel } from './_controller-inputs.ts';
import type { ControllerInputs } from './_controller-inputs.ts';

import {
  SOURCE_REVISION,
  NEWER_SOURCE_REVISION,
  uuidFromSlug,
} from '../../fixtures/controllers.ts';

export interface CriterionResult {
  readonly ref: string;
  readonly statement: string;
  readonly satisfied: boolean;
  readonly evidence: string;
  readonly observedVia: string;
  readonly negativeControl: string;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly criteria: readonly CriterionResult[];
  readonly allSatisfied: boolean;
  readonly digest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function finish(scenario: string, criteria: readonly CriterionResult[]): ScenarioResult {
  return {
    scenario,
    criteria,
    allSatisfied: criteria.every((c) => c.satisfied),
    digest: `sha256:${createHash('sha256').update(canonical(criteria)).digest('hex')}`,
  };
}

const OP_ID = uuidFromSlug('operation-rollback_conflict');
const PREIMAGE_ID = uuidFromSlug('preimage-evidence');

function cleanCtx(over: Partial<ControllerRollbackContext> = {}): ControllerRollbackContext {
  return {
    operationId: OP_ID,
    preimageEvidenceId: PREIMAGE_ID,
    producedRevision: SOURCE_REVISION,
    observedRevision: SOURCE_REVISION,
    compensatedSteps: 1,
    totalSteps: 1,
    compensationAvailable: true,
    compensationSucceeded: true,
    restorationVerified: true,
    policyAuthorizesRollback: true,
    ...over,
  };
}

export function runControllerRollbackScenario(inputs: ControllerInputs): ScenarioResult {
  const detail = seedOperationDetailModel('rollback_conflict', inputs.at);
  const verifiedSuccessDetail = seedOperationDetailModel('verified_success', inputs.at);
  const criteria: CriterionResult[] = [];

  // NS-011 — a drifted observed revision REFUSES the rollback as a conflict; newer state protected, escalate.
  const conflict = decideControllerRollback(cleanCtx({ observedRevision: NEWER_SOURCE_REVISION }));
  const clean = decideControllerRollback(cleanCtx());
  criteria.push({
    ref: 'NS-011 (protect newer state)',
    statement: 'A rollback whose observed revision drifted to a newer legitimate state is refused as a conflict — newer state protected, escalate.',
    satisfied:
      conflict.result === 'conflict' &&
      conflict.protectedNewerState === true &&
      conflict.operationCleared === false &&
      conflict.remainsDegraded === true &&
      conflict.mustEscalate === true &&
      conflict.reason === 'newer_legitimate_state_protected_escalated',
    evidence: `conflict: result=${conflict.result}, protectedNewerState=${conflict.protectedNewerState}, mustEscalate=${conflict.mustEscalate}`,
    observedVia: 'decideControllerRollback({observedRevision: NEWER_SOURCE_REVISION})',
    negativeControl: `a clean context (revisions equal) rolls back and clears (result=${clean.result}, operationCleared=${clean.operationCleared}) — the refusal is driven by the drift`,
  });

  // FR-028 — only a restoration VERIFIED by a direct remote read clears the operation.
  const unverified = decideControllerRollback(cleanCtx({ restorationVerified: false }));
  criteria.push({
    ref: 'FR-028 (verified restore only)',
    statement: 'Only a restoration verified by a direct remote read clears an operation; an unverified restore stays degraded.',
    satisfied:
      clean.result === 'rolled_back' &&
      clean.operationCleared === true &&
      clean.residualDifferences === 0 &&
      unverified.operationCleared === false &&
      unverified.remainsDegraded === true,
    evidence: `verified: cleared=${clean.operationCleared}, residual=${clean.residualDifferences}; unverified: cleared=${unverified.operationCleared}, degraded=${unverified.remainsDegraded}`,
    observedVia: 'decideControllerRollback({restorationVerified})',
    negativeControl: 'an unverified restoration never clears the operation — restoration is observation-first, like every confirmation',
  });

  // NS-011 (UI honesty) — the presenter surfaces the refusal as rollback_refused_newer_state, not success.
  criteria.push({
    ref: 'NS-011 (UI surfaces refusal)',
    statement: 'The operation detail surfaces the rollback refusal as protecting newer state, never as a plain success.',
    satisfied:
      detail.rollback.result === 'rollback_refused_newer_state' &&
      detail.rollback.reason.length > 0 &&
      detail.effectConfirmed === false,
    evidence: `rollback.result=${detail.rollback.result}; effectConfirmed=${detail.effectConfirmed}`,
    observedVia: 'OperationDetailModel(rollback_conflict).rollback.{result,reason}',
    negativeControl: `a non-rollback operation reports rollback.result='none' (verified_success → ${verifiedSuccessDetail.rollback.result}) — the refusal banner is scenario-specific`,
  });

  // Fails-closed — no preimage / unauthorized rollback never silently succeeds.
  const noPreimage = decideControllerRollback(cleanCtx({ preimageEvidenceId: null }));
  const unauthorized = decideControllerRollback(cleanCtx({ policyAuthorizesRollback: false, totalSteps: 3, compensatedSteps: 1 }));
  criteria.push({
    ref: 'NS-011 (fail closed)',
    statement: 'A rollback with no preserved preimage is unavailable; an unauthorized rollback fails closed and escalates — never a silent success.',
    satisfied:
      noPreimage.result === 'unavailable' &&
      noPreimage.reason === 'no_preserved_preimage_to_restore' &&
      unauthorized.result === 'failed' &&
      unauthorized.mustEscalate === true &&
      unauthorized.reason === 'rollback_not_policy_authorized',
    evidence: `noPreimage: result=${noPreimage.result} (${noPreimage.reason}); unauthorized: result=${unauthorized.result}, escalate=${unauthorized.mustEscalate}`,
    observedVia: 'decideControllerRollback({preimageEvidenceId:null}) + ({policyAuthorizesRollback:false})',
    negativeControl: 'the clean context succeeds — the unavailable/failed verdicts are driven by the missing preimage / missing authorization, not a blanket refusal',
  });

  return finish('controller-rollback', criteria);
}

export default runControllerRollbackScenario;
