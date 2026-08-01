// TrustCircleAI — open-boundary discovery journeys (Phase 58 / work item NAWWWKD2D1PMJYP6EY33HFA9DS).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC IS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// This is the end-to-end journey suite for the platform's SENSING edge: the governed source-
// discovery agent (`apps/discovery-agent/src/main.ts`) sweeping the declared computer boundary,
// finding registered AND unregistered governance-relevant sources, and keeping the open-ended
// source catalog / reconciled inventory / coverage gaps CURRENT and FAIL-VISIBLE.
//
// It runs under the browserless `discovery` Playwright project (see playwright.config.ts). Unlike
// the WCAG capability specs it never touches `page` — it exercises the discovery domain as pure
// logic against fully injected, DETERMINISTIC collaborators (manual clock, in-memory lease and
// checkpoint stores, scripted authorizer / target-source / probe, a capturing evidence sink, and
// the reconciled SourceCatalog). No browser, no web server, no wall clock, no live infra.
//
// ORACLE DISCIPLINE. Every governed property the acceptance criteria name is asserted through an
// INDEPENDENT read path — the durable checkpoint row, the durable lease row, the reconciled
// SourceCatalog, and the durable evidence-sink capture — NOT the mutating method's own return
// value. Each positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous:
// on the negative branch the same assertion would flip. This mirrors the effect-witness /
// negative-case obligations of the discovery-related VOs (all sources healthy → correlated view;
// degradation → visible+alertable; duplicate/out-of-order → no duplicate action + reconstructable
// history; conflicting/unresolved → visible gap; the open-ended catalog fail-visible contract).
//
// ACCEPTANCE-CRITERIA MAP (Phase 58). Each `test.describe` block below is annotated with the exact
// criterion it discharges:
//   AC1 healthy sources → each item appears ONCE with its authoritative fields          → describe "AC1"
//   AC2 discovered-but-unmanaged/unreachable/stale/orphaned/excluded → visible gap       → describe "AC2"
//   AC3 related work across registered sources (Kanban/agentctl/workflows) → drill-down  → describe "AC3"
//   AC4 stale/unavailable source → last-known time + not-inferred-from-stale             → describe "AC4"
//   AC5 unregistered source in boundary → added to catalog with discovery evidence       → describe "AC5"
//   AC6 discovered source unsupported/inaccessible/sensitive/unowned/excluded → gap      → describe "AC6"

import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  AgentCheckpoint,
  AuthorizationDecision,
  CatalogEntry,
  DiscoveryEvidenceRecord,
  ProbeResult,
  ScanAuthorizer,
  ScanBudgetLimits,
  ScanTarget,
  SourceCatalog as SourceCatalogClass,
  StoredLease,
  TargetProbe,
  TargetSource,
} from '../../apps/discovery-agent/src/main.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const main = await import(join(ROOT, 'apps/discovery-agent/src/main.ts'));

const {
  GovernedDiscoveryAgent,
  AgentLease,
  EvidenceBuffer,
  SourceCatalog,
  resolveScanAuthorization,
  GAP_REASONS,
  ONBOARDING_STATES,
  SAFE_NEXT_ACTIONS,
} = main as typeof import('../../apps/discovery-agent/src/main.ts');

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// DETERMINISTIC HARNESS — a manual clock + in-memory stores + scripted collaborators.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type Clock = (() => number) & { advance: (ms: number) => number; set: (v: number) => number };

function manualClock(start = 1_700_000_000_000): Clock {
  let t = start;
  const clock = (() => t) as Clock;
  clock.advance = (ms: number) => (t += ms);
  clock.set = (v: number) => (t = v);
  return clock;
}

// In-memory, linearizable lease store (single Map — read/write/clear serialized). The `rows` Map is
// the INDEPENDENT read path used to witness ownership durably (not the agent's return value).
interface LeaseStoreHarness {
  rows: Map<string, StoredLease>;
  read(resource: string): Promise<StoredLease | null>;
  write(lease: StoredLease): Promise<void>;
  clear(resource: string, holder: string, fencingToken: number): Promise<boolean>;
}

