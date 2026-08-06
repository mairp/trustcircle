import { forwardGovernedCommand } from '../../../../lib/governed-command-proxy.ts';

export async function POST(request: Request): Promise<Response> {
  return forwardGovernedCommand(
    request,
    '/v1/connector-reconciliations',
    'connector-reconciliation',
  );
}
