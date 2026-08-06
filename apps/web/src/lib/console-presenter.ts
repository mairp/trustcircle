import type { ConsoleDomain } from './permissions.ts';

export interface ConsoleRecordField {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: 'status' | 'identifier' | 'time';
}

export interface ConsoleRecordDetail {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly fields: readonly ConsoleRecordField[];
}

export interface ConsoleDomainPresentation {
  readonly description: string;
  readonly emptyMessage: string;
  readonly detailsLabel: string;
}

export const DOMAIN_PRESENTATION: Readonly<Record<ConsoleDomain, ConsoleDomainPresentation>> = {
  posture: {
    description:
      'Authoritative record counts across the tenant inventory, decision, integrity, controller, and connector domains.',
    emptyMessage: 'No posture domains were returned by the authoritative read model.',
    detailsLabel: 'Posture by governed domain',
  },
  inventory: {
    description:
      'Governed assets such as systems, AI services, models, workflows, and data products, with ownership, risk, coverage, health, and evidence currency.',
    emptyMessage: 'No governed assets are registered for this tenant.',
    detailsLabel: 'Governed assets',
  },
  gaps: {
    description:
      'Discovered sources and their onboarding, ownership, access, health, sensitivity, and control-coverage state.',
    emptyMessage:
      'No governed sources are registered for this tenant. This does not establish that no sources exist.',
    detailsLabel: 'Governed sources and gaps',
  },
  decisions: {
    description:
      'Human decision packages awaiting, receiving, or recording governed review, including risk, scope, evidence, requirements, and expiry.',
    emptyMessage: 'No human decision packages are currently registered for this tenant.',
    detailsLabel: 'Decision packages',
  },
  integrity: {
    description:
      'Integrity, quarantine, remediation, and verification cases that require attributable follow-through.',
    emptyMessage: 'No integrity or remediation cases are currently registered for this tenant.',
    detailsLabel: 'Integrity cases',
  },
  controllers: {
    description:
      'Governed controller definitions and observed instances, including ownership, version, health, drift, and allowed state transitions.',
    emptyMessage: 'No governed controller definitions are registered for this tenant.',
    detailsLabel: 'Governed controllers',
  },
  compliance: {
    description:
      'Publications, obligations, internal control mappings, evaluations, evidence, and coverage gaps. Internal readiness is not legal compliance or certification.',
    emptyMessage:
      'No publications, obligations, control mappings, evaluations, evidence, or coverage gaps are registered for this tenant.',
    detailsLabel: 'Compliance coverage records',
  },
  evidence: {
    description:
      'Governed evidence metadata and custody posture available to the auditor role; protected evidence content is never rendered here.',
    emptyMessage: 'No governed evidence metadata is registered for this tenant.',
    detailsLabel: 'Evidence records',
  },
  integrations: {
    description:
      'Connector and adapter inventory with accountable ownership, lifecycle, capability, freshness, health, and alert state.',
    emptyMessage: 'No governed connectors are registered for this tenant.',
    detailsLabel: 'Connectors and adapters',
  },
  operations: {
    description:
      'The owner-approved component profile reconciled against disclosure-safe live probes. Runtime availability is shown separately from design authority and expected-offline state.',
    emptyMessage:
      'No runtime component declarations were returned. Treat this as a composition failure, not an empty platform.',
    detailsLabel: 'Declared versus observed components',
  },
};

type RecordObject = Readonly<Record<string, unknown>>;
type FieldFormat = 'text' | 'label' | 'identifier' | 'time' | 'boolean' | 'count' | 'percentage';

interface FieldPlan {
  readonly label: string;
  readonly keys: readonly string[];
  readonly format?: FieldFormat;
  readonly emphasis?: ConsoleRecordField['emphasis'];
}

