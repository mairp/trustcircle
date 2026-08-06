// Test fixtures — a deterministic, multi-scenario SOURCE-AND-WORKFLOW-HEALTH world for Phase 8 / User
// Story 6 (Maintain Source and Workflow Health). Seeds every integration shape the US6 tests, e2e
// scenarios, and signed evidence manifests consume: signed/versioned adapter manifests (the five named
// connectors), provisioned connector instances (credential-ref only, negotiated capability subsets),
// health telemetry (present / absent / stale), alert records, component activations (core vs optional),
// cursor batches, and return-to-service inputs.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FIXTURE EXISTS  (T269 — FR-029, FR-030, FR-036, FR-041, NFR-010, SC-014..016)
// ───────────────────────────────────────────────────────────────────────────────────────────
// The US6 tests + e2e scenarios drive the REAL application services (connector-service, alert-routing,
// readiness-service, return-to-service, source-ingestion, cursor-recovery, offline-dispatch), the REAL
// command-worker loops (connector-reconciler, dead-letter-handler, component-lifecycle, health-observer,
// retry-scheduler), the REAL adapter-sdk contract (validateManifest / negotiateContract /
// negotiateCapabilities / conformance), and the five REAL named adapters over a KNOWN, FIXED world, and
// assert genuine facts — never a mutation echo. This builder is that fixed world.
//
// LOAD-BEARING INVARIANTS THE WORLD ENCODES:
//   * CREDENTIALS ARE NEVER STORED — connectors carry only an opaque `credentialRef` handle.
//   * A CONNECTOR IS NEVER GRANTED GOVERNANCE AUTHORITY — every manifest's `authority.authoritative_fields`
//     never includes an approval, and `security` never carries a secret.
//   * CORE HEALTH IS INDEPENDENT OF OPTIONAL — the optional connectors are `intentionally_inactive`; the
//     core component stays healthy regardless.
//   * ABSENCE IS HONEST — a connector with NO telemetry reads `unknown`/`stale`, never inferred healthy.
//
// DETERMINISM. No wall clock (the fixed `NOW`), no I/O, no randomness. Ids come from readable slugs
// sha256'd into valid v7-shaped UUIDs, so the world is byte-identical every call.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  toUuid,
  type Uuid,
  type TenantId,
  type EpochMillis,
} from '@trustcircle/domain';

import {
  validateManifest,
  type AdapterManifest,
  type AdapterCapability,
} from '@trustcircle/adapter-sdk';

// ── Deterministic clock + identity ──────────────────────────────────────────────────────────────

/** The fixed observation instant every US6 scenario reads against. */
export const NOW: EpochMillis = 1_772_600_000_000 as EpochMillis;

export const ONE_SECOND = 1_000;
export const ONE_MINUTE = 60 * ONE_SECOND;
export const ONE_HOUR = 60 * ONE_MINUTE;
export const ONE_DAY = 24 * ONE_HOUR;

