// @trustcircle/discovery-agent — least-privilege REPOSITORY & FILESYSTEM metadata discovery.
//
// Phase 67 / bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item RH7VP6ZADJCBBNVD15E5MSQTSQ.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// `main.ts` gives the discovery agent its GOVERNANCE machinery: least-privilege scan authorization,
// per-sweep budgets, leases, the metadata-only DISCLOSURE guard, the reconciled `SourceCatalog`, and
// the fail-visible status. What it deliberately leaves INJECTED is the actual SENSING SUBSTRATE — the
// `TargetSource` that enumerates candidate targets and the `TargetProbe` that inspects one. This
// module is that substrate for a FILESYSTEM boundary: it walks a declared directory tree, finds the
// governance-relevant sources living inside it (git repositories, workflow/orchestration configs,
// Kanban/agentctl markers, and unknown directories), and reports each as a discovery observation.
//
// ---------------------------------------------------------------------------
// THE LEAST-PRIVILEGE / NO-PROTECTED-CONTENT CONTRACT (the whole point of the phase)
// ---------------------------------------------------------------------------
// The scanner is a METADATA-ONLY sensor. It is structurally incapable of reading protected content:
//
//   1. It talks to the filesystem ONLY through the injected `FileSystemPort`, whose surface is
//      `list(dir)` and `stat(path)`. There is NO `readFile` on the port. The scanner cannot open a
//      file body even if it wanted to — the capability is simply absent. This is least privilege
//      enforced by construction, not by discipline.
//
//   2. Everything the scanner learns is FILESYSTEM METADATA: an entry's NAME, whether it is a file /
//      directory / symlink, its size, and its mtime. Names of well-known MARKER files (`.git`,
//      `package.json`, a `.github/workflows` dir, a `kanban.json`, an `agentctl.yaml`) are used to
//      CLASSIFY the source — but their CONTENTS are never read. "There is a package.json here" is
//      metadata; "here is what the package.json says" would be content, and the scanner cannot obtain
//      it.
//
//   3. Every durable record the scanner emits flows through `toMetadataOnlyRecord` from `main.ts`,
//      the single disclosure chokepoint, and is asserted `isMetadataOnly`. A path that happens to be
//      a DSN-with-password or a marker name that looks secret-shaped is redacted before it is written.
//
// Because of (1)–(3), the two INDEPENDENT durable read paths of a sweep — the reconciled catalog and
// the flushed evidence sink — can be inspected afterward and shown to contain metadata only. That is
// the observable proof the phase demands.
//
// ---------------------------------------------------------------------------
// HOW IT MAPS TO THE ACCEPTANCE CRITERIA
// ---------------------------------------------------------------------------
//   AC1  A healthy discovered repository renders ONCE in the catalog with ALL ten inventory facets:
//        type, source identity, owner, lifecycle state, risk, control coverage, evidence state, health,
//        last-observation time, and unresolved issues (`FilesystemSource`, one reconciled row per path).
//   AC2  A discovered-but-unmanaged / unreachable / excluded component stays a VISIBLE coverage gap
//        with reason + age + impact + required owner action (`FilesystemGap`, never dropped).
//   AC3  Distinct marker records are kept per source: the named source systems (Kanban, agentctl,
//        workflow_orchestration, git-repository) each produce a SEPARATE `SourceRecordObservation`
//        under one correlated target — sharing a `correlationId`, carrying per-record STATUS
//        differences (current vs stale by their own mtime), and DEPENDENCY edges between them.
//   AC4  A stale target (mtime older than the freshness horizon, or an unreadable stat) is marked with
//        its last-known time + confidence, and health is NOT inferred from stale data (health→unknown).
//   AC5  An UNREGISTERED directory inside the boundary is added to the catalog with discovery evidence,
//        a type-or-unknown classification, location, access status, sensitivity, ownership status, and
//        onboarding state.
//   AC6  A discovered source that is unsupported / inaccessible / sensitive / unowned / excluded stays
//        a VISIBLE governed-source gap with reason, impact, owner action, and a review-or-expiry date.
//
// The module is pure/deterministic given the injected `FileSystemPort` and an explicit `now` epoch —
// no wall-clock reads, no ambient fs access — so every criterion is exercised by a fixture filesystem.

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
// 1. The injected, read-only FileSystemPort — the ONLY door to the disk
// ===========================================================================

/** The kind of a single directory entry, as reported by the filesystem — metadata, never content. */
export const FS_ENTRY_KINDS = ['file', 'directory', 'symlink', 'other'] as const;
export type FsEntryKind = (typeof FS_ENTRY_KINDS)[number];

/** One directory entry: its bare name and kind. No contents, no descent — just what `list` sees. */
export interface FsDirEntry {
  readonly name: string;
  readonly kind: FsEntryKind;
}

/** Metadata for a single path: size + mtime + kind. This is the deepest the scanner ever reaches. */
export interface FsStat {
  readonly kind: FsEntryKind;
  /** Size in bytes (metadata). A discovery sweep records sizes, never bytes. */
  readonly size: number;
  /** Last-modified time in epoch millis — the source of staleness/freshness (AC4). */
  readonly mtimeMs: EpochMillis;
}