const FIELD_PLANS: Readonly<Record<ConsoleDomain, readonly FieldPlan[]>> = {
  posture: [
    { label: 'Domain', keys: ['domain'], format: 'label' },
    { label: 'Governed records', keys: ['record_count'], format: 'count' },
  ],
  inventory: [
    { label: 'Asset ID', keys: ['assetId'], format: 'identifier', emphasis: 'identifier' },
    { label: 'Type', keys: ['assetType'], format: 'label' },
    { label: 'Owner', keys: ['ownerPrincipalId'], format: 'label' },
    { label: 'Lifecycle', keys: ['lifecycleState'], format: 'label', emphasis: 'status' },
    { label: 'Risk tier', keys: ['riskTier'], format: 'label', emphasis: 'status' },
    { label: 'Coverage', keys: ['coverage'], format: 'label', emphasis: 'status' },
    { label: 'Health', keys: ['reportedHealth'], format: 'label', emphasis: 'status' },
    { label: 'Evidence', keys: ['evidenceState'], format: 'label', emphasis: 'status' },
    { label: 'Observed', keys: ['lastObservationAt'], format: 'time', emphasis: 'time' },
    { label: 'Open issues', keys: ['unresolvedIssueCount'], format: 'count' },
    { label: 'Confidence', keys: ['confidence'], format: 'percentage' },
  ],
  gaps: [
    { label: 'Source ID', keys: ['sourceId', 'id'], format: 'identifier', emphasis: 'identifier' },
    { label: 'Class', keys: ['sourceClass'], format: 'label' },
    { label: 'Owner', keys: ['ownerPrincipalId'], format: 'label' },
    { label: 'Onboarding', keys: ['onboardingState'], format: 'label', emphasis: 'status' },
    { label: 'Access', keys: ['accessState'], format: 'label', emphasis: 'status' },
    {
      label: 'Health',
      keys: ['reportedHealth', 'healthState'],
      format: 'label',
      emphasis: 'status',
    },
    { label: 'Sensitivity', keys: ['sensitivity'], format: 'label' },
    { label: 'Ownership gap', keys: ['ownershipGap'], format: 'boolean', emphasis: 'status' },
    { label: 'Control coverage', keys: ['hasControlCoverage'], format: 'boolean' },
    { label: 'Open issues', keys: ['unresolvedIssueCount'], format: 'count' },
    { label: 'Last known', keys: ['lastKnownAt', 'lastSeenAt'], format: 'time', emphasis: 'time' },
    { label: 'Confidence', keys: ['confidence'], format: 'percentage' },
  ],
  decisions: [
    { label: 'Decision ID', keys: ['id'], format: 'identifier', emphasis: 'identifier' },
    { label: 'Work item', keys: ['workItemId'], format: 'identifier' },
    { label: 'Action', keys: ['requestedAction'], format: 'text' },
    { label: 'Action class', keys: ['actionClass'], format: 'label' },
    { label: 'Risk tier', keys: ['riskTier'], format: 'label', emphasis: 'status' },
    { label: 'Status', keys: ['status'], format: 'label', emphasis: 'status' },
    { label: 'Requester', keys: ['requesterPrincipalId'], format: 'label' },
    { label: 'Evidence manifest', keys: ['evidenceManifestId'], format: 'identifier' },
    { label: 'Requirements', keys: ['requirements'], format: 'count' },
    { label: 'Expires', keys: ['expiresAt'], format: 'time', emphasis: 'time' },
  ],
  integrity: [
    { label: 'Case ID', keys: ['id'], format: 'identifier', emphasis: 'identifier' },
    { label: 'Problem class', keys: ['problemClass'], format: 'label' },
    { label: 'Severity', keys: ['severity'], format: 'label', emphasis: 'status' },
    { label: 'State', keys: ['state'], format: 'label', emphasis: 'status' },
    { label: 'Original evidence', keys: ['originalEvidenceId'], format: 'identifier' },
    { label: 'Quarantine', keys: ['quarantineId'], format: 'identifier' },
    { label: 'Remediation plan', keys: ['remediationPlanId'], format: 'identifier' },
    { label: 'Verification', keys: ['verificationId'], format: 'identifier' },
  ],
  controllers: [
    { label: 'Controller ID', keys: ['id'], format: 'identifier', emphasis: 'identifier' },
    { label: 'Owner', keys: ['ownerPrincipalId'], format: 'label' },
    { label: 'Health', keys: ['health'], format: 'label', emphasis: 'status' },
    { label: 'Bound version', keys: ['controllerVersion'], format: 'text' },
    { label: 'Observed version', keys: ['observedVersion'], format: 'text' },
    { label: 'Observed', keys: ['observedAt'], format: 'time', emphasis: 'time' },
    { label: 'Next actions', keys: ['nextPermittedActions'], format: 'count' },
  ],
  compliance: [
    { label: 'Record type', keys: ['record_type'], format: 'label', emphasis: 'status' },
    {
      label: 'Record ID',
      keys: ['id', 'evidence_item_id', 'obligation_id', 'control_mapping_id'],
      format: 'identifier',
      emphasis: 'identifier',
    },
    { label: 'Title', keys: ['exactTitle', 'exact_title', 'title'], format: 'text' },
    { label: 'Identifier', keys: ['identifier'], format: 'identifier' },
    { label: 'Publisher', keys: ['publisher'], format: 'text' },
    {
      label: 'Status',
      keys: ['status', 'state', 'coverage_state'],
      format: 'label',
      emphasis: 'status',
    },
    { label: 'Obligation', keys: ['obligation_text', 'obligation'], format: 'text' },
    { label: 'Control', keys: ['control_id', 'control_key'], format: 'identifier' },
    { label: 'Evidence type', keys: ['evidence_type'], format: 'label' },
    { label: 'Observed', keys: ['observed_at', 'collected_at', 'evaluated_at'], format: 'time' },
  ],
  evidence: [
    {
      label: 'Evidence ID',
      keys: ['evidence_item_id', 'id'],
      format: 'identifier',
      emphasis: 'identifier',
    },
    { label: 'Type', keys: ['evidence_type', 'type'], format: 'label' },
    { label: 'Subject', keys: ['subject_id', 'subject_ref'], format: 'identifier' },
    { label: 'Source system', keys: ['source_system', 'source'], format: 'text' },
    { label: 'Quality', keys: ['quality_status', 'quality'], format: 'label', emphasis: 'status' },
    { label: 'Custody', keys: ['custody_status'], format: 'label', emphasis: 'status' },
    { label: 'Collected', keys: ['collected_at', 'observed_at'], format: 'time', emphasis: 'time' },
    { label: 'Expires', keys: ['expires_at'], format: 'time', emphasis: 'time' },
    { label: 'Digest', keys: ['content_digest'], format: 'identifier' },
  ],
  integrations: [
    { label: 'Connector ID', keys: ['id'], format: 'identifier', emphasis: 'identifier' },
    { label: 'Adapter', keys: ['adapterKey'], format: 'label' },
    { label: 'Source', keys: ['sourceRef'], format: 'text' },
    { label: 'Owner', keys: ['ownerPrincipalId'], format: 'label' },
    { label: 'Availability', keys: ['availabilityClass'], format: 'label', emphasis: 'status' },
    { label: 'Lifecycle', keys: ['lifecycleState'], format: 'label', emphasis: 'status' },
    { label: 'Health', keys: ['health'], format: 'label', emphasis: 'status' },
    { label: 'Freshness', keys: ['freshness'], format: 'label', emphasis: 'status' },
    { label: 'Version', keys: ['observedVersion'], format: 'text' },
    { label: 'Capabilities', keys: ['enabledCapabilities'], format: 'text' },
    { label: 'Alerts', keys: ['alerts'], format: 'count' },
    { label: 'Observed', keys: ['observedAt'], format: 'time', emphasis: 'time' },
  ],
  operations: [
    {
      label: 'Component',
      keys: ['component_key', 'id'],
      format: 'identifier',
      emphasis: 'identifier',
    },
    { label: 'Role', keys: ['role'], format: 'label' },
    { label: 'Runtime set', keys: ['runtime_set'], format: 'label', emphasis: 'status' },
    {
      label: 'Runtime state',
      keys: ['runtime_state'],
      format: 'label',
      emphasis: 'status',
    },
    { label: 'Health', keys: ['health'], format: 'label', emphasis: 'status' },
    { label: 'Freshness', keys: ['freshness'], format: 'label', emphasis: 'status' },
    { label: 'Owner', keys: ['owner'], format: 'text' },
    { label: 'Purpose', keys: ['purpose'], format: 'text' },
    { label: 'Dependencies', keys: ['dependencies'], format: 'text' },
    { label: 'May execute', keys: ['may_execute'], format: 'boolean', emphasis: 'status' },
    { label: 'Observation source', keys: ['observation_source'], format: 'label' },
    { label: 'Observation detail', keys: ['observation_detail'], format: 'text' },
    { label: 'Safe next action', keys: ['safe_next_action'], format: 'text' },
    { label: 'Observed', keys: ['observed_at'], format: 'time', emphasis: 'time' },
  ],
};

