// @trustcircle/application — STRUCTURED DECISION REASONS (Phase 4 / User Story 2 / FR-011).
//
// Every consequential human decision — accepted OR rejected — MUST capture an attributable reason
// (spec FR-011, AC2/AC3). This module is the application-layer reason contract:
//   * a PINNED taxonomy of structured reason CATEGORIES per decision verb, so a reason is
//     machine-classifiable, not free prose only;
//   * a MEANINGFUL-NARRATIVE validator that rejects an empty, whitespace, or vacuous ("n/a", "ok",
//     "asdf") narrative — a reason must actually explain the decision;
//   * SENSITIVE-CONTENT guidance that flags (never silently stores) a narrative that appears to
//     contain a secret / credential / PII pattern, so the approver is warned before it is recorded;
//   * SAFE FORM PRESERVATION: on a validation failure the caller's typed input is returned intact
//     (never dropped), so a UI can re-render the retained text (AC3 / FR-011 "retained input").
//
// The domain `Reason` (code + text) from @trustcircle/domain is the wire/audit shape; this module
// wraps it with the category taxonomy and the narrative/sensitivity oracles. It re-uses
// `makeReason` (which enforces the code pattern + non-empty text) rather than re-implementing it.

import {
  makeReason,
  isConsequentialReason,
  type Reason,
} from '@trustcircle/domain';
import { type DecisionActionVerb, DECISION_ACTIONS } from '@trustcircle/domain';

// ---------------------------------------------------------------------------
// 1. Structured reason categories, keyed by decision verb.
// ---------------------------------------------------------------------------

/** The pinned structured reason categories a decision reason `code` must belong to, per verb. */
export const REASON_CATEGORIES: Readonly<Record<DecisionActionVerb, readonly string[]>> =
  Object.freeze({
    approve: ['risk_accepted', 'controls_sufficient', 'business_justified', 'evidence_complete'],
    deny: ['risk_unacceptable', 'controls_insufficient', 'policy_violation', 'evidence_missing'],
    request_changes: ['needs_more_evidence', 'scope_too_broad', 'alternative_preferred'],
    escalate: ['above_authority', 'cross_tenant_impact', 'needs_central_review'],
    delegate: ['coverage', 'expertise', 'availability'],
    expire: ['deadline_passed', 'no_longer_relevant'],
    cancel: ['requested_withdrawn', 'superseded', 'duplicate'],
  });

/** Every recognised reason category across all verbs (the classification alphabet). */
export const ALL_REASON_CATEGORIES: readonly string[] = Object.freeze([
  ...new Set(Object.values(REASON_CATEGORIES).flat()),
]);

/** True iff `code` is a recognised structured category for `action`. */
export function isReasonCategoryFor(action: DecisionActionVerb, code: string): boolean {
  const cats = REASON_CATEGORIES[action];
  return cats.includes(code);
}

// ---------------------------------------------------------------------------
// 2. Meaningful-narrative validation.
// ---------------------------------------------------------------------------

/** Narratives whose entire content is a vacuous placeholder — rejected as not meaningful. */
const VACUOUS_NARRATIVES: ReadonlySet<string> = new Set([
  'na',
  'n/a',
  'ok',
  'okay',
  'yes',
  'no',
  'none',
  'tbd',
  'asdf',
  'test',
  'x',
  '.',
  '-',
]);

const MIN_MEANINGFUL_WORDS = 3;
const MIN_MEANINGFUL_LENGTH = 12;

/** A single distinct character repeated (e.g. "aaaaaa") carries no information. */
function isRepeatedChar(s: string): boolean {
  const t = s.replace(/\s+/g, '');
  return t.length > 0 && new Set(t.split('')).size === 1;
}

/**
 * True iff `text` is a MEANINGFUL narrative — non-empty after trim, not a known vacuous
 * placeholder, not a single repeated character, and carrying at least a few distinct words. This
 * is the executable form of FR-011 "attributable, meaningful reason".
 */
export function isMeaningfulNarrative(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_MEANINGFUL_LENGTH) return false;
  if (VACUOUS_NARRATIVES.has(trimmed.toLowerCase())) return false;
  if (isRepeatedChar(trimmed)) return false;
  const words = trimmed.split(/\s+/).filter((w) => w.length > 1);
  return words.length >= MIN_MEANINGFUL_WORDS;
}

