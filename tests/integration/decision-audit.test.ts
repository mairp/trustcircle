// Integration-suite test — DECISION AUDIT & ATTRIBUTION (Phase 4 / User Story 2 / T092 / AC2/AC3).
//
// PHASE OBJECTIVE (T092): "Test accepted and rejected attempt attribution, package binding,
// signature, trusted time, audit atomicity, and non-repudiation evidence in
// tests/integration/decision-audit.test.ts".
//
// Every consequential decision ATTEMPT — accepted OR rejected — must produce EXACTLY ONE durable,
// attributable record that (1) names the actor, (2) binds to the exact package digest the actor
// acted against, (3) carries a mandatory, meaningful reason, (4) carries a trusted (injected)
// decided-at instant, and (5) carries an audit_event_id for non-repudiation. This suite drives the
// REAL decision-service transition function over the REAL domain record factory and reason
// validator, asserting each property for the accepted path and each named rejection path. A
// rejection is never a silent no-op: it yields a REJECTED record naming the machine-readable cause.
//
// Determinism: one fixed injected instant (NOW) and fixed ids — no wall clock, no id generation at
// module scope. Run via `vitest run --project integration`.

import { describe, it, expect } from 'vitest';

import {
  decideDecisionAction,
  acceptedStatusFor,
  type DecisionActionCommand,
  type EffectAuthorityVerdict,
} from '../../packages/application/src/decision-service.ts';
import { validateDecisionReason } from '../../packages/application/src/reasons.ts';
import {
  makeDecisionPackage,
  makeReason,
  decisionPackageDigest,
  decisionRecordDigest,
  type DecisionPackage,
  type Reason,
} from '../../packages/domain/src/index.ts';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const DEC_ID = '00000000-0000-4000-8000-000000000101';
const TENANT = '00000000-0000-4000-8000-000000000001';
const WORK_ITEM = '00000000-0000-4000-8000-000000000102';
const REQUESTER = '00000000-0000-4000-8000-000000000103';
const ACTOR = '00000000-0000-4000-8000-000000000104';
const ASSIGNMENT = '00000000-0000-4000-8000-000000000105';
const RECORD_ID = '00000000-0000-4000-8000-000000000106';
const AUDIT_ID = '00000000-0000-4000-8000-000000000107';

function pkg(over: Partial<Parameters<typeof makeDecisionPackage>[0]> = {}): DecisionPackage {
  return makeDecisionPackage({
    id: DEC_ID,
    tenantId: TENANT,
    workItemId: WORK_ITEM,
    requesterPrincipalId: REQUESTER,
    requestedAction: 'rotate_credentials',
    actionClass: 'high-risk-change',
    riskTier: 'high',
    scope: { system: 'billing' },
    businessImpact: { customers: 'all' },
    risks: [{ kind: 'outage', severity: 'high' }],
    alternatives: [{ kind: 'staged_rollout' }],
    expectedResult: { outcome: 'rotated' },
    createdAt: NOW - DAY,
    expiresAt: NOW + DAY,
    ...over,
  });
}

const APPROVE_REASON: Reason = makeReason('risk_accepted', 'compensating controls verified in staging run');

function permitVerdict(): EffectAuthorityVerdict {
  return { permitted: true, denyReason: null, authorityAssignmentId: ASSIGNMENT };
}

function command(over: Partial<DecisionActionCommand> = {}): DecisionActionCommand {
  const decision = over.decision ?? pkg();
  return {
    decision,
    action: 'approve',
    actorPrincipalId: ACTOR,
    reason: APPROVE_REASON,
    expectedVersion: decision.version,
    authority: permitVerdict(),
    policyAvailable: true,
    newRecordId: RECORD_ID,
    auditEventId: AUDIT_ID,
    now: NOW,
    ...over,
  };
}

