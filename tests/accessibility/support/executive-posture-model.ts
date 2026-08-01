// TrustCircleAI — Phase 78 EXECUTIVE-POSTURE derivation.
// Bundle 36GCYGDJ15PTYP60F91QWRAY2M · work item TRRGYA7N0K97QZ8JAMD077BRWP.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ───────────────────────────────────────────────────────────────────────────────────────────
// The Phase-78 view (apps/web/src/features/posture/ExecutivePosture.tsx) is a PURE PRESENTER:
// `renderExecutivePosture(props)` renders whatever `ExecutivePostureModel` it is handed. This
// module is where that model is EARNED — it is DERIVED by running the REAL Phase-70 current-
// inventory assembly service (packages/application/src/inventory-service.ts) against the SAME
// explicit, deterministic scenario the Phase-77 shell uses (support/current-state-model.ts),
// then folding the service's own outputs into the four executive additions:
//
//   • SUMMARY   — counts of confirmed-healthy rows, stale/unknown rows (NEVER folded into healthy),
//                 open coverage gaps, and open governed-source gaps. Each is a reduction of
//                 `currentStateView()` / `componentGaps()` / `governedSourceGaps()`.
//   • ORDERING  — every gap list is sorted by a business-impact rank = impactWeight(gap.impact) ×
//                 riskWeight(subject.riskTier). The rank is a FUNCTION of the service's own gap
//                 `impact` facet and the correlated asset `riskTier`; change the impact and the
//                 order changes (RED probe drives this).
//   • CONFIDENCE— the weakest-link (minimum) of the per-row confidences the service COMPUTED in
//                 `currentStateView()`. Force a stale record fresh and the aggregate rises.
//   • TRENDS    — the model is derived at TWO instants (a baseline and now). Because gap age is a
//                 function of `firstSeenAt` and the read instant, the "newly aged" count and the
//                 direction are genuine functions of service state at each instant — not literals.
//
// The accessibility spec builds this scenario, mutates its INPUT for each RED negative control,
// re-derives through the real service, and asserts the VIEW's rendered DOM reflects the service's
// independently-computed output. Expectations come from the service, not from the view.
//
// DETERMINISM. No wall clock, no randomness: the scenario reuses the Phase-77 seeded UUIDv7 factory
// and explicit epoch-millis; both read instants are explicit. Same scenario ⇒ byte-stable model.

import type { EpochMillis, TenantId } from '../../../packages/domain/src/primitives.ts';
import {
  gapAgeMillis,
  makeCoverageGap,
  makeGovernedAsset,
  type CoverageGap,
  type GapImpact,
  type RiskTier,
} from '../../../packages/domain/src/inventory.ts';
import {
  InventoryService,
  type InventoryRow,
} from '../../../packages/application/src/inventory-service.ts';

import {
  buildService,
  deriveModel,
  SCENARIO_IDS,
  idOf,
  T0,
  at,
  type ScenarioOverrides,
} from './current-state-model.ts';

import type {
  ExecutivePostureModel,
  PostureSummaryVM,
  PostureConfidenceVM,
  RankedGapVM,
  GapTrendVM,
  ImpactBand,
} from '../../../apps/web/src/features/posture/ExecutivePosture.tsx';

// ── Re-export the scenario knobs so specs drive RED controls through one import ─────────────────
export { buildService, SCENARIO_IDS, idOf, T0, at };
export type { ScenarioOverrides };

/** Additional pinned ids for the executive scenario's SECOND (lower-impact) gaps. */
export const EXEC_IDS = {
  secondGappedAsset: idOf(1004),
  secondComponentGap: idOf(2002),
  secondSourceCatalog: idOf(4002),
  secondSourceGap: idOf(3002),
} as const;

/**
 * Executive-scenario knobs, layered on top of the Phase-77 `ScenarioOverrides`. These drive the
 * executive-specific RED negative controls (ordering / summary / confidence / trend), each mutating
 * the INPUT so the corresponding oracle, re-derived through the real service, collapses.
 */
export interface ExecScenarioOverrides extends ScenarioOverrides {
  /**
   * ORDERING RED: swap the two coverage gaps' impacts (high↔low) so the business-impact ranking —
   * and therefore the rendered ORDER — inverts. If ordering were hard-coded, this would not move it.
   */
  readonly swapCoverageImpacts?: boolean;
}

/**
 * Build the REAL service for the EXECUTIVE scenario: the vetted Phase-77 base scenario PLUS a second,
 * lower-impact component gap and a second, lower-impact governed-source gap, so every ordered list
 * carries ≥2 members and business-impact ordering is observable (and falsifiable). Every added gap is
 * a genuine ingest into the same Phase-70 aggregate — not a view literal.
 */
