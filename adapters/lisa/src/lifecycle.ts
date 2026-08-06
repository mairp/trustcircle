// @trustcircle/adapter-lisa — LISA lifecycle guards (task T262 / US6).
//
// LISA is an ON-DEMAND, intentionally-inactive-by-default component. This module handles its
// intentionally-inactive state, activation PREFLIGHT, crash recovery, backlog reconciliation, and
// safe return to service. PURE guarded functions: no I/O, no wall clock (`at` is injected on every
// call), no randomness, Node built-in `crypto` only.
//
// LOAD-BEARING INVARIANT (NOTHING RESUMES UNPROVEN):
//   * Being inactive is EXPECTED, never a fault. `assessInactivity` never raises an alarm for a
//     component that is intentionally inactive.
//   * `activationPreflight` PROVES identity, contract compatibility, authority posture, and a
//     reconciled backlog BEFORE activation. Any unmet proof ⇒ activation is refused (fail-visible).
//   * Crash recovery reconciles the backlog first; a crashed component returns to service only
//     after its outstanding work is accounted for.
//   * A verdict/gate is never treated as human approval by any of these guards.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Inactivity assessment (intentionally-inactive is expected).
// ---------------------------------------------------------------------------

export type LisaActivationState = 'intentionally_inactive' | 'active' | 'crashed';

export interface InactivityInput {
  readonly deploymentId: string;
  readonly state: LisaActivationState;
  /** When the component last checkpointed (epoch ms), or null if never. */
  readonly lastCheckpointAt: number | null;
  /** Injected observation time (epoch ms). */
  readonly at: number;
}

export interface InactivityAssessment {
  readonly deploymentId: string;
  readonly state: LisaActivationState;
  /** True only for `crashed` — an intentionally-inactive component is never anomalous. */
  readonly anomalous: boolean;
  readonly idleMillis: number | null;
  readonly rationale: string;
}

/**
 * Assess an inactive/active/crashed LISA deployment. Intentional inactivity is expected and never
 * anomalous; only a crash is.
 */
export function assessInactivity(input: InactivityInput): InactivityAssessment {
  const idleMillis = input.lastCheckpointAt === null ? null : input.at - input.lastCheckpointAt;
  const anomalous = input.state === 'crashed';
  const rationale =
    input.state === 'intentionally_inactive'
      ? 'Deployment is intentionally inactive (on-demand); no action required.'
      : input.state === 'active'
        ? 'Deployment is active.'
        : 'Deployment is crashed; crash recovery and backlog reconciliation are required before resume.';
  return Object.freeze({
    deploymentId: input.deploymentId,
    state: input.state,
    anomalous,
    idleMillis,
    rationale,
  });
}

// ---------------------------------------------------------------------------
// Activation preflight (prove identity / contract / authority / backlog).
// ---------------------------------------------------------------------------

export interface DeploymentIdentity {
  readonly repositoryId: string;
  readonly deploymentId: string;
  readonly workspaceId: string;
}

/** A backlog item outstanding at activation time; must be reconciled before resume. */
export interface BacklogItem {
  readonly jobId: string;
  readonly externalId: string;
  readonly reconciled: boolean;
}

export interface ActivationPreflightInput {
  /** Identity the operator intends to activate. */
  readonly intendedIdentity: DeploymentIdentity;
  /** Identity the component actually reports. Must match `intendedIdentity`. */
  readonly observedIdentity: DeploymentIdentity;
  /** Whether the platform protocol negotiated within the manifest contract range. */
  readonly contractCompatible: boolean;
  /**
   * Whether the authority posture is intact: the caller has verified the adapter holds NO
   * governance authority (verdicts are evidence, humans approve).
   */
  readonly authorityPostureIntact: boolean;
  /** Outstanding backlog at activation. Every item must be reconciled to pass preflight. */
  readonly backlog: readonly BacklogItem[];
  /** Injected time (epoch ms). */
  readonly at: number;
}

export type PreflightFailure =
  | 'identity_mismatch'
  | 'contract_incompatible'
  | 'authority_posture_unproven'
  | 'backlog_unreconciled';

export interface ActivationPreflightResult {
  readonly deploymentId: string;
  readonly cleared: boolean;
  readonly failures: readonly PreflightFailure[];
  readonly unreconciledBacklog: readonly BacklogItem[];
  readonly at: number;
  /** Deterministic digest over the preflight decision — a durable evidence anchor. */
  readonly preflightDigest: string;
  readonly rationale: string;
}

function identityMatches(a: DeploymentIdentity, b: DeploymentIdentity): boolean {
  return (
    a.repositoryId === b.repositoryId &&
    a.deploymentId === b.deploymentId &&
    a.workspaceId === b.workspaceId
  );
}

/**
 * Prove identity, contract compatibility, authority posture, and a reconciled backlog BEFORE
 * activation. Activation is cleared only when EVERY proof holds; otherwise it is refused with the
 * specific unmet proofs (fail-visible). Nothing resumes unproven.
 */
