// @trustcircle/policy — replaceable Policy Decision Point (PDP) port, signed OPA bundle
// adapter with revision pinning, and signed decision evidence
// (Phase 44 / work item D10569SD6BGCGB9QP40ZNBQP4Z / VO-173f7afb7801f4ab3e29).
//
// Acceptance criterion (VO-173f7afb7801f4ab3e29):
//   Request, review, approval, execution, evidence administration, control ownership, and
//   assurance MUST be separated where conflicts exist; platform administration alone MUST NOT
//   grant decision authority, and the independent central reviewer for a cross-tenant action
//   MUST NOT hold an incompatible action role.
//
// Design (specs/001-governance-control-plane/plan.md §Policy, research.md §OPA):
//   - The PDP is a REPLACEABLE PORT: {@link PolicyDecisionPoint}. Any adapter (OPA, a future
//     in-process engine, a remote authorization service) that implements the port is a drop-in
//     substitute. No caller depends on OPA concretely — they depend on the port.
//   - The default adapter is a SIGNED OPA BUNDLE adapter: it will only evaluate against a
//     bundle whose detached signature verifies AND whose revision matches the caller's PINNED
//     revision. An unsigned bundle, a tampered bundle, or a revision drift is a hard
//     fail-closed error — never a silent permit. This mirrors OPA's `.signatures.json`
//     bundle-signing + `--bundle-verification` and the `.manifest` `revision` pin.
//   - Every decision produces DECISION EVIDENCE: a signed, verifiable record binding the input,
//     the exact policy bundle revision + content digest, the decision, the reasons, the actor,
//     and the time. The evidence signature is tamper-evident and independently verifiable, so a
//     decision "reported as complete" carries a durable, reconstructable proof.
//   - The SEPARATION-OF-DUTIES policy is NOT re-implemented here. The single source of truth is
//     `@trustcircle/authz` (packages/authz/src/separation-of-duties.ts). The bundled SoD policy
//     delegates to that module, so the platform-admin-no-authority rule and the cross-tenant
//     central-reviewer distinctness rule are enforced by exactly one implementation.
//
// This module is dependency-free at runtime except Node built-in `crypto` and the canonical
// `@trustcircle/authz` SoD surface, so it is independently observable under `npm ci` with no
// live OPA sidecar. Every guard fails CLOSED.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  evaluateSeparationOfDuties,
  evaluateCentralReviewerDistinctness,
  type DutyAssignment,
  type SoDConstraint,
  type CrossTenantAction,
  type CentralReviewer,
  type SoDEvaluation,
  type Violation,
} from '@trustcircle/authz';

// Re-export the canonical SoD input types so PDP callers construct decision inputs without
// reaching around the port into another package's internals.
export type {
  DutyAssignment,
  SoDConstraint,
  CrossTenantAction,
  CentralReviewer,
  SoDEvaluation,
  Violation,
};

// ---------------------------------------------------------------------------
// Shared primitives.
// ---------------------------------------------------------------------------

/** Milliseconds since the Unix epoch. */
export type EpochMillis = number;

/** Lowercase hex SHA-256 digest — content address of a policy bundle. */
export type ContentDigest = string;

