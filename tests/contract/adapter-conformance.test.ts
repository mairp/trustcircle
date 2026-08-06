// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — ADAPTER CONFORMANCE MATRIX (T220 · FR-029 · NS-005 · SC-011).
//
// CONTRACT oracle for the LANGUAGE-NEUTRAL conformance runner + signed result manifest
// (`@trustcircle/adapter-sdk` conformance module, packages/adapter-sdk/src/conformance.ts). Before an
// adapter version may ACTIVATE, it must pass a fixed conformance suite that any implementation can be
// driven through via an injected `ConformanceProbe`. This suite pins the dangerous adapter invariants
// the matrix enforces, over the FIVE REAL shipped manifests:
//
//   * OVER-PRIVILEGE — a command using an undeclared capability is refused.
//   * PROTECTED CONTENT — a metadata_only adapter never returns protected content.
//   * TOMBSTONES — an archive/deletion is a tombstone, never a governance closure.
//   * ROLLBACK — a rollback restores the preimage and verifies it.
//   * HEALTH — the health endpoint is non-mutating and reports freshness.
//   * OLD/NEW OVERLAP — during a version overlap window both contract majors are honored.
//   * VERSION DRIFT (NS-005) — a drifted version echo is refused.
//   * IDEMPOTENCY / DEDUP (SC-011) — a retried command under one key yields exactly one effect.
//
// The proof is bidirectional: a HONEST probe passes every dimension; a probe that BREAKS one invariant
// fails EXACTLY that dimension (non-vacuity). The runner then seals a SIGNED result manifest whose
// digest binds the outcome — tamper it and verification fails.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  buildConformanceSuite,
  runConformance,
  sealConformanceResult,
  authorGuidedConnectorDefinition,
  verifyConformanceResult,
  manifestDigest,
  CONFORMANCE_DIMENSIONS,
  type ConformanceProbe,
  type ConformanceCase,
  type AdapterManifest,
  type GuidedConnectorDefinitionInput,
} from '@trustcircle/adapter-sdk';

import { NAMED_MANIFESTS } from '../fixtures/integrations.ts';

const SIGNING_KEY = 'conformance-test-key-abcdefghijklmnop';

/** An HONEST probe: every case observes exactly the expectation declared for it. */
function honestProbe(): ConformanceProbe {
  return async (kase: ConformanceCase) => ({ caseId: kase.id, observed: { ...kase.expect } });
}

/** A probe that BREAKS exactly one dimension (returns the opposite observable). */
function brokenProbe(brokenDimension: string): ConformanceProbe {
  return async (kase: ConformanceCase) => {
    if (kase.dimension !== brokenDimension) {
      return { caseId: kase.id, observed: { ...kase.expect } };
    }
    // Invert every expected key so the expectation cannot hold.
    const inverted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(kase.expect)) {
      inverted[k] = typeof v === 'boolean' ? !v : `broken:${String(v)}`;
    }
    return { caseId: kase.id, observed: inverted };
  };
}

describe('adapter conformance matrix · honest adapters pass every dimension', () => {
  for (const [id, manifest] of Object.entries(NAMED_MANIFESTS)) {
    it(`${id}: suite covers every named conformance dimension`, () => {
      const suite = buildConformanceSuite(manifest);
      const dims = new Set(suite.map((c) => c.dimension));
      for (const d of CONFORMANCE_DIMENSIONS) expect(dims.has(d)).toBe(true);
      // The over-privilege case names a capability the adapter genuinely does NOT declare.
      const overPriv = suite.find((c) => c.dimension === 'over_privilege');
      expect(overPriv).toBeDefined();
      const cap = overPriv!.action['capability'] as string;
      expect(manifest.capabilities as readonly string[]).not.toContain(cap);
    });

    it(`${id}: an honest probe passes the whole suite`, async () => {
      const outcome = await runConformance(manifest, honestProbe());
      expect(outcome.passed).toBe(true);
      expect(outcome.passedCount).toBe(outcome.total);
      expect(outcome.total).toBe(CONFORMANCE_DIMENSIONS.length);
      expect(outcome.verdicts.every((v) => v.passed)).toBe(true);
    });
  }
});

describe('adapter conformance matrix · breaking one invariant fails exactly that dimension (non-vacuity)', () => {
  const manifest: AdapterManifest = NAMED_MANIFESTS.kanban;

  for (const dimension of CONFORMANCE_DIMENSIONS) {
    it(`breaking '${dimension}' fails only that case`, async () => {
      const outcome = await runConformance(manifest, brokenProbe(dimension));
      expect(outcome.passed).toBe(false);
      const failed = outcome.verdicts.filter((v) => !v.passed);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.dimension).toBe(dimension);
      expect(outcome.passedCount).toBe(outcome.total - 1);
    });
  }
});

