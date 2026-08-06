import { randomUUID } from 'node:crypto';

import { apiCommand } from '../../../../lib/api-client.ts';
import { resolveOperatorSession } from '../../../../lib/session-context.ts';

const MAX_BODY_BYTES = 8192;

function bad(status: number, code: string): Response {
  return Response.json({ code, message: 'request rejected' }, { status });
}

async function body(request: Request): Promise<unknown | Response> {
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
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return bad(400, 'invalid_json');
  }
}

export async function POST(request: Request): Promise<Response> {
  const parsed = await body(request);
  if (parsed instanceof Response) return parsed;
  const session = await resolveOperatorSession();
  const correlation = session.correlationId ?? randomUUID();
  const result = await apiCommand(
    '/v1/impact-previews',
    { ...session, correlationId: correlation },
    parsed,
    { idempotencyKey: 'impact-preview-' + randomUUID() },
  );
  return Response.json(result.body ?? { code: result.failure ?? 'preview_unavailable' }, {
    status: result.status,
    headers: { 'cache-control': 'no-store' },
  });
}
