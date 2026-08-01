// @trustcircle/discovery-agent — least-privilege RUNTIME metadata discovery.
//
// Phase 68 / bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item QBY0EVXEA2226PHHBADJ6H7X7P.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// `main.ts` gives the discovery agent its GOVERNANCE machinery: least-privilege scan authorization,
// per-sweep budgets, leases, the metadata-only DISCLOSURE guard, the reconciled `SourceCatalog`, and
// the fail-visible status. What it deliberately leaves INJECTED is the actual SENSING SUBSTRATE — the
// `TargetSource` that enumerates candidate targets and the `TargetProbe` that inspects one. This
// module is that substrate for a RUNTIME boundary: it enumerates the governance-relevant runtime
// entities living on a declared host — processes, services, containers, listening ports, and the
// manifests that declare them — and reports each as a discovery observation.
//
// The runtime analogue of a "directory of markers" is a runtime ENTITY (a process / service /
// container) that advertises well-known runtime MARKERS: the workload it runs (kanban board,
// agentctl controller, workflows_orchestration engine), the manifest that declares it, the ports it
// listens on. Presence of a marker — by NAME/metadata — classifies the entity; its runtime CONTENT
// (command output, environment, logs, config bodies) is never read.
//
// ---------------------------------------------------------------------------
// THE LEAST-PRIVILEGE / NO-PROTECTED-CONTENT CONTRACT (the whole point of the phase)
// ---------------------------------------------------------------------------
// The scanner is a METADATA-ONLY sensor. It is structurally incapable of reading protected content:
//
//   1. It talks to the host ONLY through the injected `RuntimeInventoryPort`, whose surface is
//      `listEntities()` and `inspect(entityId)`. There is NO `readEnv`, no `readLogs`, no `exec`, no
//      `readManifestBody`. The scanner cannot obtain a process's environment, a container's logs, or a
//      manifest's contents even if it wanted to — the capability is simply absent. This is least
//      privilege enforced by construction, not by discipline.
//
//   2. Everything the scanner learns is RUNTIME METADATA: an entity's NAME, its kind
//      (process/service/container/port/manifest), the NAMES of the runtime markers it advertises, its
//      listening port numbers, and its last-heartbeat time. Marker NAMES (`kanban`, `agentctl`,
//      `workflows_orchestration`, a `*.service` unit, a `Containerfile`/`compose.yaml` manifest) are
//      used to CLASSIFY the entity — but their runtime CONTENT is never read. "There is an agentctl
//      controller here" is metadata; "here is what the controller's config/env says" would be content,
//      and the scanner cannot obtain it.
//
//   3. Every durable record the scanner emits flows through `toMetadataOnlyRecord` from `main.ts`,
//      the single disclosure chokepoint, and is asserted `isMetadataOnly`. An entity name / marker
//      name / location that happens to be a DSN-with-password or a secret-shaped token is redacted
//      before it is written.
//
// Because of (1)–(3), the two INDEPENDENT durable read paths of a sweep — the reconciled catalog and
// the flushed evidence sink — can be inspected afterward and shown to contain metadata only. That is
// the observable proof the phase demands.
//
// ---------------------------------------------------------------------------
// HOW IT MAPS TO THE ACCEPTANCE CRITERIA
// ---------------------------------------------------------------------------
//   AC1  A healthy discovered runtime entity renders ONCE in the catalog with ALL ten inventory facets:
//        type, source identity, owner, lifecycle state, risk, control coverage, evidence state, health,
//        last-observation time, and unresolved issues (`RuntimeSource`, one reconciled row per entity).
//   AC2  A discovered-but-unmanaged / unreachable / stale / excluded runtime component stays a VISIBLE
//        coverage gap with reason + age + impact + required owner action (`RuntimeGap`, never dropped).
//   AC3  Distinct runtime records are kept per source: the named source systems (Kanban, agentctl,
//        workflows_orchestration) each produce a SEPARATE `RuntimeRecordObservation` under one
//        correlated entity — sharing a `correlationId`, carrying per-record STATUS differences (current
//        vs stale by their own heartbeat), and DEPENDENCY edges between them.
//   AC4  A stale entity (heartbeat older than the freshness horizon, or an unreachable inspect) is
//        marked with its last-known time + confidence, and health is NOT inferred from stale data
//        (health→unknown).
//   AC5  An UNREGISTERED runtime entity inside the boundary is added to the catalog with discovery
//        evidence, a type-or-unknown classification, location, access status, sensitivity, ownership
//        status, and onboarding state.
//   AC6  A discovered entity that is unsupported / inaccessible / sensitive / unowned / excluded stays a
//        VISIBLE governed-source gap with reason, impact, owner action, and a review-or-expiry date.
//
// The module is pure/deterministic given the injected `RuntimeInventoryPort` and an explicit `now`
// epoch — no wall-clock reads, no ambient host access — so every criterion is exercised by a fixture.

import {
  toMetadataOnlyRecord,
  isMetadataOnly,
  type EpochMillis,
  type ScanScope,
  type ScanTarget,
  type TargetSource,
  type TargetProbe,
  type ProbeResult,
  type OnboardingState,
  type MetadataOnlyRecord,
} from '../main.ts';
import { looksLikeSecretValue, REDACTED_PLACEHOLDER } from '@trustcircle/observability';

// ===========================================================================
// 1. The injected, read-only RuntimeInventoryPort — the ONLY door to the host
// ===========================================================================

/** The kind of a runtime entity, as reported by the host inventory — metadata, never content. */
export const RUNTIME_ENTITY_KINDS = [
  'process',
  'service',
  'container',
  'port',
  'manifest',
  'other',
] as const;
export type RuntimeEntityKind = (typeof RUNTIME_ENTITY_KINDS)[number];

/**
 * One runtime MARKER advertised by an entity: a named, metadata-only signal (the workload the entity
 * runs, the manifest that declares it, a listening port). The scanner keys off `name` + `kind` only;
 * it never reads what is "inside" the marker.
 */