const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  inventory: 'Governed inventory',
  decisions: 'Human decisions',
  integrity: 'Integrity and remediation',
  controllers: 'Controllers',
  connectors: 'Integrations',
  'runtime-components': 'Runtime components',
};

function record(value: unknown): RecordObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as RecordObject)
    : undefined;
}

function selectedValue(row: RecordObject, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function humanize(value: string): string {
  const words = value.trim().replace(/[_-]+/g, ' ').split(/\s+/).filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (lower === 'ai') return 'AI';
      if (lower === 'api') return 'API';
      if (lower === 'id') return 'ID';
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

function bounded(value: string): string {
  const normalized = value.trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function formatTime(value: unknown): string | undefined {
  const timestamp =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : typeof value === 'string'
          ? Date.parse(value)
          : Number.NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function formatValue(value: unknown, format: FieldFormat = 'text'): string | undefined {
  if (format === 'time') return formatTime(value);
  if (format === 'boolean') return typeof value === 'boolean' ? (value ? 'Yes' : 'No') : undefined;
  if (format === 'count') {
    const count = Array.isArray(value)
      ? value.length
      : typeof value === 'number'
        ? value
        : Number(value);
    return Number.isFinite(count) ? String(count) : undefined;
  }
  if (format === 'percentage') {
    const amount = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(amount)) return undefined;
    const percent = amount >= 0 && amount <= 1 ? amount * 100 : amount;
    return `${Math.round(percent)}%`;
  }
  if (Array.isArray(value)) {
    const safeItems = value.filter(
      (item): item is string | number => typeof item === 'string' || typeof item === 'number',
    );
    return safeItems.length > 0 ? bounded(safeItems.slice(0, 6).join(', ')) : undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  return bounded(format === 'label' ? humanize(text) : text);
}

function titleFor(domain: ConsoleDomain, row: RecordObject, index: number): string {
  if (domain === 'posture') {
    const key = selectedValue(row, ['domain']);
    return typeof key === 'string' ? (DOMAIN_LABELS[key] ?? humanize(key)) : `Domain ${index + 1}`;
  }
  const titleKeys: Readonly<Record<ConsoleDomain, readonly string[]>> = {
    posture: ['domain'],
    inventory: ['name', 'displayName', 'assetId'],
    gaps: ['sourceClass', 'sourceId', 'id'],
    decisions: ['requestedAction', 'id'],
    integrity: ['problemClass', 'id'],
    controllers: ['name', 'id'],
    compliance: ['exactTitle', 'exact_title', 'title', 'identifier', 'id', 'evidence_item_id'],
    evidence: ['title', 'evidence_type', 'type', 'evidence_item_id', 'id'],
    integrations: ['adapterKey', 'sourceRef', 'id'],
    operations: ['component_key', 'adapterKey', 'sourceRef', 'id'],
  };
  const value = selectedValue(row, titleKeys[domain]);
  return value === undefined ? `Record ${index + 1}` : humanize(String(value));
}

function subtitleFor(domain: ConsoleDomain, row: RecordObject): string | undefined {
  if (domain === 'posture') {
    const value = selectedValue(row, ['record_count']);
    const count = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(count) ? `${count} governed record${count === 1 ? '' : 's'}` : undefined;
  }
  const keys: Readonly<Partial<Record<ConsoleDomain, readonly string[]>>> = {
    inventory: ['assetType'],
    gaps: ['onboardingState'],
    decisions: ['status'],
    integrity: ['severity'],
    controllers: ['health'],
    compliance: ['record_type'],
    evidence: ['quality_status', 'quality'],
    integrations: ['health'],
    operations: ['health'],
  };
  const value = selectedValue(row, keys[domain] ?? []);
  return typeof value === 'string' ? humanize(value) : undefined;
}

export function presentConsoleRecords(
  domain: ConsoleDomain,
  values: readonly unknown[],
): readonly ConsoleRecordDetail[] {
  return values.slice(0, 500).flatMap((value, index) => {
    const row = record(value);
    if (!row) return [];
    const fields = FIELD_PLANS[domain].flatMap((plan) => {
      const formatted = formatValue(selectedValue(row, plan.keys), plan.format);
      return formatted
        ? [
            {
              label: plan.label,
              value: formatted,
              ...(plan.emphasis ? { emphasis: plan.emphasis } : {}),
            },
          ]
        : [];
    });
    const rawId = selectedValue(row, [
      'id',
      'component_key',
      'assetId',
      'sourceId',
      'evidence_item_id',
      'domain',
    ]);
    const subtitle = subtitleFor(domain, row);
    return [
      {
        id: rawId === undefined ? `${domain}-${index + 1}` : `${domain}-${String(rawId)}`,
        title: titleFor(domain, row, index),
        ...(subtitle ? { subtitle } : {}),
        fields,
      },
    ];
  });
}

function fact(
  label: string,
  value: unknown,
  format: FieldFormat = 'text',
): ConsoleRecordField | undefined {
  const formatted = formatValue(value, format);
  return formatted ? { label, value: formatted } : undefined;
}

export function presentSectionFacts(
  domain: ConsoleDomain,
  body: Readonly<Record<string, unknown>>,
): readonly ConsoleRecordField[] {
  if (domain === 'operations') {
    const platformState = formatValue(body['aggregate'], 'label');
    return [
      ...(platformState
        ? [{ label: 'Platform state', value: platformState, emphasis: 'status' as const }]
        : []),
      fact('Open alerts', body['openAlerts'], 'count'),
      fact('Stale connectors', body['staleConnectorIds'], 'count'),
    ].filter((item): item is ConsoleRecordField => item !== undefined);
  }
  if (domain === 'compliance') {
    const boundary = formatValue(body['claimBoundary'], 'label');
    return [
      ...(boundary
        ? [{ label: 'Claim boundary', value: boundary, emphasis: 'status' as const }]
        : []),
      fact('Publications', body['publications'], 'count'),
      fact('Obligations', body['obligations'], 'count'),
      fact('Controls', body['controls'], 'count'),
      fact('Evidence', body['evidence'], 'count'),
      fact('Coverage gaps', body['gaps'], 'count'),
    ].filter((item): item is ConsoleRecordField => item !== undefined);
  }
  return [];
}
