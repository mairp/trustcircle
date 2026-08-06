// @trustcircle/adapter-workflow-orchestration — read-only workflow snapshot + event client
// (T253 / US6 / FR-036..FR-042).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// Produces PINNED workflow snapshots and ingests workflow events THROUGH THE OWNING OpenAPI (HTTP)
// and AsyncAPI (event) SURFACES — supplied as INJECTED ports. It NEVER touches PostgreSQL or any
// database directly: the ports are explicitly HTTP/event seams so this module performs no real I/O,
// no wall-clock reads (callers pass `observedAt`), and no `Math.random`. It is testable offline with
// in-memory ports, exactly like the wiggum snapshot pattern.
//
// NO DIRECT DATABASE ACCESS. The workflow orchestration source OWNS its PostgreSQL store; this
// adapter reads only its published HTTP snapshot surface and its published event stream, so it can
// never read partial/uncommitted state or bypass the source's own authority boundary.
//
// LOAD-BEARING SAFETY INVARIANT: A CONNECTOR IS NEVER GRANTED GOVERNANCE AUTHORITY. Snapshots and
// events yield ONE ordered raw view of run/step state; the adapter never approves, gates, or closes.
//
// Dependency-free (Node built-in `crypto` only): pure, no I/O, no wall clock. Runs under Node 22
// `--experimental-strip-types`.

import { createHash } from 'node:crypto';

import type { ObservationEnvelope, Semver } from '@trustcircle/adapter-sdk';

// ---------------------------------------------------------------------------
// Pinned adapter identity.
// ---------------------------------------------------------------------------

export const WORKFLOW_ADAPTER_ID = 'workflow-orchestration';
export const WORKFLOW_SOURCE_CLASS = 'workflow_orchestration';
export const WORKFLOW_SCHEMA_MAJOR = 1;

// ---------------------------------------------------------------------------
// Raw workflow shapes — exactly what the OWNING OpenAPI surface returns. Read-only.
// ---------------------------------------------------------------------------

/** A raw run snapshot from the owning HTTP surface. `status` is the source's own vocabulary. */
export interface RawWorkflowRun {
  readonly runId: string;
  /** The raw run status — preserved verbatim, never interpreted as approval/closure. */
  readonly status: string;
  readonly programId?: string;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly revision: string;
  readonly aggregateSequence: number | null;
  readonly steps: readonly RawWorkflowStep[];
}

export interface RawWorkflowStep {
  readonly stepId: string;
  readonly runId: string;
  /** The raw step status — preserved verbatim. */
  readonly status: string;
  readonly attempts: number;
  readonly workerId?: string;
  readonly heartbeatAt?: number | null;
  readonly agentId?: string;
  readonly agentRole?: string;
  readonly revision: string;
  readonly aggregateSequence: number | null;
}

