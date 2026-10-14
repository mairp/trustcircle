# Traceability: Governed Platform Continuation

| Requirement   | Design                                                                 | Implementation tasks                          | Required verification                                                              |
| ------------- | ---------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| FR-001-FR-005 | ReviewSnapshot, SnapshotComparison                                     | T011-T016                                     | unit canonical/signature/delta, integration API/cross-tenant, browser comparison   |
| FR-006-FR-014 | RegisterRecord, GovernedView, Subscription, DeliveryAttempt            | T017-T024                                     | lifecycle/SoD/expiry, field disclosure, duplicate/terminal delivery                |
| FR-015-FR-020 | EvidenceRequest, Attestation, SufficiencyDecision, Derivative, Package | T025-T032                                     | authority/version binding, original preservation, one-byte tamper, browser journey |
| FR-021-FR-028 | ControlObservation, MonitoringCase, ImpactPreview, Publication         | T033-T040                                     | replay/dedup/no-false-pass, pure preview, drift invalidation, rebuild/rollback     |
| FR-029-FR-036 | AIUseCase, components, evaluation, incident, CopilotExchange           | T041-T047                                     | lifecycle/SoD/drift, citation authorization, abstention, minimized metadata        |
| FR-037-FR-042 | Connector definition/report/certification                              | T048-T054                                     | full conformance failures, exact digests/bounds, author-certifier SoD, revocation  |
| FR-043-FR-045 | Analytics and ImprovementHypothesis                                    | T055-T057                                     | privacy schema/body bounds, aggregated measures, attributable outcome decision     |
| FR-046-FR-047 | EntityResolutionCase                                                   | T058-T059                                     | source preservation, tenant/SoD, merge/split/reject, invalidation/rollback         |
| FR-048-FR-049 | FrameworkMapping/matrix                                                | T060-T061                                     | mapping ambiguity and truthful claim-dimension tests                               |
| FR-050        | Accessible continuation UI                                             | T067-T068                                     | keyboard, 390px, 400% equivalent, forced colors, reduced motion, names/status      |
| GAR-001       | plan authority model                                                   | T011-T070                                     | decision authority matrix and no automation authority escalation                   |
| GAR-002       | shared audit/outbox boundary                                           | T009, T013-T070                               | audit completeness and missing-audit atomic rollback                               |
| GAR-003       | role conflict model                                                    | T017, T025, T034, T041, T049, T058, T062      | SoD/self-approval/stale-authority negatives                                        |
| GAR-004       | impact publication and rollback                                        | T034, T037, T039, T064                        | preview, bounds, invalidation, rebuild, rollback evidence                          |
| GAR-005       | controls/monitoring/evaluation/conformance                             | T033-T061                                     | version, ownership, test, drift, failure and gap witnesses                         |
| GAR-006       | immutable snapshots/evidence/reports                                   | T011, T025-T031, T048-T052, T063              | digest/signature/lineage/tamper/original preservation                              |
| GAR-007       | fail-visible projections/workers                                       | T010, T022, T031, T039, T046, T053, T069-T070 | freshness, partial, retry, terminal, owner, next action                            |
| GAR-008       | API/events/adapters                                                    | T003, T007, T018, T048-T053, T064             | boundary validation, idempotency, ordering, replay, reconciliation                 |
| GAR-009       | AI/copilot/framework truth                                             | T041-T047, T060-T061                          | non-authority output, abstention, readiness/certification distinctions             |
| GAR-010       | additive contracts/migration/rebuild                                   | T003-T010, T065                               | generation, expand-contract, old reader, historical schema, rebuild/rollback       |
| SC-001-SC-016 | spec success criteria                                                  | T011-T072                                     | focused witnesses plus performance, accessibility, full release evidence           |

## Artifact evidence

Design evidence is in spec.md, plan.md, research.md, data-model.md, contracts/, and quickstart.md. Runtime evidence paths are fixed in tasks.md. Final command results and known gaps are retained in implementation-audit.md and the roadmap implementation status.

## Implementation progress

- FR-001 through FR-005 and their GAR-001/002/003/006/009/010 boundary controls are implemented by T011-T016. Focused evidence is retained in implementation-audit.md; release/browser evidence remains governed by T062-T072.
- FR-006 through FR-014 and their GAR-001/002/003/007/008/010 boundary controls are implemented by T017-T024. Authority, resilience, accessibility, and full-release evidence remain governed by T062-T072.
- FR-015 through FR-020 and their GAR-001/002/003/006/007/010 boundary controls are implemented by T025-T032. Package tamper, original preservation, exact-version authority, and focused UI/build evidence are retained in `implementation-audit.md`; full authority/accessibility/release evidence remains governed by T062-T072.
- FR-021 through FR-028 and their GAR-001/002/003/004/005/007/008/010 boundary controls are implemented by T033-T040. Replay, no-false-pass, pure-preview, drift/SoD, deterministic rebuild, terminal failure, and rollback evidence are retained in `implementation-audit.md`; full authority/accessibility/release evidence remains governed by T062-T072.
- FR-029 through FR-036 and their GAR-001/002/003/005/006/009/010 boundary controls are implemented by T041-T047. Exact-component lifecycle, independent evaluation/approval, expiry/drift/incident constraints, retirement retention, exact citations, minimized metadata, abstention, and focused UI/build evidence are retained in `implementation-audit.md`; full authority/accessibility/release evidence remains governed by T062-T072.
- FR-037 through FR-042 and their GAR-001/002/003/005/006/007/008/010 boundary controls are implemented by T048-T054. Guided canonical manifests, full failure conformance, signed report evidence, independent exact-bound certification, validity/health/compatibility gates, revocation, reconciliation, and focused API/worker/projector/UI evidence are retained in `implementation-audit.md`; full authority/accessibility/release evidence remains governed by T062-T072.
- FR-043 through FR-045 and their GAR-002/005/008/010 controls are implemented by T055-T057. Privacy-minimized schemas, actual-body bounds, explicit disablement, aggregate thresholds, independent approval/outcome review, API transitions, and focused evidence are retained in `implementation-audit.md`; full release evidence remains governed by T062-T072.
- FR-046 through FR-047 and their GAR-001/002/003/004/005/007/010 controls are implemented by T058-T059. Immutable source identities, independent review, merge/split/reject, invalidation, partial failure, reconciliation, and rollback evidence are retained in `implementation-audit.md`; full release evidence remains governed by T062-T072.
- FR-048 through FR-049 and their GAR-005/007/009/010 controls are implemented by T060-T061. Typed mapping ambiguity, one-to-many/supersession retention, separated claim dimensions, compliance API/UI fail-visible states, and focused evidence are retained in `implementation-audit.md`; full release evidence remains governed by T062-T072.

### Final verification closeout

- T062-T072 are complete: the authority, evidence, resilience, compatibility, performance, browser/accessibility, production-composition, focused-consolidation, contract, lint, format, typecheck, build, composed PR/release, governed release-decision, and evidence-manifest witnesses all pass.
- The evidence ownership statements above are no longer pending-work markers; they identify the T062-T072 assurance tasks and `implementation-audit.md` sections that prove each implemented requirement family.
- T073-T076 synchronize the roadmap, README, Spec 003/004 artifacts, and `.specify/feature.json`; their final consistency result is retained in the implementation audit and task ledger.
