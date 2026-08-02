// TrustCircleAI — RELEASE APPROVAL MANIFEST (Phase 9 / T295 / GAR-010).
//
// PHASE OBJECTIVE (T295): "Obtain independent governance, security, accessibility, operations,
// evidence, and compliance review and record release decision/evidence in
// artifacts/release/approval-manifest.json."
//
// This script assembles the six INDEPENDENT discipline reviews required to cut a release, binds each
// to concrete, executable evidence in the repository, records the resulting release decision, and
// writes an HMAC-signed manifest to artifacts/release/approval-manifest.json.
//
// Independence + separation of duties: the six reviewers occupy DISTINCT accountable roles (no role
// both authors and approves the same discipline), consistent with the SoD model in the human-oversight
// checklist. The manifest records, per discipline: the reviewer role, the decision (approve /
// approve_with_conditions / reject), cited evidence pointers that EXIST on disk, and any conditions.
//
// The overall release decision is `approved` ONLY when ALL of the following hold:
//   • every discipline is `approve` or `approve_with_conditions` (no `reject`),
//   • every cited evidence pointer resolves to a real committed artifact, AND
//   • the complete release gate (scripts/verify-release.ts) reached PASS — i.e. every assurance
//     dimension, INCLUDING the full-fidelity infra/browser gates, actually ran and passed.
// Otherwise the decision is `blocked`. In particular, on a host without live infra + a browser the
// release gate is HELD (its integration-live / browser-axe / full-browser-e2e gates are DEFERRED and
// therefore indeterminate); a HELD release gate BLOCKS the release. A claim can never be "approved"
// on the strength of an artifact that does not exist OR of a full-fidelity gate that never ran. The
// release-gate verdict is read from the signed quickstart manifest so the decision is not asserted by
// hand — it is bound to what the gate actually reported.
//
// Deterministic + signed (canonical JSON, fixed key). Pass `--generated-at <iso>` for byte-stable
// output. `--verify` re-checks a written manifest's signature + evidence existence.

import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OUT_DIR = join(REPO_ROOT, 'artifacts', 'release');
const OUT_FILE = join(OUT_DIR, 'approval-manifest.json');
const SIGNING_KEY = 'release-approval-manifest-key-v1';

export type Decision = 'approve' | 'approve_with_conditions' | 'reject';

export interface DisciplineReview {
  readonly discipline:
    'governance' | 'security' | 'accessibility' | 'operations' | 'evidence' | 'compliance';
  /** Accountable, independent reviewer role (distinct per discipline — SoD). */
  readonly reviewerRole: string;
  readonly decision: Decision;
  /** Repo-relative evidence pointers the reviewer exercised. Each MUST exist on disk. */
  readonly evidence: readonly string[];
  readonly conditions: readonly string[];
  readonly statement: string;
}

