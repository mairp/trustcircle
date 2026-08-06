// T184 — Standards registry unit tests (FR-031, FR-051, SC-012).
//
// Exercises the REAL compliance domain factories + the REAL standards importer over the shared
// compliance fixtures. Asserts:
//   1. Immutable publication FACTS (frozen, PLATFORM_SCOPE-scoped, fields echo the inputs).
//   2. The ISO YYYY-MM-DD publicationDate format (with a non-date negative control).
//   3. Material classifications + the 42006 certification-body-criteria duty rule (FR-055).
//   4. Clause versions (publicationId / clauseRef / version / materialType, frozen).
//   5. Supersession history (registryVersion 2 supersedes v1; the reverse never supersedes).
//   6. Future 4200x imports (deterministic registryUuid + digests; duplicate-key conflict throws).
//
// Every assertion observes a genuine returned value — never a tautology.

import { describe, it, expect } from 'vitest';

import {
  makeStandardPublication,
  makeClauseVersion,
  publicationDutyClass,
  publicationSupersedes,
  standardPublicationDigest,
  clauseVersionDigest,
  MATERIAL_TYPES,
  DUTY_CLASSES,
  type StandardPublication,
} from '@trustcircle/domain';

import {
  createFrameworkMapping,
  importStandardsSeed,
  registryUuid,
  reviewFrameworkMapping,
  StandardsImportError,
  type StandardsSeed,
  type ImportedRegistry,
} from '@trustcircle/application';

import {
  PUBLICATION_42001,
  PUBLICATION_42001_V2,
  PUBLICATION_42006,
  PUBLICATIONS,
  DUTY_CLASS_42006,
  CLAUSE_READY,
  CLAUSE_STALE,
  CLAUSE_UNMAPPED,
  CLAUSE_REOPENED,
  CLAUSES,
  TENANT,
  NOW,
  IDS,
} from '../fixtures/compliance.ts';

const ISO_FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OWNER = '018f0000-0000-7000-8000-000000000010';
const REVIEWER = '018f0000-0000-7000-8000-000000000011';

describe('T184 standards registry — immutable publication facts (FR-051)', () => {
  it('makeStandardPublication returns a frozen read-only object whose fields echo the inputs', () => {
    const input = {
      id: registryUuid('unit-immutable-42001'),
      publisher: 'ISO/IEC',
      identifier: 'ISO/IEC 42001:2023',
      exactTitle: 'Information technology — Artificial intelligence — Management system',
      edition: '1',
      publicationDate: '2023-12-01',
      status: 'published' as const,
      materialType: 'requirements' as const,
      sourceUri: 'https://www.iso.org/standard/81230.html',
      registryVersion: 1,
      createdAt: NOW,
    };
    const pub = makeStandardPublication(input);

    expect(Object.isFrozen(pub)).toBe(true);
    expect(pub.publisher).toBe(input.publisher);
    expect(pub.identifier).toBe(input.identifier);
    expect(pub.exactTitle).toBe(input.exactTitle);
    expect(pub.edition).toBe(input.edition);
    expect(pub.publicationDate).toBe(input.publicationDate);
    expect(pub.status).toBe(input.status);
    expect(pub.materialType).toBe(input.materialType);
    expect(pub.sourceUri).toBe(input.sourceUri);
    expect(pub.registryVersion).toBe(input.registryVersion);
  });

  it('the fixture publication is frozen and mutating a field does not change it', () => {
    expect(Object.isFrozen(PUBLICATION_42001)).toBe(true);

    const before = PUBLICATION_42001.exactTitle;
    // A frozen object silently ignores writes in non-strict contexts; assert the value is unchanged.
    expect(() => {
      (PUBLICATION_42001 as { exactTitle: string }).exactTitle = 'TAMPERED';
    }).toThrow();
    expect(PUBLICATION_42001.exactTitle).toBe(before);
  });

  it('a publication fact is PLATFORM_SCOPE-scoped, never tenant-owned', () => {
    expect(PUBLICATION_42001.tenantId).toBe(IDS.PLATFORM_SCOPE);
    for (const p of PUBLICATIONS) {
      expect(p.tenantId).toBe(IDS.PLATFORM_SCOPE);
    }
  });
});

