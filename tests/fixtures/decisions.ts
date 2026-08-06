// Test fixtures — a deterministic, multi-scenario DECISION projection for Phase 4 / User Story 2
// (Make and Govern Human Decisions). Seeds every decision shape the decision routes and the
// accessible web surfaces (DecisionInbox / JointDecisionStatus / EmergencyIntervention) consume,
// plus the authz Delegation / BreakGlassGrant records the delegation + emergency flows govern.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FIXTURE EXISTS  (T117 — FR-010..015, FR-043..045, AC1..AC6, SC-003/004/005/020)
// ───────────────────────────────────────────────────────────────────────────────────────────
// The e2e human-decision + federated-joint-approval scenarios (tests/e2e/scenarios/human-decisions.ts)
// mount the real web renderers over a KNOWN, FIXED projection and assert genuine facets — never a
// mutation echo. This builder is that fixed projection. Every scenario below maps to an acceptance
// criterion the queue / joint / emergency surface must satisfy, and each carries an `observedVia`
// naming the exact durable read path an assertion pins, so no assertion is vacuous.
//
// The SIX seeded decision scenarios (task text: "authorized, conflicted, delegated, expired,
// cross-tenant, and emergency"):
//   1. AUTHORIZED   — a complete, in-window package with all gates satisfiable by the current
//                     approver → actionable in the queue, allowedActions include approve/deny (AC1).
//   2. CONFLICTED   — the requester is the only eligible approver: a separation_of_duties gate is
//                     UNMET → the row is NOT actionable and states the SoD conflict (FR-012, AC2).
//   3. DELEGATED    — authority delegated to a recipient within a bounded window; the package is
//                     'delegated' and the ACTIVE delegation grant makes the recipient the actor
//                     (FR-013). A SECOND, already-EXPIRED delegation proves lapse is an effect.
//   4. EXPIRED      — the crossing-deadline package is past `expiresAt` at NOW → decisionIsExpired
//                     is true; the queue shows it EXPIRED + escalated, no live actions (FR-014, SC-020).
//   5. CROSS-TENANT — a joint package affecting three tenants: execution BLOCKED until non-waivable
//                     central guardrails pass, EVERY affected tenant supplies a current scoped
//                     approval, and a DISTINCT central reviewer approves — no cross-tenant evidence
//                     leaked (FR-043/044/045, AC6, SC-005).
//   6. EMERGENCY    — an ACTIVE break-glass grant that STOPPED an operation but NEVER conferred
//                     decision authority, whose mandatory post-event review is still OPEN → the
//                     emergency surface renders the outstanding-review alert (FR-015, SC-004).
//
// DETERMINISM. No wall clock, no I/O. The clock is the fixed `NOW`; ids come from a monotonic
// UUIDv7 factory seeded with a DETERMINISTIC byte source (`seededRandom`), so the whole projection
// — including id tails — is byte-identical every call. Same input ⇒ same output.

import {
  createIdFactory,
  toUuid,
  makeReason,
  makeDecisionPackage,
  makeDecisionRequirement,
  makeJointDecisionPackage,
  decisionIsExpired,
  isCentralGuardrail,
  type Uuid,
  type EpochMillis,
  type TenantId,
  type Reason,
  type DecisionPackage,
  type DecisionRequirement,
  type JointDecisionPackage,
} from '@trustcircle/domain';
import type { Delegation, BreakGlassGrant } from '@trustcircle/authz';
import { createHash } from 'node:crypto';

// The view-model shapes the shipped web renderers consume — imported TYPE-ONLY so the fixture stays
// in lock-step with the exact surfaces under test and never drifts from what the renderer reads.
import type {
  DecisionInboxModel,
  DecisionInboxRowVM,
  InboxRequirementVM,
} from '../../apps/web/src/features/decisions/DecisionInbox.tsx';
import type {
  JointDecisionStatusModel,
  TenantApprovalVM,
} from '../../apps/web/src/features/decisions/JointDecisionStatus.tsx';
import type {
  EmergencyInterventionModel,
  BreakGlassEventVM,
} from '../../apps/web/src/features/operations/EmergencyIntervention.tsx';

