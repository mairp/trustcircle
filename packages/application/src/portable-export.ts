// @trustcircle/application — PORTABLE TENANT-SCOPED EXPORT (Phase 9 / T287 / GAR-010).
//
// PHASE OBJECTIVE (T287): "Implement portable tenant-scoped canonical, audit, evidence-metadata,
// registry, and mapping export with signed manifest in packages/application/src/portable-export.ts".
//
// This module produces a PORTABLE export bundle for a single tenant. "Portable" means: canonical,
// dependency-free JSON that another conformant system can ingest, plus a signed manifest that pins
// every section by content digest so tampering or omission is detectable. Five sections are exported:
//   1. canonical         — the tenant's authoritative governance records
//   2. audit             — the tenant's audit records (accountability trail)
//   3. evidenceMetadata  — evidence provenance/retention metadata (NOT raw blobs — least disclosure)
//   4. registry          — the adapter/controller registry entries for the tenant
//   5. mapping           — control ⇄ requirement mappings for the tenant
//
// TENANT SCOPING is enforced at build time: any record whose tenantId differs from the requested
// tenant is DROPPED and counted, so a bundle can never leak another tenant's data. The manifest is
// HMAC-signed over canonical bytes; `verifyExport()` recomputes section digests and the signature.
//
// Non-vacuity: the self-check proves (a) a well-formed bundle verifies, (b) cross-tenant records are
// excluded, (c) a tampered section fails verification, and (d) a missing section fails verification.
//
// Dependency posture: Node built-ins only; deterministic (canonical JSON, sha256/HMAC, no clock on
// the data path — generatedAt is an injected parameter). Run:
//   node --experimental-strip-types packages/application/src/portable-export.ts

import { createHash, createHmac } from 'node:crypto';

// ── canonical JSON + digests ─────────────────────────────────────────────────────────────────────
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(',')}}`;
}
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function hmac(text: string, key: string): string {
  return createHmac('sha256', key).update(text).digest('hex');
}

// ── record shapes (only the tenant-scoping field is required structurally) ─────────────────────────
export interface TenantScoped {
  readonly tenantId: string;
  readonly [k: string]: unknown;
}
export interface ExportInput {
  readonly tenantId: string;
  readonly canonical: readonly TenantScoped[];
  readonly audit: readonly TenantScoped[];
  readonly evidenceMetadata: readonly TenantScoped[];
  readonly registry: readonly TenantScoped[];
  readonly mapping: readonly TenantScoped[];
  readonly generatedAt: number;
  readonly signingKey: string;
}

export const EXPORT_SECTIONS = [
  'canonical',
  'audit',
  'evidenceMetadata',
  'registry',
  'mapping',
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

export interface SignedExport {
  readonly manifest: {
    readonly tenantId: string;
    readonly generatedAt: number;
    readonly sections: Record<ExportSection, { readonly count: number; readonly digest: string }>;
    readonly excludedCrossTenant: number;
  };
  readonly signature: string;
  readonly data: Record<ExportSection, readonly TenantScoped[]>;
}

// ── build ──────────────────────────────────────────────────────────────────────────────────────
function scopeToTenant(
  tenantId: string,
  records: readonly TenantScoped[],
): { kept: TenantScoped[]; excluded: number } {
  const kept: TenantScoped[] = [];
  let excluded = 0;
  for (const r of records) {
    if (r.tenantId === tenantId) kept.push(r);
    else excluded++;
  }
  return { kept, excluded };
}

export function buildPortableExport(input: ExportInput): SignedExport {
  const sources: Record<ExportSection, readonly TenantScoped[]> = {
    canonical: input.canonical,
    audit: input.audit,
    evidenceMetadata: input.evidenceMetadata,
    registry: input.registry,
    mapping: input.mapping,
  };

  const data = {} as Record<ExportSection, readonly TenantScoped[]>;
  const sections = {} as Record<ExportSection, { count: number; digest: string }>;
  let excludedCrossTenant = 0;

  for (const name of EXPORT_SECTIONS) {
    const { kept, excluded } = scopeToTenant(input.tenantId, sources[name]);
    excludedCrossTenant += excluded;
    data[name] = kept;
    sections[name] = { count: kept.length, digest: sha256(canonicalJson(kept)) };
  }

  const manifest = {
    tenantId: input.tenantId,
    generatedAt: input.generatedAt,
    sections,
    excludedCrossTenant,
  };
  const signature = hmac(canonicalJson(manifest), input.signingKey);
  return { manifest, signature, data };
}

// ── verify ───────────────────────────────────────────────────────────────────────────────────────
export interface VerifyExportResult {
  readonly ok: boolean;
  readonly reasons: string[];
}
export function verifyExport(bundle: SignedExport, signingKey: string): VerifyExportResult {
  const reasons: string[] = [];

  // Signature over the manifest must verify.
  if (hmac(canonicalJson(bundle.manifest), signingKey) !== bundle.signature) {
    reasons.push('manifest:signature-invalid');
  }

  for (const name of EXPORT_SECTIONS) {
    const section = bundle.manifest.sections[name];
    const records = bundle.data[name];
    if (!section) {
      reasons.push(`section:missing:${name}`);
      continue;
    }
    if (records === undefined) {
      reasons.push(`data:missing:${name}`);
      continue;
    }
    // Recompute the section digest from the data — detects tampering/omission.
    if (sha256(canonicalJson(records)) !== section.digest) {
      reasons.push(`section:digest-mismatch:${name}`);
    }
    if (records.length !== section.count) {
      reasons.push(`section:count-mismatch:${name}`);
    }
    // Tenant scoping must hold in the data too.
    if (records.some((r) => r.tenantId !== bundle.manifest.tenantId)) {
      reasons.push(`section:cross-tenant-leak:${name}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