describe('T184 standards registry — publicationDate format (FR-051)', () => {
  it('publicationDate is a valid ISO YYYY-MM-DD full-date', () => {
    expect(PUBLICATION_42001.publicationDate).toMatch(ISO_FULL_DATE_RE);
    // Round-trips through Date as a real calendar date (not just regex-shaped).
    const d = new Date(`${PUBLICATION_42001.publicationDate}T00:00:00.000Z`);
    expect(Number.isNaN(d.getTime())).toBe(false);
    expect(d.toISOString().slice(0, 10)).toBe(PUBLICATION_42001.publicationDate);
  });

  it('NEGATIVE: makeStandardPublication rejects a non-date publicationDate', () => {
    expect(() =>
      makeStandardPublication({
        id: registryUuid('unit-bad-date'),
        publisher: 'ISO/IEC',
        identifier: 'ISO/IEC 42001:2023',
        exactTitle: 'x',
        edition: '1',
        publicationDate: 'December 2023',
        materialType: 'requirements',
        sourceUri: 'https://example.org',
        createdAt: NOW,
      }),
    ).toThrow(/publicationDate/i);
  });
});

describe('T184 standards registry — material classifications (FR-031, FR-055)', () => {
  it('every MATERIAL_TYPES member is accepted by the factory', () => {
    for (const materialType of MATERIAL_TYPES) {
      const pub = makeStandardPublication({
        id: registryUuid(`unit-material-${materialType}`),
        publisher: 'ISO/IEC',
        identifier: `ISO/IEC 4200X:${materialType}`,
        exactTitle: `A ${materialType} publication`,
        edition: '1',
        publicationDate: '2025-01-01',
        materialType,
        sourceUri: 'https://example.org',
        createdAt: NOW,
      });
      expect(pub.materialType).toBe(materialType);
    }
  });

  it('42006 is certification_body_criteria — NOT an organizational obligation for a non-cert-body', () => {
    expect(PUBLICATION_42006.materialType).toBe('certification_body_criteria');

    // DUTY_CLASS_42006 === publicationDutyClass(PUBLICATION_42006, false) per the fixture.
    expect(DUTY_CLASS_42006).toBe('certification_body_criteria');
    expect(DUTY_CLASS_42006).not.toBe('organizational_obligation');
    expect(publicationDutyClass(PUBLICATION_42006, false)).toBe('certification_body_criteria');
    expect(DUTY_CLASSES).toContain(DUTY_CLASS_42006);
  });

  it('42006 BECOMES an organizational obligation only when the tenant IS a certification body', () => {
    const asCertBody = publicationDutyClass(PUBLICATION_42006, true);
    expect(asCertBody).toBe('organizational_obligation');
    expect(asCertBody).not.toBe(DUTY_CLASS_42006);
  });

  it('NEGATIVE control: a requirements publication IS an organizational obligation for a non-cert-body', () => {
    expect(PUBLICATION_42001.materialType).toBe('requirements');
    expect(publicationDutyClass(PUBLICATION_42001, false)).toBe('organizational_obligation');
    // And a cert-body flag does not change a plain requirements duty.
    expect(publicationDutyClass(PUBLICATION_42001, true)).toBe('organizational_obligation');
  });
});

describe('T184 standards registry — clause versions (FR-051)', () => {
  it('fixture clauses carry the 42001 publicationId, a clauseRef, a version, and requirements type', () => {
    for (const c of [CLAUSE_READY, CLAUSE_STALE, CLAUSE_UNMAPPED, CLAUSE_REOPENED]) {
      expect(c.publicationId).toBe(IDS.PUB_42001_ID);
      expect(typeof c.clauseRef).toBe('string');
      expect(c.clauseRef.length).toBeGreaterThan(0);
      expect(c.version).toBe(1);
      expect(c.materialType).toBe('requirements');
      expect(c.tenantId).toBe(IDS.PLATFORM_SCOPE);
    }
    expect(CLAUSES.length).toBe(4);
  });

  it('a clause version is frozen; mutating clauseRef does not change it', () => {
    expect(Object.isFrozen(CLAUSE_READY)).toBe(true);
    const before = CLAUSE_READY.clauseRef;
    expect(() => {
      (CLAUSE_READY as { clauseRef: string }).clauseRef = '0.0';
    }).toThrow();
    expect(CLAUSE_READY.clauseRef).toBe(before);
  });

  it('makeClauseVersion echoes its inputs on a fresh clause', () => {
    const clause = makeClauseVersion({
      id: registryUuid('unit-clause-fresh'),
      publicationId: IDS.PUB_42001_ID,
      clauseRef: '5.4',
      title: 'Roles, responsibilities and authorities',
      materialType: 'requirements',
      version: 2,
      createdAt: NOW,
    });
    expect(clause.publicationId).toBe(IDS.PUB_42001_ID);
    expect(clause.clauseRef).toBe('5.4');
    expect(clause.title).toBe('Roles, responsibilities and authorities');
    expect(clause.version).toBe(2);
  });
});

