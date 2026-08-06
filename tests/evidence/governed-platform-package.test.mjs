import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const assurance = await import(
  join(ROOT, 'packages/application/src/evidence-assurance-service.ts')
);
const reviews = await import(join(ROOT, 'packages/application/src/review-snapshot-service.ts'));
const packages = await import(join(ROOT, 'packages/evidence/src/evidence-package.ts'));
const worker = await import(join(ROOT, 'apps/command-worker/src/governed-platform-worker.ts'));

const TENANT = '018f0000-0000-7000-8000-000000000001';
const OTHER_TENANT = '018f0000-0000-7000-8000-000000000002';
const OWNER = '018f0000-0000-7000-8000-000000000010';
const AUDITOR = '018f0000-0000-7000-8000-000000000011';
const NOW = 1_800_000_000_000;
const SECRET = 'test-signing-secret';

function issued() {
  return assurance.issueEvidenceRequest({
    id: '018f0000-0000-7000-8000-000000000020',
    tenantId: TENANT,
    scope: { controlIds: ['control-1'] },
    requestedEvidenceTypes: ['configuration', 'test_result'],
    ownerPrincipalId: OWNER,
    requesterPrincipalId: AUDITOR,
    dueAt: NOW + 10_000,
    expiresAt: NOW + 20_000,
    reason: { code: 'audit.sample', text: 'Obtain exact evidence for the audit sample.' },
    now: NOW,
  });
}

test('evidence attestations bind exact versions and owner authority', () => {
  const request = issued();
  assert.throws(
    () =>
      assurance.submitEvidenceAttestation({
        request,
        tenantId: TENANT,
        expectedRequestVersion: 1,
        attestationId: '018f0000-0000-7000-8000-000000000030',
        actorPrincipalId: AUDITOR,
        evidenceVersions: [{ evidenceId: 'evidence-1', version: 3, digest: 'a'.repeat(64) }],
        statement: 'The submitted evidence is complete for the requested scope.',
        signature: 'owner-signature',
        signedAt: NOW + 1,
      }),
    /owner|authority/i,
  );
  const submitted = assurance.submitEvidenceAttestation({
    request,
    tenantId: TENANT,
    expectedRequestVersion: 1,
    attestationId: '018f0000-0000-7000-8000-000000000030',
    actorPrincipalId: OWNER,
    evidenceVersions: [{ evidenceId: 'evidence-1', version: 3, digest: 'a'.repeat(64) }],
    statement: 'The submitted evidence is complete for the requested scope.',
    signature: 'owner-signature',
    signedAt: NOW + 1,
  });
  assert.equal(submitted.request.status, 'submitted');
  assert.equal(submitted.attestation.requestVersion, 1);
  assert.equal(submitted.attestation.evidenceVersions[0].version, 3);
  assert.ok(Object.isFrozen(submitted.attestation));
});

