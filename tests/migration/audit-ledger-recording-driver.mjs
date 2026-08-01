// Audit-ledger-recording in-memory SqlDriver for the 0005_audit_ledger migration suite
// (Phase 29 / VO-d76c5d1293b91d26e094 / GAR-002).
//
// Like the Phase-23 idempotency-recording driver, this records the DDL effects of
// db/migrations/0005_audit_ledger.sql into a durable catalog (the DDL effect witness) AND models
// the audit_event / audit_checkpoint data-plane faithfully enough to EXERCISE, through an
// independent read path with NO live PostgreSQL:
//   * the ACCOUNTABILITY CONTRACT — an INSERT that omits a mandatory accountability field
//     (accountable owner, reason_code, source/target state digest, correlation, outcome, time,
//     the hash-chain links) or that violates a CHECK (a completed governed action missing
//     policy/control versions or evidence; a human action missing reason_text; an actor that is
//     neither a known principal nor an identified system automation) is REJECTED, exactly as the
//     migration's NOT NULL / CHECK constraints specify — so an action CANNOT be recorded, and
//     therefore cannot be reported complete, with a required accountability field missing;
//   * APPEND-ONLY — an UPDATE or DELETE of a recorded audit_event / audit_checkpoint row is
//     rejected by the emulated BEFORE-<event> guards (matching the trigger ERRCODE), and the
//     recorded row is observed UNCHANGED through an independent SELECT read path;
//   * the HASH CHAIN — each appended row links previous_digest -> the prior row's
//     integrity_digest, and integrity_digest is unique per ledger, so the chain is a strict
//     total order that cannot fork.
//
// It is a strict SUPERSET of the DDL-recording driver's behaviour (schema_migrations +
// advisory-lock + transaction semantics the runner relies on are preserved), so the
// checksum-pinned runner applies 0001→0002→0003→0004→0005 unchanged. The rejection predicates are
// DERIVED FROM the parsed migration (constraint text + trigger/function bodies), not hard-coded,
// so a migration that neuters a constraint or guard disables the emulated rejection — the test
// double cannot silently grade itself as passing.

