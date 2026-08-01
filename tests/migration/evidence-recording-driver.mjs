// Evidence-recording in-memory SqlDriver for the 0006_evidence migration suite
// (Phase 33 / VO-b9b935bf93be10bdecdd / VO-c03b3c1cb5014d1b72e2 / VO-4aeb030a32c9deebdb3b / GAR-006).
//
// Like the audit-ledger recording driver, this records the DDL effects of
// db/migrations/0006_evidence.sql into a durable catalog (the DDL effect witness) AND models the
// evidence data-plane faithfully enough to EXERCISE, through an independent read path with NO live
// PostgreSQL, the phase-primary oracle:
//
//   "Originals MUST remain immutable or tamper-evident; derived repairs, exports, redactions, and
//    dispositions MUST retain provenance, integrity, authorization, retention, and access history."
//
// Concretely it emulates:
//   * ORIGINALS IMMUTABLE / TAMPER-EVIDENT — the evidence_item immutable-core BEFORE UPDATE guard
//     rejects any change to a COMMITTED row's content/provenance identity columns (content_sha256,
//     content_uri, kind, size_bytes, media_type, parent_evidence_id, produced_by/at, created_at),
//     and the BEFORE DELETE guard rejects a hard delete — exactly as the trigger functions RAISE.
//   * DERIVED RETAINS PROVENANCE — the evidence_item CHECK constraints reject a non-original row
//     with no parent (and an original WITH a parent); the evidence_relation table is append-only and
//     rejects a self-edge (acyclicity base case) and a missing transformation digest / authorization.
//   * RETAINS INTEGRITY — content_sha256 / transformation_digest / custody digest are mandatory
//     (NOT NULL + non-empty CHECK); a missing digest is rejected.
//   * RETAINS AUTHORIZATION — evidence_relation + disposition_record require an authorizing
//     principal AND grant.
//   * RETAINS RETENTION — the disposition_record CHECKs reject a disposition executed before the
//     resolved retain_until (retention not elapsed) or while a hold is active (active_hold_count>0).
//   * RETAINS ACCESS HISTORY — evidence_access_log and chain_of_custody are append-only: an UPDATE
//     or DELETE of a recorded row is rejected by the emulated BEFORE-<event> guards, and the row is
//     observed UNCHANGED through an independent SELECT.
//
// It is a strict SUPERSET of the DDL-recording driver (schema_migrations + advisory-lock +
// transaction semantics the runner relies on are preserved), so the checksum-pinned runner applies
// 0001→…→0008 unchanged. The rejection predicates are DERIVED FROM the parsed migration (constraint
// text + trigger/function bodies), not hard-coded, so a migration that neuters a constraint or guard
// disables the emulated rejection — the test double cannot silently grade itself as passing.