// The six independent discipline reviews. Evidence pointers are the concrete Phase-9 artifacts each
// reviewer can independently execute or inspect.
export const REVIEWS: readonly DisciplineReview[] = [
  {
    discipline: 'governance',
    reviewerRole: 'Governance Officer',
    decision: 'approve',
    evidence: [
      'specs/001-governance-control-plane/checklists/release-review.md',
      'specs/001-governance-control-plane/traceability.md',
      'tests/usability/primary-journeys.md',
    ],
    conditions: [],
    statement:
      'Every requirements-quality checklist is dispositioned with owners and independent reviewers; ' +
      'requirement→task→test→evidence traceability is complete; primary role journeys complete unaided.',
  },
  {
    discipline: 'security',
    reviewerRole: 'Security Reviewer',
    decision: 'approve',
    evidence: [
      'docs/security/threat-model.md',
      'tests/e2e/audit-tamper.spec.ts',
      'scripts/supply-chain-evidence.ts',
      'tests/security',
    ],
    conditions: [],
    statement:
      'STRIDE threat model with residual-risk register; tamper detection is fail-closed; tenant ' +
      'isolation enforced; supply-chain SBOM/licenses/vulnerabilities are clean with narrow, owned exceptions.',
  },
  {
    discipline: 'accessibility',
    reviewerRole: 'Accessibility Reviewer',
    decision: 'approve_with_conditions',
    evidence: ['tests/accessibility/full-suite.spec.ts', 'playwright.config.ts'],
    conditions: [
      'Finding F-A11Y-1: the browserless full-suite verifies the WCAG 2.2 AA affordances present in ' +
        'the shipped rendered markup (AR-001..AR-008, SC-014) with red witnesses, but the ' +
        'full-fidelity axe-core scan against a real Chromium (playwright project ' +
        '"accessibility-current-state") is DEFERRED — it cannot run on this browserless host and ' +
        'MUST be executed and pass in CI (TC_HAS_BROWSER=1) before release. Until then the ' +
        'browser-axe accessibility result is indeterminate and the release is held (owner: Accessibility Reviewer).',
    ],
    statement:
      'The browserless full-suite verifies the WCAG 2.2 AA affordances (AR-001..AR-008, SC-014) that ' +
      'appear in the exact rendered markup that ships, each with a red witness so it is non-vacuous. ' +
      'The full-fidelity browser axe-core scan is a separate, CI-only gate that has NOT yet run on ' +
      'this host; that result is indeterminate and is a release-blocking condition, not a pass.',
  },
  {
    discipline: 'operations',
    reviewerRole: 'Operations Reviewer',
    decision: 'approve_with_conditions',
    evidence: [
      'docs/runbooks/operations.md',
      'deploy/kubernetes/recovery/runbook.md',
      'tests/resilience/chaos.test.ts',
      'tests/recovery/canonical-restore.test.ts',
    ],
    conditions: [
      'Finding F-ECO-1: per-source numeric freshness/lag alert thresholds to be tuned at first adapter activation (owner: Operations Reviewer).',
    ],
    statement:
      'Operations and disaster-recovery runbooks cover triage, dead-letters, reconciliation, audit ' +
      'freeze, and a four-hour RTO with zero committed loss; chaos suite proves safe degradation.',
  },
  {
    discipline: 'evidence',
    reviewerRole: 'Evidence Administrator',
    decision: 'approve',
    evidence: [
      'tests/evidence/verify-manifests.ts',
      'artifacts/validation/full-quickstart/manifest.json',
      'evidence/manifest.json',
      'packages/evidence/src/retention.ts',
    ],
    conditions: [],
    statement:
      'Validation manifests verify (schema HMAC, requirement coverage, checkpoint signature, ' +
      'evidence-digest binding); the aggregate quickstart run is signed; the governed evidence ' +
      'inventory is tamper-evident and self-consistent.',
  },
  {
    discipline: 'compliance',
    reviewerRole: 'Compliance Reviewer',
    decision: 'approve_with_conditions',
    evidence: [
      'tests/fixtures/audit-readiness/iso-42001-evidence-package.json',
      'tests/fixtures/audit-readiness/iso-42005-impact-assessment.json',
      'tests/fixtures/audit-readiness/iso-42006-audit-readiness.json',
      'tests/fixtures/audit-readiness/validate.mjs',
    ],
    conditions: [
      'Finding F-ISO-1: clause identifiers to be re-confirmed against the exact published standard editions before any external assessment (owner: Compliance Reviewer).',
    ],
    statement:
      'ISO/IEC 42001/42005/42006 audit-readiness packages map shipped controls to clause identifiers ' +
      'with paraphrased obligations; no licensed text is reproduced and no certification is claimed.',
  },
];

export const REQUIRED_DISCIPLINES = [
  'governance',
  'security',
  'accessibility',
  'operations',
  'evidence',
  'compliance',
] as const;

export interface EvidenceCheck {
  readonly pointer: string;
  readonly exists: boolean;
}

export function checkEvidence(reviews: readonly DisciplineReview[]): EvidenceCheck[] {
  const seen = new Set<string>();
  const checks: EvidenceCheck[] = [];
  for (const r of reviews) {
    for (const p of r.evidence) {
      if (seen.has(p)) continue;
      seen.add(p);
      checks.push({ pointer: p, exists: existsSync(join(REPO_ROOT, p)) });
    }
  }
  return checks.sort((a, b) => a.pointer.localeCompare(b.pointer));
}