/** Deterministic canonical JSON (sorted keys, undefined dropped) so signatures are stable. */
function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 content digest of a canonicalized value (hex). */
function digestOf(value: unknown): ContentDigest {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** HMAC-SHA256 hex signature of a canonicalized value under `key`. */
function hmac(value: unknown, key: string): string {
  return createHmac('sha256', key).update(canonicalize(value)).digest('hex');
}

/** Constant-time hex-string comparison (length-safe). */
function hexEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Policy queries + decisions (the PDP vocabulary).
// ---------------------------------------------------------------------------

/**
 * The kinds of decision the PDP can render. Each maps to a bundled policy. `separation_of_duties`
 * and `central_reviewer_distinctness` are the two policies that enforce VO-173f7afb7801f4ab3e29.
 */
export type PolicyName = 'separation_of_duties' | 'central_reviewer_distinctness';

/** A decision query: which policy, plus the typed input the policy expects. */
export type PolicyQuery =
  | {
      readonly policy: 'separation_of_duties';
      readonly input: {
        readonly assignments: readonly DutyAssignment[];
        readonly constraint: SoDConstraint;
      };
    }
  | {
      readonly policy: 'central_reviewer_distinctness';
      readonly input: {
        readonly action: CrossTenantAction;
        readonly reviewer: CentralReviewer;
      };
    };

/** The outcome of one policy evaluation. `deny` carries the machine-readable reasons. */
export interface Decision {
  readonly policy: PolicyName;
  /** true == permitted, false == denied (fail-closed default is deny). */
  readonly permit: boolean;
  /** Machine-readable reasons a deny was rendered (empty on permit). */
  readonly reasons: readonly Violation[];
}

// ---------------------------------------------------------------------------
// The REPLACEABLE PDP PORT.
// ---------------------------------------------------------------------------

/**
 * The Policy Decision Point port. Any authorization engine implements this. Callers depend on
 * the port, never on a concrete engine, so the PDP is a drop-in-replaceable seam.
 *
 * `revision` on {@link DecisionRequest} is the caller's PINNED bundle revision: the adapter MUST
 * refuse to decide against any other revision. `decide` NEVER throws for a policy denial — a
 * denial is a `permit: false` decision. It throws only for infrastructure failures the caller
 * cannot recover from (unsigned/tampered bundle, revision drift, unknown policy) — all of which
 * are fail-closed and must block execution.
 */
export interface PolicyDecisionPoint {
  /** Identity + revision + digest of the policy bundle this PDP is currently serving. */
  readonly descriptor: PdpDescriptor;
  /**
   * Render a decision and its signed evidence. Throws {@link PdpUnavailableError} when the pinned
   * revision does not match the loaded bundle, the bundle is unsigned/tampered, or the policy is
   * unknown — decisions must fail closed, never permit by default.
   */
  decide(request: DecisionRequest): DecisionResult;
}

/** Stable identity of the policy bundle a PDP serves. */
export interface PdpDescriptor {
  /** Adapter kind, e.g. 'opa-signed-bundle'. */
  readonly adapter: string;
  /** The bundle revision the adapter is currently serving (the `.manifest` revision). */
  readonly revision: string;
  /** Content digest of the signed bundle body (independent of the signature). */
  readonly bundleDigest: ContentDigest;
}

/** A decision request: the query, the actor accountable for it, the pinned revision, and time. */
export interface DecisionRequest {
  readonly query: PolicyQuery;
  /** Principal on whose behalf the decision is rendered (captured in evidence). */
  readonly actorPrincipalId: string;
  /** Correlation id tying this decision to the governed operation. */
  readonly correlationId: string;
  /**
   * The bundle revision the CALLER pinned. The adapter refuses to evaluate against any other
   * revision — this defeats a silent policy swap between simulate and execute.
   */
  readonly pinnedRevision: string;
  readonly now: EpochMillis;
}

/** The decision plus the signed, verifiable evidence that proves how it was rendered. */
export interface DecisionResult {
  readonly decision: Decision;
  readonly evidence: DecisionEvidence;
}

// ---------------------------------------------------------------------------
// DECISION EVIDENCE — signed, revision-pinned, tamper-evident.
// ---------------------------------------------------------------------------

/** The signed body of a decision-evidence record (everything except the signature). */
export interface DecisionEvidenceBody {
  readonly policy: PolicyName;
  readonly permit: boolean;
  readonly reasons: readonly Violation[];
  /** The bundle revision the decision was rendered against (pinned == served). */
  readonly bundleRevision: string;
  /** Content digest of the bundle body — binds the evidence to the exact policy content. */
  readonly bundleDigest: ContentDigest;
  /** Content digest of the canonicalized query input — binds the evidence to the exact input. */
  readonly inputDigest: ContentDigest;
  readonly actorPrincipalId: string;
  readonly correlationId: string;
  readonly decidedAt: EpochMillis;
}

/** A decision-evidence record: the body plus a tamper-evident HMAC signature. */
export interface DecisionEvidence extends DecisionEvidenceBody {
  readonly signature: string;
}

/** Sign a decision-evidence body under the PDP's evidence-signing key. */
function signEvidence(body: DecisionEvidenceBody, key: string): DecisionEvidence {
  return { ...body, signature: hmac(body, key) };
}

/**
 * Recompute and constant-time-compare the evidence signature to detect tampering. Independently
 * observable proof that a reported decision was actually rendered as recorded.
 */
export function verifyDecisionEvidence(evidence: DecisionEvidence, signingKey: string): boolean {
  const { signature, ...body } = evidence;
  if (typeof signature !== 'string' || signature.length === 0) return false;
  return hexEqual(signature, hmac(body as DecisionEvidenceBody, signingKey));
}

// ---------------------------------------------------------------------------
// Signed OPA bundle model + verification.
// ---------------------------------------------------------------------------

/**
 * A signed policy bundle, modelled on an OPA bundle: a `revision` (from `.manifest`), the policy
 * `roots` it owns, and a detached HMAC `signature` over the canonical bundle body. The concrete
 * decision logic for the two SoD policies lives in `@trustcircle/authz`; the bundle carries the
 * signed metadata that pins WHICH revision of that logic is authoritative.
 */
export interface SignedPolicyBundle {
  readonly revision: string;
  readonly roots: readonly PolicyName[];
  /** Detached HMAC-SHA256 signature over {revision, roots}. */
  readonly signature: string;
}

/** The signable body of a bundle (everything the signature covers). */
interface BundleBody {
  readonly revision: string;
  readonly roots: readonly PolicyName[];
}

/** Produce a correctly signed bundle (used by trusted publishers / tests / fixtures). */
export function signBundle(body: BundleBody, signingKey: string): SignedPolicyBundle {
  return { ...body, signature: hmac(body, signingKey) };
}

/** Reasons a bundle is rejected before any decision is rendered — all fail closed. */
export type BundleRejection =
  | 'unsigned' // no/empty signature
  | 'bad-signature' // signature does not verify against the trusted key
  | 'unknown-root'; // bundle claims a policy root this PDP cannot serve

/** Thrown when the PDP cannot render a trustworthy decision — callers MUST treat as deny. */
export class PdpUnavailableError extends Error {
  readonly reason: BundleRejection | 'revision-mismatch' | 'unknown-policy';
  readonly detail: Record<string, unknown>;
  constructor(
    reason: BundleRejection | 'revision-mismatch' | 'unknown-policy',
    detail: Record<string, unknown> = {},
  ) {
    super(`PDP unavailable: ${reason}`);
    this.name = 'PdpUnavailableError';
    this.reason = reason;
    this.detail = detail;
  }
}

const KNOWN_POLICIES: ReadonlySet<PolicyName> = new Set<PolicyName>([
  'separation_of_duties',
  'central_reviewer_distinctness',
]);

/**
 * Verify a bundle's signature and roots against a trusted key. Returns the digest of the signed
 * body on success; throws {@link PdpUnavailableError} (fail-closed) on any problem.
 */
export function verifyBundle(bundle: SignedPolicyBundle, verificationKey: string): ContentDigest {
  const body: BundleBody = { revision: bundle.revision, roots: bundle.roots };
  if (typeof bundle.signature !== 'string' || bundle.signature.length === 0) {
    throw new PdpUnavailableError('unsigned', { revision: bundle.revision });
  }
  const expected = hmac(body, verificationKey);
  if (!hexEqual(bundle.signature, expected)) {
    throw new PdpUnavailableError('bad-signature', { revision: bundle.revision });
  }
  for (const root of bundle.roots) {
    if (!KNOWN_POLICIES.has(root)) {
      throw new PdpUnavailableError('unknown-root', { root });
    }
  }
  return digestOf(body);
}

// ---------------------------------------------------------------------------
// Bundled SoD policies — thin delegations to the SINGLE source of truth (@trustcircle/authz).
// ---------------------------------------------------------------------------

function evaluateQuery(query: PolicyQuery): Decision {
  switch (query.policy) {
    case 'separation_of_duties': {
      // Delegates to packages/authz/src/separation-of-duties.ts — NOT re-implemented here.
      // Enforces: conflicting duties separated; platform administration alone grants no
      // decision authority (PLATFORM_ADMIN_NO_AUTHORITY); minimum distinct principals.
      const result: SoDEvaluation = evaluateSeparationOfDuties(
        query.input.assignments,
        query.input.constraint,
      );
      return {
        policy: 'separation_of_duties',
        permit: result.permitted,
        reasons: result.violations,
      };
    }
    case 'central_reviewer_distinctness': {
      // Delegates to packages/authz/src/separation-of-duties.ts — enforces that the cross-tenant
      // independent central reviewer is distinct from every action role and holds no incompatible
      // action role (CENTRAL_REVIEWER_NOT_DISTINCT / CENTRAL_REVIEWER_INCOMPATIBLE_ROLE).
      const result: SoDEvaluation = evaluateCentralReviewerDistinctness(
        query.input.action,
        query.input.reviewer,
      );
      return {
        policy: 'central_reviewer_distinctness',
        permit: result.permitted,
        reasons: result.violations,
      };
    }
    default: {
      // Exhaustiveness guard — an unknown policy is fail-closed at the adapter boundary.
      const _never: never = query;
      throw new PdpUnavailableError('unknown-policy', { query: _never });
    }
  }
}

// ---------------------------------------------------------------------------
// The signed OPA bundle adapter (default PDP implementation of the port).
// ---------------------------------------------------------------------------

export interface OpaAdapterConfig {
  /** The signed, revision-pinned policy bundle this adapter serves. */
  readonly bundle: SignedPolicyBundle;
  /** Key the adapter uses to VERIFY the bundle signature (bundle publisher's key). */
  readonly bundleVerificationKey: string;
  /** Key the adapter uses to SIGN decision evidence. */
  readonly evidenceSigningKey: string;
}

/**
 * Signed OPA bundle PDP. Verifies + pins the bundle at construction, then refuses to decide
 * against any revision other than the caller's pinned revision, and signs decision evidence.
 */
export class SignedOpaBundleAdapter implements PolicyDecisionPoint {
  readonly descriptor: PdpDescriptor;
  readonly #evidenceSigningKey: string;

  constructor(config: OpaAdapterConfig) {
    // Verify the bundle up front — an unsigned/tampered/unknown-root bundle can never be loaded.
    const bundleDigest = verifyBundle(config.bundle, config.bundleVerificationKey);
    this.descriptor = {
      adapter: 'opa-signed-bundle',
      revision: config.bundle.revision,
      bundleDigest,
    };
    this.#evidenceSigningKey = config.evidenceSigningKey;
  }

  decide(request: DecisionRequest): DecisionResult {
    // REVISION PINNING: the caller's pinned revision must equal the served bundle revision.
    // A drift means the policy was swapped out from under the caller — fail closed.
    if (request.pinnedRevision !== this.descriptor.revision) {
      throw new PdpUnavailableError('revision-mismatch', {
        pinned: request.pinnedRevision,
        served: this.descriptor.revision,
      });
    }
    if (!KNOWN_POLICIES.has(request.query.policy)) {
      throw new PdpUnavailableError('unknown-policy', { policy: request.query.policy });
    }

    const decision = evaluateQuery(request.query);

    const body: DecisionEvidenceBody = {
      policy: decision.policy,
      permit: decision.permit,
      reasons: decision.reasons,
      bundleRevision: this.descriptor.revision,
      bundleDigest: this.descriptor.bundleDigest,
      inputDigest: digestOf(request.query.input),
      actorPrincipalId: request.actorPrincipalId,
      correlationId: request.correlationId,
      decidedAt: request.now,
    };
    const evidence = signEvidence(body, this.#evidenceSigningKey);
    return { decision, evidence };
  }
}

/**
 * Convenience factory: sign a bundle for `revision`+`roots`, then build a revision-pinned,
 * evidence-signing PDP that serves it. Used by application wiring and by tests/fixtures.
 */
export function createSignedOpaPdp(params: {
  readonly revision: string;
  readonly roots?: readonly PolicyName[];
  readonly bundleSigningKey: string;
  readonly evidenceSigningKey: string;
}): SignedOpaBundleAdapter {
  const roots = params.roots ?? ['separation_of_duties', 'central_reviewer_distinctness'];
  const bundle = signBundle({ revision: params.revision, roots }, params.bundleSigningKey);
  return new SignedOpaBundleAdapter({
    bundle,
    bundleVerificationKey: params.bundleSigningKey,
    evidenceSigningKey: params.evidenceSigningKey,
  });
}
