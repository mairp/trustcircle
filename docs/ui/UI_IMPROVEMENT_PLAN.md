# Operator console: UI improvement plan

Sources: three research passes over `apps/web`. They covered (1) information architecture and
persona workflows, (2) the visual design system and accessibility, and (3) an external benchmark
against AI-governance and GRC products. Paths are relative to `apps/web/src/` unless they start
with `public/` or `tests/`.

Status key: **done** (applied in this change) · **next** (scheduled) · **later**.

## Headline findings

1. **The richest screens were not on any live route.** (Decisions now are: `/decisions` and `/decisions/[decisionId]`.) `features/decisions/*` (inbox, detail,
   actions, delegation, joint status), `features/posture/ExecutivePosture.tsx` and
   `features/audit/AuditExplorer.tsx` are rendered only by tests through `page.setContent`. As a
   result, approvers cannot act on a decision in the shipped app, and executives get a generic list.
2. **There are two design systems.** The shipped console uses colour tokens in `public/*.css`, with
   dark mode. The 21 `features/*` string renderers carry their own copy-pasted `<style>` blocks,
   with no tokens and light mode only.
3. **Accessibility tests mostly check the unshipped renderers.** 13 of 16 specs mount string
   renderers. Only the light theme of `/` is scanned with axe on the real app.
4. **The design is honest by default, with one exception.** `features/compliance/claim-labels.ts`
   enforces "readiness, never certification". However, the console summary counted unknown section
   counts as zero (fixed below).

## P0

| #   | Change                                                                                                                                                                                                                                                                                                                                         | Where                                                                 | Effort | Status   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ | -------- |
| 1   | Unknown section counts are no longer counted as 0. The total shows as "≥N (k uncounted)", and "No governed resources" is never claimed while counts are unknown                                                                                                                                                                                | `components/degraded-state.tsx`                                       | S      | **done** |
| 2   | Dark `--quiet` raised to `#8a978f` (≥4.8:1 on all dark panels)                                                                                                                                                                                                                                                                                 | `public/console.css`                                                  | S      | **done** |
| 3   | New `--border-control` token (≥3:1, WCAG 1.4.11) for input, textarea and button borders                                                                                                                                                                                                                                                        | `public/console.css`, `public/platform-workspaces.css`                | S      | **done** |
| 4   | Operations dead ends: the filter form and "Clear filters" go to `/operations`, and server actions revalidate `/operations`                                                                                                                                                                                                                     | `features/operations/AttentionQueue.tsx`, `app/operations/actions.ts` | S      | **done** |
| 5   | Decisions on live routes: an inbox table at `/decisions` and the full package at `/decisions/[decisionId]`, with reasoned approve, deny, request changes, escalate, delegate and withdraw forms bound to the package ETag through server actions. Self-approval, read-only roles, closed and expired packages are explained, not just disabled | `app/decisions/*`, `components/decisions/*`, `lib/decision-view.ts`   | L      | **done** |
| 6   | Record detail routes: `/[workspace]/[recordId]` replaces the dead `?record=` links, and Asset 360 related records become links                                                                                                                                                                                                                 | `components/governance-status.tsx`, `components/asset-360.tsx`        | M      | next     |
| 7   | Auditor evidence flow: package list with status, download, and verify-by-selection instead of typing a UUID                                                                                                                                                                                                                                    | `components/governed-platform-workspace.tsx`                          | M      | next     |
| 8   | Run axe against real routes in both themes and for each role, plus a unit test of the token contrast matrix                                                                                                                                                                                                                                    | `tests/accessibility/operator-console.spec.ts`                        | M      | next     |
| 9   | Operations source links currently go to raw `/v1/...` API URLs; map them to UI routes                                                                                                                                                                                                                                                          | `features/operations/AttentionQueue.tsx`, `lib/operations-loader.ts`  | S      | next     |

## P1