export interface RuntimeMarker {
  readonly name: string;
  readonly kind: RuntimeEntityKind;
  /**
   * Optional per-marker last-heartbeat (epoch ms) — a metadata number, never content. When present it
   * overrides the entity heartbeat for THIS marker's record, which is what lets two records under one
   * entity carry DISTINCT AC3 statuses (one `current`, one `stale`). Absent ⇒ the record inherits the
   * entity heartbeat.
   */
  readonly heartbeatMs?: EpochMillis;
}

/** One entity as seen by `listEntities` — its bare id, name, and kind. No inspection, no content. */
export interface RuntimeEntitySummary {
  readonly entityId: string;
  readonly name: string;
  readonly kind: RuntimeEntityKind;
}

/**
 * Metadata for a single entity: kind + the markers it advertises + listening ports + last heartbeat.
 * This is the deepest the scanner ever reaches. `heartbeatMs` is the source of staleness/freshness
 * (AC4); `listeningPorts` are metadata (numbers), never traffic.
 */
export interface RuntimeEntityDetail {
  readonly kind: RuntimeEntityKind;
  /** The runtime markers this entity advertises (by name/kind only). */
  readonly markers: readonly RuntimeMarker[];
  /** Listening TCP/UDP port numbers (metadata) — a discovery sweep records numbers, never payloads. */
  readonly listeningPorts: readonly number[];
  /** Last-heartbeat/observation time in epoch millis — the freshness/staleness source (AC4). */
  readonly heartbeatMs: EpochMillis;
}

/**
 * The read-only runtime capability the scanner is granted. Note what is ABSENT: there is no `readEnv`,
 * no `readLogs`, no `exec`, no `readManifestBody`, no stream. The scanner may enumerate entities and
 * inspect one entity's METADATA; it may NEVER read a process's environment, a container's logs, or a
 * manifest's body. Least privilege is expressed as a missing capability, so protected runtime content
 * is unreachable by construction — the strongest form of the no-content-inspection contract.
 *
 * `listEntities` / `inspect` may reject (permission denied, gone) — a rejection is caught and turned
 * into a fail-visible `inaccessible` gap, never a silent skip.
 */
export interface RuntimeInventoryPort {
  /** Enumerate the runtime entities on the host boundary (id + name + kind only). */
  listEntities(): Promise<readonly RuntimeEntitySummary[]>;
  /** Inspect ONE entity for its kind/markers/ports/heartbeat. Rejects if inaccessible or gone. */
  inspect(entityId: string): Promise<RuntimeEntityDetail>;
}

// ===========================================================================
// 2. Source classification from MARKER NAMES (never marker contents)
// ===========================================================================

/**
 * Well-known runtime markers whose mere PRESENCE (by name) classifies an entity as a particular
 * governance-relevant source. The scanner keys off the marker NAME only; it never inspects the
 * marker's runtime content. The classification vocabulary mirrors the named adapters the platform
 * governs (Kanban, agentctl, workflows_orchestration) plus generic container/service/manifest classes
 * and the catch-all `unknown` for an entity whose type discovery cannot determine.
 */
export const RUNTIME_MARKERS: ReadonlyArray<{
  readonly marker: string;
  readonly kind: RuntimeEntityKind;
  readonly classification: string;
}> = [
  { marker: 'kanban', kind: 'service', classification: 'kanban' },
  { marker: 'kanban-board', kind: 'service', classification: 'kanban' },
  { marker: 'agentctl', kind: 'service', classification: 'agentctl' },
  { marker: 'agentctl-controller', kind: 'process', classification: 'agentctl' },
  { marker: 'workflows_orchestration', kind: 'service', classification: 'workflows_orchestration' },
  { marker: 'workflow-engine', kind: 'service', classification: 'workflows_orchestration' },
  { marker: 'compose.yaml', kind: 'manifest', classification: 'container-manifest' },
  { marker: 'Containerfile', kind: 'manifest', classification: 'container-manifest' },
  { marker: 'Dockerfile', kind: 'manifest', classification: 'container-manifest' },
  { marker: '.service', kind: 'manifest', classification: 'service-unit' },
] as const;

/** The classification used when no marker matches — a discovered entity of an UNKNOWN type (AC5). */
export const RUNTIME_UNKNOWN_CLASSIFICATION = 'unknown' as const;

/**
 * Entity NAMES (or name substrings) that are STRUCTURALLY excluded from discovery. An excluded entity
 * is not silently skipped — it is still surfaced as an `excluded` governed-source GAP (AC6), so
 * intentional exclusion remains visible with a review date rather than disappearing.
 */
export const DEFAULT_EXCLUDED_ENTITY_NAMES: readonly string[] = [
  'systemd',
  'kthreadd',
  'kworker',
  'sandbox-probe',
] as const;

/**
 * Marker/entity NAMES (case-insensitive substrings) that signal an entity handles SENSITIVE material
 * and must be treated as a sensitive governed-source gap (AC6) — by NAME only, never by reading it.
 */
export const RUNTIME_SENSITIVE_MARKER_NAMES: readonly string[] = [
  'vault',
  'secrets',
  'credentials',
  'keystore',
  'sshd',
  'gpg-agent',
] as const;

/**
 * An OWNERSHIP marker: a marker whose presence signals the entity has a declared owner (a runtime
 * label / annotation naming the owning team — observed as a marker NAME, never its value).
 */
export const RUNTIME_OWNERSHIP_MARKERS: readonly string[] = [
  'owner-label',
  'team-annotation',
  'OWNERS',
] as const;

// ===========================================================================
// 3. Access status / sensitivity / ownership / onboarding vocab (AC5 facets)
// ===========================================================================

export const RT_ACCESS_STATUSES = ['reachable', 'inaccessible', 'excluded'] as const;
export type RtAccessStatus = (typeof RT_ACCESS_STATUSES)[number];

export const RT_SENSITIVITIES = ['normal', 'sensitive', 'restricted'] as const;
export type RtSensitivity = (typeof RT_SENSITIVITIES)[number];

export const RT_OWNERSHIP_STATUSES = ['owned', 'unowned', 'unknown'] as const;
export type RtOwnershipStatus = (typeof RT_OWNERSHIP_STATUSES)[number];

export const RT_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type RtFreshness = (typeof RT_FRESHNESS)[number];

