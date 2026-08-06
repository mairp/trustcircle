// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — UNCERTAIN REMOTE OUTCOME acceptance runner (T180 · FR-028 · SC-010 · SC-011).
//
// The cardinal honesty invariant of safe controller operation: an ACKNOWLEDGEMENT IS NOT A SUCCESS.
// When a dispatch times out or is severed, the remote effect is UNKNOWN — the operation is `reconciling`,
// its confirmation banner reads NOT confirmed, and it surfaces AWAITING RECONCILIATION until a DIRECT
// remote observation establishes (or refutes) the effect. A duplicate effect (>1) is surfaced, never
// hidden (SC-011). This runner reads those verdicts off the projected OperationDetail model for the
// `uncertain_outcome` scenario and contrasts them against the `verified_success` scenario, whose effect
// WAS directly observed — the negative control that proves the honesty flag is scenario-truth, not a
// global default.
//
// Pure, deterministic: every fact is a projected model field, never a mutation echo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import { seedOperationDetailModel } from './_controller-inputs.ts';
import type { ControllerInputs } from './_controller-inputs.ts';

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

export function runUncertainRemoteOutcomeScenario(inputs: ControllerInputs): ScenarioResult {
  const uncertain = seedOperationDetailModel('uncertain_outcome', inputs.at);
  const confirmed = seedOperationDetailModel('verified_success', inputs.at);
  const criteria: CriterionResult[] = [];

  // FR-028 — an uncertain latest outcome is NOT confirmed, and IS awaiting reconciliation.
  criteria.push({
    ref: 'FR-028 (uncertainty ≠ success)',
    statement: 'A timed-out/severed dispatch is not confirmed and surfaces awaiting-reconciliation — an acknowledgement is never a success.',
    satisfied:
      uncertain.latestOutcomeUncertain === true &&
      uncertain.effectConfirmed === false &&
      uncertain.awaitingReconciliation === true &&
      uncertain.state === 'reconciling',
    evidence: `state=${uncertain.state}, latestOutcomeUncertain=${uncertain.latestOutcomeUncertain}, effectConfirmed=${uncertain.effectConfirmed}, awaitingReconciliation=${uncertain.awaitingReconciliation}`,
    observedVia: 'OperationDetailModel(uncertain_outcome).{latestOutcomeUncertain,effectConfirmed,awaitingReconciliation,state}',
    negativeControl: `the verified_success op IS confirmed (effectConfirmed=${confirmed.effectConfirmed}, awaitingReconciliation=${confirmed.awaitingReconciliation}) — confirmation is scenario-truth, not a default`,
  });

  // FR-028 — the confirmed success WAS established by a DIRECT remote observation (not an ack).
  criteria.push({
    ref: 'FR-028 (observation-first)',
    statement: 'The only confirmed operation is one whose effect a reconciliation established from a direct remote observation.',
    satisfied:
      confirmed.effectConfirmed === true &&
      confirmed.state === 'succeeded' &&
      confirmed.reconciliation !== null &&
      confirmed.reconciliation.usedRemoteObservation === true &&
      confirmed.reconciliation.establishedState === true &&
      confirmed.reconciliation.observedEffectCount === 1,
    evidence: `confirmed: usedRemoteObservation=${confirmed.reconciliation?.usedRemoteObservation}, establishedState=${confirmed.reconciliation?.establishedState}, observedEffectCount=${confirmed.reconciliation?.observedEffectCount}`,
    observedVia: 'OperationDetailModel(verified_success).reconciliation.{usedRemoteObservation,establishedState,observedEffectCount}',
    negativeControl: `the uncertain op's reconciliation established nothing (establishedState=${uncertain.reconciliation?.establishedState ?? 'n/a'}) — no observation, no success`,
  });

  // FR-028 — the uncertain op's reconciliation is explicitly STILL uncertain (no established state, count 0).
  criteria.push({
    ref: 'FR-028 (still uncertain)',
    statement: 'While uncertain, the reconciliation region reports no established state and zero observed effects.',
    satisfied:
      uncertain.reconciliation !== null &&
      uncertain.reconciliation.establishedState === false &&
      uncertain.reconciliation.observedEffectCount === 0 &&
      uncertain.reconciliation.usedRemoteObservation === false,
    evidence: `uncertain reconciliation: establishedState=${uncertain.reconciliation?.establishedState}, observedEffectCount=${uncertain.reconciliation?.observedEffectCount}`,
    observedVia: 'OperationDetailModel(uncertain_outcome).reconciliation.{establishedState,observedEffectCount,usedRemoteObservation}',
    negativeControl: 'were the reconciliation to claim establishedState=true with no observation, this would fail — state is never inferred',
  });

  // SC-011 — one logical dispatch is exactly one governed effect: no duplicate is masked in either scenario.
  criteria.push({
    ref: 'SC-011 (one effect)',
    statement: 'Neither the uncertain nor the confirmed operation reports a duplicate effect — one dispatch is exactly one effect, and any duplicate would be surfaced.',
    satisfied:
      (uncertain.reconciliation === null || uncertain.reconciliation.duplicateEffect === false) &&
      (confirmed.reconciliation === null || confirmed.reconciliation.duplicateEffect === false) &&
      (confirmed.reconciliation?.observedEffectCount ?? 0) <= 1,
    evidence: `confirmed observedEffectCount=${confirmed.reconciliation?.observedEffectCount ?? 0}; duplicateEffect uncertain=${uncertain.reconciliation?.duplicateEffect ?? false}/confirmed=${confirmed.reconciliation?.duplicateEffect ?? false}`,
    observedVia: 'OperationDetailModel.reconciliation.{duplicateEffect,observedEffectCount}',
    negativeControl: 'the OperationDetail presenter renders a duplicate-effect warning when duplicateEffect=true — a duplicate can never be hidden',
  });

  return finish('uncertain-remote-outcome', criteria);
}

export default runUncertainRemoteOutcomeScenario;