/**
 * The read-only filesystem capability the scanner is granted. Note what is ABSENT: there is no
 * `readFile`, no `open`, no stream. The scanner may enumerate a directory and stat a path; it may
 * NEVER read a file's body. Least privilege is expressed as a missing capability, so protected
 * content is unreachable by construction — the strongest form of the no-content-inspection contract.
 *
 * `list` / `stat` may reject (permission denied, gone) — a rejection is caught and turned into a
 * fail-visible `inaccessible` gap, never a silent skip.
 */
export interface FileSystemPort {
  /** Enumerate the immediate children of a directory (one level; the scanner controls descent). */
  list(dir: string): Promise<readonly FsDirEntry[]>;
  /** Stat a single path for its kind/size/mtime. Rejects if the path is inaccessible or gone. */
  stat(path: string): Promise<FsStat>;
}

// ===========================================================================
// 2. Source classification from MARKER NAMES (never marker contents)
// ===========================================================================

/**
 * Well-known marker files/directories whose mere PRESENCE (by name) classifies a directory as a
 * particular governance-relevant source. The scanner keys off the entry NAME only; it never opens the
 * marker to read what is inside. The classification vocabulary mirrors the named adapters the platform
 * governs (Kanban, agentctl, workflow_orchestration) plus a generic git-repository class and the
 * catch-all `unknown` for a directory whose type discovery cannot determine.
 */
export const SOURCE_MARKERS: ReadonlyArray<{
  readonly marker: string;
  readonly kind: FsEntryKind;
  readonly classification: string;
}> = [
  { marker: '.git', kind: 'directory', classification: 'git-repository' },
  { marker: 'kanban.json', kind: 'file', classification: 'kanban' },
  { marker: '.kanban', kind: 'directory', classification: 'kanban' },
  { marker: 'agentctl.yaml', kind: 'file', classification: 'agentctl' },
  { marker: 'agentctl.yml', kind: 'file', classification: 'agentctl' },
  { marker: '.github', kind: 'directory', classification: 'workflow_orchestration' },
  { marker: 'workflows', kind: 'directory', classification: 'workflow_orchestration' },
  { marker: 'package.json', kind: 'file', classification: 'node-package' },
] as const;

/** The classification used when no marker matches — a discovered source of an UNKNOWN type (AC5). */
export const UNKNOWN_CLASSIFICATION = 'unknown' as const;

/**
 * Directory names that are STRUCTURALLY excluded from discovery. An excluded directory is not silently
 * skipped — it is still surfaced as an `excluded` governed-source GAP (AC6), so intentional exclusion
 * remains visible with a review date rather than disappearing.
 */
export const DEFAULT_EXCLUDED_DIR_NAMES: readonly string[] = [
  'node_modules',
  '.tsbuild',
  'dist',
  '.turbo',
] as const;

/**
 * Marker NAMES (case-insensitive substrings) that signal a directory holds SENSITIVE material and must
 * be treated as a sensitive governed-source gap (AC6) — again by NAME only, never by reading the file.
 */
export const SENSITIVE_MARKER_NAMES: readonly string[] = [
  '.env',
  'secrets',
  'credentials',
  '.ssh',
  '.pem',
  'id_rsa',
] as const;

/** An OWNERSHIP marker: a file whose presence signals the directory has a declared owner (CODEOWNERS). */
export const OWNERSHIP_MARKERS: readonly string[] = ['CODEOWNERS', '.owners', 'OWNERS'] as const;

// ===========================================================================
// 3. Access status / sensitivity / ownership / onboarding vocab (AC5 facets)
// ===========================================================================

export const FS_ACCESS_STATUSES = ['reachable', 'inaccessible', 'excluded'] as const;
export type FsAccessStatus = (typeof FS_ACCESS_STATUSES)[number];

export const FS_SENSITIVITIES = ['normal', 'sensitive', 'restricted'] as const;
export type FsSensitivity = (typeof FS_SENSITIVITIES)[number];

export const FS_OWNERSHIP_STATUSES = ['owned', 'unowned', 'unknown'] as const;
export type FsOwnershipStatus = (typeof FS_OWNERSHIP_STATUSES)[number];

export const FS_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type FsFreshness = (typeof FS_FRESHNESS)[number];

// ---- AC1 inventory-view facets (type/owner/lifecycle/risk/coverage/evidence/health/issues) ----

/**
 * Lifecycle state of a discovered source (AC1). Derived deterministically from freshness + access:
 * a fresh, reachable source is `active`; a stale one is `dormant`; an inaccessible one is `unknown`.
 */
export const FS_LIFECYCLE_STATES = ['active', 'dormant', 'unknown'] as const;
export type FsLifecycleState = (typeof FS_LIFECYCLE_STATES)[number];

/** Risk level of a discovered source (AC1) — a rollup of sensitivity + ownership + freshness. */
export const FS_RISK_LEVELS = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
export type FsRiskLevel = (typeof FS_RISK_LEVELS)[number];