test('sufficiency decisions are immutable, exact-attestation-bound, and independently authorized', () => {
  const request = issued();
  const submitted = assurance.submitEvidenceAttestation({
    request,
    tenantId: TENANT,
    expectedRequestVersion: 1,
    attestationId: '018f0000-0000-7000-8000-000000000030',
    actorPrincipalId: OWNER,
    evidenceVersions: [{ evidenceId: 'evidence-1', version: 3, digest: 'a'.repeat(64) }],
    statement: 'The submitted evidence is complete for the requested scope.',
    signature: 'owner-signature',
    signedAt: NOW + 1,
  });
  assert.throws(
    () =>
      assurance.decideEvidenceSufficiency({
        request: submitted.request,
        attestation: submitted.attestation,
        tenantId: TENANT,
        expectedRequestVersion: 2,
        decisionId: '018f0000-0000-7000-8000-000000000040',
        actorPrincipalId: OWNER,
        decision: 'sufficient',
        reason: { code: 'evidence.sufficient', text: 'Evidence meets the declared expectation.' },
        decidedAt: NOW + 2,
      }),
    /independent|distinct/i,
  );
  const decided = assurance.decideEvidenceSufficiency({
    request: submitted.request,
    attestation: submitted.attestation,
    tenantId: TENANT,
    expectedRequestVersion: 2,
    decisionId: '018f0000-0000-7000-8000-000000000040',
    actorPrincipalId: AUDITOR,
    decision: 'sufficient',
    reason: { code: 'evidence.sufficient', text: 'Evidence meets the declared expectation.' },
    decidedAt: NOW + 2,
  });
  assert.equal(decided.request.status, 'accepted');
  assert.equal(decided.decision.attestationDigest, submitted.attestation.canonicalDigest);
  assert.equal(submitted.request.status, 'submitted');
  assert.throws(
    () =>
      assurance.decideEvidenceSufficiency({
        request: { ...submitted.request, version: 3 },
        attestation: submitted.attestation,
        tenantId: TENANT,
        expectedRequestVersion: 3,
        decisionId: '018f0000-0000-7000-8000-000000000041',
        actorPrincipalId: AUDITOR,
        decision: 'sufficient',
        reason: { code: 'evidence.sufficient', text: 'Try to bind a stale attestation.' },
        decidedAt: NOW + 3,
      }),
    /version|attestation/i,
  );
});

test('due, expiry, reminder, and escalation remain fail-visible', () => {
  const request = issued();
  assert.equal(assurance.evidenceRequestAttention(request, NOW + 10_001), 'overdue');
  assert.equal(assurance.evidenceRequestAttention(request, NOW + 20_001), 'expired');
  const expired = assurance.expireEvidenceRequest(request, NOW + 20_001);
  assert.equal(expired.status, 'expired');
  assert.equal(request.status, 'issued');
});

test('redaction creates a verified derivative and never mutates or replaces the original', () => {
  const original = packages.createEvidenceOriginal({
    id: 'original-1',
    tenantId: TENANT,
    mediaType: 'application/json',
    content: '{"name":"Alice","account":"1234"}',
    classification: 'restricted',
    retentionPolicyId: 'retention-1',
    recordedAt: NOW,
  });
  assert.throws(
    () =>
      packages.createRedactedEvidenceDerivative({
        id: 'redacted-failed',
        original,
        tenantId: TENANT,
        content: '{"name":"REDACTED","account":"1234"}',
        rulesetId: 'ruleset-1',
        actorPrincipalId: OWNER,
        verifiedAt: NOW + 1,
        verify: () => false,
      }),
    /verification|redaction/i,
  );
  const derivative = packages.createRedactedEvidenceDerivative({
    id: 'redacted-1',
    original,
    tenantId: TENANT,
    content: '{"name":"REDACTED","account":"REDACTED"}',
    rulesetId: 'ruleset-1',
    actorPrincipalId: OWNER,
    verifiedAt: NOW + 1,
    verify: (candidate) =>
      !candidate.content.includes('Alice') && !candidate.content.includes('1234'),
  });
  assert.equal(derivative.parentDigest, original.contentDigest);
  assert.notEqual(derivative.contentDigest, original.contentDigest);
  assert.equal(original.content, '{"name":"Alice","account":"1234"}');
  assert.equal(original.derivative, false);
  assert.equal(derivative.derivative, true);
});

function sign(digest) {
  return createHmac('sha256', SECRET).update(digest).digest('hex');
}

