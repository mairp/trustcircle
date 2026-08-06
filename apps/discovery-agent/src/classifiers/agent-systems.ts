// @trustcircle/discovery-agent — AGENT-SYSTEMS candidate classifier (two-axis, advisory only / T267).
//
// Phase 8 / User Story 6 — Maintain Source and Workflow Health / NFR-010.
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// The named EXTERNAL AGENT SYSTEMS the spec calls out — OpenClaw, AgentEs, AgentES-OilGas, and the
// MPLS report agent — are metadata-only DISCOVERED sources. This module places each on the SAME two
// governance axes the domain defines in `@trustcircle/domain` (component-profile.ts / NFR-010):
//
//   1. the OWNER-APPROVED ARCHITECTURE ROLE  — stable design intent (ARCHITECTURE_ROLES)
//   2. the RUNTIME AVAILABILITY CLASS        — how essential to the running platform (AVAILABILITY_CLASSES)
//
// and, in addition to the two-axis placement, it emits an ONBOARDING TEMPLATE per system: the
// proposed contract, the proposed capabilities, and the OWNER ACTION still required. Keying off the
// NAME only (never any content of the discovered source) keeps the classifier metadata-only.
//
// ---------------------------------------------------------------------------
// THE "CANDIDATE, NOT ONBOARDED" CONTRACT (identical to core-architecture.ts)
// ---------------------------------------------------------------------------
// The classifier is ADVISORY. It proposes an axis placement + an onboarding template; it NEVER
// onboards and NEVER grants authority. Concretely:
//
//   1. It does NOT construct a validated `ArchitectureRoleProfile`. It emits a PROPOSED role and an
//      explicit `ownerApprovalRequired: true`, never an approved profile.
//   2. Every emitted record keeps `registered: false` and an `onboarding` state of `discovered`.
//      The availability CLASS it proposes is a candidate placement, not a live-observed fact.
//   3. It is metadata-only. Every durable record flows through `toMetadataOnlyRecord` and is asserted
//      `isMetadataOnly`; a name that is secret-shaped is redacted via `safeAgentId`.
//   4. An agent system is a CONNECTOR — it is NEVER authoritative for governance. Every onboarding
//      template carries `authorityGrantable: false`.
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
// 1. Candidate vocabulary — the named agent systems this classifier places
// ===========================================================================

/**
 * The closed set of named agent-system classifications this classifier places on the two axes.
 * `mpls-report-agent` is the MPLS report agent; the rest are the external agent systems the spec
 * names. `unknown` is the catch-all for any agent-shaped candidate that matches none of these.
 */
export const AGENT_SYSTEM_CLASSIFICATIONS = [
  'openclaw',
  'agentes',
  'agentes-oilgas',
  'mpls-report-agent',
  'unknown',
] as const;
export type AgentSystemClassification = (typeof AGENT_SYSTEM_CLASSIFICATIONS)[number];

/** The classification used when a discovered agent matches none of the known systems. */
export const UNKNOWN_AGENT = 'unknown' as const;

export function isAgentSystemClassification(s: unknown): s is AgentSystemClassification {
  return (
    typeof s === 'string' && (AGENT_SYSTEM_CLASSIFICATIONS as readonly string[]).includes(s)
  );
}

/**
 * Normalize a raw discovered classification / marker string onto the closed agent-system set. Aliases
 * common spellings; anything unrecognized becomes `unknown` (never a silent drop). Reads the NAME only.
 */
export function normalizeAgentSystem(raw: string): AgentSystemClassification {
  const key = raw.trim().toLowerCase();
  if (isAgentSystemClassification(key)) return key;
  switch (key) {
    case 'open-claw':
    case 'openclaw-agent':
    case 'openclaw-mcp':
      return 'openclaw';
    case 'agent-es':
    case 'agentes-agent':
    case 'agent-es-core':
      return 'agentes';
    case 'agentes-oil-gas':
    case 'agentes_oilgas':
    case 'agent-es-oilgas':
      return 'agentes-oilgas';
    case 'mpls':
    case 'mpls-report':
    case 'mpls_report_agent':
    case 'mpls-reporter':
      return 'mpls-report-agent';
    default:
      return UNKNOWN_AGENT;
  }
}