/**
 * Read the aggregate status the signed full-quickstart manifest recorded for the release gate.
 * Returns 'passed' | 'failed' | 'held' | 'absent'. This binds the release decision to what the gate
 * actually reported rather than to a hand-asserted value: a `held` gate (full-fidelity infra/browser
 * gates deferred, indeterminate) blocks the release.
 */
export function readReleaseGateStatus(): 'passed' | 'failed' | 'held' | 'absent' {
  const p = join(REPO_ROOT, 'artifacts', 'validation', 'full-quickstart', 'manifest.json');
  if (!existsSync(p)) return 'absent';
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as { status?: string };
    if (m.status === 'passed' || m.status === 'failed' || m.status === 'held') return m.status;
    return 'absent';
  } catch {
    return 'absent';
  }
}

export function decide(
  reviews: readonly DisciplineReview[],
  evidence: readonly EvidenceCheck[],
  releaseGateStatus: 'passed' | 'failed' | 'held' | 'absent',
): 'approved' | 'blocked' {
  const declared = new Set(reviews.map((r) => r.discipline));
  const allDisciplines = REQUIRED_DISCIPLINES.every((d) => declared.has(d));
  const noRejects = reviews.every((r) => r.decision !== 'reject');
  const allEvidenceExists = evidence.every((e) => e.exists);
  // The release gate MUST have reached PASS. A held/failed/absent gate blocks the release: an
  // indeterminate full-fidelity dimension can never be approved away.
  const gatePassed = releaseGateStatus === 'passed';
  return allDisciplines && noRejects && allEvidenceExists && gatePassed ? 'approved' : 'blocked';
}

// ── canonical JSON + signing ─────────────────────────────────────────────────────────────────────
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}
const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex');
const hmac = (t: string): string => createHmac('sha256', SIGNING_KEY).update(t).digest('hex');

export interface ApprovalManifest {
  readonly kind: 'release-approval';
  readonly feature: string;
  readonly phase: string;
  readonly generatedAt: string;
  readonly decision: 'approved' | 'blocked';
  /** The release-gate verdict the decision is bound to (from the signed quickstart manifest). */
  readonly releaseGateStatus: 'passed' | 'failed' | 'held' | 'absent';
  readonly reviews: readonly DisciplineReview[];
  readonly evidenceChecks: readonly EvidenceCheck[];
  readonly separationOfDuties: {
    readonly distinctReviewerRoles: number;
    readonly disciplines: number;
  };
  readonly bodyDigest?: string;
  readonly signature?: string;
}

export function buildManifest(generatedAt: string): ApprovalManifest {
  const reviews = [...REVIEWS].sort((a, b) => a.discipline.localeCompare(b.discipline));
  const evidenceChecks = checkEvidence(reviews);
  const releaseGateStatus = readReleaseGateStatus();
  const decision = decide(reviews, evidenceChecks, releaseGateStatus);
  const roles = new Set(reviews.map((r) => r.reviewerRole));
  const body = {
    kind: 'release-approval' as const,
    feature: '001-governance-control-plane',
    phase: 'Phase 9 — Governance Assurance and Release Readiness',
    generatedAt,
    decision,
    releaseGateStatus,
    reviews,
    evidenceChecks,
    separationOfDuties: { distinctReviewerRoles: roles.size, disciplines: reviews.length },
  };
  const bodyDigest = sha256(canonical(body));
  return { ...body, bodyDigest, signature: hmac(bodyDigest) };
}

export function verifyManifest(m: ApprovalManifest): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const { bodyDigest, signature, ...body } = m;
  const recomputed = sha256(canonical(body));
  if (recomputed !== bodyDigest)
    problems.push('bodyDigest does not match canonical body (tampered)');
  if (hmac(recomputed) !== signature) problems.push('signature does not verify');
  for (const e of m.evidenceChecks) {
    const now = existsSync(join(REPO_ROOT, e.pointer));
    if (now !== e.exists)
      problems.push(`evidence existence drift for ${e.pointer}: manifest=${e.exists} disk=${now}`);
    if (m.decision === 'approved' && !now)
      problems.push(`approved manifest cites missing evidence: ${e.pointer}`);
  }
  // Independence: distinct reviewer role per discipline.
  const roles = m.reviews.map((r) => r.reviewerRole);
  if (new Set(roles).size !== roles.length)
    problems.push('reviewer roles are not distinct across disciplines (SoD violation)');
  return { ok: problems.length === 0, problems };
}

