// @trustcircle/adapter-lisa — LISA evidence mapping (task T261 / US6).
//
// Maps LISA persistence, outbox, artifacts, providers, fallbacks, hooks, plugins, skills, memory,
// and telemetry state into governance EVIDENCE records — WITH authority, cost, egress, integrity,
// retention, and explicit gap evidence. PURE: no I/O, no wall clock (`observedAt` is injected),
// no randomness, Node built-in `crypto` only.
//
// Every emitted evidence record carries a content hash (integrity anchor) and an explicit
// `authorityNote` restating that the observed state is EVIDENCE, never a governance decision.
// Missing or unreadable surfaces are emitted as explicit GAP evidence rather than silently
// dropped — a gap is a first-class, fail-visible fact.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Evidence surfaces + integrity/cost/egress/retention descriptors.
// ---------------------------------------------------------------------------

export type LisaEvidenceSurface =
  | 'persistence'
  | 'outbox'
  | 'artifact'
  | 'provider'
  | 'fallback'
  | 'hook'
  | 'plugin'
  | 'skill'
  | 'memory'
  | 'telemetry';

/** Cost attribution for a surface observation (units are source-defined, carried verbatim). */
export interface CostAttribution {
  readonly currency: string;
  readonly amount: number;
  readonly tokensConsumed: number | null;
}

/** Network egress a surface performed, if any (empty ⇒ no egress observed). */
export interface EgressRecord {
  readonly destination: string;
  readonly bytes: number;
}

/** Retention posture for the observed state. */
export interface RetentionPolicy {
  readonly retainedUntil: number | null;
  readonly redactable: boolean;
}

/**
 * A raw observation of a LISA operational surface. Read-only. `contentHash` is the source's own
 * integrity anchor; when absent (unreadable), the mapper emits a gap.
 */
export interface LisaSurfaceObservation {
  readonly surface: LisaEvidenceSurface;
  readonly jobId: string;
  readonly externalId: string;
  /** Source integrity anchor over the observed payload; null when the surface is unreadable. */
  readonly contentHash: string | null;
  /** Cost attributed to the observed operation, if the source reports it. */
  readonly cost: CostAttribution | null;
  /** Network egress the surface performed. Empty array ⇒ none observed. */
  readonly egress: readonly EgressRecord[];
  readonly retention: RetentionPolicy;
  /** Opaque, already-normalized payload snapshot. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** When discovery observed this surface (epoch ms) — injected. */
  readonly observedAt: number;
}

// ---------------------------------------------------------------------------
// Evidence records + gaps.
// ---------------------------------------------------------------------------

export interface LisaEvidenceRecord {
  readonly surface: LisaEvidenceSurface;
  readonly jobId: string;
  readonly externalId: string;
  /** Digest binding surface + payload + integrity anchor — the durable evidence hash. */
  readonly evidenceDigest: string;
  /** The source's own content hash, preserved for chain of custody. */
  readonly sourceContentHash: string;
  readonly cost: CostAttribution | null;
  readonly egress: readonly EgressRecord[];
  readonly retention: RetentionPolicy;
  readonly observedAt: number;
  /** Restates that this record is EVIDENCE and confers no governance authority. */
  readonly authorityNote: string;
}

export type LisaEvidenceGapReason =
  /** The surface's integrity anchor (content hash) was missing/unreadable. */
  | 'missing_content_hash'
  /** The surface was expected but no observation was collected. */
  | 'surface_not_observed';

export interface LisaEvidenceGap {
  readonly surface: LisaEvidenceSurface;
  readonly jobId: string;
  readonly externalId: string | null;
  readonly reason: LisaEvidenceGapReason;
  /** Deterministic id so the same gap is reported identically across runs. */
  readonly gapId: string;
  readonly detail: string;
}

export interface LisaEvidenceMapping {
  readonly records: readonly LisaEvidenceRecord[];
  readonly gaps: readonly LisaEvidenceGap[];
  /** Digest over the whole mapping body — a durable, independently checkable witness. */
  readonly mappingDigest: string;
}

const AUTHORITY_NOTE =
  'LISA operational-surface state is EVIDENCE only; it confers no governance authority and is ' +
  'never a substitute for a human approval decision.';

// ---------------------------------------------------------------------------
// Mapping.
// ---------------------------------------------------------------------------

/**
 * Map raw LISA surface observations into evidence records + explicit gaps.
 *
 * `expectedSurfaces` lists surfaces that MUST be present for the job; any expected surface with no
 * observation becomes a `surface_not_observed` gap. An observation lacking a content hash becomes a
 * `missing_content_hash` gap AND is not emitted as a trusted record.
 *
 * Pure and deterministic: same inputs ⇒ identical `mappingDigest`.
 */
export function mapEvidence(
  observations: readonly LisaSurfaceObservation[],
  expectedSurfaces: readonly LisaEvidenceSurface[] = [],
): LisaEvidenceMapping {
  const records: LisaEvidenceRecord[] = [];
  const gaps: LisaEvidenceGap[] = [];

  for (const obs of observations) {
    if (obs.contentHash === null) {
      gaps.push(makeGap(obs.surface, obs.jobId, obs.externalId, 'missing_content_hash',
        `Surface ${obs.surface}:${obs.externalId} was observed without an integrity anchor; ` +
          'emitted as a gap rather than a trusted record.'));
      continue;
    }

    const evidenceDigest = contentDigest({
      surface: obs.surface,
      jobId: obs.jobId,
      externalId: obs.externalId,
      contentHash: obs.contentHash,
      payload: obs.payload,
    });

    records.push(Object.freeze({
      surface: obs.surface,
      jobId: obs.jobId,
      externalId: obs.externalId,
      evidenceDigest,
      sourceContentHash: obs.contentHash,
      cost: obs.cost === null ? null : Object.freeze({ ...obs.cost }),
      egress: Object.freeze(obs.egress.map((e) => Object.freeze({ ...e }))),
      retention: Object.freeze({ ...obs.retention }),
      observedAt: obs.observedAt,
      authorityNote: AUTHORITY_NOTE,
    }));
  }

  // Expected-but-absent surfaces are explicit gaps.
  const observedSurfaces = new Set(observations.map((o) => o.surface));
  for (const surface of expectedSurfaces) {
    if (!observedSurfaces.has(surface)) {
      const jobId = observations[0]?.jobId ?? 'unknown';
      gaps.push(makeGap(surface, jobId, null, 'surface_not_observed',
        `Expected surface ${surface} was not observed for job ${jobId}.`));
    }
  }

  // Deterministic ordering for a stable mapping digest.
  records.sort((a, b) => (recordKey(a) < recordKey(b) ? -1 : recordKey(a) > recordKey(b) ? 1 : 0));
  gaps.sort((a, b) => (a.gapId < b.gapId ? -1 : a.gapId > b.gapId ? 1 : 0));

  const mappingDigest = contentDigest({ records, gaps });

  return Object.freeze({
    records: Object.freeze(records),
    gaps: Object.freeze(gaps),
    mappingDigest,
  });
}

function makeGap(
  surface: LisaEvidenceSurface,
  jobId: string,
  externalId: string | null,
  reason: LisaEvidenceGapReason,
  detail: string,
): LisaEvidenceGap {
  const gapId = `lisa-gap-${contentDigest({ surface, jobId, externalId, reason }).slice(0, 32)}`;
  return Object.freeze({ surface, jobId, externalId, reason, gapId, detail });
}

const recordKey = (r: LisaEvidenceRecord): string => `${r.jobId} ${r.surface} ${r.externalId}`;

// ---------------------------------------------------------------------------
// Local canonicalization + digest.
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
