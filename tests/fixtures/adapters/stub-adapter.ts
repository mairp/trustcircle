// Test fixture — a DETERMINISTIC, CONTRACT-COMPLIANT STUB CONTROLLER ADAPTER (Phase 6 / User Story 4 /
// T178 — FR-024, FR-026, FR-027, FR-028, NS-005, SC-011).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FIXTURE EXISTS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The adapter-sdk `AdapterClient` drives a controller adapter over an INJECTED transport seam
// (`AdapterTransport`: a fetch-like port). To prove — with no live adapter and no network — every
// dangerous branch the client must survive, we need a scriptable, in-memory adapter that behaves like a
// real, well-behaved (and deliberately mis-behaving) remote controller:
//
//   * VERSION-PINNED ECHO (NS-005). It echoes the pinned protocol/version/source-revision from the
//     request headers/body, so a `driftEcho` config makes it echo a DIFFERENT tuple — the exact input
//     that must force the client to a `version_drift` refusal.
//   * ONE IDEMPOTENCY IDENTITY (FR-026 / SC-011). It keys stored effects by `idempotency-key`. A retry
//     under the SAME key resolves to EXACTLY ONE effect — never a duplicate — unless `duplicateEffect`
//     is set (to prove the client SURFACES a duplicate, never hides it).
//   * CONFIRMATION ≠ ACKNOWLEDGEMENT (FR-027). By default a dispatch is ACKNOWLEDGED (2xx) WITHOUT a
//     `remoteEffectObserved` flag — the client must report `dispatched_unconfirmed`. Only when the
//     effect is directly observable (after `applyEffect`/`observe`) does the adapter report the effect.
//   * TIMEOUT / SEVER ⇒ UNCERTAIN (FR-027/028). `timeoutDispatch` / `severDispatch` make the transport
//     return `timeout` / `network_error` — the client must map these to uncertain, never a definite
//     outcome.
//   * PARTIAL EFFECT + HEALTH LOSS + ROLLBACK + RECONCILIATION. It models an effect that half-applies,
//     a health/readiness probe that flips to unavailable, a preserved preimage a rollback restores to,
//     and an authoritative state read (`observe`) that establishes actual state.
//
// DETERMINISM. Pure in-memory; no wall clock, no randomness, no I/O. The same config + same request
// sequence always yields byte-identical responses. It is a plain object implementing `AdapterTransport`,
// so it is passed straight into `new AdapterClient(transport, config)`.

import { createHash } from 'node:crypto';

import type {
  AdapterTransport,
  AdapterHttpRequest,
  AdapterTransportResult,
} from '@trustcircle/adapter-sdk';

// ── Config: every controllable failure mode is an explicit, defaulted flag ────────────────────────

export interface StubAdapterConfig {
  /** The protocol/version/source-revision the adapter will ECHO. Defaults to whatever the request pins. */
  readonly echoProtocolVersion?: number;
  readonly echoAdapterVersionId?: string;
  readonly echoSourceRevision?: string;
  /** Force a DIFFERENT echoed tuple than pinned (NS-005 drift). Overrides the echo* fields. */
  readonly driftEcho?: boolean;
  /** The next dispatch times out (⇒ uncertain / timed_out). Consumed once, then normal. */
  readonly timeoutDispatch?: boolean;
  /** The next dispatch severs the connection (⇒ uncertain). Consumed once, then normal. */
  readonly severDispatch?: boolean;
  /** Dispatch returns a non-2xx WITH an explicit no-effect body (⇒ clean failed). */
  readonly refuseWithNoEffect?: boolean;
  /** Dispatch returns a non-2xx WITHOUT a no-effect body (⇒ uncertain — may have half-applied). */
  readonly refuseAmbiguously?: boolean;
  /** The effect actually lands on the remote at dispatch (so a later `observe` sees it). Default false —
   *  a plain 2xx is an ACKNOWLEDGEMENT, not a confirmed effect (FR-027). */
  readonly applyEffectOnDispatch?: boolean;
  /** The dispatch body DIRECTLY reports a remote effect observation (⇒ confirmed). Default false. */
  readonly reportEffectObservedOnDispatch?: boolean;
  /** The effect only PARTIALLY applied (records partial state for rollback tests). */
  readonly partialEffect?: boolean;
  /** `observe` reports MORE THAN ONE effect for one idempotency identity (SC-011 duplicate). */
  readonly duplicateEffect?: boolean;
  /** The adapter's health/readiness probe reports unavailable (health loss). */
  readonly healthLost?: boolean;
  /** The observed revision the adapter reports (defaults to the pinned/echoed source revision). */
  readonly observedRevision?: string;
  /** `observe` is unreachable (times out) — remote unreadable, stays uncertain upstream. */
  readonly observeUnreachable?: boolean;
}

