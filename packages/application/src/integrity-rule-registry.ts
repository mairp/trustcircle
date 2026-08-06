// @trustcircle/application — INTEGRITY-RULE REGISTRY: immutable rule versions, applicability,
// tests, monitoring, approval, and activation (Phase 5 / User Story 3 / FR-016).
//
// A stable integrity rule (identified by `ruleId`) accrues an APPEND-ONLY sequence of immutable
// versions, each a `IntegrityRuleVersion` domain value. The registry is the application-layer
// coordinator for that lifecycle: draft a version, attach tests/monitoring, record an approval
// decision, then ACTIVATE — where activation is fail-closed (an active version must carry ≥1 test
// and an effective_from instant, enforced by the domain factory and re-checked here so the refusal
// is an explained outcome, not a thrown exception). Superseding activation deprecates the prior
// active version so exactly one version is effective per rule at any instant.
//
// The registry is a pure, dependency-free (transitively node:crypto only) in-memory aggregate. It
// never reads the wall clock: every mutating call takes an explicit `at: EpochMillis` and an
// injected id. Every mutation is INDEPENDENTLY READABLE afterwards (`versionsOf`, `activeVersionFor`,
// `applicableRules`, `snapshotDigest`) — the mutation response is never the proof; the re-readable
// state and its content digest are. It grants NO governance authority: it records and keeps visible;
// it never deletes — deprecated/retired versions stay queryable so rule history stays reconstructable.

import { isUuid, type Uuid, type TenantId, type EpochMillis } from '@trustcircle/domain';
import {
  makeIntegrityRuleVersion,
  integrityRuleVersionDigest,
  ruleVersionEffectiveAt,
  type IntegrityRuleVersion,
  type ProblemClass,
  type Severity,
  type RuleLifecycleState,
} from '@trustcircle/domain';
import { createHash } from 'node:crypto';

export type RuleRegistryRejectionCode =
  | 'UNKNOWN_VERSION'
  | 'NOT_APPROVED'
  | 'ALREADY_ACTIVE'
  | 'TERMINAL_VERSION'
  | 'MISSING_TESTS'
  | 'MISSING_EFFECTIVE_FROM'
  | 'INVARIANT_VIOLATION';

export interface RuleRegistryOutcome {
  readonly accepted: boolean;
  readonly version: IntegrityRuleVersion | null;
  readonly rejectionCode: RuleRegistryRejectionCode | null;
}

/** A predicate a caller supplies to decide whether a rule version applies to a source record. */
export interface Applicability {
  readonly sourceTypes?: readonly string[];
  readonly recordKinds?: readonly string[];
}

function accept(v: IntegrityRuleVersion): RuleRegistryOutcome {
  return { accepted: true, version: v, rejectionCode: null };
}

function reject(code: RuleRegistryRejectionCode): RuleRegistryOutcome {
  return { accepted: false, version: null, rejectionCode: code };
}

export class IntegrityRuleRegistry {
  readonly #tenantId: TenantId;
  // id → version value (append-only; deprecated/retired retained).
  readonly #byId = new Map<Uuid, IntegrityRuleVersion>();
  // ruleId → ordered version numbers seen (to compute the next version).
  readonly #versionsByRule = new Map<Uuid, IntegrityRuleVersion[]>();

  constructor(tenantId: TenantId) {
    this.#tenantId = tenantId;
  }

  /** Draft a new immutable version for `ruleId`. The version number is derived (max + 1). */
  draftVersion(input: {
    id: Uuid;
    ruleId: Uuid;
    problemClass: ProblemClass;
    ownerPrincipalId: Uuid;
    severity?: Severity;
    applicability?: Applicability;
    detectionQuery?: Record<string, unknown>;
    confidenceModel?: Record<string, unknown>;
    quarantineCondition?: Record<string, unknown>;
    lowRiskRepairEligible?: boolean;
    tests?: readonly Record<string, unknown>[];
    monitoring?: readonly Record<string, unknown>[];
    policyControlMappings?: readonly Record<string, unknown>[];
    at: EpochMillis;
  }): RuleRegistryOutcome {
    const existing = this.#versionsByRule.get(input.ruleId) ?? [];
    const nextVersion = existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;
    let v: IntegrityRuleVersion;
    try {
      v = makeIntegrityRuleVersion({
        id: input.id,
        tenantId: this.#tenantId,
        ruleId: input.ruleId,
        version: nextVersion,
        problemClass: input.problemClass,
        ownerPrincipalId: input.ownerPrincipalId,
        ...(input.severity !== undefined ? { severity: input.severity } : {}),
        ...(input.applicability !== undefined
          ? { applicability: input.applicability as Record<string, unknown> }
          : {}),
        ...(input.detectionQuery !== undefined ? { detectionQuery: input.detectionQuery } : {}),
        ...(input.confidenceModel !== undefined ? { confidenceModel: input.confidenceModel } : {}),
        ...(input.quarantineCondition !== undefined
          ? { quarantineCondition: input.quarantineCondition }
          : {}),
        ...(input.lowRiskRepairEligible !== undefined
          ? { lowRiskRepairEligible: input.lowRiskRepairEligible }
          : {}),
        ...(input.tests !== undefined ? { tests: input.tests } : {}),
        ...(input.monitoring !== undefined ? { monitoring: input.monitoring } : {}),
        ...(input.policyControlMappings !== undefined
          ? { policyControlMappings: input.policyControlMappings }
          : {}),
        lifecycleState: 'draft',
        createdAt: input.at,
      });
    } catch {
      return reject('INVARIANT_VIOLATION');
    }
    this.#store(v);
    return accept(v);
  }

