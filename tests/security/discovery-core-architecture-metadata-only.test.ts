// Security-suite test — the CORE-ARCHITECTURE candidate classifier is METADATA-ONLY and NEVER
// ONBOARDS. It may propose an architecture role + availability class for a discovered candidate, but
// it must NEVER (a) carry or persist a candidate's protected CONTENT / CREDENTIALS / SECRET VALUE into
// any durable record, nor (b) register / onboard the candidate as a governed source.
// (Phase 69 / task T069 / bundle 36GCYGDJ15PTYP60F91QWRAY2M.)
//
// The property is proven three ways, all structural:
//   (1) NO-ONBOARD — every durable record the classifier emits has `registered: false`, `onboarding`
//       in {discovered, gap} (never `registered`), and every placed candidate carries
//       `ownerApprovalRequired: true`. An axis placement is advice, never a forged owner-approved
//       profile. Least authority is a hard flag, not a discipline.
//   (2) DISCLOSURE — we seed adversarial candidate IDENTITIES / LOCATIONS carrying real secret shapes
//       (a PEM, an AWS key, a DSN, a JWT). We run a real classification pass and inspect the durable
//       read paths (`ArchitectureCandidate.metadata`, `ArchitectureGap.metadata`) asserting no seeded
//       secret survives, and that `isMetadataOnly` holds for every record.
//   (3) CAPABILITY — the classifier's INPUT is `DiscoveredCandidate`, whose shape is name + identity +
//       location + owner-reference + observation time. There is no content/credential field to read;
//       the classifier is structurally incapable of carrying a body.
//
// Every positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous: a benign id
// survives unchanged, and the RAW input genuinely contained the secrets — so it is the guard, not the
// input, that produced clean durable output.
//
// Run: npm run test:security   (vitest run --project security)

import { describe, it, expect } from 'vitest';
import { isMetadataOnly } from '../../apps/discovery-agent/src/main.ts';
import {
  looksLikeSecretValue,
  REDACTED_PLACEHOLDER,
} from '../../packages/observability/src/instrumentation.ts';
import {
  classifyDiscoveries,
  safeCandidateId,
  type DiscoveredCandidate,
  type CoreArchitectureClassifyOptions,
} from '../../apps/discovery-agent/src/classifiers/core-architecture.ts';

// ───────────────────────────────────────────────────────────────────────────
// Seeded secrets — real value shapes the value detectors must catch.
// ───────────────────────────────────────────────────────────────────────────
const SECRETS = {
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA2Z\n-----END RSA PRIVATE KEY-----',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  dsn: 'postgres://appuser:sup3rSecret@db.internal:5432/trustcircle',
} as const;
const ALL_SECRET_STRINGS: readonly string[] = Object.values(SECRETS);

function assertNoSecretAnywhere(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    for (const s of ALL_SECRET_STRINGS) {
      const needle = s.slice(0, Math.min(s.length, 24));
      expect(value.includes(needle), `secret leaked at ${path}: ${value}`).toBe(false);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretAnywhere(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertNoSecretAnywhere(v, `${path}.${k}`);
  }
}

const NOW = 1_800_000_000_000;
const OPTS: CoreArchitectureClassifyOptions = {
  scope: 'machine:acme',
  now: NOW,
  freshnessHorizonMs: 60 * 60 * 1000,
};

// ═══════════════════════════════════════════════════════════════════════════
describe('NO-ONBOARD — the classifier proposes but never registers/onboards a candidate', () => {
  it('every durable record is registered:false and onboarding is never "registered"', () => {
    const discoveries: DiscoveredCandidate[] = [
      {
        classification: 'lisa',
        identity: 'id:lisa',
        location: 'adapters/lisa',
        owner: 'declared-by:OWNERS',
        lastObservedAt: NOW - 1000,
      },
      {
        classification: 'wiggum',
        identity: 'id:wiggum',
        location: 'adapters/wiggum',
        owner: 'declared-by:OWNERS',
        lastObservedAt: NOW - 1000,
      },
      {
        classification: 'unknown',
        identity: 'id:mystery',
        location: 'srv/mystery',
        owner: null,
        lastObservedAt: NOW - 1000,
      },
    ];
    const rep = classifyDiscoveries(discoveries, OPTS);

    for (const c of rep.candidates) {
      expect(c.registered).toBe(false);
      expect(c.onboarding).toBe('discovered');
      expect(c.ownerApprovalRequired).toBe(true);
      expect(c.metadata.registered).toBe(false);
      expect(['discovered', 'gap']).toContain(c.metadata.onboarding);
      expect(c.metadata.onboarding).not.toBe('registered');
    }
    for (const g of rep.gaps) {
      expect(g.metadata.registered).toBe(false);
      expect(g.metadata.onboarding).toBe('gap');
    }
    // We really did classify something (non-vacuous): at least the two core candidates + one gap.
    expect(rep.candidates.length).toBeGreaterThanOrEqual(2);
    expect(rep.gaps.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('DISCLOSURE — no seeded secret survives into any durable record', () => {
  const adversarial: DiscoveredCandidate[] = [
    // A benign LISA whose LOCATION segment is a DSN, and whose IDENTITY carries an AWS key.
    {
      classification: 'lisa',
      identity: `id:lisa/${SECRETS.aws}`,
      location: `adapters/${SECRETS.dsn}/lisa`,
      owner: 'declared-by:OWNERS',
      lastObservedAt: NOW - 1000,
    },
    // An unknown candidate whose identity is a PEM and location a JWT — becomes a gap; still clean.
    {
      classification: 'unknown',
      identity: `id:${SECRETS.pem}`,
      location: `srv/${SECRETS.jwt}`,
      owner: null,
      lastObservedAt: NOW - 1000,
    },
  ];

  it('seed sanity: the RAW inputs genuinely contain detectable secret shapes', () => {
    // The guard, not the input, must be what cleans the output — so the input must be dirty.
    expect(looksLikeSecretValue(adversarial[0]!.location)).toBe(true);
    expect(looksLikeSecretValue(adversarial[1]!.identity)).toBe(true);
  });

  it('no candidate/gap durable record leaks a seeded secret; every record isMetadataOnly', () => {
    const rep = classifyDiscoveries(adversarial, OPTS);
    for (const c of rep.candidates) {
      expect(isMetadataOnly(c.metadata)).toBe(true);
      assertNoSecretAnywhere(c.metadata, 'candidate.metadata');
      assertNoSecretAnywhere(c.candidateId, 'candidate.candidateId');
      assertNoSecretAnywhere(c.location, 'candidate.location');
    }
    for (const g of rep.gaps) {
      expect(isMetadataOnly(g.metadata)).toBe(true);
      assertNoSecretAnywhere(g.metadata, 'gap.metadata');
      assertNoSecretAnywhere(g.candidateId, 'gap.candidateId');
      assertNoSecretAnywhere(g.location, 'gap.location');
      assertNoSecretAnywhere(g.detail, 'gap.detail');
    }
  });

  it('safeCandidateId redacts a secret-shaped segment but preserves a benign one (non-vacuous)', () => {
    // Positive: a DSN-shaped segment is redacted.
    const redacted = safeCandidateId(`adapters/${SECRETS.dsn}/lisa`);
    expect(redacted.includes(SECRETS.dsn)).toBe(false);
    expect(redacted).toContain(REDACTED_PLACEHOLDER);
    // NEGATIVE control: a benign id is returned UNCHANGED — the guard is not blanket-redacting.
    expect(safeCandidateId('adapters/lisa')).toBe('adapters/lisa');
    expect(safeCandidateId('id:kanban')).toBe('id:kanban');
  });
});