// ---- AC1 inventory-view facets (type/owner/lifecycle/risk/coverage/evidence/health/issues) ----

/**
 * Lifecycle state of a discovered runtime entity (AC1). Derived deterministically from freshness +
 * access: a fresh, reachable entity is `active`; a stale one is `dormant`; an inaccessible one is
 * `unknown`.
 */
export const RT_LIFECYCLE_STATES = ['active', 'dormant', 'unknown'] as const;
export type RtLifecycleState = (typeof RT_LIFECYCLE_STATES)[number];

/** Risk level of a discovered entity (AC1) — a rollup of sensitivity + ownership + freshness. */
export const RT_RISK_LEVELS = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
export type RtRiskLevel = (typeof RT_RISK_LEVELS)[number];

/**
 * Control-coverage state (AC1): does the entity have the governance controls (a declared owner and a
 * recognized/supported type) that let it be governed? `covered` = owned AND supported; `partial` =
 * one present; `uncovered` = neither; `unknown` = coverage cannot be assessed (inaccessible/stale).
 */
export const RT_CONTROL_COVERAGE = ['covered', 'partial', 'uncovered', 'unknown'] as const;
export type RtControlCoverage = (typeof RT_CONTROL_COVERAGE)[number];

/**
 * Evidence state (AC1): the quality of the metadata evidence backing this observation. `attested` =
 * fresh markers were inspected; `stale-evidence` = markers exist but are past the horizon; `absent` =
 * no marker evidence could be gathered. Distinct from freshness so an inventory view can show BOTH
 * "how old" and "how well-evidenced".
 */
export const RT_EVIDENCE_STATES = ['attested', 'stale-evidence', 'absent'] as const;
export type RtEvidenceState = (typeof RT_EVIDENCE_STATES)[number];

/**
 * Health of a discovered entity (AC1/AC4). Only ever `healthy` when data is FRESH; `degraded` when a
 * governance concern (sensitive/unowned) coexists with fresh data; `unknown` whenever data is
 * stale/absent (health is NEVER inferred from stale data — AC4).
 */
export const RT_HEALTH_STATES = ['healthy', 'degraded', 'unknown'] as const;
export type RtHealthState = (typeof RT_HEALTH_STATES)[number];

/** An unresolved-issue tag (AC1): a disclosure-safe, closed-vocabulary reason an entity needs action. */
export const RT_ISSUE_TAGS = [
  'unowned',
  'sensitive',
  'restricted',
  'stale',
  'unsupported',
  'evidence-absent',
] as const;
export type RtIssueTag = (typeof RT_ISSUE_TAGS)[number];

/** Why a runtime entity is a governed-source GAP rather than a healthy source (AC2/AC6). */
export const RT_GAP_REASONS = [
  'excluded', // intentionally excluded from discovery (still visible)
  'inaccessible', // inspect rejected — unreachable
  'unsupported', // discovered but of an unsupported/unknown class
  'sensitive', // handles sensitive material — must not be auto-onboarded
  'unowned', // no declared owner
  'stale', // last heartbeat is older than the freshness horizon
] as const;
export type RtGapReason = (typeof RT_GAP_REASONS)[number];

export const RT_GAP_IMPACTS = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
export type RtGapImpact = (typeof RT_GAP_IMPACTS)[number];

// ===========================================================================
// 4. Observation records — the durable, independently-readable witnesses
// ===========================================================================

/**
 * A single MARKER observation within a discovered runtime entity. AC3: an entity's distinct markers
 * (its kanban workload, its agentctl controller, its workflows_orchestration engine) are kept as
 * SEPARATE records under one correlated entity, so the drill-down can show their distinct source
 * records and authoritative fields. Each record is metadata only — name + kind + heartbeat, never
 * runtime content.
 */
export interface RuntimeRecordObservation {
  /** The marker name that produced this record (e.g. 'kanban', 'agentctl'). */
  readonly marker: string;
  readonly kind: RuntimeEntityKind;
  readonly classification: string;
  /** Last-heartbeat time (metadata) — the authoritative freshness field for this record. */
  readonly heartbeatMs: EpochMillis;
  /**
   * AC3 correlation key: the id of the entity this record belongs to. All of an entity's records share
   * one `correlationId`, so the distinct records are provably tied together under one governed entity.
   */
  readonly correlationId: string;
  /**
   * AC3 per-record STATUS. Two records under the same entity can differ: a kanban workload heartbeat'd
   * today is `current` while an agentctl marker past the freshness horizon is `stale` — the status
   * difference is an authoritative, per-record field derived from that record's own heartbeat, not the
   * entity rollup.
   */
  readonly status: 'current' | 'stale';
  /**
   * AC3 DEPENDENCY edges: the markers this record depends on within the same entity (e.g. a
   * `workflows_orchestration` engine depends on the `agentctl` controller that drives it; an `agentctl`
   * controller depends on the `kanban` board it drives). Empty when the record has no declared
   * upstream. Correlated by classification within the entity — never a cross-source content read.
   */
  readonly dependsOn: readonly string[];
}

/**
 * A discovered runtime SOURCE — one reconciled entry per entity. Carries the full AC5 facet set:
 * discovery evidence (the marker observations), a type-or-unknown classification, location, access
 * status, sensitivity, ownership status, and onboarding state. It appears exactly ONCE per entity.
 */
export interface RuntimeSource {
  // ---- AC1 facet 1: TYPE ----------------------------------------------------
  /** The source TYPE (AC1). An explicit facet; equals `classification` (kept for the drill-down view). */
  readonly type: string;
  /** Alias of `type` retained for the classification vocabulary; identical value. */
  readonly classification: string;

  // ---- AC1 facet 2: SOURCE IDENTITY ----------------------------------------
  /** Stable identity within the boundary — the entity id. Also the catalog targetId (AC1). */
  readonly targetId: string;
  /** Explicit AC1 "source identity" facet — the disclosure-safe identity string (equals targetId). */
  readonly sourceIdentity: string;
  readonly scope: ScanScope;
  readonly location: string;
  readonly access: RtAccessStatus;
  readonly sensitivity: RtSensitivity;
  /** Listening port numbers (metadata) — part of the discovery evidence for a service/container. */
  readonly listeningPorts: readonly number[];

