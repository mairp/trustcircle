// Delivery-recording in-memory SqlDriver for the 0004_delivery migration suite
// (Phase 24 / VO-52d0780c11bcc6fd7583, VO-7a0dbcc527946b539bf6).
//
// The Phase-18/23 DDL-recording drivers record CREATE TABLE / CREATE INDEX / ALTER TABLE
// ADD COLUMN / ADD CONSTRAINT / CREATE FUNCTION / CREATE TRIGGER effects. 0004_delivery.sql
// emits all of those PLUS a set of guard triggers on the delivery tables:
//   * outbox_message  — extended with delivery lifecycle columns + a partial dedup UNIQUE.
//   * inbox_message   — consumer-side dedup identity (tenant, consumer, event_id).
//   * dead_letter_record — terminal failure evidence, retained original.
//   * delivery_attempt — APPEND-ONLY attempt history (BEFORE-UPDATE reject).
//   * inbox_cursor + inbox_cursor_history — monotonic cursor + append-only trail.
// This driver records all of that into a durable catalog (the DDL effect witness) AND
// models the delivery DATA-PLANE faithfully enough to EXERCISE each guard behaviorally:
//   * an outbox INSERT with a duplicate (tenant, dedup_key) is rejected (unique_violation),
//   * an inbox INSERT with a duplicate (tenant, consumer, event_id) is rejected,
//   * an UPDATE of a recorded delivery_attempt row is rejected (append-only),
//   * an inbox_cursor UPDATE that moves cursor_seq BACKWARD is rejected (no-regress),
//   * an UPDATE of a recorded inbox_cursor_history row is rejected (append-only),
// so the integration/effect-witness tests observe a real durable effect that could not
// exist before the migration ran — with NO live PostgreSQL. Each guard's rejection
// predicate is DERIVED FROM the parsed plpgsql body (not hard-coded), so a migration that
// neuters a guard disables the emulated rejection — the behavior tracks the real SQL,
// closing the "the emulator grades itself" gap.
//
// It is a strict SUPERSET of the DDL-recording driver's behavior (schema_migrations +
// advisory-lock + transaction semantics the runner relies on are preserved), so the
// checksum-pinned runner applies 0001→0002→0003→0004 unchanged.

