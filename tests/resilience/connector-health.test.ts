// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — CONNECTOR HEALTH RESILIENCE (T222 · FR-057..FR-060 · SC-014 · SC-015 · SC-024).
//
// RESILIENCE oracle for connector health, freshness, visibility, owner notification, stale-data
// labeling, and alert recovery. It drives the REAL health observer
// (apps/command-worker/src/health-observer.ts observeHealth / isObservationStale), the REAL alert
// routing (`@trustcircle/application` raiseAlert / notifyOwner / acknowledgeAlert / recoverAlert +
// meetsVisibilityObjective / meetsOwnerNotifyObjective), and the REAL last-known-state projector
// (`@trustcircle/projections` LastKnownStateProjector) over the deterministic integrations fixture.
//
//   * FRESHNESS THRESHOLD. Telemetry newer than the horizon is fresh; strictly older is stale; the
//     boundary (age == horizon) is fresh.
//   * ABSENCE IS NEVER HEALTH (SC-024). Missing telemetry ⇒ readiness unknown / liveness stale /
//     freshness stale / inferredFromAbsence true — never a positive reading from silence.
//   * 60-SECOND VISIBILITY (SC-014). A breach visible within 60s meets the objective; 60.001s does not.
//   * 5-MINUTE OWNER NOTIFICATION (SC-015). An owner notified within 5min meets the objective; an
//     un-notified alert never meets it.
//   * STALE-DATA LABELING. The last-known-state projector labels an offline component's retained record
//     current | aging | stale | unknown — never a live reading.
//   * ALERT RECOVERY. A breach recovers from any non-recovered state; recovery is ordered + terminal.
//
// Every assertion pins a REAL service/projector verdict — never a re-implemented rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  raiseAlert,
  notifyOwner,
  acknowledgeAlert,
  recoverAlert,
  meetsVisibilityObjective,
  meetsOwnerNotifyObjective,
  VISIBILITY_OBJECTIVE_MS,
  OWNER_NOTIFY_OBJECTIVE_MS,
} from '@trustcircle/application';

import { LastKnownStateProjector } from '@trustcircle/projections';

import {
  observeHealth,
  isObservationStale,
} from '../../apps/command-worker/src/health-observer.ts';

import {
  NOW,
  ONE_MINUTE,
  ONE_HOUR,
  ONE_DAY,
  TENANT,
  PLATFORM_OWNER,
  SOURCE_STEWARD,
  KANBAN_MANIFEST,
  KANBAN_CONNECTOR,
  telemetryFor,
  uuidFromSlug,
} from '../fixtures/integrations.ts';

const HORIZON = KANBAN_MANIFEST.health.freshness_seconds * 1000;

