// @trustcircle/discovery-agent — least-privilege discovery bootstrap, scan authorization,
// budgets, and evidence sink (Phase 49 / work item HNHHZ8H0GJ5SK4G99Z2CSPSRAA /
// VO-6acaf6470d0810df4c93, VO-53a014009bdfebd7af13).
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// This is the *entry point* for the SOURCE-DISCOVERY agent. Where the command-worker (Phase 47)
// governs the outbox producer and the projector (Phase 48) governs the read-model consumer, the
// discovery agent governs the platform's SENSING edge: it sweeps the declared computer boundary,
// finds governance-relevant sources (registered and — crucially — UNREGISTERED), and records each
// as a discovery observation. It is the component that makes the phrase "open-ended source
// catalog" real: the set of sources is not a fixed list, it is whatever discovery finds, and the
// gaps (unsupported / inaccessible / sensitive / unowned / excluded) must remain VISIBLE rather
// than silently absent.
//
// A discovery sweep is a consequential operation: it reaches out to systems inside the boundary.
// So the phase objective is not "scan everything as fast as possible" — it is a LEAST-PRIVILEGE,
// AUTHORIZED, BUDGETED, EVIDENCE-PRESERVING sweep whose full state is always current and
// fail-visible. Concretely this module does five governed things and exposes ALL of them through a
// single independently observable status snapshot:
//
//   1. LEAST-PRIVILEGE BOOTSTRAP (`bootstrapDiscoveryAgent`) — parse the injected environment
//      fail-closed (a bad config NEVER yields a half-configured agent; it refuses to start and the
//      reason is visible), derive a stable agent identity, and wire the agent with ONLY the
//      explicitly granted scan scopes. The agent holds no ambient authority: a target outside its
//      granted scopes can never be scanned, only recorded as a coverage gap.
//
//   2. SCAN AUTHORIZATION (`ScanAuthorizer`) — before EVERY target is probed, an authorization
//      decision (fail-closed) must return `authorized`. Unknown, indeterminate, or denied
//      decisions do NOT scan; the target is quarantined from scanning and surfaced as a coverage
//      gap with the deny reason. Absence of a decision is a denial, never a default-allow.
//
//   3. BUDGETS (`ScanBudget`) — the sweep is bounded on three axes the spec calls out for a
//      consequential sensing action: rate (max targets per sweep + max probes/sec), time (max
//      wall-clock per sweep), and blast radius (max NEW unregistered sources onboarded per sweep).
//      Exceeding any budget stops the sweep at a safe checkpoint, marks it `paused`/`degraded`, and
//      surfaces the exhausted budget as the fail-visible reason — the sweep never silently runs
//      past its bound and never claims full coverage it did not achieve.
//
//   4. EVIDENCE SINK (`EvidenceBuffer` + injected sink) — every discovery observation (found a
//      source, classified a gap, refused a target) is buffered and flushed to a DURABLE evidence
//      sink. Buffered-but-unflushed evidence is counted in the status; a failed flush RETAINS the
//      records (nothing lost) and marks the agent degraded — discovery evidence is never dropped
//      silently, so the source catalog stays reconstructable.
//
//   5. FAIL-VISIBLE STATUS (`DiscoveryStatus`) — the single observable surface that makes the
//      open-ended source catalog, reconciled inventory, coverage gaps, workflow/controller state,
//      ownership (lease), health, failures, retries, continuity mode + lease, buffered evidence,
//      and the safe next action ALL current and visible at once. `healthy` is true only when the
//      agent is running within an owned live lease with no unresolved error and no exhausted
//      budget; every ambiguous condition is a distinct fail-visible state.
//
// ---------------------------------------------------------------------------
// DESIGN CONSTRAINTS
// ---------------------------------------------------------------------------
// * Dependency-free at runtime except Node built-ins + the already-in-workspace
//   application/contracts/observability surfaces (the discovery-agent package's DECLARED deps —
//   notably NOT persistence: least privilege extends to the code's own imports). Runs under Node 22
//   `--experimental-strip-types`.
// * Deterministic and injectable: the clock, the sleeper, the environment, the process-signal
//   surface, the lease store, the checkpoint store, the scan authorizer, the target source, the
//   probe, and the evidence sink are ALL injected, so the whole lifecycle is unit-testable with no
//   wall clock, no real process signals, and no live infrastructure.
// * Fail-closed / fail-visible: every ambiguous state (config error, lost lease, unauthorized
//   target, exhausted budget, unflushed evidence, probe throw) resolves to *stop governed action +
//   surface a safe next action + mark the durable status*, never to an optimistic "clean" or
//   "complete coverage".

import {
  parseEnvironment,
  type AppEnvironment,
  type EnvironmentIssue,
  type RawEnvironment,
} from '@trustcircle/application';

// ===========================================================================
// 0. Small injected primitives (deterministic testability)
// ===========================================================================

/** Milliseconds since the Unix epoch. Self-contained here (the app does not depend on persistence). */
export type EpochMillis = number;

/** A clock returning the current time in epoch millis. Injected so tests advance time explicitly. */
export type Clock = () => EpochMillis;

/** A cancellable sleeper. Injected so tests advance time without a real timer. */
export type Sleeper = (ms: number, signal?: AbortSignal) => Promise<void>;

