// Security-suite test — telemetry redaction, sensitive-evidence exclusion, queue-loss
// signaling, and NON-AUTHORITATIVE telemetry behaviour
// (T051 / GAR-007 / VO-53a014009bdfebd7af13, paired with VO-6acaf6470d0810df4c93).
//
// This proves the Vitest `security` project runs AND that
// packages/observability/src/instrumentation.ts enforces its oracle behaviour.
// Every clause is asserted WITH a negative control so the oracle is non-vacuous:
// each positive assertion is accompanied by a case that WOULD fail if the guard
// were removed, demonstrating the property is actually load-bearing.

import { describe, it, expect } from 'vitest';
import {
  INSTRUMENTED_COMPONENTS,
  isInstrumentedComponent,
  SAFE_NEXT_ACTIONS,
  REDACTED_PLACEHOLDER,
  isRedactedKey,
  looksLikeSecretValue,
  redactAttributes,
  makeResource,
  createInstrument,
  createCollectingExporter,
  emitQueueLoss,
  GOVERNANCE_FACETS,
  CORE_FACETS,
  renderGovernancePicture,
  emitGovernancePicture,
  type Signal,
  type GovernanceFacet,
  type FacetObservation,
} from '../../packages/observability/src/instrumentation.ts';

const T0 = 1_700_000_000_000; // fixed injected epoch-millis — deterministic.

// ---- Coverage: all seven instrumented domains present ----------------------

describe('instrumented components (API, workers, database, NATS, PDP, object store, adapters)', () => {
  it('covers every domain named by the phase', () => {
    for (const c of [
      'api',
      'command-worker',
      'projector',
      'discovery-agent',
      'database',
      'nats',
      'pdp',
      'object-store',
      'adapter',
    ]) {
      expect(isInstrumentedComponent(c)).toBe(true);
    }
  });

  it('negative control: an unknown component is rejected', () => {
    expect(isInstrumentedComponent('mainframe')).toBe(false);
    expect(() => makeResource('mainframe' as never, 'svc')).toThrow();
  });
});

// ---- Clause 1: telemetry redaction (secrets never emitted) ------------------

describe('telemetry redaction — secrets never leave the process', () => {
  it('drops values under secret-named keys', () => {
    const out = redactAttributes({
      apiKey: 'sk-live-abcdef',
      db_password: 'hunter2',
      Authorization: 'Bearer xyz',
      sessionToken: 'abc',
      component: 'api',
    });
    expect(out.apiKey).toBe(REDACTED_PLACEHOLDER);
    expect(out.db_password).toBe(REDACTED_PLACEHOLDER);
    expect(out.Authorization).toBe(REDACTED_PLACEHOLDER);
    expect(out.sessionToken).toBe(REDACTED_PLACEHOLDER);
    // Non-secret keys survive.
    expect(out.component).toBe('api');
  });

  it('drops secret-SHAPED values even under an innocent key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    const out = redactAttributes({ note: jwt, aws: 'AKIAIOSFODNN7EXAMPLE' });
    expect(out.note).toBe(REDACTED_PLACEHOLDER);
    expect(out.aws).toBe(REDACTED_PLACEHOLDER);
  });

  it('permits SAFE secret references (a name, not a value)', () => {
    const out = redactAttributes({ keyRef: 'vault:prod/db#password' });
    expect(out.keyRef).toBe('vault:prod/db#password');
  });

  it('negative control: a benign value is NOT redacted', () => {
    // Proves redaction is selective — a passing test cannot come from redacting
    // everything unconditionally.
    const out = redactAttributes({ region: 'us-east-1', attempts: 3 });
    expect(out.region).toBe('us-east-1');
    expect(out.attempts).toBe(3);
    expect(isRedactedKey('region')).toBe(false);
    expect(looksLikeSecretValue('us-east-1')).toBe(false);
  });

  it('redaction flows through emitted spans/metrics', () => {
    const exporter = createCollectingExporter();
    const inst = createInstrument(makeResource('database', 'pg'), exporter);
    inst.span({
      name: 'db.query',
      startMillis: T0,
      endMillis: T0 + 5,
      attributes: { password: 'hunter2', table: 'evidence' },
    });
    const span = exporter.signals[0];
    expect(span.attributes.password).toBe(REDACTED_PLACEHOLDER);
    expect(span.attributes.table).toBe('evidence');
  });
});

// ---- Clause 2: sensitive-evidence exclusion --------------------------------

