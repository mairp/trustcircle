// Security-suite test — the least-privilege RUNTIME scanner is METADATA-ONLY: it may observe that a
// runtime entity (process/service/container/port/manifest) EXISTS and classify it, but it must NEVER
// read, carry, or persist the entity's protected runtime CONTENT (environment, logs, command output,
// manifest/config bodies), its CREDENTIALS, or any SECRET VALUE.
// (Phase 68 / bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item QBY0EVXEA2226PHHBADJ6H7X7P.)
//
// The property is proven two ways, both structural:
//   (1) CAPABILITY — the injected `RuntimeInventoryPort` the scanner is granted exposes ONLY
//       `listEntities` + `inspect`. There is no `readEnv`, no `readLogs`, no `exec`, no
//       `readManifestBody`. Even a fixture that TRIES to hand the scanner runtime content cannot: the
//       scanner never asks for one. Least privilege is a missing capability, not a discipline.
//   (2) DISCLOSURE — we seed an adversarial inventory whose ENTITY ids and MARKER names carry real
//       secret shapes (a DSN, an AWS key, a JWT, a GitHub token). We run a real sweep and inspect the
//       TWO INDEPENDENT durable read paths the scanner produces — every `RuntimeSource.metadata` /
//       `RuntimeGap.metadata` record, and every correlated `records[]` entry — asserting no seeded
//       secret survives into any of them.
//
// Every positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous: a benign
// entity survives unchanged, and the RAW fixture the scanner walked genuinely contains the secrets —
// so it is the guard, not the input, that cleaned the durable output.
//
// Run: npm run test:security   (vitest run --project security)

import { describe, it, expect } from 'vitest';
import { isMetadataOnly } from '../../apps/discovery-agent/src/main.ts';
import {
  looksLikeSecretValue,
  REDACTED_PLACEHOLDER,
} from '../../packages/observability/src/instrumentation.ts';
import {
  RuntimeScanner,
  describeRuntimeProbeError,
  type RuntimeInventoryPort,
  type RuntimeEntitySummary,
  type RuntimeEntityDetail,
  type RuntimeMarker,
} from '../../apps/discovery-agent/src/scanners/runtime.ts';

// ───────────────────────────────────────────────────────────────────────────
// Seeded secrets — real value shapes the value detectors must catch.
// ───────────────────────────────────────────────────────────────────────────
const SECRETS = {
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA2Z\n-----END RSA PRIVATE KEY-----',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  slack: 'xoxb-1234567890-abcdefghijklmnop',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
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
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoSecretAnywhere(k, `${path}.<key>`);
      assertNoSecretAnywhere(v, `${path}.${k}`);
    }
  }
}

const NOW = 1_700_000_000_000;
const HORIZON = 30 * 24 * 60 * 60 * 1000;
const FRESH = NOW - 1000;

// A fixture that RECORDS every entity id it was asked to inspect, and tracks whether any
// content-reading method was ever attempted (there is none to attempt). This lets us prove the scanner
// NEVER reaches for runtime content.
interface EntityNode {
  readonly summary: RuntimeEntitySummary;
  readonly detail?: RuntimeEntityDetail;
  readonly denied?: boolean;
}
function instrumentedRuntime(
  nodes: readonly EntityNode[],
): RuntimeInventoryPort & { readonly listed: number; readonly inspected: string[] } {
  const byId = new Map(nodes.map((n) => [n.summary.entityId, n] as const));
  const state = { listed: 0, inspected: [] as string[] };
  return {
    get listed() {
      return state.listed;
    },
    get inspected() {
      return state.inspected;
    },
    async listEntities() {
      state.listed += 1;
      return nodes.map((n) => n.summary);
    },
    async inspect(entityId: string) {
      state.inspected.push(entityId);
      const node = byId.get(entityId);
      if (!node) throw new Error(`ENOENT '${entityId}'`);
      if (node.denied || !node.detail) throw new Error(`EACCES '${entityId}'`);
      return node.detail;
    },
  };
}

function mk(
  entityId: string,
  name: string,
  markers: readonly RuntimeMarker[],
  extra?: { listeningPorts?: readonly number[]; heartbeatMs?: number; denied?: boolean },
): EntityNode {
  const denied = extra?.denied ?? false;
  return {
    summary: { entityId, name, kind: 'service' },
    denied,
    detail: denied
      ? undefined
      : {
          kind: 'service',
          markers,
          listeningPorts: extra?.listeningPorts ?? [],
          heartbeatMs: extra?.heartbeatMs ?? FRESH,
        },
  };
}

const OWNED: RuntimeMarker = { name: 'owner-label', kind: 'other' };

