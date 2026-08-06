// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — NAMED ADAPTERS + CORE-ONLY ACTIVATION SIGNED RESULT MANIFEST emitter
// (T271 · FR-008 · FR-029 · FR-030 · NFR-010 · SC-011 · SC-024). Acceptance: US6-AS1 + the named-
// source ecosystem invariant (Kanban, workflow_orchestration, agentctl, LISA, Wiggum) and the
// component-profile invariant "only the CORE profile runs continuously" (NFR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────────
// A dependency-free, deterministic emitter that RUNS the real adapter-SDK contract + the real
// component-lifecycle / readiness services over the five shipped named adapters and the core control-
// plane component, and EMITS A SIGNED result manifest binding, per named adapter and for the core-only
// activation profile, its:
//
//   • requirement reference   (FR-008 correlate across all registered sources / FR-029 continuous
//                              reconciliation / NFR-010 only-core-runs-continuously),
//   • assertion reference     (a per-adapter runner id + the US6-AS1 acceptance criterion),
//   • audit reference         (the verification obligation + the safe next action),
//   • evidence                (facts read from the REAL SDK verdict — validateManifest / negotiated
//                              capability subset / contract-range gate — and the REAL readiness verdict,
//                              NEVER a re-implemented rule),
//   • version reference       (the pinned scenario identity + the integrations-world digest),
//   • gap references          (every optional/on-demand source that is intentionally inactive — visible,
//                              never hidden as "everything is fine").
//
// LOAD-BEARING INVARIANTS WITNESSED (never re-implemented):
//   * A CONNECTOR IS NEVER GRANTED GOVERNANCE AUTHORITY — no adapter's authoritative_fields names an
//     approval / decision / closure; every operation risk is a declared closed class (SC-024).
//   * LEAST PRIVILEGE — the negotiated capability subset is a strict subset of the declared set; a
//     capability an adapter does NOT declare is refused (even agentctl, the only adapter with execute).
//   * ONLY CORE RUNS CONTINUOUSLY (NFR-010) — the core component activates ONLY once its prerequisites
//     are proven; every named connector is optional/on-demand → intentionally_inactive, and readiness
//     is core-only: optional inactivity is surfaced as an explicit inventory, never drags core down.
//
// This file is a plain ESM module (no test-runner import), reusable from node --test and the browserless
// Playwright `ecosystem-health` project. tests/e2e/ecosystem-health.spec.ts asserts it with paired
// NEGATIVE controls so the oracle is non-vacuous.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

import {
  validateManifest,
  negotiateCapabilities,
  negotiateContract,
  manifestDigest,
  isMajorSupported,
  type AdapterManifest,
  type AdapterCapability,
} from '@trustcircle/adapter-sdk';

import { evaluateReadiness } from '@trustcircle/application';

import {
  inspect,
  activate,
  reconcile,
  preflightPassed,
  type ActivationPrerequisites,
} from '../../../apps/command-worker/src/component-lifecycle.ts';

import {
  NOW,
  TENANT,
  PLATFORM_OWNER,
  CONNECTOR_SPECS,
  CORE_COMPONENT,
  integrationsWorldDigest,
  type ConnectorSpec,
} from '../../fixtures/integrations.ts';

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. PINNED SCENARIO IDENTITY.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export const PINNED = Object.freeze({
  scenario: 'US6-named-adapters',
  scenarioTitle: 'Maintain Source and Workflow Health — named adapters + core-only activation',
  requirementRefs: Object.freeze(['FR-008', 'FR-029', 'NFR-010']),
  worldDigest: integrationsWorldDigest(),
  /** The five shipped named adapters, in a fixed order. */
  namedAdapters: Object.freeze(['kanban', 'workflow-orchestration', 'agentctl', 'lisa', 'wiggum']),
} as const);

export const MANIFEST_VERSION = 1 as const;

/** A governance-authority "smell test" — no authoritative field may name a decision. */
const APPROVAL_RE =
  /\bapprov|\baccept(ance|ed)?\b|\bdecision\b|\bsign[-_ ]?off\b|\bclos(e|ure)\b|\bgovernance_verdict\b|\bquarantine\b/i;

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE ACCEPTANCE CRITERION + per-adapter runner obligations.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface AcceptanceSpec {
  readonly assertionRef: string;
  readonly obligationRef: string;
  readonly text: string;
}

/** The US6-AS1 correlated-view acceptance criterion (verbatim, spec.md US6). */
export const US6_AS1: AcceptanceSpec = Object.freeze({
  assertionRef: 'US6-AS1',
  obligationRef: 'VO-nam3dc0rrel4t3d1',
  text: 'Given all sources are healthy, When work changes state, Then the correlated governance view reflects the authoritative source change within the freshness objective.',
});

