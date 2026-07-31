// DDL-recording in-memory SqlDriver for the tenant-RLS migration suite (Phase 19).
//
// Superset of tests/migration/ddl-recording-driver.mjs: it records everything that
// driver does (enum types, tables + columns + constraints, indexes) so it can apply the
// FULL ordered migration set (0001_tenancy_authority.sql THEN 0002_tenant_rls.sql), AND
// additionally records the physical-security objects 0002 emits:
//
//   * row-level-security state per table:  rls[table] = { enabled, forced }
//   * policies:                            policies -> Map(table -> Map(policyName -> {as, cmd, using, check}))
//   * roles:                               roles -> Map(roleName -> { attrs:Set })
//   * grants / revokes:                    grants -> per (table,role) -> Set(privilege)
//   * composite (multi-column) FKs + UNIQUEs recorded on the table.
//
// Applying the migration therefore yields a durable, independently observable effect
// (the security catalog) that could NOT exist before the migration ran — the
// effect-witness — without needing a live PostgreSQL. schema_migrations /
// idempotency_ledger + advisory-lock + transaction semantics are preserved so the real
// checksum-pinned runner drives it unchanged.

export function createRlsRecordingDriver() {
  const committed = {
    schema_migrations: new Map(),
    idempotency_ledger: new Map(),
  };
  const catalog = {
    types: new Map(), // typeName -> [values]
    tables: new Map(), // tableName -> { columns:Set, constraints:Map(name->def), body }
    indexes: new Set(), // indexName
    // --- security objects (the RLS effect witness) ---
    rls: new Map(), // tableName -> { enabled:bool, forced:bool }
    policies: new Map(), // tableName -> Map(policyName -> { as, cmd, using, check })
    roles: new Map(), // roleName -> { attrs:Set<string> }
    grants: new Map(), // `${table}${role}` -> Set<privilege>
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

  // ---------- shared DDL parsing (tables/types/indexes) — same shapes as 0001 --------
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
    const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(/gi;
    let m;
    while ((m = re.exec(sql))) {
      const name = m[1];
      let i = re.lastIndex - 1;
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
      re.lastIndex = i + 1;
      const columns = new Set();
      const constraints = new Map();
      for (const part of splitTopLevel(body)) {
        const cm = part.match(/^CONSTRAINT\s+(\w+)\s+([\s\S]*)$/i);
        if (cm) {
          constraints.set(cm[1], cm[2].replace(/\s+/g, ' ').trim());
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

  // ---------- Phase-19 security-object parsing --------------------------------------
  function ensureRls(table) {
    if (!catalog.rls.has(table)) catalog.rls.set(table, { enabled: false, forced: false });
    return catalog.rls.get(table);
  }
  function recordRls(stmt) {
    let m = stmt.match(/^ALTER\s+TABLE\s+(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY$/i);
    if (m) {
      ensureRls(m[1]).enabled = true;
      return true;
    }
    m = stmt.match(/^ALTER\s+TABLE\s+(\w+)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY$/i);
    if (m) {
      ensureRls(m[1]).forced = true;
      return true;
    }
    return false;
  }
  function recordAlterAddConstraint(stmt) {
    // ALTER TABLE <t> ADD CONSTRAINT <name> <definition...>
    const m = stmt.match(/^ALTER\s+TABLE\s+(\w+)\s+ADD\s+CONSTRAINT\s+(\w+)\s+([\s\S]*)$/i);
    if (!m) return false;
    const [, table, cname, def] = m;
    if (!catalog.tables.has(table))
      catalog.tables.set(table, { columns: new Set(), constraints: new Map(), body: '' });
    catalog.tables.get(table).constraints.set(cname, def.replace(/\s+/g, ' ').trim());
    return true;
  }
  function recordPolicy(stmt) {
    // DROP POLICY IF EXISTS <name> ON <table>
    let m = stmt.match(/^DROP\s+POLICY\s+IF\s+EXISTS\s+(\w+)\s+ON\s+(\w+)$/i);
    if (m) {
      const byTable = catalog.policies.get(m[2]);
      if (byTable) byTable.delete(m[1]);
      return true;
    }
    // CREATE POLICY <name> ON <table> [AS RESTRICTIVE|PERMISSIVE] [FOR <cmd>]
    //   [USING (...)] [WITH CHECK (...)]
    m = stmt.match(/^CREATE\s+POLICY\s+(\w+)\s+ON\s+(\w+)\s*([\s\S]*)$/i);
    if (!m) return false;
    const [, name, table, rest] = m;
    const asM = rest.match(/\bAS\s+(RESTRICTIVE|PERMISSIVE)\b/i);
    const forM = rest.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i);
    const usingM = rest.match(/\bUSING\s*\(([\s\S]*?)\)\s*(?:WITH\s+CHECK|$)/i);
    const checkM = rest.match(/\bWITH\s+CHECK\s*\(([\s\S]*?)\)\s*$/i);
    if (!catalog.policies.has(table)) catalog.policies.set(table, new Map());
    catalog.policies.get(table).set(name, {
      as: asM ? asM[1].toLowerCase() : 'permissive',
      cmd: forM ? forM[1].toUpperCase() : 'ALL',
      using: usingM ? usingM[1].replace(/\s+/g, ' ').trim() : null,
      check: checkM ? checkM[1].replace(/\s+/g, ' ').trim() : null,
    });
    return true;
  }
  function recordRole(stmt) {
    // CREATE ROLE <name> <attrs...>   (inside DO blocks we also see this exact text)
    let m = stmt.match(/\bCREATE\s+ROLE\s+(\w+)\s+([\s\S]*?)(?:;|$)/i);
    if (m) {
      const name = m[1];
      const attrs = new Set(m[2].toUpperCase().split(/\s+/).filter(Boolean));
      if (!catalog.roles.has(name)) catalog.roles.set(name, { attrs });
      else for (const a of attrs) catalog.roles.get(name).attrs.add(a);
      return true;
    }
    // ALTER ROLE <name> <attrs...>
    m = stmt.match(/^ALTER\s+ROLE\s+(\w+)\s+([\s\S]*)$/i);
    if (m) {
      const name = m[1];
      const attrs = m[2].toUpperCase().split(/\s+/).filter(Boolean);
      if (!catalog.roles.has(name)) catalog.roles.set(name, { attrs: new Set() });
      const r = catalog.roles.get(name);
      // ALTER can flip a NO<X> <-> <X>; model that so a later ALTER wins.
      for (const a of attrs) {
        if (a.startsWith('NO')) {
          r.attrs.delete(a.slice(2));
          r.attrs.add(a);
        } else {
          r.attrs.delete('NO' + a);
          r.attrs.add(a);
        }
      }
      return true;
    }
    return false;
  }
  function grantKey(table, role) {
    return table + ' ' + role;
  }
  function recordGrant(stmt) {
    // GRANT <privs> ON <table> TO <role>
    let m = stmt.match(/^GRANT\s+([\s\S]+?)\s+ON\s+(\w+)\s+TO\s+(\w+)$/i);
    if (m) {
      const privs = m[1].split(',').map((p) => p.trim().toUpperCase());
      const key = grantKey(m[2], m[3]);
      if (!catalog.grants.has(key)) catalog.grants.set(key, new Set());
      for (const p of privs) catalog.grants.get(key).add(p);
      return true;
    }
    // REVOKE <privs> ON <table> FROM <role>
    m = stmt.match(/^REVOKE\s+([\s\S]+?)\s+ON\s+(\w+)\s+FROM\s+(\w+)$/i);
    if (m) {
      const privs = m[1].split(',').map((p) => p.trim().toUpperCase());
      const key = grantKey(m[2], m[3]);
      const set = catalog.grants.get(key);
      if (set) for (const p of privs) set.delete(p);
      return true;
    }
    return false;
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

  // Split a migration body into statements on top-level semicolons, keeping DO $$ ... $$
  // dollar-quoted blocks intact (they contain their own semicolons).
  function splitStatements(sql) {
    const out = [];
    let cur = '';
    let i = 0;
    let inDollar = false;
    while (i < sql.length) {
      if (!inDollar && sql.startsWith('$$', i)) {
        inDollar = true;
        cur += '$$';
        i += 2;
        continue;
      }
      if (inDollar && sql.startsWith('$$', i)) {
        inDollar = false;
        cur += '$$';
        i += 2;
        continue;
      }
      const ch = sql[i];
      if (ch === ';' && !inDollar) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        i++;
        continue;
      }
      cur += ch;
      i++;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function applyStatement(raw) {
    const stmt = raw.replace(/\s+/g, ' ').trim();
    // DO blocks: record whatever CREATE ROLE they contain, then done.
    if (/^DO\s+\$\$/i.test(stmt)) {
      recordEnumTypes(stmt); // guarded CREATE TYPE inside DO blocks (0001)
      recordRole(stmt); // guarded CREATE ROLE inside DO blocks (0002)
      return;
    }
    if (/^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i.test(stmt)) return; // current_tenant()
    if (recordRls(stmt)) return;
    if (recordPolicy(stmt)) return;
    if (recordRole(stmt)) return;
    if (recordGrant(stmt)) return;
    if (recordAlterAddConstraint(stmt)) return;
    // Fall through to the create-table/type/index recorders (0001 body).
    recordEnumTypes(stmt);
    recordTables(stmt);
    recordIndexes(stmt);
  }

  function applyDdl(rawSql) {
    const sql = stripComments(rawSql);
    for (const stmt of splitStatements(sql)) applyStatement(stmt);
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
    __catalog: catalog,
    __committed: committed,
  };
}
