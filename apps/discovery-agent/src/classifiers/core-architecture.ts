// @trustcircle/discovery-agent — CORE-ARCHITECTURE candidate classifier (two-axis, advisory only).
//
// Phase 69 / task T069 / bundle 36GCYGDJ15PTYP60F91QWRAY2M / user story US1.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// The filesystem / runtime scanners (Phase 67/68) DISCOVER sources by marker name and report each as a
// metadata-only observation with a coarse `classification` string (`git-repository`, `kanban`,
// `agentctl`, `workflow_orchestration`, `unknown`, …). This module takes those discovered
// classifications and places each candidate on the TWO SEPARATE governance axes the domain defines in
// `@trustcircle/domain` (`packages/domain/src/component-profile.ts`, Phase 52 / NFR-010):
//
//   1. the OWNER-APPROVED ARCHITECTURE ROLE  — stable design intent (ARCHITECTURE_ROLES)
//   2. the RUNTIME AVAILABILITY CLASS        — how essential to the running platform (AVAILABILITY_CLASSES)
//
// It classifies LISA and Wiggum as ARCHITECTURE-CORE CANDIDATES, and classifies Kanban,
// workflow_orchestration, agentctl, OpenClaw, AgentEs, AgentES-OilGas, MCP, Terraform, NetBox,
// deployment consoles, and the catch-all `unknown` candidate on BOTH axes.
//
// ---------------------------------------------------------------------------
// THE "CANDIDATE, NOT ONBOARDED" CONTRACT (the whole point of the phase)
// ---------------------------------------------------------------------------
// The classifier is ADVISORY. It proposes an axis placement; it NEVER onboards. Concretely:
//
//   1. It does NOT construct a validated `ArchitectureRoleProfile`. Per the domain, that is stable
//      design intent that only exists after a NAMED OWNER approves it with a mandatory review date
//      (`assertArchitectureRoleProfile`). A classifier cannot forge owner approval, so it emits a
//      PROPOSED role and an explicit `ownerApprovalRequired: true`, never an approved profile.
//   2. It does NOT register / onboard the candidate. Every emitted record keeps `registered: false`
//      and an `onboarding` state of `discovered` (a proposed candidate) or `gap` (a visible
//      governed-source gap). Nothing here flips a source to `registered`. The availability CLASS it
//      proposes is likewise a candidate placement, not a live-observed runtime fact.
//   3. It is metadata-only. Every durable record flows through `toMetadataOnlyRecord` and is asserted
//      `isMetadataOnly`; a candidate name that is secret-shaped is redacted via `safeCandidateId`.
//
// Because of (1)–(3), the classifier's output can be inspected afterward and shown to be advice —
// proposed axes + the owner action still required — rather than an accomplished onboarding.
//
// ---------------------------------------------------------------------------
// HOW IT MAPS TO THE ACCEPTANCE CRITERIA
// ---------------------------------------------------------------------------
//   AC1  Each classified candidate renders ONCE with its full inventory facet set: type, source
//        identity, owner, lifecycle state, risk, control coverage, evidence state, health,
//        last-observation time, and unresolved issues — PLUS the two axes (proposed architecture role,
//        architecture-core membership, proposed availability class). (`ArchitectureCandidate`.)
//   AC2  A discovered-but-unmanaged candidate (unknown type, or a known type that cannot be placed on
//        an axis) stays a VISIBLE coverage gap with reason + age + impact + owner action, never dropped.
//   AC3  The distinct named source systems (Kanban, agentctl, workflow_orchestration) are kept as
//        SEPARATE records under one correlated classification pass — sharing a `correlationId`,
//        carrying per-record STATUS differences (current vs stale by their own observation age), and
//        DEPENDENCY edges between them across the named systems.
//   AC4  A candidate whose backing observation is stale (older than the freshness horizon) or absent is
//        marked with its last-known time + confidence, and its axes/health are NOT asserted from stale
//        data (placement→proposed-only, health→unknown, `axisAssertable: false`).
//   AC5  An UNREGISTERED / unknown candidate is added to the view with discovery evidence, a
//        type-or-unknown classification, both proposed axes (or `unknown`), and an onboarding state —
//        never silently onboarded.
//   AC6  A candidate that is unsupported / unplaceable / sensitive / unowned / stale stays a VISIBLE
//        governed-source gap with reason, impact, owner action, and a review-or-expiry date.
//
// The module is pure/deterministic given its inputs and an explicit `now` epoch — no wall-clock reads,
// no ambient IO — so every criterion is exercised by fixture inputs.

import {
  toMetadataOnlyRecord,
  isMetadataOnly,
  type EpochMillis,
  type ScanScope,
  type OnboardingState,
  type MetadataOnlyRecord,
} from '../main.ts';
import {
  ARCHITECTURE_ROLES,
  AVAILABILITY_CLASSES,
  isArchitectureRole,
  isAvailabilityClass,
  type ArchitectureRole,
  type AvailabilityClass,
} from '@trustcircle/domain';
import { looksLikeSecretValue, REDACTED_PLACEHOLDER } from '@trustcircle/observability';

