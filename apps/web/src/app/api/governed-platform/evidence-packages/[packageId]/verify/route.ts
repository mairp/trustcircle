import { randomUUID } from 'node:crypto';

import { apiCommand } from '../../../../../../lib/api-client.ts';
import { resolveOperatorSession } from '../../../../../../lib/session-context.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bad(status: number, code: string): Response {
  return Response.json({ code, message: 'request rejected' }, { status });
}

export async function POST(
  _request: Request,
  { params }: { readonly params: Promise<{ packageId: string }> },
): Promise<Response> {
  const { packageId } = await params;
  if (!UUID.test(packageId)) return bad(400, 'invalid_package_id');
  const session = await resolveOperatorSession();
  const correlation = session.correlationId ?? randomUUID();
  const result = await apiCommand(
    `/v1/evidence-packages/${packageId}/verify`,
    { ...session, correlationId: correlation },
    {},
    { idempotencyKey: 'evidence-package-verify-' + packageId },
  );
  return Response.json(result.body ?? { code: result.failure ?? 'verification_unavailable' }, {
    status: result.status,
    headers: { 'cache-control': 'no-store' },
  });
}
