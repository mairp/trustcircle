// @trustcircle/authz — OIDC issuer / audience / subject / expiry / assurance validation
// for HUMAN sessions (T044 / GAR-003 / VO-173f7afb7801f4ab3e29).
//
// Oracle (VO-173f7afb7801f4ab3e29): Request, review, approval, execution, evidence
// administration, control ownership, and assurance MUST be separated where conflicts
// exist; platform administration alone MUST NOT grant decision authority, and the
// independent central reviewer for a cross-tenant action MUST NOT hold an incompatible
// action role.
//
// Why OIDC session validation is part of the Separation-of-Duties contract
// ------------------------------------------------------------------------
// Separation of duties is only meaningful over an AUTHENTIC principal identity. Every
// SoD guard in ./separation-of-duties.ts consumes a `principalId`, a set of `roles`, and
// (for decision authority) an assurance expectation. If a human session's subject could be
// forged, replayed after expiry, minted by an untrusted issuer, or issued for a different
// relying party, then "two distinct principals" and "the central reviewer is distinct"
// collapse — an attacker (or one person) could masquerade as several principals, or a
// platform-administration session could silently carry decision authority it never earned.
//
// This module is therefore the AUTHENTICATION gate that establishes the trustworthy
// `VerifiedHumanSession` the SoD layer relies on. It enforces, fail-closed, the five
// facts named in the phase objective for a human session:
//
//   1. issuer     — the token comes from a trusted, pinned identity provider (exact match).
//   2. audience   — the token was minted for THIS relying party (this platform), not another.
//   3. subject    — a present, stable, non-empty subject that becomes the SoD `principalId`.
//   4. expiry     — not expired and not used before its not-before; bounded max age; the
//                   `auth_time`/session lifetime is honoured so a stale session cannot act.
//   5. assurance  — the authentication assurance level (AAL/ACR + amr) meets the minimum the
//                   requested duty requires; DECISION duties require step-up assurance so
//                   platform administration (or a weakly-authenticated session) alone can
//                   never carry decision authority.
//
// The module additionally exposes:
//   * `sessionToDutyAssignment` — the ONLY sanctioned bridge from a verified session to a
//     `DutyAssignment`, so SoD is always evaluated over an authenticated subject.
//   * `assertDecisionAuthority` — a verified session may fill a DECISION duty only when it
//     both meets step-up assurance AND carries at least one genuine decision role; a session
//     backed solely by `platform_admin` (or any non-decision role) is refused here too — the
//     authentication-layer mirror of the SoD `PLATFORM_ADMIN_NO_AUTHORITY` guard.
//   * `assertCrossTenantReviewerSession` — the independent central reviewer for a cross-tenant
//     action must present a HIGH-assurance session whose verified subject is distinct from
//     every action principal and holds no incompatible action role.
//
// Dependency-free at runtime (Node built-in `crypto` only for constant-time compare); pure
// with respect to inputs (the caller supplies "now", so there is no hidden clock) so it is
// deterministic and independently testable under `npm ci` with no adjacent infrastructure.
// Compiles under the strict shared base (tsconfig.base.json) as a `composite` project.

import { timingSafeEqual } from 'node:crypto';

import type { Duty, DutyAssignment, RoleKey, Relationship } from './separation-of-duties.ts';
import { NON_DECISION_ROLES } from './separation-of-duties.ts';

// ---------------------------------------------------------------------------
// Assurance levels (NIST 800-63 AAL, surfaced via OIDC `acr`/`amr`).
// ---------------------------------------------------------------------------

/**
 * Authentication assurance, ordered. Higher ordinal = stronger. `unknown` is the fail-closed
 * floor for any session whose assurance cannot be established.
 */
export type AssuranceLevel = 'unknown' | 'aal1' | 'aal2' | 'aal3';

const ASSURANCE_ORDER: Record<AssuranceLevel, number> = {
  unknown: 0,
  aal1: 1,
  aal2: 2,
  aal3: 3,
};