// ===========================================================================
// 1. Candidate vocabulary — the discovered systems this phase classifies
// ===========================================================================

/**
 * The closed set of candidate CLASSIFICATIONS this phase places on the two axes. These are the marker
 * classifications the scanners emit (`kanban`, `agentctl`, `workflow_orchestration`, …) plus the named
 * agent/infrastructure systems the spec calls out (LISA, Wiggum, OpenClaw, AgentEs, AgentES-OilGas,
 * MCP, Terraform, NetBox, deployment consoles) and the catch-all `unknown`. Keying off the NAME only —
 * never any content of the discovered source — keeps the classifier metadata-only.
 */
export const CANDIDATE_CLASSIFICATIONS = [
  'lisa',
  'wiggum',
  'kanban',
  'workflow_orchestration',
  'agentctl',
  'openclaw',
  'agentes',
  'agentes-oilgas',
  'mcp',
  'terraform',
  'netbox',
  'deployment-console',
  'unknown',
] as const;
export type CandidateClassification = (typeof CANDIDATE_CLASSIFICATIONS)[number];

/** The classification used when a discovered candidate matches none of the known systems (AC2/AC5). */
export const UNKNOWN_CANDIDATE = 'unknown' as const;

export function isCandidateClassification(s: unknown): s is CandidateClassification {
  return typeof s === 'string' && (CANDIDATE_CLASSIFICATIONS as readonly string[]).includes(s);
}

/**
 * Normalize a raw discovered classification / marker string into a canonical candidate classification.
 * Aliases the scanner vocabulary (`git-repository`, `workflows`, `.github`, `node-package`) and common
 * spellings onto the closed set. Anything unrecognized becomes `unknown` (never a silent drop). Reads
 * the NAME only.
 */
export function normalizeCandidate(raw: string): CandidateClassification {
  const key = raw.trim().toLowerCase();
  if (isCandidateClassification(key)) return key;
  switch (key) {
    case 'lisa-orchestrator':
    case 'lisa-agent':
      return 'lisa';
    case 'wiggum-snapshot':
    case 'wiggum-adapter':
      return 'wiggum';
    case '.kanban':
    case 'kanban.json':
    case 'kanban-board':
      return 'kanban';
    case 'agentctl.yaml':
    case 'agentctl.yml':
      return 'agentctl';
    case '.github':
    case 'workflows':
    case 'workflow-orchestration':
    case 'github-actions':
      return 'workflow_orchestration';
    case 'open-claw':
    case 'openclaw-agent':
      return 'openclaw';
    case 'agent-es':
    case 'agentes-agent':
      return 'agentes';
    case 'agentes-oil-gas':
    case 'agentes_oilgas':
      return 'agentes-oilgas';
    case 'model-context-protocol':
    case 'mcp-server':
    case 'gnmi-mcp':
      return 'mcp';
    case 'tf':
    case 'terraform-module':
      return 'terraform';
    case 'net-box':
    case 'netbox-dcim':
      return 'netbox';
    case 'deployment-consoles':
    case 'deploy-console':
    case 'deployment_console':
      return 'deployment-console';
    default:
      return UNKNOWN_CANDIDATE;
  }
}

// ===========================================================================
// 2. The two axes — proposed placement, never an approved profile
// ===========================================================================

/**
 * The canonical, hand-authored TWO-AXIS placement table. For each known candidate it records:
 *   - `role`               — the PROPOSED owner-approved architecture role (a valid ARCHITECTURE_ROLES
 *                            member). Proposed only: it is design intent AWAITING owner approval.
 *   - `architectureCore`   — whether the candidate is part of the CORE architecture (LISA & Wiggum are).
 *   - `availability`       — the PROPOSED runtime availability class (a valid AVAILABILITY_CLASSES
 *                            member). Proposed only: the LIVE class is a separate observed fact.
 *   - `rationale`          — a disclosure-safe, human-readable reason for the placement (metadata).
 *
 * Per the spec's availability rule: "LISA and Wiggum are part of the core architecture but may be
 * activated on demand" — so both are `architectureCore: true` with availability `on-demand`. The two
 * axes are deliberately independent: core membership (architecture) does NOT imply `core` availability.
 */
export interface AxisPlacement {
  readonly role: ArchitectureRole;
  readonly architectureCore: boolean;
  readonly availability: AvailabilityClass;
  readonly rationale: string;
}

