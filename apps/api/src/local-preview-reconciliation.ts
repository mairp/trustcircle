import { createHash } from 'node:crypto';

export interface LocalPreviewSqlClient {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
}

export interface LocalPreviewAdapterManifest {
  readonly path: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

export interface LocalPreviewReconciliationInput {
  readonly tenantId: string;
  readonly tenantName?: string;
  readonly componentProfile: Readonly<Record<string, unknown>>;
  readonly adapterManifests: readonly LocalPreviewAdapterManifest[];
  readonly standardsRegistry: Readonly<Record<string, unknown>>;
  readonly observedAtMs: number;
}

export interface LocalPreviewReconciliationResult {
  readonly tenantId: string;
  readonly principals: number;
  readonly assets: number;
  readonly sources: number;
  readonly coverageGaps: number;
  readonly adapterDefinitions: number;
  readonly adapterVersions: number;
  readonly connectors: number;
  readonly componentActivations: number;
  readonly publications: number;
  readonly clauses: number;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function objects(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => object(entry, `${label}[${index}]`));
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

/** Stable UUIDs keep this reconciliation idempotent without pretending the rows were discovered. */
export function localPreviewUuid(key: string): string {
  const bytes = createHash('sha256')
    .update(`trustcircle:local-preview:${key}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function epoch(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function protocolMajor(value: unknown): number {
  const major = Number.parseInt(typeof value === 'string' ? (value.split('.')[0] ?? '') : '', 10);
  return Number.isInteger(major) && major > 0 ? major : 1;
}

function adapterCategory(adapterKey: string): string {
  if (adapterKey === 'agentctl') return 'cli';
  if (adapterKey === 'workflow-orchestration') return 'workflow';
  if (adapterKey === 'lisa' || adapterKey === 'wiggum') return 'governance-observer';
  return 'connector';
}

function availabilityClass(runtimeSet: string): 'core' | 'optional' | 'on-demand' {
  if (runtimeSet === 'core-required') return 'core';
  if (runtimeSet === 'on-demand') return 'on-demand';
  return 'optional';
}

/**
 * Materialize the local preview's owner-approved declarations into the canonical store.
 * This is intentionally metadata-only: it registers what the repository actually declares,
 * but leaves runtime health unknown and connectors inactive until a real observation exists.
 */
export async function reconcileLocalPreviewData(
  client: LocalPreviewSqlClient,
  input: LocalPreviewReconciliationInput,
): Promise<LocalPreviewReconciliationResult> {
  const now = input.observedAtMs;
  if (!Number.isFinite(now) || now <= 0) throw new RangeError('observedAtMs must be positive');
  const components = objects(input.componentProfile['components'], 'componentProfile.components');
  const tenantName = input.tenantName?.trim() || 'Local read-only preview';
  const retentionPolicyId = localPreviewUuid('retention-policy:local-preview');
  const boundaryVersionId = localPreviewUuid('inventory-boundary:local-preview');

  await client.query(
    `INSERT INTO tenant
       (tenant_id, slug, display_name, boundary_version_id, status, data_residency,
        evidence_namespace, retention_policy_set_id, created_at, updated_at)
     VALUES ($1, 'local-preview', $2, $3, 'active', '{}'::jsonb,
             'trustcircle/local-preview', $4, $5, $5)
     ON CONFLICT (tenant_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       boundary_version_id = EXCLUDED.boundary_version_id,
       status = EXCLUDED.status,
       retention_policy_set_id = EXCLUDED.retention_policy_set_id,
       updated_at = EXCLUDED.updated_at`,
    [input.tenantId, tenantName, boundaryVersionId, retentionPolicyId, now],
  );

  const componentById = new Map<string, JsonObject>();
  const owners = new Set<string>(['platform/governance']);
  for (const component of components) {
    const id = requiredText(component['id'], 'component.id');
    componentById.set(id, component);
    owners.add(requiredText(component['owner'], `component ${id}.owner`));
  }

  const ownerIds = new Map<string, string>();
  for (const owner of [...owners].sort()) {
    const principalId = localPreviewUuid(`owner:${owner}`);
    ownerIds.set(owner, principalId);
    await client.query(
      `INSERT INTO principal
         (principal_id, principal_type, issuer, subject, display_name, status,
          assurance_level, attributes, last_verified_at, created_at, updated_at)
       VALUES ($1, 'service', 'trustcircle://component-profile', $2, $2, 'active',
               'declared-owner', $3::jsonb, $4, $4, $4)
       ON CONFLICT (principal_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         attributes = EXCLUDED.attributes,
         last_verified_at = EXCLUDED.last_verified_at,
         updated_at = EXCLUDED.updated_at`,
      [principalId, owner, JSON.stringify({ source: 'deploy/profiles/components.yaml' }), now],
    );
  }

  for (const component of components) {
    const componentKey = requiredText(component['id'], 'component.id');
    const role = requiredText(component['role'], `component ${componentKey}.role`);
    const runtimeSet = requiredText(
      component['runtimeSet'],
      `component ${componentKey}.runtimeSet`,
    );
    const owner = requiredText(component['owner'], `component ${componentKey}.owner`);
    const ownerId = ownerIds.get(owner)!;
    const assetId = localPreviewUuid(`component-asset:${componentKey}`);
    const activationId = localPreviewUuid(`component-activation:${componentKey}`);
    const declaredAvailability = availabilityClass(runtimeSet);
    const componentDigest = digest(component);

    await client.query(
      `INSERT INTO governed_asset
         (id, tenant_id, asset_type, name, owner_principal_id, lifecycle_state,
          risk_tier, health, coverage, last_observed_at, version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'unassessed', 'unknown', 'partial', NULL, 1, $7)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         asset_type = EXCLUDED.asset_type,
         name = EXCLUDED.name,
         owner_principal_id = EXCLUDED.owner_principal_id,
         updated_at = EXCLUDED.updated_at`,
      [
        assetId,
        input.tenantId,
        role,
        componentKey,
        ownerId,
        runtimeSet === 'core-required' ? 'unknown' : 'planned',
        now,
      ],
    );

    await client.query(
      `INSERT INTO component_activation
         (id, tenant_id, component_key, availability_class, runtime_state, activation_state,
          identity_verified, contract_verified, authority_verified, backlog_reconciled,
          evidence_ids, owner_principal_id, activated_at, updated_at, content_digest)
       VALUES ($1, $2, $3, $4, $5, 'inactive', FALSE, FALSE, FALSE, FALSE,
               '[]'::jsonb, $6, NULL, $7, $8)
       ON CONFLICT (tenant_id, component_key) DO UPDATE SET
         availability_class = EXCLUDED.availability_class,
         owner_principal_id = EXCLUDED.owner_principal_id,
         updated_at = EXCLUDED.updated_at,
         content_digest = EXCLUDED.content_digest`,
      [
        activationId,
        input.tenantId,
        componentKey,
        declaredAvailability,
        runtimeSet === 'core-required' ? 'unavailable' : 'intentionally_inactive',
        ownerId,
        now,
        componentDigest,
      ],
    );
  }

  for (const entry of input.adapterManifests) {
    const manifest = object(entry.manifest, `adapter manifest ${entry.path}`);
    const adapterKey = requiredText(manifest['adapter_id'], `${entry.path}.adapter_id`);
    const adapterName = requiredText(manifest['name'], `${entry.path}.name`);
    const adapterVersion = requiredText(
      manifest['adapter_version'],
      `${entry.path}.adapter_version`,
    );
    const capabilities = stringArray(manifest['capabilities']);
    const sourceClasses = stringArray(manifest['source_classes']);
    const contractRange = object(manifest['contract_range'], `${entry.path}.contract_range`);
    const lifecycle = object(manifest['lifecycle'], `${entry.path}.lifecycle`);
    const component = componentById.get(adapterKey);
    const owner = optionalText(component?.['owner']) ?? 'platform/governance';
    const ownerId = ownerIds.get(owner) ?? ownerIds.get('platform/governance')!;
    const runtimeSet = optionalText(component?.['runtimeSet']) ?? 'external';
    const definitionId = localPreviewUuid(`adapter-definition:${adapterKey}`);
    const versionId = localPreviewUuid(`adapter-version:${adapterKey}:${adapterVersion}`);
    const connectorId = localPreviewUuid(`connector:${adapterKey}`);
    const sourceId = localPreviewUuid(`source:${adapterKey}`);
    const gapId = localPreviewUuid(`source-gap:${adapterKey}`);
    const manifestDigest = digest(manifest);
    const releasedAt = epoch(lifecycle['released_at'], now);

    await client.query(
      `INSERT INTO adapter_definition
         (id, tenant_id, adapter_key, display_name, category, authority_grantable,
          owner_principal_id, content_digest, created_at)
       VALUES ($1, $2, $3, $4, $5, FALSE, $6, $7, $8)
       ON CONFLICT (adapter_key) DO NOTHING`,
      [
        definitionId,
        input.tenantId,
        adapterKey,
        adapterName,
        adapterCategory(adapterKey),
        ownerId,
        manifestDigest,
        releasedAt,
      ],
    );

    await client.query(
      `INSERT INTO adapter_version
         (id, tenant_id, definition_id, semantic_version, protocol_min, protocol_max,
          capabilities, manifest, manifest_signature, signing_key_id, lifecycle_state,
          content_digest, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
               'registered', $11, $12)
       ON CONFLICT (definition_id, semantic_version) DO NOTHING`,
      [
        versionId,
        input.tenantId,
        definitionId,
        adapterVersion,
        protocolMajor(contractRange['minimum']),
        protocolMajor(contractRange['maximum']),
        JSON.stringify(capabilities),
        JSON.stringify(manifest),
        `unverified-local-preview:${manifestDigest}`,
        'local-preview/unverified-manifest',
        manifestDigest,
        releasedAt,
      ],
    );

    await client.query(
      `INSERT INTO connector_instance
         (id, tenant_id, definition_id, version_id, source_ref, credential_ref,
          enabled_capabilities, scopes, cursor, cursor_sequence, availability_class,
          lifecycle_state, owner_principal_id, content_digest, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, '[]'::jsonb, $6::jsonb, NULL, 0, $7,
               'inactive', $8, $9, $10, $11)
       ON CONFLICT (tenant_id, definition_id, source_ref) DO UPDATE SET
         version_id = EXCLUDED.version_id,
         scopes = EXCLUDED.scopes,
         availability_class = EXCLUDED.availability_class,
         owner_principal_id = EXCLUDED.owner_principal_id,
         content_digest = EXCLUDED.content_digest,
         updated_at = EXCLUDED.updated_at`,
      [
        connectorId,
        input.tenantId,
        definitionId,
        versionId,
        `manifest://${entry.path}`,
        JSON.stringify(sourceClasses),
        availabilityClass(runtimeSet),
        ownerId,
        digest({ manifestDigest, sourceClasses }),
        releasedAt,
        now,
      ],
    );

    const lifecycleStatus = optionalText(lifecycle['status']) ?? 'proposed';
    const gapReason = lifecycleStatus === 'proposed' ? 'unsupported' : 'unmanaged';
    await client.query(
      `INSERT INTO coverage_gap
         (id, tenant_id, subject_kind, subject_id, gap_class, reason, impact,
          required_action, required_owner, status, resolution, first_seen_at,
          review_at, expires_at, resolved_at)
       VALUES ($1, $2, 'source_catalog_entry', $3, 'governed_source', $4, 'medium',
               $5, $6, 'open', NULL, $7, $8, NULL, NULL)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        gapId,
        input.tenantId,
        sourceId,
        gapReason,
        'Configure credentials, activate the connector, and run source reconciliation.',
        ownerId,
        releasedAt,
        now + 90 * 24 * 60 * 60 * 1_000,
      ],
    );

    await client.query(
      `INSERT INTO source_catalog_entry
         (id, tenant_id, source_class, boundary_id, observed_locations,
          owner_principal_id, onboarding_state, access_state, health_state, sensitivity,
          discovery_evidence, coverage_gap_ids, first_seen_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'pending', 'unknown', 'unknown', 'normal',
               NULL, $7::jsonb, $8, $9)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         source_class = EXCLUDED.source_class,
         boundary_id = EXCLUDED.boundary_id,
         observed_locations = EXCLUDED.observed_locations,
         owner_principal_id = EXCLUDED.owner_principal_id,
         coverage_gap_ids = EXCLUDED.coverage_gap_ids,
         last_seen_at = EXCLUDED.last_seen_at`,
      [
        sourceId,
        input.tenantId,
        sourceClasses[0] ?? adapterKey,
        boundaryVersionId,
        JSON.stringify([`manifest://${entry.path}`]),
        ownerId,
        JSON.stringify([gapId]),
        releasedAt,
        now,
      ],
    );
  }

