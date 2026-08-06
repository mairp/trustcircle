// @trustcircle/adapter-wiggum — Wiggum governance mapping (task T265 / US6).
//
// Distinguishes Wiggum CRITIC VERDICTS and GATE MARKERS from HUMAN APPROVAL, binds nonce/spec
// hashes, preserves stale evidence, and maps VerificationPlan evidence. PURE: no I/O, no wall
// clock (`at` is injected where a timestamp is recorded), no randomness, Node built-in `crypto`
// only.
//
// LOAD-BEARING INVARIANT (CONNECTOR NEVER HOLDS GOVERNANCE AUTHORITY):
//   * A Wiggum critic verdict is NEVER human approval. It is mapped as EVIDENCE, bound to its
//     nonce/spec hash, and preserved — `humanApprovalSatisfied` is never set true by a verdict.
//   * A GATE MARKER never equals approval. A marked/closed gate is evidence that a machine gate
//     was reached; it never opens a governance gate on its own.
//   * Evidence is BOUND to the nonce/spec hash it was produced against. When the observed hash no
//     longer matches the current pinned hash, the evidence is STALE: it is PRESERVED (never
//     dropped) but flagged stale and REJECTED as current authority.

import { createHash } from 'node:crypto';
import type { BundleIdentity } from './snapshot.ts';

// ---------------------------------------------------------------------------
// Nonce / spec-hash binding.
// ---------------------------------------------------------------------------

/** The nonce + spec hash a piece of Wiggum evidence is bound to. */
export interface EvidenceBinding {
  readonly nonce: string;
  readonly specHash: string;
}

function bindingKey(binding: EvidenceBinding): string {
  return `${binding.nonce} ${binding.specHash}`;
}

/** Deterministic binding hash — used to compare observed evidence to the current pinned binding. */
export function bindingHash(binding: EvidenceBinding): string {
  return createHash('sha256').update(bindingKey(binding), 'utf8').digest('hex');
}

/** True iff two bindings are identical (nonce AND spec hash). */
export function bindingMatches(a: EvidenceBinding, b: EvidenceBinding): boolean {
  return a.nonce === b.nonce && a.specHash === b.specHash;
}

// ---------------------------------------------------------------------------
// Raw Wiggum evidence kinds.
// ---------------------------------------------------------------------------

export type WiggumEvidenceKind = 'critic_verdict' | 'gate_marker' | 'human_approval';

export type WiggumCriticVerdict = 'pass' | 'fail' | 'inconclusive';

export type WiggumGateMarkerState = 'open_requested' | 'marked' | 'closed';

/**
 * A raw Wiggum governance-relevant observation. `humanPrincipalId` is non-null ONLY for a genuine
 * human approval act; a critic verdict or gate marker always carries a null principal.
 */
export interface WiggumGovernanceObservation {
  readonly kind: WiggumEvidenceKind;
  readonly featureId: string;
  readonly identity: BundleIdentity;
  readonly binding: EvidenceBinding;
  /** Present for critic_verdict. */
  readonly criticVerdict?: WiggumCriticVerdict;
  /** Present for gate_marker. */
  readonly gateMarkerState?: WiggumGateMarkerState;
  /** Non-null only for a human approval act. */
  readonly humanPrincipalId: string | null;
  /** Source integrity anchor over the raw payload; preserved for chain of custody. */
  readonly sourceContentHash: string;
}

// ---------------------------------------------------------------------------
// Mapped governance evidence.
// ---------------------------------------------------------------------------

export type EvidenceAuthority =
  /** A critic verdict or gate marker: evidence only, never human approval. */
  | 'machine_evidence'
  /** A human approval act bound to a current nonce/spec. */
  | 'human_approval'
  /** Evidence whose binding no longer matches the current pinned one — preserved, rejected. */
  | 'stale_rejected';

export interface MappedGovernanceEvidence {
  readonly kind: WiggumEvidenceKind;
  readonly featureId: string;
  readonly identity: BundleIdentity;
  readonly binding: EvidenceBinding;
  readonly bindingHash: string;
  readonly authority: EvidenceAuthority;
  /** True ONLY for a current (non-stale) human approval act. Verdicts/markers never set this. */
  readonly humanApprovalSatisfied: boolean;
  /** True when bound to a nonce/spec that no longer matches the current pinned one. */
  readonly stale: boolean;
  readonly criticVerdict: WiggumCriticVerdict | null;
  readonly gateMarkerState: WiggumGateMarkerState | null;
  /** Preserved for audit even when stale/rejected (never dropped). */
  readonly sourceContentHash: string;
  readonly rationale: string;
}

/**
 * Map a single raw Wiggum governance observation against the CURRENT pinned binding.
 *
 * - `critic_verdict` and `gate_marker` → `machine_evidence`; never human approval.
 * - `human_approval` with a matching binding and a human principal → `human_approval`.
 * - Any observation whose binding no longer matches the current pinned binding → `stale_rejected`
 *   (preserved as evidence, flagged stale).
 */