/**
 * Control-coverage state (AC1): does the source have the governance controls (a declared owner and a
 * recognized/supported type) that let it be governed? `covered` = owned AND supported; `partial` =
 * one present; `uncovered` = neither; `unknown` = coverage cannot be assessed (inaccessible/stale).
 */
export const FS_CONTROL_COVERAGE = ['covered', 'partial', 'uncovered', 'unknown'] as const;
export type FsControlCoverage = (typeof FS_CONTROL_COVERAGE)[number];

/**
 * Evidence state (AC1): the quality of the metadata evidence backing this observation. `attested` =
 * fresh markers were stat-observed; `stale-evidence` = markers exist but are past the horizon;
 * `absent` = no marker evidence could be gathered. Distinct from freshness so an inventory view can
 * show BOTH "how old" and "how well-evidenced".
 */
export const FS_EVIDENCE_STATES = ['attested', 'stale-evidence', 'absent'] as const;
export type FsEvidenceState = (typeof FS_EVIDENCE_STATES)[number];

/**
 * Health of a discovered source (AC1/AC4). Only ever `healthy` when data is FRESH; `degraded` when
 * a governance concern (sensitive/unowned) coexists with fresh data; `unknown` whenever data is
 * stale/absent (health is NEVER inferred from stale data — AC4).
 */
export const FS_HEALTH_STATES = ['healthy', 'degraded', 'unknown'] as const;
export type FsHealthState = (typeof FS_HEALTH_STATES)[number];

/** An unresolved-issue tag (AC1): a disclosure-safe, closed-vocabulary reason a source needs action. */
export const FS_ISSUE_TAGS = [
  'unowned',
  'sensitive',
  'restricted',
  'stale',
  'unsupported',
  'evidence-absent',
] as const;
export type FsIssueTag = (typeof FS_ISSUE_TAGS)[number];

/** Why a filesystem target is a governed-source GAP rather than a healthy source (AC2/AC6). */
export const FS_GAP_REASONS = [
  'excluded', // intentionally excluded from discovery (still visible)
  'inaccessible', // list/stat rejected — unreachable
  'unsupported', // discovered but of an unsupported/unknown class
  'sensitive', // holds sensitive material — must not be auto-onboarded
  'unowned', // no declared owner
  'stale', // last observation is older than the freshness horizon
] as const;
export type FsGapReason = (typeof FS_GAP_REASONS)[number];

export const FS_GAP_IMPACTS = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
export type FsGapImpact = (typeof FS_GAP_IMPACTS)[number];

// ===========================================================================
// 4. Observation records — the durable, independently-readable witnesses
// ===========================================================================

/**
 * A single MARKER observation within a discovered source. AC3: a repository's distinct markers (its
 * `.git`, its `package.json`, its `.github/workflows`) are kept as SEPARATE records under one
 * correlated target, so the drill-down can show their distinct source records and authoritative
 * fields. Each record is metadata only — name + kind + size + mtime, never contents.
 */
export interface SourceRecordObservation {
  /** The marker name that produced this record (e.g. '.git', 'package.json'). */
  readonly marker: string;
  readonly kind: FsEntryKind;
  readonly classification: string;
  /** Size in bytes (metadata). */
  readonly size: number;
  /** Last-modified time (metadata) — the authoritative freshness field. */
  readonly mtimeMs: EpochMillis;
  /**
   * AC3 correlation key: the id of the source this record belongs to. All of a source's records share
   * one `correlationId`, so the distinct records are provably tied together under one governed target.
   */
  readonly correlationId: string;
  /**
   * AC3 per-record STATUS. Two records under the same source can differ: a `.git` observed today is
   * `current` while a `package.json` past the freshness horizon is `stale` — the status difference is
   * an authoritative, per-record field derived from that record's own mtime, not the source rollup.
   */
  readonly status: 'current' | 'stale';
  /**
   * AC3 DEPENDENCY edges: the markers this record depends on within the same source (e.g. a
   * `workflow_orchestration` marker depends on the `git-repository` marker that hosts it; an
   * `agentctl` marker depends on the `kanban` board it drives). Empty when the record has no
   * declared upstream. Correlated by marker name within the source — never a cross-source content read.
   */
  readonly dependsOn: readonly string[];
}

/**
 * A discovered filesystem SOURCE — one reconciled entry per directory. Carries the full AC5 facet set:
 * discovery evidence (the marker observations), a type-or-unknown classification, location, access
 * status, sensitivity, ownership status, and onboarding state. It appears exactly ONCE per path.
 */
export interface FilesystemSource {
  // ---- AC1 facet 1: TYPE ----------------------------------------------------
  /** The source TYPE (AC1). An explicit facet; equals `classification` (kept for the drill-down view). */
  readonly type: string;
  /** Alias of `type` retained for the classification vocabulary; identical value. */
  readonly classification: string;

  // ---- AC1 facet 2: SOURCE IDENTITY ----------------------------------------
  /** Stable identity within the boundary — the relative path. Also the catalog targetId (AC1). */
  readonly targetId: string;
  /** Explicit AC1 "source identity" facet — the disclosure-safe identity string (equals targetId). */
  readonly sourceIdentity: string;
  readonly scope: ScanScope;
  readonly location: string;
  readonly access: FsAccessStatus;
  readonly sensitivity: FsSensitivity;

