// TrustCircleAI — Phase 79 SEARCHABLE/FILTERABLE INVENTORY-TABLE derivation.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item TRRGYA7N0K97QZ8JAMD077BRWP.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The Phase-79 view (apps/web/src/features/inventory/InventoryTable.tsx) is a PURE PRESENTER:
// `renderInventoryTable(props)` renders whatever `InventoryTableModel` it is handed. This module is
// where that model is EARNED — it is DERIVED by running the REAL Phase-70 current-inventory assembly
// service (packages/application/src/inventory-service.ts) against the SAME explicit, deterministic
// scenario the Phase-77 shell uses (support/current-state-model.ts), then folding the service's own
// outputs into the two enriched tables plus the search/filter result set:
//
//   • GOVERNED-ASSET TABLE — every reconciled `InventoryRow` (healthy, gapped, AND stale), each ONCE,
//     enriched with an explicit AGE (observation age in days, and a `stale` flag when past the
//     freshness horizon — derived from `lastObservationAt` + `evidenceState`) and an explicit
//     AUTHORITY facet (the authoritative-field attributions the service correlated via `drillDown`,
//     with the source class named, and a CONTESTED flag when a field's authority is unresolved).
//   • SOURCE-CATALOG TABLE — every `catalogView()` entry, each ONCE, enriched with an explicit AGE
//     (days since first discovery AND since last seen — from the raw `SourceCatalogEntry`) and an
//     explicit AUTHORITY facet (classified vs. `unknown`, and ownership authority vs. ownership gap).
//     Any governed-source gap (`governedSourceGaps()`) bound to a source is carried on its row.
//   • SEARCH / FILTER — the officer's free-text query + active facet chips are applied to the SERVICE's
//     rows. A row MATCHES iff its searchable index contains the query text AND it satisfies every
//     active filter family. Non-matching rows are kept (never deleted) and marked with a reason. The
//     visible/total counts are a reduction of that membership.
//
// The accessibility spec builds this scenario, mutates its INPUT (or its query) for each RED negative
// control, re-derives through the real service, and asserts the VIEW's rendered DOM reflects the
// service's independently-computed output. Expectations come from the service, not from the view.
//
// DETERMINISM. No wall clock, no randomness: the scenario reuses the Phase-77 seeded UUIDv7 factory and
// explicit epoch-millis; the read instant is explicit. Same scenario+query ⇒ byte-stable model.

import type { EpochMillis } from '../../../packages/domain/src/primitives.ts';
import {
  gapAgeMillis,
  type CoverageGap,
  type SourceCatalogEntry,
} from '../../../packages/domain/src/inventory.ts';
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
  InventoryTableModel,
  AssetTableRowVM,
  SourceTableRowVM,
  AssetAgeVM,
  AssetAuthorityVM,
  SourceAgeVM,
  SourceAuthorityVM,
  FilterChipVM,
  QueryStateVM,
} from '../../../apps/web/src/features/inventory/InventoryTable.tsx';
import type {
  CurrentStateModel,
  InventoryRowVM,
  DiscoveredSourceVM,
  SourceGapVM,
} from '../../../apps/web/src/app/layout.tsx';

// ── Re-export the scenario knobs so specs drive RED controls through one import ─────────────────
export { buildService, SCENARIO_IDS, idOf, T0, at };
export type { ScenarioOverrides };

const DAY_MS = 24 * 60 * 60_000;

// ── The officer's SEARCH / FILTER query ─────────────────────────────────────────────────────────
//
// A filter is `family=value`. A row satisfies the active query iff (a) its search index contains the
// (lower-cased) text, AND (b) for every filter FAMILY that has ≥1 active value, the row's facet for
// that family is one of the active values. Different families AND together; values within a family OR.

/** The officer's query: free text + a set of active `family=value` filters. */
export interface InventoryQuery {
  readonly text?: string;
  readonly filters?: readonly string[];
}

