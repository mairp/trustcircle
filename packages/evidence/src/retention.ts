// @trustcircle/evidence — retention resolution, legal-hold enforcement, and signed
// disposition records (T037 / GAR-006 / VO-b9b935bf93be10bdecdd).
//
// Oracle (VO-b9b935bf93be10bdecdd): Originals MUST remain immutable or tamper-evident;
// derived repairs, exports, redactions, and dispositions MUST retain provenance,
// integrity, authorization, retention, and access history.
//
// This module is dependency-free (Node built-in `crypto` only) so it is independently
// observable and testable under `npm ci` without any adjacent infrastructure. It implements
// three invariants from specs/001-governance-control-plane/data-model.md §"RetentionPolicy,
// LegalHold, and DispositionRecord":
//
//   1. Longest-applicable retention resolution — the resolved retain-until is the MAXIMUM of
//      every applicable policy's expiry; a disposition may not occur before it.
//   2. Legal-hold enforcement — disposition is forbidden while ANY applicable hold is active.
//   3. Signed disposition records — every disposition binds evidence IDs, resolved
//      policies/holds, authorization, executor, verification, and a cryptographic signature
//      over the canonical record, so it is tamper-evident and carries full provenance.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Domain types (mirrors data-model.md EvidenceItem / RetentionPolicy / LegalHold /
// DispositionRecord). Kept structural so downstream packages can widen without breaking.
// ---------------------------------------------------------------------------

export type EvidenceKind = 'original' | 'derived' | 'export' | 'redaction' | 'repair';

/** Milliseconds since the Unix epoch (deterministic, injectable — never reads the wall clock). */
export type EpochMillis = number;

export interface EvidenceItem {
  readonly evidenceItemId: string;
  readonly tenantId: string;
  readonly kind: EvidenceKind;
  /** SHA-256 over the content bytes; the immutability / tamper-evidence anchor. */
  readonly contentSha256: string;
  /** Provenance edge to the parent this item derived from (null only for originals). */
  readonly parentEvidenceId: string | null;
  readonly classification: string;
  readonly createdAt: EpochMillis;
}

export interface RetentionPolicy {
  readonly policyId: string;
  readonly tenantId: string;
  /** Evidence classifications this policy applies to; empty = applies to all. */
  readonly appliesToClassifications: readonly string[];
  readonly durationMillis: number;
  readonly approved: boolean;
}

export type LegalHoldStatus = 'active' | 'released';

export interface LegalHold {
  readonly holdId: string;
  readonly tenantId: string;
  /** Evidence IDs the hold covers; empty = covers the whole tenant. */
  readonly scopeEvidenceIds: readonly string[];
  readonly status: LegalHoldStatus;
}

export interface Authorization {
  readonly principalId: string;
  readonly grantId: string;
}

export interface AccessRecord {
  readonly principalId: string;
  readonly action: string;
  readonly at: EpochMillis;
}

// ---------------------------------------------------------------------------
// Immutability / tamper-evidence for originals.
// ---------------------------------------------------------------------------

/**
 * Verify that an evidence item's content has not been altered since capture. Recomputes the
 * SHA-256 over the supplied bytes and compares (constant-time) against the recorded digest.
 * Originals are never rewritten — any mismatch is a tamper signal.
 */
