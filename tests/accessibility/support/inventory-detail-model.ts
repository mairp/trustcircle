// TrustCircleAI — Phase 80 SOURCE/ASSET DRILL-DOWN DETAIL derivation.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item 384B1E4BN35A236DWJKY5MK8AE.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The Phase-80 view (apps/web/src/features/inventory/InventoryDetail.tsx) is a PURE PRESENTER:
// `renderInventoryDetail(props)` renders whatever `InventoryDetailModel` it is handed. This module is
// where that model is EARNED — it is DERIVED by running the REAL Phase-70 current-inventory assembly
// service (packages/application/src/inventory-service.ts) against the SAME explicit, deterministic
// scenario the Phase-77 shell / Phase-79 table use (support/current-state-model.ts), then SELECTING one
// asset and projecting the service's OWN `drillDown(assetId)` / `rowFor()` / `componentGaps()` /
// `governedSourceGaps()` / `catalogView()` outputs into the detail panels:
//
//   • AC1 the identity header IS the service's `InventoryRow` for the selected asset — emitted ONCE.
//   • AC3 the distinct-source-record rows ARE `drillDown().sourceRecords` (each `SourceRecord` kept
//     verbatim). The per-field authority / contested / status-differences / VERSIONS come from
//     `drillDown().correlation.fields` (`FieldResolution`): `authoritativeSourceClass` is the
//     system-of-record, `contested` flags a status difference, `contributingSources` is the field's
//     HISTORY (one version per source: value + freshness + confidence + as-of), and `differingSources`
//     marks which of those versions disagree with the resolved value. The dependency edges are
//     `drillDown().dependencies` (`DependencyView`).
//   • AC4 a record / field whose winning observation is stale reports its `stale`/`freshness` verdict,
//     and the header's `reportedHealth` is `unknown` because the SERVICE refuses to infer it.
//   • AC2 the still-visible component coverage gaps bound to the asset are `componentGaps()` (filtered
//     to the asset's subject id) — kept with reason/age/impact/action.
//   • AC5 the correlated discovered-source panel is the service's `catalogView()` entry.
//   • AC6 the governed-source gap is the service's `governedSourceGaps()` entry for that source.
//
// The accessibility spec builds this scenario, mutates its INPUT for each RED negative control (a stale
// record, a single source, a dropped gap/evidence/review), re-derives through the real service, and
// asserts the VIEW's rendered DOM reflects the service's independently-computed output. Expectations
// come from the service, not from the view — the oracle cannot be satisfied by a static template.
//
// DETERMINISM. No wall clock, no randomness: the scenario reuses the seeded UUIDv7 factory and explicit
// epoch-millis; the read instant is explicit. Same scenario ⇒ byte-stable model ⇒ byte-stable render.

import type { EpochMillis } from '../../../packages/domain/src/primitives.ts';
import {
  gapAgeMillis,
  gapHasReviewOrExpiry,
  type CoverageGap,
  type GapReason,
  type SourceRecord,
} from '../../../packages/domain/src/inventory.ts';
import type {
  FieldResolution,
  FieldCandidate,
  DependencyView,
} from '../../../packages/domain/src/correlation.ts';
import {
  InventoryService,
  type InventoryRow,
  type InventoryDrillDown,
} from '../../../packages/application/src/inventory-service.ts';

import {
  buildService,
  deriveModel,
  SCENARIO_IDS,
  idOf,
  T0,
  at,
  HORIZON_MILLIS,
  type ScenarioOverrides,
} from './current-state-model.ts';

import type {
  InventoryDetailModel,
  DetailAssetHeaderVM,
  DetailSourceRecordVM,
  DetailFieldVM,
  FieldSourceVersionVM,
  DetailDiscoveredSourceVM,
} from '../../../apps/web/src/features/inventory/InventoryDetail.tsx';
import type {
  InventoryRowVM,
  CoverageGapVM,
  DiscoveredSourceVM,
  SourceGapVM,
} from '../../../apps/web/src/app/layout.tsx';

// ── Re-export the scenario knobs so specs drive RED controls through one import ─────────────────
export { buildService, SCENARIO_IDS, idOf, T0, at, HORIZON_MILLIS };
export type { ScenarioOverrides };

const DAY_MS = 24 * 60 * 60_000;

// ── small helpers ────────────────────────────────────────────────────────────────────────────

