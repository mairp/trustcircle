// @trustcircle/discovery-agent — INFRASTRUCTURE candidate classifier (two-axis, advisory only / T268).
//
// Phase 8 / User Story 6 — Maintain Source and Workflow Health / NFR-010.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// The named INFRASTRUCTURE systems the spec calls out — Cisco gNMI MCP, the LB Observer / mcp-lb,
// Terraform, NetBox, load-balancer automation, and deployment consoles — are metadata-only
// DISCOVERED sources. This module classifies each on TWO governance axes distinct from the agent /
// core-architecture classifiers:
//
//   (a) READ vs MUTATION RISK  — does the system merely OBSERVE infrastructure, or can it MUTATE it?
//       A read-only observer carries low blast radius; a mutating controller is a high-risk axis and
//       always requires an owner-approved activation path before it may drive change.
//   (b) DESIRED vs OBSERVED STATE — does the system express the DESIRED state (declarative intent,
//       e.g. Terraform / a source-of-record), the OBSERVED state (live telemetry, e.g. gNMI / an LB
//       observer), or BOTH (a reconciler that compares the two)?
//
// It ALSO places each on the domain two axes (architecture role + availability class) so the advisory
// output is consistent with the other classifiers. Keying off the NAME only (never any content of the
// discovered source) keeps the classifier metadata-only.
//
// ---------------------------------------------------------------------------
// THE "CANDIDATE, NOT ONBOARDED" CONTRACT (identical to core-architecture.ts)
// ---------------------------------------------------------------------------
// The classifier is ADVISORY. It proposes axis placements; it NEVER onboards and NEVER grants
// authority. Every record keeps `registered:false`, `ownerApprovalRequired:true`, and is metadata-only
// (flows through `toMetadataOnlyRecord`, asserted `isMetadataOnly`). A MUTATION-risk system is flagged
// but never activated here — `mutationRequiresApproval:true`. Returns are `Object.freeze`d.
//
// Deterministic given its inputs + an explicit `now` epoch — no wall-clock reads, no ambient IO.

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
// 1. Candidate vocabulary — the named infrastructure systems this classifier places
// ===========================================================================

export const INFRASTRUCTURE_CLASSIFICATIONS = [
  'cisco-gnmi-mcp',
  'lb-observer',
  'terraform',
  'netbox',
  'lb-automation',
  'deployment-console',
  'unknown',
] as const;
export type InfrastructureClassification = (typeof INFRASTRUCTURE_CLASSIFICATIONS)[number];

export const UNKNOWN_INFRASTRUCTURE = 'unknown' as const;

export function isInfrastructureClassification(s: unknown): s is InfrastructureClassification {
  return (
    typeof s === 'string' && (INFRASTRUCTURE_CLASSIFICATIONS as readonly string[]).includes(s)
  );
}

/**
 * Normalize a raw discovered classification / marker string onto the closed infrastructure set.
 * Aliases common spellings; anything unrecognized becomes `unknown` (never a silent drop). NAME only.
 */
export function normalizeInfrastructure(raw: string): InfrastructureClassification {
  const key = raw.trim().toLowerCase();
  if (isInfrastructureClassification(key)) return key;
  switch (key) {
    case 'gnmi-mcp':
    case 'cisco-gnmi':
    case 'gnmi':
      return 'cisco-gnmi-mcp';
    case 'mcp-lb':
    case 'lb-observer-mcp':
    case 'load-balancer-observer':
      return 'lb-observer';
    case 'terraform':
    case 'tf':
    case 'terraform-iac':
      return 'terraform';
    case 'net-box':
    case 'netbox-dcim':
      return 'netbox';
    case 'lb-automation-controller':
    case 'load-balancer-automation':
    case 'lb-driver':
      return 'lb-automation';
    case 'deployment-consoles':
    case 'deploy-console':
    case 'deployment_console':
      return 'deployment-console';
    default:
      return UNKNOWN_INFRASTRUCTURE;
  }
}

// ===========================================================================
// 2. The classifier's two axes: read-vs-mutation risk + desired-vs-observed state
// ===========================================================================

/** AXIS (a): does the system OBSERVE only, or can it MUTATE infrastructure? */
export const INTERACTION_MODES = ['read', 'mutation'] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

/** The blast-radius risk of the interaction mode. Read is low; mutation is high. */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** AXIS (b): which state facet the system expresses — desired intent, observed live, or both. */
export const STATE_FACETS = ['desired', 'observed', 'both'] as const;
export type StateFacet = (typeof STATE_FACETS)[number];