| #   | Change                                                                                                               | Where                                                                      | Effort | Status   |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------ | -------- |
| 10  | Focus ring covers `input`, `select`, `textarea` and `summary` through one `--focus-ring` token                       | `public/console.css`, `public/platform-workspaces.css`                     | S      | **done** |
| 11  | Theme toggle is a `role="switch"` with `aria-checked`, and its visible label equals its accessible name (WCAG 2.5.3) | `components/theme-toggle.tsx`                                              | S      | **done** |
| 12  | Live region narrowed from the whole summary to its status line                                                       | `components/degraded-state.tsx`                                            | S      | **done** |
| 13  | Executive role and view: render `ExecutivePosture` on `/posture` with AI asset count and status above the fold       | `lib/session-context.ts`, `lib/platform-workspaces.ts`                     | M      | next     |
| 14  | Filter, sort and page bar on every domain page (fixes `/inventory?q=ai`, which ignores `q` today)                    | `components/workspace-overview.tsx`, `components/capability-workspace.tsx` | M      | next     |
| 15  | Links filtered by role, plus a "Not permitted" page that is distinct from 404                                        | `components/capability-workspace.tsx`, `components/role-dashboard.tsx`     | S      | next     |
| 16  | Three-level breadcrumbs (Workspace › Record)                                                                         | `components/operator-shell.tsx`                                            | S      | next     |
| 17  | `loading.tsx` per segment, and an in-frame `error.tsx` that says whether a read or a command failed                  | `app/`                                                                     | S      | next     |
| 18  | One status token per state; show unknown as neutral plus a hatch or icon, never as red                               | `public/console.css`                                                       | S      | next     |
| 19  | Spacing, type, radius and breakpoint token scale to replace 32 font sizes, 35 gaps, 15 radii and 5 breakpoints       | `public/*.css`                                                             | M      | later    |
| 20  | Link the stylesheets directly instead of through a sequential `@import` chain                                        | `app/layout.tsx`                                                           | S      | next     |

## P2

- One terminology set routed through `i18n/catalog.ts`. The catalog has no importers today, and
  most concepts have two or three names.
- **done:** the `/` search shortcut now works (`components/search-shortcut.tsx`).
- Retire the legacy `SHELL_NAV` / `renderAppShell` in `app/layout.tsx` and point the
  accessibility specs at the live shell.
- **done (Trends):** relative ages ("6 h ago") with the ISO timestamp kept as `<time>` and tooltip. Other pages are still to do.
- Delete `src/app/globals.css`, which is unused and wrongly claims to mirror `public/console.css`.
- Re-run the usability study against the live routes.

## Target information architecture (from the benchmark)

```
SIDEBAR (grouped by job)            HOME (role dashboard)
Home                                ┌ NEEDS YOUR ACTION ───────────────────────────────┐
My inbox (decisions)  3             │ approvals awaiting you · evidence expiring ≤14d   │
GOVERN                              │ failing controls · discovered AI awaiting triage  │
  AI inventory (+ discovery)        └───────────────────────────────────────────────────┘
  AI lifecycle / use cases          ┌ READINESS (internal, not certification) ─────────┐
  Risk & exception registers        │ ISO/IEC 42001  61%  23 open · 4 indeterminate  →  │
  Decisions & approvals             │ EU AI Act      44%  applicability: 3 high-risk →  │
ASSURE                              │ NIST AI RMF    72%  9 open                     →  │
  Framework readiness (matrix)      └───────────────────────────────────────────────────┘
  Coverage gaps · Evidence · Audit  ┌ INVENTORY ──────────┐┌ CONTROL MONITORING ─────────┐
OPERATE                             │ assets by risk tier ││ failing-test trend, cases   │
  Operations · Controls · Integrity │ lifecycle stages    ││ connector health            │
INSIGHT                             └─────────────────────┘└─────────────────────────────┘
  Posture (exec) · Trends · Copilot · Search
```

## Patterns to adopt

| Pattern                                                                                                                             | Seen in                          | Applies to                  |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------- |
| Per-framework readiness cards that open the filtered control list, with indeterminate items counted separately and never as passing | Drata                            | `/compliance`, posture      |
| Per-control progress bar broken down by evidence, monitoring, policy and approval                                                   | Drata                            | `CoverageView`              |
| Recommended actions as the first thing on Home                                                                                      | ServiceNow AI Control Tower      | `/`, `AttentionQueue`       |
| Use-case intake that becomes a lifecycle tracker                                                                                    | IBM watsonx.governance, Collibra | `/ai-governance`, Asset 360 |
| Generated factsheet for each AI asset                                                                                               | IBM AI Factsheets                | `/assets/[assetId]`         |
| One control mapped to many frameworks, shown as a matrix                                                                            | Vanta, Credo AI                  | `/compliance`               |
| A separate rating for each risk dimension instead of one blended score                                                              | Holistic AI                      | `/registers`, inventory     |
| Discovered "shadow AI" waits in a triage inbox before it enters the inventory                                                       | Holistic AI, ServiceNow          | discovery → inventory       |

## Anti-patterns to avoid

- "Compliant", "Certified" or "100% ISO 42001" badges, or a green check next to a framework.
- A single blended score that counts untested or erroring items as passing.
- Templated or pre-filled evidence that looks like collected evidence.
- Red/amber/green status shown by colour alone, or "unknown" drawn in red.
- Hiding frameworks at 0%: for readiness, an in-scope framework at 0% is the most important item.
- Disabled approve buttons with no reason. Say "you prepared this package" instead.