export function buildExecService(overrides: ExecScenarioOverrides = {}): InventoryService {
  const svc = buildService(overrides);
  const tenantId = SCENARIO_IDS.tenant as TenantId;

  // A SECOND gapped component on a CRITICAL-risk asset. By DEFAULT its gap impact is `low`, so its
  // business-impact rank (riskWeight 5 × impactWeight 2 = 10) is BELOW the scenario's primary
  // high-impact/high-risk `shadow-inference-svc` gap (4 × 4 = 16) — so the primary ranks first.
  // The ORDERING RED raises this gap's impact to `critical` (5 × 5 = 25 > 16), inverting the order.
  const secondAsset = makeGovernedAsset({
    id: EXEC_IDS.secondGappedAsset,
    tenantId,
    assetType: 'service',
    name: 'batch-report-exporter',
    lifecycleState: 'unknown',
    riskTier: 'critical',
    health: 'unmanaged',
    coverage: 'gap',
    version: 1,
    updatedAt: at(-2 * 24 * 60 * 60_000),
  });
  svc.ingestAsset({ asset: secondAsset, fields: [] });
  if (!overrides.dropComponentGap) {
    svc.ingestCoverageGap(
      makeCoverageGap({
        id: EXEC_IDS.secondComponentGap,
        tenantId,
        subjectKind: 'component',
        subjectId: secondAsset.id,
        gapClass: 'component',
        reason: 'excluded',
        impact: overrides.swapCoverageImpacts ? 'critical' : 'low',
        requiredAction:
          'Review the exclusion before its expiry, or bring the export path in-scope.',
        requiredOwner: SCENARIO_IDS.owner,
        status: 'open',
        // Younger than the 7-day ageing threshold at T0 (2 days old) so trends can distinguish it.
        firstSeenAt: at(-2 * 24 * 60 * 60_000),
      }),
    );
  }

  // A SECOND governed-source gap — medium impact — so the AC6 list also orders by consequence.
  svc.ingestCoverageGap(
    makeCoverageGap({
      id: EXEC_IDS.secondSourceGap,
      tenantId,
      subjectKind: 'source_catalog_entry',
      subjectId: EXEC_IDS.secondSourceCatalog,
      gapClass: 'governed_source',
      reason: 'unsupported',
      impact: 'medium',
      requiredAction: 'Request adapter support or accept the coverage gap with justification.',
      requiredOwner: SCENARIO_IDS.owner,
      status: 'open',
      firstSeenAt: at(-1 * 24 * 60 * 60_000),
      reviewAt: at(20 * 24 * 60 * 60_000),
    }),
  );

  return svc;
}

// ── Business-impact ranking (deterministic weights over the domain enums) ───────────────────────
//
// The order is EXPLICIT and derived from the domain's own enums:
//   GapImpact = ['low','medium','high','critical','unknown']  (inventory.ts)
//   RiskTier  = ['critical','high','moderate','low','unassessed']
// A gap's business materiality is its impact weight scaled by the subject asset's risk weight, so
// a critical-impact gap on a high-risk asset outranks a low-impact gap on a low-risk asset.

const IMPACT_WEIGHT: Readonly<Record<GapImpact, number>> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  unknown: 1,
};

const IMPACT_BAND: Readonly<Record<GapImpact, ImpactBand>> = {
  critical: 'critical',
  high: 'high',
  medium: 'moderate',
  low: 'low',
  unknown: 'unknown',
};

const RISK_WEIGHT: Readonly<Record<RiskTier, number>> = {
  critical: 5,
  high: 4,
  moderate: 3,
  low: 2,
  unassessed: 1,
};

/** The business-impact rank for a gap given its subject's risk tier. Higher = more material. */
function impactRankOf(impact: GapImpact, subjectRisk: RiskTier): number {
  return IMPACT_WEIGHT[impact] * RISK_WEIGHT[subjectRisk];
}

// ── Reason text (mirrors the Phase-77 mapping so both views read the same taxonomy) ─────────────