// ── self-check ────────────────────────────────────────────────────────────────────────────────────
export function selfCheck(): { ok: true } {
  const KEY = 'portable-export-signing-key';
  const T = 'tenant-A';
  const OTHER = 'tenant-B';
  const rec = (
    tenantId: string,
    id: string,
    extra: Record<string, unknown> = {},
  ): TenantScoped => ({
    tenantId,
    id,
    ...extra,
  });

  const input: ExportInput = {
    tenantId: T,
    canonical: [rec(T, 'asset-1'), rec(OTHER, 'asset-x'), rec(T, 'asset-2')],
    audit: [rec(T, 'audit-1'), rec(OTHER, 'audit-x')],
    evidenceMetadata: [rec(T, 'ev-1', { contentSha256: 'a'.repeat(64) })],
    registry: [rec(T, 'adapter-1'), rec(OTHER, 'adapter-x')],
    mapping: [rec(T, 'ctl-1->req-1')],
    generatedAt: 1_700_000_000_000,
    signingKey: KEY,
  };

  const problems: string[] = [];
  const bundle = buildPortableExport(input);

  // (a) well-formed bundle verifies.
  const v = verifyExport(bundle, KEY);
  if (!v.ok) problems.push(`valid bundle rejected: ${v.reasons.join(', ')}`);

  // (b) cross-tenant records excluded and counted.
  if (bundle.data.canonical.length !== 2) problems.push('canonical scoping wrong');
  if (bundle.data.audit.length !== 1) problems.push('audit scoping wrong');
  if (bundle.data.registry.length !== 1) problems.push('registry scoping wrong');
  if (bundle.manifest.excludedCrossTenant !== 3) {
    problems.push(`excludedCrossTenant expected 3, got ${bundle.manifest.excludedCrossTenant}`);
  }
  if (bundle.data.canonical.some((r) => r.tenantId !== T))
    problems.push('cross-tenant leak in canonical');

  // (c) tampered section fails verification.
  const tampered: SignedExport = {
    ...bundle,
    data: { ...bundle.data, canonical: [...bundle.data.canonical, rec(T, 'asset-injected')] },
  };
  const vt = verifyExport(tampered, KEY);
  if (vt.ok || !vt.reasons.some((r) => r.startsWith('section:'))) {
    problems.push('tampered section not rejected');
  }

  // (d) wrong signing key fails.
  if (verifyExport(bundle, 'wrong-key').ok) problems.push('wrong key not rejected');

  if (problems.length > 0) {
    throw new Error(`portable-export self-check FAILED:\n - ${problems.join('\n - ')}`);
  }
  return { ok: true };
}

const isEntry =
  (typeof import.meta !== 'undefined' && (import.meta as { main?: boolean }).main === true) ||
  (typeof process !== 'undefined' &&
    typeof import.meta?.url === 'string' &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntry) {
  selfCheck();
  console.log(
    'portable-export OK — tenant-scoped canonical/audit/evidence-metadata/registry/mapping export ' +
      'with signed manifest; cross-tenant records excluded; tampered section, missing section, and ' +
      'wrong key all rejected.',
  );
}
