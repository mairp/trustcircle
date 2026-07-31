// Deterministic in-memory SqlDriver for the UNIT-OF-WORK tests (Phase 21).
//
// It extends the Phase-17 fake with the three unit-of-work tables so the atomic
// "canonical_state + audit_event + outbox_message in ONE transaction" invariant is exercised
// for real, under `npm ci`, with NO live PostgreSQL. It models, per session:
//
//   * BEGIN [ISOLATION LEVEL ...] / COMMIT / ROLLBACK — a transaction operates on a shallow
//     working copy of the committed store and swaps it in only on COMMIT (so a mid-transaction
//     throw + ROLLBACK leaves ZERO durable rows across ALL tables — the atomicity property),
//   * pg_advisory_lock / pg_advisory_unlock keyed on a 64-bit id (cross-session mutual exclusion),
//   * CREATE TABLE / CREATE INDEX IF NOT EXISTS (no-ops for the fake),
//   * idempotency_ledger upsert + SELECT (the runMutation witness),
//   * canonical_state INSERT ... ON CONFLICT DO UPDATE + version SELECT + full-row SELECT,
//   * audit_event INSERT + SELECT by audit_id,
//   * outbox_message INSERT + SELECT by message_id.
//
// A `faultAt(marker)` hook injects a throw right BEFORE a chosen write commits, so a test can
// prove that a failure at the audit or outbox write rolls back the canonical write too.

export function createUowDriver() {
  const committed = {
    schema_migrations: new Map(),
    idempotency_ledger: new Map(), // `${t} ${s} ${k}` -> row
    canonical_state: new Map(), // `${t} ${kind} ${id}` -> row
    audit_event: new Map(), // audit_id -> row
    outbox_message: new Map(), // message_id -> row
  };
  const lockHolders = new Map();
  const waiters = [];
  let sessionSeq = 0;

  // Fault injection: when set, a matching write throws a (non-retryable) error to force rollback.
  let fault = null; // { table: 'canonical_state'|'audit_event'|'outbox_message', code?: string }

  function cloneStore(s) {
    const clone = {};
    for (const [name, map] of Object.entries(s)) {
      clone[name] = new Map([...map].map(([k, v]) => [k, { ...v }]));
    }
    return clone;
  }
  const ck = (a, b, c) => `${a} ${b} ${c}`;

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

  function maybeFault(table) {
    if (fault && fault.table === table) {
      const err = new Error(`injected fault at ${table}`);
      if (fault.code) err.code = fault.code; // e.g. '40001' to test retry; default non-retryable
      // one-shot unless sticky
      if (!fault.sticky) fault = null;
      throw err;
    }
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
        tx = null; // discard the working copy — NOTHING becomes durable
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

      // --- idempotency_ledger ---
      if (/INSERT INTO idempotency_ledger/i.test(text)) {
        const [
          tenant_id,
          operation_scope,
          idempotency_key,
          correlation_id,
          request_digest,
          contract_version,
          status,
          response_digest,
          response_json,
          now,
          attempts,
        ] = params;
        const store = view();
        const key = ck(tenant_id, operation_scope, idempotency_key);
        const prior = store.idempotency_ledger.get(key);
        const row = prior
          ? {
              ...prior,
              status,
              response_digest,
              response_json,
              last_seen_at: now,
              attempts,
              correlation_id,
            }
          : {
              tenant_id,
              operation_scope,
              idempotency_key,
              correlation_id,
              request_digest,
              contract_version,
              status,
              response_digest,
              response_json,
              first_seen_at: now,
              last_seen_at: now,
              attempts,
            };
        store.idempotency_ledger.set(key, row);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM idempotency_ledger/i.test(text)) {
        const [t, s, k] = params;
        const row = view().idempotency_ledger.get(ck(t, s, k));
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      // --- canonical_state ---
      if (/SELECT version FROM canonical_state/i.test(text)) {
        const [t, kind, id] = params;
        const row = view().canonical_state.get(ck(t, kind, id));
        return { rows: row ? [{ version: row.version }] : [], rowCount: row ? 1 : 0 };
      }
      if (/INSERT INTO canonical_state/i.test(text)) {
        maybeFault('canonical_state');
        const [
          tenant_id,
          entity_kind,
          entity_id,
          version,
          state_json,
          state_digest,
          correlation_id,
          updated_at,
        ] = params;
        const store = view();
        store.canonical_state.set(ck(tenant_id, entity_kind, entity_id), {
          tenant_id,
          entity_kind,
          entity_id,
          version,
          state_json,
          state_digest,
          correlation_id,
          updated_at,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM canonical_state/i.test(text)) {
        const [t, kind, id] = params;
        const row = view().canonical_state.get(ck(t, kind, id));
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      // --- audit_event ---
      if (/INSERT INTO audit_event/i.test(text)) {
        maybeFault('audit_event');
        const [
          audit_id,
          tenant_id,
          action,
          actor,
          owner,
          reason_code,
          reason_text,
          source_state_digest,
          target_state_digest,
          scope,
          policy_version,
          control_version,
          evidence_refs,
          correlation_id,
          outcome,
          recorded_at,
        ] = params;
        view().audit_event.set(audit_id, {
          audit_id,
          tenant_id,
          action,
          actor,
          owner,
          reason_code,
          reason_text,
          source_state_digest,
          target_state_digest,
          scope,
          policy_version,
          control_version,
          evidence_refs,
          correlation_id,
          outcome,
          recorded_at,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM audit_event/i.test(text)) {
        const [id] = params;
        const row = view().audit_event.get(id);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      // --- outbox_message ---
      if (/INSERT INTO outbox_message/i.test(text)) {
        maybeFault('outbox_message');
        const [
          message_id,
          tenant_id,
          topic,
          payload_json,
          payload_digest,
          correlation_id,
          status,
          attempts,
          created_at,
        ] = params;
        view().outbox_message.set(message_id, {
          message_id,
          tenant_id,
          topic,
          payload_json,
          payload_digest,
          correlation_id,
          status,
          attempts,
          created_at,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM outbox_message/i.test(text)) {
        const [id] = params;
        const row = view().outbox_message.get(id);
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
      }

      // --- schema_migrations (unused here but kept for completeness) ---
      if (/INSERT INTO schema_migrations/i.test(text)) {
        const [id, name, kind, checksum, applied_at] = params;
        view().schema_migrations.set(id, { id, name, kind, checksum, applied_at });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM schema_migrations/i.test(text)) {
        const rows = [...view().schema_migrations.values()].map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
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
    // Test introspection + fault control (NOT part of SqlDriver):
    __committed: committed,
    __lockHolders: lockHolders,
    faultAt(table, opts = {}) {
      fault = { table, ...opts };
    },
    clearFault() {
      fault = null;
    },
  };
}