test('signed evidence packages verify independently and fail after any one-byte change', () => {
  const original = packages.createEvidenceOriginal({
    id: 'original-1',
    tenantId: TENANT,
    mediaType: 'text/plain',
    content: 'governed evidence',
    classification: 'internal',
    retentionPolicyId: 'retention-1',
    recordedAt: NOW,
  });
  const bundle = packages.buildSignedEvidencePackage({
    id: 'package-1',
    tenantId: TENANT,
    audiencePrincipalIds: [AUDITOR],
    scope: { controlIds: ['control-1'] },
    entries: [original],
    generatedAt: NOW + 1,
    generatedByPrincipalId: OWNER,
    schemaVersion: 1,
    signatureAlgorithm: 'HMAC-SHA-256',
    signatureKeyId: 'test-key',
    signDigest: sign,
  });
  assert.deepEqual(
    packages.verifySignedEvidencePackage({
      package: bundle,
      tenantId: TENANT,
      audiencePrincipalId: AUDITOR,
      verifySignature: (digest, signature) => sign(digest) === signature,
    }),
    { valid: true, reason: null },
  );
  const tampered = {
    ...bundle,
    entries: [{ ...bundle.entries[0], content: 'governed evidencf' }],
  };
  assert.deepEqual(
    packages.verifySignedEvidencePackage({
      package: tampered,
      tenantId: TENANT,
      audiencePrincipalId: AUDITOR,
      verifySignature: (digest, signature) => sign(digest) === signature,
    }),
    { valid: false, reason: 'content_digest_mismatch' },
  );
  assert.equal(
    packages.verifySignedEvidencePackage({
      package: bundle,
      tenantId: OTHER_TENANT,
      audiencePrincipalId: AUDITOR,
      verifySignature: () => true,
    }).valid,
    false,
  );
  assert.equal(
    packages.verifySignedEvidencePackage({
      package: bundle,
      tenantId: TENANT,
      audiencePrincipalId: OWNER,
      verifySignature: () => true,
    }).reason,
    'audience_not_authorized',
  );
});

test('asynchronous package jobs retain cancellation, failure evidence, verification, and retention state', async () => {
  const queued = worker.createEvidencePackageJob({
    id: 'job-1',
    tenantId: TENANT,
    requesterPrincipalId: AUDITOR,
    requestedAt: NOW,
    retentionUntil: NOW + 86_400_000,
  });
  const cancelled = worker.cancelEvidencePackageJob(queued, AUDITOR, NOW + 1);
  let generated = false;
  const cancelledRun = await worker.runEvidencePackageJob({
    job: cancelled,
    now: NOW + 2,
    generate: async () => {
      generated = true;
      throw new Error('must not run');
    },
  });
  assert.equal(cancelledRun.status, 'cancelled');
  assert.equal(generated, false);

  const failed = await worker.runEvidencePackageJob({
    job: queued,
    now: NOW + 2,
    generate: async () => {
      throw new Error('object store unavailable');
    },
  });
  assert.equal(failed.status, 'failed');
  assert.match(failed.failureEvidence.canonicalDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(failed).includes('object store unavailable'), false);

  const original = packages.createEvidenceOriginal({
    id: 'job-original',
    tenantId: TENANT,
    mediaType: 'text/plain',
    content: 'job evidence',
    classification: 'internal',
    retentionPolicyId: 'retention-1',
    recordedAt: NOW,
  });
  const bundle = packages.buildSignedEvidencePackage({
    id: 'job-package',
    tenantId: TENANT,
    audiencePrincipalIds: [AUDITOR],
    scope: { controlIds: ['control-1'] },
    entries: [original],
    generatedAt: NOW + 2,
    generatedByPrincipalId: OWNER,
    schemaVersion: 1,
    signatureAlgorithm: 'HMAC-SHA-256',
    signatureKeyId: 'test-key',
    signDigest: sign,
  });
  const completed = await worker.runEvidencePackageJob({
    job: queued,
    now: NOW + 2,
    generate: async () => bundle,
  });
  assert.equal(completed.status, 'completed');
  const verified = worker.verifyEvidencePackageJob(completed, {
    tenantId: TENANT,
    audiencePrincipalId: AUDITOR,
    verifySignature: (digest, signature) => sign(digest) === signature,
    verifiedAt: NOW + 3,
  });
  assert.equal(verified.verificationStatus, 'verified');
  assert.equal(verified.retentionUntil, queued.retentionUntil);
});
test('signed review history is immutable and corrections remain separately linked facts', () => {
  const snapshot = reviews.createSignedReviewSnapshot({
    snapshotId: 'snapshot-1',
    source: {
      tenantId: TENANT,
      reviewId: 'review-1',
      reviewVersion: 1,
      completed: true,
      scope: { systemIds: ['system-1'] },
      periodStart: NOW - 86_400_000,
      periodEnd: NOW,
      registryVersions: ['iso-42001:2023'],
      policyVersions: ['policy-1'],
      sourceRevisionSet: ['controls:1'],
      outcomes: [
        { key: 'control:c-1', type: 'control', status: 'pass', recordRef: '/controls/c-1' },
      ],
      evidenceRefs: ['evidence-1'],
      decisionRefs: ['decision-1'],
      authorPrincipalIds: [OWNER],
    },
    signerPrincipalId: AUDITOR,
    signerRole: 'auditor',
    authorityDecisionId: 'authority-1',
    requireIndependentSigner: true,
    signedAt: NOW + 1,
    signatureAlgorithm: 'HMAC-SHA-256',
    signatureKeyId: 'test-key',
    signDigest: sign,
  });
  const correction = reviews.correctReviewSnapshot({
    snapshot,
    correctionRecordId: 'correction-1',
    reason: 'Clarify the scope without rewriting signed history.',
    actorPrincipalId: AUDITOR,
    linkedAt: NOW + 2,
  });
  assert.equal(reviews.verifyReviewSnapshotDigest(snapshot), true);
  assert.equal(correction.originalDigest, snapshot.canonicalDigest);
  assert.deepEqual(snapshot.correctionNoticeRefs, []);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(
    reviews.verifyReviewSnapshotDigest({
      ...snapshot,
      outcomes: [{ ...snapshot.outcomes[0], status: 'fail' }],
    }),
    false,
  );
});