export function verifyContentIntegrity(item: EvidenceItem, content: Uint8Array): boolean {
  const actual = createHash('sha256').update(content).digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(item.contentSha256, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** An original must have no parent edge; a derived item MUST retain its provenance edge. */
export function hasValidProvenance(item: EvidenceItem): boolean {
  return item.kind === 'original' ? item.parentEvidenceId === null : item.parentEvidenceId !== null;
}

// ---------------------------------------------------------------------------
// Longest-applicable retention resolution.
// ---------------------------------------------------------------------------

export interface RetentionResolution {
  readonly evidenceItemId: string;
  /** IDs of the approved policies that applied. */
  readonly appliedPolicyIds: readonly string[];
  /** MAX over all applicable policies of (createdAt + duration); null if none applied. */
  readonly retainUntil: EpochMillis | null;
}

function policyApplies(policy: RetentionPolicy, item: EvidenceItem): boolean {
  if (!policy.approved) return false;
  if (policy.tenantId !== item.tenantId) return false;
  if (policy.appliesToClassifications.length === 0) return true;
  return policy.appliesToClassifications.includes(item.classification);
}

/**
 * Resolve the retain-until for an item as the LONGEST applicable approved retention
 * requirement. Only approved, same-tenant, classification-matching policies count.
 */
export function resolveRetention(
  item: EvidenceItem,
  policies: readonly RetentionPolicy[],
): RetentionResolution {
  const applied: string[] = [];
  let retainUntil: EpochMillis | null = null;
  for (const policy of policies) {
    if (!policyApplies(policy, item)) continue;
    applied.push(policy.policyId);
    const expiry = item.createdAt + policy.durationMillis;
    if (retainUntil === null || expiry > retainUntil) retainUntil = expiry;
  }
  return { evidenceItemId: item.evidenceItemId, appliedPolicyIds: applied, retainUntil };
}

// ---------------------------------------------------------------------------
// Legal-hold enforcement.
// ---------------------------------------------------------------------------

function holdCovers(hold: LegalHold, item: EvidenceItem): boolean {
  if (hold.tenantId !== item.tenantId) return false;
  if (hold.scopeEvidenceIds.length === 0) return true;
  return hold.scopeEvidenceIds.includes(item.evidenceItemId);
}

/** The IDs of active legal holds that cover the given item. */
export function activeHoldsFor(item: EvidenceItem, holds: readonly LegalHold[]): readonly string[] {
  return holds.filter((h) => h.status === 'active' && holdCovers(h, item)).map((h) => h.holdId);
}

// ---------------------------------------------------------------------------
// Disposition eligibility (the invariant gate).
// ---------------------------------------------------------------------------

export type DispositionBlockReason = 'active-legal-hold' | 'retention-not-elapsed' | 'unauthorized';

export interface DispositionEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly DispositionBlockReason[];
  readonly resolution: RetentionResolution;
  readonly activeHoldIds: readonly string[];
}

export interface DispositionRequest {
  readonly item: EvidenceItem;
  readonly policies: readonly RetentionPolicy[];
  readonly holds: readonly LegalHold[];
  readonly authorization: Authorization | null;
  /** Injected clock — deterministic; never reads Date.now(). */
  readonly now: EpochMillis;
}

/**
 * Evaluate whether an evidence item may be disposed. Disposition is blocked if ANY applicable
 * hold is active, if the longest approved retention has not elapsed, or if unauthorized.
 */
export function evaluateDisposition(req: DispositionRequest): DispositionEligibility {
  const resolution = resolveRetention(req.item, req.policies);
  const activeHoldIds = activeHoldsFor(req.item, req.holds);
  const reasons: DispositionBlockReason[] = [];

  if (activeHoldIds.length > 0) reasons.push('active-legal-hold');
  if (resolution.retainUntil !== null && req.now < resolution.retainUntil) {
    reasons.push('retention-not-elapsed');
  }
  if (req.authorization === null) reasons.push('unauthorized');

  return { eligible: reasons.length === 0, reasons, resolution, activeHoldIds };
}

// ---------------------------------------------------------------------------
// Signed disposition records.
// ---------------------------------------------------------------------------

export type DispositionMethod = 'delete' | 'anonymize' | 'archive' | 'crypto-shred';

export interface DispositionRecord {
  readonly evidenceItemId: string;
  readonly tenantId: string;
  readonly method: DispositionMethod;
  readonly resolvedPolicyIds: readonly string[];
  readonly clearedHoldIds: readonly string[];
  readonly authorization: Authorization;
  readonly executedBy: string;
  readonly executedAt: EpochMillis;
  /** Access history retained with the disposition for auditability. */
  readonly accessHistory: readonly AccessRecord[];
  /** Content digest of the disposed original — provenance/integrity anchor. */
  readonly contentSha256: string;
  /** HMAC-SHA256 over the canonical record body; makes the record tamper-evident. */
  readonly signature: string;
}

interface DispositionRecordBody {
  readonly evidenceItemId: string;
  readonly tenantId: string;
  readonly method: DispositionMethod;
  readonly resolvedPolicyIds: readonly string[];
  readonly clearedHoldIds: readonly string[];
  readonly authorization: Authorization;
  readonly executedBy: string;
  readonly executedAt: EpochMillis;
  readonly accessHistory: readonly AccessRecord[];
  readonly contentSha256: string;
}

/** Deterministic canonical JSON (sorted keys) so signatures are stable across runs. */
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

function signBody(body: DispositionRecordBody, signingKey: string): string {
  return createHmac('sha256', signingKey).update(canonicalize(body)).digest('hex');
}

export class DispositionNotPermittedError extends Error {
  readonly reasons: readonly DispositionBlockReason[];
  constructor(reasons: readonly DispositionBlockReason[]) {
    super(`disposition not permitted: ${reasons.join(', ')}`);
    this.name = 'DispositionNotPermittedError';
    this.reasons = reasons;
  }
}

export interface RecordDispositionInput extends DispositionRequest {
  readonly method: DispositionMethod;
  readonly executedBy: string;
  readonly accessHistory: readonly AccessRecord[];
  readonly signingKey: string;
}

/**
 * Produce a signed DispositionRecord — but ONLY when eligible. Throws
 * DispositionNotPermittedError while a hold is active, retention has not elapsed, or the
 * request is unauthorized. The returned record retains provenance (contentSha256, policy/hold
 * IDs), authorization, executor, and access history, and is signed for tamper-evidence.
 */
export function recordDisposition(input: RecordDispositionInput): DispositionRecord {
  const eligibility = evaluateDisposition(input);
  if (!eligibility.eligible || input.authorization === null) {
    throw new DispositionNotPermittedError(eligibility.reasons);
  }
  const body: DispositionRecordBody = {
    evidenceItemId: input.item.evidenceItemId,
    tenantId: input.item.tenantId,
    method: input.method,
    resolvedPolicyIds: eligibility.resolution.appliedPolicyIds,
    clearedHoldIds: eligibility.activeHoldIds, // empty by construction (eligible => no active holds)
    authorization: input.authorization,
    executedBy: input.executedBy,
    executedAt: input.now,
    accessHistory: input.accessHistory,
    contentSha256: input.item.contentSha256,
  };
  return { ...body, signature: signBody(body, input.signingKey) };
}

/** Recompute and constant-time-compare the record signature to detect tampering. */
export function verifyDispositionRecord(record: DispositionRecord, signingKey: string): boolean {
  const { signature, ...body } = record;
  const expected = signBody(body as DispositionRecordBody, signingKey);
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