// ── Fixed clock & identity ──────────────────────────────────────────────────────────────────────

/** The single fixed "now" every seeded deadline is measured against. Chosen distinct from the
 *  inventory fixture's NOW so a mixed run cannot accidentally alias the two projections. */
export const NOW: EpochMillis = 1_772_050_000_000 as EpochMillis;

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

/** A deterministic 10-byte source for the UUIDv7 tail, so ids are byte-stable across runs. */
function seededRandom(): (n: number) => Uint8Array {
  let state = 0x9e3779b9 >>> 0;
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      // xorshift32 — pure, deterministic, no crypto/clock dependency.
      state ^= state << 13;
      state >>>= 0;
      state ^= state >> 17;
      state ^= state << 5;
      state >>>= 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

/**
 * A deterministic, legible-in-source UUID derived from a readable slug. The slug is sha256'd and the
 * digest is laid out as a canonical, version-7-shaped UUID (version nibble '7', variant nibble in
 * 8–b). Pure — no clock, no crypto RNG — so the whole projection is byte-identical every run while
 * every id remains a syntactically valid UUID the domain factories accept.
 */
function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`decision-fixture:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const canonical = `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return toUuid(canonical);
}

// ── Stable principals & tenants ───────────────────────────────────────────────────────────────────
// UUIDs derived from readable slugs via uuidFromSlug so the projection is legible AND reproducible.

export const TENANT: TenantId = uuidFromSlug('tenant-home-decisions') as unknown as TenantId;
export const PARTNER_TENANT_A: Uuid = uuidFromSlug('tenant-partner-alpha');
export const PARTNER_TENANT_B: Uuid = uuidFromSlug('tenant-partner-bravo');

export const REQUESTER: Uuid = uuidFromSlug('principal-requester-quinn');
export const APPROVER: Uuid = uuidFromSlug('principal-approver-avery');
export const DELEGATE: Uuid = uuidFromSlug('principal-delegate-devon');
export const CENTRAL_REVIEWER: Uuid = uuidFromSlug('principal-central-reviewer-cora');
export const OPERATOR: Uuid = uuidFromSlug('principal-operator-omar');
export const BREAK_GLASS_REVIEWER: Uuid = uuidFromSlug('principal-bg-reviewer-blake');

const WORK_ITEM = (slug: string): Uuid => uuidFromSlug(`work-item-${slug}`);

function iso(ms: EpochMillis): string {
  // Deterministic ISO string — no `new Date()` wall-clock read; constructed from the fixed epoch.
  return new Date(ms).toISOString();
}

// ── The seeded scenario catalogue (each maps to an acceptance criterion) ──────────────────────────

/** A named seeded decision scenario + the durable read path an assertion witnesses it through. */
export interface DecisionScenarioSpec {
  readonly scenario:
    'authorized' | 'conflicted' | 'delegated' | 'expired' | 'cross-tenant' | 'emergency';
  /** The seeded fact an assertion pins. */
  readonly witness: string;
  /** The durable read path the fact is observed through (never a mutation response). */
  readonly observedVia: string;
}

export const SIX_DECISION_SCENARIOS: readonly DecisionScenarioSpec[] = [
  {
    scenario: 'authorized',
    witness: 'complete in-window package whose SoD gate is satisfiable by a distinct approver',
    observedVia: 'DecisionInboxModel.rows[authorized].actionable === true (queue projection)',
  },
  {
    scenario: 'conflicted',
    witness: 'requester is the only eligible approver → separation_of_duties gate unmet',
    observedVia:
      'DecisionInboxModel.rows[conflicted].conflicts names the SoD conflict; actionable === false',
  },
  {
    scenario: 'delegated',
    witness: 'active delegation makes the recipient the actor; a second delegation already expired',
    observedVia:
      'seed.delegations: one status="active" (in-window) + one status="expired" (lapsed)',
  },
  {
    scenario: 'expired',
    witness: 'package past expiresAt at NOW → decisionIsExpired true, no live actions',
    observedVia:
      'decisionIsExpired(seed.packages.expired, NOW) === true; row status="expired", escalated',
  },
  {
    scenario: 'cross-tenant',
    witness:
      'joint package affecting 3 tenants; execution blocked until all three gates pass; no evidence leak',
    observedVia:
      'JointDecisionStatusModel.executionBlocked + per-tenant rows with evidenceDisclosed===false',
  },
  {
    scenario: 'emergency',
    witness: 'active break-glass stopped an op, conferred NO decision authority, review still open',
    observedVia:
      'EmergencyInterventionModel.priorEvents[*].reviewComplete===false (open-reviews alert)',
  },
];