test('redacted package disclosure includes only the verified derivative while preserving lineage', () => {
  const original = packages.createEvidenceOriginal({
    id: 'original-disclosure',
    tenantId: TENANT,
    mediaType: 'application/json',
    content: '{"name":"Alice","account":"1234"}',
    classification: 'restricted',
    retentionPolicyId: 'retention-1',
    recordedAt: NOW,
  });
  const derivative = packages.createRedactedEvidenceDerivative({
    id: 'redacted-disclosure',
    original,
    tenantId: TENANT,
    content: '{"name":"REDACTED","account":"REDACTED"}',
    rulesetId: 'ruleset-disclosure',
    actorPrincipalId: OWNER,
    verifiedAt: NOW + 1,
    verify: (candidate) =>
      !candidate.content.includes('Alice') && !candidate.content.includes('1234'),
  });
  const bundle = packages.buildSignedEvidencePackage({
    id: 'package-redacted',
    tenantId: TENANT,
    audiencePrincipalIds: [AUDITOR],
    scope: { evidenceIds: [derivative.id] },
    entries: [derivative],
    generatedAt: NOW + 2,
    generatedByPrincipalId: OWNER,
    schemaVersion: 1,
    signatureAlgorithm: 'HMAC-SHA-256',
    signatureKeyId: 'test-key',
    signDigest: sign,
  });
  assert.equal(bundle.entries[0].parentDigest, original.contentDigest);
  assert.equal(JSON.stringify(bundle).includes('Alice'), false);
  assert.equal(JSON.stringify(bundle).includes('1234'), false);
  assert.deepEqual(
    packages.verifySignedEvidencePackage({
      package: bundle,
      tenantId: TENANT,
      audiencePrincipalId: AUDITOR,
      verifySignature: (digest, signature) => sign(digest) === signature,
    }),
    { valid: true, reason: null },
  );
});
