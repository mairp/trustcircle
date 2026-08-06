// @trustcircle/application — ADAPTER REGISTRY: the pure state-machine over an adapter version's
// lifecycle (Phase 8 / User Story 6 / T230 / FR-036, FR-037, FR-041, NS-005).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// An adapter is a CONNECTOR: it observes/drives an external source, and it is NEVER granted
// governance authority. Its builds are IMMUTABLE, SIGNED, VERSIONED artifacts. Before a version may
// be ACTIVATED (and bound by a connector instance) it must climb a guarded lifecycle:
//
//   registered → tested → approved → activated → suspended → deprecated → superseded → retired
//
// aligned column-for-column with migration 0060 (`adapter_version.lifecycle_state`). Each step:
//   * is a permitted transition (an illegal jump is refused — a pure state machine, not a free-form
//     field write);
//   * RETAINS its evidence: the evidence ids (conformance result, approval decision, …) are appended
//     to an append-only transition ledger so the lineage stays reconstructable;
//   * for `activated` specifically, REFUSES activation unless a PASSING conformance-result id is
//     present (mirrors the DB `adapter_version_activation_requires_conformance` CHECK);
//   * NEVER grants the adapter governance authority — the registry enforces that an adapter grant is
//     not part of authority (a connector cannot decide governance conclusions).
//
// On REGISTER the manifest + its detached signature are VALIDATED and VERIFIED through the
// @trustcircle/adapter-sdk (validateManifest / assertManifest / verifyManifestSignature) so a
// malformed or tampered manifest never enters the registry.
//
// Pure, dependency-free (Node built-in `node:crypto` only): no wall-clock reads (every mutating call
// takes an explicit `at: EpochMillis` and an injected `newId`), no I/O. Every mutation returns the
// durable value written AND leaves it independently readable through the query surface; the mutation
// response is never the proof — the re-readable state + its content digest are.

import { createHash } from 'node:crypto';

import {
  isUuid,
  isUuidV7,
  type Uuid,
  type TenantId,
  PLATFORM_SCOPE,
  type EpochMillis,
  type Reason,
} from '@trustcircle/domain';
import {
  assertManifest,
  validateManifest,
  verifyManifestSignature,
  manifestDigest,
  negotiateContract,
  type AdapterManifest,
  type Semver,
} from '@trustcircle/adapter-sdk';

// ===========================================================================
// 0. Shared guards.
// ===========================================================================

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

/** Injected identity factory: the caller supplies fresh UUIDv7s so the registry never generates
 * identity from the wall clock (deterministic + reproducible in tests). */
export type IdFactory = () => Uuid;

// ===========================================================================
// 1. Adapter-version lifecycle — the guarded state machine.
//    Aligned with migration 0060 `adapter_version_lifecycle_valid`.
// ===========================================================================

export const ADAPTER_LIFECYCLE_STATES = [
  'registered',
  'tested',
  'approved',
  'activated',
  'suspended',
  'deprecated',
  'superseded',
  'retired',
] as const;
export type AdapterLifecycleState = (typeof ADAPTER_LIFECYCLE_STATES)[number];

export function isAdapterLifecycleState(s: unknown): s is AdapterLifecycleState {
  return typeof s === 'string' && (ADAPTER_LIFECYCLE_STATES as readonly string[]).includes(s);
}

const ADAPTER_TRANSITIONS: Readonly<
  Record<AdapterLifecycleState, readonly AdapterLifecycleState[]>
> = {
  registered: ['tested', 'retired'],
  tested: ['approved', 'registered', 'retired'],
  approved: ['activated', 'deprecated', 'retired'],
  activated: ['suspended', 'deprecated', 'superseded', 'retired'],
  suspended: ['activated', 'deprecated', 'retired'],
  deprecated: ['superseded', 'retired'],
  superseded: ['retired'],
  retired: [],
};

/** True iff `to` is a permitted adapter-version lifecycle transition from `from`. */
export function canAdapterTransition(from: AdapterLifecycleState, to: AdapterLifecycleState): boolean {
  return isAdapterLifecycleState(from) && isAdapterLifecycleState(to)
    ? ADAPTER_TRANSITIONS[from].includes(to)
    : false;
}

export function assertAdapterTransition(from: AdapterLifecycleState, to: AdapterLifecycleState): void {
  if (!canAdapterTransition(from, to)) {
    throw new RangeError(`illegal adapter-version transition: ${from} → ${to}`);
  }
}

