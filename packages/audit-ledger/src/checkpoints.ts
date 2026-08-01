// packages/audit-ledger/src/checkpoints.ts
//
// Phase 31 / task T031 / GAR-002 / VO-d76c5d1293b91d26e094.
//
// The application-layer counterpart to the `audit_checkpoint` table in
// db/migrations/0005_audit_ledger.sql. Phase 30 (./hash-chain.ts) produces the byte-stable
// per-ledger hash chain and `computeCheckpointRoot` (the rolling root over a contiguous, INTACT
// range). This module turns that root into a SIGNED, IMMUTABLE, PUBLISHED checkpoint and records an
// append-only VERIFICATION HISTORY over it. Three capabilities, mirroring the phase title:
//
//   1. ED25519 CHECKPOINT SIGNING — `signCheckpoint` signs a canonical checkpoint payload with an
//      Ed25519 private key (Node built-in `crypto`, no external deps); `verifyCheckpointSignature`
//      re-verifies it against the public key. The signature covers the range, the root digest, the
//      head integrity digest, the checkpoint-chain link, and the pinned bundle identity — so a
//      forged/altered range, root, link, or identity fails signature verification.
//
//   2. IMMUTABLE CHECKPOINT PUBLICATION — `publishCheckpoint` / `CheckpointLog` append a signed
//      checkpoint to a per-ledger, monotone, CHECKPOINT-CHAINED log (`previousRootDigest` links to
//      the prior checkpoint's `rootDigest`) whose range starts exactly where the previous checkpoint
//      ended (contiguous, gap-free coverage). Published checkpoints are deep-frozen; the log returns
//      a NEW log on append and never mutates a published entry — a range end is checkpointed at most
//      once, so truncation or replacement of a whole checkpoint is detectable.
//
//   3. VERIFICATION HISTORY — `verifyPublishedCheckpoint` is the INDEPENDENT READ PATH: it
//      re-derives the range root from the ledger records read back independently, re-checks the
//      Ed25519 signature, and re-checks the checkpoint-chain link, then produces an append-only
//      `CheckpointVerification` record (`verified` when everything matches, `tampered` otherwise).
//      `appendVerification` keeps the history append-only and ordered; it is never rewritten.
//
// THE ACCOUNTABILITY GATE (the Phase-31 AC / VO-d76c5d1293b91d26e094). Signing/publishing a
// checkpoint and recording a verification are themselves "automated actions" that MUST capture the
// full accountability set — actor/principal, accountable owner, reason, source and target state,
// policy and control versions, evidence, scope, time, correlation, and outcome — BEFORE the action
// can be reported complete. So `publishCheckpoint` and `verifyPublishedCheckpoint` REQUIRE an
// `AccountabilityRecord` (validated by `assertAccountable` from hash-chain.ts) describing the action;
// a checkpoint or verification with an incomplete accountability record can never be produced. The
// accountability record is itself bound into the signed/verified payload (by its content digest), so
// the "who/why/when/outcome" cannot be swapped after the fact without breaking the signature.
//
// Dependency policy: Node built-in `crypto` only (+ type-only import from @trustcircle/domain,
// erased under verbatimModuleSyntax) and the sibling ./hash-chain.ts. No clock, no fs, no network —
// fully deterministic, so it runs under Node 22 `--experimental-strip-types` with no infrastructure.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

import {
  type AccountabilityRecord,
  type ChainedAuditRecord,
  type CheckpointRange,
  type AuditOutcome,
  assertAccountable,
  canonicalJson,
  contentDigest,
  computeCheckpointRoot,
  verifyLedger,
  GENESIS_PREVIOUS_DIGEST,
} from './hash-chain.ts';

// The pinned bundle identity this checkpoint machinery belongs to. Bound into every signed payload
// so a checkpoint signed under a different bundle/semantic-hash is rejected at verification — a
// checkpoint's provenance cannot be silently re-homed. (Mirrors the pinned-identity discipline used
// across the bundle's adapters.)
export const CHECKPOINT_BUNDLE_ID = '36GCYGDJ15PTYP60F91QWRAY2M';
export const CHECKPOINT_BUNDLE_SEMANTIC_HASH =
  'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b';

