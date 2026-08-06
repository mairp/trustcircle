// @trustcircle/adapter-sdk — LANGUAGE-NEUTRAL adapter CONFORMANCE runner + signed result manifest
// (Phase 8 / User Story 6 / T229 / FR-029, NS-005, SC-011).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// Before an adapter version may be ACTIVATED (adapter-registry / migration 0060
// `adapter_version_activation_requires_conformance`), it must pass a fixed conformance suite that any
// implementation — TypeScript, Go, Python, a shell CLI behind an HTTP shim — can be driven through.
// The suite is defined as a LANGUAGE-NEUTRAL list of `ConformanceCase`s whose expectations are pure
// data; the adapter under test is exercised through an injected `ConformanceProbe` port (an HTTP/event
// seam), and every case's observed result is compared to its declared expectation. The runner then
// emits a SIGNED result manifest whose digest binds the adapter identity, the suite version, and each
// case verdict — a durable, independently verifiable artifact that the registry stores as the
// activation gate evidence.
//
// The suite pins the dangerous adapter invariants that MUST hold for every adapter:
//   * OVER-PRIVILEGE REFUSAL — a command using a capability the manifest does not declare is refused.
//   * PROTECTED CONTENT — a metadata_only adapter never returns protected content.
//   * TOMBSTONES — an archive/deletion is a tombstone, never a governance closure.
//   * ROLLBACK — a rollback restores the preimage and verifies it.
//   * HEALTH — the health endpoint is non-mutating and reports freshness.
//   * OLD/NEW OVERLAP — during a version overlap window both contract majors are honored.
//   * VERSION DRIFT (NS-005) — a drifted version echo is refused.
//   * IDEMPOTENCY / DEDUP (SC-011) — a retried command under one key yields exactly one effect.
//
// Dependency-free (Node built-in `crypto` only): pure, deterministic given the probe's responses.
// Runs under Node 22 `--experimental-strip-types`.

import { createHash, createHmac } from 'node:crypto';

import {
  canonicalJson,
  type AdapterCapability,
  type AdapterManifest,
  type Semver,
} from './manifest.ts';

// ===========================================================================
// 1. The conformance dimensions the suite covers (language-neutral).
// ===========================================================================

export const CONFORMANCE_DIMENSIONS = [
  'manifest_signature',
  'over_privilege',
  'protected_content',
  'tombstone',
  'rollback',
  'health',
  'version_overlap',
  'malformed',
  'delayed',
  'out_of_order',
  'partial_delivery',
  'unauthorized',
  'rate_limit',
  'revocation',
  'terminal_failure',
  'version_drift',
  'idempotency',
  'reconciliation',
] as const;
export type ConformanceDimension = (typeof CONFORMANCE_DIMENSIONS)[number];

/** A single, self-describing conformance case. Its expectation is pure data (language-neutral). */
export interface ConformanceCase {
  readonly id: string;
  readonly dimension: ConformanceDimension;
  readonly description: string;
  /** The probe action to run (opaque to the runner; interpreted by the probe). */
  readonly action: Readonly<Record<string, unknown>>;
  /** The expected observable verdict from the probe. */
  readonly expect: Readonly<Record<string, unknown>>;
}

// ===========================================================================
// 2. The injected probe port — the language-neutral seam.
// ===========================================================================

/** The observable result of running one case against the adapter under test. */
export interface ProbeResult {
  readonly caseId: string;
  readonly observed: Readonly<Record<string, unknown>>;
}

/** The seam a conformance harness implements to drive an adapter (HTTP, events, CLI-over-shim). */
export type ConformanceProbe = (kase: ConformanceCase) => Promise<ProbeResult>;

// ===========================================================================
// 3. The canonical suite — the fixed language-neutral case list.
// ===========================================================================

/**
 * Build the canonical conformance suite for an adapter, parameterized by its declared capabilities so
 * the over-privilege case names a capability the adapter genuinely does NOT declare.
 */