export const SUCCESS_CRITERIA = Object.freeze([
  {
    id: 'SC-024',
    text: 'Absence is never inferred as health, and no connector is ever granted governance authority.',
  },
] as const);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. CANONICALISATION + SIGNING.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function sha256(buf: string): string {
  return createHash('sha256').update(buf).digest('hex');
}
export function canonicalize(obj: unknown): string {
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone && typeof clone === 'object') {
    delete (clone as Record<string, unknown>).manifestDigest;
    delete (clone as Record<string, unknown>).signature;
  }
  return stableStringify(clone);
}
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') {
    return (
      '{' +
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(v);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE MANIFEST TYPES.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface EvidenceWitness {
  readonly readPath: 'adapter-sdk-verdict' | 'component-lifecycle' | 'readiness-verdict';
  readonly detail: string;
  readonly witnessed: readonly string[];
}

export interface GapReference {
  /** The intentionally-inactive source (a visible inventory item, never hidden). */
  readonly subject: string;
  readonly availabilityClass: string;
  readonly runtimeState: string;
  readonly ownerAction: string;
}

export interface AdapterRunnerLine {
  readonly runnerRef: string; // adapter id
  readonly assertionRef: string; // US6-AS1
  readonly requirementRefs: readonly string[];
  readonly auditRef: { readonly obligationRef: string; readonly safeNextAction: string };
  readonly sourceClass: string;
  readonly negotiatedCapabilities: readonly string[];
  readonly grantsGovernanceAuthority: boolean;
  readonly evidence: readonly EvidenceWitness[];
  readonly lineDigest: string;
}

export interface CoreActivationLine {
  readonly assertionRef: string; // US6-core-only-activation
  readonly requirementRefs: readonly string[];
  readonly auditRef: { readonly obligationRef: string; readonly safeNextAction: string };
  readonly evidence: readonly EvidenceWitness[];
  readonly lineDigest: string;
}

export interface NamedAdaptersManifest {
  readonly manifestVersion: number;
  readonly kind: 'scenario-result-manifest';
  readonly scenario: string;
  readonly scenarioTitle: string;
  readonly emittedBy: string;
  readonly version: {
    readonly scenario: string;
    readonly requirementRefs: readonly string[];
    readonly worldDigest: string;
  };
  readonly successCriteria: readonly {
    readonly id: string;
    readonly text: string;
    readonly met: boolean;
    readonly measure: string;
  }[];
  readonly adapterLines: readonly AdapterRunnerLine[];
  readonly coreActivation: CoreActivationLine;
  /** Every optional/on-demand source that is intentionally inactive — visible, never hidden. */
  readonly gapRegister: readonly GapReference[];
  readonly manifestDigest: string;
  readonly signature: {
    readonly algorithm: 'sha256';
    readonly digest: string;
    readonly boundScenario: string;
    readonly boundWorldDigest: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. RUN THE REAL MODULES per named adapter + the core-only activation profile.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const ALL_PROVEN: ActivationPrerequisites = Object.freeze({
  identityVerified: true,
  contractVerified: true,
  authorityVerified: true,
  backlogReconciled: true,
});

export interface AdapterRunnerObservation {
  readonly adapterId: string;
  readonly sourceClass: string;
  readonly manifestValid: boolean;
  readonly manifestDigest: string;
  readonly requestedCapabilities: readonly string[];
  readonly negotiatedOk: boolean;
  readonly negotiatedCapabilities: readonly string[];
  /** An undeclared capability is refused (least privilege). */
  readonly undeclaredRefused: boolean;
  readonly undeclaredReason: string | null;
  /** The supported / drifted contract-major gate (NS-005). */
  readonly supportedMajor: boolean;
  readonly driftedMajor: boolean;
  readonly negotiatedContractOk: boolean;
  /** No authoritative field names an approval (SC-024). */
  readonly grantsGovernanceAuthority: boolean;
  readonly authoritativeFields: readonly string[];
  readonly forbiddenInferenceCount: number;
  readonly availabilityClass: string;
}

/** Pick a real capability the adapter does NOT declare (to prove refusal), or null if it declares all. */
function undeclaredCapability(manifest: AdapterManifest): AdapterCapability | null {
  const ALL: readonly AdapterCapability[] = [
    'discover',
    'inspect',
    'snapshot',
    'subscribe',
    'execute',
    'reconcile',
    'collect_evidence',
  ];
  return ALL.find((c) => !manifest.capabilities.includes(c)) ?? null;
}

function runAdapter(spec: ConnectorSpec): AdapterRunnerObservation {
  const manifest = spec.manifest;
  const validation = validateManifest(manifest);
  const requested = spec.requestedCapabilities;
  const negotiated = negotiateCapabilities(manifest, requested);

  const undeclared = undeclaredCapability(manifest);
  const undeclaredResult = undeclared ? negotiateCapabilities(manifest, [undeclared]) : null;

  const max = Number(manifest.contract_range.maximum.split('.')[0]);
  const contract = negotiateContract(manifest, manifest.contract_range.maximum);

  const authoritativeFields = manifest.authority.authoritative_fields;
  const grantsAuthority = authoritativeFields.some((f) => APPROVAL_RE.test(f));

  return {
    adapterId: manifest.adapter_id,
    sourceClass: manifest.source_classes[0]!,
    manifestValid: validation.valid,
    manifestDigest: manifestDigest(manifest),
    requestedCapabilities: [...requested],
    negotiatedOk: negotiated.ok,
    negotiatedCapabilities: negotiated.ok ? [...negotiated.enabled] : [],
    undeclaredRefused: undeclaredResult ? !undeclaredResult.ok : true,
    undeclaredReason: undeclaredResult && !undeclaredResult.ok ? undeclaredResult.reason : null,
    supportedMajor: isMajorSupported(manifest, max),
    driftedMajor: isMajorSupported(manifest, max + 1),
    negotiatedContractOk: contract.ok,
    grantsGovernanceAuthority: grantsAuthority,
    authoritativeFields: [...authoritativeFields],
    forbiddenInferenceCount: manifest.authority.forbidden_inferences.length,
    availabilityClass: spec.availabilityClass,
  };
}

export interface CoreActivationObservation {
  readonly preflightPassed: boolean;
  readonly coreInspectUnprovenState: string;
  readonly coreActivatedState: string;
  readonly coreActivatedRuntime: string;
  readonly coreLapsedReconcileState: string;
  readonly optionalInspectStates: readonly { readonly adapterId: string; readonly runtimeState: string }[];
  readonly readinessVerdict: string;
  readonly coreHealthy: boolean;
  readonly optionalUnavailable: readonly string[];
  readonly unhealthyCore: readonly string[];
  readonly readinessDigest: string;
}

function runCoreOnlyActivation(): CoreActivationObservation {
  const coreKey = CORE_COMPONENT.name;
  const owner = String(PLATFORM_OWNER);
  const tenant = String(TENANT);

  const coreInputProven = {
    componentKey: coreKey,
    tenantId: tenant,
    owner,
    availabilityClass: 'core' as const,
    prerequisites: ALL_PROVEN,
    at: NOW as number,
  };
  const coreInputUnproven = { ...coreInputProven, prerequisites: { ...ALL_PROVEN, authorityVerified: false } };
  const coreInputLapsed = { ...coreInputProven, prerequisites: { ...ALL_PROVEN, backlogReconciled: false } };

  // Core: proof-before-active. Unproven inspect is intentionally_inactive; activation reaches active
  // only when fully proven; a lapsed core reconciles to stale (drift-visible).
  const coreInspectUnproven = inspect(coreInputUnproven);
  const coreActivated = activate(coreInputProven);
  const coreLapsed = reconcile(coreInputLapsed);

  // Every named connector is optional/on-demand → intentionally_inactive even when fully proven.
  const optionalInspectStates = CONNECTOR_SPECS.map((spec) => {
    const cls = spec.availabilityClass === 'core' ? 'core' : spec.availabilityClass;
    const activation = inspect({
      componentKey: spec.slug,
      tenantId: tenant,
      owner,
      availabilityClass: cls,
      prerequisites: ALL_PROVEN,
      at: NOW as number,
    });
    return { adapterId: spec.adapterId, runtimeState: activation.runtimeState };
  });

  // Readiness is core-only: core active + every named connector intentionally_inactive ⇒ ready, with
  // an explicit unavailable inventory.
  const readiness = evaluateReadiness({
    at: NOW as number,
    activations: [
      { componentKey: coreKey, availabilityClass: 'core', runtimeState: 'active' },
      ...CONNECTOR_SPECS.map((spec) => ({
        componentKey: spec.slug,
        availabilityClass: spec.availabilityClass === 'core' ? ('core' as const) : spec.availabilityClass,
        runtimeState: 'intentionally_inactive' as const,
      })),
    ],
  });

  return {
    preflightPassed: preflightPassed(ALL_PROVEN),
    coreInspectUnprovenState: coreInspectUnproven.runtimeState,
    coreActivatedState: coreActivated.activationState,
    coreActivatedRuntime: coreActivated.runtimeState,
    coreLapsedReconcileState: coreLapsed.runtimeState,
    optionalInspectStates,
    readinessVerdict: readiness.verdict,
    coreHealthy: readiness.coreHealthy,
    optionalUnavailable: readiness.optionalUnavailable.map((f) => f.componentKey).sort(),
    unhealthyCore: readiness.unhealthyCore.map((c) => c.componentKey),
    readinessDigest: readiness.digest,
  };
}

export interface NamedAdaptersObservations {
  readonly adapters: readonly AdapterRunnerObservation[];
  readonly core: CoreActivationObservation;
}

export function runNamedAdapters(): NamedAdaptersObservations {
  // Fixed order — one runner per named adapter, driven off the fixture's connector specs.
  const byId = new Map(CONNECTOR_SPECS.map((s) => [s.adapterId, s]));
  const adapters = PINNED.namedAdapters.map((id) => {
    const spec = byId.get(id);
    if (!spec) throw new Error(`named-adapters: no connector spec for ${id}`);
    return runAdapter(spec);
  });
  return { adapters, core: runCoreOnlyActivation() };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6. BUILD THE SIGNED MANIFEST.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function adapterEvidence(a: AdapterRunnerObservation): EvidenceWitness[] {
  return [
    {
      readPath: 'adapter-sdk-verdict',
      detail:
        'the shipped manifest validates, negotiates a least-privilege capability SUBSET, and refuses an undeclared capability (real SDK verdicts, never re-implemented)',
      witnessed: [
        `${a.adapterId}: valid=${a.manifestValid}|sourceClass=${a.sourceClass}|digest=${a.manifestDigest.slice(0, 12)}…`,
        `negotiated: ok=${a.negotiatedOk}|enabled=[${[...a.negotiatedCapabilities].sort().join(',')}]`,
        `undeclared refused=${a.undeclaredRefused}${a.undeclaredReason ? `|reason=${a.undeclaredReason}` : ''}`,
        `contract gate (NS-005): supportedMajor=${a.supportedMajor}|driftedMajor=${a.driftedMajor}|negotiatedContractOk=${a.negotiatedContractOk}`,
      ],
    },
    {
      readPath: 'adapter-sdk-verdict',
      detail:
        'NO governance authority: no authoritative field names an approval/decision/closure, and forbidden inferences are declared (SC-024)',
      witnessed: [
        `grantsGovernanceAuthority=${a.grantsGovernanceAuthority}`,
        `authoritativeFields=[${a.authoritativeFields.join(',')}]`,
        `forbiddenInferences=${a.forbiddenInferenceCount}`,
      ],
    },
  ];
}

function coreEvidence(c: CoreActivationObservation): EvidenceWitness[] {
  return [
    {
      readPath: 'component-lifecycle',
      detail:
        'proof-before-active: an unproven core is intentionally_inactive; activation reaches active ONLY when fully proven; a lapsed core reconciles to stale (drift-visible, NFR-010)',
      witnessed: [
        `preflightPassed(all four)=${c.preflightPassed}`,
        `core inspect (unproven)=${c.coreInspectUnprovenState}`,
        `core activated: activationState=${c.coreActivatedState}|runtimeState=${c.coreActivatedRuntime}`,
        `core lapsed reconcile=${c.coreLapsedReconcileState}`,
      ],
    },
    {
      readPath: 'component-lifecycle',
      detail:
        'every named connector is optional/on-demand → intentionally_inactive even when fully proven (only core runs continuously)',
      witnessed: c.optionalInspectStates.map((s) => `${s.adapterId}=${s.runtimeState}`),
    },
    {
      readPath: 'readiness-verdict',
      detail:
        'readiness is core-only: core active + every named connector inactive ⇒ ready, with an EXPLICIT unavailable inventory (optional inactivity never drags core down)',
      witnessed: [
        `verdict=${c.readinessVerdict}|coreHealthy=${c.coreHealthy}`,
        `optionalUnavailable=[${c.optionalUnavailable.join(',')}]`,
        `unhealthyCore=[${c.unhealthyCore.join(',')}]`,
        `readinessDigest=${c.readinessDigest.slice(0, 12)}…`,
      ],
    },
  ];
}

function gapRegister(c: CoreActivationObservation): GapReference[] {
  // Every intentionally-inactive named connector is a visible inventory item, never hidden.
  const byId = new Map(CONNECTOR_SPECS.map((s) => [s.slug, s]));
  return c.optionalUnavailable
    .map((slug) => {
      const spec = byId.get(slug);
      return {
        subject: slug,
        availabilityClass: spec?.availabilityClass ?? 'optional',
        runtimeState: 'intentionally_inactive',
        ownerAction: 'owner_approved_activation_to_enable',
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

function successCriteria(o: NamedAdaptersObservations): NamedAdaptersManifest['successCriteria'] {
  const noneGrantAuthority = o.adapters.every((a) => !a.grantsGovernanceAuthority);
  const coreOnly =
    o.core.coreActivatedRuntime === 'active' &&
    o.core.optionalInspectStates.every((s) => s.runtimeState === 'intentionally_inactive') &&
    o.core.readinessVerdict === 'ready' &&
    o.core.coreHealthy;
  return [
    {
      id: 'SC-024',
      text: SUCCESS_CRITERIA[0].text,
      met: noneGrantAuthority && coreOnly,
      measure: `no adapter grants governance authority=${noneGrantAuthority}; core-only continuous runtime + core-only readiness=${coreOnly}`,
    },
  ];
}

export function emitNamedAdaptersManifest(injected?: NamedAdaptersObservations): NamedAdaptersManifest {
  const o = injected ?? runNamedAdapters();
  const safeNextAction = 'owner_approved_activation_to_enable_optional_sources';

  const adapterLines: AdapterRunnerLine[] = o.adapters.map((a) => {
    const line: Omit<AdapterRunnerLine, 'lineDigest'> = {
      runnerRef: a.adapterId,
      assertionRef: US6_AS1.assertionRef,
      requirementRefs: [...PINNED.requirementRefs],
      auditRef: { obligationRef: US6_AS1.obligationRef, safeNextAction },
      sourceClass: a.sourceClass,
      negotiatedCapabilities: [...a.negotiatedCapabilities].sort(),
      grantsGovernanceAuthority: a.grantsGovernanceAuthority,
      evidence: adapterEvidence(a),
    };
    return { ...line, lineDigest: sha256(canonicalize(line)) };
  });

  const coreLineDraft: Omit<CoreActivationLine, 'lineDigest'> = {
    assertionRef: 'US6-core-only-activation',
    requirementRefs: ['NFR-010'],
    auditRef: { obligationRef: 'VO-c0r30nlyact1v4t3', safeNextAction },
    evidence: coreEvidence(o.core),
  };
  const coreActivation: CoreActivationLine = {
    ...coreLineDraft,
    lineDigest: sha256(canonicalize(coreLineDraft)),
  };

  const draft: Omit<NamedAdaptersManifest, 'manifestDigest' | 'signature'> = {
    manifestVersion: MANIFEST_VERSION,
    kind: 'scenario-result-manifest',
    scenario: PINNED.scenario,
    scenarioTitle: PINNED.scenarioTitle,
    emittedBy: 'tests/e2e/scenarios/named-adapters.ts',
    version: {
      scenario: PINNED.scenario,
      requirementRefs: [...PINNED.requirementRefs],
      worldDigest: PINNED.worldDigest,
    },
    successCriteria: successCriteria(o),
    adapterLines,
    coreActivation,
    gapRegister: gapRegister(o.core),
  };

  const manifestDigestValue = sha256(canonicalize(draft));
  return {
    ...draft,
    manifestDigest: manifestDigestValue,
    signature: {
      algorithm: 'sha256',
      digest: manifestDigestValue,
      boundScenario: PINNED.scenario,
      boundWorldDigest: PINNED.worldDigest,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7. VERIFY — the independent oracle.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface VerifyResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}

export function verifyNamedAdaptersManifest(manifest: NamedAdaptersManifest): VerifyResult {
  const reasons: string[] = [];

  // (a) Pinned identity.
  if (manifest.version.scenario !== PINNED.scenario)
    reasons.push(`scenario ${manifest.version.scenario} != pinned ${PINNED.scenario}`);
  if (manifest.version.worldDigest !== PINNED.worldDigest)
    reasons.push('world digest differs from pinned input');
  if (manifest.signature.boundScenario !== PINNED.scenario) reasons.push('signature scenario not pinned');
  if (manifest.signature.boundWorldDigest !== PINNED.worldDigest)
    reasons.push('signature world digest not pinned');

  // (b) Signature.
  const recomputed = sha256(canonicalize(manifest));
  if (recomputed !== manifest.manifestDigest)
    reasons.push(
      `manifestDigest mismatch (recomputed ${recomputed.slice(0, 12)}… != stored ${manifest.manifestDigest.slice(0, 12)}…)`,
    );
  if (manifest.signature.digest !== manifest.manifestDigest)
    reasons.push('signature.digest != manifestDigest');

  // (c) Per-line digests — adapters + the core activation line.
  for (const line of manifest.adapterLines) {
    const { lineDigest, ...rest } = line;
    if (sha256(canonicalize(rest)) !== lineDigest) reasons.push(`adapter line ${line.runnerRef} digest mismatch`);
  }
  {
    const { lineDigest, ...rest } = manifest.coreActivation;
    if (sha256(canonicalize(rest)) !== lineDigest) reasons.push('core activation line digest mismatch');
  }

  // (d) Coverage — all five named adapters present, none grants governance authority, each with
  //     evidence witnesses read from a real SDK verdict.
  const present = new Set(manifest.adapterLines.map((l) => l.runnerRef));
  for (const id of PINNED.namedAdapters) {
    if (!present.has(id)) {
      reasons.push(`missing named-adapter runner ${id}`);
      continue;
    }
    const line = manifest.adapterLines.find((l) => l.runnerRef === id)!;
    if (line.grantsGovernanceAuthority) reasons.push(`adapter ${id} GRANTS governance authority (invariant breach)`);
    if (line.assertionRef !== US6_AS1.assertionRef) reasons.push(`adapter ${id} wrong assertionRef`);
    if (!line.requirementRefs.includes('FR-008')) reasons.push(`adapter ${id} missing FR-008`);
    if (line.evidence.length === 0) reasons.push(`adapter ${id} has no evidence witness`);
    const emptyWitness = line.evidence.some(
      (e) => e.witnessed.length === 0 || e.witnessed.some((w) => /MISSING/.test(w)),
    );
    if (emptyWitness) reasons.push(`adapter ${id} has an empty/missing evidence witness`);
    const badPath = line.evidence.some(
      (e) => !['adapter-sdk-verdict', 'component-lifecycle', 'readiness-verdict'].includes(e.readPath),
    );
    if (badPath) reasons.push(`adapter ${id} has a non-durable evidence read path`);
    // Non-vacuous: the undeclared-capability refusal must be witnessed true.
    const refusalWitnessed = line.evidence.some((e) =>
      e.witnessed.some((w) => /undeclared refused=true/.test(w)),
    );
    if (!refusalWitnessed) reasons.push(`adapter ${id} does not witness least-privilege refusal`);
    // The drifted contract major must be refused (NS-005) — witnessed false.
    const contractGate = line.evidence.some((e) =>
      e.witnessed.some((w) => /driftedMajor=false/.test(w)),
    );
    if (!contractGate) reasons.push(`adapter ${id} does not witness contract-major drift refusal`);
  }

  // (e) Core-only activation — the core line witnesses proof-before-active + core-only readiness.
  const core = manifest.coreActivation;
  if (!core.requirementRefs.includes('NFR-010')) reasons.push('core activation missing NFR-010');
  if (core.evidence.length === 0) reasons.push('core activation has no evidence witness');
  const coreActive = core.evidence.some((e) =>
    e.witnessed.some((w) => /core activated:.*activationState=active\|runtimeState=active/.test(w)),
  );
  if (!coreActive) reasons.push('core activation does not witness core reaching active once proven');
  const readyCoreOnly = core.evidence.some((e) =>
    e.witnessed.some((w) => /verdict=ready\|coreHealthy=true/.test(w)),
  );
  if (!readyCoreOnly) reasons.push('core activation does not witness core-only ready verdict');
  // Every named connector must be witnessed intentionally_inactive.
  const inactiveWitness = core.evidence.find((e) =>
    e.detail.includes('optional/on-demand'),
  );
  if (!inactiveWitness || !inactiveWitness.witnessed.every((w) => /=intentionally_inactive$/.test(w))) {
    reasons.push('core activation does not witness every named connector intentionally_inactive');
  }

  // (f) Gap register — every intentionally-inactive named source is a visible inventory item with a
  //     specific owner action (nothing "looks healthy" by omission).
  if (manifest.gapRegister.length === 0)
    reasons.push('gap register empty — optional inactivity must be visible');
  for (const g of manifest.gapRegister) {
    if (!g.ownerAction || g.ownerAction === 'investigate')
      reasons.push(`gap ${g.subject} lacks a specific owner action`);
    if (g.runtimeState !== 'intentionally_inactive')
      reasons.push(`gap ${g.subject} is not intentionally_inactive`);
  }

  // (g) Success criteria — present + met.
  const scIds = new Set(manifest.successCriteria.map((s) => s.id));
  for (const sc of SUCCESS_CRITERIA) if (!scIds.has(sc.id)) reasons.push(`missing success criterion ${sc.id}`);
  for (const s of manifest.successCriteria) if (!s.met) reasons.push(`success criterion ${s.id} not met: ${s.measure}`);

  return { ok: reasons.length === 0, reasons };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 8. PER-JOURNEY EVIDENCE PROJECTION (T272).
//
// The full named-adapters manifest above binds every adapter + the core-only line in ONE digest.
// That is the right integrity object for the run, but it is the WRONG evidence artifact for a
// per-journey drill-down: Scenario 9 (Kanban projection) and Scenario 10 (workflow_orchestration +
// agentctl) and the core-only activation PROFILE are DISTINCT journeys, and each must be attested by
// its OWN signed manifest whose digest reflects ONLY that journey's content — so a drift in the
// Kanban journey produces a different digest from a drift in the agentctl journey, and neither can be
// masked by the other.
//
// A journey manifest is DERIVED deterministically from the full run: it carries a `journeyScope`
// discriminator, the SUBSET of adapter lines that belong to the journey (empty for the core-only
// profile), the core-activation line ONLY for the profile journey, and a gap register scoped to the
// journey's optional sources. Every digest (line + manifest) is recomputed over the reduced content,
// so distinct journeys necessarily yield distinct digests. `verifyJourneyManifest` re-derives the
// journey from a fresh full run and checks the on-disk journey byte-for-byte at the digest level, so
// the artifact is independently falsifiable — not a copy under a new name.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type JourneyScope =
  | 'scenario-9-kanban-projection'
  | 'scenario-10-workflow-agentctl'
  | 'profile-core-only-activation';

export interface JourneySpec {
  readonly scope: JourneyScope;
  readonly title: string;
  readonly requirementRefs: readonly string[];
  /** Adapter ids in this journey (fixed order); empty ⇒ core-only profile journey. */
  readonly adapters: readonly string[];
  /** Whether the core-only activation line is part of this journey's evidence. */
  readonly includesCore: boolean;
}

export const JOURNEYS: readonly JourneySpec[] = Object.freeze([
  Object.freeze({
    scope: 'scenario-9-kanban-projection',
    title: 'Scenario 9 — Kanban projection drill-down (columns/cards/tombstones, done≠closure)',
    requirementRefs: Object.freeze(['FR-008', 'FR-029']),
    adapters: Object.freeze(['kanban']),
    includesCore: false,
  }),
  Object.freeze({
    scope: 'scenario-10-workflow-agentctl',
    title: 'Scenario 10 — workflow_orchestration + agentctl activation (read-only, JSON fallback)',
    requirementRefs: Object.freeze(['FR-008', 'FR-029']),
    adapters: Object.freeze(['workflow-orchestration', 'agentctl']),
    includesCore: false,
  }),
  Object.freeze({
    scope: 'profile-core-only-activation',
    title: 'Profile — core-only activation (only core runs continuously, NFR-010)',
    requirementRefs: Object.freeze(['NFR-010']),
    adapters: Object.freeze([]),
    includesCore: true,
  }),
]);

export interface JourneyManifest {
  readonly manifestVersion: number;
  readonly kind: 'journey-result-manifest';
  readonly journeyScope: JourneyScope;
  readonly journeyTitle: string;
  readonly parentScenario: string;
  readonly emittedBy: string;
  readonly version: {
    readonly scenario: string;
    readonly requirementRefs: readonly string[];
    readonly worldDigest: string;
  };
  readonly successCriteria: NamedAdaptersManifest['successCriteria'];
  readonly adapterLines: readonly AdapterRunnerLine[];
  readonly coreActivation: CoreActivationLine | null;
  readonly gapRegister: readonly GapReference[];
  readonly manifestDigest: string;
  readonly signature: {
    readonly algorithm: 'sha256';
    readonly digest: string;
    readonly boundScenario: string;
    readonly boundWorldDigest: string;
    readonly boundJourney: JourneyScope;
  };
}

/** Journey-scoped success criteria: SC-024 restricted to the lines this journey actually attests. */
function journeySuccessCriteria(
  spec: JourneySpec,
  adapterLines: readonly AdapterRunnerLine[],
  core: CoreActivationLine | null,
  full: NamedAdaptersManifest,
): NamedAdaptersManifest['successCriteria'] {
  const noneGrantAuthority = adapterLines.every((a) => !a.grantsGovernanceAuthority);
  if (spec.includesCore) {
    // Core-only profile: SC-024's core-only-continuous half, read from the shared core line witnesses.
    const coreReady =
      !!core &&
      core.evidence.some((e) =>
        e.witnessed.some((w) => /verdict=ready\|coreHealthy=true/.test(w)),
      ) &&
      core.evidence.some((e) =>
        e.witnessed.some((w) => /activationState=active\|runtimeState=active/.test(w)),
      );
    return [
      {
        id: 'SC-024',
        text: SUCCESS_CRITERIA[0].text,
        met: coreReady,
        measure: `core-only continuous runtime + core-only readiness witnessed=${coreReady}`,
      },
    ];
  }
  // Adapter journeys: the "no connector holds governance authority" half, scoped to this journey.
  return [
    {
      id: 'SC-024',
      text: SUCCESS_CRITERIA[0].text,
      met: noneGrantAuthority,
      measure: `no adapter in journey grants governance authority=${noneGrantAuthority} (scope=${spec.scope}, full-run SC-024 met=${full.successCriteria[0]?.met})`,
    },
  ];
}

/**
 * Project ONE distinct, independently-signed journey manifest from the full named-adapters run.
 * The digest is recomputed over the journey-scoped content, so each journey yields a distinct digest.
 */
export function projectJourneyManifest(
  spec: JourneySpec,
  full?: NamedAdaptersManifest,
): JourneyManifest {
  const source = full ?? emitNamedAdaptersManifest();

  const wanted = new Set(spec.adapters);
  const adapterLines = source.adapterLines
    .filter((l) => wanted.has(l.runnerRef))
    // Re-derive each line digest fresh from the scoped line body (identical to the full-run body,
    // but recomputed here so the journey's integrity does not depend on the full manifest object).
    .map((l) => {
      const { lineDigest: _drop, ...rest } = l;
      return { ...rest, lineDigest: sha256(canonicalize(rest)) } as AdapterRunnerLine;
    });

  if (adapterLines.length !== spec.adapters.length) {
    const present = new Set(adapterLines.map((l) => l.runnerRef));
    const missing = spec.adapters.filter((a) => !present.has(a));
    throw new Error(`journey ${spec.scope}: missing adapter line(s) ${missing.join(',')}`);
  }

  let coreActivation: CoreActivationLine | null = null;
  if (spec.includesCore) {
    const { lineDigest: _d, ...rest } = source.coreActivation;
    coreActivation = { ...rest, lineDigest: sha256(canonicalize(rest)) } as CoreActivationLine;
  }

  // Gap register scoped to the journey: for adapter journeys, only the journey's own adapters that
  // are intentionally inactive; for the core-only profile, the FULL optional inventory (that IS the
  // profile's evidence — every optional source is inactive while only core runs).
  const gapRegister = spec.includesCore
    ? source.gapRegister
    : source.gapRegister.filter((g) => wanted.has(g.subject));

  const draft: Omit<JourneyManifest, 'manifestDigest' | 'signature'> = {
    manifestVersion: MANIFEST_VERSION,
    kind: 'journey-result-manifest',
    journeyScope: spec.scope,
    journeyTitle: spec.title,
    parentScenario: PINNED.scenario,
    emittedBy: 'tests/e2e/scenarios/named-adapters.ts#projectJourneyManifest',
    version: {
      scenario: PINNED.scenario,
      requirementRefs: [...spec.requirementRefs],
      worldDigest: PINNED.worldDigest,
    },
    successCriteria: journeySuccessCriteria(spec, adapterLines, coreActivation, source),
    adapterLines,
    coreActivation,
    gapRegister,
  };

  const manifestDigestValue = sha256(canonicalize(draft));
  return {
    ...draft,
    manifestDigest: manifestDigestValue,
    signature: {
      algorithm: 'sha256',
      digest: manifestDigestValue,
      boundScenario: PINNED.scenario,
      boundWorldDigest: PINNED.worldDigest,
      boundJourney: spec.scope,
    },
  };
}

/** Verify ONE journey manifest independently, re-deriving it from a fresh full run. */
export function verifyJourneyManifest(manifest: JourneyManifest): VerifyResult {
  const reasons: string[] = [];

  const spec = JOURNEYS.find((j) => j.scope === manifest.journeyScope);
  if (!spec) {
    return { ok: false, reasons: [`unknown journey scope ${manifest.journeyScope}`] };
  }

  // (a) Pinned identity + journey binding.
  if (manifest.version.scenario !== PINNED.scenario)
    reasons.push(`scenario ${manifest.version.scenario} != pinned ${PINNED.scenario}`);
  if (manifest.version.worldDigest !== PINNED.worldDigest)
    reasons.push('world digest differs from pinned input');
  if (manifest.signature.boundJourney !== manifest.journeyScope)
    reasons.push('signature journey not bound to journeyScope');
  if (manifest.signature.boundScenario !== PINNED.scenario)
    reasons.push('signature scenario not pinned');
  if (manifest.signature.boundWorldDigest !== PINNED.worldDigest)
    reasons.push('signature world digest not pinned');

  // (b) Signature.
  const recomputed = sha256(canonicalize(manifest));
  if (recomputed !== manifest.manifestDigest)
    reasons.push(
      `manifestDigest mismatch (recomputed ${recomputed.slice(0, 12)}… != stored ${manifest.manifestDigest.slice(0, 12)}…)`,
    );
  if (manifest.signature.digest !== manifest.manifestDigest)
    reasons.push('signature.digest != manifestDigest');

  // (c) Scope shape — exactly the journey's adapters, core line iff the profile journey.
  const ids = manifest.adapterLines.map((l) => l.runnerRef).sort();
  const want = [...spec.adapters].sort();
  if (ids.join(',') !== want.join(','))
    reasons.push(`journey adapter set [${ids.join(',')}] != expected [${want.join(',')}]`);
  if (spec.includesCore && !manifest.coreActivation)
    reasons.push('core-only profile journey missing the core activation line');
  if (!spec.includesCore && manifest.coreActivation)
    reasons.push('adapter journey must NOT carry a core activation line');

  // (d) Per-line digests recompute.
  for (const line of manifest.adapterLines) {
    const { lineDigest, ...rest } = line;
    if (sha256(canonicalize(rest)) !== lineDigest)
      reasons.push(`journey adapter line ${line.runnerRef} digest mismatch`);
    if (line.grantsGovernanceAuthority)
      reasons.push(`journey adapter ${line.runnerRef} GRANTS governance authority (invariant breach)`);
    if (line.evidence.length === 0) reasons.push(`journey adapter ${line.runnerRef} has no evidence`);
  }
  if (manifest.coreActivation) {
    const { lineDigest, ...rest } = manifest.coreActivation;
    if (sha256(canonicalize(rest)) !== lineDigest) reasons.push('journey core line digest mismatch');
    if (!manifest.coreActivation.requirementRefs.includes('NFR-010'))
      reasons.push('journey core line missing NFR-010');
  }

  // (e) Independence — re-derive the journey from a fresh full run; digest MUST match on-disk, and
  //     MUST differ from every OTHER journey (no two journeys share a digest).
  const rederived = projectJourneyManifest(spec);
  if (rederived.manifestDigest !== manifest.manifestDigest)
    reasons.push(
      `journey digest not reproducible (re-derived ${rederived.manifestDigest.slice(0, 12)}… != on-disk ${manifest.manifestDigest.slice(0, 12)}…)`,
    );
  for (const other of JOURNEYS) {
    if (other.scope === spec.scope) continue;
    const otherDigest = projectJourneyManifest(other).manifestDigest;
    if (otherDigest === manifest.manifestDigest)
      reasons.push(`journey ${spec.scope} shares a digest with ${other.scope} (not distinct evidence)`);
  }

  // (f) Success criteria present + met.
  if (manifest.successCriteria.length === 0) reasons.push('journey has no success criteria');
  for (const s of manifest.successCriteria)
    if (!s.met) reasons.push(`journey success criterion ${s.id} not met: ${s.measure}`);

  return { ok: reasons.length === 0, reasons };
}
