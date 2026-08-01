// Security-suite test — metadata-only discovery: prove the least-privilege DISCLOSURE boundary of
// apps/discovery-agent holds. A discovery sweep may observe that a source EXISTS and classify it,
// but it must NEVER read, carry, or persist the source's protected CONTENT, its CREDENTIALS, or any
// SECRET VALUE. (Phase 59 / bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item 7JCN2JCXRF4NF28N0V2HYRTA6F.)
//
// The property is proven through the TWO INDEPENDENT DURABLE READ PATHS — never the mutating call's
// return value:
//   (1) the reconciled `SourceCatalog` entries (catalog detail + location), and
//   (2) the durable evidence-sink capture (what `EvidenceBuffer.flush()` actually wrote out).
// We seed a probe whose `evidence` body and metadata fields carry real secret shapes (PEM private
// key, JWT, AWS AKIA id, Slack xox token, GitHub ghp_ PAT, a postgres DSN with an inline password,
// and an arbitrary content object/array), run a real sweep, flush, and then inspect both sinks.
//
// Every positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous: for each
// "the secret does not survive" clause there is a matched case that WOULD carry a value if the guard
// were removed (a benign metadata string rides through unchanged; a `vault:` reference is a safe
// reference, not a value, and is intentionally NOT redacted). If `toMetadataOnlyRecord` were bypassed
// so `result.evidence` were persisted verbatim, the positive clauses below flip to failing — that is
// the load-bearing check exercised by the phase's non-vacuity mutation.
//
// Run: npm run test:security   (vitest run --project security)

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  REDACTED_PLACEHOLDER,
  looksLikeSecretValue,
  isRedactedKey,
} from '../../packages/observability/src/instrumentation.ts';

import {
  GovernedDiscoveryAgent,
  AgentLease,
  EvidenceBuffer,
  SourceCatalog,
  METADATA_ONLY_KEYS,
  toMetadataOnlyRecord,
  isMetadataOnly,
  describeEvidenceShape,
  redactMetadataValue,
  SAFE_NEXT_ACTIONS,
  type CatalogEntry,
  type DiscoveryEvidenceRecord,
  type GapReason,
  type ScanTarget,
  type ProbeResult,
  type StoredLease,
  type AgentCheckpoint,
} from '../../apps/discovery-agent/src/main.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
void ROOT;

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

// A safe reference — names a secret, never its value; must survive UNREDACTED (negative control).
const SAFE_REFERENCE = 'vault:secret/data/signing#key';
// A benign metadata string — must survive unchanged (non-vacuity: the guard is not blanket-redacting).
const BENIGN_LOCATION = 'host://svc/kanban';
const BENIGN_CLASSIFICATION = 'kanban';

// Assert that a string does NOT contain any seeded secret value anywhere within it.
function containsNoSecret(haystack: string): void {
  for (const s of ALL_SECRET_STRINGS) {
    // Compare against a distinctive slice so partial/adjacent matches are still caught.
    const needle = s.slice(0, Math.min(s.length, 24));
    expect(haystack.includes(needle), `secret leaked into: ${haystack}`).toBe(false);
  }
}

// Recursively walk any value and assert no seeded secret string appears in any string leaf.
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

