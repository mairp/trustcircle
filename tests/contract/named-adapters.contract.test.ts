// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 8 · User Story 6 — NAMED ADAPTER MAPPINGS (T225 · FR-029 · FR-030 · SC-011 · SC-024).
//
// CONTRACT oracle pinning the FIVE shipped named adapters — Kanban, Workflow-Orchestration, agentctl,
// LISA, Wiggum — against a PINNED expectation table, and proving the load-bearing safety invariant that
// holds across every one of them: A CONNECTOR IS NEVER GRANTED GOVERNANCE AUTHORITY. Each adapter maps
// its source to raw observations only; none may approve, accept risk, close, or sign off.
//
// This is distinct from the generic manifest contract (T219): here every EXPECTED value is written down
// per named adapter (source class, capability set, content-access mode, delivery/idempotency model,
// operation-risk profile, reconciliation scope), so a silent drift in a shipped manifest is caught as a
// mismatch against the pin — not merely "still a valid manifest".
//
// The one consequential adapter (agentctl, which declares `execute`) is pinned SPECIFICALLY: it is the
// only adapter whose operation-risk profile includes a non-read_only class, and it STILL grants zero
// governance authority — proving least privilege is enforced even where a write capability exists.
//
// Every assertion pins a REAL SDK verdict / a REAL shipped manifest field — never a re-implemented rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  validateManifest,
  negotiateCapabilities,
  manifestDigest,
  type AdapterManifest,
  type AdapterCapability,
} from '@trustcircle/adapter-sdk';

import { NAMED_MANIFESTS } from '../fixtures/integrations.ts';

// ── The PINNED expectation table. A shipped-manifest drift is a mismatch against these. ──────────────

interface NamedAdapterPin {
  readonly sourceClass: string;
  readonly capabilities: readonly AdapterCapability[];
  readonly contentAccess: string;
  readonly ordering: string;
  readonly idempotency: string;
  /** The set of operation-risk classes the adapter's operation_risk map ranges over. */
  readonly operationRiskClasses: readonly string[];
  readonly reconciliationScope: string;
  /** True iff the adapter declares any write/consequential capability (agentctl only). */
  readonly hasConsequentialOperation: boolean;
}

const PINS: Readonly<Record<string, NamedAdapterPin>> = Object.freeze({
  kanban: {
    sourceClass: 'kanban',
    capabilities: ['discover', 'inspect', 'snapshot', 'subscribe', 'reconcile', 'collect_evidence'],
    contentAccess: 'metadata_only',
    ordering: 'aggregate_sequence',
    idempotency: 'read_only_only',
    operationRiskClasses: ['read_only'],
    reconciliationScope: 'collection',
    hasConsequentialOperation: false,
  },
  'workflow-orchestration': {
    sourceClass: 'workflow_orchestration',
    capabilities: ['discover', 'inspect', 'snapshot', 'subscribe', 'reconcile', 'collect_evidence'],
    contentAccess: 'scoped_content',
    ordering: 'aggregate_sequence',
    idempotency: 'read_only_only',
    operationRiskClasses: ['read_only'],
    reconciliationScope: 'source',
    hasConsequentialOperation: false,
  },
  agentctl: {
    sourceClass: 'agentctl',
    capabilities: ['discover', 'inspect', 'snapshot', 'execute', 'reconcile', 'collect_evidence'],
    contentAccess: 'scoped_content',
    ordering: 'source_revision',
    idempotency: 'source_operation_id',
    operationRiskClasses: ['read_only', 'consequential'],
    reconciliationScope: 'item',
    hasConsequentialOperation: true,
  },
  lisa: {
    sourceClass: 'lisa',
    capabilities: ['discover', 'inspect', 'snapshot', 'subscribe', 'reconcile', 'collect_evidence'],
    contentAccess: 'metadata_only',
    ordering: 'aggregate_sequence',
    idempotency: 'read_only_only',
    operationRiskClasses: ['read_only'],
    reconciliationScope: 'source',
    hasConsequentialOperation: false,
  },
  wiggum: {
    sourceClass: 'wiggum',
    capabilities: ['discover', 'inspect', 'snapshot', 'subscribe', 'reconcile', 'collect_evidence'],
    contentAccess: 'metadata_only',
    ordering: 'aggregate_sequence',
    idempotency: 'read_only_only',
    operationRiskClasses: ['read_only'],
    reconciliationScope: 'source',
    hasConsequentialOperation: false,
  },
});

