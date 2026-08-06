import { validateProductAnalyticsEvent } from '../../../lib/product-analytics.ts';

const MAX_ANALYTICS_BODY_BYTES = 2048;

function payloadTooLarge(): Response {
  return Response.json({ accepted: false, code: 'payload_too_large' }, { status: 413 });
}

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get('x-trustcircle-product-analytics') === 'disabled') {
    return new Response(null, { status: 204 });
  }
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return Response.json({ accepted: false, code: 'invalid_content_length' }, { status: 400 });
    }
    if (Number(contentLength) > MAX_ANALYTICS_BODY_BYTES) {
      return payloadTooLarge();
    }
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    return Response.json({ accepted: false, code: 'unsupported_media_type' }, { status: 415 });
  }
  let bodyText: string;
  try {
    bodyText = await request.text();
  } catch {
    return Response.json({ accepted: false, code: 'invalid_json' }, { status: 400 });
  }
  const actualLength = new TextEncoder().encode(bodyText).byteLength;
  if (actualLength > MAX_ANALYTICS_BODY_BYTES) {
    return payloadTooLarge();
  }
  if (contentLength !== null && Number(contentLength) !== actualLength) {
    return Response.json({ accepted: false, code: 'content_length_mismatch' }, { status: 400 });
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
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