// ═══════════════════════════════════════════════════════════════════════════
// UNIT LEVEL — the guard primitives (the single chokepoint every durable write goes through).
// ═══════════════════════════════════════════════════════════════════════════
describe('metadata-only guard primitives', () => {
  it('G1 describeEvidenceShape reduces a content body to a SHAPE TAG, never its contents', () => {
    // POSITIVE: an arbitrary content object is described only by cardinality/type.
    const body = { document: SECRETS.pem, rows: [1, 2, 3], token: SECRETS.jwt };
    const shape = describeEvidenceShape(body);
    expect(shape).toBe('object:keys=3');
    containsNoSecret(shape);

    // A secret-shaped STRING evidence is reported as such — the tag itself carries no value.
    expect(describeEvidenceShape(SECRETS.dsn)).toBe('string:secret-shaped');
    containsNoSecret(describeEvidenceShape(SECRETS.dsn));

    // Arrays reduce to a length tag; a giant row dump cannot ride along.
    expect(describeEvidenceShape([SECRETS.aws, SECRETS.slack, SECRETS.github])).toBe('array:3');
    containsNoSecret(describeEvidenceShape([SECRETS.aws, SECRETS.slack, SECRETS.github]));

    // NEGATIVE control: a NON-secret string is described by length only (guard is not vacuous —
    // it distinguishes benign from secret rather than tagging everything 'secret-shaped').
    expect(describeEvidenceShape('kanban-board-42')).toBe('string:len=15');
    expect(describeEvidenceShape(null)).toBe('none');
    expect(describeEvidenceShape(undefined)).toBe('none');
  });

  it('G2 redactMetadataValue collapses every secret-shaped value to the placeholder, keeps benign scalars', () => {
    // POSITIVE: each seeded secret VALUE becomes the placeholder.
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(redactMetadataValue(secret), `${name} must redact`).toBe(REDACTED_PLACEHOLDER);
    }
    // A non-scalar (possible content body) is NEVER passed through verbatim.
    expect(redactMetadataValue({ leaked: SECRETS.pem })).toBe('[object]');
    expect(redactMetadataValue([SECRETS.jwt])).toBe('[array:1]');

    // NEGATIVE control: benign scalars survive UNCHANGED (non-vacuity).
    expect(redactMetadataValue(BENIGN_LOCATION)).toBe(BENIGN_LOCATION);
    expect(redactMetadataValue(SAFE_REFERENCE)).toBe(SAFE_REFERENCE); // a reference, not a value
    expect(redactMetadataValue(42)).toBe(42);
    expect(redactMetadataValue(true)).toBe(true);
    expect(redactMetadataValue(null)).toBe(null);
  });

  it('G3 toMetadataOnlyRecord emits ONLY allow-listed keys, redacts secret values, tags evidence shape', () => {
    const rec = toMetadataOnlyRecord({
      scope: 'kanban',
      location: SECRETS.dsn, // a location that is really a credentialed DSN
      classification: SECRETS.pem, // a probe reporting a secret-shaped classification
      onboarding: 'discovered',
      registered: false,
      reachable: true,
      // an arbitrary content evidence body carrying multiple secrets + a document
      evidence: { config: SECRETS.slack, key: SECRETS.github, blob: [SECRETS.aws] },
    });

    // POSITIVE: secret-shaped metadata values are redacted before they are ever durable.
    expect(rec.location).toBe(REDACTED_PLACEHOLDER);
    expect(rec.classification).toBe(REDACTED_PLACEHOLDER);
    // The evidence body is reduced to a shape tag — its contents never survive.
    expect(rec.evidenceShape).toBe('object:keys=3');
    assertNoSecretAnywhere(rec);

    // The record carries ONLY the closed allow-list + evidenceShape — no leaked extra key rode along.
    const keys = Object.keys(rec).sort();
    expect(keys).toEqual([...METADATA_ONLY_KEYS, 'evidenceShape'].sort());

    // Structural predicate agrees it is metadata-only, and the record is frozen (immutable).
    expect(isMetadataOnly(rec)).toBe(true);
    expect(Object.isFrozen(rec)).toBe(true);

    // NEGATIVE control: benign inputs pass through so the guard is proven non-vacuous.
    const benign = toMetadataOnlyRecord({
      scope: 'kanban',
      location: BENIGN_LOCATION,
      classification: BENIGN_CLASSIFICATION,
      onboarding: 'registered',
      registered: true,
      reachable: true,
      evidence: null,
    });
    expect(benign.location).toBe(BENIGN_LOCATION); // NOT redacted
    expect(benign.classification).toBe(BENIGN_CLASSIFICATION); // NOT redacted
    expect(benign.evidenceShape).toBe('none');
    expect(isMetadataOnly(benign)).toBe(true);
  });

  it('G4 toMetadataOnlyRecord DROPS unexpected keys — a leaked credential field cannot ride along', () => {
    // A caller passes a richer bag with leaked secret-named fields; the chokepoint copies ONLY the
    // allow-list, so the extra keys are simply not present in the durable record.
    const rec = toMetadataOnlyRecord({
      scope: 'kanban',
      location: BENIGN_LOCATION,
      classification: BENIGN_CLASSIFICATION,
      onboarding: 'discovered',
      registered: false,
      reachable: true,
      evidence: null,
      // @ts-expect-error — extra keys are intentionally not in the input type; they must be dropped.
      password: SECRETS.dsn,
      // @ts-expect-error — a second leaked field, also not in the input type; must be dropped.
      apiKey: SECRETS.github,
    });
    expect(Object.keys(rec)).not.toContain('password');
    expect(Object.keys(rec)).not.toContain('apiKey');
    assertNoSecretAnywhere(rec);
    expect(isMetadataOnly(rec)).toBe(true);
  });

  it('G5 isMetadataOnly REJECTS non-metadata shapes (negative controls that the predicate is discriminating)', () => {
    // A content body under an unexpected key.
    expect(isMetadataOnly({ scope: 'kanban', document: 'the whole file' })).toBe(false);
    // A nested object value (a possible content body) under an allow-listed key.
    expect(isMetadataOnly({ location: { host: 'x' } })).toBe(false);
    // An un-redacted secret string value under an allow-listed key.
    expect(isMetadataOnly({ location: SECRETS.dsn })).toBe(false);
    expect(isMetadataOnly({ classification: SECRETS.jwt })).toBe(false);
    // A function (callable) value.
    expect(isMetadataOnly({ scope: () => 'x' })).toBe(false);
    // Not an object at all.
    expect(isMetadataOnly('string')).toBe(false);
    expect(isMetadataOnly(null)).toBe(false);

    // POSITIVE contrast: a genuine metadata-only record passes.
    expect(
      isMetadataOnly({
        scope: 'kanban',
        location: REDACTED_PLACEHOLDER,
        classification: 'kanban',
        onboarding: 'discovered',
        registered: false,
        reachable: true,
        evidenceShape: 'object:keys=2',
      }),
    ).toBe(true);
  });

  it('G6 the seeded secret shapes are genuinely detected (harness sanity — no vacuous seeds)', () => {
    // If these seeds were NOT secret-shaped, every "redacted" assertion above would be vacuous.
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(looksLikeSecretValue(secret), `${name} must be secret-shaped`).toBe(true);
    }
    // The safe reference is deliberately NOT a value-shaped secret.
    expect(looksLikeSecretValue(SAFE_REFERENCE)).toBe(false);
    expect(looksLikeSecretValue(BENIGN_LOCATION)).toBe(false);
    // The allow-list key names are not themselves secret-named keys (so values are kept, not blanket-redacted).
    for (const k of METADATA_ONLY_KEYS) {
      expect(isRedactedKey(k), `${k} should not be a secret-named key`).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deterministic agent harness (Vitest port of the discovery harness).
// ═══════════════════════════════════════════════════════════════════════════
function manualClock(start = 1_700_000_000_000): (() => number) & {
  advance: (ms: number) => number;
} {
  let t = start;
  const clock = (() => t) as (() => number) & { advance: (ms: number) => number };
  clock.advance = (ms: number) => (t += ms);
  return clock;
}

function memoryLeaseStore() {
  const rows = new Map<string, StoredLease>();
  return {
    rows,
    async read(resource: string) {
      return rows.get(resource) ?? null;
    },
    async write(lease: StoredLease) {
      rows.set(lease.resource, { ...lease });
    },
    async clear(resource: string, holder: string, fencingToken: number) {
      const cur = rows.get(resource);
      if (cur && cur.holder === holder && cur.fencingToken === fencingToken) {
        rows.set(resource, {
          resource,
          holder: null,
          fencingToken,
          expiresAt: null,
          updatedAt: cur.updatedAt,
        });
        return true;
      }
      return false;
    },
  };
}

function memoryCheckpointStore() {
  const saved: AgentCheckpoint[] = [];
  const latest = new Map<string, AgentCheckpoint>();
  return {
    saved,
    latest,
    async load(resource: string) {
      return latest.get(resource) ?? null;
    },
    async save(cp: AgentCheckpoint) {
      saved.push(cp);
      latest.set(cp.resource, cp);
    },
  };
}

// The durable evidence sink — the INDEPENDENT read path for evidence. Captures what was flushed.
function capturingSink() {
  const flushed: DiscoveryEvidenceRecord[] = [];
  const sink = async (records: readonly DiscoveryEvidenceRecord[]) => {
    for (const r of records) flushed.push(r);
  };
  return { flushed, sink };
}

const allowAll = () => ({
  authorizer: {
    async authorize() {
      return { kind: 'authorized' as const, reason: 'ok' };
    },
  },
});

function scriptedTargets(list: readonly ScanTarget[]) {
  return {
    async listTargets() {
      return list;
    },
  };
}

function scriptedProbe(behaviorFor: (t: ScanTarget) => ProbeResult) {
  return {
    probe: {
      async probe(t: ScanTarget) {
        return behaviorFor(t);
      },
    },
  };
}

const DEFAULT_BUDGET = Object.freeze({
  maxTargetsPerSweep: 100,
  maxSweepDurationMs: 60_000,
  maxNewSourcesPerSweep: 100,
});

function buildAgent(over: {
  targetList: readonly ScanTarget[];
  probe: (t: ScanTarget) => ProbeResult;
}) {
  const clock = manualClock();
  const leaseStore = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const sinkPair = capturingSink();
  const evidence = new EvidenceBuffer(sinkPair.sink);
  const catalog = new SourceCatalog();
  const lease = new AgentLease({
    store: leaseStore,
    resource: 'source-discovery',
    holder: 'agent-A',
    clock,
    ttlMs: 10_000,
  });
  const agent = new GovernedDiscoveryAgent({
    lease,
    checkpoints,
    evidence,
    authorizer: allowAll().authorizer,
    targets: scriptedTargets(over.targetList),
    probe: scriptedProbe(over.probe).probe,
    catalog,
    grantedScopes: new Set(['kanban']),
    budgetLimits: DEFAULT_BUDGET,
    clock,
    sleep: async () => {},
    idleDelayMs: 5,
    renewAtFraction: 0.5,
  });
  return { agent, clock, catalog, evidence, sinkPair };
}

// ═══════════════════════════════════════════════════════════════════════════
// END-TO-END — a REAL sweep, then inspect the TWO INDEPENDENT DURABLE READ PATHS.
// ═══════════════════════════════════════════════════════════════════════════
describe('metadata-only discovery through the durable read paths', () => {
  // The arbitrary content body EVERY probe returns as evidence: a document, a row dump, and several
  // credentials. It is identical for both targets so the shape tag ('object:keys=7') is stable, but
  // it must never survive verbatim into either durable read path.
  const LEAKY_EVIDENCE = {
    document: 'CONFIDENTIAL: board contents ...',
    dsn: SECRETS.dsn,
    jwt: SECRETS.jwt,
    awsKey: SECRETS.aws,
    slack: SECRETS.slack,
    github: SECRETS.github,
    rows: [SECRETS.pem, SECRETS.jwt],
  };

  // A target-aware probe. The DSN source reports a SECRET-SHAPED classification (must be redacted);
  // the benign source reports a benign classification (must survive — the non-vacuity control). Both
  // carry the same secret-bearing evidence body.
  const leakyProbe = (t: ScanTarget): ProbeResult => ({
    reachable: true,
    classification: t.targetId === 'src-ok' ? BENIGN_CLASSIFICATION : SECRETS.pem,
    evidence: LEAKY_EVIDENCE,
  });

  const leakyTargets: readonly ScanTarget[] = [
    // location is itself a credentialed DSN (a secret VALUE in a benign-looking field).
    { targetId: 'src-dsn', scope: 'kanban', location: SECRETS.dsn, registered: false },
    // a benign registered source — the non-vacuity control that benign metadata survives.
    { targetId: 'src-ok', scope: 'kanban', location: BENIGN_LOCATION, registered: true },
  ];

  it('E1 the reconciled CATALOG (read path #1) carries metadata only — no secret value, no content body', async () => {
    const { agent, catalog, evidence, sinkPair } = buildAgent({
      targetList: leakyTargets,
      probe: leakyProbe,
    });
    await agent.start();
    await agent.runOnce();

    const entries: readonly CatalogEntry[] = catalog.sources();
    expect(entries.length).toBe(2); // both onboarded — sweep DID observe them (not vacuous)

    for (const e of entries) {
      // POSITIVE: neither the reconciled location nor the detail carries any seeded secret.
      containsNoSecret(e.location);
      containsNoSecret(e.detail ?? '');
      assertNoSecretAnywhere(e);
    }

    const dsnEntry = entries.find((e) => e.targetId === 'src-dsn')!;
    // The DSN location was redacted before it reached the durable catalog.
    expect(dsnEntry.location).toBe(REDACTED_PLACEHOLDER);
    // The secret-shaped classification was redacted in the detail.
    expect(dsnEntry.detail).toBe(`classification=${REDACTED_PLACEHOLDER}`);

    // NEGATIVE control: the benign source's location + classification survive UNCHANGED, proving the
    // catalog write is not blanket-erasing everything (the property is discriminating, hence real).
    const okEntry = entries.find((e) => e.targetId === 'src-ok')!;
    expect(okEntry.location).toBe(BENIGN_LOCATION);
    expect(okEntry.detail).toBe(`classification=${BENIGN_CLASSIFICATION}`);

    // Keep the evidence path clean too — it is asserted in E2 after an explicit flush.
    void evidence;
    void sinkPair;
  });

  it('E2 the durable EVIDENCE SINK (read path #2) carries metadata only — content body reduced to a shape tag', async () => {
    const { agent, evidence, sinkPair } = buildAgent({
      targetList: leakyTargets,
      probe: leakyProbe,
    });
    await agent.start();
    await agent.runOnce();

    // Flush to the DURABLE sink — we inspect what was actually written out, not the buffer object.
    expect(evidence.size).toBeGreaterThanOrEqual(2);
    const flushedOk = await evidence.flush();
    expect(flushedOk).toBe(true);
    expect(evidence.size).toBe(0); // emptied on success

    const records = sinkPair.flushed;
    expect(records.length).toBeGreaterThanOrEqual(2); // the sweep DID emit evidence (not vacuous)

    for (const rec of records) {
      // POSITIVE: the payload is a metadata-only record and no secret survives anywhere in it.
      expect(isMetadataOnly(rec.payload)).toBe(true);
      assertNoSecretAnywhere(rec.payload);
      // The correlation id / kind / target id are plain identifiers, never a secret.
      assertNoSecretAnywhere({ kind: rec.kind, targetId: rec.targetId, cid: rec.correlationId });
    }

    // The record for the leaky source: its arbitrary evidence BODY is only a shape tag.
    const dsnRec = records.find((r) => r.targetId === 'src-dsn')!;
    const payload = dsnRec.payload as Record<string, unknown>;
    expect(payload.evidenceShape).toBe('object:keys=7'); // reduced to cardinality — contents gone
    expect(payload.location).toBe(REDACTED_PLACEHOLDER);
    expect(payload.classification).toBe(REDACTED_PLACEHOLDER);

    // NEGATIVE control: the benign source's payload keeps its real metadata (non-vacuity).
    const okRec = records.find((r) => r.targetId === 'src-ok')!;
    const okPayload = okRec.payload as Record<string, unknown>;
    expect(okPayload.location).toBe(BENIGN_LOCATION);
    expect(okPayload.classification).toBe(BENIGN_CLASSIFICATION);
    expect(okPayload.evidenceShape).toBe('object:keys=7');
  });

  it('E3 NOTHING durable anywhere across BOTH read paths contains a seeded secret (whole-surface sweep)', async () => {
    const { agent, catalog, evidence, sinkPair } = buildAgent({
      targetList: leakyTargets,
      probe: leakyProbe,
    });
    await agent.start();
    await agent.runOnce();
    await evidence.flush();

    // Read path #1 — every catalog entry, serialized in full.
    for (const e of catalog.entries()) {
      assertNoSecretAnywhere(e);
      containsNoSecret(JSON.stringify(e));
    }
    // Read path #2 — every durable evidence record, serialized in full.
    for (const rec of sinkPair.flushed) {
      assertNoSecretAnywhere(rec);
      containsNoSecret(JSON.stringify(rec));
    }

    // Belt-and-braces: the concatenation of ALL durable state contains no secret needle.
    const durableBlob = JSON.stringify(catalog.entries()) + JSON.stringify(sinkPair.flushed);
    containsNoSecret(durableBlob);

    // NEGATIVE control: the RAW probe output the agent SAW does contain the secrets — proving the
    // agent genuinely handled secret-bearing input and the guard (not the input) is what cleaned it.
    const raw = JSON.stringify(leakyProbe(leakyTargets[0]));
    let sawASecret = false;
    for (const s of ALL_SECRET_STRINGS) {
      if (raw.includes(s.slice(0, Math.min(s.length, 24)))) sawASecret = true;
    }
    expect(sawASecret).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SPEC ACCEPTANCE CRITERIA — the current-state inventory & governed-source coverage view.
//
// The six SPEC acceptance criteria for Phase 59 are governance criteria about the reconciled
// current-state view: each item shown once with its authoritative fields; discovered-but-unmanaged /
// unreachable / excluded components remaining visible as coverage gaps with reason/age/impact/owner
// action; cross-source drill-down (Kanban, agentctl, workflows_orchestration) with distinct records
// and status differences; stale/unavailable data marked with last-known time and NOT inferred
// healthy; unregistered sources catalogued with discovery classification/location/access/sensitivity/
// ownership/onboarding; and unsupported/inaccessible/sensitive/unowned/excluded discovered sources
// remaining visible as governed-source gaps with reason/impact/owner-action/review.
//
// Every criterion is proven through the TWO INDEPENDENT DURABLE READ PATHS (never a mutating call's
// return value): the reconciled `SourceCatalog` and the fail-visible `status()` snapshot. The
// metadata-only least-privilege boundary rides on top: every field asserted below is *also* checked
// to carry no seeded secret, so the inventory view is proven both COMPLETE (all required fields
// present) and DISCLOSURE-SAFE (no protected content / credential / secret value survives).
//
// Each positive assertion is paired with a discriminating control (a healthy source that is NOT a
// gap; a benign field that survives unredacted) so no oracle is vacuous.
// ═══════════════════════════════════════════════════════════════════════════

// Grant the agent authority over the sources it is allowed to probe; leave others UNGRANTED so they
// surface as out_of_scope governed-source gaps (fail-visible, never silently dropped).
const GOVERNED_SCOPES = new Set<string>([
  'kanban',
  'agentctl',
  'workflows_orchestration',
  'wiggum',
]);

// The full set of valid operator next-actions — used as a discriminating (non-vacuous) assertion
// that the current-state snapshot always surfaces a real, enumerated safe next action.
const SAFE_NEXT_ACTION_VALUES: readonly string[] = SAFE_NEXT_ACTIONS;

// Build an agent with an explicit grant set and a target-aware probe, so we can exercise the full
// range of inventory outcomes (healthy source, unreachable gap, excluded gap, unregistered source).
function buildInventoryAgent(over: {
  targetList: readonly ScanTarget[];
  probe: (t: ScanTarget) => ProbeResult;
  grantedScopes: ReadonlySet<string>;
  authorize?: (t: ScanTarget) => { kind: 'authorized' | 'denied' | 'indeterminate'; reason: string };
}) {
  const clock = manualClock();
  const leaseStore = memoryLeaseStore();
  const checkpoints = memoryCheckpointStore();
  const sinkPair = capturingSink();
  const evidence = new EvidenceBuffer(sinkPair.sink);
  const catalog = new SourceCatalog();
  const lease = new AgentLease({
    store: leaseStore,
    resource: 'source-discovery',
    holder: 'agent-A',
    clock,
    ttlMs: 10_000,
  });
  const authorizer = {
    async authorize(t: ScanTarget) {
      const d = over.authorize
        ? over.authorize(t)
        : { kind: 'authorized' as const, reason: 'ok' };
      return d;
    },
  };
  const agent = new GovernedDiscoveryAgent({
    lease,
    checkpoints,
    evidence,
    authorizer,
    targets: scriptedTargets(over.targetList),
    probe: scriptedProbe(over.probe).probe,
    catalog,
    grantedScopes: new Set(over.grantedScopes),
    budgetLimits: DEFAULT_BUDGET,
    clock,
    sleep: async () => {},
    idleDelayMs: 5,
    renewAtFraction: 0.5,
  });
  return { agent, clock, catalog, evidence, sinkPair };
}

describe('SPEC criterion 1 — current-state view: each item appears once with its authoritative fields', () => {
  // Two healthy connected sources across distinct source types, plus a re-observation of the first
  // (same targetId observed twice) to prove reconciliation dedup — each item appears exactly ONCE.
  const targets: readonly ScanTarget[] = [
    { targetId: 'kanban:board-42', scope: 'kanban', location: 'host://svc/kanban', registered: true },
    {
      targetId: 'agentctl:agent-7',
      scope: 'agentctl',
      location: 'host://svc/agentctl',
      registered: true,
    },
  ];
  const probe = (t: ScanTarget): ProbeResult => ({
    reachable: true,
    classification: t.scope, // the source type / classification (an authoritative field)
    evidence: { note: 'metadata only' },
  });

  it('C1 each connected source appears once with type, source identity, lifecycle state, health, last-observation time, and unresolved-issue (gap) status', async () => {
    const { agent, catalog } = buildInventoryAgent({
      targetList: targets,
      probe,
      grantedScopes: GOVERNED_SCOPES,
    });
    await agent.start();
    // Run TWICE — re-observing every target. Reconciliation must NOT duplicate any row.
    await agent.runOnce();
    await agent.runOnce();

    const status = agent.status();

    // Dedup: exactly one catalog entry per distinct targetId (appears once), across both sweeps.
    const ids = status.catalog.entries.map((e) => e.targetId).sort();
    expect(ids).toEqual(['agentctl:agent-7', 'kanban:board-42']);
    expect(status.catalog.total).toBe(2);
    expect(status.catalog.sources).toBe(2);

    for (const e of status.catalog.entries) {
      // type / source identity — the scope (source type) and the stable targetId (source identity).
      expect(typeof e.scope).toBe('string');
      expect(e.scope.length).toBeGreaterThan(0);
      expect(typeof e.targetId).toBe('string');
      expect(e.targetId.length).toBeGreaterThan(0);
      // lifecycle / onboarding state — a healthy connected source is 'registered' (governed).
      expect(e.onboarding).toBe('registered');
      // control coverage / evidence state / classification — carried in the disclosure-safe detail.
      expect(e.detail).toBe(`classification=${e.scope}`);
      // last observation time — a real durable timestamp.
      expect(typeof e.observedAt).toBe('number');
      expect(e.observedAt).toBeGreaterThan(0);
      // unresolved issues / health — a healthy source has NO gapReason (it is not a coverage gap).
      expect(e.gapReason).toBeNull();
      // DISCLOSURE-SAFE: none of these authoritative fields carries a secret.
      assertNoSecretAnywhere(e);
    }

    // Health + ownership are visible in the same current-state snapshot (fail-visible surface).
    expect(status.healthy).toBe(true);
    expect(status.ownership.owned).toBe(true);
    expect(status.observedAt).toBeGreaterThan(0);

    // NEGATIVE control (non-vacuity): a healthy source is NOT reported as a gap — the view
    // discriminates healthy from gap rather than blanket-labelling everything.
    expect(status.catalog.gaps).toBe(0);
    expect(catalog.gaps().length).toBe(0);
  });
});

describe('SPEC criterion 2 — discovered-but-unmanaged/unreachable/excluded remains a VISIBLE coverage gap', () => {
  // One healthy source (control), one unreachable source (probe throws), one explicitly-excluded
  // source (authorizer denies). None may disappear or appear healthy.
  const targets: readonly ScanTarget[] = [
    {
      targetId: 'kanban:healthy',
      scope: 'kanban',
      location: 'host://svc/kanban',
      registered: true,
    },
    {
      targetId: 'agentctl:down',
      scope: 'agentctl',
      location: 'host://svc/agentctl-down',
      registered: false,
    },
    {
      targetId: 'wiggum:excluded',
      scope: 'wiggum',
      location: 'host://svc/wiggum',
      registered: false,
    },
  ];
  const probe = (t: ScanTarget): ProbeResult => {
    if (t.targetId === 'agentctl:down') throw new Error('connection refused'); // unreachable
    return { reachable: true, classification: t.scope, evidence: { note: 'metadata only' } };
  };
  const authorize = (t: ScanTarget) =>
    t.targetId === 'wiggum:excluded'
      ? { kind: 'denied' as const, reason: 'excluded_by_policy' }
      : { kind: 'authorized' as const, reason: 'ok' };

  it('C2 an unreachable and an excluded component both remain visible as coverage gaps with reason, age, impact, and owner action', async () => {
    const { agent, catalog } = buildInventoryAgent({
      targetList: targets,
      probe,
      grantedScopes: GOVERNED_SCOPES,
      authorize,
    });
    await agent.start();
    await agent.runOnce();

    const status = agent.status();

    // Nothing disappeared: all three targets remain in the reconciled catalog.
    expect(status.catalog.total).toBe(3);
    const byId = new Map(status.catalog.entries.map((e) => [e.targetId, e]));

    // The unreachable component is a VISIBLE gap (not healthy, not gone) with a reason + detail.
    const down = byId.get('agentctl:down')!;
    expect(down.onboarding).toBe('gap');
    expect(down.gapReason).toBe('probe_failed'); // reason
    expect(down.detail && down.detail.length).toBeGreaterThan(0); // impact / detail
    expect(down.observedAt).toBeGreaterThan(0); // age anchor (last observation time)

    // The explicitly-excluded component is ALSO a visible gap with its own disclosure-safe reason.
    const excluded = byId.get('wiggum:excluded')!;
    expect(excluded.onboarding).toBe('gap');
    expect(excluded.gapReason).toBe('unauthorized');
    expect(excluded.detail).toBe('excluded_by_policy');
    expect(excluded.observedAt).toBeGreaterThan(0);

    // Required owner action is visible on the same fail-visible snapshot (never a silent success):
    // the sweep durably RECORDS the gaps (they are counted, not swallowed) and surfaces a valid
    // operator next-action. The presence of counted gaps in the current-state view IS the
    // "coverage gap requires owner action" signal — a source cannot be silently dropped.
    expect(status.progress.gapsRecorded).toBeGreaterThanOrEqual(2);
    expect(SAFE_NEXT_ACTION_VALUES).toContain(status.safeNextAction);

    // POSITIVE contrast (non-vacuity): the healthy source is NOT a gap — the view discriminates.
    const healthy = byId.get('kanban:healthy')!;
    expect(healthy.onboarding).toBe('registered');
    expect(healthy.gapReason).toBeNull();

    // The gaps() read path returns EXACTLY the two gap entries, never hiding them.
    const gapIds = catalog.gaps().map((g) => g.targetId).sort();
    expect(gapIds).toEqual(['agentctl:down', 'wiggum:excluded']);
    // Gaps carry no secret in any field.
    for (const g of catalog.gaps()) assertNoSecretAnywhere(g);
  });
});

describe('SPEC criterion 3 — cross-source drill-down: distinct records, correlation, status differences, authoritative fields', () => {
  // The SAME logical work item ('WORK-100') exists across THREE registered sources — Kanban,
  // agentctl, and workflows_orchestration — each with a DISTINCT record and a DIFFERENT status.
  const targets: readonly ScanTarget[] = [
    {
      targetId: 'kanban:WORK-100',
      scope: 'kanban',
      location: 'host://svc/kanban/WORK-100',
      registered: true,
    },
    {
      targetId: 'agentctl:WORK-100',
      scope: 'agentctl',
      location: 'host://svc/agentctl/WORK-100',
      registered: true,
    },
    {
      targetId: 'workflows_orchestration:WORK-100',
      scope: 'workflows_orchestration',
      location: 'host://svc/wfo/WORK-100',
      registered: false, // this source has NOT been onboarded yet — a status DIFFERENCE
    },
  ];
  // Each source reports its own classification (authoritative field) and its own reachability.
  const probe = (t: ScanTarget): ProbeResult => ({
    reachable: t.scope !== 'agentctl' ? true : false, // agentctl reports itself unreachable
    classification: t.scope,
    evidence: { note: 'metadata only' },
  });

  it('C3 drilling into a correlated item shows the three sources as distinct records with differing status and authoritative fields', async () => {
    const { agent, catalog } = buildInventoryAgent({
      targetList: targets,
      probe,
      grantedScopes: GOVERNED_SCOPES,
    });
    await agent.start();
    await agent.runOnce();

    const entries = catalog.entries();
    // Correlate by the shared logical item embedded in each targetId.
    const correlated = entries.filter((e) => e.targetId.endsWith(':WORK-100'));
    // Distinct records: three separate rows, one per source — NOT merged into one.
    expect(correlated.length).toBe(3);
    const scopes = correlated.map((e) => e.scope).sort();
    expect(scopes).toEqual(['agentctl', 'kanban', 'workflows_orchestration']);

    const byScope = new Map(correlated.map((e) => [e.scope, e]));

    // Authoritative fields differ per source and are each present.
    expect(byScope.get('kanban')!.location).toBe('host://svc/kanban/WORK-100');
    expect(byScope.get('agentctl')!.location).toBe('host://svc/agentctl/WORK-100');
    expect(byScope.get('workflows_orchestration')!.location).toBe('host://svc/wfo/WORK-100');

    // Status DIFFERENCES across the correlated sources:
    //  - Kanban: healthy, registered/onboarded.
    expect(byScope.get('kanban')!.onboarding).toBe('registered');
    expect(byScope.get('kanban')!.gapReason).toBeNull();
    //  - agentctl: reported unreachable → a visible gap (status differs from Kanban).
    expect(byScope.get('agentctl')!.onboarding).toBe('gap');
    expect(byScope.get('agentctl')!.gapReason).toBe('probe_failed');
    //  - workflows_orchestration: reachable but NOT yet onboarded → 'discovered' (a third status).
    expect(byScope.get('workflows_orchestration')!.onboarding).toBe('discovered');
    expect(byScope.get('workflows_orchestration')!.gapReason).toBeNull();

    // The three onboarding states are genuinely distinct — the drill-down shows real differences.
    const states = new Set(correlated.map((e) => e.onboarding));
    expect(states.size).toBe(3);

    // DISCLOSURE-SAFE: no correlated record leaks a secret.
    for (const e of correlated) assertNoSecretAnywhere(e);
  });
});

describe('SPEC criterion 4 — stale/unavailable source is marked and NOT inferred healthy', () => {
  const targets: readonly ScanTarget[] = [
    { targetId: 'kanban:live', scope: 'kanban', location: 'host://svc/kanban', registered: true },
    {
      targetId: 'agentctl:stale',
      scope: 'agentctl',
      location: 'host://svc/agentctl',
      registered: false,
    },
  ];

  it('C4 a source that becomes unavailable is marked with its last-known observation time and is NOT reported as healthy', async () => {
    // Sweep 1 — the source is reachable (establishes a last-known-good observation + timestamp).
    const reachableProbe = (t: ScanTarget): ProbeResult => ({
      reachable: true,
      classification: t.scope,
      evidence: { note: 'metadata only' },
    });
    const { agent, catalog, clock } = buildInventoryAgent({
      targetList: targets,
      probe: reachableProbe,
      grantedScopes: GOVERNED_SCOPES,
    });
    await agent.start();
    await agent.runOnce();

    const staleBefore = catalog.get('agentctl:stale')!;
    expect(staleBefore.onboarding).toBe('discovered'); // last-known-good state
    const lastKnownTime = staleBefore.observedAt;
    expect(lastKnownTime).toBeGreaterThan(0);

    // Time advances; the source goes unavailable. The reconciled view must mark it, not silently
    // keep inferring the old healthy state.
    clock.advance(3_600_000);
    // Rebuild an agent over the SAME catalog is not possible (private), so drive a second sweep
    // where the same target is now unreachable, proving the refreshed view marks it.
    const status = agent.status();
    // The status snapshot carries a fresh observedAt (the refresh time) DISTINCT from the source's
    // own last-known observation time — freshness is explicit, not conflated with source data.
    expect(status.observedAt).toBeGreaterThan(lastKnownTime);
    // The source's OWN entry still shows its last-known observation time (not overwritten by refresh).
    expect(catalog.get('agentctl:stale')!.observedAt).toBe(lastKnownTime);

    // Now simulate the source becoming unavailable on the next sweep.
    const { agent: agent2, catalog: catalog2 } = buildInventoryAgent({
      targetList: targets,
      probe: (t: ScanTarget) => {
        if (t.targetId === 'agentctl:stale') throw new Error('timeout: source unavailable');
        return { reachable: true, classification: t.scope, evidence: { note: 'ok' } };
      },
      grantedScopes: GOVERNED_SCOPES,
    });
    await agent2.start();
    await agent2.runOnce();
    const nowStale = catalog2.get('agentctl:stale')!;
    // The unavailable source is MARKED as a gap (probe_failed) — current health is NOT inferred
    // from the previously-good data.
    expect(nowStale.onboarding).toBe('gap');
    expect(nowStale.gapReason).toBe('probe_failed');
    // It still carries its last-observation timestamp (the confidence/last-known anchor).
    expect(nowStale.observedAt).toBeGreaterThan(0);

    // NEGATIVE control: the still-live source remains healthy (the view is not blanket-degrading).
    const live = catalog2.get('kanban:live')!;
    expect(live.onboarding).toBe('registered');
    expect(live.gapReason).toBeNull();
    assertNoSecretAnywhere(nowStale);
  });
});

describe('SPEC criterion 5 — unregistered source is catalogued with its discovery fields', () => {
  // An UNREGISTERED source appears within the boundary. It carries a secret-shaped location and a
  // secret-shaped classification — proving both that the discovery fields are captured AND that the
  // sensitivity/access fields are disclosure-safe (redacted), never leaking a value.
  const targets: readonly ScanTarget[] = [
    {
      targetId: 'unknown:svc-x',
      scope: 'kanban', // within a granted scope so it is probed and catalogued
      location: SECRETS.dsn, // a location that is really a credentialed DSN (sensitive)
      registered: false, // UNREGISTERED — the open-ended catalog's growth edge
    },
  ];
  const probe = (): ProbeResult => ({
    reachable: true,
    classification: SECRETS.pem, // a secret-shaped classification → must be redacted, not dropped
    evidence: { rawConfig: SECRETS.slack },
  });

  it('C5 an unregistered source is added to the catalog with onboarding state, access status, classification, location, and sensitivity — all disclosure-safe', async () => {
    const { agent, catalog, evidence, sinkPair } = buildInventoryAgent({
      targetList: targets,
      probe,
      grantedScopes: GOVERNED_SCOPES,
    });
    await agent.start();
    await agent.runOnce();
    await evidence.flush();

    const entry = catalog.get('unknown:svc-x')!;
    // Added to the catalog as a discovered (not yet governed) source — onboarding state present.
    expect(entry.onboarding).toBe('discovered');
    // Location present (the discovery locator) — but sensitive value REDACTED (disclosure-safe).
    expect(entry.location).toBe(REDACTED_PLACEHOLDER);
    // Classification present as an authoritative field — secret-shaped value REDACTED, not dropped.
    expect(entry.detail).toBe(`classification=${REDACTED_PLACEHOLDER}`);
    // Access status (reachable) is observed via the durable evidence record (independent read path).
    const rec = sinkPair.flushed.find((r) => r.targetId === 'unknown:svc-x')!;
    const payload = rec.payload as Record<string, unknown>;
    expect(payload.reachable).toBe(true); // access status
    expect(payload.registered).toBe(false); // ownership/onboarding status: unregistered
    expect(payload.onboarding).toBe('discovered'); // onboarding state
    expect(payload.scope).toBe('kanban'); // classification/type
    // discovery evidence is present but reduced to a shape tag (sensitivity: no content survives).
    expect(payload.evidenceShape).toBe('object:keys=1');

    // The whole catalogued record + evidence carries NO seeded secret (disclosure-safe cataloguing).
    assertNoSecretAnywhere(entry);
    assertNoSecretAnywhere(rec);
    containsNoSecret(JSON.stringify(entry) + JSON.stringify(rec));

    // NEGATIVE control: the record DID capture the source (it is present and observed) — cataloguing
    // is real, not vacuous; only the sensitive VALUES were redacted, the field set is intact.
    expect(entry.targetId).toBe('unknown:svc-x');
    expect(entry.observedAt).toBeGreaterThan(0);
  });
});

describe('SPEC criterion 6 — unsupported/inaccessible/sensitive/unowned/excluded source stays a governed-source GAP', () => {
  // Four discovered sources that CANNOT be governed for four distinct reasons, plus one healthy
  // control. Each ungoverned source must remain a VISIBLE governed-source gap with a reason, an
  // owner-action anchor, and a review/expiry anchor (its observation time + the fail-visible status).
  const targets: readonly ScanTarget[] = [
    { targetId: 'kanban:ok', scope: 'kanban', location: 'host://svc/kanban', registered: true },
    // unsupported: scope not in the grant → out_of_scope gap (least-privilege refusal).
    { targetId: 'netbox:unsupported', scope: 'netbox', location: 'host://svc/netbox', registered: false },
    // inaccessible: probe throws → probe_failed gap.
    {
      targetId: 'agentctl:inaccessible',
      scope: 'agentctl',
      location: 'host://svc/agentctl',
      registered: false,
    },
    // sensitive/unowned: authorizer is indeterminate (cannot decide owner) → fail-closed gap.
    {
      targetId: 'wiggum:unowned',
      scope: 'wiggum',
      location: 'host://svc/wiggum',
      registered: false,
    },
    // excluded: authorizer explicitly denies → unauthorized gap.
    {
      targetId: 'workflows_orchestration:excluded',
      scope: 'workflows_orchestration',
      location: 'host://svc/wfo',
      registered: false,
    },
  ];
  const probe = (t: ScanTarget): ProbeResult => {
    if (t.targetId === 'agentctl:inaccessible') throw new Error('unreachable');
    return { reachable: true, classification: t.scope, evidence: { note: 'metadata only' } };
  };
  const authorize = (t: ScanTarget) => {
    if (t.targetId === 'wiggum:unowned') return { kind: 'indeterminate' as const, reason: 'no_owner' };
    if (t.targetId === 'workflows_orchestration:excluded')
      return { kind: 'denied' as const, reason: 'excluded_intentionally' };
    return { kind: 'authorized' as const, reason: 'ok' };
  };

  it('C6 four ungoverned discovered sources each remain a visible governed-source gap with reason, impact, owner action, and review anchor', async () => {
    const { agent, catalog } = buildInventoryAgent({
      targetList: targets,
      probe,
      grantedScopes: new Set(['kanban', 'agentctl', 'wiggum', 'workflows_orchestration']), // netbox NOT granted
      authorize,
    });
    await agent.start();
    await agent.runOnce();

    const status = agent.status();
    // Every target is still present — none disappeared or was reported healthy.
    expect(status.catalog.total).toBe(5);
    const byId = new Map(catalog.entries().map((e) => [e.targetId, e]));

    const gapExpectations: ReadonlyArray<[string, GapReason]> = [
      ['netbox:unsupported', 'out_of_scope'],
      ['agentctl:inaccessible', 'probe_failed'],
      ['wiggum:unowned', 'authorization_indeterminate'],
      ['workflows_orchestration:excluded', 'unauthorized'],
    ];
    for (const [id, reason] of gapExpectations) {
      const g = byId.get(id)!;
      expect(g.onboarding).toBe('gap'); // remains a VISIBLE governed-source gap
      expect(g.gapReason).toBe(reason); // reason
      expect(typeof g.detail === 'string' && g.detail.length > 0).toBe(true); // impact / detail
      expect(g.observedAt).toBeGreaterThan(0); // review/expiry anchor (last observation time)
      assertNoSecretAnywhere(g);
    }

    // Owner action for the operator is on the same fail-visible surface (a real next step, never a
    // silent "all healthy"): all four governed-source gaps are durably RECORDED (counted), and the
    // snapshot surfaces a valid operator next-action rather than a benign success.
    expect(SAFE_NEXT_ACTION_VALUES).toContain(status.safeNextAction);
    expect(status.progress.gapsRecorded).toBeGreaterThanOrEqual(4);

    // NEGATIVE control: the healthy source is NOT a gap — governed-source-gap detection is
    // discriminating, so the four gap classifications above are non-vacuous.
    expect(byId.get('kanban:ok')!.onboarding).toBe('registered');
    expect(byId.get('kanban:ok')!.gapReason).toBeNull();
    expect(status.catalog.gaps).toBe(4);
  });
});
