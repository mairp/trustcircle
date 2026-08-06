import { notFound } from 'next/navigation';

import { Asset360, assetTab } from '../../../components/asset-360.tsx';
import { AuthenticationRequired } from '../../../components/degraded-state.tsx';
import { GovernanceSection } from '../../../components/governance-status.tsx';
import { OperatorShell } from '../../../components/operator-shell.tsx';
import { loadConsole } from '../../../lib/console-loader.ts';
import { operationsWorkspaceCapabilities, permittedDomains } from '../../../lib/permissions.ts';
import { resolveOperatorSession } from '../../../lib/session-context.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AssetPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ assetId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await resolveOperatorSession();
  if (!session.authenticated) return <AuthenticationRequired />;
  const plans = permittedDomains(session);
  const capabilities = operationsWorkspaceCapabilities(session);
  const inventoryPlan = plans.find((plan) => plan.id === 'inventory');
  if (!inventoryPlan) notFound();
  const [{ assetId: encodedAssetId }, query] = await Promise.all([params, searchParams]);
  const assetId = decodeURIComponent(encodedAssetId);
  const sections = await loadConsole(plans, session);
  const inventory = sections.find((section) => section.id === 'inventory');
  if (!inventory) notFound();
  const asset = inventory.records.find((record) =>
    record.fields.some((field) => field.label === 'Asset ID' && field.value === assetId),
  );
  if (!asset && inventory.quality === 'current') notFound();
  return (
    <OperatorShell
      session={session}
      plans={plans}
      operationsVisible={capabilities.canRead}
      operationsMutable={!capabilities.readOnly}
      currentPath="/inventory"
      pageEyebrow="Governed inventory"
      pageTitle={asset?.title ?? 'Asset detail unavailable'}
      pageDescription="Business identity, governance posture, related controls and evidence, dependencies, provenance, and attributable history."
    >
      {asset ? (
        <Asset360
          assetId={assetId}
          asset={asset}
          inventory={inventory}
          sections={sections}
          tab={assetTab(query['tab'])}
        />
      ) : (
        <>
          <div className="status-explanation status-explanation--blocked">
            <div>
              <h2>Asset could not be verified</h2>
              <p>
                The inventory source is not current, so a missing record is not treated as absent.
              </p>
            </div>
            <p>
              <strong>Safe next action</strong>
              <span>
                Restore the authoritative inventory projection and retry this stable deep link.
              </span>
            </p>
          </div>
          <GovernanceSection section={inventory} />
        </>
      )}
    </OperatorShell>
  );
}
