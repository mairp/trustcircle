// @trustcircle/adapter-sdk — VERSION-PINNED ADAPTER CLIENT: the out-of-process seam the platform uses
// to drive a controller adapter over HTTP, safely (Phase 6 / User Story 4 / FR-024, FR-026, FR-027,
// NS-005, SC-011).
//
// A controller adapter runs OUT OF PROCESS (its own service, credentials, and blast radius). The
// platform never reaches a managed source directly; it dispatches through this client. Because the
// adapter is a separate moving part, the client makes the dangerous parts safe:
//
//   * VERSION-PINNED (NS-005). Every request pins the exact adapter protocol version, adapter version,
//     and bound source revision the operation was authorized on. The adapter MUST echo them back; a
//     mismatch is a `version_drift` refusal — the platform never lets a drifted adapter apply an effect
//     authorized against a different world.
//   * ONE IDEMPOTENCY IDENTITY (FR-026). A single logical dispatch carries ONE idempotency key across
//     every retry. The adapter deduplicates on it, so a retried dispatch resolves to EXACTLY ONE effect
//     (SC-011), never a duplicate.
//   * CONFIRMATION ≠ ACKNOWLEDGEMENT (FR-027). A 2xx transport response is only an acknowledgement. The
//     client reports `confirmed` ONLY when the adapter body carries a DIRECT remote effect observation
//     (`remoteEffectObserved: true`); everything else is `dispatched_unconfirmed` / `uncertain` —
//     resolvable only by a subsequent `observe` (reconciliation), never inferred from the HTTP status.
//   * TIMEOUT ⇒ UNCERTAIN, NEVER FAILED (FR-027). A timed-out or network-severed dispatch is
//     `uncertain` (the effect may or may not have landed): the caller must reconcile, and MAY safely
//     retry under the SAME idempotency key. It is never reported as a definite success or a definite
//     failure.
//   * LEAST TRUST. The client interprets only the fields it needs and never executes adapter-returned
//     content; the body is data, not instructions.
//
// The HTTP transport is INJECTED (a minimal fetch-like port), so every branch — echoed-version drift,
// acknowledgement-without-observation, timeout, non-2xx — is provable with a scriptable fake and no
// live adapter, under Node 22 `--experimental-strip-types`.

import type { AttemptOutcome, OperationKind } from '@trustcircle/domain';

// ---------------------------------------------------------------------------
// Injected transport port (a minimal fetch-like seam).
// ---------------------------------------------------------------------------

export interface AdapterHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  /** Abort budget in ms; the transport MUST reject/abort past this (mapped to `uncertain`). */
  readonly timeoutMs: number;
}

export interface AdapterHttpResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The transport outcome. `ok` — a response was received (any status). `timeout` — the abort budget
 * elapsed (⇒ uncertain). `network_error` — the connection failed WITHOUT a known effect (⇒ uncertain).
 * The port never throws for these; it returns a tagged result so the client maps them deterministically.
 */
export type AdapterTransportResult =
  | { readonly kind: 'ok'; readonly response: AdapterHttpResponse }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network_error'; readonly detail: string };

export type AdapterTransport = (req: AdapterHttpRequest) => Promise<AdapterTransportResult>;

// ---------------------------------------------------------------------------
// Version pinning + tenant credentials.
// ---------------------------------------------------------------------------

/** The exact versions a request is pinned to; the adapter MUST echo all three (NS-005). */
export interface AdapterVersionPin {
  readonly adapterProtocolVersion: number;
  readonly adapterVersionId: string;
  /** The source revision the operation was authorized on (bound-versions source revision). */
  readonly sourceRevision: string;
}

/** Tenant-scoped adapter credentials (per-tenant isolation; never shared across tenants). */
export interface AdapterCredentials {
  readonly tenantId: string;
  /** Opaque bearer/secret presented to the adapter (never logged in full by callers). */
  readonly token: string;
}

export interface AdapterClientConfig {
  readonly baseUrl: string;
  readonly credentials: AdapterCredentials;
  readonly pin: AdapterVersionPin;
  /** Per-request abort budget. Default 10s. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Dispatch + observe shapes.
// ---------------------------------------------------------------------------

export interface DispatchRequest {
  readonly operationId: string;
  readonly operationKind: OperationKind;
  /** The ONE idempotency key for this logical dispatch — stable across every retry (FR-026). */
  readonly idempotencyKey: string;
  /** The change to apply (opaque to the client; the adapter interprets it). */
  readonly desiredState: Readonly<Record<string, unknown>>;
}

/** The adapter's echoed acknowledgement body (the subset the client trusts + interprets). */
interface AdapterAckBody {
  readonly adapterProtocolVersion?: number;
  readonly adapterVersionId?: string;
  readonly sourceRevision?: string;
  /** True iff the adapter DIRECTLY observed the remote effect (FR-027 — the only proof of confirmation). */
  readonly remoteEffectObserved?: boolean;
  readonly observedRevision?: string;
  readonly detail?: string;
}