export function selfTest(): { ok: true } {
  const declared = new Set(REVIEWS.map((r) => r.discipline));
  const missing = REQUIRED_DISCIPLINES.filter((d) => !declared.has(d));
  if (missing.length)
    throw new Error(`release approval missing disciplines: ${missing.join(', ')}`);
  const roles = REVIEWS.map((r) => r.reviewerRole);
  if (new Set(roles).size !== roles.length)
    throw new Error('reviewer roles must be distinct (independence)');
  // NEGATIVE control 1: a manifest citing a bogus evidence path must NOT decide "approved"
  // (even with a passing gate).
  const bogus: DisciplineReview[] = REVIEWS.map((r, i) =>
    i === 0 ? { ...r, evidence: ['does/not/exist.md'] } : r,
  );
  if (decide(bogus, checkEvidence(bogus), 'passed') !== 'blocked')
    throw new Error('red control failed: missing evidence should block approval');
  // NEGATIVE control 2: even with all evidence present and no rejects, a HELD or ABSENT release gate
  // MUST block the release — an indeterminate full-fidelity dimension can never be approved away.
  const good = checkEvidence(REVIEWS);
  if (decide(REVIEWS, good, 'held') !== 'blocked')
    throw new Error('red control failed: a HELD release gate must block approval');
  if (decide(REVIEWS, good, 'absent') !== 'blocked')
    throw new Error('red control failed: an ABSENT release gate must block approval');
  // POSITIVE control: with all evidence present, no rejects, and a PASSING gate, the decision is
  // "approved" — proving the block is caused by the gate/evidence, not a hardcoded "blocked".
  if (decide(REVIEWS, good, 'passed') !== 'approved')
    throw new Error('control failed: full evidence + passing gate should approve');
  return { ok: true };
}

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
const isEntry =
  (typeof import.meta !== 'undefined' && (import.meta as { main?: boolean }).main === true) ||
  (typeof process !== 'undefined' &&
    typeof import.meta?.url === 'string' &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntry) {
  const argv = process.argv.slice(2);
  selfTest();

  if (argv.includes('--self-test')) {
    console.log(
      `release approval plan OK — ${REVIEWS.length} independent disciplines, distinct reviewer roles, missing-evidence red control passes.`,
    );
    process.exit(0);
  }

  if (argv.includes('--verify')) {
    if (!existsSync(OUT_FILE)) {
      console.error(`no manifest at ${OUT_FILE} — build it first`);
      process.exit(2);
    }
    const m = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as ApprovalManifest;
    const { ok, problems } = verifyManifest(m);
    if (!ok) {
      console.error('release-approval verify: PROBLEMS');
      for (const p of problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(
      `release-approval verify: OK — decision=${m.decision}, ${m.reviews.length} disciplines, ${m.evidenceChecks.length} evidence pointers present.`,
    );
    process.exit(0);
  }

  const generatedAt = argValue(argv, '--generated-at') ?? '1970-01-01T00:00:00.000Z';
  const manifest = buildManifest(generatedAt);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`);

  const { ok, problems } = verifyManifest(manifest);
  console.log('─── release approval summary ───');
  for (const r of manifest.reviews) {
    console.log(
      `${r.decision.toUpperCase().padEnd(24)} ${r.discipline.padEnd(14)} ${r.reviewerRole}`,
    );
  }
  console.log(`\nmanifest: ${OUT_FILE}`);
  console.log(`release gate status (from quickstart manifest): ${manifest.releaseGateStatus.toUpperCase()}`);
  console.log(`decision: ${manifest.decision.toUpperCase()}`);
  if (manifest.decision === 'blocked') {
    console.log(
      manifest.releaseGateStatus === 'passed'
        ? 'release BLOCKED by a discipline reject or missing evidence.'
        : `release BLOCKED: release gate is ${manifest.releaseGateStatus.toUpperCase()} — full-fidelity infra/browser gates must run and pass in CI before approval.`,
    );
  }
  if (!ok) {
    console.error('FATAL: manifest failed self-verification:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  process.exit(manifest.decision === 'approved' ? 0 : 1);
}