/**
 * The hand-authored TWO-AXIS placement for each named infrastructure system, plus the domain axes
 * (architecture role + availability class). A MUTATION system is high-risk and always requires an
 * owner-approved activation path — `mutationRequiresApproval:true` — before it may drive change.
 */
export interface InfrastructurePlacement {
  readonly interactionMode: InteractionMode;
  readonly risk: RiskLevel;
  readonly stateFacet: StateFacet;
  readonly role: ArchitectureRole;
  readonly availability: AvailabilityClass;
  /** True whenever the system can mutate — a mutating system is never activated without owner approval. */
  readonly mutationRequiresApproval: boolean;
  readonly rationale: string;
}

const PLACEMENTS: Readonly<
  Record<Exclude<InfrastructureClassification, 'unknown'>, InfrastructurePlacement>
> = {
  // Cisco gNMI MCP — reads live device telemetry (observed state); no mutation.
  'cisco-gnmi-mcp': {
    interactionMode: 'read',
    risk: 'low',
    stateFacet: 'observed',
    role: 'connector',
    availability: 'on-demand',
    mutationRequiresApproval: false,
    rationale:
      'read/observed: Cisco gNMI MCP subscribes to live device telemetry; no infrastructure mutation',
  },
  // LB Observer / mcp-lb — reads live load-balancer state (observed); no mutation.
  'lb-observer': {
    interactionMode: 'read',
    risk: 'low',
    stateFacet: 'observed',
    role: 'connector',
    availability: 'on-demand',
    mutationRequiresApproval: false,
    rationale:
      'read/observed: the LB Observer (mcp-lb) reads live load-balancer state; no infrastructure mutation',
  },
  // Terraform — declares desired state AND applies it (mutation).
  'terraform': {
    interactionMode: 'mutation',
    risk: 'high',
    stateFacet: 'both',
    role: 'controller',
    availability: 'on-demand',
    mutationRequiresApproval: true,
    rationale:
      'mutation/desired+observed: Terraform declares desired infra and APPLIES it — owner-approved activation required',
  },
  // NetBox — the DCIM source-of-record: the DESIRED/declared inventory; read as a source of record.
  netbox: {
    interactionMode: 'read',
    risk: 'low',
    stateFacet: 'desired',
    role: 'connector',
    availability: 'on-demand',
    mutationRequiresApproval: false,
    rationale:
      'read/desired: NetBox is the DCIM source-of-record for declared inventory; observed as a source of record',
  },
  // Load-balancer automation — drives LB configuration change (mutation) toward a desired state.
  'lb-automation': {
    interactionMode: 'mutation',
    risk: 'high',
    stateFacet: 'both',
    role: 'controller',
    availability: 'on-demand',
    mutationRequiresApproval: true,
    rationale:
      'mutation/desired+observed: load-balancer automation drives LB config change — owner-approved activation required',
  },
  // Deployment consoles — drive releases (mutation) toward a desired deployment.
  'deployment-console': {
    interactionMode: 'mutation',
    risk: 'high',
    stateFacet: 'both',
    role: 'controller',
    availability: 'on-demand',
    mutationRequiresApproval: true,
    rationale:
      'mutation/desired+observed: a deployment console drives releases — owner-approved activation required',
  },
} as const;

// Defensive: every placement must reference a VALID domain role / availability class. Runs at load.
for (const [candidate, p] of Object.entries(PLACEMENTS)) {
  if (!isArchitectureRole(p.role)) {
    throw new Error(`infrastructure: candidate "${candidate}" has an invalid architecture role`);
  }
  if (!isAvailabilityClass(p.availability)) {
    throw new Error(`infrastructure: candidate "${candidate}" has an invalid availability class`);
  }
  // A mutating system MUST require owner approval — a read-only one need not.
  if (p.interactionMode === 'mutation' && !p.mutationRequiresApproval) {
    throw new Error(`infrastructure: mutating candidate "${candidate}" must require owner approval`);
  }
}

export function infrastructurePlacementFor(
  candidate: InfrastructureClassification,
): InfrastructurePlacement | null {
  if (candidate === UNKNOWN_INFRASTRUCTURE) return null;
  return PLACEMENTS[candidate];
}

// ===========================================================================
// 3. Records — the durable, independently-readable, advisory witnesses
// ===========================================================================

export const INFRA_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type InfraFreshness = (typeof INFRA_FRESHNESS)[number];

/**
 * A classified infrastructure candidate — the read-vs-mutation axis, the desired-vs-observed axis,
 * the domain axes, and the `ownerApprovalRequired`/`registered:false` witnesses that prove this is
 * advice, not onboarding. `axisAssertable` is false whenever the backing data is stale.
 */