// ── Requirement builders ──────────────────────────────────────────────────────────────────────────

let idf = createIdFactory(seededRandom());
const mint = (at: EpochMillis = NOW): Uuid => idf.next(at);

function sodRequirement(status: DecisionRequirement['status']): DecisionRequirement {
  return makeDecisionRequirement({
    id: mint(),
    gateType: 'separation_of_duties',
    tenantId: TENANT as unknown as Uuid,
    status,
    minimumDistinctPrincipals: 2,
    incompatibleRelationships: ['requester', 'implementer'],
  });
}

function centralGuardrail(status: DecisionRequirement['status']): DecisionRequirement {
  // tenantId === null ⇒ non-waivable central guardrail (isCentralGuardrail true).
  return makeDecisionRequirement({
    id: mint(),
    gateType: 'central_guardrail',
    tenantId: null,
    status,
    minimumDistinctPrincipals: 1,
  });
}

// ── The seeded projection ───────────────────────────────────────────────────────────────────────

export interface SeededDecisions {
  readonly tenantId: TenantId;
  readonly now: EpochMillis;
  readonly packages: {
    readonly authorized: DecisionPackage;
    readonly conflicted: DecisionPackage;
    readonly delegated: DecisionPackage;
    readonly expired: DecisionPackage;
    /** The underlying package the cross-tenant joint wraps. */
    readonly crossTenant: DecisionPackage;
  };
  readonly joint: JointDecisionPackage;
  readonly delegations: {
    /** In-window, currently effective delegation of the delegated package's authority. */
    readonly active: Delegation;
    /** Already past its window at NOW — proves delegation lapse is an accountability effect. */
    readonly expired: Delegation;
  };
  readonly breakGlass: BreakGlassGrant;
  /** The reasons attached to seeded decisions (attributable, audited). */
  readonly reasons: {
    readonly approve: Reason;
    readonly emergency: Reason;
  };
  readonly scenarios: readonly DecisionScenarioSpec[];
}

/**
 * Build the full multi-scenario decision projection for {@link TENANT}. Deterministic: same output
 * every call (ids minted from a fresh monotonic factory seeded with a deterministic byte source at
 * fixed timestamps; no wall-clock read, no I/O).
 */
