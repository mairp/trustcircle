// @trustcircle/application — MATERIAL-CHANGE INVALIDATION (Phase 4 / User Story 2 / FR-012, AC4).
//
// A decision is only meaningful against the package it was reviewed over. If the world moves under
// an OPEN decision — the scope widens, the evidence is superseded, a control/policy version rolls,
// a requirement is added, the business impact changes — then any approval already granted, or any
// approval about to be granted against the version the approver last saw, is STALE. Letting it
// stand would be a bypass ("a consequential action slipped through on an out-of-date package").
//
// This module is the invalidation oracle. It never guesses: it compares the DIGEST of the package
// the approver acted against (bound onto the decision record at effect time) with the CURRENT
// package digest. A mismatch is a material change. The oracle is content-addressed, so it is exact
// and deterministic — the same two packages always produce the same verdict, with no wall clock.
//
// On a detected material change to an OPEN package, the package is transitioned to `invalidated`
// with a mandatory reason + instant (the migration's decision_request_invalidation_paired CHECK),
// its in-flight approvals are void (they bound to the superseded digest), and it must be re-issued
// and re-reviewed. Terminal packages are never invalidated (the decision already took effect and is
// itself the durable record). Determinism: the invalidation instant is injected.

import {
  decisionPackageDigest,
  isTerminalDecisionStatus,
  makeDecisionPackage,
  type DecisionPackage,
  type DecisionRecord,
} from '@trustcircle/domain';
import { type EpochMillis } from '@trustcircle/domain';

export type InvalidationTrigger =
  | 'scope_changed'
  | 'evidence_superseded'
  | 'policy_revision_changed'
  | 'control_version_changed'
  | 'requirements_changed'
  | 'business_impact_changed'
  | 'risk_reassessed'
  | 'digest_mismatch';

export interface MaterialChangeVerdict {
  /** True iff `current` differs materially from `reviewed` (their digests diverge). */
  readonly changed: boolean;
  /** The specific facet(s) that diverged (best-effort classification for the audit reason). */
  readonly triggers: readonly InvalidationTrigger[];
  readonly reviewedDigest: string;
  readonly currentDigest: string;
}

/**
 * Detect whether the CURRENT package differs materially from the package as REVIEWED (the version an
 * approver saw / a record bound to). The authoritative signal is the digest mismatch; the per-facet
 * triggers are a classification for the human-readable invalidation reason, computed only when the
 * digests actually diverge (so a matching pair reports no triggers).
 */
export function detectMaterialChange(
  reviewed: DecisionPackage,
  current: DecisionPackage,
): MaterialChangeVerdict {
  const reviewedDigest = decisionPackageDigest(reviewed);
  const currentDigest = decisionPackageDigest(current);
  if (reviewedDigest === currentDigest) {
    return { changed: false, triggers: [], reviewedDigest, currentDigest };
  }
  const triggers: InvalidationTrigger[] = [];
  if (JSON.stringify(reviewed.scope) !== JSON.stringify(current.scope)) {
    triggers.push('scope_changed');
  }
  if ((reviewed.evidenceManifestId ?? null) !== (current.evidenceManifestId ?? null)) {
    triggers.push('evidence_superseded');
  }
  if ((reviewed.policyRevision ?? null) !== (current.policyRevision ?? null)) {
    triggers.push('policy_revision_changed');
  }
  if ((reviewed.controlVersion ?? null) !== (current.controlVersion ?? null)) {
    triggers.push('control_version_changed');
  }
  if (
    JSON.stringify(reviewed.requirements.map((r) => [r.id, r.status, r.gateType])) !==
    JSON.stringify(current.requirements.map((r) => [r.id, r.status, r.gateType]))
  ) {
    triggers.push('requirements_changed');
  }
  if (JSON.stringify(reviewed.businessImpact) !== JSON.stringify(current.businessImpact)) {
    triggers.push('business_impact_changed');
  }
  if (reviewed.riskTier !== current.riskTier) triggers.push('risk_reassessed');
  if (triggers.length === 0) triggers.push('digest_mismatch');
  return { changed: true, triggers, reviewedDigest, currentDigest };
}

/**
 * True iff an already-recorded ACCEPTED decision is stale against the current package — i.e. the
 * record bound to a digest that no longer matches the live package. Rejected records never "bind"
 * an effect, so they cannot go stale in this sense.
 */
export function decisionRecordIsStale(record: DecisionRecord, current: DecisionPackage): boolean {
  if (record.status !== 'accepted') return false;
  return record.packageDigest !== decisionPackageDigest(current);
}

export interface InvalidationResult {
  /** The invalidated package (status `invalidated`, reason + instant paired), or the input unchanged. */
  readonly package: DecisionPackage;
  readonly invalidated: boolean;
  readonly verdict: MaterialChangeVerdict;
}

/**
 * Invalidate an OPEN package if it changed materially from the reviewed version. Terminal packages
 * are never invalidated (the decision already stands as the durable record). On invalidation the
 * package advances to `invalidated` with a mandatory, paired reason + instant, and its version is
 * bumped so any in-flight approval bound to the old version is rejected as STALE_VERSION by the
 * decision-service. Determinism: `now` is injected.
 */
export function invalidateOnMaterialChange(
  reviewed: DecisionPackage,
  current: DecisionPackage,
  now: EpochMillis,
): InvalidationResult {
  const verdict = detectMaterialChange(reviewed, current);
  if (!verdict.changed || isTerminalDecisionStatus(current.status) || current.status === 'invalidated') {
    return { package: current, invalidated: false, verdict };
  }
  const reason = `material change detected: ${verdict.triggers.join(', ')}`;
  const invalidated = makeDecisionPackage({
    id: current.id,
    tenantId: current.tenantId,
    workItemId: current.workItemId,
    requesterPrincipalId: current.requesterPrincipalId,
    requestedAction: current.requestedAction,
    actionClass: current.actionClass,
    riskTier: current.riskTier,
    scope: { ...current.scope },
    businessImpact: { ...current.businessImpact },
    risks: current.risks.map((r) => ({ ...r })),
    alternatives: current.alternatives.map((a) => ({ ...a })),
    expectedResult: { ...current.expectedResult },
    ...(current.evidenceManifestId ? { evidenceManifestId: current.evidenceManifestId } : {}),
    ...(current.simulationId ? { simulationId: current.simulationId } : {}),
    ...(current.policyRevision ? { policyRevision: current.policyRevision } : {}),
    ...(current.controlVersion ? { controlVersion: current.controlVersion } : {}),
    affectedTenantIds: [...current.affectedTenantIds],
    requirements: [...current.requirements],
    status: 'invalidated',
    version: current.version + 1,
    invalidationReason: reason,
    invalidatedAt: now,
    createdAt: current.createdAt,
    expiresAt: current.expiresAt,
  });
  return { package: invalidated, invalidated: true, verdict };
}