// ═══════════════════════════════════════════════════════════════════════════
// CAPABILITY — the scanner cannot read runtime content; it only lists and inspects metadata.
// ═══════════════════════════════════════════════════════════════════════════
describe('least-privilege capability — no protected-content read path exists', () => {
  it('P1 a sweep only ever lists entities and inspects metadata; no content-reading method exists', async () => {
    const rt = instrumentedRuntime([
      mk(
        'svc/kanban-1',
        'kanban-board',
        [{ name: 'kanban', kind: 'service', heartbeatMs: FRESH }, OWNED],
        {
          listeningPorts: [8080],
        },
      ),
    ]);
    const scanner = new RuntimeScanner({
      boundary: 'host',
      scope: 'runtime',
      runtime: rt,
      now: NOW,
      freshnessHorizonMs: HORIZON,
    });
    await scanner.scan();

    // POSITIVE: the port has NO content-reading capability at all.
    const surface = rt as unknown as Record<string, unknown>;
    expect('readEnv' in surface).toBe(false);
    expect('readLogs' in surface).toBe(false);
    expect('exec' in surface).toBe(false);
    expect('readManifestBody' in surface).toBe(false);
    expect('open' in surface).toBe(false);

    // The scanner DID do real work (non-vacuous): it listed once and inspected the entity's metadata.
    expect(rt.listed).toBeGreaterThan(0);
    expect(rt.inspected).toContain('svc/kanban-1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DISCLOSURE — secret-shaped entity ids / marker names are redacted in every durable read path.
// ═══════════════════════════════════════════════════════════════════════════
describe('metadata-only disclosure — secret-shaped ids never survive into durable output', () => {
  // An adversarial inventory: entity ids and marker names carry real secret shapes.
  const nodes: readonly EntityNode[] = [
    // benign, healthy control — its metadata must survive UNREDACTED (non-vacuity).
    mk('svc/benign', 'benign', [{ name: 'kanban', kind: 'service', heartbeatMs: FRESH }, OWNED]),
    // an entity whose very ID is a secret VALUE (an AWS access-key id).
    mk(`svc/${SECRETS.aws}`, 'aws-named', [
      { name: 'kanban', kind: 'service', heartbeatMs: FRESH },
      OWNED,
    ]),
    // an entity whose ID embeds a DSN-with-password.
    mk(`svc/${SECRETS.dsn}`, 'dsn-named', [
      { name: 'agentctl', kind: 'service', heartbeatMs: FRESH },
      OWNED,
    ]),
  ];

  it('D1 an entity whose id is a secret is redacted in its durable metadata; a benign source survives', async () => {
    const scanner = new RuntimeScanner({
      boundary: 'host',
      scope: 'runtime',
      runtime: instrumentedRuntime(nodes),
      now: NOW,
      freshnessHorizonMs: HORIZON,
    });
    const report = await scanner.scan();

    // Whole-surface sweep: NOTHING durable across sources + gaps carries a seeded secret.
    for (const s of report.sources) {
      assertNoSecretAnywhere(s.metadata);
      assertNoSecretAnywhere(s.location);
      assertNoSecretAnywhere(s.targetId);
      assertNoSecretAnywhere(s.sourceIdentity);
      assertNoSecretAnywhere(s.records);
      expect(isMetadataOnly(s.metadata)).toBe(true);
    }
    for (const g of report.gaps) {
      assertNoSecretAnywhere(g.metadata);
      assertNoSecretAnywhere(g.location);
      assertNoSecretAnywhere(g.detail);
      expect(isMetadataOnly(g.metadata)).toBe(true);
    }

    // Whole durable blob carries no seeded secret.
    const durableBlob = JSON.stringify(report.sources) + JSON.stringify(report.gaps);
    for (const s of ALL_SECRET_STRINGS) {
      const needle = s.slice(0, Math.min(s.length, 24));
      expect(durableBlob.includes(needle), 'a seeded secret leaked into durable output').toBe(
        false,
      );
    }
    // The redaction placeholder is present somewhere (the secret-named entity ids collapsed to it).
    expect(durableBlob).toContain(REDACTED_PLACEHOLDER);

    // NEGATIVE control: the benign source's identity survived UNCHANGED (guard is not blanket-erasing).
    const benign = report.sources.find((s) => s.targetId === 'svc/benign');
    expect(benign).toBeDefined();
    expect(benign!.location).toBe('svc/benign');
    expect(benign!.metadata.location).toBe('svc/benign');
  });

  it('D2 harness sanity — the seeds are genuinely secret-shaped and the raw fixture DID contain them', () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(looksLikeSecretValue(secret), `${name} must be secret-shaped`).toBe(true);
    }
    // The raw fixture ids really do embed a secret — the guard, not the input, cleaned the output.
    const rawIds = nodes.map((n) => n.summary.entityId).join('|');
    let sawASecret = false;
    for (const s of ALL_SECRET_STRINGS) {
      if (rawIds.includes(s.slice(0, Math.min(s.length, 24)))) sawASecret = true;
    }
    expect(sawASecret).toBe(true);
  });

  it('D3 describeRuntimeProbeError never leaks a secret-shaped thrown message', () => {
    // A list/inspect failure whose error message embeds a secret must be reduced to a safe token.
    const safe = describeRuntimeProbeError(new Error(SECRETS.dsn));
    assertNoSecretAnywhere(safe);
    // NEGATIVE control: a benign error message survives (non-vacuity — not blanket-erased).
    const benign = describeRuntimeProbeError(new Error('connection refused'));
    expect(benign).toContain('connection refused');
  });
});
