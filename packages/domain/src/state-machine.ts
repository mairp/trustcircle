// @trustcircle/domain — reusable guarded state-machine transitions with terminal-history
// preservation (Phase 15 / VO-34d9f9fb2a6a39e2d62c).
//
// Oracle (VO-34d9f9fb2a6a39e2d62c): Integrity rules, policies, controllers, controls, and
// mappings MUST have stable identifiers, versions, owners, lifecycle states, tests,
// monitoring, failure behavior, exceptions, and evidence expectations.
//
// The state machines that drive governed work (source-catalog, work-item, human-decision,
// controller-operation, applicability, exception lifecycles — data-model.md) are all the same
// shape: a finite set of states, a set of transitions each protected by a GUARD, optimistic
// version concurrency, TERMINAL states that may never be rewritten, and an append-only history
// that keeps every terminal and historical record queryable (data-model.md: "All terminal and
// historical records remain queryable"; "Triggered guards reject terminal-state rewrites";
// "Optimistic updates require WHERE id = ? AND version = ?; zero rows is a conflict").
//
// This module makes that shape reusable and, critically, makes the phase oracle an executable
// invariant: `defineStateMachine` REFUSES a definition that is not a fully governed entity —
// it must carry a stable UUIDv7 IDENTIFIER, a VERSION, an OWNER, a LIFECYCLE STATE, and a
// complete governance CONTRACT (TESTS, MONITORING, FAILURE BEHAVIOR, EXCEPTIONS, EVIDENCE
// EXPECTATIONS). A machine (integrity rule / policy / controller / control / mapping)
// therefore cannot exist without all nine facets.
//
// Guarantees the machine enforces at runtime:
//   1. Guarded transitions — a transition fires only if it is declared AND its guard returns
//      an allow verdict. A rejected guard produces a recorded, explained rejection and NO
//      state change (data-model.md: "records a rejected attempt without transition").
//   2. Optimistic concurrency — every apply is version-gated: applying against a stale version
//      is a CONFLICT with no effect, mirroring `WHERE id = ? AND version = ?` / zero-rows.
//   3. Terminal-history preservation — terminal states are sinks: any attempt to transition
//      out of a terminal state is rejected ("terminal-state rewrite"), and the full ordered
//      transition history (including the entry into the terminal state) is retained and
//      queryable. History is APPEND-ONLY; it is never truncated or rewritten.
//   4. Structured, attributable outcomes — every applied transition records actor, reason,
//      from/to state, resulting version, and a monotative sequence number, so the effect is an
//      independently observable durable record, not a claim.
//
// Dependency-free (Node built-in `crypto` only) so it is independently observable and testable
// under `npm ci` with no adjacent infrastructure, and runs under Node 22
// `--experimental-strip-types`. Builds only on ./primitives.ts (same package boundary).

import { createHash } from 'node:crypto';
import {
  type EpochMillis,
  type GovernanceContract,
  type GovernedEntity,
  type GovernedEntityKind,
  type LifecycleState,
  type Owner,
  type Reason,
  type TenantId,
  type Uuid,
  assertGovernedEntity,
  isConsequentialReason,
  isUuid,
} from './primitives.ts';

// ===========================================================================
// Transition guards & verdicts
// ===========================================================================

/** A guard's verdict: whether the transition is permitted, and — when refused — WHY. A refusal
 * always carries a structured reason so the rejection can be recorded and explained. */
export type GuardVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: Reason };

export const allow = (): GuardVerdict => ({ allowed: true });
export const deny = (reason: Reason): GuardVerdict => {
  if (!isConsequentialReason(reason)) {
    throw new TypeError('a guard denial must carry a structured, non-empty reason');
  }
  return { allowed: false, reason };
};

/**
 * The context a guard sees. `TCtx` is caller-supplied domain context (e.g. the actor's
 * authority, SoD facts, evidence completeness) so the SAME machine can be reused with
 * different guard policies. A guard is a PURE predicate over (from, to, context): it must not
 * mutate anything and must not read the wall clock.
 */
