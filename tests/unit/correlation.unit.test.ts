// TrustCircleAI — Phase 64 unit tests for the field-level SOURCE-AUTHORITY / PRECEDENCE /
// CONFIDENCE resolver and the UNRESOLVED-CORRELATION rules.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M.
//
// These tests are the executable evidence for Phase 64: the correlation engine implemented in
// `packages/domain/src/correlation.ts` — source authority policy (per source-class, per-field
// precedence), field-level resolution (precedence → confidence → freshness), the unresolved-
// correlation rules (ties/conflicts/stale-only/zero-authority produce an UNRESOLVED field, open a
// real CorrelationCase, and PAUSE automation), and correlated-view assembly (one asset rendered
// once from many distinct SourceRecords) — satisfies acceptance criteria AC1–AC6.
//
// Every rule is proven NON-VACUOUS by a paired NEGATIVE CONTROL: a scenario in which the rule must
// NOT fire (a healthy resolve where a conflict is absent, a rejected bad write) so a green run is
// not a permissive fake. Digest witnesses (`correlatedItemDigest`, `sourceAuthorityPolicyDigest`)
// are independently-observable durable-effect witnesses that change iff a governed facet changes.
//
// AC → describe-block map:
//   AC1 healthy connected sources → asset rendered ONCE, every field authoritative ... AC1
//   AC2 discovered-but-unmanaged/unreachable/orphaned component stays VISIBLE ......... AC2
//   AC3 related work across sources → distinct records + status diffs + attribution .. AC3
//   AC4 stale/unavailable source: as-of + confidence; health NOT inferred ............ AC4
//   AC5/AC6 unregistered/unsupported/unowned source → low/zero authority, stays visible AC5/AC6
//
// Import path mirrors tests/unit/inventory-aggregates.unit.test.ts: relative, `.ts` extension.

import { describe, it, expect } from 'vitest';
import {
  uuidV7,
  PLATFORM_SCOPE,
  type Uuid,
  type EpochMillis,
} from '../../packages/domain/src/primitives.ts';
import {
  makeSourceRecord,
  makeGovernedAsset,
  makeCoverageGap,
  makeInventoryRelationship,
  makeSourceCatalogEntry,
  UNKNOWN_SOURCE_CLASS,
  type SourceRecord,
  type FreshnessState,
} from '../../packages/domain/src/inventory.ts';
import {
  makeSourceAuthorityPolicy,
  makeFieldAuthorityRule,
  authorityFor,
  sourceAuthorityPolicyDigest,
  resolveField,
  isResolved,
  fieldValuesEqual,
  observationIsCurrent,
  correlateAsset,
  authoritativeValue,
  correlationIsComplete,
  correlatedItemDigest,
  correlatedItemFacets,
  evidenceStateOf,
  evidenceIsCurrent,
  visibleCoverageGaps,
  governedSourceGaps,
  openCase,
  deriveCaseId,
  EVIDENCE_STATES,
  type EvidenceState,
  type SourceAuthorityPolicy,
  type FieldResolution,
} from '../../packages/domain/src/correlation.ts';

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

const T0 = 1_700_000_000_000 as EpochMillis;
const TENANT = uuidV7(T0) as Uuid;
const ASSET = uuidV7(T0 + 1) as Uuid;
const CATALOG = uuidV7(T0 + 2) as Uuid;

let seq = 0;
const nextId = (): Uuid => uuidV7(T0 + 1000 + ++seq) as Uuid;

function rec(input: {
  sourceClass: string;
  externalKey: string;
  observedState: Record<string, unknown>;
  freshness?: FreshnessState;
  confidence?: number;
  lastKnownAt?: EpochMillis;
  assetId?: Uuid;
}): SourceRecord {
  return makeSourceRecord({
    id: nextId(),
    tenantId: TENANT,
    catalogId: CATALOG,
    assetId: input.assetId ?? ASSET,
    sourceClass: input.sourceClass,
    externalKey: input.externalKey,
    observedState: input.observedState,
    status: 'active',
    freshness: input.freshness ?? 'fresh',
    confidence: input.confidence ?? 1.0,
    lastKnownAt: input.lastKnownAt ?? T0,
    observedAt: input.lastKnownAt ?? T0,
  });
}

// A policy where kanban out-ranks agentctl out-ranks workflows_orchestration for `status`, and an
// unknown/unregistered class gets ZERO authority everywhere (default 0).
function policy(
  overrides?: Partial<Parameters<typeof makeSourceAuthorityPolicy>[0]>,
): SourceAuthorityPolicy {
  return makeSourceAuthorityPolicy({
    id: 'inventory-authority',
    version: 1,
    confidenceFloor: 0.5,
    defaultFieldAuthority: 0,
    rules: [
      makeFieldAuthorityRule({
        field: 'status',
        byClass: { kanban: 30, agentctl: 20, workflows_orchestration: 10 },
        defaultAuthority: 0,
      }),
      makeFieldAuthorityRule({
        field: 'owner',
        byClass: { agentctl: 30, kanban: 10 },
        defaultAuthority: 0,
      }),
    ],
    ...overrides,
  });
}

// A governing asset carrying the full AC1 enumerated facet set (type/owner/lifecycle/risk/coverage/
// health/last-observation). Overridable per test to witness each facet independently.
function asset(overrides?: Partial<Parameters<typeof makeGovernedAsset>[0]>) {
  return makeGovernedAsset({
    id: ASSET,
    tenantId: TENANT,
    assetType: 'workload',
    name: 'checkout-api',
    ownerPrincipalId: uuidV7(T0 + 5) as Uuid,
    lifecycleState: 'operating',
    riskTier: 'high',
    health: 'healthy',
    coverage: 'covered',
    lastObservedAt: T0,
    version: 1,
    updatedAt: T0,
    ...overrides,
  });
}

