// Verification-obligation test for VO-34d9f9fb2a6a39e2d62c
// (Phase 16 / packages/domain/src/outcomes.ts / GAR-005).
//
// Oracle: Integrity rules, policies, controllers, controls, and mappings MUST have stable
// identifiers, versions, owners, lifecycle states, tests, monitoring, failure behavior,
// exceptions, and evidence expectations.
//
// This suite exercises the REAL packages/domain/src/outcomes.ts using only Node built-ins
// (loaded via --experimental-strip-types), so it runs deterministically under `npm ci` with no
// adjacent infrastructure. Every property is proven by a positive control paired with a
// negative control, so the assertions are non-vacuous:
//
//   * Governance (oracle/GAR-005): the outcome vocabulary is a governed MAPPING entity — it
//     cannot be defined without all nine facets; dropping ANY facet is rejected, and the
//     descriptor table must be exhaustive over the canonical codes.
//   * Canonical outcome codes: a closed, stable set covering the Failure-Semantics / CHK016
//     classes; membership is total.
//   * Safe next action (CHK016): EXACTLY ONE next action per outcome; the mapping is total and
//     unambiguous; every code resolves.
//   * Retryability: retries are bounded; a non-retryable outcome can NEVER carry retry advice;
//     rate-limited carries a concrete delay hint.
//   * RFC 9457 envelope: problem+json with the RFC members plus governance extensions; envelope
//     is internally consistent (type/title/status/retry/nextAction all match the code) and
//     disclosure-safe (no stack traces / secrets); a forged inconsistent envelope is rejected.
//   * Durable-effect witness: the catalog digest is re-derivable from an independent snapshot
//     and changes iff a governed facet changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const oc = await import(join(ROOT, 'packages/domain/src/outcomes.ts'));
const prim = await import(join(ROOT, 'packages/domain/src/primitives.ts'));

const {
  OUTCOME_CODES,
  FAILURE_OUTCOME_CODES,
  isOutcomeCode,
  isTerminalSuccess,
  SAFE_NEXT_ACTIONS,
  SAFE_NEXT_ACTION_BY_CODE,
  safeNextActionFor,
  isSafeNextAction,
  makeRetry,
  assertRetry,
  retryFor,
  NO_RETRY,
  OUTCOME_REGISTRY,
  outcomeDescriptor,
  PROBLEM_JSON_MEDIA_TYPE,
  makeProblem,
  assertProblem,
  defineOutcomeCatalog,
  assertOutcomeCatalog,
  outcomeCatalogDigest,
} = oc;

const { uuidV7, makeReason, PLATFORM_SCOPE } = prim;

const detRandom = (n) => new Uint8Array(n).fill(0xa7);
const T0 = 1_700_000_000_000;
const CID = uuidV7(T0, detRandom);

function goodContract(overrides = {}) {
  return {
    tests: ['VO-34d9f9fb2a6a39e2d62c', 'tests/domain/outcomes.test.mjs'],
    monitoring: ['alert.outcome.unmapped'],
    failureBehavior: 'fail-closed',
    exceptions: [],
    evidenceExpectations: ['outcome-catalog-digest', 'problem-envelope'],
    ...overrides,
  };
}

