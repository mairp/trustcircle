// packages/observability/src/instrumentation.ts
//
// Phase 50 / T050 (GAR-007) — Instrument API, workers, database, NATS, PDP,
// object store, and adapters with REDACTED OpenTelemetry signals.
//
// Phase-primary acceptance criterion:
//   VO-6acaf6470d0810df4c93 / GAR-007 — "The open-ended source catalog, reconciled
//   inventory, coverage gaps, workflow and controller state, ownership, health,
//   failures, retries, continuity mode and lease, buffered evidence, and safe next
//   actions MUST be current and fail-visible."
// Paired security obligation (tests/security/telemetry-redaction.test.ts):
//   VO-53a014009bdfebd7af13 — telemetry redaction, sensitive-evidence exclusion,
//   queue-loss signaling, and NON-AUTHORITATIVE telemetry behavior.
//
// Design contract (plan.md §Security Boundaries — "Telemetry: Redaction and
// allowlists; no secrets or evidence bodies by default; never authoritative for
// decisions"):
//   * Dependency-free — Node built-ins only (no OpenTelemetry SDK required to build
//     or test). Emits the OTel *shape* (Resource + attribute key/value spans/metrics)
//     through an injected exporter seam so a real OTLP exporter mounts unchanged.
//   * PURE + deterministic — every span/metric carries an injected timestamp; no
//     clock, no network, no process.env reads. Redaction is a pure transform.
//   * FAIL-VISIBLE — the twelve GAR-007 facets are TOTAL: a missing facet is
//     synthesised as `unavailable` + stale, never omitted; every off/missing/stale
//     facet carries a safe next action. Aggregate health is derived, never inferred
//     from telemetry ABSENCE (a silent/empty pipeline reads as unavailable, not ok).
//   * NON-AUTHORITATIVE — every emitted signal is stamped `authoritative:false`;
//     telemetry can never be a decision of record.

/* ------------------------------------------------------------------ *
 * Instrumented components (API, workers, database, NATS, PDP, object  *
 * store, adapters) — the closed set this module instruments.          *
 * ------------------------------------------------------------------ */

export const INSTRUMENTED_COMPONENTS = [
  'api',
  'command-worker',
  'projector',
  'discovery-agent',
  'database',
  'nats',
  'pdp',
  'object-store',
  'adapter',
] as const;
export type InstrumentedComponent = (typeof INSTRUMENTED_COMPONENTS)[number];

export function isInstrumentedComponent(s: unknown): s is InstrumentedComponent {
  return typeof s === 'string' && (INSTRUMENTED_COMPONENTS as readonly string[]).includes(s);
}

/* ------------------------------------------------------------------ *
 * Safe next actions (self-contained vocabulary — leaf package).       *
 * ------------------------------------------------------------------ */

export const SAFE_NEXT_ACTIONS = [
  'none',
  'retry',
  'reconcile',
  'escalate',
  'raise_budget',
  'rebuild',
] as const;
export type SafeNextAction = (typeof SAFE_NEXT_ACTIONS)[number];

export function isSafeNextAction(s: unknown): s is SafeNextAction {
  return typeof s === 'string' && (SAFE_NEXT_ACTIONS as readonly string[]).includes(s);
}

/* ------------------------------------------------------------------ *
 * REDACTION — no secrets or evidence bodies leave the process.        *
 * ------------------------------------------------------------------ */

/**
 * Attribute keys whose *values* are always dropped from telemetry. Case- and
 * separator-insensitive substring match (secret / password / token / credential /
 * api key / authorization / cookie / private key / signing key / session, plus
 * anything that literally names evidence/PII payloads).
 */
export const REDACTED_KEY_PATTERNS: readonly string[] = [
  'secret',
  'password',
  'passwd',
  'token',
  'credential',
  'apikey',
  'api_key',
  'authorization',
  'auth_header',
  'cookie',
  'privatekey',
  'signingkey',
  'session',
  'ssn',
  'creditcard',
  'evidencebody',
  'evidencecontent',
  'evidence_payload',
  'payload',
  'rawcontent',
  'plaintext',
];

export const REDACTED_PLACEHOLDER = '[REDACTED]' as const;

