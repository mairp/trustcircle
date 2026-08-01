// @trustcircle/discovery-agent — periodic & on-demand discovery SCHEDULING over the governed
// least-privilege sweep (Phase 74 / work item VG924JZDB48J1T6Q2EDCMR6G77).
//
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
// ---------------------------------------------------------------------------
// `main.ts` gives us the governed *sweep* — a single fail-closed, least-privilege, budgeted,
// evidence-preserving pass over an injected `TargetSource`/`TargetProbe`. The scanners
// (`RepositoryFileSystemScanner`, `RuntimeScanner`, ...) each implement that substrate for one
// KIND of source. What has been missing is the layer ABOVE the sweep: WHEN discovery runs and over
// WHAT. This module is that layer. It answers three questions the phase objective names:
//
//   1. SCHEDULING — machine-wide discovery must run PERIODICALLY (a recurring cadence with no
//      operator in the loop) AND ON DEMAND (an operator/automation can request a sweep NOW), with
//      exactly-one-sweep-in-flight so a periodic tick and an on-demand request never double-scan.
//      The cadence is injected (clock + sleeper), so the whole schedule is deterministic in tests.
//
//   2. COMPOSITION (cross-source) — one machine has many source KINDS (filesystem, runtime, a
//      Kanban connector, agentctl, workflow orchestration, ...). `CompositeScanSource` fans a sweep
//      across every injected `TargetSource`+`TargetProbe`, WITHOUT pre-naming the sources: each
//      source enumerates its own targets, and the composite namespaces every target by its origin
//      source so the reconciled catalog can be DRILLED DOWN per source and CONFLICTS across sources
//      (two sources reporting the same underlying entity) remain distinct, correlated rows.
//
//   3. FAIL-VISIBLE SCHEDULE STATUS — a single snapshot that makes the schedule itself observable:
//      the cadence, the last/next tick, how each run was triggered (periodic vs on-demand), the
//      per-run outcome, and — crucially — which sources are STALE or UNAVAILABLE (their last sweep
//      failed or has not happened) so health is never INFERRED from stale data. The unified
//      current-state view (every catalog item once, with full attributes), the visible coverage
//      gaps, and the buffered discovery evidence all hang off the same snapshot.
//
// ---------------------------------------------------------------------------
// DESIGN CONSTRAINTS (inherited from main.ts, re-stated because they bind here too)
// ---------------------------------------------------------------------------
// * Least privilege / metadata only: the runner adds NO new authority and reads NO content. It only
//   ORCHESTRATES the governed sweep, which already enforces scan authorization (fail-closed) and the
//   metadata-only disclosure guard. A composed source that is out of the agent's grant set is still
//   recorded as a coverage gap, never probed.
// * Fail-closed / fail-visible: a source whose enumeration throws does NOT abort the whole schedule
//   and is NOT silently dropped — it is recorded as an unavailable source with its last-known good
//   time and a confidence marker, and the run continues over the remaining sources.
// * Deterministic + injectable: clock, sleeper, and the set of sources are all injected; there is no
//   wall clock and no real timer, so a full periodic schedule can be driven tick-by-tick in a test.
// * Exactly-one-in-flight: an on-demand request that arrives while a sweep is running joins the
//   in-flight sweep rather than starting a second concurrent one (no double governance action).

import {
  GovernedDiscoveryAgent,
  describeError,
  type SweepReport,
  type ScanTarget,
  type ScanScope,
  type ProbeResult,
  type TargetSource,
  type TargetProbe,
  type CatalogEntry,
  type SourceCatalog,
  type Clock,
  type Sleeper,
  type EpochMillis,
  type GapReason,
  realSleeper,
} from './main.ts';

// ===========================================================================
// 1. Trigger vocabulary — how a run was started (fail-visible in the status)
// ===========================================================================

