const TIMEOUT_MS = Number(process.env['WEB_API_TIMEOUT_MS'] ?? 2500);

function safeBaseUrl(): string {
  const url = new URL(process.env['API_BASE_URL'] ?? 'http://api:3000');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported API protocol');
  return url.origin;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function GET() {
  const checkedAt = new Date().toISOString();
  try {
    const response = await fetch(`${safeBaseUrl()}/v1/readiness`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (
      !(response.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
    ) {
      throw new SyntaxError('non-json readiness response');
    }
    const body = object(await response.json());
    const compatible = body?.['apiVersion'] === 1;
    const ready =
      response.ok && compatible && body?.['ready'] === true && body?.['lifecycle'] === 'ready';
    const degradedFacets = Array.isArray(body?.['degradedFacets'])
      ? body['degradedFacets']
          .filter((item): item is string => typeof item === 'string')
          .slice(0, 20)
      : [];
    return Response.json(
      {
        status: ready ? 'ready' : compatible ? 'degraded' : 'unavailable',
        service: 'web',
        authority: 'none',
        checkedAt,
        apiVersion: compatible ? 1 : 'unsupported',
        apiLifecycle: typeof body?.['lifecycle'] === 'string' ? body['lifecycle'] : 'unknown',
        degradedFacets,
        safeNextAction: ready
          ? 'none'
          : 'Inspect API /v1/readiness and escalate to the owning service.',
      },
      { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const classification =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? 'timeout'
        : error instanceof SyntaxError
          ? 'malformed_response'
          : 'unreachable';
    return Response.json(
      {
        status: 'unavailable',
        service: 'web',
        authority: 'none',
        checkedAt,
        apiStatus: classification,
        safeNextAction: 'Inspect API /v1/readiness and escalate to the owning service.',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