describe('connector health · freshness threshold (fresh / boundary / stale)', () => {
  it('is fresh strictly within the horizon, fresh AT the boundary, stale strictly beyond', () => {
    const reportedAt = NOW - HORIZON; // exactly the horizon → boundary is fresh
    expect(isObservationStale(reportedAt, NOW, HORIZON)).toBe(false);
    expect(isObservationStale(NOW - (HORIZON - 1), NOW, HORIZON)).toBe(false);
    expect(isObservationStale(NOW - (HORIZON + 1), NOW, HORIZON)).toBe(true);
    // Absence is always stale.
    expect(isObservationStale(undefined, NOW, HORIZON)).toBe(true);
    expect(isObservationStale(null, NOW, HORIZON)).toBe(true);
  });

  it('present fresh telemetry passes readiness/liveness through faithfully', () => {
    const fresh = telemetryFor(KANBAN_MANIFEST, 'fresh');
    const obs = observeHealth({
      connectorId: KANBAN_CONNECTOR.slug,
      tenantId: String(TENANT),
      owner: String(SOURCE_STEWARD),
      connectorVersion: KANBAN_MANIFEST.adapter_version,
      telemetry: { reportedAt: fresh.lastSuccessfulAt!, ready: true, live: true },
      freshnessHorizonMs: HORIZON,
      businessImpact: 'engineering board projection',
      now: NOW,
    });
    expect(obs.readiness).toBe('ready');
    expect(obs.liveness).toBe('live');
    expect(obs.freshness).toBe('fresh');
    expect(obs.inferredFromAbsence).toBe(false);
    expect(obs.observationDigest).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('connector health · absence is never health (SC-024)', () => {
  it('missing telemetry collapses to unknown/stale/stale with inferredFromAbsence=true', () => {
    const obs = observeHealth({
      connectorId: KANBAN_CONNECTOR.slug,
      tenantId: String(TENANT),
      owner: String(SOURCE_STEWARD),
      connectorVersion: KANBAN_MANIFEST.adapter_version,
      freshnessHorizonMs: HORIZON,
      businessImpact: 'engineering board projection',
      now: NOW,
    });
    expect(obs.readiness).toBe('unknown');
    expect(obs.liveness).toBe('stale');
    expect(obs.freshness).toBe('stale');
    expect(obs.inferredFromAbsence).toBe(true);
    expect(obs.reportedAt).toBeNull();
  });

  it('EXPIRED telemetry (past horizon) is treated as absence — no positive reading', () => {
    const stale = telemetryFor(KANBAN_MANIFEST, 'stale');
    const obs = observeHealth({
      connectorId: KANBAN_CONNECTOR.slug,
      tenantId: String(TENANT),
      owner: String(SOURCE_STEWARD),
      connectorVersion: KANBAN_MANIFEST.adapter_version,
      // The connector CLAIMS ready+live, but the telemetry is past the horizon → not trusted.
      telemetry: { reportedAt: stale.lastSuccessfulAt!, ready: true, live: true },
      freshnessHorizonMs: HORIZON,
      businessImpact: 'engineering board projection',
      now: NOW,
    });
    expect(obs.readiness).toBe('unknown');
    expect(obs.freshness).toBe('stale');
    expect(obs.inferredFromAbsence).toBe(true);
  });
});

describe('connector health · 60-second visibility objective (SC-014)', () => {
  const alert = raiseAlert({
    id: uuidFromSlug('alert-health-1'),
    tenantId: TENANT as unknown as ReturnType<typeof uuidFromSlug>,
    connectorId: uuidFromSlug('conn-health-1'),
    alertClass: 'health',
    severity: 'high',
    ownerPrincipalId: PLATFORM_OWNER,
    at: NOW,
  });

  it('a breach visible within 60s meets the objective; strictly beyond does not', () => {
    expect(VISIBILITY_OBJECTIVE_MS).toBe(60_000);
    expect(meetsVisibilityObjective(alert, (NOW + 60_000) as typeof NOW)).toBe(true);
    expect(meetsVisibilityObjective(alert, (NOW + 60_001) as typeof NOW)).toBe(false);
    expect(meetsVisibilityObjective(alert, NOW)).toBe(true);
  });
});

describe('connector health · 5-minute owner notification objective (SC-015)', () => {
  const base = raiseAlert({
    id: uuidFromSlug('alert-fresh-1'),
    tenantId: TENANT as unknown as ReturnType<typeof uuidFromSlug>,
    connectorId: uuidFromSlug('conn-fresh-1'),
    alertClass: 'freshness',
    ownerPrincipalId: SOURCE_STEWARD,
    at: NOW,
  });

  it('an un-notified alert never meets the objective', () => {
    expect(meetsOwnerNotifyObjective(base)).toBe(false);
    expect(base.state).toBe('open');
  });

  it('notifying within 5 minutes meets the objective; beyond does not', () => {
    expect(OWNER_NOTIFY_OBJECTIVE_MS).toBe(300_000);
    const inTime = notifyOwner(base, (NOW + 4 * ONE_MINUTE) as typeof NOW);
    expect(inTime.state).toBe('notified');
    expect(meetsOwnerNotifyObjective(inTime)).toBe(true);

    const late = notifyOwner(base, (NOW + 6 * ONE_MINUTE) as typeof NOW);
    expect(meetsOwnerNotifyObjective(late)).toBe(false);
  });
});

describe('connector health · stale-data labeling of an offline component', () => {
  const connectorId = uuidFromSlug('conn-offline-1');

  function projectorAt(observedAt: number) {
    return new LastKnownStateProjector({
      observation: {
        connectorId,
        observedAt: observedAt as typeof NOW,
        lastSourceVersion: 'src-v42',
        lastMappingVersion: 'map-v3',
        confidence: 0.9,
        retentionMs: 30 * ONE_DAY,
      },
    });
  }

  it('labels a recent record current, an older one aging, an ancient one stale', () => {
    const currentP = projectorAt(NOW - ONE_HOUR).project(NOW as typeof NOW);
    expect(currentP.staleness).toBe('current');
    expect(currentP.isStale).toBe(false);
    // Preserved facts carried verbatim — never a live reading.
    expect(currentP.lastSourceVersion).toBe('src-v42');
    expect(currentP.lastMappingVersion).toBe('map-v3');

    const agingP = projectorAt(NOW - 3 * ONE_DAY).project(NOW as typeof NOW);
    expect(agingP.staleness).toBe('aging');

    const staleP = projectorAt(NOW - 10 * ONE_DAY).project(NOW as typeof NOW);
    expect(staleP.staleness).toBe('stale');
    expect(staleP.isStale).toBe(true);
  });

  it('a never-observed component is unknown/stale, never inferred current', () => {
    const p = new LastKnownStateProjector({}).project(NOW as typeof NOW);
    expect(p.staleness).toBe('unknown');
    expect(p.isStale).toBe(true);
    expect(p.lastSourceVersion).toBeNull();
  });
});

describe('connector health · alert recovery is ordered and terminal', () => {
  const alert = raiseAlert({
    id: uuidFromSlug('alert-recover-1'),
    tenantId: TENANT as unknown as ReturnType<typeof uuidFromSlug>,
    connectorId: uuidFromSlug('conn-recover-1'),
    alertClass: 'health',
    ownerPrincipalId: PLATFORM_OWNER,
    at: NOW,
  });

  it('a breach recovers after notify+ack; recovery is one-way', () => {
    const notified = notifyOwner(alert, (NOW + ONE_MINUTE) as typeof NOW);
    const acked = acknowledgeAlert(notified);
    const recovered = recoverAlert(acked, (NOW + 2 * ONE_HOUR) as typeof NOW);
    expect(recovered.state).toBe('recovered');
    expect(recovered.recoveredAt).toBe(NOW + 2 * ONE_HOUR);
    // Recovery is terminal — a second recovery is refused.
    expect(() => recoverAlert(recovered, (NOW + 3 * ONE_HOUR) as typeof NOW)).toThrow(
      /already recovered/i,
    );
  });

  it('recovery predating first observation is refused (recovery-ordered)', () => {
    expect(() => recoverAlert(alert, (NOW - ONE_MINUTE) as typeof NOW)).toThrow(
      /recovery-ordered|>=/i,
    );
  });
});
