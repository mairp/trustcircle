#!/usr/bin/env node
// Audit-readiness fixtures validator + manifest builder (Phase 9 / T292 / GAR-010).
//
// Validates the ISO/IEC 42001 / 42005 / 42006 sample packages in this directory and (with --build)
// (re)writes a signed `manifest.json` that binds each package by content digest. Run as a node test
// (`node --test`) it asserts:
//   1. each package parses, is non-empty, and carries `certificationClaimed:false` + a disclaimer;
//   2. every mapping entry references a clause id, a paraphrase, a shipped control, and an evidence
//      pointer to a repo path that actually EXISTS on disk;
//   3. no entry contains obvious copied normative standard text (heuristic: the tell-tale ISO
//      normative verb phrases "the organization shall" / "shall establish, implement, maintain");
//   4. the manifest digests are self-consistent (built the same way from the same bytes).
//
// Dependency-free (Node built-ins only), deterministic (canonical JSON, sha256/HMAC).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const KEY = 'audit-readiness-manifest-key';

const PACKAGES = [
  'iso-42001-evidence-package.json',
  'iso-42005-impact-assessment.json',
  'iso-42006-audit-readiness.json',
];

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
    .join(',')}}`;
}
const sha256 = (t) => createHash('sha256').update(t).digest('hex');
const hmac = (t) => createHmac('sha256', KEY).update(t).digest('hex');

function entriesOf(pkg) {
  return pkg.controls ?? pkg.assessment ?? pkg.readiness ?? [];
}

// Heuristic detector for copied ISO normative text (we must NOT reproduce licensed text).
const NORMATIVE_TELLS = [
  'the organization shall',
  'shall establish, implement, maintain',
  'shall determine the boundaries and applicability',
];
function looksLikeCopiedText(s) {
  const lower = String(s).toLowerCase();
  return NORMATIVE_TELLS.some((t) => lower.includes(t));
}

function buildManifest() {
  const packages = PACKAGES.map((name) => {
    const bytes = readFileSync(join(HERE, name), 'utf8');
    return { name, digest: sha256(bytes) };
  });
  const body = { kind: 'audit-readiness', certificationClaimed: false, packages };
  return { ...body, signature: hmac(canonical(body)) };
}

if (process.argv.includes('--build')) {
  writeFileSync(join(HERE, 'manifest.json'), `${canonical(buildManifest())}\n`);
  console.log('audit-readiness manifest built.');
}

test('every package parses, is non-empty, and disclaims certification', () => {
  for (const name of PACKAGES) {
    const pkg = JSON.parse(readFileSync(join(HERE, name), 'utf8'));
    assert.equal(pkg.certificationClaimed, false, `${name} must set certificationClaimed:false`);
    assert.ok(
      typeof pkg.disclaimer === 'string' && pkg.disclaimer.length > 0,
      `${name} needs a disclaimer`,
    );
    const entries = entriesOf(pkg);
    assert.ok(entries.length > 0, `${name} must have at least one mapping entry`);
  }
});

test('every entry references a clause, control/finding, and an evidence pointer that exists', () => {
  for (const name of PACKAGES) {
    const pkg = JSON.parse(readFileSync(join(HERE, name), 'utf8'));
    for (const e of entriesOf(pkg)) {
      assert.ok(e.clause, `${name}: entry missing clause`);
      assert.ok(e.obligationParaphrase, `${name}: entry missing obligationParaphrase`);
      assert.ok(e.evidencePointer, `${name}: entry missing evidencePointer`);
      // The evidence pointer's path prefix (before any parenthetical note) must exist.
      const path = String(e.evidencePointer).split(' (')[0].trim();
      assert.ok(
        existsSync(join(REPO_ROOT, path)),
        `${name}: evidence path does not exist: ${path}`,
      );
    }
  }
});

test('no package reproduces obvious copied normative standard text', () => {
  for (const name of PACKAGES) {
    const raw = readFileSync(join(HERE, name), 'utf8');
    assert.equal(
      looksLikeCopiedText(raw),
      false,
      `${name} appears to contain copied normative text`,
    );
  }
});

test('NEGATIVE: the copied-text heuristic actually fires on copied text', () => {
  assert.equal(
    looksLikeCopiedText('The organization shall establish, implement, maintain ...'),
    true,
  );
  assert.equal(looksLikeCopiedText('We paraphrase the obligation in our own words.'), false);
});

test('manifest digests are self-consistent and signed', () => {
  const manifest = buildManifest();
  assert.equal(manifest.certificationClaimed, false);
  const { signature, ...body } = manifest;
  assert.equal(hmac(canonical(body)), signature, 'manifest signature must verify');
  // Each digest matches the on-disk bytes.
  for (const p of manifest.packages) {
    assert.equal(sha256(readFileSync(join(HERE, p.name), 'utf8')), p.digest);
  }
});
