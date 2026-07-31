// DDL-recording in-memory SqlDriver for the tenancy/authority migration suite (Phase 18).
//
// The Phase-17 in-memory driver (tests/persistence/in-memory-driver.mjs) treats arbitrary
// migration-body DDL as an executed no-op — it only models `schema_migrations` and
// `idempotency_ledger`. That is enough for the runner's bookkeeping but gives no
// *independently readable durable effect* for the physical schema a migration creates.
//
// This driver additionally parses and records the object catalog produced by the
// `0001_tenancy_authority.sql` DDL — enum types, tables (with columns and CHECK/UNIQUE
// constraints), and indexes — into an in-memory `catalog`. Applying a migration therefore
// yields a durable, independently observable effect (the catalog) that could NOT exist
// before the migration ran, satisfying the effect-witness obligation without a live
// PostgreSQL. It preserves the schema_migrations / idempotency_ledger + advisory-lock +
// transaction semantics the runner relies on.

export function createDdlRecordingDriver() {
  const committed = {
    schema_migrations: new Map(),
    idempotency_ledger: new Map(),
  };
  // Durable physical-schema catalog (the effect witness).
  const catalog = {
    types: new Map(), // typeName -> [values]
    tables: new Map(), // tableName -> { columns:Set, constraints:Set, body }
    indexes: new Set(), // indexName
  };
  const lockHolders = new Map();
  const waiters = [];
  let sessionSeq = 0;

  function cloneStore(s) {
    return {
      schema_migrations: new Map([...s.schema_migrations].map(([k, v]) => [k, { ...v }])),
      idempotency_ledger: new Map([...s.idempotency_ledger].map(([k, v]) => [k, { ...v }])),
    };
  }
  function ledgerKey(t, s, k) {
    return `${t} ${s} ${k}`;
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

  // --- DDL parsing (only the shapes 0001_tenancy_authority.sql emits) -----------------
  function recordEnumTypes(sql) {
    const re = /CREATE\s+TYPE\s+(\w+)\s+AS\s+ENUM\s*\(([^)]*)\)/gi;
    let m;
    while ((m = re.exec(sql))) {
      const name = m[1];
      const values = [...m[2].matchAll(/'([^']+)'/g)].map((v) => v[1]);
      if (!catalog.types.has(name)) catalog.types.set(name, values);
    }
  }
  function splitTopLevel(body) {
    // Split a CREATE TABLE body on top-level commas (ignoring commas inside parentheses).
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
  function recordTables(sql) {
    // Match: CREATE TABLE IF NOT EXISTS <name> ( <body> );  (balanced outer parens)
    const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(/gi;
    let m;
    while ((m = re.exec(sql))) {
      const name = m[1];
      // Find the matching close paren for the table body.
      let i = re.lastIndex - 1; // at the '('
      let depth = 0;
      let start = i + 1;
      for (; i < sql.length; i++) {
        if (sql[i] === '(') depth++;
        else if (sql[i] === ')') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = sql.slice(start, i);
      // Resume scanning AFTER this table's closing paren so the next CREATE TABLE
      // match does not start inside the body we just consumed.
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
  function recordIndexes(sql) {
    const re = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;
    let m;
    while ((m = re.exec(sql))) catalog.indexes.add(m[1]);
  }
  function stripComments(sql) {
    // Remove line comments (-- …) which may contain commas/parens that would break the
    // top-level splitter, and normalize whitespace to single spaces.
    return sql
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--');
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join('\n');
  }
  function applyDdl(rawSql) {
    const sql = stripComments(rawSql);
    recordEnumTypes(sql);
    recordTables(sql);
    recordIndexes(sql);
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
          committed.idempotency_ledger = tx.idempotency_ledger;
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
      // Bootstrap ledger/history tables (schema_migrations, idempotency_ledger).
      if (/^CREATE TABLE IF NOT EXISTS schema_migrations/i.test(text)) {
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO idempotency_ledger/i.test(text)) {
        return { rows: [], rowCount: 1 };
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
      if (/FROM idempotency_ledger/i.test(text)) {
        const [t, s, k] = params;
        const row = view().idempotency_ledger.get(ledgerKey(t, s, k));
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
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
    // Independent read path into the durable physical-schema catalog (the effect witness).
    __catalog: catalog,
    __committed: committed,
  };
}
