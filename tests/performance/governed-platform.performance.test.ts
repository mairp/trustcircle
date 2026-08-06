import { describe, expect, it } from 'vitest';

import {
  ContinuousMonitoringService,
  createImpactPreview,
  type GovernedDependencyNode,
} from '@trustcircle/application';
import { buildSignedEvidencePackage, type EvidencePackageArtifact } from '@trustcircle/evidence';
import { GovernedPlatformProjector } from '@trustcircle/projections';

const NOW = 1_800_000_000_000;
const TENANT = 'tenant-performance';

describe('Spec 004 performance acceptance', () => {
  it('queries 10,000 projected register records within the 3-second acceptance budget', () => {
    const projector = new GovernedPlatformProjector(TENANT);
    for (let index = 0; index < 10_000; index += 1) {
      projector.apply({
        eventId: 'event-' + index.toString().padStart(5, '0'),
        eventType: 'register.record.created.v1',
        eventVersion: 1,
        tenantId: TENANT,
        aggregateType: 'register_record',
        aggregateId: 'record-' + index.toString().padStart(5, '0'),
        aggregateVersion: 1,
        occurredAt: NOW + index,
        correlationId: 'correlation-register-performance',
        payload: { status: index % 2 === 0 ? 'open' : 'triage', version: 1 },
      });
    }
    const started = performance.now();
    const page = projector.page('register_record', NOW + 10_001, 60_000);
    const elapsed = performance.now() - started;
    expect(page.items).toHaveLength(10_000);
    expect(page.metadata.visibility).toBe('current');
    expect(elapsed).toBeLessThan(3_000);
  });

  it('accepts and correlates an ordinary control observation within two minutes', () => {
    const service = new ContinuousMonitoringService(TENANT);
    const started = performance.now();
    const result = service.ingest(
      {
        id: 'observation-1',
        tenantId: TENANT,
        sourceId: 'source-1',
        sourceEventId: 'event-1',
        sourceContractVersion: 1,
        assetId: 'asset-1',
        controlId: 'control-1',
        conditionId: 'condition-1',
        observedAt: NOW,
        receivedAt: NOW + 1,
        status: 'pass',
        freshness: 'fresh',
        completeness: 'complete',
        confidence: 1,
        payloadEvidenceRef: '/evidence/observation-1',
        sourceHealth: 'healthy',
        correlationAttributes: {},
      },
      {
        id: 'policy-1',
        tenantId: TENANT,
        version: 1,
        keyAttributes: ['assetId', 'controlId'],
        requiredSourceIds: ['source-1'],
        staleAfterMs: 60_000,
        defaultOwnerPrincipalId: 'owner-1',
        maxObservationRefs: 20,
      },
      NOW + 2,
    );
    const elapsed = performance.now() - started;
    expect(result.ingestStatus).toBe('accepted');
    expect(result.case.assuranceOutcome).toBe('pass');
    expect(elapsed).toBeLessThan(120_000);
  });

  it('previews exactly 10,000 affected references within the two-minute budget', () => {
    const root: GovernedDependencyNode = {
      ref: '/controls/root',
      tenantId: TENANT,
      kind: 'control',
      version: 1,
      dependsOn: [],
    };
    const graph: GovernedDependencyNode[] = [
      root,
      ...Array.from({ length: 10_000 }, (_, index) => ({
        ref: '/assets/asset-' + index.toString().padStart(5, '0'),
        tenantId: TENANT,
        kind: 'asset' as const,
        version: 1,
        dependsOn: [root.ref],
      })),
    ];
    const started = performance.now();
    const preview = createImpactPreview({
      id: 'preview-performance',
      tenantId: TENANT,
      proposalType: 'control',
      proposalRef: root.ref,
      proposalDigest: 'a'.repeat(64),
      requestedBy: 'owner-1',
      graph,
      generatedAt: NOW,
      expiresAt: NOW + 180_000,
    });
    const elapsed = performance.now() - started;
    expect(preview.affectedAssetRefs).toHaveLength(10_000);
    expect(preview.unknownDependencies).toEqual([]);
    expect(elapsed).toBeLessThan(120_000);
  });

  it('builds a signed 100,000-reference evidence package within the 15-minute budget', () => {
    const entries: EvidencePackageArtifact[] = Array.from({ length: 100_000 }, (_, index) => ({
      id: 'evidence-' + index.toString().padStart(6, '0'),
      tenantId: TENANT,
      mediaType: 'application/json',
      content: '{}',
      contentDigest: index.toString(16).padStart(64, '0'),
      classification: 'internal',
      retentionPolicyId: 'retention-1',
      recordedAt: NOW,
      derivative: false,
      parentDigest: null,
      transformationDigest: null,
      redactionVerifiedAt: null,
      redactionVerifiedBy: null,
    }));
    const started = performance.now();
    const bundle = buildSignedEvidencePackage({
      id: 'package-performance',
      tenantId: TENANT,
      audiencePrincipalIds: ['auditor-1'],
      scope: { evidenceCount: entries.length },
      entries,
      generatedAt: NOW,
      generatedByPrincipalId: 'owner-1',
      schemaVersion: 1,
      signatureAlgorithm: 'test-sha256',
      signatureKeyId: 'performance-key',
      signDigest: (digest) => 'signature:' + digest,
    });
    const elapsed = performance.now() - started;
    expect(bundle.entries).toHaveLength(100_000);
    expect(bundle.canonicalDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(elapsed).toBeLessThan(900_000);
  });
});