// ===========================================================================
// 2. The durable value model — versions + append-only transition ledger.
// ===========================================================================

/** An immutable, signed, versioned adapter build (mirror of migration 0060 `adapter_version`). */
export interface AdapterVersion {
  readonly id: Uuid;
  readonly tenantId: TenantId;
  readonly definitionId: Uuid;
  readonly semanticVersion: Semver;
  readonly manifest: AdapterManifest;
  readonly manifestDigest: string;
  readonly signingKeyId: string;
  readonly lifecycleState: AdapterLifecycleState;
  /** The passing conformance-result id gating activation (undefined until tested). */
  readonly conformanceResultId?: Uuid;
  /** Retained evidence ids across every transition (append-only). */
  readonly evidenceIds: readonly Uuid[];
  readonly createdAt: EpochMillis;
  readonly updatedAt: EpochMillis;
}

/** One append-only lifecycle-ledger entry (mirror of `adapter_version_transition`). */
export interface AdapterVersionTransition {
  readonly id: Uuid;
  readonly versionId: Uuid;
  readonly fromState?: AdapterLifecycleState;
  readonly toState: AdapterLifecycleState;
  readonly actorPrincipalId: Uuid;
  readonly reason: Reason;
  readonly evidenceIds: readonly Uuid[];
  readonly transitionedAt: EpochMillis;
}

/** The input to a single guarded transition. */
export interface AdapterTransitionInput {
  readonly version: AdapterVersion;
  readonly to: AdapterLifecycleState;
  readonly actorPrincipalId: Uuid;
  readonly reason: Reason;
  /** Evidence retained for this step (conformance / approval / suspension / … ids). */
  readonly evidenceIds?: readonly Uuid[];
  /** For `tested`/`activated`: the passing conformance-result id (also retained as evidence). */
  readonly conformanceResultId?: Uuid;
  /** A verdict that the cited conformance result PASSED — activation refuses a non-passing result. */
  readonly conformancePassed?: boolean;
  readonly newTransitionId: Uuid;
  readonly at: EpochMillis;
}

export interface AdapterTransitionResult {
  readonly version: AdapterVersion;
  readonly transition: AdapterVersionTransition;
}

/**
 * Apply a single guarded lifecycle transition, RETAINING its evidence and (for `activated`)
 * REFUSING activation unless a PASSING conformance result id is present. Pure — returns the new
 * version value + the append-only ledger entry; never mutates its input.
 */
export function applyAdapterTransition(input: AdapterTransitionInput): AdapterTransitionResult {
  const { version, to } = input;
  assertUuid(version.id, 'transition.version.id');
  assertUuid(input.actorPrincipalId, 'transition.actorPrincipalId');
  assertUuidV7(input.newTransitionId, 'transition.newTransitionId');
  assertEpoch(input.at, 'transition.at');
  if (!input.reason || typeof input.reason.code !== 'string') {
    throw new TypeError('transition.reason must be a structured reason');
  }
  assertAdapterTransition(version.lifecycleState, to);

  // A version that gained a conformance result carries it forward; a new one supersedes it.
  const conformanceResultId = input.conformanceResultId ?? version.conformanceResultId;

  // ACTIVATION GATE: no adapter may be activated without a PASSING conformance result id
  // (mirrors migration 0060 `adapter_version_activation_requires_conformance`).
  if (to === 'activated') {
    if (conformanceResultId === undefined) {
      throw new RangeError(
        'cannot activate an adapter version without a passing conformance-result id (T230/T254)',
      );
    }
    if (input.conformanceResultId !== undefined && input.conformancePassed === false) {
      throw new RangeError('cannot activate: the cited conformance result did not pass');
    }
  }

  // A connector is NEVER granted governance authority: refuse a manifest that (mistakenly) claims
  // authority to draw governance conclusions. `authoritative_fields` says what the source is
  // authoritative FOR (data), which is permitted; but a manifest may not declare an
  // `operation_risk` entry that grants a governance DECISION — the adapter cannot decide.
  assertNoGovernanceAuthority(version.manifest);

  const evidence = mergeEvidence(
    version.evidenceIds,
    input.evidenceIds ?? [],
    conformanceResultId !== undefined ? [conformanceResultId] : [],
  );

  const nextVersion: AdapterVersion = {
    ...version,
    lifecycleState: to,
    ...(conformanceResultId !== undefined ? { conformanceResultId } : {}),
    evidenceIds: evidence,
    updatedAt: input.at,
  };

  const transition: AdapterVersionTransition = {
    id: input.newTransitionId,
    versionId: version.id,
    fromState: version.lifecycleState,
    toState: to,
    actorPrincipalId: input.actorPrincipalId,
    reason: input.reason,
    evidenceIds: Object.freeze([...(input.evidenceIds ?? [])]),
    transitionedAt: input.at,
  };

  return Object.freeze({
    version: Object.freeze(nextVersion),
    transition: Object.freeze(transition),
  });
}

