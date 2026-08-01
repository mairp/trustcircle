// @trustcircle/authz — distinct workload identities, mTLS binding, and exact service
// capabilities (T040 / GAR-003 / VO-173f7afb7801f4ab3e29).
//
// Oracle (VO-173f7afb7801f4ab3e29): Request, review, approval, execution, evidence
// administration, control ownership, and assurance MUST be separated where conflicts
// exist; platform administration alone MUST NOT grant decision authority, and the
// independent central reviewer for a cross-tenant action MUST NOT hold an incompatible
// action role.
//
// Why a workload-identity module proves this oracle -----------------------------------
// Separation of duties is only meaningful over an AUTHENTIC principal identity. oidc.ts is
// the authentication gate for HUMAN sessions; this module is its service→service (workload)
// complement, matching plan.md §"Security boundaries" — Service → service: "Distinct workload
// identity, mTLS, exact capability allowlist, signed request context, network policy" — and
// contracts/README.md: "Workload calls require a distinct workload identity and mTLS or an
// approved equivalent." A workload (an adapter, projector, command-worker, or policy
// evaluator) is a MACHINE principal. If a workload's identity could be forged, or a workload
// could quietly acquire a capability it was never granted, or a workload could be treated as
// carrying human decision authority, then "platform administration alone grants no decision
// authority" and "the central reviewer is distinct and holds no incompatible role" would both
// collapse — an automation principal would launder itself into a decision or a central review.
//
// This module therefore, fail-closed:
//   1. DISTINCT WORKLOAD IDENTITIES — verifies a SPIFFE-style workload id that is structurally
//      distinct from a human subject, carries its service class + tenant/source scope, and is
//      bound to a single service. Two workloads are never conflated; a human subject can never
//      masquerade as a workload and vice-versa.
//   2. mTLS BINDING — binds the *claimed* identity to a *verified* mTLS peer certificate (or an
//      approved equivalent per the adapter manifest's identity_mode); an unverified chain, an
//      expired/not-yet-valid leaf, an identity/SAN mismatch, or a tenant-scope mismatch is
//      refused. The presented credential must PROVE the identity, not merely assert it.
//   3. EXACT SERVICE CAPABILITIES — authorizes a requested capability against an EXACT
//      allowlist (no prefix, no wildcard, no substring). A capability not explicitly granted is
//      denied. The allowlist itself is validated against the workload's service class so an
//      adapter can never be granted a decision/review/approval capability.
//   4. SoD BINDING — a workload may ONLY ever fill NON-DECISION duties (request/execution/
//      evidence_administration), always as a non-decision `automation_principal` role, and is
//      REFUSED any decision (review/approval/assurance) duty and any cross-tenant central-review
//      role. `workloadToDutyAssignment` is the SOLE sanctioned bridge from a verified workload
//      to a SoD DutyAssignment and it fails closed on any decision duty — the machine-principal
//      analogue of oidc.ts's PLATFORM_ADMIN_NO_AUTHORITY guard.
//
// Dependency-free at runtime except Node's built-in `crypto` (constant-time compare) — no
// network, no clock (any "now" is injected), no filesystem — so it is independently observable
// and testable under `npm ci` with `--experimental-strip-types` and compiles under the strict
// shared base as a `composite` project. It imports ONLY the sibling separation-of-duties.ts so
// the SoD binding is proven against the REAL guards, never a stand-in.

import { timingSafeEqual } from 'node:crypto';

import {
  type Duty,
  type DutyAssignment,
  type RoleKey,
  type Relationship,
  type SoDEvaluation,
  type Violation,
  NON_DECISION_ROLES,
} from './separation-of-duties.ts';

// ---------------------------------------------------------------------------
// Constant-time string compare (no early-exit length/branch leak). Used for issuer/
// identity equality so a near-match cannot be probed byte-by-byte.
// ---------------------------------------------------------------------------