/** Every way a discovery run can be started. Recorded per run so the schedule is auditable. */
export const RUN_TRIGGERS = ['periodic', 'on_demand', 'initial'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** The lifecycle of the scheduler loop itself (distinct from the agent's own state vocabulary). */
export const SCHEDULE_STATES = [
  'idle', // constructed, not yet started
  'running', // the periodic loop is active
  'sweeping', // a sweep is currently in flight
  'stopped', // the loop exited cleanly on request
] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

// ===========================================================================
// 2. Composite scan source — fan a sweep across many source KINDS
// ===========================================================================

/** One named source KIND contributing targets to a machine-wide sweep. */
export interface NamedScanSource {
  /**
   * A stable, disclosure-safe identifier for the source KIND (e.g. 'filesystem', 'runtime',
   * 'kanban', 'agentctl', 'workflows_orchestration'). Used to namespace targets and to drill down.
   */
  readonly sourceId: string;
  /** The target enumerator for this source (usually a scanner). */
  readonly source: TargetSource;
  /** The probe for this source (usually the same scanner object). */
  readonly probe: TargetProbe;
}

/** The separator between a source id and the origin target id in a composed target id. */
export const COMPOSITE_ID_SEPARATOR = '::';

/** Split a composed targetId back into `{ sourceId, originTargetId }`, or null if not composed. */
export function splitCompositeTargetId(
  composedId: string,
): { readonly sourceId: string; readonly originTargetId: string } | null {
  const idx = composedId.indexOf(COMPOSITE_ID_SEPARATOR);
  if (idx < 0) return null;
  return {
    sourceId: composedId.slice(0, idx),
    originTargetId: composedId.slice(idx + COMPOSITE_ID_SEPARATOR.length),
  };
}

/** Build a composed targetId from a source id and the origin id. */
export function composeTargetId(sourceId: string, originTargetId: string): string {
  return `${sourceId}${COMPOSITE_ID_SEPARATOR}${originTargetId}`;
}

/**
 * A per-source outcome captured every time the composite enumerates targets. Because a single
 * source's enumeration can FAIL without failing the others, this is where "which sources are
 * unavailable" becomes observable — with the last-known-good time and a confidence marker, so
 * health is never inferred from stale data.
 */
export interface SourceObservation {
  readonly sourceId: string;
  /** True iff the source enumerated its targets without throwing on THIS pass. */
  readonly available: boolean;
  /** How many targets the source contributed on this pass (0 when unavailable). */
  readonly targetCount: number;
  /** The last time this source was successfully enumerated, or null if never. */
  readonly lastSuccessAt: EpochMillis | null;
  /** Wall-clock of this observation. */
  readonly observedAt: EpochMillis;
  /**
   * Confidence in this source's contribution. `fresh` = enumerated OK this pass; `stale` = this pass
   * failed but a prior pass succeeded (we keep the last-known list but flag it); `unknown` = never
   * succeeded. Coverage is never claimed with more confidence than the data supports.
   */
  readonly confidence: 'fresh' | 'stale' | 'unknown';
  /** Disclosure-safe failure detail when unavailable, else null. */
  readonly detail: string | null;
}

/**
 * Fans a sweep across many source KINDS. Implements `TargetSource`+`TargetProbe` so it plugs
 * directly into `GovernedDiscoveryAgent` — the agent sees ONE substrate; the composite hides the
 * fan-out. Target ids are namespaced by source id so the reconciled catalog stays drillable and a
 * probe is routed back to the ORIGIN source's probe. A source whose `listTargets` throws is recorded
 * as unavailable (fail-visible) and simply contributes no targets this pass — it never aborts the
 * sweep or vanishes silently.
 */
export class CompositeScanSource implements TargetSource, TargetProbe {
  readonly #sources: readonly NamedScanSource[];
  readonly #byId = new Map<string, NamedScanSource>();
  readonly #clock: Clock;
  readonly #lastSuccessAt = new Map<string, EpochMillis>();
  #lastObservations: readonly SourceObservation[] = [];

  constructor(sources: readonly NamedScanSource[], clock: Clock) {
    if (sources.length === 0) {
      throw new RangeError('CompositeScanSource requires at least one source');
    }
    const seen = new Set<string>();
    for (const s of sources) {
      if (s.sourceId.length === 0) throw new RangeError('sourceId must be non-empty');
      if (s.sourceId.includes(COMPOSITE_ID_SEPARATOR)) {
        throw new RangeError(`sourceId must not contain "${COMPOSITE_ID_SEPARATOR}"`);
      }
      if (seen.has(s.sourceId)) throw new RangeError(`duplicate sourceId "${s.sourceId}"`);
      seen.add(s.sourceId);
      this.#byId.set(s.sourceId, s);
    }
    this.#sources = [...sources];
    this.#clock = clock;
  }

  /** The source ids composed here (drill-down axis for the catalog). */
  sourceIds(): readonly string[] {
    return this.#sources.map((s) => s.sourceId);
  }

  /** The per-source observations from the most recent `listTargets` pass (defensive copies). */
  observations(): readonly SourceObservation[] {
    return this.#lastObservations.map((o) => ({ ...o }));
  }

  // ---- TargetSource -------------------------------------------------------

  /**
   * Enumerate every source's targets, namespacing each target's id by its origin source. A source
   * that throws is recorded as unavailable and skipped (its already-catalogued entries are NOT
   * removed — they simply age, flagged stale, so nothing silently disappears).
   */
  async listTargets(): Promise<readonly ScanTarget[]> {
    const out: ScanTarget[] = [];
    const observations: SourceObservation[] = [];
    const now = this.#clock();
    for (const s of this.#sources) {
      const priorSuccess = this.#lastSuccessAt.get(s.sourceId) ?? null;
      try {
        const targets = await s.source.listTargets();
        this.#lastSuccessAt.set(s.sourceId, now);
        for (const t of targets) {
          out.push({
            targetId: composeTargetId(s.sourceId, t.targetId),
            scope: t.scope,
            location: t.location,
            registered: t.registered,
          });
        }
        observations.push({
          sourceId: s.sourceId,
          available: true,
          targetCount: targets.length,
          lastSuccessAt: now,
          observedAt: now,
          confidence: 'fresh',
          detail: null,
        });
      } catch (err) {
        // Fail-visible: the source is unavailable this pass. We keep its last-known good time and
        // mark confidence stale/unknown so downstream health is never inferred from stale data.
        observations.push({
          sourceId: s.sourceId,
          available: false,
          targetCount: 0,
          lastSuccessAt: priorSuccess,
          observedAt: now,
          confidence: priorSuccess == null ? 'unknown' : 'stale',
          detail: describeError(err),
        });
      }
    }
    this.#lastObservations = observations;
    return out;
  }

  // ---- TargetProbe --------------------------------------------------------

  /** Route a probe to the ORIGIN source's probe, using the un-namespaced origin target id. */
  async probe(target: ScanTarget): Promise<ProbeResult> {
    const split = splitCompositeTargetId(target.targetId);
    if (split == null) {
      throw new Error(`probe target is not a composite id: ${target.targetId}`);
    }
    const named = this.#byId.get(split.sourceId);
    if (named == null) {
      throw new Error(`probe target references unknown source: ${split.sourceId}`);
    }
    // Hand the origin probe an origin-shaped target (its own id, not the namespaced one).
    return named.probe.probe({
      targetId: split.originTargetId,
      scope: target.scope,
      location: target.location,
      registered: target.registered,
    });
  }
}

// ===========================================================================
// 3. Per-run record + fail-visible schedule status
// ===========================================================================

/** The outcome of one scheduled discovery run (a single governed sweep). */
export interface DiscoveryRunRecord {
  readonly runNumber: number;
  readonly trigger: RunTrigger;
  readonly startedAt: EpochMillis;
  readonly finishedAt: EpochMillis;
  /** The sweep report if the sweep completed, or null if the sweep itself threw (fail-visible). */
  readonly sweep: SweepReport | null;
  /** Disclosure-safe error if the sweep threw, else null. */
  readonly error: string | null;
  /** Per-source availability observed at the start of this run. */
  readonly sources: readonly SourceObservation[];
}

/**
 * A single drillable row of the unified current-state view: one catalog entry decorated with the
 * origin source it was discovered through. Every discovered item appears EXACTLY ONCE (the catalog
 * reconciles by targetId), carrying its full attributes plus the source axis for cross-source
 * drill-down. A coverage gap is a row here too — gaps never vanish from the current-state view.
 */
export interface UnifiedSourceRow {
  readonly targetId: string;
  /** The source KIND this row was discovered through (drill-down key), or null if not composed. */
  readonly sourceId: string | null;
  /** The un-namespaced id within its origin source, or the raw targetId if not composed. */
  readonly originTargetId: string;
  readonly scope: ScanScope;
  readonly location: string;
  readonly onboarding: CatalogEntry['onboarding'];
  readonly gapReason: GapReason | null;
  readonly detail: string | null;
  readonly observedAt: EpochMillis;
}

/**
 * The complete, current, fail-visible view of the DISCOVERY SCHEDULE. It layers scheduling
 * observability on top of the agent's own `DiscoveryStatus`: the cadence, the trigger history, the
 * per-source availability (with staleness + confidence), the unified current-state view (each item
 * once, with full attributes and its source), and the visible coverage gaps.
 */
export interface DiscoveryScheduleStatus {
  readonly scheduleState: ScheduleState;
  /** The configured periodic cadence in ms (null when periodic scheduling is disabled). */
  readonly intervalMs: number | null;
  readonly totalRuns: number;
  readonly lastRun: DiscoveryRunRecord | null;
  /** When the next periodic tick is due (null when not running periodically). */
  readonly nextTickAt: EpochMillis | null;
  /** True iff a sweep is in flight right now. */
  readonly sweepInFlight: boolean;
  /** Per-source availability from the most recent enumeration (staleness is visible here). */
  readonly sources: readonly SourceObservation[];
  /** The unified current-state view: every catalog item once, decorated with its origin source. */
  readonly unified: readonly UnifiedSourceRow[];
  /** The coverage gaps only — a subset of `unified`, surfaced explicitly so they never hide. */
  readonly gaps: readonly UnifiedSourceRow[];
  readonly catalogCounts: {
    readonly total: number;
    readonly sources: number;
    readonly gaps: number;
  };
  readonly observedAt: EpochMillis;
}

/** Decorate one reconciled catalog entry into a drillable unified row. */
export function toUnifiedRow(entry: CatalogEntry): UnifiedSourceRow {
  const split = splitCompositeTargetId(entry.targetId);
  return {
    targetId: entry.targetId,
    sourceId: split?.sourceId ?? null,
    originTargetId: split?.originTargetId ?? entry.targetId,
    scope: entry.scope,
    location: entry.location,
    onboarding: entry.onboarding,
    gapReason: entry.gapReason,
    detail: entry.detail,
    observedAt: entry.observedAt,
  };
}

// ===========================================================================
// 4. The discovery runner — periodic + on-demand scheduling
// ===========================================================================

export interface DiscoveryRunnerOptions {
  /** The governed agent that performs each sweep. Must be started before the runner sweeps. */
  readonly agent: GovernedDiscoveryAgent;
  /** The reconciled catalog the agent writes into (the unified current-state view reads from it). */
  readonly catalog: SourceCatalog;
  /** The composite source, if the agent is driven by one — exposes per-source availability. */
  readonly compositeSource?: CompositeScanSource | undefined;
  readonly clock: Clock;
  readonly sleep?: Sleeper | undefined;
  /**
   * The periodic cadence in ms. A positive value enables periodic scheduling; `null`/`0` disables it
   * (the runner then only sweeps on demand). Default null (on-demand only).
   */
  readonly intervalMs?: number | null | undefined;
}

/**
 * Schedules governed discovery sweeps periodically and on demand over a `GovernedDiscoveryAgent`.
 *
 * Concurrency contract: AT MOST ONE sweep runs at a time. `triggerOnDemand()` while a sweep is in
 * flight JOINS the in-flight sweep (returns its record) rather than starting a second one, so a
 * periodic tick and an on-demand request never double-scan. `start()` runs the periodic loop until
 * `requestStop()`; each tick runs one sweep then sleeps (abortably) until the next tick.
 */
export class DiscoveryRunner {
  readonly #agent: GovernedDiscoveryAgent;
  readonly #catalog: SourceCatalog;
  readonly #composite: CompositeScanSource | null;
  readonly #clock: Clock;
  readonly #sleep: Sleeper;
  readonly #intervalMs: number | null;

  #state: ScheduleState = 'idle';
  #runNumber = 0;
  #runs: DiscoveryRunRecord[] = [];
  #inFlight: Promise<DiscoveryRunRecord> | null = null;
  #stopRequested = false;
  #stopController = new AbortController();
  #nextTickAt: EpochMillis | null = null;

  constructor(opts: DiscoveryRunnerOptions) {
    this.#agent = opts.agent;
    this.#catalog = opts.catalog;
    this.#composite = opts.compositeSource ?? null;
    this.#clock = opts.clock;
    this.#sleep = opts.sleep ?? realSleeper;
    const iv = opts.intervalMs ?? null;
    if (iv != null && !(Number.isFinite(iv) && iv > 0)) {
      throw new RangeError('intervalMs must be a positive finite number or null');
    }
    this.#intervalMs = iv;
  }

  get state(): ScheduleState {
    return this.#state;
  }
  get stopRequested(): boolean {
    return this.#stopRequested;
  }
  get totalRuns(): number {
    return this.#runNumber;
  }

  /** The full run history (defensive copies) — the auditable trigger trail. */
  runs(): readonly DiscoveryRunRecord[] {
    return this.#runs.map((r) => ({ ...r, sources: r.sources.map((s) => ({ ...s })) }));
  }

  /**
   * Run exactly ONE sweep now, on demand. If a sweep is already in flight this JOINS it (returns the
   * in-flight run's record) so there is never more than one concurrent governed sweep.
   */
  async triggerOnDemand(): Promise<DiscoveryRunRecord> {
    return this.#runOne('on_demand');
  }

  /**
   * Start the PERIODIC schedule: run a sweep, then sleep (abortably) for `intervalMs`, repeating
   * until `requestStop()`. Requires periodic scheduling to be enabled (a positive `intervalMs`).
   * The first run is tagged `initial`; subsequent ticks are `periodic`. An on-demand trigger may
   * still arrive concurrently and will simply join whatever sweep is in flight.
   */
  async start(): Promise<void> {
    if (this.#intervalMs == null) {
      throw new Error('start() requires a positive intervalMs (periodic scheduling disabled)');
    }
    if (this.#state === 'running' || this.#state === 'sweeping') {
      throw new Error('discovery schedule already running');
    }
    this.#state = 'running';
    let first = true;
    while (!this.#stopRequested) {
      await this.#runOne(first ? 'initial' : 'periodic');
      first = false;
      if (this.#stopRequested) break;
      this.#nextTickAt = this.#clock() + this.#intervalMs;
      await this.#sleep(this.#intervalMs, this.#stopController.signal);
    }
    this.#nextTickAt = null;
    this.#state = 'stopped';
  }

  /** Request a clean stop of the periodic loop. Idempotent; wakes the abortable sleep immediately. */
  requestStop(reason = 'discovery schedule stop requested'): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    this.#stopController.abort(reason);
  }

  // ---- the exactly-one-in-flight sweep primitive --------------------------

  #runOne(trigger: RunTrigger): Promise<DiscoveryRunRecord> {
    // Join an in-flight sweep rather than starting a second concurrent governed sweep.
    if (this.#inFlight != null) return this.#inFlight;
    const p = this.#doSweep(trigger).finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = p;
    return p;
  }

  async #doSweep(trigger: RunTrigger): Promise<DiscoveryRunRecord> {
    const prevState = this.#state;
    this.#state = 'sweeping';
    this.#runNumber += 1;
    const runNumber = this.#runNumber;
    const startedAt = this.#clock();
    let sweep: SweepReport | null = null;
    let error: string | null = null;
    try {
      sweep = await this.#agent.runOnce();
    } catch (err) {
      // A sweep throw is fail-visible: recorded on the run, never swallowed. The schedule continues.
      error = describeError(err);
    }
    const finishedAt = this.#clock();
    const sources = this.#composite?.observations() ?? [];
    const record: DiscoveryRunRecord = {
      runNumber,
      trigger,
      startedAt,
      finishedAt,
      sweep,
      error,
      sources: sources.map((s) => ({ ...s })),
    };
    this.#runs.push(record);
    // Restore the loop state (running) when the periodic loop is active; otherwise back to idle-ish.
    this.#state = prevState === 'running' && !this.#stopRequested ? 'running' : prevState;
    if (this.#state === 'sweeping') this.#state = this.#stopRequested ? 'stopped' : 'idle';
    return record;
  }

  // ---- the fail-visible schedule status -----------------------------------

  /**
   * Build the CURRENT fail-visible schedule status. Pure read of in-memory schedule state + the
   * reconciled catalog + the composite's latest per-source observations. Every discovered item
   * appears exactly once in `unified` (the catalog is reconciled by targetId); gaps are surfaced
   * both inside `unified` and as the explicit `gaps` subset so they can never hide.
   */
  status(now: EpochMillis = this.#clock()): DiscoveryScheduleStatus {
    const entries = this.#catalog.entries();
    const unified = entries.map(toUnifiedRow);
    const counts = this.#catalog.counts();
    return {
      scheduleState: this.#state,
      intervalMs: this.#intervalMs,
      totalRuns: this.#runNumber,
      lastRun: this.#runs.length > 0 ? { ...this.#runs[this.#runs.length - 1]! } : null,
      nextTickAt: this.#state === 'running' ? this.#nextTickAt : null,
      sweepInFlight: this.#inFlight != null,
      sources: this.#composite?.observations() ?? [],
      unified,
      gaps: unified.filter((r) => r.onboarding === 'gap'),
      catalogCounts: { total: counts.total, sources: counts.sources, gaps: counts.gaps },
      observedAt: now,
    };
  }
}
