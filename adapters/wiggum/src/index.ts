// @trustcircle/adapter-wiggum package boundary entry point.
// Re-exports the read-only snapshot discovery, governance mapping, and governed operations
// surfaces (T264–T266 / US6).
//
// Each module ships its own in-module `contentDigest` helper; to keep the package surface
// unambiguous under `verbatimModuleSyntax`/`isolatedModules`, `contentDigest` is re-exported once
// (from the snapshot module) and the mapping/operations modules' identical helper is not re-exported.
export * from './snapshot.ts';

export type {
  EvidenceBinding,
  WiggumEvidenceKind,
  WiggumCriticVerdict,
  WiggumGateMarkerState,
  WiggumGovernanceObservation,
  EvidenceAuthority,
  MappedGovernanceEvidence,
  VerificationObligation,
  VerificationPlanObservation,
  MappedObligation,
  MappedVerificationPlan,
} from './governance-mapping.ts';
export {
  bindingHash,
  bindingMatches,
  mapGovernanceEvidence,
  mapVerificationPlan,
} from './governance-mapping.ts';

export type {
  WiggumOperationKind,
  OperationOutcome,
  SourceSignal,
  OperationInput,
  OperationEvidence,
  TimeoutReconciliationInput,
  TimeoutReconciliationResult,
} from './operations.ts';
export { performOperation, reconcileTimeout } from './operations.ts';