  // ---- AC1 facet 3: OWNER ---------------------------------------------------
  readonly ownership: FsOwnershipStatus;
  /** Explicit AC1 OWNER facet: the declared owner identity, or `null` when unowned/unknown. */
  readonly owner: string | null;

  readonly onboarding: OnboardingState;
  readonly freshness: FsFreshness;

  // ---- AC1 facet 4: LIFECYCLE STATE ----------------------------------------
  /** AC1 LIFECYCLE STATE — active/dormant/unknown, derived from freshness + access. */
  readonly lifecycleState: FsLifecycleState;

  // ---- AC1 facet 5: RISK ----------------------------------------------------
  /** AC1 RISK level — a rollup of sensitivity + ownership + freshness. */
  readonly risk: FsRiskLevel;

  // ---- AC1 facet 6: CONTROL COVERAGE ---------------------------------------
  /** AC1 CONTROL COVERAGE — covered/partial/uncovered/unknown (owner + supported-type presence). */
  readonly controlCoverage: FsControlCoverage;

  // ---- AC1 facet 7: EVIDENCE STATE -----------------------------------------
  /** AC1 EVIDENCE STATE — attested/stale-evidence/absent (quality of the metadata evidence). */
  readonly evidenceState: FsEvidenceState;

  // ---- AC1 facet 8: HEALTH --------------------------------------------------
  /** AC1 HEALTH — healthy/degraded/unknown; NEVER `healthy` unless data is fresh (AC4). */
  readonly health: FsHealthState;
  /** Confidence in [0,1]: 1 when a fresh observation exists, decayed/zeroed when stale/unknown (AC4). */
  readonly confidence: number;
  /** Whether current health may be asserted — false whenever data is stale/unknown (AC4). */
  readonly healthAssertable: boolean;

  /** Distinct marker records — the AC3 authoritative, correlated source records (discovery evidence). */
  readonly records: readonly SourceRecordObservation[];

  // ---- AC1 facet 9: LAST OBSERVATION TIME ----------------------------------
  /** Epoch time of THIS observation (AC1 last-observation-time). */
  readonly observedAt: EpochMillis;

  // ---- AC1 facet 10: UNRESOLVED ISSUES -------------------------------------
  /** AC1 UNRESOLVED ISSUES — a closed-vocabulary, disclosure-safe list; empty for a clean source. */
  readonly unresolvedIssues: readonly FsIssueTag[];

  /** The metadata-only record persisted to the durable evidence sink — never protected content. */
  readonly metadata: MetadataOnlyRecord;
}

/**
 * A discovered filesystem GAP — a component/source that is visible but NOT healthy: excluded,
 * inaccessible, unsupported, sensitive, unowned, or stale. AC2/AC6: it remains in the reconciled
 * catalog with a reason, an age, an impact, a required owner action, and (for governed-source gaps) a
 * mandatory review-or-expiry date — rather than appearing healthy or disappearing.
 */
export interface FilesystemGap {
  readonly targetId: string;
  readonly scope: ScanScope;
  readonly location: string;
  readonly reason: FsGapReason;
  /** Disclosure-safe detail. */
  readonly detail: string;
  readonly impact: FsGapImpact;
  /** The action an owner must take to close the gap (AC2/AC6 required owner action). */
  readonly ownerAction: string;
  /** Age of the gap in ms (now − firstObservedAt). Surfaced so a gap cannot look "fresh" forever. */
  readonly ageMs: EpochMillis;
  readonly observedAt: EpochMillis;
  /** Governed-source gaps carry a review-or-expiry deadline (AC6). Null for pure component gaps. */
  readonly reviewBy: EpochMillis | null;
  readonly metadata: MetadataOnlyRecord;
}

/** The full result of one filesystem sweep — sources + gaps together, plus a durable digest witness. */
export interface FilesystemScanReport {
  readonly boundary: string;
  readonly scope: ScanScope;
  readonly sources: readonly FilesystemSource[];
  readonly gaps: readonly FilesystemGap[];
  readonly counts: {
    readonly directoriesVisited: number;
    readonly sources: number;
    readonly gaps: number;
  };
  readonly observedAt: EpochMillis;
}

// ===========================================================================
// 5. Options
// ===========================================================================

