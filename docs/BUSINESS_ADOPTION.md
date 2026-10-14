# Business adoption: AI Governance Control Plane

Audience: executive sponsors and adoption leads. Baselines are measured at your organisation; this
document does not quote production figures. Feasibility statements come from the platform's own
acceptance evidence.

## Use case

Most organisations now run AI everywhere: models in products, agents in operations, automated
workflows in the back office, and copilots on every desk. Governing that estate is usually a
patchwork. The AI register is a spreadsheet, approvals happen by email, control evidence is gathered
by hand before each audit, and several compliance frameworks are tracked in parallel until someone
declares the organisation "compliant" on a slide. Nobody can say with confidence what AI exists, who
owns it, whether its controls work, or what changed since the last review.

With TrustCircleAI:

- **Inventory.** The organisation declares the boundary it is responsible for, and the platform
  keeps a continuously reconciled inventory of every AI asset inside it, including assets nobody
  registered.
- **Asset picture.** Each asset shows its owner, risk, lifecycle stage, the controls and evidence
  covering it, and how fresh that picture is. Anything unknown, unreachable or unowned stays visible
  as a gap until a person owns it.
- **Decisions.** A consequential decision might be approving an AI use case for production,
  accepting a risk or granting an exception. For each one, the platform assembles the full decision
  package and routes it to a person who actually holds the authority. A reason is required, and
  self-approval is refused.
- **Monitoring.** Control signals are watched continuously, and each real failure becomes exactly
  one owned case.
- **Incoming work.** Governance work is quality-checked on arrival, and damaged items are
  quarantined before they can trigger anything.
- **Evidence.** Evidence is requested, attested, judged and exported as a signed package that an
  external assessor can verify.
- **Frameworks.** Obligations from ISO/IEC 42001, the EU AI Act, the NIST AI RMF and internal policy
  are held once, mapped to controls, and reported as readiness, never as certification.
- **Reviews.** Each review period is signed and can be compared with the last.

The platform recommends, prepares, checks and records. It never approves, closes, certifies or
declares compliance. A named person always does that, and every such action records their identity,
their reason and a tamper-evident trail.

## Impact

- **Leadership** gets one truthful answer to "what AI do we run, who owns it, and is it under
  control?", instead of surveys and slides.
- **Approvals** speed up: instead of days spent chasing context, the approver receives a complete
  package, and approvals based on stale information stop.
- **Control failures** get an owner within minutes instead of surfacing at the next audit.
  Duplicate tickets for the same failure disappear.
- **Audit preparation** shrinks from weeks of collection to minutes of assembly, with evidence the
  assessor can verify independently.
- **Compliance exposure** falls, because readiness and certification are kept distinct and gaps are
  reported, not hidden.
- **Governance staff** spend their time reviewing and deciding instead of assembling context and
  chasing evidence.
- **Every decision, repair, evidence judgement and change** records who, what, why and what was
  verified, so audit evidence is produced as a by-product.

## ISO/IEC 42001

TrustCircleAI is designed to support ISO/IEC 42001 AI management system implementation and audit
readiness, with controls mapped to the clauses and Annex A control areas
([mapping](compliance/ISO42001.md)). Certification remains the decision of an accredited
certification body. The platform shortens the path to it but does not replace it.

## Feasibility

The platform's own acceptance suites prove every capability listed above:

- inventory and discovery
- decision packages with separation of duties
- the operations queue and case escalation
- integrity quarantine and bounded repair
- continuous monitoring
- change impact preview
- evidence packages with one-byte tamper detection
- the multi-framework readiness register
- the AI use-case lifecycle
- signed review comparison
- a citation-bound copilot

The platform is deliberately cautious. It acts only inside a signed policy, holds no source
credentials, and cannot grant itself authority.

**Getting started:** an instance is provisioned with one script on Docker Compose (pilot) or
Kubernetes (production). See [PROVISIONING.md](PROVISIONING.md).

**Main adoption effort:** the current build ships reference adapters for internal work-tracking
and agent-orchestration sources. Corporate systems such as an issue tracker, ITSM platform, model
registry, email or chat each need a connector, built and certified through the platform's own
conformance process.

**Copilot:** it is deterministic today. Adding a language model is on the roadmap, and that model
would itself be governed by the platform before use.

## Success metrics

Measure a baseline before the pilot and compare at 90 days:

| Metric                        | How to measure                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| AI asset coverage             | Assets with a named owner, divided by assets discovered within the declared boundary |
| Unowned-gap age               | Median time a discovered gap stays unowned                                           |
| Approval cycle time           | Request to decision for AI use-case approvals; share made on stale information       |
| Control-failure time to owner | Signal to owned case; duplicate cases per real failure                               |
| Audit preparation effort      | Person-hours to assemble an evidence package for one framework scope                 |
| Evidence freshness            | Share of in-scope controls with evidence inside its validity window                  |
| Readiness honesty             | Indeterminate or unknown items reported, not counted as passing                      |