interface StoredEffect {
  readonly idempotencyKey: string;
  readonly applied: boolean;
  readonly partial: boolean;
  readonly revision: string;
}

// ── The stub adapter ──────────────────────────────────────────────────────────────────────────────

/**
 * A deterministic in-memory controller adapter. `transport` is the `AdapterTransport` to hand to an
 * `AdapterClient`; the remaining methods (`applyEffect`, `preimageDigest`, `effectCount`, `healthy`)
 * let a test/scenario inspect and drive the adapter's world without touching the client.
 */
export class StubControllerAdapter {
  #config: StubAdapterConfig;
  readonly #effects = new Map<string, StoredEffect>();
  #preimage: Record<string, unknown> = { revision: 'preimage', intact: true };
  #timeoutArmed: boolean;
  #severArmed: boolean;

  constructor(config: StubAdapterConfig = {}) {
    this.#config = config;
    this.#timeoutArmed = config.timeoutDispatch === true;
    this.#severArmed = config.severDispatch === true;
  }

  /** Reconfigure the adapter mid-scenario (e.g. restore health, apply an effect out of band). */
  reconfigure(patch: Partial<StubAdapterConfig>): void {
    this.#config = { ...this.#config, ...patch };
    if (patch.timeoutDispatch !== undefined) this.#timeoutArmed = patch.timeoutDispatch;
    if (patch.severDispatch !== undefined) this.#severArmed = patch.severDispatch;
  }