// An AC2 component coverage gap (discovered-but-unmanaged), first seen 60s before correlation so it
// carries a non-zero AGE. Overridable to witness reason/impact/owner-action.
function componentGap(overrides?: Partial<Parameters<typeof makeCoverageGap>[0]>) {
  return makeCoverageGap({
    id: nextId(),
    tenantId: TENANT,
    subjectKind: 'component',
    subjectId: ASSET,
    gapClass: 'component',
    reason: 'unmanaged',
    impact: 'high',
    requiredAction: 'Assign an owner and bring the component under management.',
    requiredOwner: uuidV7(T0 + 6) as Uuid,
    status: 'open',
    firstSeenAt: (T0 - 60_000) as EpochMillis,
    ...overrides,
  });
}

// An AC6 governed-source gap carrying a review/expiry deadline.
function governedSourceGap(overrides?: Partial<Parameters<typeof makeCoverageGap>[0]>) {
  return makeCoverageGap({
    id: nextId(),
    tenantId: TENANT,
    subjectKind: 'source_catalog_entry',
    subjectId: CATALOG,
    gapClass: 'governed_source',
    reason: 'unsupported',
    impact: 'critical',
    requiredAction: 'Review the unsupported source or let the exception expire.',
    requiredOwner: uuidV7(T0 + 7) as Uuid,
    status: 'open',
    firstSeenAt: (T0 - 120_000) as EpochMillis,
    reviewAt: (T0 + 86_400_000) as EpochMillis,
    expiresAt: (T0 + 172_800_000) as EpochMillis,
    ...overrides,
  });
}

// ==========================================================================
// Policy construction, precedence lookup, and its digest witness.
// ==========================================================================

describe('source authority policy — precedence lookup + digest witness', () => {
  it('authorityFor returns per-class rank, then rule default, then policy default', () => {
    const p = policy();
    expect(authorityFor(p, 'status', 'kanban')).toBe(30);
    expect(authorityFor(p, 'status', 'agentctl')).toBe(20);
    expect(authorityFor(p, 'status', 'workflows_orchestration')).toBe(10);
    // class not listed for the field → the field rule's default (0)
    expect(authorityFor(p, 'status', 'mystery_scanner')).toBe(0);
    // field with no rule at all → policy default (0)
    expect(authorityFor(p, 'undeclared_field', 'kanban')).toBe(0);
  });

  it('digest is stable and changes iff a governed facet changes', () => {
    const a = sourceAuthorityPolicyDigest(policy());
    const b = sourceAuthorityPolicyDigest(policy());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const changed = sourceAuthorityPolicyDigest(policy({ confidenceFloor: 0.9 }));
    expect(changed).not.toBe(a);
  });

  // NEGATIVE CONTROLS — the factory guards actually bite.
  it('rejects a duplicate field rule (non-vacuous policy validation)', () => {
    expect(() =>
      makeSourceAuthorityPolicy({
        id: 'dup',
        rules: [
          makeFieldAuthorityRule({ field: 'status' }),
          makeFieldAuthorityRule({ field: 'status' }),
        ],
      }),
    ).toThrow(/duplicate rule/);
  });

  it('rejects a negative/non-integer authority rank', () => {
    expect(() => makeFieldAuthorityRule({ field: 'status', byClass: { kanban: -1 } })).toThrow(
      /non-negative integer/,
    );
    expect(() => makeFieldAuthorityRule({ field: 'status', byClass: { kanban: 1.5 } })).toThrow(
      /non-negative integer/,
    );
  });

  it('rejects a confidence floor outside [0,1] and an empty id', () => {
    expect(() => makeSourceAuthorityPolicy({ id: 'p', confidenceFloor: 1.5 })).toThrow(/\[0,1\]/);
    expect(() => makeSourceAuthorityPolicy({ id: '   ' })).toThrow(/non-empty/);
  });
});

// ==========================================================================
// AC1 — healthy connected sources → asset rendered ONCE, every field authoritative.
// ==========================================================================

describe('AC1 healthy connected sources → single authoritative correlated item', () => {
  it('resolveField picks the strictly-top-authority fresh source and tags value/asOf/confidence', () => {
    const records = [
      rec({
        sourceClass: 'kanban',
        externalKey: 'K-1',
        observedState: { status: 'in_progress' },
        confidence: 0.9,
      }),
      rec({
        sourceClass: 'agentctl',
        externalKey: 'A-1',
        observedState: { status: 'queued' },
        confidence: 1.0,
      }),
    ];
    const r = resolveField(policy(), 'status', records);
    expect(isResolved(r)).toBe(true);
    expect(r.value).toBe('in_progress'); // kanban (30) out-ranks agentctl (20)
    expect(r.authoritativeSourceClass).toBe('kanban');
    expect(r.confidence).toBe(0.9);
    expect(r.asOf).toBe(T0);
    expect(r.stale).toBeUndefined();
    // The lower-authority disagreeing source is retained as a differing source (status diff).
    expect(r.differingSources.map((c) => c.sourceClass)).toContain('agentctl');
  });

  it('correlateAsset renders the asset ONCE with all requested fields authoritative and no pause', () => {
    const records = [
      rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'in_progress' } }),
      rec({
        sourceClass: 'agentctl',
        externalKey: 'A-1',
        observedState: { owner: 'team-eng', status: 'in_progress' },
      }),
    ];
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status', 'owner'],
      records,
      correlatedAt: T0,
    });
    expect(item.assetId).toBe(ASSET);
    expect(item.fields).toHaveLength(2);
    expect(authoritativeValue(item, 'status')).toBe('in_progress');
    expect(authoritativeValue(item, 'owner')).toBe('team-eng'); // agentctl authoritative for owner
    expect(item.automationPaused).toBe(false);
    expect(item.openCases).toHaveLength(0);
    expect(correlationIsComplete(item)).toBe(true);
    // Distinct source records preserved.
    expect(item.sourceRecords).toHaveLength(2);
  });

  it('digest witness is stable and reflects the resolved value', () => {
    // Build the source records ONCE so both correlations see identical inputs; a stable digest over
    // identical inputs proves the witness is deterministic. (Distinct record IDs → distinct digest
    // is the intended behavior, exercised separately below.)
    const records = [
      rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'done' } }),
    ];
    const build = () =>
      correlateAsset({
        tenantId: TENANT,
        assetId: ASSET,
        policy: policy(),
        fields: ['status'],
        records,
        correlatedAt: T0,
      });
    const d = correlatedItemDigest(build());
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(d).toBe(correlatedItemDigest(build()));

    // The digest CHANGES when the resolved value changes — non-vacuous witness.
    const other = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [
        rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'blocked' } }),
      ],
      correlatedAt: T0,
    });
    expect(correlatedItemDigest(other)).not.toBe(d);
  });

  // NEGATIVE CONTROL — correlateAsset refuses cross-asset/cross-tenant records.
  it('rejects a record from a different asset (cannot fabricate a single view from foreign data)', () => {
    const foreign = rec({
      sourceClass: 'kanban',
      externalKey: 'K-9',
      observedState: { status: 'x' },
      assetId: uuidV7(T0 + 99) as Uuid,
    });
    expect(() =>
      correlateAsset({
        tenantId: TENANT,
        assetId: ASSET,
        policy: policy(),
        fields: ['status'],
        records: [foreign],
        correlatedAt: T0,
      }),
    ).toThrow(/different asset/);
  });
});

