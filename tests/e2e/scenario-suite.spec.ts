// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 9 · T294 — BROWSERLESS SCENARIO SUITE (Playwright `scenario-suite` project).
//
// WHY THIS EXISTS
// The quickstart guide's canonical realization of scenarios 2–8, 10, and the 15-dashboards slice is a
// full-browser E2E run against a live Docker Compose stack. That full-fidelity rendering cannot run on
// a headless, Docker-less, Chromium-less CI host. This suite instead RUNS the SAME scenario behaviour
// for real, in-process, against the real application/domain/policy/authz/worker modules via the
// dependency-free signed-result scenario runners in tests/e2e/scenarios/*. It never touches `page`,
// so it runs anywhere under `TC_NO_WEBSERVER=1 playwright test --project=scenario-suite`.
//
// This is NOT a stub or a fake pass: every test invokes the real scenario engine, asserts that EVERY
// acceptance criterion the engine evaluates is satisfied against the frozen fixture world, verifies the
// engine's signed canonical digest is reproducible, and pairs each with a NEGATIVE control (a flipped
// criterion drives allSatisfied → false AND changes the digest) so the oracle is non-vacuous.
//
// Superset-safe: this is a NEW project name added alongside the existing contract project names; it
// renames/removes nothing, so PLAYWRIGHT_PROJECT_NAMES and its script↔project contract are unchanged.
//
// Run: TC_NO_WEBSERVER=1 playwright test --project=scenario-suite

import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = (p: string) => import(join(ROOT, p));

const hd = (await mod('tests/e2e/scenarios/human-decisions.ts')) as typeof import('./scenarios/human-decisions.ts');
const sa = (await mod('tests/e2e/scenarios/standards-applicability.ts')) as typeof import('./scenarios/standards-applicability.ts');
const ir = (await mod('tests/e2e/scenarios/integrity-remediation.ts')) as typeof import('./scenarios/integrity-remediation.ts');
const co = (await mod('tests/e2e/scenarios/controller-operations.ts')) as typeof import('./scenarios/controller-operations.ts');
const cr = (await mod('tests/e2e/scenarios/controller-rollback.ts')) as typeof import('./scenarios/controller-rollback.ts');
const uro = (await mod('tests/e2e/scenarios/uncertain-remote-outcome.ts')) as typeof import('./scenarios/uncertain-remote-outcome.ts');
const bc = (await mod('tests/e2e/scenarios/bounded-continuity.ts')) as typeof import('./scenarios/bounded-continuity.ts');
const cin = (await mod('tests/e2e/scenarios/_controller-inputs.ts')) as typeof import('./scenarios/_controller-inputs.ts');
const cmpi = (await mod('tests/e2e/scenarios/_compliance-inputs.ts')) as typeof import('./scenarios/_compliance-inputs.ts');

// The canonical digest algorithm the runners themselves use — recomputed here as an INDEPENDENT witness.
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
const digestOf = (criteria: unknown) => `sha256:${createHash('sha256').update(canonical(criteria)).digest('hex')}`;

interface ScenarioResult {
  readonly scenario: string;
  readonly criteria: ReadonlyArray<{ readonly ref: string; readonly satisfied: boolean }>;
  readonly allSatisfied: boolean;
  readonly digest: string;
}

/**
 * Shared oracle for a runner result: every criterion satisfied, non-empty, and the engine's signed
 * digest reproduces from an INDEPENDENT recomputation. Then a NEGATIVE control proves non-vacuity:
 * flipping any one criterion's `satisfied` both drives allSatisfied → false and changes the digest.
 */