export function mapGovernanceEvidence(
  observation: WiggumGovernanceObservation,
  currentBinding: EvidenceBinding,
): MappedGovernanceEvidence {
  const stale = !bindingMatches(observation.binding, currentBinding);

  let authority: EvidenceAuthority;
  let humanApprovalSatisfied = false;
  let rationale: string;

  if (stale) {
    authority = 'stale_rejected';
    rationale =
      `Evidence bound to nonce/spec ${bindingHash(observation.binding)} no longer matches the ` +
      `current pinned binding ${bindingHash(currentBinding)}; preserved as evidence, rejected as ` +
      'current authority.';
  } else if (observation.kind === 'human_approval' && observation.humanPrincipalId !== null) {
    authority = 'human_approval';
    humanApprovalSatisfied = true;
    rationale = `Human approver ${observation.humanPrincipalId} approval bound to the current nonce/spec.`;
  } else if (observation.kind === 'gate_marker') {
    authority = 'machine_evidence';
    rationale =
      'A Wiggum gate marker is machine evidence that a gate was reached; it never equals human approval.';
  } else if (observation.kind === 'critic_verdict') {
    authority = 'machine_evidence';
    rationale =
      'A Wiggum critic verdict is machine evidence and never constitutes human approval.';
  } else {
    // human_approval kind without a human principal is not a human approval act.
    authority = 'machine_evidence';
    rationale =
      'Human-approval record carries no human principal; treated as evidence, not human approval.';
  }

  return Object.freeze({
    kind: observation.kind,
    featureId: observation.featureId,
    identity: Object.freeze({ ...observation.identity }),
    binding: Object.freeze({ ...observation.binding }),
    bindingHash: bindingHash(observation.binding),
    authority,
    humanApprovalSatisfied,
    stale,
    criticVerdict: observation.criticVerdict ?? null,
    gateMarkerState: observation.gateMarkerState ?? null,
    sourceContentHash: observation.sourceContentHash,
    rationale,
  });
}

// ---------------------------------------------------------------------------
// VerificationPlan evidence mapping.
// ---------------------------------------------------------------------------

/** A single verification obligation within a Wiggum VerificationPlan. */
export interface VerificationObligation {
  readonly obligationId: string;
  readonly description: string;
  /** The critic verdict recorded against this obligation, if any. */
  readonly criticVerdict: WiggumCriticVerdict | null;
  /** The binding the obligation's evidence was produced against. */
  readonly binding: EvidenceBinding;
  readonly sourceContentHash: string;
}

export interface VerificationPlanObservation {
  readonly planId: string;
  readonly featureId: string;
  readonly identity: BundleIdentity;
  readonly obligations: readonly VerificationObligation[];
}

export interface MappedObligation {
  readonly obligationId: string;
  readonly description: string;
  readonly criticVerdict: WiggumCriticVerdict | null;
  readonly binding: EvidenceBinding;
  readonly bindingHash: string;
  readonly stale: boolean;
  readonly sourceContentHash: string;
}

export interface MappedVerificationPlan {
  readonly planId: string;
  readonly featureId: string;
  readonly identity: BundleIdentity;
  readonly obligations: readonly MappedObligation[];
  /**
   * True when every obligation carries a current (non-stale) passing critic verdict. This is
   * MACHINE evidence of verification completeness — it is NEVER human approval and never opens a
   * governance gate on its own.
   */
  readonly allObligationsPassed: boolean;
  /** Obligations whose evidence is stale (hash-mismatched) — preserved but flagged. */
  readonly staleObligations: readonly MappedObligation[];
  readonly planDigest: string;
  readonly authorityNote: string;
}

const PLAN_AUTHORITY_NOTE =
  'A completed Wiggum VerificationPlan is MACHINE evidence of verification; it confers no ' +
  'governance authority and is never a substitute for a human approval decision.';

/**
 * Map a Wiggum VerificationPlan into governance evidence against the current pinned binding.
 * `allObligationsPassed` summarizes machine verification completeness only; it never implies
 * human approval. Stale obligations are preserved and flagged.
 */
export function mapVerificationPlan(
  plan: VerificationPlanObservation,
  currentBinding: EvidenceBinding,
): MappedVerificationPlan {
  const obligations: MappedObligation[] = plan.obligations.map((o) =>
    Object.freeze({
      obligationId: o.obligationId,
      description: o.description,
      criticVerdict: o.criticVerdict,
      binding: Object.freeze({ ...o.binding }),
      bindingHash: bindingHash(o.binding),
      stale: !bindingMatches(o.binding, currentBinding),
      sourceContentHash: o.sourceContentHash,
    }),
  );

  const staleObligations = obligations.filter((o) => o.stale);
  const allObligationsPassed =
    obligations.length > 0 &&
    obligations.every((o) => !o.stale && o.criticVerdict === 'pass');

  const sorted = [...obligations].sort((a, b) =>
    a.obligationId < b.obligationId ? -1 : a.obligationId > b.obligationId ? 1 : 0,
  );

  const planDigest = contentDigest({
    planId: plan.planId,
    featureId: plan.featureId,
    identity: plan.identity,
    obligations: sorted,
    allObligationsPassed,
  });

  return Object.freeze({
    planId: plan.planId,
    featureId: plan.featureId,
    identity: Object.freeze({ ...plan.identity }),
    obligations: Object.freeze(sorted),
    allObligationsPassed,
    staleObligations: Object.freeze(staleObligations),
    planDigest,
    authorityNote: PLAN_AUTHORITY_NOTE,
  });
}

// ---------------------------------------------------------------------------
// Local canonicalization + digest.
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
