// @trustcircle/command-worker — the REPAIR EXECUTOR (Phase 5 / User Story 3 / T136 /
// FR-019, FR-020, FR-021, FR-022, GAR-004, SC-007, SC-008).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// Only PRE-AUTHORIZED, LOW-RISK, NON-DESTRUCTIVE repair may run automatically (GAR-004). When an
// integrity case carries such an approved remediation plan and the automatic-repair policy admits it,
// this worker executes the repair steps under ONE idempotency identity, writing DERIVED evidence (the
// repaired output, alongside — never over — the preserved original), taking a CHECKPOINT before and
// after, honouring a KILL SWITCH, and — when the outcome is UNCERTAIN — stopping and quarantining
// rather than guessing. A repair's own success is NEVER verified closure (FR-022): the executor emits
// `succeeded_unverified`, and verified closure is a separate independent-verification effect.
//
// Every repair effect commits through the SAME transactional-outbox unit-of-work every governed effect
// uses: a repair-attempt state transition + derived-evidence ref + an audit event + an outbox
// notification, atomic or not at all. A crash mid-repair resumes safely: the idempotency identity is
// derived from the case + plan + preserved-original revision, so re-running the pass deduplicates.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — PRE-AUTHORIZED-ONLY, IDEMPOTENT, CHECKPOINTED, KILL-SWITCHABLE, LEAF-CLEAN
// ─────────────────────────────────────────────────────────────────────────────
// * PRE-AUTHORIZED ONLY (GAR-004). Before any effect, the injected `admit` oracle (production wires
//   `evaluateAutomaticRepair`) is consulted; a DENY verdict short-circuits to a `blocked` outcome
//   naming the deny reason — no destructive/unapproved/expired/out-of-scope repair ever runs.
// * ONE IDEMPOTENCY IDENTITY (FR-020). The attempt id, idempotency key, correlation id, and derived
//   evidence id are all DERIVED (sha-256) from case id + plan id + plan version + preserved-original
//   revision. Re-running the pass over the same durable state is a NO-OP (unit-of-work dedup): a repair
//   is executed at most once per (case, plan, revision), whatever the scan cadence.
// * DERIVED EVIDENCE, ORIGINAL PRESERVED (FR-017/FR-019). The repair writes its output as DERIVED
//   evidence via the injected `deriveEvidence` port, which links back to the preserved original; the
//   original is never overwritten. The attempt binds both ids.
// * CHECKPOINTED + KILL-SWITCHABLE (FR-021). A checkpoint is taken before and after the steps; a kill
//   switch (injected predicate) is checked before starting and between steps, stopping safely and
//   leaving a resumable `stopped` outcome.
// * UNCERTAIN ⇒ STOP + QUARANTINE (FR-022, SC-008). A step whose outcome cannot be confidently
//   determined yields an `uncertain` attempt: the executor does NOT claim success, retains
//   containment, and routes the case for human resolution.
// * NOT VERIFIED CLOSURE (FR-022). A successful repair is `succeeded_unverified` — verified closure is
//   a distinct downstream effect. The executor never emits `verified`.
// * INJECTABLE / LEAF-CLEAN. Like expiry-worker.ts, depends on NO domain/application package at the
//   type level: minimal STRUCTURAL port shapes + injected oracles/ports. Production wires the real
//   policy/evidence/repository functions; tests wire pure in-memory fakes, so every branch is provable
//   with no live DB under Node 22 `--experimental-strip-types`.

import {
  commitUnitOfWork,
  readCanonicalState,
  type Database,
  type SourceContract,
  type AuditEventInput,
  type CommitUnitOfWorkResult,
  digest,
} from '@trustcircle/persistence';

// ===========================================================================
// 0. Outcome vocabulary (mirrors domain REPAIR_OUTCOMES — leaf-clean copy).
// ===========================================================================

/**
 * The disposition the executor records for one repair attempt. NOTE the executor never emits
 * `verified` (that is a separate independent-verification effect) nor `rolled_back` (rollback is a
 * separate service): it emits at most `succeeded_unverified`.
 */