export function createEvidenceRecordingDriver() {
  const committed = {
    schema_migrations: new Map(),
    retention_policy: new Map(), // retention_policy_id -> row
    legal_hold: new Map(), // legal_hold_id -> row
    evidence_item: new Map(), // evidence_item_id -> row
    evidence_relation: new Map(), // evidence_relation_id -> row
    evidence_manifest: new Map(), // evidence_manifest_id -> row
    evidence_access_log: new Map(), // access_log_id -> row
    chain_of_custody: new Map(), // custody_id -> row
    disposition_record: new Map(), // disposition_id -> row
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

  const DATA_TABLES = [
    'retention_policy',
    'legal_hold',
    'evidence_item',
    'evidence_relation',
    'evidence_manifest',
    'evidence_access_log',
    'chain_of_custody',
    'disposition_record',
  ];

  function cloneStore(s) {
    const out = {
      schema_migrations: new Map([...s.schema_migrations].map(([k, v]) => [k, { ...v }])),
    };
    for (const t of DATA_TABLES) out[t] = new Map([...s[t]].map(([k, v]) => [k, { ...v }]));
    return out;
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

  // --- DDL parsing (the shapes 0006_evidence.sql emits) -------------------------------
  function recordEnumTypes(sql) {
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

  // A BEFORE-<event> guard is ACTIVE iff the migration installed the trigger on the table AND its
  // bound plpgsql function body actually RAISEs. Derived from parsed SQL, not hard-coded.
  function guardActive(triggerName, table, event) {
    const trig = catalog.triggers.get(triggerName);
    if (!trig || trig.table !== table || trig.timing !== 'BEFORE' || trig.event !== event) {
      return false;
    }
    const fn = catalog.functions.get(trig.fn);
    return !!fn && /RAISE\s+EXCEPTION/i.test(fn.body || '');
  }
  // The immutable-core guard's function body is content-sensitive: it only RAISEs when a content /
  // provenance identity column differs. We detect that the guard is present AND that its body names
  // the content columns (so a neutered body that no longer references content_sha256 disables it).
  function immutableCoreGuardActive() {
    const trig = catalog.triggers.get('evidence_item_immutable_core');
    if (!trig || trig.table !== 'evidence_item' || trig.event !== 'UPDATE') return false;
    const fn = catalog.functions.get(trig.fn);
    const body = (fn && fn.body) || '';
    return /RAISE\s+EXCEPTION/i.test(body) && /content_sha256/i.test(body);
  }

  // Derived CHECK detectors (present iff the migration declared the constraint).
  function constraintPresent(table, predicate) {
    const t = catalog.tables.get(table);
    if (!t) return false;
    for (const expr of t.constraints.values()) if (predicate(expr)) return true;
    return false;
  }
  const derivedHasParentCheck = () =>
    constraintPresent(
      'evidence_item',
      (e) => /parent_evidence_id/i.test(e) && /original/i.test(e) && /NOT\s+NULL/i.test(e),
    );
  const originalNoParentCheck = () =>
    constraintPresent(
      'evidence_item',
      (e) => /parent_evidence_id/i.test(e) && /original/i.test(e) && /IS\s+NULL/i.test(e),
    );
  const relationAuthorizedCheck = () =>
    constraintPresent(
      'evidence_relation',
      (e) => /authorization_principal_id/i.test(e) && /authorization_grant_id/i.test(e),
    );
  const relationDigestCheck = () =>
    constraintPresent('evidence_relation', (e) => /transformation_digest/i.test(e));
  const relationNoSelfEdgeCheck = () =>
    constraintPresent('evidence_relation', (e) =>
      /parent_evidence_id\s*<>\s*child_evidence_id/i.test(e),
    );
  const dispRetentionElapsedCheck = () =>
    constraintPresent(
      'disposition_record',
      (e) => /resolved_retain_until/i.test(e) && /executed_at/i.test(e),
    );
  const dispNoActiveHoldCheck = () =>
    constraintPresent('disposition_record', (e) => /active_hold_count_at_exec\s*=\s*0/i.test(e));
  const dispAuthorizedCheck = () =>
    constraintPresent(
      'disposition_record',
      (e) => /authorization_principal_id/i.test(e) && /authorization_grant_id/i.test(e),
    );
  const dispSignedCheck = () =>
    constraintPresent('disposition_record', (e) => /length\(signature\)/i.test(e));

  // Column order the test's INSERT statements use, per table (named for clarity).
  const COLS = {
    retention_policy: [
      'retention_policy_id',
      'tenant_id',
      'name',
      'applies_to_classifications',
      'duration_millis',
      'disposition_action',
      'owner_principal_id',
      'approved',
      'approved_by_principal_id',
      'version',
      'effective_from',
      'effective_until',
      'review_at',
      'created_at',
    ],
    legal_hold: [
      'legal_hold_id',
      'tenant_id',
      'reason',
      'authority_principal_id',
      'scope_evidence_ids',
      'status',
      'placed_at',
      'released_at',
      'released_by_principal_id',
    ],
    evidence_item: [
      'evidence_item_id',
      'tenant_id',
      'kind',
      'content_uri',
      'content_sha256',
      'size_bytes',
      'media_type',
      'parent_evidence_id',
      'source_catalog_entry_id',
      'source_record_id',
      'produced_by_principal_id',
      'produced_at',
      'observed_at',
      'classification',
      'access_policy_id',
      'retention_policy_id',
      'retain_until',
      'legal_hold_count',
      'integrity_status',
      'encryption_key_ref',
      'storage_version_id',
      'status',
      'created_at',
    ],
    evidence_relation: [
      'evidence_relation_id',
      'tenant_id',
      'parent_evidence_id',
      'child_evidence_id',
      'relationship',
      'method',
      'transformation_digest',
      'tool_adapter_version',
      'actor_principal_id',
      'reason',
      'created_at',
      'authorization_principal_id',
      'authorization_grant_id',
    ],
    evidence_manifest: [
      'evidence_manifest_id',
      'tenant_id',
      'manifest_type',
      'scope',
      'evidence_item_ids',
      'canonical_digest',
      'created_by_principal_id',
      'created_at',
      'policy_version_ids',
      'control_version_ids',
      'standard_version_ids',
      'missing_evidence_ids',
      'signing_key_id',
      'signature_algorithm',
      'signature',
      'status',
      'verification_history',
    ],
    evidence_access_log: [
      'access_log_id',
      'tenant_id',
      'evidence_item_id',
      'principal_id',
      'action',
      'purpose',
      'decision',
      'access_policy_id',
      'correlation_id',
      'accessed_at',
    ],
    chain_of_custody: [
      'custody_id',
      'tenant_id',
      'evidence_item_id',
      'sequence',
      'event_type',
      'from_principal_id',
      'to_principal_id',
      'reason',
      'content_sha256',
      'occurred_at',
    ],
    disposition_record: [
      'disposition_id',
      'tenant_id',
      'evidence_item_id',
      'method',
      'resolved_policy_ids',
      'cleared_hold_ids',
      'resolved_retain_until',
      'active_hold_count_at_exec',
      'authorization_principal_id',
      'authorization_grant_id',
      'executed_by_principal_id',
      'executed_at',
      'content_sha256',
      'access_history',
      'verification_status',
      'signing_key_id',
      'signature_algorithm',
      'signature',
    ],
  };
  const PK = {
    retention_policy: 'retention_policy_id',
    legal_hold: 'legal_hold_id',
    evidence_item: 'evidence_item_id',
    evidence_relation: 'evidence_relation_id',
    evidence_manifest: 'evidence_manifest_id',
    evidence_access_log: 'access_log_id',
    chain_of_custody: 'custody_id',
    disposition_record: 'disposition_id',
  };

  function fail(message, code) {
    const err = new Error(message);
    err.code = code;
    return err;
  }
  function rowFromParams(table, params) {
    const row = {};
    COLS[table].forEach((c, i) => (row[c] = params[i] === undefined ? null : params[i]));
    return row;
  }
  function enforceNotNull(table, row) {
    const t = catalog.tables.get(table);
    if (!t) throw fail(`relation "${table}" does not exist`, '42P01');
    for (const col of t.notNull) {
      if (row[col] === null || row[col] === undefined) {
        throw fail(`null value in column "${col}" violates not-null constraint`, '23502');
      }
    }
    return t;
  }

  function insert(table, params, view) {
    const row = rowFromParams(table, params);
    enforceNotNull(table, row);
    const store = view[table];

    if (table === 'evidence_item') {
      if (row.integrity_status == null) row.integrity_status = 'unverified';
      if (row.status == null) row.status = 'pending';
      // Provenance CHECKs.
      if (originalNoParentCheck() && row.kind === 'original' && row.parent_evidence_id != null) {
        throw fail('evidence_item_original_has_no_parent check violation', '23514');
      }
      if (derivedHasParentCheck() && row.kind !== 'original' && row.parent_evidence_id == null) {
        throw fail('evidence_item_derived_has_parent check violation', '23514');
      }
      // Content digest present.
      if (
        constraintPresent('evidence_item', (e) => /length\(content_sha256\)/i.test(e)) &&
        !(row.content_sha256 && String(row.content_sha256).length > 0)
      ) {
        throw fail('evidence_item_content_digest_present check violation', '23514');
      }
    }

    if (table === 'evidence_relation') {
      if (relationNoSelfEdgeCheck() && row.parent_evidence_id === row.child_evidence_id) {
        throw fail('evidence_relation_no_self_edge check violation', '23514');
      }
      if (
        relationAuthorizedCheck() &&
        (row.authorization_principal_id == null || row.authorization_grant_id == null)
      ) {
        throw fail('evidence_relation_authorized check violation', '23514');
      }
      if (
        relationDigestCheck() &&
        !(row.transformation_digest && String(row.transformation_digest).length > 0)
      ) {
        throw fail('evidence_relation_digest_present check violation', '23514');
      }
      // UNIQUE (tenant, parent, child, relationship).
      for (const e of store.values()) {
        if (
          e.tenant_id === row.tenant_id &&
          e.parent_evidence_id === row.parent_evidence_id &&
          e.child_evidence_id === row.child_evidence_id &&
          e.relationship === row.relationship
        ) {
          throw fail('duplicate evidence_relation edge', '23505');
        }
      }
    }

    if (table === 'disposition_record') {
      if (
        dispAuthorizedCheck() &&
        (row.authorization_principal_id == null || row.authorization_grant_id == null)
      ) {
        throw fail('disposition_record_authorized check violation', '23514');
      }
      if (dispSignedCheck() && !(row.signature && String(row.signature).length > 0)) {
        throw fail('disposition_record_signed check violation', '23514');
      }
      if (dispNoActiveHoldCheck() && Number(row.active_hold_count_at_exec) !== 0) {
        throw fail('disposition_record_no_active_hold check violation', '23514');
      }
      if (
        dispRetentionElapsedCheck() &&
        row.resolved_retain_until != null &&
        Number(row.executed_at) < Number(row.resolved_retain_until)
      ) {
        throw fail('disposition_record_retention_elapsed check violation', '23514');
      }
      // UNIQUE (tenant, evidence_item): an item is disposed once.
      for (const e of store.values()) {
        if (e.tenant_id === row.tenant_id && e.evidence_item_id === row.evidence_item_id) {
          throw fail('duplicate disposition for evidence item', '23505');
        }
      }
    }

    if (table === 'chain_of_custody') {
      // UNIQUE (tenant, evidence_item, sequence): custody order cannot fork.
      for (const e of store.values()) {
        if (
          e.tenant_id === row.tenant_id &&
          e.evidence_item_id === row.evidence_item_id &&
          Number(e.sequence) === Number(row.sequence)
        ) {
          throw fail('duplicate custody sequence', '23505');
        }
      }
    }

    const pk = row[PK[table]];
    if (pk == null) throw fail(`null value in PK column "${PK[table]}"`, '23502');
    if (store.has(pk)) throw fail(`duplicate ${table} primary key`, '23505');
    store.set(pk, row);
    return { rows: [], rowCount: 1 };
  }

  // The immutable-core UPDATE emulation: only reject when a COMMITTED evidence_item's content /
  // provenance identity column would change. A lifecycle-only update (status/integrity/retention)
  // is allowed, matching the trigger body.
  const IMMUTABLE_CORE_COLS = [
    'content_sha256',
    'content_uri',
    'kind',
    'size_bytes',
    'media_type',
    'parent_evidence_id',
    'produced_by_principal_id',
    'produced_at',
    'created_at',
  ];
  function updateEvidenceItem(setCol, setVal, whereId, view) {
    const store = view.evidence_item;
    const row = store.get(whereId);
    if (!row) return { rows: [], rowCount: 0 };
    if (immutableCoreGuardActive() && row.status !== 'pending') {
      if (IMMUTABLE_CORE_COLS.includes(setCol) && row[setCol] !== setVal) {
        throw fail(
          `evidence_item ${whereId} is committed and tamper-evident: content/provenance cannot be mutated`,
          '2F004',
        );
      }
    }
    const next = { ...row, [setCol]: setVal };
    store.set(whereId, next);
    return { rows: [], rowCount: 1 };
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
          for (const t of DATA_TABLES) committed[t] = tx[t];
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

      // --- data-plane, dispatched per table ------------------------------------------
      for (const table of DATA_TABLES) {
        if (new RegExp(`^INSERT INTO ${table}\\b`, 'i').test(text)) {
          return insert(table, params, view());
        }
      }

      // evidence_item UPDATE — immutable-core guard (content columns) vs lifecycle-allowed.
      if (/^UPDATE evidence_item\b/i.test(text)) {
        // Parse "SET <col>=$1 WHERE evidence_item_id=$2".
        const setm = text.match(/SET\s+(\w+)\s*=\s*\$1/i);
        return updateEvidenceItem(setm ? setm[1] : '', params[0], params[1], view());
      }
      if (/^DELETE FROM evidence_item\b/i.test(text)) {
        if (guardActive('evidence_item_no_delete', 'evidence_item', 'DELETE')) {
          throw fail('evidence_item cannot be hard-deleted', '2F004');
        }
        return { rows: [], rowCount: 0 };
      }

      // Append-only tables: UPDATE/DELETE rejected by the emulated guards.
      const APPEND_ONLY = {
        evidence_relation: [
          'evidence_relation_append_only_update',
          'evidence_relation_append_only_delete',
        ],
        evidence_manifest: ['evidence_manifest_immutable', 'evidence_manifest_no_delete'],
        evidence_access_log: [
          'evidence_access_log_append_only_update',
          'evidence_access_log_append_only_delete',
        ],
        chain_of_custody: [
          'chain_of_custody_append_only_update',
          'chain_of_custody_append_only_delete',
        ],
        disposition_record: [
          'disposition_record_immutable_update',
          'disposition_record_immutable_delete',
        ],
      };
      for (const [table, [upTrig, delTrig]] of Object.entries(APPEND_ONLY)) {
        if (new RegExp(`^UPDATE ${table}\\b`, 'i').test(text)) {
          if (guardActive(upTrig, table, 'UPDATE')) {
            throw fail(`${table} is append-only: UPDATE rejected`, '2F004');
          }
          return { rows: [], rowCount: 0 };
        }
        if (new RegExp(`^DELETE FROM ${table}\\b`, 'i').test(text)) {
          if (guardActive(delTrig, table, 'DELETE')) {
            throw fail(`${table} is append-only: DELETE rejected`, '2F004');
          }
          return { rows: [], rowCount: 0 };
        }
      }

      // SELECT read paths (independent observation).
      for (const table of DATA_TABLES) {
        if (new RegExp(`FROM ${table}\\b`, 'i').test(text)) {
          const store = view()[table];
          let rows = [...store.values()].map((r) => ({ ...r }));
          // Optional first-positional filter matching the table's PK, its tenant, or (for the
          // per-item history tables) its evidence_item_id — whichever the query keys on.
          if (params.length >= 1 && params[0] != null) {
            rows = rows.filter(
              (r) =>
                r[PK[table]] === params[0] ||
                r.tenant_id === params[0] ||
                r.evidence_item_id === params[0],
            );
          }
          if (table === 'chain_of_custody') rows.sort((a, b) => a.sequence - b.sequence);
          return { rows, rowCount: rows.length };
        }
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
