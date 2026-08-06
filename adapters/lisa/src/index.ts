// @trustcircle/adapter-lisa package boundary entry point.
// Re-exports the read-only LISA snapshot, governance mapping, evidence mapping, and lifecycle
// guard surfaces (T259–T262 / US6).
//
// Each module ships its own in-module `contentDigest` helper; to keep the package surface
// unambiguous under `verbatimModuleSyntax`/`isolatedModules`, `contentDigest` is re-exported once
// (from the snapshot module) and the mapping/lifecycle modules' identical helper is not re-exported.
export * from './snapshot.ts';

export type {
  DecisionBinding,
  LisaGateRole,
  LisaVerdict,
  LisaGateDecision,
  DecisionAuthority,
  MappedGateDecision,
  GateResolution,
  StateField,
  StateDiffEntry,
  StateDiffProposal,
  LisaControlKind,
  LisaControlObservation,
  MappedControlIntent,
} from './governance-mapping.ts';
export {
  bindingHash,
  bindingMatches,
  mapGateDecision,
  resolveGate,
  diffDesiredState,
  mapControlIntent,
} from './governance-mapping.ts';

export type {
  LisaEvidenceSurface,
  CostAttribution,
  EgressRecord,
  RetentionPolicy,
  LisaSurfaceObservation,
  LisaEvidenceRecord,
  LisaEvidenceGapReason,
  LisaEvidenceGap,
  LisaEvidenceMapping,
} from './evidence-mapping.ts';
export { mapEvidence } from './evidence-mapping.ts';

export type {
  LisaActivationState,
  InactivityInput,
  InactivityAssessment,
  DeploymentIdentity,
  BacklogItem,
  ActivationPreflightInput,
  PreflightFailure,
  ActivationPreflightResult,
  OutstandingWork,
  CrashRecoveryInput,
  CrashRecoveryResult,
  SafeReturnInput,
  SafeReturnDecision,
} from './lifecycle.ts';
export {
  assessInactivity,
  activationPreflight,
  reconcileCrashBacklog,
  safeReturnToService,
} from './lifecycle.ts';