function goodCatalogInput(overrides = {}) {
  return {
    id: uuidV7(T0, detRandom),
    tenantId: PLATFORM_SCOPE,
    version: 1,
    owner: { ownerId: 'platform-governance', kind: 'team' },
    lifecycleState: 'active',
    contract: goodContract(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Canonical outcome codes — closed, stable, total membership
// ---------------------------------------------------------------------------

test('outcome codes cover the CHK016 outcome classes and succeeded/duplicate', () => {
  for (const c of [
    'succeeded',
    'retryable_failure',
    'non_retryable_failure',
    'rate_limited',
    'policy_denied',
    'contract_invalid',
    'version_unsupported',
    'conflict',
    'uncertain',
    'duplicate',
  ]) {
    assert.ok(OUTCOME_CODES.includes(c), `missing canonical code ${c}`);
    assert.ok(isOutcomeCode(c));
  }
  // Negative control: an unknown code is not canonical.
  assert.equal(isOutcomeCode('kinda_worked'), false);
  assert.equal(isOutcomeCode(42), false);
});

test('isTerminalSuccess is true only for succeeded/duplicate', () => {
  assert.equal(isTerminalSuccess('succeeded'), true);
  assert.equal(isTerminalSuccess('duplicate'), true);
  // Negative control.
  assert.equal(isTerminalSuccess('conflict'), false);
  assert.equal(isTerminalSuccess('uncertain'), false);
  for (const c of FAILURE_OUTCOME_CODES) assert.equal(isTerminalSuccess(c), false);
});

// ---------------------------------------------------------------------------
// Safe next action — CHK016: exactly one, total, unambiguous
// ---------------------------------------------------------------------------

test('every canonical code maps to exactly one safe next action (total, CHK016)', () => {
  const seenCodes = new Set();
  for (const code of OUTCOME_CODES) {
    const a = safeNextActionFor(code);
    assert.ok(isSafeNextAction(a), `action ${a} not in the closed set`);
    assert.ok(SAFE_NEXT_ACTIONS.includes(a), 'resolved action must be from the closed set');
    assert.equal(a, SAFE_NEXT_ACTION_BY_CODE[code], 'function and table disagree');
    seenCodes.add(code);
  }
  // Total: table has an entry for every code and no extras.
  assert.deepEqual(Object.keys(SAFE_NEXT_ACTION_BY_CODE).sort(), [...OUTCOME_CODES].sort());
  assert.equal(seenCodes.size, OUTCOME_CODES.length);
});

test('outcome registry is exhaustive and every entry is a disclosure-safe descriptor', () => {
  assert.deepEqual(Object.keys(OUTCOME_REGISTRY).sort(), [...OUTCOME_CODES].sort());
  for (const code of OUTCOME_CODES) {
    const d = OUTCOME_REGISTRY[code];
    assert.equal(d.code, code);
    assert.ok(d.type.startsWith('https://'), 'RFC 9457 type must be a URI');
    assert.ok(d.title.length > 0);
    assert.ok(Number.isInteger(d.status) && d.status >= 200 && d.status < 600);
    assert.equal(outcomeDescriptor(code).type, d.type);
  }
});

test('safe-next-action rules are the intended unambiguous ones per class', () => {
  assert.equal(safeNextActionFor('succeeded'), 'none');
  assert.equal(safeNextActionFor('duplicate'), 'none');
  assert.equal(safeNextActionFor('retryable_failure'), 'retry_with_backoff');
  assert.equal(safeNextActionFor('non_retryable_failure'), 'escalate');
  assert.equal(safeNextActionFor('rate_limited'), 'retry_after_delay');
  assert.equal(safeNextActionFor('policy_denied'), 'request_review');
  assert.equal(safeNextActionFor('contract_invalid'), 'fix_and_resubmit');
  assert.equal(safeNextActionFor('version_unsupported'), 'upgrade_contract_version');
  assert.equal(safeNextActionFor('conflict'), 'refresh_and_retry');
  assert.equal(safeNextActionFor('uncertain'), 'reconcile');
  // Negative control: an uncertain outcome must NEVER be told to claim success (none) — it
  // must reconcile.
  assert.notEqual(safeNextActionFor('uncertain'), 'none');
});

// ---------------------------------------------------------------------------
// Retryability — bounded; non-retryable carries no advice
// ---------------------------------------------------------------------------

test('retries are bounded and non-retryable outcomes carry no retry advice', () => {
  const r = makeRetry({ retryable: true, maxAttempts: 3, backoff: 'exponential' });
  assert.equal(r.retryable, true);
  assert.ok(r.maxAttempts >= 1 && Number.isInteger(r.maxAttempts));

  assert.deepEqual(
    { ...NO_RETRY },
    { retryable: false, maxAttempts: 0, backoff: 'none', retryAfterMs: 0 },
  );

  // Negative controls: a non-retryable outcome cannot smuggle in attempts or a delay.
  assert.throws(() => makeRetry({ retryable: false, maxAttempts: 5 }), /non-retryable/);
  assert.throws(() => makeRetry({ retryable: false, retryAfterMs: 100 }), /non-retryable/);
  // Retryable must be bounded.
  assert.throws(() => makeRetry({ retryable: true, maxAttempts: 0 }), /bounded/);
  // assertRetry rejects a hand-forged inconsistent descriptor.
  assert.throws(
    () => assertRetry({ retryable: false, maxAttempts: 3, backoff: 'none', retryAfterMs: 0 }),
    /must not carry retry advice/,
  );
});

test('retryFor is total and matches the code semantics', () => {
  assert.equal(retryFor('retryable_failure').retryable, true);
  assert.equal(retryFor('conflict').retryable, true);
  const rl = retryFor('rate_limited');
  assert.equal(rl.retryable, true);
  assert.ok(rl.retryAfterMs > 0, 'rate_limited must carry a concrete delay hint');
  for (const c of [
    'succeeded',
    'duplicate',
    'non_retryable_failure',
    'policy_denied',
    'contract_invalid',
    'version_unsupported',
    'uncertain',
  ]) {
    assert.equal(retryFor(c).retryable, false, `${c} must be non-retryable`);
  }
});

// ---------------------------------------------------------------------------
// RFC 9457 envelope — problem+json, consistent + disclosure-safe
// ---------------------------------------------------------------------------

test('makeProblem produces an RFC 9457 problem+json envelope with governance extensions', () => {
  assert.equal(PROBLEM_JSON_MEDIA_TYPE, 'application/problem+json');
  const p = makeProblem({
    outcomeCode: 'rate_limited',
    detail: 'Source connector throttled the request.',
    instance: '/operations/op-123',
    correlationId: CID,
    occurredAt: T0,
    retryAfterMs: 2500,
  });
  // RFC 9457 base members.
  for (const m of ['type', 'title', 'status', 'detail', 'instance']) {
    assert.ok(m in p, `envelope missing RFC 9457 member ${m}`);
  }
  const d = outcomeDescriptor('rate_limited');
  assert.equal(p.type, d.type);
  assert.equal(p.title, d.title);
  assert.equal(p.status, d.status);
  assert.equal(p.status, 429);
  // Governance extension members.
  assert.equal(p.outcomeCode, 'rate_limited');
  assert.equal(p.nextAction, 'retry_after_delay');
  assert.equal(p.retry.retryable, true);
  assert.equal(p.retry.retryAfterMs, 2500);
  assert.equal(p.correlationId, CID);
  assert.equal(p.occurredAt, T0);
  // Independent read-path check accepts a well-formed envelope.
  assert.doesNotThrow(() => assertProblem(p));
});

test('envelopes are internally consistent — a forged inconsistent envelope is rejected', () => {
  const p = makeProblem({
    outcomeCode: 'non_retryable_failure',
    detail: 'Downstream permanently rejected the mutation.',
    instance: '/operations/op-9',
    correlationId: CID,
    occurredAt: T0,
  });
  assert.equal(p.retry.retryable, false, 'non-retryable code must not advise retry');
  assert.equal(p.nextAction, 'escalate');

  // Negative control A: swap nextAction to a wrong one -> assertProblem rejects (CHK016).
  assert.throws(() => assertProblem({ ...p, nextAction: 'none' }), /nextAction is inconsistent/);
  // Negative control B: mismatched status vs registry.
  assert.throws(() => assertProblem({ ...p, status: 200 }), /status does not match/);
  // Negative control C: retry advice on a non-retryable code.
  assert.throws(
    () =>
      assertProblem({
        ...p,
        retry: { retryable: true, maxAttempts: 3, backoff: 'fixed', retryAfterMs: 0 },
      }),
    /inconsistent with the outcome code/,
  );
});

test('problem detail must be disclosure-safe (no stack traces / secrets)', () => {
  const base = {
    outcomeCode: 'non_retryable_failure',
    instance: '/operations/op-x',
    correlationId: CID,
    occurredAt: T0,
  };
  // Positive control: a plain safe message is accepted.
  assert.doesNotThrow(() => makeProblem({ ...base, detail: 'The remote rejected the request.' }));
  // Negative controls: leaked stack frame, source location, or secret is refused.
  assert.throws(
    () => makeProblem({ ...base, detail: 'boom at handler (/app/src/x.ts:42)' }),
    /disclosure-safe/,
  );
  assert.throws(() => makeProblem({ ...base, detail: 'failed at foo.ts:12' }), /disclosure-safe/);
  assert.throws(
    () => makeProblem({ ...base, detail: 'db password was rejected' }),
    /disclosure-safe/,
  );
});

// ---------------------------------------------------------------------------
// Governed outcome catalog — GAR-005 executable invariant (the phase oracle)
// ---------------------------------------------------------------------------

test('outcome catalog is a fully governed mapping entity (all nine GAR-005 facets)', () => {
  const cat = defineOutcomeCatalog(goodCatalogInput());
  assert.equal(cat.kind, 'mapping');
  // Stable id, version, owner, lifecycle, contract facets all present.
  assert.ok(cat.id && cat.version >= 1 && cat.owner && cat.lifecycleState);
  assert.ok(cat.contract.tests.length > 0);
  assert.ok(cat.contract.monitoring.length > 0);
  assert.ok(cat.contract.failureBehavior);
  assert.ok(Array.isArray(cat.contract.exceptions));
  assert.ok(cat.contract.evidenceExpectations.length > 0);
  // Descriptor table is exhaustive over the canonical codes.
  assert.deepEqual(Object.keys(cat.descriptors).sort(), [...OUTCOME_CODES].sort());
  assert.doesNotThrow(() => assertOutcomeCatalog(cat));
});

test('catalog accepts a governed exception register (approved, structured reason, expiry)', () => {
  const exceptionId = uuidV7(T0, detRandom);
  const cat = defineOutcomeCatalog(
    goodCatalogInput({
      contract: goodContract({
        exceptions: [
          {
            exceptionId,
            reason: makeReason('outcome.legacy', 'legacy consumer mapping retained under waiver'),
            approvedBy: { ownerId: 'chief-governance', kind: 'user' },
            expiresAt: T0 + 86_400_000,
          },
        ],
      }),
    }),
  );
  assert.equal(cat.contract.exceptions.length, 1);
  assert.doesNotThrow(() => assertOutcomeCatalog(cat));
  // Negative control: an exception with an empty reason text is rejected.
  assert.throws(() => makeReason('outcome.legacy', '   '), /empty/i);
});

test('a catalog missing ANY GAR-005 facet is rejected (non-vacuous per facet)', () => {
  // id / stable identifier
  assert.throws(() => defineOutcomeCatalog(goodCatalogInput({ id: 'not-a-uuid' })), /UUID/i);
  // version
  assert.throws(() => defineOutcomeCatalog(goodCatalogInput({ version: 0 })), /version/i);
  // owner
  assert.throws(
    () => defineOutcomeCatalog(goodCatalogInput({ owner: { ownerId: '', kind: 'team' } })),
    /owner/i,
  );
  // lifecycle
  assert.throws(
    () => defineOutcomeCatalog(goodCatalogInput({ lifecycleState: 'bogus' })),
    /lifecycle/i,
  );
  // tests
  assert.throws(
    () => defineOutcomeCatalog(goodCatalogInput({ contract: goodContract({ tests: [] }) })),
    /tests/i,
  );
  // monitoring
  assert.throws(
    () => defineOutcomeCatalog(goodCatalogInput({ contract: goodContract({ monitoring: [] }) })),
    /monitoring/i,
  );
  // failure behavior
  assert.throws(
    () =>
      defineOutcomeCatalog(
        goodCatalogInput({ contract: goodContract({ failureBehavior: 'nope' }) }),
      ),
    /failureBehavior/i,
  );
  // exceptions must be present (array)
  assert.throws(
    () =>
      defineOutcomeCatalog(goodCatalogInput({ contract: goodContract({ exceptions: undefined }) })),
    /exceptions/i,
  );
  // evidence expectations
  assert.throws(
    () =>
      defineOutcomeCatalog(
        goodCatalogInput({ contract: goodContract({ evidenceExpectations: [] }) }),
      ),
    /evidenceExpectations/i,
  );
});

test('assertOutcomeCatalog rejects a non-exhaustive descriptor table', () => {
  const cat = defineOutcomeCatalog(goodCatalogInput());
  const missingOne = { ...cat.descriptors };
  delete missingOne.conflict;
  assert.throws(
    () => assertOutcomeCatalog({ ...cat, descriptors: missingOne }),
    /exhaustive over OUTCOME_CODES/,
  );
  // And a descriptor mutated to disagree with the registry is rejected.
  const tampered = { ...cat.descriptors, conflict: { ...cat.descriptors.conflict, status: 200 } };
  assert.throws(() => assertOutcomeCatalog({ ...cat, descriptors: tampered }), /inconsistent/);
});

// ---------------------------------------------------------------------------
// Durable-effect witness — re-derivable digest that changes iff facets change
// ---------------------------------------------------------------------------

test('catalog digest is re-derivable from an independent snapshot and change-detecting', () => {
  const a = defineOutcomeCatalog(goodCatalogInput());
  const b = defineOutcomeCatalog(goodCatalogInput()); // independently constructed, same facets
  assert.equal(outcomeCatalogDigest(a), outcomeCatalogDigest(b), 'digest must be re-derivable');
  // Negative control: bump the version -> digest changes.
  const c = defineOutcomeCatalog(goodCatalogInput({ version: 2 }));
  assert.notEqual(outcomeCatalogDigest(a), outcomeCatalogDigest(c));
  // Negative control: change an owner -> digest changes.
  const dOwner = defineOutcomeCatalog(
    goodCatalogInput({ owner: { ownerId: 'someone-else', kind: 'user' } }),
  );
  assert.notEqual(outcomeCatalogDigest(a), outcomeCatalogDigest(dOwner));
});