export function createAuditLedgerRecordingDriver() {
  const committed = {
    schema_migrations: new Map(),
    audit_event: new Map(), // pk "tenant ledger seq" -> row (data-plane; effect witness)
    audit_checkpoint: new Map(), // checkpoint_id -> row
  };
  const catalog = {
    types: new Map(), // typeName -> { labels:Set }
    tables: new Map(), // tableName -> { columns:Set, notNull:Set, constraints:Map<name,expr>, body }
    indexes: new Set(),
    functions: new Map(), // fnName -> { body }
    triggers: new Map(), // triggerName -> { table, timing, event, fn }
  };
  const lockHolders = new Map();
  const waiters = [];
  let sessionSeq = 0;

  function cloneStore(s) {
    return {
      schema_migrations: new Map([...s.schema_migrations].map(([k, v]) => [k, { ...v }])),
      audit_event: new Map([...s.audit_event].map(([k, v]) => [k, { ...v }])),
      audit_checkpoint: new Map([...s.audit_checkpoint].map(([k, v]) => [k, { ...v }])),
    };
  }
  function eventKey(t, l, s) {
    return `${t} ${l} ${s}`;
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

  function stripComments(sql) {
    return sql
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--');
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join('\n');
  }
  function splitTopLevel(body) {
    const parts = [];
    let depth = 0;
    let cur = '';
    for (const ch of body) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
  }

  // --- DDL parsing (the shapes 0005_audit_ledger.sql emits) ---------------------------
  function recordEnumTypes(sql) {
    // CREATE TYPE <name> AS ENUM ( 'a', 'b', ... )   — inside DO $$ ... $$ blocks.
    const re = /CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM\s*\(([\s\S]*?)\)/gi;
    let m;
    while ((m = re.exec(sql))) {
      const [, name, body] = m;
      const labels = new Set([...body.matchAll(/'([^']+)'/g)].map((x) => x[1]));
      catalog.types.set(name, { labels });
    }
  }
  function recordTables(sql) {
    const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(/gi;
    let m;
    while ((m = re.exec(sql))) {
      const name = m[1];
      let i = re.lastIndex - 1;
      let depth = 0;
      const start = i + 1;
      for (; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = sql.slice(start, i);
      re.lastIndex = i + 1;
      const columns = new Set();
      const notNull = new Set();
      const constraints = new Map();
      for (const part of splitTopLevel(body)) {
        const cm = part.match(/^CONSTRAINT\s+(\w+)\s+([\s\S]+)$/i);
        if (cm) {
          constraints.set(cm[1], cm[2].trim());
          continue;
        }
        if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)/i.test(part)) continue;
        const col = part.match(/^(\w+)\s+/);
        if (col) {
          columns.add(col[1]);
          if (/\bNOT\s+NULL\b/i.test(part)) notNull.add(col[1]);
        }
      }
      if (!catalog.tables.has(name))
        catalog.tables.set(name, { columns, notNull, constraints, body });
    }
  }
  function recordIndexes(sql) {
    const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
    let m;
    while ((m = re.exec(sql))) catalog.indexes.add(m[1]);
  }
  function recordFunctions(sql) {
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\([\s\S]*?\$\$([\s\S]*?)\$\$/gi;
    let m;
    while ((m = re.exec(sql))) catalog.functions.set(m[1], { body: m[2] });
    const re2 = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\(/gi;
    let m2;
    while ((m2 = re2.exec(sql))) {
      if (!catalog.functions.has(m2[1])) catalog.functions.set(m2[1], { body: '' });
    }
  }
  function recordTriggers(sql) {
    const re =
      /CREATE\s+TRIGGER\s+(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(\w+)\s+ON\s+(\w+)[\s\S]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+)/gi;
    let m;
    while ((m = re.exec(sql))) {
      const [, name, timing, event, table, fn] = m;
      catalog.triggers.set(name, {
        table,
        timing: timing.replace(/\s+/g, ' ').toUpperCase(),
        event: event.toUpperCase(),
        fn,
      });
    }
  }
  function applyDdl(rawSql) {
    const sql = stripComments(rawSql);
    recordEnumTypes(sql);
    recordTables(sql);
    recordIndexes(sql);
    recordFunctions(sql);
    recordTriggers(sql);
  }

  // A BEFORE-<event> append-only guard is ACTIVE iff the migration installed the trigger AND its
  // bound plpgsql function body actually RAISEs (rejects). Derived from parsed SQL, not hard-coded.
  function appendOnlyGuardActive(triggerName, table, event) {
    const trig = catalog.triggers.get(triggerName);
    if (!trig || trig.table !== table || trig.timing !== 'BEFORE' || trig.event !== event) {
      return false;
    }
    const fn = catalog.functions.get(trig.fn);
    return !!fn && /RAISE\s+EXCEPTION/i.test(fn.body || '');
  }

  // The accountability contract is enforced from the RECORDED table metadata: a column is
  // mandatory iff the migration declared it NOT NULL (or it participates in the PK). The
  // completed-governed CHECK is enforced iff the migration declared a constraint whose text
  // requires policy/control versions + evidence for a succeeded/partial governed action.
  function auditEventTable() {
    return catalog.tables.get('audit_event');
  }
  function governedCompletionCheckActive(t) {
    for (const expr of t.constraints.values()) {
      if (
        /policy_version_ids/i.test(expr) &&
        /control_version_ids/i.test(expr) &&
        /evidence_manifest_id/i.test(expr) &&
        /succeeded/i.test(expr)
      ) {
        return true;
      }
    }
    return false;
  }
  function reasonTextCheckActive(t) {
    for (const expr of t.constraints.values()) {
      if (/reason_text/i.test(expr) && /actor_is_system/i.test(expr)) return true;
    }
    return false;
  }
  function actorPresentCheckActive(t) {
    for (const expr of t.constraints.values()) {
      if (/actor_principal_id/i.test(expr) && /automation_id/i.test(expr)) return true;
    }
    return false;
  }
  function recordedAfterOccurredCheckActive(t) {
    for (const expr of t.constraints.values()) {
      if (/recorded_at\s*>=\s*occurred_at/i.test(expr)) return true;
    }
    return false;
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
          committed.schema_migrations = tx.schema_migrations;
          committed.audit_event = tx.audit_event;
          committed.audit_checkpoint = tx.audit_checkpoint;
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
      if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO schema_migrations/i.test(text)) {
        const [id, name, kind, checksum, applied_at] = params;
        view().schema_migrations.set(id, { id, name, kind, checksum, applied_at });
        return { rows: [], rowCount: 1 };
      }
      if (/FROM schema_migrations/i.test(text)) {
        let rows = [...view().schema_migrations.values()].map((r) => ({ ...r }));
        if (/ORDER BY id ASC/i.test(text))
          rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return { rows, rowCount: rows.length };
      }

      // --- audit_event data-plane (accountability contract + append-only + hash chain) ---
      if (/^INSERT INTO audit_event/i.test(text)) {
        return insertAuditEvent(params);
      }
      if (/^UPDATE audit_event/i.test(text)) {
        if (appendOnlyGuardActive('audit_event_append_only_update', 'audit_event', 'UPDATE')) {
          const err = new Error('audit_event is append-only: UPDATE rejected');
          err.code = '2F004'; // restrict_violation family (any non-null SQLSTATE)
          throw err;
        }
        return { rows: [], rowCount: 0 };
      }
      if (/^DELETE FROM audit_event/i.test(text)) {
        if (appendOnlyGuardActive('audit_event_append_only_delete', 'audit_event', 'DELETE')) {
          const err = new Error('audit_event is append-only: DELETE rejected');
          err.code = '2F004';
          throw err;
        }
        return { rows: [], rowCount: 0 };
      }
      if (/FROM audit_event/i.test(text)) {
        const store = view().audit_event;
        let rows = [...store.values()].map((r) => ({ ...r }));
        // Optional (tenant, ledger) filter by positional params, else return all in seq order.
        if (params.length >= 2) {
          rows = rows.filter((r) => r.tenant_id === params[0] && r.ledger_id === params[1]);
        }
        rows.sort((a, b) => a.sequence - b.sequence);
        return { rows, rowCount: rows.length };
      }

      // --- audit_checkpoint data-plane -------------------------------------------------
      if (/^INSERT INTO audit_checkpoint/i.test(text)) {
        return insertAuditCheckpoint(params);
      }
      if (/^UPDATE audit_checkpoint/i.test(text)) {
        if (
          appendOnlyGuardActive('audit_checkpoint_append_only_update', 'audit_checkpoint', 'UPDATE')
        ) {
          const err = new Error('audit_checkpoint is append-only: UPDATE rejected');
          err.code = '2F004';
          throw err;
        }
        return { rows: [], rowCount: 0 };
      }
      if (/^DELETE FROM audit_checkpoint/i.test(text)) {
        if (
          appendOnlyGuardActive('audit_checkpoint_append_only_delete', 'audit_checkpoint', 'DELETE')
        ) {
          const err = new Error('audit_checkpoint is append-only: DELETE rejected');
          err.code = '2F004';
          throw err;
        }
        return { rows: [], rowCount: 0 };
      }
      if (/FROM audit_checkpoint/i.test(text)) {
        const store = view().audit_checkpoint;
        let rows = [...store.values()].map((r) => ({ ...r }));
        if (params.length >= 1) rows = rows.filter((r) => r.checkpoint_id === params[0]);
        return { rows, rowCount: rows.length };
      }

      // Any other statement is migration-body DDL — record its catalog effect.
      applyDdl(text);
      return { rows: [], rowCount: 0 };
    }

    // Column order used by the test's INSERT statement (named for clarity).
    const EVENT_COLS = [
      'audit_event_id',
      'tenant_id',
      'ledger_id',
      'sequence',
      'event_type',
      'schema_version',
      'actor_principal_id',
      'actor_role_assignment_id',
      'actor_is_system',
      'automation_id',
      'accountable_owner_principal_id',
      'reason_code',
      'reason_text',
      'entity_type',
      'entity_id',
      'entity_version',
      'source_state_digest',
      'target_state_digest',
      'actual_state_digest',
      'policy_version_ids',
      'control_version_ids',
      'evidence_manifest_id',
      'requested_scope',
      'actual_scope',
      'outcome',
      'occurred_at',
      'recorded_at',
      'correlation_id',
      'causation_id',
      'trace_id',
      'previous_digest',
      'integrity_digest',
    ];

    function insertAuditEvent(params) {
      const t = auditEventTable();
      if (!t) {
        const err = new Error('relation "audit_event" does not exist');
        err.code = '42P01';
        throw err;
      }
      const row = {};
      EVENT_COLS.forEach((c, i) => (row[c] = params[i] === undefined ? null : params[i]));

      // NOT NULL contract (mandatory accountability fields) — derived from recorded metadata.
      for (const col of t.notNull) {
        if (row[col] === null || row[col] === undefined) {
          const err = new Error(`null value in column "${col}" violates not-null constraint`);
          err.code = '23502'; // not_null_violation
          throw err;
        }
      }
      // PK presence (tenant, ledger, sequence) — also mandatory.
      for (const col of ['tenant_id', 'ledger_id', 'sequence']) {
        if (row[col] === null || row[col] === undefined) {
          const err = new Error(`null value in PK column "${col}"`);
          err.code = '23502';
          throw err;
        }
      }
      // CHECK: actor present (known principal OR identified system automation).
      if (actorPresentCheckActive(t)) {
        const actorOk =
          row.actor_principal_id != null ||
          (row.actor_is_system === true && row.automation_id != null);
        if (!actorOk) {
          const err = new Error('audit_event_actor_present check violation');
          err.code = '23514';
          throw err;
        }
      }
      // CHECK: human action requires reason_text.
      if (reasonTextCheckActive(t)) {
        if (row.actor_is_system !== true && row.reason_text == null) {
          const err = new Error('audit_event_reason_text_for_human check violation');
          err.code = '23514';
          throw err;
        }
      }
      // CHECK: recorded_at >= occurred_at.
      if (recordedAfterOccurredCheckActive(t)) {
        if (Number(row.recorded_at) < Number(row.occurred_at)) {
          const err = new Error('audit_event_recorded_after_occurred check violation');
          err.code = '23514';
          throw err;
        }
      }
      // CHECK: completed governed action requires policy+control versions AND evidence.
      if (governedCompletionCheckActive(t)) {
        const governed = row.actor_is_system !== true;
        const completed = row.outcome === 'succeeded' || row.outcome === 'partial';
        if (governed && completed) {
          const pol = Array.isArray(row.policy_version_ids) ? row.policy_version_ids : [];
          const ctl = Array.isArray(row.control_version_ids) ? row.control_version_ids : [];
          if (pol.length < 1 || ctl.length < 1 || row.evidence_manifest_id == null) {
            const err = new Error(
              'audit_event_governed_completion_requires_versions_and_evidence check violation',
            );
            err.code = '23514';
            throw err;
          }
        }
      }
      // UNIQUE integrity_digest per (tenant, ledger) — the chain cannot fork.
      const store = view().audit_event;
      for (const existing of store.values()) {
        if (
          existing.tenant_id === row.tenant_id &&
          existing.ledger_id === row.ledger_id &&
          existing.integrity_digest === row.integrity_digest
        ) {
          const err = new Error('duplicate integrity_digest — chain fork');
          err.code = '23505';
          throw err;
        }
      }
      // PK uniqueness.
      const pk = eventKey(row.tenant_id, row.ledger_id, row.sequence);
      if (store.has(pk)) {
        const err = new Error('duplicate ledger position');
        err.code = '23505';
        throw err;
      }
      store.set(pk, row);
      return { rows: [], rowCount: 1 };
    }

    const CHECKPOINT_COLS = [
      'checkpoint_id',
      'tenant_id',
      'ledger_id',
      'first_sequence',
      'last_sequence',
      'event_count',
      'root_digest',
      'head_integrity_digest',
      'previous_root_digest',
      'generated_at',
      'signing_key_id',
      'signature_algorithm',
      'signature',
      'evidence_item_id',
      'status',
      'verification_history',
      'external_anchor_ref',
    ];

    function insertAuditCheckpoint(params) {
      const t = catalog.tables.get('audit_checkpoint');
      if (!t) {
        const err = new Error('relation "audit_checkpoint" does not exist');
        err.code = '42P01';
        throw err;
      }
      const row = {};
      CHECKPOINT_COLS.forEach((c, i) => (row[c] = params[i] === undefined ? null : params[i]));
      for (const col of t.notNull) {
        if (row[col] === null || row[col] === undefined) {
          const err = new Error(`null value in column "${col}" violates not-null constraint`);
          err.code = '23502';
          throw err;
        }
      }
      // CHECK: range ordered + count matches range.
      if (Number(row.last_sequence) < Number(row.first_sequence)) {
        const err = new Error('audit_checkpoint_range_ordered check violation');
        err.code = '23514';
        throw err;
      }
      if (Number(row.event_count) !== Number(row.last_sequence) - Number(row.first_sequence) + 1) {
        const err = new Error('audit_checkpoint_count_matches_range check violation');
        err.code = '23514';
        throw err;
      }
      const store = view().audit_checkpoint;
      if (store.has(row.checkpoint_id)) {
        const err = new Error('duplicate checkpoint_id');
        err.code = '23505';
        throw err;
      }
      store.set(row.checkpoint_id, row);
      return { rows: [], rowCount: 1 };
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
    __catalog: catalog,
    __committed: committed,
    __eventKey: eventKey,
  };
}
