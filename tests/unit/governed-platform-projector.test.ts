import { describe, expect, it } from 'vitest';

import { GovernedPlatformProjector } from '@trustcircle/projections';

function event(overrides: Partial<Parameters<GovernedPlatformProjector['apply']>[0]> = {}) {
  return {
    eventId: 'event-1',
    eventType: 'register.record.created.v1',
    eventVersion: 1,
    tenantId: 'tenant-a',
    aggregateType: 'register_record',
    aggregateId: 'record-1',
    aggregateVersion: 1,
    occurredAt: 1_800_000_000_000,
    correlationId: 'correlation-1',
    payload: { status: 'active' },
    ...overrides,
  };
}

describe('governed platform projector', () => {
  it('deduplicates event IDs and leaves aggregate gaps pending reconciliation', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    expect(projector.apply(event())).toBe('applied');
    expect(projector.apply(event())).toBe('duplicate');
    expect(
      projector.apply(
        event({
          eventId: 'event-3',
          aggregateVersion: 3,
          occurredAt: 1_800_000_000_002,
        }),
      ),
    ).toBe('pending_reconciliation');
    expect(
      projector.apply(
        event({
          eventId: 'event-2',
          aggregateVersion: 2,
          occurredAt: 1_800_000_000_001,
        }),
      ),
    ).toBe('applied');
  });

  it('refuses cross-tenant events and marks stale/partial state visibly', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    expect(() => projector.apply(event({ tenantId: 'tenant-b' }))).toThrow(/tenant/i);
    projector.apply(event({ payload: { status: 'active', partial: true } }));
    const page = projector.page('register_record', 1_800_000_600_001, 300_000);
    expect(page.metadata.visibility).toBe('partial');
    expect(page.metadata.partialCoverage).toBe(true);
    expect(page.metadata.coverageGaps).toEqual(['projection_partial']);
  });

  it('rebuilds deterministically and exposes an unknown empty page', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    expect(projector.page('review_snapshot', 1_800_000_000_000, 300_000).metadata.visibility).toBe(
      'unknown',
    );
    projector.rebuild([
      event(),
      event({
        eventId: 'event-2',
        aggregateVersion: 2,
        occurredAt: 1_800_000_000_001,
        payload: { status: 'closed' },
      }),
    ]);
    const first = projector.page('register_record', 1_800_000_000_002, 300_000);
    projector.rebuild([
      event(),
      event({
        eventId: 'event-2',
        aggregateVersion: 2,
        occurredAt: 1_800_000_000_001,
        payload: { status: 'closed' },
      }),
    ]);
    const second = projector.page('register_record', 1_800_000_000_002, 300_000);
    expect(first.items).toEqual(second.items);
    expect(second.items[0]?.state['status']).toBe('closed');
  });

  it('projects signed history, comparison classes, source links, freshness, and safe actions', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    projector.apply(
      event({
        eventId: 'snapshot-event-1',
        eventType: 'review.snapshot.signed.v1',
        aggregateType: 'review_snapshot',
        aggregateId: 'snapshot-1',
        payload: {
          reviewVersion: 1,
          canonicalDigest: 'a'.repeat(64),
          signatureKeyId: 'signing-key-1',
          sourceLinks: ['/reviews/review-1', '/evidence/evidence-1'],
        },
      }),
    );
    projector.apply(
      event({
        eventId: 'snapshot-event-2',
        eventType: 'review.snapshot.signed.v1',
        aggregateType: 'review_snapshot',
        aggregateId: 'snapshot-2',
        payload: {
          reviewVersion: 2,
          canonicalDigest: 'b'.repeat(64),
          signatureKeyId: 'signing-key-1',
          sourceLinks: ['/reviews/review-1', '/evidence/evidence-2'],
        },
      }),
    );
    projector.apply(
      event({
        eventId: 'comparison-event-1',
        eventType: 'review.comparison.created.v1',
        aggregateType: 'review_comparison',
        aggregateId: 'comparison-1',
        payload: {
          compatibility: 'compatible',
          improvedRefs: ['/controls/c-1'],
          regressedRefs: [],
          unknownRefs: ['/controls/c-2'],
          sourceLinks: ['/review-snapshots/snapshot-1', '/review-snapshots/snapshot-2'],
        },
      }),
    );

    const view = projector.reviewWorkspace(1_800_000_000_001, 300_000);
    expect(view.snapshots).toHaveLength(2);
    expect(view.comparisons[0]?.state['improvedRefs']).toEqual(['/controls/c-1']);
    expect(view.comparisons[0]?.state['sourceLinks']).toHaveLength(2);
    expect(view.metadata.visibility).toBe('current');
    expect(view.safeNextActions).toContain(
      'investigate unknown comparison outcomes using their governed source links',
    );
    expect(view.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('projects evidence due state, derivative lineage, package integrity, and safe actions', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    projector.apply(
      event({
        eventId: 'evidence-request-1',
        eventType: 'evidence.request.expired.v1',
        aggregateType: 'evidence_request',
        aggregateId: 'request-1',
        payload: {
          status: 'expired',
          attention: 'expired',
          dueAt: 1_799_999_000_000,
          expiresAt: 1_799_999_500_000,
          ownerPrincipalId: 'owner-1',
        },
      }),
    );
    projector.apply(
      event({
        eventId: 'evidence-derivative-1',
        eventType: 'evidence.derivative.created.v1',
        aggregateType: 'evidence_derivative',
        aggregateId: 'derivative-1',
        payload: {
          parentDigest: 'a'.repeat(64),
          contentDigest: 'b'.repeat(64),
          redactionVerified: true,
        },
      }),
    );
    projector.apply(
      event({
        eventId: 'evidence-package-1',
        eventType: 'evidence.package.failed.v1',
        aggregateType: 'evidence_package',
        aggregateId: 'package-1',
        payload: {
          status: 'failed',
          verificationStatus: 'failed',
          integrityValid: false,
          failureEvidenceRef: '/evidence/failure-1',
        },
      }),
    );

    const view = projector.evidenceWorkspace(1_800_000_000_100, 300_000);
    expect(view.requests[0]?.state['attention']).toBe('expired');
    expect(view.derivatives[0]?.state['parentDigest']).toBe('a'.repeat(64));
    expect(view.packages[0]?.state['integrityValid']).toBe(false);
    expect(view.safeNextActions).toContain(
      'escalate overdue or expired evidence requests to the accountable owner',
    );
    expect(view.safeNextActions).toContain(
      'reconcile failed package generation or integrity verification before release',
    );
    expect(view.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('projects monitoring uncertainty and change rebuild failures deterministically', () => {
    const events = [
      event({
        eventId: 'observation-event-1',
        eventType: 'control.observation.accepted.v1',
        aggregateType: 'control_observation',
        aggregateId: 'observation-1',
        payload: {
          status: 'pass',
          freshness: 'stale',
          completeness: 'partial',
          sourceHealth: 'degraded',
          evidenceRef: '/evidence/observation-1',
        },
      }),
      event({
        eventId: 'monitoring-case-event-1',
        eventType: 'monitoring.case.correlated.v1',
        aggregateType: 'monitoring_case',
        aggregateId: 'case-1',
        payload: {
          status: 'open',
          assuranceOutcome: 'unknown',
          uncertaintyReasons: ['partial', 'stale', 'source_degraded'],
          retryState: { attempts: 2, terminal: true },
          terminalFailureRef: '/evidence/monitoring-terminal-1',
        },
      }),
      event({
        eventId: 'impact-preview-event-1',
        eventType: 'change.impact-preview.generated.v1',
        aggregateType: 'impact_preview',
        aggregateId: 'preview-1',
        payload: {
          status: 'ready',
          sourceVersionSet: { '/controls/c-1': 2 },
          affectedProjectionRefs: ['/projections/p-1'],
        },
      }),
      event({
        eventId: 'publication-event-1',
        eventType: 'change.publication.approved.v1',
        aggregateType: 'change_publication',
        aggregateId: 'publication-1',
        payload: {
          status: 'published',
          rebuildStatus: 'pending',
          rollbackStatus: 'available',
        },
      }),
      event({
        eventId: 'rebuild-event-1',
        eventType: 'projection.rebuild.updated.v1',
        aggregateType: 'projection_rebuild',
        aggregateId: 'rebuild-1',
        payload: {
          status: 'failed',
          progress: 0.5,
          failureEvidenceRef: '/evidence/rebuild-failure-1',
        },
      }),
    ];
    const projector = new GovernedPlatformProjector('tenant-a');
    for (const item of events) expect(projector.apply(item)).toBe('applied');
    expect(projector.apply(events[0]!)).toBe('duplicate');

    const monitoring = projector.monitoringWorkspace(1_800_000_000_100, 300_000);
    expect(monitoring.observations).toHaveLength(1);
    expect(monitoring.cases[0]?.state['assuranceOutcome']).toBe('unknown');
    expect(monitoring.safeNextActions).toContain(
      'reconcile terminal monitoring failures with the accountable owner',
    );

    const change = projector.changeWorkspace(1_800_000_000_100, 300_000);
    expect(change.previews[0]?.state['sourceVersionSet']).toEqual({ '/controls/c-1': 2 });
    expect(change.rebuilds[0]?.state['status']).toBe('failed');
    expect(change.safeNextActions).toContain(
      'reconcile failed rebuild work or invoke the governed rollback path',
    );

    const stateBefore = JSON.stringify({ monitoring: monitoring.cases, change: change.rebuilds });
    projector.rebuild(events);
    const stateAfter = JSON.stringify({
      monitoring: projector.monitoringWorkspace(1_800_000_000_100, 300_000).cases,
      change: projector.changeWorkspace(1_800_000_000_100, 300_000).rebuilds,
    });
    expect(stateAfter).toBe(stateBefore);
  });

  it('projects AI lifecycle, exact components, evaluations, incidents, and abstention fail visibly', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    projector.apply(
      event({
        eventId: 'ai-use-case-event-1',
        eventType: 'ai.use-case.changed.v1',
        aggregateType: 'ai_use_case',
        aggregateId: 'ai-1',
        payload: {
          lifecycleState: 'suspended',
          purpose: 'governance assistance',
          ownerPrincipalId: 'owner-1',
          riskClass: 'high',
          activeComponentVersionRefs: ['component-1:v3'],
          approvalValidUntil: 1_799_999_999_999,
          driftReasons: ['approval_expired'],
        },
      }),
    );
    projector.apply(
      event({
        eventId: 'ai-evaluation-event-1',
        eventType: 'ai.evaluation.recorded.v1',
        aggregateType: 'ai_evaluation',
        aggregateId: 'evaluation-1',
        payload: {
          useCaseId: 'ai-1',
          componentVersionRefs: ['component-1:v3'],
          verdict: 'limited',
          limitations: ['scope limited'],
          canonicalDigest: 'a'.repeat(64),
        },
      }),
    );
    projector.apply(
      event({
        eventId: 'ai-incident-event-1',
        eventType: 'ai.incident.changed.v1',
        aggregateType: 'ai_incident',
        aggregateId: 'incident-1',
        payload: {
          useCaseId: 'ai-1',
          severity: 'critical',
          status: 'open',
          evidenceRefs: ['/evidence/ai-incident-1'],
        },
      }),
    );
    projector.apply(
      event({
        eventId: 'copilot-event-1',
        eventType: 'ai.copilot.exchange-recorded.v1',
        aggregateType: 'copilot_exchange',
        aggregateId: 'exchange-1',
        payload: {
          label: 'generated_assistance',
          authority: 'non_authoritative',
          citationRefs: [],
          limitationCodes: ['conflicting_sources'],
          abstentionCode: 'conflicting_sources',
        },
      }),
    );

    const view = projector.aiWorkspace(1_800_000_000_100, 300_000);
    expect(view.useCases[0]?.state['activeComponentVersionRefs']).toEqual(['component-1:v3']);
    expect(view.evaluations[0]?.state['verdict']).toBe('limited');
    expect(view.incidents[0]?.state['severity']).toBe('critical');
    expect(view.exchanges[0]?.state['abstentionCode']).toBe('conflicting_sources');
    expect(view.safeNextActions).toContain(
      'keep the AI use case suspended or constrained until approval, drift, and incidents are resolved',
    );
    expect(view.safeNextActions).toContain(
      'restore current authorized sources before relying on generated assistance',
    );
  });

  it('projects connector definitions, reports, certifications, health, revocation, and reconciliation', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    const connectorEvents = [
      event({
        eventId: 'connector-definition-event-1',
        eventType: 'connector.definition.changed.v1',
        aggregateType: 'connector_definition',
        aggregateId: 'definition-1',
        payload: {
          adapterId: 'kanban',
          exactVersion: '2.4.0',
          status: 'draft',
          manifestDigest: 'a'.repeat(64),
        },
      }),
      event({
        eventId: 'conformance-report-event-1',
        eventType: 'connector.conformance.completed.v1',
        aggregateType: 'connector_conformance_report',
        aggregateId: 'report-1',
        payload: {
          status: 'passed',
          reportDigest: 'b'.repeat(64),
          environmentDigest: 'c'.repeat(64),
          failedDimensions: [],
        },
      }),
      event({
        eventId: 'connector-certification-event-1',
        eventType: 'connector.certification.changed.v1',
        aggregateType: 'connector_certification',
        aggregateId: 'certification-1',
        payload: {
          status: 'revoked',
          exactVersion: '2.4.0',
          manifestDigest: 'a'.repeat(64),
          reportDigest: 'b'.repeat(64),
          certifierPrincipalId: 'certifier-1',
          revocationReason: { code: 'connector.revoke', text: 'unsafe version' },
        },
      }),
      event({
        eventId: 'connector-health-event-1',
        eventType: 'connector.health.changed.v1',
        aggregateType: 'connector_health',
        aggregateId: 'health-1',
        payload: {
          status: 'failed',
          retryState: 'terminal',
          terminalFailureRef: '/evidence/connector-terminal-1',
          reconciliationAvailable: true,
        },
      }),
    ];
    for (const item of connectorEvents) expect(projector.apply(item)).toBe('applied');
    const view = projector.connectorWorkspace(1_800_000_000_100, 300_000);
    expect(view.definitions).toHaveLength(1);
    expect(view.reports[0]?.state['status']).toBe('passed');
    expect(view.certifications[0]?.state['status']).toBe('revoked');
    expect(view.health[0]?.state['reconciliationAvailable']).toBe(true);
    expect(view.safeNextActions).toContain(
      'block new connector work and reconcile retained uncertain or partial outcomes',
    );
  });
});