export interface GuardInput<TState extends string, TCtx> {
  readonly from: TState;
  readonly to: TState;
  readonly context: TCtx;
}

export type Guard<TState extends string, TCtx> = (input: GuardInput<TState, TCtx>) => GuardVerdict;

/** A declared transition: `from → to`, protected by an optional guard (default: allow). */
export interface TransitionDef<TState extends string, TCtx> {
  readonly from: TState;
  readonly to: TState;
  readonly guard?: Guard<TState, TCtx>;
}

// ===========================================================================
// State-machine definition (a governed entity)
// ===========================================================================

/**
 * A reusable, guarded state-machine DEFINITION. It is a {@link GovernedEntity}: it carries all
 * nine oracle facets. `defineStateMachine` validates that, so a machine that is missing any
 * facet cannot be constructed.
 */
export interface StateMachineDef<TState extends string, TCtx> {
  /** Stable UUIDv7 identifier + version + owner + lifecycle + governance contract. */
  readonly governance: GovernedEntity;
  readonly states: readonly TState[];
  readonly initial: TState;
  /** States from which NO transition may leave. Terminal history is preserved forever. */
  readonly terminal: readonly TState[];
  readonly transitions: readonly TransitionDef<TState, TCtx>[];
}

export interface StateMachine<TState extends string, TCtx> {
  readonly id: Uuid;
  readonly kind: GovernedEntityKind;
  readonly tenantId: TenantId;
  readonly version: number;
  readonly owner: Owner;
  readonly lifecycleState: LifecycleState;
  readonly contract: GovernanceContract;
  readonly states: readonly TState[];
  readonly initial: TState;
  readonly terminal: ReadonlySet<TState>;
  /** True iff `s` is a declared state of this machine. */
  isState(s: string): s is TState;
  /** True iff `s` is a terminal (sink) state. */
  isTerminal(s: TState): boolean;
  /** True iff `from → to` is a declared transition (guard not evaluated). */
  hasTransition(from: TState, to: TState): boolean;
  /** All declared target states reachable in one hop from `from` (guards not evaluated). */
  allowedTargets(from: TState): readonly TState[];
  /** Create a fresh instance rooted at the machine's initial state (version 1, empty history). */
  create(instanceId: Uuid, at: EpochMillis): MachineInstance<TState>;
  /** Restore an instance from durable fields (state + version + prior history). */
  restore(snapshot: MachineInstanceSnapshot<TState>): MachineInstance<TState>;
  /**
   * Attempt a guarded, version-gated transition. Returns a discriminated result:
   *   - applied  → new state/version + the appended history entry (durable effect witness).
   *   - conflict → optimistic-version mismatch; NO effect.
   *   - rejected → not a declared transition, terminal-state rewrite, or guard denial; the
   *                rejection is recorded and explained; NO effect.
   * Never throws for a business rejection; only throws on programmer error (unknown state).
   */
  apply(
    instance: MachineInstance<TState>,
    req: TransitionRequest<TState, TCtx>,
  ): TransitionResult<TState>;
}

// ===========================================================================
// Instances, history, requests, results
// ===========================================================================

/** An append-only record of one applied transition. Ordered by `seq` (strictly increasing). */
export interface HistoryEntry<TState extends string> {
  readonly seq: number;
  readonly from: TState;
  readonly to: TState;
  /** Version AFTER this transition (optimistic concurrency token). */
  readonly toVersion: number;
  readonly actorId: string;
  readonly reason: Reason;
  readonly at: EpochMillis;
}

/** Durable snapshot of an instance (what a store would persist). */
export interface MachineInstanceSnapshot<TState extends string> {
  readonly instanceId: Uuid;
  readonly state: TState;
  readonly version: number;
  readonly history: readonly HistoryEntry<TState>[];
}

