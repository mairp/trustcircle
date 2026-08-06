// @trustcircle/application — REPAIR RECONCILIATION: reconcile the EXPECTED repair outcome with the
// authoritative CURRENT source and retain every difference (Phase 5 / User Story 3 / FR-022).
//
// After a repair executes, the desired result and the AUTHORITATIVE current source state must be
// compared field-by-field. This service performs that comparison and — critically — RETAINS EVERY
// difference it finds. A reconciliation is `reconciled` ONLY when there are zero residual
// differences AND the remote outcome is not uncertain; any residual difference or uncertainty leaves
// `reconciled=false`, which keeps the case OUT of verified closure. Uncertainty is a first-class,
// visible state (a lost acknowledgement, an ambiguous remote response) — never silently coerced to
// success.
//
// The service is pure and clock-free: it folds injected expected/observed field maps into a
// `Reconciliation` value (aligned column-for-column with the `repair_reconciliation` table and its
// `repair_reconciliation_clean` CHECK). It does not mutate the source and grants no authority.

import { type Uuid, type EpochMillis, type TenantId } from '@trustcircle/domain';
import { createHash } from 'node:crypto';

export interface FieldDifference {
  readonly field: string;
  readonly expected: unknown;
  readonly observed: unknown;
}

export interface Reconciliation {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly integrityCaseId: Uuid;
  readonly repairAttemptId: Uuid;
  readonly expectedState: Readonly<Record<string, unknown>>;
  readonly observedState: Readonly<Record<string, unknown>>;
  readonly differences: readonly FieldDifference[];
  readonly reconciled: boolean;
  readonly uncertain: boolean;
  readonly reconciledAt: EpochMillis;
}

export interface ReconcileCommand {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly integrityCaseId: Uuid;
  readonly repairAttemptId: Uuid;
  readonly expectedState: Record<string, unknown>;
  readonly observedState: Record<string, unknown>;
  /** True iff the remote outcome could not be confirmed (lost ack / ambiguous response). */
  readonly uncertain: boolean;
  readonly reconciledAt: EpochMillis;
}

function stableEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Reconcile expected vs observed source state. Computes the full set of field differences (the union
 * of keys, so a MISSING or EXTRA field is a difference too), and sets `reconciled` only when there
 * are no differences and no uncertainty. Every difference is retained on the returned value.
 */
export function reconcileRepair(cmd: ReconcileCommand): Reconciliation {
  const keys = new Set<string>([
    ...Object.keys(cmd.expectedState),
    ...Object.keys(cmd.observedState),
  ]);
  const differences: FieldDifference[] = [];
  for (const field of [...keys].sort()) {
    const expected = cmd.expectedState[field];
    const observed = cmd.observedState[field];
    if (!stableEqual(expected, observed)) {
      differences.push(Object.freeze({ field, expected, observed }));
    }
  }
  const reconciled = differences.length === 0 && !cmd.uncertain;
  return Object.freeze({
    id: cmd.id,
    tenantId: cmd.tenantId,
    integrityCaseId: cmd.integrityCaseId,
    repairAttemptId: cmd.repairAttemptId,
    expectedState: Object.freeze({ ...cmd.expectedState }),
    observedState: Object.freeze({ ...cmd.observedState }),
    differences: Object.freeze(differences),
    reconciled,
    uncertain: cmd.uncertain,
    reconciledAt: cmd.reconciledAt,
  });
}

export function reconciliationDigest(r: Reconciliation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: r.id,
        tenantId: r.tenantId,
        integrityCaseId: r.integrityCaseId,
        repairAttemptId: r.repairAttemptId,
        expectedState: r.expectedState,
        observedState: r.observedState,
        differences: r.differences,
        reconciled: r.reconciled,
        uncertain: r.uncertain,
        reconciledAt: r.reconciledAt,
      }),
    )
    .digest('hex');
}
