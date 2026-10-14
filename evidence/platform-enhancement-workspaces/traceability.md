# Traceability: Platform Enhancement Workspaces

| Requirement     | Implementation                                                                                | Verification                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| FR-001–FR-003   | `platform-workspaces.ts`, `operator-shell.tsx`, `[workspace]/page.tsx`, `operations/page.tsx` | `platform-workspaces.test.ts`, operator console browser suites, session boundary tests                                          |
| FR-004–FR-007   | `platform-workspaces.ts`, `discovery-workspace.tsx`, `saved-view-control.tsx`                 | discovery unit tests, search browser journey                                                                                    |
| FR-008–FR-010   | `governance-status.tsx`, `relatedAssetRecords`, `asset-360.tsx`, `assets/[assetId]/page.tsx`  | exact/collision relationship unit controls, degraded stable-link browser journey, route production build                        |
| FR-011–FR-013   | `classifyRecordStatus`, `statusExplanation`, `workspace-overview.tsx`                         | explainable-status unit tests, inventory degraded browser journey                                                               |
| FR-014–FR-015   | `operator-shell.tsx`, `platform-workspaces.css`, canonical `reflow.ts` helper                 | root/inventory/search/trends/copilot 390px and equivalent-400% browser matrix, JavaScript-disabled suite                        |
| FR-016          | `dashboard-snapshot.tsx`, root `page.tsx`                                                     | `operator-console-root.test.ts`, `operator-console.spec.ts`                                                                     |
| FR-017–FR-018   | `deploymentIdentity`, diagnostics in `operator-shell.tsx`                                     | matched/mismatch/unknown and six-profile unit matrix, diagnostics browser journey, Next build                                   |
| FR-019          | `product-analytics.ts`, actual-byte/media enforcement in analytics route/components           | analytics unit and integration negatives for governed content, route IDs, media type, and false/missing-length oversized bodies |
| FR-020          | `copilot-workspace.tsx`                                                                       | copilot browser journey and authorization composition                                                                           |
| FR-021–FR-022   | existing domain plans/loaders and Operations Command Center                                   | compatibility, session, security, read-model, degraded-state, and operations suites                                             |
| GAR-001–GAR-008 | route composition, disclosure allowlists, analytics validation, truthful UI copy              | focused lint/type/build/unit/integration/security/browser verification                                                          |
| SC-001–SC-008   | complete feature surface                                                                      | `implementation-audit.md`                                                                                                       |

## Roadmap Links

- Capabilities 1–6: route shell, search, Asset 360, status language, responsive navigation, identities.
- Capability 7: role dashboard entry model.
- Capability 8: [spec 002 Operations Command Center](../002-operations-command-center/spec.md).
- Capabilities 9–16 and 18: current-state entry points over existing platform primitives; remaining
  workflow/persistence expansion stays in the roadmap status document.
- Capability 17: deterministic citation-only boundary implementation.
- Platform delivery: build/deployment identity and aggregate-only product analytics.