  /** Force an effect to be present for an idempotency identity (models the effect landing remotely). */
  applyEffect(idempotencyKey: string, opts: { partial?: boolean; revision?: string } = {}): void {
    this.#effects.set(idempotencyKey, {
      idempotencyKey,
      applied: true,
      partial: opts.partial ?? false,
      revision: opts.revision ?? this.#config.observedRevision ?? this.#config.echoSourceRevision ?? 'rev-applied',
    });
  }

  /** True iff the adapter currently reports healthy (health probe). */
  healthy(): boolean {
    return this.#config.healthLost !== true;
  }

  /** The number of stored effects for an idempotency identity (0 or 1 unless duplicateEffect). */
  effectCount(idempotencyKey: string): number {
    if (this.#config.duplicateEffect === true && this.#effects.has(idempotencyKey)) return 2;
    return this.#effects.has(idempotencyKey) ? 1 : 0;
  }

  /** A stable digest of the preserved preimage the rollback restores to (NS-011). */
  preimageDigest(): string {
    return createHash('sha256').update(JSON.stringify(this.#preimage)).digest('hex');
  }

  /** The transport port to pass into `new AdapterClient(transport, config)`. */
  get transport(): AdapterTransport {
    return (req: AdapterHttpRequest): Promise<AdapterTransportResult> => this.#handle(req);
  }

  // ── The request router (dispatch vs observe) ────────────────────────────────────────────────────

  async #handle(req: AdapterHttpRequest): Promise<AdapterTransportResult> {
    const idempotencyKey = req.headers['idempotency-key'] ?? '';
    const pinnedProtocol = Number(req.headers['x-tc-adapter-protocol'] ?? '1');
    const pinnedVersion = req.headers['x-tc-adapter-version'] ?? '';
    const pinnedRevision = req.headers['x-tc-source-revision'] ?? '';

    if (req.method === 'GET' && req.url.includes('/state')) {
      return this.#observe(idempotencyKey, pinnedRevision);
    }
    return this.#dispatch(req, idempotencyKey, pinnedProtocol, pinnedVersion, pinnedRevision);
  }

  #echoTuple(pinnedProtocol: number, pinnedVersion: string, pinnedRevision: string): {
    protocol: number;
    version: string;
    revision: string;
  } {
    if (this.#config.driftEcho === true) {
      // Deliberately echo a DIFFERENT tuple than pinned (NS-005 drift).
      return { protocol: pinnedProtocol + 1, version: `${pinnedVersion}-DRIFTED`, revision: `${pinnedRevision}-DRIFTED` };
    }
    return {
      protocol: this.#config.echoProtocolVersion ?? pinnedProtocol,
      version: this.#config.echoAdapterVersionId ?? pinnedVersion,
      revision: this.#config.echoSourceRevision ?? pinnedRevision,
    };
  }

  #dispatch(
    _req: AdapterHttpRequest,
    idempotencyKey: string,
    pinnedProtocol: number,
    pinnedVersion: string,
    pinnedRevision: string,
  ): AdapterTransportResult {
    // FR-027/028 — a timeout or sever leaves the effect UNKNOWN. Consumed once so a retry can succeed.
    if (this.#timeoutArmed) {
      this.#timeoutArmed = false;
      return { kind: 'timeout' };
    }
    if (this.#severArmed) {
      this.#severArmed = false;
      return { kind: 'network_error', detail: 'connection reset before acknowledgement' };
    }

    const echo = this.#echoTuple(pinnedProtocol, pinnedVersion, pinnedRevision);
    const observedRevision = this.#config.observedRevision ?? echo.revision;

    // A non-2xx WITH an explicit no-effect body ⇒ clean failed (nothing landed).
    if (this.#config.refuseWithNoEffect === true) {
      return this.#ok(422, {
        adapterProtocolVersion: echo.protocol,
        adapterVersionId: echo.version,
        sourceRevision: echo.revision,
        remoteEffectObserved: false,
        observedRevision,
        detail: 'precondition failed; no effect applied',
      });
    }
    // A non-2xx WITHOUT a no-effect body ⇒ uncertain (may have half-applied).
    if (this.#config.refuseAmbiguously === true) {
      return this.#ok(503, {
        adapterProtocolVersion: echo.protocol,
        adapterVersionId: echo.version,
        sourceRevision: echo.revision,
        detail: 'upstream unavailable; effect state unknown',
      });
    }

    // The effect optionally lands remotely NOW (so a later `observe` establishes it). By default it does
    // NOT — a plain 2xx is an ACKNOWLEDGEMENT, not a confirmed effect (FR-027).
    if (this.#config.applyEffectOnDispatch === true) {
      this.applyEffect(idempotencyKey, {
        ...(this.#config.partialEffect === true ? { partial: true } : {}),
        revision: observedRevision,
      });
    }

    const reportObserved = this.#config.reportEffectObservedOnDispatch === true;
    return this.#ok(200, {
      adapterProtocolVersion: echo.protocol,
      adapterVersionId: echo.version,
      sourceRevision: echo.revision,
      remoteEffectObserved: reportObserved,
      observedRevision,
      detail: reportObserved ? 'dispatch acknowledged and remote effect directly observed' : 'dispatch acknowledged',
    });
  }

  #observe(idempotencyKey: string, pinnedRevision: string): AdapterTransportResult {
    if (this.#config.observeUnreachable === true) {
      return { kind: 'timeout' };
    }
    if (this.#config.healthLost === true) {
      // A health-lost adapter cannot be read authoritatively.
      return this.#ok(503, { detail: 'adapter unavailable; state unreadable' });
    }
    const count = this.effectCount(idempotencyKey);
    const stored = this.#effects.get(idempotencyKey);
    const observedRevision = this.#config.observedRevision ?? stored?.revision ?? pinnedRevision;
    return this.#ok(200, {
      remoteEffectObserved: count >= 1,
      observedRevision,
      observedEffectCount: count,
    });
  }

  #ok(status: number, body: Record<string, unknown>): AdapterTransportResult {
    return { kind: 'ok', response: { status, body: JSON.stringify(body) } };
  }
}

/** Convenience — build a stub adapter and return its transport in one call. */
export function stubAdapterTransport(config: StubAdapterConfig = {}): {
  readonly adapter: StubControllerAdapter;
  readonly transport: AdapterTransport;
} {
  const adapter = new StubControllerAdapter(config);
  return { adapter, transport: adapter.transport };
}
