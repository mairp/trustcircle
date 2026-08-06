import { createHash, randomUUID } from 'node:crypto';

import type { OperationalCaseRepository } from '@trustcircle/application';
import type { ContextRole, RequestLike, VerifiedIdentity } from './middleware/context.ts';
import { registerComplianceRoutes } from './routes/compliance.ts';
import type { CoverageView } from './routes/compliance.ts';
import { registerControllersRoutes } from './routes/controllers.ts';
import type { ControllerView, OperationView } from './routes/controllers.ts';
import { registerDecisionDashboardRoutes } from './routes/decision-dashboard.ts';
import type { DecisionQueueDashboard, ForeignDashboardView } from './routes/decision-dashboard.ts';
import { registerDecisionRoutes } from './routes/decisions.ts';
import type { DecisionPackageView, DecisionQueueView } from './routes/decisions.ts';
import { registerIntegrationRoutes } from './routes/integrations.ts';
import type {
  ConnectorView,
  PlatformHealthView,
  PlatformReadinessView,
} from './routes/integrations.ts';
import { registerIntegrityCasesRoutes } from './routes/integrity-cases.ts';
import type { IntegrityCaseView, IntegrityQueueView } from './routes/integrity-cases.ts';
import { registerInventoryRoutes } from './routes/inventory.ts';
import type { TenantProjection } from './routes/inventory.ts';
import { createRuntimeOperationsCommandCenter } from './operations-runtime.ts';
import { registerOperationsCommandCenterRoutes } from './routes/operations-command-center.ts';
import {
  API_VERSION,
  createApp,
  type App,
  type GovernancePictureInput,
  type ReadinessProvider,
} from './server.ts';

export const INTERNAL_PREVIEW_IDENTITY_HEADER = 'x-trustcircle-runtime-preview-identity';
export const DEFAULT_LOCAL_PREVIEW_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const DEFAULT_LOCAL_PREVIEW_PRINCIPAL_ID = 'local-preview-operator';

const READ_CONTRACT_VERSION = '1.0';
const FRESHNESS_OBJECTIVE_MS = 15_000;

export type RuntimeRow = Readonly<Record<string, unknown>>;

export interface RuntimeReadModelSnapshot {
  readonly tenantId: string;
  readonly tenantRegistered: boolean;
  readonly observedAtMs: number;
  readonly assets: readonly RuntimeRow[];
  readonly sources: readonly RuntimeRow[];
  readonly coverageGaps: readonly RuntimeRow[];
  readonly decisions: readonly RuntimeRow[];
  readonly decisionRequirements: readonly RuntimeRow[];
  readonly integrityCases: readonly RuntimeRow[];
  readonly controllerDefinitions: readonly RuntimeRow[];
  readonly controllerInstances: readonly RuntimeRow[];
  readonly controllerOperations: readonly RuntimeRow[];
  readonly publications: readonly RuntimeRow[];
  readonly obligations: readonly RuntimeRow[];
  readonly controlMappings: readonly RuntimeRow[];
  readonly controlEvaluations: readonly RuntimeRow[];
  readonly evidence: readonly RuntimeRow[];
  readonly connectors: readonly RuntimeRow[];
  readonly adapterDefinitions: readonly RuntimeRow[];
  readonly adapterVersions: readonly RuntimeRow[];
  readonly healthObservations: readonly RuntimeRow[];
  readonly alerts: readonly RuntimeRow[];
  readonly componentActivations: readonly RuntimeRow[];
  readonly runtimeComponents: readonly RuntimeRow[];
}

export interface RuntimeReadModelRepository {
  refreshTenant(tenantId: string): Promise<RuntimeReadModelSnapshot>;
  snapshot(tenantId: string): RuntimeReadModelSnapshot | undefined;
  close?(): void | Promise<void>;
}

export type RuntimeComponentProvider = () => Promise<readonly RuntimeRow[]>;

export interface RuntimeSqlClient {
  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Readonly<Record<string, unknown>>[] }>;
  end?(): void | Promise<void>;
}

export function createEmptyRuntimeSnapshot(
  tenantId: string,
  observedAtMs: number,
  tenantRegistered = true,
): RuntimeReadModelSnapshot {
  return Object.freeze({
    tenantId,
    tenantRegistered,
    observedAtMs,
    assets: Object.freeze([]),
    sources: Object.freeze([]),
    coverageGaps: Object.freeze([]),
    decisions: Object.freeze([]),
    decisionRequirements: Object.freeze([]),
    integrityCases: Object.freeze([]),
    controllerDefinitions: Object.freeze([]),
    controllerInstances: Object.freeze([]),
    controllerOperations: Object.freeze([]),
    publications: Object.freeze([]),
    obligations: Object.freeze([]),
    controlMappings: Object.freeze([]),
    controlEvaluations: Object.freeze([]),
    evidence: Object.freeze([]),
    connectors: Object.freeze([]),
    adapterDefinitions: Object.freeze([]),
    adapterVersions: Object.freeze([]),
    healthObservations: Object.freeze([]),
    alerts: Object.freeze([]),
    componentActivations: Object.freeze([]),
    runtimeComponents: Object.freeze([]),
  });
}