  // ---- AC1 facet 3: OWNER ---------------------------------------------------
  readonly ownership: RtOwnershipStatus;
  /** Explicit AC1 OWNER facet: the declared owner identity, or `null` when unowned/unknown. */
  readonly owner: string | null;

  readonly onboarding: OnboardingState;
  readonly freshness: RtFreshness;

  // ---- AC1 facet 4: LIFECYCLE STATE ----------------------------------------
  /** AC1 LIFECYCLE STATE — active/dormant/unknown, derived from freshness + access. */
  readonly lifecycleState: RtLifecycleState;

  // ---- AC1 facet 5: RISK ----------------------------------------------------
  /** AC1 RISK level — a rollup of sensitivity + ownership + freshness. */
  readonly risk: RtRiskLevel;

  // ---- AC1 facet 6: CONTROL COVERAGE ---------------------------------------
  /** AC1 CONTROL COVERAGE — covered/partial/uncovered/unknown (owner + supported-type presence). */
  readonly controlCoverage: RtControlCoverage;

  // ---- AC1 facet 7: EVIDENCE STATE -----------------------------------------
  /** AC1 EVIDENCE STATE — attested/stale-evidence/absent (quality of the metadata evidence). */
  readonly evidenceState: RtEvidenceState;

  // ---- AC1 facet 8: HEALTH --------------------------------------------------
  /** AC1 HEALTH — healthy/degraded/unknown; NEVER `healthy` unless data is fresh (AC4). */
  readonly health: RtHealthState;
  /** Confidence in [0,1]: 1 when a fresh observation exists, decayed/zeroed when stale/unknown (AC4). */
  readonly confidence: number;
  /** Whether current health may be asserted — false whenever data is stale/unknown (AC4). */
  readonly healthAssertable: boolean;

  /** Distinct marker records — the AC3 authoritative, correlated source records (discovery evidence). */
  readonly records: readonly RuntimeRecordObservation[];

  // ---- AC1 facet 9: LAST OBSERVATION TIME ----------------------------------
  /** Epoch time of THIS observation (AC1 last-observation-time). */
  readonly observedAt: EpochMillis;
  /** The newest heartbeat across this entity's records — its last-known live signal (AC4). */
  readonly lastKnownAt: EpochMillis | null;

  // ---- AC1 facet 10: UNRESOLVED ISSUES -------------------------------------
  /** AC1 UNRESOLVED ISSUES — a closed-vocabulary, disclosure-safe list; empty for a clean source. */
  readonly unresolvedIssues: readonly RtIssueTag[];

  /** The metadata-only record persisted to the durable evidence sink — never protected content. */
  readonly metadata: MetadataOnlyRecord;
}

/**
 * A discovered runtime GAP — an entity that is visible but NOT healthy: excluded, inaccessible,
 * unsupported, sensitive, unowned, or stale. AC2/AC6: it remains in the reconciled catalog with a
 * reason, an age, an impact, a required owner action, and (for governed-source gaps) a mandatory
 * review-or-expiry date — rather than appearing healthy or disappearing.
 */
export interface RuntimeGap {
  readonly targetId: string;
  readonly scope: ScanScope;
  readonly location: string;
  readonly reason: RtGapReason;
  /** Disclosure-safe detail. */
  readonly detail: string;
  readonly impact: RtGapImpact;
  /** The action an owner must take to close the gap (AC2/AC6 required owner action). */
  readonly ownerAction: string;
  /** Age of the gap in ms (now − lastKnownAt). Surfaced so a gap cannot look "fresh" forever. */
  readonly ageMs: EpochMillis;
  readonly observedAt: EpochMillis;
  /** Last-known live time for a stale gap (AC4) — null when never observed live. */
  readonly lastKnownAt: EpochMillis | null;
  /** Confidence in the last-known state [0,1] (AC4) — decayed for stale, 0 for never-seen. */
  readonly confidence: number;
  /** Governed-source gaps carry a review-or-expiry deadline (AC6). Null for pure component gaps. */
  readonly reviewBy: EpochMillis | null;
  readonly metadata: MetadataOnlyRecord;
}

/** The full result of one runtime sweep — sources + gaps together, plus a durable digest witness. */
export interface RuntimeScanReport {
  readonly boundary: string;
  readonly scope: ScanScope;
  readonly sources: readonly RuntimeSource[];
  readonly gaps: readonly RuntimeGap[];
  readonly counts: {
    readonly entitiesVisited: number;
    readonly sources: number;
    readonly gaps: number;
  };
  readonly observedAt: EpochMillis;
}

// ===========================================================================
// 5. Options
// ===========================================================================