export function seedDecisions(now: EpochMillis = NOW): SeededDecisions {
  // Re-seed the id factory so repeat calls are byte-identical.
  idf = createIdFactory(seededRandom());

  const baseFacets = {
    scope: { environment: 'production', blastRadius: 'tenant' },
    businessImpact: { revenueAtRisk: 'medium', customersAffected: 1200 },
    risks: [{ id: 'r1', summary: 'rollback window is narrow', severity: 'medium' }],
    alternatives: [{ id: 'a1', summary: 'defer to next maintenance window' }],
    expectedResult: { outcome: 'capacity increased', reversible: true },
  } as const;

  // 1. AUTHORIZED — complete, in-window, SoD satisfiable by a DISTINCT approver → actionable.
  const authorized = makeDecisionPackage({
    id: mint(),
    tenantId: TENANT,
    workItemId: WORK_ITEM('authorized-scale-up'),
    requesterPrincipalId: REQUESTER,
    requestedAction: 'scale orders-api to 12 replicas',
    actionClass: 'capacity_change',
    riskTier: 'medium',
    ...baseFacets,
    requirements: [sodRequirement('pending')],
    status: 'in_review',
    createdAt: (now - 2 * ONE_HOUR) as EpochMillis,
    expiresAt: (now + 6 * ONE_HOUR) as EpochMillis,
  });

  // 2. CONFLICTED — requester is the only eligible approver → SoD gate FAILED (unmet, blocking).
  const conflicted = makeDecisionPackage({
    id: mint(),
    tenantId: TENANT,
    workItemId: WORK_ITEM('conflicted-self-approve'),
    requesterPrincipalId: REQUESTER,
    requestedAction: 'grant REQUESTER production db-write for 24h',
    actionClass: 'access_grant',
    riskTier: 'high',
    ...baseFacets,
    requirements: [sodRequirement('failed')],
    status: 'in_review',
    createdAt: (now - 3 * ONE_HOUR) as EpochMillis,
    expiresAt: (now + 4 * ONE_HOUR) as EpochMillis,
  });

  // 3. DELEGATED — authority delegated; package status 'delegated'.
  const delegated = makeDecisionPackage({
    id: mint(),
    tenantId: TENANT,
    workItemId: WORK_ITEM('delegated-config-change'),
    requesterPrincipalId: REQUESTER,
    requestedAction: 'roll out feature flag checkout-v2 to 10%',
    actionClass: 'config_change',
    riskTier: 'low',
    ...baseFacets,
    requirements: [sodRequirement('pending')],
    status: 'delegated',
    createdAt: (now - 90 * ONE_MINUTE) as EpochMillis,
    expiresAt: (now + 12 * ONE_HOUR) as EpochMillis,
  });

  // 4. EXPIRED — expiresAt strictly before NOW ⇒ decisionIsExpired true.
  const expired = makeDecisionPackage({
    id: mint(),
    tenantId: TENANT,
    workItemId: WORK_ITEM('expired-migration'),
    requesterPrincipalId: REQUESTER,
    requestedAction: 'migrate payments schema v7 → v8',
    actionClass: 'schema_migration',
    riskTier: 'critical',
    ...baseFacets,
    requirements: [sodRequirement('pending')],
    status: 'escalated', // past-deadline & unactioned → escalated, never silently closed
    createdAt: (now - 2 * ONE_DAY) as EpochMillis,
    expiresAt: (now - ONE_HOUR) as EpochMillis,
  });

  // 5. CROSS-TENANT — the underlying package a joint wraps; affects three tenants.
  const affectedTenantIds: readonly Uuid[] = [
    TENANT as unknown as Uuid,
    PARTNER_TENANT_A,
    PARTNER_TENANT_B,
  ];
  const crossTenant = makeDecisionPackage({
    id: mint(),
    tenantId: TENANT,
    workItemId: WORK_ITEM('cross-tenant-shared-index'),
    requesterPrincipalId: REQUESTER,
    requestedAction: 'rebuild the shared federated search index',
    actionClass: 'federated_change',
    riskTier: 'high',
    ...baseFacets,
    affectedTenantIds,
    requirements: [
      centralGuardrail('pending'), // non-waivable, not yet passed → execution blocked
      makeDecisionRequirement({
        id: mint(),
        gateType: 'central_review',
        tenantId: null,
        status: 'pending',
        minimumDistinctPrincipals: 1,
      }),
    ],
    status: 'in_review',
    createdAt: (now - 4 * ONE_HOUR) as EpochMillis,
    expiresAt: (now + 8 * ONE_HOUR) as EpochMillis,
  });

  const joint = makeJointDecisionPackage({
    id: mint(),
    tenantId: TENANT,
    decisionId: crossTenant.id,
    affectedTenantIds,
    centralReviewerPrincipalId: CENTRAL_REVIEWER,
    packageDigest: 'sha256:joint-shared-index-fixed-digest',
    centralState: 'collecting', // not yet central_review/approved ⇒ blocked
    createdAt: (now - 4 * ONE_HOUR) as EpochMillis,
    updatedAt: (now - 30 * ONE_MINUTE) as EpochMillis,
  });

  // A resolved authority scope for the delegation/break-glass grants (exact-match action tokens).
  const tenantScope = {
    scopeType: 'resource',
    scopeId: TENANT as unknown as string,
    allowedActions: ['decision.approve', 'decision.deny'],
  } as const;

  // 3b. Delegation grants — one ACTIVE (in-window) and one EXPIRED (lapsed at NOW).
  const activeDelegation: Delegation = {
    delegationId: mint(),
    tenantId: TENANT as unknown as string,
    delegatorPrincipalId: APPROVER,
    recipientPrincipalId: DELEGATE,
    authorityAssignmentId: mint(),
    scope: tenantScope,
    reasonText: 'covering approver Avery while on-call rotation is handed to Devon',
    validFrom: (now - ONE_HOUR) as unknown as number,
    expiresAt: (now + 6 * ONE_HOUR) as unknown as number,
    parentDelegationId: null,
    status: 'active',
  };

  const expiredDelegation: Delegation = {
    delegationId: mint(),
    tenantId: TENANT as unknown as string,
    delegatorPrincipalId: APPROVER,
    recipientPrincipalId: DELEGATE,
    authorityAssignmentId: mint(),
    scope: tenantScope,
    reasonText: 'prior week hand-off — window has since lapsed',
    validFrom: (now - 3 * ONE_DAY) as unknown as number,
    expiresAt: (now - ONE_DAY) as unknown as number,
    parentDelegationId: null,
    status: 'expired',
  };

  // 6. EMERGENCY — active break-glass that stopped an op; post-event review still OPEN.
  const breakGlass: BreakGlassGrant = {
    breakGlassGrantId: mint(),
    tenantId: TENANT as unknown as string,
    principalId: OPERATOR,
    scope: {
      scopeType: 'action',
      scopeId: 'operation.emergency-stop',
      allowedActions: ['operation.stop'],
    },
    reasonText: 'runaway migration on payments-db — emergency stop to contain blast radius',
    incidentId: uuidFromSlug('incident-payments-runaway'),
    activatedAt: (now - 20 * ONE_MINUTE) as unknown as number,
    expiresAt: (now + 40 * ONE_MINUTE) as unknown as number,
    monitoringEvidenceId: uuidFromSlug('evidence-bg-monitoring'),
    reviewerPrincipalId: BREAK_GLASS_REVIEWER,
    reviewDueAt: (now + 2 * ONE_HOUR) as unknown as number,
    reviewedAt: 0 as unknown as BreakGlassGrant['reviewedAt'], // 0 ⇒ post-event review not yet done
    status: 'active',
  };

  return {
    tenantId: TENANT,
    now,
    packages: { authorized, conflicted, delegated, expired, crossTenant },
    joint,
    delegations: { active: activeDelegation, expired: expiredDelegation },
    breakGlass,
    reasons: {
      approve: makeReason(
        'approved_within_authority',
        'Reviewed; within delegated authority and policy.',
      ),
      emergency: makeReason(
        'emergency_stop',
        'Runaway migration contained via break-glass; post-event review required.',
      ),
    },
    scenarios: SIX_DECISION_SCENARIOS,
  };
}