/** Constant-time string equality. Fails closed on non-strings; never throws. */
export function constantTimeEqual(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Compare against self to keep the timing profile independent of the mismatch position.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// (1) Distinct workload identities.
// ---------------------------------------------------------------------------

/**
 * Service classes that may hold a workload identity. These are MACHINE principals; none of
 * them carries governance decision authority (see {@link DECISION_CAPABILITIES} /
 * {@link workloadToDutyAssignment}).
 */
export type ServiceClass =
  | 'adapter' // source connectors (kanban, wiggum, agentctl, lisa, …)
  | 'projector' // read-model projectors
  | 'command_worker' // outbox publisher / repair executor / audit export
  | 'policy_evaluator' // read-only PDP
  | 'api'; // the control-plane API service itself

export const ALL_SERVICE_CLASSES: readonly ServiceClass[] = [
  'adapter',
  'projector',
  'command_worker',
  'policy_evaluator',
  'api',
] as const;

/**
 * The approved workload authentication modes, mirroring
 * specs/.../contracts/adapter-manifest.schema.json `security.identity_mode`.
 * `mtls` is the canonical mode; the others are the "approved equivalents" of
 * contracts/README.md and MUST still be cryptographically bound (see {@link verifyWorkloadBinding}).
 */
export type IdentityMode =
  'mtls' | 'oauth2_client_credentials' | 'signed_workload' | 'local_socket';

export const ALL_IDENTITY_MODES: readonly IdentityMode[] = [
  'mtls',
  'oauth2_client_credentials',
  'signed_workload',
  'local_socket',
] as const;

/**
 * A distinct workload identity. `spiffeId` is a SPIFFE-style URI:
 *   spiffe://<trustDomain>/ns/<tenantId|central>/svc/<serviceClass>/<serviceName>[/src/<sourceId>]
 * It is structurally distinct from a human subject (a human subject is an opaque OIDC `sub`,
 * never a spiffe:// URI), so a human can never be mistaken for a workload.
 */
export interface WorkloadIdentity {
  readonly spiffeId: string;
  readonly trustDomain: string;
  readonly serviceClass: ServiceClass;
  readonly serviceName: string;
  /** null ONLY for a central (non-tenant-scoped) platform workload. */
  readonly tenantId: string | null;
  /** Present for a tenant-scoped source adapter; null otherwise. */
  readonly sourceId: string | null;
}

const SPIFFE_SCHEME = 'spiffe://';

/**
 * Parse and structurally validate a SPIFFE-style workload id. Fails closed (returns null) on
 * anything malformed: wrong scheme, empty segments, unknown service class, or an identity that
 * looks like a human subject. This is a TOTAL, pure function — never throws.
 */
export function parseWorkloadIdentity(spiffeId: unknown): WorkloadIdentity | null {
  if (typeof spiffeId !== 'string' || !spiffeId.startsWith(SPIFFE_SCHEME)) return null;
  const rest = spiffeId.slice(SPIFFE_SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null; // must have a trust domain AND a path
  const trustDomain = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (trustDomain.length === 0 || path.length === 0) return null;
  const segs = path.split('/');
  // ns/<tenant|central>/svc/<serviceClass>/<serviceName>[/src/<sourceId>]
  if (segs.length !== 5 && segs.length !== 7) return null;
  if (segs[0] !== 'ns' || segs[2] !== 'svc') return null;
  const nsScope = segs[1];
  const serviceClass = segs[3];
  const serviceName = segs[4];
  if (!nsScope || !serviceName) return null;
  if (!ALL_SERVICE_CLASSES.includes(serviceClass as ServiceClass)) return null;
  let sourceId: string | null = null;
  if (segs.length === 7) {
    if (segs[5] !== 'src' || !segs[6]) return null;
    sourceId = segs[6];
  }
  const tenantId = nsScope === 'central' ? null : nsScope;
  // Reject any segment that still carries structure that could smuggle another authority.
  for (const s of segs) {
    if (s.includes(SPIFFE_SCHEME) || s.length === 0) return null;
  }
  return {
    spiffeId,
    trustDomain,
    serviceClass: serviceClass as ServiceClass,
    serviceName,
    tenantId,
    sourceId,
  };
}

/**
 * True iff two workload identities are the SAME distinct workload. Distinctness is exact:
 * different trust domain, service class, service name, tenant, OR source ⇒ distinct.
 */
export function sameWorkload(a: WorkloadIdentity, b: WorkloadIdentity): boolean {
  return (
    constantTimeEqual(a.spiffeId, b.spiffeId) &&
    a.serviceClass === b.serviceClass &&
    a.serviceName === b.serviceName &&
    a.tenantId === b.tenantId &&
    a.sourceId === b.sourceId
  );
}

/** True iff `subject` is a human OIDC subject (NOT a workload SPIFFE id). */
export function isHumanSubject(subject: unknown): boolean {
  return typeof subject === 'string' && subject.length > 0 && !subject.startsWith(SPIFFE_SCHEME);
}

// ---------------------------------------------------------------------------
// (2) mTLS binding: bind the claimed identity to a verified peer credential.
// ---------------------------------------------------------------------------

/**
 * The verified properties of a presented peer credential, as established by the TLS terminator
 * BEFORE this module runs. `chainVerified` MUST be the result of real chain validation against
 * the trusted CA set; this module refuses to trust an unverified chain. Validity times are in
 * epoch milliseconds so the check is clock-injected and deterministic.
 */
export interface PeerCredential {
  readonly mode: IdentityMode;
  /** Result of CA-chain validation performed by the terminator. */
  readonly chainVerified: boolean;
  /** The SPIFFE URI SAN presented in the leaf certificate (or signed token subject). */
  readonly presentedSpiffeId: string;
  /** Leaf not-before / not-after in epoch ms. */
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
  /** The trust domain the terminator anchored the chain to. */
  readonly trustDomain: string;
}

/** The tenant/source scope a request is being made within (from routing / X-Tenant-ID). */
export interface RequestScope {
  readonly tenantId: string | null;
  readonly sourceId: string | null;
}

export type BindingRejectionCode =
  | 'UNSUPPORTED_MODE'
  | 'CHAIN_UNVERIFIED'
  | 'MALFORMED_IDENTITY'
  | 'IDENTITY_MISMATCH' // presented SAN ≠ claimed identity
  | 'TRUST_DOMAIN_MISMATCH'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_NOT_YET_VALID'
  | 'TENANT_SCOPE_MISMATCH' // identity tenant ≠ request tenant
  | 'SOURCE_SCOPE_MISMATCH'; // identity source ≠ request source

export interface BindingRejection {
  readonly code: BindingRejectionCode;
  readonly message: string;
}

export interface VerifiedWorkload {
  readonly identity: WorkloadIdentity;
  readonly mode: IdentityMode;
  /** The single distinct principal id this workload acts as, for the SoD layer. */
  readonly principalId: string;
}

export type WorkloadBinding =
  | { readonly ok: true; readonly workload: VerifiedWorkload }
  | { readonly ok: false; readonly rejections: readonly BindingRejection[] };

/**
 * Verify that a presented peer credential cryptographically BINDS to a claimed distinct
 * workload identity, within the given request scope, at time `nowMs`. Fails CLOSED and
 * accumulates EVERY reason so a rejected attempt can be fully recorded.
 *
 * The claimed identity is derived from the credential's OWN presented SAN (not from any
 * caller-supplied header), so a caller cannot claim one identity while presenting another.
 */
export function verifyWorkloadBinding(
  credential: PeerCredential,
  scope: RequestScope,
  nowMs: number,
): WorkloadBinding {
  const rejections: BindingRejection[] = [];

  if (!ALL_IDENTITY_MODES.includes(credential.mode)) {
    rejections.push({
      code: 'UNSUPPORTED_MODE',
      message: `identity mode '${String(credential.mode)}' is not an approved workload mode`,
    });
  }

  // The chain MUST be verified by the terminator; an unverified chain is never trusted.
  if (credential.chainVerified !== true) {
    rejections.push({
      code: 'CHAIN_UNVERIFIED',
      message: 'peer certificate chain was not verified against the trusted CA set',
    });
  }

  const identity = parseWorkloadIdentity(credential.presentedSpiffeId);
  if (identity === null) {
    rejections.push({
      code: 'MALFORMED_IDENTITY',
      message: 'presented SPIFFE identity is malformed or is not a workload identity',
    });
    // Without a parseable identity nothing else can be bound; return early, fail closed.
    return { ok: false, rejections };
  }

  // The credential's trust domain must match the identity's trust domain.
  if (!constantTimeEqual(credential.trustDomain, identity.trustDomain)) {
    rejections.push({
      code: 'TRUST_DOMAIN_MISMATCH',
      message: `credential trust domain '${credential.trustDomain}' ≠ identity trust domain '${identity.trustDomain}'`,
    });
  }

  // Validity window (clock-injected, inclusive not-before, exclusive not-after).
  if (!(
    Number.isFinite(nowMs) &&
    Number.isFinite(credential.notBeforeMs) &&
    Number.isFinite(credential.notAfterMs)
  )) {
    rejections.push({
      code: 'CREDENTIAL_EXPIRED',
      message: 'credential validity window or evaluation time is not a finite number',
    });
  } else {
    if (nowMs < credential.notBeforeMs) {
      rejections.push({
        code: 'CREDENTIAL_NOT_YET_VALID',
        message: `credential not valid until ${credential.notBeforeMs} but now is ${nowMs}`,
      });
    }
    if (nowMs >= credential.notAfterMs) {
      rejections.push({
        code: 'CREDENTIAL_EXPIRED',
        message: `credential expired at ${credential.notAfterMs} but now is ${nowMs}`,
      });
    }
  }

  // Scope binding: a tenant-scoped workload can only act within its own tenant, and a
  // source adapter only within its own source. A central workload (tenantId === null) is
  // NOT permitted to impersonate a tenant scope.
  if (identity.tenantId !== scope.tenantId) {
    rejections.push({
      code: 'TENANT_SCOPE_MISMATCH',
      message: `workload identity tenant '${identity.tenantId ?? 'central'}' ≠ request tenant '${scope.tenantId ?? 'central'}'`,
    });
  }
  if (identity.sourceId !== null && identity.sourceId !== scope.sourceId) {
    rejections.push({
      code: 'SOURCE_SCOPE_MISMATCH',
      message: `workload identity source '${identity.sourceId}' ≠ request source '${scope.sourceId ?? 'none'}'`,
    });
  }

  if (rejections.length > 0) return { ok: false, rejections };

  return {
    ok: true,
    workload: {
      identity,
      mode: credential.mode,
      principalId: identity.spiffeId,
    },
  };
}

// ---------------------------------------------------------------------------
// (3) Exact service capabilities.
// ---------------------------------------------------------------------------

/**
 * A capability grant: the EXACT set of capability tokens a workload is authorized for. The
 * allowlist is exact-match only — no prefix, no wildcard, no substring. `serviceClass` binds
 * the grant to a class so it can be validated (a decision capability can never be granted to a
 * non-`api` class).
 */
export interface CapabilityGrant {
  readonly spiffeId: string;
  readonly serviceClass: ServiceClass;
  /** EXACT capability tokens, e.g. 'source.read', 'outbox.publish', 'evidence.write'. */
  readonly capabilities: readonly string[];
}

/**
 * Capabilities that constitute governance DECISION authority. A workload MUST NEVER be granted
 * one of these — they belong to a human decision duty (review/approval/assurance). Used both to
 * validate a grant ({@link validateCapabilityGrant}) and to refuse a workload duty assignment.
 */
export const DECISION_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  'decision.approve',
  'decision.deny',
  'decision.review',
  'decision.delegate',
  'decision.escalate',
  'assurance.attest',
  'control.own',
  'central.review',
]);