export interface RuntimeScanOptions {
  /** The declared host boundary: an identifier for the runtime the sweep is authorized over. */
  readonly boundary: string;
  /** The least-privilege scope every discovered target is tagged with. */
  readonly scope: ScanScope;
  /** The injected read-only runtime inventory capability. */
  readonly runtime: RuntimeInventoryPort;
  /** Explicit observation time (epoch ms) — injected so the sweep is deterministic (no clock reads). */
  readonly now: EpochMillis;
  /**
   * Freshness horizon in ms. An entity whose newest marker heartbeat is older than `now − horizon` is
   * STALE: it is surfaced with last-known time + reduced confidence and its health is NOT asserted.
   */
  readonly freshnessHorizonMs: number;
  /** Entity names to treat as EXCLUDED (still surfaced as visible gaps). Defaults provided. */
  readonly excludedEntityNames?: readonly string[];
  /** Default review window (ms) added to `now` for governed-source gaps. Default 7 days. */
  readonly gapReviewWindowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ===========================================================================
// 6. Pure helpers
// ===========================================================================

/**
 * Disclosure-safe identity/location for an entity id or name. If it looks secret-shaped (an entity
 * named after a DSN, an AWS key, a JWT, etc.) it is replaced with the placeholder; benign values
 * survive. `:`-delimited segments are redacted individually so a benign prefix survives while a
 * secret-shaped tail is scrubbed. Applied to BOTH the durable `location` field AND the public
 * `targetId`, since either is durable output a secret name would otherwise leak into.
 */
function safeLocation(location: string): string {
  if (!looksLikeSecretValue(location)) return location;
  const parts = location.split(/[:/]/);
  const safe = parts.map((seg) => (looksLikeSecretValue(seg) ? REDACTED_PLACEHOLDER : seg));
  const rejoined = safe.join('/');
  // If a secret spans segment boundaries (still detected after per-segment redaction), collapse whole.
  return looksLikeSecretValue(rejoined) ? REDACTED_PLACEHOLDER : rejoined;
}

function classificationFor(markers: readonly RuntimeMarker[]): {
  classification: string;
  matched: RuntimeMarker[];
} {
  const matched: RuntimeMarker[] = [];
  let classification: string = RUNTIME_UNKNOWN_CLASSIFICATION;
  const byName = new Map(markers.map((m) => [m.name, m] as const));
  // A named governed workload (kanban/agentctl/workflows_orchestration) wins over a generic manifest.
  const NAMED = new Set(['kanban', 'agentctl', 'workflows_orchestration']);
  for (const def of RUNTIME_MARKERS) {
    const hit = byName.get(def.marker);
    if (hit && hit.kind === def.kind) {
      matched.push(hit);
      if (classification === RUNTIME_UNKNOWN_CLASSIFICATION || NAMED.has(def.classification)) {
        if (!NAMED.has(classification)) classification = def.classification;
      }
    }
  }
  return { classification, matched };
}

function detectSensitivity(name: string, markers: readonly RuntimeMarker[]): RtSensitivity {
  const haystacks = [name, ...markers.map((m) => m.name)].map((s) => s.toLowerCase());
  for (const hay of haystacks) {
    for (const s of RUNTIME_SENSITIVE_MARKER_NAMES) {
      if (hay === s || hay.includes(s)) {
        // A vault / keystore / ssh daemon is RESTRICTED; a plain secrets sidecar is sensitive.
        if (hay.includes('vault') || hay.includes('keystore') || hay.includes('sshd')) {
          return 'restricted';
        }
        return 'sensitive';
      }
    }
  }
  return 'normal';
}

function detectOwnership(markers: readonly RuntimeMarker[]): RtOwnershipStatus {
  const has = new Set(markers.map((m) => m.name));
  for (const m of RUNTIME_OWNERSHIP_MARKERS) if (has.has(m)) return 'owned';
  return 'unowned';
}

/**
 * The declared OWNER identity for AC1's owner facet. When an ownership marker is present the owner is
 * named by that marker (e.g. `declared-by:owner-label`) — a disclosure-safe reference to the ownership
 * artifact, NOT its value (the label value is never read). Null when unowned.
 */
function detectOwner(markers: readonly RuntimeMarker[]): string | null {
  const has = new Set(markers.map((m) => m.name));
  for (const m of RUNTIME_OWNERSHIP_MARKERS) if (has.has(m)) return `declared-by:${m}`;
  return null;
}

function impactForGap(reason: RtGapReason, sensitivity: RtSensitivity): RtGapImpact {
  switch (reason) {
    case 'sensitive':
      return sensitivity === 'restricted' ? 'critical' : 'high';
    case 'inaccessible':
      return 'high';
    case 'unowned':
      return 'medium';
    case 'unsupported':
      return 'medium';
    case 'stale':
      return 'medium';
    case 'excluded':
      return 'low';
    default:
      return 'unknown';
  }
}

// ---- AC1 facet derivations (pure, deterministic, metadata-only) -----------

/** The set of classifications the platform can actually govern (a "supported" type — AC1 coverage). */
const SUPPORTED_CLASSIFICATIONS: ReadonlySet<string> = new Set([
  'kanban',
  'agentctl',
  'workflows_orchestration',
  'container-manifest',
  'service-unit',
]);

/** AC1 lifecycle: fresh+reachable ⇒ active; stale ⇒ dormant; anything unknown ⇒ unknown. */
function deriveLifecycle(access: RtAccessStatus, freshness: RtFreshness): RtLifecycleState {
  if (access !== 'reachable') return 'unknown';
  if (freshness === 'fresh') return 'active';
  if (freshness === 'stale') return 'dormant';
  return 'unknown';
}

/** AC1 risk rollup: restricted material or an inaccessible entity is highest; unowned/stale raise it. */
function deriveRisk(
  sensitivity: RtSensitivity,
  ownership: RtOwnershipStatus,
  freshness: RtFreshness,
  access: RtAccessStatus,
): RtRiskLevel {
  if (access === 'inaccessible') return 'unknown';
  if (sensitivity === 'restricted') return 'critical';
  if (sensitivity === 'sensitive') return 'high';
  if (ownership !== 'owned') return 'medium';
  if (freshness !== 'fresh') return 'medium';
  return 'low';
}

/** AC1 control coverage: owner AND supported type ⇒ covered; one ⇒ partial; none ⇒ uncovered. */
function deriveControlCoverage(
  ownership: RtOwnershipStatus,
  classification: string,
  access: RtAccessStatus,
): RtControlCoverage {
  if (access === 'inaccessible') return 'unknown';
  const owned = ownership === 'owned';
  const supported = SUPPORTED_CLASSIFICATIONS.has(classification);
  if (owned && supported) return 'covered';
  if (owned || supported) return 'partial';
  return 'uncovered';
}

/** AC1 evidence state derived from marker count + freshness (distinct from freshness itself). */
function deriveEvidenceState(recordCount: number, freshness: RtFreshness): RtEvidenceState {
  if (recordCount === 0) return 'absent';
  if (freshness === 'fresh') return 'attested';
  return 'stale-evidence';
}

/** AC1 health: only `healthy` when fresh AND no governance concern; never inferred from stale data. */
function deriveHealth(
  freshness: RtFreshness,
  sensitivity: RtSensitivity,
  ownership: RtOwnershipStatus,
): RtHealthState {
  if (freshness !== 'fresh') return 'unknown'; // AC4: never assert health from stale/unknown data
  if (sensitivity !== 'normal' || ownership !== 'owned') return 'degraded';
  return 'healthy';
}

/** AC1 unresolved issues: a closed-vocabulary rollup of every open governance concern for the entity. */
function deriveUnresolvedIssues(
  classification: string,
  sensitivity: RtSensitivity,
  ownership: RtOwnershipStatus,
  freshness: RtFreshness,
  isSource: boolean,
  recordCount: number,
): RtIssueTag[] {
  const issues: RtIssueTag[] = [];
  if (!isSource || !SUPPORTED_CLASSIFICATIONS.has(classification)) issues.push('unsupported');
  if (sensitivity === 'restricted') issues.push('restricted');
  else if (sensitivity === 'sensitive') issues.push('sensitive');
  if (ownership !== 'owned') issues.push('unowned');
  if (freshness === 'stale' || freshness === 'unknown') issues.push('stale');
  if (recordCount === 0) issues.push('evidence-absent');
  return issues;
}

/**
 * AC3 dependency correlation between the DISTINCT marker records of ONE entity. Edges are derived from
 * marker CLASSIFICATION only (never from reading a marker's runtime content): a
 * workflows_orchestration engine depends on the agentctl controller that drives it and on the kanban
 * board; an agentctl controller depends on the kanban board it drives. This yields a real, inspectable
 * dependency graph across the named source systems for a single correlated entity.
 */
function dependenciesFor(
  classification: string,
  presentClassifications: ReadonlySet<string>,
): string[] {
  const deps: string[] = [];
  const add = (c: string) => {
    if (c !== classification && presentClassifications.has(c)) deps.push(c);
  };
  switch (classification) {
    case 'workflows_orchestration':
      add('agentctl');
      add('kanban');
      break;
    case 'agentctl':
      add('kanban');
      break;
    case 'container-manifest':
      add('kanban');
      add('agentctl');
      add('workflows_orchestration');
      break;
    case 'service-unit':
      add('container-manifest');
      break;
    default:
      break;
  }
  return deps;
}

function ownerActionForGap(reason: RtGapReason): string {
  switch (reason) {
    case 'excluded':
      return 'confirm-exclusion-and-set-review-date';
    case 'inaccessible':
      return 'grant-read-metadata-access-or-mark-out-of-boundary';
    case 'unsupported':
      return 'assign-source-type-or-declare-unsupported';
    case 'sensitive':
      return 'assign-data-steward-and-approve-handling';
    case 'unowned':
      return 'assign-accountable-owner';
    case 'stale':
      return 'restart-or-refresh-source-or-mark-inactive';
    default:
      return 'review';
  }
}

// ===========================================================================
// 7. The scanner — a TargetSource + TargetProbe over a runtime boundary
// ===========================================================================

/**
 * `RuntimeScanner` is the injected sensing substrate for a runtime/host boundary. It implements both
 * hexagonal ports the `GovernedDiscoveryAgent` consumes:
 *
 *   • `TargetSource.listTargets()` — enumerate candidate runtime entities under the boundary as
 *     `ScanTarget`s. Excluded entities are still listed so their gap stays visible.
 *   • `TargetProbe.probe(target)` — inspect ONE authorized entity's METADATA (marker names, ports,
 *     heartbeat), classify it, and return a metadata-only `ProbeResult`. The probe never reads runtime
 *     content: it has only the read-only `RuntimeInventoryPort`.
 *
 * It also exposes `scan()` — a standalone metadata-only sweep that produces a fully reconciled
 * `RuntimeScanReport` (sources + gaps) independent of the agent runtime, so every acceptance criterion
 * is exercisable without booting a lease/budget/checkpoint stack.
 */
export class RuntimeScanner implements TargetSource, TargetProbe {
  readonly #opts: Required<
    Omit<RuntimeScanOptions, 'excludedEntityNames' | 'gapReviewWindowMs'>
  > & {
    readonly excludedEntityNames: ReadonlySet<string>;
    readonly gapReviewWindowMs: number;
  };

