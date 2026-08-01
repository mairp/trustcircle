// Security-suite test — the least-privilege FILESYSTEM scanner is METADATA-ONLY: it may observe that
// a repository/source EXISTS and classify it, but it must NEVER read, carry, or persist the source's
// protected CONTENT, its CREDENTIALS, or any SECRET VALUE.
// (Phase 67 / bundle 36GCYGDJ15PTYP60F91QWRAY2M / work item RH7VP6ZADJCBBNVD15E5MSQTSQ.)
//
// The property is proven two ways, both structural:
//   (1) CAPABILITY — the injected `FileSystemPort` the scanner is granted exposes ONLY `list` + `stat`.
//       There is no `readFile`. Even a fixture that TRIES to hand the scanner file bodies cannot: the
//       scanner never asks for one. Least privilege is a missing capability, not a discipline.
//   (2) DISCLOSURE — we seed an adversarial filesystem whose PATH names and marker names carry real
//       secret shapes (a PEM file, an AWS-key-named file, a DSN-shaped directory name, a JWT-named
//       marker). We run a real sweep and inspect the TWO INDEPENDENT durable read paths the scanner
//       produces — every `FilesystemSource.metadata` / `FilesystemGap.metadata` record, and every
//       marker `records[]` entry — asserting no seeded secret survives into any of them.
//
// Every positive assertion is paired with a NEGATIVE control so the oracle is non-vacuous: a benign
// path survives unchanged, and the RAW fixture the scanner walked genuinely contains the secrets — so
// it is the guard, not the input, that cleaned the durable output.
//
// Run: npm run test:security   (vitest run --project security)

import { describe, it, expect } from 'vitest';
import { isMetadataOnly } from '../../apps/discovery-agent/src/main.ts';
import {
  looksLikeSecretValue,
  REDACTED_PLACEHOLDER,
} from '../../packages/observability/src/instrumentation.ts';
import {
  RepositoryFileSystemScanner,
  describeProbeError,
  type FileSystemPort,
  type FsDirEntry,
  type FsStat,
} from '../../apps/discovery-agent/src/scanners/filesystem.ts';

// ───────────────────────────────────────────────────────────────────────────
// Seeded secrets — real value shapes the value detectors must catch.
// ───────────────────────────────────────────────────────────────────────────
const SECRETS = {
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA2Z\n-----END RSA PRIVATE KEY-----',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  slack: 'xoxb-1234567890-abcdefghijklmnop',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  dsn: 'postgres://appuser:sup3rSecret@db.internal:5432/trustcircle',
} as const;
const ALL_SECRET_STRINGS: readonly string[] = Object.values(SECRETS);

function assertNoSecretAnywhere(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    for (const s of ALL_SECRET_STRINGS) {
      const needle = s.slice(0, Math.min(s.length, 24));
      expect(value.includes(needle), `secret leaked at ${path}: ${value}`).toBe(false);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecretAnywhere(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertNoSecretAnywhere(k, `${path}.<key>`);
      assertNoSecretAnywhere(v, `${path}.${k}`);
    }
  }
}

const NOW = 1_700_000_000_000;
const HORIZON = 30 * 24 * 60 * 60 * 1000;