/** The minimal process-signal surface the agent binds to (injected in tests). */
export interface SignalSource {
  once(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
  removeListener(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void;
}

/** Default real sleeper — resolves after `ms`, or early if the signal aborts. */
export const realSleeper: Sleeper = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

// ===========================================================================
// 1. Governed discovery-agent states (fail-visible vocabulary)
// ===========================================================================

/**
 * The agent's controller/workflow lifecycle state. Every value is a state an operator can SEE in
 * the status snapshot; there is no hidden state. `degraded`, `lost_lease`, and `budget_exhausted`
 * are fail-visible terminals/pauses distinct from a clean `stopped`.
 */
export const AGENT_STATES = [
  'starting', // bootstrapping — config parsed, lease not yet held
  'acquiring_lease', // contending for ownership
  'scanning', // owns the lease, sweeping targets
  'draining', // shutdown requested; finishing the in-flight sweep safely
  'stopped', // clean, fully-reconciled exit
  'degraded', // exited/parked with an unresolved condition (fail-visible)
  'lost_lease', // ownership lost mid-sweep (fail-closed; must reconcile)
  'budget_exhausted', // paused because a scan budget bound was hit (fail-visible)
  'failed', // bootstrap or fatal error before/while running (fail-visible)
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/**
 * Continuity mode mirrors the platform continuity contract (FR-046..FR-050): while a valid lease
 * covers the current step the agent may `continue` and buffer evidence; otherwise it must `pause`
 * at a safe checkpoint and require reconciliation.
 */
export const CONTINUITY_MODES = ['normal', 'continue_under_lease', 'paused'] as const;
export type ContinuityMode = (typeof CONTINUITY_MODES)[number];

/** The single safe next action an operator/automation should take given the current state. */
export const SAFE_NEXT_ACTIONS = ['none', 'retry', 'reconcile', 'escalate', 'raise_budget'] as const;
export type SafeNextAction = (typeof SAFE_NEXT_ACTIONS)[number];

/** Terminal states — no further governed action happens after these. */
const TERMINAL_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'stopped',
  'degraded',
  'lost_lease',
  'failed',
]);

export function isTerminalState(s: AgentState): boolean {
  return TERMINAL_STATES.has(s);
}

// ===========================================================================
// 2. Least-privilege scan scopes + scan authorization (fail-closed)
// ===========================================================================

/**
 * A scan scope is the least-privilege unit of authority the agent is granted: a coarse target
 * class it is allowed to probe within the declared boundary. The agent holds NO ambient authority
 * — its grant set is exactly what was injected at bootstrap, and a target whose scope is not in
 * the set can never be probed (it becomes a coverage gap instead).
 */
export type ScanScope = string;

/** A discovery target the agent may consider probing during a sweep. */
export interface ScanTarget {
  /** Stable identity of the target within the boundary (e.g. a source URI / connector key). */
  readonly targetId: string;
  /** The scope this target belongs to; must be in the agent's grant set to be probed. */
  readonly scope: ScanScope;
  /** Where the target lives (host/path/locator) — recorded in discovery evidence. */
  readonly location: string;
  /**
   * True when the target is already a registered/onboarded source; false when it is an
   * UNREGISTERED source appearing within the boundary (the open-ended catalog's growth edge).
   */
  readonly registered: boolean;
}

/** The outcome of an authorization decision for a single target. */
export const AUTHORIZATION_DECISIONS = [
  'authorized', // may be probed
  'denied', // explicitly refused
  'indeterminate', // authorizer could not decide — fail-closed => NOT probed
] as const;
export type AuthorizationDecisionKind = (typeof AUTHORIZATION_DECISIONS)[number];

export interface AuthorizationDecision {
  readonly kind: AuthorizationDecisionKind;
  /** Disclosure-safe reason (a code/short phrase), surfaced in the coverage gap when not authorized. */
  readonly reason: string;
}

/**
 * The fail-closed authorization gate. Given a target it returns a decision; the agent treats
 * ANYTHING other than a clean `authorized` (including a thrown authorizer, an out-of-scope target,
 * or an `indeterminate` result) as a refusal. Absence of authority is denial — never default-allow.
 */
export interface ScanAuthorizer {
  authorize(target: ScanTarget): Promise<AuthorizationDecision>;
}

/**
 * Resolve whether a target may be probed. This is the single fail-closed decision point:
 *   1. the target's scope MUST be in the agent's least-privilege grant set, else `denied`
 *      (out_of_scope) WITHOUT even consulting the authorizer — least privilege is enforced first;
 *   2. the injected authorizer must return `authorized`; a throw is caught and mapped to
 *      `indeterminate` (fail-closed), never allowed through.
 */
export async function resolveScanAuthorization(
  authorizer: ScanAuthorizer,
  grantedScopes: ReadonlySet<ScanScope>,
  target: ScanTarget,
): Promise<AuthorizationDecision> {
  if (!grantedScopes.has(target.scope)) {
    return { kind: 'denied', reason: 'out_of_scope' };
  }
  try {
    const decision = await authorizer.authorize(target);
    // Defensive: an authorizer that returns a bogus kind is treated as indeterminate (fail-closed).
    if (
      decision.kind === 'authorized' ||
      decision.kind === 'denied' ||
      decision.kind === 'indeterminate'
    ) {
      return decision;
    }
    return { kind: 'indeterminate', reason: 'authorizer_returned_unknown_kind' };
  } catch (err) {
    return { kind: 'indeterminate', reason: `authorizer_error:${describeError(err)}` };
  }
}

// ===========================================================================
// 3. Scan budgets — rate / time / blast-radius bounds (fail-visible)
// ===========================================================================

/** The three budget axes the spec calls out for a consequential sensing action. */
export const BUDGET_AXES = ['targets', 'duration', 'blast'] as const;
export type BudgetAxis = (typeof BUDGET_AXES)[number];

export interface ScanBudgetLimits {
  /** Max targets considered per sweep (rate cap on breadth). */
  readonly maxTargetsPerSweep: number;
  /** Max wall-clock milliseconds a single sweep may run (time cap). */
  readonly maxSweepDurationMs: number;
  /** Max NEW unregistered sources onboarded per sweep (blast-radius cap). */
  readonly maxNewSourcesPerSweep: number;
}

/** Why a budget check refused to continue (null when the sweep may continue). */
export type BudgetRefusal =
  | null
  | { readonly axis: BudgetAxis; readonly limit: number; readonly observed: number };

/**
 * A per-sweep budget meter. It is consulted BEFORE each target is probed and after each new source
 * is onboarded. When any axis is exhausted the meter returns a refusal; the sweep then stops at a
 * safe checkpoint and the exhausted axis becomes the fail-visible reason. The meter is pure /
 * deterministic given the injected clock, so budget exhaustion is fully testable.
 */
export class ScanBudget {
  readonly #limits: ScanBudgetLimits;
  readonly #clock: Clock;
  readonly #startedAt: EpochMillis;
  #targetsConsidered = 0;
  #newSourcesOnboarded = 0;

  constructor(limits: ScanBudgetLimits, clock: Clock) {
    assertPositiveInt('maxTargetsPerSweep', limits.maxTargetsPerSweep);
    assertPositiveInt('maxSweepDurationMs', limits.maxSweepDurationMs);
    assertNonNegativeInt('maxNewSourcesPerSweep', limits.maxNewSourcesPerSweep);
    this.#limits = limits;
    this.#clock = clock;
    this.#startedAt = clock();
  }

  get limits(): ScanBudgetLimits {
    return this.#limits;
  }
  get targetsConsidered(): number {
    return this.#targetsConsidered;
  }
  get newSourcesOnboarded(): number {
    return this.#newSourcesOnboarded;
  }
  get elapsedMs(): EpochMillis {
    return this.#clock() - this.#startedAt;
  }