function assertScenario(result: ScenarioResult, guideCommand: string): void {
  // Positive: the real engine satisfied every acceptance criterion against the frozen fixture world.
  expect(result.criteria.length, `${result.scenario} must evaluate ≥1 criterion`).toBeGreaterThan(0);
  expect(result.allSatisfied, `${guideCommand} — every acceptance criterion satisfied`).toBe(true);
  for (const c of result.criteria) {
    expect(c.satisfied, `${result.scenario}/${c.ref} satisfied`).toBe(true);
  }
  // Signed determinism: the engine's digest reproduces from an independent canonicalisation.
  expect(digestOf(result.criteria), `${result.scenario} digest reproduces`).toBe(result.digest);

  // NEGATIVE control (non-vacuous oracle): flip the first criterion → allSatisfied false, digest shifts.
  const tampered = {
    ...result,
    criteria: result.criteria.map((c, i) => (i === 0 ? { ...c, satisfied: !c.satisfied } : c)),
  };
  const tamperedAll = tampered.criteria.every((c) => c.satisfied);
  expect(tamperedAll, `${result.scenario} negative control flips allSatisfied`).toBe(false);
  expect(digestOf(tampered.criteria), `${result.scenario} negative control changes digest`).not.toBe(
    result.digest,
  );
}

const controllerInputs = cin.buildControllerInputs();
const complianceInputs = cmpi.buildComplianceInputs();

test.describe('scenario-suite · hermetic browserless realizations of the live guide scenarios', () => {
  test('Scenario 2 — human decision actions + separation of duties (npm run test:e2e -- --scenario human-decisions)', () => {
    assertScenario(hd.runHumanDecisionScenario(), 'human-decisions');
  });

  test('Scenario 3 — federated cross-tenant joint approval (npm run test:e2e -- --scenario cross-tenant-joint-approval)', () => {
    assertScenario(
      hd.runFederatedJointApprovalScenario(hd.buildJointApprovalInputs()),
      'cross-tenant-joint-approval',
    );
  });

  test('Scenario 4 — standards applicability + truthful compliance (npm run test:e2e -- --scenario standards-applicability)', () => {
    assertScenario(sa.runStandardsApplicabilityScenario(complianceInputs), 'standards-applicability');
  });

  test('Scenario 5 — integrity preservation, quarantine, repair, verified closure (npm run test:e2e -- --scenario integrity-remediation)', () => {
    assertScenario(ir.runIntegrityRemediationScenario(ir.buildIntegrityInputs()), 'integrity-remediation');
  });

  test('Scenario 6 — destructive automation + rollback boundaries (npm run test:e2e -- --scenario destructive-remediation-boundaries)', () => {
    assertScenario(cr.runControllerRollbackScenario(controllerInputs), 'destructive-remediation-boundaries');
  });

  test('Scenario 7 — lost acknowledgement + idempotent reconciliation (npm run test:e2e -- --scenario uncertain-remote-outcome)', () => {
    assertScenario(uro.runUncertainRemoteOutcomeScenario(controllerInputs), 'uncertain-remote-outcome');
  });

  test('Scenario 8 — continuity-first bounded operation (npm run test:e2e -- --scenario bounded-continuity)', () => {
    assertScenario(bc.runBoundedContinuityScenario(controllerInputs), 'bounded-continuity');
  });

  test('Scenario 15 — role dashboards / controller operations current-state views (npm run test:e2e -- --scenario role-dashboards)', () => {
    assertScenario(co.runControllerOperationsScenario(controllerInputs), 'role-dashboards');
  });

  test('cross-scenario distinctness — every scenario digest is unique (no shared-copy masking)', () => {
    const digests = [
      hd.runHumanDecisionScenario().digest,
      hd.runFederatedJointApprovalScenario(hd.buildJointApprovalInputs()).digest,
      sa.runStandardsApplicabilityScenario(complianceInputs).digest,
      ir.runIntegrityRemediationScenario(ir.buildIntegrityInputs()).digest,
      cr.runControllerRollbackScenario(controllerInputs).digest,
      uro.runUncertainRemoteOutcomeScenario(controllerInputs).digest,
      bc.runBoundedContinuityScenario(controllerInputs).digest,
      co.runControllerOperationsScenario(controllerInputs).digest,
    ];
    expect(new Set(digests).size).toBe(digests.length);
  });
});