describe('sensitive-evidence exclusion — evidence bodies never serialised', () => {
  it('collapses nested objects/arrays to a shape tag, never their contents', () => {
    const out = redactAttributes({
      evidence: { secretField: 'classified-body', bytes: 4096 },
      tags: ['a', 'b', 'c'],
    });
    expect(out.evidence).toBe('[object]');
    expect(out.tags).toBe('[array:3]');
    expect(JSON.stringify(out)).not.toContain('classified-body');
  });

  it('drops values under evidence-body keys outright', () => {
    const out = redactAttributes({
      evidenceBody: 'the full attested document text',
      rawContent: 'plaintext payload',
    });
    expect(out.evidenceBody).toBe(REDACTED_PLACEHOLDER);
    expect(out.rawContent).toBe(REDACTED_PLACEHOLDER);
  });

  it('negative control: a scalar summary attribute survives', () => {
    // If exclusion collapsed *everything*, this would fail — proving the object
    // exclusion is targeted at bodies, not all attributes.
    const out = redactAttributes({ evidenceCount: 12, evidenceKind: 'attestation' });
    expect(out.evidenceCount).toBe(12);
    expect(out.evidenceKind).toBe('attestation');
  });
});

// ---- Clause 3: queue-loss signaling (fail-visible) -------------------------

describe('queue-loss signaling — a broken pipeline is explicit, never silent', () => {
  it('raises the loss gauge and a corrective action on lost/disconnected/dropped', () => {
    const exporter = createCollectingExporter();
    const lost = emitQueueLoss(exporter, {
      queue: 'discovery.work',
      health: 'lost',
      droppedMessages: 0,
      atMillis: T0,
    });
    expect(lost.value).toBe(1);
    expect(lost.safeNextAction).toBe('reconcile');

    const dropped = emitQueueLoss(exporter, {
      queue: 'projector.work',
      health: 'connected',
      droppedMessages: 7,
      atMillis: T0,
    });
    expect(dropped.value).toBe(1);
    expect(dropped.droppedMessages).toBe(7);
    expect(dropped.safeNextAction).not.toBe('none');
  });

  it('negative control: a healthy connected queue signals 0 / none', () => {
    // Proves the gauge is not stuck-high — the loss signal genuinely tracks state,
    // so a "1" elsewhere is meaningful rather than constant.
    const exporter = createCollectingExporter();
    const ok = emitQueueLoss(exporter, {
      queue: 'command.work',
      health: 'connected',
      droppedMessages: 0,
      atMillis: T0,
    });
    expect(ok.value).toBe(0);
    expect(ok.safeNextAction).toBe('none');
  });
});

// ---- Clause 4: NON-AUTHORITATIVE telemetry ---------------------------------

describe('non-authoritative telemetry — never a decision of record', () => {
  it('stamps every span/metric authoritative:false', () => {
    const exporter = createCollectingExporter();
    const inst = createInstrument(makeResource('pdp', 'authz'), exporter);
    inst.span({ name: 'pdp.decide', startMillis: T0, endMillis: T0 + 1 });
    inst.counter({ name: 'pdp.decisions', value: 1, atMillis: T0 });
    inst.gauge({ name: 'pdp.inflight', value: 2, atMillis: T0 });
    for (const s of exporter.signals as readonly Signal[]) {
      expect(s.authoritative).toBe(false);
    }
  });

  it('queue-loss and governance emissions are also non-authoritative', () => {
    const exporter = createCollectingExporter();
    const loss = emitQueueLoss(exporter, {
      queue: 'q',
      health: 'degraded',
      droppedMessages: 0,
      atMillis: T0,
    });
    expect(loss.authoritative).toBe(false);
    const picture = renderGovernancePicture({
      observedAtMillis: T0,
      freshnessObjectiveMillis: 60_000,
      observations: {},
    });
    expect(picture.authoritative).toBe(false);
  });

  it('negative control: no signal is ever stamped authoritative:true', () => {
    const exporter = createCollectingExporter();
    const inst = createInstrument(makeResource('adapter', 'ext'), exporter);
    inst.counter({ name: 'adapter.calls', value: 1, atMillis: T0 });
    const authoritative = (exporter.signals as readonly Signal[]).filter(
      (s) => (s as { authoritative: unknown }).authoritative === true,
    );
    expect(authoritative).toHaveLength(0);
  });
});

// ---- GAR-007: fail-visible governance picture (twelve facets) --------------

