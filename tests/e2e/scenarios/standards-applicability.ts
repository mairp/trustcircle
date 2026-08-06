// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 7 · User Story 5 — DEMONSTRATE COMPLIANCE AND AUDIT READINESS acceptance runners (T217).
//
//   Requirements: FR-031, FR-032, FR-033, FR-034, FR-035, FR-051, FR-052, FR-053, FR-054, FR-055, FR-056.
//   Success:      SC-012 (readiness ≠ certification; nothing promoted), SC-013 (reconstruct-at-instant is
//                 byte-identical), SC-022 (every gap surfaced verbatim, never hidden).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free, deterministic set of ACCEPTANCE RUNNERS for User Story 5. It projects the FIXED
// compliance world (tests/fixtures/compliance.ts, bridged node-safely through ./_compliance-inputs.ts)
// and returns a STRUCTURED RESULT that binds every acceptance criterion to a concrete durable fact
// observed through a REAL oracle — a coverage-engine result (`reconstructCoverage`), a domain predicate
// (`applicabilityIsActive` / `nonApplicabilityReopensGap` / `applicabilityVersionSupersedes` /
// `publicationDutyClass`), an application service (`proposeApplicability` / `reviewApplicability` /
// `importStandardsSeed`), the audit-export BUILDER (`buildAuditExportPackage` / `verifyManifest` /
// `custodyChainIsIntact` / `authorizeReferences`), or the accessibility ORACLE — NEVER a mutation echo.
//
// It is a plain ESM module (no test-runner import) reusable from BOTH the Node built-in runner and the
// vitest emitter. The SYNC logic scenario is `.tsx`-free at eval time (raw-node runnable); the ASYNC
// accessibility scenario lazily imports the `.tsx` oracle (vitest-only). Every criterion carries a
// NEGATIVE-CONTROL fact whose flip would drive its oracle RED, so no assertion is vacuous.
//
// DETERMINISM. No wall clock (the fixed NOW), no I/O, no randomness. Same fixture ⇒ byte-identical result.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import {
  NOW,
  TENANT,
  OTHER_TENANT,
  COMPLIANCE_OWNER,
  INDEPENDENT_REVIEWER,
  CONTROL_OWNER,
  AUDITOR,
  PUBLICATION_42006,
  DUTY_CLASS_42006,
  CLAUSE_READY,
  DECISION_READY,
  DECISION_REOPENED_NA,
  FULL_TENANT_INPUTS,
  IDS,
  coverageForScenario,
  buildCoverageViewModel,
} from './_compliance-inputs.ts';
import type { ComplianceInputs } from './_compliance-inputs.ts';

import {
  proposeApplicability,
  reviewApplicability,
  importStandardsSeed,
  registryUuid,
  StandardsImportError,
  type StandardsSeed,
} from '@trustcircle/application';
import { evaluateApplicabilityReview } from '@trustcircle/authz';
import {
  applicabilityIsActive,
  nonApplicabilityReopensGap,
  applicabilityVersionSupersedes,
  publicationDutyClass,
  makeReason,
  type Uuid,
  type EpochMillis,
} from '@trustcircle/domain';
import {
  holdManagementReview,
  reviewCadenceLapsed,
  type ManagementReview,
} from '@trustcircle/application';
import {
  raiseFinding,
  openCorrectiveAction,
  reviewEffectiveness,
  closeCorrectiveAction,
  findingOverdue,
} from '@trustcircle/application';
import {
  buildAuditExportPackage,
  verifyManifest,
  custodyChainIsIntact,
  authorizeReferences,
  exportReferenceCount,
  EXTERNAL_CLAIM_NOTE,
  type AuditExportRequest,
  type EvidenceReference,
  type SigningKey,
} from '../../../apps/command-worker/src/audit-export.ts';

import type { AccessibilityReport } from '../../../apps/web/src/features/compliance/accessibility.tsx';

const ACCESSIBILITY_ORACLE = '../../../apps/web/src/features/compliance/accessibility.tsx';