// ===========================================================================
// 2. The two axes + the onboarding template — proposed only, never approved
// ===========================================================================

/**
 * An ONBOARDING TEMPLATE: the proposed contract, capabilities, and the owner action still required
 * before a discovered agent system may be governed. `authorityGrantable` is ALWAYS false — an agent
 * system is a connector and is never granted governance authority.
 */
export interface OnboardingTemplate {
  /** The proposed adapter/protocol contract the system would speak once onboarded. */
  readonly proposedContract: string;
  /** The proposed capabilities (read/observe/drive — never authoritative). */
  readonly proposedCapabilities: readonly string[];
  /** ALWAYS false: an agent-system connector is never authoritative for governance. */
  readonly authorityGrantable: false;
  /** The concrete OWNER ACTION still required (approve role + availability, assign owner). */
  readonly ownerAction: string;
}

/**
 * The hand-authored TWO-AXIS placement + onboarding template for each named agent system. The role
 * and availability are PROPOSED (design intent awaiting owner approval); the template's capabilities
 * are proposals, not granted permissions.
 */
export interface AgentPlacement {
  readonly role: ArchitectureRole;
  readonly availability: AvailabilityClass;
  readonly rationale: string;
  readonly template: OnboardingTemplate;
}

const PLACEMENTS: Readonly<Record<Exclude<AgentSystemClassification, 'unknown'>, AgentPlacement>> = {
  openclaw: {
    role: 'connector',
    availability: 'on-demand',
    rationale:
      'on-demand connector: OpenClaw is an external agent source observed via metadata when activated',
    template: {
      proposedContract: 'mcp-agent-observation/v1',
      proposedCapabilities: ['observe-agent-state', 'read-agent-tasks'],
      authorityGrantable: false,
      ownerAction: 'approve architecture-role=connector + availability=on-demand; assign accountable owner',
    },
  },
  agentes: {
    role: 'connector',
    availability: 'on-demand',
    rationale:
      'on-demand connector: AgentEs is an external agent source observed via metadata when activated',
    template: {
      proposedContract: 'mcp-agent-observation/v1',
      proposedCapabilities: ['observe-agent-state', 'read-agent-tasks'],
      authorityGrantable: false,
      ownerAction: 'approve architecture-role=connector + availability=on-demand; assign accountable owner',
    },
  },
  'agentes-oilgas': {
    role: 'connector',
    availability: 'on-demand',
    rationale:
      'on-demand connector: AgentES-OilGas is a domain-specific external agent source observed on demand',
    template: {
      proposedContract: 'mcp-agent-observation/v1',
      proposedCapabilities: ['observe-agent-state', 'read-agent-tasks', 'read-domain-context'],
      authorityGrantable: false,
      ownerAction:
        'approve architecture-role=connector + availability=on-demand; assign domain owner; confirm data-residency scope',
    },
  },
  'mpls-report-agent': {
    role: 'connector',
    availability: 'on-demand',
    rationale:
      'on-demand connector: the MPLS report agent emits read-only reports observed via metadata when activated',
    template: {
      proposedContract: 'report-observation/v1',
      proposedCapabilities: ['observe-report-runs', 'read-report-metadata'],
      authorityGrantable: false,
      ownerAction:
        'approve architecture-role=connector + availability=on-demand; assign report owner',
    },
  },
} as const;

// Defensive: every placement must reference a VALID domain role / availability class. Runs once at
// module load, turning a typo into an immediate hard failure rather than silent bad advice.
for (const [candidate, p] of Object.entries(PLACEMENTS)) {
  if (!isArchitectureRole(p.role)) {
    throw new Error(`agent-systems: candidate "${candidate}" has an invalid architecture role`);
  }
  if (!isAvailabilityClass(p.availability)) {
    throw new Error(`agent-systems: candidate "${candidate}" has an invalid availability class`);
  }
}