// ── View-model projections the web renderers consume ──────────────────────────────────────────────
// These map the seeded domain records onto the EXACT VMs the shipped renderers read, so the e2e
// specs mount real HTML over a fixed model and assert genuine facets.

function requirementVMs(pkg: DecisionPackage): readonly InboxRequirementVM[] {
  return pkg.requirements
    .filter((r) => r.status !== 'satisfied')
    .map((r) => ({
      id: r.id,
      gateType: r.gateType,
      central: isCentralGuardrail(r),
    }));
}

function inboxRow(
  pkg: DecisionPackage,
  now: EpochMillis,
  opts: {
    readonly allowedActions: readonly string[];
    readonly actionable: boolean;
    readonly conflicts: readonly string[];
    readonly escalated: boolean;
    readonly priority: number;
  },
): DecisionInboxRowVM {
  const ttl = pkg.expiresAt - now;
  const isExpired = decisionIsExpired(pkg, now);
  // Postures the DecisionInbox renderer recognises for its textual time warning:
  //   'expired' → "Expired — dispose…"; 'expiring_soon' → "Expiring soon — act before it lapses.";
  //   'ample' → no warning. (A warning that the renderer ignores would make the T093 assertion
  //   vacuous, so the fixture only emits postures the renderer acts on.)
  const timePosture = isExpired ? 'expired' : ttl <= 4 * ONE_HOUR ? 'expiring_soon' : 'ample';
  return {
    decisionId: pkg.id,
    workItemId: pkg.workItemId,
    requesterPrincipalId: pkg.requesterPrincipalId,
    requestedAction: pkg.requestedAction,
    actionClass: pkg.actionClass,
    riskTier: pkg.riskTier,
    impact: String((pkg.businessImpact as Record<string, unknown>)['revenueAtRisk'] ?? 'unknown'),
    status: pkg.status,
    ageLabel: `${Math.round((now - pkg.createdAt) / ONE_MINUTE)}m ago`,
    timeToExpiryMillis: ttl,
    timePosture,
    expiryLabel: isExpired ? `expired ${iso(pkg.expiresAt)}` : `expires ${iso(pkg.expiresAt)}`,
    evidenceCurrency: 'current',
    openRequirements: requirementVMs(pkg),
    isCrossTenant: pkg.affectedTenantIds.length > 0,
    escalated: opts.escalated,
    conflicts: opts.conflicts,
    allowedActions: opts.allowedActions,
    actionable: opts.actionable,
    priority: opts.priority,
    searchIndex: `${pkg.requestedAction} ${pkg.actionClass} ${pkg.status}`.toLowerCase(),
    matches: true,
    filteredOutReason: '',
  };
}