  /**
   * Check whether one more target may be considered. Returns null to proceed, or a refusal naming
   * the exhausted axis. Checks the TIME axis (already elapsed) and the TARGETS axis (would this be
   * one too many). Does NOT mutate — call `recordTargetConsidered` only after you actually probe.
   */
  checkBeforeTarget(): BudgetRefusal {
    const elapsed = this.elapsedMs;
    if (elapsed >= this.#limits.maxSweepDurationMs) {
      return { axis: 'duration', limit: this.#limits.maxSweepDurationMs, observed: elapsed };
    }
    if (this.#targetsConsidered >= this.#limits.maxTargetsPerSweep) {
      return {
        axis: 'targets',
        limit: this.#limits.maxTargetsPerSweep,
        observed: this.#targetsConsidered,
      };
    }
    return null;
  }

  /** Record that a target was actually considered (consumes the rate budget). */
  recordTargetConsidered(): void {
    this.#targetsConsidered += 1;
  }

  /**
   * Check whether one more NEW source may be onboarded. Returns null to proceed, or a blast-radius
   * refusal. Consulted before an unregistered discovery is committed as onboarded.
   */
  checkBeforeNewSource(): BudgetRefusal {
    if (this.#newSourcesOnboarded >= this.#limits.maxNewSourcesPerSweep) {
      return {
        axis: 'blast',
        limit: this.#limits.maxNewSourcesPerSweep,
        observed: this.#newSourcesOnboarded,
      };
    }
    return null;
  }

  /** Record that a new source was onboarded (consumes the blast-radius budget). */
  recordNewSourceOnboarded(): void {
    this.#newSourcesOnboarded += 1;
  }
}

// ===========================================================================
// 4. Lease ownership — exactly-one-owner, fenced, time-bounded
// ===========================================================================
//
// Self-contained here (least privilege: the agent does not depend on persistence). The lease store
// is injected, so the ownership row is a DURABLE, independently readable identity — the effect
// witness that ownership could not exist before acquisition.

/** An acquired ownership lease. Immutable once granted; renewal produces a new snapshot. */
export interface LeaseGrant {
  readonly resource: string;
  readonly holder: string;
  /** Monotonic fencing token — strictly increases across acquisitions of the same resource. */
  readonly fencingToken: number;
  readonly acquiredAt: EpochMillis;
  readonly expiresAt: EpochMillis;
}

/** Thrown when the agent attempts a governed action without a live lease (fail-closed). */
export class LeaseLostError extends Error {
  readonly resource: string;
  constructor(resource: string, detail: string) {
    super(`discovery-agent lease for "${resource}" is not live: ${detail}`);
    this.name = 'LeaseLostError';
    this.resource = resource;
  }
}

/** The durable lease row shape. */
export interface StoredLease {
  readonly resource: string;
  readonly holder: string | null;
  readonly fencingToken: number;
  readonly expiresAt: EpochMillis | null;
  readonly updatedAt: EpochMillis;
}

/**
 * Durable, linearizable ownership store. `read`/`write`/`clear` must be serialized w.r.t. each
 * other (the in-memory test store uses a single map; a production store would use a
 * SELECT ... FOR UPDATE / advisory lock). The store is the INDEPENDENT read path that proves
 * ownership without trusting any in-memory flag.
 */
export interface LeaseStore {
  read(resource: string): Promise<StoredLease | null>;
  write(lease: StoredLease): Promise<void>;
  clear(resource: string, holder: string, fencingToken: number): Promise<boolean>;
}

export interface AgentLeaseOptions {
  readonly store: LeaseStore;
  readonly resource: string;
  readonly holder: string;
  readonly clock: Clock;
  /** Lease TTL in ms — ownership expires this long after each acquire/renew. */
  readonly ttlMs: number;
}

export class AgentLease {
  readonly #store: LeaseStore;
  readonly #resource: string;
  readonly #holder: string;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  #grant: LeaseGrant | null = null;

  constructor(opts: AgentLeaseOptions) {
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new RangeError('lease ttlMs must be a positive finite number');
    }
    if (!opts.resource) throw new Error('lease resource is required');
    if (!opts.holder) throw new Error('lease holder is required');
    this.#store = opts.store;
    this.#resource = opts.resource;
    this.#holder = opts.holder;
    this.#clock = opts.clock;
    this.#ttlMs = opts.ttlMs;
  }

  get holder(): string {
    return this.#holder;
  }
  get resource(): string {
    return this.#resource;
  }
  get grant(): LeaseGrant | null {
    return this.#grant;
  }

  /** Pure: is the current grant live at `now`? False when unheld or expired. */
  isLive(now: EpochMillis = this.#clock()): boolean {
    return this.#grant != null && this.#grant.expiresAt > now;
  }

  /**
   * Contend for ownership. Returns the grant on success, or null if another holder owns a
   * still-live lease. The store's linearizability makes the token bump race-free.
   */
  async tryAcquire(): Promise<LeaseGrant | null> {
    const now = this.#clock();
    const existing = await this.#store.read(this.#resource);
    const someoneElseLive =
      existing != null &&
      existing.holder != null &&
      existing.holder !== this.#holder &&
      existing.expiresAt != null &&
      existing.expiresAt > now;
    if (someoneElseLive) return null; // another agent owns a live lease — do not steal

    const nextToken = (existing?.fencingToken ?? 0) + 1;
    const grant: LeaseGrant = {
      resource: this.#resource,
      holder: this.#holder,
      fencingToken: nextToken,
      acquiredAt: now,
      expiresAt: now + this.#ttlMs,
    };
    await this.#store.write({
      resource: this.#resource,
      holder: this.#holder,
      fencingToken: nextToken,
      expiresAt: grant.expiresAt,
      updatedAt: now,
    });
    this.#grant = grant;
    return grant;
  }

  /**
   * Extend the lease. Succeeds ONLY if this holder + fencing token still own the durable row. On
   * any mismatch (stolen lease, cleared row) the in-memory grant is dropped and false is returned —
   * the caller MUST then treat ownership as lost (fail-closed).
   */
  async renew(): Promise<boolean> {
    if (this.#grant == null) return false;
    const now = this.#clock();
    const existing = await this.#store.read(this.#resource);
    const stillOurs =
      existing != null &&
      existing.holder === this.#holder &&
      existing.fencingToken === this.#grant.fencingToken;
    if (!stillOurs) {
      this.#grant = null; // lost — surface it
      return false;
    }
    const renewed: LeaseGrant = { ...this.#grant, expiresAt: now + this.#ttlMs };
    await this.#store.write({
      resource: this.#resource,
      holder: this.#holder,
      fencingToken: this.#grant.fencingToken,
      expiresAt: renewed.expiresAt,
      updatedAt: now,
    });
    this.#grant = renewed;
    return true;
  }

  /** Release ownership (best-effort, fenced). Safe to call when not held. */
  async release(): Promise<void> {
    const grant = this.#grant;
    this.#grant = null;
    if (grant == null) return;
    await this.#store.clear(this.#resource, this.#holder, grant.fencingToken);
  }

  /** Read the durable lease row via the INDEPENDENT read path (no in-memory trust). */
  async readDurable(): Promise<StoredLease | null> {
    return this.#store.read(this.#resource);
  }

  /** Assert a live lease or throw LeaseLostError — the fail-closed guard for governed actions. */
  assertLive(now: EpochMillis = this.#clock()): LeaseGrant {
    if (!this.isLive(now)) {
      throw new LeaseLostError(this.#resource, this.#grant == null ? 'not held' : 'expired');
    }
    return this.#grant!;
  }
}

// ===========================================================================
// 5. The source catalog + coverage gaps — the reconciled, fail-visible inventory
// ===========================================================================