export function createDeliveryRecordingDriver() {
  const committed = {
    schema_migrations: new Map(),
    outbox_message: new Map(), // message_id -> row
    inbox_message: new Map(), // scopeKey(tenant,consumer,event) -> row
    dead_letter_record: new Map(), // dead_letter_id -> row
    delivery_attempt: new Map(), // attempt_id -> row
    inbox_cursor: new Map(), // scopeKey(tenant,consumer,stream) -> row
    inbox_cursor_history: new Map(), // history_id -> row
  };
  // Durable physical-schema catalog (the DDL effect witness).
  const catalog = {
    types: new Map(),
    tables: new Map(), // tableName -> { columns:Set, constraints:Set, body }
    indexes: new Set(),
    functions: new Map(), // function name -> { body }
    triggers: new Map(), // triggerName -> { table, timing, event, fn }
  };
  const lockHolders = new Map();
  const waiters = [];
  let sessionSeq = 0;

  function clone(v) {
    return { ...v };
  }
  function cloneMap(m) {
    return new Map([...m].map(([k, v]) => [k, clone(v)]));
  }
  function cloneStore(s) {
    return {
      schema_migrations: cloneMap(s.schema_migrations),
      outbox_message: cloneMap(s.outbox_message),
      inbox_message: cloneMap(s.inbox_message),
      dead_letter_record: cloneMap(s.dead_letter_record),
      delivery_attempt: cloneMap(s.delivery_attempt),
      inbox_cursor: cloneMap(s.inbox_cursor),
      inbox_cursor_history: cloneMap(s.inbox_cursor_history),
    };
  }
  function scopeKey(...parts) {
    return parts.join('  ');
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

  // --- DDL parsing (the shapes 0004_delivery.sql emits) -------------------------------
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
      const constraints = new Set();
      for (const part of splitTopLevel(body)) {
        const cm = part.match(/^CONSTRAINT\s+(\w+)/i);
        if (cm) {
          constraints.add(cm[1]);
          continue;
        }
        if (/^(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)/i.test(part)) continue;
        const col = part.match(/^(\w+)\s+/);
        if (col) columns.add(col[1]);
      }
      if (!catalog.tables.has(name)) catalog.tables.set(name, { columns, constraints, body });
    }
  }
  function recordAddColumns(sql) {
    const re = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
    let m;
    while ((m = re.exec(sql))) {
      const [, table, col] = m;
      const t = catalog.tables.get(table);
      if (t) t.columns.add(col);
    }
  }
  function recordAddConstraints(sql) {
    const re = /ALTER\s+TABLE\s+(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)/gi;
    let m;
    while ((m = re.exec(sql))) {
      const [, table, con] = m;
      const t = catalog.tables.get(table);
      if (t) t.constraints.add(con);
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
    while ((m = re.exec(sql))) {
      const [, name, body] = m;
      catalog.functions.set(name, { body });
    }
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
    recordTables(sql);
    recordAddColumns(sql);
    recordAddConstraints(sql);
    recordIndexes(sql);
    recordFunctions(sql);
    recordTriggers(sql);
  }

  // --- Guard predicates derived from the parsed plpgsql (not hard-coded) --------------
  function triggerActive(triggerName, table, event, bodyMustMatch) {
    const trig = catalog.triggers.get(triggerName);
    if (!trig || trig.table !== table || trig.timing !== 'BEFORE' || trig.event !== event) {
      return false;
    }
    const fn = catalog.functions.get(trig.fn);
    if (!fn) return false;
    return bodyMustMatch.every((re) => re.test(fn.body || ''));
  }
  // delivery_attempt append-only: the bound fn RAISEs unconditionally on UPDATE.
  function attemptAppendOnly() {
    return triggerActive('delivery_attempt_append_only', 'delivery_attempt', 'UPDATE', [
      /RAISE\s+EXCEPTION/i,
      /append-only/i,
    ]);
  }
  // inbox_cursor no-regress: the bound fn RAISEs when NEW.cursor_seq < OLD.cursor_seq.
  function cursorNoRegress() {
    return triggerActive('inbox_cursor_no_regress', 'inbox_cursor', 'UPDATE', [
      /NEW\.cursor_seq\s*<\s*OLD\.cursor_seq/i,
      /RAISE\s+EXCEPTION/i,
    ]);
  }
  // inbox_cursor_history append-only.
  function cursorHistoryAppendOnly() {
    return triggerActive('inbox_cursor_history_append_only', 'inbox_cursor_history', 'UPDATE', [
      /RAISE\s+EXCEPTION/i,
      /append-only/i,
    ]);
  }
  // Whether the migration declared the partial dedup UNIQUE index on outbox_message.
  function outboxDedupUnique() {
    return catalog.indexes.has('outbox_message_dedup_key_unique');
  }
  // Whether the migration declared the inbox dedup identity (PK / named unique).
  function inboxDedupUnique() {
    return (
      catalog.indexes.has('inbox_message_dedup_unique') ||
      (catalog.tables.get('inbox_message')?.body || '').match(
        /PRIMARY\s+KEY\s*\(\s*tenant_id\s*,\s*consumer\s*,\s*event_id\s*\)/i,
      ) != null
    );
  }

  function uniqueViolation(msg) {
    const err = new Error(msg);
    err.code = '23505';
    return err;
  }
  function restrictViolation(msg) {
    const err = new Error(msg);
    err.code = '2F004'; // restrict_violation family (behavioral marker for the tests)
    err.raised = true;
    return err;
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
          for (const k of Object.keys(committed)) committed[k] = tx[k];
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

      // ---------------------------------------------------------------------------------
      // Delivery data-plane (INSERT-first + guard emulation). The tests drive these
      // directly via db.query(); a matching INSERT/UPDATE flows through the modeled guard.
      // ---------------------------------------------------------------------------------

      // outbox_message INSERT (test seam) — dedup on (tenant_id, dedup_key).
      if (/^INSERT INTO outbox_message/i.test(text)) {
        const row = mapNamed(text, params);
        const store = view().outbox_message;
        if (outboxDedupUnique() && row.dedup_key != null) {
          for (const r of store.values()) {
            if (r.tenant_id === row.tenant_id && r.dedup_key === row.dedup_key) {
              throw uniqueViolation(
                `duplicate outbox dedup_key (${row.tenant_id}, ${row.dedup_key})`,
              );
            }
          }
        }
        store.set(row.message_id, row);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM outbox_message/i.test(text)) {
        const rows = filterRows(view().outbox_message, text, params);
        return { rows, rowCount: rows.length };
      }

      // inbox_message INSERT — dedup on (tenant_id, consumer, event_id).
      if (/^INSERT INTO inbox_message/i.test(text)) {
        const row = mapNamed(text, params);
        const key = scopeKey(row.tenant_id, row.consumer, row.event_id);
        const store = view().inbox_message;
        if (inboxDedupUnique() && store.has(key)) {
          throw uniqueViolation(
            `duplicate inbox event (${row.tenant_id}, ${row.consumer}, ${row.event_id})`,
          );
        }
        store.set(key, row);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM inbox_message/i.test(text)) {
        const rows = filterRows(view().inbox_message, text, params);
        return { rows, rowCount: rows.length };
      }

      // dead_letter_record INSERT — unique per (tenant, origin, origin_message_id).
      if (/^INSERT INTO dead_letter_record/i.test(text)) {
        const row = mapNamed(text, params);
        const store = view().dead_letter_record;
        for (const r of store.values()) {
          if (
            r.tenant_id === row.tenant_id &&
            r.origin === row.origin &&
            r.origin_message_id === row.origin_message_id
          ) {
            throw uniqueViolation(
              `duplicate dead letter (${row.tenant_id}, ${row.origin}, ${row.origin_message_id})`,
            );
          }
        }
        store.set(row.dead_letter_id, row);
        return { rows: [], rowCount: 1 };
      }
      if (/FROM dead_letter_record/i.test(text)) {
        const rows = filterRows(view().dead_letter_record, text, params);
        return { rows, rowCount: rows.length };
      }

      // delivery_attempt INSERT (unique per message,attempt_no) + append-only UPDATE guard.
      if (/^INSERT INTO delivery_attempt/i.test(text)) {
        const row = mapNamed(text, params);
        const store = view().delivery_attempt;
        for (const r of store.values()) {
          if (
            r.tenant_id === row.tenant_id &&
            r.origin === row.origin &&
            r.message_id === row.message_id &&
            String(r.attempt_no) === String(row.attempt_no)
          ) {
            throw uniqueViolation(
              `duplicate delivery attempt (${row.message_id} #${row.attempt_no})`,
            );
          }
        }
        store.set(row.attempt_id, row);
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE delivery_attempt/i.test(text)) {
        if (attemptAppendOnly()) {
          throw restrictViolation('delivery_attempt is append-only');
        }
        return { rows: [], rowCount: 0 };
      }
      if (/FROM delivery_attempt/i.test(text)) {
        const rows = filterRows(view().delivery_attempt, text, params);
        return { rows, rowCount: rows.length };
      }

      // inbox_cursor upsert (INSERT ... ON CONFLICT DO UPDATE) + no-regress guard.
      if (/^INSERT INTO inbox_cursor\b/i.test(text) && !/inbox_cursor_history/i.test(text)) {
        const row = mapNamed(text, params);
        const key = scopeKey(row.tenant_id, row.consumer, row.stream);
        const store = view().inbox_cursor;
        const existing = store.get(key);
        if (!existing) {
          store.set(key, row);
          return { rows: [], rowCount: 1 };
        }
        // ON CONFLICT DO UPDATE ⇒ fires the BEFORE-UPDATE no-regress guard.
        if (cursorNoRegress() && Number(row.cursor_seq) < Number(existing.cursor_seq)) {
          throw restrictViolation(
            `inbox cursor regression (${row.tenant_id}, ${row.consumer}, ${row.stream})`,
          );
        }
        store.set(key, { ...existing, ...row });
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE inbox_cursor\b/i.test(text) && !/inbox_cursor_history/i.test(text)) {
        // Direct UPDATE ... SET cursor_seq=$n WHERE ... — model no-regress.
        const key = updateCursorKey(text, params);
        const store = view().inbox_cursor;
        const existing = store.get(key);
        if (existing) {
          const newSeq = updateNewSeq(text, params);
          if (cursorNoRegress() && newSeq != null && newSeq < Number(existing.cursor_seq)) {
            throw restrictViolation('inbox cursor regression');
          }
          if (newSeq != null) existing.cursor_seq = newSeq;
        }
        return { rows: [], rowCount: existing ? 1 : 0 };
      }
      if (/FROM inbox_cursor\b/i.test(text) && !/inbox_cursor_history/i.test(text)) {
        const rows = filterRows(view().inbox_cursor, text, params);
        return { rows, rowCount: rows.length };
      }

      // inbox_cursor_history INSERT (unique per stream,seq) + append-only UPDATE guard.
      if (/^INSERT INTO inbox_cursor_history/i.test(text)) {
        const row = mapNamed(text, params);
        const store = view().inbox_cursor_history;
        for (const r of store.values()) {
          if (
            r.tenant_id === row.tenant_id &&
            r.consumer === row.consumer &&
            r.stream === row.stream &&
            String(r.cursor_seq) === String(row.cursor_seq)
          ) {
            throw uniqueViolation(
              `duplicate cursor-history seq (${row.stream} @ ${row.cursor_seq})`,
            );
          }
        }
        store.set(row.history_id, row);
        return { rows: [], rowCount: 1 };
      }
      if (/^UPDATE inbox_cursor_history/i.test(text)) {
        if (cursorHistoryAppendOnly()) {
          throw restrictViolation('inbox_cursor_history is append-only');
        }
        return { rows: [], rowCount: 0 };
      }
      if (/FROM inbox_cursor_history/i.test(text)) {
        const rows = filterRows(view().inbox_cursor_history, text, params);
        return { rows, rowCount: rows.length };
      }

      // Any other statement is migration-body DDL — record its catalog effect.
      applyDdl(text);
      return { rows: [], rowCount: 0 };
    }

    return {
      query,
      release() {
        tx = null;
      },
    };
  }

  // --- Minimal INSERT ... VALUES ($n) column mapper -----------------------------------
  // Reads the explicit column list from `INSERT INTO t (a, b, c) VALUES ($1,$2,$3)` and
  // binds params positionally. Repeated placeholders ($10 twice) bind the same param.
  function mapNamed(sql, params) {
    const m = sql.match(/INSERT\s+INTO\s+\w+\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i);
    if (!m) return {};
    const cols = m[1].split(',').map((c) => c.trim());
    const vals = m[2].split(',').map((v) => v.trim());
    const row = {};
    cols.forEach((col, i) => {
      const ph = vals[i];
      const pm = ph && ph.match(/\$(\d+)/);
      row[col] = pm ? params[Number(pm[1]) - 1] : null;
    });
    return row;
  }

  // Filter rows by a trailing `WHERE col=$n AND ...` clause; no clause ⇒ all rows.
  function filterRows(store, sql, params) {
    const all = [...store.values()].map((r) => ({ ...r }));
    const where = sql.match(/WHERE\s+([\s\S]+?)(?:ORDER\s+BY|LIMIT|$)/i);
    if (!where) return all;
    const preds = where[1].split(/\s+AND\s+/i).map((p) => p.trim());
    return all.filter((r) =>
      preds.every((p) => {
        const pm = p.match(/(\w+)\s*=\s*\$(\d+)/);
        if (!pm) return true;
        return String(r[pm[1]]) === String(params[Number(pm[2]) - 1]);
      }),
    );
  }
  function updateCursorKey(sql, params) {
    // UPDATE inbox_cursor SET ... WHERE tenant_id=$a AND consumer=$b AND stream=$c
    const grab = (col) => {
      const pm = sql.match(new RegExp(col + '\\s*=\\s*\\$(\\d+)', 'i'));
      return pm ? params[Number(pm[1]) - 1] : undefined;
    };
    return scopeKey(grab('tenant_id'), grab('consumer'), grab('stream'));
  }
  function updateNewSeq(sql, params) {
    const pm = sql.match(/SET[\s\S]*?cursor_seq\s*=\s*\$(\d+)/i);
    if (!pm) return null;
    const v = params[Number(pm[1]) - 1];
    return v == null ? null : Number(v);
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
    __scopeKey: scopeKey,
  };
}