const PLACEMENTS: Readonly<Record<Exclude<CandidateClassification, 'unknown'>, AxisPlacement>> = {
  // ---- Architecture-core candidates (LISA & Wiggum) — on-demand availability ----
  lisa: {
    role: 'control-plane',
    architectureCore: true,
    availability: 'on-demand',
    rationale:
      'architecture-core: LISA orchestrates governed jobs/phases/gates; activated on demand',
  },
  wiggum: {
    role: 'connector',
    architectureCore: true,
    availability: 'on-demand',
    rationale:
      'architecture-core: Wiggum is a read-only feature-state snapshot; activated on demand',
  },
  // ---- Named platform adapters — optional, part of governance but not core-required ----
  kanban: {
    role: 'connector',
    architectureCore: false,
    availability: 'optional',
    rationale: 'optional connector: Kanban board state is read/observed, not core-required',
  },
  workflow_orchestration: {
    role: 'worker',
    architectureCore: false,
    availability: 'optional',
    rationale:
      'optional worker: workflow_orchestration runs background pipelines; not core-required',
  },
  agentctl: {
    role: 'controller',
    architectureCore: false,
    availability: 'optional',
    rationale: 'optional controller: agentctl executes governed operations against a target',
  },
  // ---- External agent systems — on-demand connectors/controllers ----
  openclaw: {
    role: 'connector',
    architectureCore: false,
    availability: 'on-demand',
    rationale: 'on-demand connector: OpenClaw is an external agent source observed when activated',
  },
  agentes: {
    role: 'connector',
    architectureCore: false,
    availability: 'on-demand',
    rationale: 'on-demand connector: AgentEs is an external agent source observed when activated',
  },
  'agentes-oilgas': {
    role: 'connector',
    architectureCore: false,
    availability: 'on-demand',
    rationale: 'on-demand connector: AgentES-OilGas is a domain-specific external agent source',
  },
  mcp: {
    role: 'connector',
    architectureCore: false,
    availability: 'on-demand',
    rationale: 'on-demand connector: MCP server is read/observed via metadata when activated',
  },
  // ---- Infrastructure systems — on-demand controllers/connectors ----
  terraform: {
    role: 'controller',
    architectureCore: false,
    availability: 'on-demand',
    rationale: 'on-demand controller: Terraform applies infrastructure change when activated',
  },
  netbox: {
    role: 'connector',
    architectureCore: false,
    availability: 'on-demand',
    rationale: 'on-demand connector: NetBox is a DCIM source-of-record observed on demand',
  },
  'deployment-console': {
    role: 'controller',
    architectureCore: false,
    availability: 'on-demand',
    rationale: 'on-demand controller: a deployment console drives releases when activated',
  },
} as const;

// Defensive: every placement must reference a VALID domain role / availability class. This runs once at
// module load, turning a typo in the table into an immediate hard failure rather than silent bad advice.
for (const [candidate, p] of Object.entries(PLACEMENTS)) {
  if (!isArchitectureRole(p.role)) {
    throw new Error(`core-architecture: candidate "${candidate}" has an invalid architecture role`);
  }
  if (!isAvailabilityClass(p.availability)) {
    throw new Error(
      `core-architecture: candidate "${candidate}" has an invalid availability class`,
    );
  }
}

/** Look up the proposed two-axis placement for a candidate, or `null` for the unknown catch-all. */
export function placementFor(candidate: CandidateClassification): AxisPlacement | null {
  if (candidate === UNKNOWN_CANDIDATE) return null;
  return PLACEMENTS[candidate];
}

// ===========================================================================
// 3. Facet vocabularies (AC1) + gap vocabularies (AC2/AC6)
// ===========================================================================

/** Freshness of the backing observation (AC4). */
export const CA_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type CaFreshness = (typeof CA_FRESHNESS)[number];

/** AC1 lifecycle state of a candidate — derived from freshness + whether it is placeable. */
export const CA_LIFECYCLE_STATES = ['candidate', 'dormant', 'unknown'] as const;
export type CaLifecycleState = (typeof CA_LIFECYCLE_STATES)[number];

/** AC1 risk level of a candidate placement. */
export const CA_RISK_LEVELS = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
export type CaRiskLevel = (typeof CA_RISK_LEVELS)[number];

/**
 * AC1 control coverage: can this candidate be governed once onboarded? `covered` = placeable on BOTH
 * axes AND owned; `partial` = placeable but unowned (or vice-versa); `uncovered` = neither; `unknown` =
 * coverage cannot be assessed (stale/unknown observation).
 */
export const CA_CONTROL_COVERAGE = ['covered', 'partial', 'uncovered', 'unknown'] as const;
export type CaControlCoverage = (typeof CA_CONTROL_COVERAGE)[number];

/** AC1 evidence state — the quality of the discovery evidence backing the classification. */
export const CA_EVIDENCE_STATES = ['attested', 'stale-evidence', 'absent'] as const;
export type CaEvidenceState = (typeof CA_EVIDENCE_STATES)[number];

/**
 * AC1/AC4 health of a candidate. Only ever `healthy` when data is FRESH and the candidate is fully
 * placeable and owned; `degraded` when fresh but with an open concern; `unknown` whenever data is
 * stale/absent (health is NEVER inferred from stale data — AC4).
 */
export const CA_HEALTH_STATES = ['healthy', 'degraded', 'unknown'] as const;
export type CaHealthState = (typeof CA_HEALTH_STATES)[number];