export interface InfrastructureCandidate {
  readonly type: InfrastructureClassification;
  readonly classification: InfrastructureClassification;
  readonly candidateId: string;
  readonly sourceIdentity: string;
  readonly scope: ScanScope;
  readonly location: string;
  // AXIS (a) — read vs mutation risk
  readonly interactionMode: InteractionMode;
  readonly risk: RiskLevel;
  readonly mutationRequiresApproval: boolean;
  // AXIS (b) — desired vs observed state
  readonly stateFacet: StateFacet;
  // domain axes
  readonly proposedRole: ArchitectureRole;
  readonly proposedAvailability: AvailabilityClass;
  // candidate-not-onboarded witnesses
  readonly ownerApprovalRequired: true;
  readonly registered: false;
  readonly onboarding: OnboardingState;
  readonly axisAssertable: boolean;
  readonly owner: string | null;
  readonly freshness: InfraFreshness;
  readonly observedAt: EpochMillis;
  readonly rationale: string;
  readonly metadata: MetadataOnlyRecord;
}

/** An unplaceable / unknown / stale infrastructure candidate kept as a VISIBLE governed-source gap. */
export interface InfrastructureGap {
  readonly candidateId: string;
  readonly scope: ScanScope;
  readonly location: string;
  readonly reason: 'unsupported' | 'stale';
  readonly detail: string;
  readonly ownerAction: string;
  readonly ageMs: EpochMillis;
  readonly observedAt: EpochMillis;
  readonly reviewBy: EpochMillis;
  readonly metadata: MetadataOnlyRecord;
}

/** The full result of one infrastructure classification pass. */
export interface InfrastructureReport {
  readonly scope: ScanScope;
  readonly candidates: readonly InfrastructureCandidate[];
  readonly gaps: readonly InfrastructureGap[];
  readonly counts: {
    readonly considered: number;
    readonly candidates: number;
    readonly gaps: number;
    readonly mutationCandidates: number;
  };
  readonly observedAt: EpochMillis;
}

// ===========================================================================
// 4. Inputs / options
// ===========================================================================

export interface DiscoveredInfrastructure {
  readonly classification: string;
  readonly identity: string;
  readonly location: string;
  readonly owner?: string | null;
  readonly lastObservedAt: EpochMillis;
}