export type CapabilityRejectionCode =
  | 'CAPABILITY_NOT_GRANTED' // requested token not in the exact allowlist
  | 'GRANT_IDENTITY_MISMATCH' // grant is for a different workload
  | 'DECISION_CAPABILITY_FORBIDDEN' // grant tries to hand a workload decision authority
  | 'EMPTY_CAPABILITY'; // requested/granted token is empty/whitespace

export interface CapabilityRejection {
  readonly code: CapabilityRejectionCode;
  readonly message: string;
}

export interface CapabilityDecision {
  readonly permitted: boolean;
  readonly rejections: readonly CapabilityRejection[];
}

function isBlank(s: unknown): boolean {
  return typeof s !== 'string' || s.trim().length === 0;
}

/**
 * Validate a capability grant in isolation: reject empty tokens and reject ANY grant that would
 * hand a workload a governance decision capability. Fails closed. This runs at grant-admission
 * time so a decision capability can never even be stored against a workload.
 */
export function validateCapabilityGrant(grant: CapabilityGrant): CapabilityDecision {
  const rejections: CapabilityRejection[] = [];
  for (const cap of grant.capabilities) {
    if (isBlank(cap)) {
      rejections.push({ code: 'EMPTY_CAPABILITY', message: 'capability token is empty' });
      continue;
    }
    if (DECISION_CAPABILITIES.has(cap)) {
      rejections.push({
        code: 'DECISION_CAPABILITY_FORBIDDEN',
        message: `workload '${grant.spiffeId}' may not be granted decision capability '${cap}' — platform/automation grants no decision authority`,
      });
    }
  }
  return { permitted: rejections.length === 0, rejections };
}

