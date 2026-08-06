// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — ADAPTER MANIFEST CONTRACT (T219 · FR-029 · FR-030 · NS-005 · SC-011).
//
// CONTRACT oracle for the manifest-first adapter contract (`@trustcircle/adapter-sdk` manifest module,
// packages/adapter-sdk/src/manifest.ts) driven over the FIVE REAL shipped named-adapter manifests
// (adapters/*/manifest.json, loaded via tests/fixtures/integrations.ts). The manifest is the ONE
// artifact the platform trusts to validate, sign, negotiate, and gate an adapter version. This suite
// pins every declared surface of that contract at each dangerous branch:
//
//   * VALIDATE — every shipped manifest is structurally + semantically valid (all required fields,
//     enum vocabularies, semver/id/sha256 patterns, ordered contract range, non-mutating health).
//   * SIGNATURES — a sealed manifest verifies; a tampered body / wrong key / unsigned FAILS.
//   * SCHEMAS — observation/command/result/health schema refs are present with sha256 digests.
//   * CONTRACT RANGE — negotiation REFUSES a protocol below-min / above-max (NS-005 version drift).
//   * CAPABILITIES — negotiation is a SUBSET (least privilege); an undeclared capability is REFUSED.
//   * AUTHORITY — a connector is NEVER authoritative for a governance approval; forbidden inferences
//     are declared and never grant authority.
//   * SECURITY — credentials are external-secret-reference only (no inline secret), scopes declared.
//   * DELIVERY / RETRY / RECONCILIATION / EVIDENCE / HEALTH / LIFECYCLE — each declared vocabulary is
//     validated against the closed enum sets.
//
// Every assertion pins a REAL SDK verdict over a REAL shipped manifest — never a re-implemented rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  validateManifest,
  assertManifest,
  signManifest,
  verifyManifestSignature,
  manifestDigest,
  negotiateContract,
  negotiateCapabilities,
  isMajorSupported,
  compareSemver,
  isSemver,
  ADAPTER_CAPABILITIES,
  OPERATION_RISK_CLASSES,
  ORDERING_MODELS,
  IDEMPOTENCY_MODES,
  RETRYABLE_CLASSES,
  TERMINAL_CLASSES,
  DRIFT_CLASSES,
  LIFECYCLE_STATUSES,
  type AdapterManifest,
  type AdapterCapability,
} from '@trustcircle/adapter-sdk';

import { NAMED_MANIFESTS } from '../fixtures/integrations.ts';

const ENTRIES = Object.entries(NAMED_MANIFESTS);
const SIGNING_KEY = 'contract-test-signing-key-0123456789';