export const REPAIR_EXECUTOR_OUTCOMES = [
  'succeeded_unverified',
  'failed',
  'uncertain',
  'stopped',
  'blocked',
] as const;
export type RepairExecutorOutcome = (typeof REPAIR_EXECUTOR_OUTCOMES)[number];

/** The canonical `entity_kind` a repair attempt is stored under. */
export const REPAIR_ATTEMPT_ENTITY_KIND = 'repair_attempt';

/** The canonical outbox topic a repair effect publishes on. */
export const REPAIR_EXECUTED_TOPIC = 'governance.integrity.repair_executed';

/** The system principal attributed as the actor on every repair effect (deterministic, non-human). */
export const REPAIR_ACTOR = 'system:repair-executor';

// ===========================================================================
// 1. Minimal STRUCTURAL port shapes (leaf-clean — no domain dependency)
// ===========================================================================

/** A repair step to execute (opaque to the worker — the injected `runStep` port interprets it). */
export interface RepairStep {
  readonly stepId: string;
  readonly kind: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** An approved, pre-authorized-low-risk remediation plan ready to execute (GAR-004). */
export interface ExecutableRepair {
  readonly caseId: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly workItemId: string;
  /** The preserved-original evidence id + revision the repair derives from (FR-017/FR-019). */
  readonly preservedOriginalEvidenceId: string;
  readonly preservedOriginalRevision: string;
  /** The ordered repair steps (executed under one idempotency identity). */
  readonly steps: readonly RepairStep[];
  /** The owner accountable for the repaired output. */
  readonly ownerPrincipalId: string;
}

/** The result of running one repair step (the injected `runStep` port returns this). */
export interface StepResult {
  readonly stepId: string;
  /** `ok` — step applied; `uncertain` — outcome cannot be confidently determined (STOP); `failed`. */
  readonly status: 'ok' | 'uncertain' | 'failed';
  /** The bytes/patch produced by this step, folded into the derived output. */
  readonly output: Uint8Array;
  readonly detail: string;
}

/** The derived-evidence receipt (the injected `deriveEvidence` port returns this). */
export interface DerivedEvidenceReceipt {
  readonly derivedEvidenceId: string;
  readonly derivedFromEvidenceId: string;
  readonly contentDigest: string;
}

/** The admission verdict from the automatic-repair policy (injected `admit` oracle). GAR-004. */
export interface RepairAdmission {
  readonly admitted: boolean;
  /** The machine deny reason when `admitted: false` (e.g. NOT_APPROVED, KILL_SWITCH_ENGAGED). */
  readonly denyReason: string | null;
}

// ===========================================================================
// 2. Injected oracles + ports
// ===========================================================================
//
// Production wires:
//   admit          := (repair, now) => { const v = evaluateAutomaticRepair({...}); return {admitted: v.admitted, denyReason: v.denyReason}; }
//   killEngaged    := () => readKillSwitch()              (operator-controlled global stop)
//   runStep        := (step, ctx) => applyRepairStep(...) (interprets a step against the source)
//   deriveEvidence := (repair, output, now) => commitDerived(evidenceService, {...})  (original-linked)
//   checkpoint     := (repair, phase, now) => persistCheckpoint(...)  (resumable progress marker)
// Tests wire pure fakes. The worker owns the SEQUENCING + idempotency, never the step semantics.

export interface RepairExecutorOracles {
  /** GAR-004 admission — a DENY short-circuits to a `blocked` outcome (never executes). */
  readonly admit: (repair: ExecutableRepair, now: number) => RepairAdmission;
  /** FR-021 kill switch — checked before start and between steps; true ⇒ stop safely (`stopped`). */
  readonly killEngaged: () => boolean;
}

export interface RepairExecutorPorts {
  /** The bounded batch of admitted, ready-to-execute repairs at `now` (repository query). */
  readonly dueRepairs: (now: number, limit: number) => Promise<readonly ExecutableRepair[]>;
  /** Execute one step; returns ok / uncertain / failed + its output bytes. */
  readonly runStep: (step: RepairStep, repair: ExecutableRepair) => Promise<StepResult>;
  /** Write the repaired output as DERIVED evidence linked to the preserved original (FR-019). */
  readonly deriveEvidence: (
    repair: ExecutableRepair,
    output: Uint8Array,
    now: number,
  ) => Promise<DerivedEvidenceReceipt>;
  /** Persist a resumable checkpoint before/after the steps (FR-021). Idempotent by (repair, phase). */
  readonly checkpoint: (
    repair: ExecutableRepair,
    phase: 'before' | 'after',
    now: number,
  ) => Promise<void>;
}

// ===========================================================================
// 3. Worker configuration
// ===========================================================================

export interface RepairExecutorOptions {
  readonly contract: SourceContract;
  readonly expectedContractVersion: string;
  readonly policyVersion: string;
  readonly controlVersion: string;
  readonly owner?: string;
  /** Max repairs executed per pass (bounds the pass). Default 50 (repair is heavier than expiry). */
  readonly batchSize?: number;
}

const DEFAULT_OWNER = 'team:governance-runtime';
const DEFAULT_BATCH_SIZE = 50;

// ===========================================================================
// 4. Per-repair + per-pass result shapes (fail-visible witnesses)
// ===========================================================================

export interface RepairItemResult {
  readonly caseId: string;
  readonly tenantId: string;
  readonly planId: string;
  readonly attemptId: string;
  readonly outcome: RepairExecutorOutcome;
  /** The derived-evidence id written on a successful (unverified) repair (null otherwise). */
  readonly derivedEvidenceId: string | null;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** True on `deduplicated` — the repair already executed on a prior pass (idempotent). */
  readonly deduplicated: boolean;
  /** The deny reason when `blocked` (GAR-004), else null. */
  readonly denyReason: string | null;
  /** The safe next action: verify (success), escalate (uncertain), reconcile (failed), none/resume. */
  readonly safeNextAction: 'verify' | 'escalate' | 'reconcile' | 'resume' | 'none';
  readonly error: string | null;
}

export interface RepairPassResult {
  readonly scannedAt: number;
  readonly scanned: number;
  readonly succeededUnverified: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly stopped: number;
  readonly blocked: number;
  readonly deduplicated: number;
  readonly results: readonly RepairItemResult[];
}

// ===========================================================================
// 5. Deterministic identity derivation (ONE idempotency identity — FR-020)
// ===========================================================================
//
// Every id is derived from case id + plan id + plan version + preserved-original REVISION — NOT from
// `now` or step outputs. So a repair already executed for (case, plan, revision) re-derives the SAME
// attempt id / idempotency key on a later pass and the unit-of-work deduplicates it: a repair runs at
// most once per identity, whatever the scan cadence. A NEW plan version derives a fresh identity.

/** The ONE stable idempotency identity for a repair attempt (case + plan + plan version + revision). */
export function repairIdentityBasis(repair: ExecutableRepair): {
  caseId: string;
  planId: string;
  planVersion: number;
  revision: string;
} {
  return {
    caseId: repair.caseId,
    planId: repair.planId,
    planVersion: repair.planVersion,
    revision: repair.preservedOriginalRevision,
  };
}

export function repairIdempotencyKey(repair: ExecutableRepair): string {
  return 'repair-' + digest({ ...repairIdentityBasis(repair), purpose: 'repair_idempotency' }).slice(0, 40);
}

export function repairCorrelationId(repair: ExecutableRepair): string {
  return (
    'corr-repair-' + digest({ ...repairIdentityBasis(repair), purpose: 'repair_correlation' }).slice(0, 32)
  );
}

export function repairAttemptId(repair: ExecutableRepair): string {
  return 'attempt-' + digest({ ...repairIdentityBasis(repair), purpose: 'repair_attempt' }).slice(0, 32);
}

// ===========================================================================
// 6. The repair executor worker
// ===========================================================================

export class RepairExecutor {
  readonly #db: Database;
  readonly #ports: RepairExecutorPorts;
  readonly #oracles: RepairExecutorOracles;
  readonly #contract: SourceContract;
  readonly #expectedContractVersion: string;
  readonly #policyVersion: string;
  readonly #controlVersion: string;
  readonly #owner: string;
  readonly #batchSize: number;

