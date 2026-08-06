// @trustcircle/evidence — ORIGINAL PRESERVATION: capture raw source content, revision, available
// metadata, digest, custody, classification, and retention BEFORE any transformation
// (Phase 5 / User Story 3 / FR-017 / GAR-006).
//
// Oracle (FR-017 — preservation precedes classification): the moment a governance work item is
// suspected of being damaged, the SYSTEM MUST preserve the raw original — its exact bytes, the
// source revision it was read at, and whatever metadata was available — into the immutable,
// content-addressed evidence store BEFORE parsing, normalising, quarantining, repairing, redacting,
// or rolling back. Nothing downstream (classification, quarantine, remediation) may run until this
// commit succeeds, so the un-transformed truth is always recoverable and tamper-evident.
//
// This module is the narrow, purpose-built seam for that first commit. It wraps
// `EvidenceService.commitOriginal` (which enforces original-first ordering, digest verification,
// tenant namespacing, and classification/quarantine gating) and records the additional
// PRESERVATION-SPECIFIC facts the integrity workflow needs to cite later:
//
//   * the SOURCE REVISION the content was captured at (so drift is detectable at repair time);
//   * a CUSTODY record (who captured it, under what authorization grant, when);
//   * the classification + retention binding applied to the original;
//   * the content DIGEST (the durable, independently-verifiable witness);
//   * whether the original was captured directly into QUARANTINE (inspectable, non-executable).
//
// The returned `PreservedOriginal` is the durable receipt every downstream step binds to
// (`case.originalEvidenceId`, `quarantine.originalEvidenceId`, `attempt.preservedOriginalEvidenceId`).
// A capture that fails digest verification, lacks authorization, or names an unknown classification
// is REFUSED (an `EvidencePreservationError`), never a partial/ silent write. Dependency-free beyond
// the sibling evidence modules and `node:crypto`.

import { createHash } from 'node:crypto';

import type { Authorization, EpochMillis } from './retention.ts';
import type { ContentDigest, ObjectRetention } from './object-store.ts';
import {
  EvidenceService,
  EvidenceCommitError,
  handleKey,
  type EvidenceHandle,
  type ExecutionState,
} from './evidence-service.ts';

// ---------------------------------------------------------------------------
// Errors — every refusal is first-class (mirrors EvidenceCommitError shape).
// ---------------------------------------------------------------------------

export type PreservationRejectionReason =
  | 'missing-source-revision'
  | 'empty-content'
  | 'digest-mismatch'
  | 'missing-authorization'
  | 'unknown-classification'
  | 'commit-failed';

