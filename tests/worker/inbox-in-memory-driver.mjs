// Deterministic in-memory SqlDriver for the INBOX-CONSUMER tests (Phase 28 / T028).
//
// It models the consumer side of db/migrations/0004_delivery.sql — inbox_message (dedup keyed on
// (tenant_id, consumer, event_id)), the append-only delivery_attempt history (inbox origin), the
// MONOTONIC inbox_cursor + append-only inbox_cursor_history, and the dead_letter_record terminal
// table — so the durable inbox consumer's invariants (durable dedup, ordered apply, quarantine,
// bounded-retry ack rules, reconstructable history) are exercised for real under `npm ci` with NO
// live PostgreSQL. Per session it models:
//
//   * BEGIN [ISOLATION LEVEL ...] / COMMIT / ROLLBACK on a shallow working copy (so a
//     mid-transaction throw + ROLLBACK leaves ZERO durable rows — the atomicity property),
//   * pg_advisory_lock / pg_advisory_unlock keyed on a 64-bit id (per-aggregate mutual exclusion
//     — this is how the consumer serializes concurrent delivery of one aggregate stream),
//   * inbox_message INSERT ... ON CONFLICT (tenant,consumer,event_id) DO NOTHING (the dedup PK),
//     state UPDATE, and full-row SELECT (single + per-consumer scan),
//   * delivery_attempt INSERT ... ON CONFLICT DO NOTHING (with an append-only UPDATE guard) +
//     ordered SELECT,
//   * inbox_cursor INSERT ... ON CONFLICT DO UPDATE with a MONOTONIC no-regress guard (an update
//     that would move cursor_seq BACKWARD raises — mirrors inbox_cursor_no_regress), and the
//     append-only inbox_cursor_history INSERT ... ON CONFLICT DO NOTHING,
//   * dead_letter_record INSERT ... ON CONFLICT DO NOTHING + SELECT,
//   * the attempts-bounded CHECK (attempts <= max_attempts) from 0004.
//
// The store enforces the SAME durable guards the migration does so the tests cannot "pass"
// against a permissive fake: the dedup PK, the cursor no-regress, the append-only guards, the
// attempt uniqueness, and the attempts<=max_attempts bound all raise/no-op if violated.

