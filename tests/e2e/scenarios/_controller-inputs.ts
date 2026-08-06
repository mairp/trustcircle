// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 6 · User Story 4 — shared CONTROLLER SCENARIO INPUTS (node-safe fixture bridge).
//
// The controller acceptance runners (controller-operations.ts + the three named T180–T182 files) all
// project the SAME fixed world (tests/fixtures/controllers.ts) into read models and read durable facts
// off them. This module builds that shared input bundle ONCE and re-exports the fixture's model builders
// so every runner reads byte-identical inputs.
//
// NODE-SAFETY. tests/fixtures/controllers.ts imports the shipped `.tsx` presenter TYPES only (type-only
// imports are erased by Node's `--experimental-strip-types` loader), never their runtime — so this bridge
// and the raw-node manifest emitter that consumes it stay `.tsx`-free at module-eval time. The `.tsx`
// accessibility ORACLE is loaded lazily, only inside the accessibility runner (which runs under vitest /
// the vitest emitter, both of which handle `.tsx`). See tests/e2e/scenarios/controller-operations.ts.
//
// DETERMINISM. The fixed clock NOW, no I/O, no randomness. Same fixture ⇒ byte-identical inputs.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import {
  NOW,
  TENANT,
  iso,
  uuidFromSlug,
  seedControllers,
  type ControllerScenarioSpec,
} from '../../fixtures/controllers.ts';

import type { EpochMillis } from '@trustcircle/domain';
import type { TenantScope } from '../../../apps/web/src/app/layout.tsx';
import type {
  OperationActionsModel,
  OperationActionVM,
  OperationKind,
} from '../../../apps/web/src/features/controllers/OperationActions.tsx';

export {
  seedControllers,
  seedControllerRegistryModel,
  seedOperationDetailModel,
  seedOperationActionsModel,
} from '../../fixtures/controllers.ts';
export type { ControllerScenarioSpec, ControllerScenarioName } from '../../fixtures/controllers.ts';

/**
 * The tenant-scope banner the three presenters render into. Constructed from the fixture's fixed
 * TENANT + clock so it is deterministic and carries no wall-clock timestamp. Mirrors the integrity
 * fixture's TENANT_SCOPE shape (the `TenantScope` contract from apps/web/src/app/layout.tsx).
 */
export const CONTROLLER_TENANT_SCOPE: TenantScope = {
  tenantId: String(TENANT),
  tenantName: 'Home Tenant',
  bundleId: 'bundle-controllers-001',
  semanticHash: 'sha256:controllers-fixture-bundle',
  workItemId: String(uuidFromSlug('controller-work-item-scope')),
  generatedAt: iso(NOW),
};

/** The shared input bundle every controller runner reads from. */
export interface ControllerInputs {
  readonly at: EpochMillis;
  readonly tenant: TenantScope;
  readonly seed: readonly ControllerScenarioSpec[];
}

/** Build the shared controller input bundle (deterministic; the fixed clock by default). */
export function buildControllerInputs(at: EpochMillis = NOW): ControllerInputs {
  return {
    at,
    tenant: CONTROLLER_TENANT_SCOPE,
    seed: seedControllers(),
  };
}

/**
 * Re-derive an action's ENABLED verdict from the model WITHOUT importing the `.tsx` runtime `actionIsEnabled`
 * (which would drag a `.tsx` into the node-safe emitter path). This is byte-identical to the presenter's
 * `actionIsEnabled(a, terminal)` rule (OperationActions.tsx): permittedByState AND not-terminal AND
 * (read-only OR (simulation AND approval)). Kept here so runners can assert the gate on the node path.
 */
export function actionIsEnabledForVM(a: OperationActionVM, terminal: boolean): boolean {
  if (terminal) return false;
  if (!a.permittedByState) return false;
  if (a.stateChanging && !(a.simulationSatisfied && a.approvalSatisfied)) return false;
  return true;
}

/** Convenience: look up one action kind in a model and return its enabled verdict. */
export function actionIsEnabledForScenario(
  model: OperationActionsModel,
  kind: OperationKind,
): boolean {
  const a = model.actions.find((x) => x.kind === kind);
  if (a === undefined) throw new Error(`action kind ${kind} not present in model`);
  return actionIsEnabledForVM(a, model.terminal);
}