export interface DispatchResult {
  /** pending | dispatched_unconfirmed | confirmed | no_effect | failed | uncertain | timed_out. */
  readonly outcome: AttemptOutcome;
  /** True iff a direct remote effect was observed (only ever true on `confirmed`). */
  readonly remoteEffectObserved: boolean;
  readonly observedRevision: string | null;
  /** True iff the caller may safely retry under the SAME idempotency key (uncertain/timeout only). */
  readonly retryableUnderSameKey: boolean;
  /** True iff the caller must RECONCILE (read authoritative state) before any new mutation (FR-028). */
  readonly mustReconcile: boolean;
  readonly detail: string;
}

export interface ObserveResult {
  readonly remoteEffectObserved: boolean;
  readonly observedRevision: string | null;
  /** Number of effects the adapter reports for this idempotency identity (SC-011: >1 is a duplicate). */
  readonly observedEffectCount: number;
  readonly reachable: boolean;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

export class AdapterClient {
  readonly #transport: AdapterTransport;
  readonly #config: AdapterClientConfig;
  readonly #timeoutMs: number;

  constructor(transport: AdapterTransport, config: AdapterClientConfig) {
    if (typeof config.baseUrl !== 'string' || config.baseUrl.trim().length === 0) {
      throw new TypeError('AdapterClient requires a baseUrl');
    }
    if (typeof config.credentials?.token !== 'string' || config.credentials.token.length === 0) {
      throw new TypeError('AdapterClient requires tenant credentials');
    }
    const t = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(t) || t <= 0)
      throw new RangeError('timeoutMs must be a positive integer');
    this.#transport = transport;
    this.#config = config;
    this.#timeoutMs = t;
  }

