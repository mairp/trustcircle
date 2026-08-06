// @trustcircle/application — ADAPTER ACTIVATION: validate an out-of-process adapter manifest before a
// controller version may bind it (Phase 6 / User Story 4 / FR-023, FR-024, GAR-005).
//
// A controller acts on a real source ONLY through an out-of-process ADAPTER. Before an adapter version
// may be activated (and thus bound by a controller instance), its manifest must pass a fail-closed
// battery of checks:
//
//   * signature — the manifest carries a valid signature over its canonical content digest (a
//     tampered manifest is refused);
//   * contract range — the adapter's declared protocol range must include the platform's required
//     protocol version (an out-of-range adapter cannot speak the protocol);
//   * capabilities — every capability the adapter advertises must be a governable operation kind, and
//     the LEAST-PRIVILEGE requirement holds: the adapter may not advertise a capability the bound
//     controller version does not declare (the adapter cannot grant authority the manifest withheld);
//   * conformance evidence — the adapter cites passing conformance-suite evidence;
//   * health — the adapter declares a health/readiness probe;
//   * failure semantics — the adapter declares its timeout + idempotency + retry semantics (so lost
//     acknowledgements are handled, not guessed);
//   * activation approval — activation requires an approval decision id.
//
// This is a pure decision function: manifest in, a structured verdict (activatable + the list of
// failed checks) out. It never mutates and never itself activates; the caller acts on the verdict.

import {
  type Uuid,
  type OperationKind,
  type ControllerVersion,
  OPERATION_KINDS,
  declaresCapability,
} from '@trustcircle/domain';

/** The protocol version the platform requires an adapter to speak. */
export const REQUIRED_ADAPTER_PROTOCOL = 1 as const;

export interface AdapterManifest {
  readonly adapterId: Uuid;
  readonly adapterVersionId: Uuid;
  readonly name: string;
  /** Inclusive protocol range the adapter can speak. */
  readonly protocolMin: number;
  readonly protocolMax: number;
  /** The operation kinds the adapter advertises it can dispatch. */
  readonly advertisedCapabilities: readonly OperationKind[];
  /** A signature over the manifest content digest. */
  readonly contentDigest: string;
  readonly signature: string;
  /** Handle to a passing conformance-suite evidence record. */
  readonly conformanceEvidenceId?: Uuid;
  readonly conformancePassed: boolean;
  /** True iff the adapter declares a health/readiness probe. */
  readonly declaresHealthProbe: boolean;
  /** True iff the adapter declares timeout + idempotency + retry (failure) semantics. */
  readonly declaresFailureSemantics: boolean;
  readonly requiresApprovalDecisionId?: Uuid;
}

export interface AdapterActivationInput {
  readonly manifest: AdapterManifest;
  /** The controller version that will bind this adapter — least-privilege reference surface. */
  readonly controllerVersion: ControllerVersion;
  /** A verifier that the signature matches the content digest (injected — no crypto policy here). */
  readonly verifySignature: (contentDigest: string, signature: string) => boolean;
  /** The approval decision authorizing activation (undefined ⇒ not approved). */
  readonly approvalDecisionId?: Uuid;
}

export interface AdapterActivationCheck {
  readonly check: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface AdapterActivationResult {
  readonly activatable: boolean;
  readonly checks: readonly AdapterActivationCheck[];
  readonly failed: readonly string[];
}

/**
 * Validate an adapter manifest for activation. Returns a NON-throwing structured verdict listing every
 * check and every failure, so the caller can surface ALL problems at once (fail-closed: any failed
 * check ⇒ not activatable).
 */
export function evaluateAdapterActivation(input: AdapterActivationInput): AdapterActivationResult {
  const { manifest, controllerVersion, verifySignature } = input;
  const checks: AdapterActivationCheck[] = [];
  const add = (check: string, passed: boolean, detail: string): void => {
    checks.push({ check, passed, detail });
  };

  // Signature over the content digest.
  const signatureOk = verifySignature(manifest.contentDigest, manifest.signature);
  add(
    'signature',
    signatureOk,
    signatureOk
      ? 'manifest signature verifies'
      : 'manifest signature does not verify (tampered or unsigned)',
  );

  // Contract range must include the required protocol.
  const rangeOk =
    Number.isInteger(manifest.protocolMin) &&
    Number.isInteger(manifest.protocolMax) &&
    manifest.protocolMin <= REQUIRED_ADAPTER_PROTOCOL &&
    manifest.protocolMax >= REQUIRED_ADAPTER_PROTOCOL;
  add(
    'contract-range',
    rangeOk,
    `required protocol ${REQUIRED_ADAPTER_PROTOCOL} within [${manifest.protocolMin},${manifest.protocolMax}]=${rangeOk}`,
  );

  // Capabilities must be governable operation kinds.
  const unknownKinds = manifest.advertisedCapabilities.filter((k) => !OPERATION_KINDS.includes(k));
  add(
    'capabilities-valid',
    unknownKinds.length === 0,
    unknownKinds.length === 0
      ? 'all advertised capabilities are governable operation kinds'
      : `unknown capabilities: ${unknownKinds.join(', ')}`,
  );

  // Least privilege: the adapter may not advertise a capability the controller manifest does not
  // declare — the adapter cannot grant authority the controller version withheld.
  const overreach = manifest.advertisedCapabilities.filter(
    (k) => !declaresCapability(controllerVersion, k),
  );
  add(
    'least-privilege',
    overreach.length === 0,
    overreach.length === 0
      ? 'adapter advertises only controller-declared capabilities'
      : `adapter overreaches controller manifest: ${overreach.join(', ')}`,
  );

  // Conformance evidence.
  const conformanceOk =
    manifest.conformancePassed === true && manifest.conformanceEvidenceId !== undefined;
  add(
    'conformance-evidence',
    conformanceOk,
    conformanceOk ? 'passing conformance-suite evidence cited' : 'no passing conformance evidence',
  );

  // Health probe.
  add(
    'health-probe',
    manifest.declaresHealthProbe === true,
    manifest.declaresHealthProbe
      ? 'health/readiness probe declared'
      : 'no health/readiness probe declared',
  );

  // Failure semantics (timeout + idempotency + retry).
  add(
    'failure-semantics',
    manifest.declaresFailureSemantics === true,
    manifest.declaresFailureSemantics
      ? 'timeout/idempotency/retry semantics declared'
      : 'no failure semantics declared (lost acknowledgements would be guessed)',
  );

  // Activation approval.
  const approvalOk = input.approvalDecisionId !== undefined;
  add(
    'activation-approval',
    approvalOk,
    approvalOk
      ? 'activation approval decision present'
      : 'activation requires an approval decision',
  );

  const failed = checks.filter((c) => !c.passed).map((c) => c.check);
  return {
    activatable: failed.length === 0,
    checks: Object.freeze(checks),
    failed: Object.freeze(failed),
  };
}
