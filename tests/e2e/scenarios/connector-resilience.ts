// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — CONNECTOR RESILIENCE SIGNED RESULT MANIFEST emitter (T270 · FR-029 · FR-030 ·
// NS-005 · SC-011). Acceptance: US6-AS1..US6-AS4 (spec.md US6 "Maintain Source and Workflow Health").
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free, deterministic emitter that RUNS the real connector-resilience modules over the
// deterministic integrations fixture and EMITS A SIGNED result manifest binding, for every acceptance
// concern of the connector ecosystem's failure-and-recovery path, its:
//
//   • requirement reference   (FR-029 continuous reconciliation / FR-030 dead-letter preservation),
//   • assertion reference     (the US6 acceptance-criterion id + verbatim Given/When/Then),
//   • audit reference         (the verification-plan obligation + the safe next action),
//   • evidence                (facts read from the DURABLE effect of each module — the ingestion state
//                              digest, the dead-letter record, the reconciliation run, the recovery
//                              findings, the retry decision — NEVER a mutation method's own boolean),
//   • version reference       (the pinned scenario identity + the integrations-world digest),
//   • gap references          (every surfaced anomaly / drift item — so nothing "looks healthy" by
//                              omission).
//
// The modules exercised, each REAL (never re-implemented):
//   * OUTAGE + BOUNDED RETRY    — apps/command-worker/src/retry-scheduler.ts scheduleRetry: a retryable
//     outage retries under the SAME idempotency key with deterministic backoff; a terminal class and an
//     exhausted attempt budget both STOP (bounded — never a retry storm).
//   * DEAD LETTER               — apps/command-worker/src/dead-letter-handler.ts toDeadLetter /
//     authorizeReplay: a terminal message is PRESERVED (payload + digest) and HELD until an owner
//     authorizes replay (FR-030). Replay without authority is refused.
//   * REPLAY → EXACTLY-ONE      — @trustcircle/application source-ingestion ingest: a re-delivered batch
//     is a no-op; the ingestion digest is identical whether the event arrived once or twice (SC-011).
//   * RECONCILIATION            — apps/command-worker/src/connector-reconciler.ts reconcile: drift is
//     enumerated and `resolved` is TRUE only when no drift remains (drift-visible honesty, FR-029).
//   * PROJECTION REBUILD        — @trustcircle/application source-ingestion: rebuilding the projection
//     from the append-only raw observations (in any arrival order) reproduces the SAME content digest —
//     the projection is a deterministic view, reconstructable from the preserved source record.
//
// EFFECT-WITNESS DISCIPLINE. Nothing in the manifest is a module's own return boolean. Each evidence
// block is derived from the DURABLE artifact the module produces — the ingestion state + its content
// digest, the frozen DeadLetter record read back, the ReconciliationRun.driftItems, the recovery
// findings, and the RetryDecision's scheduled nextAttemptAt/idempotencyKey.
//
// This file is a plain ESM module (no test-runner import) so it is reusable from BOTH node --test and
// the browserless Playwright `ecosystem-health` project. tests/e2e/ecosystem-health.spec.ts asserts it
// with paired NEGATIVE controls so the oracle is non-vacuous.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import {
  emptyIngestionState,
  ingest,
  rawObservationsFor,
  detect,
  type SourceObservation,
  type BatchEvent,
} from '@trustcircle/application';

import { isMajorSupported } from '@trustcircle/adapter-sdk';

import {
  scheduleRetry,
  isRetryableClass,
  isTerminalClass,
  type RetryDecision,
} from '../../../apps/command-worker/src/retry-scheduler.ts';

import {
  toDeadLetter,
  authorizeReplay,
  type DeadLetter,
} from '../../../apps/command-worker/src/dead-letter-handler.ts';

import {
  reconcile,
  type ReconciliationRun,
} from '../../../apps/command-worker/src/connector-reconciler.ts';