/** Look up the proposed placement + onboarding template for an agent system, or `null` for unknown. */
export function agentPlacementFor(candidate: AgentSystemClassification): AgentPlacement | null {
  if (candidate === UNKNOWN_AGENT) return null;
  return PLACEMENTS[candidate];
}

// ===========================================================================
// 3. Records — the durable, independently-readable, advisory witnesses
// ===========================================================================

/** Freshness of the backing observation. */
export const AGENT_FRESHNESS = ['fresh', 'stale', 'unknown'] as const;
export type AgentFreshness = (typeof AGENT_FRESHNESS)[number];

/**
 * A classified agent-system candidate — the two-axis placement, the onboarding template, and the
 * explicit `ownerApprovalRequired`/`registered:false` witnesses that prove this is advice, not
 * onboarding. Health is NEVER asserted from stale data (`axisAssertable:false` when stale).
 */
export interface AgentSystemCandidate {
  readonly type: AgentSystemClassification;
  readonly classification: AgentSystemClassification;
  readonly candidateId: string;
  readonly sourceIdentity: string;
  readonly scope: ScanScope;
  readonly location: string;
  // AXIS 1 — proposed architecture role
  readonly proposedRole: ArchitectureRole;
  // AXIS 2 — proposed availability class
  readonly proposedAvailability: AvailabilityClass;
  // the onboarding template (proposed contract/capabilities/owner-action)
  readonly onboardingTemplate: OnboardingTemplate;
  // candidate-not-onboarded witnesses
  readonly ownerApprovalRequired: true;
  readonly registered: false;
  readonly onboarding: OnboardingState;
  readonly axisAssertable: boolean;
  readonly owner: string | null;
  readonly freshness: AgentFreshness;
  readonly observedAt: EpochMillis;
  readonly rationale: string;
  readonly metadata: MetadataOnlyRecord;
}

/** An unplaceable / unknown / stale agent candidate kept as a VISIBLE governed-source gap. */
export interface AgentSystemGap {
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

/** The full result of one agent-systems classification pass. */
export interface AgentSystemsReport {
  readonly scope: ScanScope;
  readonly candidates: readonly AgentSystemCandidate[];
  readonly gaps: readonly AgentSystemGap[];
  readonly counts: {
    readonly considered: number;
    readonly candidates: number;
    readonly gaps: number;
  };
  readonly observedAt: EpochMillis;
}

// ===========================================================================
// 4. Inputs / options
// ===========================================================================

/** One discovered agent-shaped candidate to classify — a metadata-only scanner projection. */
export interface DiscoveredAgentSystem {
  readonly classification: string;
  readonly identity: string;
  readonly location: string;
  readonly owner?: string | null;
  readonly lastObservedAt: EpochMillis;
}

export interface AgentSystemsClassifyOptions {
  readonly scope: ScanScope;
  readonly now: EpochMillis;
  readonly freshnessHorizonMs: number;
  readonly gapReviewWindowMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ===========================================================================
// 5. Pure helpers — deterministic, metadata-only
// ===========================================================================

/** Disclosure-safe identity — a secret-shaped id segment is redacted while benign segments survive. */
export function safeAgentId(id: string): string {
  if (!looksLikeSecretValue(id)) return id;
  const parts = id.split(/([/:])/);
  const safe = parts.map((seg) =>
    seg === '/' || seg === ':' ? seg : looksLikeSecretValue(seg) ? REDACTED_PLACEHOLDER : seg,
  );
  const rejoined = safe.join('');
  return looksLikeSecretValue(rejoined) ? REDACTED_PLACEHOLDER : rejoined;
}

function freshnessOf(lastObservedAt: EpochMillis, now: EpochMillis, horizon: number): AgentFreshness {
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
    // The classifier NEVER onboards: registered is hard-false, reachable is a discovery fact.
    registered: false,
    reachable: true,
    evidence: input.evidence,
  });
  if (!isMetadataOnly(record)) {
    throw new Error(`agent-systems classifier produced a non-metadata record for ${input.location}`);
  }
  return record;
}

