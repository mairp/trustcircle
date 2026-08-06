// @trustcircle/adapter-workflow-orchestration — READ-ONLY conformance drift gate (T254 / US6 / NS-005).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A PURE gate that compares the OBSERVED source surface descriptors (schema, event subjects, approval
// surface, response envelope, worker surface) against the PINNED contract and returns named DRIFT
// findings plus a `readOnlyUntilConformant` boolean. The gate keeps the adapter READ-ONLY until
// conformance evidence passes: `readOnlyUntilConformant` is TRUE whenever ANY drift exists. Drift is
// RETAINED as an explicit contract gap — never silently absorbed, never treated as compatible.
//
// Dependency-free, pure, no I/O, no wall clock. Runs under Node 22 `--experimental-strip-types`.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Surface descriptors — the pinned contract vs the observed source surface.
// ---------------------------------------------------------------------------

/** The five drift dimensions this gate detects. */
export type WorkflowDriftDimension =
  | 'schema'
  | 'subject'
  | 'approval'
  | 'response'
  | 'worker_surface';

/** A pinned/observed surface descriptor: each field is a version-pinned digest of the surface. */
export interface WorkflowSurfaceDescriptor {
  /** Digest of the request/response JSON schema the source exposes. */
  readonly schemaDigest: string;
  /** The set of AsyncAPI event subjects/topics the source publishes. */
  readonly eventSubjects: readonly string[];
  /** Digest of the approval surface descriptor (routes/fields governing approvals). */
  readonly approvalSurfaceDigest: string;
  /** Digest of the response envelope descriptor. */
  readonly responseEnvelopeDigest: string;
  /** Digest of the worker surface descriptor (worker registration/heartbeat contract). */
  readonly workerSurfaceDigest: string;
}

// ---------------------------------------------------------------------------
// Drift findings — named, deterministic, drift retained as an explicit gap.
// ---------------------------------------------------------------------------

export interface WorkflowDriftFinding {
  readonly dimension: WorkflowDriftDimension;
  /** Stable, deterministic id so the SAME drift is always the SAME id. */
  readonly findingId: string;
  readonly pinned: string;
  readonly observed: string;
  readonly reason: string;
}

export interface WorkflowConformanceGateResult {
  readonly driftFindings: readonly WorkflowDriftFinding[];
  /**
   * TRUE whenever ANY drift exists: the adapter stays READ-ONLY until conformance evidence passes.
   * The gate never activates a drifted adapter (NS-005).
   */
  readonly readOnlyUntilConformant: boolean;
}

export interface WorkflowConformanceGateInput {
  readonly pinned: WorkflowSurfaceDescriptor;
  readonly observed: WorkflowSurfaceDescriptor;
}

function findingId(dimension: WorkflowDriftDimension, pinned: string, observed: string): string {
  const digest = createHash('sha256').update([dimension, pinned, observed].join(' '), 'utf8').digest('hex');
  return `workflow-drift-${dimension.replace(/_/g, '-')}-${digest.slice(0, 32)}`;
}

/** Canonical, sorted comparison string for an event-subject set (order-insensitive). */
function subjectsKey(subjects: readonly string[]): string {
  return [...subjects].sort().join(',');
}

/**
 * Compare the observed source surface against the pinned contract. Returns named drift findings and
 * `readOnlyUntilConformant`, which is TRUE whenever any drift exists. PURE: inputs are never mutated;
 * drift is retained explicitly rather than absorbed.
 */
export function evaluateConformanceGate(
  input: WorkflowConformanceGateInput,
): WorkflowConformanceGateResult {
  const { pinned, observed } = input;
  const findings: WorkflowDriftFinding[] = [];

  const scalarChecks: readonly {
    readonly dimension: WorkflowDriftDimension;
    readonly pinned: string;
    readonly observed: string;
    readonly reason: string;
  }[] = [
    {
      dimension: 'schema',
      pinned: pinned.schemaDigest,
      observed: observed.schemaDigest,
      reason: 'The source request/response schema digest differs from the pinned contract.',
    },
    {
      dimension: 'approval',
      pinned: pinned.approvalSurfaceDigest,
      observed: observed.approvalSurfaceDigest,
      reason: 'The source approval surface digest differs from the pinned contract.',
    },
    {
      dimension: 'response',
      pinned: pinned.responseEnvelopeDigest,
      observed: observed.responseEnvelopeDigest,
      reason: 'The source response envelope digest differs from the pinned contract.',
    },
    {
      dimension: 'worker_surface',
      pinned: pinned.workerSurfaceDigest,
      observed: observed.workerSurfaceDigest,
      reason: 'The source worker surface digest differs from the pinned contract.',
    },
  ];

  for (const check of scalarChecks) {
    if (check.pinned !== check.observed) {
      findings.push(
        Object.freeze({
          dimension: check.dimension,
          findingId: findingId(check.dimension, check.pinned, check.observed),
          pinned: check.pinned,
          observed: check.observed,
          reason: check.reason,
        }),
      );
    }
  }

  // Event subject drift (order-insensitive set comparison).
  const pinnedSubjects = subjectsKey(pinned.eventSubjects);
  const observedSubjects = subjectsKey(observed.eventSubjects);
  if (pinnedSubjects !== observedSubjects) {
    findings.push(
      Object.freeze({
        dimension: 'subject',
        findingId: findingId('subject', pinnedSubjects, observedSubjects),
        pinned: pinnedSubjects,
        observed: observedSubjects,
        reason: 'The source event subjects differ from the pinned contract subjects.',
      }),
    );
  }

  return Object.freeze({
    driftFindings: Object.freeze(findings),
    readOnlyUntilConformant: findings.length > 0,
  });
}
