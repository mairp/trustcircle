import { createHash } from 'node:crypto';

import {
  OperationalCaseCommandError,
  type CaseMutation,
  type CaseRepositoryTransactionInput,
  type CaseRepositoryTransactionResult,
  type OperationalCaseDetail,
  type OperationalCaseRepository,
  type OperationalCaseTransition,
} from '@trustcircle/application';
import type { EscalationRecord, OperationalCase } from '@trustcircle/domain';

interface IdempotencyEntry {
  readonly requestDigest: string;
  readonly mutation: CaseMutation;
}

function key(tenantId: string, caseId: string): string {
  return `${tenantId}:${caseId}`;
}

function idempotencyKey(input: CaseRepositoryTransactionInput): string {
  return `${input.tenantId}:${input.scope}:${input.idempotencyKey}`;
}

function cloneCase(value: OperationalCase): OperationalCase {
  return structuredClone(value);
}

function cloneTransition(value: OperationalCaseTransition): OperationalCaseTransition {
  return structuredClone(value);
}

function cloneEscalation(value: EscalationRecord): EscalationRecord {
  return structuredClone(value);
}

/** Deterministic reference adapter used by unit tests and explicitly local preview runtimes. */
export class InMemoryOperationalCaseRepository implements OperationalCaseRepository {
  readonly #cases = new Map<string, OperationalCase>();
  readonly #transitions = new Map<string, OperationalCaseTransition[]>();
  readonly #escalations = new Map<string, EscalationRecord[]>();
  readonly #idempotency = new Map<string, IdempotencyEntry>();

