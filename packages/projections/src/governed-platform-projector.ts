import {
  assertGovernedTenant,
  classifyGovernedVisibility,
  governedDigest,
  makeGovernedProjectionMetadata,
  type GovernedProjectionMetadata,
  type GovernedVisibilityState,
} from '@trustcircle/domain';

export type GovernedProjectionApplyStatus =
  'applied' | 'duplicate' | 'pending_reconciliation' | 'conflict';

export interface GovernedPlatformProjectionEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly tenantId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly occurredAt: number;
  readonly correlationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface GovernedPlatformProjectionRow {
  readonly tenantId: string;
  readonly kind: string;
  readonly id: string;
  readonly resourceVersion: number;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly sourceEventId: string;
  readonly sourceCursor: string;
  readonly correlationId: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly updatedAt: number;
  readonly stateDigest: string;
}

export interface GovernedPlatformProjectionPage {
  readonly items: readonly GovernedPlatformProjectionRow[];
  readonly metadata: GovernedProjectionMetadata;
  readonly snapshotDigest: string;
}

export interface GovernedReviewWorkspaceProjection {
  readonly snapshots: readonly GovernedPlatformProjectionRow[];
  readonly comparisons: readonly GovernedPlatformProjectionRow[];
  readonly metadata: GovernedProjectionMetadata;
  readonly safeNextActions: readonly string[];
  readonly snapshotDigest: string;
}

export interface GovernedEvidenceWorkspaceProjection {
  readonly requests: readonly GovernedPlatformProjectionRow[];
  readonly attestations: readonly GovernedPlatformProjectionRow[];
  readonly sufficiencyDecisions: readonly GovernedPlatformProjectionRow[];
  readonly derivatives: readonly GovernedPlatformProjectionRow[];
  readonly packages: readonly GovernedPlatformProjectionRow[];
  readonly metadata: GovernedProjectionMetadata;
  readonly safeNextActions: readonly string[];
  readonly snapshotDigest: string;
}

export interface GovernedMonitoringWorkspaceProjection {
  readonly observations: readonly GovernedPlatformProjectionRow[];
  readonly cases: readonly GovernedPlatformProjectionRow[];
  readonly metadata: GovernedProjectionMetadata;
  readonly safeNextActions: readonly string[];
  readonly snapshotDigest: string;
}

export interface GovernedChangeWorkspaceProjection {
  readonly previews: readonly GovernedPlatformProjectionRow[];
  readonly publications: readonly GovernedPlatformProjectionRow[];
  readonly invalidations: readonly GovernedPlatformProjectionRow[];
  readonly rebuilds: readonly GovernedPlatformProjectionRow[];
  readonly rollbacks: readonly GovernedPlatformProjectionRow[];
  readonly metadata: GovernedProjectionMetadata;
  readonly safeNextActions: readonly string[];
  readonly snapshotDigest: string;
}
export interface GovernedAiWorkspaceProjection {
  readonly useCases: readonly GovernedPlatformProjectionRow[];
  readonly evaluations: readonly GovernedPlatformProjectionRow[];
  readonly incidents: readonly GovernedPlatformProjectionRow[];
  readonly exchanges: readonly GovernedPlatformProjectionRow[];
  readonly metadata: GovernedProjectionMetadata;
  readonly safeNextActions: readonly string[];
  readonly snapshotDigest: string;
}

export interface GovernedConnectorWorkspaceProjection {
  readonly definitions: readonly GovernedPlatformProjectionRow[];
  readonly reports: readonly GovernedPlatformProjectionRow[];
  readonly certifications: readonly GovernedPlatformProjectionRow[];
  readonly health: readonly GovernedPlatformProjectionRow[];
  readonly metadata: GovernedProjectionMetadata;
  readonly safeNextActions: readonly string[];
  readonly snapshotDigest: string;
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(field + ' must be a positive integer.');
  }
}