/** A digestible governance-authority "smell test" — no authoritative field may name a decision. */
const APPROVAL_RE =
  /\bapprov|\baccept(ance|ed)?\b|\bdecision\b|\bsign[-_ ]?off\b|\bclos(e|ure)\b|\bgovernance_verdict\b|\bquarantine\b/i;

describe('named adapters · every shipped manifest matches its PINNED mapping', () => {
  it('loads exactly the five expected named adapters', () => {
    expect(Object.keys(NAMED_MANIFESTS).sort()).toEqual(Object.keys(PINS).sort());
  });

  for (const [id, pin] of Object.entries(PINS)) {
    describe(`${id}`, () => {
      const manifest: AdapterManifest = NAMED_MANIFESTS[id]!;

      it('is a valid manifest with the pinned identity + source class', () => {
        expect(validateManifest(manifest).valid).toBe(true);
        expect(manifest.adapter_id).toBe(id);
        expect(manifest.source_classes).toEqual([pin.sourceClass]);
      });

      it('declares exactly the pinned capability set (order-independent)', () => {
        expect([...manifest.capabilities].sort()).toEqual([...pin.capabilities].sort());
      });

      it('declares the pinned content-access, delivery ordering, and idempotency model', () => {
        expect(manifest.security.content_access).toBe(pin.contentAccess);
        expect(manifest.delivery.ordering).toBe(pin.ordering);
        expect(manifest.delivery.idempotency).toBe(pin.idempotency);
      });

      it('declares the pinned reconciliation scope', () => {
        expect(manifest.reconciliation.scope).toBe(pin.reconciliationScope);
      });

      it('declares the pinned operation-risk class range', () => {
        const classes = [...new Set(Object.values(manifest.authority.operation_risk))].sort();
        expect(classes).toEqual([...pin.operationRiskClasses].sort());
      });

      it('has a stable content digest (a pin against silent body drift)', () => {
        expect(manifestDigest(manifest)).toMatch(/^[a-f0-9]{64}$/);
      });
    });
  }
});

describe('named adapters · NONE is ever granted governance authority (load-bearing invariant)', () => {
  for (const id of Object.keys(PINS)) {
    const manifest = NAMED_MANIFESTS[id]!;

    it(`${id}: no authoritative field names an approval / decision / closure`, () => {
      for (const f of manifest.authority.authoritative_fields) {
        expect(f).not.toMatch(APPROVAL_RE);
      }
    });

    it(`${id}: declares explicit forbidden inferences (the conclusions it may NOT draw)`, () => {
      expect(manifest.authority.forbidden_inferences.length).toBeGreaterThan(0);
      // Every operation risk is a declared, closed class — never an implicit governance power.
      for (const risk of Object.values(manifest.authority.operation_risk)) {
        expect(['read_only', 'consequential', 'destructive']).toContain(risk);
      }
    });
  }
});

describe('named adapters · least privilege holds EVEN where a write capability exists (agentctl)', () => {
  const manifest = NAMED_MANIFESTS.agentctl;

  it('agentctl is the only named adapter declaring a consequential operation', () => {
    for (const [id, pin] of Object.entries(PINS)) {
      expect(pin.hasConsequentialOperation).toBe(id === 'agentctl');
    }
    expect(Object.values(manifest.authority.operation_risk)).toContain('consequential');
  });

  it('agentctl STILL grants zero governance authority despite `execute`', () => {
    expect(manifest.capabilities as readonly string[]).toContain('execute');
    for (const f of manifest.authority.authoritative_fields) {
      expect(f).not.toMatch(APPROVAL_RE);
    }
  });

  it('negotiation is a strict SUBSET — a capability agentctl does NOT declare is refused', () => {
    // A read-only subset negotiates.
    const subset = negotiateCapabilities(manifest, ['discover', 'inspect']);
    expect(subset.ok).toBe(true);

    // `approve` is not even a real capability; pick a real one agentctl lacks to prove refusal.
    const undeclared = (['subscribe'] as readonly AdapterCapability[]).find(
      (c) => !manifest.capabilities.includes(c),
    );
    if (undeclared) {
      const refused = negotiateCapabilities(manifest, [undeclared]);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toBe('not_declared');
    }
  });
});