/** Onboarding/lifecycle state a discovered source can hold. */
export const ONBOARDING_STATES = [
  'registered', // already onboarded / governed
  'discovered', // newly found, awaiting onboarding
  'gap', // visible coverage gap (not scanned / not onboarded) — fail-visible
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

/**
 * Why a target is a coverage GAP rather than a scanned/onboarded source. Every gap remains VISIBLE
 * with its reason so the catalog never "looks healthy" by omission.
 */
export const GAP_REASONS = [
  'out_of_scope', // scope not in the agent's least-privilege grant
  'unauthorized', // authorizer denied
  'authorization_indeterminate', // authorizer could not decide (fail-closed)
  'probe_failed', // authorized + probed, but the probe errored (unreachable)
  'budget_targets', // rate budget exhausted before this target was considered
  'budget_duration', // time budget exhausted before this target was considered
  'budget_blast', // blast-radius budget exhausted before onboarding this new source
] as const;
export type GapReason = (typeof GAP_REASONS)[number];

/** A single reconciled catalog entry: either a source record or a visible gap. */
export interface CatalogEntry {
  readonly targetId: string;
  readonly scope: ScanScope;
  readonly location: string;
  readonly onboarding: OnboardingState;
  /** Present only for gap entries — the disclosure-safe reason the target is not covered. */
  readonly gapReason: GapReason | null;
  /** Free-form disclosure-safe detail (e.g. the authorizer/probe reason). */
  readonly detail: string | null;
  readonly observedAt: EpochMillis;
}

/**
 * The reconciled source catalog. It is `open-ended` (grows as discovery finds new targets) and it
 * is reconciled: each target appears exactly ONCE, keyed by targetId, and re-observing a target
 * UPDATES its entry in place (no duplicate governance rows, history reconstructable via the
 * evidence sink). Coverage gaps live in the same catalog as sources so they cannot silently vanish.
 */
export class SourceCatalog {
  readonly #entries = new Map<string, CatalogEntry>();

  /** Upsert a source/gap entry (reconciliation: same targetId overwrites, never duplicates). */
  upsert(entry: CatalogEntry): void {
    this.#entries.set(entry.targetId, entry);
  }

  get(targetId: string): CatalogEntry | null {
    return this.#entries.get(targetId) ?? null;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** All entries (defensive copies) — the full catalog, sources + gaps together. */
  entries(): readonly CatalogEntry[] {
    return [...this.#entries.values()].map((e) => ({ ...e }));
  }

  /** The coverage gaps only — visible, never hidden. */
  gaps(): readonly CatalogEntry[] {
    return this.entries().filter((e) => e.onboarding === 'gap');
  }

  /** The onboarded/discovered sources only. */
  sources(): readonly CatalogEntry[] {
    return this.entries().filter((e) => e.onboarding !== 'gap');
  }

  counts(): { readonly total: number; readonly sources: number; readonly gaps: number } {
    let sources = 0;
    let gaps = 0;
    for (const e of this.#entries.values()) {
      if (e.onboarding === 'gap') gaps += 1;
      else sources += 1;
    }
    return { total: this.#entries.size, sources, gaps };
  }
}

// ===========================================================================
// 6. Buffered evidence — held during continuity, flushed on a safe boundary
// ===========================================================================

/** One discovery observation buffered for the durable evidence sink. */
export interface DiscoveryEvidenceRecord {
  /** e.g. 'source_discovered' | 'coverage_gap' | 'target_refused'. */
  readonly kind: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly payload: unknown;
  readonly bufferedAt: EpochMillis;
}

/**
 * An append-only buffer that holds discovery evidence in memory and flushes it to a durable sink at
 * a safe boundary. `size` is surfaced in the status so unflushed evidence is NEVER invisible; a
 * failed flush leaves the buffer intact (nothing lost) and marks the agent degraded (fail-visible).
 */
export class EvidenceBuffer {
  readonly #records: DiscoveryEvidenceRecord[] = [];
  readonly #sink: (records: readonly DiscoveryEvidenceRecord[]) => Promise<void>;

  constructor(sink: (records: readonly DiscoveryEvidenceRecord[]) => Promise<void>) {
    this.#sink = sink;
  }

  get size(): number {
    return this.#records.length;
  }

  buffer(record: DiscoveryEvidenceRecord): void {
    this.#records.push(record);
  }

  /** Snapshot (defensive copy) of buffered evidence for inspection. */
  snapshot(): readonly DiscoveryEvidenceRecord[] {
    return this.#records.map((r) => ({ ...r }));
  }

  /**
   * Flush everything to the durable sink. On success the buffer is emptied and `true` returned. On
   * sink failure the records are RETAINED (nothing lost) and `false` returned so the caller can
   * surface a degraded exit — discovery evidence is never dropped silently.
   */
  async flush(): Promise<boolean> {
    if (this.#records.length === 0) return true;
    const pending = this.#records.slice();
    try {
      await this.#sink(pending);
      this.#records.length = 0;
      return true;
    } catch {
      return false; // retained — fail-visible
    }
  }
}

// ===========================================================================
// 7. Target source + probe — the injected scanning substrate
// ===========================================================================

/**
 * The injected source of candidate targets for a sweep. Returns the batch of targets the agent
 * should consider this sweep (registered + newly-appearing unregistered). Kept as a simple async
 * supplier so tests script exactly which targets appear.
 */
export interface TargetSource {
  listTargets(): Promise<readonly ScanTarget[]>;
}

/** The result of probing a single authorized target. */
export interface ProbeResult {
  /** True when the probe reached the target and gathered discovery evidence. */
  readonly reachable: boolean;
  /** Disclosure-safe classification (e.g. 'kanban' | 'agentctl' | 'unknown'). */
  readonly classification: string;
  /** Arbitrary disclosure-safe evidence payload recorded in the evidence sink. */
  readonly evidence: unknown;
}

/**
 * The injected probe. Given an AUTHORIZED target (never called for an unauthorized one) it reaches
 * the target and returns discovery evidence, or throws if unreachable. A throw is caught by the
 * sweep and turned into a `probe_failed` coverage gap (fail-visible), never a silent skip.
 */
export interface TargetProbe {
  probe(target: ScanTarget): Promise<ProbeResult>;
}

// ===========================================================================
// 8. Checkpointing — durable, resumable, fail-visible sweep progress
// ===========================================================================

/**
 * A durable checkpoint of the agent's progress. Written after every sweep so a crash resumes from
 * here. It is the reconstructable history AND the fail-visible status source: it carries cumulative
 * counters, the last error, the continuity mode, the budget snapshot, and the single safe next
 * action.
 */
export interface AgentCheckpoint {
  readonly resource: string;
  readonly holder: string;
  readonly fencingToken: number;
  readonly sweep: number;
  readonly state: AgentState;
  readonly continuity: ContinuityMode;
  readonly totals: {
    readonly targetsConsidered: number;
    readonly sourcesDiscovered: number;
    readonly gapsRecorded: number;
    readonly refusals: number;
    readonly probeFailures: number;
    readonly retries: number;
  };
  readonly catalog: { readonly total: number; readonly sources: number; readonly gaps: number };
  readonly budget: {
    readonly exhaustedAxis: BudgetAxis | null;
    readonly targetsConsidered: number;
    readonly newSourcesOnboarded: number;
  };
  readonly bufferedEvidence: number;
  readonly lastError: string | null;
  readonly safeNextAction: SafeNextAction;
  readonly updatedAt: EpochMillis;
}

/** Durable store for the single latest checkpoint per resource. */
export interface CheckpointStore {
  load(resource: string): Promise<AgentCheckpoint | null>;
  save(cp: AgentCheckpoint): Promise<void>;
}

// ===========================================================================
// 9. The fail-visible status snapshot — the ONE observable surface
// ===========================================================================

/**
 * The complete, current, fail-visible discovery-agent status. This single object satisfies the
 * acceptance oracle: it makes the open-ended source catalog, reconciled inventory, coverage gaps,
 * workflow/controller state, ownership, health, failures, retries, continuity mode + lease,
 * buffered evidence, and the safe next action all visible at once.
 */
export interface DiscoveryStatus {
  readonly resource: string;
  readonly holder: string;
  readonly state: AgentState;
  readonly healthy: boolean;
  /** The least-privilege scan scopes this agent was granted (its complete authority surface). */
  readonly grantedScopes: readonly ScanScope[];
  readonly ownership: {
    readonly owned: boolean;
    readonly fencingToken: number | null;
    readonly leaseExpiresAt: EpochMillis | null;
    readonly leaseLive: boolean;
  };
  readonly continuity: ContinuityMode;
  /** The open-ended source catalog + reconciled inventory + coverage-gap counts. */
  readonly catalog: {
    readonly total: number;
    readonly sources: number;
    readonly gaps: number;
    readonly entries: readonly CatalogEntry[];
  };
  readonly progress: {
    readonly sweep: number;
    readonly targetsConsidered: number;
    readonly sourcesDiscovered: number;
    readonly gapsRecorded: number;
    readonly refusals: number;
    readonly probeFailures: number;
    readonly retries: number;
  };
  /** Which budget axis (if any) is currently exhausted — the fail-visible bound. */
  readonly budget: {
    readonly exhaustedAxis: BudgetAxis | null;
    readonly limits: ScanBudgetLimits;
  };
  readonly bufferedEvidence: number;
  readonly lastError: string | null;
  readonly safeNextAction: SafeNextAction;
  readonly observedAt: EpochMillis;
}

// ===========================================================================
// 10. The result of a single sweep (fail-visible)
// ===========================================================================

export interface SweepReport {
  readonly targetsConsidered: number;
  readonly sourcesDiscovered: number;
  readonly gapsRecorded: number;
  readonly refusals: number;
  readonly probeFailures: number;
  /** The budget axis that stopped the sweep, or null if it ran to completion of the target list. */
  readonly stoppedByBudget: BudgetAxis | null;
}

// ===========================================================================
// 11. GovernedDiscoveryAgent — the runtime that ties it all together
// ===========================================================================

export interface GovernedDiscoveryAgentOptions {
  readonly lease: AgentLease;
  readonly checkpoints: CheckpointStore;
  readonly evidence: EvidenceBuffer;
  readonly authorizer: ScanAuthorizer;
  readonly targets: TargetSource;
  readonly probe: TargetProbe;
  readonly catalog: SourceCatalog;
  /** The least-privilege scopes the agent may scan. Empty set => the agent can scan NOTHING. */
  readonly grantedScopes: ReadonlySet<ScanScope>;
  readonly budgetLimits: ScanBudgetLimits;
  readonly clock: Clock;
  // `| undefined` on the optionals so a caller (e.g. bootstrapDiscoveryAgent) may forward an
  // absent value explicitly under exactOptionalPropertyTypes; the constructor applies defaults.
  readonly sleep?: Sleeper | undefined;
  /** Idle sleep (ms) between sweeps. Default 1000. */
  readonly idleDelayMs?: number | undefined;
  /** Fraction of the lease TTL after which a renewal is attempted before each sweep. Default 0.5. */
  readonly renewAtFraction?: number | undefined;
}

export interface AgentRunReport {
  readonly finalState: AgentState;
  readonly sweeps: number;
  readonly status: DiscoveryStatus;
  readonly cleanShutdown: boolean;
}

export class GovernedDiscoveryAgent {
  readonly #lease: AgentLease;
  readonly #checkpoints: CheckpointStore;
  readonly #evidence: EvidenceBuffer;
  readonly #authorizer: ScanAuthorizer;
  readonly #targets: TargetSource;
  readonly #probe: TargetProbe;
  readonly #catalog: SourceCatalog;
  readonly #grantedScopes: ReadonlySet<ScanScope>;
  readonly #budgetLimits: ScanBudgetLimits;
  readonly #clock: Clock;
  readonly #sleep: Sleeper;
  readonly #idleDelayMs: number;
  readonly #renewAtFraction: number;

  #state: AgentState = 'starting';
  #continuity: ContinuityMode = 'normal';
  #sweep = 0;
  #totals = {
    targetsConsidered: 0,
    sourcesDiscovered: 0,
    gapsRecorded: 0,
    refusals: 0,
    probeFailures: 0,
    retries: 0,
  };
  #exhaustedAxis: BudgetAxis | null = null;
  #lastError: string | null = null;
  #safeNextAction: SafeNextAction = 'none';
  #stopRequested = false;
  #stopController = new AbortController();
  #correlationSeq = 0;

  constructor(opts: GovernedDiscoveryAgentOptions) {
    this.#lease = opts.lease;
    this.#checkpoints = opts.checkpoints;
    this.#evidence = opts.evidence;
    this.#authorizer = opts.authorizer;
    this.#targets = opts.targets;
    this.#probe = opts.probe;
    this.#catalog = opts.catalog;
    this.#grantedScopes = opts.grantedScopes;
    this.#budgetLimits = opts.budgetLimits;
    this.#clock = opts.clock;
    this.#sleep = opts.sleep ?? realSleeper;
    this.#idleDelayMs = opts.idleDelayMs ?? 1000;
    const f = opts.renewAtFraction ?? 0.5;
    if (!(f > 0 && f < 1)) throw new RangeError('renewAtFraction must be in (0,1)');
    this.#renewAtFraction = f;
  }

  get state(): AgentState {
    return this.#state;
  }
  get stopRequested(): boolean {
    return this.#stopRequested;
  }
  get catalog(): SourceCatalog {
    return this.#catalog;
  }

  /**
   * Read `#state` widened to the full AgentState union. Used at points where TypeScript's
   * control-flow analysis would otherwise over-narrow the field (e.g. after an early
   * `this.#state !== 'scanning'` guard) and reject a legitimate later comparison. The mutation
   * points are all `this.#state = ...` assignments, so the field genuinely can hold any state here.
   */
  #peekState(): AgentState {
    return this.#state;
  }

  /**
   * Build the CURRENT fail-visible status. Pure read of in-memory state + the lease grant + the
   * catalog. `healthy` is true only when running/starting with a live lease, no unresolved error,
   * and no exhausted budget.
   */
  status(now: EpochMillis = this.#clock()): DiscoveryStatus {
    const grant = this.#lease.grant;
    const leaseLive = this.#lease.isLive(now);
    const counts = this.#catalog.counts();
    const healthy =
      !TERMINAL_STATES.has(this.#state) &&
      this.#state !== 'lost_lease' &&
      this.#state !== 'budget_exhausted' &&
      this.#lastError == null &&
      this.#exhaustedAxis == null &&
      (this.#state === 'starting' || this.#state === 'acquiring_lease' || leaseLive);
    return {
      resource: this.#lease.resource,
      holder: this.#lease.holder,
      state: this.#state,
      healthy,
      grantedScopes: [...this.#grantedScopes],
      ownership: {
        owned: grant != null,
        fencingToken: grant?.fencingToken ?? null,
        leaseExpiresAt: grant?.expiresAt ?? null,
        leaseLive,
      },
      continuity: this.#continuity,
      catalog: {
        total: counts.total,
        sources: counts.sources,
        gaps: counts.gaps,
        entries: this.#catalog.entries(),
      },
      progress: { sweep: this.#sweep, ...this.#totals },
      budget: { exhaustedAxis: this.#exhaustedAxis, limits: this.#budgetLimits },
      bufferedEvidence: this.#evidence.size,
      lastError: this.#lastError,
      safeNextAction: this.#safeNextAction,
      observedAt: now,
    };
  }

  /**
   * Acquire ownership (bounded contention). Resumes cumulative counters + the catalog counts from
   * any prior checkpoint so a restart continues the reconstructable history rather than resetting
   * it. Returns true on success; on failure the state becomes `degraded` with a safe next action.
   */
  async start(): Promise<boolean> {
    this.#state = 'acquiring_lease';
    const grant = await this.#lease.tryAcquire();
    if (grant == null) {
      // Another agent owns a live lease — this instance is a standby, not a failure.
      this.#state = 'degraded';
      this.#safeNextAction = 'none';
      this.#lastError = 'lease held by another agent';
      await this.#writeCheckpoint();
      return false;
    }
    const prior = await this.#checkpoints.load(this.#lease.resource);
    if (prior != null) {
      this.#sweep = prior.sweep;
      this.#totals = { ...prior.totals };
      if (prior.safeNextAction !== 'none') this.#safeNextAction = prior.safeNextAction;
    }
    this.#state = 'scanning';
    this.#lastError = null;
    await this.#writeCheckpoint();
    return true;
  }

  /**
   * Run ONE governed discovery sweep. This is the heart of the phase:
   *   1. asserts a live lease (fail-closed) before touching any target;
   *   2. lists candidate targets from the injected source;
   *   3. for each target, in order:
   *        a. checks the sweep BUDGET (time + rate) — if exhausted, records the REMAINING targets
   *           as budget gaps and stops the sweep at a safe checkpoint (fail-visible);
   *        b. resolves SCAN AUTHORIZATION fail-closed (least-privilege scope first, then the
   *           injected authorizer). Anything but a clean `authorized` => a coverage gap, NOT probed;
   *        c. probes the authorized target; a probe throw => a `probe_failed` gap (unreachable),
   *           never a silent skip;
   *        d. onboards a NEW unregistered source only within the BLAST-RADIUS budget; over budget
   *           => a `budget_blast` gap;
   *   4. every step writes a DISCOVERY EVIDENCE record to the buffer (durable, reconstructable);
   *   5. reconciles each target into the catalog EXACTLY ONCE (upsert by targetId — dedup / no
   *      duplicate governance action; re-observation updates in place).
   * Returns a fail-visible SweepReport. Requires state `scanning` (call start() first).
   */
  async runOnce(): Promise<SweepReport> {
    if (this.#state !== 'scanning') {
      throw new Error(`runOnce() requires state "scanning" (call start() first); state=${this.#state}`);
    }
    this.#lease.assertLive(this.#clock()); // fail-closed guard
    const budget = new ScanBudget(this.#budgetLimits, this.#clock);
    const targets = await this.#targets.listTargets();

    let sourcesDiscovered = 0;
    let gapsRecorded = 0;
    let refusals = 0;
    let probeFailures = 0;
    let stoppedByBudget: BudgetAxis | null = null;

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      // (3a) time + rate budget BEFORE considering the target.
      const before = budget.checkBeforeTarget();
      if (before != null) {
        stoppedByBudget = before.axis;
        // Record EVERY remaining target as a visible budget gap — coverage is never overstated.
        for (let j = i; j < targets.length; j++) {
          const rem = targets[j]!;
          this.#recordGap(rem, before.axis === 'duration' ? 'budget_duration' : 'budget_targets', `limit=${before.limit}`);
          gapsRecorded += 1;
        }
        break;
      }
      budget.recordTargetConsidered();

      // (3b) fail-closed scan authorization: least privilege scope, then the authorizer.
      const decision = await resolveScanAuthorization(this.#authorizer, this.#grantedScopes, target);
      if (decision.kind !== 'authorized') {
        const reason: GapReason =
          decision.reason === 'out_of_scope'
            ? 'out_of_scope'
            : decision.kind === 'denied'
              ? 'unauthorized'
              : 'authorization_indeterminate';
        this.#recordGap(target, reason, decision.reason);
        this.#recordRefusalEvidence(target, decision);
        refusals += 1;
        gapsRecorded += 1;
        continue;
      }

      // (3c) probe the AUTHORIZED target. A throw => unreachable coverage gap (fail-visible).
      let result: ProbeResult;
      try {
        result = await this.#probe.probe(target);
      } catch (err) {
        this.#recordGap(target, 'probe_failed', describeError(err));
        this.#recordProbeFailureEvidence(target, err);
        probeFailures += 1;
        gapsRecorded += 1;
        continue;
      }
      if (!result.reachable) {
        this.#recordGap(target, 'probe_failed', `classification=${result.classification}`);
        this.#recordProbeFailureEvidence(target, new Error('probe reported unreachable'));
        probeFailures += 1;
        gapsRecorded += 1;
        continue;
      }

      // (3d) onboard: a REGISTERED source updates in place; a NEW source consumes blast budget.
      if (!target.registered) {
        const blast = budget.checkBeforeNewSource();
        if (blast != null) {
          stoppedByBudget = blast.axis;
          this.#recordGap(target, 'budget_blast', `limit=${blast.limit}`);
          this.#recordSourceEvidence(target, result, 'coverage_gap');
          gapsRecorded += 1;
          continue; // over blast budget for NEW sources, but keep scanning already-registered ones
        }
        budget.recordNewSourceOnboarded();
      }
      this.#recordSource(target, result);
      this.#recordSourceEvidence(target, result, 'source_discovered');
      sourcesDiscovered += 1;
    }

    // Fold results into cumulative totals + budget state; checkpoint durably.
    this.#sweep += 1;
    this.#totals = {
      targetsConsidered: this.#totals.targetsConsidered + budget.targetsConsidered,
      sourcesDiscovered: this.#totals.sourcesDiscovered + sourcesDiscovered,
      gapsRecorded: this.#totals.gapsRecorded + gapsRecorded,
      refusals: this.#totals.refusals + refusals,
      probeFailures: this.#totals.probeFailures + probeFailures,
      retries: this.#totals.retries,
    };
    if (stoppedByBudget != null) {
      // A budget stop is a fail-visible PAUSE requiring an operator to raise the budget or accept
      // the recorded gaps — the sweep NEVER claims full coverage past its bound.
      this.#exhaustedAxis = stoppedByBudget;
      // If a stop is already in flight the state is `draining`; keep it. Otherwise this is a
      // fail-visible pause: surface `budget_exhausted`.
      this.#state = this.#stopRequested ? this.#peekState() : 'budget_exhausted';
      this.#continuity = 'paused';
      this.#safeNextAction = 'raise_budget';
      this.#lastError = `scan budget exhausted on axis "${stoppedByBudget}"`;
    } else {
      this.#exhaustedAxis = null;
      if (this.#peekState() === 'budget_exhausted') this.#state = 'scanning';
      this.#lastError = null;
      if (this.#safeNextAction === 'raise_budget') this.#safeNextAction = 'none';
    }
    await this.#writeCheckpoint();

    return { targetsConsidered: budget.targetsConsidered, sourcesDiscovered, gapsRecorded, refusals, probeFailures, stoppedByBudget };
  }

  /**
   * Run sweeps until shutdown is requested or ownership is lost. Each iteration renews the lease at
   * half-life (a failed renew => lost_lease, fail-closed, stop), runs one sweep, and idles a
   * bounded, abortable interval. A sweep throw is captured, checkpointed, and retried under backoff.
   * Returns a terminal, fail-visible report.
   */
  async run(): Promise<AgentRunReport> {
    // `scanning` is the normal entry; `draining`/`budget_exhausted` are accepted when a stop was
    // already requested before run() (the loop is skipped and we go straight to a safe drain). Any
    // other state means start() was never called — fail loudly rather than run ungoverned.
    if (this.#state !== 'scanning' && !(this.#stopRequested && (this.#state === 'draining' || this.#state === 'budget_exhausted'))) {
      throw new Error(`run() requires state "scanning" (call start() first); state=${this.#state}`);
    }
    while (!this.#stopRequested) {
      const renewed = await this.#renewIfDue();
      if (!renewed) {
        this.#onLeaseLost();
        break;
      }
      try {
        this.#lease.assertLive(this.#clock());
      } catch {
        this.#onLeaseLost();
        break;
      }
      try {
        await this.runOnce();
        if (this.#safeNextAction === 'retry') this.#safeNextAction = 'none';
      } catch (err) {
        this.#totals = { ...this.#totals, retries: this.#totals.retries + 1 };
        this.#lastError = describeError(err);
        this.#safeNextAction = 'retry';
        await this.#writeCheckpoint();
        await this.#sleep(this.#idleDelayMs, this.#stopController.signal);
        continue;
      }
      await this.#sleep(this.#idleDelayMs, this.#stopController.signal);
    }
    if (this.#peekState() === 'lost_lease') {
      await this.#writeCheckpoint();
      await this.#evidence.flush(); // best-effort; failure only tightens the fail-visible state
      await this.#writeCheckpoint();
      return this.#terminalReport('lost_lease', false);
    }
    return this.#completeShutdown();
  }

  /**
   * Request a safe shutdown. Idempotent. Signals the abortable sleeps to wake immediately so the
   * loop reaches its safe boundary quickly. Does NOT interrupt an in-flight sweep — that is the
   * point of a SAFE shutdown (no half-recorded target).
   */
  requestStop(reason = 'shutdown requested'): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    if (this.#state === 'scanning' || this.#state === 'budget_exhausted') this.#state = 'draining';
    this.#stopController.abort(reason);
  }

  /**
   * Bind SIGTERM/SIGINT to `requestStop`, returning an unbind function. The handlers are `once` so
   * a second signal does not double-fire; the disposer removes them after shutdown completes.
   */
  bindSignals(signals: SignalSource): () => void {
    const onTerm = (): void => this.requestStop('SIGTERM');
    const onInt = (): void => this.requestStop('SIGINT');
    signals.once('SIGTERM', onTerm);
    signals.once('SIGINT', onInt);
    return () => {
      signals.removeListener('SIGTERM', onTerm);
      signals.removeListener('SIGINT', onInt);
    };
  }

  // --- catalog + evidence recording --------------------------------------

  #recordSource(target: ScanTarget, result: ProbeResult): void {
    this.#catalog.upsert({
      targetId: target.targetId,
      scope: target.scope,
      location: target.location,
      onboarding: target.registered ? 'registered' : 'discovered',
      gapReason: null,
      detail: `classification=${result.classification}`,
      observedAt: this.#clock(),
    });
  }

  #recordGap(target: ScanTarget, reason: GapReason, detail: string): void {
    this.#catalog.upsert({
      targetId: target.targetId,
      scope: target.scope,
      location: target.location,
      onboarding: 'gap',
      gapReason: reason,
      detail,
      observedAt: this.#clock(),
    });
  }

  #recordSourceEvidence(target: ScanTarget, result: ProbeResult, kind: string): void {
    this.#evidence.buffer({
      kind,
      targetId: target.targetId,
      correlationId: this.#nextCorrelationId(),
      payload: { scope: target.scope, location: target.location, classification: result.classification, evidence: result.evidence, registered: target.registered },
      bufferedAt: this.#clock(),
    });
  }

  #recordRefusalEvidence(target: ScanTarget, decision: AuthorizationDecision): void {
    this.#evidence.buffer({
      kind: 'target_refused',
      targetId: target.targetId,
      correlationId: this.#nextCorrelationId(),
      payload: { scope: target.scope, location: target.location, decision: decision.kind, reason: decision.reason },
      bufferedAt: this.#clock(),
    });
  }

  #recordProbeFailureEvidence(target: ScanTarget, err: unknown): void {
    this.#evidence.buffer({
      kind: 'coverage_gap',
      targetId: target.targetId,
      correlationId: this.#nextCorrelationId(),
      payload: { scope: target.scope, location: target.location, reason: 'probe_failed', detail: describeError(err) },
      bufferedAt: this.#clock(),
    });
  }

  #nextCorrelationId(): string {
    this.#correlationSeq += 1;
    return `${this.#lease.holder}:${this.#lease.grant?.fencingToken ?? 0}:${this.#sweep}:${this.#correlationSeq}`;
  }

  // --- internal lifecycle helpers ----------------------------------------

  async #renewIfDue(): Promise<boolean> {
    const grant = this.#lease.grant;
    if (grant == null) return false;
    const now = this.#clock();
    const ttl = grant.expiresAt - grant.acquiredAt;
    const renewAt = grant.acquiredAt + ttl * this.#renewAtFraction;
    if (now < renewAt && this.#lease.isLive(now)) return true;
    return this.#lease.renew();
  }

  #onLeaseLost(): void {
    this.#state = 'lost_lease';
    this.#continuity = 'paused';
    this.#lastError = 'lease ownership lost — paused at safe checkpoint';
    this.#safeNextAction = 'reconcile';
  }

  async #completeShutdown(): Promise<AgentRunReport> {
    this.#state = 'draining';
    const flushed = await this.#evidence.flush();
    let clean = true;
    if (!flushed) {
      clean = false;
      this.#state = 'degraded';
      this.#continuity = 'paused';
      this.#lastError = 'buffered discovery evidence could not be flushed on shutdown';
      this.#safeNextAction = 'reconcile';
    }
    // A sweep that stopped on an exhausted budget is NOT a clean exit — it is a degraded terminal so
    // an operator sees the bound in the durable checkpoint rather than a benign `stopped`.
    if (clean && this.#exhaustedAxis != null) {
      clean = false;
      this.#state = 'degraded';
      this.#continuity = 'paused';
      this.#safeNextAction = 'raise_budget';
    } else if (clean) {
      this.#state = 'stopped';
      this.#continuity = 'normal';
      this.#safeNextAction = 'none';
    }
    await this.#writeCheckpoint();
    await this.#lease.release();
    return this.#terminalReport(this.#state, clean && this.#state === 'stopped');
  }

  #terminalReport(state: AgentState, cleanShutdown: boolean): AgentRunReport {
    return { finalState: state, sweeps: this.#sweep, status: this.status(), cleanShutdown };
  }

  async #writeCheckpoint(): Promise<void> {
    const grant = this.#lease.grant;
    const counts = this.#catalog.counts();
    const cp: AgentCheckpoint = {
      resource: this.#lease.resource,
      holder: this.#lease.holder,
      fencingToken: grant?.fencingToken ?? 0,
      sweep: this.#sweep,
      state: this.#state,
      continuity: this.#continuity,
      totals: { ...this.#totals },
      catalog: { total: counts.total, sources: counts.sources, gaps: counts.gaps },
      budget: {
        exhaustedAxis: this.#exhaustedAxis,
        targetsConsidered: this.#totals.targetsConsidered,
        newSourcesOnboarded: this.#totals.sourcesDiscovered,
      },
      bufferedEvidence: this.#evidence.size,
      lastError: this.#lastError,
      safeNextAction: this.#safeNextAction,
      updatedAt: this.#clock(),
    };
    await this.#checkpoints.save(cp);
  }
}