function resourceKey(kind: string, id: string): string {
  if (kind.length === 0 || id.length === 0)
    throw new TypeError('Projection kind and ID are required.');
  return kind + ':' + id;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export interface GovernedPlatformProjectorStatus {
  readonly component: 'governed-platform-projector';
  readonly tenantId: string;
  readonly health: 'healthy' | 'degraded' | 'unavailable';
  readonly ownerPrincipalId: string;
  readonly sourceCursor: string;
  readonly rebuildVersion: number;
  readonly visibility: GovernedVisibilityState;
  readonly lastAttemptAt?: number;
  readonly lastSuccessAt?: number;
  readonly retryState: 'none' | 'pending' | 'terminal';
  readonly terminalFailureRef?: string;
  readonly safeNextAction: string;
}

export interface GovernedPlatformProjectorStatusInput {
  readonly ownerPrincipalId: string;
  readonly at: number;
  readonly freshnessHorizonMs: number;
  readonly lastAttemptAt?: number;
  readonly terminalFailureRef?: string;
}

export class GovernedPlatformProjector {
  readonly #tenantId: string;
  readonly #rows = new Map<string, GovernedPlatformProjectionRow>();
  readonly #inbox = new Set<string>();
  readonly #aggregateVersions = new Map<string, number>();
  #sourceCursor = 'none';
  #rebuildVersion = 1;

  constructor(tenantId: string) {
    if (tenantId.length === 0) throw new TypeError('Projector tenant ID is required.');
    this.#tenantId = tenantId;
  }

  get tenantId(): string {
    return this.#tenantId;
  }

  get rebuildVersion(): number {
    return this.#rebuildVersion;
  }

  apply(event: GovernedPlatformProjectionEvent): GovernedProjectionApplyStatus {
    assertGovernedTenant(event.tenantId, this.#tenantId);
    if (this.#inbox.has(event.eventId)) return 'duplicate';
    requirePositiveInteger(event.eventVersion, 'eventVersion');
    requirePositiveInteger(event.aggregateVersion, 'aggregateVersion');
    if (!Number.isSafeInteger(event.occurredAt) || event.occurredAt < 0) {
      throw new RangeError('occurredAt must be a non-negative integer epoch.');
    }
    const key = resourceKey(event.aggregateType, event.aggregateId);
    const currentVersion = this.#aggregateVersions.get(key) ?? 0;
    if (event.aggregateVersion > currentVersion + 1) return 'pending_reconciliation';
    if (event.aggregateVersion <= currentVersion) {
      this.#inbox.add(event.eventId);
      return 'conflict';
    }

    const state = Object.freeze({ ...event.payload });
    const row = Object.freeze({
      tenantId: event.tenantId,
      kind: event.aggregateType,
      id: event.aggregateId,
      resourceVersion: event.aggregateVersion,
      eventType: event.eventType,
      eventVersion: event.eventVersion,
      sourceEventId: event.eventId,
      sourceCursor: event.eventId,
      correlationId: event.correlationId,
      state,
      updatedAt: event.occurredAt,
      stateDigest: governedDigest(state),
    });
    this.#rows.set(key, row);
    this.#aggregateVersions.set(key, event.aggregateVersion);
    this.#inbox.add(event.eventId);
    this.#sourceCursor = event.eventId;
    return 'applied';
  }

  rebuild(events: readonly GovernedPlatformProjectionEvent[]): void {
    this.#rows.clear();
    this.#inbox.clear();
    this.#aggregateVersions.clear();
    this.#sourceCursor = 'none';
    this.#rebuildVersion += 1;
    const ordered = [...events].sort(
      (a, b) =>
        a.occurredAt - b.occurredAt ||
        a.aggregateVersion - b.aggregateVersion ||
        a.eventId.localeCompare(b.eventId),
    );
    for (const event of ordered) {
      const result = this.apply(event);
      if (result !== 'applied' && result !== 'duplicate') {
        throw new Error('Projection rebuild requires a contiguous, conflict-free event stream.');
      }
    }
  }

  page(kind: string, at: number, freshnessHorizonMs: number): GovernedPlatformProjectionPage {
    if (!Number.isSafeInteger(at) || at < 0) throw new RangeError('at must be an epoch integer.');
    if (!Number.isSafeInteger(freshnessHorizonMs) || freshnessHorizonMs < 0) {
      throw new RangeError('freshnessHorizonMs must be a non-negative integer.');
    }
    const items = Object.freeze(
      [...this.#rows.values()]
        .filter((row) => row.kind === kind)
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    const latest = items.reduce((max, row) => Math.max(max, row.updatedAt), 0);
    const visibility = this.#visibility(items, latest, at, freshnessHorizonMs);
    const coverageGaps = this.#coverageGaps(items, visibility);
    const metadata = makeGovernedProjectionMetadata({
      sourceCursor: this.#sourceCursor,
      generatedAt: at,
      rebuildVersion: this.#rebuildVersion,
      visibility,
      coverageGaps,
    });
    return Object.freeze({
      items,
      metadata,
      snapshotDigest: governedDigest({
        tenantId: this.#tenantId,
        kind,
        at,
        rebuildVersion: this.#rebuildVersion,
        sourceCursor: this.#sourceCursor,
        items,
      }),
    });
  }

  reviewWorkspace(at: number, freshnessHorizonMs: number): GovernedReviewWorkspaceProjection {
    const snapshots = this.page('review_snapshot', at, freshnessHorizonMs);
    const comparisons = this.page('review_comparison', at, freshnessHorizonMs);
    const all = Object.freeze([...snapshots.items, ...comparisons.items]);
    const latest = all.reduce((max, row) => Math.max(max, row.updatedAt), 0);
    const visibility = this.#visibility(all, latest, at, freshnessHorizonMs);
    const explicitGaps = this.#coverageGaps(all, visibility);
    const safeNextActions: string[] = [];
    if (snapshots.items.length === 0) {
      safeNextActions.push('complete and sign a governed review before comparing periods');
    } else if (snapshots.items.length === 1) {
      safeNextActions.push('sign another compatible review period before comparing changes');
    }
    if (comparisons.items.some((row) => row.state['compatibility'] === 'incompatible')) {
      safeNextActions.push('align scope, snapshot schema, and registry versions before comparison');
    }
    if (
      comparisons.items.some(
        (row) => Array.isArray(row.state['unknownRefs']) && row.state['unknownRefs'].length > 0,
      )
    ) {
      safeNextActions.push(
        'investigate unknown comparison outcomes using their governed source links',
      );
    }
    if (safeNextActions.length === 0) {
      safeNextActions.push('inspect attributable deltas and follow their governed source links');
    }
    const metadata = makeGovernedProjectionMetadata({
      sourceCursor: this.#sourceCursor,
      generatedAt: at,
      rebuildVersion: this.#rebuildVersion,
      visibility,
      coverageGaps: explicitGaps,
    });
    return Object.freeze({
      snapshots: snapshots.items,
      comparisons: comparisons.items,
      metadata,
      safeNextActions: Object.freeze([...new Set(safeNextActions)]),
      snapshotDigest: governedDigest({
        tenantId: this.#tenantId,
        sourceCursor: this.#sourceCursor,
        rebuildVersion: this.#rebuildVersion,
        snapshots: snapshots.items,
        comparisons: comparisons.items,
      }),
    });
  }
  evidenceWorkspace(at: number, freshnessHorizonMs: number): GovernedEvidenceWorkspaceProjection {
    const requests = this.page('evidence_request', at, freshnessHorizonMs);
    const attestations = this.page('evidence_attestation', at, freshnessHorizonMs);
    const sufficiency = this.page('evidence_sufficiency_decision', at, freshnessHorizonMs);
    const derivatives = this.page('evidence_derivative', at, freshnessHorizonMs);
    const packages = this.page('evidence_package', at, freshnessHorizonMs);
    const all = Object.freeze([
      ...requests.items,
      ...attestations.items,
      ...sufficiency.items,
      ...derivatives.items,
      ...packages.items,
    ]);
    const latest = all.reduce((max, row) => Math.max(max, row.updatedAt), 0);
    const visibility = this.#visibility(all, latest, at, freshnessHorizonMs);
    const coverageGaps = this.#coverageGaps(all, visibility);
    const safeNextActions: string[] = [];
    if (requests.items.length === 0) {
      safeNextActions.push(
        'issue a version-bound evidence request before inferring assurance coverage',
      );
    }
    if (
      requests.items.some(
        (row) =>
          row.state['status'] === 'expired' ||
          row.state['attention'] === 'overdue' ||
          row.state['attention'] === 'expired',
      )
    ) {
      safeNextActions.push(
        'escalate overdue or expired evidence requests to the accountable owner',
      );
    }
    if (
      derivatives.items.some(
        (row) =>
          row.state['redactionVerified'] === false || typeof row.state['parentDigest'] !== 'string',
      )
    ) {
      safeNextActions.push('quarantine unverified derivatives and preserve the immutable original');
    }
    if (
      packages.items.some(
        (row) =>
          row.state['status'] === 'failed' ||
          row.state['verificationStatus'] === 'failed' ||
          row.state['integrityValid'] === false,
      )
    ) {
      safeNextActions.push(
        'reconcile failed package generation or integrity verification before release',
      );
    }
    if (safeNextActions.length === 0) {
      safeNextActions.push(
        'review exact versions, sufficiency authority, derivative lineage, and package integrity',
      );
    }
    const metadata = makeGovernedProjectionMetadata({
      sourceCursor: this.#sourceCursor,
      generatedAt: at,
      rebuildVersion: this.#rebuildVersion,
      visibility,
      coverageGaps,
    });
    return Object.freeze({
      requests: requests.items,
      attestations: attestations.items,
      sufficiencyDecisions: sufficiency.items,
      derivatives: derivatives.items,
      packages: packages.items,
      metadata,
      safeNextActions: Object.freeze([...new Set(safeNextActions)]),
      snapshotDigest: governedDigest({
        tenantId: this.#tenantId,
        sourceCursor: this.#sourceCursor,
        rebuildVersion: this.#rebuildVersion,
        requests: requests.items,
        attestations: attestations.items,
        sufficiency: sufficiency.items,
        derivatives: derivatives.items,
        packages: packages.items,
      }),
    });
  }
  monitoringWorkspace(
    at: number,
    freshnessHorizonMs: number,
  ): GovernedMonitoringWorkspaceProjection {
    const observations = this.page('control_observation', at, freshnessHorizonMs);
    const cases = this.page('monitoring_case', at, freshnessHorizonMs);
    const all = Object.freeze([...observations.items, ...cases.items]);
    const latest = all.reduce((max, row) => Math.max(max, row.updatedAt), 0);
    const visibility = this.#visibility(all, latest, at, freshnessHorizonMs);
    const coverageGaps = this.#coverageGaps(all, visibility);
    const safeNextActions: string[] = [];
    if (observations.items.length === 0) {
      safeNextActions.push('restore governed observation coverage before inferring control health');
    }
    if (
      observations.items.some(
        (row) =>
          row.state['status'] !== 'pass' ||
          row.state['freshness'] === 'stale' ||
          row.state['completeness'] !== 'complete' ||
          row.state['sourceHealth'] !== 'healthy',
      ) ||
      cases.items.some(
        (row) =>
          row.state['assuranceOutcome'] !== 'pass' ||
          (Array.isArray(row.state['uncertaintyReasons']) &&
            row.state['uncertaintyReasons'].length > 0),
      )
    ) {
      safeNextActions.push(
        'investigate uncertainty, source health, and preserved observation evidence; do not infer pass',
      );
    }
    if (
      cases.items.some((row) => {
        const retry = row.state['retryState'];
        return (
          row.state['terminalFailureRef'] !== undefined ||
          (typeof retry === 'object' &&
            retry !== null &&
            'terminal' in retry &&
            retry.terminal === true)
        );
      })
    ) {
      safeNextActions.push('reconcile terminal monitoring failures with the accountable owner');
    }
    if (safeNextActions.length === 0) {
      safeNextActions.push('inspect current case ownership and exact observation evidence');
    }
    const metadata = makeGovernedProjectionMetadata({
      sourceCursor: this.#sourceCursor,
      generatedAt: at,
      rebuildVersion: this.#rebuildVersion,
      visibility,
      coverageGaps,
    });
    return Object.freeze({
      observations: observations.items,
      cases: cases.items,
      metadata,
      safeNextActions: Object.freeze([...new Set(safeNextActions)]),
      snapshotDigest: governedDigest({
        tenantId: this.#tenantId,
        sourceCursor: this.#sourceCursor,
        rebuildVersion: this.#rebuildVersion,
        observations: observations.items,
        cases: cases.items,
      }),
    });
  }

  changeWorkspace(at: number, freshnessHorizonMs: number): GovernedChangeWorkspaceProjection {
    const previews = this.page('impact_preview', at, freshnessHorizonMs);
    const publications = this.page('change_publication', at, freshnessHorizonMs);
    const invalidations = this.page('projection_invalidation', at, freshnessHorizonMs);
    const rebuilds = this.page('projection_rebuild', at, freshnessHorizonMs);
    const rollbacks = this.page('governed_rollback', at, freshnessHorizonMs);
    const all = Object.freeze([
      ...previews.items,
      ...publications.items,
      ...invalidations.items,
      ...rebuilds.items,
      ...rollbacks.items,
    ]);
    const latest = all.reduce((max, row) => Math.max(max, row.updatedAt), 0);
    const visibility = this.#visibility(all, latest, at, freshnessHorizonMs);
    const coverageGaps = this.#coverageGaps(all, visibility);
    const safeNextActions: string[] = [];
    if (previews.items.length === 0) {
      safeNextActions.push('generate a non-mutating version-bound preview before publication');
    }
    if (
      previews.items.some((row) =>
        ['partial', 'expired', 'source_drift', 'proposal_drift'].includes(
          String(row.state['status']),
        ),
      )
    ) {
      safeNextActions.push(
        'regenerate invalid or incomplete previews from current source versions',
      );
    }
    if (
      rebuilds.items.some(
        (row) =>
          row.state['status'] === 'failed' ||
          row.state['terminal'] === true ||
          row.state['failureEvidenceRef'] !== undefined,
      )
    ) {
      safeNextActions.push('reconcile failed rebuild work or invoke the governed rollback path');
    }
    if (
      publications.items.some((row) =>
        ['pending', 'running', 'failed'].includes(String(row.state['rebuildStatus'])),
      )
    ) {
      safeNextActions.push(
        'keep publication rebuild progress and failures visible until reconciled',
      );
    }
    if (safeNextActions.length === 0) {
      safeNextActions.push(
        'verify affected records, rebuild completion, and retained rollback evidence',
      );
    }
    const metadata = makeGovernedProjectionMetadata({
      sourceCursor: this.#sourceCursor,
      generatedAt: at,
      rebuildVersion: this.#rebuildVersion,
      visibility,
      coverageGaps,
    });
    return Object.freeze({
      previews: previews.items,
      publications: publications.items,
      invalidations: invalidations.items,
      rebuilds: rebuilds.items,
      rollbacks: rollbacks.items,
      metadata,
      safeNextActions: Object.freeze([...new Set(safeNextActions)]),
      snapshotDigest: governedDigest({
        tenantId: this.#tenantId,
        sourceCursor: this.#sourceCursor,
        rebuildVersion: this.#rebuildVersion,
        previews: previews.items,
        publications: publications.items,
        invalidations: invalidations.items,
        rebuilds: rebuilds.items,
        rollbacks: rollbacks.items,
      }),
    });
  }
  aiWorkspace(at: number, freshnessHorizonMs: number): GovernedAiWorkspaceProjection {
    const useCases = this.page('ai_use_case', at, freshnessHorizonMs);
    const evaluations = this.page('ai_evaluation', at, freshnessHorizonMs);
    const incidents = this.page('ai_incident', at, freshnessHorizonMs);
    const exchanges = this.page('copilot_exchange', at, freshnessHorizonMs);
    const all = Object.freeze([
      ...useCases.items,
      ...evaluations.items,
      ...incidents.items,
      ...exchanges.items,
    ]);
    const latest = all.reduce((max, row) => Math.max(max, row.updatedAt), 0);
    const visibility = this.#visibility(all, latest, at, freshnessHorizonMs);
    const coverageGaps = this.#coverageGaps(all, visibility);
    const safeNextActions: string[] = [];
    if (useCases.items.length === 0) {
      safeNextActions.push(
        'register purpose, ownership, risk, oversight, and exact components before use',
      );
    }
    if (
      useCases.items.some(
        (row) =>
          ['constrained', 'suspended'].includes(String(row.state['lifecycleState'])) ||
          (Array.isArray(row.state['driftReasons']) && row.state['driftReasons'].length > 0),
      ) ||
      incidents.items.some(
        (row) =>
          row.state['status'] === 'open' &&
          ['critical', 'high'].includes(String(row.state['severity'])),
      )
    ) {
      safeNextActions.push(
        'keep the AI use case suspended or constrained until approval, drift, and incidents are resolved',
      );
    }
    if (
      evaluations.items.some((row) => ['fail', 'limited'].includes(String(row.state['verdict'])))
    ) {
      safeNextActions.push('review evaluation limitations before any exact-component approval');
    }
    if (
      exchanges.items.some(
        (row) =>
          typeof row.state['abstentionCode'] === 'string' ||
          !Array.isArray(row.state['citationRefs']) ||
          row.state['citationRefs'].length === 0,
      )
    ) {
      safeNextActions.push(
        'restore current authorized sources before relying on generated assistance',
      );
    }
    if (safeNextActions.length === 0) {
      safeNextActions.push(
        'verify exact component approvals, evaluations, monitoring, and citation authority',
      );
    }
    const metadata = makeGovernedProjectionMetadata({
      sourceCursor: this.#sourceCursor,
      generatedAt: at,
      rebuildVersion: this.#rebuildVersion,
      visibility,
      coverageGaps,
    });
    return Object.freeze({
      useCases: useCases.items,
      evaluations: evaluations.items,
      incidents: incidents.items,
      exchanges: exchanges.items,
      metadata,
      safeNextActions: Object.freeze([...new Set(safeNextActions)]),
      snapshotDigest: governedDigest({
        tenantId: this.#tenantId,
        sourceCursor: this.#sourceCursor,
        rebuildVersion: this.#rebuildVersion,
        useCases: useCases.items,
        evaluations: evaluations.items,
        incidents: incidents.items,
        exchanges: exchanges.items,
      }),
    });
  }

  connectorWorkspace(at: number, freshnessHorizonMs: number): GovernedConnectorWorkspaceProjection {
    const definitions = this.page('connector_definition', at, freshnessHorizonMs);
    const reports = this.page('connector_conformance_report', at, freshnessHorizonMs);
    const certifications = this.page('connector_certification', at, freshnessHorizonMs);
    const health = this.page('connector_health', at, freshnessHorizonMs);
    const all = Object.freeze([
      ...definitions.items,
      ...reports.items,
      ...certifications.items,
      ...health.items,
    ]);
    const latest = all.reduce((max, row) => Math.max(max, row.updatedAt), 0);
    const visibility = this.#visibility(all, latest, at, freshnessHorizonMs);
    const coverageGaps = this.#coverageGaps(all, visibility);
    const safeNextActions: string[] = [];
    if (definitions.items.length === 0) {
      safeNextActions.push(
        'author a complete connector definition before requesting conformance or certification',
      );
    }
    if (
      reports.items.some(
        (row) =>
          row.state['status'] !== 'passed' ||
          (Array.isArray(row.state['failedDimensions']) &&
            row.state['failedDimensions'].length > 0),
      )
    ) {
      safeNextActions.push(
        'resolve every failed conformance dimension and sign a new exact report',
      );
    }
    if (
      certifications.items.some((row) =>
        ['revoked', 'expired'].includes(String(row.state['status'])),
      ) ||
      health.items.some(
        (row) =>
          row.state['status'] !== 'healthy' ||
          row.state['terminalFailureRef'] !== undefined ||
          row.state['reconciliationAvailable'] === true,
      )
    ) {
      safeNextActions.push(
        'block new connector work and reconcile retained uncertain or partial outcomes',
      );
    }
    if (safeNextActions.length === 0) {
      safeNextActions.push(
        'verify exact certification bounds, connector health, and reconciliation evidence',
      );
    }
    const metadata = makeGovernedProjectionMetadata({
      sourceCursor: this.#sourceCursor,
      generatedAt: at,
      rebuildVersion: this.#rebuildVersion,
      visibility,
      coverageGaps,
    });
    return Object.freeze({
      definitions: definitions.items,
      reports: reports.items,
      certifications: certifications.items,
      health: health.items,
      metadata,
      safeNextActions: Object.freeze([...new Set(safeNextActions)]),
      snapshotDigest: governedDigest({
        tenantId: this.#tenantId,
        sourceCursor: this.#sourceCursor,
        rebuildVersion: this.#rebuildVersion,
        definitions: definitions.items,
        reports: reports.items,
        certifications: certifications.items,
        health: health.items,
      }),
    });
  }

  status(input: GovernedPlatformProjectorStatusInput): GovernedPlatformProjectorStatus {
    if (input.ownerPrincipalId.trim().length === 0) {
      throw new TypeError('Projector owner is required.');
    }
    if (!Number.isSafeInteger(input.at) || input.at < 0) {
      throw new RangeError('Projector status time must be a non-negative epoch.');
    }
    if (!Number.isSafeInteger(input.freshnessHorizonMs) || input.freshnessHorizonMs < 0) {
      throw new RangeError('Projector freshness horizon must be non-negative.');
    }
    const rows = [...this.#rows.values()];
    const latest = rows.reduce((max, row) => Math.max(max, row.updatedAt), 0);
    const visibility = this.#visibility(rows, latest, input.at, input.freshnessHorizonMs);
    const retainedTerminalRef =
      input.terminalFailureRef ??
      rows
        .map((row) => row.state['terminalFailureRef'])
        .find((value): value is string => typeof value === 'string' && value.length > 0);
    const terminal = retainedTerminalRef !== undefined;
    const healthy = visibility === 'current' && !terminal;
    return Object.freeze({
      component: 'governed-platform-projector',
      tenantId: this.#tenantId,
      health: healthy ? 'healthy' : terminal ? 'unavailable' : 'degraded',
      ownerPrincipalId: input.ownerPrincipalId,
      sourceCursor: this.#sourceCursor,
      rebuildVersion: this.#rebuildVersion,
      visibility,
      ...(input.lastAttemptAt === undefined && latest === 0
        ? {}
        : { lastAttemptAt: input.lastAttemptAt ?? latest }),
      ...(latest === 0 ? {} : { lastSuccessAt: latest }),
      retryState: terminal ? 'terminal' : healthy ? 'none' : 'pending',
      ...(retainedTerminalRef === undefined ? {} : { terminalFailureRef: retainedTerminalRef }),
      safeNextAction: terminal
        ? 'Reconcile the retained terminal projection failure before serving current claims.'
        : healthy
          ? 'Retain cursor and rebuild evidence; no projection recovery action is required.'
          : 'Retry or rebuild from the durable source cursor; do not infer current state.',
    });
  }

  #visibility(
    items: readonly GovernedPlatformProjectionRow[],
    latest: number,
    at: number,
    freshnessHorizonMs: number,
  ): GovernedVisibilityState {
    if (items.length === 0) return 'unknown';
    const unavailable = items.some((row) => bool(row.state['available']) === false);
    const conflicting = items.some((row) => bool(row.state['conflicting']) === true);
    const partial = items.some((row) => bool(row.state['partial']) === true);
    return classifyGovernedVisibility({
      present: true,
      available: !unavailable,
      conflicting,
      partial,
      fresh: at - latest <= freshnessHorizonMs,
    });
  }

  #coverageGaps(
    items: readonly GovernedPlatformProjectionRow[],
    visibility: GovernedVisibilityState,
  ): readonly string[] {
    const explicit = items.flatMap((row) =>
      Array.isArray(row.state['coverageGaps'])
        ? row.state['coverageGaps'].filter((gap): gap is string => typeof gap === 'string')
        : [],
    );
    if (explicit.length > 0) return Object.freeze([...new Set(explicit)].sort());
    if (visibility === 'current' || visibility === 'aging') return Object.freeze([]);
    return Object.freeze(['projection_' + visibility]);
  }
}
