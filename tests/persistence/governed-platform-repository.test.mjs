import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createUowDriver } from './uow-in-memory-driver.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { Database } = await import(join(ROOT, 'packages/persistence/src/database.ts'));
const repository = await import(
  join(ROOT, 'packages/persistence/src/governed-platform-repository.ts')
);
const { governedDigest } = await import(join(ROOT, 'packages/domain/src/governed-platform.ts'));

const contract = {
  sourceId: 'trustcircle',
  version: '1.0.0',
  contractDigest: 'contract-digest',
  validated: true,
};

function database() {
  return new Database(createUowDriver(), {
    clock: (() => {
      let now = 1_800_000_000_000;
      return () => ++now;
    })(),
  });
}

function resourceCommand(overrides = {}) {
  return {
    tenantId: 'tenant-a',
    kind: 'register_record',
    entityId: 'record-1',
    expectedVersion: 0,
    state: {
      id: 'record-1',
      tenantId: 'tenant-a',
      kind: 'register_record',
      schemaVersion: 1,
      resourceVersion: 1,
      status: 'active',
      ownerPrincipalId: 'owner-a',
      createdAt: 1_800_000_000_000,
      updatedAt: 1_800_000_000_000,
      data: { title: 'Control gap' },
    },
    actorPrincipalId: 'requester-a',
    accountableOwnerId: 'owner-a',
    reason: { code: 'register.created', text: 'Create a governed control gap.' },
    policyVersion: 'policy-1',
    controlVersion: 'control-1',
    policyDecisionId: 'decision-1',
    evidenceRefs: ['evidence-1'],
    idempotencyKey: 'idempotency-register-1',
    correlationId: 'correlation-register-1',
    contract,
    expectedContractVersion: '1.0.0',
    eventTopic: 'register.record.created.v1',
    eventPayload: { status: 'active' },
    ...overrides,
  };
}

test('governed repository atomically commits canonical state, audit, and outbox once', async () => {
  const db = database();
  const first = await repository.commitGovernedResource(db, resourceCommand());
  const replay = await repository.commitGovernedResource(db, resourceCommand());
  assert.equal(first.status, 'succeeded');
  assert.equal(replay.deduplicated, true);
  const row = await repository.readGovernedResource(db, 'tenant-a', 'register_record', 'record-1');
  assert.equal(row?.version, 1);
  assert.equal(row?.correlationId, 'correlation-register-1');
  assert.deepEqual(row?.state.data, { title: 'Control gap' });
});

test('governed repository rejects cross-tenant state before any durable effect', async () => {
  const db = database();
  await assert.rejects(
    repository.commitGovernedResource(
      db,
      resourceCommand({
        state: { ...resourceCommand().state, tenantId: 'tenant-b' },
      }),
    ),
    /tenant/i,
  );
  assert.equal(
    await repository.readGovernedResource(db, 'tenant-a', 'register_record', 'record-1'),
    null,
  );
});

test('immutable fact digest excludes its digest field and rejects tampering', async () => {
  const db = database();
  const factContent = {
    id: 'snapshot-1',
    tenantId: 'tenant-a',
    schemaVersion: 1,
    recordedAt: 1_800_000_000_000,
    actorPrincipalId: 'signer-a',
    correlationId: 'correlation-snapshot-1',
  };
  const fact = { ...factContent, canonicalDigest: governedDigest(factContent) };
  const command = {
    tenantId: 'tenant-a',
    kind: 'review_snapshot',
    fact,
    accountableOwnerId: 'owner-a',
    reason: { code: 'review.signed', text: 'Sign the completed review snapshot.' },
    policyVersion: 'policy-1',
    controlVersion: 'control-1',
    policyDecisionId: 'decision-1',
    evidenceRefs: ['review-1'],
    idempotencyKey: 'idempotency-snapshot-1',
    contract,
    expectedContractVersion: '1.0.0',
    eventTopic: 'review.snapshot.signed.v1',
    eventPayload: { reviewId: 'review-1' },
  };
  const result = await repository.appendGovernedFact(db, command);
  assert.equal(result.status, 'succeeded');
  await assert.rejects(
    repository.appendGovernedFact(db, {
      ...command,
      idempotencyKey: 'idempotency-snapshot-tampered',
      fact: { ...fact, recordedAt: fact.recordedAt + 1 },
    }),
    /digest/i,
  );
});
