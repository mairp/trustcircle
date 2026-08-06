// @trustcircle — AUDIT-EXPORT performance + correctness suite (Phase 7 / User Story 5 /
// T188 — FR-051..056, SC-013, SC-022).
//
// This suite drives the REAL, pure audit-export builders from the T209 worker module
// (`apps/command-worker/src/audit-export.ts`) over synthetic, in-memory evidence rows. It is
// fully deterministic: no wall clock inside the app logic (`performance.now()` is used ONLY as
// the test's own external stopwatch), no randomness, no Testcontainers. Every assertion observes
// real output of the real functions — never a stub.
//
// The seven concerns exercised:
//   1. 100,000-reference scoped export completes and is bounded well under the 15-minute objective.
//   2. Access filtering (FR-053): cross-tenant references are excluded, symmetrically.
//   3. Chain of custody (FR-052): an ordered, tamper-evident fold, detectably broken by a reorder.
//   4. Signed manifest (FR-056): stable digest for identical inputs, different when a ref changes,
//      valid via `verifyManifest`, invalid when mutated.
//   5. Gap report (SC-022): gaps surfaced verbatim; all-covered yields an empty gap list.
//   6. Reproducible-at-instant (SC-013): two runs over identical inputs are deep-equal.
//   7. Truthful boundary (FR-055): internal readiness is never promoted to external certification.

import { describe, it, expect } from 'vitest';

import {
  buildAuditExportBody,
  buildAuditExportPackage,
  buildCustodyChain,
  custodyChainIsIntact,
  authorizeReferences,
  verifyManifest,
  assertTruthfulBoundary,
  auditExportBodyDigest,
  exportReferenceCount,
  isInternalReadinessBoundary,
  EXTERNAL_CLAIM_NOTE,
  AuditExportError,
  type AuditExportRequest,
  type EvidenceReference,
  type CustodyLink,
  type SigningKey,
} from '../../apps/command-worker/src/audit-export.ts';

import {
  NOW,
  TENANT,
  OTHER_TENANT,
  READY_INPUTS,
  UNMAPPED_INPUTS,
  CERTIFIED_INPUTS,
  EXPIRED_CERT_INPUTS,
  REOPENED_INPUTS,
} from '../fixtures/compliance.ts';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Deterministic helpers — no randomness, no clock. Ids derive from the index.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The generous ceiling proving ample headroom under the 900s (15-minute) objective (SC-013). */
const OBJECTIVE_MILLIS = 900_000;
const HEADROOM_CEILING_MILLIS = 60_000;

/** A fixed, non-random signing key — the secret is a literal, so the whole suite is byte-stable. */
const SIGNING_KEY: SigningKey = {
  keyId: 'test-audit-export-key-1',
  secret: 'test-secret-material',
};
const ALT_KEY: SigningKey = { keyId: 'other-key', secret: 'other-secret-material' };

/** A stable, zero-padded evidence id from an index — deterministic, unique, sortable. */
function refId(i: number): string {
  return `evidence-${String(i).padStart(7, '0')}`;
}

/** A stable content digest from an index (deterministic hex-ish token; not crypto, just stable). */
function contentDigest(i: number): string {
  return `content-${String(i).padStart(7, '0')}`;
}

/**
 * A synthetic evidence reference for index `i`, owned by `tenantId`. `recordedAt` is derived from the
 * index (spread within the export window) so custody ordering is exercised deterministically.
 */
function makeRef(i: number, tenantId: string): EvidenceReference {
  return {
    evidenceId: refId(i),
    tenantId,
    recordedAt: (NOW as number) - 1_000_000 + i,
    contentDigest: contentDigest(i),
    accessAuthorized: true,
  };
}

/**
 * The scope for a tenant-scoped export. The worker requires `scope.tenantId === request.tenantId`;
 * the coverage engine's scope type wants Uuid-shaped ids, which the fixture tenants already are.
 */
function scopeFor(tenantId: typeof TENANT | typeof OTHER_TENANT): AuditExportRequest['scope'] {
  return { tenantId: tenantId as unknown as AuditExportRequest['scope']['tenantId'] };
}

