// @trustcircle/command-worker — the INTEGRITY DETECTOR (Phase 5 / User Story 3 / T130 /
// FR-016, FR-017, FR-018, SC-006).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ─────────────────────────────────────────────────────────────────────────────
// New and changed governance source records must be evaluated for DAMAGE — malformed structure,
// corrupted content, unsafe duplication, staleness, conflicting facts, orphaned ownership — and,
// when a defect is detected, the raw ORIGINAL must be preserved (FR-017) and an integrity CASE
// opened BEFORE anything downstream (classification, quarantine, repair) runs. This worker is the
// deterministic sweep that scans a bounded batch of new/changed source records at an injected
// instant and, for each record a detection ORACLE flags as damaged, commits exactly ONE detection
// effect through the SAME transactional-outbox unit-of-work every governed effect uses: preserve the
// original → open the integrity case → audit → outbox notification, atomic or not at all.
//
// It NEVER classifies, quarantines, or repairs — those are separate governed effects owned by the
// application services and the repair executor. It answers one question per record: "is this damaged,
// and if so, has its original been preserved and a case opened?" — fail-closed, audited, idempotent.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN — DETERMINISTIC, PRESERVATION-FIRST, AUDITED, INJECTABLE, LEAF-CLEAN
// ─────────────────────────────────────────────────────────────────────────────
// * DETERMINISTIC. The worker reads NO wall clock. The scan instant (`now`) is injected per pass;
//   every idempotency key, correlation id, case id, and evidence id is DERIVED (sha-256 digest) from
//   the record identity + the source revision it was read at, so re-running a pass over the same
//   durable state is a NO-OP (the unit-of-work deduplicates on the stable key). A record already
//   detected at revision R is never re-opened for the same R.
// * PRESERVATION-FIRST (FR-017). The detection effect binds the original evidence id BEFORE the case
//   is opened; the injected `preserveOriginal` port is called first and its receipt is threaded onto
//   the case. A record whose original cannot be preserved is FAILED-VISIBLE, never classified.
// * AUDITED. Every detection commits an audit event carrying actor=`system:integrity-detector`, the
//   accountable owner, a structured reason naming the defect classes, source/target digests, and the
//   preserved-original evidence ref — the audit-completeness gate refuses an incomplete one.
// * FAIL-VISIBLE. A per-record outcome (`opened` | `clean` | `deduplicated` | `failed`) is returned;
//   a commit or preservation failure is captured, counted, and surfaced (never swallowed).
// * INJECTABLE / LEAF-CLEAN. Like expiry-worker.ts, this module depends on NO domain/application
//   package at the type level: it defines minimal STRUCTURAL port shapes and takes the detection
//   ORACLE + the preservation port + the read port as INJECTED functions. Production wires the real
//   detector oracle, `preserveOriginal`, and repositories; tests wire pure in-memory fakes, so every
//   branch is provable with no live DB under Node 22 `--experimental-strip-types`.

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
// 0. The defect classes (mirror the domain PROBLEM_CLASSES — leaf-clean copy).
// ===========================================================================

/** The problem classes the detector evaluates each record against (mirrors domain). */
export const DETECTABLE_PROBLEM_CLASSES = [
  'malformed',
  'corrupted',
  'duplicated',
  'stale',
  'conflicting',
  'orphaned',
  'combined',
  'unknown',
] as const;
export type DetectableProblemClass = (typeof DETECTABLE_PROBLEM_CLASSES)[number];

export const DETECTOR_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type DetectorSeverity = (typeof DETECTOR_SEVERITIES)[number];

export const DETECTOR_SAFETY_IMPACTS = ['none', 'low', 'moderate', 'high', 'catastrophic'] as const;
export type DetectorSafetyImpact = (typeof DETECTOR_SAFETY_IMPACTS)[number];

/** The canonical `entity_kind` an integrity case is stored under. */
export const INTEGRITY_CASE_ENTITY_KIND = 'integrity_case';

/** The canonical outbox topic a detection effect publishes on. */
export const INTEGRITY_DETECTED_TOPIC = 'governance.integrity.detected';

