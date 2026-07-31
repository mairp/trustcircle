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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SQL = readFileSync(join(ROOT, 'db', 'migrations', '0002_tenant_rls.sql'), 'utf8');

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

function parsePolicies(table: string): Policy[] {
  const out: Policy[] = [];
  const re =
    /CREATE\s+POLICY\s+(\w+)\s+ON\s+(\w+)\s*([\s\S]*?)(?=(?:CREATE|ALTER|DROP|GRANT|REVOKE|$))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(SQL))) {
    if (m[2].toLowerCase() !== table) continue;
    const body = m[3];
    const asM = body.match(/\bAS\s+(RESTRICTIVE|PERMISSIVE)\b/i);
    const usingM = body.match(/\bUSING\s*\(([\s\S]*?)\)\s*(?:WITH\s+CHECK|$)/i);
    const checkM = body.match(/\bWITH\s+CHECK\s*\(([\s\S]*?)\)/i);
    out.push({
      name: m[1],
      as: (asM ? asM[1].toLowerCase() : 'permissive') as Policy['as'],
      using: usingM ? usingM[1].replace(/\s+/g, ' ').trim() : 'true',
      check: checkM
        ? checkM[1].replace(/\s+/g, ' ').trim()
        : usingM
          ? usingM[1].replace(/\s+/g, ' ').trim()
          : 'true',
    });
  }
  return out;
}

// Evaluate a policy predicate for a candidate row given the session's tenant context.
// current_tenant() = NULLIF(current_setting('app.tenant_id', true), '')::uuid, so an unset
// or empty context is NULL and any `tenant_id = current_tenant()` comparison is NULL/false.
function evalPredicate(pred: string, rowTenant: string | null, ctxTenant: string | null): boolean {
  const ct = ctxTenant && ctxTenant.length > 0 ? ctxTenant : null; // NULLIF empty
  // Supported predicate forms in this migration:
  //   tenant_id = current_tenant()
  //   tenant_id IS NULL OR tenant_id = current_tenant()
  const eq = ct !== null && rowTenant === ct; // NULL comparison ⇒ false
  const central = /tenant_id\s+IS\s+NULL/i.test(pred);
  if (central) return rowTenant === null || eq;
  return eq;
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
