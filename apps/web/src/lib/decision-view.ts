// Pure view model for the live decision screens (/decisions and /decisions/[decisionId]).
//
// Everything here is a deterministic function of the API's wire representation, the verified
// session and an injected instant. Nothing grants authority: the API re-checks role authority,
// separation of duties, expiry and version on every action. The UI only explains, up front, why a
// form is or is not offered, so a reviewer never meets an unexplained disabled button.

export const DECISION_STATUSES = [
  'pending',
  'in_review',
  'approved',
  'denied',
  'changes_requested',
  'escalated',
  'delegated',
  'expired',
  'cancelled',
  'invalidated',
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

const TERMINAL: ReadonlySet<string> = new Set(['approved', 'denied', 'expired', 'cancelled']);

/** Actions a reviewer can take from the action panel (expire is system-driven, not offered). */
export const REVIEW_ACTIONS = ['approve', 'deny', 'request_changes', 'escalate'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export type DecisionActionVerb = ReviewAction | 'delegate' | 'cancel';

export interface DecisionRequirementView {
  readonly id: string;
  readonly gateType: string;
  readonly status: string;
  readonly minimumDistinctPrincipals: number;
  readonly incompatibleRelationships: readonly string[];
}

export interface DecisionView {
  readonly id: string;
  readonly workItemId: string;
  readonly requesterPrincipalId: string;
  readonly requestedAction: string;
  readonly actionClass: string;
  readonly riskTier: string;
  readonly status: string;
  readonly version: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly scope: Readonly<Record<string, unknown>>;
  readonly businessImpact: Readonly<Record<string, unknown>>;
  readonly expectedResult: Readonly<Record<string, unknown>>;
  readonly risks: readonly Readonly<Record<string, unknown>>[];
  readonly alternatives: readonly Readonly<Record<string, unknown>>[];
  readonly requirements: readonly DecisionRequirementView[];
  readonly evidenceManifestId?: string;
  readonly simulationId?: string;
}

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
const records = (value: unknown): readonly Readonly<Record<string, unknown>>[] =>
  Array.isArray(value) ? value.map(record) : [];

/** Parse one wire `DecisionRequest`; undefined when the identity fields are missing. */
export function parseDecision(raw: unknown): DecisionView | undefined {
  const r = record(raw);
  const id = text(r['id']);
  if (!id) return undefined;
  const version = typeof r['version'] === 'number' ? r['version'] : Number.NaN;
  if (!Number.isInteger(version) || version < 1) return undefined;
  const evidenceManifestId = text(r['evidence_manifest_id']);
  const simulationId = text(r['simulation_id']);
  return {
    id,
    workItemId: text(r['work_item_id'], 'unknown'),
    requesterPrincipalId: text(r['requester_principal_id'], 'unknown'),
    requestedAction: text(r['requested_action'], 'Unnamed decision'),
    actionClass: text(r['action_class'], 'unknown'),
    riskTier: text(r['risk_tier'], 'unknown'),
    status: text(r['status'], 'unknown'),
    version,
    createdAt: text(r['created_at']),
    expiresAt: text(r['expires_at']),
    scope: record(r['scope']),
    businessImpact: record(r['business_impact']),
    expectedResult: record(r['expected_result']),
    risks: records(r['risks']),
    alternatives: records(r['alternatives']),
    requirements: (Array.isArray(r['requirements']) ? r['requirements'] : []).map((q) => {
      const req = record(q);
      return {
        id: text(req['id'], 'unknown'),
        gateType: text(req['gate_type'], 'unknown'),
        status: text(req['status'], 'unknown'),
        minimumDistinctPrincipals:
          typeof req['minimum_distinct_principals'] === 'number'
            ? req['minimum_distinct_principals']
            : 1,
        incompatibleRelationships: Array.isArray(req['incompatible_relationships'])
          ? req['incompatible_relationships'].filter((x): x is string => typeof x === 'string')
          : [],
      };
    }),
    ...(evidenceManifestId ? { evidenceManifestId } : {}),
    ...(simulationId ? { simulationId } : {}),
  };
}

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export function statusLabel(status: string): string {
  return status === 'in_review'
    ? 'In review'
    : status === 'changes_requested'
      ? 'Changes requested'
      : status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
}

// ── Time posture: stated in words, never colour alone (WCAG 1.4.1) ────────────────────────────

export type TimePosture = 'fresh' | 'expiring_soon' | 'expired' | 'unknown';

const DAY = 24 * 60 * 60 * 1000;

export function timePosture(expiresAt: string, now: number): TimePosture {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return 'unknown';
  if (at <= now) return 'expired';
  return at - now <= DAY ? 'expiring_soon' : 'fresh';
}

export function timePostureLabel(posture: TimePosture): string {
  return posture === 'expired'
    ? 'Expired'
    : posture === 'expiring_soon'
      ? 'Expires within 24 h'
      : posture === 'fresh'
        ? 'Within its window'
        : 'Expiry unknown';
}

/**
 * Requirement gates not yet satisfied. Only `satisfied` closes a gate (waivers are forbidden by the
 * domain); an unknown status counts as open, so a gate is never assumed to have passed.
 */
export function openRequirements(decision: DecisionView): readonly DecisionRequirementView[] {
  return decision.requirements.filter((q) => q.status !== 'satisfied');
}

export function requirementStatusLabel(status: string): string {
  return status === 'satisfied'
    ? 'Satisfied'
    : status === 'failed'
      ? 'Failed'
      : status === 'waived_forbidden'
        ? 'Waiver refused'
        : status === 'pending'
          ? 'Pending'
          : 'Unknown';
}

// ── Who may act, and why not ──────────────────────────────────────────────────────────────────

export interface ActingPosition {
  /** Review actions (approve/deny/request changes/escalate) are offered. */
  readonly canReview: boolean;
  /** The delegation form is offered. */
  readonly canDelegate: boolean;
  /** The requester may withdraw (cancel) their own open request. */
  readonly canCancel: boolean;
  /** Why review actions are not offered, in plain words; undefined when they are. */
  readonly blockedReason?: string;
}

export function actingPosition(
  decision: DecisionView,
  principalId: string | undefined,
  roleMayAct: boolean,
  roleMayDelegate: boolean,
  now: number,
): ActingPosition {
  const isRequester = principalId !== undefined && principalId === decision.requesterPrincipalId;
  if (isTerminal(decision.status)) {
    return {
      canReview: false,
      canDelegate: false,
      canCancel: false,
      blockedReason: `This decision is closed (${statusLabel(decision.status).toLowerCase()}). No further action can be taken.`,
    };
  }
  if (timePosture(decision.expiresAt, now) === 'expired') {
    return {
      canReview: false,
      canDelegate: false,
      canCancel: isRequester,
      blockedReason:
        'This decision package has expired. Acting on stale information is refused; ask the requester to raise a fresh package.',
    };
  }
  if (isRequester) {
    return {
      canReview: false,
      canDelegate: false,
      canCancel: true,
      blockedReason:
        'You requested this decision. Separation of duties requires a different person with authority to approve or deny it.',
    };
  }
  if (!roleMayAct) {
    return {
      canReview: false,
      canDelegate: false,
      canCancel: false,
      blockedReason:
        'Your verified role can read decisions but holds no decision authority. Nothing here can be changed from this session.',
    };
  }
  return { canReview: true, canDelegate: roleMayDelegate, canCancel: false };
}

// ── Action request bodies (the server action posts exactly this) ──────────────────────────────

export const REASON_CODE_RE = /^[a-z][a-z0-9_.-]{1,63}$/;

export const REASON_CODES: Readonly<Record<DecisionActionVerb, readonly [string, string][]>> = {
  approve: [
    ['risk.accepted', 'Risk understood and accepted'],
    ['evidence.sufficient', 'Evidence is sufficient'],
    ['policy.compliant', 'Consistent with policy'],
  ],
  deny: [
    ['risk.unacceptable', 'Risk is not acceptable'],
    ['evidence.insufficient', 'Evidence is insufficient'],
    ['policy.conflict', 'Conflicts with policy'],
  ],
  request_changes: [
    ['package.incomplete', 'Package is incomplete'],
    ['scope.unclear', 'Scope is unclear'],
    ['alternatives.missing', 'Alternatives not considered'],
  ],
  escalate: [
    ['authority.insufficient', 'Needs higher authority'],
    ['impact.cross_domain', 'Cross-domain impact'],
  ],
  delegate: [
    ['availability.absence', 'Planned absence'],
    ['expertise.required', 'Specialist expertise required'],
  ],
  cancel: [['request.withdrawn', 'Request withdrawn by requester']],
};

export interface ParsedAction {
  readonly decisionId: string;
  readonly etag: string;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Thrown for input the reviewer can fix; its message is safe to show on the page. */
export class DecisionInputError extends Error {}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `datetime-local` inputs carry no zone; the form labels them UTC, so parse them as UTC. */
function parseUtc(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value) ? `${value}Z` : value);
}

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function reasonFrom(form: FormData, action: DecisionActionVerb) {
  const code = field(form, 'reason_code');
  const reasonText = field(form, 'reason_text');
  if (!REASON_CODE_RE.test(code) || !REASON_CODES[action].some(([c]) => c === code)) {
    throw new DecisionInputError('Choose a reason from the list.');
  }
  if (reasonText.length < 3 || reasonText.length > 4000) {
    throw new DecisionInputError('Explain your reason in 3 to 4000 characters.');
  }
  return { code, text: reasonText };
}

/** Validate a submitted action form and build the exact API body. Pure; throws DecisionInputError. */
export function parseDecisionActionForm(form: FormData): ParsedAction {
  const decisionId = field(form, 'decision_id');
  const etag = field(form, 'etag');
  if (!UUID_RE.test(decisionId)) throw new DecisionInputError('Unknown decision.');
  if (!etag) throw new DecisionInputError('Re-open the decision: its version is missing.');
  const action = field(form, 'action') as DecisionActionVerb;
  if (![...REVIEW_ACTIONS, 'delegate', 'cancel'].includes(action)) {
    throw new DecisionInputError('Choose an action.');
  }
  const reason = reasonFrom(form, action);
  if (action !== 'delegate') return { decisionId, etag, body: { action, reason } };

  const recipient = field(form, 'recipient_principal_id');
  const assignment = field(form, 'authority_assignment_id');
  if (!UUID_RE.test(recipient)) throw new DecisionInputError('Recipient must be a principal ID.');
  if (!UUID_RE.test(assignment)) {
    throw new DecisionInputError('Authority assignment must be an assignment ID.');
  }
  const actions = form
    .getAll('delegated_actions')
    .filter(
      (a): a is string =>
        typeof a === 'string' && (REVIEW_ACTIONS as readonly string[]).includes(a),
    );
  if (actions.length === 0) throw new DecisionInputError('Delegate at least one action.');
  const validFrom = parseUtc(field(form, 'valid_from'));
  const expiresAt = parseUtc(field(form, 'delegation_expires_at'));
  if (Number.isNaN(validFrom) || Number.isNaN(expiresAt) || expiresAt <= validFrom) {
    throw new DecisionInputError('The delegation must end after it starts.');
  }
  return {
    decisionId,
    etag,
    body: {
      action,
      reason,
      delegation: {
        recipient_principal_id: recipient,
        authority_assignment_id: assignment,
        scope: { decision_id: decisionId },
        actions: [...new Set(actions)],
        reason,
        valid_from: new Date(validFrom).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
      },
    },
  };
}

/** Short past-tense outcome for the confirmation banner. */
export function outcomeLabel(action: string): string {
  return action === 'approve'
    ? 'Approved'
    : action === 'deny'
      ? 'Denied'
      : action === 'request_changes'
        ? 'Changes requested'
        : action === 'escalate'
          ? 'Escalated'
          : action === 'delegate'
            ? 'Delegated'
            : action === 'cancel'
              ? 'Withdrawn'
              : 'Recorded';
}