describe('T184 standards registry — supersession history (FR-051)', () => {
  it('the v2 publication records registryVersion 2 and supersedes v1 by id', () => {
    expect(PUBLICATION_42001_V2.registryVersion).toBe(2);
    expect(PUBLICATION_42001_V2.supersedesId).toBe(PUBLICATION_42001.id);
    expect(PUBLICATION_42001.registryVersion).toBe(1);
  });

  it('publicationSupersedes(prior, next) is true when next is the strictly-newer version', () => {
    expect(publicationSupersedes(PUBLICATION_42001, PUBLICATION_42001_V2)).toBe(true);
  });

  it('NEGATIVE control: an older edition does not supersede a newer one', () => {
    expect(publicationSupersedes(PUBLICATION_42001_V2, PUBLICATION_42001)).toBe(false);
  });
});

describe('T184 standards registry — future 4200x imports (SC-012)', () => {
  const FUTURE_SEED: StandardsSeed = {
    registryVersion: 1,
    publications: [
      {
        id: 'iso-iec-42007-2027-draft',
        publisher: 'ISO/IEC',
        identifier: 'ISO/IEC 42007:2027',
        exactTitle:
          'Information technology — Artificial intelligence — A hypothetical future 4200x work item',
        edition: '1',
        publicationDate: '2027-03-15',
        status: 'draft',
        materialType: 'draft',
        sourceUri: 'https://www.iso.org/standard/42007.html',
        registryVersion: 1,
        clauses: [
          {
            clauseRef: '4.1',
            title: 'Context of the organization',
            materialType: 'requirements',
            version: 1,
          },
        ],
      },
    ],
  };

  it('importStandardsSeed loads a future 4200x publication with a deterministic id + digest', () => {
    const registry: ImportedRegistry = importStandardsSeed(FUTURE_SEED, NOW);

    const expectedId = registryUuid('iso-iec-42007-2027-draft');
    const imported = registry.publications.find((p) => p.id === expectedId);
    expect(imported).toBeDefined();
    const pub = imported as StandardPublication;

    expect(pub.identifier).toBe('ISO/IEC 42007:2027');
    expect(pub.status).toBe('draft');
    expect(pub.materialType).toBe('draft');
    expect(pub.publicationDate).toBe('2027-03-15');
    expect(pub.createdAt).toBe(NOW);
    expect(pub.tenantId).toBe(IDS.PLATFORM_SCOPE);

    // The recorded digest matches the domain digest of the imported fact (a genuine witness).
    expect(registry.publicationDigests[pub.id]).toBe(standardPublicationDigest(pub));

    // The seeded clause is imported under the same publication with a deterministic id + digest.
    const clause = registry.clauses.find((c) => c.publicationId === expectedId);
    expect(clause).toBeDefined();
    expect(clause?.clauseRef).toBe('4.1');
    expect(registry.clauseDigests[clause!.id]).toBe(clauseVersionDigest(clause!));

    // Determinism: same seed + same `now` ⇒ byte-identical publication digest.
    const again = importStandardsSeed(FUTURE_SEED, NOW);
    expect(again.publicationDigests[pub.id]).toBe(registry.publicationDigests[pub.id]);
  });

  it('NEGATIVE control: a seed sharing identifier@registryVersion throws StandardsImportError', () => {
    const conflicting: StandardsSeed = {
      publications: [
        FUTURE_SEED.publications[0]!,
        {
          // A different seed id (⇒ different UUID) but the SAME identifier@registryVersion.
          ...FUTURE_SEED.publications[0]!,
          id: 'iso-iec-42007-2027-duplicate',
        },
      ],
    };
    expect(() => importStandardsSeed(conflicting, NOW)).toThrow(StandardsImportError);
    expect(() => importStandardsSeed(conflicting, NOW)).toThrow(/duplicate/i);
  });
});