/** The system principal attributed as the actor on every detection effect (deterministic, non-human). */
export const DETECTOR_ACTOR = 'system:integrity-detector';

// ===========================================================================
// 1. Minimal STRUCTURAL port shapes (leaf-clean — no domain dependency)
// ===========================================================================

/** A new or changed source record to evaluate for damage. */
export interface DetectableRecord {
  readonly recordId: string;
  readonly tenantId: string;
  readonly workItemId: string;
  readonly sourceType: string;
  readonly recordKind: string;
  /** The source revision the record was read at (drift-detection basis + idempotency basis). */
  readonly sourceRevision: string;
  /** The raw bytes as read from the source (preserved verbatim before any transformation). */
  readonly content: Uint8Array;
  /** The resolved owner principal id, or null when the record has an ownership gap (FR-018). */
  readonly ownerPrincipalId: string | null;
  /** The classification governing the original's retention/quarantine. */
  readonly classification: string;
  /** Work items whose correctness depends on this record (dependency propagation). */
  readonly dependentWorkIds: readonly string[];
  /** Available source metadata retained verbatim with the original. */
  readonly availableMetadata?: Record<string, unknown>;
}

/**
 * The verdict the detection ORACLE returns for one record. `damaged: false` ⇒ the record is clean.
 * When damaged, the oracle names the defect class(es), severity, safety impact, and whether it is a
 * `suspected` (below-threshold) finding — the same shape the application classifier folds.
 */
export interface DetectionVerdict {
  readonly damaged: boolean;
  readonly problemClasses: readonly DetectableProblemClass[];
  readonly severity: DetectorSeverity;
  readonly safetyImpact: DetectorSafetyImpact;
  /** True iff the finding is below the confident-detection threshold (disposition `suspected`). */
  readonly suspected: boolean;
  readonly detail: string;
}

/** The injected preservation port — production wires @trustcircle/evidence `preserveOriginal`. */
export interface PreservedOriginalReceipt {
  readonly originalEvidenceId: string;
  readonly contentDigest: string;
  readonly deduplicated: boolean;
}

// ===========================================================================
// 2. Injected oracle + ports — the detection decision + preservation + reads
// ===========================================================================
//
// Production wires these to the real functions:
//   detect            := (record, now) => classifyDetection(record, now)   (application oracle)
//   preserve          := (record, now) => preserveOriginal(evidenceService, {...})  (evidence seam)
//   dueRecords        := repository query for new/changed records not yet detected at their revision
// Tests wire pure fakes. The worker owns the SWEEP, never the oracle.

export interface IntegrityDetectorOracles {
  readonly detect: (record: DetectableRecord, now: number) => DetectionVerdict;
}

export interface IntegrityDetectorPorts {
  /** The bounded batch of new/changed records to evaluate at `now` (repository query). */
  readonly dueRecords: (now: number, limit: number) => Promise<readonly DetectableRecord[]>;
  /**
   * Preserve the raw original BEFORE the case is opened (FR-017). Throws to signal a preservation
   * refusal — the worker captures it as a FAILED outcome and never opens a case without an original.
   */
  readonly preserve: (record: DetectableRecord, now: number) => Promise<PreservedOriginalReceipt>;
}

// ===========================================================================
// 3. Worker configuration
// ===========================================================================

export interface IntegrityDetectorOptions {
  readonly contract: SourceContract;
  readonly expectedContractVersion: string;
  readonly policyVersion: string;
  readonly controlVersion: string;
  /** The accountable owner recorded on every detection audit event. Default 'team:governance-runtime'. */
  readonly owner?: string;
  /** Max records swept per pass (bounds the pass). Default 200. */
  readonly batchSize?: number;
}

const DEFAULT_OWNER = 'team:governance-runtime';
const DEFAULT_BATCH_SIZE = 200;

// ===========================================================================
// 4. Per-record + per-pass result shapes (fail-visible witnesses)
// ===========================================================================

export type DetectionDisposition = 'opened' | 'clean' | 'deduplicated' | 'failed';