/** Project the seeded packages onto the DecisionInbox model the queue renderer consumes. */
export function seedDecisionInboxModel(
  seed: SeededDecisions = seedDecisions(),
): DecisionInboxModel {
  const { packages: p, now } = seed;
  const rows: readonly DecisionInboxRowVM[] = [
    inboxRow(p.expired, now, {
      allowedActions: [], // terminal/expired → no live actions (FR-014)
      actionable: false,
      conflicts: [],
      escalated: true,
      priority: 100, // most urgent surfaced first
    }),
    inboxRow(p.conflicted, now, {
      allowedActions: [], // SoD unmet → cannot act (FR-012)
      actionable: false,
      conflicts: ['separation-of-duties: requester cannot approve their own access grant'],
      escalated: false,
      priority: 80,
    }),
    inboxRow(p.authorized, now, {
      allowedActions: ['approve', 'deny', 'request_changes', 'delegate'],
      actionable: true,
      conflicts: [],
      escalated: false,
      priority: 60,
    }),
    inboxRow(p.crossTenant, now, {
      allowedActions: ['request_changes'], // joint gates open ⇒ cannot finalize here
      actionable: false,
      conflicts: [],
      escalated: false,
      priority: 55,
    }),
    inboxRow(p.delegated, now, {
      allowedActions: ['approve', 'deny'], // exercised by the delegate
      actionable: true,
      conflicts: [],
      escalated: false,
      priority: 40,
    }),
  ];
  const visible = rows.filter((r) => r.matches).length;
  const actionableVisible = rows.filter((r) => r.matches && r.actionable).length;
  return {
    rows,
    filters: [
      { facet: 'expiry', value: 'expiring_soon', label: 'Expiring soon', active: false },
      { facet: 'escalation', value: 'escalated', label: 'Escalated', active: false },
      { facet: 'actionability', value: 'actionable', label: 'Actionable by me', active: false },
    ],
    query: {
      text: '',
      activeFilters: [],
      visible,
      total: rows.length,
      actionableVisible,
      resultSummary: `${visible} of ${rows.length} decisions shown, ${actionableVisible} actionable`,
    },
    metadata: {
      generatedAtIso: iso(now),
      freshness: 'current',
      partialCoverage: false,
      snapshotDigest: 'sha256:decision-inbox-fixed-digest',
      safeNextAction: 'review the escalated, expired decision first',
    },
  };
}