describe('GAR-007 fail-visible governance picture — twelve facets, current & fail-visible', () => {
  const ALL_FACETS = GOVERNANCE_FACETS;

  function healthyObs(atMillis: number): Partial<Record<GovernanceFacet, FacetObservation>> {
    const o: Partial<Record<GovernanceFacet, FacetObservation>> = {};
    for (const f of ALL_FACETS) o[f] = { state: 'healthy', observedAtMillis: atMillis };
    return o;
  }

  it('enumerates all twelve required facets', () => {
    expect(ALL_FACETS).toHaveLength(12);
    for (const f of [
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
    ]) {
      expect(ALL_FACETS).toContain(f as GovernanceFacet);
    }
  });

  it('is TOTAL — a missing facet is synthesised unavailable, never omitted', () => {
    const picture = renderGovernancePicture({
      observedAtMillis: T0,
      freshnessObjectiveMillis: 60_000,
      observations: {}, // nothing reported at all
    });
    for (const f of ALL_FACETS) {
      expect(picture.facets[f]).toBeDefined();
      expect(picture.facets[f].state).toBe('unavailable');
      expect(picture.facets[f].safeNextAction).not.toBe('none');
    }
    expect(picture.health).toBe('unavailable');
    // Every facet appears on the fail-visible worklist.
    expect(picture.attention).toHaveLength(12);
  });

  it('marks a facet older than the freshness objective STALE (never inferred healthy)', () => {
    const obs = healthyObs(T0);
    obs.health = { state: 'healthy', observedAtMillis: T0 - 120_000 }; // 2 min old
    const picture = renderGovernancePicture({
      observedAtMillis: T0,
      freshnessObjectiveMillis: 60_000, // 1 min objective
      observations: obs,
    });
    expect(picture.facets.health.state).toBe('stale');
    expect(picture.facets.health.fresh).toBe(false);
    expect(picture.facets.health.safeNextAction).not.toBe('none');
    // A stale CORE facet degrades the whole picture to unavailable.
    expect(CORE_FACETS).toContain('health');
    expect(picture.health).toBe('unavailable');
  });

  it('surfaces an off facet with a corrective action', () => {
    const obs = healthyObs(T0);
    obs.coverageGaps = { state: 'off', observedAtMillis: T0 };
    const picture = renderGovernancePicture({
      observedAtMillis: T0,
      freshnessObjectiveMillis: 60_000,
      observations: obs,
    });
    expect(picture.facets.coverageGaps.state).toBe('off');
    expect(picture.facets.coverageGaps.safeNextAction).not.toBe('none');
    // coverageGaps is non-core → degraded, not unavailable.
    expect(picture.health).toBe('degraded');
  });

  it('negative control: an all-fresh-healthy picture is healthy with an empty worklist', () => {
    // Proves health is not hard-coded to unavailable — the fail-visible states are
    // reached by real facet conditions, not by construction.
    const picture = renderGovernancePicture({
      observedAtMillis: T0,
      freshnessObjectiveMillis: 60_000,
      observations: healthyObs(T0),
    });
    expect(picture.health).toBe('healthy');
    expect(picture.attention).toHaveLength(0);
    for (const f of ALL_FACETS) {
      expect(picture.facets[f].state).toBe('healthy');
      expect(picture.facets[f].safeNextAction).toBe('none');
    }
  });

  it('emits a redacted, non-authoritative gauge per facet plus aggregate health', () => {
    const exporter = createCollectingExporter();
    const picture = renderGovernancePicture({
      observedAtMillis: T0,
      freshnessObjectiveMillis: 60_000,
      observations: {},
    });
    const emitted = emitGovernancePicture(exporter, picture);
    expect(emitted).toHaveLength(13); // 12 facets + aggregate health
    for (const m of emitted) expect(m.authoritative).toBe(false);
    const health = emitted.find((m) => m.name === 'governance.picture.health');
    expect(health?.value).toBe(2); // unavailable
  });
});

// ---- Vocabulary sanity ------------------------------------------------------

describe('exported vocabularies are closed and stable', () => {
  it('safe next actions include the corrective verbs used by fail-visible paths', () => {
    for (const a of ['none', 'retry', 'reconcile', 'escalate']) {
      expect(SAFE_NEXT_ACTIONS).toContain(a as (typeof SAFE_NEXT_ACTIONS)[number]);
    }
  });

  it('instrumented component set is exactly the phase-named domains', () => {
    expect([...INSTRUMENTED_COMPONENTS].sort()).toEqual(
      [
        'adapter',
        'api',
        'command-worker',
        'database',
        'discovery-agent',
        'nats',
        'object-store',
        'pdp',
        'projector',
      ].sort(),
    );
  });
});