/** Which facet families the tables expose as filter chips, and the chips offered for each. */
const FILTER_FAMILIES: ReadonlyArray<{
  readonly family: string;
  readonly appliesTo: FilterChipVM['appliesTo'];
  readonly values: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}> = [
  {
    family: 'risk',
    appliesTo: 'asset',
    values: [
      { value: 'high', label: 'Risk: high' },
      { value: 'moderate', label: 'Risk: moderate' },
      { value: 'critical', label: 'Risk: critical' },
    ],
  },
  {
    family: 'coverage',
    appliesTo: 'asset',
    values: [
      { value: 'covered', label: 'Coverage: covered' },
      { value: 'gap', label: 'Coverage: gap' },
    ],
  },
  {
    family: 'health',
    appliesTo: 'asset',
    values: [
      { value: 'healthy', label: 'Health: healthy' },
      { value: 'unknown', label: 'Health: unknown' },
      { value: 'unmanaged', label: 'Health: unmanaged' },
    ],
  },
  {
    family: 'access',
    appliesTo: 'source',
    values: [
      { value: 'reachable', label: 'Access: reachable' },
      { value: 'connected', label: 'Access: connected' },
    ],
  },
  {
    family: 'sensitivity',
    appliesTo: 'source',
    values: [
      { value: 'normal', label: 'Sensitivity: normal' },
      { value: 'restricted', label: 'Sensitivity: restricted' },
    ],
  },
  {
    family: 'onboarding',
    appliesTo: 'source',
    values: [
      { value: 'discovered', label: 'Onboarding: discovered' },
      { value: 'onboarded', label: 'Onboarding: onboarded' },
    ],
  },
];

/** Parse the active `family=value` filters into a family→Set map. */
function activeByFamily(filters: readonly string[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const f of filters) {
    const eq = f.indexOf('=');
    if (eq < 0) continue;
    const family = f.slice(0, eq);
    const value = f.slice(eq + 1);
    if (!m.has(family)) m.set(family, new Set());
    m.get(family)!.add(value);
  }
  return m;
}

/** True iff `haystack` contains the (already lower-cased) query text (empty text matches everything). */
function textMatches(index: string, text: string): boolean {
  return text.length === 0 || index.includes(text);
}

// ── AGE + AUTHORITY reductions over the real service outputs ─────────────────────────────────────