export class EvidencePreservationError extends Error {
  readonly reason: PreservationRejectionReason;
  constructor(reason: PreservationRejectionReason, detail?: string) {
    super(`original preservation rejected [${reason}]${detail ? `: ${detail}` : ''}`);
    this.name = 'EvidencePreservationError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Inputs / receipts.
// ---------------------------------------------------------------------------

/** The custody facts recorded alongside the preserved original (who / grant / when). */
export interface CustodyRecord {
  readonly capturedByPrincipalId: string;
  readonly authorizationGrantId: string;
  readonly capturedAt: EpochMillis;
}

export interface PreserveOriginalInput {
  readonly tenantId: string;
  /** The exact raw bytes as read from the source — captured BEFORE any transformation. */
  readonly content: Uint8Array;
  /** The source revision / version the content was read at (drift detection at repair time). */
  readonly sourceRevision: string;
  /** The work item / source record the original belongs to (for the custody record). */
  readonly workItemId: string;
  readonly sourceRecordId: string;
  /** Whatever metadata the source made available at capture time (retained verbatim). */
  readonly availableMetadata?: Record<string, unknown>;
  readonly classification: string;
  readonly authorization: Authorization;
  readonly now: EpochMillis;
  /** Optional caller-declared digest; MUST match the recomputed content address if present. */
  readonly expectedDigest?: ContentDigest;
  /** WORM retention binding for the original. */
  readonly retention?: ObjectRetention;
  /** Capture directly into quarantine (inspectable, non-executable) when the defect is unsafe. */
  readonly execution?: ExecutionState;
}

/** The durable receipt of a preserved original — the witness every downstream step binds to. */
export interface PreservedOriginal {
  readonly handle: EvidenceHandle;
  readonly originalEvidenceId: string;
  readonly tenantId: string;
  readonly sourceRevision: string;
  readonly workItemId: string;
  readonly sourceRecordId: string;
  readonly classification: string;
  readonly execution: ExecutionState;
  readonly contentDigest: ContentDigest;
  readonly metadataDigest: string;
  readonly custody: CustodyRecord;
  /** True iff identical bytes were already preserved for this tenant (idempotent capture). */
  readonly deduplicated: boolean;
  readonly preservedAt: EpochMillis;
}

// ---------------------------------------------------------------------------
// Canonical hashing of the preserved metadata (independent witness).
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// The preservation seam.
// ---------------------------------------------------------------------------

/**
 * Preserve a raw source original into the immutable evidence store BEFORE any transformation, and
 * return the durable `PreservedOriginal` receipt. This is the FIRST governed effect of the integrity
 * workflow: every later step (classification, quarantine, remediation, repair, rollback) binds to
 * the `originalEvidenceId` / `contentDigest` it returns. A missing revision, empty content, digest
 * mismatch, missing authorization, or unknown classification is REFUSED — nothing is partially
 * written.
 */
export function preserveOriginal(
  service: EvidenceService,
  input: PreserveOriginalInput,
): PreservedOriginal {
  if (typeof input.sourceRevision !== 'string' || input.sourceRevision.trim().length === 0) {
    throw new EvidencePreservationError('missing-source-revision');
  }
  if (!(input.content instanceof Uint8Array) || input.content.byteLength === 0) {
    throw new EvidencePreservationError('empty-content');
  }

  let commit;
  try {
    commit = service.commitOriginal({
      tenantId: input.tenantId,
      content: input.content,
      classification: input.classification,
      authorization: input.authorization,
      now: input.now,
      ...(input.expectedDigest !== undefined ? { expectedDigest: input.expectedDigest } : {}),
      ...(input.retention !== undefined ? { retention: input.retention } : {}),
      ...(input.execution !== undefined ? { execution: input.execution } : {}),
    });
  } catch (err) {
    if (err instanceof EvidenceCommitError) {
      // Map the store's refusal reasons onto preservation reasons so callers get one error family.
      switch (err.reason) {
        case 'digest-mismatch':
          throw new EvidencePreservationError('digest-mismatch', err.message);
        case 'missing-authorization':
          throw new EvidencePreservationError('missing-authorization', err.message);
        case 'unknown-classification':
          throw new EvidencePreservationError('unknown-classification', err.message);
        default:
          throw new EvidencePreservationError('commit-failed', err.message);
      }
    }
    throw err;
  }

  const custody: CustodyRecord = {
    capturedByPrincipalId: input.authorization.principalId,
    authorizationGrantId: input.authorization.grantId,
    capturedAt: input.now,
  };
  const execution: ExecutionState = service.executionState(commit.handle);
  const metadataDigest = canonicalHash({
    tenantId: input.tenantId,
    workItemId: input.workItemId,
    sourceRecordId: input.sourceRecordId,
    sourceRevision: input.sourceRevision,
    classification: input.classification,
    availableMetadata: input.availableMetadata ?? {},
    custody,
    contentDigest: commit.handle.digest,
  });

  return Object.freeze({
    handle: commit.handle,
    // The evidence id is the tenant-namespaced handle key — stable + independently re-derivable.
    originalEvidenceId: handleKey(commit.handle),
    tenantId: input.tenantId,
    sourceRevision: input.sourceRevision,
    workItemId: input.workItemId,
    sourceRecordId: input.sourceRecordId,
    classification: input.classification,
    execution,
    contentDigest: commit.handle.digest,
    metadataDigest,
    custody,
    deduplicated: commit.deduplicated,
    preservedAt: input.now,
  });
}

/**
 * A pure guard the integrity classifier / detector can call to REFUSE to proceed unless an original
 * has been preserved (FR-017 precedence). Returns true iff `preserved` is a receipt whose content
 * digest re-verifies against `content` — i.e. the preserved bytes are provably the ones about to be
 * classified. This makes "preservation precedes classification" checkable at the call site.
 */
export function originalIsPreserved(
  service: EvidenceService,
  preserved: PreservedOriginal | undefined | null,
  content: Uint8Array,
): boolean {
  if (!preserved) return false;
  if (!service.exists(preserved.handle)) return false;
  return service.verifyDigest(preserved.handle, content);
}