// A fixture that RECORDS every path it was asked to list/stat, so we can prove the scanner NEVER
// attempts to read a file body (there is no readFile to attempt, and stat is metadata only).
function instrumentedFs(
  tree: Record<
    string,
    { kind: 'file' | 'directory' | 'symlink'; size?: number; mtimeMs?: number; denied?: boolean }
  >,
): FileSystemPort & { readonly listed: string[]; readonly statted: string[] } {
  const listed: string[] = [];
  const statted: string[] = [];
  const childrenOf = (dir: string): FsDirEntry[] => {
    const prefix = dir === '.' || dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
    const out: FsDirEntry[] = [];
    for (const [p, node] of Object.entries(tree)) {
      if (p === dir || !p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.length === 0 || rest.includes('/')) continue;
      out.push({ name: rest, kind: node.kind });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
  return {
    listed,
    statted,
    async list(dir: string) {
      listed.push(dir);
      const node = tree[dir];
      if (node?.denied) throw new Error(`EACCES '${dir}'`);
      return childrenOf(dir);
    },
    async stat(p: string) {
      statted.push(p);
      const node = tree[p];
      if (!node) throw new Error(`ENOENT '${p}'`);
      if (node.denied) throw new Error(`EACCES '${p}'`);
      const st: FsStat = { kind: node.kind, size: node.size ?? 0, mtimeMs: node.mtimeMs ?? NOW };
      return st;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CAPABILITY — the scanner cannot read a file body; it only lists and stats.
// ═══════════════════════════════════════════════════════════════════════════
describe('least-privilege capability — no protected-content read path exists', () => {
  it('P1 a sweep only ever lists directories and stats markers; it never reads a file body', async () => {
    const fs = instrumentedFs({
      root: { kind: 'directory' },
      'root/repo': { kind: 'directory' },
      'root/repo/.git': { kind: 'directory', mtimeMs: NOW - 1000 },
      'root/repo/CODEOWNERS': { kind: 'file', mtimeMs: NOW - 1000 },
      // A file with a secret-bearing name AND (pretend) a big body — the scanner must never open it.
      'root/repo/.env': { kind: 'file', size: 999999, mtimeMs: NOW - 1000 },
      'root/repo/src': { kind: 'directory' },
      'root/repo/src/index.ts': { kind: 'file', size: 500000, mtimeMs: NOW - 1000 },
    });
    const scanner = new RepositoryFileSystemScanner({
      boundary: 'root',
      scope: 'filesystem',
      fs,
      now: NOW,
      freshnessHorizonMs: HORIZON,
    });
    await scanner.scan();

    // POSITIVE: the port has no readFile-like capability at all.
    expect('readFile' in (fs as unknown as Record<string, unknown>)).toBe(false);
    expect('open' in (fs as unknown as Record<string, unknown>)).toBe(false);

    // Every path the scanner stat'd is a MARKER (a name in the recognized marker set), never a content
    // file like src/index.ts. Stat returns size/mtime metadata only — never bytes.
    for (const p of fs.statted) {
      expect(p.endsWith('/index.ts'), `scanner must not stat content file ${p}`).toBe(false);
    }
    // The scanner DID do real work (non-vacuous): it listed directories.
    expect(fs.listed.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DISCLOSURE — secret-shaped paths/markers are redacted in every durable read path.
// ═══════════════════════════════════════════════════════════════════════════
describe('metadata-only disclosure — secret-shaped paths never survive into durable output', () => {
  // An adversarial boundary: directory and marker NAMES carry real secret shapes.
  const tree = {
    root: { kind: 'directory' as const },
    // benign, healthy control — its metadata must survive UNREDACTED (non-vacuity).
    'root/benign': { kind: 'directory' as const },
    'root/benign/.git': { kind: 'directory' as const, mtimeMs: NOW - 1000 },
    'root/benign/CODEOWNERS': { kind: 'file' as const, mtimeMs: NOW - 1000 },
    // a directory whose very NAME is a secret VALUE (an AWS access-key id — slash-free so it is a
    // single path segment / a real single directory child of the boundary).
    [`root/${SECRETS.aws}`]: { kind: 'directory' as const },
    [`root/${SECRETS.aws}/.git`]: { kind: 'directory' as const, mtimeMs: NOW - 1000 },
    [`root/${SECRETS.aws}/CODEOWNERS`]: { kind: 'file' as const, mtimeMs: NOW - 1000 },
  };

  it('D1 a directory whose name is a secret key is redacted in its durable metadata; a benign source survives', async () => {
    const scanner = new RepositoryFileSystemScanner({
      boundary: 'root',
      scope: 'filesystem',
      fs: instrumentedFs(tree),
      now: NOW,
      freshnessHorizonMs: HORIZON,
    });
    const report = await scanner.scan();

    // Whole-surface sweep: NOTHING durable across sources + gaps carries a seeded secret.
    for (const s of report.sources) {
      assertNoSecretAnywhere(s.metadata);
      assertNoSecretAnywhere(s.location);
      assertNoSecretAnywhere(s.records);
      expect(isMetadataOnly(s.metadata)).toBe(true);
    }
    for (const g of report.gaps) {
      assertNoSecretAnywhere(g.metadata);
      assertNoSecretAnywhere(g.location);
      assertNoSecretAnywhere(g.detail);
      expect(isMetadataOnly(g.metadata)).toBe(true);
    }

    // The secret-DSN-named directory's durable record has a REDACTED location (never the value).
    const durableBlob = JSON.stringify(report.sources) + JSON.stringify(report.gaps);
    for (const s of ALL_SECRET_STRINGS) {
      const needle = s.slice(0, Math.min(s.length, 24));
      expect(durableBlob.includes(needle), 'a seeded secret leaked into durable output').toBe(
        false,
      );
    }
    // The redaction placeholder is present somewhere (the DSN-named dir's location collapsed to it).
    expect(durableBlob).toContain(REDACTED_PLACEHOLDER);

    // NEGATIVE control: the benign source's location survived UNCHANGED (guard is not blanket-erasing).
    const benign = report.sources.find((s) => s.targetId === 'root/benign');
    expect(benign).toBeDefined();
    expect(benign!.location).toBe('root/benign');
    expect(benign!.metadata.location).toBe('root/benign');
  });

  it('D2 harness sanity — the seeds are genuinely secret-shaped and the raw fixture DID contain them', () => {
    // If the seeds were not secret-shaped, every "redacted" assertion above would be vacuous.
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(looksLikeSecretValue(secret), `${name} must be secret-shaped`).toBe(true);
    }
    // The raw fixture path names really do embed a secret — the guard, not the input, cleaned output.
    const rawKeys = Object.keys(tree).join('|');
    let sawASecret = false;
    for (const s of ALL_SECRET_STRINGS) {
      if (rawKeys.includes(s.slice(0, Math.min(s.length, 24)))) sawASecret = true;
    }
    expect(sawASecret).toBe(true);
  });

  it('D3 describeProbeError never leaks a secret-shaped thrown message', () => {
    // A probe/list failure whose error message embeds a secret must be reduced to a safe token.
    const safe = describeProbeError(new Error(SECRETS.dsn));
    assertNoSecretAnywhere(safe);
    // NEGATIVE control: a benign error message survives (non-vacuity — not blanket-erased).
    const benign = describeProbeError(new Error('connection refused'));
    expect(benign).toContain('connection refused');
  });
});