  const publications = objects(
    input.standardsRegistry['publications'],
    'standardsRegistry.publications',
  );
  let clauseCount = 0;
  for (const publication of publications) {
    const seedId = requiredText(publication['id'], 'publication.id');
    const publicationId = localPreviewUuid(`standard-publication:${seedId}`);
    const registryVersion = Number(publication['registryVersion'] ?? 1);
    const publicationDigest = digest(publication);
    const createdAt = epoch(publication['publicationDate'], now);
    await client.query(
      `INSERT INTO standard_publication
         (id, tenant_id, publisher, identifier, exact_title, edition, publication_date,
          status, material_type, source_uri, registry_version, supersedes_id,
          content_digest, created_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6::date, $7, $8, $9, $10, NULL, $11, $12)
       ON CONFLICT (identifier, registry_version) DO NOTHING`,
      [
        publicationId,
        requiredText(publication['publisher'], `${seedId}.publisher`),
        requiredText(publication['identifier'], `${seedId}.identifier`),
        requiredText(publication['exactTitle'], `${seedId}.exactTitle`),
        requiredText(publication['edition'], `${seedId}.edition`),
        requiredText(publication['publicationDate'], `${seedId}.publicationDate`),
        requiredText(publication['status'], `${seedId}.status`),
        requiredText(publication['materialType'], `${seedId}.materialType`),
        requiredText(publication['sourceUri'], `${seedId}.sourceUri`),
        Number.isInteger(registryVersion) && registryVersion > 0 ? registryVersion : 1,
        publicationDigest,
        createdAt,
      ],
    );

    const clauses = objects(publication['clauses'] ?? [], `${seedId}.clauses`);
    clauseCount += clauses.length;
    for (const clause of clauses) {
      const clauseRef = requiredText(clause['clauseRef'], `${seedId}.clauseRef`);
      const version = Number(clause['version'] ?? 1);
      await client.query(
        `INSERT INTO clause_version
           (id, tenant_id, publication_id, clause_ref, title, material_type, version,
            supersedes_id, content_digest, created_at)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, NULL, $7, $8)
         ON CONFLICT (publication_id, clause_ref, version) DO NOTHING`,
        [
          localPreviewUuid(`standard-clause:${seedId}:${clauseRef}:${version}`),
          publicationId,
          clauseRef,
          requiredText(clause['title'], `${seedId}.${clauseRef}.title`),
          requiredText(clause['materialType'], `${seedId}.${clauseRef}.materialType`),
          Number.isInteger(version) && version > 0 ? version : 1,
          digest(clause),
          createdAt,
        ],
      );
    }
  }

  return {
    tenantId: input.tenantId,
    principals: owners.size,
    assets: components.length,
    sources: input.adapterManifests.length,
    coverageGaps: input.adapterManifests.length,
    adapterDefinitions: input.adapterManifests.length,
    adapterVersions: input.adapterManifests.length,
    connectors: input.adapterManifests.length,
    componentActivations: components.length,
    publications: publications.length,
    clauses: clauseCount,
  };
}
