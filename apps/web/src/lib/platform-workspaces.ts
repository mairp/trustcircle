import type { ConsoleSectionState } from './console-loader.ts';
import type { ConsoleRecordDetail } from './console-presenter.ts';
import type { ConsoleDomain } from './permissions.ts';
import type { ReadQuality } from './read-model.ts';
import type { OperatorRole } from './session-context.ts';

export type WorkspaceGroup = 'overview' | 'governance' | 'assurance' | 'platform' | 'intelligence';

export interface PlatformWorkspace {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly href: `/${string}`;
  readonly description: string;
  readonly group: WorkspaceGroup;
  readonly domain?: ConsoleDomain;
  readonly roadmapCapabilities: readonly number[];
}

export const PLATFORM_WORKSPACES: readonly PlatformWorkspace[] = [
  {
    id: 'posture',
    label: 'Governance posture',
    shortLabel: 'Posture',
    href: '/posture',
    description: 'Role-aware posture, material risks, assurance coverage, and review focus.',
    group: 'overview',
    domain: 'posture',
    roadmapCapabilities: [1, 7, 9],
  },
  {
    id: 'operations-command-center',
    label: 'Operations command center',
    shortLabel: 'Attention queue',
    href: '/operations',
    description: 'Prioritized work, accountable cases, service levels, and safe escalation.',
    group: 'overview',
    roadmapCapabilities: [7, 8, 11, 13],
  },
  {
    id: 'inventory',
    label: 'Governed inventory',
    shortLabel: 'Inventory',
    href: '/inventory',
    description: 'Human-readable governed assets with ownership, risk, coverage, and Asset 360.',
    group: 'governance',
    domain: 'inventory',
    roadmapCapabilities: [1, 2, 3, 6, 16],
  },
  {
    id: 'gaps',
    label: 'Coverage gaps',
    shortLabel: 'Gaps',
    href: '/gaps',
    description: 'Unowned, stale, partial, uncertain, and uncovered governance state.',
    group: 'governance',
    domain: 'gaps',
    roadmapCapabilities: [1, 4, 8, 10],
  },
  {
    id: 'decisions',
    label: 'Human decisions',
    shortLabel: 'Decisions',
    href: '/decisions',
    description: 'Governed decision packages, approvals, expiry, delegation, and rationale.',
    group: 'governance',
    domain: 'decisions',
    roadmapCapabilities: [1, 7, 10, 15],
  },
  {
    id: 'integrity',
    label: 'Integrity and remediation',
    shortLabel: 'Integrity',
    href: '/integrity',
    description: 'Integrity cases, original evidence, bounded repair, verification, and closure.',
    group: 'governance',
    domain: 'integrity',
    roadmapCapabilities: [1, 8, 10, 13],
  },
  {
    id: 'registers',
    label: 'Risk and exception registers',
    shortLabel: 'Registers',
    href: '/registers',
    description: 'Cross-domain risk, gap, exception, finding, and improvement registers.',
    group: 'governance',
    roadmapCapabilities: [10, 11],
  },
  {
    id: 'controllers',
    label: 'Governed controllers',
    shortLabel: 'Controllers',
    href: '/controllers',
    description: 'Controller ownership, health, simulation binding, actions, and rollback.',
    group: 'platform',
    domain: 'controllers',
    roadmapCapabilities: [1, 13, 15],
  },
  {
    id: 'runtime',
    label: 'Runtime operations',
    shortLabel: 'Runtime',
    href: '/runtime',
    description: 'Declared components, live health, retry posture, and safe diagnostics.',
    group: 'platform',
    domain: 'operations',
    roadmapCapabilities: [1, 4, 8, 13],
  },
  {
    id: 'integrations',
    label: 'Integrations and connector kit',
    shortLabel: 'Integrations',
    href: '/integrations',
    description: 'Human-readable connector health, certification evidence, and adapter contracts.',
    group: 'platform',
    domain: 'integrations',
    roadmapCapabilities: [1, 6, 11, 18],
  },
  {
    id: 'compliance',
    label: 'Compliance coverage',
    shortLabel: 'Compliance',
    href: '/compliance',
    description: 'Framework, obligation, control, applicability, evaluation, and evidence mapping.',
    group: 'assurance',
    domain: 'compliance',
    roadmapCapabilities: [1, 10, 12],
  },
  {
    id: 'evidence',
    label: 'Evidence lifecycle',
    shortLabel: 'Evidence',
    href: '/evidence',
    description: 'Evidence freshness, expiry, provenance, custody, retention, and export posture.',
    group: 'assurance',
    domain: 'evidence',
    roadmapCapabilities: [1, 9, 11, 14],
  },
  {
    id: 'trends',
    label: 'Trends and review changes',
    shortLabel: 'Trends',
    href: '/trends',
    description: 'Current posture snapshots, review-period comparison, and explicit history gaps.',
    group: 'assurance',
    roadmapCapabilities: [9],
  },
  {
    id: 'automation',
    label: 'Monitoring and simulation',
    shortLabel: 'Automation',
    href: '/automation',
    description:
      'Continuous monitoring, evidence automation, impact previews, and bounded controls.',
    group: 'intelligence',
    roadmapCapabilities: [13, 14, 15],
  },
  {
    id: 'ai-governance',
    label: 'AI governance lifecycle',
    shortLabel: 'AI lifecycle',
    href: '/ai-governance',
    description:
      'AI use cases, models, evaluations, lineage, oversight, incidents, and retirement.',
    group: 'intelligence',
    roadmapCapabilities: [16],
  },
  {
    id: 'copilot',
    label: 'Governance copilot',
    shortLabel: 'Copilot',
    href: '/copilot',
    description:
      'Citation-led discovery that separates governed facts, inference, and recommendations.',
    group: 'intelligence',
    roadmapCapabilities: [17],
  },
  {
    id: 'search',
    label: 'Global search',
    shortLabel: 'Search',
    href: '/search',
    description: 'Search and share scoped views across every domain the current role may read.',
    group: 'intelligence',
    roadmapCapabilities: [2],
  },
] as const;

