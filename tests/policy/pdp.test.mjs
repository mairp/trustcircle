// Verification-obligation test for VO-173f7afb7801f4ab3e29 (Phase 44 — packages/policy/src/pdp.ts).
//
// Oracle (acceptance criterion): Request, review, approval, execution, evidence administration,
// control ownership, and assurance MUST be separated where conflicts exist; platform
// administration alone MUST NOT grant decision authority, and the independent central reviewer
// for a cross-tenant action MUST NOT hold an incompatible action role.
//
// Independently observable: exercises the REAL packages/policy/src/pdp.ts (the replaceable PDP
// port + signed OPA bundle adapter + revision pinning + signed decision evidence), which itself
// delegates the SoD decision to the SINGLE source of truth packages/authz/src/separation-of-
// duties.ts. Loaded via --experimental-strip-types with only Node built-ins, so it runs
// deterministically under `npm ci` with no OPA sidecar. Every clause pairs a positive control
// (clean case permitted) with a negative control (violation denied), so assertions are
// non-vacuous. The PDP-mechanics clauses (bundle signing, revision pinning, evidence) each pair
// a durable, independently verifiable witness with a rejected tamper/drift case.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pdp = await import(join(ROOT, 'packages/policy/src/pdp.ts'));

const {
  SignedOpaBundleAdapter,
  createSignedOpaPdp,
  signBundle,
  verifyBundle,
  verifyDecisionEvidence,
  PdpUnavailableError,
} = pdp;

const BK = 'bundle-signing-key';
const EK = 'evidence-signing-key';

/** A clean, independently-reviewed SoD action (request + distinct approver with real authority). */
function cleanSoDInput() {
  return {
    assignments: [
      {
        principalId: 'requester-1',
        duty: 'request',
        roles: ['governance_officer'],
        relationships: ['requester'],
        tenantId: 't1',
      },
      {
        principalId: 'approver-1',
        duty: 'approval',
        roles: ['authorized_approver'],
        relationships: ['approver'],
        tenantId: 't1',
      },
    ],
    constraint: {
      sodConstraintId: 'c-1',
      tenantId: 't1',
      actionClass: 'consequential.action',
      incompatibleRoles: [],
      incompatibleRelationships: [],
      minimumDistinctPrincipals: 2,
      status: 'active',
    },
  };
}

function decisionRequest(query, over = {}) {
  return {
    query,
    actorPrincipalId: 'system-pdp',
    correlationId: 'corr-abc',
    pinnedRevision: 'rev-1',
    now: 1_700_000_000_000,
    ...over,
  };
}

function freshPdp() {
  return createSignedOpaPdp({ revision: 'rev-1', bundleSigningKey: BK, evidenceSigningKey: EK });
}

// ---------------------------------------------------------------------------
// The PDP is a REPLACEABLE PORT: the concrete adapter satisfies the PolicyDecisionPoint shape.
// ---------------------------------------------------------------------------

test('PDP port: signed OPA adapter implements the replaceable port surface (descriptor + decide)', () => {
  const engine = freshPdp();
  assert.equal(engine.descriptor.adapter, 'opa-signed-bundle');
  assert.equal(engine.descriptor.revision, 'rev-1');
  assert.match(engine.descriptor.bundleDigest, /^[0-9a-f]{64}$/);
  assert.equal(typeof engine.decide, 'function');

  // A different in-process adapter object implementing the same port is a drop-in substitute:
  // the caller only depends on { descriptor, decide }.
  const stub = {
    descriptor: { adapter: 'stub', revision: 'rev-1', bundleDigest: 'x'.repeat(64) },
    decide() {
      return {
        decision: { policy: 'separation_of_duties', permit: true, reasons: [] },
        evidence: null,
      };
    },
  };
  assert.equal(typeof stub.decide, 'function');
  assert.equal(stub.decide().decision.permit, true);
});

// ---------------------------------------------------------------------------
// Clause A — duties MUST be separated where conflicts exist (self-approval denied).
// ---------------------------------------------------------------------------

test('clause A (positive): distinct requester+approver with authority is PERMITTED', () => {
  const engine = freshPdp();
  const { decision } = engine.decide(
    decisionRequest({ policy: 'separation_of_duties', input: cleanSoDInput() }),
  );
  assert.equal(decision.permit, true);
  assert.deepEqual(decision.reasons, []);
});

test('clause A (negative): one principal holding request AND approval is DENIED (self-approval)', () => {
  const engine = freshPdp();
  const input = cleanSoDInput();
  // Same principal now fills both the request and the approval duty for the same action.
  input.assignments = [
    {
      principalId: 'same-1',
      duty: 'request',
      roles: ['governance_officer'],
      relationships: ['requester'],
      tenantId: 't1',
    },
    {
      principalId: 'same-1',
      duty: 'approval',
      roles: ['authorized_approver'],
      relationships: [],
      tenantId: 't1',
    },
  ];
  const { decision } = engine.decide(decisionRequest({ policy: 'separation_of_duties', input }));
  assert.equal(decision.permit, false);
  assert.ok(decision.reasons.some((v) => v.code === 'SELF_APPROVAL'));
});

