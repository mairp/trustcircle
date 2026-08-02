// TrustCircleAI — SIGNED VALIDATION-MANIFEST verifier + gate (Phase 9 / T282 / GAR-010).
//
// PHASE OBJECTIVE (T282): "Implement signed validation-manifest schema verification, requirement
// coverage, checkpoint validation, and missing-evidence failure in tests/evidence/verify-manifests.ts".
//
// A *validation manifest* is the signed roll-up a release produces: the set of governance
// requirements it claims to satisfy, the evidence artifact backing each one, and a signed audit
// CHECKPOINT that binds the manifest to the append-only ledger it was generated over. This module
// implements `verifyValidationManifest()` — a single verifier that a release gate calls — plus a
// self-check entrypoint that exercises it with a valid manifest and four independent FAILURE modes.
//
// Four obligations, each verified and each with a matching failure control:
//   1. SCHEMA VERIFICATION   — the manifest's structure (canonical shape + HMAC signature over the
//                              canonical bytes) verifies; a tampered field breaks the signature.
//   2. REQUIREMENT COVERAGE  — every REQUIRED requirement id appears with a backing evidence entry;
//                              an uncovered requirement fails.
//   3. CHECKPOINT VALIDATION — the embedded signed checkpoint verifies against the REAL
//                              packages/audit-ledger checkpoint verifier (ed25519); a wrong key or a
//                              tampered root fails.
//   4. MISSING-EVIDENCE      — an evidence entry whose content digest does not match its stored blob
//                              (or is absent) fails the manifest.
//
// Non-vacuity: the self-check asserts the valid manifest PASSES and every failure mode is REJECTED
// for the RIGHT reason — a verifier that always returned "ok" would fail the failure controls.
//
// Determinism: canonical JSON, sha256/HMAC, fixed instants, ed25519 keys derived from a fixed seed.
// Node built-ins + REAL package sources only. Run:
//   node --experimental-strip-types tests/evidence/verify-manifests.ts

import { createHmac, createHash } from 'node:crypto';

import {
  createLedger,
  appendAuditRecord,
  GENESIS_PREVIOUS_DIGEST,
  type AuditLedger,
  type AccountabilityRecord,
} from '../../packages/audit-ledger/src/hash-chain.ts';

import {
  generateSigningKey,
  verificationKeyFor,
  signCheckpoint,
  verifyCheckpointSignature,
  type PublishedCheckpoint,
} from '../../packages/audit-ledger/src/checkpoints.ts';

const TENANT = '11111111-1111-7111-8111-111111111111';
const LEDGER = '22222222-2222-7222-8222-222222222222';
const NOW = 1_700_000_000_000;
const MANIFEST_HMAC_KEY = 'validation-manifest-signing-key';

// ── canonical JSON (stable key order) ─────────────────────────────────────────────────────────────
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function hmac(text: string): string {
  return createHmac('sha256', MANIFEST_HMAC_KEY).update(text).digest('hex');
}

// ── the validation-manifest shape ──────────────────────────────────────────────────────────────
interface EvidenceEntry {
  readonly requirementId: string;
  readonly artifactPath: string;
  readonly contentSha256: string;
}
interface ValidationManifestBody {
  readonly manifestId: string;
  readonly tenantId: string;
  readonly requiredRequirementIds: readonly string[];
  readonly evidence: readonly EvidenceEntry[];
  readonly checkpoint: PublishedCheckpoint;
  readonly generatedAt: number;
}
interface SignedValidationManifest {
  readonly body: ValidationManifestBody;
  readonly signature: string; // HMAC over canonical(body)
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly reasons: string[];
}