export function workspaceForDomain(domain: ConsoleDomain): PlatformWorkspace | undefined {
  return PLATFORM_WORKSPACES.find((workspace) => workspace.domain === domain);
}

export function workspaceForHref(href: string): PlatformWorkspace | undefined {
  return PLATFORM_WORKSPACES.find((workspace) => workspace.href === href);
}

export interface RoleDashboard {
  readonly title: string;
  readonly summary: string;
  readonly primaryHref: PlatformWorkspace['href'];
  readonly primaryLabel: string;
  readonly readOnly: boolean;
}

export const ROLE_DASHBOARDS: Readonly<Record<OperatorRole, RoleDashboard>> = {
  governance_officer: {
    title: 'Governance officer workbench',
    summary: 'Prioritize obligations, controls, decisions, cases, remediation, and accountability.',
    primaryHref: '/operations',
    primaryLabel: 'Open attention queue',
    readOnly: false,
  },
  control_owner: {
    title: 'Control owner workspace',
    summary: 'Focus on assigned gaps, expiring evidence, evaluations, attestations, and due dates.',
    primaryHref: '/search?view=my-attention',
    primaryLabel: 'Review assigned attention',
    readOnly: false,
  },
  auditor: {
    title: 'Auditor assurance workspace',
    summary:
      'Inspect evidence, provenance, applicability, history, and reproducible assurance records.',
    primaryHref: '/evidence',
    primaryLabel: 'Inspect evidence posture',
    readOnly: true,
  },
  operator: {
    title: 'Operator command center',
    summary:
      'Work the attention queue, failed operations, retries, connector health, and safe actions.',
    primaryHref: '/operations',
    primaryLabel: 'Open command center',
    readOnly: false,
  },
  authorized_approver: {
    title: 'Approval workspace',
    summary: 'Review decision context, authority, evidence, expiry, and simulation results.',
    primaryHref: '/decisions',
    primaryLabel: 'Review decisions',
    readOnly: false,
  },
  tenant_compliance_owner: {
    title: 'Compliance owner workbench',
    summary:
      'Review obligations, applicability, control coverage, gaps, evidence, and accountable actions.',
    primaryHref: '/compliance',
    primaryLabel: 'Open coverage matrix',
    readOnly: false,
  },
  independent_compliance_reviewer: {
    title: 'Independent assurance workspace',
    summary: 'Verify applicability, evidence sufficiency, findings, and closure independence.',
    primaryHref: '/compliance',
    primaryLabel: 'Review assurance coverage',
    readOnly: true,
  },
  platform_admin: {
    title: 'Platform support diagnostics',
    summary: 'Inspect disclosure-safe deployment health without implicit governance visibility.',
    primaryHref: '/runtime',
    primaryLabel: 'Open runtime diagnostics',
    readOnly: true,
  },
  central_governance_reviewer: {
    title: 'Central governance review',
    summary:
      'Review joint decisions, cross-tenant guardrails, and independent governance evidence.',
    primaryHref: '/decisions',
    primaryLabel: 'Review governed decisions',
    readOnly: true,
  },
  source_steward: {
    title: 'Source steward workspace',
    summary: 'Resolve ownership, freshness, onboarding, schema, and connector-quality gaps.',
    primaryHref: '/integrations',
    primaryLabel: 'Review source health',
    readOnly: false,
  },
  automation_principal: {
    title: 'Automation service scope',
    summary:
      'Service identity visibility is bounded to authorized automation and reconciliation status.',
    primaryHref: '/automation',
    primaryLabel: 'Inspect automation controls',
    readOnly: true,
  },
} as const;

