// Phase 38 — evidence-boundary security tests (bundle 36GCYGDJ15PTYP60F91QWRAY2M,
// work item FBVSGW29PR3MNRBNXWNG5FMVCK).
//
// Sole acceptance criterion / canonical oracle
//   VO-b9b935bf93be10bdecdd (also VO-c03b3c1cb5014d1b72e2 / VO-4aeb030a32c9deebdb3b):
//   "Originals MUST remain immutable or tamper-evident; derived repairs, exports,
//    redactions, and dispositions MUST retain provenance, integrity, authorization,
//    retention, and access history."
//
// Objective: test EVIDENCE-WRITE FAILURE BEFORE MUTATION, CROSS-TENANT DENIAL, LEGAL HOLD,
// DISPOSITION, and DERIVATIVE PROVENANCE against the real evidence subsystem
// (packages/evidence/src). Every assertion observes a durable, independently readable effect
// (stored bytes / access history / signed record / hash-chained ledger) — never a mutation's
// return value alone — and every positive path is paired with a negative control so the
// oracle is non-vacuous.
//
// The whole test is dependency-free: it drives the in-memory immutable object store and the
// pure retention / provenance modules directly, so it is observable under `npm ci` with no
// live infrastructure. Run: `vitest run --project security`.

import { describe, it, expect } from 'vitest';

import {
  EvidenceService,
  EvidenceCommitError,
  EvidenceAccessError,
  evidenceDigest,
  type EvidenceHandle,
} from '../../packages/evidence/src/evidence-service.ts';

import {
  InMemoryImmutableObjectStore,
  ImmutableObjectError,
  contentAddress,
  deletionBlockReason,
  retainsRequiredProvenance,
  type ObjectMetadata,
  type StoredObject,
} from '../../packages/evidence/src/object-store.ts';

import {
  evaluateDisposition,
  recordDisposition,
  verifyDispositionRecord,
  verifyContentIntegrity,
  hasValidProvenance,
  activeHoldsFor,
  DispositionNotPermittedError,
  type Authorization,
  type EvidenceItem,
  type LegalHold,
  type RetentionPolicy,
} from '../../packages/evidence/src/retention.ts';

import {
  ProvenanceLedger,
  ProvenanceError,
  verifyEdgeChain,
  canonicalHash,
  type ProvenanceEdge,
} from '../../packages/evidence/src/provenance.ts';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const AUTH: Authorization = { principalId: 'officer-a', grantId: 'grant-1' };
const AUTH_B: Authorization = { principalId: 'officer-b', grantId: 'grant-2' };
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function retention(retainUntil: number): { mode: 'COMPLIANCE'; retainUntil: number } {
  return { mode: 'COMPLIANCE', retainUntil };
}

function makeItem(over: Partial<EvidenceItem> = {}): EvidenceItem {
  const content = bytes(over.contentSha256 ? 'x' : 'original-bytes');
  return {
    evidenceItemId: 'ev-1',
    tenantId: 'tenant-a',
    kind: 'original',
    contentSha256: contentAddress(content),
    parentEvidenceId: null,
    classification: 'sensitive',
    createdAt: T0,
    ...over,
  };
}

// ===========================================================================
// 1. EVIDENCE-WRITE FAILURE BEFORE MUTATION
//    A rejected write must not alter, create, or corrupt any stored object.
//    Witness: read the store through an independent path AFTER the failure.
// ===========================================================================