function ageLabelFor(days: number): string {
  if (days < 0) return 'never observed';
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/** The AGE facet for a governed-asset row: observation age in days + a `stale` flag past the horizon. */
function assetAge(row: InventoryRow, now: EpochMillis): AssetAgeVM {
  const observedAt = row.lastObservationAt;
  if (observedAt === undefined) {
    return {
      observationAgeDays: -1,
      stale: row.evidenceState !== 'current',
      label: 'never observed',
    };
  }
  const ageMs = Math.max(0, now - observedAt);
  const days = Math.floor(ageMs / DAY_MS);
  // Stale iff the SERVICE says the evidence is not current OR the newest observation is past horizon.
  const stale = row.evidenceState !== 'current' || ageMs > HORIZON_MILLIS;
  return { observationAgeDays: days, stale, label: ageLabelFor(days) };
}

/** The AUTHORITY facet for a governed-asset row: named authoritative-field attributions + contested. */
function assetAuthority(dd: InventoryDrillDown): AssetAuthorityVM {
  // Map each authoritative-field attribution to a "field ← sourceClass" phrase.
  const classById = new Map<string, string>();
  for (const r of dd.sourceRecords) classById.set(String(r.catalogId), r.sourceClass);
  const attributions = dd.authoritativeFields.map((a) => {
    const cls = classById.get(String(a.authoritativeSourceId)) ?? String(a.authoritativeSourceId);
    return `${a.field} ← ${cls}`;
  });
  // A field is CONTESTED when two+ sources reported different values (AC3 status difference), and the
  // whole item's automation PAUSES iff any governed field is unresolved — both are service-computed.
  const contestedFields = dd.correlation.fields.filter((f) => f.contested).map((f) => f.field);
  const contested = dd.correlation.automationPaused || contestedFields.length > 0;
  const summary = contested
    ? `${attributions.length} authoritative field(s); ${contestedFields.length} contested (automation paused)`
    : attributions.length > 0
      ? `${attributions.length} authoritative field(s), none contested`
      : 'no authoritative source recorded';
  return {
    authoritativeFieldCount: attributions.length,
    attributions,
    contested,
    contestedFields,
    summary,
  };
}

/** The searchable text index for an asset row (lower-cased). */
function assetSearchIndex(b: InventoryRowVM): string {
  return [
    b.name,
    b.assetType,
    b.sourceIdentity,
    b.owner,
    b.lifecycleState,
    b.riskTier,
    b.controlCoverage,
    b.evidenceState,
    b.reportedHealth,
  ]
    .join(' ')
    .toLowerCase();
}

/** Does an asset base row satisfy the active FILTER families (text handled separately)? */
function assetSatisfiesFilters(
  b: InventoryRowVM,
  filters: Map<string, Set<string>>,
): { ok: boolean; reason: string } {
  const risk = filters.get('risk');
  if (risk && !risk.has(b.riskTier)) return { ok: false, reason: `risk!=${[...risk].join(',')}` };
  const coverage = filters.get('coverage');
  // The coverage facet label may be e.g. "gap (open component gap)" — match on the leading token.
  const coverageToken = b.controlCoverage.split(' ')[0];
  if (coverage && !coverage.has(coverageToken))
    return { ok: false, reason: `coverage!=${[...coverage].join(',')}` };
  const health = filters.get('health');
  if (health && !health.has(b.reportedHealth))
    return { ok: false, reason: `health!=${[...health].join(',')}` };
  return { ok: true, reason: '' };
}

// ── Source-catalog AGE + AUTHORITY ───────────────────────────────────────────────────────────────

function sourceAge(entry: SourceCatalogEntry, now: EpochMillis): SourceAgeVM {
  const discoveredDays = Math.floor(Math.max(0, now - entry.firstSeenAt) / DAY_MS);
  const lastSeenDays = Math.floor(Math.max(0, now - entry.lastSeenAt) / DAY_MS);
  return {
    discoveredAgeDays: discoveredDays,
    lastSeenAgeDays: lastSeenDays,
    label: `discovered ${ageLabelFor(discoveredDays)}, last seen ${ageLabelFor(lastSeenDays)}`,
  };
}

function sourceAuthority(base: DiscoveredSourceVM): SourceAuthorityVM {
  const classified = base.classification !== 'unknown';
  const ownershipGap = base.ownershipStatus.startsWith('unowned');
  const summary = `${classified ? `classified as ${base.classification}` : 'classification unknown'}; ${
    ownershipGap ? 'no accountable owner (ownership gap)' : `owned by ${base.ownershipStatus}`
  }`;
  return { classified, ownershipStatus: base.ownershipStatus, ownershipGap, summary };
}

function sourceSearchIndex(b: DiscoveredSourceVM, gap?: SourceGapVM): string {
  return [
    b.id,
    b.classification,
    b.location,
    b.accessStatus,
    b.sensitivity,
    b.onboardingState,
    b.ownershipStatus,
    gap?.reasonClass ?? '',
    gap?.reasonText ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function sourceSatisfiesFilters(
  b: DiscoveredSourceVM,
  filters: Map<string, Set<string>>,
): { ok: boolean; reason: string } {
  const access = filters.get('access');
  if (access && !access.has(b.accessStatus))
    return { ok: false, reason: `access!=${[...access].join(',')}` };
  const sensitivity = filters.get('sensitivity');
  if (sensitivity && !sensitivity.has(b.sensitivity))
    return { ok: false, reason: `sensitivity!=${[...sensitivity].join(',')}` };
  const onboarding = filters.get('onboarding');
  if (onboarding && !onboarding.has(b.onboardingState))
    return { ok: false, reason: `onboarding!=${[...onboarding].join(',')}` };
  return { ok: true, reason: '' };
}

// ── Assemble the asset table rows (every reconciled row, each once) ──────────────────────────────

function assetTableRows(
  svc: InventoryService,
  cs: CurrentStateModel,
  now: EpochMillis,
  text: string,
  filters: Map<string, Set<string>>,
): readonly AssetTableRowVM[] {
  const rows = svc.currentStateView(now);
  return rows.map((row): AssetTableRowVM => {
    // Reuse the vetted Phase-77 row→VM mapping by matching on asset id from the derived model where
    // present; otherwise construct the base VM fields the same way (stale/gapped rows are not in the
    // healthy `inventory` list but ARE in the full service view — the table shows ALL of them once).
    const base = baseVMFor(row, cs);
    const age = assetAge(row, now);
    const authority = assetAuthority(svc.drillDown(row.assetId, now));
    const searchIndex = assetSearchIndex(base);
    const filterCheck = assetSatisfiesFilters(base, filters);
    const textOk = textMatches(searchIndex, text);
    const matches = textOk && filterCheck.ok;
    const filteredOutReason = matches ? '' : !textOk ? `text!=${text}` : filterCheck.reason;
    return {
      base,
      age,
      authority,
      hasVisibleGap: row.hasVisibleComponentGap,
      searchIndex,
      matches,
      filteredOutReason,
    };
  });
}

/** The base InventoryRowVM for a service row — from the derived model if healthy, else built here. */
function baseVMFor(row: InventoryRow, cs: CurrentStateModel): InventoryRowVM {
  const fromModel =
    cs.inventory.find((r) => r.id === String(row.assetId)) ??
    (cs.stale && cs.stale.id === String(row.assetId) ? cs.stale : undefined);
  if (fromModel) return fromModel;
  // Gapped/unmanaged rows are not in the healthy list — build their VM the same shape.
  const coverageLabel = row.hasVisibleComponentGap
    ? 'gap (open component gap)'
    : row.coverage === 'covered'
      ? 'covered'
      : row.coverage === 'partial'
        ? 'partial'
        : 'gap';
  const isoOf = (ms: EpochMillis | undefined): string =>
    ms === undefined ? '—' : new Date(ms).toISOString();
  return {
    id: String(row.assetId),
    assetType: row.assetType,
    name: row.name,
    sourceIdentity: `svc/${row.assetType}/${row.name}`,
    owner: row.ownershipGap ? 'unowned (ownership gap)' : String(row.ownerPrincipalId ?? 'unowned'),
    lifecycleState: row.lifecycleState,
    riskTier: row.riskTier,
    controlCoverage: coverageLabel,
    evidenceState: row.evidenceState,
    reportedHealth: row.reportedHealth,
    observedHealth: row.observedHealth,
    confidence: row.confidence,
    lastObservedAt: isoOf(row.lastObservationAt),
    unresolvedIssues: row.unresolvedIssueCount,
    sourceRecordCount: row.sourceRecordCount,
  };
}

// ── Assemble the source table rows (every catalog entry, each once) ──────────────────────────────

function sourceTableRows(
  svc: InventoryService,
  cs: CurrentStateModel,
  now: EpochMillis,
  text: string,
  filters: Map<string, Set<string>>,
): readonly SourceTableRowVM[] {
  const catalog = svc.catalog();
  const gapBySubject = new Map<string, SourceGapVM>();
  for (const g of cs.sourceGaps) {
    // sourceGaps' `source` label encodes the subject id ("source/<subjectId>"); map back to it.
    const subjectId = g.source.replace(/^source\//, '');
    gapBySubject.set(subjectId, g);
  }
  return cs.discoveredSources.map((base): SourceTableRowVM => {
    const entry = catalog.find((e) => String(e.id) === base.id) as SourceCatalogEntry;
    const gap = gapBySubject.get(base.id);
    const age = sourceAge(entry, now);
    const authority = sourceAuthority(base);
    const searchIndex = sourceSearchIndex(base, gap);
    const filterCheck = sourceSatisfiesFilters(base, filters);
    const textOk = textMatches(searchIndex, text);
    const matches = textOk && filterCheck.ok;
    const filteredOutReason = matches ? '' : !textOk ? `text!=${text}` : filterCheck.reason;
    return { base, age, authority, gap, searchIndex, matches, filteredOutReason };
  });
}

// ── Filter chips (with active state) + query summary ─────────────────────────────────────────────

function buildFilterChips(active: Map<string, Set<string>>): readonly FilterChipVM[] {
  const chips: FilterChipVM[] = [];
  for (const fam of FILTER_FAMILIES) {
    for (const v of fam.values) {
      chips.push({
        facet: fam.family,
        value: v.value,
        label: v.label,
        active: active.get(fam.family)?.has(v.value) ?? false,
        appliesTo: fam.appliesTo,
      });
    }
  }
  return chips;
}

function queryState(
  text: string,
  activeFilters: readonly string[],
  assetRows: readonly AssetTableRowVM[],
  sourceRows: readonly SourceTableRowVM[],
): QueryStateVM {
  const assetVisible = assetRows.filter((r) => r.matches).length;
  const sourceVisible = sourceRows.filter((r) => r.matches).length;
  const q = text.length ? `matching "${text}"` : 'no text query';
  const f = activeFilters.length ? `filters [${activeFilters.join(', ')}]` : 'no filters';
  return {
    text,
    activeFilters: [...activeFilters],
    assetVisible,
    assetTotal: assetRows.length,
    sourceVisible,
    sourceTotal: sourceRows.length,
    resultSummary:
      `${assetVisible} of ${assetRows.length} governed asset(s) and ${sourceVisible} of ` +
      `${sourceRows.length} discovered source(s) match (${q}; ${f}). Hidden rows remain governed ` +
      `records with their filter reason.`,
  };
}

// ── The public derivation ────────────────────────────────────────────────────────────────────────

/**
 * DERIVE the inventory-table model from the REAL service at instant `now`, applying the officer's
 * `query` (free text + active `family=value` filters) to the service's own rows. Every field is a
 * projection of a value the service COMPUTED (reconciliation, correlation, freshness, catalog); the
 * search/filter membership is a pure function of the query over those rows.
 */
export function deriveInventoryTable(
  overrides: ScenarioOverrides = {},
  query: InventoryQuery = {},
  now: EpochMillis = T0,
): InventoryTableModel {
  const svc = buildService(overrides);
  const currentState = deriveModel(svc, now);

  const text = (query.text ?? '').toLowerCase();
  const activeFilters = query.filters ?? [];
  const filters = activeByFamily(activeFilters);

  const assetRows = assetTableRows(svc, currentState, now, text, filters);
  const sourceRows = sourceTableRows(svc, currentState, now, text, filters);
  const chips = buildFilterChips(filters);
  const q = queryState(text, activeFilters, assetRows, sourceRows);

  return {
    currentState,
    assetRows,
    sourceRows,
    filters: chips,
    query: q,
    generatedAtIso: new Date(now).toISOString(),
    snapshotDigest: svc.snapshotDigest(now),
  };
}

/** Convenience: the default (no-override, empty-query) inventory table at T0. */
export function defaultInventoryTable(now: EpochMillis = T0): InventoryTableModel {
  return deriveInventoryTable({}, {}, now);
}

/** Re-export the gap-age helper so specs can assert age independently of the view. */
export function gapAgeDays(gap: CoverageGap, now: EpochMillis): number {
  return Math.floor(gapAgeMillis(gap, now) / DAY_MS);
}