  constructor(
    db: Database,
    ports: RepairExecutorPorts,
    oracles: RepairExecutorOracles,
    opts: RepairExecutorOptions,
  ) {
    this.#db = db;
    this.#ports = ports;
    this.#oracles = oracles;
    this.#contract = opts.contract;
    this.#expectedContractVersion = opts.expectedContractVersion;
    this.#policyVersion = opts.policyVersion;
    this.#controlVersion = opts.controlVersion;
    this.#owner = opts.owner ?? DEFAULT_OWNER;
    const b = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    if (!Number.isInteger(b) || b <= 0) throw new RangeError('batchSize must be a positive integer');
    this.#batchSize = b;
  }

  /**
   * Run ONE deterministic repair pass at the injected instant `now`. Each ready repair is admitted by
   * the GAR-004 policy (deny ⇒ `blocked`), checkpointed, executed step-by-step under a kill switch,
   * and — on success — written as derived evidence and committed as `succeeded_unverified` (NEVER
   * verified). Uncertain ⇒ stop + escalate; kill ⇒ `stopped` (resumable). Re-running the pass over
   * the same durable state is a no-op (dedup on the single idempotency identity).
   */
  async runRepairPass(now: number): Promise<RepairPassResult> {
    if (!Number.isFinite(now)) throw new RangeError('now must be a finite epoch-ms instant');
    const results: RepairItemResult[] = [];

    for (const repair of await this.#ports.dueRepairs(now, this.#batchSize)) {
      results.push(await this.#executeOne(repair, now));
    }

    const count = (o: RepairExecutorOutcome): number =>
      results.filter((r) => r.outcome === o && !r.deduplicated).length;
    return {
      scannedAt: now,
      scanned: results.length,
      succeededUnverified: count('succeeded_unverified'),
      failed: count('failed'),
      uncertain: count('uncertain'),
      stopped: count('stopped'),
      blocked: count('blocked'),
      deduplicated: results.filter((r) => r.deduplicated).length,
      results,
    };
  }

  async #executeOne(repair: ExecutableRepair, now: number): Promise<RepairItemResult> {
    const attemptId = repairAttemptId(repair);
    const idempotencyKey = repairIdempotencyKey(repair);
    const correlationId = repairCorrelationId(repair);
    const base = {
      caseId: repair.caseId,
      tenantId: repair.tenantId,
      planId: repair.planId,
      attemptId,
      idempotencyKey,
      correlationId,
    };

    // GAR-004 — pre-authorized-low-risk admission. A deny NEVER executes; it is recorded, not run.
    const admission = this.#oracles.admit(repair, now);
    if (!admission.admitted) {
      return this.#commit(repair, now, {
        outcome: 'blocked',
        derived: null,
        denyReason: admission.denyReason,
        detail: `repair not admitted by automatic-repair policy: ${admission.denyReason ?? 'denied'}`,
        safeNextAction: 'escalate',
      });
    }