export function activationPreflight(input: ActivationPreflightInput): ActivationPreflightResult {
  const failures: PreflightFailure[] = [];

  if (!identityMatches(input.intendedIdentity, input.observedIdentity)) {
    failures.push('identity_mismatch');
  }
  if (!input.contractCompatible) failures.push('contract_incompatible');
  if (!input.authorityPostureIntact) failures.push('authority_posture_unproven');

  const unreconciledBacklog = input.backlog.filter((b) => !b.reconciled);
  if (unreconciledBacklog.length > 0) failures.push('backlog_unreconciled');

  const cleared = failures.length === 0;
  const rationale = cleared
    ? 'Preflight cleared: identity, contract, authority posture, and backlog all proven.'
    : `Preflight refused: ${failures.join(', ')}. Activation is not permitted until resolved.`;

  const preflightDigest = contentDigest({
    intendedIdentity: input.intendedIdentity,
    observedIdentity: input.observedIdentity,
    contractCompatible: input.contractCompatible,
    authorityPostureIntact: input.authorityPostureIntact,
    unreconciledBacklog,
    cleared,
    failures,
    at: input.at,
  });

  return Object.freeze({
    deploymentId: input.intendedIdentity.deploymentId,
    cleared,
    failures: Object.freeze(failures),
    unreconciledBacklog: Object.freeze(unreconciledBacklog.map((b) => Object.freeze({ ...b }))),
    at: input.at,
    preflightDigest,
    rationale,
  });
}

// ---------------------------------------------------------------------------
// Crash recovery + backlog reconciliation.
// ---------------------------------------------------------------------------

/** An outstanding unit of work discovered during crash recovery. */
export interface OutstandingWork {
  readonly jobId: string;
  readonly externalId: string;
  /** Whether the unit's effect is accounted for (already applied or safely re-enqueued). */
  readonly accountedFor: boolean;
}

export interface CrashRecoveryInput {
  readonly deploymentId: string;
  readonly outstanding: readonly OutstandingWork[];
  readonly at: number;
}

export interface CrashRecoveryResult {
  readonly deploymentId: string;
  /** Work still unaccounted for after reconciliation; blocks safe return to service. */
  readonly unaccounted: readonly OutstandingWork[];
  /** Reconciled backlog items (accounted-for work) usable by activation preflight. */
  readonly reconciledBacklog: readonly BacklogItem[];
  /** True only when every outstanding unit is accounted for. */
  readonly backlogReconciled: boolean;
  readonly at: number;
  readonly recoveryDigest: string;
  readonly rationale: string;
}

/**
 * Reconcile a crashed deployment's outstanding work. Any unit not accounted for keeps the backlog
 * unreconciled — a crashed component returns to service only after its work is accounted for.
 */
export function reconcileCrashBacklog(input: CrashRecoveryInput): CrashRecoveryResult {
  const unaccounted = input.outstanding.filter((w) => !w.accountedFor);
  const backlogReconciled = unaccounted.length === 0;

  const reconciledBacklog: BacklogItem[] = input.outstanding.map((w) =>
    Object.freeze({ jobId: w.jobId, externalId: w.externalId, reconciled: w.accountedFor }),
  );

  const rationale = backlogReconciled
    ? 'All outstanding work accounted for; backlog reconciled.'
    : `${unaccounted.length} outstanding unit(s) unaccounted for; return to service blocked.`;

  const recoveryDigest = contentDigest({
    deploymentId: input.deploymentId,
    outstanding: input.outstanding,
    backlogReconciled,
    at: input.at,
  });

  return Object.freeze({
    deploymentId: input.deploymentId,
    unaccounted: Object.freeze(unaccounted.map((w) => Object.freeze({ ...w }))),
    reconciledBacklog: Object.freeze(reconciledBacklog),
    backlogReconciled,
    at: input.at,
    recoveryDigest,
    rationale,
  });
}

// ---------------------------------------------------------------------------
// Safe return to service (gated on a cleared preflight).
// ---------------------------------------------------------------------------

export interface SafeReturnInput {
  readonly preflight: ActivationPreflightResult;
  readonly at: number;
}

export interface SafeReturnDecision {
  readonly deploymentId: string;
  /** True only when the preflight cleared — nothing returns to service unproven. */
  readonly returnedToService: boolean;
  readonly at: number;
  readonly rationale: string;
}

/**
 * Decide whether the deployment may safely return to service. Gated entirely on a CLEARED
 * preflight; a refused preflight keeps the component out of service.
 */
export function safeReturnToService(input: SafeReturnInput): SafeReturnDecision {
  const returnedToService = input.preflight.cleared;
  const rationale = returnedToService
    ? 'Preflight cleared; deployment may safely return to service.'
    : `Preflight not cleared (${input.preflight.failures.join(', ')}); deployment stays out of service.`;
  return Object.freeze({
    deploymentId: input.preflight.deploymentId,
    returnedToService,
    at: input.at,
    rationale,
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
