// Verification-obligation test for VO-52d0780c11bcc6fd7583
// (Phase 22 / packages/application/src/concurrency.ts).
//
// Oracle (the phase's sole acceptance criterion): "Every onboarded source contract MUST be
// versioned and validated; mutating operations MUST be correlated, deduplicated, reconcilable,
// retry-bounded, and safe under duplicate, delayed, partial, conflicting, and uncertain
// outcomes."
//
// This suite exercises the REAL packages/application/src/concurrency.ts using only Node built-ins
// (loaded via --experimental-strip-types), so it runs deterministically under `npm ci` with no
// adjacent infrastructure. Every property is proven by a positive control paired with a negative
// control, so the assertions are non-vacuous. The module is the transport-boundary enforcement of
// the oracle; the mapping of oracle clause → observable behavior is:
//
//   * VERSIONED + VALIDATED  → makeETag is a deterministic function of (id, tenant, version,
//     contentDigest); parseETag/parseIfMatch VALIDATE the wire form and REJECT malformed input.
//   * OPTIMISTIC CONCURRENCY / SAFE UNDER CONFLICTING → evaluatePrecondition resolves to a closed
//     set (proceed/conflict/precondition_required/not_found); a stale validator → conflict; a
//     missing precondition on a mutation → precondition_required (no blind overwrite / lost
//     update); a matching validator → proceed.
//   * CONFLICT RESPONSES → buildConflictResponse emits an RFC 9457 problem+json 409 carrying the
//     canonical `conflict` outcome, `refresh_and_retry` next action, a bounded retry, and the
//     current server ETag so the caller reconciles & retries.
//   * DEDUPLICATED / SAFE UNDER DUPLICATE & UNCERTAIN → parseIdempotencyKey validates the key;
//     classifyReplay distinguishes first / duplicate (safe replay, no new effect) /
//     idempotency_conflict (same key + different request → refuse).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cc = await import(join(ROOT, 'packages/application/src/concurrency.ts'));

const {
  makeETag,
  parseETag,
  assertETag,
  eTagMatches,
  parseIfMatch,
  PRECONDITION_RESULTS,
  evaluatePrecondition,
  buildConflictResponse,
  parseIdempotencyKey,
  REPLAY_CLASSES,
  classifyReplay,
} = cc;

// A valid UUID + epoch-ms for the RFC 9457 envelope (the domain layer re-validates both).
const CORRELATION_ID = '018f4e2a-7b3c-7c00-8a1b-2c3d4e5f6a7b';
const OCCURRED_AT = 1_720_000_000_000;

function resource(overrides = {}) {
  return {
    id: 'work-item-42',
    tenantId: '018f0000-0000-7000-8000-000000000001',
    version: 3,
    contentDigest: 'sha256:deadbeef',
    ...overrides,
  };
}

// ===========================================================================
// 1. ETags — versioned + validated identity
// ===========================================================================

test('makeETag is deterministic and version/content sensitive (versioned + validated)', () => {
  const r = resource();
  const a = makeETag(r);
  const b = makeETag({ ...r });
  assert.equal(a, b, 'same resource version → identical ETag (deterministic)');
  assert.match(a, /^"v3-[0-9a-f]{32}"$/, 'strong quoted ETag embedding the version');

  // NEGATIVE CONTROL: a change to ANY versioned field changes the ETag.
  assert.notEqual(makeETag({ ...r, version: 4 }), a, 'version bump changes the ETag');
  assert.notEqual(makeETag({ ...r, contentDigest: 'sha256:0' }), a, 'content change changes ETag');
  assert.notEqual(
    makeETag({ ...r, tenantId: '018f0000-0000-7000-8000-000000000002' }),
    a,
    'tenant change changes the ETag (isolation)',
  );
});

test('makeETag rejects an unversioned / invalid resource (validated)', () => {
  assert.throws(() => makeETag({ ...resource(), version: 0 }), /version/, 'version must be ≥ 1');
  assert.throws(
    () => makeETag({ ...resource(), version: 1.5 }),
    /version/,
    'version must be integer',
  );
  assert.throws(() => makeETag({ ...resource(), id: '' }), /id/, 'id must be non-empty');
  assert.throws(() => makeETag({ ...resource(), contentDigest: '' }), /contentDigest/);
  // POSITIVE CONTROL: a well-formed resource does not throw.
  assert.doesNotThrow(() => makeETag(resource()));
});

test('parseETag validates the entity-tag wire form and rejects malformed input', () => {
  assert.deepEqual(parseETag('"abc"'), { value: 'abc', weak: false });
  assert.deepEqual(parseETag('W/"abc"'), { value: 'abc', weak: true }, 'weak marker parsed');
  // NEGATIVE CONTROL: malformed validators are rejected, not silently trusted.
  assert.throws(() => parseETag('abc'), /quoted/, 'unquoted tag rejected');
  assert.throws(() => parseETag('"abc'), /quoted/, 'unterminated quote rejected');
  assert.throws(() => parseETag('"a"b"'), /illegal/, 'embedded quote rejected');
});