export function createInboxDriver() {
  const committed = {
    inbox_message: new Map(), // `${tenant}|${consumer}|${event}` -> row
    delivery_attempt: new Map(), // attempt_id -> row
    inbox_cursor: new Map(), // `${tenant}|${consumer}|${stream}` -> row
    inbox_cursor_history: new Map(), // history_id -> row
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

  const ik = (t, c, e) => `${t}|${c}|${e}`;
  const ck = (t, c, s) => `${t}|${c}|${s}`;

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

      // ---------------- inbox_message ----------------
      if (/^INSERT INTO inbox_message/i.test(text)) {
        const [
          tenant_id,
          consumer,
          event_id,
          schema_version,
          payload_digest,
          payload_json,
          correlation_id,
          received_at,
          max_attempts,
        ] = params;
        const store = view();
        const key = ik(tenant_id, consumer, event_id);
        if (store.inbox_message.has(key)) {
          // ON CONFLICT (tenant_id, consumer, event_id) DO NOTHING
          return { rows: [], rowCount: 0 };
        }
        store.inbox_message.set(key, {
          tenant_id,
          consumer,
          event_id,
          schema_version,
          payload_digest,
          payload_json,
          evidence_ref: null,
          correlation_id,
          received_at,
          processing_state: 'buffered',
          attempts: 0,
          max_attempts: max_attempts ?? 8,
          result_cursor: null,
          last_error: null,
          updated_at: received_at,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE inbox_message/i.test(text)) {
        const [tenant_id, consumer, event_id, state, attempts, result_cursor, last_error, now] =
          params;
        const store = view();
        const row = store.inbox_message.get(ik(tenant_id, consumer, event_id));
        if (!row) return { rows: [], rowCount: 0 };
        assertAttemptsBound(attempts, row.max_attempts);
        row.processing_state = state;
        row.attempts = attempts;
        row.result_cursor = result_cursor ?? null;
        row.last_error = last_error ?? null;
        row.updated_at = now;
        return { rows: [], rowCount: 1 };
      }
      // Per-consumer scan (rebuildAggregateState + listQuarantined).
      if (/SELECT .*FROM inbox_message\s+WHERE tenant_id = \$1 AND consumer = \$2/i.test(text)) {
        const [tenant_id, consumer] = params;
        let rows = [...view().inbox_message.values()].filter(
          (r) => r.tenant_id === tenant_id && r.consumer === consumer,
        );
        if (/processing_state = 'quarantined'/i.test(text)) {
          rows = rows.filter((r) => r.processing_state === 'quarantined');
        }
        rows = rows.sort((a, b) => a.received_at - b.received_at).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      // Single-row SELECT.
      if (
        /SELECT \* FROM inbox_message\s+WHERE tenant_id = \$1 AND consumer = \$2 AND event_id = \$3/i.test(
          text,
        )
      ) {
        const [tenant_id, consumer, event_id] = params;
        const row = view().inbox_message.get(ik(tenant_id, consumer, event_id));
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      // ---------------- delivery_attempt (inbox origin) ----------------
      if (/^INSERT INTO delivery_attempt/i.test(text)) {
        const [
          attempt_id,
          tenant_id,
          message_id,
          attempt_no,
          correlation_id,
          started_at,
          ended_at,
          outcome,
          error_detail,
        ] = params;
        const store = view();
        // ON CONFLICT (tenant,origin,message,attempt_no) DO NOTHING.
        for (const r of store.delivery_attempt.values()) {
          if (
            r.tenant_id === tenant_id &&
            r.origin === 'inbox' &&
            r.message_id === message_id &&
            r.attempt_no === attempt_no
          ) {
            return { rows: [], rowCount: 0 };
          }
        }
        store.delivery_attempt.set(attempt_id, {
          attempt_id,
          tenant_id,
          origin: 'inbox',
          message_id,
          attempt_no,
          correlation_id,
          started_at,
          ended_at,
          outcome,
          ack_ref: null,
          error_detail: error_detail ?? null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM delivery_attempt/i.test(text)) {
        const [tenant_id, message_id] = params;
        const rows = [...view().delivery_attempt.values()]
          .filter(
            (r) => r.tenant_id === tenant_id && r.origin === 'inbox' && r.message_id === message_id,
          )
          .sort((a, b) => a.attempt_no - b.attempt_no)
          .map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }

      // ---------------- inbox_cursor (monotonic) ----------------
      if (
        /^INSERT INTO inbox_cursor\s/i.test(text) &&
        /ON CONFLICT \(tenant_id, consumer, stream\)/i.test(text)
      ) {
        const [tenant_id, consumer, stream, cursor_value, cursor_seq, correlation_id, updated_at] =
          params;
        const store = view();
        const key = ck(tenant_id, consumer, stream);
        const existing = store.inbox_cursor.get(key);
        if (existing) {
          // inbox_cursor_no_regress: reject a backward cursor_seq.
          if (cursor_seq < existing.cursor_seq) {
            const e = new Error(
              `inbox cursor regression for (${tenant_id}, ${consumer}, ${stream}): recorded ${existing.cursor_seq}, incoming ${cursor_seq}`,
            );
            e.code = '23514';
            throw e;
          }
          existing.cursor_value = cursor_value;
          existing.cursor_seq = cursor_seq;
          existing.correlation_id = correlation_id;
          existing.updated_at = updated_at;
        } else {
          store.inbox_cursor.set(key, {
            tenant_id,
            consumer,
            stream,
            cursor_value,
            cursor_seq,
            correlation_id,
            updated_at,
          });
        }
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT \* FROM inbox_cursor\s+WHERE/i.test(text)) {
        const [tenant_id, consumer, stream] = params;
        const row = view().inbox_cursor.get(ck(tenant_id, consumer, stream));
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      // ---------------- inbox_cursor_history (append-only) ----------------
      if (/^INSERT INTO inbox_cursor_history/i.test(text)) {
        const [
          history_id,
          tenant_id,
          consumer,
          stream,
          cursor_value,
          cursor_seq,
          correlation_id,
          recorded_at,
        ] = params;
        const store = view();
        for (const r of store.inbox_cursor_history.values()) {
          if (
            r.tenant_id === tenant_id &&
            r.consumer === consumer &&
            r.stream === stream &&
            r.cursor_seq === cursor_seq
          ) {
            return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
          }
        }
        store.inbox_cursor_history.set(history_id, {
          history_id,
          tenant_id,
          consumer,
          stream,
          cursor_value,
          cursor_seq,
          correlation_id,
          recorded_at,
        });
        return { rows: [], rowCount: 1 };
      }

      // ---------------- dead_letter_record ----------------
      if (/^INSERT INTO dead_letter_record/i.test(text)) {
        const [
          dead_letter_id,
          tenant_id,
          origin_message_id,
          correlation_id,
          contract_version,
          schema_version,
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
        for (const r of store.dead_letter_record.values()) {
          if (
            r.tenant_id === tenant_id &&
            r.origin === 'inbox' &&
            r.origin_message_id === origin_message_id
          ) {
            return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
          }
        }
        store.dead_letter_record.set(dead_letter_id, {
          dead_letter_id,
          tenant_id,
          origin: 'inbox',
          origin_message_id,
          correlation_id,
          contract_version,
          schema_version,
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
            r.origin === 'inbox' &&
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
      const e = new Error(`inbox_message_attempts_bounded violated: ${attempts} > ${cap}`);
      e.code = '23514';
      throw e;
    }
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
  };
}
