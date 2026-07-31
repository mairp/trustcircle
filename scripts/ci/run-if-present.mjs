#!/usr/bin/env node
// Phase 9 — Guarded CI step runner (task series T009 / GAR-010).
//
// Some PR-validation legs depend on tooling/artifacts that land in later implementation
// phases (contract validators, generated-code diff, SQL migrations, the migrate runner).
// This runner keeps .github/workflows/verify.yml GREEN and HONEST at every phase:
//
//   * If the required probe path(s) exist -> run the real command; its exit code is the gate.
//   * If they do NOT yet exist          -> emit an explicit, machine-visible SKIP notice
//                                           naming the missing artifact, and exit 0.
//
// A skip is never silent: it prints `::warning::` (a GitHub Actions annotation) plus a
// `PR-VALIDATION SKIP` line, so a reviewer always sees which supported-consumer check was
// deferred and why. This models the compatibility discipline (VO-ec575c4ce42b548bfb4d):
// a change is either validated by an active check or accompanied by a visible, owned notice
// — it is never allowed to pass without a record.
//
// Usage:
//   node scripts/ci/run-if-present.mjs --label "contracts" --requires <path> [--requires <p2>] -- <cmd> [args...]

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { label: 'check', requires: [], cmd: [] };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      out.cmd = args.slice(i + 1);
      break;
    } else if (a === '--label') {
      out.label = args[++i];
    } else if (a === '--requires') {
      out.requires.push(args[++i]);
    } else {
      throw new Error(`unknown flag ${a}`);
    }
  }
  if (!out.cmd.length) throw new Error('no command supplied after `--`');
  if (!out.requires.length) throw new Error('at least one --requires <path> is mandatory');
  return out;
}

function main() {
  const { label, requires, cmd } = parseArgs(process.argv);
  const missing = requires.filter((p) => !existsSync(join(ROOT, p)));
  if (missing.length) {
    // Explicit, visible skip — never a silent pass.
    process.stdout.write(
      `::warning title=PR-validation deferred::${label}: required artifact(s) not present yet: ${missing.join(', ')}\n`,
    );
    process.stdout.write(
      `PR-VALIDATION SKIP [${label}] deferred — missing: ${missing.join(', ')} ` +
        `(check activates automatically when the artifact lands in its phase)\n`,
    );
    return 0;
  }
  process.stdout.write(`PR-VALIDATION RUN [${label}] -> ${cmd.join(' ')}\n`);
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: 'inherit', shell: false });
  if (res.error) {
    process.stderr.write(`PR-VALIDATION FAIL [${label}] — spawn error: ${res.error.message}\n`);
    return 1;
  }
  return res.status == null ? 1 : res.status;
}

process.exit(main());
