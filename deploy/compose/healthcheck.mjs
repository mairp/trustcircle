// deploy/compose/healthcheck.mjs
// =============================================================================
// Dependency-free container healthcheck probe for the control-plane application
// services (Phase 54 / task T054 / NFR-010).
//
// Usage:  node healthcheck.mjs <target>
//   http://host:port/path   — probe an HTTP liveness/readiness endpoint; a 2xx is
//                             healthy, anything else (including a refused connection
//                             or timeout) is UNHEALTHY.
//   file:///app/.health/<x>  — probe a filesystem liveness marker a worker refreshes;
//                             the marker must exist and be fresh (mtime within a bound).
//
// FAIL-CLOSED by construction (NFR-010): any error, non-2xx, missing/stale marker, or
// timeout exits NON-ZERO so the orchestrator marks the container unhealthy and does NOT
// route new work to it. Health is never inferred from the absence of a signal.
// =============================================================================

import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = process.argv[2];
const TIMEOUT_MS = Number(process.env.HEALTHCHECK_TIMEOUT_MS ?? 4000);
const MARKER_MAX_AGE_MS = Number(process.env.HEALTHCHECK_MARKER_MAX_AGE_MS ?? 30_000);

function unhealthy(reason) {
  // stderr only; a healthy probe is silent. Non-zero exit == unhealthy.
  process.stderr.write(`healthcheck: UNHEALTHY: ${reason}\n`);
  process.exit(1);
}
function healthy() {
  process.exit(0);
}

if (!target) unhealthy('no target argument');

if (target.startsWith('file://')) {
  // Worker liveness marker: must exist and be fresh.
  let path;
  try {
    path = fileURLToPath(target);
  } catch (err) {
    unhealthy(`bad file url: ${err?.message ?? err}`);
  }
  try {
    const st = statSync(path);
    const age = Date.now() - st.mtimeMs;
    if (age > MARKER_MAX_AGE_MS) unhealthy(`stale liveness marker (${Math.round(age)}ms old)`);
    healthy();
  } catch (err) {
    unhealthy(`missing liveness marker ${path}: ${err?.code ?? err?.message ?? err}`);
  }
} else {
  // HTTP endpoint: a 2xx is healthy; anything else fails closed.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(target, { signal: controller.signal, redirect: 'manual' });
    clearTimeout(timer);
    if (res.status >= 200 && res.status < 300) healthy();
    unhealthy(`non-2xx status ${res.status} from ${target}`);
  } catch (err) {
    clearTimeout(timer);
    unhealthy(
      `request to ${target} failed: ${err?.name === 'AbortError' ? 'timeout' : (err?.message ?? err)}`,
    );
  }
}