/**
 * Authorize a single requested capability for a verified workload against its EXACT allowlist.
 * Exact-match only: 'source.read' does NOT grant 'source.read.all' and 'outbox' does NOT grant
 * 'outbox.publish'. A blank request, an identity mismatch, or a capability absent from the
 * allowlist is refused. Fails closed.
 */
export function authorizeCapability(
  workload: VerifiedWorkload,
  grant: CapabilityGrant,
  requested: string,
): CapabilityDecision {
  const rejections: CapabilityRejection[] = [];

  // A grant only ever applies to its own workload identity — never another's.
  if (!constantTimeEqual(grant.spiffeId, workload.identity.spiffeId)) {
    rejections.push({
      code: 'GRANT_IDENTITY_MISMATCH',
      message: `capability grant is for '${grant.spiffeId}', not the verified workload '${workload.identity.spiffeId}'`,
    });
  }

  if (isBlank(requested)) {
    rejections.push({ code: 'EMPTY_CAPABILITY', message: 'requested capability is empty' });
    return { permitted: false, rejections };
  }

  // The grant itself must be admissible (no decision capability laundered in).
  const grantValidation = validateCapabilityGrant(grant);
  rejections.push(...grantValidation.rejections);

  // Even if a malformed grant somehow lists it, a decision capability is NEVER authorizable
  // for a workload.
  if (DECISION_CAPABILITIES.has(requested)) {
    rejections.push({
      code: 'DECISION_CAPABILITY_FORBIDDEN',
      message: `workload '${workload.identity.spiffeId}' requested decision capability '${requested}' — refused`,
    });
    return { permitted: false, rejections };
  }

  // EXACT membership — no prefix/wildcard/substring.
  const granted = grant.capabilities.some((c) => c === requested);
  if (!granted) {
    rejections.push({
      code: 'CAPABILITY_NOT_GRANTED',
      message: `capability '${requested}' is not in the exact allowlist for workload '${workload.identity.spiffeId}'`,
    });
  }

  return { permitted: rejections.length === 0, rejections };
}

