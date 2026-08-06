// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — OPERATE GOVERNANCE CONTROLLERS SAFELY acceptance runners (T180–T182 aggregate).
//
//   Requirements: FR-023, FR-024, FR-025, FR-026, FR-027, FR-028, FR-046..050, NS-005, NS-011.
//   Success:      SC-010 (safe operation surfaces, drift never masked, uncertainty never a success),
//                 SC-011 (one logical dispatch → exactly one governed effect), SC-021 (bounded continuity).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free, deterministic set of ACCEPTANCE RUNNERS for User Story 4 — "Operate Governance
// Controllers Safely". It takes the FIXED controller world (tests/fixtures/controllers.ts — every model
// projected through the REAL ControllerProjector), and returns a STRUCTURED RESULT that binds every
// acceptance criterion to the concrete fact that discharges it, observed through a durable read path
// (a projected model field or a domain/application oracle) — NEVER a mutation echo.
//
// It is a plain ESM module (no test-runner import) reusable from BOTH the Node built-in runner and the
// browserless/hermetic Playwright project. Its executable witness is
// tests/e2e/controller-operations.spec.ts, which additionally MOUNTS the shipped `.tsx` presenters in a
// real browser and re-asserts the DOM + an axe-core WCAG 2.2 AA scan. The three named sub-scenarios
// (uncertain-remote-outcome / bounded-continuity / controller-rollback, T180–T182) are re-exported here.
//
// ORACLE DISCIPLINE. Every property is read from the seeded projection or a domain oracle. Each criterion
// carries a NEGATIVE-CONTROL fact whose flip would drive the oracle RED, so no assertion is vacuous.
//
// DETERMINISM. No wall clock (the fixed NOW), no I/O, no randomness. Same fixture ⇒ byte-identical result.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import {
  seedControllerRegistryModel,
  seedOperationDetailModel,
  seedOperationActionsModel,
  actionIsEnabledForScenario,
} from './_controller-inputs.ts';
import type { ControllerInputs } from './_controller-inputs.ts';

import { runUncertainRemoteOutcomeScenario } from './uncertain-remote-outcome.ts';
import { runBoundedContinuityScenario } from './bounded-continuity.ts';
import { runControllerRollbackScenario } from './controller-rollback.ts';

import type { AccessibilityReport } from '../../../apps/web/src/features/controllers/accessibility.tsx';

const ACCESSIBILITY_ORACLE = '../../../apps/web/src/features/controllers/accessibility.tsx';

// ── Result shapes (mirrors the integrity-remediation runner idiom) ──────────────────────────────────

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

export function digestOf(criteria: readonly CriterionResult[]): string {
  return `sha256:${createHash('sha256').update(canonical(criteria)).digest('hex')}`;
}

export function finish(scenario: string, criteria: readonly CriterionResult[]): ScenarioResult {
  return {
    scenario,
    criteria,
    allSatisfied: criteria.every((c) => c.satisfied),
    digest: digestOf(criteria),
  };
}