  #headers(idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.#config.credentials.token}`,
      'x-tc-tenant-id': this.#config.credentials.tenantId,
      'x-tc-adapter-protocol': String(this.#config.pin.adapterProtocolVersion),
      'x-tc-adapter-version': this.#config.pin.adapterVersionId,
      'x-tc-source-revision': this.#config.pin.sourceRevision,
    };
    if (idempotencyKey !== undefined) h['idempotency-key'] = idempotencyKey;
    return h;
  }

  /** True iff the adapter echoed EXACTLY the pinned protocol/version/revision (NS-005). */
  #versionsEcho(body: AdapterAckBody): boolean {
    return (
      body.adapterProtocolVersion === this.#config.pin.adapterProtocolVersion &&
      body.adapterVersionId === this.#config.pin.adapterVersionId &&
      body.sourceRevision === this.#config.pin.sourceRevision
    );
  }

  /**
   * Dispatch a logical change to the adapter. Version-pinned and idempotency-keyed. A timeout or network
   * error is `uncertain` (retryable under the same key, must reconcile). A response is trusted ONLY as an
   * acknowledgement: `confirmed` requires the adapter to echo the pinned versions AND report a DIRECT
   * remote effect observation; otherwise `dispatched_unconfirmed` (must reconcile). Version drift in the
   * echo is a hard refusal (`failed`, must reconcile) — a drifted adapter never confirms an effect.
   */
  async dispatch(req: DispatchRequest): Promise<DispatchResult> {
    if (typeof req.idempotencyKey !== 'string' || req.idempotencyKey.length < 8) {
      throw new TypeError(
        'dispatch requires an idempotencyKey of length >= 8 (FR-026 one identity)',
      );
    }

    const transportResult = await this.#transport({
      url: `${trimSlash(this.#config.baseUrl)}/operations/${encodeURIComponent(req.operationId)}/dispatch`,
      method: 'POST',
      headers: this.#headers(req.idempotencyKey),
      body: JSON.stringify({
        operationId: req.operationId,
        operationKind: req.operationKind,
        idempotencyKey: req.idempotencyKey,
        pin: this.#config.pin,
        desiredState: req.desiredState,
      }),
      timeoutMs: this.#timeoutMs,
    });

    // FR-027 — a timeout/severed connection is UNCERTAIN, never a definite success or failure.
    if (transportResult.kind === 'timeout') {
      return uncertain(
        'timed_out',
        'dispatch timed out before an acknowledgement; effect is unknown',
      );
    }
    if (transportResult.kind === 'network_error') {
      return uncertain(
        'uncertain',
        `dispatch severed without a known effect: ${transportResult.detail}`,
      );
    }

    const { response } = transportResult;
    const body = parseAckBody(response.body);

    // A non-2xx WITH a parseable body: if the adapter unambiguously reports no effect, it's a clean
    // `failed` (no reconcile needed — nothing landed); otherwise it's uncertain (may have half-applied).
    if (response.status < 200 || response.status >= 300) {
      if (body && body.remoteEffectObserved === false) {
        return {
          outcome: 'failed',
          remoteEffectObserved: false,
          observedRevision: body.observedRevision ?? null,
          retryableUnderSameKey: true,
          mustReconcile: false,
          detail: `adapter refused (status ${response.status}) with no effect: ${body.detail ?? 'no detail'}`,
        };
      }
      return uncertain(
        'uncertain',
        `adapter returned status ${response.status}; effect state unknown`,
      );
    }

    if (!body) {
      return uncertain('uncertain', 'adapter acknowledgement body was unparseable; effect unknown');
    }

    // NS-005 — a drifted echo is a hard refusal; a drifted adapter must never confirm an effect.
    if (!this.#versionsEcho(body)) {
      return {
        outcome: 'failed',
        remoteEffectObserved: false,
        observedRevision: body.observedRevision ?? null,
        retryableUnderSameKey: false,
        mustReconcile: true,
        detail:
          'adapter echoed a different protocol/version/source revision than pinned (version_drift, NS-005)',
      };
    }

    // FR-027 — CONFIRMATION requires a DIRECT observation, not the 2xx acknowledgement.
    if (body.remoteEffectObserved === true) {
      return {
        outcome: 'confirmed',
        remoteEffectObserved: true,
        observedRevision: body.observedRevision ?? null,
        retryableUnderSameKey: false,
        mustReconcile: false,
        detail: 'adapter directly observed the remote effect; confirmed',
      };
    }

    // A 2xx acknowledgement WITHOUT an observation is exactly that: acknowledged, not confirmed.
    return {
      outcome: 'dispatched_unconfirmed',
      remoteEffectObserved: false,
      observedRevision: body.observedRevision ?? null,
      retryableUnderSameKey: false,
      mustReconcile: true,
      detail:
        'dispatch acknowledged (2xx) but effect not directly observed; must reconcile (FR-027)',
    };
  }

  /**
   * OBSERVE the authoritative current remote state for a logical dispatch (the reconciliation read).
   * This is the ONLY path that establishes whether an effect is present. Reports the effect-count so a
   * duplicate governed effect (>1 for one idempotency identity) is surfaced, never hidden (SC-011). An
   * unreachable adapter yields `reachable: false` (the outcome stays uncertain upstream).
   */
  async observe(operationId: string, idempotencyKey: string): Promise<ObserveResult> {
    const transportResult = await this.#transport({
      url: `${trimSlash(this.#config.baseUrl)}/operations/${encodeURIComponent(operationId)}/state?idempotencyKey=${encodeURIComponent(idempotencyKey)}`,
      method: 'GET',
      headers: this.#headers(idempotencyKey),
      body: null,
      timeoutMs: this.#timeoutMs,
    });

    if (transportResult.kind !== 'ok') {
      return {
        remoteEffectObserved: false,
        observedRevision: null,
        observedEffectCount: 0,
        reachable: false,
        detail:
          transportResult.kind === 'timeout'
            ? 'observe timed out; remote unreadable'
            : `observe severed: ${transportResult.detail}`,
      };
    }

    const { response } = transportResult;
    if (response.status < 200 || response.status >= 300) {
      return {
        remoteEffectObserved: false,
        observedRevision: null,
        observedEffectCount: 0,
        reachable: false,
        detail: `adapter state read returned status ${response.status}; remote unreadable`,
      };
    }

    const body = parseObserveBody(response.body);
    if (!body) {
      return {
        remoteEffectObserved: false,
        observedRevision: null,
        observedEffectCount: 0,
        reachable: false,
        detail: 'adapter state body was unparseable; remote unreadable',
      };
    }

    const count =
      typeof body.observedEffectCount === 'number' &&
      Number.isInteger(body.observedEffectCount) &&
      body.observedEffectCount >= 0
        ? body.observedEffectCount
        : body.remoteEffectObserved === true
          ? 1
          : 0;

    return {
      remoteEffectObserved: body.remoteEffectObserved === true,
      observedRevision: typeof body.observedRevision === 'string' ? body.observedRevision : null,
      observedEffectCount: count,
      reachable: true,
      detail:
        count > 1
          ? `duplicate effect observed (${count}) for one idempotency identity (SC-011)`
          : 'authoritative remote state read',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function uncertain(outcome: AttemptOutcome, detail: string): DispatchResult {
  return {
    outcome,
    remoteEffectObserved: false,
    observedRevision: null,
    retryableUnderSameKey: true,
    mustReconcile: true,
    detail,
  };
}

function trimSlash(u: string): string {
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

function parseAckBody(raw: string): AdapterAckBody | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== 'object') return null;
    return v as AdapterAckBody;
  } catch {
    return null;
  }
}

interface AdapterObserveBody {
  readonly remoteEffectObserved?: boolean;
  readonly observedRevision?: string;
  readonly observedEffectCount?: number;
}

function parseObserveBody(raw: string): AdapterObserveBody | null {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== 'object') return null;
    return v as AdapterObserveBody;
  } catch {
    return null;
  }
}
