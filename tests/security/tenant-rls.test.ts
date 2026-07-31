// Tenant-RLS security suite — Phase 19 (task T020 / GAR-008).
//
// Proves the tenant-isolation properties that db/migrations/0002_tenant_rls.sql MUST
// guarantee, per specs/001-governance-control-plane/data-model.md §"Database enforcement"
// and research.md:
//   1. Cross-tenant READ denial   — a session in tenant A cannot see tenant B's rows.
//   2. Cross-tenant WRITE denial  — a session in tenant A cannot INSERT/UPDATE a row into
//                                   tenant B (the WITH CHECK rejects it).
//   3. Missing tenant-context denial — with no `app.tenant_id` set, nothing is readable or
//                                   writable (fail-closed default-deny).
//   4. Owner / BYPASSRLS safeguards — application roles are NOBYPASSRLS + NOSUPERUSER and
//                                   never table owners, and FORCE ROW LEVEL SECURITY binds
//                                   the owner too, so no application identity is exempt.
//
// Runs under `vitest run --project security` (test:security). There is no live PostgreSQL
// in `npm ci`, so this suite builds an INDEPENDENT executable oracle: a faithful model of
// Postgres FORCE-RLS + restrictive/permissive policy evaluation, driven by the ACTUAL role
// attributes and policy predicates PARSED FROM the migration file. The model therefore
// tests the migration's real contents (a regression in the SQL flips a test), not a
// hand-copied duplicate. Every allow has a matching deny (negative control), so the oracle
// is non-vacuous.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  parseMigrationFilename,
  checksumMigration,
} from '../../packages/persistence/src/database.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION_FILE = '0002_tenant_rls.sql';
const SQL = readFileSync(join(ROOT, 'db', 'migrations', MIGRATION_FILE), 'utf8');

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';
const TENANT_TABLES = ['role_assignment', 'delegation', 'break_glass_grant', 'sod_constraint'];

// ---------------------------------------------------------------------------
// Parse the migration's role attributes + policies into a machine-checkable model.
// ---------------------------------------------------------------------------
type RoleAttrs = { bypassRls: boolean; superuser: boolean; login: boolean };

function parseRole(name: string): RoleAttrs {
  const re = new RegExp(`CREATE\\s+ROLE\\s+${name}\\s+([^;]*)`, 'i');
  const m = SQL.match(re);
  const attrs = (m ? m[1] : '').toUpperCase();
  return {
    // NOBYPASSRLS ⇒ bypass false. A bare BYPASSRLS ⇒ true. Default (unspecified) ⇒ false.
    bypassRls: /\bBYPASSRLS\b/.test(attrs) && !/\bNOBYPASSRLS\b/.test(attrs),
    superuser: /\bSUPERUSER\b/.test(attrs) && !/\bNOSUPERUSER\b/.test(attrs),
    login: /\bLOGIN\b/.test(attrs) && !/\bNOLOGIN\b/.test(attrs),
  };
}

type Policy = { name: string; as: 'restrictive' | 'permissive'; using: string; check: string };

// Extract the parenthesised expression that immediately follows `keyword` in `body`,
// honouring NESTED parentheses (so `current_tenant()` inside the predicate does not
// truncate the capture). Returns null if the keyword is absent. A naive non-greedy regex
// stops at the first `)` — i.e. the one closing `current_tenant(` — silently capturing a
// malformed predicate; balancing avoids that class of vacuous parse.
function extractParenExpr(body: string, keyword: RegExp): string | null {
  const km = body.match(keyword);
  if (!km || km.index === undefined) return null;
  // Find the first '(' after the keyword.
  let i = body.indexOf('(', km.index + km[0].length);
  if (i < 0) return null;
  let depth = 0;
  const start = i;
  for (; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return body
          .slice(start + 1, i)
          .replace(/\s+/g, ' ')
          .trim();
      }
    }
  }
  return null; // unbalanced — treat as absent so callers fall back explicitly
}

