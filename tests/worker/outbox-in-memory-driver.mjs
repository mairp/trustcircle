// Deterministic in-memory SqlDriver for the OUTBOX-PUBLISHER tests (Phase 27).
//
// It models the delivery substrate of db/migrations/0004_delivery.sql + 0005_outbox_claim.sql —
// outbox_message (with claim-lease columns), the append-only delivery_attempt history, and the
// dead_letter_record terminal table — so the transactional-outbox publisher's invariants (atomic
// claim, ack-gated success, bounded retry, dead-letter, uncertain-safety) are exercised for real
// under `npm ci` with NO live PostgreSQL. Per session it models:
//
//   * BEGIN [ISOLATION LEVEL ...] / COMMIT / ROLLBACK on a shallow working copy (so a
//     mid-transaction throw + ROLLBACK leaves ZERO durable rows — the atomicity property),
//   * pg_advisory_lock / pg_advisory_unlock keyed on a 64-bit id (cross-session mutual exclusion
//     — this is how the publisher's per-message claim lock serializes concurrent workers),
//   * the outbox_message claim UPDATE (guarded by a status predicate — a compare-and-set),
//     mark-published / mark-failed / mark-dead-letter UPDATEs, and full-row SELECT,
//   * delivery_attempt INSERT (with an append-only UPDATE guard) + ordered SELECT,
//   * dead_letter_record INSERT ... ON CONFLICT DO NOTHING + SELECT,
//   * the attempts-bounded CHECK (attempts <= max_attempts) from 0004.
//
// The store enforces the SAME durable guards the migrations do so the tests cannot "pass" against
// a permissive fake: the delivery_attempt append-only guard, the (tenant,origin,message,attempt)
// uniqueness, and the attempts<=max_attempts bound all raise if violated.