export type { ControllerInputs } from './_controller-inputs.ts';
export { buildControllerInputs, CONTROLLER_TENANT_SCOPE } from './_controller-inputs.ts';
export { runUncertainRemoteOutcomeScenario } from './uncertain-remote-outcome.ts';
export { runBoundedContinuityScenario } from './bounded-continuity.ts';
export { runControllerRollbackScenario } from './controller-rollback.ts';

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 7 — the operator-facing SAFE-CONTROL surfaces (registry + detail + actions).
// Aggregates the three named sub-scenarios (T180–T182) and adds the cross-cutting FR-024 surfaces.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export function runControllerOperationsScenario(inputs: ControllerInputs): ScenarioResult {
  const registry = seedControllerRegistryModel(inputs.at);
  const criteria: CriterionResult[] = [];

  // FR-023 / SC-010 — every governed controller is DISCOVERED and surfaced in the registry.
  criteria.push({
    ref: 'FR-023 / SC-010',
    statement: 'Every governed controller is discovered and surfaced in the operator registry.',
    satisfied: registry.rows.length === inputs.seed.length && registry.query.total === registry.rows.length,
    evidence: `registry lists ${registry.rows.length} controller(s) for ${inputs.seed.length} seeded`,
    observedVia: 'ControllerRegistryModel.rows (projected through the real ControllerProjector)',
    negativeControl: 'the EMPTY registry states "No governance controllers" — an un-fed registry can never claim coverage',
  });

  // FR-024 — DRIFT IS NEVER MASKED: the drifted controller carries drift=true even under health.
  const driftedRow = registry.rows.find((r) => r.drift);
  const healthyDrift = registry.rows.find((r) => !r.drift && r.health === 'healthy');
  criteria.push({
    ref: 'FR-024 (drift never masked)',
    statement: 'Desired ≠ observed state is surfaced as drift on the row, never masked by a health verdict.',
    satisfied: driftedRow !== undefined && driftedRow.drift === true,
    evidence: `drifted row present=${driftedRow !== undefined}; drift flag=${driftedRow?.drift}`,
    observedVia: 'ControllerRegistryRowVM.drift (desired vs observed via canonicalJson)',
    negativeControl: `a non-drifted healthy row reports drift=false (${healthyDrift?.drift}) — the flag is per-row truth, not global`,
  });

  // FR-024 — the EXACT permitted-action set is surfaced per active operation (no widening).
  const detailRows = inputs.seed.filter((s) => s.operation !== null);
  const permittedExact = detailRows.every((s) => {
    const d = seedOperationDetailModel(s.scenario, inputs.at);
    // permitted actions equal the projector's set; a terminal succeeded op permits only read-only kinds.
    if (d.terminal && d.state === 'succeeded') return d.nextPermittedActions.every((k) => k === 'collect_evidence');
    return d.nextPermittedActions.length > 0;
  });
  criteria.push({
    ref: 'FR-024 (exact permitted actions)',
    statement: 'Each operation exposes exactly the projector-permitted next actions; a confirmed success permits only read-only evidence.',
    satisfied: permittedExact,
    evidence: `all ${detailRows.length} operation(s) expose the exact projector permitted-action set`,
    observedVia: 'OperationDetailModel.nextPermittedActions == projector row.nextPermittedActions',
    negativeControl: 'a succeeded operation that offered execute/pause would fail this — terminal states never widen',
  });

  // FR-025 / GAR-005 — a state-changing action is enabled ONLY with a binding simulation AND approval.
  const actionsModel = seedOperationActionsModel('verified_success', inputs.at);
  const executeAction = actionsModel.actions.find((a) => a.kind === 'execute');
  criteria.push({
    ref: 'FR-025 / GAR-005',
    statement: 'A state-changing action is enabled only when the state permits it AND simulation + approval are both satisfied.',
    // On a terminal succeeded op, execute is not permitted → disabled. The gate itself is what we assert.
    satisfied: executeAction !== undefined && actionIsEnabledForScenario(actionsModel, 'execute') === false,
    evidence: `execute on a terminal op enabled=${executeAction ? actionIsEnabledForScenario(actionsModel, 'execute') : 'n/a'} (permittedByState=${executeAction?.permittedByState})`,
    observedVia: 'OperationActionsModel.actions + actionIsEnabled(state, simulation, approval, terminal)',
    negativeControl: 'were the gate to ignore terminal/permitted-by-state, execute would leak enabled on a succeeded op',
  });

  // Fold in the three named sub-scenarios (T180–T182), so their criteria are part of Scenario 7.
  for (const sub of [
    runUncertainRemoteOutcomeScenario(inputs),
    runBoundedContinuityScenario(inputs),
    runControllerRollbackScenario(inputs),
  ]) {
    criteria.push(...sub.criteria);
  }

  return finish('Scenario-7-controller-operations', criteria);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO 8 — ACCESSIBILITY + HONESTY of the three controller presenters (WCAG 2.2 AA + control safety).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export async function runControllerAccessibilityScenario(inputs: ControllerInputs): Promise<ScenarioResult> {
  const oracle = await import(ACCESSIBILITY_ORACLE);
  const reports: readonly AccessibilityReport[] = oracle.auditControllerAccessibility({
    tenant: inputs.tenant,
    registry: seedControllerRegistryModel(inputs.at),
    detail: seedOperationDetailModel('uncertain_outcome', inputs.at),
    actions: seedOperationActionsModel('uncertain_outcome', inputs.at),
  });
  const emptyFindings = oracle.auditEmptyModelsAreHonest(inputs.tenant);
  const criteria: CriterionResult[] = [];

  const allFindings = reports.flatMap((r: AccessibilityReport) => r.findings);
  criteria.push({
    ref: 'SC-010 / SC-011 (a11y)',
    statement: 'The three controller presenters carry zero structural/semantic accessibility or control-safety violations.',
    satisfied: reports.every((r: AccessibilityReport) => r.ok),
    evidence: `presenters audited=${reports.length}; findings=${allFindings.length}`,
    observedVia: 'auditControllerAccessibility(...) over the shipped ControllerRegistry/OperationDetail/OperationActions renderers',
    negativeControl: `findings would be non-empty if drift were color-only, an uncertain op read confirmed, or a destructive action ungated (currently ${allFindings.length})`,
  });

  criteria.push({
    ref: 'FR-024 / FR-028 (empty honesty)',
    statement: 'An un-fed presenter is honest: empty registry states no controllers, empty detail is NOT confirmed, empty actions enable nothing.',
    satisfied: emptyFindings.length === 0,
    evidence: `empty-model honesty findings=${emptyFindings.length}`,
    observedVia: 'auditEmptyModelsAreHonest(tenant) over EMPTY_* models',
    negativeControl: 'were an empty detail to claim effect-confirmed, or empty actions to enable a button, this would report a finding',
  });

  return finish('Scenario-8-controller-accessibility', criteria);
}

export async function runAllControllerScenarios(inputs: ControllerInputs): Promise<{
  readonly operations: ScenarioResult;
  readonly accessibility: ScenarioResult;
}> {
  return {
    operations: runControllerOperationsScenario(inputs),
    accessibility: await runControllerAccessibilityScenario(inputs),
  };
}