test('assertETag / eTagMatches implement RFC 9110 strong vs weak comparison', () => {
  const strong = parseETag('"x"');
  const weak = parseETag('W/"x"');
  assertETag(strong);
  assert.equal(eTagMatches(strong, strong, 'strong'), true, 'two strong equal tags match');
  // NEGATIVE CONTROL: a weak validator NEVER strong-matches (unsafe for optimistic writes).
  assert.equal(eTagMatches(strong, weak, 'strong'), false, 'weak tag fails strong comparison');
  assert.equal(
    eTagMatches(strong, weak, 'weak'),
    true,
    'weak comparison ignores the weakness flag',
  );
  assert.throws(() => assertETag({ value: 5, weak: false }), /value/, 'non-string value rejected');
});

// ===========================================================================
// 2. If-Match parsing — RFC 9110 §13.1.1
// ===========================================================================

test('parseIfMatch parses absence, wildcard, and the 1#entity-tag list', () => {
  assert.equal(parseIfMatch(undefined), null, 'absent header → null');
  assert.equal(parseIfMatch('   '), null, 'blank header → null');
  assert.deepEqual(parseIfMatch('*'), { wildcard: true }, 'wildcard');
  const parsed = parseIfMatch('"a", W/"b" , "c"');
  assert.equal(parsed.wildcard, false);
  assert.deepEqual(parsed.tags, [
    { value: 'a', weak: false },
    { value: 'b', weak: true },
    { value: 'c', weak: false },
  ]);
});

test('parseIfMatch rejects a malformed precondition (must not be treated as unconditional)', () => {
  // NEGATIVE CONTROL: garbled / empty-member lists throw rather than silently downgrading.
  assert.throws(() => parseIfMatch('"a",,"b"'), /empty member/, 'double comma rejected');
  assert.throws(() => parseIfMatch('"a", '), /empty member/, 'trailing comma rejected');
  assert.throws(() => parseIfMatch('notquoted'), /quoted/, 'unquoted member rejected');
});

// ===========================================================================
// 3. Optimistic precondition evaluation — safe under conflicting outcomes
// ===========================================================================

test('a matching strong validator → proceed (safe to mutate)', () => {
  const current = resource();
  const currentETag = makeETag(current);
  const decision = evaluatePrecondition({ ifMatch: parseIfMatch(currentETag), current });
  assert.equal(decision.result, 'proceed');
  assert.equal(decision.currentETag, currentETag);
});

test('a stale validator → conflict (the resource moved under the client)', () => {
  const current = resource({ version: 4 }); // server moved to v4
  const staleETag = makeETag(resource({ version: 3 })); // client read v3
  const decision = evaluatePrecondition({ ifMatch: parseIfMatch(staleETag), current });
  assert.equal(decision.result, 'conflict');
  assert.equal(decision.currentETag, makeETag(current), 'echoes the CURRENT server ETag');
  // POSITIVE/NEGATIVE contrast: the up-to-date validator on the SAME state would proceed.
  assert.equal(
    evaluatePrecondition({ ifMatch: parseIfMatch(makeETag(current)), current }).result,
    'proceed',
  );
});

test('a missing If-Match on a mutation → precondition_required (no lost update)', () => {
  const decision = evaluatePrecondition({ ifMatch: null, current: resource() });
  assert.equal(decision.result, 'precondition_required');
  // A blind overwrite is structurally impossible: absence is never treated as a match.
  assert.notEqual(decision.result, 'proceed');
});

test('If-Match: * matches an existing resource but not an absent one', () => {
  assert.equal(
    evaluatePrecondition({ ifMatch: parseIfMatch('*'), current: resource() }).result,
    'proceed',
  );
  // NEGATIVE CONTROL: wildcard against a non-existent resource → not_found, never proceed.
  assert.equal(
    evaluatePrecondition({ ifMatch: parseIfMatch('*'), current: null }).result,
    'not_found',
  );
});

test('PRECONDITION_RESULTS is the closed outcome set and every branch stays inside it', () => {
  for (const scenario of [
    { ifMatch: null, current: resource() },
    { ifMatch: parseIfMatch('*'), current: resource() },
    { ifMatch: parseIfMatch('*'), current: null },
    { ifMatch: parseIfMatch(makeETag(resource())), current: resource() },
    { ifMatch: parseIfMatch(makeETag(resource({ version: 9 }))), current: resource() },
  ]) {
    const d = evaluatePrecondition(scenario);
    assert.ok(PRECONDITION_RESULTS.includes(d.result), `result ${d.result} is in the closed set`);
  }
});

// ===========================================================================
// 4. Conflict responses — RFC 9457 problem+json
// ===========================================================================