/** Secret-reference schemes that are SAFE to emit (they name a secret, not its value). */
const SAFE_SECRET_REFERENCE = /^(env|file|vault|awssm|gcpsm|k8s):[A-Za-z0-9_./-]+$/;

/** Value-shaped secret detectors — a leaked *value* even under a benign key. */
const VALUE_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // JWT
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\bghp_[A-Za-z0-9]{20,}\b/, // GitHub PAT
  /\bpostgres(?:ql)?:\/\/[^\s]*:[^\s@]+@/i, // DSN with inline password
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True iff the attribute *key* denotes a value that must never be emitted. */
export function isRedactedKey(key: string): boolean {
  const n = normalizeKey(key);
  return REDACTED_KEY_PATTERNS.some((p) => n.includes(normalizeKey(p)));
}

/** True iff a *value* string looks like a leaked secret regardless of its key. */
export function looksLikeSecretValue(value: string): boolean {
  if (SAFE_SECRET_REFERENCE.test(value.trim())) return false; // a reference is safe
  return VALUE_SECRET_PATTERNS.some((re) => re.test(value));
}

/**
 * Attribute value primitive after redaction. Objects/arrays are never emitted
 * verbatim (they could carry evidence bodies) — they collapse to a shape tag.
 */
export type AttributeValue = string | number | boolean | null;
export type Attributes = Readonly<Record<string, AttributeValue>>;

/**
 * Pure redaction transform. Given a bag of candidate attributes, returns a bag safe
 * to export: secret/evidence keys → placeholder; secret-shaped values → placeholder;
 * nested objects/arrays → a `[object]`/`[array:N]` shape tag (never their contents);
 * over-long strings truncated. Input is never mutated.
 */
export function redactAttributes(input: Readonly<Record<string, unknown>>): Attributes {
  const out: Record<string, AttributeValue> = {};
  for (const key of Object.keys(input).sort()) {
    const raw = input[key];
    if (isRedactedKey(key)) {
      out[key] = REDACTED_PLACEHOLDER;
      continue;
    }
    out[key] = redactValue(raw);
  }
  return Object.freeze(out);
}

const MAX_STRING = 512;