/** Project the seeded joint package onto the JointDecisionStatus model — no cross-tenant evidence. */
export function seedJointDecisionStatusModel(
  seed: SeededDecisions = seedDecisions(),
): JointDecisionStatusModel {
  const { joint, packages, now } = seed;
  const pkg = packages.crossTenant;
  const tenantApprovals: readonly TenantApprovalVM[] = joint.affectedTenantIds.map((tid, i) => ({
    tenantId: tid,
    tenantName: `tenant ${tid.slice(0, 8)}`,
    status: i === 0 ? 'approved' : 'pending',
    current: i === 0, // only the home tenant has approved so far ⇒ gate still open
    reviewerPrincipalId: i === 0 ? APPROVER : '',
    decidedAtIso: i === 0 ? iso((now - ONE_HOUR) as EpochMillis) : '',
    evidenceDisclosed: false, // AC6 — never disclose another tenant's evidence
  }));
  const guardrails = pkg.requirements.filter(isCentralGuardrail);
  return {
    decisionId: joint.decisionId,
    workItemId: pkg.workItemId,
    requesterPrincipalId: pkg.requesterPrincipalId,
    requestedAction: pkg.requestedAction,
    executionBlocked: true, // guardrails pending + not all tenants approved + central not approved
    centralGuardrails: guardrails.map((g) => ({
      id: g.id,
      gateType: g.gateType,
      passed: g.status === 'satisfied',
      detail:
        g.status === 'satisfied'
          ? 'non-waivable guardrail satisfied'
          : 'non-waivable guardrail not yet satisfied — blocking',
    })),
    tenantApprovals,
    centralReview: {
      approved: joint.centralState === 'approved',
      reviewerPrincipalId: joint.centralReviewerPrincipalId ?? '',
      distinct: true, // central reviewer is distinct from tenant approvers and requester
      decidedAtIso: '',
      detail: 'awaiting distinct central governance review (FR-045)',
    },
    snapshotDigest: 'sha256:joint-status-fixed-digest',
  };
}

/** Project the seeded break-glass grant onto the EmergencyIntervention model — review OPEN. */
export function seedEmergencyInterventionModel(
  seed: SeededDecisions = seedDecisions(),
): EmergencyInterventionModel {
  const { breakGlass, now } = seed;
  const priorEvents: readonly BreakGlassEventVM[] = [
    {
      id: breakGlass.breakGlassGrantId,
      invokerPrincipalId: breakGlass.principalId,
      reasonText: breakGlass.reasonText,
      stoppedOperationId: uuidFromSlug('operation-payments-migration'),
      occurredAtIso: iso((now - 20 * ONE_MINUTE) as EpochMillis),
      reviewComplete: false, // mandatory post-event review still OPEN (FR-015)
      reviewerPrincipalId: '', // empty ⇒ review outstanding
    },
  ];
  return {
    target: {
      operationId: uuidFromSlug('operation-payments-migration'),
      workItemId: WORK_ITEM('expired-migration'),
      summary: 'payments schema migration currently mid-flight',
      status: 'running',
      startedAtIso: iso((now - 25 * ONE_MINUTE) as EpochMillis),
    },
    consequences: [
      { summary: 'halt the in-flight migration at its current step', effect: 'will' },
      { summary: 'approve any decision or grant you decision authority', effect: 'will_not' },
    ],
    armed: false,
    confirmationPhrase: 'STOP payments-migration',
    retainedConfirmation: '',
    retainedReasonCode: '',
    retainedReasonText: '',
    validation: [],
    priorEvents,
    stopEndpoint: '/api/operations/emergency-stop',
    snapshotDigest: 'sha256:emergency-fixed-digest',
  };
}