const TENANT_SNAPSHOT_SQL = `
SELECT jsonb_build_object(
  'tenantRegistered', EXISTS (SELECT 1 FROM tenant WHERE tenant_id = $1),
  'assets', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT id, tenant_id, asset_type, name, owner_principal_id, lifecycle_state, risk_tier,
           health, coverage, last_observed_at, version, updated_at
      FROM governed_asset WHERE tenant_id = $1 ORDER BY id
  ) r), '[]'::jsonb),
  'sources', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT id, tenant_id, source_class, boundary_id, observed_locations, owner_principal_id,
           onboarding_state, access_state, health_state, sensitivity, discovery_evidence,
           coverage_gap_ids, first_seen_at, last_seen_at
      FROM source_catalog_entry WHERE tenant_id = $1 ORDER BY id
  ) r), '[]'::jsonb),
  'coverageGaps', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM coverage_gap WHERE tenant_id = $1 ORDER BY id
  ) r), '[]'::jsonb),
  'decisions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM decision_request WHERE tenant_id = $1 ORDER BY created_at DESC, id
  ) r), '[]'::jsonb),
  'decisionRequirements', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM decision_requirement WHERE owner_tenant_id = $1 ORDER BY decision_id, id
  ) r), '[]'::jsonb),
  'integrityCases', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM integrity_case WHERE tenant_id = $1 ORDER BY detected_at DESC, id
  ) r), '[]'::jsonb),
  'controllerDefinitions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM controller_definition WHERE tenant_id = $1 ORDER BY controller_key, id
  ) r), '[]'::jsonb),
  'controllerInstances', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM controller_instance WHERE tenant_id = $1 ORDER BY controller_id, id
  ) r), '[]'::jsonb),
  'controllerOperations', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM controller_operation WHERE tenant_id = $1 ORDER BY requested_at DESC, id
  ) r), '[]'::jsonb),
  'publications', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT id, tenant_id, publisher, identifier, exact_title, edition, publication_date,
           status, material_type, source_uri, registry_version
      FROM standard_publication
     WHERE tenant_id = $1 OR tenant_id IS NULL
     ORDER BY identifier, registry_version DESC, id
  ) r), '[]'::jsonb),
  'obligations', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM compliance_obligation WHERE tenant_id = $1 ORDER BY id
  ) r), '[]'::jsonb),
  'controlMappings', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM control_mapping WHERE tenant_id = $1 ORDER BY id
  ) r), '[]'::jsonb),
  'controlEvaluations', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM control_evaluation WHERE tenant_id = $1 ORDER BY evaluated_at DESC, id
  ) r), '[]'::jsonb),
  'evidence', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT evidence_item_id, tenant_id, kind, content_sha256, size_bytes, media_type,
           parent_evidence_id, source_catalog_entry_id, source_record_id,
           produced_by_principal_id, produced_at, observed_at, classification,
           retain_until, legal_hold_count, integrity_status, status, created_at
      FROM evidence_item WHERE tenant_id = $1 ORDER BY created_at DESC, evidence_item_id
  ) r), '[]'::jsonb),
  'connectors', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT id, tenant_id, definition_id, version_id, source_ref, enabled_capabilities, scopes,
           cursor_sequence, availability_class, lifecycle_state, owner_principal_id,
           content_digest, created_at, updated_at
      FROM connector_instance WHERE tenant_id = $1 ORDER BY id
  ) r), '[]'::jsonb),
  'adapterDefinitions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM adapter_definition WHERE tenant_id = $1 ORDER BY adapter_key, id
  ) r), '[]'::jsonb),
  'adapterVersions', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT id, tenant_id, definition_id, semantic_version, protocol_min, protocol_max,
           capabilities, lifecycle_state, content_digest, created_at
      FROM adapter_version WHERE tenant_id = $1 ORDER BY definition_id, created_at DESC, id
  ) r), '[]'::jsonb),
  'healthObservations', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM health_observation WHERE tenant_id = $1 ORDER BY observed_at DESC, id
  ) r), '[]'::jsonb),
  'alerts', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM alert_record WHERE tenant_id = $1 ORDER BY first_observed_at DESC, id
  ) r), '[]'::jsonb),
  'componentActivations', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT * FROM component_activation WHERE tenant_id = $1 ORDER BY component_key, id
  ) r), '[]'::jsonb)
) AS snapshot
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rows(value: unknown): readonly RuntimeRow[] {
  return Array.isArray(value) ? value.filter(isRecord).map((row) => Object.freeze({ ...row })) : [];
}

export class PostgresRuntimeReadModelRepository implements RuntimeReadModelRepository {
  private readonly snapshots = new Map<string, RuntimeReadModelSnapshot>();
  private readonly client: RuntimeSqlClient;
  private readonly now: () => number;
  private readonly componentProvider: RuntimeComponentProvider;

  constructor(
    client: RuntimeSqlClient,
    now: () => number = Date.now,
    componentProvider: RuntimeComponentProvider = async () => [],
  ) {
    this.client = client;
    this.now = now;
    this.componentProvider = componentProvider;
  }

  async refreshTenant(tenantId: string): Promise<RuntimeReadModelSnapshot> {
    const [result, runtimeComponents] = await Promise.all([
      this.client.query(TENANT_SNAPSHOT_SQL, [tenantId]),
      this.componentProvider(),
    ]);
    const root = result.rows[0]?.['snapshot'];
    if (!isRecord(root)) throw new Error('postgresql read-model snapshot is malformed');
    const tenantRegistered = root['tenantRegistered'] === true;
    const empty = createEmptyRuntimeSnapshot(tenantId, this.now(), tenantRegistered);
    const snapshot = Object.freeze({
      ...empty,
      assets: rows(root['assets']),
      sources: rows(root['sources']),
      coverageGaps: rows(root['coverageGaps']),
      decisions: rows(root['decisions']),
      decisionRequirements: rows(root['decisionRequirements']),
      integrityCases: rows(root['integrityCases']),
      controllerDefinitions: rows(root['controllerDefinitions']),
      controllerInstances: rows(root['controllerInstances']),
      controllerOperations: rows(root['controllerOperations']),
      publications: rows(root['publications']),
      obligations: rows(root['obligations']),
      controlMappings: rows(root['controlMappings']),
      controlEvaluations: rows(root['controlEvaluations']),
      evidence: rows(root['evidence']),
      connectors: rows(root['connectors']),
      adapterDefinitions: rows(root['adapterDefinitions']),
      adapterVersions: rows(root['adapterVersions']),
      healthObservations: rows(root['healthObservations']),
      alerts: rows(root['alerts']),
      componentActivations: rows(root['componentActivations']),
      runtimeComponents: rows(runtimeComponents),
    });
    this.snapshots.set(tenantId, snapshot);
    return snapshot;
  }

  snapshot(tenantId: string): RuntimeReadModelSnapshot | undefined {
    return this.snapshots.get(tenantId);
  }

  async close(): Promise<void> {
    await this.client.end?.();
  }
}

function text(row: RuntimeRow, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? fallback
      : String(value);
}

function optionalText(row: RuntimeRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(row: RuntimeRow, key: string, fallback = 0): number {
  const value = row[key];
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(row: RuntimeRow, key: string, fallback = false): boolean {
  return typeof row[key] === 'boolean' ? row[key] : fallback;
}

function recordValue(row: RuntimeRow, key: string): Readonly<Record<string, unknown>> {
  return isRecord(row[key]) ? row[key] : {};
}

function arrayValue(row: RuntimeRow, key: string): readonly unknown[] {
  return Array.isArray(row[key]) ? row[key] : [];
}

function stringArray(row: RuntimeRow, key: string): readonly string[] {
  return arrayValue(row, key).filter((value): value is string => typeof value === 'string');
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rowTenant(row: RuntimeRow): string {
  return text(row, 'tenant_id');
}

function decisionView(row: RuntimeRow, snapshot: RuntimeReadModelSnapshot): DecisionPackageView {
  const id = text(row, 'id');
  const requirements = snapshot.decisionRequirements
    .filter((requirement) => text(requirement, 'decision_id') === id)
    .map((requirement) => ({
      id: text(requirement, 'id'),
      gateType: text(requirement, 'gate_type'),
      tenantId: optionalText(requirement, 'tenant_id') ?? null,
      status: text(requirement, 'status', 'pending'),
      minimumDistinctPrincipals: numberValue(requirement, 'minimum_distinct_principals', 1),
      incompatibleRelationships: stringArray(requirement, 'incompatible_relationships'),
    }));
  return {
    id,
    tenantId: rowTenant(row),
    workItemId: text(row, 'work_item_id'),
    requesterPrincipalId: text(row, 'requester_principal_id'),
    requestedAction: text(row, 'requested_action'),
    actionClass: text(row, 'action_class'),
    riskTier: text(row, 'risk_tier', 'unassessed'),
    scope: recordValue(row, 'scope'),
    businessImpact: recordValue(row, 'business_impact'),
    risks: arrayValue(row, 'risks').filter(isRecord),
    alternatives: arrayValue(row, 'alternatives').filter(isRecord),
    expectedResult: recordValue(row, 'expected_result'),
    evidenceManifestId: optionalText(row, 'evidence_manifest_id') ?? null,
    simulationId: optionalText(row, 'simulation_id') ?? null,
    affectedTenantIds: stringArray(row, 'affected_tenant_ids'),
    status: text(row, 'status', 'pending'),
    requirements,
    version: numberValue(row, 'version', 1),
    createdAt: numberValue(row, 'created_at'),
    expiresAt: numberValue(row, 'expires_at'),
    packageDigest: digest(row),
  } as unknown as DecisionPackageView;
}

function integrityView(row: RuntimeRow): IntegrityCaseView {
  return {
    id: text(row, 'id'),
    tenantId: rowTenant(row),
    problemClass: text(row, 'problem_class', 'unknown'),
    severity: text(row, 'severity', 'unknown'),
    originalEvidenceId: text(row, 'original_evidence_id'),
    quarantineId: optionalText(row, 'quarantine_id') ?? null,
    remediationPlanId: optionalText(row, 'active_remediation_plan_id') ?? null,
    verificationId: optionalText(row, 'resolution_verification_id') ?? null,
    state: text(row, 'state', 'unknown'),
    version: numberValue(row, 'version', 1),
    caseDigest: digest(row),
  } as unknown as IntegrityCaseView;
}

function controllerViews(snapshot: RuntimeReadModelSnapshot): readonly ControllerView[] {
  return snapshot.controllerDefinitions.map((definition) => {
    const definitionId = text(definition, 'id');
    const instance = snapshot.controllerInstances.find(
      (candidate) => text(candidate, 'controller_id') === definitionId,
    );
    const row = instance ?? definition;
    const observedAt = numberValue(row, 'last_observed_at', numberValue(row, 'updated_at'));
    return {
      id: definitionId,
      tenantId: rowTenant(definition),
      controllerVersion: text(row, 'bound_version', '1'),
      desiredVersion: numberValue(row, 'bound_version', 1),
      observedVersion: optionalText(row, 'source_revision'),
      ownerPrincipalId: optionalText(definition, 'owner_principal_id'),
      health: text(row, 'health_state', 'unknown'),
      desiredState: recordValue(row, 'desired_state'),
      observedState: recordValue(row, 'observed_state'),
      nextPermittedActions: [],
      ...(observedAt > 0 ? { observedAt } : {}),
      failureDetail: null,
    } as unknown as ControllerView;
  });
}

function operationView(row: RuntimeRow): OperationView {
  return {
    id: text(row, 'id'),
    tenantId: rowTenant(row),
    controllerId: text(row, 'controller_id'),
    operationType: text(row, 'operation_kind'),
    expectedObservedVersion: text(row, 'source_revision'),
    reason: { code: 'persisted_operation', text: 'Persisted governed controller operation' },
    scope: {},
    targetState: recordValue(row, 'requested_change'),
    simulationId: optionalText(row, 'simulation_id') ?? null,
    decisionRequestId: optionalText(row, 'approval_decision_id') ?? null,
    policyDecisionId: text(row, 'bound_policy_version_id'),
    status: text(row, 'state', 'unknown'),
    outcome: {},
    continuityLeaseExpiresAt: null,
    reconciliationRunId: null,
    evidenceManifestId: null,
    createdAt: numberValue(row, 'requested_at'),
    version: 1,
    operationDigest: text(row, 'content_digest', digest(row)),
  } as unknown as OperationView;
}

function connectorViews(snapshot: RuntimeReadModelSnapshot): readonly ConnectorView[] {
  return snapshot.connectors.map((connector) => {
    const id = text(connector, 'id');
    const definitionId = text(connector, 'definition_id');
    const versionId = text(connector, 'version_id');
    const definition = snapshot.adapterDefinitions.find(
      (candidate) => text(candidate, 'id') === definitionId,
    );
    const version = snapshot.adapterVersions.find(
      (candidate) => text(candidate, 'id') === versionId,
    );
    const observation = snapshot.healthObservations.find(
      (candidate) => text(candidate, 'connector_id') === id,
    );
    const alerts = snapshot.alerts
      .filter((candidate) => text(candidate, 'connector_id') === id)
      .map((alert) => ({
        id: text(alert, 'id'),
        alertClass: text(alert, 'alert_class'),
        severity: text(alert, 'severity'),
        ownerPrincipalId: text(alert, 'owner_principal_id'),
        state: text(alert, 'state'),
        firstObservedAt: numberValue(alert, 'first_observed_at'),
        ownerNotifiedAt: numberValue(alert, 'owner_notified_at') || null,
        recoveredAt: numberValue(alert, 'recovered_at') || null,
      }));
    const observedAt = observation
      ? numberValue(observation, 'observed_at', snapshot.observedAtMs)
      : snapshot.observedAtMs;
    const freshness = observation ? text(observation, 'freshness_state', 'unknown') : 'unknown';
    const readiness = observation ? text(observation, 'readiness_state', 'unknown') : 'unknown';
    const health =
      freshness === 'fresh' && readiness === 'ready'
        ? 'healthy'
        : freshness === 'stale'
          ? 'degraded'
          : 'unknown';
    return {
      id,
      adapterKey: definition ? text(definition, 'adapter_key', 'unknown') : 'unknown',
      sourceRef: text(connector, 'source_ref'),
      definitionId,
      versionId,
      observedVersion: version ? text(version, 'semantic_version') : null,
      ownerPrincipalId: text(connector, 'owner_principal_id'),
      availabilityClass: text(connector, 'availability_class', 'optional'),
      lifecycleState: text(connector, 'lifecycle_state', 'unknown'),
      enabledCapabilities: stringArray(connector, 'enabled_capabilities'),
      scopes: stringArray(connector, 'scopes'),
      health,
      freshness,
      freshnessAgeMs: observation ? numberValue(observation, 'freshness_age_ms') : null,
      lagMs: observation ? numberValue(observation, 'lag_ms') : null,
      lastSuccessAt: null,
      lastAttemptAt: observedAt,
      activeOperationId: null,
      failureCount: observation ? numberValue(observation, 'failure_count') : 0,
      retryDepth: observation ? numberValue(observation, 'retry_depth') : 0,
      deadLetterCount: 0,
      affectedScope: observation ? stringArray(observation, 'affected_scope') : [],
      businessImpact: observation ? text(observation, 'business_impact', 'none') : 'none',
      evidenceIds: observation ? stringArray(observation, 'evidence_ids') : [],
      alerts,
      safeNextAction:
        health === 'healthy'
          ? 'none'
          : 'Inspect connector ownership and refresh its health observation.',
      observedAt,
    } as unknown as ConnectorView;
  });
}

function currentMetadata(observedAtMs: number, sourceCursor: string) {
  return {
    generated_at: new Date(observedAtMs).toISOString(),
    source_cursor: sourceCursor,
    freshness: 'current' as const,
    partial_coverage: false,
  };
}

function readonlyMutation(): never {
  throw new Error('local preview is read-only');
}

function mountDomainRoutes(
  app: App,
  repository: RuntimeReadModelRepository,
  now: () => number,
  operationsRepository?: OperationalCaseRepository,
): void {
  const snapshotFor = (tenantId: string) => repository.snapshot(String(tenantId));

  registerInventoryRoutes(app, {
    projections: (tenantId) => {
      const snapshot = snapshotFor(String(tenantId));
      if (!snapshot) return undefined;
      const now = snapshot.observedAtMs;
      const inventoryRows = snapshot.assets.map((asset) => {
        const observedAt = numberValue(asset, 'last_observed_at');
        const age = observedAt > 0 ? Math.max(0, now - observedAt) : Number.POSITIVE_INFINITY;
        const current = age <= FRESHNESS_OBJECTIVE_MS;
        const observedHealth = text(asset, 'health', 'unknown');
        return {
          assetId: text(asset, 'id'),
          assetType: text(asset, 'asset_type', 'unknown'),
          name: text(asset, 'name', 'Unnamed asset'),
          ownerPrincipalId: optionalText(asset, 'owner_principal_id'),
          ownershipGap: !optionalText(asset, 'owner_principal_id'),
          lifecycleState: text(asset, 'lifecycle_state', 'unknown'),
          riskTier: text(asset, 'risk_tier', 'unassessed'),
          coverage: text(asset, 'coverage', 'gap'),
          observedHealth,
          reportedHealth: current ? observedHealth : 'unknown',
          evidenceState: observedAt === 0 ? 'incomplete' : current ? 'current' : 'stale',
          ...(observedAt > 0 ? { lastObservationAt: observedAt } : {}),
          unresolvedIssueCount: 0,
          confidence: observedAt === 0 ? 0 : current ? 1 : 0.5,
          hasVisibleComponentGap: false,
          sourceRecordCount: 0,
          version: numberValue(asset, 'version', 1),
        };
      });
      const sourceRows = snapshot.sources.map((source) => {
        const lastKnownAt = numberValue(source, 'last_seen_at', now);
        const age = Math.max(0, now - lastKnownAt);
        const stale = age > FRESHNESS_OBJECTIVE_MS;
        const observedHealth = text(source, 'health_state', 'unknown');
        return {
          sourceId: text(source, 'id'),
          sourceClass: text(source, 'source_class', 'unknown'),
          classifiedUnknown: text(source, 'source_class', 'unknown') === 'unknown',
          ownerPrincipalId: optionalText(source, 'owner_principal_id'),
          ownershipGap: !optionalText(source, 'owner_principal_id'),
          onboardingState: text(source, 'onboarding_state', 'discovered'),
          accessState: text(source, 'access_state', 'unknown'),
          observedHealth,
          reportedHealth: stale ? 'unknown' : observedHealth,
          sensitivity: text(source, 'sensitivity', 'normal'),
          evidenceState: stale ? 'stale' : 'current',
          staleness: stale ? 'stale' : 'fresh',
          lastKnownAt,
          confidence: stale ? 0.5 : 1,
          hasControlCoverage: stringArray(source, 'coverage_gap_ids').length === 0,
          unresolvedIssueCount: stringArray(source, 'coverage_gap_ids').length,
          discoveryEvidence: optionalText(source, 'discovery_evidence'),
          version: 1,
        };
      });
      const sources = {
        currentStateView: () => sourceRows,
        catalog: () =>
          snapshot.sources.map((source) => ({
            id: text(source, 'id'),
            tenantId: rowTenant(source),
            sourceClass: text(source, 'source_class', 'unknown'),
            boundaryId: optionalText(source, 'boundary_id'),
            observedLocations: stringArray(source, 'observed_locations'),
            ownerPrincipalId: optionalText(source, 'owner_principal_id'),
            onboardingState: text(source, 'onboarding_state', 'discovered'),
            accessState: text(source, 'access_state', 'unknown'),
            healthState: text(source, 'health_state', 'unknown'),
            sensitivity: text(source, 'sensitivity', 'normal'),
            discoveryEvidence: optionalText(source, 'discovery_evidence'),
            coverageGapIds: stringArray(source, 'coverage_gap_ids'),
            firstSeenAt: numberValue(source, 'first_seen_at', now),
            lastSeenAt: numberValue(source, 'last_seen_at', now),
          })),
        gapsForSource: () => [],
        statusDifferencesFor: () => [],
        dependenciesFor: () => [],
      };
      return {
        now,
        inventory: {
          currentStateView: () => inventoryRows,
          gapsForAsset: () => [],
        },
        sources,
      } as unknown as TenantProjection;
    },
    discovery: async () => readonlyMutation(),
  });

  registerDecisionRoutes(app, {
    queue: (tenantId, _principalId, filter): DecisionQueueView | undefined => {
      const snapshot = snapshotFor(String(tenantId));
      if (!snapshot) return undefined;
      let items = snapshot.decisions.map((row) => decisionView(row, snapshot));
      if (filter.status) items = items.filter((item) => item.status === filter.status);
      return {
        items,
        generatedAt: snapshot.observedAtMs,
        freshness: 'current',
        partialCoverage: false,
        snapshotDigest: digest(snapshot.decisions),
      } as unknown as DecisionQueueView;
    },
    readPackage: (tenantId, decisionId) => {
      const snapshot = snapshotFor(String(tenantId));
      const row = snapshot?.decisions.find(
        (candidate) => text(candidate, 'id') === String(decisionId),
      );
      return row && snapshot ? decisionView(row, snapshot) : undefined;
    },
    create: async () => readonlyMutation(),
    act: async () => readonlyMutation(),
  });

  // The console's role label is a stable compatibility alias for the existing executive
  // dashboard presenter. Register it as an exact route before the module's parameterized
  // /dashboards/:view route so the generic module remains unchanged for its public enum.
  app.get('/dashboards/governance-officer', (c) => {
    const tenantId = c.ctx?.tenantId;
    const snapshot = tenantId ? snapshotFor(tenantId) : undefined;
    if (!snapshot) {
      return c.json(
        {
          error: 'POSTURE_UNAVAILABLE',
          message: 'the tenant posture read model is unavailable',
          correlationId: c.ctx?.correlationId,
        },
        503,
      );
    }
    const items = [
      { domain: 'inventory', record_count: snapshot.assets.length },
      { domain: 'decisions', record_count: snapshot.decisions.length },
      { domain: 'integrity', record_count: snapshot.integrityCases.length },
      { domain: 'controllers', record_count: snapshot.controllerDefinitions.length },
      { domain: 'connectors', record_count: snapshot.connectors.length },
      { domain: 'runtime-components', record_count: snapshot.runtimeComponents.length },
    ];
    return c.json({
      view: 'governance-officer',
      data: { items },
      metadata: currentMetadata(snapshot.observedAtMs, digest(items)),
    });
  });

  registerDecisionDashboardRoutes(app, {
    decisionQueue: (tenantId): DecisionQueueDashboard | undefined => {
      const snapshot = snapshotFor(String(tenantId));
      if (!snapshot) return undefined;
      const decisions = snapshot.decisions.map((row) => decisionView(row, snapshot));
      return {
        items: decisions.map((item, index) => ({
          decisionId: String(item.id),
          workItemId: String(item.workItemId),
          requesterPrincipalId: String(item.requesterPrincipalId),
          requestedAction: item.requestedAction,
          actionClass: item.actionClass,
          riskTier: item.riskTier,
          impact: 'unknown',
          status: item.status,
          ageMillis: Math.max(0, snapshot.observedAtMs - item.createdAt),
          timeToExpiryMillis: Math.max(0, item.expiresAt - snapshot.observedAtMs),
          timePosture: item.expiresAt < snapshot.observedAtMs ? 'expired' : 'fresh',
          evidenceCurrency: item.evidenceManifestId ? 'current' : 'missing',
          openRequirementIds: item.requirements
            .filter((requirement) => requirement.status !== 'satisfied')
            .map((requirement) => String(requirement.id)),
          isCrossTenant: (item.affectedTenantIds?.length ?? 0) > 1,
          conflicts: [],
          allowedActions: [],
          actionable: false,
          priority: decisions.length - index,
        })),
        generatedAt: snapshot.observedAtMs,
        freshness: 'current',
        partialCoverage: false,
        snapshotDigest: digest(snapshot.decisions),
      } as unknown as DecisionQueueDashboard;
    },
    otherViews: (view, tenantId): ForeignDashboardView | undefined => {
      const snapshot = snapshotFor(String(tenantId));
      if (!snapshot) return undefined;
      const items =
        view === 'auditor'
          ? snapshot.evidence.map((item) => ({ ...item }))
          : [
              { domain: 'inventory', record_count: snapshot.assets.length },
              { domain: 'decisions', record_count: snapshot.decisions.length },
              { domain: 'integrity', record_count: snapshot.integrityCases.length },
              { domain: 'controllers', record_count: snapshot.controllerDefinitions.length },
              { domain: 'connectors', record_count: snapshot.connectors.length },
              { domain: 'runtime-components', record_count: snapshot.runtimeComponents.length },
            ];
      return {
        data: { items },
        metadata: currentMetadata(snapshot.observedAtMs, digest(items)),
      } as unknown as ForeignDashboardView;
    },
  });

  registerIntegrityCasesRoutes(app, {
    queue: (tenantId, filter): IntegrityQueueView | undefined => {
      const snapshot = snapshotFor(String(tenantId));
      if (!snapshot) return undefined;
      let items = snapshot.integrityCases.map(integrityView);
      if (filter.state) items = items.filter((item) => item.state === filter.state);
      if (filter.problemClass) {
        items = items.filter((item) => item.problemClass === filter.problemClass);
      }
      return {
        items,
        generatedAt: snapshot.observedAtMs,
        freshness: 'current',
        partialCoverage: false,
        snapshotDigest: digest(snapshot.integrityCases),
      } as unknown as IntegrityQueueView;
    },
    readCase: (tenantId, caseId) => {
      const row = snapshotFor(String(tenantId))?.integrityCases.find(
        (candidate) => text(candidate, 'id') === String(caseId),
      );
      return row ? integrityView(row) : undefined;
    },
  });

  registerControllersRoutes(app, {
    registry: (tenantId, filter) => {
      const snapshot = snapshotFor(String(tenantId));
      if (!snapshot) return undefined;
      let items = controllerViews(snapshot);
      if (filter.health) items = items.filter((item) => item.health === filter.health);
      if (filter.drifted !== undefined) {
        items = items.filter((item) => {
          const instance = snapshot.controllerInstances.find(
            (candidate) => text(candidate, 'controller_id') === String(item.id),
          );
          return booleanValue(instance ?? {}, 'has_drift') === filter.drifted;
        });
      }
      return {
        items,
        generatedAt: snapshot.observedAtMs,
        freshness: 'current',
        partialCoverage: false,
        snapshotDigest: digest(snapshot.controllerDefinitions),
      };
    },
    readOperation: (tenantId, controllerId, operationId) => {
      const row = snapshotFor(String(tenantId))?.controllerOperations.find(
        (candidate) =>
          text(candidate, 'controller_id') === String(controllerId) &&
          text(candidate, 'id') === String(operationId),
      );
      return row ? operationView(row) : undefined;
    },
    createOperation: async () => readonlyMutation(),
    applyAction: async () => readonlyMutation(),
  });

  registerComplianceRoutes(app, {
    coverage: (query): CoverageView | undefined => {
      const snapshot = snapshotFor(String(query.tenantId));
      if (!snapshot) return undefined;
      const controls = snapshot.controlMappings.map((mapping) => {
        const mappingId = text(mapping, 'id');
        const evaluation = snapshot.controlEvaluations.find(
          (candidate) => text(candidate, 'control_mapping_id') === mappingId,
        );
        return { ...mapping, ...(evaluation ? { evaluation: { ...evaluation } } : {}) };
      });
      return {
        tenantId: query.tenantId,
        scope: {
          ...(query.systemId ? { system_id: String(query.systemId) } : {}),
          ...(query.publicationId ? { publication_id: String(query.publicationId) } : {}),
        },
        publications: snapshot.publications.map((publication) => ({
          id: text(publication, 'id'),
          publisher: text(publication, 'publisher'),
          identifier: text(publication, 'identifier'),
          exactTitle: text(publication, 'exact_title'),
          edition: text(publication, 'edition'),
          publicationDate: text(publication, 'publication_date'),
          status: text(publication, 'status'),
          materialType: text(publication, 'material_type'),
          sourceUri: text(publication, 'source_uri'),
          registryVersion: numberValue(publication, 'registry_version', 1),
        })),
        obligations: snapshot.obligations.map((row) => ({ ...row })),
        controls,
        evidence: snapshot.evidence.map((row) => ({ ...row })),
        gaps: snapshot.coverageGaps.map((row) => ({ ...row })),
        claimBoundary:
          snapshot.obligations.length === 0 && controls.length === 0 ? 'incomplete' : 'ready',
        metadata: {
          generatedAt: snapshot.observedAtMs,
          sourceCursor: digest([
            snapshot.obligations,
            snapshot.controlMappings,
            snapshot.controlEvaluations,
          ]),
          freshness: 'current',
          partialCoverage: snapshot.coverageGaps.length > 0,
          coverageGaps: snapshot.coverageGaps.map((gap) => text(gap, 'id')),
        },
      } as unknown as CoverageView;
    },
    readEvidence: (tenantId, evidenceId) => {
      const row = snapshotFor(String(tenantId))?.evidence.find(
        (candidate) => text(candidate, 'evidence_item_id') === String(evidenceId),
      );
      return row ? { ...row } : undefined;
    },
    enqueueExport: async () => readonlyMutation(),
  });

  registerIntegrationRoutes(app, {
    registerAdapter: async () => readonlyMutation(),
    listConnectors: (query) => {
      const snapshot = snapshotFor(String(query.tenantId));
      if (!snapshot) throw new Error('connector snapshot unavailable');
      let connectors = connectorViews(snapshot);
      if (query.availabilityClass) {
        connectors = connectors.filter(
          (connector) => connector.availabilityClass === query.availabilityClass,
        );
      }
      if (query.lifecycleState) {
        connectors = connectors.filter(
          (connector) => connector.lifecycleState === query.lifecycleState,
        );
      }
      return { connectors, observedAt: snapshot.observedAtMs };
    },
    reconcile: async () => readonlyMutation(),
    platformHealth: (query): PlatformHealthView => {
      const snapshot = snapshotFor(String(query.tenantId));
      if (!snapshot) throw new Error('platform health snapshot unavailable');
      const connectors = connectorViews(snapshot);
      const runtimeHealths = snapshot.runtimeComponents
        .filter((component) => text(component, 'availability_class') === 'core')
        .map((component) => text(component, 'health', 'unknown'));
      const healths =
        runtimeHealths.length > 0
          ? runtimeHealths
          : connectors.map((connector) => connector.health);
      const aggregate = healths.includes('unavailable')
        ? 'unavailable'
        : healths.includes('degraded')
          ? 'degraded'
          : healths.length > 0 && healths.every((health) => health === 'healthy')
            ? 'healthy'
            : 'unknown';
      const openAlerts = connectors
        .flatMap((connector) => connector.alerts)
        .filter((alert) => alert.state !== 'recovered' && alert.state !== 'closed');
      return {
        aggregate,
        connectors,
        openAlerts,
        staleConnectorIds: connectors
          .filter((connector) => connector.freshness !== 'fresh')
          .map((connector) => connector.id),
        observedAt: snapshot.observedAtMs,
      } as unknown as PlatformHealthView;
    },
    readiness: (query): PlatformReadinessView => {
      const snapshot = snapshotFor(String(query.tenantId));
      if (!snapshot) throw new Error('platform readiness snapshot unavailable');
      const componentRows =
        snapshot.runtimeComponents.length > 0
          ? snapshot.runtimeComponents
          : snapshot.componentActivations;
      const components = componentRows.map((component) => {
        const runtimeState = text(component, 'runtime_state', 'unknown');
        const available = runtimeState === 'active' || runtimeState === 'ready';
        const health = text(component, 'health', available ? 'healthy' : 'unavailable');
        const freshness = text(component, 'freshness', 'unknown');
        const safeNextAction = optionalText(component, 'safe_next_action');
        return {
          componentKey: text(component, 'component_key'),
          availabilityClass: text(component, 'availability_class', 'optional'),
          runtimeState,
          health,
          freshness,
          ...(safeNextAction
            ? { safeNextAction }
            : health === 'healthy' && freshness === 'fresh'
              ? {}
              : { safeNextAction: 'Inspect the component activation and accountable owner.' }),
        };
      });
      const unavailableCoreComponents = components
        .filter(
          (component) =>
            component.availabilityClass === 'core' &&
            (component.health !== 'healthy' || component.freshness !== 'fresh'),
        )
        .map((component) => component.componentKey);
      return {
        ready: unavailableCoreComponents.length === 0,
        components,
        unavailableCoreComponents,
        observedAt: snapshot.observedAtMs,
      } as unknown as PlatformReadinessView;
    },
  });

  registerOperationsCommandCenterRoutes(
    app,
    createRuntimeOperationsCommandCenter({
      snapshotFor,
      now,
      ...(operationsRepository ? { repository: operationsRepository } : {}),
    }),
  );
}

interface RouteEnvelopeConfig {
  readonly domain: string;
  readonly source: string;
}

const UI_ROUTE_ENVELOPES = new Map<string, RouteEnvelopeConfig>([
  [
    '/v1/dashboards/governance-officer',
    { domain: 'posture', source: 'postgresql-read-model:governance-posture' },
  ],
  ['/v1/inventory/assets', { domain: 'inventory', source: 'postgresql-read-model:governed_asset' }],
  [
    '/v1/inventory/sources',
    { domain: 'gaps', source: 'postgresql-read-model:source_catalog_entry' },
  ],
  ['/v1/decisions', { domain: 'decisions', source: 'postgresql-read-model:decision_request' }],
  ['/v1/integrity-cases', { domain: 'integrity', source: 'postgresql-read-model:integrity_case' }],
  [
    '/v1/controllers',
    { domain: 'controllers', source: 'postgresql-read-model:controller_definition' },
  ],
  [
    '/v1/compliance/coverage',
    { domain: 'compliance', source: 'postgresql-read-model:compliance_coverage' },
  ],
  ['/v1/dashboards/auditor', { domain: 'evidence', source: 'postgresql-read-model:evidence_item' }],
  [
    '/v1/connectors',
    { domain: 'integrations', source: 'postgresql-read-model:connector_instance' },
  ],
  [
    '/v1/platform/health',
    {
      domain: 'operations',
      source: 'runtime-reconciliation:component-profile+live-probes',
    },
  ],
]);

function recordsFromBody(path: string, body: Record<string, unknown>): readonly unknown[] {
  if (Array.isArray(body['items'])) return body['items'];
  if (Array.isArray(body['connectors'])) return body['connectors'];
  const data = body['data'];
  if (isRecord(data) && Array.isArray(data['items'])) return data['items'];
  if (path === '/v1/compliance/coverage') {
    const keys = ['publications', 'obligations', 'controls', 'evidence', 'gaps'] as const;
    return keys.flatMap((key) =>
      Array.isArray(body[key])
        ? body[key].map((record) =>
            isRecord(record) ? { record_type: key, ...record } : { record_type: key },
          )
        : [],
    );
  }
  return [];
}

function headerValue(req: RequestLike, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function unavailableEnvelope(
  config: RouteEnvelopeConfig,
  tenantId: string,
  nowMs: number,
  correlationId: string | undefined,
): Response {
  return new Response(
    JSON.stringify({
      apiVersion: API_VERSION,
      contractVersion: READ_CONTRACT_VERSION,
      tenantId,
      tenant_id: tenantId,
      domain: config.domain,
      records: [],
      source: config.source,
      observedAt: null,
      receivedAt: new Date(nowMs).toISOString(),
      freshnessObjectiveMs: FRESHNESS_OBJECTIVE_MS,
      quality: 'unavailable',
      partialFailures: ['postgresql_read_failed'],
      ...(correlationId ? { correlationId } : {}),
      safeNextAction: 'Inspect PostgreSQL availability and retry the tenant-scoped read.',
    }),
    { status: 503, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

async function envelopeResponse(input: {
  readonly response: Response;
  readonly path: string;
  readonly tenantId: string;
  readonly snapshot: RuntimeReadModelSnapshot;
  readonly degraded: boolean;
  readonly nowMs: number;
}): Promise<Response> {
  const config = UI_ROUTE_ENVELOPES.get(input.path);
  if (!config || input.response.status < 200 || input.response.status >= 300) return input.response;
  let body: unknown;
  try {
    body = await input.response.json();
  } catch {
    return unavailableEnvelope(config, input.tenantId, input.nowMs, undefined);
  }
  if (!isRecord(body)) return unavailableEnvelope(config, input.tenantId, input.nowMs, undefined);
  const bodyRecords = recordsFromBody(input.path, body);
  const records =
    input.path === '/v1/platform/health' && input.snapshot.runtimeComponents.length > 0
      ? input.snapshot.runtimeComponents
      : bodyRecords;
  const correlationId = input.response.headers.get('x-correlation-id') ?? undefined;
  const envelope = {
    ...body,
    apiVersion: API_VERSION,
    contractVersion: READ_CONTRACT_VERSION,
    tenantId: input.tenantId,
    tenant_id: input.tenantId,
    domain: config.domain,
    records,
    source: config.source,
    observedAt: new Date(input.snapshot.observedAtMs).toISOString(),
    receivedAt: new Date(input.nowMs).toISOString(),
    freshnessObjectiveMs: FRESHNESS_OBJECTIVE_MS,
    quality: !input.snapshot.tenantRegistered ? 'unknown' : input.degraded ? 'degraded' : 'current',
    partialFailures: !input.snapshot.tenantRegistered
      ? ['tenant_not_registered']
      : input.degraded
        ? ['postgresql_read_failed']
        : [],
    ...(correlationId ? { correlationId } : {}),
    ...(!input.snapshot.tenantRegistered
      ? {
          safeNextAction:
            'Register and reconcile this tenant before treating zero records as an authoritative empty state.',
        }
      : input.degraded
        ? { safeNextAction: 'Treat this as last-known state and restore PostgreSQL reads.' }
        : {}),
  };
  const headers = new Headers(input.response.headers);
  headers.delete('content-length');
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'private, no-store');
  return new Response(JSON.stringify(envelope), { status: input.response.status, headers });
}

export interface LocalPreviewIdentityOptions {
  readonly enabled: boolean;
  readonly tenantId: string;
  readonly principalId: string;
  readonly roles: readonly ContextRole[];
}

export interface ProductionApiRuntimeOptions {
  readonly repository: RuntimeReadModelRepository;
  readonly preview: LocalPreviewIdentityOptions;
  readonly readiness: ReadinessProvider;
  readonly operationsRepository?: OperationalCaseRepository;
  readonly now?: () => number;
}

export interface ProductionFetchOptions {
  readonly trustedPreviewTransport?: boolean;
}

export interface ProductionApiRuntime {
  readonly app: App;
  readonly shutdown: ReturnType<typeof createApp>['shutdown'];
  fetch(request: Request, options?: ProductionFetchOptions): Promise<Response>;
}

export function createProductionApiRuntime(
  options: ProductionApiRuntimeOptions,
): ProductionApiRuntime {
  const now = options.now ?? Date.now;
  const marker = randomUUID();
  const verifyIdentity = (req: RequestLike): VerifiedIdentity | null => {
    if (!options.preview.enabled) return null;
    if (headerValue(req, INTERNAL_PREVIEW_IDENTITY_HEADER) !== marker) return null;
    return {
      principalId: options.preview.principalId,
      tenantId: options.preview.tenantId,
      roles: options.preview.roles,
      isBrowserSession: false,
    };
  };
  const { app, shutdown } = createApp({ verifyIdentity, readiness: options.readiness, now });
  mountDomainRoutes(app, options.repository, now, options.operationsRepository);

  return {
    app,
    shutdown,
    async fetch(request, fetchOptions = {}) {
      const url = new URL(request.url);
      const path = url.pathname;
      const envelopeConfig = UI_ROUTE_ENVELOPES.get(path);
      const trustedRead =
        options.preview.enabled &&
        fetchOptions.trustedPreviewTransport === true &&
        request.method === 'GET';
      const headers = new Headers(request.headers);
      headers.delete(INTERNAL_PREVIEW_IDENTITY_HEADER);
      headers.delete('x-trustcircle-principal');
      headers.delete('x-trustcircle-tenant-id');
      headers.delete('x-trustcircle-roles');
      if (trustedRead) headers.set(INTERNAL_PREVIEW_IDENTITY_HEADER, marker);
      const sanitizedRequest = new Request(request, { headers });

      let snapshot = options.repository.snapshot(options.preview.tenantId);
      let degraded = false;
      if (trustedRead && envelopeConfig) {
        try {
          snapshot = await options.repository.refreshTenant(options.preview.tenantId);
        } catch {
          degraded = true;
          snapshot = options.repository.snapshot(options.preview.tenantId);
          if (!snapshot) {
            return unavailableEnvelope(
              envelopeConfig,
              options.preview.tenantId,
              now(),
              request.headers.get('x-correlation-id') ?? undefined,
            );
          }
        }
      }

      const response = await app.fetch(sanitizedRequest);
      if (!snapshot || !envelopeConfig || !trustedRead) return response;
      return envelopeResponse({
        response,
        path,
        tenantId: options.preview.tenantId,
        snapshot,
        degraded,
        nowMs: now(),
      });
    },
  };
}

export function healthyReadiness(nowMs: number): GovernancePictureInput {
  return { facets: [], freshnessObjectiveMs: Math.max(0, nowMs) };
}