export interface FilesystemScanOptions {
  /** The declared computer boundary: the root directory to sweep (relative locators used as ids). */
  readonly boundary: string;
  /** The least-privilege scope every discovered target is tagged with. */
  readonly scope: ScanScope;
  /** The injected read-only filesystem capability. */
  readonly fs: FileSystemPort;
  /** Explicit observation time (epoch ms) — injected so the sweep is deterministic (no clock reads). */
  readonly now: EpochMillis;
  /**
   * Freshness horizon in ms. A target whose newest marker mtime is older than `now − horizon` is
   * STALE: it is surfaced with last-known time + reduced confidence and its health is NOT asserted.
   */
  readonly freshnessHorizonMs: number;
  /** Max directory depth to descend from the boundary (blast-radius bound). Default 4. */
  readonly maxDepth?: number;
  /** Directory names to treat as EXCLUDED (still surfaced as visible gaps). Defaults provided. */
  readonly excludedDirNames?: readonly string[];
  /** Default review window (ms) added to `now` for governed-source gaps. Default 7 days. */
  readonly gapReviewWindowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ===========================================================================
// 6. Pure helpers
// ===========================================================================

function joinPath(a: string, b: string): string {
  if (a === '' || a === '.') return b;
  return `${a.replace(/\/+$/, '')}/${b}`;
}

/**
 * Disclosure-safe identity/location for a path. A path SEGMENT that itself looks secret-shaped (a
 * directory named after a DSN, an AWS key, etc.) is replaced with the placeholder, while benign
 * segments survive — so the disclosed identity never carries a secret VALUE yet stays structurally
 * distinct from its siblings (two different secret-named dirs under the same parent still differ by
 * their benign parent segments; identical full secret paths were the same directory anyway). This is
 * applied to BOTH the durable `location` field AND the public `targetId`, since either is durable
 * output that a secret path name would otherwise leak into.
 */
function safeLocation(location: string): string {
  if (!looksLikeSecretValue(location)) return location;
  const parts = location.split('/');
  const safe = parts.map((seg) => (looksLikeSecretValue(seg) ? REDACTED_PLACEHOLDER : seg));
  const rejoined = safe.join('/');
  // If a secret spans segment boundaries (still detected after per-segment redaction), collapse whole.
  return looksLikeSecretValue(rejoined) ? REDACTED_PLACEHOLDER : rejoined;
}

function classificationFor(entries: readonly FsDirEntry[]): {
  classification: string;
  markers: FsDirEntry[];
} {
  const markers: FsDirEntry[] = [];
  let classification: string = UNKNOWN_CLASSIFICATION;
  // git-repository takes precedence over node-package/workflow when several markers coexist.
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  for (const def of SOURCE_MARKERS) {
    const hit = byName.get(def.marker);
    if (hit && hit.kind === def.kind) {
      markers.push(hit);
      if (
        classification === UNKNOWN_CLASSIFICATION ||
        def.classification === 'git-repository' // repo identity wins
      ) {
        if (classification !== 'git-repository') classification = def.classification;
      }
    }
  }
  return { classification, markers };
}

function detectSensitivity(entries: readonly FsDirEntry[]): FsSensitivity {
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    for (const s of SENSITIVE_MARKER_NAMES) {
      if (lower === s || lower.includes(s)) {
        // A private key / ssh dir is RESTRICTED; a plain .env is sensitive.
        if (lower.includes('id_rsa') || lower.includes('.ssh') || lower.includes('.pem')) {
          return 'restricted';
        }
        return 'sensitive';
      }
    }
  }
  return 'normal';
}

function detectOwnership(entries: readonly FsDirEntry[]): FsOwnershipStatus {
  const has = new Set(entries.map((e) => e.name));
  for (const m of OWNERSHIP_MARKERS) if (has.has(m)) return 'owned';
  return 'unowned';
}

/**
 * The declared OWNER identity for AC1's owner facet. When an ownership marker is present the owner is
 * named by that marker (e.g. `declared-by:CODEOWNERS`) — a disclosure-safe reference to the ownership
 * artifact, NOT its contents (the file is never read). Null when unowned. */
function detectOwner(entries: readonly FsDirEntry[]): string | null {
  const has = new Set(entries.map((e) => e.name));
  for (const m of OWNERSHIP_MARKERS) if (has.has(m)) return `declared-by:${m}`;
  return null;
}

function impactForGap(reason: FsGapReason, sensitivity: FsSensitivity): FsGapImpact {
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
  'git-repository',
  'kanban',
  'agentctl',
  'workflow_orchestration',
  'node-package',
]);

/** AC1 lifecycle: fresh+reachable ⇒ active; stale ⇒ dormant; anything unknown ⇒ unknown. */
function deriveLifecycle(access: FsAccessStatus, freshness: FsFreshness): FsLifecycleState {
  if (access !== 'reachable') return 'unknown';
  if (freshness === 'fresh') return 'active';
  if (freshness === 'stale') return 'dormant';
  return 'unknown';
}

/** AC1 risk rollup: restricted material or an inaccessible source is highest; unowned/stale raise it. */
function deriveRisk(
  sensitivity: FsSensitivity,
  ownership: FsOwnershipStatus,
  freshness: FsFreshness,
  access: FsAccessStatus,
): FsRiskLevel {
  if (access === 'inaccessible') return 'unknown';
  if (sensitivity === 'restricted') return 'critical';
  if (sensitivity === 'sensitive') return 'high';
  if (ownership !== 'owned') return 'medium';
  if (freshness !== 'fresh') return 'medium';
  return 'low';
}

/** AC1 control coverage: owner AND supported type ⇒ covered; one ⇒ partial; none ⇒ uncovered. */
function deriveControlCoverage(
  ownership: FsOwnershipStatus,
  classification: string,
  access: FsAccessStatus,
): FsControlCoverage {
  if (access === 'inaccessible') return 'unknown';
  const owned = ownership === 'owned';
  const supported = SUPPORTED_CLASSIFICATIONS.has(classification);
  if (owned && supported) return 'covered';
  if (owned || supported) return 'partial';
  return 'uncovered';
}