// ---------------------------------------------------------------------------
// Clause B — platform administration ALONE MUST NOT grant decision authority.
// ---------------------------------------------------------------------------

test('clause B (positive): an authorized_approver DOES carry approval decision authority', () => {
  const engine = freshPdp();
  const { decision } = engine.decide(
    decisionRequest({ policy: 'separation_of_duties', input: cleanSoDInput() }),
  );
  assert.equal(decision.permit, true);
});

test('clause B (negative): platform_admin alone filling approval is DENIED (no decision authority)', () => {
  const engine = freshPdp();
  const input = cleanSoDInput();
  input.assignments = [
    {
      principalId: 'requester-1',
      duty: 'request',
      roles: ['governance_officer'],
      relationships: ['requester'],
      tenantId: 't1',
    },
    {
      principalId: 'admin-1',
      duty: 'approval',
      roles: ['platform_admin'],
      relationships: [],
      tenantId: 't1',
    },
  ];
  const { decision } = engine.decide(decisionRequest({ policy: 'separation_of_duties', input }));
  assert.equal(decision.permit, false);
  assert.ok(decision.reasons.some((v) => v.code === 'PLATFORM_ADMIN_NO_AUTHORITY'));
});

// ---------------------------------------------------------------------------
// Clause C — the cross-tenant independent central reviewer MUST be distinct and hold no
// incompatible action role.
// ---------------------------------------------------------------------------

function crossTenantAction() {
  return {
    requesterPrincipalId: 'req-1',
    operatorPrincipalId: 'op-1',
    controlOwnerPrincipalId: 'owner-1',
    tenantApproverPrincipalIds: ['ta-1', 'ta-2'],
  };
}

test('clause C (positive): a distinct central reviewer with only the reviewer role is PERMITTED', () => {
  const engine = freshPdp();
  const { decision } = engine.decide(
    decisionRequest({
      policy: 'central_reviewer_distinctness',
      input: {
        action: crossTenantAction(),
        reviewer: { principalId: 'central-1', roles: ['central_governance_reviewer'] },
      },
    }),
  );
  assert.equal(decision.permit, true);
});

test('clause C (negative: not distinct): reviewer who is also a tenant approver is DENIED', () => {
  const engine = freshPdp();
  const { decision } = engine.decide(
    decisionRequest({
      policy: 'central_reviewer_distinctness',
      input: {
        action: crossTenantAction(),
        reviewer: { principalId: 'ta-1', roles: ['central_governance_reviewer'] },
      },
    }),
  );
  assert.equal(decision.permit, false);
  assert.ok(decision.reasons.some((v) => v.code === 'CENTRAL_REVIEWER_NOT_DISTINCT'));
});

test('clause C (negative: incompatible role): reviewer who also holds an approver role is DENIED', () => {
  const engine = freshPdp();
  const { decision } = engine.decide(
    decisionRequest({
      policy: 'central_reviewer_distinctness',
      input: {
        action: crossTenantAction(),
        reviewer: {
          principalId: 'central-2',
          roles: ['central_governance_reviewer', 'authorized_approver'],
        },
      },
    }),
  );
  assert.equal(decision.permit, false);
  assert.ok(decision.reasons.some((v) => v.code === 'CENTRAL_REVIEWER_INCOMPATIBLE_ROLE'));
});

// ---------------------------------------------------------------------------
// Signed OPA bundle: a bundle must be signed and untampered before it can be loaded.
// ---------------------------------------------------------------------------