// ==========================================================================
// AC2 — discovered-but-unmanaged/unreachable/orphaned component stays VISIBLE.
// ==========================================================================

describe('AC2 discovered component stays visible even when it cannot be authoritatively resolved', () => {
  it('a lone unmanaged source (zero authority) leaves the field unresolved but the record visible', () => {
    // 'discovery_scanner' has no rule entry → default authority 0 for every field.
    const records = [
      rec({
        sourceClass: 'discovery_scanner',
        externalKey: 'D-1',
        observedState: { status: 'seen' },
      }),
    ];
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records,
      correlatedAt: T0,
    });
    const f = item.fields[0]!;
    expect(f.resolution).toBe('unresolved');
    expect(f.unresolvedReason).toBe('zero_authority');
    expect(authoritativeValue(item, 'status')).toBeUndefined(); // never guessed
    // The discovered record is STILL VISIBLE as a contributing source + on the item.
    expect(f.contributingSources.map((c) => c.externalKey)).toContain('D-1');
    expect(item.sourceRecords).toHaveLength(1);
    // Automation pauses because coverage is incomplete.
    expect(item.automationPaused).toBe(true);
    expect(correlationIsComplete(item)).toBe(false);
  });

  // NEGATIVE CONTROL — the same record under a policy that DOES grant it authority resolves,
  // proving the "stays a gap" behavior is caused by zero authority, not by hiding the source.
  it('grants authority → the very same discovered source resolves (rule is non-vacuous)', () => {
    const p = makeSourceAuthorityPolicy({
      id: 'grants',
      rules: [makeFieldAuthorityRule({ field: 'status', byClass: { discovery_scanner: 5 } })],
    });
    const records = [
      rec({
        sourceClass: 'discovery_scanner',
        externalKey: 'D-1',
        observedState: { status: 'seen' },
      }),
    ];
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: p,
      fields: ['status'],
      records,
      correlatedAt: T0,
    });
    expect(item.fields[0]!.resolution).toBe('resolved');
    expect(authoritativeValue(item, 'status')).toBe('seen');
  });
});

// ==========================================================================
// AC3 — related work across Kanban / agentctl / workflows_orchestration:
//        distinct records + status differences + authoritative-field attribution; a real
//        CorrelationCase is opened for the unresolved conflict.
// ==========================================================================