/** AC1 evidence state derived from marker count + freshness (distinct from freshness itself). */
function deriveEvidenceState(recordCount: number, freshness: FsFreshness): FsEvidenceState {
  if (recordCount === 0) return 'absent';
  if (freshness === 'fresh') return 'attested';
  return 'stale-evidence';
}

/** AC1 health: only `healthy` when fresh AND no governance concern; never inferred from stale data. */
function deriveHealth(
  freshness: FsFreshness,
  sensitivity: FsSensitivity,
  ownership: FsOwnershipStatus,
): FsHealthState {
  if (freshness !== 'fresh') return 'unknown'; // AC4: never assert health from stale/unknown data
  if (sensitivity !== 'normal' || ownership !== 'owned') return 'degraded';
  return 'healthy';
}

/** AC1 unresolved issues: a closed-vocabulary rollup of every open governance concern for the source. */
function deriveUnresolvedIssues(
  classification: string,
  sensitivity: FsSensitivity,
  ownership: FsOwnershipStatus,
  freshness: FsFreshness,
  isSource: boolean,
  recordCount: number,
): FsIssueTag[] {
  const issues: FsIssueTag[] = [];
  if (!isSource || !SUPPORTED_CLASSIFICATIONS.has(classification)) issues.push('unsupported');
  if (sensitivity === 'restricted') issues.push('restricted');
  else if (sensitivity === 'sensitive') issues.push('sensitive');
  if (ownership !== 'owned') issues.push('unowned');
  if (freshness === 'stale' || freshness === 'unknown') issues.push('stale');
  if (recordCount === 0) issues.push('evidence-absent');
  return issues;
}

/**
 * AC3 dependency correlation between the DISTINCT marker records of ONE source. Edges are derived from
 * marker CLASSIFICATION only (never from reading a marker's contents): a workflow_orchestration config
 * depends on the git-repository it lives in; an agentctl controller depends on the kanban board it
 * drives and on the repository. This yields a real, inspectable dependency graph across the named
 * source systems for a single correlated target.
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
    case 'workflow_orchestration':
      add('git-repository');
      add('agentctl');
      break;
    case 'agentctl':
      add('kanban');
      add('git-repository');
      break;
    case 'kanban':
      add('git-repository');
      break;
    case 'node-package':
      add('git-repository');
      break;
    default:
      break;
  }
  return deps;
}

function ownerActionForGap(reason: FsGapReason): string {
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
      return 'refresh-source-or-mark-inactive';
    default:
      return 'review';
  }
}

// ===========================================================================
// 7. The scanner — a TargetSource + TargetProbe over a filesystem boundary
// ===========================================================================

/**
 * `RepositoryFileSystemScanner` is the injected sensing substrate for a filesystem/repository
 * boundary. It implements both hexagonal ports the `GovernedDiscoveryAgent` consumes:
 *
 *   • `TargetSource.listTargets()` — enumerate candidate directories under the boundary (bounded by
 *     `maxDepth`) as `ScanTarget`s. Excluded directories are NOT descended but ARE listed so their
 *     gap stays visible.
 *   • `TargetProbe.probe(target)` — inspect ONE authorized directory's METADATA (marker names, stat
 *     size/mtime), classify it, and return a metadata-only `ProbeResult`. The probe never reads a file
 *     body: it has only the read-only `FileSystemPort`.
 *
 * It also exposes `scan()` — a standalone metadata-only sweep that produces a fully reconciled
 * `FilesystemScanReport` (sources + gaps) independent of the agent runtime, so every acceptance
 * criterion is exercisable without booting a lease/budget/checkpoint stack.
 */
export class RepositoryFileSystemScanner implements TargetSource, TargetProbe {
  readonly #opts: Required<
    Omit<FilesystemScanOptions, 'excludedDirNames' | 'maxDepth' | 'gapReviewWindowMs'>
  > & {
    readonly excludedDirNames: ReadonlySet<string>;
    readonly maxDepth: number;
    readonly gapReviewWindowMs: number;
  };