  constructor(opts: RuntimeScanOptions) {
    if (!Number.isFinite(opts.now)) throw new RangeError('now must be a finite epoch-ms value');
    if (!(opts.freshnessHorizonMs > 0)) {
      throw new RangeError('freshnessHorizonMs must be a positive number');
    }
    this.#opts = {
      boundary: opts.boundary,
      scope: opts.scope,
      runtime: opts.runtime,
      now: opts.now,
      freshnessHorizonMs: opts.freshnessHorizonMs,
      excludedEntityNames: new Set(opts.excludedEntityNames ?? DEFAULT_EXCLUDED_ENTITY_NAMES),
      gapReviewWindowMs: opts.gapReviewWindowMs ?? 7 * DAY_MS,
    };
  }

  /** Is this entity name structurally excluded from discovery (still surfaced as a visible gap)? */
  #isExcluded(name: string): boolean {
    const lower = name.toLowerCase();
    for (const ex of this.#opts.excludedEntityNames) {
      if (lower === ex.toLowerCase() || lower.includes(ex.toLowerCase())) return true;
    }
    return false;
  }

  // ---- TargetSource -------------------------------------------------------

  /** Enumerate candidate runtime entities under the boundary as `ScanTarget`s. */
  async listTargets(): Promise<readonly ScanTarget[]> {
    let entities: readonly RuntimeEntitySummary[];
    try {
      entities = await this.#opts.runtime.listEntities();
    } catch {
      // The whole inventory is inaccessible — no targets can be enumerated (the sweep will gap it).
      return [];
    }
    return entities.map((e) => ({
      targetId: e.entityId,
      scope: this.#opts.scope,
      location: safeLocation(e.entityId),
      registered: false,
    }));
  }

  // ---- TargetProbe --------------------------------------------------------

  /**
   * Probe ONE entity's metadata and classify it. Never reads runtime content. A rejected `inspect`
   * becomes `reachable:false` (turned into an `inaccessible` gap by the agent), never a throw that
   * silently loses the target.
   */
  async probe(target: ScanTarget): Promise<ProbeResult> {
    try {
      const detail = await this.#opts.runtime.inspect(target.targetId);
      const { classification } = classificationFor(detail.markers);
      // Evidence is a bounded metadata summary — NOT runtime content. Only marker names + counts.
      const evidence = {
        markerNames: detail.markers.map((m) => m.name),
        markerCount: detail.markers.length,
        portCount: detail.listeningPorts.length,
      };
      return { reachable: true, classification, evidence };
    } catch (err) {
      return {
        reachable: false,
        classification: RUNTIME_UNKNOWN_CLASSIFICATION,
        evidence: `probe_failed:${describeRuntimeProbeError(err)}`,
      };
    }
  }

  // ---- Standalone reconciled sweep (AC1–AC6) ------------------------------

  /**
   * Sweep the boundary and produce a fully reconciled report: one `RuntimeSource` per healthy
   * discovered entity and one `RuntimeGap` per excluded/inaccessible/unsupported/sensitive/unowned/
   * stale entity. Deterministic given the injected runtime + `now`. Metadata only throughout.
   */
  async scan(): Promise<RuntimeScanReport> {
    const sources: RuntimeSource[] = [];
    const gaps: RuntimeGap[] = [];
    const seen = new Set<string>(); // reconciliation: one entry per entity, no duplicates
    let visited = 0;

    let entities: readonly RuntimeEntitySummary[];
    try {
      entities = await this.#opts.runtime.listEntities();
    } catch (err) {
      // The whole inventory is inaccessible — a single fail-visible boundary gap (AC2/AC6).
      gaps.push(
        this.#makeGap(
          this.#opts.boundary,
          'inaccessible',
          describeRuntimeProbeError(err),
          'normal',
          [],
          null,
        ),
      );
      return {
        boundary: this.#opts.boundary,
        scope: this.#opts.scope,
        sources,
        gaps,
        counts: { entitiesVisited: 0, sources: 0, gaps: gaps.length },
        observedAt: this.#opts.now,
      };
    }

    for (const entity of entities) {
      if (seen.has(entity.entityId)) continue;
      seen.add(entity.entityId);
      visited += 1;

      // Structurally excluded entity → visible `excluded` gap, never inspected/descended (AC6).
      if (this.#isExcluded(entity.name)) {
        gaps.push(
          this.#makeGap(
            entity.entityId,
            'excluded',
            `excluded-entity:${entity.name}`,
            'normal',
            [],
            null,
          ),
        );
        continue;
      }

      // Inspect the entity's metadata. A rejected inspect is a fail-visible inaccessible gap (AC2/AC4).
      let detail: RuntimeEntityDetail;
      try {
        detail = await this.#opts.runtime.inspect(entity.entityId);
      } catch (err) {
        gaps.push(
          this.#makeGap(
            entity.entityId,
            'inaccessible',
            describeRuntimeProbeError(err),
            'normal',
            [],
            null,
          ),
        );
        continue;
      }

      await this.#reconcile(entity, detail, { sources, gaps });
    }

    return {
      boundary: this.#opts.boundary,
      scope: this.#opts.scope,
      sources,
      gaps,
      counts: { entitiesVisited: visited, sources: sources.length, gaps: gaps.length },
      observedAt: this.#opts.now,
    };
  }

  // ---- Internal reconciliation --------------------------------------------

  async #reconcile(
    entity: RuntimeEntitySummary,
    detail: RuntimeEntityDetail,
    sink: { sources: RuntimeSource[]; gaps: RuntimeGap[] },
  ): Promise<void> {
    const { classification, matched } = classificationFor(detail.markers);
    const isSource = matched.length > 0 || classification !== RUNTIME_UNKNOWN_CLASSIFICATION;

    const sensitivity = detectSensitivity(entity.name, detail.markers);
    const ownership = detectOwnership(detail.markers);
    const owner = detectOwner(detail.markers);
    const correlationId = safeLocation(entity.entityId); // AC3: all of this entity's records share id

    // AC3: build the DISTINCT, CORRELATED source records. Each carries the shared correlationId, a
    // per-record STATUS (its own heartbeat vs the horizon — records under one entity can differ), and
    // its DEPENDENCY edges across the named source systems present here. The classified markers ARE the
    // distinct records. A marker's own `heartbeatMs` (metadata) overrides the entity heartbeat, so two
    // records under one entity can be `current` and `stale` respectively — an observable AC3 status
    // difference derived from metadata only, never runtime content.
    let newestHeartbeat = Number.NEGATIVE_INFINITY;
    const presentClasses = new Set<string>();
    for (const m of matched) {
      const c = RUNTIME_MARKERS.find(
        (d) => d.marker === m.name && d.kind === m.kind,
      )?.classification;
      if (c !== undefined) presentClasses.add(c);
    }

    const records: RuntimeRecordObservation[] = matched.map((m) => {
      const markerClass =
        RUNTIME_MARKERS.find((d) => d.marker === m.name && d.kind === m.kind)?.classification ??
        classification;
      const heartbeatMs = m.heartbeatMs ?? detail.heartbeatMs;
      if (heartbeatMs > newestHeartbeat) newestHeartbeat = heartbeatMs;
      const recordAge = this.#opts.now - heartbeatMs;
      const status: 'current' | 'stale' =
        recordAge <= this.#opts.freshnessHorizonMs ? 'current' : 'stale';
      return {
        marker: m.name,
        kind: m.kind,
        classification: markerClass,
        heartbeatMs,
        correlationId,
        status,
        dependsOn: dependenciesFor(markerClass, presentClasses),
      };
    });

    // ---- Freshness / confidence / health (AC4) ----
    let freshness: RtFreshness;
    let confidence: number;
    let lastKnownAt: EpochMillis | null;
    if (records.length === 0) {
      freshness = 'unknown';
      confidence = 0;
      lastKnownAt = null;
    } else {
      lastKnownAt = newestHeartbeat;
      const age = this.#opts.now - newestHeartbeat;
      if (age <= this.#opts.freshnessHorizonMs) {
        freshness = 'fresh';
        confidence = 1;
      } else {
        freshness = 'stale';
        // Linear decay to a 0.1 floor across one extra horizon; stale ⇒ never full confidence.
        const over = age - this.#opts.freshnessHorizonMs;
        confidence = Math.max(0.1, 1 - over / this.#opts.freshnessHorizonMs);
      }
    }
    // Health may only be asserted from FRESH data (AC4: never inferred from stale/unknown data).
    const healthAssertable = freshness === 'fresh';

    const metadata = this.#metadataFor({
      location: entity.entityId,
      classification,
      onboarding: 'discovered',
      reachable: true,
      evidence: {
        markers: matched.map((m) => m.name),
        markerCount: detail.markers.length,
        portCount: detail.listeningPorts.length,
      },
    });
    // Defensive post-condition: nothing but metadata is ever written.
    if (!isMetadataOnly(metadata)) {
      throw new Error(`runtime scanner produced a non-metadata record for ${entity.entityId}`);
    }

    // ---- Decide: healthy source vs governed-source gap (AC2/AC5/AC6) ----
    // An entity becomes a GAP if it is not a supported source, is sensitive, is unowned, or is stale.
    let gapReason: RtGapReason | null = null;
    if (!isSource) {
      gapReason = 'unsupported';
    } else if (sensitivity !== 'normal') {
      gapReason = 'sensitive';
    } else if (ownership === 'unowned') {
      gapReason = 'unowned';
    } else if (freshness === 'stale' || freshness === 'unknown') {
      gapReason = 'stale';
    }

    if (gapReason) {
      sink.gaps.push(
        this.#makeGap(
          entity.entityId,
          gapReason,
          `class=${classification};sensitivity=${sensitivity};ownership=${ownership};freshness=${freshness}`,
          sensitivity,
          records,
          lastKnownAt,
          confidence,
        ),
      );
      return;
    }

    // A healthy, supported, owned, fresh source — appears ONCE with the full AC1 facet set.
    const access: RtAccessStatus = 'reachable';
    const identity = safeLocation(entity.entityId); // disclosure-safe identity — secret name never leaks
    sink.sources.push({
      // facet 1 — TYPE
      type: classification,
      classification,
      // facet 2 — SOURCE IDENTITY
      targetId: identity,
      sourceIdentity: identity,
      scope: this.#opts.scope,
      location: safeLocation(entity.entityId),
      access,
      sensitivity,
      listeningPorts: [...detail.listeningPorts],
      // facet 3 — OWNER
      ownership,
      owner,
      onboarding: 'discovered',
      freshness,
      // facet 4 — LIFECYCLE STATE
      lifecycleState: deriveLifecycle(access, freshness),
      // facet 5 — RISK
      risk: deriveRisk(sensitivity, ownership, freshness, access),
      // facet 6 — CONTROL COVERAGE
      controlCoverage: deriveControlCoverage(ownership, classification, access),
      // facet 7 — EVIDENCE STATE
      evidenceState: deriveEvidenceState(records.length, freshness),
      // facet 8 — HEALTH
      health: deriveHealth(freshness, sensitivity, ownership),
      confidence,
      healthAssertable,
      // AC3 correlated records
      records,
      // facet 9 — LAST OBSERVATION TIME
      observedAt: this.#opts.now,
      lastKnownAt,
      // facet 10 — UNRESOLVED ISSUES
      unresolvedIssues: deriveUnresolvedIssues(
        classification,
        sensitivity,
        ownership,
        freshness,
        isSource,
        records.length,
      ),
      metadata,
    });
  }

  #makeGap(
    entityId: string,
    reason: RtGapReason,
    detail: string,
    sensitivity: RtSensitivity,
    records: readonly RuntimeRecordObservation[],
    lastKnownAt: EpochMillis | null,
    confidence?: number,
  ): RuntimeGap {
    const metadata = this.#metadataFor({
      location: entityId,
      classification: reason,
      onboarding: 'gap',
      reachable: reason !== 'inaccessible',
      evidence: { records: records.length },
    });
    if (!isMetadataOnly(metadata)) {
      throw new Error(`runtime scanner produced a non-metadata gap record for ${entityId}`);
    }
    // Age is measured from the last-known observation when we have one, else 0 (first sighting now).
    const firstObserved = lastKnownAt ?? this.#opts.now;
    const ageMs = Math.max(0, this.#opts.now - firstObserved);
    // Confidence in the last-known state: caller-supplied for stale sources; else derived from age.
    let conf: number;
    if (confidence !== undefined) {
      conf = confidence;
    } else if (lastKnownAt === null) {
      conf = 0; // never observed live (inaccessible/excluded) ⇒ no confidence in a "live" claim
    } else {
      const over = Math.max(0, ageMs - this.#opts.freshnessHorizonMs);
      conf =
        ageMs <= this.#opts.freshnessHorizonMs
          ? 1
          : Math.max(0.1, 1 - over / this.#opts.freshnessHorizonMs);
    }
    return {
      targetId: safeLocation(entityId), // disclosure-safe identity
      scope: this.#opts.scope,
      location: safeLocation(entityId),
      reason,
      detail: safeLocation(detail),
      impact: impactForGap(reason, sensitivity),
      ownerAction: ownerActionForGap(reason),
      ageMs,
      observedAt: this.#opts.now,
      lastKnownAt,
      confidence: conf,
      // Every governed-source gap carries a mandatory review-or-expiry deadline (AC6).
      reviewBy: this.#opts.now + this.#opts.gapReviewWindowMs,
      metadata,
    };
  }

  #metadataFor(input: {
    location: string;
    classification: string;
    onboarding: OnboardingState | 'gap';
    reachable: boolean;
    evidence: unknown;
  }): MetadataOnlyRecord {
    return toMetadataOnlyRecord({
      scope: this.#opts.scope,
      location: input.location,
      classification: input.classification,
      onboarding: input.onboarding,
      registered: false,
      reachable: input.reachable,
      evidence: input.evidence,
    });
  }
}

// ===========================================================================
// 8. Local error describer (self-contained; mirrors main.ts, disclosure-safe)
// ===========================================================================

/** Reduce any thrown value to a short disclosure-safe string. Never leaks a stack or a secret value. */
export function describeRuntimeProbeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (looksLikeSecretValue(msg)) return err.name || 'Error';
    return `${err.name}:${msg.slice(0, 120)}`;
  }
  const s = String(err);
  return looksLikeSecretValue(s) ? 'error' : s.slice(0, 120);
}