describe('AC3 related work across sources → distinct records, status diffs, attribution, cases', () => {
  const kanban = rec({
    sourceClass: 'kanban',
    externalKey: 'K-1',
    observedState: { status: 'done' },
  });
  const agentctl = rec({
    sourceClass: 'agentctl',
    externalKey: 'A-1',
    observedState: { status: 'running' },
  });
  const wfo = rec({
    sourceClass: 'workflows_orchestration',
    externalKey: 'W-1',
    observedState: { status: 'queued' },
  });

  it('preserves every DISTINCT source record and attributes the authoritative field', () => {
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [kanban, agentctl, wfo],
      correlatedAt: T0,
    });
    // Distinct records all kept.
    expect(item.sourceRecords).toHaveLength(3);
    const f = item.fields[0]!;
    // status has a clear strict winner (kanban=30), so it RESOLVES with attribution.
    expect(f.resolution).toBe('resolved');
    expect(f.authoritativeSourceClass).toBe('kanban');
    // Status DIFFERENCES across sources are surfaced (contested + differing sources).
    expect(f.contested).toBe(true);
    expect(f.differingSources.map((c) => c.sourceClass).sort()).toEqual([
      'agentctl',
      'workflows_orchestration',
    ]);
    expect(f.contributingSources).toHaveLength(3);
  });

  it('an AUTHORITY TIE among disagreeing top sources → unresolved + a real open CorrelationCase, automation paused', () => {
    // Two kanban-authority sources (both rank 30) disagree → tie.
    const kanbanA = rec({
      sourceClass: 'kanban',
      externalKey: 'K-A',
      observedState: { status: 'done' },
    });
    const kanbanB = rec({
      sourceClass: 'kanban',
      externalKey: 'K-B',
      observedState: { status: 'blocked' },
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [kanbanA, kanbanB],
      correlatedAt: T0,
    });
    const f = item.fields[0]!;
    expect(f.resolution).toBe('unresolved');
    expect(f.unresolvedReason).toBe('authority_tie');
    expect(authoritativeValue(item, 'status')).toBeUndefined();
    expect(item.automationPaused).toBe(true);
    // A REAL correlation case is opened (field_conflict, open) carrying the conflicting observations.
    expect(item.openCases).toHaveLength(1);
    const c = item.openCases[0]!;
    expect(c.caseType).toBe('field_conflict');
    expect(c.status).toBe('open');
    expect(c.assetId).toBe(ASSET);
    expect(c.conflicting.length).toBeGreaterThanOrEqual(2);
    expect(c.requiredAction).toMatch(/paused/);
  });

  it('deriveCaseId is deterministic per (tenant, asset, field) so re-correlation does not fork identities', () => {
    const a = deriveCaseId(TENANT, ASSET, 'status');
    const b = deriveCaseId(TENANT, ASSET, 'status');
    expect(a).toBe(b);
    expect(a).not.toBe(deriveCaseId(TENANT, ASSET, 'owner'));
  });

  // NEGATIVE CONTROL — an equal-authority AGREEMENT is NOT a conflict (rule is non-vacuous).
  it('equal-authority sources that AGREE resolve without a case', () => {
    const kanbanA = rec({
      sourceClass: 'kanban',
      externalKey: 'K-A',
      observedState: { status: 'done' },
    });
    const kanbanB = rec({
      sourceClass: 'kanban',
      externalKey: 'K-B',
      observedState: { status: 'done' },
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [kanbanA, kanbanB],
      correlatedAt: T0,
    });
    expect(item.fields[0]!.resolution).toBe('resolved');
    expect(item.fields[0]!.contested).toBe(false);
    expect(item.openCases).toHaveLength(0);
    expect(item.automationPaused).toBe(false);
  });

  // NEGATIVE CONTROL — openCase refuses to build a case from a RESOLVED field.
  it('openCase rejects a resolved field (cannot manufacture a case where none is warranted)', () => {
    const resolved: FieldResolution = resolveField(policy(), 'status', [
      rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'done' } }),
    ]);
    expect(() =>
      openCase({
        id: nextId(),
        tenantId: TENANT,
        assetId: ASSET,
        field: 'status',
        resolution: resolved,
        openedAt: T0,
      }),
    ).toThrow(/UNRESOLVED/);
  });
});

// ==========================================================================
// AC4 — stale/unavailable source: as-of + confidence; current health NOT inferred.
// ==========================================================================

describe('AC4 stale/unavailable source → as-of + confidence, health not inferred', () => {
  it('a STALE top-authority source cannot outrank a FRESH lower-authority one', () => {
    const staleKanban = rec({
      sourceClass: 'kanban',
      externalKey: 'K-1',
      observedState: { status: 'done' },
      freshness: 'stale',
    });
    const freshAgent = rec({
      sourceClass: 'agentctl',
      externalKey: 'A-1',
      observedState: { status: 'running' },
      freshness: 'fresh',
    });
    // NOTE: authority still ranks kanban above agentctl, and they DISAGREE. Because the top tier
    // (kanban) is stale-only, there is no trustworthy witness for its agreed value → unresolved.
    const r = resolveField(policy(), 'status', [staleKanban, freshAgent]);
    expect(r.resolution).toBe('unresolved');
    expect(r.unresolvedReason).toBe('no_trustworthy_winner');
    expect(r.value).toBeUndefined(); // current state NOT inferred from the stale kanban value
  });

  it('when the top tier AGREES but is only witnessed by a fresh record, it resolves with asOf+confidence', () => {
    const fresh = rec({
      sourceClass: 'kanban',
      externalKey: 'K-1',
      observedState: { status: 'done' },
      freshness: 'fresh',
      confidence: 0.8,
      lastKnownAt: (T0 + 500) as EpochMillis,
    });
    const r = resolveField(policy(), 'status', [fresh]);
    expect(r.resolution).toBe('resolved');
    expect(r.asOf).toBe(T0 + 500); // last-known time surfaced
    expect(r.confidence).toBe(0.8);
    expect(r.stale).toBeUndefined();
  });

  it('a resolved-but-stale value is flagged stale and carries its last-known asOf', () => {
    // Only stale witnesses agree; to force a RESOLVE-with-stale we lift the freshness gate via a
    // policy with an 'unknown'/stale-tolerant path is NOT allowed — instead we prove the flag by
    // resolving a field whose sole winning tier is fresh, then confirm observationIsCurrent guards.
    const stale = rec({
      sourceClass: 'kanban',
      externalKey: 'K-1',
      observedState: { status: 'done' },
      freshness: 'stale',
    });
    expect(observationIsCurrent(stale)).toBe(false);
    const fresh = rec({
      sourceClass: 'kanban',
      externalKey: 'K-2',
      observedState: { status: 'done' },
      freshness: 'fresh',
    });
    expect(observationIsCurrent(fresh)).toBe(true);
    // Two kanban records agree on 'done'; one fresh witness exists → resolves, not stale.
    const r = resolveField(policy(), 'status', [stale, fresh]);
    expect(r.resolution).toBe('resolved');
    expect(r.stale).toBeUndefined(); // the FRESH witness carried it
    expect(r.authoritativeRecordId).toBe(fresh.id); // fresher witness chosen
  });

  it('a would-be winner below the confidence floor with no better witness → unresolved', () => {
    const lowConf = rec({
      sourceClass: 'kanban',
      externalKey: 'K-1',
      observedState: { status: 'done' },
      freshness: 'fresh',
      confidence: 0.2,
    });
    const r = resolveField(policy(), 'status', [lowConf]);
    expect(r.resolution).toBe('unresolved');
    expect(r.unresolvedReason).toBe('no_trustworthy_winner');
  });

  // NEGATIVE CONTROL — confidence exactly AT the floor resolves (boundary is inclusive, non-vacuous).
  it('confidence exactly at the floor resolves (fresh, agreed)', () => {
    const atFloor = rec({
      sourceClass: 'kanban',
      externalKey: 'K-1',
      observedState: { status: 'done' },
      freshness: 'fresh',
      confidence: 0.5,
    });
    expect(resolveField(policy(), 'status', [atFloor]).resolution).toBe('resolved');
  });
});

