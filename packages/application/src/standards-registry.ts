// @trustcircle/application — STANDARDS REGISTRY: a versioned, immutable query surface over the
// central ISO/IEC 4200x publication facts (Phase 7 / User Story 5 — Demonstrate Compliance and Audit
// Readiness / FR-051, FR-055, FR-056, SC-012, SC-022).
//
// The registry is a PURE function over an injected set of already-validated StandardPublication /
// ClauseVersion facts (loaded by standards-import.ts from db/seeds/iso-4200x.json). It resolves the
// current version, walks supersession history, classifies each publication's duty class for a given
// scope (an ordinary tenant vs. a tenant that is itself an accredited certification body), and answers
// point-in-time / paged queries — WITHOUT a wall clock or randomness (every instant is injected).
//
// It NEVER represents a mapping, an internal assessment, or a registry entry as conformity,
// accreditation, or certification: publicationDutyClass keeps 42006 as certification_body_criteria
// for an ordinary tenant, and the registry only reports the publication FACTS ISO recorded.

import {
  publicationDutyClass,
  publicationSupersedes,
  type StandardPublication,
  type ClauseVersion,
  type DutyClass,
  type MaterialType,
} from '@trustcircle/domain';

/** A resolved registry entry: a publication plus its clause versions and duty classification. */
export interface RegistryEntry {
  readonly publication: StandardPublication;
  readonly clauses: readonly ClauseVersion[];
  /** The duty class for the querying scope (42006 ⇒ certification_body_criteria unless cert body). */
  readonly dutyClass: DutyClass;
  /** True iff this is the CURRENT (highest registry version, not superseded) row for its identifier. */
  readonly current: boolean;
}

export interface RegistrySnapshot {
  readonly publications: readonly StandardPublication[];
  readonly clauses: readonly ClauseVersion[];
}

export interface RegistryQuery {
  /** Restrict to a single identifier, e.g. "ISO/IEC 42001:2023". */
  readonly identifier?: string;
  /** Include superseded (historical) versions too. Default false ⇒ current versions only. */
  readonly includeSuperseded?: boolean;
  /** True iff the querying tenant is itself an accredited certification body for the scope (FR-055). */
  readonly actsAsCertificationBody?: boolean;
  /** 1-based page (default 1). */
  readonly page?: number;
  /** Page size (default 50, max 500). */
  readonly pageSize?: number;
}

export interface RegistryPage {
  readonly entries: readonly RegistryEntry[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** The current (highest, non-superseded) publication for each identifier in the snapshot. */
function currentIds(snapshot: RegistrySnapshot): ReadonlySet<string> {
  const byIdentifier = new Map<string, StandardPublication>();
  for (const p of snapshot.publications) {
    const seen = byIdentifier.get(p.identifier);
    if (seen === undefined || p.registryVersion > seen.registryVersion)
      byIdentifier.set(p.identifier, p);
  }
  // A publication is superseded iff another row supersedes it; the surviving current one is the max.
  const superseded = new Set<string>();
  for (const p of snapshot.publications) {
    for (const q of snapshot.publications) {
      if (publicationSupersedes(p, q)) superseded.add(p.id);
    }
  }
  const current = new Set<string>();
  for (const p of byIdentifier.values()) {
    if (!superseded.has(p.id)) current.add(p.id);
  }
  return current;
}

function clausesOf(snapshot: RegistrySnapshot, publicationId: string): ClauseVersion[] {
  return snapshot.clauses
    .filter((c) => c.publicationId === publicationId)
    .slice()
    .sort((a, b) =>
      a.clauseRef < b.clauseRef ? -1 : a.clauseRef > b.clauseRef ? 1 : a.version - b.version,
    );
}

/** Resolve a single registry entry (publication + clauses + duty class) for a scope. */
export function resolveEntry(
  snapshot: RegistrySnapshot,
  publication: StandardPublication,
  actsAsCertificationBody = false,
): RegistryEntry {
  const current = currentIds(snapshot);
  return Object.freeze({
    publication,
    clauses: Object.freeze(clausesOf(snapshot, publication.id)),
    dutyClass: publicationDutyClass(publication, actsAsCertificationBody),
    current: current.has(publication.id),
  });
}

/** Look up the CURRENT publication for an identifier (the highest, non-superseded version), or null. */
export function currentPublication(
  snapshot: RegistrySnapshot,
  identifier: string,
): StandardPublication | null {
  const current = currentIds(snapshot);
  const candidates = snapshot.publications
    .filter((p) => p.identifier === identifier && current.has(p.id))
    .sort((a, b) => b.registryVersion - a.registryVersion);
  return candidates[0] ?? null;
}

/** Walk the supersession chain for an identifier, oldest → newest (FR-056 versioned history). */
export function supersessionChain(
  snapshot: RegistrySnapshot,
  identifier: string,
): readonly StandardPublication[] {
  return snapshot.publications
    .filter((p) => p.identifier === identifier)
    .slice()
    .sort((a, b) => a.registryVersion - b.registryVersion);
}

const MATERIAL_IS_OBLIGATION: ReadonlySet<MaterialType> = new Set<MaterialType>([
  'requirements',
  'amendment',
  'corrigendum',
]);

/** True iff this publication's material carries organizational obligations for an ordinary tenant. */
export function carriesObligations(p: StandardPublication): boolean {
  return MATERIAL_IS_OBLIGATION.has(p.materialType);
}

/** Query the registry, paged, with duty classification for the querying scope. Deterministic. */
export function queryRegistry(snapshot: RegistrySnapshot, query: RegistryQuery = {}): RegistryPage {
  const includeSuperseded = query.includeSuperseded ?? false;
  const acts = query.actsAsCertificationBody ?? false;
  const current = currentIds(snapshot);

  let rows = snapshot.publications.slice();
  if (query.identifier !== undefined) rows = rows.filter((p) => p.identifier === query.identifier);
  if (!includeSuperseded) rows = rows.filter((p) => current.has(p.id));

  rows.sort((a, b) =>
    a.identifier < b.identifier
      ? -1
      : a.identifier > b.identifier
        ? 1
        : b.registryVersion - a.registryVersion,
  );

  const total = rows.length;
  const page = Math.max(1, Math.trunc(query.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Math.trunc(query.pageSize ?? 50)));
  const start = (page - 1) * pageSize;
  const entries = rows.slice(start, start + pageSize).map((p) => resolveEntry(snapshot, p, acts));

  return Object.freeze({ entries: Object.freeze(entries), total, page, pageSize });
}