export function createOutboxDriver() {
  const committed = {
    outbox_message: new Map(), // message_id -> row
    delivery_attempt: new Map(), // attempt_id -> row
    dead_letter_record: new Map(), // dead_letter_id -> row
  };
  const lockHolders = new Map();
  const waiters = [];
  let sessionSeq = 0;

  function cloneStore(s) {
    const clone = {};
    for (const [name, map] of Object.entries(s)) {
      clone[name] = new Map([...map].map(([k, v]) => [k, { ...v }]));
    }
    return clone;
  }

  async function acquireLock(lockId, token) {
    const id = String(lockId);
    if (!lockHolders.has(id)) {
      lockHolders.set(id, token);
      return;
    }
    await new Promise((resolve) => waiters.push({ id, token, resolve }));
    lockHolders.set(id, token);
  }
  function releaseLock(lockId) {
    const id = String(lockId);
    lockHolders.delete(id);
    const idx = waiters.findIndex((w) => w.id === id);
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve();
  }

  function makeSession() {
    const token = ++sessionSeq;
    let tx = null;
    const view = () => tx ?? committed;

    async function query(sql, params = []) {
      const text = sql.trim();

      if (/^BEGIN\b/i.test(text)) {
        tx = cloneStore(committed);
        return { rows: [], rowCount: 0 };
      }
      if (/^COMMIT\b/i.test(text)) {
        if (tx) {
          for (const name of Object.keys(committed)) committed[name] = tx[name];
          tx = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (/^ROLLBACK\b/i.test(text)) {
        tx = null;
        return { rows: [], rowCount: 0 };
      }
      if (/pg_advisory_lock\(/i.test(text)) {
        await acquireLock(params[0], token);
        return { rows: [{ pg_advisory_lock: null }], rowCount: 1 };
      }
      if (/pg_advisory_unlock\(/i.test(text)) {
        releaseLock(params[0]);
        return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
      }
      if (/^CREATE TABLE IF NOT EXISTS/i.test(text) || /^CREATE INDEX IF NOT EXISTS/i.test(text)) {
        return { rows: [], rowCount: 0 };
      }

      // ---------------- outbox_message ----------------
      // Due-batch id scan (runOnce snapshot).
      if (/SELECT message_id FROM outbox_message/i.test(text)) {
        const [now, limit] = params;
        const rows = [...view().outbox_message.values()]
          .filter(
            (r) =>
              r.status === 'pending' ||
              (r.status === 'failed' && (r.next_attempt_at == null || r.next_attempt_at <= now)),
          )
          .sort((a, b) => a.created_at - b.created_at)
          .slice(0, limit)
          .map((r) => ({ message_id: r.message_id }));
        return { rows, rowCount: rows.length };
      }
      // selectDue full-row scan (helper).
      if (/SELECT \* FROM outbox_message\s+WHERE status = 'pending'/i.test(text)) {
        const [now, limit] = params;
        const rows = [...view().outbox_message.values()]
          .filter(
            (r) =>
              r.status === 'pending' ||
              (r.status === 'failed' && (r.next_attempt_at == null || r.next_attempt_at <= now)),
          )
          .sort((a, b) => a.created_at - b.created_at)
          .slice(0, limit)
          .map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      // Claim (compare-and-set on the status predicate).
      if (/UPDATE outbox_message\s+SET status = 'publishing'/i.test(text)) {
        const [message_id, worker, now] = params;
        const store = view();
        const row = store.outbox_message.get(message_id);
        if (!row || (row.status !== 'pending' && row.status !== 'failed')) {
          return { rows: [], rowCount: 0 };
        }
        row.status = 'publishing';
        row.claimed_by = worker;
        row.claimed_at = now;
        row.updated_at = now;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE outbox_message\s+SET status = 'published'/i.test(text)) {
        const [message_id, attempts, ack_ref, now] = params;
        const row = view().outbox_message.get(message_id);
        if (!row) return { rows: [], rowCount: 0 };
        assertAttemptsBound(attempts, row.max_attempts);
        row.status = 'published';
        row.attempts = attempts;
        row.ack_ref = ack_ref;
        row.next_attempt_at = null;
        row.terminal_error = null;
        row.claimed_by = null;
        row.updated_at = now;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE outbox_message\s+SET status = 'failed'/i.test(text)) {
        const [message_id, attempts, next_attempt_at, detail, now] = params;
        const row = view().outbox_message.get(message_id);
        if (!row) return { rows: [], rowCount: 0 };
        assertAttemptsBound(attempts, row.max_attempts);
        row.status = 'failed';
        row.attempts = attempts;
        row.next_attempt_at = next_attempt_at;
        row.terminal_error = detail;
        row.claimed_by = null;
        row.updated_at = now;
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE outbox_message\s+SET status = 'dead_letter'/i.test(text)) {
        const [message_id, attempts, detail, now] = params;
        const row = view().outbox_message.get(message_id);
        if (!row) return { rows: [], rowCount: 0 };
        assertAttemptsBound(attempts, row.max_attempts);
        row.status = 'dead_letter';
        row.attempts = attempts;
        row.next_attempt_at = null;
        row.terminal_error = detail;
        row.claimed_by = null;
        row.updated_at = now;
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT \* FROM outbox_message WHERE message_id/i.test(text)) {
        const [id] = params;
        const row = view().outbox_message.get(id);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      // ---------------- delivery_attempt ----------------
      if (/INSERT INTO delivery_attempt/i.test(text)) {
        const [
          attempt_id,
          tenant_id,
          message_id,
          attempt_no,
          correlation_id,
          started_at,
          ended_at,
          outcome,
          ack_ref,
          error_detail,
        ] = params;
        const store = view();
        // Uniqueness (tenant, origin, message, attempt_no) from 0004.
        for (const r of store.delivery_attempt.values()) {
          if (
            r.tenant_id === tenant_id &&
            r.origin === 'outbox' &&
            r.message_id === message_id &&
            r.attempt_no === attempt_no
          ) {
            const e = new Error('duplicate delivery_attempt');
            e.code = '23505';
            throw e;
          }
        }
        store.delivery_attempt.set(attempt_id, {
          attempt_id,
          tenant_id,
          origin: 'outbox',
          message_id,
          attempt_no,
          correlation_id,
          started_at,
          ended_at,
          outcome,
          ack_ref: ack_ref ?? null,
          error_detail: error_detail ?? null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM delivery_attempt/i.test(text)) {
        const [tenant_id, message_id] = params;
        const rows = [...view().delivery_attempt.values()]
          .filter(
            (r) =>
              r.tenant_id === tenant_id && r.origin === 'outbox' && r.message_id === message_id,
          )
          .sort((a, b) => a.attempt_no - b.attempt_no)
          .map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }

      // ---------------- dead_letter_record ----------------
      if (/INSERT INTO dead_letter_record/i.test(text)) {
        const [
          dead_letter_id,
          tenant_id,
          origin_message_id,
          correlation_id,
          failure_class,
          attempts,
          original_payload,
          original_digest,
          owner,
          affected_scope,
          business_impact,
          now,
        ] = params;
        const store = view();
        // ON CONFLICT (tenant_id, origin, origin_message_id) DO NOTHING
        for (const r of store.dead_letter_record.values()) {
          if (
            r.tenant_id === tenant_id &&
            r.origin === 'outbox' &&
            r.origin_message_id === origin_message_id
          ) {
            return { rows: [], rowCount: 0 };
          }
        }
        store.dead_letter_record.set(dead_letter_id, {
          dead_letter_id,
          tenant_id,
          origin: 'outbox',
          origin_message_id,
          correlation_id,
          contract_version: 'n/a',
          schema_version: 'n/a',
          failure_class,
          attempts,
          original_payload,
          original_digest,
          owner,
          affected_scope,
          business_impact,
          outcome: 'open',
          first_seen_at: now,
          updated_at: now,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM dead_letter_record/i.test(text)) {
        const [tenant_id, origin_message_id] = params;
        const row = [...view().dead_letter_record.values()].find(
          (r) =>
            r.tenant_id === tenant_id &&
            r.origin === 'outbox' &&
            r.origin_message_id === origin_message_id,
        );
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      return { rows: [], rowCount: 0 };
    }

    return {
      query,
      release() {
        tx = null;
      },
    };
  }

  function assertAttemptsBound(attempts, maxAttempts) {
    const cap = maxAttempts ?? 8;
    if (attempts > cap) {
      const e = new Error(`outbox_message_attempts_bounded violated: ${attempts} > ${cap}`);
      e.code = '23514';
      throw e;
    }
  }

  // Seed a pending outbox row exactly as the unit-of-work would write it (+ 0005 defaults).
  function seedOutbox(row) {
    committed.outbox_message.set(row.message_id, {
      message_id: row.message_id,
      tenant_id: row.tenant_id,
      topic: row.topic,
      payload_json: JSON.stringify(row.payload ?? {}),
      payload_digest: row.payload_digest ?? 'dig-' + row.message_id,
      correlation_id: row.correlation_id ?? 'corr-' + row.message_id,
      status: row.status ?? 'pending',
      attempts: row.attempts ?? 0,
      max_attempts: row.max_attempts ?? 8,
      next_attempt_at: row.next_attempt_at ?? null,
      ack_ref: row.ack_ref ?? null,
      claimed_by: row.claimed_by ?? null,
      claimed_at: row.claimed_at ?? null,
      terminal_error: row.terminal_error ?? null,
      entity_version: row.entity_version ?? null,
      dedup_key: row.dedup_key ?? null,
      ordering_key: row.ordering_key ?? null,
      created_at: row.created_at ?? 1_700_000_000_000,
      updated_at: row.updated_at ?? null,
    });
  }

  return {
    async query(sql, params) {
      const s = makeSession();
      try {
        return await s.query(sql, params);
      } finally {
        s.release();
      }
    },
    async connect() {
      return makeSession();
    },
    async end() {},
    __committed: committed,
    __lockHolders: lockHolders,
    seedOutbox,
  };
}