// ===========================================================================
// 6. The classifier — advisory two-axis placement + onboarding template, no onboarding
// ===========================================================================

/**
 * Classify ONE discovered agent system onto both axes (advisory). Returns either a placed
 * `AgentSystemCandidate` (proposed role + availability + onboarding template, `registered:false`,
 * `ownerApprovalRequired:true`) or an `AgentSystemGap` for an unknown or stale candidate. The
 * returned record is frozen so an advisory placement cannot be mutated into an onboarding fact.
 */
export function classifyAgentSystem(
  discovered: DiscoveredAgentSystem,
  opts: AgentSystemsClassifyOptions,
): { candidate: AgentSystemCandidate } | { gap: AgentSystemGap } {
  const now = opts.now;
  const reviewWindow = opts.gapReviewWindowMs ?? 7 * DAY_MS;
  const classification = normalizeAgentSystem(discovered.classification);
  const identity = safeAgentId(discovered.identity);
  const location = safeAgentId(discovered.location);
  const owner = discovered.owner ?? null;
  const freshness = freshnessOf(discovered.lastObservedAt, now, opts.freshnessHorizonMs);

  const placement = agentPlacementFor(classification);

  // An UNKNOWN agent is unsupported; a known-but-stale one is a visible gap — so a governance concern
  // never masquerades as a clean placement.
  let gapReason: 'unsupported' | 'stale' | null = null;
  if (placement === null) gapReason = 'unsupported';
  else if (freshness === 'stale' || freshness === 'unknown') gapReason = 'stale';

  if (gapReason) {
    const firstObserved = Number.isFinite(discovered.lastObservedAt) ? discovered.lastObservedAt : now;
    const ageMs = Math.max(0, now - firstObserved);
    const gap: AgentSystemGap = Object.freeze({
      candidateId: identity,
      scope: opts.scope,
      location,
      reason: gapReason,
      detail: safeAgentId(`class=${classification};freshness=${freshness}`),
      ownerAction:
        gapReason === 'unsupported'
          ? 'assign-agent-system-type-or-declare-unsupported'
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

  const p = placement as AgentPlacement;
  const candidate: AgentSystemCandidate = Object.freeze({
    type: classification,
    classification,
    candidateId: identity,
    sourceIdentity: identity,
    scope: opts.scope,
    location,
    proposedRole: p.role,
    proposedAvailability: p.availability,
    onboardingTemplate: p.template,
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
        proposedRole: p.role,
        proposedAvailability: p.availability,
        proposedContract: p.template.proposedContract,
        authorityGrantable: false,
        ownerApprovalRequired: true,
      },
    }),
  });
  return { candidate };
}

/**
 * Classify a whole pass of discovered agent systems (advisory). Produces one placed candidate per
 * placeable/fresh agent and one gap per unknown / stale agent. Deterministic given the inputs + `now`.
 * Nothing is onboarded: every candidate keeps `registered:false`. The report is frozen.
 */
export function classifyAgentSystems(
  discoveries: readonly DiscoveredAgentSystem[],
  opts: AgentSystemsClassifyOptions,
): AgentSystemsReport {
  if (!Number.isFinite(opts.now)) throw new RangeError('now must be a finite epoch-ms value');
  if (!(opts.freshnessHorizonMs > 0)) {
    throw new RangeError('freshnessHorizonMs must be a positive number');
  }

  const candidates: AgentSystemCandidate[] = [];
  const gaps: AgentSystemGap[] = [];
  const seen = new Set<string>();

  for (const d of discoveries) {
    const key = safeAgentId(d.identity);
    if (seen.has(key)) continue; // one reconciled row per identity
    seen.add(key);
    const outcome = classifyAgentSystem(d, opts);
    if ('candidate' in outcome) candidates.push(outcome.candidate);
    else gaps.push(outcome.gap);
  }

  return Object.freeze({
    scope: opts.scope,
    candidates,
    gaps,
    counts: {
      considered: discoveries.length,
      candidates: candidates.length,
      gaps: gaps.length,
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