  constructor(opts: FilesystemScanOptions) {
    if (!Number.isFinite(opts.now)) throw new RangeError('now must be a finite epoch-ms value');
    if (!(opts.freshnessHorizonMs > 0)) {
      throw new RangeError('freshnessHorizonMs must be a positive number');
    }
    const maxDepth = opts.maxDepth ?? 4;
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError('maxDepth must be a positive integer');
    }
    this.#opts = {
      boundary: opts.boundary,
      scope: opts.scope,
      fs: opts.fs,
      now: opts.now,
      freshnessHorizonMs: opts.freshnessHorizonMs,
      excludedDirNames: new Set(opts.excludedDirNames ?? DEFAULT_EXCLUDED_DIR_NAMES),
      maxDepth,
      gapReviewWindowMs: opts.gapReviewWindowMs ?? 7 * DAY_MS,
    };
  }

  // ---- TargetSource -------------------------------------------------------

  /** Enumerate candidate directory targets under the boundary as `ScanTarget`s (bounded by depth). */
  async listTargets(): Promise<readonly ScanTarget[]> {
    const out: ScanTarget[] = [];
    await this.#walk(this.#opts.boundary, 0, out, /* asTargets */ true, undefined);
    return out;
  }

  // ---- TargetProbe --------------------------------------------------------

  /**
   * Probe ONE directory's metadata and classify it. Never reads file bodies. A rejected `list`/`stat`
   * becomes `reachable:false` (turned into an `inaccessible` gap by the agent), never a throw that
   * silently loses the target.
   */
  async probe(target: ScanTarget): Promise<ProbeResult> {
    try {
      const entries = await this.#opts.fs.list(target.targetId);
      const { classification } = classificationFor(entries);
      // Evidence is a bounded metadata summary — NOT file contents. Only names + counts.
      const evidence = {
        markerNames: entries
          .filter((e) => SOURCE_MARKERS.some((m) => m.marker === e.name))
          .map((e) => e.name),
        entryCount: entries.length,
      };
      return { reachable: true, classification, evidence };
    } catch (err) {
      return {
        reachable: false,
        classification: UNKNOWN_CLASSIFICATION,
        evidence: `probe_failed:${describeProbeError(err)}`,
      };
    }
  }

  // ---- Standalone reconciled sweep (AC1–AC6) ------------------------------

  /**
   * Sweep the boundary and produce a fully reconciled report: one `FilesystemSource` per healthy
   * discovered directory and one `FilesystemGap` per excluded/inaccessible/unsupported/sensitive/
   * unowned/stale directory. Deterministic given the injected fs + `now`. Metadata only throughout.
   */
  async scan(): Promise<FilesystemScanReport> {
    const sources: FilesystemSource[] = [];
    const gaps: FilesystemGap[] = [];
    const seen = new Set<string>(); // reconciliation: one entry per path, no duplicates
    const visited = { n: 0 };
    await this.#walk(this.#opts.boundary, 0, undefined, /* asTargets */ false, {
      sources,
      gaps,
      seen,
      visited,
    });
    return {
      boundary: this.#opts.boundary,
      scope: this.#opts.scope,
      sources,
      gaps,
      counts: { directoriesVisited: visited.n, sources: sources.length, gaps: gaps.length },
      observedAt: this.#opts.now,
    };
  }

  // ---- Internal walk ------------------------------------------------------

  async #walk(
    dir: string,
    depth: number,
    targetsOut: ScanTarget[] | undefined,
    asTargets: boolean,
    sink:
      | {
          sources: FilesystemSource[];
          gaps: FilesystemGap[];
          seen: Set<string>;
          visited: { n: number };
        }
      | undefined,
  ): Promise<void> {
    if (depth > this.#opts.maxDepth) return;

    let entries: readonly FsDirEntry[];
    try {
      entries = await this.#opts.fs.list(dir);
    } catch (err) {
      // The directory itself is inaccessible — fail-visible gap (AC2/AC6), never a silent skip.
      if (sink && !sink.seen.has(dir)) {
        sink.seen.add(dir);
        sink.gaps.push(this.#makeGap(dir, 'inaccessible', describeProbeError(err), 'normal', []));
      }
      return;
    }

    if (sink) sink.visited.n += 1;

    const childDirs = entries.filter((e) => e.kind === 'directory');

    // Classify THIS directory from its own markers.
    const { classification, markers } = classificationFor(entries);
    const isSource = markers.length > 0 || classification !== UNKNOWN_CLASSIFICATION;

    if (asTargets) {
      // Emit this directory as a candidate ScanTarget (registered flag left false — discovery edge).
      if (depth > 0 || isSource) {
        targetsOut!.push({
          targetId: dir,
          scope: this.#opts.scope,
          location: safeLocation(dir),
          registered: false,
        });
      }
    } else if (sink && depth > 0 && !sink.seen.has(dir)) {
      // Reconcile this directory into a source or a gap.
      sink.seen.add(dir);
      await this.#reconcile(dir, entries, classification, markers, isSource, sink);
    }

    // Descend into non-excluded child directories.
    for (const child of childDirs) {
      const childPath = joinPath(dir, child.name);
      if (this.#opts.excludedDirNames.has(child.name)) {
        if (sink && !sink.seen.has(childPath)) {
          sink.seen.add(childPath);
          const sensitivity = detectSensitivity([child]);
          sink.gaps.push(
            this.#makeGap(childPath, 'excluded', `excluded-dir:${child.name}`, sensitivity, []),
          );
        }
        continue; // excluded → visible gap, not descended
      }
      await this.#walk(childPath, depth + 1, targetsOut, asTargets, sink);
    }
  }

  async #reconcile(
    dir: string,
    entries: readonly FsDirEntry[],
    classification: string,
    markers: readonly FsDirEntry[],
    isSource: boolean,
    sink: {
      sources: FilesystemSource[];
      gaps: FilesystemGap[];
      seen: Set<string>;
    },
  ): Promise<void> {
    const sensitivity = detectSensitivity(entries);
    const ownership = detectOwnership(entries);
    const owner = detectOwner(entries);
    const correlationId = safeLocation(dir); // AC3: all of this source's records share one id

    // Stat each marker for its metadata (size/mtime). A rejected stat is tolerated (skips that record).
    // First pass: gather each marker's stat + classification. Second pass adds correlation/deps once
    // the full set of present classifications for THIS source is known (AC3 dependency edges).
    type RawRecord = {
      marker: string;
      kind: FsEntryKind;
      classification: string;
      size: number;
      mtimeMs: EpochMillis;
    };
    const raw: RawRecord[] = [];
    let newestMtime = Number.NEGATIVE_INFINITY;
    for (const m of markers) {
      const markerPath = joinPath(dir, m.name);
      try {
        const st = await this.#opts.fs.stat(markerPath);
        const markerClass =
          SOURCE_MARKERS.find((d) => d.marker === m.name)?.classification ?? classification;
        raw.push({
          marker: m.name,
          kind: st.kind,
          classification: markerClass,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
        if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs;
      } catch {
        // stat rejected for this marker — omit its record; freshness handled below.
      }
    }

    // AC3: build the DISTINCT, CORRELATED source records. Each carries the shared correlationId, a
    // per-record STATUS (its own mtime vs the horizon — records under one source can differ), and its
    // DEPENDENCY edges across the named source systems present here.
    const presentClasses = new Set(raw.map((r) => r.classification));
    const records: SourceRecordObservation[] = raw.map((r) => {
      const recordAge = this.#opts.now - r.mtimeMs;
      const status: 'current' | 'stale' =
        recordAge <= this.#opts.freshnessHorizonMs ? 'current' : 'stale';
      return {
        marker: r.marker,
        kind: r.kind,
        classification: r.classification,
        size: r.size,
        mtimeMs: r.mtimeMs,
        correlationId,
        status,
        dependsOn: dependenciesFor(r.classification, presentClasses),
      };
    });

    // ---- Freshness / confidence / health (AC4) ----
    let freshness: FsFreshness;
    let confidence: number;
    if (records.length === 0) {
      freshness = 'unknown';
      confidence = 0;
    } else {
      const age = this.#opts.now - newestMtime;
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
      location: dir,
      classification,
      onboarding: 'discovered',
      reachable: true,
      evidence: { markers: markers.map((m) => m.name), entryCount: entries.length },
    });
    // Defensive post-condition: nothing but metadata is ever written.
    if (!isMetadataOnly(metadata)) {
      throw new Error(`filesystem scanner produced a non-metadata record for ${dir}`);
    }

    // ---- Decide: healthy source vs governed-source gap (AC2/AC5/AC6) ----
    // A directory becomes a GAP if it is not a supported source, is sensitive, is unowned, or is stale.
    let gapReason: FsGapReason | null = null;
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
          dir,
          gapReason,
          `class=${classification};sensitivity=${sensitivity};ownership=${ownership};freshness=${freshness}`,
          sensitivity,
          records,
          newestMtime === Number.NEGATIVE_INFINITY ? null : newestMtime,
        ),
      );
      return;
    }

    // A healthy, supported, owned, fresh source — appears ONCE with the full AC1 facet set.
    const access: FsAccessStatus = 'reachable';
    const identity = safeLocation(dir); // disclosure-safe identity — a secret-named dir never leaks
    sink.sources.push({
      // facet 1 — TYPE
      type: classification,
      classification,
      // facet 2 — SOURCE IDENTITY
      targetId: identity,
      sourceIdentity: identity,
      scope: this.#opts.scope,
      location: safeLocation(dir),
      access,
      sensitivity,
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
    dir: string,
    reason: FsGapReason,
    detail: string,
    sensitivity: FsSensitivity,
    records: readonly SourceRecordObservation[],
    lastKnownMtime?: EpochMillis | null,
  ): FilesystemGap {
    const metadata = this.#metadataFor({
      location: dir,
      classification: reason,
      onboarding: 'gap',
      reachable: reason !== 'inaccessible',
      evidence: { records: records.length },
    });
    if (!isMetadataOnly(metadata)) {
      throw new Error(`filesystem scanner produced a non-metadata gap record for ${dir}`);
    }
    // Age is measured from the last-known observation when we have one, else 0 (first sighting now).
    const firstObserved = lastKnownMtime ?? this.#opts.now;
    const ageMs = Math.max(0, this.#opts.now - firstObserved);
    return {
      targetId: safeLocation(dir), // disclosure-safe identity
      scope: this.#opts.scope,
      location: safeLocation(dir),
      reason,
      detail: safeLocation(detail),
      impact: impactForGap(reason, sensitivity),
      ownerAction: ownerActionForGap(reason),
      ageMs,
      observedAt: this.#opts.now,
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
export function describeProbeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message;
    if (looksLikeSecretValue(msg)) return err.name || 'Error';
    return `${err.name}:${msg.slice(0, 120)}`;
  }
  const s = String(err);
  return looksLikeSecretValue(s) ? 'error' : s.slice(0, 120);
}