/** A live instance. `history` is append-only and terminal entries are never rewritten. */
export interface MachineInstance<TState extends string> {
  readonly instanceId: Uuid;
  readonly state: TState;
  readonly version: number;
  readonly history: readonly HistoryEntry<TState>[];
  /** Durable snapshot for persistence / independent re-read. */
  snapshot(): MachineInstanceSnapshot<TState>;
}

export interface TransitionRequest<TState extends string, TCtx> {
  readonly to: TState;
  /** Version the caller believes the instance is at (optimistic-concurrency token). */
  readonly expectedVersion: number;
  readonly actorId: string;
  readonly reason: Reason;
  readonly at: EpochMillis;
  readonly context: TCtx;
}

export type TransitionOutcome = 'applied' | 'conflict' | 'rejected';
export type RejectionCode =
  'unknown-target-state' | 'no-such-transition' | 'terminal-state-rewrite' | 'guard-denied';

export type TransitionResult<TState extends string> =
  | {
      readonly outcome: 'applied';
      readonly instance: MachineInstance<TState>;
      readonly entry: HistoryEntry<TState>;
    }
  | {
      readonly outcome: 'conflict';
      readonly reason: Reason;
      readonly expectedVersion: number;
      readonly actualVersion: number;
    }
  | {
      readonly outcome: 'rejected';
      readonly code: RejectionCode;
      readonly reason: Reason;
      readonly from: TState;
      readonly to: TState;
    };

// ===========================================================================
// Internal helpers
// ===========================================================================

function makeReasonLite(code: string, text: string): Reason {
  return { code, text };
}

function transitionKey(from: string, to: string): string {
  return `${from} ${to}`;
}

class Instance<TState extends string> implements MachineInstance<TState> {
  readonly instanceId: Uuid;
  readonly state: TState;
  readonly version: number;
  readonly history: readonly HistoryEntry<TState>[];
  constructor(
    instanceId: Uuid,
    state: TState,
    version: number,
    history: readonly HistoryEntry<TState>[],
  ) {
    this.instanceId = instanceId;
    this.state = state;
    this.version = version;
    this.history = history;
  }
  snapshot(): MachineInstanceSnapshot<TState> {
    return {
      instanceId: this.instanceId,
      state: this.state,
      version: this.version,
      // Defensive copy — callers cannot mutate the retained history through the snapshot.
      history: this.history.map((h) => ({ ...h })),
    };
  }
}

// ===========================================================================
// defineStateMachine — the constructor that enforces the oracle
// ===========================================================================

/**
 * Build a reusable guarded state machine. THROWS unless the definition is a fully-governed
 * entity (stable UUIDv7 id, version, owner, lifecycle state, and a complete governance
 * contract with tests/monitoring/failure-behavior/exceptions/evidence-expectations) and the
 * topology is well-formed (initial ∈ states, terminal ⊆ states, every transition endpoint ∈
 * states, no transition may LEAVE a terminal state, no duplicate transitions).
 */