// ---------------------------------------------------------------------------
// (4) SoD binding — the sole sanctioned bridge from a verified workload to a SoD duty.
// ---------------------------------------------------------------------------

/**
 * The ONLY duties a machine principal may fill. Every one is a NON-DECISION duty; a workload is
 * refused review/approval/assurance (and control ownership) categorically.
 */
export const WORKLOAD_ALLOWED_DUTIES: ReadonlySet<Duty> = new Set<Duty>([
  'request',
  'execution',
  'evidence_administration',
]);

export type WorkloadDutyRejectionCode =
  | 'DECISION_DUTY_FORBIDDEN' // a workload may not fill review/approval/assurance/control_ownership
  | 'UNKNOWN_DUTY';

export interface WorkloadDutyRejection {
  readonly code: WorkloadDutyRejectionCode;
  readonly message: string;
}

export type WorkloadDutyResult =
  | { readonly ok: true; readonly assignment: DutyAssignment }
  | { readonly ok: false; readonly rejections: readonly WorkloadDutyRejection[] };

/**
 * Bridge a verified workload into a SoD {@link DutyAssignment}. This is the machine-principal
 * analogue of oidc.ts's `sessionToDutyAssignment` and it FAILS CLOSED on any decision duty:
 * the produced assignment ALWAYS carries the single non-decision role `automation_principal`
 * (which {@link NON_DECISION_ROLES} contains), so when it flows into
 * `evaluateSeparationOfDuties`/`checkRoles`, a workload filling a decision duty triggers
 * PLATFORM_ADMIN_NO_AUTHORITY there too — belt and suspenders. Here we refuse the decision duty
 * outright so it never reaches the guard at all.
 */