describe('adapter conformance matrix · signed result manifest is a verifiable activation gate', () => {
  const manifest = NAMED_MANIFESTS['workflow-orchestration']!;

  it('seals + verifies a passing result; tamper fails', async () => {
    const outcome = await runConformance(manifest, honestProbe());
    const sealed = sealConformanceResult({
      outcome,
      manifestDigest: manifestDigest(manifest),
      ranAt: 1_772_600_000_000,
      keyId: 'gate-key',
      signingKey: SIGNING_KEY,
    });
    expect(sealed.kind).toBe('adapter-conformance-result');
    expect(sealed.passed).toBe(true);
    expect(sealed.manifestDigest).toBe(manifestDigest(manifest));
    expect(verifyConformanceResult(sealed, SIGNING_KEY)).toEqual({ valid: true });

    // Tampering the recorded verdict count breaks the digest.
    const tampered = { ...sealed, passedCount: sealed.passedCount - 1 };
    expect(verifyConformanceResult(tampered, SIGNING_KEY).valid).toBe(false);

    // A wrong key fails signature verification.
    expect(verifyConformanceResult(sealed, 'other-key')).toEqual({
      valid: false,
      reason: 'signature-mismatch',
    });
  });

  it('a FAILED outcome seals honestly (passed:false) and still verifies', async () => {
    const outcome = await runConformance(manifest, brokenProbe('version_drift'));
    const sealed = sealConformanceResult({
      outcome,
      manifestDigest: manifestDigest(manifest),

      ranAt: 1_772_600_000_000,
      keyId: 'gate-key',
      signingKey: SIGNING_KEY,
    });
    expect(sealed.passed).toBe(false);
    expect(verifyConformanceResult(sealed, SIGNING_KEY)).toEqual({ valid: true });
  });
});

describe('Spec 004 guided connector authoring', () => {
  const baseManifest = NAMED_MANIFESTS.kanban;
  const unsignedManifest = {
    ...baseManifest,
    manifest_digest: undefined,
    signature: undefined,
  };
  const validInput: GuidedConnectorDefinitionInput = {
    id: '018f0000-0000-7000-8000-000000000801',
    authorPrincipalId: '018f0000-0000-7000-8000-000000000802',
    draftVersion: 1,
    manifest: unsignedManifest,
    mappingRefs: ['/connector-mappings/kanban-v1'],
    credentialClassRefs: ['oauth-client'],
    paginationPolicy: {
      mode: 'cursor',
      cursorField: 'next_cursor',
      maximumPageSize: 100,
    },
    failurePolicy: {
      correlation: 'required',
      idempotency: 'required',
      reconciliation: 'source_scoped',
      retry: 'bounded',
      replay: 'source_event_identity',
      terminalFailure: 'retained_for_reconciliation',
      revocation: 'block_new_work_reconcile_existing',
      migration: 'version_overlap',
      rollback: 'verified_preimage',
    },
    schemaVersion: 1,
  };

  it('generates the canonical existing manifest shape and binds guided policies into a digest', () => {
    const definition = authorGuidedConnectorDefinition(validInput);
    expect(definition.status).toBe('draft');
    expect(definition.authorPrincipalId).toBe(validInput.authorPrincipalId);
    expect(definition.manifest.adapter_id).toBe(baseManifest.adapter_id);
    expect(definition.manifest.manifest_digest).toBeUndefined();
    expect(definition.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(definition.failurePolicy.revocation).toBe('block_new_work_reconcile_existing');
    expect(definition.credentialClassRefs).toEqual(['oauth-client']);
  });

  it('rejects missing failure semantics, inline secrets, and invalid pagination before a manifest can be certified', () => {
    expect(() =>
      authorGuidedConnectorDefinition({
        ...validInput,
        failurePolicy: {
          ...validInput.failurePolicy,
          terminalFailure: '',
        },
      }),
    ).toThrow(/terminal.failure/i);
    expect(() =>
      authorGuidedConnectorDefinition({
        ...validInput,
        credentialSecret: 'must-never-enter-a-definition',
      } as GuidedConnectorDefinitionInput),
    ).toThrow(/secret|credential/i);
    expect(() =>
      authorGuidedConnectorDefinition({
        ...validInput,
        paginationPolicy: { ...validInput.paginationPolicy, maximumPageSize: 0 },
      }),
    ).toThrow(/page/i);
  });
});

describe('Spec 004 expanded conformance evidence', () => {
  it('covers every malformed, delayed, ordering, partial, authorization, rate, revocation, and terminal defect', () => {
    const dimensions = new Set(
      buildConformanceSuite(NAMED_MANIFESTS.kanban).map((kase) => kase.dimension),
    );
    for (const dimension of [
      'malformed',
      'delayed',
      'out_of_order',
      'partial_delivery',
      'unauthorized',
      'rate_limit',
      'revocation',
      'terminal_failure',
    ]) {
      expect(dimensions.has(dimension as never)).toBe(true);
    }
  });

  it('binds environment, fixtures, tools, case evidence, and run times into the signed report', async () => {
    const manifest = NAMED_MANIFESTS.kanban;
    const outcome = await runConformance(manifest, honestProbe(), '2.0.0');
    const sealed = sealConformanceResult({
      outcome,
      manifestDigest: manifestDigest(manifest),
      environmentDigest: 'a'.repeat(64),
      fixtureDigests: ['b'.repeat(64), 'c'.repeat(64)],
      toolVersions: { runner: '2.0.0', node: '22.0.0' },
      caseEvidenceRefs: outcome.verdicts.map((verdict) => ({
        caseId: verdict.caseId,
        evidenceRef: '/evidence/conformance/' + verdict.caseId,
      })),
      startedAt: 1_772_599_999_000,
      completedAt: 1_772_600_000_000,
      keyId: 'gate-key',
      signingKey: SIGNING_KEY,
    });
    expect(sealed.environmentDigest).toBe('a'.repeat(64));
    expect(sealed.fixtureDigests).toHaveLength(2);
    expect(sealed.toolVersions['runner']).toBe('2.0.0');
    expect(sealed.caseEvidenceRefs).toHaveLength(outcome.total);
    expect(sealed.startedAt).toBeLessThan(sealed.completedAt);
    expect(verifyConformanceResult(sealed, SIGNING_KEY)).toEqual({ valid: true });
  });
});