  /** Record an approval decision against a draft/proposed version (moves it to `proposed`). */
  approveVersion(input: {
    versionId: Uuid;
    approvalDecisionId: Uuid;
    at: EpochMillis;
  }): RuleRegistryOutcome {
    const current = this.#byId.get(input.versionId);
    if (current === undefined) return reject('UNKNOWN_VERSION');
    if (current.lifecycleState === 'deprecated' || current.lifecycleState === 'retired') {
      return reject('TERMINAL_VERSION');
    }
    if (current.lifecycleState === 'active') return reject('ALREADY_ACTIVE');
    const next = this.#rebuild(current, {
      approvalDecisionId: input.approvalDecisionId,
      lifecycleState: 'proposed',
    });
    if (next === null) return reject('INVARIANT_VIOLATION');
    this.#store(next);
    return accept(next);
  }

  /**
   * Activate an APPROVED (proposed) version. Fail-closed: the version must carry ≥1 test, an
   * approval decision, and be activated with an effective_from instant. Any prior active version of
   * the same rule is deprecated (superseded) so exactly one version is effective at a time.
   */
  activateVersion(input: {
    versionId: Uuid;
    effectiveFrom: EpochMillis;
    at: EpochMillis;
  }): RuleRegistryOutcome {
    const current = this.#byId.get(input.versionId);
    if (current === undefined) return reject('UNKNOWN_VERSION');
    if (current.lifecycleState === 'deprecated' || current.lifecycleState === 'retired') {
      return reject('TERMINAL_VERSION');
    }
    if (current.lifecycleState === 'active') return reject('ALREADY_ACTIVE');
    if (current.approvalDecisionId === undefined) return reject('NOT_APPROVED');
    if (current.tests.length < 1) return reject('MISSING_TESTS');
    const next = this.#rebuild(current, {
      lifecycleState: 'active',
      effectiveFrom: input.effectiveFrom,
    });
    if (next === null) return reject('INVARIANT_VIOLATION');
    // Supersede the prior active version of the same rule (deprecate, retain history).
    for (const v of this.#versionsByRule.get(current.ruleId) ?? []) {
      if (v.id !== current.id && v.lifecycleState === 'active') {
        const dep = this.#rebuild(v, {
          lifecycleState: 'deprecated',
          effectiveTo: input.effectiveFrom,
        });
        if (dep !== null) this.#store(dep);
      }
    }
    this.#store(next);
    return accept(next);
  }

  /** Retire a version (terminal; retained for history). */
  retireVersion(input: { versionId: Uuid; at: EpochMillis }): RuleRegistryOutcome {
    const current = this.#byId.get(input.versionId);
    if (current === undefined) return reject('UNKNOWN_VERSION');
    if (current.lifecycleState === 'retired') return reject('TERMINAL_VERSION');
    const next = this.#rebuild(current, {
      lifecycleState: 'retired',
      effectiveTo: current.effectiveTo ?? input.at,
    });
    if (next === null) return reject('INVARIANT_VIOLATION');
    this.#store(next);
    return accept(next);
  }

  // ---- queries (independent read surface) --------------------------------

  versionsOf(ruleId: Uuid): readonly IntegrityRuleVersion[] {
    return Object.freeze([...(this.#versionsByRule.get(ruleId) ?? [])]);
  }

  getVersion(versionId: Uuid): IntegrityRuleVersion | undefined {
    return this.#byId.get(versionId);
  }

  /** The single active version currently effective for `ruleId` at `now` (or undefined). */
  activeVersionFor(ruleId: Uuid, now: EpochMillis): IntegrityRuleVersion | undefined {
    for (const v of this.#versionsByRule.get(ruleId) ?? []) {
      if (ruleVersionEffectiveAt(v, now)) return v;
    }
    return undefined;
  }

  /**
   * Every ACTIVE, currently-effective rule version whose applicability matches the given source
   * record descriptor. This is the detector's rule-selection surface — it never returns a
   * non-effective version, so a retired/deprecated rule cannot silently classify production.
   */
  applicableRules(descriptor: {
    sourceType: string;
    recordKind: string;
    now: EpochMillis;
  }): readonly IntegrityRuleVersion[] {
    const out: IntegrityRuleVersion[] = [];
    for (const v of this.#byId.values()) {
      if (!ruleVersionEffectiveAt(v, descriptor.now)) continue;
      if (this.#applies(v, descriptor.sourceType, descriptor.recordKind)) out.push(v);
    }
    return Object.freeze(out);
  }

  /** A content digest over the whole registry — the independent durable-effect witness. */
  snapshotDigest(): string {
    const ids = [...this.#byId.keys()].sort();
    const digests = ids.map((id) => integrityRuleVersionDigest(this.#byId.get(id)!));
    return createHash('sha256')
      .update(JSON.stringify({ tenantId: this.#tenantId, versions: digests }))
      .digest('hex');
  }

  // ---- internals ---------------------------------------------------------

  #store(v: IntegrityRuleVersion): void {
    this.#byId.set(v.id, v);
    const list = this.#versionsByRule.get(v.ruleId) ?? [];
    const idx = list.findIndex((x) => x.id === v.id);
    if (idx >= 0) list[idx] = v;
    else list.push(v);
    list.sort((a, b) => a.version - b.version);
    this.#versionsByRule.set(v.ruleId, list);
  }

  /** Rebuild an immutable version with a lifecycle mutation, re-running the domain invariants. */
  #rebuild(
    current: IntegrityRuleVersion,
    patch: {
      approvalDecisionId?: Uuid;
      lifecycleState?: RuleLifecycleState;
      effectiveFrom?: EpochMillis;
      effectiveTo?: EpochMillis;
    },
  ): IntegrityRuleVersion | null {
    try {
      return makeIntegrityRuleVersion({
        id: current.id,
        tenantId: current.tenantId,
        ruleId: current.ruleId,
        version: current.version,
        problemClass: current.problemClass,
        applicability: current.applicability as Record<string, unknown>,
        detectionQuery: current.detectionQuery as Record<string, unknown>,
        severity: current.severity,
        confidenceModel: current.confidenceModel as Record<string, unknown>,
        quarantineCondition: current.quarantineCondition as Record<string, unknown>,
        lowRiskRepairEligible: current.lowRiskRepairEligible,
        tests: current.tests as readonly Record<string, unknown>[],
        monitoring: current.monitoring as readonly Record<string, unknown>[],
        policyControlMappings: current.policyControlMappings as readonly Record<string, unknown>[],
        ownerPrincipalId: current.ownerPrincipalId,
        ...(patch.approvalDecisionId !== undefined
          ? { approvalDecisionId: patch.approvalDecisionId }
          : current.approvalDecisionId !== undefined
            ? { approvalDecisionId: current.approvalDecisionId }
            : {}),
        lifecycleState: patch.lifecycleState ?? current.lifecycleState,
        ...(patch.effectiveFrom !== undefined
          ? { effectiveFrom: patch.effectiveFrom }
          : current.effectiveFrom !== undefined
            ? { effectiveFrom: current.effectiveFrom }
            : {}),
        ...(patch.effectiveTo !== undefined
          ? { effectiveTo: patch.effectiveTo }
          : current.effectiveTo !== undefined
            ? { effectiveTo: current.effectiveTo }
            : {}),
        createdAt: current.createdAt,
      });
    } catch {
      return null;
    }
  }

  #applies(v: IntegrityRuleVersion, sourceType: string, recordKind: string): boolean {
    const app = v.applicability as Applicability;
    const types = app.sourceTypes;
    const kinds = app.recordKinds;
    // An empty applicability applies universally; a present list must contain the descriptor.
    if (Array.isArray(types) && types.length > 0 && !types.includes(sourceType)) return false;
    if (Array.isArray(kinds) && kinds.length > 0 && !kinds.includes(recordKind)) return false;
    return true;
  }
}

/** Narrow guard used by callers building descriptors (defence in depth on ids). */
export function isRuleId(x: unknown): x is Uuid {
  return isUuid(x);
}
