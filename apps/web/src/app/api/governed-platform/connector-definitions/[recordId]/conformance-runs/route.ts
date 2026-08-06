import { forwardGovernedCommand } from '../../../../../../lib/governed-command-proxy.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { readonly params: Promise<{ recordId: string }> },
): Promise<Response> {
  const { recordId } = await params;
  if (!UUID.test(recordId)) {
    return Response.json(
      { code: 'invalid_connector_definition_id', message: 'request rejected' },
      { status: 400 },
    );
  }
  return forwardGovernedCommand(
    request,
    `/v1/connector-definitions/${recordId}/conformance-runs`,
    'connector-conformance-' + recordId,
  );
}