// The signature algorithm string persisted on the checkpoint (mirrors `signature_algorithm` in
// audit_checkpoint). Ed25519 is a fixed, closed choice — an unknown algorithm is refused.
export const CHECKPOINT_SIGNATURE_ALGORITHM = 'ed25519';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}

// ---------------------------------------------------------------------------
// Errors.

export class CheckpointError extends Error {
  /** Machine reason code. */
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'CheckpointError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 1. ED25519 CHECKPOINT SIGNING.
//
// A signing key pair. The private key signs; the public key (distributable) verifies. `keyId`
// identifies the key so a checkpoint records WHICH key signed it (mirrors `signing_key_id`).

export interface CheckpointSigningKey {
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

export interface CheckpointVerificationKey {
  readonly keyId: string;
  readonly publicKey: KeyObject;
}

/**
 * Generate a fresh Ed25519 signing key pair. `random` is injectable ONLY for the caller to supply a
 * deterministic keyId; the Ed25519 private scalar is always drawn from the platform CSPRNG (there is
 * no safe way to make a signing key deterministic, and we must not pretend otherwise).
 */
export function generateSigningKey(keyId: string): CheckpointSigningKey {
  if (!isNonEmptyString(keyId)) {
    throw new CheckpointError('key_id', 'a non-empty keyId is required');
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return Object.freeze({ keyId, privateKey, publicKey });
}

/**
 * Rebuild a signing key from PEM/DER material (e.g. loaded from a secret reference). Kept so the
 * live signer does not have to hold a generated pair in memory across processes.
 */
export function signingKeyFromPem(keyId: string, privateKeyPem: string): CheckpointSigningKey {
  if (!isNonEmptyString(keyId)) {
    throw new CheckpointError('key_id', 'a non-empty keyId is required');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (e) {
    throw new CheckpointError(
      'key_material',
      `invalid Ed25519 private key: ${(e as Error).message}`,
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new CheckpointError('key_material', 'signing key must be Ed25519');
  }
  const publicKey = createPublicKey(privateKey);
  return Object.freeze({ keyId, privateKey, publicKey });
}

/** Extract the distributable verification handle from a signing key. */
export function verificationKeyFor(key: CheckpointSigningKey): CheckpointVerificationKey {
  return Object.freeze({ keyId: key.keyId, publicKey: key.publicKey });
}

/**
 * The exact, canonical bytes an Ed25519 signature is computed over. This is the "what is signed":
 * the pinned identity, the whole covered range (tenant/ledger/first/last/count), the root digest,
 * the head integrity digest, the checkpoint-chain link, the signing key id, and the CONTENT DIGEST
 * of the accountability record for the publish action. Because the accountability digest is bound
 * in, the actor/owner/reason/scope/time/outcome of the publish cannot be altered without
 * invalidating the signature.
 */
export function checkpointSigningPayload(input: {
  range: CheckpointRange;
  previousRootDigest: string;
  keyId: string;
  accountabilityDigest: string;
}): string {
  const { range, previousRootDigest, keyId, accountabilityDigest } = input;
  return canonicalJson({
    bundleId: CHECKPOINT_BUNDLE_ID,
    bundleSemanticHash: CHECKPOINT_BUNDLE_SEMANTIC_HASH,
    algorithm: CHECKPOINT_SIGNATURE_ALGORITHM,
    tenantId: range.tenantId,
    ledgerId: range.ledgerId,
    firstSequence: range.firstSequence,
    lastSequence: range.lastSequence,
    eventCount: range.eventCount,
    rootDigest: range.rootDigest,
    headIntegrityDigest: range.headIntegrityDigest,
    previousRootDigest,
    keyId,
    accountabilityDigest,
  });
}

/**
 * Sign a checkpoint payload with an Ed25519 private key. Returns the signature as base64. Ed25519 is
 * a pure signature scheme (no pre-hash algorithm argument), so `sign(null, data, key)` is the
 * correct Node call.
 */
export function signPayload(privateKey: KeyObject, payload: string): string {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new CheckpointError('key_material', 'signing key must be Ed25519');
  }
  return edSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
}

/** Verify an Ed25519 signature over a payload. Never throws — returns a boolean. */
export function verifyPayloadSignature(
  publicKey: KeyObject,
  payload: string,
  signatureBase64: string,
): boolean {
  if (publicKey.asymmetricKeyType !== 'ed25519') return false;
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureBase64, 'base64');
  } catch {
    return false;
  }
  try {
    return edVerify(null, Buffer.from(payload, 'utf8'), publicKey, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2. IMMUTABLE CHECKPOINT PUBLICATION.
//
// A published, signed checkpoint — the in-memory projection of one `audit_checkpoint` row.

export type CheckpointStatus = 'signed' | 'verified' | 'anchored' | 'tampered';

export interface CheckpointVerification {
  /** Position in the append-only verification history (1-based, monotone). */
  readonly sequence: number;
  /** Outcome of this verification pass. */
  readonly result: 'verified' | 'tampered';
  /** Machine reason when tampered; null when verified. */
  readonly reason: string | null;
  /** The accountability record content-digest for the VERIFY action (who/why/when). */
  readonly accountabilityDigest: string;
  /** The verifier's outcome disposition, from the accountability record. */
  readonly outcome: AuditOutcome;
  /** When this verification was recorded (epoch ms, from the accountability record). */
  readonly recordedAt: number;
}

export interface PublishedCheckpoint {
  readonly checkpointId: string;
  readonly tenantId: string;
  readonly ledgerId: string;

  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly eventCount: number;

  readonly rootDigest: string;
  readonly headIntegrityDigest: string;
  /** Chains the checkpoints themselves: the prior checkpoint's rootDigest (genesis sentinel for the first). */
  readonly previousRootDigest: string;

  readonly generatedAt: number;

  readonly signingKeyId: string;
  readonly signatureAlgorithm: string;
  /** Base64 Ed25519 signature over {@link checkpointSigningPayload}. */
  readonly signature: string;

  /** Content-digest of the accountability record for the PUBLISH action, bound into the signature. */
  readonly accountabilityDigest: string;

  /** Optional immutable evidence-item reference (checkpoint manifest in immutable storage). */
  readonly evidenceItemId: string | null;
  /** Optional external immutable anchor reference. */
  readonly externalAnchorRef: string | null;

  readonly status: CheckpointStatus;
  /** Append-only verification history — never rewritten in place. */
  readonly verificationHistory: readonly CheckpointVerification[];
}

/**
 * Sign a contiguous, INTACT ledger range into a signed (but not-yet-logged) checkpoint. The range
 * root is computed by `computeCheckpointRoot` (which itself asserts the sub-chain is intact), the
 * publish action's accountability record is validated and bound in by its content digest, and the
 * whole payload is Ed25519-signed. `previousRootDigest` links this checkpoint to the prior one in
 * the checkpoint chain (pass {@link GENESIS_PREVIOUS_DIGEST} for the first).
 *
 * Throws `AccountabilityError` if the publish action is not fully accountable, and `CheckpointError`
 * on an empty/broken range. A signed checkpoint therefore cannot be produced for an incomplete
 * action or an unverifiable range.
 */
export function signCheckpoint(input: {
  checkpointId: string;
  key: CheckpointSigningKey;
  records: readonly ChainedAuditRecord[];
  previousRootDigest: string;
  action: AccountabilityRecord;
  generatedAt: number;
  evidenceItemId?: string | null;
  externalAnchorRef?: string | null;
}): PublishedCheckpoint {
  const {
    checkpointId,
    key,
    records,
    previousRootDigest,
    action,
    generatedAt,
    evidenceItemId = null,
    externalAnchorRef = null,
  } = input;

  if (!isNonEmptyString(checkpointId)) {
    throw new CheckpointError('checkpoint_id', 'a non-empty checkpointId is required');
  }
  if (!isNonEmptyString(previousRootDigest)) {
    throw new CheckpointError(
      'previous_root',
      'previousRootDigest is required (genesis sentinel for the first)',
    );
  }
  if (!isFiniteInt(generatedAt)) {
    throw new CheckpointError('generated_at', 'generatedAt (epoch ms) is required');
  }
  // The publish is an accountable action — must capture the full accountability set BEFORE it can be
  // reported complete (the Phase-31 AC). This throws AccountabilityError naming the missing clause.
  assertAccountable(action);

  // Compute the range root over an INTACT sub-chain (computeCheckpointRoot asserts intactness).
  const range: CheckpointRange = computeCheckpointRoot(action.tenantId, action.ledgerId, records);

  // The checkpoint covers this ledger; bind the range's tenant/ledger to the action's.
  if (range.tenantId !== action.tenantId || range.ledgerId !== action.ledgerId) {
    throw new CheckpointError(
      'ledger_mismatch',
      'checkpoint range tenant/ledger must match the publish action',
    );
  }

  const accountabilityDigest = contentDigest(action);
  const payload = checkpointSigningPayload({
    range,
    previousRootDigest,
    keyId: key.keyId,
    accountabilityDigest,
  });
  const signature = signPayload(key.privateKey, payload);

  return Object.freeze({
    checkpointId,
    tenantId: range.tenantId,
    ledgerId: range.ledgerId,
    firstSequence: range.firstSequence,
    lastSequence: range.lastSequence,
    eventCount: range.eventCount,
    rootDigest: range.rootDigest,
    headIntegrityDigest: range.headIntegrityDigest,
    previousRootDigest,
    generatedAt,
    signingKeyId: key.keyId,
    signatureAlgorithm: CHECKPOINT_SIGNATURE_ALGORITHM,
    signature,
    accountabilityDigest,
    evidenceItemId,
    externalAnchorRef,
    status: 'signed',
    verificationHistory: Object.freeze([]) as readonly CheckpointVerification[],
  });
}

/**
 * Independently verify a signed checkpoint's SIGNATURE against a verification key WITHOUT trusting
 * the ledger — this proves the checkpoint was signed by the named key over the exact range/root it
 * claims. Returns a machine reason on failure (`null` when valid).
 */
export function verifyCheckpointSignature(
  checkpoint: PublishedCheckpoint,
  key: CheckpointVerificationKey,
): string | null {
  if (checkpoint.signatureAlgorithm !== CHECKPOINT_SIGNATURE_ALGORITHM) {
    return 'unsupported_algorithm';
  }
  if (checkpoint.signingKeyId !== key.keyId) {
    return 'key_id_mismatch';
  }
  const payload = checkpointSigningPayload({
    range: {
      tenantId: checkpoint.tenantId,
      ledgerId: checkpoint.ledgerId,
      firstSequence: checkpoint.firstSequence,
      lastSequence: checkpoint.lastSequence,
      eventCount: checkpoint.eventCount,
      rootDigest: checkpoint.rootDigest,
      headIntegrityDigest: checkpoint.headIntegrityDigest,
    },
    previousRootDigest: checkpoint.previousRootDigest,
    keyId: checkpoint.signingKeyId,
    accountabilityDigest: checkpoint.accountabilityDigest,
  });
  return verifyPayloadSignature(key.publicKey, payload, checkpoint.signature)
    ? null
    : 'bad_signature';
}

/**
 * The append-only, per-ledger checkpoint LOG. Deep-frozen and immutable: `publish` returns a NEW
 * log; the receiver is never mutated.
 *
 * COVERAGE MODEL. The Phase-30 substrate (`computeCheckpointRoot`/`verifyLedger`) computes a range
 * root over a ledger sub-chain that begins at sequence 1 — so each checkpoint is a PREFIX checkpoint
 * covering `[1 .. lastSequence]`, and successive checkpoints extend that prefix (a later `lastSequence`
 * covering a strict superset of the prior). Checkpoints are chained (`previousRootDigest` links to the
 * prior checkpoint's `rootDigest`) and strictly monotone in coverage, so a whole checkpoint cannot be
 * dropped, reordered, or replaced without breaking the chain or the monotone-coverage invariant.
 */
export interface CheckpointLog {
  readonly tenantId: string;
  readonly ledgerId: string;
  readonly checkpoints: readonly PublishedCheckpoint[];
  /** rootDigest of the last published checkpoint (genesis sentinel when empty). */
  readonly headRootDigest: string;
  /** lastSequence of the last published checkpoint (0 when empty). */
  readonly coveredThroughSequence: number;
}

export function createCheckpointLog(tenantId: string, ledgerId: string): CheckpointLog {
  if (!isNonEmptyString(tenantId) || !isNonEmptyString(ledgerId)) {
    throw new CheckpointError('log', 'tenantId and ledgerId are required');
  }
  return Object.freeze({
    tenantId,
    ledgerId,
    checkpoints: Object.freeze([]) as readonly PublishedCheckpoint[],
    headRootDigest: GENESIS_PREVIOUS_DIGEST,
    coveredThroughSequence: 0,
  });
}

/**
 * Publish a signed PREFIX checkpoint to the log (IMMUTABLE PUBLICATION). Enforces:
 *   1. the checkpoint belongs to this log's (tenant, ledger);
 *   2. its `previousRootDigest` equals the log's current head root — the checkpoint chain links,
 *      so no prior checkpoint can be silently dropped or replaced;
 *   3. it is a prefix checkpoint (`firstSequence === 1`) that STRICTLY EXTENDS prior coverage
 *      (`lastSequence > coveredThroughSequence`) — so coverage grows monotonically, a range end is
 *      published at most once, and a shorter/equal re-publication (truncation or replay) is refused.
 *
 * Returns a NEW, deep-frozen log with the checkpoint appended; the input log and its entries are
 * untouched (a published checkpoint is never mutated in place — verification appends to a NEW entry).
 */
export function publishCheckpoint(
  log: CheckpointLog,
  checkpoint: PublishedCheckpoint,
): CheckpointLog {
  if (checkpoint.tenantId !== log.tenantId || checkpoint.ledgerId !== log.ledgerId) {
    throw new CheckpointError(
      'ledger_mismatch',
      'checkpoint does not belong to this checkpoint log',
    );
  }
  if (checkpoint.previousRootDigest !== log.headRootDigest) {
    throw new CheckpointError(
      'broken_checkpoint_chain',
      "checkpoint previousRootDigest does not match the log's head root digest",
    );
  }
  if (checkpoint.firstSequence !== 1) {
    throw new CheckpointError(
      'non_prefix_range',
      `a prefix checkpoint must start at sequence 1, got ${checkpoint.firstSequence}`,
    );
  }
  if (checkpoint.lastSequence <= log.coveredThroughSequence) {
    throw new CheckpointError(
      'non_monotone_coverage',
      `checkpoint coverage must extend past sequence ${log.coveredThroughSequence}, got ${checkpoint.lastSequence}`,
    );
  }
  return Object.freeze({
    tenantId: log.tenantId,
    ledgerId: log.ledgerId,
    checkpoints: Object.freeze([...log.checkpoints, checkpoint]) as readonly PublishedCheckpoint[],
    headRootDigest: checkpoint.rootDigest,
    coveredThroughSequence: checkpoint.lastSequence,
  });
}

/**
 * Verify an entire published checkpoint LOG independently: each checkpoint chains to the prior
 * (`previousRootDigest`), each is a prefix (`firstSequence === 1`) whose coverage strictly extends
 * the prior, and (optionally) each signature is re-verified against the supplied key. Detects a
 * dropped/reordered/replaced whole checkpoint.
 */
export function verifyCheckpointLog(
  log: CheckpointLog,
  key?: CheckpointVerificationKey,
): { ok: boolean; reason: string | null; index: number | null } {
  let previousRoot = GENESIS_PREVIOUS_DIGEST;
  let coveredThrough = 0;
  for (let i = 0; i < log.checkpoints.length; i++) {
    const cp = log.checkpoints[i]!;
    if (cp.tenantId !== log.tenantId || cp.ledgerId !== log.ledgerId) {
      return { ok: false, reason: 'ledger_mismatch', index: i };
    }
    if (cp.previousRootDigest !== previousRoot) {
      return { ok: false, reason: 'broken_checkpoint_chain', index: i };
    }
    if (cp.firstSequence !== 1) {
      return { ok: false, reason: 'non_prefix_range', index: i };
    }
    if (cp.lastSequence <= coveredThrough) {
      return { ok: false, reason: 'non_monotone_coverage', index: i };
    }
    if (key) {
      const sigReason = verifyCheckpointSignature(cp, key);
      if (sigReason !== null) {
        return { ok: false, reason: sigReason, index: i };
      }
    }
    previousRoot = cp.rootDigest;
    coveredThrough = cp.lastSequence;
  }
  return { ok: true, reason: null, index: null };
}

// ---------------------------------------------------------------------------
// 3. VERIFICATION HISTORY — the independent read path + append-only history.

/**
 * Independently VERIFY a published checkpoint against the ledger records read back independently
 * (e.g. `SELECT ... WHERE sequence BETWEEN first AND last ORDER BY sequence`). Produces a
 * `CheckpointVerification` record for the append-only history WITHOUT mutating the checkpoint. The
 * verify is itself an accountable action, so a full accountability record is REQUIRED and bound into
 * the produced verification by its content digest.
 *
 * Verification passes only when ALL hold:
 *   1. the supplied records are an INTACT sub-chain for (tenant, ledger) — `verifyLedger`;
 *   2. re-deriving the range root over them equals the checkpoint's `rootDigest` — no row was
 *      added/removed/altered/reordered in the covered range (truncation/replacement tamper-evident);
 *   3. the head integrity digest matches;
 *   4. the Ed25519 signature re-verifies against the supplied key.
 *
 * On any failure the result is `tampered` with a machine reason. Never throws for a verification
 * failure (that is a recorded outcome, not an exception) — only throws `AccountabilityError` if the
 * VERIFY action itself is not fully accountable.
 */
export function verifyPublishedCheckpoint(input: {
  checkpoint: PublishedCheckpoint;
  records: readonly ChainedAuditRecord[];
  key: CheckpointVerificationKey;
  action: AccountabilityRecord;
}): CheckpointVerification {
  const { checkpoint, records, key, action } = input;

  // The verify is an accountable action (Phase-31 AC): full accountability required first.
  assertAccountable(action);

  const sequence = checkpoint.verificationHistory.length + 1;
  const accountabilityDigest = contentDigest(action);
  const base = {
    sequence,
    accountabilityDigest,
    outcome: action.outcome,
    recordedAt: action.timing.recordedAt,
  };

  const tampered = (reason: string): CheckpointVerification =>
    Object.freeze({ ...base, result: 'tampered' as const, reason });

  // (1) The independently-read records must be an intact sub-chain.
  const chainResult = verifyLedger(checkpoint.tenantId, checkpoint.ledgerId, records);
  if (!chainResult.ok) {
    return tampered(`chain:${chainResult.reason ?? 'invalid'}`);
  }

  // The records must cover EXACTLY the checkpoint's range.
  if (records.length !== checkpoint.eventCount) {
    return tampered('range_count_mismatch');
  }
  const first = records[0];
  const last = records[records.length - 1];
  if (
    !first ||
    !last ||
    first.sequence !== checkpoint.firstSequence ||
    last.sequence !== checkpoint.lastSequence
  ) {
    return tampered('range_bounds_mismatch');
  }

  // (2)+(3) Re-derive the range root + head digest and compare to the signed values.
  let recomputed: CheckpointRange;
  try {
    recomputed = computeCheckpointRoot(checkpoint.tenantId, checkpoint.ledgerId, records);
  } catch {
    return tampered('range_unverifiable');
  }
  if (recomputed.rootDigest !== checkpoint.rootDigest) {
    return tampered('root_digest_mismatch');
  }
  if (recomputed.headIntegrityDigest !== checkpoint.headIntegrityDigest) {
    return tampered('head_digest_mismatch');
  }

  // (4) The signature must re-verify against the exact signed payload.
  const sigReason = verifyCheckpointSignature(checkpoint, key);
  if (sigReason !== null) {
    return tampered(`signature:${sigReason}`);
  }

  return Object.freeze({ ...base, result: 'verified' as const, reason: null });
}

/**
 * Append a verification record to a published checkpoint's history (APPEND-ONLY). Returns a NEW,
 * deep-frozen checkpoint with the record appended and `status` advanced to `verified` (a passing
 * verification) or `tampered` (a failing one). Enforces monotone, gap-free verification sequence and
 * refuses to overwrite history — the signed range/root/signature are NEVER rewritten.
 *
 * A `tampered` status is STICKY: once a checkpoint has been found tampered, a later `verified` pass
 * cannot silently clear it (the historical tamper finding remains the checkpoint's status), so a
 * detected tamper cannot be laundered away.
 */
export function appendVerification(
  checkpoint: PublishedCheckpoint,
  verification: CheckpointVerification,
): PublishedCheckpoint {
  const expectedSequence = checkpoint.verificationHistory.length + 1;
  if (verification.sequence !== expectedSequence) {
    throw new CheckpointError(
      'verification_sequence',
      `verification sequence ${verification.sequence} is not the expected next ${expectedSequence}`,
    );
  }
  if (verification.result !== 'verified' && verification.result !== 'tampered') {
    throw new CheckpointError(
      'verification_result',
      'verification result must be verified or tampered',
    );
  }

  const wasTampered =
    checkpoint.status === 'tampered' ||
    checkpoint.verificationHistory.some((v) => v.result === 'tampered');
  let nextStatus: CheckpointStatus;
  if (verification.result === 'tampered' || wasTampered) {
    // A tamper finding is sticky — never laundered back to verified.
    nextStatus = 'tampered';
  } else {
    nextStatus = 'verified';
  }

  return Object.freeze({
    ...checkpoint,
    status: nextStatus,
    verificationHistory: Object.freeze([
      ...checkpoint.verificationHistory,
      Object.freeze({ ...verification }),
    ]) as readonly CheckpointVerification[],
  });
}

/**
 * Convenience: verify a published checkpoint against independently-read records and append the
 * resulting verification to its history in one step (the common operational path). Returns the NEW
 * checkpoint carrying the appended verification and advanced status.
 */
export function verifyAndRecord(input: {
  checkpoint: PublishedCheckpoint;
  records: readonly ChainedAuditRecord[];
  key: CheckpointVerificationKey;
  action: AccountabilityRecord;
}): { checkpoint: PublishedCheckpoint; verification: CheckpointVerification } {
  const verification = verifyPublishedCheckpoint(input);
  const checkpoint = appendVerification(input.checkpoint, verification);
  return { checkpoint, verification };
}

/**
 * Anchor a verified checkpoint to an external immutable reference (e.g. a transparency log / object
 * lock). Only a currently-`verified` checkpoint may be anchored; a `tampered` or unverified
 * checkpoint cannot be promoted to `anchored`. Returns a NEW checkpoint.
 */
export function anchorCheckpoint(
  checkpoint: PublishedCheckpoint,
  externalAnchorRef: string,
): PublishedCheckpoint {
  if (!isNonEmptyString(externalAnchorRef)) {
    throw new CheckpointError('anchor', 'externalAnchorRef is required');
  }
  if (checkpoint.status !== 'verified') {
    throw new CheckpointError(
      'anchor_state',
      `only a verified checkpoint can be anchored (status is ${checkpoint.status})`,
    );
  }
  return Object.freeze({ ...checkpoint, status: 'anchored', externalAnchorRef });
}

// NB: the hash-chain accountability surface (AccountabilityRecord, ChainedAuditRecord, CheckpointRange,
// AccountabilityError, assertAccountable, contentDigest, computeCheckpointRoot, GENESIS_PREVIOUS_DIGEST)
// is intentionally NOT re-exported here — the package barrel (./index.ts) already re-exports it from
// ./hash-chain.ts, and re-exporting it again would create an ambiguous duplicate export.