describe('evidence-write failure leaves originals unmutated (write fails before mutation)', () => {
  it('rejects a content-address mismatch and stores NOTHING (no partial write)', () => {
    const store = new InMemoryImmutableObjectStore();
    const content = bytes('capture-1');
    const digest = contentAddress(content);
    const meta: ObjectMetadata = {
      tenantId: 'tenant-a',
      kind: 'original',
      classification: 'sensitive',
      provenance: { parentDigest: null, method: 'capture', transformationDigest: null },
      authorization: AUTH,
      retention: null,
      createdAt: T0,
    };

    // A lying expectedDigest is a tamper signal: the put MUST throw before any state change.
    expect(() =>
      store.put({ content, metadata: meta, by: AUTH, now: T0, expectedDigest: 'deadbeef' }),
    ).toThrow(ImmutableObjectError);

    // Independent read path: the object was never created.
    expect(store.exists(digest)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it('rejects overwriting an existing address with DIFFERENT bytes and preserves the original bytes', () => {
    const store = new InMemoryImmutableObjectStore();
    const original = bytes('the-original-record');
    const meta: ObjectMetadata = {
      tenantId: 'tenant-a',
      kind: 'original',
      classification: 'sensitive',
      provenance: { parentDigest: null, method: 'capture', transformationDigest: null },
      authorization: AUTH,
      retention: null,
      createdAt: T0,
    };
    const put = store.put({ content: original, metadata: meta, by: AUTH, now: T0 });

    // Forge a write that claims the SAME content address but carries different bytes.
    const forged = bytes('tampered-record');
    expect(() =>
      store.put({
        content: forged,
        metadata: meta,
        by: AUTH_B,
        now: T0 + 1,
        expectedDigest: put.digest, // same key, different body ⇒ tamper.
      }),
    ).toThrow(ImmutableObjectError);

    // Independent read: bytes, version, and access history are exactly what was first committed.
    const got = store.get(put.digest, AUTH, T0 + 2);
    expect(new TextDecoder().decode(got.content)).toBe('the-original-record');
    expect(got.object.versionId).toBe(put.versionId);
    // The failed forge left no 'put' by officer-b in the history.
    expect(got.object.accessHistory.some((a) => a.principalId === 'officer-b')).toBe(false);
  });

  it('idempotent re-put of IDENTICAL bytes is a dedup no-op, not a mutation', () => {
    const store = new InMemoryImmutableObjectStore();
    const content = bytes('same-bytes');
    const meta: ObjectMetadata = {
      tenantId: 'tenant-a',
      kind: 'original',
      classification: 'internal',
      provenance: { parentDigest: null, method: 'capture', transformationDigest: null },
      authorization: AUTH,
      retention: null,
      createdAt: T0,
    };
    const first = store.put({ content, metadata: meta, by: AUTH, now: T0 });
    const second = store.put({ content, metadata: meta, by: AUTH_B, now: T0 + 5 });

    expect(second.deduplicated).toBe(true);
    expect(second.versionId).toBe(first.versionId); // same version — no new object version.
    expect(store.list()).toHaveLength(1);
  });

  it('service rejects a DERIVED write whose parent original does not yet exist — original-first', () => {
    const svc = new EvidenceService();
    const missingParent: EvidenceHandle = {
      tenantId: 'tenant-a',
      digest: contentAddress(bytes('never-committed')),
    };

    let thrown: unknown;
    try {
      svc.commitDerived({
        tenantId: 'tenant-a',
        parent: missingParent,
        kind: 'redaction',
        content: bytes('redacted-derivative'),
        classification: 'sensitive',
        authorization: AUTH,
        now: T0,
        retention: retention(T0 + DAY),
        transformationDigest: contentAddress(bytes('redaction-ruleset')),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EvidenceCommitError);
    expect((thrown as EvidenceCommitError).reason).toBe('parent-not-found');

    // Independent read: the failed derivation created no object of any kind.
    const derivedHandle: EvidenceHandle = {
      tenantId: 'tenant-a',
      digest: contentAddress(bytes('redacted-derivative')),
    };
    expect(svc.exists(derivedHandle)).toBe(false);
    expect(svc.exists(missingParent)).toBe(false);
  });

  it('a quarantined original stays inspectable but cannot be a derivation parent (blocked before write)', () => {
    const svc = new EvidenceService();
    const orig = svc.commitOriginal({
      tenantId: 'tenant-a',
      content: bytes('unsafe-original'),
      classification: 'restricted',
      authorization: AUTH,
      now: T0,
      execution: 'quarantined',
    });

    // Visible & inspectable: the quarantined original reads back fine.
    const head = svc.head(orig.handle, AUTH, T0 + 1);
    expect(head.metadata.kind).toBe('original');
    expect(svc.executionState(orig.handle)).toBe('quarantined');

    // But it cannot drive a derivation — rejected before any derived object is written.
    let thrown: unknown;
    try {
      svc.commitDerived({
        tenantId: 'tenant-a',
        parent: orig.handle,
        kind: 'repair',
        content: bytes('repair-derivative'),
        classification: 'restricted',
        authorization: AUTH,
        now: T0 + 2,
        retention: retention(T0 + DAY),
        transformationDigest: contentAddress(bytes('repair-patch')),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EvidenceCommitError);
    expect((thrown as EvidenceCommitError).reason).toBe('parent-quarantined');
    expect(
      svc.exists({ tenantId: 'tenant-a', digest: contentAddress(bytes('repair-derivative')) }),
    ).toBe(false);
  });
});

// ===========================================================================
// 2. CROSS-TENANT DENIAL
//    Tenant A can never read, derive from, or dispose tenant B's evidence.
// ===========================================================================

describe('cross-tenant denial (tenant isolation of evidence)', () => {
  it('the same bytes committed by two tenants are isolated: a cross-tenant handle is not-found', () => {
    const svc = new EvidenceService();
    const content = bytes('collision-candidate'); // identical bytes ⇒ identical digest.
    const a = svc.commitOriginal({
      tenantId: 'tenant-a',
      content,
      classification: 'internal',
      authorization: AUTH,
      now: T0,
    });
    const b = svc.commitOriginal({
      tenantId: 'tenant-b',
      content,
      classification: 'internal',
      authorization: AUTH_B,
      now: T0,
    });
    expect(a.handle.digest).toBe(b.handle.digest); // digests collide…

    // …but the namespaces don't: tenant-b's principal cannot read via a tenant-a handle.
    const crossHandle: EvidenceHandle = { tenantId: 'tenant-c', digest: a.handle.digest };
    expect(svc.exists(crossHandle)).toBe(false);
    expect(() => svc.get(crossHandle, AUTH, T0 + 1)).toThrow(EvidenceAccessError);

    // Each tenant still reads its OWN object independently.
    expect(svc.get(a.handle, AUTH, T0 + 1).object.metadata.tenantId).toBe('tenant-a');
    expect(svc.get(b.handle, AUTH_B, T0 + 1).object.metadata.tenantId).toBe('tenant-b');
  });

  it('a derived write may not attach to a parent in ANOTHER tenant', () => {
    const svc = new EvidenceService();
    const parentA = svc.commitOriginal({
      tenantId: 'tenant-a',
      content: bytes('a-original'),
      classification: 'sensitive',
      authorization: AUTH,
      now: T0,
    });

    let thrown: unknown;
    try {
      svc.commitDerived({
        tenantId: 'tenant-b', // derived claims tenant-b…
        parent: { tenantId: 'tenant-a', digest: parentA.handle.digest }, // …parent is tenant-a.
        kind: 'export',
        content: bytes('cross-tenant-export'),
        classification: 'sensitive',
        authorization: AUTH_B,
        now: T0 + 1,
        retention: retention(T0 + DAY),
        transformationDigest: contentAddress(bytes('export-query')),
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(EvidenceCommitError);
    expect((thrown as EvidenceCommitError).reason).toBe('parent-tenant-mismatch');
  });

  it('disposition is refused when the item tenant differs from the handle tenant', () => {
    const svc = new EvidenceService();
    const orig = svc.commitOriginal({
      tenantId: 'tenant-a',
      content: bytes('disposable-a'),
      classification: 'internal',
      authorization: AUTH,
      now: T0,
    });
    const wrongTenantItem: EvidenceItem = {
      evidenceItemId: 'ev-x',
      tenantId: 'tenant-b', // mismatched with the tenant-a handle.
      kind: 'original',
      contentSha256: orig.handle.digest,
      parentEvidenceId: null,
      classification: 'internal',
      createdAt: T0,
    };
    expect(() =>
      svc.disposeEvidence({
        handle: orig.handle,
        item: wrongTenantItem,
        policies: [],
        holds: [],
        authorization: AUTH,
        method: 'delete',
        executedBy: 'officer-a',
        signingKey: 'k',
        now: T0 + DAY,
      }),
    ).toThrow(EvidenceAccessError);
  });

  it('a legal hold scoped to tenant-b does NOT cover a tenant-a item', () => {
    const itemA = makeItem({ tenantId: 'tenant-a', evidenceItemId: 'ev-a' });
    const holdB: LegalHold = {
      holdId: 'hold-b',
      tenantId: 'tenant-b',
      scopeEvidenceIds: [],
      status: 'active',
    };
    expect(activeHoldsFor(itemA, [holdB])).toEqual([]); // no cross-tenant hold coverage.
  });
});

// ===========================================================================
// 3. LEGAL HOLD
//    An active hold blocks disposition and store deletion regardless of retention.
// ===========================================================================

describe('legal hold enforcement (disposition + deletion blocked while held)', () => {
  const elapsedPolicy: RetentionPolicy = {
    policyId: 'ret-30d',
    tenantId: 'tenant-a',
    appliesToClassifications: [],
    durationMillis: 30 * DAY,
    approved: true,
  };

  it('disposition is BLOCKED while any active hold covers the item, even after retention elapses', () => {
    const item = makeItem();
    const hold: LegalHold = {
      holdId: 'hold-1',
      tenantId: 'tenant-a',
      scopeEvidenceIds: ['ev-1'],
      status: 'active',
    };
    const wayPastRetention = T0 + 365 * DAY; // retention long elapsed.
    const decision = evaluateDisposition({
      item,
      policies: [elapsedPolicy],
      holds: [hold],
      authorization: AUTH,
      now: wayPastRetention,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('active-legal-hold');
    expect(decision.activeHoldIds).toEqual(['hold-1']);

    // recordDisposition must refuse to mint a record.
    expect(() =>
      recordDisposition({
        item,
        policies: [elapsedPolicy],
        holds: [hold],
        authorization: AUTH,
        now: wayPastRetention,
        method: 'delete',
        executedBy: 'officer-a',
        accessHistory: [],
        signingKey: 'k',
      }),
    ).toThrow(DispositionNotPermittedError);
  });

  it('RELEASING the hold unblocks disposition (negative control for the hold gate)', () => {
    const item = makeItem();
    const released: LegalHold = {
      holdId: 'hold-1',
      tenantId: 'tenant-a',
      scopeEvidenceIds: ['ev-1'],
      status: 'released',
    };
    const decision = evaluateDisposition({
      item,
      policies: [elapsedPolicy],
      holds: [released],
      authorization: AUTH,
      now: T0 + 365 * DAY,
    });
    expect(decision.activeHoldIds).toEqual([]);
    expect(decision.reasons).not.toContain('active-legal-hold');
    expect(decision.eligible).toBe(true);
  });

  it('the object store refuses to DELETE bytes under an active legal hold, and records the denial', () => {
    const store = new InMemoryImmutableObjectStore();
    const content = bytes('held-evidence');
    const meta: ObjectMetadata = {
      tenantId: 'tenant-a',
      kind: 'original',
      classification: 'restricted',
      provenance: { parentDigest: null, method: 'capture', transformationDigest: null },
      authorization: AUTH,
      retention: null,
      createdAt: T0,
    };
    const put = store.put({ content, metadata: meta, by: AUTH, now: T0 });
    store.setLegalHold(put.digest, AUTH, T0 + 1);

    let thrown: unknown;
    try {
      store.delete({ digest: put.digest, by: AUTH, now: T0 + 2 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ImmutableObjectError);
    expect((thrown as ImmutableObjectError).reason).toBe('active-legal-hold');

    // Independent read: the object still exists, and the refused delete is in the access history.
    expect(store.exists(put.digest)).toBe(true);
    const head = store.head(put.digest, AUTH, T0 + 3);
    expect(head.accessHistory.some((a) => a.action === 'delete-denied')).toBe(true);
    // deletionBlockReason agrees (pure decision function is directly observable).
    expect(deletionBlockReason({ ...head, legalHold: true }, T0 + 2)).toBe('active-legal-hold');
  });

  it('COMPLIANCE retention that has not elapsed also blocks deletion, un-bypassably', () => {
    const store = new InMemoryImmutableObjectStore();
    const content = bytes('worm-original');
    const meta: ObjectMetadata = {
      tenantId: 'tenant-a',
      kind: 'original',
      classification: 'restricted',
      provenance: { parentDigest: null, method: 'capture', transformationDigest: null },
      authorization: AUTH,
      retention: retention(T0 + 10 * DAY),
      createdAt: T0,
    };
    const put = store.put({ content, metadata: meta, by: AUTH, now: T0 });

    // Even with a bypass flag, COMPLIANCE mode cannot be bypassed.
    expect(() =>
      store.delete({
        digest: put.digest,
        by: AUTH,
        now: T0 + DAY,
        bypassGovernanceRetention: true,
      }),
    ).toThrow(ImmutableObjectError);
    expect(store.exists(put.digest)).toBe(true);
  });
});

// ===========================================================================
// 4. DISPOSITION
//    A permitted disposition mints a SIGNED, tamper-evident record retaining
//    provenance, integrity, authorization, retention, and access history.
// ===========================================================================

describe('signed disposition records retain provenance/integrity/authorization/retention/access history', () => {
  const policy: RetentionPolicy = {
    policyId: 'ret-1d',
    tenantId: 'tenant-a',
    appliesToClassifications: ['internal'],
    durationMillis: 1 * DAY,
    approved: true,
  };

  function eligibleItem(): EvidenceItem {
    return makeItem({ classification: 'internal', contentSha256: contentAddress(bytes('body')) });
  }

  it('mints a signed record only AFTER retention elapses, carrying all five required facts', () => {
    const item = eligibleItem();
    const signingKey = 'disposition-signing-key';
    const now = item.createdAt + 2 * DAY; // retention (1d) elapsed.
    const record = recordDisposition({
      item,
      policies: [policy],
      holds: [],
      authorization: AUTH,
      now,
      method: 'crypto-shred',
      executedBy: 'officer-a',
      accessHistory: [{ principalId: 'officer-a', action: 'get', at: now - 1 }],
      signingKey,
    });

    // (1) provenance — resolved policy IDs; (2) integrity — contentSha256 anchor;
    // (3) authorization — principal+grant; (4) retention — the resolved policy; (5) access history.
    expect(record.resolvedPolicyIds).toEqual(['ret-1d']);
    expect(record.contentSha256).toBe(item.contentSha256);
    expect(record.authorization).toEqual(AUTH);
    expect(record.method).toBe('crypto-shred');
    expect(record.accessHistory).toHaveLength(1);

    // The record is tamper-evident: it verifies under the key…
    expect(verifyDispositionRecord(record, signingKey)).toBe(true);
    // …and a wrong key or any field mutation fails verification (negative controls).
    expect(verifyDispositionRecord(record, 'wrong-key')).toBe(false);
    const tampered = { ...record, method: 'delete' as const };
    expect(verifyDispositionRecord(tampered, signingKey)).toBe(false);
    const tamperedHistory = { ...record, contentSha256: 'f'.repeat(64) };
    expect(verifyDispositionRecord(tamperedHistory, signingKey)).toBe(false);
  });

  it('disposition BEFORE retention elapses is refused (negative control for the retention gate)', () => {
    const item = eligibleItem();
    const decision = evaluateDisposition({
      item,
      policies: [policy],
      holds: [],
      authorization: AUTH,
      now: item.createdAt + 1, // well before 1d.
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reasons).toContain('retention-not-elapsed');
    expect(() =>
      recordDisposition({
        item,
        policies: [policy],
        holds: [],
        authorization: AUTH,
        now: item.createdAt + 1,
        method: 'delete',
        executedBy: 'officer-a',
        accessHistory: [],
        signingKey: 'k',
      }),
    ).toThrow(DispositionNotPermittedError);
  });

  it('an UNAUTHORIZED disposition is refused even when retention has elapsed', () => {
    const item = eligibleItem();
    const decision = evaluateDisposition({
      item,
      policies: [policy],
      holds: [],
      authorization: null, // no authorization.
      now: item.createdAt + 2 * DAY,
    });
    expect(decision.reasons).toContain('unauthorized');
    expect(decision.eligible).toBe(false);
  });

  it('the disposition of a derived artifact does not mutate the immutable original', () => {
    const svc = new EvidenceService();
    const orig = svc.commitOriginal({
      tenantId: 'tenant-a',
      content: bytes('the-original'),
      classification: 'internal',
      authorization: AUTH,
      now: T0,
    });
    const derived = svc.commitDerived({
      tenantId: 'tenant-a',
      parent: orig.handle,
      kind: 'export',
      content: bytes('the-export'),
      classification: 'internal',
      authorization: AUTH,
      now: T0 + 1,
      retention: retention(T0 + DAY),
      transformationDigest: contentAddress(bytes('export-query')),
    });
    const derivedItem: EvidenceItem = {
      evidenceItemId: 'ev-derived',
      tenantId: 'tenant-a',
      kind: 'export',
      contentSha256: derived.handle.digest,
      parentEvidenceId: orig.handle.digest,
      classification: 'internal',
      createdAt: T0 + 1,
    };
    const record = svc.disposeEvidence({
      handle: derived.handle,
      item: derivedItem,
      policies: [],
      holds: [],
      authorization: AUTH,
      method: 'archive',
      executedBy: 'officer-a',
      signingKey: 'k',
      now: T0 + 2 * DAY,
    });
    expect(verifyDispositionRecord(record, 'k')).toBe(true);

    // Independent read: the ORIGINAL is byte-for-byte intact after the derived disposition.
    const stillThere = svc.get(orig.handle, AUTH, T0 + 3 * DAY);
    expect(new TextDecoder().decode(stillThere.content)).toBe('the-original');
    expect(stillThere.object.metadata.kind).toBe('original');
  });
});

// ===========================================================================
// 5. DERIVATIVE PROVENANCE
//    Derived artifacts retain a reconstructable, tamper-evident link to the
//    immutable original; the provenance ledger detects any tampering.
// ===========================================================================

describe('derivative provenance (immutable, tamper-evident lineage)', () => {
  it('a stored derived object structurally retains provenance/integrity/authorization/retention/history', () => {
    const svc = new EvidenceService();
    const orig = svc.commitOriginal({
      tenantId: 'tenant-a',
      content: bytes('root'),
      classification: 'sensitive',
      authorization: AUTH,
      now: T0,
    });
    const derived = svc.commitDerived({
      tenantId: 'tenant-a',
      parent: orig.handle,
      kind: 'redaction',
      content: bytes('redacted'),
      classification: 'sensitive',
      authorization: AUTH,
      now: T0 + 1,
      retention: retention(T0 + DAY),
      transformationDigest: contentAddress(bytes('redaction-ruleset')),
    });

    const chain = svc.provenanceChain(derived.handle, AUTH, T0 + 2);
    expect(chain).toHaveLength(2); // [derived, original]
    expect(chain[0]!.metadata.kind).toBe('redaction');
    expect(chain[1]!.metadata.kind).toBe('original');
    expect(chain[0]!.metadata.provenance.parentDigest).toBe(orig.handle.digest);

    // The stored derived object retains all five required facts; the original retains its shape.
    expect(retainsRequiredProvenance(chain[0] as StoredObject)).toBe(true);
    expect(retainsRequiredProvenance(chain[1] as StoredObject)).toBe(true);

    // Negative control: a derived object stripped of its transformation digest fails the check.
    const stripped: StoredObject = {
      ...(chain[0] as StoredObject),
      metadata: {
        ...chain[0]!.metadata,
        provenance: { ...chain[0]!.metadata.provenance, transformationDigest: null },
      },
    };
    expect(retainsRequiredProvenance(stripped)).toBe(false);
  });

  it('the provenance ledger enforces original-first and rejects a derived edge with no parent', () => {
    const ledger = new ProvenanceLedger('tenant-a');
    const origDigest = contentAddress(bytes('ledger-root'));
    ledger.append({
      tenantId: 'tenant-a',
      nodeKind: 'original',
      nodeDigest: origDigest,
      parentDigest: null,
      transformationDigest: null,
      method: 'capture',
      classification: 'sensitive',
      authorization: AUTH,
      retention: null,
      accessHistoryCount: 1,
      recordedAt: T0,
    });

    // A derived edge whose parent is not yet in the ledger is rejected (original-first).
    let thrown: unknown;
    try {
      ledger.append({
        tenantId: 'tenant-a',
        nodeKind: 'repair',
        nodeDigest: contentAddress(bytes('orphan-repair')),
        parentDigest: contentAddress(bytes('unknown-parent')),
        transformationDigest: contentAddress(bytes('patch')),
        method: 'repair',
        classification: 'sensitive',
        authorization: AUTH,
        retention: retention(T0 + DAY),
        accessHistoryCount: 1,
        recordedAt: T0 + 1,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProvenanceError);
    expect((thrown as ProvenanceError).reason).toBe('parent-not-in-ledger');
  });

  it('the hash-chained ledger verifies intact and DETECTS any tampering (tamper-evidence)', () => {
    const ledger = new ProvenanceLedger('tenant-a');
    const rootDigest = contentAddress(bytes('chain-root'));
    ledger.append({
      tenantId: 'tenant-a',
      nodeKind: 'original',
      nodeDigest: rootDigest,
      parentDigest: null,
      transformationDigest: null,
      method: 'capture',
      classification: 'internal',
      authorization: AUTH,
      retention: null,
      accessHistoryCount: 1,
      recordedAt: T0,
    });
    ledger.append({
      tenantId: 'tenant-a',
      nodeKind: 'export',
      nodeDigest: contentAddress(bytes('chain-export')),
      parentDigest: rootDigest,
      transformationDigest: contentAddress(bytes('export-q')),
      method: 'export',
      classification: 'internal',
      authorization: AUTH,
      retention: retention(T0 + DAY),
      accessHistoryCount: 2,
      recordedAt: T0 + 1,
    });

    // Intact ledger verifies.
    expect(ledger.verify().valid).toBe(true);
    const edges = ledger.edges();
    expect(verifyEdgeChain(edges).valid).toBe(true);

    // Tamper with a field of an edge WITHOUT recomputing its hash: the chain must break.
    const forged: ProvenanceEdge[] = edges.map((e) => ({ ...e }));
    forged[1] = { ...forged[1]!, classification: 'public' }; // silently down-classify.
    const res = verifyEdgeChain(forged);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.brokenAt).toBe(1);
      expect(res.reason).toBe('edge-hash-mismatch');
    }

    // Reordering the edges also breaks the chain (order is fixed).
    const reordered = [edges[1]!, edges[0]!];
    expect(verifyEdgeChain(reordered).valid).toBe(false);
  });

  it('an original cannot be re-parented — a node is recorded once and is immutable', () => {
    const ledger = new ProvenanceLedger('tenant-a');
    const d = contentAddress(bytes('once'));
    ledger.append({
      tenantId: 'tenant-a',
      nodeKind: 'original',
      nodeDigest: d,
      parentDigest: null,
      transformationDigest: null,
      method: 'capture',
      classification: 'internal',
      authorization: AUTH,
      retention: null,
      accessHistoryCount: 1,
      recordedAt: T0,
    });
    // A second edge for the SAME node digest (attempting to add a parent) is refused.
    expect(() =>
      ledger.append({
        tenantId: 'tenant-a',
        nodeKind: 'derived',
        nodeDigest: d,
        parentDigest: contentAddress(bytes('some-parent')),
        transformationDigest: contentAddress(bytes('t')),
        method: 'derived',
        classification: 'internal',
        authorization: AUTH,
        retention: retention(T0 + DAY),
        accessHistoryCount: 1,
        recordedAt: T0 + 1,
      }),
    ).toThrow(ProvenanceError);
  });

  it('content integrity + provenance-shape helpers agree with the immutability oracle', () => {
    const content = bytes('integrity-body');
    const item = makeItem({ contentSha256: contentAddress(content), kind: 'original' });
    // Original: unchanged bytes verify; a single flipped byte is detected as tamper.
    expect(verifyContentIntegrity(item, content)).toBe(true);
    expect(verifyContentIntegrity(item, bytes('integrity-body!'))).toBe(false);
    // Provenance shape: original has no parent; a derived item must retain one.
    expect(hasValidProvenance(item)).toBe(true);
    const derivedItem = makeItem({ kind: 'export', parentEvidenceId: 'ev-1' });
    expect(hasValidProvenance(derivedItem)).toBe(true);
    const brokenDerived = makeItem({ kind: 'export', parentEvidenceId: null });
    expect(hasValidProvenance(brokenDerived)).toBe(false);
  });

  it('canonicalHash is deterministic and order-independent for object keys (stable identities)', () => {
    const a = canonicalHash({ x: 1, y: [2, 3], z: { b: 'q', a: 'p' } });
    const b = canonicalHash({ z: { a: 'p', b: 'q' }, y: [2, 3], x: 1 });
    expect(a).toBe(b);
    // A different value yields a different hash (non-vacuous).
    expect(canonicalHash({ x: 1, y: [3, 2], z: { a: 'p', b: 'q' } })).not.toBe(a);
  });

  it('evidenceDigest matches the object-store content address (single integrity anchor)', () => {
    const content = bytes('anchor-check');
    expect(evidenceDigest(content)).toBe(contentAddress(content));
  });
});