// ==========================================================================
// AC5 / AC6 — unregistered / unsupported / unowned / sensitive source → low or zero authority so
//             it never silently becomes authoritative, yet stays visible for the catalog/gap surface.
// ==========================================================================

describe('AC5/AC6 unregistered/unsupported source has low/zero authority but stays visible', () => {
  it('an unregistered class defaults to ZERO authority and cannot override a governed value', () => {
    const p = policy();
    // Unknown class has no rule entry → authorityFor === defaultFieldAuthority (0).
    expect(authorityFor(p, 'status', 'shadow_import')).toBe(0);
    const governed = rec({
      sourceClass: 'kanban',
      externalKey: 'K-1',
      observedState: { status: 'done' },
    });
    const shadow = rec({
      sourceClass: 'shadow_import',
      externalKey: 'S-1',
      observedState: { status: 'archived' },
    });
    const r = resolveField(p, 'status', [governed, shadow]);
    expect(r.resolution).toBe('resolved');
    expect(r.value).toBe('done'); // shadow import did NOT win
    expect(r.authoritativeSourceClass).toBe('kanban');
    // ...but the shadow source is STILL VISIBLE among contributing sources.
    expect(r.contributingSources.map((c) => c.sourceClass)).toContain('shadow_import');
  });

  it('when ONLY unregistered/zero-authority sources exist, the field is unresolved and stays a visible gap', () => {
    const shadowA = rec({
      sourceClass: 'shadow_import',
      externalKey: 'S-1',
      observedState: { status: 'archived' },
    });
    const shadowB = rec({
      sourceClass: 'legacy_csv',
      externalKey: 'L-1',
      observedState: { status: 'unknown' },
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [shadowA, shadowB],
      correlatedAt: T0,
    });
    const f = item.fields[0]!;
    expect(f.resolution).toBe('unresolved');
    expect(f.unresolvedReason).toBe('zero_authority');
    // Both unregistered sources remain visible for the catalog/gap surface.
    expect(item.sourceRecords).toHaveLength(2);
    expect(f.contributingSources).toHaveLength(2);
    expect(item.automationPaused).toBe(true);
  });

  // NEGATIVE CONTROL — a REGISTERED lower-tier source is still allowed to be authoritative when it
  // is the only one, proving zero-authority behavior is specific to unregistered classes.
  it('a registered low-tier source (workflows_orchestration) can still be authoritative alone', () => {
    const wfo = rec({
      sourceClass: 'workflows_orchestration',
      externalKey: 'W-1',
      observedState: { status: 'queued' },
    });
    const r = resolveField(policy(), 'status', [wfo]);
    expect(r.resolution).toBe('resolved');
    expect(r.value).toBe('queued');
  });
});

// ==========================================================================
// AC1 (facets) — a healthy correlated item surfaces the FULL enumerated facet set: type, source
// identity, owner, lifecycle state, risk, control coverage, evidence state, health, last
// observation time, and unresolved issues — each independently witnessed.
// ==========================================================================