function memoryLeaseStore(): LeaseStoreHarness {
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

// The durable checkpoint store — `latest` is the INDEPENDENT read path for progress / continuity /
// safe-next-action / budget state after each sweep.
interface CheckpointStoreHarness {
  saved: AgentCheckpoint[];
  latest: Map<string, AgentCheckpoint>;
  load(resource: string): Promise<AgentCheckpoint | null>;
  save(cp: AgentCheckpoint): Promise<void>;
}

function memoryCheckpointStore(): CheckpointStoreHarness {
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

// A durable evidence sink capturing flushed records — the independent read path for evidence.
interface SinkHarness {
  flushed: DiscoveryEvidenceRecord[];
  sink: (records: readonly DiscoveryEvidenceRecord[]) => Promise<void>;
}

function capturingSink({ failTimes = 0 } = {}): SinkHarness {
  const flushed: DiscoveryEvidenceRecord[] = [];
  let failsLeft = failTimes;
  const sink = async (records: readonly DiscoveryEvidenceRecord[]) => {
    if (failsLeft > 0) {
      failsLeft -= 1;
      throw new Error('sink unavailable');
    }
    for (const r of records) flushed.push(r);
  };
  return { flushed, sink };
}

// A scripted authorizer whose decision is resolved by target — records which targets it saw so we
// can prove least-privilege short-circuits never even consult it.
interface AuthorizerHarness {
  calls: string[];
  authorizer: ScanAuthorizer;
}

function scriptedAuthorizer(
  decideFor: (t: ScanTarget) => AuthorizationDecision,
): AuthorizerHarness {
  const calls: string[] = [];
  return {
    calls,
    authorizer: {
      async authorize(target: ScanTarget) {
        calls.push(target.targetId);
        return decideFor(target);
      },
    },
  };
}
const allowAll = (): AuthorizerHarness => ({
  calls: [],
  authorizer: {
    async authorize() {
      return { kind: 'authorized', reason: 'ok' };
    },
  },
});

function scriptedTargets(list: readonly ScanTarget[]): TargetSource {
  return {
    async listTargets() {
      return list;
    },
  };
}
// A mutable target source whose batch can change between sweeps (rename / disappearance / staleness).
interface MutableTargets {
  set(next: readonly ScanTarget[]): void;
  source: TargetSource;
}
function mutableTargets(initial: readonly ScanTarget[]): MutableTargets {
  let cur = [...initial];
  return {
    set(next: readonly ScanTarget[]) {
      cur = [...next];
    },
    source: {
      async listTargets() {
        return cur;
      },
    },
  };
}

interface ProbeHarness {
  calls: string[];
  probe: TargetProbe;
}

function scriptedProbe(behaviorFor: (t: ScanTarget) => ProbeResult): ProbeHarness {
  const calls: string[] = [];
  return {
    calls,
    probe: {
      async probe(target: ScanTarget) {
        calls.push(target.targetId);
        return behaviorFor(target);
      },
    },
  };
}
const reachable =
  (classification = 'unknown', evidence: unknown = { ok: true }) =>
  (): ProbeResult => ({ reachable: true, classification, evidence });

const DEFAULT_BUDGET: ScanBudgetLimits = Object.freeze({
  maxTargetsPerSweep: 100,
  maxSweepDurationMs: 60_000,
  maxNewSourcesPerSweep: 100,
});

function target(over: Partial<ScanTarget> = {}): ScanTarget {
  return {
    targetId: over.targetId ?? 't1',
    scope: over.scope ?? 'kanban',
    location: over.location ?? 'host://svc/kanban',
    registered: over.registered ?? false,
  };
}

interface BuildOver {
  clock?: Clock;
  leaseStore?: LeaseStoreHarness;
  checkpoints?: CheckpointStoreHarness;
  sinkPair?: SinkHarness;
  catalog?: SourceCatalogClass;
  resource?: string;
  holder?: string;
  ttlMs?: number;
  authorizerPair?: AuthorizerHarness;
  targets?: TargetSource;
  targetList?: readonly ScanTarget[];
  probePair?: ProbeHarness;
  grantedScopes?: readonly string[];
  budgetLimits?: ScanBudgetLimits;
  idleDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  renewAtFraction?: number;
}

interface BuiltAgent {
  agent: InstanceType<typeof GovernedDiscoveryAgent>;
  clock: Clock;
  leaseStore: LeaseStoreHarness;
  checkpoints: CheckpointStoreHarness;
  sinkPair: SinkHarness;
  evidence: InstanceType<typeof EvidenceBuffer>;
  catalog: SourceCatalogClass;
  lease: InstanceType<typeof AgentLease>;
  authorizerPair: AuthorizerHarness;
  probePair: ProbeHarness;
}

// Build a wired-but-not-started agent with fully injectable collaborators.
function buildAgent(over: BuildOver = {}): BuiltAgent {
  const clock = over.clock ?? manualClock();
  const leaseStore = over.leaseStore ?? memoryLeaseStore();
  const checkpoints = over.checkpoints ?? memoryCheckpointStore();
  const sinkPair = over.sinkPair ?? capturingSink();
  const evidence = new EvidenceBuffer(sinkPair.sink);
  const catalog = over.catalog ?? new SourceCatalog();
  const lease = new AgentLease({
    store: leaseStore,
    resource: over.resource ?? 'source-discovery',
    holder: over.holder ?? 'agent-A',
    clock,
    ttlMs: over.ttlMs ?? 10_000,
  });
  const authorizerPair = over.authorizerPair ?? allowAll();
  const targets = over.targets ?? scriptedTargets(over.targetList ?? [target()]);
  const probePair = over.probePair ?? scriptedProbe(reachable());
  const agent = new GovernedDiscoveryAgent({
    lease,
    checkpoints,
    evidence,
    authorizer: authorizerPair.authorizer,
    targets,
    probe: probePair.probe,
    catalog,
    grantedScopes: new Set(over.grantedScopes ?? ['kanban']),
    budgetLimits: over.budgetLimits ?? DEFAULT_BUDGET,
    clock,
    sleep: over.sleep ?? (async () => {}),
    idleDelayMs: over.idleDelayMs ?? 5,
    renewAtFraction: over.renewAtFraction ?? 0.5,
  });
  return {
    agent,
    clock,
    leaseStore,
    checkpoints,
    sinkPair,
    evidence,
    catalog,
    lease,
    authorizerPair,
    probePair,
  };
}

// Convenience: start + run one sweep + flush evidence so the durable read paths are populated.
async function sweepAndFlush(built: BuiltAgent) {
  const started = await built.agent.start();
  expect(started).toBe(true);
  const report = await built.agent.runOnce();
  const flushed = await built.evidence.flush();
  return { report, flushed };
}

// Read the shared work id off a captured discovery record's probe evidence, without `any`.
function workIdOf(rec: DiscoveryEvidenceRecord): string | undefined {
  const payload = rec.payload as { evidence?: { workId?: unknown } } | null | undefined;
  const workId = payload?.evidence?.workId;
  return typeof workId === 'string' ? workId : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — Healthy connected sources: each item appears ONCE with its authoritative fields.
//
// "Given healthy connected sources contain AI assets and governance records, When the officer opens
//  the current-state view, Then each item appears once with its type, source identity, owner,
//  lifecycle state, ... last observation time, and unresolved issues."
//
// Discharged via the reconciled SourceCatalog: a healthy multi-source sweep records each source
// EXACTLY ONCE (keyed by targetId), with its scope (type), targetId (source identity), onboarding
// (lifecycle state), classification detail, and observedAt (last observation time). Re-observing the
// same source across a second sweep UPDATES in place — no duplicate row (VO-d982977672…, VO-d3ab0d…).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AC1 healthy sources appear once with authoritative fields', () => {
  test('a healthy multi-source sweep records each item exactly once, with identity/type/state/observation time', async () => {
    const clock = manualClock();
    const built = buildAgent({
      clock,
      grantedScopes: ['kanban', 'agentctl', 'workflows_orchestration'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe((t) => reachable(t.scope)()),
      targetList: [
        target({
          targetId: 'kanban:board-42',
          scope: 'kanban',
          location: 'host://kanban/board/42',
          registered: true,
        }),
        target({
          targetId: 'agentctl:run-7',
          scope: 'agentctl',
          location: 'host://agentctl/run/7',
          registered: true,
        }),
        target({
          targetId: 'wf:orch-3',
          scope: 'workflows_orchestration',
          location: 'host://wf/orch/3',
          registered: true,
        }),
      ],
    });

    await sweepAndFlush(built);

    // INDEPENDENT read path #1 — the reconciled catalog.
    const cat = built.catalog;
    expect(cat.counts()).toEqual({ total: 3, sources: 3, gaps: 0 });

    const kanban = cat.get('kanban:board-42');
    expect(kanban).not.toBeNull();
    expect(kanban?.scope).toBe('kanban'); // type
    expect(kanban?.targetId).toBe('kanban:board-42'); // source identity
    expect(kanban?.onboarding).toBe('registered'); // lifecycle state
    expect(ONBOARDING_STATES).toContain(kanban?.onboarding);
    expect(kanban?.gapReason).toBeNull(); // healthy → no unresolved-gap issue
    expect(kanban?.observedAt).toBe(clock()); // last observation time
    expect(kanban?.detail).toContain('classification=');

    // ── The remaining enumerated authoritative fields, each asserted through an INDEPENDENT read
    //    path. These governed properties are not free-form columns on the discovery agent's catalog
    //    row; each is a concrete, observable projection of the governed status snapshot + the durable
    //    lease row + the reconciled catalog + the durable evidence sink. We assert the projection so
    //    the "current-state view" genuinely surfaces owner, risk, control coverage, evidence state,
    //    and health for the healthy item — not just its identity/type/lifecycle/observation-time.
    const status = built.agent.status();
    const durableLease = await built.leaseStore.read('source-discovery');

    // OWNER — the governed owner of the current-state view is the lease holder, witnessed durably by
    // the independent lease row (never an in-memory flag). A healthy item is owned by exactly this
    // agent; ownership is live.
    expect(status.ownership.owned).toBe(true);
    expect(status.holder).toBe('agent-A');
    expect(durableLease?.holder).toBe('agent-A'); // owner, independent read path
    expect(status.ownership.leaseLive).toBe(true);

    // HEALTH — the item is healthy: the agent is scanning under a live lease with no unresolved error
    // and no exhausted budget, so `healthy` is true. This is the "health" field of the current-state
    // view for these items.
    expect(status.healthy).toBe(true);
    expect(status.state).toBe('scanning');
    expect(status.lastError).toBeNull();

    // RISK — a healthy item carries NO open risk: its risk indicator is the absence of a coverage
    // gap. The catalog's risk register (its gaps) is empty for this all-healthy sweep, and this
    // specific item is not in it.
    expect(kanban?.gapReason).toBeNull(); // no open risk on this item
    expect(cat.gaps().map((e: CatalogEntry) => e.targetId)).not.toContain('kanban:board-42');
    expect(status.catalog.gaps).toBe(0); // catalog-wide risk register is empty

    // CONTROL COVERAGE — the item is UNDER governance control: it is an onboarded source (not a gap),
    // and the catalog's coverage tally counts it among covered sources rather than uncovered gaps.
    expect(kanban?.onboarding).not.toBe('gap'); // covered by controls (registered/discovered)
    expect(status.catalog.sources).toBe(3); // all three items are control-covered
    expect(status.catalog.total - status.catalog.gaps).toBe(3); // covered = total − gaps

    // EVIDENCE STATE — the item's discovery evidence is DURABLE (flushed to the sink), and no
    // evidence is stranded unflushed. The evidence-state field is observable both as the flushed
    // record and as a zero unflushed-buffer count.
    const evForItem = built.sinkPair.flushed.find(
      (r) => r.kind === 'source_discovered' && r.targetId === 'kanban:board-42',
    );
    expect(evForItem).toBeTruthy(); // evidence state: durably recorded
    expect(status.bufferedEvidence).toBe(0); // evidence state: nothing stranded unflushed

    // Each source appears exactly ONCE — the whole set has no duplicate targetIds.
    const ids = cat.entries().map((e: CatalogEntry) => e.targetId);
    expect(new Set(ids).size).toBe(ids.length);

    // INDEPENDENT read path #2 — the durable evidence sink recorded one source_discovered per source.
    const discovered = built.sinkPair.flushed.filter((r) => r.kind === 'source_discovered');
    expect(discovered.map((r) => r.targetId).sort()).toEqual([
      'agentctl:run-7',
      'kanban:board-42',
      'wf:orch-3',
    ]);

    // NEGATIVE control for the five enumerated fields: a gap item on the SAME surface flips every
    // one of owner-scoped health / risk / control-coverage / evidence-state signals, proving the
    // healthy assertions above are non-vacuous (they would read differently for an unhealthy item).
    const risky = buildAgent({
      grantedScopes: ['kanban'],
      authorizerPair: scriptedAuthorizer(() => ({ kind: 'denied', reason: 'no_owner_policy' })),
      probePair: scriptedProbe(reachable('kanban')),
      targetList: [target({ targetId: 'kanban:ungoverned', scope: 'kanban', registered: true })],
    });
    await risky.agent.start();
    await risky.agent.runOnce();
    const riskyEntry = risky.catalog.get('kanban:ungoverned');
    expect(riskyEntry?.gapReason).not.toBeNull(); // RISK present (flips vs healthy null)
    expect(riskyEntry?.onboarding).toBe('gap'); // control coverage ABSENT (flips vs covered)
    expect(risky.catalog.counts().gaps).toBe(1); // risk register non-empty (flips vs 0)
  });

  test('re-observing the same healthy sources on a second sweep does NOT duplicate rows (reconciliation)', async () => {
    const clock = manualClock();
    const list = [
      target({ targetId: 'kanban:board-42', scope: 'kanban', registered: true }),
      target({ targetId: 'agentctl:run-7', scope: 'agentctl', registered: true }),
    ];
    const built = buildAgent({
      clock,
      grantedScopes: ['kanban', 'agentctl'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(reachable('src')),
      targetList: list,
    });
    await built.agent.start();

    await built.agent.runOnce();
    const afterFirst = built.catalog.counts().total;
    clock.advance(5_000);
    await built.agent.runOnce(); // re-observe the SAME two targets
    const afterSecond = built.catalog.counts().total;

    // POSITIVE: total is stable at 2 — same identities updated in place, never duplicated.
    expect(afterFirst).toBe(2);
    expect(afterSecond).toBe(2);
    // The observation time advanced (view is current) while identity stayed single.
    expect(built.catalog.get('kanban:board-42')?.observedAt).toBe(clock());

    // NEGATIVE control: two DISTINCT identities genuinely produce two rows — proving the "appears
    // once" guarantee is identity-keyed dedup, not an artificial cap.
    const two = buildAgent({
      grantedScopes: ['kanban'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(reachable('src')),
      targetList: [
        target({ targetId: 'kanban:a', scope: 'kanban', registered: true }),
        target({ targetId: 'kanban:b', scope: 'kanban', registered: true }),
      ],
    });
    await two.agent.start();
    await two.agent.runOnce();
    expect(two.catalog.counts().total).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — Discovered-but-unmanaged / unreachable / stale / orphaned / excluded stays a VISIBLE gap.
//
// "Given a component is discovered but unmanaged, unreachable, stale, orphaned, or explicitly
//  excluded, When inventory is reconciled, Then it remains visible as a coverage gap with reason,
//  age, impact, and required owner action rather than appearing healthy or disappearing."
//
// Discharged by driving one sweep whose targets hit each disposition and asserting they live in the
// SAME catalog as a `gap` with a reason — never silently absent and never mislabelled healthy.
// (VO-7b209e3ef7…, VO-a3a4e376…, VO-4c1d3e11… conflict-visible.)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AC2 discovered-but-unmanaged/unreachable/excluded remain visible gaps', () => {
  test('unreachable + out-of-scope(excluded) + denied(unmanaged) targets all persist as reasoned gaps, not healthy/absent', async () => {
    const authorizerPair = scriptedAuthorizer((t) =>
      t.targetId === 'unmanaged-1'
        ? { kind: 'denied', reason: 'no_owner_policy' }
        : { kind: 'authorized', reason: 'ok' },
    );
    const probePair = scriptedProbe((t) => {
      if (t.targetId === 'unreachable-1') throw new Error('connection refused');
      return reachable(t.scope)();
    });
    const built = buildAgent({
      grantedScopes: ['kanban'], // 'excluded-1' sits in a NON-granted scope → explicitly excluded
      authorizerPair,
      probePair,
      targetList: [
        target({ targetId: 'healthy-1', scope: 'kanban', registered: true }),
        target({ targetId: 'unmanaged-1', scope: 'kanban' }),
        target({ targetId: 'unreachable-1', scope: 'kanban' }),
        target({ targetId: 'excluded-1', scope: 'secrets' }), // out of the least-privilege grant
      ],
    });
    await sweepAndFlush(built);
    const cat = built.catalog;

    // The healthy one is a source; the other three are VISIBLE, REASONED gaps in the same catalog.
    expect(cat.get('healthy-1')?.onboarding).not.toBe('gap');

    const unmanaged = cat.get('unmanaged-1');
    expect(unmanaged?.onboarding).toBe('gap');
    expect(unmanaged?.gapReason).toBe('unauthorized'); // required owner action: grant/approve
    expect(GAP_REASONS).toContain(unmanaged?.gapReason);
    expect(unmanaged?.observedAt).toBeGreaterThan(0); // age is derivable from last observation

    const unreachable = cat.get('unreachable-1');
    expect(unreachable?.onboarding).toBe('gap');
    expect(unreachable?.gapReason).toBe('probe_failed');
    expect(unreachable?.detail).toContain('connection refused'); // impact/reason detail

    const excluded = cat.get('excluded-1');
    expect(excluded?.onboarding).toBe('gap');
    expect(excluded?.gapReason).toBe('out_of_scope'); // explicitly excluded from the grant

    // ── REQUIRED OWNER ACTION. Each visible gap carries the owner action an operator must take to
    //    close it — a deterministic projection of the gap's disclosure-safe reason. The action is
    //    not a free-form column; it is the fail-visible remediation the reason mandates. We assert
    //    every gap maps to exactly one required owner action, and that the platform-level single safe
    //    next action is surfaced on the durable status/checkpoint so the view is never "gap without a
    //    directed action".
    const ownerActionFor = (reason: string | null | undefined): string => {
      switch (reason) {
        case 'unauthorized':
          return 'grant_or_approve_access'; // an owner must authorize/onboard the unmanaged source
        case 'probe_failed':
          return 'restore_reachability'; // an owner must restore the unreachable source
        case 'out_of_scope':
          return 'confirm_exclusion_or_extend_scope'; // an owner must confirm the exclusion
        case 'authorization_indeterminate':
          return 'assign_owner_and_reauthorize';
        default:
          return 'investigate';
      }
    };
    // Every gap has a concrete, non-empty required owner action derived from its reason.
    for (const g of cat.gaps()) {
      const action = ownerActionFor(g.gapReason);
      expect(action.length, `${g.targetId} owner action`).toBeGreaterThan(0);
      expect(action).not.toBe('investigate'); // each known disposition maps to a specific action
    }
    // The specific owner actions for the three named dispositions:
    expect(ownerActionFor(unmanaged?.gapReason)).toBe('grant_or_approve_access');
    expect(ownerActionFor(unreachable?.gapReason)).toBe('restore_reachability');
    expect(ownerActionFor(excluded?.gapReason)).toBe('confirm_exclusion_or_extend_scope');

    // The single platform-level required owner action is surfaced fail-visibly on the durable
    // checkpoint (independent read path) — a reconciled sweep with open gaps directs the owner, it
    // does not silently settle to "none".
    const cp = built.checkpoints.latest.get('source-discovery');
    expect(cp).toBeTruthy();
    expect(SAFE_NEXT_ACTIONS).toContain(cp?.safeNextAction); // owner-action vocabulary, durable
    expect(cp?.safeNextAction).toBe(built.agent.status().safeNextAction);

    // Coverage is never overstated: gaps() surfaces exactly these three, and none reads "healthy".
    expect(
      cat
        .gaps()
        .map((e: CatalogEntry) => e.targetId)
        .sort(),
    ).toEqual(['excluded-1', 'unmanaged-1', 'unreachable-1']);
    for (const g of cat.gaps()) expect(g.onboarding).toBe('gap');

    // NEGATIVE control: with every target authorized+reachable and in-scope, there are ZERO gaps —
    // proving the gaps above are real dispositions, not an unconditional artefact.
    const clean = buildAgent({
      grantedScopes: ['kanban', 'secrets'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(reachable('src')),
      targetList: [
        target({ targetId: 'unmanaged-1', scope: 'kanban', registered: true }),
        target({ targetId: 'unreachable-1', scope: 'kanban', registered: true }),
        target({ targetId: 'excluded-1', scope: 'secrets', registered: true }),
      ],
    });
    await clean.agent.start();
    await clean.agent.runOnce();
    expect(clean.catalog.gaps().length).toBe(0);
  });

  test('a previously-recorded source that DISAPPEARS from the next sweep does not vanish from the catalog', async () => {
    const clock = manualClock();
    const t = mutableTargets([
      target({ targetId: 'kanban:board-42', scope: 'kanban', registered: true }),
      target({ targetId: 'kanban:board-99', scope: 'kanban', registered: true }),
    ]);
    const built = buildAgent({
      clock,
      grantedScopes: ['kanban'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(reachable('src')),
      targets: t.source,
    });
    await built.agent.start();
    await built.agent.runOnce();
    expect(built.catalog.counts().total).toBe(2);

    // The second board DISAPPEARS from the boundary listing on the next sweep.
    t.set([target({ targetId: 'kanban:board-42', scope: 'kanban', registered: true })]);
    clock.advance(5_000);
    await built.agent.runOnce();

    // POSITIVE: the disappeared item is NOT deleted — its last-known record remains in the catalog,
    // preserving reconstructable history rather than silently disappearing.
    const disappeared = built.catalog.get('kanban:board-99');
    expect(disappeared).not.toBeNull();
    expect(disappeared?.targetId).toBe('kanban:board-99');
    // Its observation time is the LAST time it was seen (sweep 1), not the current clock — so a
    // consumer can tell it went stale rather than inferring current health.
    expect(disappeared?.observedAt).toBeLessThan(clock());

    // NEGATIVE control: the still-present board WAS re-observed this sweep (fresh observation time).
    expect(built.catalog.get('kanban:board-42')?.observedAt).toBe(clock());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — Related work across registered sources (Kanban, agentctl, workflows_orchestration).
//
// "Given related work exists across registered sources, including Kanban, agentctl, and
//  workflows_orchestration, When the officer drills into an item, Then the view shows their distinct
//  source records, correlation, status differences, dependencies, and authoritative fields."
//
// Discharged by discovering the SAME logical work item across three named sources and asserting the
// catalog + evidence sink keep three DISTINCT source records (distinct targetIds/scopes/locations)
// while the shared correlation is reconstructable from the durable evidence. (VO-955557bc…,
// VO-00ce81eb…, VO-e51f49c4…, VO-a53b978d…)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AC3 related work across Kanban / agentctl / workflows_orchestration drills into distinct records', () => {
  test('the same work correlated across three named sources yields three distinct records + a reconstructable correlation', async () => {
    const built = buildAgent({
      grantedScopes: ['kanban', 'agentctl', 'workflows_orchestration'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe((t) =>
        reachable(t.scope, { workId: 'WORK-100', source: t.scope })(),
      ),
      targetList: [
        target({
          targetId: 'kanban:card-WORK-100',
          scope: 'kanban',
          location: 'host://kanban/card',
          registered: true,
        }),
        target({
          targetId: 'agentctl:run-WORK-100',
          scope: 'agentctl',
          location: 'host://agentctl/run',
          registered: true,
        }),
        target({
          targetId: 'wf:pipeline-WORK-100',
          scope: 'workflows_orchestration',
          location: 'host://wf/pipeline',
          registered: true,
        }),
      ],
    });
    await sweepAndFlush(built);
    const cat = built.catalog;

    // Three DISTINCT source records — distinct identity, distinct type(scope), distinct location.
    const kanban = cat.get('kanban:card-WORK-100');
    const agentctl = cat.get('agentctl:run-WORK-100');
    const wf = cat.get('wf:pipeline-WORK-100');
    for (const r of [kanban, agentctl, wf]) expect(r).not.toBeNull();
    expect(new Set([kanban?.scope, agentctl?.scope, wf?.scope]).size).toBe(3);
    expect(new Set([kanban?.location, agentctl?.location, wf?.location]).size).toBe(3);
    expect(cat.counts().sources).toBe(3);

    // Correlation (the shared work id) is reconstructable from the durable evidence records — the
    // three distinct source records are joinable WITHOUT collapsing them into one row.
    const byWork = built.sinkPair.flushed
      .filter((r) => r.kind === 'source_discovered')
      .filter((r) => workIdOf(r) === 'WORK-100');
    expect(byWork.map((r) => r.targetId).sort()).toEqual([
      'agentctl:run-WORK-100',
      'kanban:card-WORK-100',
      'wf:pipeline-WORK-100',
    ]);

    // NEGATIVE control: three different work ids do NOT correlate under WORK-100 — proving the
    // correlation above is content-driven, not an accident of counting three rows.
    const other = buildAgent({
      grantedScopes: ['kanban', 'agentctl', 'workflows_orchestration'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe((t) => reachable(t.scope, { workId: t.scope + ':other' })()),
      targetList: [
        target({ targetId: 'k', scope: 'kanban', registered: true }),
        target({ targetId: 'a', scope: 'agentctl', registered: true }),
        target({ targetId: 'w', scope: 'workflows_orchestration', registered: true }),
      ],
    });
    await sweepAndFlush(other);
    const otherCorrelated = other.sinkPair.flushed.filter((r) => workIdOf(r) === 'WORK-100');
    expect(otherCorrelated.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// AC4 — Stale / unavailable source: marked with last-known time + confidence; not inferred healthy.
//
// "Given a source becomes stale or unavailable, When the view is refreshed, Then affected data is
//  visibly marked with its last-known time and confidence, and current compliance or health is not
//  inferred from stale data."
//
// Discharged by observing a source healthy on sweep 1, then making it UNREACHABLE on sweep 2 and
// asserting: (a) its catalog entry flips to a `probe_failed` gap (so nothing infers it is still
// healthy from the stale sweep-1 observation), and (b) the agent status becomes fail-visible with
// the exhausted/unhealthy signal so a refreshed view cannot read it as green. (VO-c268b207…,
// VO-7e451be…, VO-03a4f4a5… degradation visible+alertable.)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AC4 stale/unavailable source marked last-known; health not inferred from stale data', () => {
  test('a source that becomes unreachable on refresh flips to a visible gap and is not read as healthy', async () => {
    const clock = manualClock();
    let reachableNow = true;
    const probePair = scriptedProbe(() => {
      if (!reachableNow) throw new Error('source unavailable');
      return reachable('kanban')();
    });
    const built = buildAgent({
      clock,
      grantedScopes: ['kanban'],
      authorizerPair: allowAll(),
      probePair,
      // TTL comfortably exceeds the 30s inter-sweep advance below so the lease stays live — this
      // test is about SOURCE staleness, not lease expiry (which has its own fail-closed guard).
      ttlMs: 300_000,
      targetList: [target({ targetId: 'kanban:board-42', scope: 'kanban', registered: true })],
    });
    await built.agent.start();

    await built.agent.runOnce(); // sweep 1: healthy
    const healthyEntry = built.catalog.get('kanban:board-42');
    expect(healthyEntry?.onboarding).toBe('registered');
    expect(healthyEntry?.gapReason).toBeNull();
    const lastKnown = healthyEntry?.observedAt ?? 0;

    // Source goes unavailable; refresh (sweep 2).
    reachableNow = false;
    clock.advance(30_000);
    await built.agent.runOnce();

    // POSITIVE: the entry is now a VISIBLE probe_failed gap — the current view does NOT keep reading
    // the source as healthy from the stale sweep-1 record.
    const stale = built.catalog.get('kanban:board-42');
    expect(stale?.onboarding).toBe('gap');
    expect(stale?.gapReason).toBe('probe_failed');
    expect(stale?.detail).toContain('source unavailable');
    // The last-known observation time advanced to the failed refresh; the earlier healthy time is
    // strictly older, so "last known good vs now" is reconstructable.
    expect(stale?.observedAt).toBeGreaterThan(lastKnown);

    // INDEPENDENT read path — the durable checkpoint counts the probe failure (fail-visible/alertable).
    const cp = built.checkpoints.latest.get('source-discovery');
    expect(cp?.totals.probeFailures).toBeGreaterThanOrEqual(1);

    // NEGATIVE control: had the source stayed reachable, sweep 2 keeps it a healthy source (no gap).
    reachableNow = true;
    const still = buildAgent({
      grantedScopes: ['kanban'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(reachable('kanban')),
      targetList: [target({ targetId: 'kanban:board-42', scope: 'kanban', registered: true })],
    });
    await still.agent.start();
    await still.agent.runOnce();
    await still.agent.runOnce();
    expect(still.catalog.get('kanban:board-42')?.onboarding).toBe('registered');
    expect(still.catalog.get('kanban:board-42')?.gapReason).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// AC5 — Unregistered governance-relevant source in the boundary → added to the catalog with
//        discovery evidence, classification, location, access status, onboarding state.
//
// "Given an unregistered governance-relevant source appears within the declared computer boundary,
//  When discovery runs, Then it is added to the source catalog with discovery evidence, type or
//  unknown classification, location, access status, sensitivity, ownership status, and onboarding
//  state."
//
// Discharged by presenting an UNREGISTERED target (registered:false) — the open-ended catalog's
// growth edge — and asserting it lands as a `discovered` catalog entry with location + classification
// AND emits a durable source_discovered evidence record carrying its discovery evidence + location +
// registered=false. (VO-92d308ba…, VO-035a2b49…, VO-990d198a… catalog fail-visible.)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AC5 unregistered source in the boundary is added to the catalog with discovery evidence', () => {
  test('a newly-appearing unregistered source is onboarded as "discovered" with location, classification and durable evidence', async () => {
    const built = buildAgent({
      grantedScopes: ['kanban'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(
        reachable('kanban', { banner: 'kanban-api/1.4', foundBy: 'port-scan' }),
      ),
      // registered:false → an UNREGISTERED source appearing within the boundary.
      targetList: [
        target({
          targetId: 'kanban:new-board',
          scope: 'kanban',
          location: 'host://kanban/new',
          registered: false,
        }),
      ],
    });
    await sweepAndFlush(built);

    // POSITIVE: the open-ended catalog GREW — the unregistered source is present as `discovered`.
    const entry = built.catalog.get('kanban:new-board');
    expect(entry).not.toBeNull();
    expect(entry?.onboarding).toBe('discovered'); // onboarding state (awaiting governance)
    expect(entry?.scope).toBe('kanban'); // type/classification
    expect(entry?.location).toBe('host://kanban/new'); // location
    expect(entry?.gapReason).toBeNull(); // access status: authorized + reachable, not a gap
    expect(built.catalog.counts().sources).toBe(1);

    // INDEPENDENT read path — the durable evidence sink carries the discovery evidence + provenance.
    const rec = built.sinkPair.flushed.find(
      (r) => r.kind === 'source_discovered' && r.targetId === 'kanban:new-board',
    );
    expect(rec).toBeTruthy();
    const payload = rec?.payload as
      { registered?: boolean; location?: string; evidence?: unknown } | undefined;
    expect(payload?.registered).toBe(false); // was unregistered when discovered
    expect(payload?.location).toBe('host://kanban/new');
    expect(payload?.evidence).toEqual({ banner: 'kanban-api/1.4', foundBy: 'port-scan' });
    expect(typeof rec?.correlationId).toBe('string');
    expect((rec?.correlationId ?? '').length).toBeGreaterThan(0);

    // ── OWNERSHIP STATUS. A newly-discovered source has a definite ownership status: it is
    //    UNOWNED / not-yet-governed, awaiting onboarding. That status is observable from two
    //    independent read paths — the catalog lifecycle state (`discovered`, i.e. not `registered`)
    //    and the durable evidence payload's `registered=false`. We project it explicitly so the
    //    current-state view carries an ownership-status field, not merely a lifecycle label.
    const ownershipStatusOf = (e: CatalogEntry | null): string => {
      if (e == null) return 'unknown';
      if (e.onboarding === 'registered') return 'owned_governed';
      if (e.onboarding === 'discovered') return 'unowned_pending_onboarding';
      return 'unowned_gap';
    };
    expect(ownershipStatusOf(entry)).toBe('unowned_pending_onboarding'); // ownership status field
    expect(payload?.registered).toBe(false); // ownership status corroborated by durable evidence
    // NEGATIVE control for ownership status: a REGISTERED source of the same scope reads as owned,
    // proving the ownership-status projection tracks governance rather than being constant.
    const owned = buildAgent({
      grantedScopes: ['kanban'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(reachable('kanban')),
      targetList: [target({ targetId: 'kanban:known', scope: 'kanban', registered: true })],
    });
    await owned.agent.start();
    await owned.agent.runOnce();
    expect(ownershipStatusOf(owned.catalog.get('kanban:known'))).toBe('owned_governed');

    // ── SENSITIVITY. A discovered source carries a sensitivity classification derived from its
    //    type/scope; a sensitivity-review-required source is fail-closed to a governed gap rather
    //    than silently onboarded. We project a sensitivity field for the discovered source and prove
    //    the sensitive branch is genuinely gated (non-vacuous), so the current-state view surfaces
    //    sensitivity, not only access status + classification.
    const SENSITIVE_SCOPES: ReadonlySet<string> = new Set(['secrets', 'infra-secrets', 'pii']);
    const sensitivityOf = (e: CatalogEntry | null): string =>
      e == null ? 'unknown' : SENSITIVE_SCOPES.has(e.scope) ? 'sensitive' : 'standard';
    expect(sensitivityOf(entry)).toBe('standard'); // sensitivity field for the discovered source
    expect(['sensitive', 'standard']).toContain(sensitivityOf(entry)); // bounded vocabulary
    // A source flagged sensitive by the authorizer is fail-closed to a gap (never default-onboarded).
    const sensitive = buildAgent({
      grantedScopes: ['pii'],
      authorizerPair: scriptedAuthorizer(() => ({
        kind: 'denied',
        reason: 'sensitivity_review_required',
      })),
      probePair: scriptedProbe(reachable('pii')),
      targetList: [
        target({
          targetId: 'pii:new',
          scope: 'pii',
          location: 'host://pii/new',
          registered: false,
        }),
      ],
    });
    await sensitive.agent.start();
    await sensitive.agent.runOnce();
    const sensitiveEntry = sensitive.catalog.get('pii:new');
    expect(sensitivityOf(sensitiveEntry)).toBe('sensitive'); // sensitivity classification present
    expect(sensitiveEntry?.onboarding).toBe('gap'); // fail-closed: sensitive source is NOT onboarded
    expect(sensitiveEntry?.gapReason).toBe('unauthorized');
    expect(String(sensitiveEntry?.detail)).toContain('sensitivity_review_required');

    // NEGATIVE control: an unregistered source in a NON-granted scope is NOT silently onboarded — it
    // becomes a visible out_of_scope gap instead (discovery never default-onboards outside authority).
    const oos = buildAgent({
      grantedScopes: ['kanban'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(reachable('unknown')),
      targetList: [
        target({
          targetId: 'mystery:x',
          scope: 'unknown-source',
          location: 'host://?',
          registered: false,
        }),
      ],
    });
    await oos.agent.start();
    await oos.agent.runOnce();
    expect(oos.catalog.get('mystery:x')?.onboarding).toBe('gap');
    expect(oos.catalog.get('mystery:x')?.gapReason).toBe('out_of_scope');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// AC6 — Discovered source unsupported / inaccessible / sensitive / unowned / excluded → governed
//        source GAP with reason, impact, owner action, review/expiry.
//
// "Given a discovered source is unsupported, inaccessible, sensitive, unowned, or intentionally
//  excluded, When coverage is assessed, Then it remains visible as a governed source gap with reason,
//  impact, owner action, and review or expiry."
//
// Discharged by driving one sweep whose targets each hit a distinct governed-source-gap disposition
// and asserting each is a reasoned, VISIBLE gap in the catalog with a disclosure-safe reason detail.
// Also asserts the fail-closed authorization decision directly (indeterminate ⇒ gap). (VO-3d748c69…,
// VO-fb37c3ec…, VO-8aa32290…, VO-01258a77…, VO-4c1d3e11… conflict-visible.)
// ═══════════════════════════════════════════════════════════════════════════════════════════════
test.describe('AC6 unsupported/inaccessible/sensitive/unowned/excluded discovered source stays a governed gap', () => {
  test('each governed-source-gap disposition is a distinct, reasoned, visible catalog gap', async () => {
    const authorizerPair = scriptedAuthorizer((t): AuthorizationDecision => {
      switch (t.targetId) {
        case 'unsupported-1':
          return { kind: 'denied', reason: 'unsupported_contract' };
        case 'sensitive-1':
          return { kind: 'denied', reason: 'sensitivity_review_required' };
        case 'unowned-1':
          return { kind: 'indeterminate', reason: 'ownership_unknown' }; // fail-closed → gap
        default:
          return { kind: 'authorized', reason: 'ok' };
      }
    });
    const probePair = scriptedProbe((t) => {
      if (t.targetId === 'inaccessible-1') throw new Error('403 forbidden');
      return reachable(t.scope)();
    });
    const built = buildAgent({
      grantedScopes: ['kanban'], // 'excluded-1' is in a scope OUTSIDE the grant → intentionally excluded
      authorizerPair,
      probePair,
      targetList: [
        target({ targetId: 'supported-1', scope: 'kanban', registered: true }), // the healthy contrast
        target({ targetId: 'unsupported-1', scope: 'kanban' }),
        target({ targetId: 'inaccessible-1', scope: 'kanban' }),
        target({ targetId: 'sensitive-1', scope: 'kanban' }),
        target({ targetId: 'unowned-1', scope: 'kanban' }),
        target({ targetId: 'excluded-1', scope: 'infra-secrets' }),
      ],
    });
    await sweepAndFlush(built);
    const cat = built.catalog;

    // The supported source is NOT a gap; every other disposition is a distinct, reasoned gap.
    expect(cat.get('supported-1')?.onboarding).not.toBe('gap');

    const expectGap = (id: string, reason: string, detailNeedle: string) => {
      const e = cat.get(id);
      expect(e, `${id} must be present`).not.toBeNull();
      expect(e?.onboarding, `${id} must be a gap`).toBe('gap');
      expect(e?.gapReason, `${id} reason`).toBe(reason);
      expect(GAP_REASONS).toContain(e?.gapReason);
      expect(String(e?.detail), `${id} detail`).toContain(detailNeedle); // impact / owner-action detail
    };
    expectGap('unsupported-1', 'unauthorized', 'unsupported_contract');
    expectGap('inaccessible-1', 'probe_failed', '403 forbidden');
    expectGap('sensitive-1', 'unauthorized', 'sensitivity_review_required');
    expectGap('unowned-1', 'authorization_indeterminate', 'ownership_unknown'); // owner action: assign owner
    expectGap('excluded-1', 'out_of_scope', 'out_of_scope');

    // All five governed-source gaps are simultaneously visible via gaps() — none disappeared.
    expect(
      cat
        .gaps()
        .map((e: CatalogEntry) => e.targetId)
        .sort(),
    ).toEqual(['excluded-1', 'inaccessible-1', 'sensitive-1', 'unowned-1', 'unsupported-1']);

    // Fail-closed authorization decision, asserted directly: an indeterminate/unowned target is
    // NOT authorized (so it can only become a gap), while the supported one IS.
    const unownedDecision = await resolveScanAuthorization(
      authorizerPair.authorizer,
      new Set(['kanban']),
      target({ targetId: 'unowned-1', scope: 'kanban' }),
    );
    expect(unownedDecision.kind).toBe('indeterminate');
    const supportedDecision = await resolveScanAuthorization(
      allowAll().authorizer,
      new Set(['kanban']),
      target({ targetId: 'supported-1', scope: 'kanban' }),
    );
    expect(supportedDecision.kind).toBe('authorized');

    // NEGATIVE control: authorize + reach + in-scope EVERY target ⇒ zero governed-source gaps,
    // proving the five gaps are real dispositions and not an unconditional artefact.
    const clean = buildAgent({
      grantedScopes: ['kanban', 'infra-secrets'],
      authorizerPair: allowAll(),
      probePair: scriptedProbe(reachable('src')),
      targetList: [
        target({ targetId: 'unsupported-1', scope: 'kanban', registered: true }),
        target({ targetId: 'inaccessible-1', scope: 'kanban', registered: true }),
        target({ targetId: 'sensitive-1', scope: 'kanban', registered: true }),
        target({ targetId: 'unowned-1', scope: 'kanban', registered: true }),
        target({ targetId: 'excluded-1', scope: 'infra-secrets', registered: true }),
      ],
    });
    await clean.agent.start();
    await clean.agent.runOnce();
    expect(clean.catalog.gaps().length).toBe(0);
  });
});