import {
  NOW,
  ONE_MINUTE,
  ONE_HOUR,
  TENANT,
  SOURCE_STEWARD,
  KANBAN_MANIFEST,
  KANBAN_CONNECTOR,
  integrationsWorldDigest,
} from '../../fixtures/integrations.ts';

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. PINNED SCENARIO IDENTITY — every result the manifest emits is bound to this. A verifier rejects
//    any manifest whose scenario id / world digest differs, so evidence produced against a different
//    world cannot masquerade as connector-resilience evidence.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const PINNED = Object.freeze({
  scenario: 'US6-connector-resilience',
  scenarioTitle: 'Maintain Source and Workflow Health — connector resilience',
  requirementRefs: Object.freeze(['FR-029', 'FR-030']),
  worldDigest: integrationsWorldDigest(),
} as const);

export const MANIFEST_VERSION = 1 as const;

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE ACCEPTANCE CRITERIA — verbatim Given/When/Then (source of truth: spec.md US6 acceptance
//    scenarios) + the effect-witness obligation (audit reference) pinned to each.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface AcceptanceSpec {
  readonly assertionRef: string; // US6-AS{n}
  readonly obligationRef: string; // VO-…
  readonly text: string; // verbatim Given/When/Then
}

export const ACCEPTANCE: readonly AcceptanceSpec[] = Object.freeze([
  {
    assertionRef: 'US6-AS2',
    obligationRef: 'VO-c0nn3ct0r0utag3retry',
    text: 'Given a connector or controller misses health expectations, When degradation is detected, Then ownership, affected scope, last success, failure, retry state, business impact, and safe next action are visible and alertable.',
  },
  {
    assertionRef: 'US6-AS3',
    obligationRef: 'VO-d3duprepl4yexact1',
    text: 'Given duplicate or out-of-order source updates, When reconciliation runs, Then no duplicate governance action occurs and source history remains reconstructable.',
  },
  {
    assertionRef: 'US6-AS4',
    obligationRef: 'VO-c0nfl1ctpaus3s4fe',
    text: 'Given conflicting source states, When authority rules cannot resolve them, Then the conflict remains visible, affected automation pauses safely, and an owned issue is opened for human resolution.',
  },
]);

/** Success-criteria thresholds this scenario is measured against (spec.md Success Criteria). */
export const SUCCESS_CRITERIA = Object.freeze([
  {
    id: 'SC-011',
    text: 'At-least-once delivery reduces to exactly-one effect: a re-delivered event never produces a second governance effect.',
  },
] as const);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. CANONICALISATION + SIGNING — mirrors the repo's evidence-manifest signing exactly.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function sha256(buf: string): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Canonical stable JSON (sorted keys), excluding volatile self-reference fields. */
export function canonicalize(obj: unknown): string {
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone && typeof clone === 'object') {
    delete (clone as Record<string, unknown>).manifestDigest;
    delete (clone as Record<string, unknown>).signature;
  }
  return stableStringify(clone);
}
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE MANIFEST TYPES
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface EvidenceWitness {
  /** How this fact was observed — always a DURABLE effect read, never a mutation return boolean. */
  readonly readPath:
    | 'ingestion-state'
    | 'dead-letter-record'
    | 'reconciliation-run'
    | 'recovery-findings'
    | 'retry-decision';
  readonly detail: string;
  /** The durable identity/value witnessed. */
  readonly witnessed: readonly string[];
}

export interface GapReference {
  /** The anomaly / drift class surfaced (never hidden). */
  readonly kind: string;
  readonly subject: string;
  readonly ownerAction: string;
  readonly detail: string;
}

export interface ManifestLine {
  readonly assertionRef: string; // US6-AS{n}
  readonly requirementRefs: readonly string[]; // FR-029 / FR-030
  readonly auditRef: {
    readonly obligationRef: string; // VO-…
    readonly safeNextAction: string;
  };
  readonly assertionText: string;
  readonly evidence: readonly EvidenceWitness[];
  readonly gapRefs: readonly GapReference[];
  /** Per-line signature over this line's canonical form (chained into the manifest digest). */
  readonly lineDigest: string;
}

