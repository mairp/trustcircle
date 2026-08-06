import { randomUUID } from 'node:crypto';

import { apiCommand } from '../../../../lib/api-client.ts';
import { resolveOperatorSession } from '../../../../lib/session-context.ts';

const MAX_BODY_BYTES = 8192;

function bad(status: number, code: string): Response {
  return Response.json({ code, message: 'request rejected' }, { status });
}

export async function POST(request: Request): Promise<Response> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return bad(415, 'unsupported_media_type');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return bad(413, 'payload_too_large');
  let text: string;
  try {
    text = await request.text();
  } catch {
    return bad(400, 'invalid_json');
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
    return bad(413, 'payload_too_large');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad(400, 'invalid_json');
  }
  const session = await resolveOperatorSession();
  const correlation = session.correlationId ?? randomUUID();
  const result = await apiCommand(
    '/v1/evidence-packages',
    { ...session, correlationId: correlation },
    body,
    { idempotencyKey: 'evidence-package-' + randomUUID() },
  );
  return Response.json(result.body ?? { code: result.failure ?? 'package_unavailable' }, {
    status: result.status,
    headers: { 'cache-control': 'no-store' },
  });
}