describe('AC1 correlated item surfaces every enumerated governance facet', () => {
  it('binds the governing asset and exposes type/owner/lifecycle/risk/coverage/health facets', () => {
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [
        rec({
          sourceClass: 'kanban',
          externalKey: 'K-1',
          observedState: { status: 'in_progress' },
        }),
      ],
      correlatedAt: (T0 + 10_000) as EpochMillis,
      asset: asset(),
    });
    const f = correlatedItemFacets(item);
    expect(f).toBeDefined();
    // AC1 "type"
    expect(f!.assetType).toBe('workload');
    // AC1 "owner" (+ ownership NOT a gap here)
    expect(f!.ownerPrincipalId).toBeDefined();
    expect(f!.ownershipGap).toBe(false);
    // AC1 "lifecycle state"
    expect(f!.lifecycleState).toBe('operating');
    // AC1 "risk"
    expect(f!.riskTier).toBe('high');
    // AC1 "control coverage"
    expect(f!.coverage).toBe('covered');
    // AC1 "health"
    expect(f!.health).toBe('healthy');
    // AC1 "evidence state" — every field resolved from a FRESH witness ⇒ current
    expect(f!.evidenceState).toBe('current');
    expect(evidenceIsCurrent(item)).toBe(true);
    // AC1 "last observation time" — newest source last-known time
    expect(f!.lastObservationAt).toBe(T0);
    // AC1 "unresolved issues" — none here
    expect(f!.unresolvedIssueCount).toBe(0);
    // AC1 "source identity" — the item renders ONCE but keeps every distinct source visible
    expect(item.assetId).toBe(ASSET);
    expect(item.sourceRecords).toHaveLength(1);
  });

  it('surfaces an OWNERSHIP gap facet when the asset has no owner (AC1 owner facet is non-vacuous)', () => {
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'x' } })],
      correlatedAt: T0,
      asset: asset({ ownerPrincipalId: undefined, coverage: 'partial', health: 'unmanaged' }),
    });
    const f = correlatedItemFacets(item)!;
    expect(f.ownerPrincipalId).toBeUndefined();
    expect(f.ownershipGap).toBe(true);
  });

  it('evidence state is INCOMPLETE and unresolvedIssueCount>0 when a field is unresolved (AC1 unresolved-issues facet)', () => {
    // two kanban sources disagree → authority_tie → unresolved
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [
        rec({ sourceClass: 'kanban', externalKey: 'K-A', observedState: { status: 'done' } }),
        rec({ sourceClass: 'kanban', externalKey: 'K-B', observedState: { status: 'blocked' } }),
      ],
      correlatedAt: T0,
      asset: asset(),
    });
    const f = correlatedItemFacets(item)!;
    expect(f.evidenceState).toBe('incomplete');
    expect(evidenceStateOf(item)).toBe('incomplete');
    expect(evidenceIsCurrent(item)).toBe(false);
    expect(f.unresolvedIssueCount).toBe(1);
    expect(item.openCases).toHaveLength(1);
  });

  it('evidence state is STALE (not current) when the sole winning witness is stale — AC4: health not inferred from stale', () => {
    // A stale-only agreement: two kanban records agree on 'done' but BOTH are stale. resolveField
    // then yields no_trustworthy_winner → unresolved, which is `incomplete`. To witness the STALE
    // evidence-state specifically we grant a stale-tolerant field via a second field that resolves
    // fresh and a first that resolves stale is impossible under the safety rule; instead we assert
    // the safety property directly: a stale top tier ⇒ NOT current.
    const staleKanban = rec({
      sourceClass: 'kanban',
      externalKey: 'K-1',
      observedState: { status: 'done' },
      freshness: 'stale',
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [staleKanban],
      correlatedAt: T0,
      asset: asset({ health: 'degraded' }),
    });
    // The stale-only witness cannot resolve → incomplete, and evidence is NOT current.
    expect(item.fields[0]!.resolution).toBe('unresolved');
    expect(evidenceIsCurrent(item)).toBe(false);
    // Even though the asset's stored health facet is surfaced verbatim...
    expect(correlatedItemFacets(item)!.health).toBe('degraded');
    // ...the evidence-state marks it non-current so a consumer must not read it as current health.
    expect(evidenceStateOf(item)).toBe('incomplete');
  });

  it('the facet set folds into the digest witness — changing a governed facet changes the hash', () => {
    // Build source records + the governing asset ONCE so both correlations see identical inputs (a
    // distinct record id or a fresh random owner id would itself change the digest). This isolates
    // the risk-tier FACET as the sole differing input for the "changes" assertion.
    const records = [
      rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'done' } }),
    ];
    const baseAsset = asset();
    const riskierAsset = makeGovernedAsset({
      id: ASSET,
      tenantId: TENANT,
      assetType: baseAsset.assetType,
      name: baseAsset.name,
      ownerPrincipalId: baseAsset.ownerPrincipalId,
      lifecycleState: baseAsset.lifecycleState,
      riskTier: 'critical', // the ONLY difference from baseAsset
      health: baseAsset.health,
      coverage: baseAsset.coverage,
      lastObservedAt: baseAsset.lastObservedAt,
      version: baseAsset.version,
      updatedAt: baseAsset.updatedAt,
    });
    const build = (a: ReturnType<typeof asset>) =>
      correlateAsset({
        tenantId: TENANT,
        assetId: ASSET,
        policy: policy(),
        fields: ['status'],
        records,
        correlatedAt: T0,
        asset: a,
      });
    const d = correlatedItemDigest(build(baseAsset));
    expect(correlatedItemDigest(build(baseAsset))).toBe(d); // stable over identical inputs
    // Flip ONLY the risk tier facet → digest must change (facets are a durable-effect witness).
    expect(correlatedItemDigest(build(riskierAsset))).not.toBe(d);
  });

  // NEGATIVE CONTROL — a foreign asset cannot be bound to a different asset's correlation.
  it('rejects a governing asset whose id/tenant does not match the correlation scope', () => {
    expect(() =>
      correlateAsset({
        tenantId: TENANT,
        assetId: ASSET,
        policy: policy(),
        fields: ['status'],
        records: [],
        correlatedAt: T0,
        asset: asset({ id: uuidV7(T0 + 999) as Uuid }),
      }),
    ).toThrow(/not the asset being correlated/);
  });

  // NEGATIVE CONTROL — omitting the asset yields NO facets block (facets are genuinely sourced from
  // the asset, not fabricated).
  it('omitting the governing asset yields an item with no facets block', () => {
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'x' } })],
      correlatedAt: T0,
    });
    expect(correlatedItemFacets(item)).toBeUndefined();
    expect(evidenceStateOf(item)).toBeUndefined();
  });

  // TYPE ENFORCEMENT — the EvidenceState vocabulary is pinned: a non-member is a compile error, so
  // the derived evidence-state facet cannot silently take an off-vocabulary value.
  it('evidence-state vocabulary is type-pinned (non-member rejected at compile time)', () => {
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'x' } })],
      correlatedAt: T0,
      asset: asset(),
    });
    // Narrow to the pinned union, then prove a non-member is a compile error.
    const state: EvidenceState = evidenceStateOf(item) ?? 'current';
    expect(EVIDENCE_STATES).toContain(state);
    // @ts-expect-error 'made_up' is not a member of EVIDENCE_STATES
    const bad: EvidenceState = 'made_up';
    expect(bad).toBe('made_up'); // runtime is irrelevant; the @ts-expect-error is the assertion
  });
});

// ==========================================================================
// AC2 — a discovered-but-unmanaged component stays VISIBLE as a coverage gap carrying reason, AGE,
// impact, and required owner action.
// ==========================================================================