  async transact(
    input: CaseRepositoryTransactionInput,
    effect: (current: OperationalCase | undefined) => CaseMutation,
  ): Promise<CaseRepositoryTransactionResult> {
    const idKey = idempotencyKey(input);
    const prior = this.#idempotency.get(idKey);
    if (prior) {
      if (prior.requestDigest !== input.requestDigest) {
        throw new OperationalCaseCommandError(
          'idempotency_conflict',
          409,
          'Use a new idempotency key for a different command payload.',
        );
      }
      return {
        outcome: 'duplicate',
        mutation: {
          case: cloneCase(prior.mutation.case),
          transition: { ...cloneTransition(prior.mutation.transition), outcome: 'duplicate' },
          ...(prior.mutation.escalations === undefined
            ? {}
            : { escalations: prior.mutation.escalations.map(cloneEscalation) }),
        },
      };
    }
    const caseKey = key(input.tenantId, input.caseId);
    const current = this.#cases.get(caseKey);
    if (input.expectedVersion !== undefined && current?.version !== input.expectedVersion) {
      throw new OperationalCaseCommandError('version_conflict', 412);
    }
    const mutation = effect(current === undefined ? undefined : cloneCase(current));
    if (mutation.case.tenantId !== input.tenantId) {
      throw new OperationalCaseCommandError('tenant_scope_mismatch', 403);
    }
    const actualKey = key(mutation.case.tenantId, mutation.case.id);
    const transitions = this.#transitions.get(actualKey) ?? [];
    const existingEscalations = this.#escalations.get(actualKey) ?? [];
    const escalationIds = new Set(existingEscalations.map((record) => record.idempotencyIdentity));
    const newEscalations = (mutation.escalations ?? []).filter(
      (record) => !escalationIds.has(record.idempotencyIdentity),
    );
    const committed: CaseMutation = {
      case: cloneCase(mutation.case),
      transition: cloneTransition(mutation.transition),
      ...(mutation.escalations === undefined
        ? {}
        : { escalations: mutation.escalations.map(cloneEscalation) }),
    };
    this.#cases.set(actualKey, committed.case);
    this.#transitions.set(actualKey, [...transitions, committed.transition]);
    this.#escalations.set(actualKey, [
      ...existingEscalations,
      ...newEscalations.map(cloneEscalation),
    ]);
    this.#idempotency.set(idKey, { requestDigest: input.requestDigest, mutation: committed });
    return {
      outcome: 'accepted',
      mutation: {
        case: cloneCase(committed.case),
        transition: cloneTransition(committed.transition),
        ...(committed.escalations === undefined
          ? {}
          : { escalations: committed.escalations.map(cloneEscalation) }),
      },
    };
  }

  async read(tenantId: string, caseId: string): Promise<OperationalCaseDetail | undefined> {
    const caseKey = key(tenantId, caseId);
    const current = this.#cases.get(caseKey);
    if (!current) return undefined;
    return {
      case: cloneCase(current),
      transitions: (this.#transitions.get(caseKey) ?? []).map(cloneTransition),
      escalations: (this.#escalations.get(caseKey) ?? []).map(cloneEscalation),
    };
  }

  async list(tenantId: string): Promise<readonly OperationalCase[]> {
    return [...this.#cases.values()]
      .filter((value) => value.tenantId === tenantId)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .map(cloneCase);
  }

  async appendRejected(transition: OperationalCaseTransition): Promise<void> {
    const caseKey = key(transition.tenantId, transition.caseId);
    const transitions = this.#transitions.get(caseKey) ?? [];
    this.#transitions.set(caseKey, [...transitions, cloneTransition(transition)]);
  }
}

export interface OperationalCaseSqlSession extends OperationalCaseSqlExecutor {
  release(): void;
}

export interface OperationalCaseSqlDriver extends OperationalCaseSqlExecutor {
  connect(): Promise<OperationalCaseSqlSession>;
}

function parsed<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return structuredClone(value) as T;
}

function stableUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function tenantContext(session: OperationalCaseSqlExecutor, tenantId: string): Promise<void> {
  await session.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
}

async function insertTransition(
  session: OperationalCaseSqlExecutor,
  transition: OperationalCaseTransition,
): Promise<void> {
  await session.query(
    `INSERT INTO operational_case_transition
       (id, tenant_id, case_id, command, from_status, to_status, outcome,
        expected_version, actual_version, actor_principal_id, actor_roles, reason,
        idempotency_key, correlation_id, causation_id, rejection_code, safe_next_action,
        occurred_at, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,
    [
      transition.id,
      transition.tenantId,
      transition.caseId,
      transition.command,
      transition.fromStatus ?? null,
      transition.toStatus ?? null,
      transition.outcome,
      transition.expectedVersion ?? null,
      transition.actualVersion ?? null,
      transition.actorId,
      JSON.stringify(transition.actorRoles),
      transition.reason,
      transition.idempotencyKey,
      transition.correlationId,
      transition.causationId,
      transition.rejectionCode ?? null,
      transition.safeNextAction ?? null,
      transition.occurredAt,
      JSON.stringify(transition),
    ],
  );
}

async function writeCase(
  session: OperationalCaseSqlExecutor,
  current: OperationalCase | undefined,
  next: OperationalCase,
): Promise<void> {
  const payload = JSON.stringify(next);
  if (!current) {
    await session.query(
      `INSERT INTO operational_case
         (id, tenant_id, attention_item_id, title, priority, status, creator_principal_id,
          owner_principal_id, source_owner_ids, rationale, opened_at, acknowledged_at,
          acknowledgement_target_at, resolution_target_at, verification_target_at,
          service_level_policy_id, service_level_policy_version, escalation_level,
          breach_types, verification, payload, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19::jsonb,$20::jsonb,$21::jsonb,$22,$23,$24)`,
      [
        next.id,
        next.tenantId,
        next.attentionItemId ?? null,
        next.title,
        next.priority,
        next.status,
        next.creatorId,
        next.ownerId ?? null,
        JSON.stringify(next.sourceOwnerIds),
        next.rationale,
        next.openedAt,
        next.acknowledgedAt ?? null,
        next.acknowledgementTargetAt,
        next.resolutionTargetAt,
        next.verificationTargetAt ?? null,
        next.serviceLevelPolicyId,
        next.serviceLevelPolicyVersion,
        next.escalationLevel,
        JSON.stringify(next.breachTypes),
        JSON.stringify(next.verification ?? null),
        payload,
        next.version,
        next.createdAt,
        next.updatedAt,
      ],
    );
  } else {
    const result = await session.query(
      `UPDATE operational_case SET
         attention_item_id=$4, title=$5, priority=$6, status=$7, owner_principal_id=$8,
         source_owner_ids=$9::jsonb, rationale=$10, acknowledged_at=$11,
         acknowledgement_target_at=$12, resolution_target_at=$13, verification_target_at=$14,
         escalation_level=$15, breach_types=$16::jsonb, verification=$17::jsonb,
         payload=$18::jsonb, version=$19, updated_at=$20
       WHERE tenant_id=$1 AND id=$2 AND version=$3`,
      [
        next.tenantId,
        next.id,
        current.version,
        next.attentionItemId ?? null,
        next.title,
        next.priority,
        next.status,
        next.ownerId ?? null,
        JSON.stringify(next.sourceOwnerIds),
        next.rationale,
        next.acknowledgedAt ?? null,
        next.acknowledgementTargetAt,
        next.resolutionTargetAt,
        next.verificationTargetAt ?? null,
        next.escalationLevel,
        JSON.stringify(next.breachTypes),
        JSON.stringify(next.verification ?? null),
        payload,
        next.version,
        next.updatedAt,
      ],
    );
    if (result.rowCount !== 1) throw new OperationalCaseCommandError('version_conflict', 412);
  }

  for (const [index, source] of next.sourceReferences.entries()) {
    await session.query(
      `INSERT INTO operational_case_source
         (id, tenant_id, case_id, source_order, domain, record_type, record_id, record_version,
          governed_problem_key, href, observed_at, source_owner_id, resolution_state, payload, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)
       ON CONFLICT (tenant_id, case_id, domain, record_type, record_id) DO NOTHING`,
      [
        stableUuid(
          `${next.tenantId}:${next.id}:${source.domain}:${source.recordType}:${source.recordId}`,
        ),
        next.tenantId,
        next.id,
        index,
        source.domain,
        source.recordType,
        source.recordId,
        source.recordVersion ?? null,
        source.governedProblemKey ?? null,
        source.href,
        source.observedAt,
        source.sourceOwnerId ?? null,
        source.resolved === true
          ? 'resolved'
          : source.resolved === false
            ? 'unresolved'
            : 'unknown',
        JSON.stringify(source),
        next.updatedAt,
      ],
    );
  }

  for (const evidenceReference of next.evidenceReferences) {
    await session.query(
      `INSERT INTO operational_case_evidence
         (id, tenant_id, case_id, evidence_reference, added_by_principal_id, added_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, case_id, evidence_reference) DO NOTHING`,
      [
        stableUuid(`${next.tenantId}:${next.id}:evidence:${evidenceReference}`),
        next.tenantId,
        next.id,
        evidenceReference,
        next.verification?.verifierId ?? next.ownerId ?? next.creatorId,
        next.updatedAt,
      ],
    );
  }
}

/** PostgreSQL implementation used by production; every command is one serializable unit. */
export class PostgresOperationalCaseRepository implements OperationalCaseRepository {
  readonly #driver: OperationalCaseSqlDriver;

  constructor(driver: OperationalCaseSqlDriver) {
    this.#driver = driver;
  }

  async transact(
    input: CaseRepositoryTransactionInput,
    effect: (current: OperationalCase | undefined) => CaseMutation,
  ): Promise<CaseRepositoryTransactionResult> {
    const session = await this.#driver.connect();
    try {
      await session.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await tenantContext(session, input.tenantId);
      const replay = await session.query<{ request_digest: string; result_payload: unknown }>(
        `SELECT request_digest, result_payload FROM operational_case_idempotency
          WHERE tenant_id=$1 AND command_scope=$2 AND idempotency_key=$3`,
        [input.tenantId, input.scope, input.idempotencyKey],
      );
      const existing = replay.rows[0];
      if (existing) {
        if (existing.request_digest !== input.requestDigest) {
          throw new OperationalCaseCommandError(
            'idempotency_conflict',
            409,
            'Use a new idempotency key for a different command payload.',
          );
        }
        const mutation = parsed<CaseMutation>(existing.result_payload);
        await session.query('COMMIT');
        return {
          outcome: 'duplicate',
          mutation: { ...mutation, transition: { ...mutation.transition, outcome: 'duplicate' } },
        };
      }
      const locked = await session.query<{ payload: unknown; version: number }>(
        `SELECT payload, version FROM operational_case WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.caseId],
      );
      const current = locked.rows[0] ? parsed<OperationalCase>(locked.rows[0].payload) : undefined;
      if (input.expectedVersion !== undefined && current?.version !== input.expectedVersion) {
        throw new OperationalCaseCommandError('version_conflict', 412);
      }
      const mutation = effect(current === undefined ? undefined : cloneCase(current));
      if (mutation.case.tenantId !== input.tenantId) {
        throw new OperationalCaseCommandError('tenant_scope_mismatch', 403);
      }
      await writeCase(session, current, mutation.case);
      await insertTransition(session, mutation.transition);
      for (const escalation of mutation.escalations ?? []) {
        await session.query(
          `INSERT INTO operational_case_escalation
             (id, tenant_id, case_id, policy_version, level, breach_type, target_role,
              status, idempotency_identity, opened_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
           ON CONFLICT (tenant_id, idempotency_identity) DO NOTHING`,
          [
            stableUuid(`${escalation.tenantId}:${escalation.idempotencyIdentity}`),
            escalation.tenantId,
            escalation.caseId,
            escalation.policyVersion,
            escalation.level,
            escalation.breachType,
            escalation.targetRole,
            escalation.status,
            escalation.idempotencyIdentity,
            escalation.openedAt,
            JSON.stringify(escalation),
          ],
        );
      }
      await session.query(
        `INSERT INTO operational_case_idempotency
           (tenant_id, command_scope, idempotency_key, request_digest, result_payload, created_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [
          input.tenantId,
          input.scope,
          input.idempotencyKey,
          input.requestDigest,
          JSON.stringify(mutation),
          mutation.transition.occurredAt,
        ],
      );
      await session.query('COMMIT');
      return { outcome: 'accepted', mutation: structuredClone(mutation) };
    } catch (error) {
      try {
        await session.query('ROLLBACK');
      } catch {
        /* preserve the authoritative failure */
      }
      throw error;
    } finally {
      session.release();
    }
  }

  async read(tenantId: string, caseId: string): Promise<OperationalCaseDetail | undefined> {
    const session = await this.#driver.connect();
    try {
      await session.query('BEGIN READ ONLY');
      await tenantContext(session, tenantId);
      const [caseResult, transitionResult, escalationResult] = await Promise.all([
        session.query<{ payload: unknown }>(
          `SELECT payload FROM operational_case WHERE tenant_id=$1 AND id=$2`,
          [tenantId, caseId],
        ),
        session.query<{ payload: unknown }>(
          `SELECT payload FROM operational_case_transition WHERE tenant_id=$1 AND case_id=$2 ORDER BY occurred_at,id`,
          [tenantId, caseId],
        ),
        session.query<{ payload: unknown }>(
          `SELECT payload FROM operational_case_escalation WHERE tenant_id=$1 AND case_id=$2 ORDER BY opened_at,id`,
          [tenantId, caseId],
        ),
      ]);
      await session.query('COMMIT');
      const row = caseResult.rows[0];
      if (!row) return undefined;
      return {
        case: parsed<OperationalCase>(row.payload),
        transitions: transitionResult.rows.map((item) =>
          parsed<OperationalCaseTransition>(item.payload),
        ),
        escalations: escalationResult.rows.map((item) => parsed<EscalationRecord>(item.payload)),
      };
    } catch (error) {
      try {
        await session.query('ROLLBACK');
      } catch {
        /* preserve the authoritative failure */
      }
      throw error;
    } finally {
      session.release();
    }
  }

  async list(tenantId: string): Promise<readonly OperationalCase[]> {
    const session = await this.#driver.connect();
    try {
      await session.query('BEGIN READ ONLY');
      await tenantContext(session, tenantId);
      const result = await session.query<{ payload: unknown }>(
        `SELECT payload FROM operational_case WHERE tenant_id=$1 ORDER BY updated_at DESC,id`,
        [tenantId],
      );
      await session.query('COMMIT');
      return result.rows.map((item) => parsed<OperationalCase>(item.payload));
    } catch (error) {
      try {
        await session.query('ROLLBACK');
      } catch {
        /* preserve the authoritative failure */
      }
      throw error;
    } finally {
      session.release();
    }
  }

  async appendRejected(transition: OperationalCaseTransition): Promise<void> {
    const session = await this.#driver.connect();
    try {
      await session.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await tenantContext(session, transition.tenantId);
      await insertTransition(session, transition);
      await session.query('COMMIT');
    } catch (error) {
      try {
        await session.query('ROLLBACK');
      } catch {
        /* preserve the authoritative failure */
      }
      throw error;
    } finally {
      session.release();
    }
  }
}

export interface OperationalCaseSqlExecutor {
  query<R extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly R[]; readonly rowCount: number }>;
}

/** SQL helpers used by a composition root that wraps commands in a serializable transaction. */
export const OPERATIONAL_CASE_SQL = Object.freeze({
  lockCurrent: `SELECT payload, version FROM operational_case WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
  readIdempotency: `SELECT request_digest, result_payload FROM operational_case_idempotency WHERE tenant_id = $1 AND command_scope = $2 AND idempotency_key = $3`,
  insertIdempotency: `INSERT INTO operational_case_idempotency (tenant_id, command_scope, idempotency_key, request_digest, result_payload, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
  compareAndSwap: `UPDATE operational_case SET payload = $4, status = $5, owner_principal_id = $6, version = $7, updated_at = $8 WHERE tenant_id = $1 AND id = $2 AND version = $3`,
  insertTransition: `INSERT INTO operational_case_transition (id, tenant_id, case_id, command, outcome, expected_version, actual_version, actor_principal_id, actor_roles, reason, idempotency_key, correlation_id, causation_id, rejection_code, safe_next_action, occurred_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
  insertEscalation: `INSERT INTO operational_case_escalation (id, tenant_id, case_id, policy_version, level, breach_type, target_role, status, idempotency_identity, opened_at, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (tenant_id, idempotency_identity) DO NOTHING`,
});

export function operationalCaseDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