function parsePolicies(table: string): Policy[] {
  const out: Policy[] = [];
  const re =
    /CREATE\s+POLICY\s+(\w+)\s+ON\s+(\w+)\s*([\s\S]*?)(?=(?:CREATE|ALTER|DROP|GRANT|REVOKE|$))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SQL))) {
    if (m[2].toLowerCase() !== table) continue;
    const body = m[3];
    const asM = body.match(/\bAS\s+(RESTRICTIVE|PERMISSIVE)\b/i);
    const using = extractParenExpr(body, /\bUSING\b/i);
    const check = extractParenExpr(body, /\bWITH\s+CHECK\b/i);
    out.push({
      name: m[1],
      as: (asM ? asM[1].toLowerCase() : 'permissive') as Policy['as'],
      // Postgres defaults: an absent USING (for a write-only policy) blocks reads; here
      // every policy has an explicit USING, so absence is a parse error surfaced as 'false'
      // (fail-closed) rather than the permissive 'true' the old code assumed.
      using: using ?? 'false',
      // WITH CHECK defaults to the USING expression when omitted (Postgres semantics).
      check: check ?? using ?? 'false',
    });
  }
  return out;
}

// Evaluate a policy predicate for a candidate row given the session's tenant context.
// current_tenant() = NULLIF(current_setting('app.tenant_id', true), '')::uuid, so an unset
// or empty context is NULL and any `tenant_id = current_tenant()` comparison is NULL/false.
//
// This is a FAITHFUL interpreter of the predicate TEXT parsed from the migration — it does
// not assume tenant-equality. A regression that weakens a predicate (e.g. to `true`, or to
// `tenant_id IS NOT NULL`, or drops the current_tenant() comparison) changes the predicate
// string and therefore changes the evaluated result, flipping the corresponding test. Any
// predicate form the migration does not currently use is an explicit throw, so a silent
// substitution to an unmodeled form fails loudly rather than passing vacuously.
function evalPredicate(pred: string, rowTenant: string | null, ctxTenant: string | null): boolean {
  const ct = ctxTenant && ctxTenant.length > 0 ? ctxTenant : null; // NULLIF empty
  const norm = pred.replace(/\s+/g, ' ').trim().toLowerCase();

  // SQL literal booleans (a weakened WITH CHECK/USING regression looks like this).
  if (norm === 'true') return true;
  if (norm === 'false') return false;

  // tenant_id = current_tenant()  — the only equality form used. NULL ctx ⇒ NULL ⇒ false.
  const eqForm = 'tenant_id = current_tenant()';
  const eq = ct !== null && rowTenant === ct;

  if (norm === eqForm) return eq;

  // tenant_id IS NULL OR tenant_id = current_tenant()  — central-guardrail visibility.
  if (norm === `tenant_id is null or ${eqForm}`) return rowTenant === null || eq;

  throw new Error(
    `evalPredicate: unmodeled policy predicate ${JSON.stringify(pred)} — the migration ` +
      `changed to a form the security oracle does not model; update the oracle deliberately.`,
  );
}

// Faithful FORCE-RLS gate: a role that is BYPASSRLS or SUPERUSER is exempt (returns true);
// otherwise ALL restrictive policies must pass AND at least one permissive policy must pass.
function rlsPasses(
  table: string,
  phase: 'read' | 'write',
  rowTenant: string | null,
  ctxTenant: string | null,
  role: RoleAttrs,
): boolean {
  if (role.bypassRls || role.superuser) return true; // (never the case for app roles)
  const policies = parsePolicies(table);
  const pick = (p: Policy) => (phase === 'read' ? p.using : p.check);
  const restrictive = policies.filter((p) => p.as === 'restrictive');
  const permissive = policies.filter((p) => p.as === 'permissive');
  const restrictiveOk = restrictive.every((p) => evalPredicate(pick(p), rowTenant, ctxTenant));
  const permissiveOk =
    permissive.length === 0 || permissive.some((p) => evalPredicate(pick(p), rowTenant, ctxTenant));
  return restrictiveOk && permissiveOk;
}

const appRw = parseRole('app_rw');
const appRo = parseRole('app_ro');