test('signed bundle (positive): a correctly signed bundle verifies and yields a digest', () => {
  const bundle = signBundle({ revision: 'rev-1', roots: ['separation_of_duties'] }, BK);
  const digest = verifyBundle(bundle, BK);
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test('signed bundle (negative: unsigned): an unsigned bundle is REJECTED fail-closed', () => {
  const bundle = { revision: 'rev-1', roots: ['separation_of_duties'], signature: '' };
  assert.throws(
    () => verifyBundle(bundle, BK),
    (e) => e instanceof PdpUnavailableError && e.reason === 'unsigned',
  );
});

test('signed bundle (negative: tampered): a bundle signed with the wrong key is REJECTED', () => {
  const bundle = signBundle({ revision: 'rev-1', roots: ['separation_of_duties'] }, 'attacker-key');
  assert.throws(
    () => verifyBundle(bundle, BK),
    (e) => e instanceof PdpUnavailableError && e.reason === 'bad-signature',
  );
});

test('signed bundle (negative: mutated after signing): revision swap breaks the signature', () => {
  const bundle = signBundle({ revision: 'rev-1', roots: ['separation_of_duties'] }, BK);
  const mutated = { ...bundle, revision: 'rev-999' };
  assert.throws(
    () => verifyBundle(mutated, BK),
    (e) => e instanceof PdpUnavailableError && e.reason === 'bad-signature',
  );
});

test('adapter construction (negative): building a PDP on an unsigned bundle throws fail-closed', () => {
  assert.throws(
    () =>
      new SignedOpaBundleAdapter({
        bundle: { revision: 'rev-1', roots: ['separation_of_duties'], signature: '' },
        bundleVerificationKey: BK,
        evidenceSigningKey: EK,
      }),
    (e) => e instanceof PdpUnavailableError && e.reason === 'unsigned',
  );
});

// ---------------------------------------------------------------------------
// Revision pinning: the adapter refuses to decide against a revision the caller did not pin.
// ---------------------------------------------------------------------------

test('revision pinning (positive): a matching pinned revision decides normally', () => {
  const engine = freshPdp();
  const { decision } = engine.decide(
    decisionRequest(
      { policy: 'separation_of_duties', input: cleanSoDInput() },
      { pinnedRevision: 'rev-1' },
    ),
  );
  assert.equal(decision.permit, true);
});

test('revision pinning (negative): a drifted pinned revision is REJECTED fail-closed', () => {
  const engine = freshPdp();
  assert.throws(
    () =>
      engine.decide(
        decisionRequest(
          { policy: 'separation_of_duties', input: cleanSoDInput() },
          { pinnedRevision: 'rev-2' },
        ),
      ),
    (e) => e instanceof PdpUnavailableError && e.reason === 'revision-mismatch',
  );
});

// ---------------------------------------------------------------------------
// Decision evidence: every decision carries a signed, revision-pinned, tamper-evident record.
// ---------------------------------------------------------------------------

test('decision evidence (positive): evidence binds input+revision+digest and verifies', () => {
  const engine = freshPdp();
  const input = cleanSoDInput();
  const { decision, evidence } = engine.decide(
    decisionRequest(
      { policy: 'separation_of_duties', input },
      { correlationId: 'corr-XYZ', actorPrincipalId: 'actor-9', now: 42 },
    ),
  );
  // Durable, independently readable witnesses that could not exist before the decision:
  assert.equal(evidence.policy, 'separation_of_duties');
  assert.equal(evidence.permit, decision.permit);
  assert.equal(evidence.bundleRevision, 'rev-1');
  assert.equal(evidence.bundleDigest, engine.descriptor.bundleDigest);
  assert.match(evidence.inputDigest, /^[0-9a-f]{64}$/);
  assert.equal(evidence.correlationId, 'corr-XYZ');
  assert.equal(evidence.actorPrincipalId, 'actor-9');
  assert.equal(evidence.decidedAt, 42);
  assert.match(evidence.signature, /^[0-9a-f]{64}$/);
  // Independently verifiable against the evidence key.
  assert.equal(verifyDecisionEvidence(evidence, EK), true);
});

test('decision evidence (negative: tamper): flipping permit invalidates the signature', () => {
  const engine = freshPdp();
  const { evidence } = engine.decide(
    decisionRequest({ policy: 'separation_of_duties', input: cleanSoDInput() }),
  );
  assert.equal(verifyDecisionEvidence({ ...evidence, permit: !evidence.permit }, EK), false);
});

test('decision evidence (negative: reason strip): removing a deny reason invalidates the signature', () => {
  const engine = freshPdp();
  const input = cleanSoDInput();
  input.assignments = [
    {
      principalId: 'admin-1',
      duty: 'approval',
      roles: ['platform_admin'],
      relationships: [],
      tenantId: 't1',
    },
    {
      principalId: 'requester-1',
      duty: 'request',
      roles: ['governance_officer'],
      relationships: ['requester'],
      tenantId: 't1',
    },
  ];
  const { evidence } = engine.decide(decisionRequest({ policy: 'separation_of_duties', input }));
  assert.ok(evidence.reasons.length > 0);
  assert.equal(verifyDecisionEvidence({ ...evidence, reasons: [] }, EK), false);
});

test('decision evidence (negative: wrong key): verifying with the wrong key fails', () => {
  const engine = freshPdp();
  const { evidence } = engine.decide(
    decisionRequest({ policy: 'separation_of_duties', input: cleanSoDInput() }),
  );
  assert.equal(verifyDecisionEvidence(evidence, 'wrong-key'), false);
});

test('decision evidence (witness): the SAME input under a DIFFERENT bundle revision yields a DIFFERENT digest binding', () => {
  const a = createSignedOpaPdp({ revision: 'rev-1', bundleSigningKey: BK, evidenceSigningKey: EK });
  const b = createSignedOpaPdp({ revision: 'rev-2', bundleSigningKey: BK, evidenceSigningKey: EK });
  const input = cleanSoDInput();
  const ea = a.decide(
    decisionRequest({ policy: 'separation_of_duties', input }, { pinnedRevision: 'rev-1' }),
  ).evidence;
  const eb = b.decide(
    decisionRequest({ policy: 'separation_of_duties', input }, { pinnedRevision: 'rev-2' }),
  ).evidence;
  // Same query input digest (identical input) but distinct bundle digests + revisions bind the
  // evidence to the exact policy content it was decided against.
  assert.equal(ea.inputDigest, eb.inputDigest);
  assert.notEqual(ea.bundleDigest, eb.bundleDigest);
  assert.notEqual(ea.bundleRevision, eb.bundleRevision);
});