describe('adapter-manifest contract · every shipped named manifest is valid', () => {
  it('loads exactly the five named adapters', () => {
    expect(ENTRIES.map(([k]) => k).sort()).toEqual(
      ['agentctl', 'kanban', 'lisa', 'wiggum', 'workflow-orchestration'],
    );
  });

  for (const [id, manifest] of ENTRIES) {
    describe(`manifest: ${id}`, () => {
      it('validates structurally + semantically (no issues)', () => {
        const result = validateManifest(manifest);
        expect(result.issues).toEqual([]);
        expect(result.valid).toBe(true);
        // assertManifest is the throwing narrowing form — it must not throw.
        expect(() => assertManifest(manifest)).not.toThrow();
      });

      it('declares its identity fields', () => {
        expect(manifest.adapter_id).toBe(id);
        expect(manifest.manifest_version).toBe('1.0.0');
        expect(isSemver(manifest.adapter_version)).toBe(true);
        expect(manifest.name.length).toBeGreaterThan(0);
        expect(manifest.vendor.length).toBeGreaterThan(0);
        expect(manifest.source_classes.length).toBeGreaterThan(0);
      });

      it('declares an ordered contract range', () => {
        expect(isSemver(manifest.contract_range.minimum)).toBe(true);
        expect(isSemver(manifest.contract_range.maximum)).toBe(true);
        expect(
          compareSemver(manifest.contract_range.minimum, manifest.contract_range.maximum),
        ).toBeLessThanOrEqual(0);
      });

      it('declares only closed-vocabulary capabilities (non-empty, unique)', () => {
        expect(manifest.capabilities.length).toBeGreaterThan(0);
        expect(new Set(manifest.capabilities).size).toBe(manifest.capabilities.length);
        for (const c of manifest.capabilities) {
          expect(ADAPTER_CAPABILITIES).toContain(c);
        }
      });

      it('declares authority WITHOUT granting a governance approval (never authoritative for approval)', () => {
        // A connector never decides governance — no authoritative field may name an approval/decision.
        for (const f of manifest.authority.authoritative_fields) {
          expect(f.toLowerCase()).not.toMatch(/\bapprov|\bdecision\b|\bgovernance_verdict\b/);
        }
        // forbidden_inferences must be declared and non-empty (the conclusions the adapter may NOT draw).
        expect(manifest.authority.forbidden_inferences.length).toBeGreaterThan(0);
        for (const [, risk] of Object.entries(manifest.authority.operation_risk)) {
          expect(OPERATION_RISK_CLASSES).toContain(risk);
        }
      });

      it('references credentials only by external secret reference (no inline secret)', () => {
        expect(manifest.security.credential_reference_mode).toBe('external_secret_reference');
        expect(Array.isArray(manifest.security.required_scopes)).toBe(true);
        // No key on security may hold a raw secret value.
        const secJson = JSON.stringify(manifest.security).toLowerCase();
        expect(secJson).not.toMatch(/"(password|token|secret_value|api_key|private_key)"\s*:/);
      });

      it('declares schema refs with sha256 digests for observation/command/result/health', () => {
        for (const key of ['observation', 'command', 'result', 'health'] as const) {
          const ref = manifest.schemas[key];
          expect(ref.uri.length).toBeGreaterThan(0);
          expect(isSemver(ref.version)).toBe(true);
          expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
      });

      it('declares delivery/retry/reconciliation vocabularies from the closed enum sets', () => {
        expect(ORDERING_MODELS).toContain(manifest.delivery.ordering);
        expect(IDEMPOTENCY_MODES).toContain(manifest.delivery.idempotency);
        for (const c of manifest.retry.retryable_classes) expect(RETRYABLE_CLASSES).toContain(c);
        for (const c of manifest.retry.terminal_classes) expect(TERMINAL_CLASSES).toContain(c);
        for (const d of manifest.reconciliation.drift_classes) expect(DRIFT_CLASSES).toContain(d);
      });

      it('declares evidence with a sha256 content hash and a chain of custody', () => {
        expect(manifest.evidence.content_hash).toBe('sha256');
        expect(typeof manifest.evidence.original_capture).toBe('boolean');
        expect(typeof manifest.evidence.result_capture).toBe('boolean');
        expect(typeof manifest.evidence.chain_of_custody).toBe('boolean');
      });

      it('declares a NON-MUTATING health surface with a positive freshness window', () => {
        expect(manifest.health.non_mutating).toBe(true);
        expect(manifest.health.freshness_seconds).toBeGreaterThanOrEqual(1);
        expect(manifest.health.endpoint.length).toBeGreaterThan(0);
        expect(manifest.health.readiness_endpoint.length).toBeGreaterThan(0);
        expect(manifest.health.owner_contact.length).toBeGreaterThan(0);
      });

      it('declares a lifecycle status from the closed set', () => {
        expect(LIFECYCLE_STATUSES).toContain(manifest.lifecycle.status);
        expect(typeof manifest.lifecycle.released_at).toBe('string');
      });

      it('signs + verifies over its canonical form; a tampered body fails', () => {
        const sealed = signManifest({ manifest, keyId: 'k1', signingKey: SIGNING_KEY });
        expect(sealed.manifest_digest).toBe(manifestDigest(manifest));
        expect(verifyManifestSignature(sealed, SIGNING_KEY)).toEqual({ valid: true });

        // Tampering the body (adapter_version) invalidates the digest.
        const tampered: AdapterManifest = { ...sealed, adapter_version: '99.0.0' };
        const tamperedResult = verifyManifestSignature(tampered, SIGNING_KEY);
        expect(tamperedResult.valid).toBe(false);

        // A wrong signing key fails signature verification.
        const wrongKey = verifyManifestSignature(sealed, 'the-wrong-key');
        expect(wrongKey).toEqual({ valid: false, reason: 'signature-mismatch' });

        // An unsigned manifest is 'unsigned'.
        expect(verifyManifestSignature(manifest, SIGNING_KEY)).toEqual({
          valid: false,
          reason: 'unsigned',
        });
      });

      it('refuses contract negotiation OUTSIDE the range (NS-005 version drift)', () => {
        const { minimum, maximum } = manifest.contract_range;
        // In-range negotiates.
        expect(negotiateContract(manifest, minimum)).toEqual({ ok: true, negotiated: minimum });
        expect(negotiateContract(manifest, maximum)).toEqual({ ok: true, negotiated: maximum });

        // Below the minimum is refused.
        const below = negotiateContract(manifest, '0.0.1');
        if (compareSemver('0.0.1', minimum) < 0) {
          expect(below.ok).toBe(false);
          if (!below.ok) expect(below.reason).toBe('below_minimum');
        }
        // Above the maximum is refused.
        const above = negotiateContract(manifest, '9999.0.0');
        expect(above.ok).toBe(false);
        if (!above.ok) expect(above.reason).toBe('above_maximum');
      });

      it('negotiates a capability SUBSET and REFUSES an undeclared capability (least privilege)', () => {
        // Requesting the full declared set yields exactly the declared set (order preserved).
        const all = negotiateCapabilities(manifest, manifest.capabilities);
        expect(all.ok).toBe(true);
        if (all.ok) expect([...all.enabled]).toEqual([...manifest.capabilities]);

        // An undeclared capability is REFUSED — never silently granted.
        const undeclared = (ADAPTER_CAPABILITIES as readonly AdapterCapability[]).find(
          (c) => !manifest.capabilities.includes(c),
        );
        if (undeclared) {
          const refused = negotiateCapabilities(manifest, [undeclared]);
          expect(refused.ok).toBe(false);
          if (!refused.ok) {
            expect(refused.reason).toBe('not_declared');
            expect(refused.offending).toContain(undeclared);
          }
        }
      });

      it('supports its declared contract majors and refuses a drifted major', () => {
        const min = Number(manifest.contract_range.minimum.split('.')[0]);
        const max = Number(manifest.contract_range.maximum.split('.')[0]);
        expect(isMajorSupported(manifest, min)).toBe(true);
        expect(isMajorSupported(manifest, max)).toBe(true);
        expect(isMajorSupported(manifest, max + 1)).toBe(false);
      });
    });
  }
});

describe('adapter-manifest contract · validator rejects malformed manifests (non-vacuity)', () => {
  const good = NAMED_MANIFESTS.kanban;

  it('rejects a non-object', () => {
    expect(validateManifest(null).valid).toBe(false);
    expect(validateManifest(42).valid).toBe(false);
  });

  it('rejects an inline secret in credential_reference_mode', () => {
    const bad = { ...good, security: { ...good.security, credential_reference_mode: 'inline' } };
    const r = validateManifest(bad);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === 'security.credential_reference_mode')).toBe(true);
  });

  it('rejects an inverted contract range', () => {
    const bad = { ...good, contract_range: { minimum: '3.0.0', maximum: '1.0.0' } };
    const r = validateManifest(bad);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === 'contract_range')).toBe(true);
  });

  it('rejects an unknown capability', () => {
    const bad = { ...good, capabilities: [...good.capabilities, 'not_a_capability'] };
    expect(validateManifest(bad).valid).toBe(false);
  });

  it('rejects a mutating health surface', () => {
    const bad = { ...good, health: { ...good.health, non_mutating: false } };
    const r = validateManifest(bad);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.path === 'health')).toBe(true);
  });
});