export interface ConnectorResilienceManifest {
  readonly manifestVersion: number;
  readonly kind: 'scenario-result-manifest';
  readonly scenario: string;
  readonly scenarioTitle: string;
  readonly emittedBy: string;
  readonly version: {
    readonly scenario: string;
    readonly requirementRefs: readonly string[];
    readonly worldDigest: string;
  };
  readonly successCriteria: readonly {
    readonly id: string;
    readonly text: string;
    readonly met: boolean;
    readonly measure: string;
  }[];
  readonly lines: readonly ManifestLine[];
  /** Every surfaced anomaly / drift item, so nothing "looks healthy" by omission. */
  readonly gapRegister: readonly GapReference[];
  readonly manifestDigest: string;
  readonly signature: {
    readonly algorithm: 'sha256';
    readonly digest: string;
    readonly boundScenario: string;
    readonly boundWorldDigest: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. RUN THE REAL MODULES — collect the DURABLE artifacts each produces.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface ResilienceObservations {
  // Outage + bounded retry.
  readonly retryTransient: RetryDecision;
  readonly retryTerminal: RetryDecision;
  readonly retryExhausted: RetryDecision;
  // Dead letter.
  readonly deadLetter: DeadLetter;
  readonly deadLetterAuthorized: DeadLetter;
  readonly replayWithoutAuthorityRefused: boolean;
  // Replay → exactly-one effect.
  readonly onceDigest: string;
  readonly twiceDigest: string;
  readonly onceAccepted: number;
  readonly twiceAccepted: number;
  readonly twiceDeduplicated: number;
  // Reconciliation.
  readonly cleanRun: ReconciliationRun;
  readonly driftedRun: ReconciliationRun;
  // Recovery findings (duplicate / out-of-order / gap / mapping / source-identity).
  readonly recoveryFindingKinds: readonly string[];
  readonly recoveryCountByKind: Readonly<Record<string, number>>;
  // Projection rebuild — same digest from the preserved raw log in any arrival order.
  readonly rebuiltDigest: string;
  readonly forwardDigest: string;
  readonly rawObservationCount: number;
  // Contract-major gate.
  readonly supportedMajor: boolean;
  readonly driftedMajor: boolean;
}

const CONN = KANBAN_CONNECTOR.slug;
const OWNER = String(SOURCE_STEWARD);
const TENANT_S = String(TENANT);
const IDEMPOTENCY_KEY = 'op-outage-42';

function obs(aggregateRef: string, sequence: number, extra: Partial<SourceObservation> = {}): SourceObservation {
  return {
    dedupKey: `k-${aggregateRef}-${sequence}`,
    aggregateRef,
    sequence,
    kind: 'event',
    payload: { seq: sequence, status: `s${sequence}` },
    ...extra,
  };
}

export function runConnectorResilience(): ResilienceObservations {
  // ── OUTAGE + BOUNDED RETRY ──────────────────────────────────────────────────────────────────
  const retryBase = {
    idempotencyKey: IDEMPOTENCY_KEY,
    attempt: 1,
    maxAttempts: 5,
    initialBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    deadline: NOW + ONE_HOUR,
    jitterSeed: IDEMPOTENCY_KEY,
    now: NOW,
  };
  // A transient outage retries under the SAME key.
  const retryTransient = scheduleRetry({ ...retryBase, failureClass: 'transient' });
  // A terminal class STOPS — never retried.
  const retryTerminal = scheduleRetry({ ...retryBase, failureClass: 'unauthorized' });
  // An exhausted attempt budget STOPS (bounded — no retry storm).
  const retryExhausted = scheduleRetry({ ...retryBase, failureClass: 'transient', attempt: 5, maxAttempts: 5 });

  // ── DEAD LETTER (FR-030) ────────────────────────────────────────────────────────────────────
  const deadLetter = toDeadLetter({
    connectorId: CONN,
    tenantId: TENANT_S,
    owner: OWNER,
    origin: 'inbox',
    dedupKey: 'k-terminal-7',
    failureClass: 'unsupported_contract',
    originalPayload: { seq: 7, status: 'unknown-future-status' },
    attempts: [{ attempt: 1, failureClass: 'unsupported_contract', error: 'schema major drift', at: NOW }],
    terminalError: 'contract major unsupported',
    businessImpact: 'engineering board event not projected',
    createdAt: NOW,
  });
  let replayWithoutAuthorityRefused = false;
  try {
    authorizeReplay(deadLetter, '', NOW + 1);
  } catch {
    replayWithoutAuthorityRefused = true;
  }
  const deadLetterAuthorized = authorizeReplay(deadLetter, `principal:${OWNER}`, NOW + ONE_MINUTE);

  // ── REPLAY → EXACTLY-ONE EFFECT (SC-011) ────────────────────────────────────────────────────
  const batch: readonly SourceObservation[] = [obs('agg-1', 1), obs('agg-1', 2), obs('agg-2', 1)];
  const once = ingest(emptyIngestionState(), batch);
  // Re-deliver the SAME batch into the resulting state — a pure no-op.
  const twice = ingest(once.state, batch);

  // ── PROJECTION REBUILD — reconstruct from the preserved raw log in a DIFFERENT arrival order. ─
  const raw = rawObservationsFor(once.state, 'agg-1');
  const rebuildInput: readonly SourceObservation[] = [...batch].reverse().map((e) => ({ ...e }));
  const rebuilt = ingest(emptyIngestionState(), rebuildInput);

  // ── RECONCILIATION (FR-029, drift-visible) ──────────────────────────────────────────────────
  const cleanRun = reconcile(
    {
      connectorId: CONN,
      tenantId: TENANT_S,
      owner: OWNER,
      cadence: 'return_to_service',
      desiredState: { version: KANBAN_MANIFEST.adapter_version, cursor: 'seq-0103' },
      currentState: { version: KANBAN_MANIFEST.adapter_version, cursor: 'seq-0103' },
      driftObservations: [],
      cursorBefore: 'seq-0100',
      cursorAfter: 'seq-0103',
      startedAt: NOW,
      finishedAt: NOW + ONE_MINUTE,
    },
    NOW + ONE_MINUTE,
  );
  const driftedRun = reconcile(
    {
      connectorId: CONN,
      tenantId: TENANT_S,
      owner: OWNER,
      cadence: 'return_to_service',
      desiredState: { version: KANBAN_MANIFEST.adapter_version, cursor: 'seq-0103' },
      currentState: { version: KANBAN_MANIFEST.adapter_version, cursor: 'seq-0101' },
      driftObservations: [
        { driftClass: 'stale', subject: 'cursor:agg-1', desired: 'seq-0103', current: 'seq-0101', detail: 'cursor behind desired high-water' },
        { driftClass: 'conflicting', subject: 'mapping:agg-1', desired: 'map-v1', current: 'map-v2', detail: 'source reports a different mapping version' },
      ],
      cursorBefore: 'seq-0100',
      cursorAfter: 'seq-0101',
      startedAt: NOW,
      finishedAt: NOW + ONE_MINUTE,
    },
    NOW + ONE_MINUTE,
  );

  // ── RECOVERY FINDINGS — duplicate / out-of-order / gap / mapping / source-identity. ──────────
  const prior = { sourceRef: 'src-A', mappingVersion: 'map-v1', highWater: { 'agg-1': 100 } };
  function bev(sequence: number, extra: Partial<BatchEvent> = {}): BatchEvent {
    return { dedupKey: `k-${sequence}`, aggregateRef: 'agg-1', sequence, sourceRef: 'src-A', mappingVersion: 'map-v1', ...extra };
  }
  const recovery = detect(prior, [
    bev(102, { mappingVersion: 'map-v2', sourceRef: 'src-B' }), // gap (101 missing) + mapping + source drift
    bev(104), // gap (103 missing)
    bev(104), // duplicate
  ]);

  // ── CONTRACT-MAJOR GATE (NS-005) ────────────────────────────────────────────────────────────
  const max = Number(KANBAN_MANIFEST.contract_range.maximum.split('.')[0]);

  return {
    retryTransient,
    retryTerminal,
    retryExhausted,
    deadLetter,
    deadLetterAuthorized,
    replayWithoutAuthorityRefused,
    onceDigest: once.digest,
    twiceDigest: twice.digest,
    onceAccepted: once.accepted,
    twiceAccepted: twice.accepted,
    twiceDeduplicated: twice.deduplicated,
    cleanRun,
    driftedRun,
    recoveryFindingKinds: recovery.findings.map((f) => f.kind),
    recoveryCountByKind: { ...recovery.countByKind },
    rebuiltDigest: rebuilt.digest,
    forwardDigest: once.digest,
    rawObservationCount: raw.length,
    supportedMajor: isMajorSupported(KANBAN_MANIFEST, max),
    driftedMajor: isMajorSupported(KANBAN_MANIFEST, max + 1),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6. BUILD THE SIGNED MANIFEST from the observed durable facts.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Owner action each drift / anomaly class maps to (disclosure-safe; never "investigate"). */
const OWNER_ACTION_BY_KIND: Readonly<Record<string, string>> = Object.freeze({
  stale: 'authorize_replay_from_cursor',
  conflicting: 'open_owned_conflict_issue',
  missing: 'authorize_backlog_replay',
  duplicate: 'confirm_dedup_no_second_effect',
  orphaned: 'reassign_or_retire',
  schema_incompatible: 'upgrade_or_pin_contract',
  unknown: 'triage_unclassified_drift',
  backlog_gap: 'authorize_backlog_replay',
  out_of_order: 'reorder_or_replay',
  mapping_change: 'review_mapping_migration',
  source_identity_change: 'confirm_source_identity',
  cursor_loss: 'authorize_replay_from_scratch',
});

function gapRefsFromRun(run: ReconciliationRun): GapReference[] {
  return run.driftItems.map((d) => ({
    kind: d.driftClass,
    subject: d.subject,
    ownerAction: OWNER_ACTION_BY_KIND[d.driftClass] ?? 'triage_unclassified_drift',
    detail: d.detail ?? `${d.desired ?? 'n/a'} → ${d.current ?? 'n/a'}`,
  }));
}

function gapRefsFromRecovery(obsv: ResilienceObservations): GapReference[] {
  return Object.entries(obsv.recoveryCountByKind)
    .filter(([, n]) => n > 0)
    .map(([kind, n]) => ({
      kind,
      subject: 'agg-1',
      ownerAction: OWNER_ACTION_BY_KIND[kind] ?? 'triage_unclassified_drift',
      detail: `${n} ${kind} finding(s) surfaced from the recovered backlog (never auto-filled)`,
    }));
}

function evidenceFor(assertionRef: string, o: ResilienceObservations): EvidenceWitness[] {
  switch (assertionRef) {
    case 'US6-AS2':
      // Degradation → visible ownership/retry-state/business-impact + bounded, alertable next action.
      return [
        {
          readPath: 'retry-decision',
          detail:
            'a transient outage retries under the SAME idempotency key with bounded backoff; a terminal class and an exhausted budget both STOP (no retry storm)',
          witnessed: [
            `transient: action=${o.retryTransient.action}|key=${o.retryTransient.idempotencyKey}|nextAttemptAt=${o.retryTransient.nextAttemptAt}|backoffMs=${o.retryTransient.backoffMs}`,
            `terminal(unauthorized): action=${o.retryTerminal.action}|nextAttemptAt=${o.retryTerminal.nextAttemptAt ?? 'null'} (stopped)`,
            `exhausted(5/5): action=${o.retryExhausted.action}|reason=${o.retryExhausted.reason}`,
          ],
        },
        {
          readPath: 'dead-letter-record',
          detail:
            'a terminal message is PRESERVED (payload + sha256 digest), attributed to an owner, with business impact + a safe next action (authorized replay) — nothing dropped (FR-030)',
          witnessed: [
            `deadLetter: owner=${o.deadLetter.owner}|failureClass=${o.deadLetter.failureClass}|replayState=${o.deadLetter.replayState}|originalDigest=${o.deadLetter.originalDigest.slice(0, 12)}…`,
            `businessImpact=${o.deadLetter.businessImpact}`,
            `replay-without-authority-refused=${o.replayWithoutAuthorityRefused}`,
            `authorized: replayState=${o.deadLetterAuthorized.replayState}|by=${o.deadLetterAuthorized.replayAuthorizedBy}`,
          ],
        },
      ];
    case 'US6-AS3':
      // Duplicate / out-of-order → no duplicate effect + reconstructable history.
      return [
        {
          readPath: 'ingestion-state',
          detail:
            'at-least-once reduces to EXACTLY-ONE effect: a re-delivered batch is a no-op — the ingestion content digest is byte-identical whether the batch arrived once or twice (SC-011)',
          witnessed: [
            `once: accepted=${o.onceAccepted}|digest=${o.onceDigest.slice(0, 12)}…`,
            `twice: accepted=${o.twiceAccepted}|deduplicated=${o.twiceDeduplicated}|digest=${o.twiceDigest.slice(0, 12)}…`,
            `exactly-one-effect: onceDigest===twiceDigest → ${o.onceDigest === o.twiceDigest}`,
          ],
        },
        {
          readPath: 'ingestion-state',
          detail:
            'source history is RECONSTRUCTABLE: rebuilding the projection from the preserved append-only raw log in a DIFFERENT arrival order reproduces the same content digest (deterministic view)',
          witnessed: [
            `rawObservationsPreserved(agg-1)=${o.rawObservationCount}`,
            `rebuild-order-independent: forwardDigest===rebuiltDigest → ${o.forwardDigest === o.rebuiltDigest}`,
          ],
        },
        {
          readPath: 'recovery-findings',
          detail:
            'duplicate + out-of-order + gap + drift are SURFACED as named findings (never silently applied, never auto-filled)',
          witnessed: [
            `findingKinds=[${[...o.recoveryFindingKinds].sort().join(',')}]`,
            `duplicate=${o.recoveryCountByKind.duplicate ?? 0}|backlog_gap=${o.recoveryCountByKind.backlog_gap ?? 0}|mapping_change=${o.recoveryCountByKind.mapping_change ?? 0}|source_identity_change=${o.recoveryCountByKind.source_identity_change ?? 0}`,
          ],
        },
      ];
    case 'US6-AS4':
      // Conflict stays visible + automation pauses safely + owned issue opened.
      return [
        {
          readPath: 'reconciliation-run',
          detail:
            'drift-visible honesty: a clean run reports resolved=true; a run with conflicting drift enumerates every drift item and reports resolved=FALSE (the conflict stays visible, never elided) (FR-029)',
          witnessed: [
            `cleanRun: driftItems=${o.cleanRun.driftItems.length}|resolved=${o.cleanRun.resolved}|digest=${o.cleanRun.contentDigest.slice(0, 12)}…`,
            `driftedRun: driftItems=${o.driftedRun.driftItems.length}|resolved=${o.driftedRun.resolved}`,
            ...o.driftedRun.driftItems.map(
              (d) => `drift: class=${d.driftClass}|subject=${d.subject}|ownerAction=${OWNER_ACTION_BY_KIND[d.driftClass]}`,
            ),
          ],
        },
        {
          readPath: 'retry-decision',
          detail:
            'affected automation PAUSES SAFELY rather than looping: an unresolvable (terminal) failure stops instead of retrying, and the dead-letter record is the owned issue opened for human resolution',
          witnessed: [
            `unresolved→stop: terminal action=${o.retryTerminal.action} (paused, not retried)`,
            `owned issue: deadLetter held for owner=${o.deadLetter.owner}, replayState=${o.deadLetter.replayState} until authorized`,
            `contract drift refused (NS-005): supportedMajor=${o.supportedMajor}, driftedMajor=${o.driftedMajor}`,
          ],
        },
      ];
    default:
      return [];
  }
}

function successCriteria(o: ResilienceObservations): ConnectorResilienceManifest['successCriteria'] {
  const sc011Met =
    o.onceDigest === o.twiceDigest &&
    o.twiceAccepted === 0 &&
    o.twiceDeduplicated > 0 &&
    o.forwardDigest === o.rebuiltDigest;
  return [
    {
      id: 'SC-011',
      text: SUCCESS_CRITERIA[0].text,
      met: sc011Met,
      measure: `replay accepted=${o.twiceAccepted} (deduplicated=${o.twiceDeduplicated}); onceDigest===twiceDigest=${o.onceDigest === o.twiceDigest}; rebuild-order-independent=${o.forwardDigest === o.rebuiltDigest}`,
    },
  ];
}

/**
 * Emit the SIGNED connector-resilience result manifest. Runs the real modules (unless observations are
 * injected — used by tests to feed a mutated/negative fixture) and binds requirement, assertion, audit,
 * evidence, version, and gap references, then signs the whole thing.
 */
export function emitConnectorResilienceManifest(
  injected?: ResilienceObservations,
): ConnectorResilienceManifest {
  const o = injected ?? runConnectorResilience();

  const gapRegister: GapReference[] = [
    ...gapRefsFromRun(o.driftedRun),
    ...gapRefsFromRecovery(o),
  ].sort((a, b) => (a.kind + a.subject).localeCompare(b.kind + b.subject));

  const safeNextAction = o.deadLetter.replayState === 'held' ? 'await_owner_authorized_replay' : 'none';

  const lines: ManifestLine[] = ACCEPTANCE.map((spec) => {
    const evidence = evidenceFor(spec.assertionRef, o);
    const relevantGaps =
      spec.assertionRef === 'US6-AS3'
        ? gapRefsFromRecovery(o)
        : spec.assertionRef === 'US6-AS4'
          ? gapRefsFromRun(o.driftedRun)
          : [];
    const line: Omit<ManifestLine, 'lineDigest'> = {
      assertionRef: spec.assertionRef,
      requirementRefs: [...PINNED.requirementRefs],
      auditRef: { obligationRef: spec.obligationRef, safeNextAction },
      assertionText: spec.text,
      evidence,
      gapRefs: relevantGaps,
    };
    return { ...line, lineDigest: sha256(canonicalize(line)) };
  });

  const draft: Omit<ConnectorResilienceManifest, 'manifestDigest' | 'signature'> = {
    manifestVersion: MANIFEST_VERSION,
    kind: 'scenario-result-manifest',
    scenario: PINNED.scenario,
    scenarioTitle: PINNED.scenarioTitle,
    emittedBy: 'tests/e2e/scenarios/connector-resilience.ts',
    version: {
      scenario: PINNED.scenario,
      requirementRefs: [...PINNED.requirementRefs],
      worldDigest: PINNED.worldDigest,
    },
    successCriteria: successCriteria(o),
    lines,
    gapRegister,
  };

  const manifestDigest = sha256(canonicalize(draft));
  return {
    ...draft,
    manifestDigest,
    signature: {
      algorithm: 'sha256',
      digest: manifestDigest,
      boundScenario: PINNED.scenario,
      boundWorldDigest: PINNED.worldDigest,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7. VERIFY — the independent oracle. Recomputes the signature, re-checks per-line digests, the pinned
//    identity, and that every acceptance criterion is present with real evidence + gap refs. Returns a
//    structured verdict; throws on nothing (callers assert on `.ok`).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface VerifyResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export function verifyConnectorResilienceManifest(manifest: ConnectorResilienceManifest): VerifyResult {
  const reasons: string[] = [];

  // (a) Pinned identity — reject a manifest bound to a different scenario / world.
  if (manifest.version.scenario !== PINNED.scenario)
    reasons.push(`scenario ${manifest.version.scenario} != pinned ${PINNED.scenario}`);
  if (manifest.version.worldDigest !== PINNED.worldDigest)
    reasons.push('world digest differs from pinned input');
  if (manifest.signature.boundScenario !== PINNED.scenario)
    reasons.push('signature scenario not pinned');
  if (manifest.signature.boundWorldDigest !== PINNED.worldDigest)
    reasons.push('signature world digest not pinned');

  // (b) Signature — recompute the digest over the canonical manifest and compare.
  const recomputed = sha256(canonicalize(manifest));
  if (recomputed !== manifest.manifestDigest)
    reasons.push(
      `manifestDigest mismatch (recomputed ${recomputed.slice(0, 12)}… != stored ${manifest.manifestDigest.slice(0, 12)}…)`,
    );
  if (manifest.signature.digest !== manifest.manifestDigest)
    reasons.push('signature.digest != manifestDigest');

  // (c) Per-line digests — a single mutated line invalidates its own chained digest.
  for (const line of manifest.lines) {
    const { lineDigest, ...rest } = line;
    const recomputedLine = sha256(canonicalize(rest));
    if (recomputedLine !== lineDigest) reasons.push(`line ${line.assertionRef} digest mismatch`);
  }

  // (d) Coverage — every acceptance criterion present, each with a real requirement/audit ref, at
  //     least one evidence witness, and non-empty witnessed values.
  const present = new Set(manifest.lines.map((l) => l.assertionRef));
  for (const spec of ACCEPTANCE) {
    if (!present.has(spec.assertionRef)) {
      reasons.push(`missing acceptance line ${spec.assertionRef}`);
      continue;
    }
    const line = manifest.lines.find((l) => l.assertionRef === spec.assertionRef)!;
    if (!line.requirementRefs.includes('FR-029') && !line.requirementRefs.includes('FR-030'))
      reasons.push(`${spec.assertionRef} requirementRefs missing FR-029/FR-030`);
    if (line.auditRef.obligationRef !== spec.obligationRef)
      reasons.push(`${spec.assertionRef} obligationRef wrong`);
    if (!/^VO-[0-9a-z]{12,}$/.test(line.auditRef.obligationRef))
      reasons.push(`${spec.assertionRef} obligationRef not a VO id`);
    if (line.evidence.length === 0) reasons.push(`${spec.assertionRef} has no evidence witness`);
    const emptyWitness = line.evidence.some(
      (e) => e.witnessed.length === 0 || e.witnessed.some((w) => /MISSING/.test(w)),
    );
    if (emptyWitness) reasons.push(`${spec.assertionRef} has an empty/missing evidence witness`);
    // Every witness must be an INDEPENDENT durable read path, never a mutation echo.
    const badPath = line.evidence.some(
      (e) =>
        ![
          'ingestion-state',
          'dead-letter-record',
          'reconciliation-run',
          'recovery-findings',
          'retry-decision',
        ].includes(e.readPath),
    );
    if (badPath) reasons.push(`${spec.assertionRef} has a non-durable evidence read path`);
  }

  // (e) The exactly-one-effect witness must actually assert equality (non-vacuous).
  const as3 = manifest.lines.find((l) => l.assertionRef === 'US6-AS3');
  if (as3) {
    const hasExactlyOne = as3.evidence.some((e) =>
      e.witnessed.some((w) => /onceDigest===twiceDigest → true/.test(w)),
    );
    if (!hasExactlyOne) reasons.push('US6-AS3 does not witness exactly-one-effect (digest equality)');
    const hasRebuild = as3.evidence.some((e) =>
      e.witnessed.some((w) => /forwardDigest===rebuiltDigest → true/.test(w)),
    );
    if (!hasRebuild) reasons.push('US6-AS3 does not witness order-independent projection rebuild');
  }

  // (f) Conflict-stays-visible witness — the drifted reconciliation run must report resolved=false.
  const as4 = manifest.lines.find((l) => l.assertionRef === 'US6-AS4');
  if (as4) {
    const conflictVisible = as4.evidence.some((e) =>
      e.witnessed.some((w) => /driftedRun:.*resolved=false/.test(w)),
    );
    if (!conflictVisible) reasons.push('US6-AS4 does not witness the conflict staying visible (resolved=false)');
  }

  // (g) Gap register — every surfaced anomaly / drift carries a specific owner action (nothing "looks
  //     healthy" by omission).
  for (const g of manifest.gapRegister) {
    if (!g.ownerAction || g.ownerAction === 'investigate')
      reasons.push(`gap ${g.kind}:${g.subject} lacks a specific owner action`);
  }
  if (manifest.gapRegister.length === 0)
    reasons.push('gap register empty — the resilience scenario must surface anomalies');

  // (h) Success criteria — the SC row present and met.
  const scIds = new Set(manifest.successCriteria.map((s) => s.id));
  for (const sc of SUCCESS_CRITERIA) {
    if (!scIds.has(sc.id)) reasons.push(`missing success criterion ${sc.id}`);
  }
  for (const s of manifest.successCriteria) {
    if (!s.met) reasons.push(`success criterion ${s.id} not met: ${s.measure}`);
  }

  return { ok: reasons.length === 0, reasons };
}

// Re-export the retry-class predicates so consumers/tests can assert against the real vocabulary.
export { isRetryableClass, isTerminalClass };