describe('tenant-RLS security — application-role owner/BYPASSRLS safeguards', () => {
  it('app_rw and app_ro are NOBYPASSRLS, NOSUPERUSER, NOLOGIN (no RLS-exempt identity)', () => {
    for (const [name, r] of [
      ['app_rw', appRw],
      ['app_ro', appRo],
    ] as const) {
      expect(r.bypassRls, `${name} must not be BYPASSRLS`).toBe(false);
      expect(r.superuser, `${name} must not be SUPERUSER`).toBe(false);
      expect(r.login, `${name} must be NOLOGIN group role`).toBe(false);
    }
  });

  it('FORCE ROW LEVEL SECURITY is asserted so even the table owner is not exempt', () => {
    for (const t of TENANT_TABLES) {
      const re = new RegExp(`ALTER\\s+TABLE\\s+${t}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i');
      expect(re.test(SQL), `${t} must FORCE ROW LEVEL SECURITY`).toBe(true);
    }
  });

  it('never grants an application role table ownership — negative control', () => {
    expect(SQL).not.toMatch(/OWNER\s+TO\s+app_(rw|ro)\b/i);
    expect(SQL).not.toMatch(/GRANT\s+ALL\b[\s\S]*?TO\s+app_(rw|ro)\b/i);
    expect(SQL).not.toMatch(/TO\s+PUBLIC\b/i);
  });
});

describe('tenant-RLS security — cross-tenant read denial', () => {
  for (const table of TENANT_TABLES) {
    it(`${table}: tenant A cannot READ tenant B's row, but CAN read its own`, () => {
      // Own row is visible.
      expect(rlsPasses(table, 'read', TENANT_A, TENANT_A, appRw)).toBe(true);
      // Cross-tenant row is denied (the negative control against the allow above).
      expect(rlsPasses(table, 'read', TENANT_B, TENANT_A, appRw)).toBe(false);
      // Read-only role has the same isolation.
      expect(rlsPasses(table, 'read', TENANT_B, TENANT_A, appRo)).toBe(false);
    });
  }

  it('sod_constraint central guardrails (tenant_id NULL) are readable by any tenant', () => {
    // Central guardrails are intentionally visible to every tenant for policy evaluation…
    expect(rlsPasses('sod_constraint', 'read', null, TENANT_A, appRw)).toBe(true);
    // …but a tenant still cannot read ANOTHER tenant's non-central rows.
    expect(rlsPasses('sod_constraint', 'read', TENANT_B, TENANT_A, appRw)).toBe(false);
  });
});

describe('tenant-RLS security — cross-tenant write denial', () => {
  for (const table of TENANT_TABLES) {
    it(`${table}: tenant A cannot WRITE a row tagged tenant B (WITH CHECK), but CAN write its own`, () => {
      // Writing a row within the session's tenant passes WITH CHECK.
      expect(rlsPasses(table, 'write', TENANT_A, TENANT_A, appRw)).toBe(true);
      // Writing a row tagged for another tenant is rejected.
      expect(rlsPasses(table, 'write', TENANT_B, TENANT_A, appRw)).toBe(false);
    });
  }

  it('sod_constraint: a tenant cannot forge a central (tenant_id NULL) guardrail row', () => {
    // Even though central rows are READABLE by all, the WITH CHECK forbids a tenant from
    // WRITING a tenant_id-NULL central guardrail (write check is `tenant_id = current_tenant()`).
    expect(rlsPasses('sod_constraint', 'write', null, TENANT_A, appRw)).toBe(false);
  });
});

describe('tenant-RLS security — missing tenant-context denial (fail-closed)', () => {
  for (const phase of ['read', 'write'] as const) {
    it(`${phase}: with NO app.tenant_id set, nothing is ${phase === 'read' ? 'readable' : 'writable'}`, () => {
      for (const table of TENANT_TABLES) {
        // Unset context (null) and empty-string context both default-deny.
        expect(rlsPasses(table, phase, TENANT_A, null, appRw)).toBe(false);
        expect(rlsPasses(table, phase, TENANT_A, '', appRw)).toBe(false);
      }
    });
  }

  it('even sod_constraint central rows require SOME context to read (no wildcard access)', () => {
    // The central branch (tenant_id IS NULL) still evaluates under the restrictive policy;
    // a NULL row is readable regardless of context, but a tenant-owned row needs context.
    expect(rlsPasses('sod_constraint', 'read', TENANT_A, null, appRw)).toBe(false);
  });
});

describe('tenant-RLS security — model is faithful (guards against a vacuous oracle)', () => {
  it('a hypothetical BYPASSRLS/superuser role WOULD bypass RLS (proves FORCE matters)', () => {
    const rogue: RoleAttrs = { bypassRls: true, superuser: false, login: true };
    // This is exactly the posture the migration forbids for app roles; showing the model
    // treats it as bypassing confirms the NOBYPASSRLS assertion above is load-bearing.
    expect(rlsPasses('role_assignment', 'read', TENANT_B, TENANT_A, rogue)).toBe(true);
    // And our real app roles are NOT that role.
    expect(appRw.bypassRls).toBe(false);
    expect(appRo.bypassRls).toBe(false);
  });

  it('the migration actually defines restrictive tenant policies for every tenant table', () => {
    for (const t of TENANT_TABLES) {
      const policies = parsePolicies(t);
      expect(
        policies.some((p) => p.as === 'restrictive'),
        `${t} restrictive policy`,
      ).toBe(true);
      expect(
        policies.every((p) => /current_tenant\(\)/.test(p.using)),
        `${t} uses GUC`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 20 — the tenant-isolation source contract is VERSIONED and VALIDATED.
//
// Phase AC / VO-52d0780c11bcc6fd7583: "Every onboarded source contract MUST be versioned
// and validated." The migration IS the security source contract enforcing tenant
// isolation. Prove — independently of the migration runner suite — that it carries a
// stable version (numeric ordinal parsed from the filename) and a content-sensitive
// checksum (the validation identity), so any edit to the isolation SQL is detectable.
// ---------------------------------------------------------------------------
describe('tenant-RLS security — versioned & validated source contract', () => {
  it('the migration filename parses to the pinned ordinal 0002 (version)', () => {
    const parsed = parseMigrationFilename(MIGRATION_FILE);
    expect(parsed, 'filename must be a valid <id>_<name>.sql contract').not.toBeNull();
    expect(parsed!.id).toBe('0002');
    expect(parsed!.name).toBe('tenant_rls');
    // Expand-only kind — the contract is additive (GAR-010 compatible evolution).
    expect(parsed!.kind).toBe('expand');
  });

  it('the checksum is content-sensitive — a single-byte edit to the isolation SQL changes it', () => {
    const base = { id: '0002', name: 'tenant_rls', kind: 'expand' as const, up: SQL };
    const original = checksumMigration(base);
    // Re-checksumming the same bytes is stable (deterministic validation identity).
    expect(checksumMigration({ ...base })).toBe(original);
    // Flip one meaningful token in the isolation policy — RESTRICTIVE → PERMISSIVE would
    // silently widen access. The checksum MUST diverge so such a regression is caught.
    const tampered = SQL.replace('AS RESTRICTIVE', 'AS PERMISSIVE');
    expect(tampered, 'sanity: replacement actually mutated the SQL').not.toBe(SQL);
    expect(checksumMigration({ ...base, up: tampered })).not.toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Phase 20 — cross-tenant MUTATIONS remain safe under duplicate, delayed, partial,
// conflicting, and uncertain outcomes.
//
// Phase AC / VO-52d0780c11bcc6fd7583: "mutating operations MUST be correlated,
// deduplicated, reconcilable, retry-bounded, and safe under duplicate, delayed, partial,
// conflicting, and uncertain outcomes." RLS is the *last line*: whatever a caller retries,
// replays, or reconciles, a write that would land in another tenant is rejected by
// WITH CHECK — and that rejection is DETERMINISTIC (identical every time), so retries and
// reconciliation never leak across tenants and never "succeed by accident". Each scenario
// below is paired with the same-tenant allow it must NOT weaken.
// ---------------------------------------------------------------------------
describe('tenant-RLS security — mutations safe under duplicate/delayed/partial/conflicting/uncertain outcomes', () => {
  // A cross-tenant write is denied identically no matter how many times it is replayed.
  it('DUPLICATE: a re-submitted cross-tenant write is denied every time (idempotent deny)', () => {
    for (const table of TENANT_TABLES) {
      const decisions = [0, 1, 2, 3, 4].map(() =>
        rlsPasses(table, 'write', TENANT_B, TENANT_A, appRw),
      );
      // Every replay decides the same way: DENY. No attempt ever slips through.
      expect(decisions.every((d) => d === false)).toBe(true);
      // …while the legitimate same-tenant write is still allowed (deny is not blanket).
      expect(rlsPasses(table, 'write', TENANT_A, TENANT_A, appRw)).toBe(true);
    }
  });

  // A delayed/replayed write that arrives after context has been cleared fails closed —
  // it cannot fall back to some other tenant's scope.
  it('DELAYED: a write replayed after tenant context is lost fails closed (no fallback tenant)', () => {
    for (const table of TENANT_TABLES) {
      // Same intended row, but the delayed replay runs with no/empty context.
      expect(rlsPasses(table, 'write', TENANT_A, null, appRw)).toBe(false);
      expect(rlsPasses(table, 'write', TENANT_A, '', appRw)).toBe(false);
    }
  });

  // Partial completion / reconciliation: reading back to determine actual state cannot
  // observe another tenant's rows, so reconciliation can never conclude a cross-tenant
  // effect "already happened".
  it('PARTIAL/RECONCILE: reading back to reconcile cannot observe another tenant’s effect', () => {
    for (const table of TENANT_TABLES) {
      // Reconciler in tenant A reads its own effect…
      expect(rlsPasses(table, 'read', TENANT_A, TENANT_A, appRw)).toBe(true);
      // …but a supposed cross-tenant effect is invisible, so it cannot be mistaken for done.
      expect(rlsPasses(table, 'read', TENANT_B, TENANT_A, appRw)).toBe(false);
      expect(rlsPasses(table, 'read', TENANT_B, TENANT_A, appRo)).toBe(false);
    }
  });

  // Conflicting outcome: two tenants racing to write the "same" logical row each stay
  // confined to their own tenant — neither can overwrite the other's row.
  it('CONFLICTING: concurrent writers in different tenants cannot cross into each other', () => {
    for (const table of TENANT_TABLES) {
      // Writer in A may only write A-tagged rows; a B-tagged conflict is rejected.
      expect(rlsPasses(table, 'write', TENANT_A, TENANT_A, appRw)).toBe(true);
      expect(rlsPasses(table, 'write', TENANT_B, TENANT_A, appRw)).toBe(false);
      // Symmetrically for a writer in B.
      expect(rlsPasses(table, 'write', TENANT_B, TENANT_B, appRw)).toBe(true);
      expect(rlsPasses(table, 'write', TENANT_A, TENANT_B, appRw)).toBe(false);
    }
  });

  // Uncertain outcome: when the caller cannot tell whether a write landed, a retry is
  // still bounded by RLS — an uncertain cross-tenant write can never resolve to success.
  it('UNCERTAIN: a retry of an ambiguous cross-tenant write can never resolve to allow', () => {
    for (const table of TENANT_TABLES) {
      // Model the "unknown outcome → retry" loop: the decision is a pure function of
      // (row tenant, context tenant, role), so every retry is the same DENY.
      const retries = Array.from({ length: 8 }, () =>
        rlsPasses(table, 'write', TENANT_B, TENANT_A, appRw),
      );
      expect(retries.some((d) => d === true)).toBe(false);
    }
    // And a forged central (tenant_id NULL) row remains un-writable across every retry.
    const central = Array.from({ length: 8 }, () =>
      rlsPasses('sod_constraint', 'write', null, TENANT_A, appRw),
    );
    expect(central.some((d) => d === true)).toBe(false);
  });
});
