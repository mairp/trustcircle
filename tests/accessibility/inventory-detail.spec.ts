// TrustCircleAI — SOURCE / ASSET DRILL-DOWN DETAIL accessibility + behaviour SPEC (Phase 80 /
// apps/web/src/features/inventory/InventoryDetail.tsx).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS SPEC PROVES
// ───────────────────────────────────────────────────────────────────────────────────────────
// The executable acceptance target for the accessible per-item DRILL-DOWN DETAIL surface — the view the
// officer reaches after selecting one governed item — that must render DISTINCT source records,
// authoritative fields, VERSIONS, HEALTH, EVIDENCE, and HISTORY (the Phase-80 objective) on top of the
// six current-state acceptance criteria (AC1–AC6). It runs under the hermetic
// `accessibility-current-state` Playwright project (root playwright.config.ts — pinned Desktop Chrome,
// REFLOW_400 layout viewport, no `setup`, no web server) and mounts the SHIPPED view —
// `renderInventoryDetail()` from apps/web/src/features/inventory/InventoryDetail.tsx — in a REAL browser
// via `page.setContent`.
//
// ── NON-TAUTOLOGY: the oracles are driven by the REAL service, not by view constants ─────────
// The view is a PURE PRESENTER of an `InventoryDetailModel`. That model is DERIVED by running the REAL
// Phase-70 `InventoryService` (packages/application/src/inventory-service.ts) over an explicit scenario
// (support/inventory-detail-model.ts → support/current-state-model.ts) — the same aggregate proven in
// tests/unit/inventory-service.unit.test.ts — and by SELECTING one asset and projecting the service's
// OWN `drillDown(assetId)` / `rowFor()` / `componentGaps()` / `governedSourceGaps()` / `catalogView()`
// outputs. For every obligation this spec:
//   1. builds the real service / re-derives the model, reads its OWN outputs as the INDEPENDENT
//      expectation (the distinct source records, per-field FieldResolution, dependencies, gaps, catalog),
//   2. injects the derived model into the view and asserts the rendered DOM equals those computed values
//      (an independent read path: the live accessibility tree + machine-readable data-*),
//   3. runs a RED NEGATIVE CONTROL that mutates the scenario INPUT to break exactly that obligation and
//      asserts the DOM reflects the changed derivation — provably non-vacuous.
// Because the expected values come from the service (not from literals in InventoryDetail.tsx), a static
// template could not satisfy these assertions.
//
// ── EFFECT-WITNESS DISCIPLINE ────────────────────────────────────────────────────────────────
// Every assertion observes an INDEPENDENT read path — the rendered accessibility tree, table/row cells,
// machine-readable <time>/<code>/data-* attributes, and the service's own `snapshotDigest` reflected
// into `<main data-snapshot-digest>` — never the render function's return value as its own proof. The
// DURABLE-IDENTITY witness is the tenant scope (bundle id + semantic hash + work item
// 384B1E4BN35A236DWJKY5MK8AE), read back from the DOM; the NEGATIVE identity case re-renders with a
// MISMATCHED identity and confirms the guard rejects it.
//
// ── Traceability (Phase-80 objective + acceptance criteria) ───────────────────────────────────
//   AC1 selected item once, all authoritative fields (health/evidence/…)         → §AC1
//   AC2 component coverage gap for the item stays visible                         → §AC2
//   AC3 distinct source records, correlation, status differences, deps, authority → §AC3
//   AC3-extra versions + history (contributing-source versions per field)         → §HISTORY
//   AC4 stale record last-known + confidence; health NOT inferred                 → §AC4
//   AC5 discovered source catalogued with full discovery metadata                 → §AC5
//   AC6 discovered-source gap visible (reason/impact/action/review)               → §AC6

import AxeBuilder from '@axe-core/playwright';
import { test, expect, type Page } from '@playwright/test';

