// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 5 · User Story 3 — CONTAIN & REPAIR DAMAGED WORK acceptance runners (T149).
//
//   Requirements: FR-016, FR-017, FR-018, FR-019, FR-020, FR-021, FR-022.
//   Success:      SC-006 (damaged work detected + prioritized), SC-007 (original preserved + contained),
//                 SC-008 (only bounded pre-authorized repair automates), SC-009 (closure only on an
//                 independent nine-gate verification).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free, deterministic set of ACCEPTANCE RUNNERS for User Story 3 — "Contain and Repair
// Damaged Work Safely". Each runner takes the fixed integrity projection (tests/fixtures/integrity.ts),
// exercises the SHIPPED artifacts a reviewer relies on (the domain closure oracle, the automatic-repair
// policy, and the three accessible integrity renderers via the accessibility oracle), and returns a
// STRUCTURED RESULT that binds every acceptance criterion to the concrete fact that discharges it —
// observed through a durable read path, never a mutation echo.
//
// This is a plain ESM module (no test-runner import) so it is reusable from BOTH the Node built-in
// runner AND the browserless/hermetic Playwright projects. Its executable witness is
// tests/e2e/integrity-remediation.spec.ts, which additionally MOUNTS the same renderers in a real
// browser and re-asserts the DOM (queue prioritization, preservation/containment banners, execute
// gating, closure honesty) plus an axe-core WCAG 2.2 AA scan.
//
// ORACLE DISCIPLINE. Every property an acceptance criterion names is read from the seeded projection
// or a domain/application oracle — NOT a mutating method's return value. Each runner exposes both the
// asserted fact AND a NEGATIVE-CONTROL fact whose flip would drive the oracle RED, so no assertion is
// vacuous (the spec asserts both directions).
//
// DETERMINISM. No wall clock, no I/O, no randomness. Same fixture ⇒ byte-identical result.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import { verifiedClosureResult, isAutomaticEligible } from '@trustcircle/domain';

import {
  seedIntegrity,
  seedIntegrityQueueModel,
  seedEvidenceComparisonModel,
  seedRemediationDetailModel,
  seedVerifiedClosedDetailModel,
  TENANT_SCOPE,
  type IntegrityScenarioSpec,
} from '../../fixtures/integrity.ts';
// NOTE: the accessibility oracle lives in a `.tsx` (it renders the shipped `.tsx` presenters). Node's
// built-in `--experimental-strip-types` loader refuses the `.tsx` extension, so the gate5 manifest
// EMITTER (raw node) must never load it at module-eval time. We therefore import it LAZILY, inside the
// accessibility runner only — the remediation runner + the emitter stay node-safe (fixture is `.tsx`
// type-only + domain), while the accessibility runner (spec + vitest emitter) resolves it via vitest,
// which handles `.tsx`. See tests/e2e/scenarios/_evidence/gate5/emit-manifests.mjs.
import type { AccessibilityReport } from '../../../apps/web/src/features/integrity/accessibility.tsx';

const ACCESSIBILITY_ORACLE = '../../../apps/web/src/features/integrity/accessibility.tsx';

// ── Result shapes (mirrors the human-decisions runner idiom) ──────────────────────────────────────

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

function digestOf(criteria: readonly CriterionResult[]): string {
  return `sha256:${createHash('sha256').update(canonical(criteria)).digest('hex')}`;
}

function finish(scenario: string, criteria: readonly CriterionResult[]): ScenarioResult {
  return {
    scenario,
    criteria,
    allSatisfied: criteria.every((c) => c.satisfied),
    digest: digestOf(criteria),
  };
}

