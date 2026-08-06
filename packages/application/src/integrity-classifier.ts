// @trustcircle/application — INTEGRITY CLASSIFIER: severity, confidence, safety/business impact,
// scope, dependencies, evidence status, and ownership gaps (Phase 5 / User Story 3 / FR-018).
//
// The classifier turns a raw detection (a matched rule version + the offending source record + the
// ALREADY-PRESERVED original evidence) into a durable `IntegrityCase` value. It is a pure function
// over injected facts — it does NOT preserve the original (that already happened; FR-017 is enforced
// upstream by requiring `originalEvidenceId`), does NOT touch the wall clock, and grants no
// authority. Its job is to synthesise the case's classification fields honestly:
//
//   * problemClass / combined — a single rule yields its class; multiple concurrent matches on the
//     same work item collapse to `combined` with every constituent class retained.
//   * confidence — carried from the detection, clamped to [0,1]; a low-confidence match is a
//     `suspected` disposition, never dropped (a suspected/false-positive finding is retained).
//   * safety/business impact + affected scope + dependents — carried from the detection context.
//   * evidence status — `tampered`/`unverifiable` originals are surfaced (they force escalation
//     downstream), never hidden.
//   * ownership gap — when no owner can be resolved, the case is an EXPLICIT `ownershipGap` with a
//     null owner. The classifier never fabricates an owner to make the gap disappear.
//
// The output is exactly one `IntegrityCase` per detection group; the case value's own invariants
// (preservation-precedes-classification, ownership-gap pairing) are enforced by the domain factory.

import { type Uuid, type EpochMillis, type TenantId } from '@trustcircle/domain';
import {
  makeIntegrityCase,
  type IntegrityCase,
  type ProblemClass,
  type Severity,
  type CaseDisposition,
  type SafetyImpact,
  type EvidenceStatus,
} from '@trustcircle/domain';

/** One matched rule against one source record, with its preserved original already committed. */
export interface DetectionMatch {
  readonly workItemId: Uuid;
  readonly ruleVersionId: Uuid;
  readonly sourceRecordId: Uuid;
  /** FR-017: the preserved original MUST already exist before classification. */
  readonly originalEvidenceId: Uuid;
  readonly problemClass: ProblemClass;
  readonly severity: Severity;
  readonly confidence: number;
  readonly safetyImpact?: SafetyImpact;
  readonly evidenceStatus?: EvidenceStatus;
  readonly businessImpact?: Record<string, unknown>;
  readonly affectedScope?: Record<string, unknown>;
  readonly dependentWorkIds?: readonly Uuid[];
  readonly sourceRef?: Record<string, unknown>;
  /** Resolved owner, or null when no owner can be determined (an explicit ownership gap). */
  readonly ownerPrincipalId?: Uuid | null;
}

export interface ClassifyCommand {
  readonly caseId: Uuid;
  readonly tenantId: TenantId;
  /** All matches for the SAME work item + source record group (≥1). */
  readonly matches: readonly DetectionMatch[];
  /** Confidence at/below which a match is `suspected` rather than `confirmed`. */
  readonly suspectedBelow?: number;
  readonly now: EpochMillis;
}

/** The disposition threshold below which a detection is treated as suspected (retained, reviewed). */
const DEFAULT_SUSPECTED_BELOW = 0.5;

function maxSeverity(a: Severity, b: Severity): Severity {
  const order: readonly Severity[] = ['low', 'medium', 'high', 'critical'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function maxSafety(a: SafetyImpact, b: SafetyImpact): SafetyImpact {
  const order: readonly SafetyImpact[] = ['none', 'low', 'moderate', 'high', 'catastrophic'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** Worst-case evidence status: tampered > unverifiable > partial > preserved. */
function worstEvidence(a: EvidenceStatus, b: EvidenceStatus): EvidenceStatus {
  const order: readonly EvidenceStatus[] = ['preserved', 'partial', 'unverifiable', 'tampered'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/**
 * Classify a detection group into a single `IntegrityCase`. When the group carries more than one
 * distinct problem class, the case is `combined` and every constituent class is retained. Impact,
 * severity, evidence status, and dependents are folded to their worst-case / union across the group.
 */
export function classifyIntegrityCase(cmd: ClassifyCommand): IntegrityCase {
  if (cmd.matches.length === 0) {
    throw new TypeError('classifyIntegrityCase requires ≥ 1 detection match');
  }
  const first = cmd.matches[0]!;
  const suspectedBelow = cmd.suspectedBelow ?? DEFAULT_SUSPECTED_BELOW;

  // Fold across the group.
  const classSet = new Set<ProblemClass>();
  let severity: Severity = 'low';
  let safety: SafetyImpact = 'none';
  let evidence: EvidenceStatus = 'preserved';
  let confidence = 0;
  const deps = new Set<Uuid>();
  let businessImpact: Record<string, unknown> = {};
  let affectedScope: Record<string, unknown> = {};
  let sourceRef: Record<string, unknown> = {};

  for (const m of cmd.matches) {
    classSet.add(m.problemClass);
    severity = maxSeverity(severity, m.severity);
    safety = maxSafety(safety, m.safetyImpact ?? 'none');
    evidence = worstEvidence(evidence, m.evidenceStatus ?? 'preserved');
    confidence = Math.max(confidence, Math.min(1, Math.max(0, m.confidence)));
    for (const d of m.dependentWorkIds ?? []) deps.add(d);
    if (m.businessImpact) businessImpact = { ...businessImpact, ...m.businessImpact };
    if (m.affectedScope) affectedScope = { ...affectedScope, ...m.affectedScope };
    if (m.sourceRef) sourceRef = { ...sourceRef, ...m.sourceRef };
  }

  const constituents = [...classSet];
  const problemClass: ProblemClass = constituents.length > 1 ? 'combined' : constituents[0]!;
  const problemClasses: readonly ProblemClass[] =
    problemClass === 'combined' ? [...constituents, 'combined'] : constituents;

  const disposition: CaseDisposition = confidence < suspectedBelow ? 'suspected' : 'confirmed';

  // Ownership: use the resolved owner if any match carries one; otherwise an EXPLICIT gap.
  let owner: Uuid | null = null;
  for (const m of cmd.matches) {
    if (m.ownerPrincipalId != null) {
      owner = m.ownerPrincipalId;
      break;
    }
  }
  const ownershipGap = owner === null;

  return makeIntegrityCase({
    id: cmd.caseId,
    tenantId: cmd.tenantId,
    workItemId: first.workItemId,
    ruleVersionId: first.ruleVersionId,
    sourceRecordId: first.sourceRecordId,
    originalEvidenceId: first.originalEvidenceId,
    problemClass,
    problemClasses,
    severity,
    confidence,
    disposition,
    safetyImpact: safety,
    businessImpact,
    affectedScope,
    dependentWorkIds: [...deps],
    evidenceStatus: evidence,
    sourceRef,
    ownerPrincipalId: owner,
    ownershipGap,
    state: 'classified',
    version: 1,
    detectedAt: cmd.now,
    updatedAt: cmd.now,
  });
}
