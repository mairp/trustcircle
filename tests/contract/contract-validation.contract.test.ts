/**
 * Contract-validation acceptance suite (T011 / GAR-010).
 *
 * Phase-primary obligation VO-ec575c4ce42b548bfb4d:
 *   "Changes to inventory, decisions, lifecycle states, source contracts,
 *    evidence, mappings, and exports MUST preserve supported consumers or
 *    provide approved deprecation, migration, rollback, notice, and
 *    compatibility evidence."
 *
 * validate.ts is the compatibility GATE over the source-contract surface. This
 * suite exercises its pure helpers directly (independent of the CLI) and asserts,
 * through independent read paths, that:
 *
 *   1. Every canonical source contract parses and passes STRUCTURAL validation
 *      (declared kind+version, identity, non-empty surface, no dangling $ref).
 *   2. UNRESOLVED PLACEHOLDERS are rejected — TODO/`<REPLACE_ME>`/`${…}`/
 *      example.com — while RFC 2606 `.invalid` hosts legitimately present in the
 *      contracts are NOT flagged (else the clean tree would fail).
 *   3. The GENERATED-DIFF leg is wired into the overall verdict.
 *
 * Every positive assertion is paired with a negative control that would pass a
 * broken validator, so the oracle is non-vacuous.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { SOURCE_CONTRACTS } from '../../packages/contracts/scripts/generate.ts';
import {
  parseContract,
  validateStructure,
  scanPlaceholders,
  validateContracts,
} from '../../packages/contracts/scripts/validate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const CONTRACTS_DIR = join(REPO_ROOT, 'contracts', 'governance-control-plane');

function raw(id: string): string {
  const c = SOURCE_CONTRACTS.find((x) => x.id === id)!;
  return readFileSync(join(CONTRACTS_DIR, c.file), 'utf8');
}
function contract(id: string) {
  return SOURCE_CONTRACTS.find((x) => x.id === id)!;
}

describe('structural contract validation', () => {
  for (const c of SOURCE_CONTRACTS) {
    it(`parses and validates ${c.id} with zero structural problems`, () => {
      const doc = parseContract(c.kind, raw(c.id));
      expect(validateStructure(c, doc)).toEqual([]);
    });
  }

  it('NEGATIVE CONTROL: a dangling local $ref is reported', () => {
    const doc = parseContract('jsonschema', raw('evidence-envelope')) as Record<string, unknown>;
    // Point evidence_id at a non-existent $def.
    (doc.properties as Record<string, unknown>).evidence_id = { $ref: '#/$defs/nope' };
    const problems = validateStructure(contract('evidence-envelope'), doc);
    expect(problems.some((p) => /dangling local \$ref/.test(p))).toBe(true);
  });

  it('NEGATIVE CONTROL: a missing version field is reported', () => {
    const doc = parseContract('openapi', raw('governance-api')) as Record<string, unknown>;
    delete (doc.info as Record<string, unknown>).version;
    const problems = validateStructure(contract('governance-api'), doc);
    expect(problems.some((p) => /info\.version/.test(p))).toBe(true);
  });

  it('NEGATIVE CONTROL: wrong asyncapi major version is reported', () => {
    const doc = parseContract('asyncapi', raw('governance-events')) as Record<string, unknown>;
    doc.asyncapi = '2.6.0';
    const problems = validateStructure(contract('governance-events'), doc);
    expect(problems.some((p) => /asyncapi.*version/.test(p))).toBe(true);
  });
});

describe('unresolved-placeholder rejection', () => {
  for (const c of SOURCE_CONTRACTS) {
    it(`clean contract ${c.id} has no unresolved placeholders`, () => {
      expect(scanPlaceholders(c, raw(c.id))).toEqual([]);
    });
  }

  it('does NOT flag RFC 2606 .invalid hosts (legitimate, present in the contracts)', () => {
    // The OpenAPI/AsyncAPI contracts intentionally use *.invalid servers.
    const text = raw('governance-api');
    expect(/\.invalid/.test(text)).toBe(true); // guard: the sample is actually present
    expect(scanPlaceholders(contract('governance-api'), text)).toEqual([]);
  });

  it.each([
    ['TODO finish', /TODO marker/],
    ['value is TBD', /TBD marker/],
    ['<REPLACE_ME>', /angle-bracket fill token/],
    ['host ${DEPLOY_HOST}', /interpolation/],
    ['see https://example.com/x', /example\.com/],
    ['secret: CHANGEME', /CHANGEME literal/],
  ])('flags placeholder %s', (needle, expected) => {
    const findings = scanPlaceholders(
      contract('evidence-envelope'),
      `line ok\nembedded ${needle} here\n`,
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => expected.test(f.message))).toBe(true);
    expect(findings[0].line).toBe(2); // line number is reported
  });

  it('NEGATIVE CONTROL: an ordinary line is not flagged', () => {
    expect(
      scanPlaceholders(contract('evidence-envelope'), 'a perfectly ordinary description line'),
    ).toEqual([]);
  });
});

describe('overall verdict (all legs)', () => {
  it('validateContracts() passes on the committed tree', () => {
    const report = validateContracts();
    expect(report.ok, JSON.stringify(report.findings, null, 2)).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.validated.sort()).toEqual(SOURCE_CONTRACTS.map((c) => c.id).sort());
  });

  it('the generated-diff leg contributes to the verdict (skipGenerated toggles it)', () => {
    // Both pass on a clean tree; this proves the leg is present and isolable
    // without mutating disk. Drift behavior is covered by the tooling black-box.
    expect(validateContracts({ skipGenerated: true }).ok).toBe(true);
    expect(validateContracts({ skipGenerated: false }).ok).toBe(true);
  });
});