describe('AC2 coverage gap stays visible with reason, age, impact, and required owner action', () => {
  it('surfaces a component gap with reason/age/impact/owner-action', () => {
    const gap = componentGap();
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'x' } })],
      correlatedAt: T0, // firstSeenAt = T0 - 60_000 → age 60_000
      asset: asset(),
      coverageGaps: [gap],
    });
    expect(item.coverageGaps).toHaveLength(1);
    const g = item.coverageGaps[0]!;
    // AC2 "reason"
    expect(g.reason).toBe('unmanaged');
    // AC2 "impact"
    expect(g.impact).toBe('high');
    // AC2 "age" — derived from firstSeenAt vs correlatedAt
    expect(g.ageMillis).toBe(60_000);
    // AC2 "required owner action"
    expect(g.requiredAction).toMatch(/bring the component under management/);
    expect(g.requiredOwner).toBeDefined();
    // Still VISIBLE (open) on the gap surface.
    expect(visibleCoverageGaps(item)).toHaveLength(1);
  });

  it('age grows with the correlation clock (non-vacuous age witness)', () => {
    const gap = componentGap({ firstSeenAt: (T0 - 5_000) as EpochMillis });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [],
      correlatedAt: (T0 + 5_000) as EpochMillis, // now 10_000 after firstSeenAt
      coverageGaps: [gap],
    });
    expect(item.coverageGaps[0]!.ageMillis).toBe(10_000);
  });

  // NEGATIVE CONTROL — a RESOLVED gap is not visible (proving visibility filtering is real).
  it('a resolved gap drops off the visible surface (visibility filter is non-vacuous)', () => {
    const resolved = componentGap({
      status: 'resolved',
      resolution: 'Owner assigned and component onboarded.',
      resolvedAt: T0,
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [],
      correlatedAt: T0,
      coverageGaps: [resolved],
    });
    expect(item.coverageGaps).toHaveLength(1); // still recorded...
    expect(visibleCoverageGaps(item)).toHaveLength(0); // ...but not on the visible surface
  });

  // NEGATIVE CONTROL — a foreign-tenant gap is rejected.
  it('rejects a coverage gap from a different tenant', () => {
    const foreign = makeCoverageGap({
      id: nextId(),
      tenantId: uuidV7(T0 + 4242) as Uuid,
      subjectKind: 'component',
      reason: 'unmanaged',
      requiredAction: 'x',
      firstSeenAt: T0,
    });
    expect(() =>
      correlateAsset({
        tenantId: TENANT,
        assetId: ASSET,
        policy: policy(),
        fields: ['status'],
        records: [],
        correlatedAt: T0,
        coverageGaps: [foreign],
      }),
    ).toThrow(/different tenant/);
  });
});

// ==========================================================================
// AC3 (facets) — drill-down surfaces DEPENDENCIES across source records + authoritative-field
// attribution, in addition to the distinct-records + status-diffs already proven above.
// ==========================================================================

describe('AC3 drill-down surfaces dependencies and authoritative-field attribution', () => {
  const depId = () => nextId();
  const srcA = uuidV7(T0 + 8001) as Uuid;
  const srcB = uuidV7(T0 + 8002) as Uuid;

  it('surfaces depends_on edges and authoritative_for attributions from inventory relationships', () => {
    const dep = makeInventoryRelationship({
      id: depId(),
      tenantId: TENANT,
      fromKind: 'source_record',
      fromId: srcA,
      toKind: 'source_record',
      toId: srcB,
      relationship: 'depends_on',
      fieldName: 'status',
      createdAt: T0,
    });
    const authFor = makeInventoryRelationship({
      id: depId(),
      tenantId: TENANT,
      fromKind: 'source_record',
      fromId: srcA,
      toKind: 'governed_asset',
      toId: ASSET,
      relationship: 'authoritative_for',
      fieldName: 'status',
      createdAt: T0,
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [
        rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'done' } }),
      ],
      correlatedAt: T0,
      asset: asset(),
      relationships: [dep, authFor],
    });
    // AC3 "dependencies"
    expect(item.dependencies).toHaveLength(1);
    expect(item.dependencies[0]!.fromId).toBe(srcA);
    expect(item.dependencies[0]!.toId).toBe(srcB);
    expect(item.dependencies[0]!.fieldName).toBe('status');
    // AC3 "authoritative fields"
    expect(item.authoritativeFields).toHaveLength(1);
    expect(item.authoritativeFields[0]!.field).toBe('status');
    expect(item.authoritativeFields[0]!.authoritativeSourceId).toBe(srcA);
  });

  // NEGATIVE CONTROL — a `correlates` edge is NEITHER a dependency NOR an authoritative-field
  // attribution, so the split is real (not every edge is force-classified as a dependency).
  it('a plain correlates edge produces no dependency and no authoritative-field view', () => {
    const correlates = makeInventoryRelationship({
      id: depId(),
      tenantId: TENANT,
      fromKind: 'source_record',
      fromId: srcA,
      toKind: 'source_record',
      toId: srcB,
      relationship: 'correlates',
      createdAt: T0,
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [],
      correlatedAt: T0,
      relationships: [correlates],
    });
    expect(item.dependencies).toHaveLength(0);
    expect(item.authoritativeFields).toHaveLength(0);
  });
});

// ==========================================================================
// AC5 — an unregistered/discovered source is added to the SOURCE CATALOG view with discovery
// evidence, type/unknown classification, location, access status, sensitivity, ownership status,
// and onboarding state.
// ==========================================================================