function redactValue(raw: unknown): AttributeValue {
  if (raw === null || raw === undefined) return null;
  const t = typeof raw;
  if (t === 'boolean') return raw as boolean;
  if (t === 'number') return Number.isFinite(raw as number) ? (raw as number) : null;
  if (t === 'bigint') return `${raw as bigint}`;
  if (t === 'string') {
    const s = raw as string;
    if (looksLikeSecretValue(s)) return REDACTED_PLACEHOLDER;
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated]` : s;
  }
  if (Array.isArray(raw)) return `[array:${raw.length}]`;
  // Objects (incl. evidence envelopes) never serialised into telemetry.
  return '[object]';
}

/* ------------------------------------------------------------------ *
 * OpenTelemetry-shaped signals (Resource + Span + Metric) through an  *
 * injected exporter seam. NON-AUTHORITATIVE by construction.          *
 * ------------------------------------------------------------------ */

export interface TelemetryResource {
  readonly component: InstrumentedComponent;
  readonly serviceName: string;
  /** Additional resource attributes (redacted at construction). */
  readonly attributes: Attributes;
}

export interface SpanRecord {
  readonly kind: 'span';
  readonly component: InstrumentedComponent;
  readonly name: string;
  readonly startUnixNanos: bigint;
  readonly endUnixNanos: bigint;
  readonly status: 'ok' | 'error';
  readonly attributes: Attributes;
  /** ALWAYS false — telemetry is never a decision of record. */
  readonly authoritative: false;
}

export type MetricKind = 'counter' | 'gauge' | 'histogram';

export interface MetricRecord {
  readonly kind: 'metric';
  readonly metricKind: MetricKind;
  readonly component: InstrumentedComponent;
  readonly name: string;
  readonly value: number;
  readonly unixNanos: bigint;
  readonly attributes: Attributes;
  readonly authoritative: false;
}

export type Signal = SpanRecord | MetricRecord;

/** Injected exporter seam — a real OTLP exporter mounts here unchanged. */
export interface SignalExporter {
  export(signal: Signal): void;
}

/** Collecting exporter for tests / buffering; retains an ordered, frozen log. */
export function createCollectingExporter(): SignalExporter & {
  readonly signals: readonly Signal[];
  reset(): void;
} {
  const log: Signal[] = [];
  return {
    signals: log,
    export(signal: Signal): void {
      log.push(signal);
    },
    reset(): void {
      log.length = 0;
    },
  };
}

function toUnixNanos(epochMillis: number): bigint {
  if (!Number.isFinite(epochMillis) || epochMillis < 0) {
    throw new RangeError('instrumentation: timestamp must be a finite non-negative epoch-millis');
  }
  return BigInt(Math.trunc(epochMillis)) * 1_000_000n;
}

export function makeResource(
  component: InstrumentedComponent,
  serviceName: string,
  attributes: Readonly<Record<string, unknown>> = {},
): TelemetryResource {
  if (!isInstrumentedComponent(component)) {
    throw new RangeError(`instrumentation: unknown component ${String(component)}`);
  }
  return Object.freeze({
    component,
    serviceName,
    attributes: redactAttributes(attributes),
  });
}

/**
 * A component instrument. Every span/metric it produces is redacted and stamped
 * `authoritative:false`, then handed to the injected exporter.
 */
export interface Instrument {
  readonly resource: TelemetryResource;
  span(input: {
    name: string;
    startMillis: number;
    endMillis: number;
    status?: 'ok' | 'error';
    attributes?: Readonly<Record<string, unknown>>;
  }): SpanRecord;
  counter(input: {
    name: string;
    value: number;
    atMillis: number;
    attributes?: Readonly<Record<string, unknown>>;
  }): MetricRecord;
  gauge(input: {
    name: string;
    value: number;
    atMillis: number;
    attributes?: Readonly<Record<string, unknown>>;
  }): MetricRecord;
  histogram(input: {
    name: string;
    value: number;
    atMillis: number;
    attributes?: Readonly<Record<string, unknown>>;
  }): MetricRecord;
}

export function createInstrument(
  resource: TelemetryResource,
  exporter: SignalExporter,
): Instrument {
  const emitMetric = (
    metricKind: MetricKind,
    input: {
      name: string;
      value: number;
      atMillis: number;
      attributes?: Readonly<Record<string, unknown>>;
    },
  ): MetricRecord => {
    const record: MetricRecord = Object.freeze({
      kind: 'metric',
      metricKind,
      component: resource.component,
      name: input.name,
      value: Number.isFinite(input.value) ? input.value : 0,
      unixNanos: toUnixNanos(input.atMillis),
      attributes: redactAttributes(input.attributes ?? {}),
      authoritative: false,
    });
    exporter.export(record);
    return record;
  };

  return {
    resource,
    span(input): SpanRecord {
      const start = toUnixNanos(input.startMillis);
      const end = toUnixNanos(input.endMillis);
      if (end < start) {
        throw new RangeError('instrumentation: span end precedes start');
      }
      const record: SpanRecord = Object.freeze({
        kind: 'span',
        component: resource.component,
        name: input.name,
        startUnixNanos: start,
        endUnixNanos: end,
        status: input.status ?? 'ok',
        attributes: redactAttributes(input.attributes ?? {}),
        authoritative: false,
      });
      exporter.export(record);
      return record;
    },
    counter: (i) => emitMetric('counter', i),
    gauge: (i) => emitMetric('gauge', i),
    histogram: (i) => emitMetric('histogram', i),
  };
}

/* ------------------------------------------------------------------ *
 * Queue-loss signaling (NATS/JetStream) — VO-53a014.                  *
 * A lost/gapped/disconnected queue is emitted as an EXPLICIT signal,  *
 * never silent. Absence of consumption is NOT treated as healthy.     *
 * ------------------------------------------------------------------ */

export const QUEUE_HEALTH = ['connected', 'degraded', 'disconnected', 'lost'] as const;
export type QueueHealth = (typeof QUEUE_HEALTH)[number];

export interface QueueLossSignal {
  readonly kind: 'metric';
  readonly metricKind: 'gauge';
  readonly component: 'nats';
  readonly name: 'messaging.queue.loss';
  readonly queue: string;
  readonly health: QueueHealth;
  /** Undelivered/gapped messages detected on the stream. */
  readonly droppedMessages: number;
  readonly value: number; // 1 iff loss is present, else 0 — fail-visible gauge.
  readonly unixNanos: bigint;
  readonly safeNextAction: SafeNextAction;
  readonly authoritative: false;
}

/**
 * Emit an explicit queue-loss signal. `lost`/`disconnected`, or any positive
 * dropped count, raises the gauge to 1 and forces a non-`none` safe next action —
 * so a broken pipeline is fail-VISIBLE. `connected` with zero drops → 0/`none`.
 */
export function emitQueueLoss(
  exporter: SignalExporter,
  input: {
    queue: string;
    health: QueueHealth;
    droppedMessages: number;
    atMillis: number;
  },
): QueueLossSignal {
  const dropped = Math.max(0, Math.trunc(input.droppedMessages));
  const lossPresent = input.health === 'lost' || input.health === 'disconnected' || dropped > 0;
  const safeNextAction: SafeNextAction =
    input.health === 'lost'
      ? 'reconcile'
      : input.health === 'disconnected'
        ? 'retry'
        : dropped > 0
          ? 'reconcile'
          : input.health === 'degraded'
            ? 'retry'
            : 'none';
  const signal: QueueLossSignal = Object.freeze({
    kind: 'metric',
    metricKind: 'gauge',
    component: 'nats',
    name: 'messaging.queue.loss',
    queue: input.queue,
    health: input.health,
    droppedMessages: dropped,
    value: lossPresent ? 1 : 0,
    unixNanos: toUnixNanos(input.atMillis),
    safeNextAction,
    authoritative: false,
  });
  exporter.export(signal as unknown as Signal);
  return signal;
}

/* ------------------------------------------------------------------ *
 * FAIL-VISIBLE GOVERNANCE PICTURE (GAR-007) — the twelve facets.      *
 * TOTAL over the facet set; a missing facet is synthesised as         *
 * unavailable+stale; a facet older than the freshness objective is    *
 * stale; every off/missing/stale facet carries a safe next action.    *
 * Health is DERIVED, never inferred from telemetry absence.           *
 * ------------------------------------------------------------------ */

export const GOVERNANCE_FACETS = [
  'sourceCatalog',
  'reconciledInventory',
  'coverageGaps',
  'workflowState',
  'controllerState',
  'ownership',
  'health',
  'failures',
  'retries',
  'continuity',
  'bufferedEvidence',
  'safeNextActions',
] as const;
export type GovernanceFacet = (typeof GOVERNANCE_FACETS)[number];

/** Facets that gate readiness — a core facet unavailable/stale ⇒ picture unavailable. */
export const CORE_FACETS: readonly GovernanceFacet[] = [
  'sourceCatalog',
  'reconciledInventory',
  'workflowState',
  'controllerState',
  'ownership',
  'health',
  'continuity',
];

export type FacetState = 'healthy' | 'off' | 'stale' | 'unavailable';

export interface FacetObservation {
  /** Whether the facet reported at all. Absent input ⇒ synthesised unavailable. */
  readonly state: 'healthy' | 'off';
  /** Epoch-millis the facet was last observed (for freshness). */
  readonly observedAtMillis: number;
  /** Redaction-safe, non-secret summary attributes. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface FacetReport {
  readonly facet: GovernanceFacet;
  readonly state: FacetState;
  readonly fresh: boolean;
  readonly lastObservedAtMillis: number | null;
  readonly safeNextAction: SafeNextAction;
  readonly attributes: Attributes;
}

export type PictureHealth = 'healthy' | 'degraded' | 'unavailable';

export interface GovernancePicture {
  readonly observedAtMillis: number;
  readonly freshnessObjectiveMillis: number;
  readonly health: PictureHealth;
  readonly facets: Readonly<Record<GovernanceFacet, FacetReport>>;
  /** Every facet that needs attention, in facet order (fail-visible worklist). */
  readonly attention: readonly FacetReport[];
  readonly authoritative: false;
}

function facetSafeAction(state: FacetState): SafeNextAction {
  switch (state) {
    case 'healthy':
      return 'none';
    case 'off':
      return 'reconcile';
    case 'stale':
      return 'reconcile';
    case 'unavailable':
      return 'escalate';
  }
}

/**
 * Render the fail-visible governance picture. TOTAL over GOVERNANCE_FACETS:
 *   * a facet absent from `observations` ⇒ synthesised `unavailable` (never omitted),
 *   * a facet whose age exceeds the freshness objective ⇒ `stale`,
 *   * a facet reporting `off` ⇒ `off`,
 * and each non-healthy facet carries a concrete safe next action. Aggregate health:
 * `unavailable` if any CORE facet is unavailable/stale; else `degraded` if any facet
 * is off/stale/unavailable; else `healthy`. Health is derived from explicit facet
 * state — an empty telemetry pipeline yields an all-unavailable picture, NOT ok.
 */
export function renderGovernancePicture(input: {
  observedAtMillis: number;
  freshnessObjectiveMillis: number;
  observations: Partial<Record<GovernanceFacet, FacetObservation>>;
}): GovernancePicture {
  const objective = Math.max(0, Math.trunc(input.freshnessObjectiveMillis));
  const now = input.observedAtMillis;
  const facets = {} as Record<GovernanceFacet, FacetReport>;
  const attention: FacetReport[] = [];

  for (const facet of GOVERNANCE_FACETS) {
    const obs = input.observations[facet];
    let state: FacetState;
    let fresh: boolean;
    let last: number | null;
    let attrs: Attributes;

    if (obs === undefined) {
      // MISSING facet — synthesised, never omitted.
      state = 'unavailable';
      fresh = false;
      last = null;
      attrs = redactAttributes({ reason: 'facet-not-reported' });
    } else {
      last = obs.observedAtMillis;
      const age = now - obs.observedAtMillis;
      const isStale = !Number.isFinite(obs.observedAtMillis) || age > objective;
      fresh = !isStale;
      if (obs.state === 'off') {
        state = 'off';
      } else if (isStale) {
        // Never infer health from a stale/absent read.
        state = 'stale';
      } else {
        state = 'healthy';
      }
      attrs = redactAttributes(obs.detail ?? {});
    }

    const report: FacetReport = Object.freeze({
      facet,
      state,
      fresh,
      lastObservedAtMillis: last,
      safeNextAction: facetSafeAction(state),
      attributes: attrs,
    });
    facets[facet] = report;
    if (state !== 'healthy') attention.push(report);
  }

  const coreBroken = CORE_FACETS.some(
    (f) => facets[f].state === 'unavailable' || facets[f].state === 'stale',
  );
  const anyNotHealthy = GOVERNANCE_FACETS.some((f) => facets[f].state !== 'healthy');
  const health: PictureHealth = coreBroken ? 'unavailable' : anyNotHealthy ? 'degraded' : 'healthy';

  return Object.freeze({
    observedAtMillis: now,
    freshnessObjectiveMillis: objective,
    health,
    facets: Object.freeze(facets),
    attention: Object.freeze(attention),
    authoritative: false,
  });
}

/**
 * Emit the governance picture as a set of redacted, non-authoritative gauges — one
 * per facet (1 iff attention needed) plus an aggregate-health gauge. This is the
 * bridge that makes the fail-visible picture observable through the telemetry seam
 * without ever letting telemetry become the decision of record.
 */
export function emitGovernancePicture(
  exporter: SignalExporter,
  picture: GovernancePicture,
): readonly MetricRecord[] {
  const instrument = createInstrument(makeResource('api', 'governance-picture'), exporter);
  const emitted: MetricRecord[] = [];
  for (const facet of GOVERNANCE_FACETS) {
    const report = picture.facets[facet];
    emitted.push(
      instrument.gauge({
        name: `governance.facet.${facet}.attention`,
        value: report.state === 'healthy' ? 0 : 1,
        atMillis: picture.observedAtMillis,
        attributes: {
          facet,
          state: report.state,
          fresh: report.fresh,
          safeNextAction: report.safeNextAction,
        },
      }),
    );
  }
  emitted.push(
    instrument.gauge({
      name: 'governance.picture.health',
      // 0 healthy / 1 degraded / 2 unavailable — fail-visible ordering.
      value: picture.health === 'healthy' ? 0 : picture.health === 'degraded' ? 1 : 2,
      atMillis: picture.observedAtMillis,
      attributes: { health: picture.health, authoritative: false },
    }),
  );
  return Object.freeze(emitted);
}
