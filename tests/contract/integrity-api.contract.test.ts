// TrustCircleAI — Phase 5 · User Story 3 — INTEGRITY-API CONTRACT (T121 · FR-016..022 · GAR-004 ·
// SC-006..009).
//
// CONTRACT-LEVEL validation of the CONTAINMENT / REPAIR surface — the integrity-case queue + detail,
// remediation (recommend / simulate / request-approval / execute-if-pre-authorized), and verification
// — against the CANONICAL API contract
// (`specs/001-governance-control-plane/contracts/governance-api.openapi.yaml`) via the runtime module
// `@trustcircle/contracts/integrity-api`. That module LOADS the contract and resolves the four
// `Integrity`-tagged operations + their `$ref` schemas, so every assertion below is coupled to the
// PUBLISHED API — never a hand-copied shape.
//
// Each obligation is asserted with its NEGATIVE control so no checker is vacuous:
//   • QUEUE / DETAIL responses (FR-016, SC-006/009) — a conformant IntegrityCasePage / IntegrityCase
//     passes; a page missing metadata or a case missing `version`/`original_evidence_id` is rejected.
//   • REMEDIATION request (FR-020, GAR-004) — a well-formed RemediationCommand with a permitted mode +
//     complete plan + reason passes; an unknown mode, an incomplete plan, or a missing reason fails.
//   • VERIFICATION request/response (FR-022) — a well-formed VerificationCommand passes; a
//     VerificationRecord with failed gate_results is a VALID response (failed gates do NOT close the
//     case) — a record missing gate_results is rejected.
//   • PROTOCOL (state-changing) — remediation + verification require X-Tenant-ID + Idempotency-Key +
//     X-Correlation-ID + If-Match; dropping any one is rejected. The single-case read declares an ETag.
//   • GOVERNED REJECTION — a GAR-004 auto-refusal is a Problem carrying an audit_event_id + safe next
//     actions.
//
// No wall clock, no Math.random; deterministic ids. Relative imports with `.ts` extensions, mirroring
// the sibling contract suites. The shared loader + generic validators come from `decision-api.ts`
// (the integrity module intentionally does not re-export them); the integrity-specific validators come
// from `integrity-api.ts`.

import { describe, expect, it } from 'vitest';

import {
  loadGovernanceApi,
  validateProblem,
  validateGovernedRejection,
  validateIdempotentReplay,
  requiredHeaders,
  declaresEtag,
  type GovernanceApiDocument,
  type Json,
  type Headers,
} from '../../packages/contracts/src/decision-api.ts';
import {
  INTEGRITY_CASES_PATH,
  INTEGRITY_CASE_PATH,
  REMEDIATION_PATH,
  VERIFICATION_PATH,
  validateRemediationCommand,
  validateVerificationCommand,
  validateIntegrityCasePage,
  validateIntegrityCase,
  validateOperationAccepted,
  validateVerificationRecord,
  validateRemediationHeaders,
  validateVerificationHeaders,
  validateIntegrityCaseEtag,
  permittedRemediationModes,
} from '../../packages/contracts/src/integrity-api.ts';

const DOC: GovernanceApiDocument = loadGovernanceApi();

// ── Deterministic fixtures (no clock / no randomness) ────────────────────────────────────────────

const TENANT = '11111111-1111-7111-8111-111111111111';
const CASE_ID = '22222222-2222-7222-8222-222222222222';
const EVIDENCE_ID = '33333333-3333-7333-8333-333333333333';
const QUARANTINE_ID = '44444444-4444-7444-8444-444444444444';
const PLAN_ID = '55555555-5555-7555-8555-555555555555';
const VERIFICATION_ID = '66666666-6666-7666-8666-666666666666';
const AUDIT_ID = '77777777-7777-7777-8777-777777777777';
const CORRELATION = '88888888-8888-7888-8888-888888888888';
const OPERATION_ID = '99999999-9999-7999-8999-999999999999';
const MANIFEST_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const VERIFIER_ID = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const IDEMPOTENCY_KEY = 'idem-integrity-0000000000000000';

const REASON: Json = {
  code: 'remediate_corruption',
  text: 'restore the derivative from the preserved original',
};