export function buildConformanceSuite(manifest: AdapterManifest): readonly ConformanceCase[] {
  const declared = new Set<AdapterCapability>(manifest.capabilities);
  const ALL: readonly AdapterCapability[] = [
    'discover',
    'inspect',
    'snapshot',
    'subscribe',
    'simulate',
    'execute',
    'pause',
    'resume',
    'reconcile',
    'rollback',
    'collect_evidence',
    'quarantine',
    'restore',
  ];
  const undeclared = ALL.find((c) => !declared.has(c)) ?? 'execute';
  const cases: ConformanceCase[] = [
    {
      id: 'C-manifest-signature',
      dimension: 'manifest_signature',
      description: 'the manifest is signed and its digest verifies',
      action: { kind: 'verify_manifest' },
      expect: { signatureValid: true },
    },
    {
      id: 'C-over-privilege',
      dimension: 'over_privilege',
      description: 'a command using an undeclared capability is refused',
      action: { kind: 'command', capability: undeclared },
      expect: { refused: true, reason: 'capability_not_declared' },
    },
    {
      id: 'C-protected-content',
      dimension: 'protected_content',
      description: 'a metadata_only adapter never returns protected content',
      action: { kind: 'read', contentAccess: manifest.security.content_access ?? 'metadata_only' },
      expect: { protectedContentReturned: false },
    },
    {
      id: 'C-tombstone',
      dimension: 'tombstone',
      description: 'an archive/deletion is a tombstone, never a governance closure',
      action: { kind: 'observe_archive' },
      expect: { tombstone: true, governanceClosure: false },
    },
    {
      id: 'C-rollback',
      dimension: 'rollback',
      description: 'a rollback restores the preimage and verifies it',
      action: { kind: 'rollback' },
      expect: { preimageRestored: true, verified: true },
    },
    {
      id: 'C-health',
      dimension: 'health',
      description: 'the health endpoint is non-mutating and reports freshness',
      action: { kind: 'health' },
      expect: { mutating: false, reportsFreshness: true },
    },
    {
      id: 'C-version-overlap',
      dimension: 'version_overlap',
      description: 'during an overlap window both contract majors are honored',
      action: {
        kind: 'overlap',
        min: manifest.contract_range.minimum,
        max: manifest.contract_range.maximum,
      },
      expect: { oldHonored: true, newHonored: true },
    },
    {
      id: 'C-version-drift',
      dimension: 'version_drift',
      description: 'a drifted version echo is refused (NS-005)',
      action: { kind: 'drift_echo' },
      expect: { refused: true, reason: 'version_drift' },
    },
    {
      id: 'C-idempotency',
      dimension: 'idempotency',
      description: 'a retried command under one key yields exactly one effect (SC-011)',
      action: { kind: 'retry_same_key' },
      expect: { effectCount: 1 },
    },
    {
      id: 'C-reconciliation',
      dimension: 'reconciliation',
      description: 'reconciliation is safe during source degradation',
      action: { kind: 'reconcile', degraded: true },
      expect: { safe: true },
    },
    {
      id: 'C-malformed',
      dimension: 'malformed',
      description: 'malformed source payloads are refused without an effect',
      action: { kind: 'ingest', payload: 'malformed' },
      expect: { refused: true, reason: 'malformed_payload', effectCount: 0 },
    },
    {
      id: 'C-delayed',
      dimension: 'delayed',
      description: 'delayed delivery preserves the observation and exposes uncertainty',
      action: { kind: 'deliver', delayed: true },
      expect: { retained: true, freshness: 'unknown' },
    },
    {
      id: 'C-out-of-order',
      dimension: 'out_of_order',
      description: 'out-of-order delivery is retained without advancing the source sequence',
      action: { kind: 'deliver', outOfOrder: true },
      expect: { retained: true, sequenceAdvanced: false },
    },
    {
      id: 'C-partial-delivery',
      dimension: 'partial_delivery',
      description: 'partial delivery remains visible and requires reconciliation',
      action: { kind: 'deliver', partial: true },
      expect: { partial: true, reconciliationRequired: true },
    },
    {
      id: 'C-unauthorized',
      dimension: 'unauthorized',
      description: 'an unauthorized operation is refused before dispatch',
      action: { kind: 'command', authority: 'denied' },
      expect: { refused: true, reason: 'unauthorized', effectCount: 0 },
    },
    {
      id: 'C-rate-limit',
      dimension: 'rate_limit',
      description: 'rate limiting is retryable only within declared bounds',
      action: { kind: 'command', sourceResponse: 'rate_limited' },
      expect: { retryable: true, retryAfterHonored: true },
    },
    {
      id: 'C-revocation',
      dimension: 'revocation',
      description: 'revocation blocks new work while preserving reconciliation',
      action: { kind: 'command', credentialState: 'revoked' },
      expect: { newWorkBlocked: true, reconciliationAvailable: true },
    },
    {
      id: 'C-terminal-failure',
      dimension: 'terminal_failure',
      description: 'terminal failure stops retry and retains sanitized evidence',
      action: { kind: 'command', sourceResponse: 'terminal' },
      expect: { terminal: true, retryScheduled: false, evidenceRetained: true },
    },
  ];
  return Object.freeze(cases);
}