/** True iff `have` is at least as strong as `need`. */
export function assuranceMeets(have: AssuranceLevel, need: AssuranceLevel): boolean {
  return ASSURANCE_ORDER[have] >= ASSURANCE_ORDER[need];
}

/**
 * The minimum assurance a duty requires. DECISION duties (review/approval/assurance) require
 * step-up (aal2). All other governed duties require at least a single-factor authenticated
 * session (aal1) — never `unknown`. Cross-tenant central review is gated separately at aal3.
 */
const DECISION_DUTIES: ReadonlySet<Duty> = new Set<Duty>(['approval', 'review', 'assurance']);

export function requiredAssuranceForDuty(duty: Duty): AssuranceLevel {
  return DECISION_DUTIES.has(duty) ? 'aal2' : 'aal1';
}

/** Assurance floor for the independent central reviewer of a cross-tenant action. */
export const CROSS_TENANT_REVIEWER_ASSURANCE: AssuranceLevel = 'aal3';

/**
 * Map an OIDC `acr` claim (and, as corroboration, the `amr` methods) to an AssuranceLevel.
 * Fails closed to `unknown` on any unrecognised / missing value.
 */
export function assuranceFromClaims(acr: unknown, amr: unknown): AssuranceLevel {
  const methods = Array.isArray(amr) ? amr.filter((m): m is string => typeof m === 'string') : [];
  const hardwareOrPhishingResistant = methods.some((m) =>
    ['hwk', 'swk', 'phr', 'phrh', 'fido', 'wia'].includes(m),
  );
  const multiFactor =
    methods.includes('mfa') ||
    // two independent factor kinds present
    [
      ['pwd', 'kba'].some((m) => methods.includes(m)), // something you know
      ['otp', 'sms', 'tel'].some((m) => methods.includes(m)), // something you have (weak)
      ['hwk', 'swk', 'fido', 'wia', 'pop'].some((m) => methods.includes(m)), // possession (strong)
      ['face', 'fpt', 'iris', 'vbm'].some((m) => methods.includes(m)), // biometric
    ].filter(Boolean).length >= 2;

  if (typeof acr === 'string') {
    const a = acr.trim().toLowerCase();
    if (a === 'aal3' || a === 'urn:mace:incommon:iap:silver3' || a === '3') return 'aal3';
    if (a === 'aal2' || a === '2' || a.includes('mfa')) return 'aal2';
    if (a === 'aal1' || a === '1' || a === 'urn:okta:loa:1fa:any') {
      return hardwareOrPhishingResistant ? 'aal2' : 'aal1';
    }
    if (a === 'aal0' || a === '0' || a === 'urn:oasis:names:tc:saml:2.0:ac:classes:unspecified') {
      return 'unknown';
    }
  }
  // No usable acr: fall back to amr-derived assurance, still fail-closed.
  if (hardwareOrPhishingResistant && multiFactor) return 'aal3';
  if (multiFactor) return 'aal2';
  if (methods.length > 0) return 'aal1';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Token shape & verification policy.
// ---------------------------------------------------------------------------

/**
 * The subset of OIDC ID-token claims this gate validates. `sub` becomes the SoD principal id.
 * All time claims are seconds since the Unix epoch (OIDC/JWT convention).
 */
export interface OidcIdTokenClaims {
  readonly iss?: unknown;
  readonly aud?: unknown; // string | string[]
  readonly azp?: unknown; // authorized party (required when aud has >1 entry)
  readonly sub?: unknown;
  readonly exp?: unknown; // seconds
  readonly iat?: unknown; // seconds
  readonly nbf?: unknown; // seconds
  readonly auth_time?: unknown; // seconds — when the user actually authenticated
  readonly acr?: unknown;
  readonly amr?: unknown;
  readonly nonce?: unknown;
  readonly tid?: unknown; // tenant id claim (optional; tenant-scoped IdPs)
  readonly roles?: unknown; // string[]
  // A verifier upstream (JWKS/signature) sets this; a session whose signature was NOT
  // cryptographically verified can never be accepted here (fail-closed).
  readonly __signatureVerified?: unknown;
}

export interface HumanSessionPolicy {
  /** Exactly the issuers this relying party trusts. Exact string match; no wildcards. */
  readonly trustedIssuers: readonly string[];
  /** This relying party's client id(s). The token's `aud` MUST contain one of these. */
  readonly audience: readonly string[];
  /** Allowed clock skew, seconds, applied to exp/nbf/iat comparisons. */
  readonly clockSkewSeconds: number;
  /** Maximum session age from `auth_time`, seconds. A session older than this is stale. */
  readonly maxSessionAgeSeconds: number;
  /** If true, a `nonce` claim must be present (replay binding). */
  readonly requireNonce: boolean;
  /** Roles this session is permitted to assert; asserted roles outside this set are dropped. */
  readonly assignableRoles: readonly RoleKey[];
}

export type SessionRejectionCode =
  | 'SIGNATURE_UNVERIFIED'
  | 'UNTRUSTED_ISSUER'
  | 'AUDIENCE_MISMATCH'
  | 'AZP_MISMATCH'
  | 'SUBJECT_MISSING'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'ISSUED_IN_FUTURE'
  | 'SESSION_STALE'
  | 'NONCE_MISSING'
  | 'ASSURANCE_INSUFFICIENT'
  | 'MALFORMED_CLAIM';

export interface SessionRejection {
  readonly code: SessionRejectionCode;
  readonly message: string;
}

/** A cryptographically- and policy-verified human session. `principalId` === verified `sub`. */
export interface VerifiedHumanSession {
  readonly principalId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string | null;
  readonly assurance: AssuranceLevel;
  /** Roles narrowed to the policy's assignable set. */
  readonly roles: readonly RoleKey[];
  readonly authTimeSeconds: number;
  readonly expiresAtSeconds: number;
}

export type SessionValidation =
  | { readonly ok: true; readonly session: VerifiedHumanSession }
  | { readonly ok: false; readonly rejections: readonly SessionRejection[] };

// ---------------------------------------------------------------------------
// Helpers — fail-closed primitives.
// ---------------------------------------------------------------------------

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Constant-time equality for the issuer/audience comparison (defence against timing oracles). */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function issuerTrusted(iss: string, trusted: readonly string[]): boolean {
  // Any-match under constant-time compare; no substring / suffix trust.
  return trusted.some((t) => isNonEmptyString(t) && constantTimeEquals(iss, t));
}

function audienceList(aud: unknown): string[] {
  if (isNonEmptyString(aud)) return [aud];
  if (Array.isArray(aud)) return aud.filter(isNonEmptyString);
  return [];
}

function narrowRoles(raw: unknown, assignable: readonly RoleKey[]): RoleKey[] {
  const allowed = new Set<string>(assignable);
  if (!Array.isArray(raw)) return [];
  const out: RoleKey[] = [];
  for (const r of raw) {
    if (typeof r === 'string' && allowed.has(r)) out.push(r as RoleKey);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Core: validate a human session's ID-token claims against policy at time `nowSeconds`.
// ---------------------------------------------------------------------------

/**
 * Validate the issuer, audience, subject, expiry, and assurance of a human session.
 * Returns a `VerifiedHumanSession` ONLY when every check passes; otherwise returns the full
 * list of rejections. Fails closed on missing/malformed input and on an unverified signature.
 *
 * @param claims       Decoded ID-token claims (the signature MUST already be verified upstream
 *                     and reflected via `__signatureVerified === true`).
 * @param policy       The relying party's trust policy.
 * @param nowSeconds   Current time in epoch seconds (injected — no hidden clock).
 * @param minAssurance Optional additional floor (e.g. a duty's requirement) applied on top of
 *                     the always-enforced non-`unknown` baseline.
 */
export function validateHumanSession(
  claims: OidcIdTokenClaims,
  policy: HumanSessionPolicy,
  nowSeconds: number,
  minAssurance: AssuranceLevel = 'aal1',
): SessionValidation {
  const rejections: SessionRejection[] = [];
  const skew = Math.max(0, Math.trunc(policy.clockSkewSeconds));

  if (!isFiniteNumber(nowSeconds)) {
    return {
      ok: false,
      rejections: [{ code: 'MALFORMED_CLAIM', message: 'nowSeconds must be a finite number' }],
    };
  }

  // 0. Signature must have been cryptographically verified upstream. Fail closed otherwise:
  //    an unsigned/unverified token can assert any subject/role and would defeat SoD entirely.
  if (claims.__signatureVerified !== true) {
    rejections.push({
      code: 'SIGNATURE_UNVERIFIED',
      message: 'ID token signature was not cryptographically verified',
    });
  }

  // 1. Issuer — must exactly match a trusted issuer.
  if (!isNonEmptyString(claims.iss)) {
    rejections.push({ code: 'MALFORMED_CLAIM', message: 'iss claim missing or empty' });
  } else if (!issuerTrusted(claims.iss, policy.trustedIssuers)) {
    rejections.push({
      code: 'UNTRUSTED_ISSUER',
      message: `issuer '${claims.iss}' is not in the trusted-issuer set`,
    });
  }

  // 2. Audience — the token must be minted for THIS relying party.
  const auds = audienceList(claims.aud);
  const rpAudiences = new Set(policy.audience.filter(isNonEmptyString));
  const matchedAud = auds.find((a) => rpAudiences.has(a));
  if (auds.length === 0) {
    rejections.push({ code: 'MALFORMED_CLAIM', message: 'aud claim missing or empty' });
  } else if (matchedAud === undefined) {
    rejections.push({
      code: 'AUDIENCE_MISMATCH',
      message: 'aud does not contain this relying party',
    });
  }
  // When the token has multiple audiences, azp MUST identify this RP (OIDC core §3.1.3.7).
  if (auds.length > 1) {
    if (!isNonEmptyString(claims.azp) || !rpAudiences.has(claims.azp)) {
      rejections.push({
        code: 'AZP_MISMATCH',
        message: 'multi-audience token without an azp identifying this relying party',
      });
    }
  }

  // 3. Subject — present, stable, non-empty. Becomes the SoD principalId.
  if (!isNonEmptyString(claims.sub)) {
    rejections.push({ code: 'SUBJECT_MISSING', message: 'sub claim missing or empty' });
  }

  // 4. Expiry / validity window.
  if (!isFiniteNumber(claims.exp)) {
    rejections.push({ code: 'MALFORMED_CLAIM', message: 'exp claim missing or non-numeric' });
  } else if (nowSeconds > claims.exp + skew) {
    rejections.push({
      code: 'EXPIRED',
      message: `token expired at ${claims.exp} (now ${nowSeconds})`,
    });
  }
  if (isFiniteNumber(claims.nbf) && nowSeconds + skew < claims.nbf) {
    rejections.push({
      code: 'NOT_YET_VALID',
      message: `token not valid before ${claims.nbf} (now ${nowSeconds})`,
    });
  }
  if (isFiniteNumber(claims.iat) && claims.iat - skew > nowSeconds) {
    rejections.push({
      code: 'ISSUED_IN_FUTURE',
      message: `token iat ${claims.iat} is in the future (now ${nowSeconds})`,
    });
  }

  // 4b. Session age — auth_time honoured; a stale session cannot act on governed state.
  const maxAge = Math.max(0, Math.trunc(policy.maxSessionAgeSeconds));
  let authTime = -1;
  if (isFiniteNumber(claims.auth_time)) {
    authTime = claims.auth_time;
  } else if (isFiniteNumber(claims.iat)) {
    authTime = claims.iat; // fall back to issuance time
  }
  if (authTime < 0) {
    rejections.push({
      code: 'MALFORMED_CLAIM',
      message: 'neither auth_time nor iat present to establish session age',
    });
  } else if (nowSeconds - authTime > maxAge + skew) {
    rejections.push({
      code: 'SESSION_STALE',
      message: `session age ${nowSeconds - authTime}s exceeds max ${maxAge}s`,
    });
  }

  // 5. Nonce (replay binding), when required.
  if (policy.requireNonce && !isNonEmptyString(claims.nonce)) {
    rejections.push({ code: 'NONCE_MISSING', message: 'required nonce claim absent' });
  }

  // 6. Assurance — derived from acr/amr, must meet BOTH the non-unknown baseline and the
  //    caller-provided floor.
  const assurance = assuranceFromClaims(claims.acr, claims.amr);
  const floor: AssuranceLevel =
    ASSURANCE_ORDER[minAssurance] >= ASSURANCE_ORDER.aal1 ? minAssurance : 'aal1';
  if (assurance === 'unknown' || !assuranceMeets(assurance, floor)) {
    rejections.push({
      code: 'ASSURANCE_INSUFFICIENT',
      message: `assurance '${assurance}' below required '${floor}'`,
    });
  }

  if (rejections.length > 0) {
    return { ok: false, rejections };
  }

  // All checks passed — construct the verified session.
  const iss = claims.iss as string;
  const sub = claims.sub as string;
  const exp = claims.exp as number;
  const tenantId = isNonEmptyString(claims.tid) ? claims.tid : null;
  const roles = narrowRoles(claims.roles, policy.assignableRoles);

  return {
    ok: true,
    session: {
      principalId: sub,
      issuer: iss,
      audience: matchedAud as string,
      tenantId,
      assurance,
      roles,
      authTimeSeconds: authTime,
      expiresAtSeconds: exp,
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge to Separation-of-Duties. The ONLY sanctioned path from session -> DutyAssignment.
// ---------------------------------------------------------------------------

/**
 * Produce a `DutyAssignment` for a duty from a verified session. This is the sole sanctioned
 * bridge from authentication to SoD evaluation, guaranteeing SoD is always evaluated over an
 * authenticated subject. It re-checks that the session's assurance meets the duty's required
 * assurance, so a duty can never be filled by an under-assured session.
 */
export function sessionToDutyAssignment(
  session: VerifiedHumanSession,
  duty: Duty,
  relationships: readonly Relationship[] = [],
): DutyAssignment {
  const need = requiredAssuranceForDuty(duty);
  if (!assuranceMeets(session.assurance, need)) {
    throw new Error(
      `session for principal '${session.principalId}' has assurance '${session.assurance}' ` +
        `below '${need}' required for duty '${duty}'`,
    );
  }
  return {
    principalId: session.principalId,
    duty,
    roles: session.roles,
    relationships,
    tenantId: session.tenantId,
  };
}

/** True iff the session carries at least one genuine decision role (not platform-admin-only). */
export function hasDecisionRole(session: VerifiedHumanSession): boolean {
  return session.roles.some((r) => !NON_DECISION_ROLES.has(r));
}

export type DecisionAuthorityRejectionCode = 'ASSURANCE_INSUFFICIENT' | 'NO_DECISION_ROLE'; // platform administration / non-decision roles alone

export interface DecisionAuthorityResult {
  readonly permitted: boolean;
  readonly rejections: readonly { code: DecisionAuthorityRejectionCode; message: string }[];
}

/**
 * A verified session may fill a DECISION duty (review/approval/assurance) only when it BOTH
 * meets step-up assurance AND carries a genuine decision role. A session backed solely by
 * `platform_admin` (or any other non-decision role) is refused — the authentication-layer
 * mirror of the SoD `PLATFORM_ADMIN_NO_AUTHORITY` guard: platform administration alone MUST
 * NOT grant decision authority. Non-decision duties bypass the decision-role requirement.
 */
export function assertDecisionAuthority(
  session: VerifiedHumanSession,
  duty: Duty,
): DecisionAuthorityResult {
  const rejections: { code: DecisionAuthorityRejectionCode; message: string }[] = [];
  if (!DECISION_DUTIES.has(duty)) {
    // Still enforce the (lower) baseline for the duty.
    if (!assuranceMeets(session.assurance, requiredAssuranceForDuty(duty))) {
      rejections.push({
        code: 'ASSURANCE_INSUFFICIENT',
        message: `assurance '${session.assurance}' below baseline for duty '${duty}'`,
      });
    }
    return { permitted: rejections.length === 0, rejections };
  }
  if (!assuranceMeets(session.assurance, 'aal2')) {
    rejections.push({
      code: 'ASSURANCE_INSUFFICIENT',
      message: `decision duty '${duty}' requires step-up (aal2); session is '${session.assurance}'`,
    });
  }
  if (!hasDecisionRole(session)) {
    rejections.push({
      code: 'NO_DECISION_ROLE',
      message:
        `session for '${session.principalId}' fills decision duty '${duty}' backed only by ` +
        `non-decision role(s) [${session.roles.join(', ') || 'none'}]; ` +
        'platform administration alone grants no decision authority',
    });
  }
  return { permitted: rejections.length === 0, rejections };
}

// ---------------------------------------------------------------------------
// Cross-tenant independent central reviewer session gate.
// ---------------------------------------------------------------------------

const INCOMPATIBLE_REVIEWER_ROLES: ReadonlySet<RoleKey> = new Set<RoleKey>([
  'authorized_approver',
  'operator',
  'control_owner',
  'automation_principal',
]);

export type ReviewerSessionRejectionCode =
  | 'ASSURANCE_INSUFFICIENT'
  | 'NOT_A_CENTRAL_REVIEWER'
  | 'REVIEWER_NOT_DISTINCT'
  | 'REVIEWER_INCOMPATIBLE_ROLE';

export interface ReviewerSessionResult {
  readonly permitted: boolean;
  readonly rejections: readonly { code: ReviewerSessionRejectionCode; message: string }[];
}

/**
 * Gate the independent central reviewer's SESSION for a cross-tenant action. The reviewer's
 * verified session MUST:
 *   (a) present HIGH assurance (aal3),
 *   (b) actually carry the central_governance_reviewer role,
 *   (c) have a verified subject DISTINCT from every action principal, and
 *   (d) hold NO incompatible action role (approver/operator/owner/automation).
 * Fails closed. This is the authentication-layer complement to
 * `evaluateCentralReviewerDistinctness` in ./separation-of-duties.ts.
 */
export function assertCrossTenantReviewerSession(
  reviewer: VerifiedHumanSession,
  actionPrincipalIds: readonly string[],
): ReviewerSessionResult {
  const rejections: { code: ReviewerSessionRejectionCode; message: string }[] = [];

  if (!assuranceMeets(reviewer.assurance, CROSS_TENANT_REVIEWER_ASSURANCE)) {
    rejections.push({
      code: 'ASSURANCE_INSUFFICIENT',
      message: `cross-tenant reviewer requires '${CROSS_TENANT_REVIEWER_ASSURANCE}'; session is '${reviewer.assurance}'`,
    });
  }

  if (!reviewer.roles.includes('central_governance_reviewer')) {
    rejections.push({
      code: 'NOT_A_CENTRAL_REVIEWER',
      message: `session for '${reviewer.principalId}' is not assigned central_governance_reviewer`,
    });
  }

  const actionSet = new Set(actionPrincipalIds.filter(isNonEmptyString));
  if (actionSet.has(reviewer.principalId)) {
    rejections.push({
      code: 'REVIEWER_NOT_DISTINCT',
      message: `reviewer '${reviewer.principalId}' also holds an action role for the cross-tenant action`,
    });
  }

  for (const role of reviewer.roles) {
    if (INCOMPATIBLE_REVIEWER_ROLES.has(role)) {
      rejections.push({
        code: 'REVIEWER_INCOMPATIBLE_ROLE',
        message: `reviewer '${reviewer.principalId}' holds incompatible action role '${role}'`,
      });
    }
  }

  return { permitted: rejections.length === 0, rejections };
}