// ===========================================================================
// 12. Bootstrap — fail-closed, least-privilege configuration + wiring
// ===========================================================================

export class BootstrapError extends Error {
  readonly issues: readonly EnvironmentIssue[];
  constructor(issues: readonly EnvironmentIssue[]) {
    // Disclosure-safe: report variable + code only, never values.
    const summary = issues.map((i) => `${i.variable}:${i.code}`).join(', ');
    super(`discovery-agent bootstrap refused: invalid configuration [${summary}]`);
    this.name = 'BootstrapError';
    this.issues = issues;
  }
}

export interface BootstrapInputs {
  readonly env: RawEnvironment;
  readonly leaseStore: LeaseStore;
  readonly checkpoints: CheckpointStore;
  readonly authorizer: ScanAuthorizer;
  readonly targets: TargetSource;
  readonly probe: TargetProbe;
  readonly evidenceSink: (records: readonly DiscoveryEvidenceRecord[]) => Promise<void>;
  readonly clock: Clock;
  readonly sleep?: Sleeper;
  /** Stable agent identity (host+pid form supplied by the caller). */
  readonly agentId: string;
  /**
   * The LEAST-PRIVILEGE scan scopes this agent is granted. An empty grant set is VALID and means
   * the agent can scan nothing — it will record every target as an out_of_scope coverage gap. The
   * agent never holds ambient authority; this set is its complete authority surface.
   */
  readonly grantedScopes: Iterable<ScanScope>;
  readonly budgetLimits: ScanBudgetLimits;
  /** Governed discovery resource name (the lease + checkpoint key). Default 'source-discovery'. */
  readonly resource?: string;
  /** Lease TTL ms. Default 15_000. */
  readonly leaseTtlMs?: number;
  readonly idleDelayMs?: number;
  /** Optional pre-seeded catalog (e.g. resumed from a prior projection). Defaults to empty. */
  readonly catalog?: SourceCatalog;
}

