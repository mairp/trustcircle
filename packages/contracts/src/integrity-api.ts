// @trustcircle/contracts — INTEGRITY-API contract surface (Phase 5 / User Story 3 / T121 /
// FR-016..022, GAR-004, SC-006..009).
//
// This module is the executable form of the phase objective for the containment / repair surface:
// "Validate integrity-case, remediation, and verification REQUESTS, HEADERS, ETags, IDEMPOTENCY,
// ERRORS, and RESPONSES against the API contract." Like decision-api.ts it does NOT re-declare the
// contract in code — it reuses the SAME loaded `governance-api.openapi.yaml` document and the same
// dependency-free schema/protocol validators, resolving the four Integrity operations and their
// `$ref` schemas out of the published contract. If the OpenAPI contract changes, every verdict here
// changes with it; the validator can never silently drift from the published API.
//
// The four operations validated (exactly the paths the contract declares under the `Integrity` tag):
//   GET  /v1/integrity-cases                       → IntegrityCasePage      (the damaged-work queue)
//   GET  /v1/integrity-cases/{caseId}              → IntegrityCase (200 + ETag)
//   POST /v1/integrity-cases/{caseId}/remediations → OperationAccepted (202) — propose/simulate/
//                                                     request-approval/execute-if-pre-authorized
//   POST /v1/integrity-cases/{caseId}/verification → VerificationRecord (200) — failed gates do NOT
//                                                     close the case (FR-022)
//
// It is a THIN specialisation: it re-exports the loader + generic schema/protocol/idempotency/
// governed-rejection validators from decision-api.ts (so a test loads one document and one validator
// family) and adds the integrity-specific named request/response validators bound to these four
// operations. The two most load-bearing invariants it makes checkable at the boundary:
//   * REMEDIATION is state-changing → requires Idempotency-Key + If-Match + Correlation-Id headers,
//     and a governed rejection (e.g. a destructive change refused automatically, GAR-004) is a
//     Problem carrying an audit_event_id + safe next actions.
//   * VERIFICATION returning `failed`/`indeterminate` gate results is a WELL-FORMED response that
//     does NOT imply closure — the contract's VerificationRecord result is independent of any
//     source-reported `done` (FR-022). This module validates the record shape; the closure semantics
//     live in the domain oracle.

// NOTE: the shared loader + generic validators (loadGovernanceApi, validateRequestHeaders,
// validateProblem, validateGovernedRejection, validateIdempotentReplay, GOVERNANCE_API_PATH, …) are
// already exported from the package barrel via ./decision-api.ts — this module does NOT re-export
// them (that would be a duplicate export). An integrity contract test imports the shared surface and
// the integrity-specific validators from the SAME `@trustcircle/contracts` entry point.
import {
  requestBodySchema,
  responseSchema,
  validateAgainstSchema,
  validateRequestHeaders,
  validateEtagResponse,
  type GovernanceApiDocument,
  type Json,
  type Headers,
} from './decision-api.ts';

// ===========================================================================
// A local response-schema resolver that follows a RESPONSE-LEVEL `$ref`.
//
// The generic `responseSchema(op, status)` reads `op.responses[status].content` directly; that works
// for operations whose response is declared inline (the GET queue/detail 200 and the verification
// 200). But the remediation 202 response is a `$ref` to a SHARED response object
// (`#/components/responses/OperationAccepted`), so `op.responses['202']` is `{ $ref: … }` with no
// inline `content`. This helper dereferences that shared response first, then hands the resolved
// response object to `responseSchema` via a one-key synthetic operation, so the validator sees the
// same `{ responses: { <status>: <resolved response> } }` shape it expects.
// ===========================================================================

function refResponseSchema(doc: GovernanceApiDocument, op: Json, status: string): Json {
  const responses = (op as Record<string, Json>)['responses'] as Record<string, Json> | undefined;
  const node = responses?.[status];
  const refPtr =
    node && typeof node === 'object' && !Array.isArray(node)
      ? (node as Record<string, Json>)['$ref']
      : undefined;
  const resolved = typeof refPtr === 'string' ? doc.ref(refPtr) : node;
  // Present the resolved response under the SAME status so responseSchema can read its content schema.
  const synthetic = { responses: { [status]: resolved } } as unknown as Parameters<
    typeof responseSchema
  >[0];
  return responseSchema(synthetic, status);
}