function specOf(seed: readonly IntegrityScenarioSpec[], name: string): IntegrityScenarioSpec {
  const s = seed.find((x) => x.scenario === name);
  if (s === undefined) throw new Error(`seed missing scenario ${name}`);
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RUNNER 1 — DETECT · PRESERVE · CONTAIN · BOUND · CLOSE (FR-016..022, SC-006..009).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface IntegrityInputs {
  readonly seed: readonly IntegrityScenarioSpec[];
  readonly queue: ReturnType<typeof seedIntegrityQueueModel>;
  readonly comparison: ReturnType<typeof seedEvidenceComparisonModel>;
  readonly autoDetail: ReturnType<typeof seedRemediationDetailModel>;
  readonly closedDetail: ReturnType<typeof seedVerifiedClosedDetailModel>;
}

export function buildIntegrityInputs(seed: readonly IntegrityScenarioSpec[] = seedIntegrity()): IntegrityInputs {
  return {
    seed,
    queue: seedIntegrityQueueModel(seed),
    comparison: seedEvidenceComparisonModel(seed),
    autoDetail: seedRemediationDetailModel(seed),
    closedDetail: seedVerifiedClosedDetailModel(seed),
  };
}

export function runIntegrityRemediationScenario(
  inputs: IntegrityInputs = buildIntegrityInputs(),
): ScenarioResult {
  const { seed, queue, comparison, autoDetail, closedDetail } = inputs;
  const criteria: CriterionResult[] = [];

  // FR-016 / SC-006 — damaged work is DETECTED and surfaced in a PRIORITIZED queue.
  const orderedByPriority = queue.rows.every((r, i) => i === 0 || queue.rows[i - 1]!.priority >= r.priority);
  const escalatedFirst = queue.rows[0]?.needsHumanAttention === true;
  criteria.push({
    ref: 'FR-016 / SC-006',
    statement: 'Damaged governance work is detected and surfaced in a prioritized queue, highest-attention first.',
    satisfied:
      queue.rows.length === seed.length &&
      orderedByPriority &&
      escalatedFirst &&
      queue.query.visible === queue.rows.length,
    evidence: `queue lists ${queue.rows.length} case(s) in non-increasing priority; row[0] needsHumanAttention=${escalatedFirst}`,
    observedVia: 'IntegrityQueueModel.rows ordered by .priority + .needsHumanAttention',
    negativeControl: 'the verified-closed case has the lowest priority and needsHumanAttention=false — not surfaced first',
  });

  // FR-017 / SC-007 — the ORIGINAL is preserved and reported INTACT (never masqueraded).
  criteria.push({
    ref: 'FR-017 / SC-007',
    statement: 'The original of a damaged item is preserved and independently verifiable as intact.',
    satisfied:
      comparison.originalIntact === true &&
      comparison.original.contentDigest === comparison.originalVerifyDigest &&
      comparison.original.quarantined === false,
    evidence: `original intact=${comparison.originalIntact}; captured digest === verify digest (${comparison.originalVerifyDigest})`,
    observedVia: 'EvidenceComparisonModel.originalIntact + original.contentDigest vs originalVerifyDigest',
    negativeControl: 'the EMPTY comparison reports originalIntact=false — an un-fed view cannot masquerade as intact',
  });

  // FR-018 — OWNERSHIP HONESTY: the escalated case names an explicit gap (never a fabricated owner).
  const gapSpec = specOf(seed, 'unresolved_escalated');
  const gapRow = queue.rows.find((r) => r.caseId === String(gapSpec.case.id));
  criteria.push({
    ref: 'FR-018',
    statement: 'Ownership is a named owner or an explicit gap — never a fabricated owner.',
    satisfied:
      gapRow !== undefined &&
      gapRow.ownershipGap === true &&
      gapRow.ownerPrincipalId === '' &&
      gapRow.needsHumanAttention === true,
    evidence: `escalated row ownershipGap=${gapRow?.ownershipGap}, ownerPrincipalId="${gapRow?.ownerPrincipalId}"`,
    observedVia: 'IntegrityQueueModel.rows[unresolved_escalated].{ownershipGap,ownerPrincipalId}',
    negativeControl: 'the detected-preserved row has a named owner and ownershipGap=false — the gap is scenario-specific',
  });

  // FR-019 / SC-007 — QUARANTINE CONTAINS the damaged effect while keeping it inspectable.
  const qSpec = specOf(seed, 'quarantined');
  criteria.push({
    ref: 'FR-019 / SC-007',
    statement: 'A quarantine contains the damaged effect (blocks downstream use) while keeping the item inspectable.',
    satisfied:
      comparison.quarantineContains === true &&
      comparison.blockedCapabilities.length > 0 &&
      qSpec.quarantine !== null &&
      qSpec.quarantine.status === 'active',
    evidence: `containment=${comparison.quarantineContains}; blocked=[${comparison.blockedCapabilities.join(', ')}]`,
    observedVia: 'EvidenceComparisonModel.quarantineContains + .blockedCapabilities + seed.quarantine.status',
    negativeControl: 'the EMPTY comparison reports quarantineContains=false — no active quarantine, no false containment claim',
  });

  // FR-020 / FR-021 / SC-008 — only a BOUNDED, pre-authorized low-risk plan may auto-execute.
  const autoSpec = specOf(seed, 'auto_repairable');
  const needsApprovalSpec = specOf(seed, 'needs_approval');
  const autoEligible = autoSpec.plan !== null && isAutomaticEligible(autoSpec.plan);
  const approvalEligible = needsApprovalSpec.plan !== null && isAutomaticEligible(needsApprovalSpec.plan);
  const executeEnabled = autoDetail.steps.every((s) => s.preAuthorizedLowRisk) && !autoDetail.ownershipGap;
  criteria.push({
    ref: 'FR-020 / FR-021 / SC-008',
    statement: 'Only a bounded, pre-authorized low-risk plan may execute automatically; a destructive plan must not.',
    satisfied:
      autoEligible === true &&
      approvalEligible === false &&
      executeEnabled === true &&
      autoDetail.attempt.outcome === 'succeeded_unverified',
    evidence: `auto plan isAutomaticEligible=${autoEligible}; destructive plan eligible=${approvalEligible}; execute enabled=${executeEnabled}`,
    observedVia: 'domain isAutomaticEligible(plan) + RemediationDetailModel.steps[*].preAuthorizedLowRisk',
    negativeControl: 'the destructive needs-approval plan is NOT automatic-eligible — execute would be gated for it',
  });

  // FR-020 — a repair that succeeded is NOT verified-closed (it awaits independent verification).
  criteria.push({
    ref: 'FR-020',
    statement: 'A successful repair is succeeded-unverified, not closed — closure is a separate verification act.',
    satisfied:
      autoDetail.attempt.outcome === 'succeeded_unverified' &&
      autoDetail.verification.caseClosed === false &&
      autoDetail.attempt.rollbackAvailable === true,
    evidence: `attempt outcome=${autoDetail.attempt.outcome}; caseClosed=${autoDetail.verification.caseClosed}; rollbackAvailable=${autoDetail.attempt.rollbackAvailable}`,
    observedVia: 'RemediationDetailModel.attempt.outcome + .verification.caseClosed',
    negativeControl: 'the verified-closed detail carries caseClosed=true only because its verification passed',
  });

  // FR-022 / SC-009 — CLOSURE only on an INDEPENDENT nine-gate verification pass.
  const closedSpec = specOf(seed, 'verified_closed');
  const oracleClosed =
    closedSpec.verification !== null &&
    verifiedClosureResult({
      gateResults: closedSpec.verification.gateResults,
      verifierIndependent: closedSpec.verification.verifierIndependent,
    }) === 'passed';
  criteria.push({
    ref: 'FR-022 / SC-009',
    statement: 'A case is closed only when an independent verification passes all nine closure gates.',
    satisfied:
      oracleClosed === true &&
      closedDetail.verification.caseClosed === true &&
      closedDetail.verification.allGatesPassed === true &&
      closedDetail.verification.gates.length === 9 &&
      closedDetail.verification.gates.every((g) => g.passed),
    evidence: `domain verdict=passed; detail caseClosed=${closedDetail.verification.caseClosed}, gates=${closedDetail.verification.gates.length} all passed`,
    observedVia: 'domain verifiedClosureResult({gateResults,verifierIndependent}) + RemediationDetailModel.verification',
    negativeControl: 'the auto-repaired detail is NOT closed (0 gates verified) — a source-reported "done" never closes a case',
  });

  return finish('integrity-remediation', criteria);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// RUNNER 2 — ACCESSIBILITY + HONESTY of the three integrity presenters (FR-017/019/022, WCAG 2.2 AA).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export async function runIntegrityAccessibilityScenario(
  inputs: IntegrityInputs = buildIntegrityInputs(),
): Promise<ScenarioResult> {
  // Lazy — see the ACCESSIBILITY_ORACLE note above (keeps the raw-node emitter path free of `.tsx`).
  const oracle = await import(ACCESSIBILITY_ORACLE);
  const reports: readonly AccessibilityReport[] = oracle.auditIntegrityAccessibility({
    tenant: TENANT_SCOPE,
    queue: inputs.queue,
    comparison: inputs.comparison,
    detail: inputs.closedDetail,
  });
  const emptyFindings = oracle.auditEmptyModelsAreHonest(TENANT_SCOPE);
  const criteria: CriterionResult[] = [];

  const allFindings = reports.flatMap((r) => r.findings);
  criteria.push({
    ref: 'SC-006 / SC-007 / SC-009',
    statement: 'The three integrity presenters carry zero structural/semantic accessibility violations.',
    satisfied: reports.every((r) => r.ok),
    evidence: `presenters audited=${reports.length}; findings=${allFindings.length}`,
    observedVia: 'auditIntegrityAccessibility(...) over the shipped renderers',
    negativeControl: `findings would be non-empty if a state were color-only or a banner missing (currently ${allFindings.length})`,
  });

  criteria.push({
    ref: 'FR-017 / FR-022 / GAR-004',
    statement: 'An un-fed presenter is honest: not intact, not closed, execute disabled, empty queue stated.',
    satisfied: emptyFindings.length === 0,
    evidence: `empty-model honesty findings=${emptyFindings.length}`,
    observedVia: 'auditEmptyModelsAreHonest(tenant) over EMPTY_* models',
    negativeControl: 'were an empty comparison to claim intact, or an empty detail to claim closed, this would report a finding',
  });

  return finish('integrity-accessibility', criteria);
}

// ── Convenience: run both scenarios ────────────────────────────────────────────────────────────────

export async function runAllIntegrityScenarios(
  seed: readonly IntegrityScenarioSpec[] = seedIntegrity(),
): Promise<{
  readonly remediation: ScenarioResult;
  readonly accessibility: ScenarioResult;
}> {
  const inputs = buildIntegrityInputs(seed);
  return {
    remediation: runIntegrityRemediationScenario(inputs),
    accessibility: await runIntegrityAccessibilityScenario(inputs),
  };
}