function isoOf(ms: EpochMillis | undefined): string {
  return ms === undefined ? '—' : new Date(ms).toISOString();
}

/** Render an arbitrary observed value as display text (the correlation stores `unknown`). */
function valueText(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

function gapReasonText(reason: GapReason): string {
  const map: Readonly<Record<GapReason, string>> = {
    unmanaged: 'Discovered but never onboarded to a governed source contract.',
    unreachable: 'The connector has missed consecutive health probes.',
    stale: 'The source has not been observed within the freshness horizon.',
    orphaned: 'Evidence exists but the owning asset was removed upstream.',
    excluded: 'Explicitly excluded by an approved scope decision.',
    unsupported: 'No adapter supports this source type yet.',
    inaccessible: 'Access is withheld; the source cannot be reached.',
    sensitive: 'Contains restricted data; access is withheld pending review.',
    unowned: 'No accountable owner has been assigned.',
  };
  return map[reason];
}

// ── AC1 — the identity header for the selected asset (the one row, expanded) ────────────────────

/** Human control-coverage label, derived from the row's coverage facet + visible-gap flag. */
function coverageLabel(row: InventoryRow): string {
  if (row.hasVisibleComponentGap) return 'gap (open component gap)';
  switch (row.coverage) {
    case 'covered':
      return 'covered';
    case 'partial':
      return 'partial';
    default:
      return 'gap';
  }
}

/** Build the base `InventoryRowVM` for the selected asset — mirrors the Phase-77 row→VM mapping. */
function baseRowVM(row: InventoryRow): InventoryRowVM {
  return {
    id: String(row.assetId),
    assetType: row.assetType,
    name: row.name,
    sourceIdentity: `svc/${row.assetType}/${row.name}`,
    owner: row.ownershipGap ? 'unowned (ownership gap)' : String(row.ownerPrincipalId ?? 'unowned'),
    lifecycleState: row.lifecycleState,
    riskTier: row.riskTier,
    controlCoverage: coverageLabel(row),
    evidenceState: row.evidenceState,
    // AC4: the health SAFE to report — the service withholds observed health when evidence is stale.
    reportedHealth: row.reportedHealth,
    observedHealth: row.observedHealth,
    confidence: row.confidence,
    lastObservedAt: isoOf(row.lastObservationAt),
    unresolvedIssues: row.unresolvedIssueCount,
    sourceRecordCount: row.sourceRecordCount,
  };
}

function headerVM(row: InventoryRow, dd: InventoryDrillDown): DetailAssetHeaderVM {
  return {
    base: baseRowVM(row),
    version: row.version,
    // AC4: evidence is "stale" (health withheld) exactly when the service could not report health.
    evidenceStale: row.evidenceState !== 'current' || row.reportedHealth === 'unknown',
    reportedHealth: row.reportedHealth,
    observedHealth: row.observedHealth,
    // AC3: automation pauses iff the correlation could not settle a single safe value for a field.
    automationPaused: dd.correlation.automationPaused,
  };
}

// ── AC3 — distinct source records (each contributing source kept once) ──────────────────────────

/** The named fields THIS record's catalog is authoritative for (comma-joined, or "—"). */
function authoritativeForRecord(dd: InventoryDrillDown, r: SourceRecord): string {
  const fields = dd.authoritativeFields
    .filter((a) => String(a.authoritativeSourceId) === String(r.catalogId))
    .map((a) => a.field);
  return fields.length ? fields.join(', ') : '—';
}

/** The external key this record depends_on (resolved to the target record's key), or "—". */
function dependsOnRecord(dd: InventoryDrillDown, r: SourceRecord): string {
  const dep = dd.dependencies.find((d) => String(d.fromId) === String(r.catalogId));
  if (dep === undefined) return '—';
  const target = dd.sourceRecords.find((x) => String(x.catalogId) === String(dep.toId));
  return target ? target.externalKey : String(dep.toId);
}

function sourceRecordVMs(dd: InventoryDrillDown): readonly DetailSourceRecordVM[] {
  return dd.sourceRecords.map((r): DetailSourceRecordVM => {
    const observed = r.observedState as Record<string, unknown>;
    return {
      sourceClass: r.sourceClass,
      externalKey: r.externalKey,
      status: r.status,
      observedStatus: String(observed['status'] ?? r.status),
      freshness: r.freshness,
      stale: r.stale,
      confidence: r.confidence,
      lastKnownAtIso: isoOf(r.lastKnownAt),
      authoritativeFor: authoritativeForRecord(dd, r),
      dependsOn: dependsOnRecord(dd, r),
    };
  });
}

// ── AC3/AC4 — per-field authority + correlation + versions/history ──────────────────────────────

/** One contributing-source VERSION of a field (value + freshness + confidence + as-of). */
function versionVMs(
  f: FieldResolution,
  differingKeys: ReadonlySet<string>,
): readonly FieldSourceVersionVM[] {
  return f.contributingSources.map((c: FieldCandidate): FieldSourceVersionVM => {
    return {
      sourceClass: c.sourceClass,
      externalKey: c.externalKey,
      value: valueText(c.value),
      freshness: c.freshness,
      confidence: c.confidence,
      asOfIso: isoOf(c.asOf),
      // A version DIFFERS iff the correlation put this record in the field's differingSources set.
      differs: differingKeys.has(String(c.recordId)),
    };
  });
}

function fieldVM(f: FieldResolution): DetailFieldVM {
  const differingKeys = new Set(f.differingSources.map((c) => String(c.recordId)));
  const resolved = f.resolution === 'resolved';
  const stale = resolved && f.stale === true;
  const value = resolved
    ? valueText(f.value)
    : `unresolved${f.unresolvedReason ? ` (${f.unresolvedReason})` : ''}`;
  const summary = resolved
    ? f.contested
      ? `${f.field}: authoritative value "${valueText(f.value)}" from ${
          f.authoritativeSourceClass ?? '—'
        }, but ${f.differingSources.length} source(s) reported a different value (status difference)${
          stale ? '; the winning observation is stale' : ''
        }`
      : `${f.field}: "${valueText(f.value)}" from ${f.authoritativeSourceClass ?? '—'}${
          stale ? ' (stale — shown with as-of, not read as current)' : ''
        }`
    : `${f.field}: unresolved${f.unresolvedReason ? ` (${f.unresolvedReason})` : ''} — ${
        f.differingSources.length
      } source(s) disagree`;
  return {
    field: f.field,
    resolution: f.resolution,
    value,
    authoritativeSourceClass: f.authoritativeSourceClass ?? '—',
    contested: f.contested,
    stale,
    unresolvedReason: f.unresolvedReason ?? '',
    confidence: f.confidence ?? 0,
    asOfIso: isoOf(f.asOf),
    versions: versionVMs(f, differingKeys),
    summary,
  };
}

function fieldVMs(dd: InventoryDrillDown): readonly DetailFieldVM[] {
  return dd.correlation.fields.map((f) => fieldVM(f));
}

// ── AC3 — dependency edges rendered as text ────────────────────────────────────────────────────

function dependencyText(dd: InventoryDrillDown, dep: DependencyView): string {
  const from = dd.sourceRecords.find((r) => String(r.catalogId) === String(dep.fromId));
  const to = dd.sourceRecords.find((r) => String(r.catalogId) === String(dep.toId));
  const fromLabel = from ? `${from.sourceClass} (${from.externalKey})` : String(dep.fromId);
  const toLabel = to ? `${to.sourceClass} (${to.externalKey})` : String(dep.toId);
  return `${fromLabel} depends on ${toLabel} for ${dep.fieldName}`;
}

// ── AC2 — component coverage gaps bound to the selected asset ────────────────────────────────────

function componentGapVMs(
  svc: InventoryService,
  assetId: string,
  now: EpochMillis,
): readonly CoverageGapVM[] {
  return svc
    .componentGaps()
    .filter((g) => String(g.subjectId) === assetId)
    .map((g): CoverageGapVM => componentGapToVM(g, now));
}

function componentGapToVM(gap: CoverageGap, now: EpochMillis): CoverageGapVM {
  return {
    id: String(gap.id),
    component:
      String(gap.subjectId) === String(SCENARIO_IDS.gappedAsset)
        ? 'shadow-inference-svc'
        : `component/${String(gap.subjectId ?? gap.id)}`,
    reasonClass: gap.reason,
    reasonText: gapReasonText(gap.reason),
    ageDays: Math.floor(gapAgeMillis(gap, now) / DAY_MS),
    impact: gap.impact,
    requiredOwnerAction: gap.requiredAction,
  };
}

// ── AC5/AC6 — the correlated discovered source + its governed-source gap ─────────────────────────

function discoveredSourceVM(
  svc: InventoryService,
  catalogId: string,
): DetailDiscoveredSourceVM | undefined {
  const c = svc.catalogView().find((e) => String(e.catalogId) === catalogId);
  if (c === undefined) return undefined;
  const base: DiscoveredSourceVM = {
    id: String(c.catalogId),
    classification: c.classifiedUnknown ? 'unknown' : c.sourceClass,
    location: c.observedLocations.join(', '),
    accessStatus: c.accessState,
    sensitivity: c.sensitivity,
    ownershipStatus: c.ownershipGap ? 'unowned (ownership gap)' : String(c.ownerPrincipalId),
    onboardingState: c.onboardingState,
    discoveryEvidenceRef: c.discoveryEvidence ? String(c.discoveryEvidence) : undefined,
  };
  // AC6: the governed-source gap whose subject is this catalog entry, if any.
  const gap = svc.governedSourceGaps().find((g) => String(g.subjectId) === catalogId);
  const gapVM: SourceGapVM | undefined = gap ? sourceGapToVM(gap) : undefined;
  return {
    base,
    gap: gapVM,
    classified: !c.classifiedUnknown,
    ownershipGap: c.ownershipGap,
  };
}

function sourceGapToVM(gap: CoverageGap): SourceGapVM {
  const review = isoOf(gap.reviewAt);
  const expiry = isoOf(gap.expiresAt);
  return {
    id: String(gap.id),
    source: `source/${String(gap.subjectId ?? gap.id)}`,
    reasonClass: gap.reason,
    reasonText: gapReasonText(gap.reason),
    impact: gap.impact,
    ownerAction: gap.requiredAction,
    reviewOrExpiry:
      review !== '—'
        ? `review by ${review}`
        : expiry !== '—'
          ? `expires ${expiry}`
          : 'no review or expiry recorded',
    hasReviewOrExpiry: gapHasReviewOrExpiry(gap),
  };
}

// ── The public derivation ────────────────────────────────────────────────────────────────────────

/**
 * DERIVE the drill-down detail model for ONE asset from the REAL service at instant `now`. The default
 * `assetId` is the healthy multi-source asset — the scenario's richest drill-down (three distinct
 * sources, an authoritative field, a dependency edge, and a contested field). Every field of the
 * returned model is a projection of a value the service COMPUTED via `drillDown()` / `rowFor()` /
 * `componentGaps()` / `governedSourceGaps()` / `catalogView()`.
 */
export function deriveInventoryDetail(
  overrides: ScenarioOverrides = {},
  assetId: string = String(SCENARIO_IDS.healthyAsset),
  now: EpochMillis = T0,
): InventoryDetailModel {
  const svc = buildService(overrides);
  // Force a full derivation of the shell model too, so the digest/scenario matches the sibling views.
  deriveModel(svc, now);

  const idUuid = assetId as unknown as Parameters<InventoryService['drillDown']>[0];
  const row = svc.rowFor(idUuid, now);
  const dd = svc.drillDown(idUuid, now);

  const header = headerVM(row, dd);
  const sourceRecords = sourceRecordVMs(dd);
  const fields = fieldVMs(dd);
  const dependencies = dd.dependencies.map((d) => dependencyText(dd, d));
  const componentGaps = componentGapVMs(svc, assetId, now);

  // The single correlated discovered source in the scenario (the open-catalog entry).
  const discovered = discoveredSourceVM(svc, String(SCENARIO_IDS.discoveredCatalog));

  return {
    header,
    sourceRecords,
    fields,
    dependencies,
    componentGaps,
    discoveredSource: discovered,
    distinctSourceCount: new Set(dd.sourceRecords.map((r) => r.sourceClass)).size,
    dependencyCount: dd.dependencies.length,
    authoritativeFieldCount: dd.authoritativeFields.length,
    generatedAtIso: new Date(now).toISOString(),
    snapshotDigest: svc.snapshotDigest(now),
  };
}

/** Convenience: the default (no-override) drill-down for the healthy multi-source asset at T0. */
export function defaultInventoryDetail(now: EpochMillis = T0): InventoryDetailModel {
  return deriveInventoryDetail({}, String(SCENARIO_IDS.healthyAsset), now);
}
