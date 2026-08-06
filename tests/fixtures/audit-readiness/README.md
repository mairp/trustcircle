<!-- Phase 9 · T292 · GAR-010 — fixtures regenerated and present in the working tree for GATE9. -->

# Audit-Readiness Fixtures (ISO/IEC 42001 · 42005 · 42006)

Phase 9 · T292 · GAR-010. This directory is a **sample, non-certified** audit-readiness package that
demonstrates how the TrustCircleAI Governance Control Plane maps its shipped controls and evidence to
the structure of the ISO/IEC AI-management standards.

## ⚠️ Important disclaimers

- **No certification is claimed or implied.** These fixtures are illustrative artifacts that show
  _readiness_ — the ability to produce evidence an assessor would request — not a certificate,
  attestation, or statement of conformity. Only an accredited certification body can certify
  conformance.
- **No licensed standard text is reproduced.** ISO/IEC standards are copyrighted. These fixtures
  reference standards by **number, part, and clause identifier only** (e.g. "ISO/IEC 42001 Clause
  9.1"), and describe each obligation **in our own words**. No normative text is copied. To read the
  actual requirements, obtain the standards from ISO or a national member body.
- The clause identifiers are provided as _navigation aids_ for an assessor and may be adjusted to
  match the exact published edition the assessment uses.

## Contents

| File                               | Purpose                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `iso-42001-evidence-package.json`  | AI Management System (AIMS) control → our evidence mapping |
| `iso-42005-impact-assessment.json` | AI system impact-assessment record (sample)                |
| `iso-42006-audit-readiness.json`   | Audit-readiness index for a certification-body assessment  |
| `manifest.json`                    | Signed index binding the three packages by content digest  |

## How the mapping works

Each entry pairs a standard **clause identifier** with:

- a plain-language paraphrase of the obligation (our words),
- the **shipped control** that addresses it, and
- an **evidence pointer** to a real artifact in this repository (a test, module, doc, or gate).

Because every evidence pointer targets a committed artifact, an assessor can follow the pointer and
independently exercise the control. The fixtures are validated by
`tests/fixtures/audit-readiness/validate.mjs` (run via `test:audit-readiness`), which asserts the
mapping is well-formed, non-empty, carries the no-certification disclaimer, contains no obvious
copied normative text, and that its manifest digests are self-consistent.