describe('Spec004 framework mapping - truthful typed relationships (FR-048/049)', () => {
  const mappingTypes = [
    'equivalent',
    'supports',
    'partially_supports',
    'conditional',
    'conflicts',
    'supersedes',
    'related',
    'not_applicable',
  ] as const;

  it('preserves every mapping type and source material class as a versioned reviewed fact', () => {
    const materialTypes = [
      'requirement',
      'guidance',
      'draft',
      'organizational_duty',
      'external_certification',
    ] as const;
    for (const [index, mappingType] of mappingTypes.entries()) {
      const mapping = createFrameworkMapping({
        id: '018f0000-0000-7000-8000-0000000001' + String(index).padStart(2, '0'),
        tenantId: TENANT,
        sourcePublicationId: IDS.PUB_42001_ID,
        sourceClauseRef: 'A.' + (index + 1),
        sourceMaterialType: materialTypes[index % materialTypes.length]!,
        targetType: 'control',
        targetRef: '/controls/control-' + index,
        mappingType,
        coverageExtent:
          mappingType === 'partially_supports'
            ? 'partial'
            : mappingType === 'not_applicable'
              ? 'none'
              : mappingType === 'conditional'
                ? 'conditional'
                : 'full',
        conditions: mappingType === 'conditional' ? ['Only for production AI systems'] : [],
        applicabilityState: mappingType === 'not_applicable' ? 'not_applicable' : 'applicable',
        obligationOwnerPrincipalId: OWNER,
        mappingOwnerPrincipalId: OWNER,
        evidenceRefs: ['/evidence/mapping-' + index],
        rationale: 'Preserve the explicit relationship without creating a conformity claim.',
        confidenceBand: 'high',
        now: NOW,
      });
      const reviewed = reviewFrameworkMapping({
        mapping,
        tenantId: TENANT,
        expectedVersion: 1,
        reviewerPrincipalId: REVIEWER,
        authorityDecisionId: 'decision-framework-' + index,
        verdict: mappingType === 'conflicts' ? 'disputed' : 'active',
        reason: { code: 'mapping.review', text: 'Review the exact typed relationship.' },
        now: NOW + 1,
      });
      expect(reviewed.mappingType).toBe(mappingType);
      expect(reviewed.sourceMaterialType).toBe(materialTypes[index % materialTypes.length]);
      expect(reviewed.version).toBe(2);
      expect(reviewed.reviewedByPrincipalId).toBe(REVIEWER);
      expect(Object.isFrozen(reviewed.history)).toBe(true);
    }
  });

  it('rejects self-review and requires conditions for conditional mappings', () => {
    const input = {
      id: '018f0000-0000-7000-8000-000000000199',
      tenantId: TENANT,
      sourcePublicationId: IDS.PUB_42001_ID,
      sourceClauseRef: '5.1',
      sourceMaterialType: 'requirement' as const,
      targetType: 'control' as const,
      targetRef: '/controls/control-1',
      mappingType: 'conditional' as const,
      coverageExtent: 'conditional' as const,
      conditions: [] as string[],
      applicabilityState: 'conditional' as const,
      obligationOwnerPrincipalId: OWNER,
      mappingOwnerPrincipalId: OWNER,
      evidenceRefs: ['/evidence/mapping-conditional'],
      rationale: 'A condition is required.',
      confidenceBand: 'medium' as const,
      now: NOW,
    };
    expect(() => createFrameworkMapping(input)).toThrow(/condition/i);
    const mapping = createFrameworkMapping({
      ...input,
      conditions: ['Only for production AI systems'],
    });
    expect(() =>
      reviewFrameworkMapping({
        mapping,
        tenantId: TENANT,
        expectedVersion: 1,
        reviewerPrincipalId: OWNER,
        authorityDecisionId: 'decision-self-review',
        verdict: 'active',
        reason: { code: 'mapping.review', text: 'Self review must fail.' },
        now: NOW + 1,
      }),
    ).toThrow(/distinct|self|review/i);
  });
});