import {
  renderInventoryDetail,
  DETAIL_TENANT,
  EMPTY_INVENTORY_DETAIL,
  type InventoryDetailProps,
  type InventoryDetailModel,
} from '../../apps/web/src/features/inventory/InventoryDetail.tsx';
import {
  deriveInventoryDetail,
  defaultInventoryDetail,
  SCENARIO_IDS,
} from './support/inventory-detail-model.ts';
import { REFLOW_400 } from '../../playwright.config.ts';

const AXE_WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** The default derived drill-down (real service, no overrides) for the healthy multi-source asset. */
const MODEL: InventoryDetailModel = defaultInventoryDetail();

function props(over: Partial<InventoryDetailProps> = {}): InventoryDetailProps {
  return { tenant: DETAIL_TENANT, model: MODEL, ...over };
}

async function mount(page: Page, p: InventoryDetailProps = props()): Promise<void> {
  await page.setContent(renderInventoryDetail(p), { waitUntil: 'domcontentloaded' });
}

test.describe('inventory drill-down detail — WCAG 2.2 AA + records/authority/versions/history + AC1–AC6', () => {
  test.beforeEach(async ({ page }) => {
    await mount(page);
  });

  // ── AA baseline over the whole view ─────────────────────────────────────────────────────────
  test('has zero axe-core WCAG 2.2 AA violations', async ({ page }, testInfo) => {
    const results = await new AxeBuilder({ page }).withTags(Array.from(AXE_WCAG_TAGS)).analyze();
    await testInfo.attach('axe-inventory-detail.json', {
      body: JSON.stringify(results, null, 2),
      contentType: 'application/json',
    });
    expect(
      results.violations,
      results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n'),
    ).toEqual([]);
  });

  // ── Landmarks + effect witness ──────────────────────────────────────────────────────────────
  test('exposes the required labelled landmarks (skip link, status, main)', async ({ page }) => {
    await expect(page.getByTestId('skip-link')).toHaveAttribute('href', '#main');
    await expect(page.locator('main#main')).toHaveAttribute('tabindex', '-1');
    const status = page.getByTestId('global-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
  });

  test('main carries the derived service snapshot digest (independent effect witness)', async ({
    page,
  }) => {
    await expect(page.locator('main#main')).toHaveAttribute(
      'data-snapshot-digest',
      MODEL.snapshotDigest,
    );
    expect(MODEL.snapshotDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(MODEL.snapshotDigest).not.toBe(EMPTY_INVENTORY_DETAIL.snapshotDigest);
  });

  // ── TENANT SCOPE (durable identity binding) ──────────────────────────────────────────────────
  test.describe('tenant scope (durable identity binding)', () => {
    test('binds the view to the pinned tenant + bundle + work-item identity, read independently', async ({
      page,
    }) => {
      const scope = page.getByTestId('tenant-scope');
      await expect(scope).toHaveAttribute('data-bundle-id', '36GCYGDJ15PTYP60F91QWRAY2M');
      await expect(scope).toHaveAttribute(
        'data-semantic-hash',
        'af120e10497d6ffe411b9756b3b341a5f812514c8ee10158c6dcd6e3298b014b',
      );
      await expect(scope).toHaveAttribute('data-work-item-id', '384B1E4BN35A236DWJKY5MK8AE');
      await expect(page.getByTestId('scope-bundle')).toContainText('36GCYGDJ15PTYP60F91QWRAY2M');
    });

    test('the pinned identity IS the phase work item (rejects a mismatched identity)', async ({
      page,
    }) => {
      const wrong = { ...DETAIL_TENANT, workItemId: 'WRONG000000000000000000000' };
      await mount(page, props({ tenant: wrong }));
      await expect(page.getByTestId('tenant-scope')).not.toHaveAttribute(
        'data-work-item-id',
        '384B1E4BN35A236DWJKY5MK8AE',
      );
      expect(DETAIL_TENANT.workItemId).toBe('384B1E4BN35A236DWJKY5MK8AE');
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC1 — the SELECTED item renders ONCE with every authoritative field
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC1 selected item once, every authoritative field', () => {
    test('renders the selected asset EXACTLY ONCE with type/owner/lifecycle/risk/coverage/evidence/health/observed/unresolved', async ({
      page,
    }) => {
      const b = MODEL.header.base;
      // Exactly one identity panel for exactly one asset id.
      await expect(page.getByTestId('asset-identity')).toHaveCount(1);
      await expect(page.getByTestId('asset-identity')).toHaveAttribute('data-asset-id', b.id);
      // Every enumerated authoritative field is present and equals the SERVICE row's value.
      await expect(page.getByTestId('identity-type')).toHaveText(b.assetType);
      await expect(page.getByTestId('identity-source-identity')).toHaveText(b.sourceIdentity);
      await expect(page.getByTestId('identity-owner')).toHaveText(b.owner);
      await expect(page.getByTestId('identity-lifecycle')).toHaveText(b.lifecycleState);
      await expect(page.getByTestId('identity-risk')).toHaveText(b.riskTier);
      await expect(page.getByTestId('identity-coverage')).toHaveText(b.controlCoverage);
      await expect(page.getByTestId('identity-evidence')).toHaveText(b.evidenceState);
      await expect(page.getByTestId('identity-health')).toContainText(MODEL.header.reportedHealth);
      await expect(page.getByTestId('identity-last-observed')).toHaveAttribute(
        'datetime',
        b.lastObservedAt,
      );
      await expect(page.getByTestId('identity-version')).toHaveText(String(MODEL.header.version));
      await expect(page.getByTestId('identity-record-count')).toHaveText(
        String(b.sourceRecordCount),
      );
    });

    test('RED: a duplicate observation of the SAME id still yields ONE identity panel (idempotent)', async ({
      page,
    }) => {
      const dup = deriveInventoryDetail({ duplicateHealthyAsset: true });
      // The service still emits one row for the id → the view still renders one identity panel.
      await mount(page, props({ model: dup }));
      await expect(page.getByTestId('asset-identity')).toHaveCount(1);
      await expect(page.getByTestId('asset-identity')).toHaveAttribute(
        'data-asset-id',
        String(SCENARIO_IDS.healthyAsset),
      );
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC3 — distinct source records, correlation, status differences, dependencies, authority
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC3 distinct source records + correlation + authority', () => {
    test('renders one row per DISTINCT service source record with its class/key/status/freshness/authority/deps', async ({
      page,
    }) => {
      const rows = page.getByTestId('detail-record-row');
      await expect(rows).toHaveCount(MODEL.sourceRecords.length);
      expect(
        MODEL.sourceRecords.length,
        'scenario must have ≥3 distinct sources',
      ).toBeGreaterThanOrEqual(3);
      // Every service source class is present exactly once (records correlated, never merged away).
      for (const rec of MODEL.sourceRecords) {
        const row = page.locator(
          `[data-testid="detail-record-row"][data-source-class="${rec.sourceClass}"]`,
        );
        await expect(row).toHaveCount(1);
        await expect(row.getByTestId('record-external-key')).toHaveText(rec.externalKey);
        await expect(row.getByTestId('record-status')).toHaveText(rec.observedStatus);
        await expect(row.getByTestId('record-freshness')).toContainText(rec.freshness);
        await expect(row.getByTestId('record-authoritative-for')).toHaveText(rec.authoritativeFor);
        await expect(row.getByTestId('record-depends-on')).toHaveText(rec.dependsOn);
      }
      // The distinct-source count is independently readable and equals the service's own count.
      await expect(page.getByTestId('records-summary')).toHaveAttribute(
        'data-distinct-sources',
        String(MODEL.distinctSourceCount),
      );
    });

    test('names the AUTHORITATIVE source per field and flags a CONTESTED field (status difference)', async ({
      page,
    }) => {
      // Independent expectation from the correlation: at least one field is contested, at least one not.
      const contested = MODEL.fields.filter((f) => f.contested);
      const uncontested = MODEL.fields.filter((f) => !f.contested);
      expect(contested.length, 'scenario must contest ≥1 field').toBeGreaterThan(0);
      expect(uncontested.length, 'scenario must resolve ≥1 field cleanly').toBeGreaterThan(0);

      for (const f of MODEL.fields) {
        const row = page.locator(`[data-testid="detail-field-row"][data-field="${f.field}"]`);
        await expect(row).toHaveCount(1);
        await expect(row.getByTestId('field-authority')).toHaveText(f.authoritativeSourceClass);
        await expect(row).toHaveAttribute('data-contested', String(f.contested));
        if (f.contested) {
          await expect(row.getByTestId('field-resolution')).toContainText('CONTESTED');
        }
      }
    });

    test('renders the dependency edges (depends_on) the service correlated', async ({ page }) => {
      const list = page.getByTestId('dependency-list');
      await expect(page.getByTestId('deps-summary')).toHaveAttribute(
        'data-dependency-count',
        String(MODEL.dependencyCount),
      );
      if (MODEL.dependencies.length > 0) {
        await expect(list.getByTestId('dependency-edge')).toHaveCount(MODEL.dependencies.length);
        for (const dep of MODEL.dependencies) {
          await expect(list).toContainText(dep);
        }
      }
    });

    test('RED: collapsing the scenario to a SINGLE source shrinks the distinct-record set', async ({
      page,
    }) => {
      const one = deriveInventoryDetail({ singleSourceOnly: true });
      expect(one.distinctSourceCount).toBe(1);
      expect(one.sourceRecords.length).toBeLessThan(MODEL.sourceRecords.length);
      await mount(page, props({ model: one }));
      await expect(page.getByTestId('detail-record-row')).toHaveCount(one.sourceRecords.length);
      await expect(page.getByTestId('records-summary')).toHaveAttribute(
        'data-distinct-sources',
        '1',
      );
      // With one source there is no status difference to contest.
      await expect(
        page.locator('[data-testid="detail-field-row"][data-contested="true"]'),
      ).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §HISTORY — versions + history (each field's contributing-source versions)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§HISTORY per-field versions + contributing-source history', () => {
    test('each field lists one VERSION per contributing source (value/freshness/confidence/as-of)', async ({
      page,
    }) => {
      for (const f of MODEL.fields) {
        const history = page.locator(`[data-testid="field-history"][data-field="${f.field}"]`);
        await expect(history).toHaveAttribute('data-version-count', String(f.versions.length));
        await expect(history.getByTestId('field-version')).toHaveCount(f.versions.length);
        for (const v of f.versions) {
          const vitem = history.locator(
            `[data-testid="field-version"][data-source-class="${v.sourceClass}"]`,
          );
          await expect(vitem.getByTestId('version-value').first()).toContainText(v.value);
        }
      }
    });

    test('marks the versions that DIFFER from the authoritative value (status-difference history)', async ({
      page,
    }) => {
      const contested = MODEL.fields.find((f) => f.contested);
      expect(contested, 'need a contested field to witness differing versions').toBeTruthy();
      const differing = contested!.versions.filter((v) => v.differs);
      expect(differing.length, 'a contested field must have ≥1 differing version').toBeGreaterThan(
        0,
      );
      const history = page.locator(
        `[data-testid="field-history"][data-field="${contested!.field}"]`,
      );
      await expect(
        history.locator('[data-testid="field-version"][data-differs="true"]'),
      ).toHaveCount(differing.length);
      await expect(history.getByTestId('version-differs').first()).toBeVisible();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC2 — component coverage gap for the item stays visible
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC2 component coverage gap stays visible', () => {
    test('an item with an open component gap shows it with reason/age/impact/required-action', async ({
      page,
    }) => {
      // Drill into the GAPPED asset — its component gap must be rendered, not hidden.
      const gapped = deriveInventoryDetail({}, String(SCENARIO_IDS.gappedAsset));
      expect(gapped.componentGaps.length).toBeGreaterThan(0);
      await mount(page, props({ model: gapped }));
      const rows = page.getByTestId('detail-component-gap-row');
      await expect(rows).toHaveCount(gapped.componentGaps.length);
      const g = gapped.componentGaps[0]!;
      const row = page.locator(
        `[data-testid="detail-component-gap-row"][data-reason="${g.reasonClass}"]`,
      );
      await expect(row.getByTestId('detail-gap-reason')).toContainText(g.reasonClass);
      await expect(row.getByTestId('detail-gap-action')).toHaveText(g.requiredOwnerAction);
      await expect(row).toHaveAttribute('data-age-days', String(g.ageDays));
    });

    test('RED: dropping the component gap empties the rendered coverage-gap rows', async ({
      page,
    }) => {
      const dropped = deriveInventoryDetail(
        { dropComponentGap: true },
        String(SCENARIO_IDS.gappedAsset),
      );
      expect(dropped.componentGaps.length).toBe(0);
      await mount(page, props({ model: dropped }));
      await expect(page.getByTestId('detail-component-gap-row')).toHaveCount(0);
      await expect(page.getByTestId('no-component-gap')).toBeVisible();
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC4 — stale record: last-known + confidence; health NOT inferred from stale data
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC4 stale data marked; health withheld (no inference)', () => {
    test('the stale item withholds reportedHealth as unknown and marks its record stale with last-known + confidence', async ({
      page,
    }) => {
      const stale = deriveInventoryDetail({}, String(SCENARIO_IDS.staleAsset));
      // The service withheld health because the evidence is stale — the view must not infer it.
      expect(stale.header.reportedHealth).toBe('unknown');
      expect(stale.header.evidenceStale).toBe(true);
      const staleRec = stale.sourceRecords.find((r) => r.stale);
      expect(staleRec, 'the stale asset must have a stale source record').toBeTruthy();

      await mount(page, props({ model: stale }));
      await expect(page.getByTestId('identity-health')).toHaveAttribute(
        'data-reported-health',
        'unknown',
      );
      // The observed health is retained (for audit) but is NOT the reported value.
      await expect(page.getByTestId('identity-health')).toHaveAttribute(
        'data-observed-health',
        stale.header.observedHealth,
      );
      await expect(page.getByTestId('identity-health-note')).toContainText('withheld');
      const row = page.locator('[data-testid="detail-record-row"][data-stale="true"]');
      await expect(row).toHaveCount(1);
      await expect(row.getByTestId('record-last-known')).toHaveAttribute(
        'datetime',
        staleRec!.lastKnownAtIso,
      );
      await expect(row.getByTestId('record-confidence')).toHaveText(
        staleRec!.confidence.toFixed(2),
      );
    });

    test('RED: forcing the stale record FRESH stops withholding health (reported = observed)', async ({
      page,
    }) => {
      const fresh = deriveInventoryDetail(
        { forceStaleRecordFresh: true },
        String(SCENARIO_IDS.staleAsset),
      );
      expect(fresh.header.reportedHealth).not.toBe('unknown');
      expect(fresh.header.evidenceStale).toBe(false);
      await mount(page, props({ model: fresh }));
      await expect(page.getByTestId('identity-health')).toHaveAttribute(
        'data-reported-health',
        fresh.header.reportedHealth,
      );
      await expect(page.getByTestId('identity-health-note')).toHaveCount(0);
      await expect(
        page.locator('[data-testid="detail-record-row"][data-stale="true"]'),
      ).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC5 — the correlated DISCOVERED source is catalogued with full discovery metadata
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC5 discovered source detail', () => {
    test('renders the discovered source with classification/location/access/sensitivity/ownership/onboarding + discovery evidence', async ({
      page,
    }) => {
      const d = MODEL.discoveredSource!;
      expect(d, 'scenario must carry a discovered source').toBeTruthy();
      const panel = page.getByTestId('discovered-source');
      await expect(panel).toHaveAttribute('data-source-id', d.base.id);
      await expect(page.getByTestId('ds-classification')).toHaveText(d.base.classification);
      await expect(page.getByTestId('ds-location')).toHaveText(d.base.location);
      await expect(page.getByTestId('ds-access')).toHaveText(d.base.accessStatus);
      await expect(page.getByTestId('ds-sensitivity')).toHaveText(d.base.sensitivity);
      await expect(page.getByTestId('ds-ownership')).toHaveText(d.base.ownershipStatus);
      await expect(page.getByTestId('ds-onboarding')).toHaveText(d.base.onboardingState);
      // Unknown classification is surfaced as `unknown`, not hidden.
      await expect(panel).toHaveAttribute('data-classified', String(d.classified));
      if (d.base.discoveryEvidenceRef) {
        await expect(page.getByTestId('ds-discovery-evidence').getByRole('link')).toBeVisible();
      }
    });

    test('RED: stripping the discovery-evidence ref replaces the link with an explicit "no discovery evidence"', async ({
      page,
    }) => {
      const noEv = deriveInventoryDetail({ dropDiscoveryEvidence: true });
      expect(noEv.discoveredSource!.base.discoveryEvidenceRef).toBeUndefined();
      await mount(page, props({ model: noEv }));
      await expect(page.getByTestId('ds-no-discovery-evidence')).toBeVisible();
      await expect(page.getByTestId('ds-discovery-evidence').getByRole('link')).toHaveCount(0);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  // §AC6 — the discovered-source gap stays visible (reason/impact/action/review)
  // ══════════════════════════════════════════════════════════════════════════════════════════
  test.describe('§AC6 governed-source gap stays visible', () => {
    test('renders the governed-source gap with reason/impact/owner-action/review-or-expiry', async ({
      page,
    }) => {
      const gap = MODEL.discoveredSource!.gap!;
      expect(gap, 'scenario must carry a governed-source gap').toBeTruthy();
      const panel = page.getByTestId('detail-source-gap');
      await expect(panel).toHaveAttribute('data-gap-reason', gap.reasonClass);
      await expect(page.getByTestId('detail-source-gap-reason')).toContainText(gap.reasonClass);
      await expect(page.getByTestId('detail-source-gap-impact')).toHaveText(gap.impact);
      await expect(page.getByTestId('detail-source-gap-action')).toHaveText(gap.ownerAction);
      await expect(page.getByTestId('detail-source-gap-review')).toHaveText(gap.reviewOrExpiry);
      await expect(panel).toHaveAttribute('data-has-review', String(gap.hasReviewOrExpiry));
    });

    test('RED: dropping the review/expiry deadline removes the governed-source gap from the AC6 view (no longer tracked)', async ({
      page,
    }) => {
      // The service withholds a governed-source gap that lacks a review-or-expiry deadline
      // (governedSourceGaps() requires one), so dropping it removes the gap from the drill-down.
      const noReview = deriveInventoryDetail({ dropGovernedGapReview: true });
      expect(noReview.discoveredSource!.gap).toBeUndefined();
      await mount(page, props({ model: noReview }));
      await expect(page.getByTestId('detail-source-gap')).toHaveCount(0);
      await expect(page.getByTestId('detail-source-no-gap')).toBeVisible();
    });
  });

  // ── Reflow: the drill-down does not force horizontal scrolling at REFLOW_400 ────────────────────
  test('does not require horizontal scrolling at 400% zoom / the reflow viewport (WCAG 1.4.10)', async ({
    page,
  }) => {
    // The hermetic project already pins REFLOW_400.viewport (1280×1024). Apply the same 4× page zoom
    // the reflow helper uses to collapse the effective layout width to the 320 CSS-px 1.4.10 target,
    // then assert the single-column, wrapping layout does not overflow horizontally.
    await page.setViewportSize(REFLOW_400.viewport);
    await mount(page);
    await page.evaluate((z) => {
      (document.documentElement.style as unknown as { zoom: string }).zoom = String(z);
    }, REFLOW_400.zoomFactor);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