/** A raw event from the owning AsyncAPI stream. Ordering is by aggregateSequence. */
export interface RawWorkflowEvent {
  readonly eventId: string;
  readonly runId: string;
  readonly stepId?: string;
  readonly kind: string;
  readonly aggregateSequence: number | null;
  readonly occurredAt: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// The injected OWNING-surface ports (HTTP snapshot + event stream; NEVER a DB).
// ---------------------------------------------------------------------------

/** The read-only OpenAPI (HTTP) snapshot seam. No direct PostgreSQL access. */
export interface WorkflowSnapshotPort {
  readonly getRun: (runId: string) => Promise<RawWorkflowRun>;
}

/** The read-only AsyncAPI event seam. Drains already-collected ordered events. No direct DB. */
export interface WorkflowEventPort {
  readonly readEvents: (
    runId: string,
    sinceSequence: number | null,
  ) => Promise<readonly RawWorkflowEvent[]>;
}

// ---------------------------------------------------------------------------
// Observation payloads — RAW data, never a governance conclusion.
// ---------------------------------------------------------------------------

export interface WorkflowRunObservationPayload {
  readonly runId: string;
  readonly rawStatus: string;
  readonly programId: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly steps: readonly WorkflowStepObservationPayload[];
}

export interface WorkflowStepObservationPayload {
  readonly stepId: string;
  readonly runId: string;
  readonly rawStatus: string;
  readonly attempts: number;
  readonly workerId: string | null;
  readonly heartbeatAt: number | null;
  readonly agentId: string | null;
  readonly agentRole: string | null;
}

export interface WorkflowEventObservationPayload {
  readonly eventId: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly kind: string;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>> | null;
}

// ---------------------------------------------------------------------------
// Canonicalization + digest.
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** SHA-256 hex digest over the canonicalized value. */
export function payloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function seal<T>(env: Omit<ObservationEnvelope<T>, 'payloadDigest'>): ObservationEnvelope<T> {
  return Object.freeze({
    ...env,
    payloadDigest: payloadDigest(env.payload),
  }) as ObservationEnvelope<T>;
}

// ---------------------------------------------------------------------------
// The read-only client — PURE over the injected ports.
// ---------------------------------------------------------------------------

export interface WorkflowClientInput {
  readonly runId: string;
  readonly adapterVersion: Semver;
  /** Injected — this module never reads the wall clock. */
  readonly observedAt: number;
  readonly sinceSequence?: number | null;
}

/** One ordered raw view of a workflow run: its pinned snapshot + the events that follow it. */
export interface WorkflowReadResult {
  readonly run: ObservationEnvelope<WorkflowRunObservationPayload>;
  readonly events: readonly ObservationEnvelope<WorkflowEventObservationPayload>[];
}

function stepPayload(step: RawWorkflowStep): WorkflowStepObservationPayload {
  return {
    stepId: step.stepId,
    runId: step.runId,
    rawStatus: step.status,
    attempts: step.attempts,
    workerId: step.workerId ?? null,
    heartbeatAt: step.heartbeatAt ?? null,
    agentId: step.agentId ?? null,
    agentRole: step.agentRole ?? null,
  };
}

/**
 * Read a pinned workflow snapshot + its following events through the OWNING HTTP + event surfaces,
 * yielding ONE ordered raw view. No direct PostgreSQL access; no approval/closure inferred; raw run
 * and step statuses are preserved verbatim.
 */
export async function readWorkflowRun(
  snapshotPort: WorkflowSnapshotPort,
  eventPort: WorkflowEventPort,
  input: WorkflowClientInput,
): Promise<WorkflowReadResult> {
  const { runId, adapterVersion, observedAt } = input;
  const sinceSequence = input.sinceSequence ?? null;

  const rawRun = await snapshotPort.getRun(runId);
  const rawEvents = await eventPort.readEvents(runId, sinceSequence);

  const run = seal({
    adapterId: WORKFLOW_ADAPTER_ID,
    adapterVersion,
    sourceClass: WORKFLOW_SOURCE_CLASS,
    sourceRevision: rawRun.revision,
    aggregateRef: `run/${rawRun.runId}`,
    sequence: rawRun.aggregateSequence ?? 0,
    schemaMajor: WORKFLOW_SCHEMA_MAJOR,
    observedAt,
    dedupKey: `run:${rawRun.runId}:${rawRun.revision}`,
    payload: {
      runId: rawRun.runId,
      rawStatus: rawRun.status,
      programId: rawRun.programId ?? null,
      startedAt: rawRun.startedAt,
      finishedAt: rawRun.finishedAt,
      steps: rawRun.steps.map(stepPayload),
    } satisfies WorkflowRunObservationPayload,
  });

  // One ordered view: events sorted by aggregateSequence (nulls last, stable by eventId).
  const orderedEvents = [...rawEvents].sort((a, b) => {
    if (
      a.aggregateSequence !== null &&
      b.aggregateSequence !== null &&
      a.aggregateSequence !== b.aggregateSequence
    ) {
      return a.aggregateSequence - b.aggregateSequence;
    }
    if (a.aggregateSequence === null && b.aggregateSequence !== null) return 1;
    if (a.aggregateSequence !== null && b.aggregateSequence === null) return -1;
    if (a.occurredAt !== b.occurredAt) return a.occurredAt - b.occurredAt;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });

  const events = orderedEvents.map((ev) =>
    seal({
      adapterId: WORKFLOW_ADAPTER_ID,
      adapterVersion,
      sourceClass: WORKFLOW_SOURCE_CLASS,
      sourceRevision: ev.eventId,
      aggregateRef: `run/${ev.runId}`,
      sequence: ev.aggregateSequence ?? 0,
      schemaMajor: WORKFLOW_SCHEMA_MAJOR,
      observedAt,
      dedupKey: `run:${ev.runId}:event:${ev.eventId}`,
      payload: {
        eventId: ev.eventId,
        runId: ev.runId,
        stepId: ev.stepId ?? null,
        kind: ev.kind,
        occurredAt: ev.occurredAt,
        payload: ev.payload ?? null,
      } satisfies WorkflowEventObservationPayload,
    }),
  );

  return Object.freeze({ run, events: Object.freeze(events) });
}
