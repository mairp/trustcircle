// @trustcircle/application — STANDARDS IMPORT: load the central ISO/IEC 4200x registry seed
// (db/seeds/iso-4200x.json) into validated, immutable domain aggregates (Phase 7 / User Story 5 —
// Demonstrate Compliance and Audit Readiness / FR-051, FR-055, FR-056, SC-012).
//
// Import is a PURE function of the seed object + an injected `now` epoch (the createdAt stamp for the
// imported rows) — no filesystem read, no wall clock, no randomness. The caller reads and parses the
// JSON (a leaf concern) and hands the object in; this module VALIDATES its shape and turns each entry
// into a StandardPublication / ClauseVersion via the domain asserting factories, so a malformed seed
// FAILS VISIBLY at import rather than silently producing a half-registry. String seed ids (e.g.
// "iso-iec-42001-2023") are mapped to deterministic v7-shaped UUIDs so re-import is byte-identical.
//
// The import records ONLY the publication facts as authored by ISO. It never marks any tenant as
// conforming, accredited, or certified — 42006 keeps its certification_body_criteria material type.

import { createHash } from 'node:crypto';
import {
  makeStandardPublication,
  makeClauseVersion,
  standardPublicationDigest,
  clauseVersionDigest,
  type StandardPublication,
  type ClauseVersion,
  type MaterialType,
  type PublicationStatus,
  type EpochMillis,
  type Uuid,
} from '@trustcircle/domain';

import type { RegistrySnapshot } from './standards-registry.ts';

/** A deterministic, legible-in-source, v7-shaped UUID derived from a seed slug (import-namespaced). */
export function registryUuid(slug: string): Uuid {
  const h = createHash('sha256').update(`standards-registry:${slug}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}` as Uuid;
}

// The seed JSON shape (validated structurally on the way in). Kept permissive (unknown) at the edge.
interface SeedClause {
  clauseRef: string;
  title: string;
  materialType?: string;
  version?: number;
}
interface SeedPublication {
  id: string;
  publisher: string;
  identifier: string;
  exactTitle: string;
  edition: string;
  publicationDate: string;
  status?: string;
  materialType: string;
  sourceUri: string;
  registryVersion?: number;
  supersedesId?: string | null;
  clauses?: readonly SeedClause[];
}
export interface StandardsSeed {
  registryVersion?: number;
  scope?: string;
  publications: readonly SeedPublication[];
}

export class StandardsImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardsImportError';
  }
}

function requireArray(v: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(v)) throw new StandardsImportError(`${label} must be an array`);
  return v;
}

/** The imported registry: validated aggregates plus their content digests (append-only witnesses). */
export interface ImportedRegistry extends RegistrySnapshot {
  readonly publicationDigests: Readonly<Record<string, string>>;
  readonly clauseDigests: Readonly<Record<string, string>>;
}

/**
 * Import a parsed standards seed into validated, immutable domain aggregates at `now`. Throws
 * {@link StandardsImportError} (or a domain TypeError/RangeError) on any malformed entry — a
 * half-registry is never returned. Deterministic: same seed + same `now` ⇒ byte-identical result.
 */
export function importStandardsSeed(seed: StandardsSeed, now: EpochMillis): ImportedRegistry {
  if (seed === null || typeof seed !== 'object') {
    throw new StandardsImportError('seed must be an object');
  }
  const seedPubs = requireArray(seed.publications, 'seed.publications') as readonly SeedPublication[];

  const publications: StandardPublication[] = [];
  const clauses: ClauseVersion[] = [];
  const publicationDigests: Record<string, string> = {};
  const clauseDigests: Record<string, string> = {};
  const seenIdentifierVersion = new Set<string>();

  for (const sp of seedPubs) {
    if (sp === null || typeof sp !== 'object') {
      throw new StandardsImportError('each publication must be an object');
    }
    const pubId = registryUuid(sp.id);
    const registryVersion = sp.registryVersion ?? 1;
    const idKey = `${sp.identifier}@${registryVersion}`;
    if (seenIdentifierVersion.has(idKey)) {
      throw new StandardsImportError(`duplicate publication ${idKey} in seed`);
    }
    seenIdentifierVersion.add(idKey);

    const publication = makeStandardPublication({
      id: pubId,
      publisher: sp.publisher,
      identifier: sp.identifier,
      exactTitle: sp.exactTitle,
      edition: sp.edition,
      publicationDate: sp.publicationDate,
      status: (sp.status as PublicationStatus | undefined) ?? 'published',
      materialType: sp.materialType as MaterialType,
      sourceUri: sp.sourceUri,
      registryVersion,
      ...(sp.supersedesId ? { supersedesId: registryUuid(sp.supersedesId) } : {}),
      createdAt: now,
    });
    publications.push(publication);
    publicationDigests[publication.id] = standardPublicationDigest(publication);

    for (const sc of sp.clauses ?? []) {
      const clause = makeClauseVersion({
        id: registryUuid(`${sp.id}#${sc.clauseRef}@${sc.version ?? 1}`),
        publicationId: pubId,
        clauseRef: sc.clauseRef,
        title: sc.title,
        materialType: (sc.materialType as MaterialType | undefined) ?? 'requirements',
        version: sc.version ?? 1,
        createdAt: now,
      });
      clauses.push(clause);
      clauseDigests[clause.id] = clauseVersionDigest(clause);
    }
  }

  return Object.freeze({
    publications: Object.freeze(publications),
    clauses: Object.freeze(clauses),
    publicationDigests: Object.freeze(publicationDigests),
    clauseDigests: Object.freeze(clauseDigests),
  });
}