/** AC1 unresolved-issue tags — a disclosure-safe, closed vocabulary. */
export const CA_ISSUE_TAGS = [
  'owner-approval-required', // ALWAYS: an axis placement is a proposal awaiting owner approval
  'unowned',
  'unplaceable', // no valid role/availability could be proposed (unknown candidate)
  'stale',
  'evidence-absent',
] as const;
export type CaIssueTag = (typeof CA_ISSUE_TAGS)[number];

/** Why a candidate is a governed-source GAP rather than a placeable candidate (AC2/AC6). */
export const CA_GAP_REASONS = [
  'unsupported', // unknown candidate — no known system to place on an axis
  'unplaceable', // known name but its placement could not be resolved to valid axes
  'unowned', // no declared owner
  'stale', // backing observation older than the freshness horizon
] as const;
export type CaGapReason = (typeof CA_GAP_REASONS)[number];

export const CA_GAP_IMPACTS = ['low', 'medium', 'high', 'critical', 'unknown'] as const;
export type CaGapImpact = (typeof CA_GAP_IMPACTS)[number];

// ===========================================================================
// 4. Observation records — the durable, independently-readable witnesses
// ===========================================================================

/**
 * A single discovered NAMED-SYSTEM record within one classification pass. AC3: the named source systems
 * (Kanban, agentctl, workflow_orchestration, …) are kept as SEPARATE records under one correlated pass,
 * so a drill-down can show their distinct source records, per-record status, and dependency edges. Each
 * record is metadata only — a candidate name + observation age + proposed axes, never any content.
 */
export interface CandidateRecordObservation {
  /** The candidate classification this record is for (e.g. 'kanban', 'agentctl'). */
  readonly candidate: CandidateClassification;
  /** The PROPOSED architecture role, or `null` when the candidate is unplaceable. */
  readonly proposedRole: ArchitectureRole | null;
  /** The PROPOSED availability class, or `null` when the candidate is unplaceable. */
  readonly proposedAvailability: AvailabilityClass | null;
  /** Whether the candidate is an architecture-CORE candidate (LISA/Wiggum). */
  readonly architectureCore: boolean;
  /** The last-known observation time for THIS record — the authoritative freshness field. */
  readonly lastObservedAt: EpochMillis;
  /**
   * AC3 correlation key: the id of the classification pass this record belongs to. All records in one
   * pass share one `correlationId`, tying the distinct records together under one governed view.
   */
  readonly correlationId: string;
  /**
   * AC3 per-record STATUS: two records in the same pass can differ — a kanban observed today is
   * `current` while an agentctl past the horizon is `stale` — derived from THIS record's own age.
   */
  readonly status: 'current' | 'stale';
  /**
   * AC3 DEPENDENCY edges across the named systems present in the same pass (e.g.
   * workflow_orchestration depends on the agentctl + kanban it drives; agentctl depends on kanban).
   * Correlated by candidate NAME within the pass — never a cross-source content read.
   */
  readonly dependsOn: readonly CandidateClassification[];
}

/**
 * A classified candidate — one reconciled entry per candidate. Carries the full AC1 facet set PLUS the
 * two axes (proposed role, architecture-core membership, proposed availability class) and the explicit
 * `ownerApprovalRequired` / `registered: false` witnesses that prove this is advice, not onboarding.
 */
export interface ArchitectureCandidate {
  // ---- AC1 facet 1: TYPE ----------------------------------------------------
  readonly type: CandidateClassification;
  readonly classification: CandidateClassification;

  // ---- AC1 facet 2: SOURCE IDENTITY ----------------------------------------
  readonly candidateId: string;
  readonly sourceIdentity: string;
  readonly scope: ScanScope;
  readonly location: string;

  // ---- AXIS 1: owner-approved ARCHITECTURE ROLE (proposed) ------------------
  /** The PROPOSED architecture role. Proposed, not approved — see `ownerApprovalRequired`. */
  readonly proposedRole: ArchitectureRole;
  /** Whether this candidate is part of the CORE architecture (LISA/Wiggum ⇒ true). */
  readonly architectureCore: boolean;

  // ---- AXIS 2: runtime AVAILABILITY CLASS (proposed) -----------------------
  /** The PROPOSED runtime availability class. A candidate placement, not a live-observed fact. */
  readonly proposedAvailability: AvailabilityClass;

  // ---- The "candidate, not onboarded" witnesses ----------------------------
  /** ALWAYS true: an architecture role is design intent that requires a NAMED owner's approval. */
  readonly ownerApprovalRequired: true;
  /** ALWAYS false: the classifier proposes; it never registers/onboards a source. */
  readonly registered: false;
  /** Onboarding state — `discovered` for a placeable candidate; never `registered`. */
  readonly onboarding: OnboardingState;
  /** Whether the axis placement may be ASSERTED — false whenever the backing data is stale (AC4). */
  readonly axisAssertable: boolean;

  // ---- AC1 facet 3: OWNER ---------------------------------------------------
  readonly owner: string | null;

  // ---- AC1 facet 4: LIFECYCLE STATE ----------------------------------------
  readonly lifecycleState: CaLifecycleState;

  // ---- AC1 facet 5: RISK ----------------------------------------------------
  readonly risk: CaRiskLevel;