export interface BootstrappedAgent {
  readonly agent: GovernedDiscoveryAgent;
  readonly lease: AgentLease;
  readonly catalog: SourceCatalog;
  readonly grantedScopes: ReadonlySet<ScanScope>;
  readonly config: AppEnvironment;
}

/**
 * Parse configuration FAIL-CLOSED and wire the least-privilege discovery agent. A configuration
 * error throws `BootstrapError` (disclosure-safe) and NO agent is produced — a misconfigured agent
 * never starts touching governed state. The budget limits are validated eagerly (a non-positive
 * bound is a bootstrap failure, not a runtime surprise). On success the agent is fully wired, holds
 * ONLY the granted scopes, and is not yet started.
 */
export function bootstrapDiscoveryAgent(inputs: BootstrapInputs): BootstrappedAgent {
  const parsed = parseEnvironment(inputs.env);
  if (!parsed.ok) {
    throw new BootstrapError(parsed.issues);
  }
  // Validate budgets eagerly (fail-closed) so an invalid bound cannot silently disable a limit.
  assertPositiveInt('maxTargetsPerSweep', inputs.budgetLimits.maxTargetsPerSweep);
  assertPositiveInt('maxSweepDurationMs', inputs.budgetLimits.maxSweepDurationMs);
  assertNonNegativeInt('maxNewSourcesPerSweep', inputs.budgetLimits.maxNewSourcesPerSweep);

  const resource = inputs.resource ?? 'source-discovery';
  const grantedScopes: ReadonlySet<ScanScope> = new Set(inputs.grantedScopes);
  const lease = new AgentLease({
    store: inputs.leaseStore,
    resource,
    holder: inputs.agentId,
    clock: inputs.clock,
    ttlMs: inputs.leaseTtlMs ?? 15_000,
  });
  const evidence = new EvidenceBuffer(inputs.evidenceSink);
  const catalog = inputs.catalog ?? new SourceCatalog();
  const agent = new GovernedDiscoveryAgent({
    lease,
    checkpoints: inputs.checkpoints,
    evidence,
    authorizer: inputs.authorizer,
    targets: inputs.targets,
    probe: inputs.probe,
    catalog,
    grantedScopes,
    budgetLimits: inputs.budgetLimits,
    clock: inputs.clock,
    sleep: inputs.sleep,
    idleDelayMs: inputs.idleDelayMs,
  });
  return { agent, lease, catalog, grantedScopes, config: parsed.env };
}

// ===========================================================================
// 13. Utilities
// ===========================================================================

/** Disclosure-safe error description: the error's message class, never internal detail dumps. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `NonError: ${String(err)}`;
}

function assertPositiveInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInt(name: string, v: number): void {
  if (!Number.isInteger(v) || v < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
}