export interface DetectionItemResult {
  readonly recordId: string;
  readonly tenantId: string;
  readonly disposition: DetectionDisposition;
  /** The case id derived for a damaged record (stable — re-derives identically ⇒ dedup). */
  readonly caseId: string | null;
  /** The preserved-original evidence id bound to the case (null when clean/failed-before-preserve). */
  readonly originalEvidenceId: string | null;
  readonly problemClasses: readonly DetectableProblemClass[];
  readonly idempotencyKey: string;
  readonly correlationId: string;
  /** The safe next action for an operator/automation (escalate for an ownership gap). */
  readonly safeNextAction: 'none' | 'escalate' | 'reconcile';
  readonly error: string | null;
}

export interface DetectionPassResult {
  readonly scannedAt: number;
  readonly scanned: number;
  readonly opened: number;
  readonly clean: number;
  readonly deduplicated: number;
  readonly failed: number;
  readonly results: readonly DetectionItemResult[];
}

// ===========================================================================
// 5. Deterministic identity derivation (no wall clock, no randomness)
// ===========================================================================
//
// Every id is derived from the record identity + the SOURCE REVISION it was read at — NOT from `now`.
// So a record already detected at revision R re-derives the SAME case id / idempotency key on a later
// pass and the unit-of-work deduplicates it: a record is opened at most once per revision, whatever
// the scan cadence. A genuine CHANGE (new revision) derives a fresh identity and is evaluated anew.

/** A stable idempotency key for a single record's detection (revision-bound, scan-time-independent). */
export function detectionIdempotencyKey(
  tenantId: string,
  recordId: string,
  sourceRevision: string,
): string {
  return (
    'detect-' +
    digest({ tenantId, recordId, sourceRevision, purpose: 'detection_idempotency' }).slice(0, 40)
  );
}

/** A stable correlation id for a detection effect (same derivation basis as the key). */
export function detectionCorrelationId(
  tenantId: string,
  recordId: string,
  sourceRevision: string,
): string {
  return (
    'corr-detect-' +
    digest({ tenantId, recordId, sourceRevision, purpose: 'detection_correlation' }).slice(0, 32)
  );
}

/** A stable integrity-case id for a damaged record (bound to the revision detected). */
export function detectionCaseId(
  tenantId: string,
  recordId: string,
  sourceRevision: string,
): string {
  return (
    'case-' + digest({ tenantId, recordId, sourceRevision, purpose: 'integrity_case' }).slice(0, 32)
  );
}

/** Collapse ≥2 defect classes to `combined`; a single class is reported as-is. */
export function canonicalDetectionClass(
  classes: readonly DetectableProblemClass[],
): DetectableProblemClass {
  if (classes.length === 0) return 'unknown';
  if (classes.length > 1) return 'combined';
  return classes[0] as DetectableProblemClass;
}

// ===========================================================================
// 6. The integrity detector worker
// ===========================================================================

export class IntegrityDetector {
  readonly #db: Database;
  readonly #ports: IntegrityDetectorPorts;
  readonly #oracles: IntegrityDetectorOracles;
  readonly #contract: SourceContract;
  readonly #expectedContractVersion: string;
  readonly #policyVersion: string;
  readonly #controlVersion: string;
  readonly #owner: string;
  readonly #batchSize: number;

  constructor(
    db: Database,
    ports: IntegrityDetectorPorts,
    oracles: IntegrityDetectorOracles,
    opts: IntegrityDetectorOptions,
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
    if (!Number.isInteger(b) || b <= 0)
      throw new RangeError('batchSize must be a positive integer');
    this.#batchSize = b;
  }