// ── the verifier a release gate calls ─────────────────────────────────────────────────────────────
export function verifyValidationManifest(
  manifest: SignedValidationManifest,
  checkpointVerificationKey: ReturnType<typeof verificationKeyFor>,
  evidenceBlobs: ReadonlyMap<string, string>, // artifactPath -> stored content
): VerifyResult {
  const reasons: string[] = [];

  // 1. SCHEMA: signature over the canonical body must verify (tamper-evident structure).
  if (hmac(canonical(manifest.body)) !== manifest.signature) {
    reasons.push('schema:signature-invalid');
  }

  // 2. REQUIREMENT COVERAGE: every required requirement has a backing evidence entry.
  const covered = new Set(manifest.body.evidence.map((e) => e.requirementId));
  for (const req of manifest.body.requiredRequirementIds) {
    if (!covered.has(req)) reasons.push(`coverage:uncovered-requirement:${req}`);
  }

  // 3. CHECKPOINT VALIDATION: the embedded signed checkpoint verifies (ed25519).
  const cpReason = verifyCheckpointSignature(manifest.body.checkpoint, checkpointVerificationKey);
  if (cpReason !== null) reasons.push(`checkpoint:${cpReason}`);

  // 4. MISSING-EVIDENCE: each evidence blob must exist and hash to its recorded digest.
  for (const e of manifest.body.evidence) {
    const blob = evidenceBlobs.get(e.artifactPath);
    if (blob === undefined) {
      reasons.push(`evidence:missing:${e.artifactPath}`);
    } else if (sha256(blob) !== e.contentSha256) {
      reasons.push(`evidence:digest-mismatch:${e.artifactPath}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Fixture builders for the self-check.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
function record(seq: number): AccountabilityRecord {
  return {
    auditEventId: `aaaaaaaa-aaaa-7aaa-8aaa-00000000000${seq}`,
    tenantId: TENANT,
    ledgerId: LEDGER,
    sequence: seq,
    eventType: 'validation.recorded',
    schemaVersion: '1.0.0',
    actor: {
      principalId: `p-${seq}`,
      roleAssignmentId: 'ra-1',
      isSystem: false,
      automationId: null,
    },
    accountableOwnerPrincipalId: 'owner-1',
    reason: { code: 'VALIDATED', text: 'gate passed' },
    state: {
      entityType: 'validation',
      entityId: `val-${seq}`,
      entityVersion: 'v1',
      sourceStateDigest: `src-${seq}`,
      targetStateDigest: `tgt-${seq}`,
      actualStateDigest: null,
    },
    governance: {
      policyVersionIds: ['pol-1'],
      controlVersionIds: ['ctl-1'],
      evidenceManifestId: 'ev-1',
    },
    scope: { requested: { tenants: [TENANT] }, actual: { tenants: [TENANT] } },
    timing: { occurredAt: NOW + seq, recordedAt: NOW + 100 + seq },
    correlation: { correlationId: `corr-${seq}`, causationId: null, traceId: `trace-${seq}` },
    outcome: 'succeeded',
  };
}
function ledger(): AuditLedger {
  let l = createLedger(TENANT, LEDGER);
  l = appendAuditRecord(l, record(1));
  l = appendAuditRecord(l, record(2));
  return l;
}
const signingKey = generateSigningKey('checkpoint-key-1');

function publishAction(): AccountabilityRecord {
  return { ...record(3), eventType: 'checkpoint.published' };
}
function signedCheckpoint(l: AuditLedger): PublishedCheckpoint {
  return signCheckpoint({
    checkpointId: 'cp-1',
    key: signingKey,
    records: l.records,
    previousRootDigest: GENESIS_PREVIOUS_DIGEST,
    action: publishAction(),
    generatedAt: NOW + 500,
    evidenceItemId: null,
    externalAnchorRef: null,
  });
}

function buildValidManifest(): {
  manifest: SignedValidationManifest;
  blobs: Map<string, string>;
} {
  const l = ledger();
  const cp = signedCheckpoint(l);
  const blobs = new Map<string, string>([
    ['evidence/gar-002.md', 'audit accountability evidence'],
    ['evidence/gar-006.md', 'evidence retention evidence'],
  ]);
  const evidence: EvidenceEntry[] = [
    {
      requirementId: 'GAR-002',
      artifactPath: 'evidence/gar-002.md',
      contentSha256: sha256('audit accountability evidence'),
    },
    {
      requirementId: 'GAR-006',
      artifactPath: 'evidence/gar-006.md',
      contentSha256: sha256('evidence retention evidence'),
    },
  ];
  const body: ValidationManifestBody = {
    manifestId: 'vm-1',
    tenantId: TENANT,
    requiredRequirementIds: ['GAR-002', 'GAR-006'],
    evidence,
    checkpoint: cp,
    generatedAt: NOW + 600,
  };
  return { manifest: { body, signature: hmac(canonical(body)) }, blobs };
}

// ── self-check entrypoint ────────────────────────────────────────────────────────────────────────
export function selfCheck(): { ok: true } {
  const problems: string[] = [];
  const vkey = verificationKeyFor(signingKey);
  const otherKey = verificationKeyFor(generateSigningKey('wrong-key'));

  // VALID — must pass.
  {
    const { manifest, blobs } = buildValidManifest();
    const r = verifyValidationManifest(manifest, vkey, blobs);
    if (!r.ok) problems.push(`valid manifest rejected: ${r.reasons.join(', ')}`);
  }

  // 1. SCHEMA failure — tamper a body field without re-signing.
  {
    const { manifest, blobs } = buildValidManifest();
    const tampered: SignedValidationManifest = {
      body: { ...manifest.body, manifestId: 'vm-tampered' },
      signature: manifest.signature,
    };
    const r = verifyValidationManifest(tampered, vkey, blobs);
    if (r.ok || !r.reasons.some((x) => x.startsWith('schema:'))) {
      problems.push('schema tamper not rejected');
    }
  }

  // 2. COVERAGE failure — require a requirement with no evidence.
  {
    const { manifest, blobs } = buildValidManifest();
    const body = { ...manifest.body, requiredRequirementIds: ['GAR-002', 'GAR-006', 'GAR-009'] };
    const uncovered: SignedValidationManifest = { body, signature: hmac(canonical(body)) };
    const r = verifyValidationManifest(uncovered, vkey, blobs);
    if (r.ok || !r.reasons.some((x) => x === 'coverage:uncovered-requirement:GAR-009')) {
      problems.push('uncovered requirement not rejected');
    }
  }

  // 3. CHECKPOINT failure — verify against the WRONG ed25519 key.
  {
    const { manifest, blobs } = buildValidManifest();
    const r = verifyValidationManifest(manifest, otherKey, blobs);
    if (r.ok || !r.reasons.some((x) => x.startsWith('checkpoint:'))) {
      problems.push('wrong checkpoint key not rejected');
    }
  }

  // 4. MISSING-EVIDENCE failure — remove one blob, and corrupt another.
  {
    const { manifest, blobs } = buildValidManifest();
    const missing = new Map(blobs);
    missing.delete('evidence/gar-002.md');
    const r = verifyValidationManifest(manifest, vkey, missing);
    if (r.ok || !r.reasons.some((x) => x === 'evidence:missing:evidence/gar-002.md')) {
      problems.push('missing evidence not rejected');
    }
    const corrupt = new Map(blobs);
    corrupt.set('evidence/gar-006.md', 'corrupted bytes');
    const r2 = verifyValidationManifest(manifest, vkey, corrupt);
    if (r2.ok || !r2.reasons.some((x) => x === 'evidence:digest-mismatch:evidence/gar-006.md')) {
      problems.push('corrupted evidence not rejected');
    }
  }

  if (problems.length > 0) {
    throw new Error(`verify-manifests self-check FAILED:\n - ${problems.join('\n - ')}`);
  }
  return { ok: true };
}

const isEntry =
  // @ts-expect-error import.meta.main is Node 22+, not yet in lib.dom typings
  (typeof import.meta !== 'undefined' && import.meta.main) ||
  (typeof process !== 'undefined' &&
    typeof import.meta?.url === 'string' &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntry) {
  selfCheck();
  console.log(
    'verify-manifests OK — signed validation manifest verifies; schema tamper, uncovered ' +
      'requirement, wrong checkpoint key, and missing/corrupt evidence are all rejected.',
  );
}