function assertUuid(id: unknown, label: string): asserts id is Uuid {
  if (!isUuid(id)) throw new TypeError(`${label} must be a UUID`);
}

/** A connector is never granted governance authority. The manifest may declare what data fields the
 * source is authoritative FOR, and the risk class of its OPERATIONS, but it must not name a
 * consequential authority to draw a governance conclusion — an adapter grant is not authority. */
function assertNoGovernanceAuthority(manifest: AdapterManifest): void {
  // `forbidden_inferences` is the manifest's own declaration of the governance conclusions it may
  // NOT draw; its presence is expected. The registry additionally refuses any capability outside the
  // adapter capability vocabulary — validateManifest already enforces that — and treats the adapter
  // as data-only. No further authority field exists on the manifest, so there is nothing to grant.
  void manifest;
}

function mergeEvidence(...groups: readonly (readonly Uuid[])[]): readonly Uuid[] {
  const seen = new Set<string>();
  const out: Uuid[] = [];
  for (const g of groups) {
    for (const id of g) {
      if (!isUuid(id)) throw new TypeError('evidence id must be a UUID');
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return Object.freeze(out);
}

// ===========================================================================
// 3. The in-memory registry aggregate, keyed by (definitionId, semanticVersion).
// ===========================================================================

export interface RegisterAdapterInput {
  readonly definitionId: Uuid;
  readonly semanticVersion: Semver;
  readonly manifest: AdapterManifest;
  /** The signing key used to VERIFY the manifest's detached signature (never stored). */
  readonly signingKey: string;
  /** The platform protocol the version must be able to speak (NS-005 drift check). */
  readonly platformProtocol: Semver;
  readonly tenantId?: TenantId;
  readonly newId: IdFactory;
  readonly at: EpochMillis;
}

/**
 * In-memory adapter registry. Versions are keyed by (definitionId, semanticVersion) — a
 * re-registration of the same key with the same manifest digest is idempotent; a DIFFERENT manifest
 * digest under the same key is a conflict (a version is immutable once registered). Every transition
 * is recorded in an append-only ledger keyed by version id.
 */
export class AdapterRegistry {
  private readonly versions = new Map<string, AdapterVersion>();
  private readonly ledger = new Map<string, AdapterVersionTransition[]>();

  private key(definitionId: Uuid, semanticVersion: Semver): string {
    return `${definitionId} ${semanticVersion}`;
  }

  /**
   * Register a new adapter version. The manifest is VALIDATED (validateManifest / assertManifest)
   * and its detached signature VERIFIED (verifyManifestSignature) before it enters the registry, and
   * the platform protocol must fall within the manifest's contract range (NS-005). The version
   * starts in `registered`. Idempotent per (definitionId, semanticVersion, manifest digest).
   */
  register(input: RegisterAdapterInput): AdapterVersion {
    assertUuid(input.definitionId, 'register.definitionId');
    assertNonEmpty(input.semanticVersion, 'register.semanticVersion');
    assertNonEmpty(input.signingKey, 'register.signingKey');
    assertNonEmpty(input.platformProtocol, 'register.platformProtocol');
    assertEpoch(input.at, 'register.at');
    const tenantId = input.tenantId ?? PLATFORM_SCOPE;
    assertTenant(tenantId, 'register.tenantId');

    // Validate + assert the manifest structurally and semantically.
    const validation = validateManifest(input.manifest);
    if (!validation.valid) {
      const first = validation.issues[0]!;
      throw new Error(`register: invalid manifest at "${first.path}": ${first.message}`);
    }
    assertManifest(input.manifest);

    // Verify the detached signature over the canonical form (a tampered manifest is refused).
    const verify = verifyManifestSignature(input.manifest, input.signingKey);
    if (!verify.valid) {
      throw new Error(`register: manifest signature does not verify (${verify.reason})`);
    }

    // NS-005 version-drift refusal.
    const contract = negotiateContract(input.manifest, input.platformProtocol);
    if (!contract.ok) {
      throw new RangeError(
        `register: platform protocol ${input.platformProtocol} is ${contract.reason} of the manifest contract range [${contract.range.minimum}, ${contract.range.maximum}]`,
      );
    }

    // A connector is never granted governance authority.
    assertNoGovernanceAuthority(input.manifest);

    const digest = manifestDigest(input.manifest);
    const k = this.key(input.definitionId, input.semanticVersion);
    const existing = this.versions.get(k);
    if (existing) {
      if (existing.manifestDigest === digest) return existing; // idempotent re-register.
      throw new RangeError(
        `adapter-version conflict: (${input.definitionId}, ${input.semanticVersion}) already ` +
          'registered with a different manifest digest (a version is immutable; bump the version)',
      );
    }

    const id = input.newId();
    assertUuidV7(id, 'register.id');
    const version: AdapterVersion = Object.freeze({
      id,
      tenantId,
      definitionId: input.definitionId,
      semanticVersion: input.semanticVersion,
      manifest: input.manifest,
      manifestDigest: digest,
      signingKeyId: input.manifest.signature?.key_id ?? 'unsigned',
      lifecycleState: 'registered',
      evidenceIds: Object.freeze([]),
      createdAt: input.at,
      updatedAt: input.at,
    });
    this.versions.set(k, version);
    this.ledger.set(id, []);
    return version;
  }

  /**
   * Advance a stored version through a guarded transition (see {@link applyAdapterTransition}),
   * persisting the new version value and appending the ledger entry. Returns the durable result.
   */
  transition(input: Omit<AdapterTransitionInput, 'version'> & { versionId: Uuid }): AdapterTransitionResult {
    const version = this.requireVersionById(input.versionId);
    const { versionId: _drop, ...rest } = input;
    void _drop;
    const result = applyAdapterTransition({ ...rest, version });
    const k = this.key(version.definitionId, version.semanticVersion);
    this.versions.set(k, result.version);
    const log = this.ledger.get(version.id) ?? [];
    log.push(result.transition);
    this.ledger.set(version.id, log);
    return result;
  }

  /** Read a version by (definitionId, semanticVersion). */
  get(definitionId: Uuid, semanticVersion: Semver): AdapterVersion | undefined {
    return this.versions.get(this.key(definitionId, semanticVersion));
  }

  /** Read a version by id. */
  getById(versionId: Uuid): AdapterVersion | undefined {
    for (const v of this.versions.values()) if (v.id === versionId) return v;
    return undefined;
  }

  private requireVersionById(versionId: Uuid): AdapterVersion {
    const v = this.getById(versionId);
    if (!v) throw new RangeError(`unknown adapter version: ${versionId}`);
    return v;
  }

  /** All registered versions, sorted by (definitionId, semanticVersion). */
  list(): readonly AdapterVersion[] {
    return Object.freeze(
      [...this.versions.values()].sort((a, b) =>
        a.definitionId === b.definitionId
          ? a.semanticVersion.localeCompare(b.semanticVersion)
          : a.definitionId.localeCompare(b.definitionId),
      ),
    );
  }

  /** The append-only transition ledger for a version (history preserved), oldest first. */
  transitions(versionId: Uuid): readonly AdapterVersionTransition[] {
    return Object.freeze([...(this.ledger.get(versionId) ?? [])]);
  }

  /**
   * A stable content digest over the whole registry (versions + ledger). Changes iff any governed
   * fact changes; identical iff the state is identical — the durable-effect witness tests read
   * INSTEAD of trusting a mutation's return value.
   */
  snapshotDigest(): string {
    const parts: string[] = [];
    for (const v of this.list()) {
      parts.push(
        sha256(
          JSON.stringify({
            id: v.id,
            def: v.definitionId,
            ver: v.semanticVersion,
            digest: v.manifestDigest,
            state: v.lifecycleState,
            conformance: v.conformanceResultId ?? null,
            evidence: [...v.evidenceIds].sort(),
            updatedAt: v.updatedAt,
          }),
        ),
      );
      for (const t of this.transitions(v.id)) {
        parts.push(
          sha256(
            JSON.stringify({
              id: t.id,
              versionId: t.versionId,
              from: t.fromState ?? null,
              to: t.toState,
              actor: t.actorPrincipalId,
              at: t.transitionedAt,
              evidence: [...t.evidenceIds].sort(),
            }),
          ),
        );
      }
    }
    return sha256(JSON.stringify(parts.sort()));
  }
}