test('buildConflictResponse emits a 409 conflict envelope with refresh_and_retry + current ETag', () => {
  const current = resource({ version: 4 });
  const decision = evaluatePrecondition({
    ifMatch: parseIfMatch(makeETag(resource({ version: 3 }))),
    current,
  });
  const resp = buildConflictResponse({
    decision,
    instance: '/work-items/42',
    correlationId: CORRELATION_ID,
    occurredAt: OCCURRED_AT,
  });
  assert.equal(resp.status, 409, 'conflict → HTTP 409');
  assert.equal(resp.outcomeCode, 'conflict', 'canonical conflict outcome code');
  assert.equal(resp.nextAction, 'refresh_and_retry', 'single safe next action (CHK016)');
  assert.equal(resp.retry.retryable, true, 'conflict is bounded-retryable');
  assert.ok(resp.retry.maxAttempts >= 1, 'retry is bounded');
  assert.equal(resp.etagHeader, makeETag(current), 'echoes the current server ETag for re-read');
  assert.equal(
    resp.problem.type.includes('conflict'),
    true,
    'problem+json type names the conflict',
  );
  assert.equal(resp.problem.title, 'State conflict; refresh and retry');
});

test('buildConflictResponse maps precondition_required and not_found distinctly', () => {
  const pr = buildConflictResponse({
    decision: evaluatePrecondition({ ifMatch: null, current: resource() }),
    instance: '/work-items/42',
    correlationId: CORRELATION_ID,
    occurredAt: OCCURRED_AT,
  });
  assert.equal(pr.status, 422, 'precondition_required → contract_invalid (422)');
  assert.equal(pr.outcomeCode, 'contract_invalid');

  const nf = buildConflictResponse({
    decision: evaluatePrecondition({ ifMatch: parseIfMatch('*'), current: null }),
    instance: '/work-items/42',
    correlationId: CORRELATION_ID,
    occurredAt: OCCURRED_AT,
  });
  assert.equal(nf.status, 500, 'not_found → non_retryable_failure (500)');
  assert.equal(nf.outcomeCode, 'non_retryable_failure');
});

test('buildConflictResponse refuses a proceed decision and an invalid correlation id', () => {
  // NEGATIVE CONTROL: a successful precondition has no conflict response.
  assert.throws(
    () =>
      buildConflictResponse({
        decision: { result: 'proceed', currentETag: makeETag(resource()), reason: 'ok' },
        instance: '/x',
        correlationId: CORRELATION_ID,
        occurredAt: OCCURRED_AT,
      }),
    /proceed/,
  );
  // NEGATIVE CONTROL: a non-UUID correlation id is rejected by the domain envelope (fail-closed).
  assert.throws(
    () =>
      buildConflictResponse({
        decision: evaluatePrecondition({ ifMatch: null, current: resource() }),
        instance: '/x',
        correlationId: 'not-a-uuid',
        occurredAt: OCCURRED_AT,
      }),
    /UUID/,
  );
});

// ===========================================================================
// 5. Idempotency replay classification — deduplicated / safe under duplicate
// ===========================================================================

test('parseIdempotencyKey validates the key and rejects malformed values', () => {
  assert.equal(parseIdempotencyKey(undefined), null, 'absent → null');
  assert.equal(parseIdempotencyKey('op-2024-abc'), 'op-2024-abc');
  // NEGATIVE CONTROL: empty / control-char / over-long keys are rejected.
  assert.equal(parseIdempotencyKey('   '), null, 'blank → null');
  assert.throws(() => parseIdempotencyKey('bad\nkey'), /printable/, 'newline rejected');
  assert.throws(() => parseIdempotencyKey('x'.repeat(256)), /255/, 'over-long rejected');
});

test('classifyReplay distinguishes first / duplicate / idempotency_conflict', () => {
  // first: no prior record → execute once.
  assert.equal(classifyReplay({ requestDigest: 'd1', stored: null }).class, 'first');

  // duplicate: same key + same digest → safe replay, NO new effect.
  const dup = classifyReplay({ requestDigest: 'd1', stored: { requestDigest: 'd1' } });
  assert.equal(dup.class, 'duplicate');
  assert.equal(dup.outcomeCode, 'duplicate', 'surfaces the canonical duplicate outcome');

  // idempotency_conflict: same key + DIFFERENT digest → refuse (no lost update).
  const conflict = classifyReplay({ requestDigest: 'd2', stored: { requestDigest: 'd1' } });
  assert.equal(conflict.class, 'idempotency_conflict');
  assert.equal(conflict.outcomeCode, 'conflict');

  // every branch stays inside the closed classification set.
  for (const c of [dup, conflict]) assert.ok(REPLAY_CLASSES.includes(c.class));
});

test('classifyReplay requires a request digest (validated)', () => {
  // NEGATIVE CONTROL: a keyed mutation cannot be classified without a digest to compare.
  assert.throws(() => classifyReplay({ requestDigest: '', stored: null }), /requestDigest/);
});
