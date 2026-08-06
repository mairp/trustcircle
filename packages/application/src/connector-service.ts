// @trustcircle/application — CONNECTOR SERVICE: the tenant-scoped live connection an adapter version
// holds against a specific external source (Phase 8 / User Story 6 / T231 / FR-029, FR-036, FR-041,
// NFR-010).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// A connector instance is a TENANT-SCOPED binding of (definitionId, adapter version, sourceRef). It is
// aligned column-for-column with migration 0060 `connector_instance`. Its load-bearing invariants:
//   * CREDENTIALS ARE NEVER STORED. Only an opaque `credentialRef` handle into the secret store is
//     retained — never a secret, never a token. There is no field on this aggregate that can hold one.
//   * ENABLED CAPABILITIES ARE A SUBSET of what the bound adapter version's manifest DECLARES. The
//     subset is negotiated through @trustcircle/adapter-sdk `negotiateCapabilities`: requesting a
//     capability the manifest does not declare is REFUSED (never silently granted — least privilege).
//   * THE LIFECYCLE IS A GUARDED STATE MACHINE over the migration's `connector_lifecycle_valid` vocab
//     (inactive→activating→active→maintenance→degraded→suspended→failed→returning→retired). An illegal
//     jump is refused; a `nextPermittedActions(connector)` helper surfaces the exact allowed moves.
//   * AVAILABILITY CLASS ∈ core|optional|on-demand (migration `connector_availability_valid`).
//   * THE CURSOR + cursor sequence are advanced monotonically — a durable ingestion cursor never moves
//     backwards (a rewind is a distinct, deliberate act, not an accidental write).
//
// Pure, dependency-free (Node built-in `node:crypto` only): no wall-clock reads (every mutating call
// takes an explicit `at: EpochMillis` and an injected `newId`), no I/O, no Math.random. Every mutation
// returns the durable value written AND leaves it independently readable through the query surface;
// the mutation response is never the proof — the re-readable state + its content digest are.

import { createHash } from 'node:crypto';

import {
  isUuid,
  isUuidV7,
  type Uuid,
  type TenantId,
  PLATFORM_SCOPE,
  type EpochMillis,
} from '@trustcircle/domain';
import {
  negotiateCapabilities,
  type AdapterManifest,
  type AdapterCapability,
} from '@trustcircle/adapter-sdk';