// ===========================================================================
// The four Integrity operation paths (exactly as declared in the contract).
// ===========================================================================

export const INTEGRITY_CASES_PATH = '/v1/integrity-cases';
export const INTEGRITY_CASE_PATH = '/v1/integrity-cases/{caseId}';
export const REMEDIATION_PATH = '/v1/integrity-cases/{caseId}/remediations';
export const VERIFICATION_PATH = '/v1/integrity-cases/{caseId}/verification';

// ===========================================================================
// Named request validators (bound to the exact contract operations).
// ===========================================================================

/** Validate a `POST .../remediations` RemediationCommand request body (propose/simulate/execute). */
export function validateRemediationCommand(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    requestBodySchema(doc.operation('post', REMEDIATION_PATH)),
    body,
  );
}

/** Validate a `POST .../verification` VerificationCommand request body. */
export function validateVerificationCommand(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    requestBodySchema(doc.operation('post', VERIFICATION_PATH)),
    body,
  );
}

// ===========================================================================
// Named response validators.
// ===========================================================================

/** Validate a `GET /v1/integrity-cases` IntegrityCasePage response body (the queue). */
export function validateIntegrityCasePage(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    responseSchema(doc.operation('get', INTEGRITY_CASES_PATH), '200'),
    body,
  );
}

/** Validate a `GET /v1/integrity-cases/{caseId}` IntegrityCase response body (200 + ETag). */
export function validateIntegrityCase(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    responseSchema(doc.operation('get', INTEGRITY_CASE_PATH), '200'),
    body,
  );
}

/** Validate a `POST .../remediations` 202 OperationAccepted response body (async accepted). The 202
 *  response is a shared `$ref` response, so its schema is resolved via `refResponseSchema`. */
export function validateOperationAccepted(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    refResponseSchema(doc, doc.operation('post', REMEDIATION_PATH), '202'),
    body,
  );
}

/** Validate a `POST .../verification` 200 VerificationRecord response body (may be failed gates). */
export function validateVerificationRecord(doc: GovernanceApiDocument, body: Json): string[] {
  return validateAgainstSchema(
    doc,
    responseSchema(doc.operation('post', VERIFICATION_PATH), '200'),
    body,
  );
}

// ===========================================================================
// Protocol convenience — the required headers for the state-changing operations.
// ===========================================================================

/** Validate the required headers a remediation request must carry (tenant/idempotency/corr/If-Match). */
export function validateRemediationHeaders(doc: GovernanceApiDocument, headers: Headers): string[] {
  return validateRequestHeaders(doc, doc.operation('post', REMEDIATION_PATH), headers);
}

/** Validate the required headers a verification request must carry. */
export function validateVerificationHeaders(
  doc: GovernanceApiDocument,
  headers: Headers,
): string[] {
  return validateRequestHeaders(doc, doc.operation('post', VERIFICATION_PATH), headers);
}

/** Validate the ETag emission on the `GET /v1/integrity-cases/{caseId}` 200 response. */
export function validateIntegrityCaseEtag(
  doc: GovernanceApiDocument,
  responseHeaders: Headers,
): string[] {
  return validateEtagResponse(doc.operation('get', INTEGRITY_CASE_PATH), '200', responseHeaders);
}

// ===========================================================================
// Convenience: the remediation MODES the contract permits (read from the enum,
// so the permitted-mode set is exactly the published contract — GAR-004's alphabet).
// ===========================================================================

export function permittedRemediationModes(doc: GovernanceApiDocument): string[] {
  const schema = doc.resolveSchema(requestBodySchema(doc.operation('post', REMEDIATION_PATH)));
  const modeNode = (schema.properties ?? {})['mode'] ?? {};
  const modeSchema = doc.resolveSchema(modeNode);
  const en = modeSchema.enum;
  if (!en) throw new Error('mode enum not found in RemediationCommand schema');
  return en.filter((x): x is string => typeof x === 'string');
}
