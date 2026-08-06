import { validateProductAnalyticsEvent } from '../../../lib/product-analytics.ts';

export async function POST(request: Request): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(length) && length > 2048) {
    return Response.json({ accepted: false, code: 'payload_too_large' }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return Response.json({ accepted: false, code: 'invalid_json' }, { status: 400 });
  }
  const validated = validateProductAnalyticsEvent(body);
  if (!validated.ok) {
    return Response.json({ accepted: false, code: validated.reason }, { status: 400 });
  }
  console.info('trustcircle_product_analytics', validated.event);
  return Response.json({ accepted: true }, { status: 202 });
}
