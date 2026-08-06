import { randomUUID } from 'node:crypto';

import { apiCommand } from './api-client.ts';
import { resolveOperatorSession } from './session-context.ts';

const MAX_BODY_BYTES = 16_384;

function bad(status: number, code: string): Response {
  return Response.json({ code, message: 'request rejected' }, { status });
}

async function boundedBody(request: Request): Promise<unknown | Response> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return bad(415, 'unsupported_media_type');
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return bad(413, 'payload_too_large');
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return bad(400, 'invalid_json');
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return bad(413, 'payload_too_large');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return bad(400, 'invalid_json');
  }
}

export async function forwardGovernedCommand(
  request: Request,
  path: `/v1/${string}`,
  idempotencyPrefix: string,
): Promise<Response> {
  const parsed = await boundedBody(request);
  if (parsed instanceof Response) return parsed;
  const session = await resolveOperatorSession();
  const correlationId = session.correlationId ?? randomUUID();
  const result = await apiCommand(path, { ...session, correlationId }, parsed, {
    idempotencyKey: idempotencyPrefix + '-' + randomUUID(),
  });
  return Response.json(result.body ?? { code: result.failure ?? 'governed_command_unavailable' }, {
    status: result.status,
    headers: { 'cache-control': 'no-store' },
  });
}