// ===========================================================================
// 4. The runner — drive the probe, compare, and collect verdicts.
// ===========================================================================

export interface CaseVerdict {
  readonly caseId: string;
  readonly dimension: ConformanceDimension;
  readonly passed: boolean;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly observed: Readonly<Record<string, unknown>>;
}

export interface ConformanceRunOutcome {
  readonly adapterId: string;
  readonly adapterVersion: Semver;
  readonly suiteVersion: Semver;
  readonly passed: boolean;
  readonly total: number;
  readonly passedCount: number;
  readonly verdicts: readonly CaseVerdict[];
}

function expectationHolds(
  expected: Readonly<Record<string, unknown>>,
  observed: Readonly<Record<string, unknown>>,
): boolean {
  // Every expected key must be present in observed with a deep-equal value (canonical compare).
  for (const [k, v] of Object.entries(expected)) {
    if (!(k in observed)) return false;
    if (canonicalJson(observed[k]) !== canonicalJson(v)) return false;
  }
  return true;
}

/** Drive the probe over the suite and collect deterministic verdicts. */
export async function runConformance(
  manifest: AdapterManifest,
  probe: ConformanceProbe,
  suiteVersion: Semver = '1.0.0',
): Promise<ConformanceRunOutcome> {
  const suite = buildConformanceSuite(manifest);
  const verdicts: CaseVerdict[] = [];
  for (const kase of suite) {
    const result = await probe(kase);
    const passed = result.caseId === kase.id && expectationHolds(kase.expect, result.observed);
    verdicts.push(
      Object.freeze({
        caseId: kase.id,
        dimension: kase.dimension,
        passed,
        expected: kase.expect,
        observed: result.observed,
      }),
    );
  }
  const passedCount = verdicts.filter((v) => v.passed).length;
  return Object.freeze({
    adapterId: manifest.adapter_id,
    adapterVersion: manifest.adapter_version,
    suiteVersion,
    passed: passedCount === verdicts.length,
    total: verdicts.length,
    passedCount,
    verdicts: Object.freeze(verdicts),
  });
}

// ===========================================================================
// 5. Signed result manifest — the durable, verifiable activation-gate evidence.
// ===========================================================================

export interface ConformanceResultManifest {
  readonly kind: 'adapter-conformance-result';
  readonly adapterId: string;
  readonly adapterVersion: Semver;
  readonly suiteVersion: Semver;
  readonly manifestDigest: string; // the manifest under test's digest
  readonly passed: boolean;
  readonly total: number;
  readonly passedCount: number;
  readonly verdicts: readonly CaseVerdict[];
  readonly ranAt: number;
  readonly environmentDigest: string;
  readonly fixtureDigests: readonly string[];
  readonly toolVersions: Readonly<Record<string, string>>;
  readonly caseEvidenceRefs: readonly ConformanceCaseEvidence[];
  readonly startedAt: number;
  readonly completedAt: number;
  readonly resultDigest: string;
  readonly signature: {
    readonly algorithm: 'HMAC-SHA256';
    readonly keyId: string;
    readonly value: string;
  };
}

export interface ConformanceCaseEvidence {
  readonly caseId: string;
  readonly evidenceRef: string;
}