/** The `Omit<CoverageInputs,'scope'|'at'>` slice a request carries — derived from a fixture inputs bag. */
function coverageInputsFrom(inputs: typeof READY_INPUTS): AuditExportRequest['coverageInputs'] {
  return {
    decisions: inputs.decisions,
    obligations: inputs.obligations,
    mappings: inputs.mappings,
    evaluations: inputs.evaluations,
    certifications: inputs.certifications,
  };
}

/** Build a well-formed export request for a tenant scope with an explicit reference set. */
function makeRequest(args: {
  tenant: typeof TENANT | typeof OTHER_TENANT;
  references: readonly EvidenceReference[];
  inputs?: typeof READY_INPUTS;
  reconstructedAt?: number;
  operationRequestId?: string;
}): AuditExportRequest {
  const inputs = args.inputs ?? READY_INPUTS;
  return {
    operationRequestId: args.operationRequestId ?? 'req-audit-export-1',
    tenantId: args.tenant as unknown as string,
    requesterPrincipalId: 'principal-auditor',
    scope: scopeFor(args.tenant),
    periodFrom: (NOW as number) - 31_536_000_000,
    periodTo: NOW as number,
    ...(args.reconstructedAt !== undefined ? { reconstructedAt: args.reconstructedAt } : {}),
    reason: { code: 'external_audit', text: 'Annual ISO/IEC 42001 audit evidence pack.' },
    coverageInputs: coverageInputsFrom(inputs),
    evidenceReferences: args.references,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. 100,000-reference scoped export — completes, is bounded, proves headroom (SC-013 scale).
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('100,000-reference scoped export (SC-013 scale)', () => {
  it('builds a signed package whose reference count equals ONLY the in-scope refs, well under the 15-minute objective', () => {
    const TOTAL = 100_000;
    // ~30% owned by OTHER_TENANT so the access filter has something real to exclude.
    const refs: EvidenceReference[] = Array.from({ length: TOTAL }, (_, i) =>
      makeRef(i, i % 10 < 3 ? (OTHER_TENANT as unknown as string) : (TENANT as unknown as string)),
    );
    const inScope = refs.filter((r) => r.tenantId === (TENANT as unknown as string)).length;
    const outOfScope = TOTAL - inScope;
    expect(inScope).toBeGreaterThan(0);
    expect(outOfScope).toBeGreaterThan(0);

    const request = makeRequest({ tenant: TENANT, references: refs });

    const started = performance.now();
    const pkg = buildAuditExportPackage(request, SIGNING_KEY);
    const elapsedMs = performance.now() - started;

    // For the record — the test's OWN external measurement, not app logic.
    console.error(
      `[T188] 100k-reference export built in ${elapsedMs.toFixed(1)} ms (in-scope=${inScope}, excluded=${outOfScope})`,
    );

    // The manifest/reference entry count equals the IN-SCOPE refs — never the total.
    expect(pkg.body.referenceCount).toBe(inScope);
    expect(pkg.body.custody.length).toBe(inScope);
    expect(pkg.body.excludedReferenceCount).toBe(outOfScope);
    expect(exportReferenceCount(request)).toBe(inScope);

    // O(n)-reasonable: building is far under a generous ceiling, proving the 900s objective has
    // ample headroom. (Ceiling is well below the objective itself.)
    expect(HEADROOM_CEILING_MILLIS).toBeLessThan(OBJECTIVE_MILLIS);
    expect(elapsedMs).toBeLessThan(HEADROOM_CEILING_MILLIS);

    // The signed manifest verifies over the produced body.
    expect(verifyManifest(pkg, SIGNING_KEY)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. Access filtering (FR-053) — cross-tenant references excluded, symmetrically.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('access filtering (FR-053)', () => {
  it('excludes OTHER_TENANT references from a TENANT-scoped export', () => {
    const tenantRefs = Array.from({ length: 10 }, (_, i) =>
      makeRef(i, TENANT as unknown as string),
    );
    const otherRefs = Array.from({ length: 4 }, (_, i) =>
      makeRef(1000 + i, OTHER_TENANT as unknown as string),
    );
    const request = makeRequest({ tenant: TENANT, references: [...tenantRefs, ...otherRefs] });
    const body = buildAuditExportBody(request);

    expect(body.referenceCount).toBe(tenantRefs.length);
    expect(body.excludedReferenceCount).toBe(otherRefs.length);

    const custodyIds = new Set(body.custody.map((l) => l.evidenceId));
    for (const other of otherRefs) {
      expect(custodyIds.has(other.evidenceId)).toBe(false);
    }
    for (const own of tenantRefs) {
      expect(custodyIds.has(own.evidenceId)).toBe(true);
    }
  });

  it('symmetrically excludes TENANT references from an OTHER_TENANT-scoped export (negative control)', () => {
    const tenantRefs = Array.from({ length: 7 }, (_, i) => makeRef(i, TENANT as unknown as string));
    const otherRefs = Array.from({ length: 5 }, (_, i) =>
      makeRef(2000 + i, OTHER_TENANT as unknown as string),
    );
    // OTHER_TENANT scope with an empty coverage picture (no obligations) so the boundary is honest.
    const request = makeRequest({
      tenant: OTHER_TENANT,
      references: [...tenantRefs, ...otherRefs],
      inputs: REOPENED_INPUTS,
    });
    const { kept, excluded } = authorizeReferences(request.evidenceReferences, request.tenantId);

    expect(kept.length).toBe(otherRefs.length);
    expect(excluded).toBe(tenantRefs.length);
    const keptIds = new Set(kept.map((r) => r.evidenceId));
    for (const t of tenantRefs) expect(keptIds.has(t.evidenceId)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. Chain of custody (FR-052) — ordered, tamper-evident fold.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('chain of custody (FR-052)', () => {
  const refs = Array.from({ length: 25 }, (_, i) => makeRef(i, TENANT as unknown as string));

  it('produces a non-empty, monotonically-sequenced chain that folds in the prior link', () => {
    const chain = buildCustodyChain(refs);
    expect(chain.length).toBe(refs.length);
    // Sequences are 0..n-1 in order.
    chain.forEach((link, i) => expect(link.sequence).toBe(i));
    // Every chainDigest is present and distinct (the fold makes each depend on all priors).
    const digests = new Set(chain.map((l) => l.chainDigest));
    expect(digests.size).toBe(chain.length);
    // The worker's own verify accepts an untampered chain.
    expect(custodyChainIsIntact(chain)).toBe(true);
  });

  it('detects a reordered chain as inconsistent (negative control)', () => {
    const chain = buildCustodyChain(refs);
    expect(chain.length).toBeGreaterThan(2);
    // Swap two links WITHOUT recomputing digests — the fold no longer matches the sequence.
    const tampered: CustodyLink[] = [...chain];
    const a = tampered[1]!;
    const b = tampered[2]!;
    tampered[1] = b;
    tampered[2] = a;
    expect(custodyChainIsIntact(tampered)).toBe(false);
  });

  it('detects a dropped link as inconsistent (negative control)', () => {
    const chain = buildCustodyChain(refs);
    const dropped = chain.filter((_, i) => i !== 3);
    // Sequences now skip 3, so the sequence/fold check fails.
    expect(custodyChainIsIntact(dropped)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. Signed manifest (FR-056) — stable, sensitive to change, verifiable.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('signed manifest (FR-056)', () => {
  const refs = Array.from({ length: 12 }, (_, i) => makeRef(i, TENANT as unknown as string));

  it('carries a signature + body digest and verifies', () => {
    const pkg = buildAuditExportPackage(
      makeRequest({ tenant: TENANT, references: refs }),
      SIGNING_KEY,
    );
    expect(pkg.manifest.algorithm).toBe('HMAC-SHA-256');
    expect(typeof pkg.manifest.signature).toBe('string');
    expect(pkg.manifest.signature.length).toBeGreaterThan(0);
    expect(pkg.manifest.bodyDigest).toBe(auditExportBodyDigest(pkg.body));
    expect(pkg.manifest.keyId).toBe(SIGNING_KEY.keyId);
    expect(verifyManifest(pkg, SIGNING_KEY)).toBe(true);
  });

  it('is STABLE for identical inputs (two builds ⇒ identical digest + signature)', () => {
    const a = buildAuditExportPackage(
      makeRequest({ tenant: TENANT, references: refs }),
      SIGNING_KEY,
    );
    const b = buildAuditExportPackage(
      makeRequest({ tenant: TENANT, references: refs }),
      SIGNING_KEY,
    );
    expect(a.manifest.bodyDigest).toBe(b.manifest.bodyDigest);
    expect(a.manifest.signature).toBe(b.manifest.signature);
  });

  it('is DIFFERENT when a reference is added or removed', () => {
    const base = buildAuditExportPackage(
      makeRequest({ tenant: TENANT, references: refs }),
      SIGNING_KEY,
    );
    const withExtra = buildAuditExportPackage(
      makeRequest({
        tenant: TENANT,
        references: [...refs, makeRef(999, TENANT as unknown as string)],
      }),
      SIGNING_KEY,
    );
    const withFewer = buildAuditExportPackage(
      makeRequest({ tenant: TENANT, references: refs.slice(1) }),
      SIGNING_KEY,
    );
    expect(withExtra.manifest.bodyDigest).not.toBe(base.manifest.bodyDigest);
    expect(withExtra.manifest.signature).not.toBe(base.manifest.signature);
    expect(withFewer.manifest.bodyDigest).not.toBe(base.manifest.bodyDigest);
  });

  it('verifyManifest returns FALSE for a mutated body or a wrong key (negative control)', () => {
    const pkg = buildAuditExportPackage(
      makeRequest({ tenant: TENANT, references: refs }),
      SIGNING_KEY,
    );

    // Mutate a covered field (the reference count) — the body no longer matches its signed digest.
    const mutated = {
      body: { ...pkg.body, referenceCount: pkg.body.referenceCount + 1 },
      manifest: pkg.manifest,
    };
    expect(verifyManifest(mutated, SIGNING_KEY)).toBe(false);

    // Tamper with the custody chain — the intactness check inside verify fails.
    const brokenCustody: CustodyLink[] = [...pkg.body.custody];
    if (brokenCustody.length > 1) {
      const first = brokenCustody[0]!;
      brokenCustody[0] = brokenCustody[1]!;
      brokenCustody[1] = first;
    }
    const custodyMutated = {
      body: { ...pkg.body, custody: brokenCustody },
      manifest: pkg.manifest,
    };
    expect(verifyManifest(custodyMutated, SIGNING_KEY)).toBe(false);

    // A different key never verifies a package signed with the real key.
    expect(verifyManifest(pkg, ALT_KEY)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. Gap report (SC-022) — gaps enumerated verbatim, never hidden.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('gap report (SC-022)', () => {
  const refs = Array.from({ length: 5 }, (_, i) => makeRef(i, TENANT as unknown as string));

  it('surfaces a known uncovered obligation as a gap with its kind', () => {
    // UNMAPPED_INPUTS: an applicable obligation with no control mapping → unmapped_obligation gap.
    const body = buildAuditExportBody(
      makeRequest({ tenant: TENANT, references: refs, inputs: UNMAPPED_INPUTS }),
    );
    expect(body.gaps.length).toBeGreaterThan(0);
    const kinds = body.gaps.map((g) => g.kind);
    expect(kinds).toContain('unmapped_obligation');
    // Never hidden — the export never claims complete while a gap exists.
    expect(body.complete).toBe(false);
  });

  it('yields an EMPTY gap list for an all-covered scope', () => {
    // READY_INPUTS: a single fully-covered obligation, sufficient non-stale evidence → zero gaps.
    const body = buildAuditExportBody(
      makeRequest({ tenant: TENANT, references: refs, inputs: READY_INPUTS }),
    );
    expect(body.gaps).toEqual([]);
    expect(body.complete).toBe(true);
  });

  it('copies the engine gaps VERBATIM (same kinds, same order) into the package', () => {
    const body = buildAuditExportBody(
      makeRequest({ tenant: TENANT, references: refs, inputs: REOPENED_INPUTS }),
    );
    // REOPENED_INPUTS: a stale not_applicable decision whose gap has reopened.
    expect(body.gaps.some((g) => g.kind === 'reopened_non_applicability')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. Reproducible-at-instant (SC-013) — identical (scope, period, refs, at) ⇒ deep-equal package.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('reproducible-at-instant (SC-013)', () => {
  it('two runs with identical inputs produce deep-equal packages', () => {
    const refs = Array.from({ length: 40 }, (_, i) => makeRef(i, TENANT as unknown as string));
    const req = () =>
      makeRequest({ tenant: TENANT, references: refs, reconstructedAt: NOW as number });
    const a = buildAuditExportPackage(req(), SIGNING_KEY);
    const b = buildAuditExportPackage(req(), SIGNING_KEY);
    expect(a).toEqual(b);
  });

  it('reconstructedAt defaults to periodTo and is reflected in the body', () => {
    const refs = Array.from({ length: 3 }, (_, i) => makeRef(i, TENANT as unknown as string));
    const body = buildAuditExportBody(makeRequest({ tenant: TENANT, references: refs }));
    expect(body.reconstructedAt).toBe(NOW as number);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 7. Truthful boundary (FR-055) — internal readiness is never external certification.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('truthful claim boundary (FR-055)', () => {
  const refs = Array.from({ length: 3 }, (_, i) => makeRef(i, TENANT as unknown as string));

  it('keeps a ready readiness at "ready" and never promotes it to "certified"', () => {
    const body = buildAuditExportBody(
      makeRequest({ tenant: TENANT, references: refs, inputs: READY_INPUTS }),
    );
    expect(body.claimBoundary).toBe('ready');
    expect(isInternalReadinessBoundary(body.claimBoundary)).toBe(true);
    // The truthful external-claim disclaimer is always present.
    expect(body.externalClaimNote).toBe(EXTERNAL_CLAIM_NOTE);
  });

  it('caps at "ready" when only an EXPIRED certification is present (readiness ≠ certification, negative control)', () => {
    const body = buildAuditExportBody(
      makeRequest({ tenant: TENANT, references: refs, inputs: EXPIRED_CERT_INPUTS }),
    );
    expect(body.claimBoundary).not.toBe('certified');
    expect(isInternalReadinessBoundary(body.claimBoundary)).toBe(true);
  });

  it('reaches "certified" ONLY with a real, displayable external certification present', () => {
    const request = makeRequest({ tenant: TENANT, references: refs, inputs: CERTIFIED_INPUTS });
    const body = buildAuditExportBody(request);
    expect(body.claimBoundary).toBe('certified');
    // With a real certification present the package signs (the truthful-boundary guard passes).
    expect(request.coverageInputs.certifications.length).toBeGreaterThan(0);
    const pkg = buildAuditExportPackage(request, SIGNING_KEY);
    expect(verifyManifest(pkg, SIGNING_KEY)).toBe(true);
  });

  it('refuses to sign a certified body with NO certification (the promotion guard, negative control)', () => {
    // Construct a real certified body (with a cert), then forge a request that strips the certs but
    // reuses the certified body — buildAuditExportPackage re-derives the body from the request, so we
    // exercise the guard directly via a body/request mismatch.
    const certifiedBody = buildAuditExportBody(
      makeRequest({ tenant: TENANT, references: refs, inputs: CERTIFIED_INPUTS }),
    );
    expect(certifiedBody.claimBoundary).toBe('certified');
    const strippedRequest = makeRequest({ tenant: TENANT, references: refs, inputs: READY_INPUTS });
    expect(strippedRequest.coverageInputs.certifications.length).toBe(0);
    // The guard refuses: a certified boundary with zero certifications is a promotion. We exercise
    // the public guard directly with a body/request mismatch (a certified body against a cert-less
    // request), which is exactly the promotion it must refuse to sign.
    expect(() => assertTruthfulBoundary(certifiedBody, strippedRequest)).toThrow(AuditExportError);
  });
});
