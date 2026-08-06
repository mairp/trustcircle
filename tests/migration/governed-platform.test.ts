import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { GovernedPlatformProjector } from '@trustcircle/projections';

const SQL_PATH = join(process.cwd(), 'db', 'migrations', '0100_governed_platform_continuation.sql');
const SQL = readFileSync(SQL_PATH, 'utf8');

const CANONICAL_TABLES = [
  'review_snapshot',
  'register_record',
  'governed_view',
  'governed_subscription',
  'delivery_attempt',
  'evidence_request',
  'evidence_attestation',
  'evidence_sufficiency_decision',
  'evidence_derivative',
  'evidence_package',
  'control_observation',
  'monitoring_case',
  'impact_preview',
  'change_publication',
  'ai_use_case',
  'ai_component_version',
  'ai_evaluation',
  'ai_incident',
  'copilot_exchange',
  'connector_certification',
  'improvement_hypothesis',
  'entity_resolution_case',
  'framework_mapping',
] as const;

describe('0100 governed platform continuation migration', () => {
  it('creates every canonical table additively after migration 0090', () => {
    expect(SQL_PATH).toContain('0100_');
    for (const table of CANONICAL_TABLES) {
      expect(SQL).toMatch(new RegExp('CREATE TABLE IF NOT EXISTS\\s+' + table + '\\b', 'i'));
    }
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE)\b/i);
  });

  it('forces tenant RLS and creates tenant-leading indexes on every tenant table', () => {
    for (const table of CANONICAL_TABLES) {
      expect(SQL).toMatch(
        new RegExp('ALTER TABLE\\s+' + table + '\\s+ENABLE ROW LEVEL SECURITY', 'i'),
      );
      expect(SQL).toMatch(
        new RegExp('ALTER TABLE\\s+' + table + '\\s+FORCE ROW LEVEL SECURITY', 'i'),
      );
      expect(SQL).toMatch(new RegExp('ON\\s+' + table + '\\s*\\(tenant_id', 'i'));
    }
    expect(SQL).toContain('app.tenant_id');
    expect(SQL).not.toMatch(/BYPASSRLS/i);
  });

  it('guards immutable facts, expected versions, replay, and delivery idempotency', () => {
    expect(SQL).toContain('governed_immutable_fact');
    expect(SQL).toContain('resource_version');
    expect(SQL).toContain('control_observation_source_event_unique');
    expect(SQL).toContain('delivery_attempt_idempotency_unique');
    expect(SQL).toContain('review_snapshot_digest_unique');
    expect(SQL).toContain('evidence_package_manifest_digest_unique');
  });

  it('uses composite tenant references for cross-record relationships', () => {
    expect(SQL).toMatch(/FOREIGN KEY\s*\(tenant_id,\s*review_id\)/i);
    expect(SQL).toMatch(/FOREIGN KEY\s*\(tenant_id,\s*original_evidence_id\)/i);
    expect(SQL).toMatch(/FOREIGN KEY\s*\(tenant_id,\s*use_case_id\)/i);
  });
});
describe('0100 retained compatibility and rebuild', () => {
  it('retains explicit historical signature schemas and immutable correction-safe facts', () => {
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS review_snapshot[\s\S]*schema_version INTEGER NOT NULL[\s\S]*signature JSONB NOT NULL/i,
    );
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS evidence_package[\s\S]*schema_version INTEGER NOT NULL[\s\S]*signature JSONB/i,
    );
    expect(SQL).toMatch(/review_snapshot_immutable[\s\S]*governed_immutable_fact/i);
    expect(SQL).toMatch(/evidence_attestation_immutable[\s\S]*governed_immutable_fact/i);
  });

  it('rebuilds a retained v1 event stream deterministically after the expand-only migration', () => {
    const projector = new GovernedPlatformProjector('tenant-a');
    const events = [
      {
        eventId: 'event-1',
        eventType: 'review.snapshot.signed.v1',
        eventVersion: 1,
        tenantId: 'tenant-a',
        aggregateType: 'review_snapshot',
        aggregateId: 'snapshot-1',
        aggregateVersion: 1,
        occurredAt: 1_800_000_000_000,
        correlationId: 'correlation-review-1',
        payload: { schemaVersion: 1, canonicalDigest: 'a'.repeat(64) },
      },
      {
        eventId: 'event-2',
        eventType: 'review.snapshot.corrected.v1',
        eventVersion: 1,
        tenantId: 'tenant-a',
        aggregateType: 'review_correction',
        aggregateId: 'correction-1',
        aggregateVersion: 1,
        occurredAt: 1_800_000_000_001,
        correlationId: 'correlation-review-2',
        payload: { snapshotId: 'snapshot-1', originalDigest: 'a'.repeat(64) },
      },
    ];
    projector.rebuild([...events].reverse());
    const first = projector.page('review_snapshot', 1_800_000_000_002, 10_000);
    projector.rebuild(events);
    const second = projector.page('review_snapshot', 1_800_000_000_002, 10_000);
    expect(first.items).toEqual(second.items);
    expect(second.items[0]?.eventVersion).toBe(1);
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|TYPE)\b/i);
  });
});