  /**
   * Run ONE deterministic detection sweep at the injected instant `now`. Each new/changed record is
   * evaluated by the detection oracle; every genuinely-damaged record has its original preserved
   * (FR-017) and an integrity case opened atomically (case + audit + outbox). The result is a
   * fail-visible per-record summary. Reading no wall clock and deriving every id from the crossed
   * source revision, re-running the same pass is a no-op (dedup).
   */
  async runDetectionPass(now: number): Promise<DetectionPassResult> {
    if (!Number.isFinite(now)) throw new RangeError('now must be a finite epoch-ms instant');
    const results: DetectionItemResult[] = [];

    for (const record of await this.#ports.dueRecords(now, this.#batchSize)) {
      const verdict = this.#oracles.detect(record, now);
      if (!verdict.damaged) {
        results.push(this.#clean(record));
        continue;
      }
      results.push(await this.#openCase(record, verdict, now));
    }

    return {
      scannedAt: now,
      scanned: results.length,
      opened: results.filter((r) => r.disposition === 'opened').length,
      clean: results.filter((r) => r.disposition === 'clean').length,
      deduplicated: results.filter((r) => r.disposition === 'deduplicated').length,
      failed: results.filter((r) => r.disposition === 'failed').length,
      results,
    };
  }

  /**
   * Preserve the original (FR-017) then open an integrity case for a damaged record. Preservation
   * runs FIRST; if it refuses, the record is FAILED-VISIBLE and NO case is opened (never a case
   * without a recoverable original). The case binds the preserved evidence id, the folded defect
   * class(es), severity/safety, the dependents, and — critically — an explicit ownership gap when the
   * record has no owner (FR-018), whose safe next action is `escalate`.
   */
  async #openCase(
    record: DetectableRecord,
    verdict: DetectionVerdict,
    now: number,
  ): Promise<DetectionItemResult> {
    const key = detectionIdempotencyKey(record.tenantId, record.recordId, record.sourceRevision);
    const correlationId = detectionCorrelationId(
      record.tenantId,
      record.recordId,
      record.sourceRevision,
    );
    const caseId = detectionCaseId(record.tenantId, record.recordId, record.sourceRevision);
    const canonicalClass = canonicalDetectionClass(verdict.problemClasses);
    const ownershipGap = record.ownerPrincipalId === null;

    // FR-017 — preserve the raw original BEFORE opening the case. A refusal fails the record visibly.
    let preserved: PreservedOriginalReceipt;
    try {
      preserved = await this.#ports.preserve(record, now);
    } catch (err) {
      return {
        recordId: record.recordId,
        tenantId: record.tenantId,
        disposition: 'failed',
        caseId,
        originalEvidenceId: null,
        problemClasses: Object.freeze([...verdict.problemClasses]),
        idempotencyKey: key,
        correlationId,
        safeNextAction: 'reconcile',
        error: `original preservation refused: ${describeDetectionError(err)}`,
      };
    }

    const reason = {
      code: verdict.suspected ? 'integrity_suspected' : 'integrity_detected',
      text: `record ${record.recordId} @${record.sourceRevision} detected damaged [${canonicalClass}: ${verdict.problemClasses.join(',')}] — ${verdict.detail}`,
    };
    const caseState = {
      id: caseId,
      tenantId: record.tenantId,
      workItemId: record.workItemId,
      sourceRecordId: record.recordId,
      sourceRevision: record.sourceRevision,
      problemClass: canonicalClass,
      problemClasses: [...verdict.problemClasses],
      severity: verdict.severity,
      safetyImpact: verdict.safetyImpact,
      disposition: verdict.suspected ? 'suspected' : 'confirmed',
      state: 'detected',
      ownerPrincipalId: record.ownerPrincipalId,
      ownershipGap,
      originalEvidenceId: preserved.originalEvidenceId,
      dependentWorkIds: [...record.dependentWorkIds],
      detectedAt: now,
    };

    return this.#commit({
      record,
      caseId,
      state: caseState,
      idempotencyKey: key,
      correlationId,
      reason,
      evidenceRefs: [
        `original:${preserved.originalEvidenceId}`,
        `content-digest:${preserved.contentDigest}`,
        `revision:${record.sourceRevision}`,
        ...(ownershipGap ? ['ownership-gap:true'] : []),
      ],
      outboxPayload: {
        eventType: 'integrity_detected',
        caseId,
        tenantId: record.tenantId,
        workItemId: record.workItemId,
        problemClass: canonicalClass,
        problemClasses: [...verdict.problemClasses],
        severity: verdict.severity,
        safetyImpact: verdict.safetyImpact,
        ownershipGap,
        originalEvidenceId: preserved.originalEvidenceId,
        detectedAt: now,
      },
      originalEvidenceId: preserved.originalEvidenceId,
      problemClasses: verdict.problemClasses,
      safeNextAction: ownershipGap ? 'escalate' : 'none',
    });
  }

  // --- the single atomic commit path ---------------------------------------

  async #commit(input: {
    record: DetectableRecord;
    caseId: string;
    state: unknown;
    idempotencyKey: string;
    correlationId: string;
    reason: { code: string; text: string };
    evidenceRefs: readonly string[];
    outboxPayload: unknown;
    originalEvidenceId: string;
    problemClasses: readonly DetectableProblemClass[];
    safeNextAction: DetectionItemResult['safeNextAction'];
  }): Promise<DetectionItemResult> {
    const targetStateDigest = digest(input.state);
    const audit: AuditEventInput = {
      actor: DETECTOR_ACTOR,
      owner: this.#owner,
      reason: input.reason,
      // Detection OPENS a case (no prior canonical state) — source digest is null (create).
      sourceStateDigest: null,
      targetStateDigest,
      scope: `tenant:${input.record.tenantId}/integrity_case:${input.caseId}`,
      policyVersion: this.#policyVersion,
      controlVersion: this.#controlVersion,
      evidenceRefs: input.evidenceRefs,
    };
    try {
      const result: CommitUnitOfWorkResult = await commitUnitOfWork(this.#db, {
        tenantId: input.record.tenantId,
        operationScope: 'integrity.detect',
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        contract: this.#contract,
        expectedContractVersion: this.#expectedContractVersion,
        request: {
          kind: 'integrity_case',
          entityId: input.caseId,
          expectedVersion: 0,
        },
        canonical: {
          entityKind: INTEGRITY_CASE_ENTITY_KIND,
          entityId: input.caseId,
          expectedVersion: 0,
          state: input.state,
        },
        action: 'detect',
        audit,
        outbox: { topic: INTEGRITY_DETECTED_TOPIC, payload: input.outboxPayload },
      });
      const disposition: DetectionDisposition = result.deduplicated
        ? 'deduplicated'
        : result.status === 'succeeded'
          ? 'opened'
          : 'failed';
      return {
        recordId: input.record.recordId,
        tenantId: input.record.tenantId,
        disposition,
        caseId: input.caseId,
        originalEvidenceId: input.originalEvidenceId,
        problemClasses: Object.freeze([...input.problemClasses]),
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        safeNextAction: disposition === 'opened' ? input.safeNextAction : 'none',
        error:
          disposition === 'failed'
            ? `commit did not succeed: status=${result.status} nextAction=${result.nextAction}`
            : null,
      };
    } catch (err) {
      return {
        recordId: input.record.recordId,
        tenantId: input.record.tenantId,
        disposition: 'failed',
        caseId: input.caseId,
        originalEvidenceId: input.originalEvidenceId,
        problemClasses: Object.freeze([...input.problemClasses]),
        idempotencyKey: input.idempotencyKey,
        correlationId: input.correlationId,
        safeNextAction: 'reconcile',
        error: describeDetectionError(err),
      };
    }
  }

  #clean(record: DetectableRecord): DetectionItemResult {
    return {
      recordId: record.recordId,
      tenantId: record.tenantId,
      disposition: 'clean',
      caseId: null,
      originalEvidenceId: null,
      problemClasses: Object.freeze([]),
      idempotencyKey: detectionIdempotencyKey(
        record.tenantId,
        record.recordId,
        record.sourceRevision,
      ),
      correlationId: detectionCorrelationId(
        record.tenantId,
        record.recordId,
        record.sourceRevision,
      ),
      safeNextAction: 'none',
      error: null,
    };
  }

  /**
   * Independent read path: the current canonical state of an opened integrity case (the durable
   * witness — never the commit return value). Returns null if no canonical row exists.
   */
  async readCase(
    tenantId: string,
    caseId: string,
  ): Promise<{ version: number; stateDigest: string; state: unknown } | null> {
    const row = await readCanonicalState(this.#db, tenantId, INTEGRITY_CASE_ENTITY_KIND, caseId);
    if (!row) return null;
    return { version: row.version, stateDigest: row.stateDigest, state: row.state };
  }
}

/** Disclosure-safe error description (error class + message, never internal detail dumps). */
export function describeDetectionError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return `NonError: ${String(err)}`;
}