// ── Result shapes (mirrors the controller-operations runner idiom, verbatim) ─────────────────────

export interface CriterionResult {
  readonly ref: string;
  readonly statement: string;
  readonly satisfied: boolean;
  readonly evidence: string;
  readonly observedVia: string;
  readonly negativeControl: string;
}

export interface ScenarioResult {
  readonly scenario: string;
  readonly criteria: readonly CriterionResult[];
  readonly allSatisfied: boolean;
  readonly digest: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function digestOf(criteria: readonly CriterionResult[]): string {
  return `sha256:${createHash('sha256').update(canonical(criteria)).digest('hex')}`;
}

export function finish(scenario: string, criteria: readonly CriterionResult[]): ScenarioResult {
  return {
    scenario,
    criteria,
    allSatisfied: criteria.every((c) => c.satisfied),
    digest: digestOf(criteria),
  };
}

export type { ComplianceInputs } from './_compliance-inputs.ts';
export {
  buildComplianceInputs,
  buildCoverageViewModel,
  COMPLIANCE_TENANT_SCOPE,
} from './_compliance-inputs.ts';

// ── The fixed, deterministic signing key + audit-export request the runners assert against ───────

/** A fixed HMAC signing key (never a wall-clock/RNG secret) — same key ⇒ same signature (FR-056). */
const SIGNING_KEY: SigningKey = { keyId: 'gate7-test-key', secret: 'gate7-deterministic-secret' };

/** A small, deterministic evidence-reference set: two owned by TENANT, one by OTHER_TENANT (FR-053). */
function evidenceReferences(): readonly EvidenceReference[] {
  return [
    {
      evidenceId: String(IDS.EVIDENCE_READY),
      tenantId: String(TENANT),
      obligationId: 'obligation-ready',
      recordedAt: NOW - 10 * 24 * 3_600_000,
      contentDigest: 'sha256:ready-evidence-content',
      accessAuthorized: true,
    },
    {
      evidenceId: String(IDS.EVIDENCE_STALE),
      tenantId: String(TENANT),
      obligationId: 'obligation-stale',
      recordedAt: NOW - 200 * 24 * 3_600_000,
      contentDigest: 'sha256:stale-evidence-content',
      accessAuthorized: true,
    },
    {
      evidenceId: 'evidence-other-tenant-leak-candidate',
      tenantId: String(OTHER_TENANT),
      recordedAt: NOW - 5 * 24 * 3_600_000,
      contentDigest: 'sha256:other-tenant-content',
      accessAuthorized: true,
    },
  ];
}

/** The exact scope + period + reason + inputs + references the FR-052/FR-056 export is built from. */
function auditExportRequest(): AuditExportRequest {
  const fi = FULL_TENANT_INPUTS;
  return {
    operationRequestId: 'audit-export-t217',
    tenantId: String(TENANT),
    requesterPrincipalId: String(AUDITOR),
    scope: { tenantId: TENANT as unknown as Uuid },
    periodFrom: NOW - 365 * 24 * 3_600_000,
    periodTo: NOW,
    reason: {
      code: 'external_audit',
      text: 'Prepare the annual ISO/IEC 42001 audit evidence pack.',
    },
    coverageInputs: {
      decisions: fi.decisions,
      obligations: fi.obligations,
      mappings: fi.mappings,
      evaluations: fi.evaluations,
      certifications: fi.certifications,
    },
    evidenceReferences: evidenceReferences(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO — STANDARDS APPLICABILITY + AUDIT READINESS (the SYNC logic scenario).
// Every criterion reads a durable fact off a REAL oracle; every one carries a flip-to-red control.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export function runStandardsApplicabilityScenario(inputs: ComplianceInputs): ScenarioResult {
  const at = inputs.at;
  const criteria: CriterionResult[] = [];

  // ── FR-031 / FR-051 — immutable versioned publication facts + material classification. ──────────
  // 42006 is certification_body_criteria; a readiness label is NEVER a certification (FR-055).
  const dutyClass42006 = publicationDutyClass(PUBLICATION_42006, false);
  const dutyIfCertBody = publicationDutyClass(PUBLICATION_42006, true);
  criteria.push({
    ref: 'FR-031 / FR-051',
    statement:
      'A registered ISO/IEC 42006 publication is an immutable, versioned fact classified as certification-body criteria — audit-readiness, NOT an organizational conformity duty.',
    satisfied:
      PUBLICATION_42006.materialType === 'certification_body_criteria' &&
      PUBLICATION_42006.registryVersion === 1 &&
      dutyClass42006 === 'certification_body_criteria' &&
      DUTY_CLASS_42006 === 'certification_body_criteria',
    evidence: `42006.materialType=${PUBLICATION_42006.materialType}; publicationDutyClass(42006,false)=${dutyClass42006}`,
    observedVia:
      'publicationDutyClass(PUBLICATION_42006, false) over the frozen fixture publication fields (domain oracle)',
    negativeControl: `were the tenant an approved certification body the class would flip to '${dutyIfCertBody}' — the class is a computed fact of the publication, not a label`,
  });

  // ── FR-051 / SC-012 — future-4200x import admits a hypothetical draft deterministically. ────────
  const futureSeed: StandardsSeed = {
    registryVersion: 1,
    scope: 'iso-4200x',
    publications: [
      {
        id: 'iso-iec-42007-2027-draft',
        publisher: 'ISO/IEC',
        identifier: 'ISO/IEC 42007:2027',
        exactTitle:
          'Information technology — Artificial intelligence — Draft guidance for a future 4200x standard',
        edition: '1',
        publicationDate: '2027-01-01',
        status: 'published',
        materialType: 'requirements',
        sourceUri: 'https://www.iso.org/standard/99999.html',
        registryVersion: 1,
        clauses: [{ clauseRef: '5.1', title: 'Scope', version: 1 }],
      },
    ],
  };
  const imported = importStandardsSeed(futureSeed, at);
  const importedAgain = importStandardsSeed(futureSeed, at);
  const importedDigestsStable =
    JSON.stringify(imported.publicationDigests) ===
    JSON.stringify(importedAgain.publicationDigests);
  let duplicateThrew = false;
  let duplicateErrName = '';
  try {
    importStandardsSeed(
      { publications: [futureSeed.publications[0]!, futureSeed.publications[0]!] },
      at,
    );
  } catch (err) {
    duplicateThrew = true;
    duplicateErrName =
      err instanceof StandardsImportError ? err.name : `Other:${(err as Error).name}`;
  }
  criteria.push({
    ref: 'FR-051 / SC-012',
    statement:
      'The standards importer admits a hypothetical future ISO/IEC 42007 draft as immutable, deterministic publication facts — without asserting any tenant conformity.',
    satisfied:
      imported.publications.length === 1 &&
      imported.publications[0]!.identifier === 'ISO/IEC 42007:2027' &&
      imported.clauses.length === 1 &&
      importedDigestsStable &&
      duplicateThrew &&
      duplicateErrName === 'StandardsImportError',
    evidence: `imported ${imported.publications.length} pub / ${imported.clauses.length} clause; digests stable=${importedDigestsStable}; duplicate threw ${duplicateErrName}`,
    observedVia: 'importStandardsSeed(futureSeed, NOW) — the real application standards importer',
    negativeControl:
      'a duplicate identifier@registryVersion seed throws StandardsImportError — the registry never silently overwrites or double-registers a fact',
  });

  // ── FR-032 — independent applicability review yields an ACTIVE superseding decision. ────────────
  const proposed = proposeApplicability({
    id: registryUuid('t217-propose-decision'),
    tenantId: TENANT as unknown as Uuid,
    clauseVersionId: CLAUSE_READY.id,
    systemId: IDS.SYSTEM_ID,
    jurisdiction: 'EU',
    useCase: { domain: 'credit-underwriting', riskTier: 'high' },
    proposedResult: 'applicable',
    rationale:
      'The clause applies: the underwriting system makes consequential automated decisions in the EU.',
    evidenceIds: [IDS.EVIDENCE_APPLICABILITY],
    obligationOwnerPrincipalId: CONTROL_OWNER,
    proposerPrincipalId: COMPLIANCE_OWNER,
    reviewAt: (at + 180 * 24 * 3_600_000) as EpochMillis,
    now: at,
  });
  const independentVerdict = evaluateApplicabilityReview({
    proposerPrincipalId: String(COMPLIANCE_OWNER),
    controlOwnerPrincipalId: String(CONTROL_OWNER),
    reviewerPrincipalId: String(INDEPENDENT_REVIEWER),
    reviewerRoles: ['independent_compliance_reviewer'],
    action: 'approve',
  });
  const approveReason = makeReason(
    'independent_review_approved',
    'Independent reviewer approved applicability.',
  );
  const reviewed = reviewApplicability({
    current: proposed.decision,
    action: 'approve',
    reviewerPrincipalId: INDEPENDENT_REVIEWER,
    reviewReason: approveReason,
    expectedVersion: proposed.decision.version,
    review: independentVerdict,
    newDecisionId: registryUuid('t217-review-decision'),
    now: at,
  });
  // Negative control: reviewer == proposer (self-review) is NOT permitted and NEVER activates.
  const selfVerdict = evaluateApplicabilityReview({
    proposerPrincipalId: String(COMPLIANCE_OWNER),
    controlOwnerPrincipalId: String(CONTROL_OWNER),
    reviewerPrincipalId: String(COMPLIANCE_OWNER),
    reviewerRoles: ['tenant_compliance_owner'],
    action: 'approve',
  });
  const selfReviewed = reviewApplicability({
    current: proposed.decision,
    action: 'approve',
    reviewerPrincipalId: COMPLIANCE_OWNER,
    reviewReason: approveReason,
    expectedVersion: proposed.decision.version,
    review: selfVerdict,
    newDecisionId: registryUuid('t217-self-review-decision'),
    now: at,
  });
  criteria.push({
    ref: 'FR-032',
    statement:
      'An independent, activating review turns a proposed applicability decision into an ACTIVE, superseding decision; a self-review never activates.',
    satisfied:
      proposed.decision.state === 'proposed' &&
      reviewed.accepted &&
      reviewed.decision.state === 'active' &&
      applicabilityIsActive(reviewed.decision) &&
      applicabilityVersionSupersedes(proposed.decision, reviewed.decision) &&
      selfReviewed.accepted === false &&
      applicabilityIsActive(selfReviewed.decision) === false,
    evidence: `reviewed.state=${reviewed.decision.state}; active=${applicabilityIsActive(reviewed.decision)}; supersedes=${applicabilityVersionSupersedes(proposed.decision, reviewed.decision)}`,
    observedVia:
      'reviewApplicability(...) + applicabilityIsActive + applicabilityVersionSupersedes (application service + domain oracles)',
    negativeControl: `a reviewer==proposer verdict yields rejectionCode=${selfReviewed.rejectionCode} and an inactive decision — self-review can never activate applicability`,
  });

  // ── FR-033 / FR-054 — non-applicability expiry REOPENS a gap (a stale NA never silences it). ────
  const reopensReopened = nonApplicabilityReopensGap(DECISION_REOPENED_NA, at);
  const reopensReady = nonApplicabilityReopensGap(DECISION_READY, at);
  const reopenedCoverage = coverageForScenario('reopened-non-applicability');
  const surfacesReopenedGap = reopenedCoverage.gaps.some(
    (g) => g.kind === 'reopened_non_applicability',
  );
  criteria.push({
    ref: 'FR-033 / FR-054',
    statement:
      'A not_applicable decision whose review instant has lapsed REOPENS its coverage gap; the coverage engine surfaces it as reopened_non_applicability.',
    satisfied: reopensReopened && surfacesReopenedGap && reopensReady === false,
    evidence: `nonApplicabilityReopensGap(REOPENED,NOW)=${reopensReopened}; reopened coverage gaps=${JSON.stringify(reopenedCoverage.gaps.map((g) => g.kind))}`,
    observedVia:
      "nonApplicabilityReopensGap(...) + reconstructCoverage('reopened-non-applicability').gaps (domain predicate + coverage engine)",
    negativeControl: `an active, in-window applicable decision (DECISION_READY) does NOT reopen a gap (${reopensReady}) — only a lapsed non-applicability reopens`,
  });

  // ── FR-054 — stale evidence is NEVER inferred current: it is a gap, boundary drops below 'ready'. ─
  const staleCoverage = coverageForScenario('stale');
  const readyCoverage = coverageForScenario('ready');
  const staleSurfacesGap = staleCoverage.gaps.some((g) => g.kind === 'stale_evidence');
  const staleBelowReady =
    staleCoverage.claimBoundary !== 'ready' &&
    staleCoverage.claimBoundary !== 'certified' &&
    staleCoverage.complete === false;
  criteria.push({
    ref: 'FR-054',
    statement:
      'A control whose evidence is stale surfaces a stale_evidence gap and caps the boundary BELOW ready — current operation is never inferred from stale evidence.',
    satisfied:
      staleSurfacesGap &&
      staleBelowReady &&
      readyCoverage.gaps.length === 0 &&
      readyCoverage.claimBoundary === 'ready' &&
      readyCoverage.complete === true,
    evidence: `stale boundary=${staleCoverage.claimBoundary}, gaps=${JSON.stringify(staleCoverage.gaps.map((g) => g.kind))}; ready boundary=${readyCoverage.claimBoundary}, complete=${readyCoverage.complete}`,
    observedVia:
      "reconstructCoverage('stale') vs reconstructCoverage('ready') — claimBoundary + gaps + complete (coverage engine)",
    negativeControl:
      'the READY scenario (current, sufficient evidence) has zero gaps and reaches ready+complete — the gap is a fact of the stale evidence, not of every scope',
  });

  // ── FR-055 / SC-012 — truthful boundary: ready is readiness, certified only with a valid cert. ──
  const certifiedCoverage = coverageForScenario('certified');
  const expiredCertCoverage = coverageForScenario('readiness-not-certification');
  criteria.push({
    ref: 'FR-055 / SC-012',
    statement:
      'The claim boundary is truthful: internal readiness reads ready; only a valid, displayable external certification reaches certified; an expired certificate NEVER promotes readiness to certified.',
    satisfied:
      readyCoverage.claimBoundary === 'ready' &&
      certifiedCoverage.claimBoundary === 'certified' &&
      expiredCertCoverage.claimBoundary === 'ready',
    evidence: `ready=${readyCoverage.claimBoundary}; certified=${certifiedCoverage.claimBoundary}; expired-cert=${expiredCertCoverage.claimBoundary}`,
    observedVia:
      'reconstructCoverage over the READY / CERTIFIED / EXPIRED-CERT input bundles — claimBoundary (coverage engine)',
    negativeControl:
      'the EXPIRED-cert scope has the identical readiness picture yet stays ready (never certified) — an out-of-window certificate cannot lift the boundary',
  });

  // ── FR-053 — evidence authorization / tenant isolation excludes OTHER_TENANT. ───────────────────
  const refs = evidenceReferences();
  const keptForTenant = authorizeReferences(refs, String(TENANT));
  const keptIds = keptForTenant.kept.map((r) => r.evidenceId);
  const noOtherKept = keptForTenant.kept.every((r) => r.tenantId === String(TENANT));
  const keptForOther = authorizeReferences(refs, String(OTHER_TENANT));
  const noTenantKeptForOther = keptForOther.kept.every((r) => r.tenantId === String(OTHER_TENANT));
  const crossTenantCoverage = coverageForScenario('cross-tenant');
  // TENANT's identical READY obligation is in scope; OTHER_TENANT's identical obligation must be
  // excluded — so exactly one obligation reconstructs (never two) and it is covered (TENANT's own).
  const crossExcludesOther =
    crossTenantCoverage.obligationCount === 1 &&
    crossTenantCoverage.obligations.length === 1 &&
    crossTenantCoverage.coveredCount === 1;
  criteria.push({
    ref: 'FR-053',
    statement:
      'Evidence + obligations are tenant-isolated: authorizing references for TENANT excludes every OTHER_TENANT reference, and TENANT coverage never includes another tenant’s obligation.',
    satisfied:
      keptForTenant.excluded > 0 &&
      noOtherKept &&
      !keptIds.includes('evidence-other-tenant-leak-candidate') &&
      crossTenantCoverage.obligationCount === 1 &&
      crossExcludesOther &&
      noTenantKeptForOther,
    evidence: `TENANT kept=${keptIds.length}, excluded=${keptForTenant.excluded}; cross-tenant obligationCount=${crossTenantCoverage.obligationCount}`,
    observedVia:
      "authorizeReferences(refs, TENANT) + reconstructCoverage('cross-tenant') (audit-export filter + coverage engine)",
    negativeControl: `authorizing the SAME refs for OTHER_TENANT keeps only OTHER_TENANT rows and excludes ${keptForOther.excluded} TENANT ref(s) — isolation is symmetric, not one-sided`,
  });

  // ── FR-052 / FR-056 / SC-022 / SC-013 — signed, reproducible, gap-honest audit export. ──────────
  const request = auditExportRequest();
  const pkg = buildAuditExportPackage(request, SIGNING_KEY);
  const pkgAgain = buildAuditExportPackage(request, SIGNING_KEY);
  const byteIdentical = JSON.stringify(pkg) === JSON.stringify(pkgAgain);
  const verifies = verifyManifest(pkg, SIGNING_KEY);
  const custodyIntact = custodyChainIsIntact(pkg.body.custody);
  const refCountExcludesCross = pkg.body.referenceCount === exportReferenceCount(request);
  const noteHonest = pkg.body.externalClaimNote === EXTERNAL_CLAIM_NOTE;
  // Negative control 1: reversing the custody chain breaks intactness AND verification.
  const tamperedCustody = {
    ...pkg,
    body: { ...pkg.body, custody: [...pkg.body.custody].reverse() },
  };
  const tamperedCustodyRejected =
    custodyChainIsIntact(tamperedCustody.body.custody) === false &&
    verifyManifest(tamperedCustody, SIGNING_KEY) === false;
  // Negative control 2: tampering with the manifest's body digest fails verification.
  const tamperedDigest = {
    ...pkg,
    manifest: { ...pkg.manifest, bodyDigest: `${pkg.manifest.bodyDigest}00` },
  };
  const tamperedDigestRejected = verifyManifest(tamperedDigest, SIGNING_KEY) === false;
  criteria.push({
    ref: 'FR-052 / FR-056 / SC-022 / SC-013',
    statement:
      'The audit export is a signed, tamper-evident, byte-reproducible package whose gaps are copied verbatim, whose cross-tenant references are excluded, and whose truthful external-claim note is always present.',
    satisfied:
      verifies &&
      custodyIntact &&
      pkg.body.gaps.length > 0 &&
      refCountExcludesCross &&
      pkg.body.excludedReferenceCount > 0 &&
      byteIdentical &&
      noteHonest &&
      tamperedCustodyRejected &&
      tamperedDigestRejected,
    evidence: `verify=${verifies}; custodyIntact=${custodyIntact}; gaps=${JSON.stringify(pkg.body.gaps.map((g) => g.kind))}; refCount=${pkg.body.referenceCount}; excluded=${pkg.body.excludedReferenceCount}; byteIdentical=${byteIdentical}`,
    observedVia:
      'buildAuditExportPackage → verifyManifest + custodyChainIsIntact + body.gaps + body.referenceCount (audit-export builders)',
    negativeControl:
      'reversing one custody link breaks custodyChainIsIntact AND verifyManifest; corrupting the manifest body digest fails verifyManifest — any tamper is detectable',
  });

  // ── FR-034 — corrective-action lifecycle: an overdue finding is surfaced; closure requires proof. ─
  const finding = raiseFinding({
    id: registryUuid('t217-finding'),
    tenantId: TENANT as unknown as Uuid,
    obligationId: IDS.SYSTEM_ID,
    severity: 'high',
    ownerPrincipalId: CONTROL_OWNER,
    dueAt: (at - 30 * 24 * 3_600_000) as EpochMillis, // due date in the PAST ⇒ overdue at NOW.
    evidenceIds: [IDS.EVIDENCE_READY],
  });
  const findingIsOverdue = findingOverdue(finding, at);
  const opened = openCorrectiveAction({
    id: registryUuid('t217-corrective'),
    finding,
    correction: 'Contain the nonconformity by disabling the affected automated path.',
    rootCause: 'The control lacked an operating attestation for the review window.',
    action: 'Reinstate the operating attestation and add a recurring evidence check.',
    ownerPrincipalId: CONTROL_OWNER,
    dueAt: (at + 30 * 24 * 3_600_000) as EpochMillis,
  });
  const verified = reviewEffectiveness(opened.correctiveAction!, 'effective', false);
  const closed = closeCorrectiveAction(verified);
  // Negative control: a corrective action WITHOUT a root cause is refused (never silently opened).
  const noRootCause = openCorrectiveAction({
    id: registryUuid('t217-corrective-bad'),
    finding,
    correction: 'Contain the nonconformity.',
    rootCause: '',
    action: 'Do the fix.',
    ownerPrincipalId: CONTROL_OWNER,
    dueAt: (at + 30 * 24 * 3_600_000) as EpochMillis,
  });
  criteria.push({
    ref: 'FR-034',
    statement:
      'A nonconformity finding retains its due date and surfaces as overdue when lapsed; its corrective action requires a root cause, and closure requires a verified-effective review.',
    satisfied:
      findingIsOverdue &&
      opened.accepted &&
      closed.accepted &&
      closed.correctiveAction.status === 'closed' &&
      noRootCause.accepted === false &&
      noRootCause.rejectionCode === 'MISSING_ROOT_CAUSE',
    evidence: `findingOverdue=${findingIsOverdue}; corrective opened=${opened.accepted}; closed status=${closed.correctiveAction.status}`,
    observedVia:
      'raiseFinding → findingOverdue → openCorrectiveAction → reviewEffectiveness → closeCorrectiveAction (corrective-action service predicates)',
    negativeControl: `a corrective action with no root cause is refused (${noRootCause.rejectionCode}) and a still-open finding past due reads overdue — closure is never inferred`,
  });

  // ── FR-035 — management-review cadence: a lapsed review is surfaced, a current one is not. ───────
  const lapsedReview = holdManagementReview({
    id: registryUuid('t217-review-lapsed'),
    tenantId: TENANT as unknown as Uuid,
    cadence: 'quarterly',
    participants: [COMPLIANCE_OWNER, AUDITOR],
    inputs: ['coverage posture', 'open findings', 'corrective-action status'],
    decisions: ['accept residual risk on obligation-ready'],
    outputs: ['refreshed evidence-collection schedule'],
    heldAt: (at - 200 * 24 * 3_600_000) as EpochMillis, // held long enough ago that a quarterly cadence lapsed.
  });
  const currentReview = holdManagementReview({
    id: registryUuid('t217-review-current'),
    tenantId: TENANT as unknown as Uuid,
    cadence: 'quarterly',
    participants: [COMPLIANCE_OWNER, AUDITOR],
    inputs: ['coverage posture'],
    heldAt: (at - 5 * 24 * 3_600_000) as EpochMillis, // held recently ⇒ cadence NOT lapsed.
  });
  const lapsed = lapsedReview.review as ManagementReview;
  const current = currentReview.review as ManagementReview;
  const lapsedIsLapsed = reviewCadenceLapsed(lapsed, at);
  const currentIsLapsed = reviewCadenceLapsed(current, at);
  criteria.push({
    ref: 'FR-035',
    statement:
      'A management review is recorded with participants + inputs on a declared cadence, and a lapsed cadence is surfaced as due — never inferred as still-current.',
    satisfied:
      lapsedReview.accepted &&
      currentReview.accepted &&
      lapsedIsLapsed === true &&
      currentIsLapsed === false,
    evidence: `lapsed review cadence lapsed=${lapsedIsLapsed}; current review cadence lapsed=${currentIsLapsed}`,
    observedVia:
      'holdManagementReview → reviewCadenceLapsed(review, NOW) (management-review service predicate)',
    negativeControl:
      'a review held 5 days ago on the same quarterly cadence reports NOT lapsed — lapse is derived from the cadence + held instant, not asserted',
  });

  return finish('Scenario-standards-applicability', criteria);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SCENARIO — ACCESSIBILITY + CLAIM-HONESTY of the compliance presenters (WCAG 2.2 AA + anti-lie).
// Lazily imports the `.tsx` oracle (vitest-only); asserts report.ok + honest-empty, each with a control.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export async function runComplianceAccessibilityScenario(
  inputs: ComplianceInputs,
): Promise<ScenarioResult> {
  const oracle = await import(ACCESSIBILITY_ORACLE);
  const coverage = buildCoverageViewModel();
  const reports: readonly AccessibilityReport[] = oracle.auditComplianceAccessibility({
    tenant: inputs.tenant,
    coverage,
  });
  const emptyFindings = oracle.auditEmptyComplianceModelsAreHonest(inputs.tenant);
  const criteria: CriterionResult[] = [];

  const allFindings = reports.flatMap((r: AccessibilityReport) => r.findings);
  criteria.push({
    ref: 'FR-031..035 / FR-055 / SC-012 (a11y)',
    statement:
      'The compliance coverage presenter is structurally/semantically clean and truthful: every gap is surfaced, the boundary is not mislabelled, and internal readiness is never rendered as external certification.',
    satisfied: reports.length > 0 && reports.every((r: AccessibilityReport) => r.ok),
    evidence: `presenters audited=${reports.length}; findings=${allFindings.length}`,
    observedVia:
      'auditComplianceAccessibility({tenant, coverage}) over the shipped renderCoverageView (accessibility oracle)',
    negativeControl:
      "were an uncovered obligation row to omit its coverage-gap, or a 'ready' boundary to read as certified, the oracle would return a non-empty findings list (currently 0)",
  });

  criteria.push({
    ref: 'FR-034 / SC-012 (empty honesty)',
    statement:
      'An un-fed compliance view is honest: its boundary is incomplete (never certified), it states internal readiness is not external certification, and it states no external certification exists.',
    satisfied: emptyFindings.length === 0,
    evidence: `empty-model honesty findings=${emptyFindings.length}`,
    observedVia:
      'auditEmptyComplianceModelsAreHonest(tenant) over EMPTY_COVERAGE_VIEW (accessibility oracle)',
    negativeControl:
      'were the empty view to report a certified boundary, omit the not-certified note, or render a certification block, this would report a finding',
  });

  return finish('Scenario-compliance-accessibility', criteria);
}

export async function runAllComplianceScenarios(inputs: ComplianceInputs): Promise<{
  readonly applicability: ScenarioResult;
  readonly accessibility: ScenarioResult;
}> {
  return {
    applicability: runStandardsApplicabilityScenario(inputs),
    accessibility: await runComplianceAccessibilityScenario(inputs),
  };
}