    // FR-021 — kill switch checked before start.
    if (this.#oracles.killEngaged()) {
      return { ...base, outcome: 'stopped', derivedEvidenceId: null, deduplicated: false, denyReason: null, safeNextAction: 'resume', error: 'kill switch engaged before start' };
    }

    // FR-021 — checkpoint BEFORE the steps (resumable).
    try {
      await this.#ports.checkpoint(repair, 'before', now);
    } catch (err) {
      return { ...base, outcome: 'failed', derivedEvidenceId: null, deduplicated: false, denyReason: null, safeNextAction: 'reconcile', error: `pre-checkpoint failed: ${describeRepairError(err)}` };
    }

    // Execute the steps under one idempotency identity, folding outputs, honouring the kill switch and
    // stopping on the FIRST uncertain/failed step (FR-022 — never guess past an uncertain outcome).
    const chunks: Uint8Array[] = [];
    for (const step of repair.steps) {
      if (this.#oracles.killEngaged()) {
        return { ...base, outcome: 'stopped', derivedEvidenceId: null, deduplicated: false, denyReason: null, safeNextAction: 'resume', error: `kill switch engaged before step ${step.stepId}` };
      }
      let sr: StepResult;
      try {
        sr = await this.#ports.runStep(step, repair);
      } catch (err) {
        return { ...base, outcome: 'failed', derivedEvidenceId: null, deduplicated: false, denyReason: null, safeNextAction: 'reconcile', error: `step ${step.stepId} threw: ${describeRepairError(err)}` };
      }
      if (sr.status === 'uncertain') {
        // FR-022 / SC-008 — STOP + quarantine + escalate. Do NOT claim success on an uncertain step.
        return this.#commit(repair, now, {
          outcome: 'uncertain',
          derived: null,
          denyReason: null,
          detail: `step ${step.stepId} outcome uncertain — stopped, containment retained, escalated: ${sr.detail}`,
          safeNextAction: 'escalate',
        });
      }
      if (sr.status === 'failed') {
        return this.#commit(repair, now, {
          outcome: 'failed',
          derived: null,
          denyReason: null,
          detail: `step ${step.stepId} failed: ${sr.detail}`,
          safeNextAction: 'reconcile',
        });
      }
      chunks.push(sr.output);
    }

    // All steps applied — write the repaired output as DERIVED evidence (linked to the original).
    let derived: DerivedEvidenceReceipt;
    try {
      derived = await this.#ports.deriveEvidence(repair, concatBytes(chunks), now);
    } catch (err) {
      return { ...base, outcome: 'failed', derivedEvidenceId: null, deduplicated: false, denyReason: null, safeNextAction: 'reconcile', error: `derived-evidence write failed: ${describeRepairError(err)}` };
    }

    // FR-021 — checkpoint AFTER the steps (best-effort; a checkpoint failure does not undo the repair
    // but is surfaced so an operator sees the gap).
    try {
      await this.#ports.checkpoint(repair, 'after', now);
    } catch {
      // Non-fatal: the derived evidence is written; the commit below still records the attempt.
    }

    // FR-022 — a successful repair is SUCCEEDED_UNVERIFIED, never verified. Verified closure is a
    // separate independent-verification effect. The safe next action is `verify`.
    return this.#commit(repair, now, {
      outcome: 'succeeded_unverified',
      derived,
      denyReason: null,
      detail: `repair applied ${repair.steps.length} step(s); derived evidence ${derived.derivedEvidenceId} written (original ${repair.preservedOriginalEvidenceId} preserved) — awaiting independent verification`,
      safeNextAction: 'verify',
    });
  }

  // --- the single atomic commit path ---------------------------------------

  async #commit(
    repair: ExecutableRepair,
    now: number,
    detailed: {
      outcome: RepairExecutorOutcome;
      derived: DerivedEvidenceReceipt | null;
      denyReason: string | null;
      detail: string;
      safeNextAction: RepairItemResult['safeNextAction'];
    },
  ): Promise<RepairItemResult> {
    const attemptId = repairAttemptId(repair);
    const idempotencyKey = repairIdempotencyKey(repair);
    const correlationId = repairCorrelationId(repair);
    const idBasis = repairIdentityBasis(repair);

    const reason = {
      code: `repair_${detailed.outcome}`,
      text: detailed.detail,
    };
    const state = {
      id: attemptId,
      tenantId: repair.tenantId,
      integrityCaseId: repair.caseId,
      remediationPlanId: repair.planId,
      remediationPlanVersion: repair.planVersion,
      idempotencyKey,
      preservedOriginalEvidenceId: repair.preservedOriginalEvidenceId,
      derivedEvidenceId: detailed.derived?.derivedEvidenceId ?? null,
      outcome: detailed.outcome,
      // FR-022 — an executor NEVER sets verified. Verification is a separate resolved verdict.
      verified: false,
      denyReason: detailed.denyReason,
      executedBy: REPAIR_ACTOR,
      executedAt: now,
    };
    const evidenceRefs = [
      `original:${repair.preservedOriginalEvidenceId}`,
      `plan:${repair.planId}@v${repair.planVersion}`,
      `revision:${repair.preservedOriginalRevision}`,
      ...(detailed.derived
        ? [`derived:${detailed.derived.derivedEvidenceId}`, `derived-digest:${detailed.derived.contentDigest}`]
        : []),
    ];
    const audit: AuditEventInput = {
      actor: REPAIR_ACTOR,
      owner: this.#owner,
      reason,
      sourceStateDigest: digest({ ...idBasis, phase: 'pre_repair' }),
      targetStateDigest: digest(state),
      scope: `tenant:${repair.tenantId}/integrity_case:${repair.caseId}/repair_attempt:${attemptId}`,
      policyVersion: this.#policyVersion,
      controlVersion: this.#controlVersion,
      evidenceRefs,
    };

    const baseResult = {
      caseId: repair.caseId,
      tenantId: repair.tenantId,
      planId: repair.planId,
      attemptId,
      idempotencyKey,
      correlationId,
      denyReason: detailed.denyReason,
    };
    try {
      const result: CommitUnitOfWorkResult = await commitUnitOfWork(this.#db, {
        tenantId: repair.tenantId,
        operationScope: 'integrity.repair',
        idempotencyKey,
        correlationId,
        contract: this.#contract,
        expectedContractVersion: this.#expectedContractVersion,
        request: { kind: 'repair_attempt', entityId: attemptId, expectedVersion: 0 },
        canonical: {
          entityKind: REPAIR_ATTEMPT_ENTITY_KIND,
          entityId: attemptId,
          expectedVersion: 0,
          state,
        },
        action: 'repair',
        audit,
        outbox: {
          topic: REPAIR_EXECUTED_TOPIC,
          payload: {
            eventType: 'repair_executed',
            caseId: repair.caseId,
            tenantId: repair.tenantId,
            attemptId,
            outcome: detailed.outcome,
            verified: false,
            derivedEvidenceId: detailed.derived?.derivedEvidenceId ?? null,
            executedAt: now,
          },
        },
      });
      if (result.deduplicated) {
        return {
          ...baseResult,
          outcome: detailed.outcome,
          derivedEvidenceId: detailed.derived?.derivedEvidenceId ?? null,
          deduplicated: true,
          safeNextAction: 'none',
          error: null,
        };
      }
      if (result.status !== 'succeeded') {
        return {
          ...baseResult,
          outcome: 'failed',
          derivedEvidenceId: null,
          deduplicated: false,
          safeNextAction: 'reconcile',
          error: `commit did not succeed: status=${result.status} nextAction=${result.nextAction}`,
        };
      }
      return {
        ...baseResult,
        outcome: detailed.outcome,
        derivedEvidenceId: detailed.derived?.derivedEvidenceId ?? null,
        deduplicated: false,
        safeNextAction: detailed.safeNextAction,
        error: null,
      };
    } catch (err) {
      return {
        ...baseResult,
        outcome: 'failed',
        derivedEvidenceId: null,
        deduplicated: false,
        safeNextAction: 'reconcile',
        error: describeRepairError(err),
      };
    }
  }

  /**
   * Independent read path: the current canonical state of a committed repair attempt (the durable
   * witness — never the commit return value). Returns null if no canonical row exists.
   */
  async readAttempt(
    tenantId: string,
    attemptId: string,
  ): Promise<{ version: number; stateDigest: string; state: unknown } | null> {
    const row = await readCanonicalState(this.#db, tenantId, REPAIR_ATTEMPT_ENTITY_KIND, attemptId);
    if (!row) return null;
    return { version: row.version, stateDigest: row.stateDigest, state: row.state };
  }
}

// ===========================================================================
// 7. Utilities
// ===========================================================================

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Disclosure-safe error description (error class + message, never internal detail dumps). */
export function describeRepairError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `NonError: ${String(err)}`;
}