describe('T092 — accepted decision attempt (AC2): one attributable, bound, signed record', () => {
  it('produces exactly one ACCEPTED record with actor, digest binding, reason, trusted time, audit id', () => {
    const p = pkg();
    const digest = decisionPackageDigest(p);
    const out = decideDecisionAction(command({ decision: p }), digest);

    expect(out.accepted).toBe(true);
    expect(out.rejectionCode).toBeNull();
    expect(out.nextStatus).toBe(acceptedStatusFor('approve'));

    const r = out.record;
    expect(r.status).toBe('accepted');
    expect(r.actorPrincipalId).toBe(ACTOR); // attribution
    expect(r.authorityAssignmentId).toBe(ASSIGNMENT); // authority binding
    expect(r.packageDigest).toBe(digest); // package binding (acted-against version)
    expect(r.reason.code).toBe('risk_accepted'); // mandatory reason preserved
    expect(r.decidedAt).toBe(NOW); // trusted, injected time
    expect(r.auditEventId).toBe(AUDIT_ID); // non-repudiation

    // The record is content-addressable — the digest is a stable non-repudiation witness.
    expect(decisionRecordDigest(r)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the accepted record binds to the CURRENT digest; a later material change makes it detectable as stale', () => {
    const p = pkg();
    const digest = decisionPackageDigest(p);
    const out = decideDecisionAction(command({ decision: p }), digest);
    // A materially changed package (new scope) has a different digest → record no longer matches.
    const changed = pkg({ scope: { system: 'billing', region: 'eu' } });
    expect(out.record.packageDigest).not.toBe(decisionPackageDigest(changed));
  });
});

describe('T092 — rejected decision attempt (AC3): a refusal is itself a durable, explained record', () => {
  it('MISSING_REASON: a vacuous reason yields a REJECTED record naming the cause', () => {
    const p = pkg();
    const badReason = { code: 'x', text: 'x' } as unknown as Reason;
    const out = decideDecisionAction(
      command({ decision: p, reason: badReason }),
      decisionPackageDigest(p),
    );
    expect(out.accepted).toBe(false);
    expect(out.rejectionCode).toBe('MISSING_REASON');
    expect(out.record.status).toBe('rejected');
    expect(out.record.rejectionCode).toBe('MISSING_REASON');
    // A rejected attempt STILL carries actor + audit id (attributable refusal).
    expect(out.record.actorPrincipalId).toBe(ACTOR);
    expect(out.record.auditEventId).toBe(AUDIT_ID);
  });

  it('NO_AUTHORITY: an unauthorized actor yields a REJECTED record (transition does not occur)', () => {
    const p = pkg();
    const out = decideDecisionAction(
      command({
        decision: p,
        authority: { permitted: false, denyReason: 'NO_AUTHORITY', authorityAssignmentId: null },
      }),
      decisionPackageDigest(p),
    );
    expect(out.accepted).toBe(false);
    expect(out.rejectionCode).toBe('NO_AUTHORITY');
    expect(out.nextStatus).toBe(p.status); // package unchanged
  });

  it('SOD_VIOLATION deny reason is propagated onto the rejected record', () => {
    const p = pkg();
    const out = decideDecisionAction(
      command({
        decision: p,
        authority: { permitted: false, denyReason: 'SOD_VIOLATION', authorityAssignmentId: ASSIGNMENT },
      }),
      decisionPackageDigest(p),
    );
    expect(out.rejectionCode).toBe('SOD_VIOLATION');
    expect(out.record.rejectionCode).toBe('SOD_VIOLATION');
  });

  it('STALE_VERSION: acting against an out-of-date version is refused (AC4 re-review)', () => {
    const p = pkg({ version: 3 });
    const out = decideDecisionAction(
      command({ decision: p, expectedVersion: 2 }),
      decisionPackageDigest(p),
    );
    expect(out.rejectionCode).toBe('STALE_VERSION');
  });

  it('POLICY_UNAVAILABLE: an unavailable policy bundle fails CLOSED', () => {
    const p = pkg();
    const out = decideDecisionAction(
      command({ decision: p, policyAvailable: false }),
      decisionPackageDigest(p),
    );
    expect(out.rejectionCode).toBe('POLICY_UNAVAILABLE');
  });

  it('ALREADY_TERMINAL: acting on a closed package is refused', () => {
    const p = pkg({ status: 'approved' });
    const out = decideDecisionAction(command({ decision: p }), decisionPackageDigest(p));
    expect(out.rejectionCode).toBe('ALREADY_TERMINAL');
  });

  it('PACKAGE_INVALIDATED: acting on an invalidated package is refused', () => {
    const p = pkg({ status: 'invalidated', invalidationReason: 'scope changed', invalidatedAt: NOW - 1 });
    const out = decideDecisionAction(command({ decision: p }), decisionPackageDigest(p));
    expect(out.rejectionCode).toBe('PACKAGE_INVALIDATED');
  });

  it('PACKAGE_EXPIRED: a non-expire verb on an expired package is refused; expire is allowed', () => {
    const expired = pkg({ createdAt: NOW - 2 * DAY, expiresAt: NOW - DAY });
    const denied = decideDecisionAction(
      command({ decision: expired, now: NOW }),
      decisionPackageDigest(expired),
    );
    expect(denied.rejectionCode).toBe('PACKAGE_EXPIRED');

    const expireOut = decideDecisionAction(
      command({
        decision: expired,
        action: 'expire',
        reason: makeReason('deadline_passed', 'review window elapsed without a decision'),
        now: NOW,
      }),
      decisionPackageDigest(expired),
    );
    expect(expireOut.accepted).toBe(true);
    expect(expireOut.nextStatus).toBe('expired');
  });
});

describe('T092 — reason validation is the gate for meaningful attribution (FR-011)', () => {
  it('a recognised category + meaningful narrative validates and preserves the input', () => {
    const v = validateDecisionReason('approve', {
      code: 'risk_accepted',
      text: 'residual risk within appetite after controls',
    });
    expect(v.ok).toBe(true);
    expect(v.reason?.code).toBe('risk_accepted');
    expect(v.preserved.text).toBe('residual risk within appetite after controls');
  });

  it('a vacuous narrative is rejected but the input is PRESERVED for re-render (AC3)', () => {
    const v = validateDecisionReason('deny', { code: 'policy_violation', text: 'n/a' });
    expect(v.ok).toBe(false);
    expect(v.rejection).toBe('NOT_MEANINGFUL');
    expect(v.preserved).toEqual({ code: 'policy_violation', text: 'n/a' });
  });
});