export interface InfrastructureClassifyOptions {
  readonly scope: ScanScope;
  readonly now: EpochMillis;
  readonly freshnessHorizonMs: number;
  readonly gapReviewWindowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ===========================================================================
// 5. Pure helpers — deterministic, metadata-only
// ===========================================================================

export function safeInfraId(id: string): string {
  if (!looksLikeSecretValue(id)) return id;
  const parts = id.split(/([/:])/);
  const safe = parts.map((seg) =>
    seg === '/' || seg === ':' ? seg : looksLikeSecretValue(seg) ? REDACTED_PLACEHOLDER : seg,
  );
  const rejoined = safe.join('');
  return looksLikeSecretValue(rejoined) ? REDACTED_PLACEHOLDER : rejoined;
}

function freshnessOf(lastObservedAt: EpochMillis, now: EpochMillis, horizon: number): InfraFreshness {
  if (!Number.isFinite(lastObservedAt)) return 'unknown';
  return now - lastObservedAt <= horizon ? 'fresh' : 'stale';
}

function metadataFor(
  scope: ScanScope,
  input: { location: string; classification: string; onboarding: OnboardingState | 'gap'; evidence: unknown },
): MetadataOnlyRecord {
  const record = toMetadataOnlyRecord({
    scope,
    location: input.location,
    classification: input.classification,
    onboarding: input.onboarding,
    registered: false,
    reachable: true,
    evidence: input.evidence,
  });
  if (!isMetadataOnly(record)) {
    throw new Error(`infrastructure classifier produced a non-metadata record for ${input.location}`);
  }
  return record;
}

// ===========================================================================
// 6. The classifier — advisory two-axis placement, no onboarding / no mutation
// ===========================================================================

/**
 * Classify ONE discovered infrastructure system onto both axes (advisory). Returns either a placed
 * `InfrastructureCandidate` (read-vs-mutation + desired-vs-observed + domain axes, `registered:false`,
 * `ownerApprovalRequired:true`) or an `InfrastructureGap` for an unknown or stale candidate. The
 * returned record is frozen so an advisory placement cannot be mutated into an onboarding fact.
 */
export function classifyInfrastructure(
  discovered: DiscoveredInfrastructure,
  opts: InfrastructureClassifyOptions,
): { candidate: InfrastructureCandidate } | { gap: InfrastructureGap } {
  const now = opts.now;
  const reviewWindow = opts.gapReviewWindowMs ?? 7 * DAY_MS;
  const classification = normalizeInfrastructure(discovered.classification);
  const identity = safeInfraId(discovered.identity);
  const location = safeInfraId(discovered.location);
  const owner = discovered.owner ?? null;
  const freshness = freshnessOf(discovered.lastObservedAt, now, opts.freshnessHorizonMs);

  const placement = infrastructurePlacementFor(classification);

  let gapReason: 'unsupported' | 'stale' | null = null;
  if (placement === null) gapReason = 'unsupported';
  else if (freshness === 'stale' || freshness === 'unknown') gapReason = 'stale';

  if (gapReason) {
    const firstObserved = Number.isFinite(discovered.lastObservedAt) ? discovered.lastObservedAt : now;
    const ageMs = Math.max(0, now - firstObserved);
    const gap: InfrastructureGap = Object.freeze({
      candidateId: identity,
      scope: opts.scope,
      location,
      reason: gapReason,
      detail: safeInfraId(`class=${classification};freshness=${freshness}`),
      ownerAction:
        gapReason === 'unsupported'
          ? 'assign-infrastructure-type-or-declare-unsupported'
          : 'refresh-discovery-or-mark-inactive',
      ageMs,
      observedAt: now,
      reviewBy: now + reviewWindow,
      metadata: metadataFor(opts.scope, {
        location: discovered.location,
        classification: `${classification}:${gapReason}`,
        onboarding: 'gap',
        evidence: { freshness, owned: owner !== null },
      }),
    });
    return { gap };
  }

  const p = placement as InfrastructurePlacement;
  const candidate: InfrastructureCandidate = Object.freeze({
    type: classification,
    classification,
    candidateId: identity,
    sourceIdentity: identity,
    scope: opts.scope,
    location,
    interactionMode: p.interactionMode,
    risk: p.risk,
    mutationRequiresApproval: p.mutationRequiresApproval,
    stateFacet: p.stateFacet,
    proposedRole: p.role,
    proposedAvailability: p.availability,
    ownerApprovalRequired: true,
    registered: false,
    onboarding: 'discovered',
    axisAssertable: freshness === 'fresh',
    owner,
    freshness,
    observedAt: now,
    rationale: p.rationale,
    metadata: metadataFor(opts.scope, {
      location: discovered.location,
      classification,
      onboarding: 'discovered',
      evidence: {
        interactionMode: p.interactionMode,
        risk: p.risk,
        stateFacet: p.stateFacet,
        mutationRequiresApproval: p.mutationRequiresApproval,
        proposedRole: p.role,
        proposedAvailability: p.availability,
        ownerApprovalRequired: true,
      },
    }),
  });
  return { candidate };
}

/**
 * Classify a whole pass of discovered infrastructure systems (advisory). One placed candidate per
 * placeable/fresh system and one gap per unknown / stale system. Deterministic given the inputs +
 * `now`. Nothing is onboarded and no mutation is performed. The report is frozen.
 */
export function classifyInfrastructures(
  discoveries: readonly DiscoveredInfrastructure[],
  opts: InfrastructureClassifyOptions,
): InfrastructureReport {
  if (!Number.isFinite(opts.now)) throw new RangeError('now must be a finite epoch-ms value');
  if (!(opts.freshnessHorizonMs > 0)) {
    throw new RangeError('freshnessHorizonMs must be a positive number');
  }

  const candidates: InfrastructureCandidate[] = [];
  const gaps: InfrastructureGap[] = [];
  const seen = new Set<string>();
  let mutationCandidates = 0;

  for (const d of discoveries) {
    const key = safeInfraId(d.identity);
    if (seen.has(key)) continue;
    seen.add(key);
    const outcome = classifyInfrastructure(d, opts);
    if ('candidate' in outcome) {
      candidates.push(outcome.candidate);
      if (outcome.candidate.interactionMode === 'mutation') mutationCandidates += 1;
    } else {
      gaps.push(outcome.gap);
    }
  }

  return Object.freeze({
    scope: opts.scope,
    candidates,
    gaps,
    counts: {
      considered: discoveries.length,
      candidates: candidates.length,
      gaps: gaps.length,
      mutationCandidates,
    },
    observedAt: opts.now,
  });
}

// ===========================================================================
// 7. Re-exported domain axis vocabularies (convenience for consumers/tests)
// ===========================================================================

export {
  ARCHITECTURE_ROLES,
  AVAILABILITY_CLASSES,
  isArchitectureRole,
  isAvailabilityClass,
  type ArchitectureRole,
  type AvailabilityClass,
};