export function dashboardForRoles(roles: readonly OperatorRole[]): RoleDashboard {
  const role = roles.find((candidate) => candidate !== 'platform_admin') ?? roles[0];
  return role ? ROLE_DASHBOARDS[role] : ROLE_DASHBOARDS.platform_admin;
}

export type StatusGroup = 'needs_attention' | 'blocked' | 'unknown' | 'healthy';

export interface ExplainableStatus {
  readonly group: StatusGroup;
  readonly label: string;
  readonly why: string;
  readonly safeNextAction: string;
  readonly owner?: string;
  readonly dueAt?: string;
  readonly confidence?: string;
  readonly freshness?: string;
}

const GROUP_LABELS: Readonly<Record<StatusGroup, string>> = {
  needs_attention: 'Needs attention',
  blocked: 'Blocked',
  unknown: 'Unknown',
  healthy: 'Healthy',
};

function fieldValue(record: ConsoleRecordDetail, labels: readonly string[]): string | undefined {
  return record.fields.find((field) => labels.includes(field.label))?.value;
}

function recordText(record: ConsoleRecordDetail): string {
  return [
    record.title,
    record.subtitle,
    ...record.fields.flatMap((field) => [field.label, field.value]),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function classifyRecordStatus(record: ConsoleRecordDetail): ExplainableStatus {
  const text = recordText(record);
  const owner = fieldValue(record, ['Owner', 'Requester', 'Source owner']);
  const dueAt = fieldValue(record, ['Due', 'Expires', 'Resolution target', 'Review / expiry']);
  const confidence = fieldValue(record, ['Confidence']);
  const freshness = fieldValue(record, ['Freshness', 'Evidence', 'Observed']);
  const safeAction = fieldValue(record, ['Safe next action']);
  let group: StatusGroup;
  let why: string;
  if (
    /\b(failed|failure|blocked|breached|quarantined|unavailable|expired|critical error)\b/.test(
      text,
    )
  ) {
    group = 'blocked';
    why =
      'A governed status field reports a failure, breach, quarantine, expiry, or unavailable dependency.';
  } else if (
    /\b(unknown|unowned|unassigned|unverified|not available)\b/.test(text) ||
    /\b0%\b/.test(text)
  ) {
    group = 'unknown';
    why = 'Required ownership, health, evidence, or confidence information is unknown.';
  } else if (
    /\b(stale|partial|degraded|overdue|expiring|warning|high|material|open issue|drift)\b/.test(
      text,
    )
  ) {
    group = 'needs_attention';
    why =
      'A governed field reports elevated risk, stale or partial evidence, drift, or time pressure.';
  } else {
    group = 'healthy';
    why =
      'No allowlisted field reports an unhealthy or uncertain posture in the current projection.';
  }
  const safeNextAction =
    safeAction ??
    (group === 'healthy'
      ? 'Continue monitoring the authoritative record and its freshness objective.'
      : group === 'unknown'
        ? 'Resolve missing ownership or source metadata before making a governance claim.'
        : group === 'blocked'
          ? 'Inspect the authoritative record, failure evidence, and governed recovery path.'
          : 'Open the authoritative record, confirm the owner and due date, and follow its governed next action.');
  return {
    group,
    label: GROUP_LABELS[group],
    why,
    safeNextAction,
    ...(owner ? { owner } : {}),
    ...(dueAt ? { dueAt } : {}),
    ...(confidence ? { confidence } : {}),
    ...(freshness ? { freshness } : {}),
  };
}

export function statusExplanation(section: ConsoleSectionState): ExplainableStatus {
  const qualityGroups: Readonly<Record<ReadQuality, StatusGroup>> = {
    current: 'healthy',
    stale: 'needs_attention',
    partial: 'needs_attention',
    degraded: 'blocked',
    unavailable: 'blocked',
    unknown: 'unknown',
  };
  const group = qualityGroups[section.quality];
  const why: Readonly<Record<ReadQuality, string>> = {
    current:
      'The authoritative source is current and its response passed scope and freshness checks.',
    stale: 'The authoritative observation is older than its freshness objective.',
    partial: 'The authoritative response identifies one or more missing or incomplete inputs.',
    degraded:
      'The domain is available only in a degraded state; current completeness is not established.',
    unavailable:
      'The authoritative domain could not be read; an empty or healthy state is not inferred.',
    unknown: 'Required scope, provenance, version, or observation metadata could not be validated.',
  };
  return {
    group,
    label: GROUP_LABELS[group],
    why: why[section.quality],
    safeNextAction:
      section.safeNextAction ??
      (group === 'healthy'
        ? 'Continue monitoring this domain against its freshness objective.'
        : 'Inspect the authoritative source, correlation-safe diagnostic, and accountable owner before acting.'),
    ...(section.observedAt ? { freshness: section.observedAt } : {}),
  };
}

export interface SavedView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly query: Readonly<Partial<DiscoveryQuery>>;
}

export const SAVED_VIEWS: readonly SavedView[] = [
  {
    id: 'my-attention',
    label: 'My attention',
    description: 'Unhealthy work assigned to the active principal.',
    query: { group: 'needs_attention', owner: 'me', sort: 'priority' },
  },
  {
    id: 'blocked-work',
    label: 'Blocked work',
    description: 'Failures, breaches, quarantines, expiry, and unavailable dependencies.',
    query: { group: 'blocked', sort: 'priority' },
  },
  {
    id: 'unknown-records',
    label: 'Unknown and unowned',
    description: 'Records whose ownership, health, evidence, or confidence is unknown.',
    query: { group: 'unknown', sort: 'priority' },
  },
  {
    id: 'expiring-evidence',
    label: 'Evidence expiring',
    description: 'Evidence records with expiry or stale posture.',
    query: { domain: 'evidence', q: 'expires stale', sort: 'due' },
  },
  {
    id: 'connector-health',
    label: 'Connector health',
    description: 'Integration health, freshness, lifecycle, and alerts.',
    query: { domain: 'integrations', sort: 'priority' },
  },
] as const;

export type DiscoverySort = 'priority' | 'title' | 'recent' | 'due';

export interface DiscoveryQuery {
  readonly q: string;
  readonly domain?: ConsoleDomain;
  readonly group?: StatusGroup;
  readonly quality?: ReadQuality;
  readonly owner?: string;
  readonly freshness?: string;
  readonly confidence?: string;
  readonly sort: DiscoverySort;
  readonly page: number;
  readonly pageSize: number;
  readonly view?: string;
}

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

function scalar(value: string | readonly string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function parseDiscoveryQuery(params: SearchParams): DiscoveryQuery {
  const view = scalar(params['view']);
  const preset = SAVED_VIEWS.find((candidate) => candidate.id === view)?.query;
  const domainInput = scalar(params['domain']) ?? preset?.domain;
  const groupInput = scalar(params['group']) ?? preset?.group;
  const qualityInput = scalar(params['quality']) ?? preset?.quality;
  const sortInput = scalar(params['sort']) ?? preset?.sort;
  const domain = [
    'posture',
    'inventory',
    'gaps',
    'decisions',
    'integrity',
    'controllers',
    'compliance',
    'evidence',
    'integrations',
    'operations',
  ].includes(domainInput ?? '')
    ? (domainInput as ConsoleDomain)
    : undefined;
  const group = ['needs_attention', 'blocked', 'unknown', 'healthy'].includes(groupInput ?? '')
    ? (groupInput as StatusGroup)
    : undefined;
  const quality = ['current', 'stale', 'partial', 'degraded', 'unavailable', 'unknown'].includes(
    qualityInput ?? '',
  )
    ? (qualityInput as ReadQuality)
    : undefined;
  const sort: DiscoverySort = ['priority', 'title', 'recent', 'due'].includes(sortInput ?? '')
    ? (sortInput as DiscoverySort)
    : 'priority';
  const q = (scalar(params['q']) ?? preset?.q ?? '').trim().slice(0, 240);
  const owner = (scalar(params['owner']) ?? preset?.owner)?.trim().slice(0, 160);
  const freshness = (scalar(params['freshness']) ?? preset?.freshness)?.trim().slice(0, 64);
  const confidence = (scalar(params['confidence']) ?? preset?.confidence)?.trim().slice(0, 64);
  return {
    q,
    ...(domain ? { domain } : {}),
    ...(group ? { group } : {}),
    ...(quality ? { quality } : {}),
    ...(owner ? { owner } : {}),
    ...(freshness ? { freshness } : {}),
    ...(confidence ? { confidence } : {}),
    sort,
    page: positiveInteger(scalar(params['page']), 1, 10_000),
    pageSize: positiveInteger(scalar(params['page_size']), 25, 100),
    ...(view ? { view } : {}),
  };
}

export interface DiscoveryItem extends ExplainableStatus {
  readonly id: string;
  readonly domain: ConsoleDomain;
  readonly domainLabel: string;
  readonly quality: ReadQuality;
  readonly title: string;
  readonly subtitle?: string;
  readonly href: string;
  readonly source: string;
  readonly observedAt?: string;
  readonly fields: ConsoleRecordDetail['fields'];
}

export interface DiscoveryResult {
  readonly items: readonly DiscoveryItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly qualityCounts: Readonly<Record<StatusGroup, number>>;
}

export interface RelatedAssetRecord {
  readonly section: ConsoleSectionState;
  readonly record: ConsoleRecordDetail;
}

const ASSET_REFERENCE_FIELD_LABELS = new Set([
  'Asset ID',
  'Subject',
  'Asset',
  'Asset reference',
  'Target asset',
  'Governed asset',
]);

function normalizedAssetReference(value: string): string {
  return value.trim().toLowerCase();
}

export function relatedAssetRecords(
  assetId: string,
  sections: readonly ConsoleSectionState[],
): readonly RelatedAssetRecord[] {
  const reference = normalizedAssetReference(assetId);
  if (!reference) return [];
  return sections.flatMap((section): readonly RelatedAssetRecord[] =>
    section.id === 'inventory'
      ? []
      : section.records
          .filter((record) =>
            record.fields.some(
              (field) =>
                ASSET_REFERENCE_FIELD_LABELS.has(field.label) &&
                normalizedAssetReference(field.value) === reference,
            ),
          )
          .map((record) => ({ section, record })),
  );
}

function assetIdentifier(record: ConsoleRecordDetail): string | undefined {
  return fieldValue(record, ['Asset ID']);
}

function resultHref(domain: ConsoleDomain, record: ConsoleRecordDetail): string {
  const assetId = domain === 'inventory' ? assetIdentifier(record) : undefined;
  if (assetId) return `/assets/${encodeURIComponent(assetId)}`;
  // Decision records open their live detail page, where an authorized reviewer can act.
  if (domain === 'decisions' && /^[0-9a-f-]{36}$/i.test(record.id)) {
    return `/decisions/${encodeURIComponent(record.id)}`;
  }
  const workspace = workspaceForDomain(domain)?.href ?? `/${domain}`;
  return `${workspace}?record=${encodeURIComponent(record.id)}#record-${encodeURIComponent(record.id)}`;
}

const GROUP_ORDER: Readonly<Record<StatusGroup, number>> = {
  blocked: 0,
  needs_attention: 1,
  unknown: 2,
  healthy: 3,
};

export function searchConsoleSections(
  sections: readonly ConsoleSectionState[],
  query: DiscoveryQuery,
  principalId?: string,
): DiscoveryResult {
  const terms = query.q.toLowerCase().split(/\s+/).filter(Boolean);
  const expanded = sections.flatMap((section): readonly DiscoveryItem[] =>
    section.records.map((record) => {
      const status = classifyRecordStatus(record);
      return {
        ...status,
        id: record.id,
        domain: section.id,
        domainLabel: section.title,
        quality: section.quality,
        title: record.title,
        ...(record.subtitle ? { subtitle: record.subtitle } : {}),
        href: resultHref(section.id, record),
        source: section.source,
        ...(section.observedAt ? { observedAt: section.observedAt } : {}),
        fields: record.fields,
      };
    }),
  );
  const filtered = expanded.filter((item) => {
    if (query.domain && item.domain !== query.domain) return false;
    if (query.group && item.group !== query.group) return false;
    if (query.quality && item.quality !== query.quality) return false;
    const text = [
      item.title,
      item.subtitle,
      item.domainLabel,
      item.label,
      item.why,
      ...item.fields.flatMap((field) => [field.label, field.value]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (terms.length > 0 && !terms.some((term) => text.includes(term))) return false;
    if (query.owner) {
      const owner = query.owner === 'me' ? principalId : query.owner;
      if (!owner || item.owner?.toLowerCase() !== owner.toLowerCase()) return false;
    }
    if (query.freshness && !item.freshness?.toLowerCase().includes(query.freshness.toLowerCase()))
      return false;
    if (query.confidence && item.confidence !== query.confidence) return false;
    return true;
  });
  filtered.sort((left, right) => {
    if (query.sort === 'title')
      return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
    if (query.sort === 'recent')
      return (
        Date.parse(right.observedAt ?? '') - Date.parse(left.observedAt ?? '') ||
        left.id.localeCompare(right.id)
      );
    if (query.sort === 'due')
      return (
        (Number.isFinite(Date.parse(left.dueAt ?? ''))
          ? Date.parse(left.dueAt!)
          : Number.MAX_SAFE_INTEGER) -
          (Number.isFinite(Date.parse(right.dueAt ?? ''))
            ? Date.parse(right.dueAt!)
            : Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id)
      );
    return (
      GROUP_ORDER[left.group] - GROUP_ORDER[right.group] ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
    );
  });
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / query.pageSize));
  const page = Math.min(query.page, pageCount);
  const start = (page - 1) * query.pageSize;
  const qualityCounts = expanded.reduce<Record<StatusGroup, number>>(
    (counts, item) => ({ ...counts, [item.group]: counts[item.group] + 1 }),
    { needs_attention: 0, blocked: 0, unknown: 0, healthy: 0 },
  );
  return {
    items: filtered.slice(start, start + query.pageSize),
    total,
    page,
    pageSize: query.pageSize,
    pageCount,
    qualityCounts,
  };
}

export interface DeploymentIdentity {
  readonly version: string;
  readonly commit: string;
  readonly profile: string;
  readonly schemaVersion: string;
  readonly drift: 'matched' | 'mismatch' | 'unknown';
  readonly mode: 'preview' | 'staging' | 'production' | 'continuity' | 'degraded' | 'development';
}

function safeIdentity(value: string | undefined, fallback: string, maximum = 80): string {
  const normalized = value?.trim();
  return normalized && /^[A-Za-z0-9._:/@+-]+$/.test(normalized)
    ? normalized.slice(0, maximum)
    : fallback;
}

export function deploymentIdentity(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DeploymentIdentity {
  const version = safeIdentity(
    environment['TC_APP_VERSION'] ?? environment['npm_package_version'],
    '0.1.0',
  );
  const fullCommit = safeIdentity(environment['TC_BUILD_COMMIT'], 'local');
  const approvedCommit = safeIdentity(environment['TC_APPROVED_BUILD_COMMIT'], 'unknown');
  const profile = safeIdentity(environment['TC_DEPLOYMENT_PROFILE'], 'development');
  const mode: DeploymentIdentity['mode'] = [
    'preview',
    'staging',
    'production',
    'continuity',
    'degraded',
    'development',
  ].includes(profile)
    ? (profile as DeploymentIdentity['mode'])
    : 'development';
  return {
    version,
    commit: fullCommit === 'local' ? fullCommit : fullCommit.slice(0, 12),
    profile,
    schemaVersion: safeIdentity(environment['TC_SCHEMA_VERSION'], 'unknown'),
    drift:
      fullCommit === 'local' || approvedCommit === 'unknown'
        ? 'unknown'
        : fullCommit === approvedCommit
          ? 'matched'
          : 'mismatch',
    mode,
  };
}