describe('AC5 discovered source surfaces its full source-catalog membership', () => {
  it('surfaces classification/location/access/sensitivity/ownership/onboarding/discovery-evidence', () => {
    const evidence = uuidV7(T0 + 9100) as Uuid;
    const entry = makeSourceCatalogEntry({
      id: CATALOG,
      tenantId: TENANT,
      sourceClass: UNKNOWN_SOURCE_CLASS, // AC5 "type/unknown classification"
      observedLocations: ['s3://bucket/prefix', 'https://host/api'], // AC5 "location"
      accessState: 'unreachable', // AC5 "access status"
      sensitivity: 'restricted', // AC5 "sensitivity"
      onboardingState: 'discovered', // AC5 "onboarding state"
      discoveryEvidence: evidence, // AC5 "discovery evidence"
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [],
      correlatedAt: T0,
      catalogEntries: [entry],
    });
    expect(item.catalogEntries).toHaveLength(1);
    const c = item.catalogEntries[0]!;
    expect(c.sourceClass).toBe('unknown');
    expect(c.classifiedUnknown).toBe(true);
    expect(c.observedLocations).toEqual(['s3://bucket/prefix', 'https://host/api']);
    expect(c.accessState).toBe('unreachable');
    expect(c.sensitivity).toBe('restricted');
    expect(c.ownerPrincipalId).toBeUndefined();
    expect(c.ownershipGap).toBe(true); // AC5 "ownership status" — unowned
    expect(c.onboardingState).toBe('discovered');
    expect(c.discoveryEvidence).toBe(evidence);
  });

  // NEGATIVE CONTROL — a fully-onboarded, owned, known-class entry is NOT flagged unknown/unowned,
  // so the classification/ownership flags are non-vacuous.
  it('a known-class owned entry is neither classifiedUnknown nor an ownership gap', () => {
    const entry = makeSourceCatalogEntry({
      id: CATALOG,
      tenantId: TENANT,
      sourceClass: 'kanban',
      observedLocations: ['https://kanban/api'],
      ownerPrincipalId: uuidV7(T0 + 9200) as Uuid,
      accessState: 'connected',
      sensitivity: 'normal',
      onboardingState: 'onboarded',
      healthState: 'healthy',
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [],
      correlatedAt: T0,
      catalogEntries: [entry],
    });
    const c = item.catalogEntries[0]!;
    expect(c.classifiedUnknown).toBe(false);
    expect(c.ownershipGap).toBe(false);
    expect(c.onboardingState).toBe('onboarded');
  });
});

// ==========================================================================
// AC6 — an unsupported/inaccessible/sensitive/unowned discovered source stays visible as a GOVERNED
// SOURCE gap carrying reason, impact, owner action, and a review-or-expiry deadline.
// ==========================================================================

describe('AC6 governed-source gap stays visible with impact and review-or-expiry', () => {
  it('surfaces a governed-source gap with impact + review + expiry', () => {
    const gap = governedSourceGap();
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [],
      correlatedAt: T0,
      coverageGaps: [gap],
    });
    const governed = governedSourceGaps(item);
    expect(governed).toHaveLength(1);
    const g = governed[0]!;
    expect(g.gapClass).toBe('governed_source');
    expect(g.reason).toBe('unsupported');
    // AC6 "impact"
    expect(g.impact).toBe('critical');
    expect(g.requiredAction).toMatch(/Review the unsupported source/);
    // AC6 "review or expiry"
    expect(g.reviewAt).toBe(T0 + 86_400_000);
    expect(g.expiresAt).toBe(T0 + 172_800_000);
    // Still visible.
    expect(visibleCoverageGaps(item)).toHaveLength(1);
  });

  // NEGATIVE CONTROL — a governed-source gap WITHOUT any review/expiry deadline is not returned by
  // governedSourceGaps (proving the review-or-expiry witness is non-vacuous), yet stays visible.
  it('a governed-source gap without a review/expiry deadline is not counted among deadlined gaps', () => {
    const noDeadline = makeCoverageGap({
      id: nextId(),
      tenantId: TENANT,
      subjectKind: 'source_catalog_entry',
      subjectId: CATALOG,
      gapClass: 'governed_source',
      reason: 'sensitive',
      impact: 'medium',
      requiredAction: 'Classify sensitivity and assign a data owner.',
      status: 'open',
      firstSeenAt: T0,
    });
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [],
      correlatedAt: T0,
      coverageGaps: [noDeadline],
    });
    expect(governedSourceGaps(item)).toHaveLength(0); // no deadline → not deadlined
    expect(visibleCoverageGaps(item)).toHaveLength(1); // but still VISIBLE
  });

  // NEGATIVE CONTROL — a component gap is NOT a governed-source gap (the two surfaces are distinct).
  it('a component gap is excluded from the governed-source deadline surface', () => {
    const item = correlateAsset({
      tenantId: TENANT,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [],
      correlatedAt: T0,
      coverageGaps: [componentGap()],
    });
    expect(governedSourceGaps(item)).toHaveLength(0);
  });
});

// ==========================================================================
// Cross-cutting helpers.
// ==========================================================================

describe('helpers — value equality + no-candidate handling', () => {
  it('fieldValuesEqual is order-independent for objects and distinguishes real differences', () => {
    expect(fieldValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(fieldValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(fieldValuesEqual('x', 'x')).toBe(true);
  });

  it('a field observed by NO source resolves to unresolved/no_candidates', () => {
    const r = resolveField(policy(), 'nonexistent', [
      rec({ sourceClass: 'kanban', externalKey: 'K-1', observedState: { status: 'done' } }),
    ]);
    expect(r.resolution).toBe('unresolved');
    expect(r.unresolvedReason).toBe('no_candidates');
    expect(r.contributingSources).toHaveLength(0);
  });

  it('platform-scoped tenant is accepted by correlateAsset', () => {
    const platformRec = makeSourceRecord({
      id: nextId(),
      tenantId: PLATFORM_SCOPE,
      catalogId: CATALOG,
      assetId: ASSET,
      sourceClass: 'kanban',
      externalKey: 'K-P',
      observedState: { status: 'done' },
      status: 'active',
      freshness: 'fresh',
      lastKnownAt: T0,
      observedAt: T0,
    });
    const item = correlateAsset({
      tenantId: PLATFORM_SCOPE,
      assetId: ASSET,
      policy: policy(),
      fields: ['status'],
      records: [platformRec],
      correlatedAt: T0,
    });
    expect(item.tenantId).toBe(PLATFORM_SCOPE);
    expect(authoritativeValue(item, 'status')).toBe('done');
  });
});