function commandHeaders(overrides: Record<string, string | undefined> = {}): Headers {
  return {
    'X-Tenant-ID': TENANT,
    'Idempotency-Key': IDEMPOTENCY_KEY,
    'X-Correlation-ID': CORRELATION,
    'If-Match': '"ic-3-abc"',
    ...overrides,
  } as Headers;
}

function completePlan(): Json {
  return {
    proposed_change: { op: 'restore_derivative', from: 'original' },
    expected_result: { derivative_matches_original: true },
    preconditions: [{ check: 'original_preserved' }],
    evidence_plan: { capture: ['before', 'after'] },
    verification_plan: { gates: 'all_nine' },
    stop_conditions: [{ on: 'unexpected_write' }],
    rollback_plan: { restore: 'checkpoint' },
  };
}

function remediationCommand(overrides: Record<string, unknown> = {}): Json {
  return {
    mode: 'execute_if_pre_authorized',
    plan: completePlan(),
    reason: REASON,
    ...overrides,
  } as Json;
}

function verificationCommand(overrides: Record<string, unknown> = {}): Json {
  return {
    expected_state: { derivative_matches_original: true },
    evidence_manifest_id: MANIFEST_ID,
    reason: { code: 'verify_closure', text: 'independent nine-gate verification of the repair' },
    ...overrides,
  } as Json;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// FR-016 / SC-006 / SC-009 — the queue + detail read responses.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('FR-016 — integrity-case queue + detail', () => {
  const wireCase = (overrides: Record<string, unknown> = {}): Json =>
    ({
      id: CASE_ID,
      tenant_id: TENANT,
      problem_class: 'corrupted',
      severity: 'high',
      original_evidence_id: EVIDENCE_ID,
      quarantine_id: QUARANTINE_ID,
      remediation_plan_id: PLAN_ID,
      verification_id: null,
      state: 'quarantined',
      version: 3,
      ...overrides,
    }) as Json;

  const pageMetadata: Json = {
    generated_at: '2026-08-02T00:00:00.000Z',
    source_cursor: 'snapshot-digest-abc',
    freshness: 'current',
    partial_coverage: false,
    next_cursor: null,
  };

  it('accepts a conformant IntegrityCasePage (the prioritized damaged-work queue)', () => {
    const page: Json = { items: [wireCase()], metadata: pageMetadata };
    expect(validateIntegrityCasePage(DOC, page)).toEqual([]);
  });

  it('NEGATIVE — a page missing metadata is rejected', () => {
    const page = { items: [wireCase()] } as Json;
    expect(validateIntegrityCasePage(DOC, page).length).toBeGreaterThan(0);
  });

  it('accepts a conformant single IntegrityCase (200 detail body)', () => {
    expect(validateIntegrityCase(DOC, wireCase())).toEqual([]);
  });

  it('NEGATIVE — a case missing the version the ETag binds to is rejected (SC-009)', () => {
    const { version: _drop, ...noVersion } = wireCase() as Record<string, unknown>;
    void _drop;
    expect(validateIntegrityCase(DOC, noVersion as Json).length).toBeGreaterThan(0);
  });

  it('NEGATIVE — a case missing the preserved original evidence id is rejected (FR-017)', () => {
    const { original_evidence_id: _drop, ...noOriginal } = wireCase() as Record<string, unknown>;
    void _drop;
    expect(validateIntegrityCase(DOC, noOriginal as Json).length).toBeGreaterThan(0);
  });

  it('NEGATIVE — a case with an out-of-vocabulary problem_class is rejected', () => {
    expect(
      validateIntegrityCase(DOC, wireCase({ problem_class: 'fabricated' })).length,
    ).toBeGreaterThan(0);
  });

  it('declares a strong ETag on the single-case read (SC-009 optimistic concurrency)', () => {
    expect(declaresEtag(DOC.operation('get', INTEGRITY_CASE_PATH), '200')).toBe(true);
    expect(validateIntegrityCaseEtag(DOC, { etag: '"ic-3-abc"' } as Headers)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// FR-020 / GAR-004 — the remediation command (recommend / simulate / request-approval / execute).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('FR-020 / GAR-004 — remediation command', () => {
  it('the permitted modes are exactly the four contract modes', () => {
    expect(permittedRemediationModes(DOC).sort()).toEqual(
      ['execute_if_pre_authorized', 'recommend_only', 'request_approval', 'simulate'].sort(),
    );
  });

  it.each(['recommend_only', 'simulate', 'request_approval', 'execute_if_pre_authorized'])(
    'accepts a well-formed command in mode %s',
    (mode) => {
      expect(validateRemediationCommand(DOC, remediationCommand({ mode }))).toEqual([]);
    },
  );

  it('NEGATIVE — an unknown mode is rejected', () => {
    expect(
      validateRemediationCommand(DOC, remediationCommand({ mode: 'delete_everything' })).length,
    ).toBeGreaterThan(0);
  });

  it('NEGATIVE — an incomplete plan (missing rollback_plan) is rejected', () => {
    const plan = completePlan() as Record<string, unknown>;
    delete plan['rollback_plan'];
    expect(validateRemediationCommand(DOC, remediationCommand({ plan })).length).toBeGreaterThan(0);
  });

  it('NEGATIVE — a command missing the mandatory reason is rejected (attributable action)', () => {
    const cmd = remediationCommand() as Record<string, unknown>;
    delete cmd['reason'];
    expect(validateRemediationCommand(DOC, cmd as Json).length).toBeGreaterThan(0);
  });

  it('NEGATIVE — an unknown top-level property is rejected (additionalProperties:false)', () => {
    expect(
      validateRemediationCommand(DOC, remediationCommand({ force: true })).length,
    ).toBeGreaterThan(0);
  });

  it('accepts a conformant 202 OperationAccepted response', () => {
    const accepted: Json = {
      operation_id: OPERATION_ID,
      status: 'accepted',
      correlation_id: CORRELATION,
      audit_event_id: AUDIT_ID,
      idempotent_replay: false,
    };
    expect(validateOperationAccepted(DOC, accepted)).toEqual([]);
    // An idempotent REPLAY must reproduce the SAME effect (same op id + audit id) and mark the flag.
    const original = {
      idempotencyKey: IDEMPOTENCY_KEY,
      tenantId: TENANT,
      resourceId: OPERATION_ID,
      resourceVersion: 1,
      auditEventId: AUDIT_ID,
      idempotentReplay: false,
    };
    const replay = { ...original, idempotentReplay: true };
    expect(validateIdempotentReplay(original, replay)).toEqual([]);
    // NEGATIVE — a replay that minted a new audit id (a second effect) is rejected.
    expect(
      validateIdempotentReplay(original, { ...replay, auditEventId: CORRELATION }).length,
    ).toBeGreaterThan(0);
  });

  it('NEGATIVE — an OperationAccepted missing its audit_event_id is rejected', () => {
    const accepted = {
      operation_id: OPERATION_ID,
      status: 'accepted',
      correlation_id: CORRELATION,
    } as Json;
    expect(validateOperationAccepted(DOC, accepted).length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// FR-022 — verification: failed gates are a VALID response and do NOT close the case.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('FR-022 — verification command + record', () => {
  it('accepts a well-formed VerificationCommand', () => {
    expect(validateVerificationCommand(DOC, verificationCommand())).toEqual([]);
  });

  it('NEGATIVE — a VerificationCommand missing the evidence manifest is rejected', () => {
    const cmd = verificationCommand() as Record<string, unknown>;
    delete cmd['evidence_manifest_id'];
    expect(validateVerificationCommand(DOC, cmd as Json).length).toBeGreaterThan(0);
  });

  it('accepts a PASSED VerificationRecord response', () => {
    const rec: Json = {
      id: VERIFICATION_ID,
      verifier_principal_id: VERIFIER_ID,
      result: 'passed',
      gate_results: [
        { gate: 'originals_and_derivatives_present', result: 'passed' },
        { gate: 'closure_transition_audited', result: 'passed' },
      ],
      evidence_manifest_id: MANIFEST_ID,
      verified_at: '2026-08-02T00:00:00.000Z',
    };
    expect(validateVerificationRecord(DOC, rec)).toEqual([]);
  });

  it('accepts a FAILED VerificationRecord — failed gates are a valid, non-closing result', () => {
    const rec: Json = {
      id: VERIFICATION_ID,
      verifier_principal_id: VERIFIER_ID,
      result: 'failed',
      gate_results: [
        {
          gate: 'state_reconciled_no_uncertainty',
          result: 'failed',
          detail: 'remote outcome uncertain',
        },
      ],
      evidence_manifest_id: MANIFEST_ID,
      verified_at: '2026-08-02T00:00:00.000Z',
    };
    // The record is WELL-FORMED even though it does not close the case (FR-022).
    expect(validateVerificationRecord(DOC, rec)).toEqual([]);
    expect(rec['result']).toBe('failed');
  });

  it('NEGATIVE — a VerificationRecord missing gate_results is rejected', () => {
    const rec = {
      id: VERIFICATION_ID,
      verifier_principal_id: VERIFIER_ID,
      result: 'passed',
      evidence_manifest_id: MANIFEST_ID,
      verified_at: '2026-08-02T00:00:00.000Z',
    } as Json;
    expect(validateVerificationRecord(DOC, rec).length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// PROTOCOL — state-changing operations require the full header set + a governed-rejection Problem.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('protocol — headers, governed rejection', () => {
  it('remediation requires tenant + idempotency + correlation + If-Match headers', () => {
    const names = requiredHeaders(DOC, DOC.operation('post', REMEDIATION_PATH))
      .map((h) => h.name)
      .sort();
    expect(names).toEqual(
      ['If-Match', 'Idempotency-Key', 'X-Correlation-ID', 'X-Tenant-ID'].sort(),
    );
    expect(validateRemediationHeaders(DOC, commandHeaders())).toEqual([]);
  });

  it.each(['X-Tenant-ID', 'Idempotency-Key', 'X-Correlation-ID', 'If-Match'])(
    'NEGATIVE — dropping the %s header on a remediation request is rejected',
    (drop) => {
      const errs = validateRemediationHeaders(DOC, commandHeaders({ [drop]: undefined }));
      expect(errs.some((e) => e.includes(drop))).toBe(true);
    },
  );

  it('verification likewise requires the full state-changing header set', () => {
    expect(validateVerificationHeaders(DOC, commandHeaders())).toEqual([]);
    expect(
      validateVerificationHeaders(DOC, commandHeaders({ 'If-Match': undefined })).length,
    ).toBeGreaterThan(0);
  });

  it('a GAR-004 governed rejection is a Problem carrying an audit_event_id + safe next actions', () => {
    const rejection: Json = {
      type: 'about:blank#remediation_not_pre_authorized',
      title: 'Unprocessable Entity',
      status: 422,
      code: 'remediation_not_pre_authorized',
      detail: 'the requested change is destructive and is not pre-authorized for automatic repair',
      correlation_id: CORRELATION,
      retryable: false,
      audit_event_id: AUDIT_ID,
      safe_next_actions: ['request_approval', 'recommend_only'],
    };
    expect(validateProblem(DOC, rejection)).toEqual([]);
    expect(validateGovernedRejection(DOC, rejection, CORRELATION)).toEqual([]);
  });

  it('NEGATIVE — a governed rejection with no audit_event_id is rejected', () => {
    const rejection = {
      type: 'about:blank#remediation_not_pre_authorized',
      title: 'Unprocessable Entity',
      status: 422,
      code: 'remediation_not_pre_authorized',
      detail: 'destructive, not pre-authorized',
      correlation_id: CORRELATION,
      retryable: false,
      safe_next_actions: ['request_approval'],
    } as Json;
    expect(validateGovernedRejection(DOC, rejection, CORRELATION).length).toBeGreaterThan(0);
  });

  it('the four Integrity paths resolve as the contract declares', () => {
    expect(INTEGRITY_CASES_PATH).toBe('/v1/integrity-cases');
    expect(INTEGRITY_CASE_PATH).toBe('/v1/integrity-cases/{caseId}');
    expect(REMEDIATION_PATH).toBe('/v1/integrity-cases/{caseId}/remediations');
    expect(VERIFICATION_PATH).toBe('/v1/integrity-cases/{caseId}/verification');
    expect(() => DOC.operation('get', INTEGRITY_CASES_PATH)).not.toThrow();
    expect(() => DOC.operation('post', VERIFICATION_PATH)).not.toThrow();
  });
});