export interface SealConformanceInput {
  readonly outcome: ConformanceRunOutcome;
  readonly manifestDigest: string;
  readonly ranAt?: number;
  readonly environmentDigest?: string;
  readonly fixtureDigests?: readonly string[];
  readonly toolVersions?: Readonly<Record<string, string>>;
  readonly caseEvidenceRefs?: readonly ConformanceCaseEvidence[];
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly keyId: string;
  readonly signingKey: string;
}

/** Seal a conformance outcome into a signed, digest-bound result manifest. */
export function sealConformanceResult(input: SealConformanceInput): ConformanceResultManifest {
  const completedAt = input.completedAt ?? input.ranAt;
  if (!Number.isInteger(completedAt) || Number(completedAt) < 0) {
    throw new RangeError('completedAt or ranAt must be a non-negative epoch-ms');
  }
  const startedAt = input.startedAt ?? completedAt!;
  if (!Number.isInteger(startedAt) || Number(startedAt) < 0 || startedAt > completedAt!) {
    throw new RangeError('startedAt must be a non-negative epoch-ms not after completedAt');
  }
  const environmentDigest =
    input.environmentDigest ??
    createHash('sha256')
      .update(
        canonicalJson({
          adapterId: input.outcome.adapterId,
          suiteVersion: input.outcome.suiteVersion,
        }),
        'utf8',
      )
      .digest('hex');
  if (!/^[a-f0-9]{64}$/.test(environmentDigest)) {
    throw new TypeError('environmentDigest must be a sha256 hex digest');
  }
  const fixtureDigests = Object.freeze([...(input.fixtureDigests ?? [])]);
  if (fixtureDigests.some((digest) => !/^[a-f0-9]{64}$/.test(digest))) {
    throw new TypeError('fixtureDigests must contain only sha256 hex digests');
  }
  const caseIds = new Set(input.outcome.verdicts.map((verdict) => verdict.caseId));
  const caseEvidenceRefs = Object.freeze([...(input.caseEvidenceRefs ?? [])]);
  if (
    caseEvidenceRefs.some(
      (entry) => !caseIds.has(entry.caseId) || entry.evidenceRef.trim().length === 0,
    )
  ) {
    throw new TypeError('caseEvidenceRefs must resolve to a conformance case and evidence ref');
  }
  const body = {
    kind: 'adapter-conformance-result' as const,
    adapterId: input.outcome.adapterId,
    adapterVersion: input.outcome.adapterVersion,
    suiteVersion: input.outcome.suiteVersion,
    manifestDigest: input.manifestDigest,
    passed: input.outcome.passed,
    total: input.outcome.total,
    passedCount: input.outcome.passedCount,
    verdicts: input.outcome.verdicts,
    environmentDigest,
    fixtureDigests,
    toolVersions: Object.freeze({ ...(input.toolVersions ?? {}) }),
    caseEvidenceRefs,
    startedAt,
    completedAt: completedAt!,
    ranAt: completedAt!,
  };
  const preimage = canonicalJson(body);
  const resultDigest = createHash('sha256').update(preimage, 'utf8').digest('hex');
  const value = createHmac('sha256', input.signingKey).update(preimage, 'utf8').digest('base64url');
  return Object.freeze({
    ...body,
    resultDigest,
    signature: Object.freeze({ algorithm: 'HMAC-SHA256' as const, keyId: input.keyId, value }),
  });
}

export type ConformanceVerifyResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: 'digest-mismatch' | 'signature-mismatch' };

/** Verify a sealed conformance result manifest against the signing key. */
export function verifyConformanceResult(
  manifest: ConformanceResultManifest,
  signingKey: string,
): ConformanceVerifyResult {
  const { resultDigest, signature, ...body } = manifest;
  const preimage = canonicalJson(body);
  const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
  if (digest !== resultDigest) return { valid: false, reason: 'digest-mismatch' };
  const expected = createHmac('sha256', signingKey).update(preimage, 'utf8').digest('base64url');
  if (expected !== signature.value) return { valid: false, reason: 'signature-mismatch' };
  return { valid: true };
}