export function workloadToDutyAssignment(
  workload: VerifiedWorkload,
  duty: Duty,
  relationships: readonly Relationship[] = ['executor'],
): WorkloadDutyResult {
  const rejections: WorkloadDutyRejection[] = [];
  if (!WORKLOAD_ALLOWED_DUTIES.has(duty)) {
    // Distinguish an unknown duty from a decision duty for clearer rejection records.
    const known: readonly Duty[] = [
      'request',
      'review',
      'approval',
      'execution',
      'evidence_administration',
      'control_ownership',
      'assurance',
    ];
    if (!known.includes(duty)) {
      rejections.push({ code: 'UNKNOWN_DUTY', message: `unknown duty '${String(duty)}'` });
    } else {
      rejections.push({
        code: 'DECISION_DUTY_FORBIDDEN',
        message: `workload '${workload.identity.spiffeId}' may not fill decision/ownership duty '${duty}' — automation grants no decision authority`,
      });
    }
    return { ok: false, rejections };
  }

  const role: RoleKey = 'automation_principal';
  // Invariant: the workload role is always non-decision. Assert it so a future edit can't slip.
  if (!NON_DECISION_ROLES.has(role)) {
    rejections.push({
      code: 'DECISION_DUTY_FORBIDDEN',
      message: 'internal invariant violated: workload role must be a non-decision role',
    });
    return { ok: false, rejections };
  }

  return {
    ok: true,
    assignment: {
      principalId: workload.principalId,
      duty,
      roles: [role],
      relationships,
      tenantId: workload.identity.tenantId,
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-tenant central reviewer: a workload can NEVER be the independent central reviewer.
// ---------------------------------------------------------------------------

/**
 * The independent central reviewer for a cross-tenant action MUST be a human with the
 * central_governance_reviewer role. A workload (automation principal) can NEVER be that
 * reviewer. This mirrors and complements evaluateCentralReviewerDistinctness /
 * assertCrossTenantReviewerSession by rejecting a MACHINE reviewer up front. Fails closed.
 */
export function assertNotWorkloadReviewer(reviewerPrincipalId: unknown): SoDEvaluation {
  const violations: Violation[] = [];
  const looksLikeWorkload =
    typeof reviewerPrincipalId === 'string' && reviewerPrincipalId.startsWith(SPIFFE_SCHEME);
  if (looksLikeWorkload || !isHumanSubject(reviewerPrincipalId)) {
    violations.push({
      code: 'CENTRAL_REVIEWER_INCOMPATIBLE_ROLE',
      message: `cross-tenant central reviewer '${String(
        reviewerPrincipalId,
      )}' is a workload/automation principal, not an independent human reviewer`,
      principals: [typeof reviewerPrincipalId === 'string' ? reviewerPrincipalId : ''],
    });
  }
  return { permitted: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// End-to-end admission: verify identity+binding, authorize a capability, and (optionally)
// bridge to a SoD duty — a single fail-closed entry point for a workload request.
// ---------------------------------------------------------------------------

export interface WorkloadRequest {
  readonly credential: PeerCredential;
  readonly scope: RequestScope;
  readonly grant: CapabilityGrant;
  readonly requestedCapability: string;
  readonly duty: Duty;
  readonly relationships?: readonly Relationship[];
}

export type WorkloadAdmission =
  | {
      readonly ok: true;
      readonly workload: VerifiedWorkload;
      readonly assignment: DutyAssignment;
    }
  | {
      readonly ok: false;
      readonly stage: 'binding' | 'capability' | 'duty';
      readonly reasons: readonly string[];
    };

/**
 * Admit a workload request end-to-end, fail-closed at the FIRST failing stage:
 *   1. bind the presented credential to a distinct workload identity within scope (mTLS),
 *   2. authorize the requested capability against the EXACT allowlist,
 *   3. bridge to a NON-DECISION SoD duty (refusing any decision duty).
 * Returns a verified workload + its SoD duty assignment only when ALL stages pass.
 */
export function admitWorkloadRequest(req: WorkloadRequest, nowMs: number): WorkloadAdmission {
  const binding = verifyWorkloadBinding(req.credential, req.scope, nowMs);
  if (!binding.ok) {
    return { ok: false, stage: 'binding', reasons: binding.rejections.map((r) => r.message) };
  }
  const capability = authorizeCapability(binding.workload, req.grant, req.requestedCapability);
  if (!capability.permitted) {
    return { ok: false, stage: 'capability', reasons: capability.rejections.map((r) => r.message) };
  }
  const duty = workloadToDutyAssignment(binding.workload, req.duty, req.relationships);
  if (!duty.ok) {
    return { ok: false, stage: 'duty', reasons: duty.rejections.map((r) => r.message) };
  }
  return { ok: true, workload: binding.workload, assignment: duty.assignment };
}