  // ---- AC1 facet 6: CONTROL COVERAGE ---------------------------------------
  readonly controlCoverage: CaControlCoverage;

  // ---- AC1 facet 7: EVIDENCE STATE -----------------------------------------
  readonly evidenceState: CaEvidenceState;

  // ---- AC1 facet 8: HEALTH --------------------------------------------------
  readonly health: CaHealthState;
  /** Confidence in [0,1]: 1 when a fresh observation backs the placement, decayed when stale (AC4). */
  readonly confidence: number;
  readonly freshness: CaFreshness;

  /** The AC3 correlated named-system records observed in this pass (discovery evidence). */
  readonly records: readonly CandidateRecordObservation[];

  // ---- AC1 facet 9: LAST OBSERVATION TIME ----------------------------------
  readonly observedAt: EpochMillis;

  // ---- AC1 facet 10: UNRESOLVED ISSUES -------------------------------------
  readonly unresolvedIssues: readonly CaIssueTag[];

  /** Disclosure-safe human-readable rationale for the placement (metadata). */
  readonly rationale: string;

  /** The metadata-only record persisted to the durable evidence sink — never protected content. */
  readonly metadata: MetadataOnlyRecord;
}

/**
 * A candidate GAP — visible but NOT a clean placement: unsupported (unknown), unplaceable, unowned, or
 * stale. AC2/AC6: it stays in the reconciled view with a reason, an age, an impact, a required owner
 * action, and a mandatory review-or-expiry date — rather than disappearing or looking onboarded.
 */
export interface ArchitectureGap {
  readonly candidateId: string;
  readonly scope: ScanScope;
  readonly location: string;
  readonly reason: CaGapReason;
  readonly detail: string;
  readonly impact: CaGapImpact;
  readonly ownerAction: string;
  readonly ageMs: EpochMillis;
  readonly observedAt: EpochMillis;
  /** Governed-source gaps carry a review-or-expiry deadline (AC6). */
  readonly reviewBy: EpochMillis;
  readonly metadata: MetadataOnlyRecord;
}

/** The full result of one classification pass — candidates + gaps together, plus counts. */
export interface CoreArchitectureReport {
  readonly scope: ScanScope;
  readonly candidates: readonly ArchitectureCandidate[];
  readonly gaps: readonly ArchitectureGap[];
  /**
   * AC3: every DISTINCT named-system record observed in this pass, all sharing ONE `correlationId`,
   * each with its own current/stale status and dependency edges across the named systems. This is the
   * drill-down surface that shows the distinct source records / correlation / dependencies across
   * Kanban, agentctl, and workflow_orchestration for a single correlated pass.
   */
  readonly records: readonly CandidateRecordObservation[];
  /** The single correlation id shared by every record in this pass (AC3). */
  readonly correlationId: string;
  readonly counts: {
    readonly considered: number;
    readonly candidates: number;
    readonly gaps: number;
    readonly architectureCore: number;
  };
  readonly observedAt: EpochMillis;
}

// ===========================================================================
// 5. Inputs / options
// ===========================================================================

/**
 * One discovered candidate to classify — the metadata-only projection of a scanner observation. The
 * classifier reads only the NAME-derived `classification`, the identity/location, an optional declared
 * owner reference, and the last-known observation time. No content is ever supplied or read.
 */
export interface DiscoveredCandidate {
  /** The raw discovered classification / marker string (normalized internally). */
  readonly classification: string;
  /** Stable identity of the discovered source within the boundary. */
  readonly identity: string;
  /** Where the candidate lives (locator) — recorded in discovery evidence. */
  readonly location: string;
  /** A disclosure-safe declared-owner reference (e.g. `declared-by:CODEOWNERS`), or null when unowned. */
  readonly owner?: string | null;
  /** Last-known observation time (epoch ms) for the backing discovery — the freshness source (AC4). */
  readonly lastObservedAt: EpochMillis;
}