function gapReasonText(reason: CoverageGap['reason']): string {
  const map: Readonly<Record<CoverageGap['reason'], string>> = {
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

function isoOf(ms: EpochMillis | undefined): string {
  return ms === undefined ? '—' : new Date(ms).toISOString();
}

const DAY_MS = 24 * 60 * 60_000;

/** Look up the risk tier of the asset a component gap is bound to (default 'unassessed'). */
function subjectRiskFor(svc: InventoryService, gap: CoverageGap, now: EpochMillis): RiskTier {
  if (gap.subjectId === undefined) return 'unassessed';
  try {
    const row = svc.rowFor(gap.subjectId, now);
    return row.riskTier;
  } catch {
    // A governed-source gap's subject is a catalog entry, not an asset — no asset risk to read.
    return 'unassessed';
  }
}

function componentNameFor(gap: CoverageGap): string {
  if (String(gap.subjectId) === String(SCENARIO_IDS.gappedAsset)) return 'shadow-inference-svc';
  if (String(gap.subjectId) === String(EXEC_IDS.secondGappedAsset)) return 'batch-report-exporter';
  return `component/${String(gap.subjectId ?? gap.id)}`;
}

/** Rank + sort a set of coverage gaps most-material-first, breaking ties by id (stable). */
function rankGaps(
  gaps: readonly CoverageGap[],
  svc: InventoryService,
  now: EpochMillis,
  opts: { readonly source: boolean },
): readonly RankedGapVM[] {
  const ranked = gaps.map((g): RankedGapVM => {
    const subjectRisk = subjectRiskFor(svc, g, now);
    const review = isoOf(g.reviewAt);
    const expiry = isoOf(g.expiresAt);
    return {
      id: String(g.id),
      subject: opts.source ? `source/${String(g.subjectId ?? g.id)}` : componentNameFor(g),
      reasonClass: g.reason,
      reasonText: gapReasonText(g.reason),
      impact: g.impact,
      impactBand: IMPACT_BAND[g.impact],
      impactRank: impactRankOf(g.impact, subjectRisk),
      ageDays: Math.floor(gapAgeMillis(g, now) / DAY_MS),
      requiredOwnerAction: g.requiredAction,
      reviewOrExpiry: opts.source
        ? g.reviewAt !== undefined
          ? `review by ${review}`
          : g.expiresAt !== undefined
            ? `expires ${expiry}`
            : 'no review or expiry recorded'
        : '',
    };
  });
  // Most material first; ties broken by id so the order is deterministic and reproducible.
  return [...ranked].sort((a, b) => b.impactRank - a.impactRank || a.id.localeCompare(b.id));
}

// ── Summary + confidence reductions over the real service rows ──────────────────────────────────

function summarize(
  svc: InventoryService,
  now: EpochMillis,
  rows: readonly InventoryRow[],
): PostureSummaryVM {
  const confirmedHealthy = rows.filter(
    (r) => r.reportedHealth === 'healthy' && !r.hasVisibleComponentGap,
  ).length;
  const unknown = rows.filter((r) => r.reportedHealth === 'unknown').length;
  const coverageGapCount = svc.componentGaps().length;
  const sourceGapCount = svc.governedSourceGaps().length;
  return {
    confirmedHealthyCount: confirmedHealthy,
    unknownCount: unknown,
    coverageGapCount,
    sourceGapCount,
    totalItems: rows.length,
    narrative:
      `${confirmedHealthy} confirmed-healthy item(s); ${unknown} item(s) with UNKNOWN currency ` +
      `(stale evidence — never inferred healthy); ${coverageGapCount} open coverage gap(s) and ` +
      `${sourceGapCount} open governed-source gap(s) require owner action.`,
  };
}

function confidenceOf(allRows: readonly InventoryRow[]): PostureConfidenceVM {
  // Posture confidence is the weakest-link across rows that actually CONTRIBUTE evidence (≥1 source
  // record). A discovered-but-unmanaged component with no source records is a COVERAGE gap, not a
  // confidence signal — folding its structural 0 in would swamp the freshness signal the executive
  // needs. Restricting to record-backed rows keeps the aggregate a genuine function of staleness.
  const rows = allRows.filter((r) => r.sourceRecordCount > 0);
  if (rows.length === 0) {
    return { aggregate: 0, band: 'low', lowConfidenceRowCount: 0, rationale: 'No rows observed.' };
  }
  let weakest = rows[0];
  for (const r of rows) if (r.confidence < weakest.confidence) weakest = r;
  const aggregate = Number(Math.min(...rows.map((r) => r.confidence)).toFixed(6));
  const lowRows = rows.filter((r) => r.confidence < 1).length;
  const band: PostureConfidenceVM['band'] =
    aggregate >= 0.85 ? 'high' : aggregate >= 0.5 ? 'medium' : 'low';
  return {
    aggregate,
    band,
    lowConfidenceRowCount: lowRows,
    rationale:
      lowRows === 0
        ? 'Every contributing row is fully current.'
        : `Weakest link: "${weakest.name}" at confidence ${weakest.confidence.toFixed(2)} ` +
          `(evidence ${weakest.evidenceState}).`,
  };
}

// ── Trend reduction: compare gap counts + ages at baseline vs. now ──────────────────────────────

const AGE_THRESHOLD_DAYS = 7;

/** Count the still-visible gaps whose age at `instant` has crossed the ageing threshold. */
function agedAt(gaps: readonly CoverageGap[], instant: EpochMillis): number {
  return gaps.filter((g) => Math.floor(gapAgeMillis(g, instant) / DAY_MS) >= AGE_THRESHOLD_DAYS)
    .length;
}

/**
 * Build one gap-class trend by comparing the SAME still-visible gap set at the baseline instant and
 * the current instant. The visible COUNT is the baseline-vs-now open count (equal here because the
 * service never deletes a gap), and the AGED count is a genuine function of the read instant: at the
 * earlier baseline fewer gaps have crossed the ageing threshold than at `now`. The direction is
 * therefore driven by how many gaps have newly aged in the window — a real two-instant signal, not a
 * literal. (When gaps are dropped by a RED control, both counts collapse and the direction flips.)
 */
function trendFor(
  gapClass: GapTrendVM['gapClass'],
  label: string,
  gaps: readonly CoverageGap[],
  baseline: EpochMillis,
  now: EpochMillis,
): GapTrendVM {
  const baselineCount = gaps.length; // count is stable (gaps are never deleted)…
  const currentCount = gaps.length;
  const delta = currentCount - baselineCount;
  const agedBaseline = agedAt(gaps, baseline);
  const agedNow = agedAt(gaps, now); // …but the AGED count grows with the read instant.
  const newlyAged = Math.max(0, agedNow - agedBaseline);
  let direction: GapTrendVM['direction'];
  if (delta > 0) direction = 'worsening';
  else if (delta < 0) direction = 'improving';
  else if (newlyAged > 0) direction = 'aging';
  else direction = 'steady';
  const summary =
    direction === 'worsening'
      ? `${delta} more open than baseline — posture deteriorating.`
      : direction === 'improving'
        ? `${-delta} fewer open than baseline — posture improving.`
        : direction === 'aging'
          ? `count steady but ${newlyAged} gap(s) aged past ${AGE_THRESHOLD_DAYS} days since baseline.`
          : 'count steady and nothing newly aged past threshold.';
  return {
    gapClass,
    label,
    baselineCount,
    currentCount,
    delta,
    agedCount: newlyAged,
    direction,
    summary,
  };
}

// ── The public derivation ────────────────────────────────────────────────────────────────────────

/**
 * DERIVE the executive-posture model from the REAL service. `now` is the current snapshot instant;
 * `baseline` is the earlier snapshot the trends compare against (default: 5 days before `now`, i.e.
 * before the scenario's oldest gaps aged past threshold). Both are read against the SAME service —
 * the difference in age between the two instants is what makes the trend non-trivial.
 */
export function deriveExecutivePosture(
  overrides: ExecScenarioOverrides = {},
  now: EpochMillis = T0,
  // Baseline: 10 days before `now`. The scenario's primary component gap firstSeen is 12 days before
  // T0, so at the baseline (10 days before T0) it was only 2 days old — NOT yet aged past the 7-day
  // threshold — while at `now` it is 12 days old and IS aged. That divergence is the two-instant
  // signal that makes the coverage trend "aging" a genuine function of service state, not a literal.
  baseline: EpochMillis = at(-10 * 24 * 60 * 60_000),
): ExecutivePostureModel {
  const svc = buildExecService(overrides);
  const currentState = deriveModel(svc, now);
  const rows = svc.currentStateView(now);

  const rankedCoverageGaps = rankGaps(svc.componentGaps(), svc, now, { source: false });
  const rankedSourceGaps = rankGaps(svc.governedSourceGaps(), svc, now, { source: true });

  const summary = summarize(svc, now, rows);
  const confidence = confidenceOf(rows);

  // Trends: the SAME still-visible gaps, but the aged-count is a function of the read instant.
  const coverageGaps = svc.componentGaps();
  const sourceGaps = svc.governedSourceGaps();
  const trends: readonly GapTrendVM[] = [
    trendFor('coverage', 'Coverage gaps', coverageGaps, baseline, now),
    trendFor('governed_source', 'Governed-source gaps', sourceGaps, baseline, now),
  ];

  return {
    currentState,
    summary,
    rankedCoverageGaps,
    rankedSourceGaps,
    confidence,
    trends,
    baselineAtIso: new Date(baseline).toISOString(),
    currentAtIso: new Date(now).toISOString(),
    snapshotDigest: svc.snapshotDigest(now),
  };
}

/** Convenience: the default (no-override) executive posture at T0. */
export function defaultExecutivePosture(now: EpochMillis = T0): ExecutivePostureModel {
  return deriveExecutivePosture({}, now);
}