/** A deterministic, legible-in-source UUID derived from a readable slug (v7-shaped, valid). */
export function uuidFromSlug(slug: string): Uuid {
  const h = createHash('sha256').update(`integrations-fixture:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return toUuid(
    `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`,
  );
}

export function iso(ms: EpochMillis): string {
  return new Date(ms).toISOString();
}

/** A deterministic id factory that yields fresh v7 UUIDs derived from a slug prefix + counter. */
export function slugIdFactory(prefix: string): () => Uuid {
  let n = 0;
  return () => uuidFromSlug(`${prefix}:${n++}`);
}

// ── Stable principals + tenant ───────────────────────────────────────────────────────────────────

export const TENANT: TenantId = uuidFromSlug('tenant-home-integrations') as unknown as TenantId;
export const OTHER_TENANT: TenantId = uuidFromSlug('tenant-other-integrations') as unknown as TenantId;

export const PLATFORM_OWNER: Uuid = uuidFromSlug('principal-platform-owner');
export const SOURCE_STEWARD: Uuid = uuidFromSlug('principal-source-steward');
export const WORKFLOW_OWNER: Uuid = uuidFromSlug('principal-workflow-owner');
export const AGENT_OPERATOR: Uuid = uuidFromSlug('principal-agent-operator');

// ── The five signed, versioned adapter manifests (loaded from the shipped adapters) ────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

function loadManifest(adapterDir: string): AdapterManifest {
  const path = resolve(REPO_ROOT, 'adapters', adapterDir, 'manifest.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  const result = validateManifest(raw);
  if (!result.valid) {
    throw new Error(
      `fixture: adapters/${adapterDir}/manifest.json is invalid: ${result.issues
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return raw as AdapterManifest;
}

export const KANBAN_MANIFEST: AdapterManifest = loadManifest('kanban');
export const WORKFLOW_MANIFEST: AdapterManifest = loadManifest('workflow-orchestration');
export const AGENTCTL_MANIFEST: AdapterManifest = loadManifest('agentctl');
export const LISA_MANIFEST: AdapterManifest = loadManifest('lisa');
export const WIGGUM_MANIFEST: AdapterManifest = loadManifest('wiggum');

/** The five named adapter manifests, keyed by adapter_id — the contract-test / scenario input set. */
export const NAMED_MANIFESTS: Readonly<Record<string, AdapterManifest>> = Object.freeze({
  kanban: KANBAN_MANIFEST,
  'workflow-orchestration': WORKFLOW_MANIFEST,
  agentctl: AGENTCTL_MANIFEST,
  lisa: LISA_MANIFEST,
  wiggum: WIGGUM_MANIFEST,
});

// ── Stable definition + version ids per adapter (deterministic, readable) ──────────────────────────

export interface AdapterIds {
  readonly definitionId: Uuid;
  readonly versionId: Uuid;
}

function idsFor(adapterId: string): AdapterIds {
  return Object.freeze({
    definitionId: uuidFromSlug(`adapter-def:${adapterId}`),
    versionId: uuidFromSlug(`adapter-ver:${adapterId}:1`),
  });
}

export const KANBAN_IDS = idsFor('kanban');
export const WORKFLOW_IDS = idsFor('workflow-orchestration');
export const AGENTCTL_IDS = idsFor('agentctl');
export const LISA_IDS = idsFor('lisa');
export const WIGGUM_IDS = idsFor('wiggum');

// ── Connector provisioning specs (fed to the REAL provisionConnector) ──────────────────────────────
//
// Each spec is a plain, serialisable description of a connector-to-be. The tests call the real
// `provisionConnector` over these — the fixture never re-implements the service. Availability class
// distinguishes CORE (the always-on control plane) from OPTIONAL (the intentionally-inactive
// connectors) so the readiness service can prove core health is independent of optional presence.

export type AvailabilityClass = 'core' | 'optional' | 'on-demand';

export interface ConnectorSpec {
  readonly slug: string;
  readonly adapterId: string;
  readonly ids: AdapterIds;
  readonly manifest: AdapterManifest;
  readonly sourceRef: string;
  readonly requestedCapabilities: readonly AdapterCapability[];
  readonly availabilityClass: AvailabilityClass;
  readonly credentialRef: string;
  readonly ownerPrincipalId: Uuid;
  readonly scopes: readonly string[];
}

/** The requested capability set for each connector — always a SUBSET of the manifest's declared set. */
function declaredSubset(manifest: AdapterManifest, want: readonly AdapterCapability[]): readonly AdapterCapability[] {
  return Object.freeze(want.filter((c) => manifest.capabilities.includes(c)));
}

export const KANBAN_CONNECTOR: ConnectorSpec = Object.freeze({
  slug: 'kanban-board-eng',
  adapterId: 'kanban',
  ids: KANBAN_IDS,
  manifest: KANBAN_MANIFEST,
  sourceRef: 'kanban://board/engineering',
  requestedCapabilities: declaredSubset(KANBAN_MANIFEST, ['discover', 'inspect', 'snapshot', 'reconcile', 'collect_evidence']),
  availabilityClass: 'optional',
  credentialRef: 'secret-ref://kanban/engineering',
  ownerPrincipalId: SOURCE_STEWARD,
  scopes: Object.freeze(['read:board:engineering']),
});

export const WORKFLOW_CONNECTOR: ConnectorSpec = Object.freeze({
  slug: 'workflow-orch-prod',
  adapterId: 'workflow-orchestration',
  ids: WORKFLOW_IDS,
  manifest: WORKFLOW_MANIFEST,
  sourceRef: 'workflow://orchestrator/prod',
  requestedCapabilities: declaredSubset(WORKFLOW_MANIFEST, ['discover', 'inspect', 'snapshot', 'subscribe', 'reconcile', 'collect_evidence']),
  availabilityClass: 'optional',
  credentialRef: 'secret-ref://workflow/prod',
  ownerPrincipalId: WORKFLOW_OWNER,
  scopes: Object.freeze(['read:workflows:prod']),
});

export const AGENTCTL_CONNECTOR: ConnectorSpec = Object.freeze({
  slug: 'agentctl-fleet',
  adapterId: 'agentctl',
  ids: AGENTCTL_IDS,
  manifest: AGENTCTL_MANIFEST,
  sourceRef: 'agentctl://fleet/default',
  requestedCapabilities: declaredSubset(AGENTCTL_MANIFEST, ['discover', 'inspect', 'snapshot', 'execute', 'reconcile', 'collect_evidence']),
  availabilityClass: 'on-demand',
  credentialRef: 'secret-ref://agentctl/fleet',
  ownerPrincipalId: AGENT_OPERATOR,
  scopes: Object.freeze(['read:agents', 'dispatch:agents']),
});

export const LISA_CONNECTOR: ConnectorSpec = Object.freeze({
  slug: 'lisa-deployment',
  adapterId: 'lisa',
  ids: LISA_IDS,
  manifest: LISA_MANIFEST,
  sourceRef: 'lisa://deployment/governance',
  requestedCapabilities: declaredSubset(LISA_MANIFEST, ['discover', 'inspect', 'snapshot', 'subscribe', 'collect_evidence']),
  availabilityClass: 'optional',
  credentialRef: 'secret-ref://lisa/governance',
  ownerPrincipalId: PLATFORM_OWNER,
  scopes: Object.freeze(['read:lisa:evidence']),
});

export const WIGGUM_CONNECTOR: ConnectorSpec = Object.freeze({
  slug: 'wiggum-bundle',
  adapterId: 'wiggum',
  ids: WIGGUM_IDS,
  manifest: WIGGUM_MANIFEST,
  sourceRef: 'wiggum://bundle/verification',
  requestedCapabilities: declaredSubset(WIGGUM_MANIFEST, ['discover', 'inspect', 'snapshot', 'collect_evidence']),
  availabilityClass: 'optional',
  credentialRef: 'secret-ref://wiggum/verification',
  ownerPrincipalId: PLATFORM_OWNER,
  scopes: Object.freeze(['read:wiggum:evidence']),
});

export const CONNECTOR_SPECS: readonly ConnectorSpec[] = Object.freeze([
  KANBAN_CONNECTOR,
  WORKFLOW_CONNECTOR,
  AGENTCTL_CONNECTOR,
  LISA_CONNECTOR,
  WIGGUM_CONNECTOR,
]);

// ── The CORE control-plane component (always-on; independent of every optional connector) ──────────

export const CORE_COMPONENT = Object.freeze({
  componentId: uuidFromSlug('component-core-control-plane'),
  name: 'governance-control-plane',
  availabilityClass: 'core' as const,
  ownerPrincipalId: PLATFORM_OWNER,
});

// ── Health telemetry scenarios (present / absent / stale) — for the health-observer ────────────────
//
// The freshness window is read from each manifest (`health.freshness_seconds`). These three telemetry
// shapes drive the three honest verdicts:
//   * FRESH   — a recent successful observation → ready/live/fresh.
//   * ABSENT  — no telemetry at all → unknown/stale, inferredFromAbsence:true (SC-014).
//   * STALE   — telemetry older than the freshness window → stale, current health NEVER inferred.

export interface HealthTelemetryFixture {
  readonly kind: 'fresh' | 'absent' | 'stale';
  readonly lastSuccessfulAt: EpochMillis | undefined;
  readonly freshnessSeconds: number;
}

export function telemetryFor(manifest: AdapterManifest, kind: 'fresh' | 'absent' | 'stale'): HealthTelemetryFixture {
  const freshnessSeconds = manifest.health.freshness_seconds;
  const windowMs = freshnessSeconds * ONE_SECOND;
  if (kind === 'absent') {
    return Object.freeze({ kind, lastSuccessfulAt: undefined, freshnessSeconds });
  }
  if (kind === 'stale') {
    return Object.freeze({ kind, lastSuccessfulAt: (NOW - windowMs - ONE_MINUTE) as EpochMillis, freshnessSeconds });
  }
  return Object.freeze({ kind, lastSuccessfulAt: (NOW - Math.floor(windowMs / 4)) as EpochMillis, freshnessSeconds });
}

// ── Cursor batch scenarios (for cursor-recovery) ───────────────────────────────────────────────────
//
// A prior cursor + a batch that exhibits each recoverable anomaly class. The tests drive the REAL
// `detect(prior, batch)` over these and assert the classified findings.

export interface BatchEventFixture {
  readonly aggregateRef: string;
  readonly sequence: number;
  readonly dedupKey: string;
  readonly observedAt: EpochMillis;
  readonly mappingVersion?: string;
  readonly sourceIdentity?: string;
}

export const PRIOR_CURSOR = Object.freeze({
  position: 'seq-0100',
  sequence: 100,
  lastObservedAt: (NOW - ONE_HOUR) as EpochMillis,
  mappingVersion: 'map-v1',
  sourceIdentity: 'source-identity-A',
});

/** An in-order, contiguous, healthy batch (no findings). */
export const HEALTHY_BATCH: readonly BatchEventFixture[] = Object.freeze([
  { aggregateRef: 'agg-1', sequence: 101, dedupKey: 'k-101', observedAt: (NOW - 40 * ONE_MINUTE) as EpochMillis, mappingVersion: 'map-v1', sourceIdentity: 'source-identity-A' },
  { aggregateRef: 'agg-1', sequence: 102, dedupKey: 'k-102', observedAt: (NOW - 30 * ONE_MINUTE) as EpochMillis, mappingVersion: 'map-v1', sourceIdentity: 'source-identity-A' },
  { aggregateRef: 'agg-1', sequence: 103, dedupKey: 'k-103', observedAt: (NOW - 20 * ONE_MINUTE) as EpochMillis, mappingVersion: 'map-v1', sourceIdentity: 'source-identity-A' },
]);

/** A batch with a gap (missing 102), a duplicate (105 twice), an out-of-order pair, a mapping change,
 * and a source-identity change — the full recoverable-anomaly surface. */
export const ANOMALOUS_BATCH: readonly BatchEventFixture[] = Object.freeze([
  { aggregateRef: 'agg-1', sequence: 101, dedupKey: 'k-101', observedAt: (NOW - 40 * ONE_MINUTE) as EpochMillis, mappingVersion: 'map-v2', sourceIdentity: 'source-identity-B' },
  // gap: 102 missing
  { aggregateRef: 'agg-1', sequence: 103, dedupKey: 'k-103', observedAt: (NOW - 30 * ONE_MINUTE) as EpochMillis, mappingVersion: 'map-v2', sourceIdentity: 'source-identity-B' },
  { aggregateRef: 'agg-1', sequence: 105, dedupKey: 'k-105', observedAt: (NOW - 10 * ONE_MINUTE) as EpochMillis, mappingVersion: 'map-v2', sourceIdentity: 'source-identity-B' },
  // out-of-order: 104 arrives after 105
  { aggregateRef: 'agg-1', sequence: 104, dedupKey: 'k-104', observedAt: (NOW - 20 * ONE_MINUTE) as EpochMillis, mappingVersion: 'map-v2', sourceIdentity: 'source-identity-B' },
  // duplicate: 105 again, same dedup key
  { aggregateRef: 'agg-1', sequence: 105, dedupKey: 'k-105', observedAt: (NOW - 10 * ONE_MINUTE) as EpochMillis, mappingVersion: 'map-v2', sourceIdentity: 'source-identity-B' },
]);

// ── Return-to-service checklist inputs ─────────────────────────────────────────────────────────────
//
// A fully-passing input (readyToResume=true) and a per-check failing variant builder, so the
// return-to-service test can prove that a single unproven prerequisite blocks resume.

export const RETURN_TO_SERVICE_PASSING = Object.freeze({
  identityVerified: true,
  contractsVerified: true,
  credentialsVerified: true,
  authorityVerified: true,
  versionsVerified: true,
  snapshotsVerified: true,
  backlogVerified: true,
  evidenceVerified: true,
});

// ── Alert scenarios (for alert-routing) ────────────────────────────────────────────────────────────
//
// A raised alert per class that a threshold breach maps to, each with a declared owner. The tests
// drive the REAL raiseAlert / notifyOwner / acknowledgeAlert / recoverAlert over these.

export interface AlertScenarioFixture {
  readonly alertClass: 'health' | 'freshness' | 'reconciliation' | 'evidence' | 'contract' | 'control_effectiveness';
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly subjectRef: string;
  readonly ownerPrincipalId: Uuid;
  readonly reason: string;
}

export const ALERT_SCENARIOS: readonly AlertScenarioFixture[] = Object.freeze([
  { alertClass: 'health', severity: 'high', subjectRef: LISA_CONNECTOR.sourceRef, ownerPrincipalId: PLATFORM_OWNER, reason: 'connector reported unhealthy for 3 consecutive observations' },
  { alertClass: 'freshness', severity: 'medium', subjectRef: KANBAN_CONNECTOR.sourceRef, ownerPrincipalId: SOURCE_STEWARD, reason: 'observation freshness exceeded the manifest window' },
  { alertClass: 'reconciliation', severity: 'high', subjectRef: WORKFLOW_CONNECTOR.sourceRef, ownerPrincipalId: WORKFLOW_OWNER, reason: 'reconciliation found unresolved drift' },
  { alertClass: 'evidence', severity: 'medium', subjectRef: WIGGUM_CONNECTOR.sourceRef, ownerPrincipalId: PLATFORM_OWNER, reason: 'evidence collection gap detected' },
  { alertClass: 'contract', severity: 'critical', subjectRef: AGENTCTL_CONNECTOR.sourceRef, ownerPrincipalId: AGENT_OPERATOR, reason: 'adapter reported a drifted contract version' },
  { alertClass: 'control_effectiveness', severity: 'high', subjectRef: CORE_COMPONENT.name, ownerPrincipalId: PLATFORM_OWNER, reason: 'control effectiveness below objective' },
]);

// ── A stable digest over the whole seeded world (a smoke witness the fixture itself is deterministic) ─

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function integrationsWorldDigest(): string {
  return `sha256:${createHash('sha256')
    .update(
      canonical({
        now: NOW,
        tenant: TENANT,
        manifests: Object.fromEntries(Object.entries(NAMED_MANIFESTS).map(([k, m]) => [k, m.adapter_version])),
        connectors: CONNECTOR_SPECS.map((s) => ({ slug: s.slug, adapter: s.adapterId, availability: s.availabilityClass })),
        alerts: ALERT_SCENARIOS.map((a) => a.alertClass),
      }),
    )
    .digest('hex')}`;
}