// ===========================================================================
// 0. Shared guards + hashing (fail-visible).
// ===========================================================================

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}
function assertUuidV7(id: unknown, label: string): asserts id is Uuid {
  if (!isUuidV7(id)) throw new TypeError(`${label} must be a stable UUIDv7 identifier`);
}
function assertTenant(t: unknown, label: string): asserts t is TenantId {
  if (t !== PLATFORM_SCOPE && !isUuid(t)) {
    throw new TypeError(`${label} must be a tenant UUID or the platform scope`);
  }
}
function assertEpoch(ms: unknown, label: string): asserts ms is EpochMillis {
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) {
    throw new RangeError(`${label} must be a non-negative integer epoch-ms, got ${String(ms)}`);
  }
}
function assertNonEmpty(s: unknown, label: string): asserts s is string {
  if (typeof s !== 'string' || s.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}
function sha256(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Injected identity factory: the caller supplies fresh UUIDv7s so the service never generates
 * identity from the wall clock (deterministic + reproducible in tests). Named distinctly from the
 * source-registry `IdFactory` so the package boundary re-export stays unambiguous. */
export type ConnectorIdFactory = () => Uuid;

// ===========================================================================
// 1. Availability class + connector lifecycle vocabulary (mirror migration 0060).
// ===========================================================================

/** Availability class (migration `connector_availability_valid`). */
export const CONNECTOR_AVAILABILITY_CLASSES = ['core', 'optional', 'on-demand'] as const;
export type ConnectorAvailabilityClass = (typeof CONNECTOR_AVAILABILITY_CLASSES)[number];

export function isConnectorAvailabilityClass(s: unknown): s is ConnectorAvailabilityClass {
  return typeof s === 'string' && (CONNECTOR_AVAILABILITY_CLASSES as readonly string[]).includes(s);
}

/** Connector lifecycle vocabulary (migration `connector_lifecycle_valid`). */
export const CONNECTOR_LIFECYCLE_STATES = [
  'inactive',
  'activating',
  'active',
  'maintenance',
  'degraded',
  'suspended',
  'failed',
  'returning',
  'retired',
] as const;
export type ConnectorLifecycleState = (typeof CONNECTOR_LIFECYCLE_STATES)[number];

export function isConnectorLifecycleState(s: unknown): s is ConnectorLifecycleState {
  return typeof s === 'string' && (CONNECTOR_LIFECYCLE_STATES as readonly string[]).includes(s);
}

/**
 * The permitted lifecycle transitions. A connector begins `inactive`; it is `activating` while its
 * activation path runs; `active` when serving; may enter `maintenance` or `degraded` and recover;
 * `suspended` on owner action; `failed` on a terminal fault; `returning` while it revalidates before
 * resuming (return-to-service); and `retired` terminally. A `returning` connector may only reach
 * `active` (a proven resume) or fall back to `failed`/`suspended` — it never skips revalidation.
 */
const CONNECTOR_TRANSITIONS: Readonly<
  Record<ConnectorLifecycleState, readonly ConnectorLifecycleState[]>
> = {
  inactive: ['activating', 'retired'],
  activating: ['active', 'failed', 'inactive'],
  active: ['maintenance', 'degraded', 'suspended', 'failed', 'retired'],
  maintenance: ['active', 'suspended', 'failed', 'retired'],
  degraded: ['active', 'maintenance', 'suspended', 'failed', 'retired'],
  suspended: ['returning', 'retired'],
  failed: ['returning', 'suspended', 'retired'],
  returning: ['active', 'failed', 'suspended'],
  retired: [],
};

/** True iff `to` is a permitted connector-lifecycle transition from `from`. */
export function canConnectorTransition(
  from: ConnectorLifecycleState,
  to: ConnectorLifecycleState,
): boolean {
  return isConnectorLifecycleState(from) && isConnectorLifecycleState(to)
    ? CONNECTOR_TRANSITIONS[from].includes(to)
    : false;
}

export function assertConnectorTransition(
  from: ConnectorLifecycleState,
  to: ConnectorLifecycleState,
): void {
  if (!canConnectorTransition(from, to)) {
    throw new RangeError(`illegal connector-lifecycle transition: ${from} → ${to}`);
  }
}

/** The exact next lifecycle moves permitted from a connector's current state (drives a UI / API). */
export function nextPermittedActions(connector: Connector): readonly ConnectorLifecycleState[] {
  return Object.freeze([...CONNECTOR_TRANSITIONS[connector.lifecycleState]]);
}

// ===========================================================================
// 2. The durable connector value (mirror migration 0060 `connector_instance`).
// ===========================================================================

/** A durable ingestion cursor. Opaque JSON position + a monotonically-advanced sequence number. */
export interface ConnectorCursor {
  /** The opaque source position (never interpreted here; a value the adapter understands). */
  readonly position: string;
  /** The aggregate sequence high-water mark; advances monotonically (see {@link advanceCursor}). */
  readonly sequence: number;
}

/** A live tenant/source connection using a specific adapter version. */
export interface Connector {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly definitionId: Uuid;
  readonly versionId: Uuid;
  /** The external source identity this connector observes (migration `source_ref`). */
  readonly sourceRef: string;
  /** An opaque handle into the secret store — NEVER a secret (migration `credential_ref`). */
  readonly credentialRef?: string;
  /** The enabled capability SUBSET (⊆ the bound version's declared capabilities). */
  readonly enabledCapabilities: readonly AdapterCapability[];
  readonly scopes: readonly string[];
  /** The last durable ingestion cursor (undefined = never ingested). */
  readonly cursor?: ConnectorCursor;
  readonly availabilityClass: ConnectorAvailabilityClass;
  readonly lifecycleState: ConnectorLifecycleState;
  readonly ownerPrincipalId: Uuid;
  readonly createdAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

// ===========================================================================
// 3. Provisioning + mutation inputs.
// ===========================================================================

export interface ProvisionConnectorInput {
  readonly tenantId: TenantId;
  readonly definitionId: Uuid;
  readonly versionId: Uuid;
  readonly sourceRef: string;
  readonly ownerPrincipalId: Uuid;
  /** The bound adapter version's manifest — the SOURCE OF TRUTH for the declared capability set. */
  readonly manifest: AdapterManifest;
  /** The capabilities the tenant requests be enabled (must be a subset of the manifest's). */
  readonly requestedCapabilities: readonly AdapterCapability[];
  readonly scopes?: readonly string[];
  /** An opaque secret-store handle (never a secret). */
  readonly credentialRef?: string;
  readonly availabilityClass?: ConnectorAvailabilityClass;
  readonly newId: ConnectorIdFactory;
  readonly at: EpochMillis;
}

/**
 * Provision a connector value in `inactive`, negotiating the enabled capability SUBSET against the
 * bound version's manifest. Requesting an undeclared capability is REFUSED (least privilege). Pure.
 */
export function provisionConnector(input: ProvisionConnectorInput): Connector {
  assertTenant(input.tenantId, 'provision.tenantId');
  if (input.tenantId === PLATFORM_SCOPE) {
    throw new TypeError(
      'a connector instance is tenant-scoped and cannot bind to the platform scope',
    );
  }
  assertUuid(input.definitionId, 'provision.definitionId');
  assertUuid(input.versionId, 'provision.versionId');
  assertUuid(input.ownerPrincipalId, 'provision.ownerPrincipalId');
  assertNonEmpty(input.sourceRef, 'provision.sourceRef');
  assertEpoch(input.at, 'provision.at');
  if (input.credentialRef !== undefined)
    assertNonEmpty(input.credentialRef, 'provision.credentialRef');

  const availabilityClass = input.availabilityClass ?? 'optional';
  if (!isConnectorAvailabilityClass(availabilityClass)) {
    throw new TypeError(
      `provision.availabilityClass must be one of ${CONNECTOR_AVAILABILITY_CLASSES.join('|')}`,
    );
  }

  // ENABLED CAPABILITIES ⊆ DECLARED. An undeclared request is refused (never silently granted).
  const negotiated = negotiateCapabilities(input.manifest, input.requestedCapabilities);
  if (!negotiated.ok) {
    throw new RangeError(
      `provision: requested capabilities are not declared by the bound version manifest: ${negotiated.offending.join(', ')} (least privilege — refused)`,
    );
  }

  const id = input.newId();
  assertUuidV7(id, 'provision.id');

  const connector: Connector = Object.freeze({
    id,
    tenantId: input.tenantId,
    definitionId: input.definitionId,
    versionId: input.versionId,
    sourceRef: input.sourceRef,
    ...(input.credentialRef !== undefined ? { credentialRef: input.credentialRef } : {}),
    enabledCapabilities: negotiated.enabled,
    scopes: Object.freeze([...(input.scopes ?? [])]),
    availabilityClass,
    lifecycleState: 'inactive',
    ownerPrincipalId: input.ownerPrincipalId,
    createdAt: input.at,
    updatedAt: input.at,
  });
  return connector;
}

/** Re-negotiate the enabled capability subset against the (possibly newer) manifest. Pure. */
export function setEnabledCapabilities(
  connector: Connector,
  manifest: AdapterManifest,
  requested: readonly AdapterCapability[],
  at: EpochMillis,
): Connector {
  assertEpoch(at, 'setEnabledCapabilities.at');
  const negotiated = negotiateCapabilities(manifest, requested);
  if (!negotiated.ok) {
    throw new RangeError(
      `setEnabledCapabilities: undeclared capabilities refused: ${negotiated.offending.join(', ')}`,
    );
  }
  return Object.freeze({ ...connector, enabledCapabilities: negotiated.enabled, updatedAt: at });
}

/** Attach/replace the opaque credential reference. Refuses anything empty; NEVER holds a secret. */
export function setCredentialRef(
  connector: Connector,
  credentialRef: string,
  at: EpochMillis,
): Connector {
  assertNonEmpty(credentialRef, 'setCredentialRef.credentialRef');
  assertEpoch(at, 'setCredentialRef.at');
  return Object.freeze({ ...connector, credentialRef, updatedAt: at });
}

/**
 * Advance the durable ingestion cursor. The sequence high-water mark is MONOTONIC — an advance to a
 * lower-or-equal sequence is refused (a rewind is a distinct deliberate act, not an accidental write).
 */
export function advanceCursor(
  connector: Connector,
  next: ConnectorCursor,
  at: EpochMillis,
): Connector {
  assertNonEmpty(next.position, 'advanceCursor.position');
  assertEpoch(at, 'advanceCursor.at');
  if (typeof next.sequence !== 'number' || !Number.isInteger(next.sequence) || next.sequence < 0) {
    throw new RangeError('advanceCursor.sequence must be a non-negative integer');
  }
  const priorSeq = connector.cursor?.sequence ?? -1;
  if (next.sequence <= priorSeq) {
    throw new RangeError(
      `advanceCursor: cursor sequence must advance monotonically (${priorSeq} → ${next.sequence} refused)`,
    );
  }
  return Object.freeze({
    ...connector,
    cursor: Object.freeze({ position: next.position, sequence: next.sequence }),
    updatedAt: at,
  });
}

/** Apply a guarded lifecycle transition. Pure — returns the new value; never mutates its input. */
export function transitionConnector(
  connector: Connector,
  to: ConnectorLifecycleState,
  at: EpochMillis,
): Connector {
  assertEpoch(at, 'transitionConnector.at');
  assertConnectorTransition(connector.lifecycleState, to);
  return Object.freeze({ ...connector, lifecycleState: to, updatedAt: at });
}

/** The content digest of a single connector value (its independently-observable witness). */
export function connectorDigest(connector: Connector): string {
  return sha256(
    canonicalJson({
      id: connector.id,
      tenant: connector.tenantId,
      def: connector.definitionId,
      ver: connector.versionId,
      source: connector.sourceRef,
      credentialRef: connector.credentialRef ?? null,
      caps: [...connector.enabledCapabilities].sort(),
      scopes: [...connector.scopes].sort(),
      cursor: connector.cursor ?? null,
      availability: connector.availabilityClass,
      lifecycle: connector.lifecycleState,
      owner: connector.ownerPrincipalId,
      updatedAt: connector.updatedAt,
    }),
  );
}

// ===========================================================================
// 4. In-memory registry aggregate, keyed by (tenantId, definitionId, sourceRef).
// ===========================================================================

/**
 * In-memory connector registry. Keyed by (tenantId, definitionId, sourceRef) — mirroring the
 * migration's UNIQUE (tenant_id, definition_id, source_ref). Provisioning a duplicate key is refused;
 * a mutation re-reads the durable value and its content digest, never trusting a return alone.
 */
export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  private key(tenantId: TenantId, definitionId: Uuid, sourceRef: string): string {
    return `${tenantId} ${definitionId} ${sourceRef}`;
  }

  /** Provision a connector; refuses a duplicate (tenantId, definitionId, sourceRef). */
  provision(input: ProvisionConnectorInput): Connector {
    const connector = provisionConnector(input);
    const k = this.key(connector.tenantId, connector.definitionId, connector.sourceRef);
    if (this.connectors.has(k)) {
      throw new RangeError(
        `connector conflict: (${connector.tenantId}, ${connector.definitionId}, ${connector.sourceRef}) already provisioned`,
      );
    }
    this.connectors.set(k, connector);
    return connector;
  }

  /** Replace a stored connector value (after a pure mutation). Refuses an unknown connector. */
  private store(connector: Connector): Connector {
    const k = this.key(connector.tenantId, connector.definitionId, connector.sourceRef);
    if (!this.connectors.has(k)) throw new RangeError(`unknown connector: ${connector.id}`);
    this.connectors.set(k, connector);
    return connector;
  }

  transition(connector: Connector, to: ConnectorLifecycleState, at: EpochMillis): Connector {
    return this.store(transitionConnector(connector, to, at));
  }

  advanceCursor(connector: Connector, next: ConnectorCursor, at: EpochMillis): Connector {
    return this.store(advanceCursor(connector, next, at));
  }

  setEnabledCapabilities(
    connector: Connector,
    manifest: AdapterManifest,
    requested: readonly AdapterCapability[],
    at: EpochMillis,
  ): Connector {
    return this.store(setEnabledCapabilities(connector, manifest, requested, at));
  }

  setCredentialRef(connector: Connector, credentialRef: string, at: EpochMillis): Connector {
    return this.store(setCredentialRef(connector, credentialRef, at));
  }

  get(tenantId: TenantId, definitionId: Uuid, sourceRef: string): Connector | undefined {
    return this.connectors.get(this.key(tenantId, definitionId, sourceRef));
  }

  getById(connectorId: Uuid): Connector | undefined {
    for (const c of this.connectors.values()) if (c.id === connectorId) return c;
    return undefined;
  }

  /** All connectors, sorted by (tenantId, definitionId, sourceRef). */
  list(): readonly Connector[] {
    return Object.freeze(
      [...this.connectors.values()].sort((a, b) => {
        if (a.tenantId !== b.tenantId) return a.tenantId.localeCompare(b.tenantId);
        if (a.definitionId !== b.definitionId) return a.definitionId.localeCompare(b.definitionId);
        return a.sourceRef.localeCompare(b.sourceRef);
      }),
    );
  }

  /** A stable content digest over the whole registry — the durable-effect witness. */
  snapshotDigest(): string {
    const parts = this.list().map(connectorDigest);
    return sha256(JSON.stringify(parts.sort()));
  }
}
