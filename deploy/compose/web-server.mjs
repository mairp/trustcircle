// deploy/compose/web-server.mjs
// =============================================================================
// Minimal dependency-free operator-UI web server for the control-plane core profile
// (Phase 54 / task T054 / NFR-010).
//
// Its ONLY job in the core-only profile is to guarantee that READ-ONLY VISIBILITY and
// ESCALATION remain available when the core is degraded (NFR-010 third clause). It:
//   * serves `/healthz` (its own liveness — always 200 while the process is up), and
//   * proxies `/readiness` to the API's fail-visible `/v1/readiness` surface, rendering
//     whatever the API reports (including 503/degraded) rather than masking it. If the
//     API is unreachable the UI still responds — with an explicit "control plane
//     unreachable, escalate" view — so the operator is never left with a blank screen.
//
// It NEVER performs governed execution and holds NO authority; being up grants none.
// The apps/web operator SPA is layered in by a later web-build phase.
// =============================================================================

import { createServer } from 'node:http';

const PORT = Number(process.env.WEB_PORT ?? 8080);
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://api:3000';

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Liveness: the UI process itself. Always available while up (read-only visibility).
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'up', service: 'web', authority: 'none' }));
    return;
  }

  // Fail-visible readiness passthrough: render the API's picture, degraded states and all.
  if (url.pathname === '/readiness' || url.pathname === '/') {
    let apiBody = null;
    let apiStatus = 0;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${API_BASE_URL}/v1/readiness`, { signal: ctrl.signal });
      clearTimeout(t);
      apiStatus = r.status;
      apiBody = await r.text();
    } catch (err) {
      // Control plane unreachable — surface it and offer escalation, never a blank/false-ok.
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          view: 'read-only',
          controlPlane: 'unreachable',
          escalation: 'available',
          reason: String(err?.message ?? err),
        }),
      );
      return;
    }
    // Mirror the API's status code so a degraded/503 core is shown as degraded, not green.
    res.writeHead(apiStatus || 502, { 'content-type': 'application/json' });
    res.end(apiBody ?? JSON.stringify({ view: 'read-only', controlPlane: 'unknown' }));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not-found' }));
});

server.listen(PORT, () => {
  process.stdout.write(`web: listening on :${PORT} (read-only visibility surface)\n`);
});