export function defineStateMachine<TState extends string, TCtx = unknown>(
  def: StateMachineDef<TState, TCtx>,
): StateMachine<TState, TCtx> {
  // 1. Oracle: the machine MUST be a fully governed entity (all nine facets).
  assertGovernedEntity(def.governance);
  const g = def.governance;

  // 2. Topology validation.
  if (!Array.isArray(def.states) || def.states.length === 0) {
    throw new TypeError('state machine must declare at least one state');
  }
  const stateSet = new Set<string>(def.states);
  if (stateSet.size !== def.states.length) {
    throw new TypeError('state machine states must be unique');
  }
  if (!stateSet.has(def.initial)) {
    throw new TypeError(`initial state ${JSON.stringify(def.initial)} is not a declared state`);
  }
  const terminal = new Set<TState>();
  for (const t of def.terminal ?? []) {
    if (!stateSet.has(t)) {
      throw new TypeError(`terminal state ${JSON.stringify(t)} is not a declared state`);
    }
    terminal.add(t);
  }

  const byKey = new Map<string, TransitionDef<TState, TCtx>>();
  const targetsByFrom = new Map<TState, TState[]>();
  for (const tr of def.transitions) {
    if (!stateSet.has(tr.from)) {
      throw new TypeError(`transition.from ${JSON.stringify(tr.from)} is not a declared state`);
    }
    if (!stateSet.has(tr.to)) {
      throw new TypeError(`transition.to ${JSON.stringify(tr.to)} is not a declared state`);
    }
    // Terminal-history preservation is a CONSTRUCTION-time invariant too: a machine may not
    // even declare a transition that leaves a terminal state.
    if (terminal.has(tr.from)) {
      throw new TypeError(
        `terminal state ${JSON.stringify(tr.from)} may not have an outgoing transition ` +
          `(terminal states are sinks; their history is preserved)`,
      );
    }
    const key = transitionKey(tr.from, tr.to);
    if (byKey.has(key)) {
      throw new TypeError(`duplicate transition ${tr.from} → ${tr.to}`);
    }
    if (tr.guard !== undefined && typeof tr.guard !== 'function') {
      throw new TypeError(`guard for ${tr.from} → ${tr.to} must be a function`);
    }
    byKey.set(key, tr);
    const arr = targetsByFrom.get(tr.from) ?? [];
    arr.push(tr.to);
    targetsByFrom.set(tr.from, arr);
  }

  const isState = (s: string): s is TState => stateSet.has(s);
  const isTerminal = (s: TState): boolean => terminal.has(s);
  const hasTransition = (from: TState, to: TState): boolean => byKey.has(transitionKey(from, to));
  const allowedTargets = (from: TState): readonly TState[] => [...(targetsByFrom.get(from) ?? [])];

  function assertKnownState(s: string): asserts s is TState {
    if (!stateSet.has(s)) throw new RangeError(`unknown state: ${JSON.stringify(s)}`);
  }

  return {
    id: g.id,
    kind: g.kind,
    tenantId: g.tenantId,
    version: g.version,
    owner: g.owner,
    lifecycleState: g.lifecycleState,
    contract: g.contract,
    states: [...def.states],
    initial: def.initial,
    terminal,
    isState,
    isTerminal,
    hasTransition,
    allowedTargets,

    create(instanceId: Uuid, _at: EpochMillis): MachineInstance<TState> {
      if (!isUuid(instanceId)) throw new TypeError('instanceId must be a UUID');
      return new Instance<TState>(instanceId, def.initial, 1, []);
    },

    restore(snapshot: MachineInstanceSnapshot<TState>): MachineInstance<TState> {
      if (!isUuid(snapshot.instanceId)) throw new TypeError('snapshot.instanceId must be a UUID');
      assertKnownState(snapshot.state);
      if (!Number.isInteger(snapshot.version) || snapshot.version < 1) {
        throw new TypeError('snapshot.version must be an integer ≥ 1');
      }
      // History must be a strictly increasing, contiguous, append-only ledger. A caller that
      // hands us a truncated or reordered history is rejected — history is never rewritten.
      let prevSeq = 0;
      for (const h of snapshot.history) {
        if (h.seq !== prevSeq + 1) {
          throw new TypeError('instance history must be contiguous and strictly increasing');
        }
        if (!stateSet.has(h.from) || !stateSet.has(h.to)) {
          throw new TypeError('instance history references an unknown state');
        }
        prevSeq = h.seq;
      }
      return new Instance<TState>(
        snapshot.instanceId,
        snapshot.state,
        snapshot.version,
        snapshot.history.map((h) => ({ ...h })),
      );
    },

    apply(
      instance: MachineInstance<TState>,
      req: TransitionRequest<TState, TCtx>,
    ): TransitionResult<TState> {
      const from = instance.state;
      assertKnownState(from);
      if (!isConsequentialReason(req.reason)) {
        // Missing reason is a recorded rejection, not a transition (data-model.md).
        return {
          outcome: 'rejected',
          code: 'guard-denied',
          reason: makeReasonLite('transition.reason_required', 'a transition requires a reason'),
          from,
          to: req.to,
        };
      }

      // (a) Optimistic concurrency — stale version is a conflict, no effect. Mirrors
      //     `WHERE id = ? AND version = ?` returning zero rows.
      if (req.expectedVersion !== instance.version) {
        return {
          outcome: 'conflict',
          reason: makeReasonLite(
            'transition.version_conflict',
            `expected version ${req.expectedVersion} but instance is at ${instance.version}`,
          ),
          expectedVersion: req.expectedVersion,
          actualVersion: instance.version,
        };
      }

      // (b) Terminal-state rewrite — a terminal state is a sink; its history is preserved and
      //     may never be transitioned out of.
      if (terminal.has(from)) {
        return {
          outcome: 'rejected',
          code: 'terminal-state-rewrite',
          reason: makeReasonLite(
            'transition.terminal_rewrite',
            `state ${from} is terminal; its history is preserved and cannot be rewritten`,
          ),
          from,
          to: req.to,
        };
      }

      // (c) Target must be a declared state and the transition must be declared.
      if (!stateSet.has(req.to)) {
        return {
          outcome: 'rejected',
          code: 'unknown-target-state',
          reason: makeReasonLite(
            'transition.unknown_target',
            `target state ${JSON.stringify(req.to)} is not declared`,
          ),
          from,
          to: req.to,
        };
      }
      const tr = byKey.get(transitionKey(from, req.to));
      if (!tr) {
        return {
          outcome: 'rejected',
          code: 'no-such-transition',
          reason: makeReasonLite(
            'transition.not_declared',
            `no declared transition ${from} → ${req.to}`,
          ),
          from,
          to: req.to,
        };
      }

      // (d) Guard — a rejected guard is a recorded, explained rejection with no state change.
      if (tr.guard) {
        const verdict = tr.guard({ from, to: req.to, context: req.context });
        if (!verdict.allowed) {
          return {
            outcome: 'rejected',
            code: 'guard-denied',
            reason: verdict.reason,
            from,
            to: req.to,
          };
        }
      }

      // (e) Apply: bump version, append an immutable history entry (durable effect witness).
      const toVersion = instance.version + 1;
      const entry: HistoryEntry<TState> = {
        seq: instance.history.length + 1,
        from,
        to: req.to,
        toVersion,
        actorId: req.actorId,
        reason: req.reason,
        at: req.at,
      };
      const next = new Instance<TState>(instance.instanceId, req.to, toVersion, [
        ...instance.history,
        entry,
      ]);
      return { outcome: 'applied', instance: next, entry };
    },
  };
}

// ===========================================================================
// Durable-effect witness
// ===========================================================================

/**
 * A stable content hash of an instance's durable state (id + state + version + full history).
 * Because history is append-only and the version is monotonic, the digest could not exist
 * before a given transition — higher layers use it as an independently-verifiable
 * durable-effect witness (the mutation RESPONSE is never proof; this digest, re-read from a
 * snapshot, is).
 */
export function instanceDigest<TState extends string>(
  instance: MachineInstance<TState> | MachineInstanceSnapshot<TState>,
): string {
  const snap: MachineInstanceSnapshot<TState> =
    'snapshot' in instance ? instance.snapshot() : instance;
  const canonical = JSON.stringify({
    instanceId: snap.instanceId,
    state: snap.state,
    version: snap.version,
    history: snap.history.map((h) => ({
      seq: h.seq,
      from: h.from,
      to: h.to,
      toVersion: h.toVersion,
      actorId: h.actorId,
      reason: h.reason,
      at: h.at,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