export interface CoreArchitectureClassifyOptions {
  /** The least-privilege scope every classified candidate is tagged with. */
  readonly scope: ScanScope;
  /** Explicit observation time (epoch ms) — injected so classification is deterministic. */
  readonly now: EpochMillis;
  /** Freshness horizon in ms. A candidate whose observation is older than `now − horizon` is STALE. */
  readonly freshnessHorizonMs: number;
  /** Default review window (ms) added to `now` for governed-source gaps. Default 7 days. */
  readonly gapReviewWindowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ===========================================================================
// 6. Pure helpers — deterministic, metadata-only
// ===========================================================================

/**
 * Disclosure-safe identity for a candidate. A path/id SEGMENT that itself looks secret-shaped is
 * replaced with the placeholder while benign segments survive, so the durable identity never carries a
 * secret VALUE. Mirrors the scanners' `safeLocation`.
 */
export function safeCandidateId(id: string): string {
  if (!looksLikeSecretValue(id)) return id;
  const parts = id.split(/([/:])/); // keep the separators so structure survives
  const safe = parts.map((seg) =>
    seg === '/' || seg === ':' ? seg : looksLikeSecretValue(seg) ? REDACTED_PLACEHOLDER : seg,
  );
  const rejoined = safe.join('');
  return looksLikeSecretValue(rejoined) ? REDACTED_PLACEHOLDER : rejoined;
}

/** AC4: is the observation fresh relative to the horizon? */
function freshnessOf(lastObservedAt: EpochMillis, now: EpochMillis, horizon: number): CaFreshness {
  if (!Number.isFinite(lastObservedAt)) return 'unknown';
  const age = now - lastObservedAt;
  return age <= horizon ? 'fresh' : 'stale';
}

/** AC4: confidence in the placement — 1 when fresh, linear decay to a 0.1 floor when stale, 0 unknown. */
function confidenceOf(freshness: CaFreshness, age: number, horizon: number): number {
  if (freshness === 'unknown') return 0;
  if (freshness === 'fresh') return 1;
  const over = Math.max(0, age - horizon);
  return Math.max(0.1, 1 - over / horizon);
}

/** AC1 lifecycle: a fresh, placeable candidate is `candidate`; stale ⇒ `dormant`; unknown ⇒ `unknown`. */
function deriveLifecycle(freshness: CaFreshness, placeable: boolean): CaLifecycleState {
  if (freshness === 'unknown') return 'unknown';
  if (!placeable) return 'unknown';
  return freshness === 'fresh' ? 'candidate' : 'dormant';
}

/** AC1 risk rollup: unplaceable/unknown is highest; unowned and stale raise it; a clean core is low. */
function deriveRisk(
  placeable: boolean,
  owned: boolean,
  freshness: CaFreshness,
  architectureCore: boolean,
): CaRiskLevel {
  if (freshness === 'unknown') return 'unknown';
  if (!placeable) return 'high';
  // A core-architecture candidate that is unowned or stale is a HIGHER governance concern.
  if (!owned) return architectureCore ? 'high' : 'medium';
  if (freshness !== 'fresh') return 'medium';
  return 'low';
}

/** AC1 control coverage: placeable AND owned ⇒ covered; one ⇒ partial; neither ⇒ uncovered. */
function deriveControlCoverage(
  placeable: boolean,
  owned: boolean,
  freshness: CaFreshness,
): CaControlCoverage {
  if (freshness === 'unknown') return 'unknown';
  if (placeable && owned) return 'covered';
  if (placeable || owned) return 'partial';
  return 'uncovered';
}

/** AC1 evidence state derived from record count + freshness (distinct from freshness itself). */
function deriveEvidenceState(recordCount: number, freshness: CaFreshness): CaEvidenceState {
  if (recordCount === 0 || freshness === 'unknown') return 'absent';
  return freshness === 'fresh' ? 'attested' : 'stale-evidence';
}

/** AC1/AC4 health: only `healthy` when fresh, placeable, and owned; never inferred from stale data. */
function deriveHealth(freshness: CaFreshness, placeable: boolean, owned: boolean): CaHealthState {
  if (freshness !== 'fresh') return 'unknown'; // AC4: never assert health from stale/unknown data
  if (!placeable || !owned) return 'degraded';
  return 'healthy';
}

/** AC1 unresolved issues: a closed-vocabulary rollup of every open governance concern. */
function deriveUnresolvedIssues(
  placeable: boolean,
  owned: boolean,
  freshness: CaFreshness,
  recordCount: number,
): CaIssueTag[] {
  const issues: CaIssueTag[] = [];
  // An axis placement is ALWAYS a proposal awaiting a named owner's approval — never onboarded here.
  issues.push('owner-approval-required');
  if (!placeable) issues.push('unplaceable');
  if (!owned) issues.push('unowned');
  if (freshness === 'stale' || freshness === 'unknown') issues.push('stale');
  if (recordCount === 0) issues.push('evidence-absent');
  return issues;
}

/**
 * AC3 dependency edges between the DISTINCT candidate records of ONE pass. Derived from candidate NAME
 * only (never content): a workflow_orchestration drives the agentctl + kanban it orchestrates; an
 * agentctl drives the kanban board; a deployment-console drives terraform. Only edges whose target is
 * actually present in the pass are emitted, so the graph reflects what was really discovered.
 */
function dependenciesFor(
  candidate: CandidateClassification,
  present: ReadonlySet<CandidateClassification>,
): CandidateClassification[] {
  const deps: CandidateClassification[] = [];
  const add = (c: CandidateClassification) => {
    if (c !== candidate && present.has(c)) deps.push(c);
  };
  switch (candidate) {
    case 'workflow_orchestration':
      add('agentctl');
      add('kanban');
      break;
    case 'agentctl':
      add('kanban');
      break;
    case 'deployment-console':
      add('terraform');
      break;
    case 'lisa':
      add('agentctl');
      add('kanban');
      break;
    default:
      break;
  }
  return deps;
}

function impactForGap(reason: CaGapReason): CaGapImpact {
  switch (reason) {
    case 'unsupported':
      return 'medium';
    case 'unplaceable':
      return 'medium';
    case 'unowned':
      return 'medium';
    case 'stale':
      return 'medium';
    default:
      return 'unknown';
  }
}

function ownerActionForGap(reason: CaGapReason): string {
  switch (reason) {
    case 'unsupported':
      return 'assign-candidate-type-or-declare-unsupported';
    case 'unplaceable':
      return 'assign-architecture-role-and-availability-class';
    case 'unowned':
      return 'assign-accountable-owner';
    case 'stale':
      return 'refresh-discovery-or-mark-inactive';
    default:
      return 'review';
  }
}

// ===========================================================================
// 7. The classifier — advisory two-axis placement, no onboarding
// ===========================================================================

function metadataFor(
  scope: ScanScope,
  input: {
    location: string;
    classification: string;
    onboarding: OnboardingState | 'gap';
    evidence: unknown;
  },
): MetadataOnlyRecord {
  const record = toMetadataOnlyRecord({
    scope,
    location: input.location,
    classification: input.classification,
    onboarding: input.onboarding,
    // The classifier NEVER onboards: registered is hard-false, reachable is a discovery fact.
    registered: false,
    reachable: true,
    evidence: input.evidence,
  });
  if (!isMetadataOnly(record)) {
    throw new Error(
      `core-architecture classifier produced a non-metadata record for ${input.location}`,
    );
  }
  return record;
}

/**
 * Classify ONE discovered candidate onto both axes (advisory). Returns either a placed
 * `ArchitectureCandidate` (proposed role + availability + core flag, `registered:false`,
 * `ownerApprovalRequired:true`) or an `ArchitectureGap` for an unknown / unplaceable / unowned / stale
 * candidate. `records` are the AC3 correlated named-system records for the pass this candidate is in.
 */
export function classifyOne(
  discovered: DiscoveredCandidate,
  records: readonly CandidateRecordObservation[],
  opts: CoreArchitectureClassifyOptions,
): { candidate: ArchitectureCandidate } | { gap: ArchitectureGap } {
  const now = opts.now;
  const reviewWindow = opts.gapReviewWindowMs ?? 7 * DAY_MS;
  const classification = normalizeCandidate(discovered.classification);
  const identity = safeCandidateId(discovered.identity);
  const location = safeCandidateId(discovered.location);
  const owner = discovered.owner ?? null;
  const owned = typeof owner === 'string' && owner.trim().length > 0;

  const freshness = freshnessOf(discovered.lastObservedAt, now, opts.freshnessHorizonMs);
  const age = Number.isFinite(discovered.lastObservedAt) ? now - discovered.lastObservedAt : 0;
  const confidence = confidenceOf(freshness, age, opts.freshnessHorizonMs);

  const placement = placementFor(classification);
  const placeable = placement !== null;

  // ---- Decide: placeable candidate vs governed-source gap (AC2/AC5/AC6) ----
  // An UNKNOWN candidate is unsupported; a known-but-stale/unowned candidate is a visible gap too, so
  // that governance concerns never masquerade as a clean placement.
  let gapReason: CaGapReason | null = null;
  if (!placeable) {
    gapReason = classification === UNKNOWN_CANDIDATE ? 'unsupported' : 'unplaceable';
  } else if (freshness === 'stale' || freshness === 'unknown') {
    gapReason = 'stale';
  } else if (!owned) {
    gapReason = 'unowned';
  }

  if (gapReason) {
    const firstObserved = Number.isFinite(discovered.lastObservedAt)
      ? discovered.lastObservedAt
      : now;
    const ageMs = Math.max(0, now - firstObserved);
    const detail = `class=${classification};placeable=${String(placeable)};owned=${String(
      owned,
    )};freshness=${freshness}`;
    const gap: ArchitectureGap = {
      candidateId: identity,
      scope: opts.scope,
      location,
      reason: gapReason,
      detail: safeCandidateId(detail),
      impact: impactForGap(gapReason),
      ownerAction: ownerActionForGap(gapReason),
      ageMs,
      observedAt: now,
      reviewBy: now + reviewWindow,
      metadata: metadataFor(opts.scope, {
        location: discovered.location,
        classification: `${classification}:${gapReason}`,
        onboarding: 'gap',
        evidence: { records: records.length, freshness, owned },
      }),
    };
    return { gap };
  }

  // A placeable, owned, fresh candidate — a proposed placement on BOTH axes, still NOT onboarded.
  const p = placement as AxisPlacement;
  const candidate: ArchitectureCandidate = {
    // facet 1 — TYPE
    type: classification,
    classification,
    // facet 2 — SOURCE IDENTITY
    candidateId: identity,
    sourceIdentity: identity,
    scope: opts.scope,
    location,
    // AXIS 1 — proposed architecture role + core membership
    proposedRole: p.role,
    architectureCore: p.architectureCore,
    // AXIS 2 — proposed availability class
    proposedAvailability: p.availability,
    // candidate-not-onboarded witnesses
    ownerApprovalRequired: true,
    registered: false,
    onboarding: 'discovered',
    axisAssertable: freshness === 'fresh', // AC4: axes not asserted from stale data
    // facet 3 — OWNER
    owner,
    // facet 4 — LIFECYCLE STATE
    lifecycleState: deriveLifecycle(freshness, placeable),
    // facet 5 — RISK
    risk: deriveRisk(placeable, owned, freshness, p.architectureCore),
    // facet 6 — CONTROL COVERAGE
    controlCoverage: deriveControlCoverage(placeable, owned, freshness),
    // facet 7 — EVIDENCE STATE
    evidenceState: deriveEvidenceState(records.length, freshness),
    // facet 8 — HEALTH
    health: deriveHealth(freshness, placeable, owned),
    confidence,
    freshness,
    // AC3 correlated records
    records,
    // facet 9 — LAST OBSERVATION TIME
    observedAt: now,
    // facet 10 — UNRESOLVED ISSUES
    unresolvedIssues: deriveUnresolvedIssues(placeable, owned, freshness, records.length),
    rationale: p.rationale,
    metadata: metadataFor(opts.scope, {
      location: discovered.location,
      classification,
      onboarding: 'discovered',
      evidence: {
        proposedRole: p.role,
        proposedAvailability: p.availability,
        architectureCore: p.architectureCore,
        ownerApprovalRequired: true,
      },
    }),
  };
  return { candidate };
}

/**
 * Classify a whole pass of discovered candidates onto both axes (advisory). Produces a reconciled
 * `CoreArchitectureReport`: one placed `ArchitectureCandidate` per placeable/owned/fresh candidate and
 * one `ArchitectureGap` per unknown / unplaceable / unowned / stale candidate. Deterministic given the
 * inputs + `now`. Nothing is onboarded: every candidate keeps `registered:false`.
 *
 * AC3: the DISTINCT named systems in one pass share a `correlationId`, carry per-record current/stale
 * status by their own age, and dependency edges across the named systems present in the pass.
 */
export function classifyDiscoveries(
  discoveries: readonly DiscoveredCandidate[],
  opts: CoreArchitectureClassifyOptions,
): CoreArchitectureReport {
  if (!Number.isFinite(opts.now)) throw new RangeError('now must be a finite epoch-ms value');
  if (!(opts.freshnessHorizonMs > 0)) {
    throw new RangeError('freshnessHorizonMs must be a positive number');
  }
  const now = opts.now;

  // AC3: one correlation id for the whole pass; every record is tied to it.
  const correlationId = `core-arch-pass:${String(now)}`;

  // Build the DISTINCT correlated records first, so dependency edges can reference the present set.
  // Each record is paired with its originating discovery so no unchecked index access is needed later.
  const present = new Set<CandidateClassification>(
    discoveries.map((d) => normalizeCandidate(d.classification)),
  );
  const paired: ReadonlyArray<{
    readonly discovered: DiscoveredCandidate;
    readonly record: CandidateRecordObservation;
  }> = discoveries.map((d) => {
    const candidate = normalizeCandidate(d.classification);
    const placement = placementFor(candidate);
    const fresh = freshnessOf(d.lastObservedAt, now, opts.freshnessHorizonMs);
    const status: 'current' | 'stale' = fresh === 'fresh' ? 'current' : 'stale';
    const record: CandidateRecordObservation = {
      candidate,
      proposedRole: placement?.role ?? null,
      proposedAvailability: placement?.availability ?? null,
      architectureCore: placement?.architectureCore ?? false,
      lastObservedAt: d.lastObservedAt,
      correlationId,
      status,
      dependsOn: dependenciesFor(candidate, present),
    };
    return { discovered: d, record };
  });

  const candidates: ArchitectureCandidate[] = [];
  const gaps: ArchitectureGap[] = [];
  const seen = new Set<string>(); // reconciliation: one entry per identity
  let architectureCore = 0;

  for (const { discovered: d, record: own } of paired) {
    const key = safeCandidateId(d.identity);
    if (seen.has(key)) continue; // dedup — one reconciled row per identity
    seen.add(key);
    // Each candidate gets the SINGLE record that describes it (its own name), correlated to the pass.
    const outcome = classifyOne(d, [own], opts);
    if ('candidate' in outcome) {
      candidates.push(outcome.candidate);
      if (outcome.candidate.architectureCore) architectureCore += 1;
    } else {
      gaps.push(outcome.gap);
    }
  }

  return {
    scope: opts.scope,
    candidates,
    gaps,
    records: paired.map((p) => p.record),
    correlationId,
    counts: {
      considered: discoveries.length,
      candidates: candidates.length,
      gaps: gaps.length,
      architectureCore,
    },
    observedAt: now,
  };
}

// ===========================================================================
// 8. Re-exported domain axis vocabularies (convenience for consumers/tests)
// ===========================================================================

export {
  ARCHITECTURE_ROLES,
  AVAILABILITY_CLASSES,
  isArchitectureRole,
  isAvailabilityClass,
  type ArchitectureRole,
  type AvailabilityClass,
};