// ---------------------------------------------------------------------------
// 3. Sensitive-content guidance (warn, never silently store).
// ---------------------------------------------------------------------------

/** Patterns that look like a secret / credential / PII the approver should NOT paste into a reason. */
const SENSITIVE_PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = Object.freeze([
  { kind: 'credential', re: /\b(password|passwd|secret|api[_-]?key|token|bearer)\b\s*[:=]/i },
  { kind: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { kind: 'ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { kind: 'card', re: /\b(?:\d[ -]?){13,16}\b/ },
]);

/** The kinds of sensitive content detected in a narrative (empty ⇒ none). Non-destructive. */
export function detectSensitiveContent(text: string): readonly string[] {
  const kinds: string[] = [];
  for (const { kind, re } of SENSITIVE_PATTERNS) {
    if (re.test(text)) kinds.push(kind);
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// 4. The reason validator — combining category, narrative, and sensitivity.
// ---------------------------------------------------------------------------

export type ReasonRejectionCode =
  | 'MISSING_CODE'
  | 'MISSING_TEXT'
  | 'UNKNOWN_CATEGORY'
  | 'NOT_MEANINGFUL'
  | 'MALFORMED_CODE';

export interface ReasonValidation {
  readonly ok: boolean;
  /** The validated domain Reason when ok; absent otherwise. */
  readonly reason?: Reason;
  /** Machine-readable rejection code when not ok. */
  readonly rejection?: ReasonRejectionCode;
  /** A human-readable explanation of the rejection (safe to surface). */
  readonly detail?: string;
  /** Sensitive-content kinds detected (guidance only — the reason may still be ok). */
  readonly sensitiveKinds: readonly string[];
  /** The caller's original, UNMODIFIED input, so a UI can re-render retained text (FR-011). */
  readonly preserved: { readonly code: string; readonly text: string };
}

/**
 * Validate a decision reason for a verb. On success returns the domain `Reason`; on failure returns
 * a machine-readable rejection AND the preserved input (never dropped). Sensitive-content kinds are
 * always reported as guidance, independent of the pass/fail verdict.
 */
export function validateDecisionReason(
  action: DecisionActionVerb,
  input: { readonly code: string; readonly text: string },
): ReasonValidation {
  const preserved = { code: String(input.code ?? ''), text: String(input.text ?? '') };
  const sensitiveKinds = detectSensitiveContent(preserved.text);

  if (!DECISION_ACTIONS.includes(action)) {
    return {
      ok: false,
      rejection: 'UNKNOWN_CATEGORY',
      detail: `unknown decision action '${action}'`,
      sensitiveKinds,
      preserved,
    };
  }
  if (preserved.code.trim().length === 0) {
    return { ok: false, rejection: 'MISSING_CODE', detail: 'a reason code is required', sensitiveKinds, preserved };
  }
  if (preserved.text.trim().length === 0) {
    return { ok: false, rejection: 'MISSING_TEXT', detail: 'a reason narrative is required', sensitiveKinds, preserved };
  }
  if (!isReasonCategoryFor(action, preserved.code)) {
    return {
      ok: false,
      rejection: 'UNKNOWN_CATEGORY',
      detail: `'${preserved.code}' is not a recognised ${action} reason category`,
      sensitiveKinds,
      preserved,
    };
  }
  if (!isMeaningfulNarrative(preserved.text)) {
    return {
      ok: false,
      rejection: 'NOT_MEANINGFUL',
      detail: 'the reason narrative must meaningfully explain the decision',
      sensitiveKinds,
      preserved,
    };
  }
  // makeReason enforces the code pattern + non-empty text; a malformed code surfaces here.
  let reason: Reason;
  try {
    reason = makeReason(preserved.code, preserved.text);
  } catch {
    return {
      ok: false,
      rejection: 'MALFORMED_CODE',
      detail: 'the reason code must match /^[a-z][a-z0-9_.-]{1,63}$/',
      sensitiveKinds,
      preserved,
    };
  }
  if (!isConsequentialReason(reason)) {
    return { ok: false, rejection: 'NOT_MEANINGFUL', detail: 'reason not consequential', sensitiveKinds, preserved };
  }
  return { ok: true, reason, sensitiveKinds, preserved };
}
