import { apiRead } from './api-client.ts';
import {
  DOMAIN_PRESENTATION,
  presentConsoleRecords,
  presentSectionFacts,
  type ConsoleRecordDetail,
  type ConsoleRecordField,
} from './console-presenter.ts';
import type { DomainPlan } from './permissions.ts';
import type { ReadQuality } from './read-model.ts';
import type { OperatorSessionContext } from './session-context.ts';

export interface ConsoleSectionState {
  readonly id: DomainPlan['id'];
  readonly title: string;
  readonly path: `/v1/${string}`;
  readonly quality: ReadQuality;
  readonly observedAt?: string;
  readonly source: string;
  readonly recordCount?: number;
  readonly verifiedEmpty: boolean;
  readonly summary: string;
  readonly description: string;
  readonly emptyMessage: string;
  readonly detailsLabel: string;
  readonly records: readonly ConsoleRecordDetail[];
  readonly facts: readonly ConsoleRecordField[];
  readonly hiddenRecordCount: number;
  readonly diagnostic?: string;
  readonly safeNextAction?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function collection(body: Record<string, unknown>): readonly unknown[] | undefined {
  for (const key of [
    'items',
    'records',
    'results',
    'data',
    'decisions',
    'controllers',
    'cases',
    'connectors',
  ]) {
    if (Array.isArray(body[key])) return body[key];
  }
  return undefined;
}

function observedAt(body: Record<string, unknown>): string | undefined {
  for (const key of ['observed_at', 'observedAt', 'generated_at', 'generatedAt']) {
    const value = body[key];
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value;
  }
  const epoch = body['observedAtMs'];
  if (typeof epoch === 'number' && Number.isFinite(epoch)) return new Date(epoch).toISOString();
  return undefined;
}

function tenantId(body: Record<string, unknown>): string | undefined {
  const value = body['tenant_id'] ?? body['tenantId'];
  return typeof value === 'string' ? value : undefined;
}

function declaredQuality(body: Record<string, unknown>): ReadQuality | undefined {
  const value = body['quality'] ?? body['aggregate'];
  if (value === 'healthy' || value === 'ready') return 'current';
  if (
    value === 'current' ||
    value === 'stale' ||
    value === 'partial' ||
    value === 'degraded' ||
    value === 'unavailable' ||
    value === 'unknown'
  )
    return value;
  return undefined;
}

function declaredSource(body: Record<string, unknown>, fallback: string): string {
  const value = body['source'];
  return typeof value === 'string' && /^[A-Za-z0-9:._/-]{1,160}$/.test(value) ? value : fallback;
}

function declaredSafeNextAction(body: Record<string, unknown>): string | undefined {
  const value = body['safeNextAction'] ?? body['safe_next_action'];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function declaredDiagnostic(body: Record<string, unknown>): string | undefined {
  const failures = body['partialFailures'] ?? body['partial_failures'];
  return Array.isArray(failures)
    ? failures.filter((failure): failure is string => typeof failure === 'string').join(', ')
    : undefined;
}

function emptyPresentation(plan: DomainPlan) {
  const presentation = DOMAIN_PRESENTATION[plan.id];
  return {
    description: presentation.description,
    emptyMessage: presentation.emptyMessage,
    detailsLabel: presentation.detailsLabel,
    records: [] as readonly ConsoleRecordDetail[],
    facts: [] as readonly ConsoleRecordField[],
    hiddenRecordCount: 0,
  };
}

export async function loadConsoleSection(
  plan: DomainPlan,
  session: OperatorSessionContext,
): Promise<ConsoleSectionState> {
  const result = await apiRead(plan.path, session);
  if (!result.ok) {
    return {
      id: plan.id,
      title: plan.label,
      path: plan.path,
      quality:
        result.failure === 'malformed_response' || result.failure === 'incompatible_version'
          ? 'unknown'
          : 'unavailable',
      source: `API ${plan.path}`,
      verifiedEmpty: false,
      summary:
        'Authoritative data is not available. No empty, healthy, complete, or compliant state is inferred.',
      ...emptyPresentation(plan),
      ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      ...(result.safeNextAction ? { safeNextAction: result.safeNextAction } : {}),
    };
  }
  const body = object(result.body);
  if (!body) {
    return {
      id: plan.id,
      title: plan.label,
      path: plan.path,
      quality: 'unknown',
      source: `API ${plan.path}`,
      verifiedEmpty: false,
      summary: 'The API response could not be validated.',
      safeNextAction: 'Inspect the versioned read contract and correlation-safe diagnostics.',
      ...emptyPresentation(plan),
    };
  }
  const observation = observedAt(body);
  const scopedTenant = tenantId(body);
  const rows = collection(body);
  const tenantMatches = scopedTenant === session.tenantId;
  const quality = observation && tenantMatches ? (declaredQuality(body) ?? 'current') : 'unknown';
  const verifiedEmpty = quality === 'current' && rows?.length === 0;
  const presentation = DOMAIN_PRESENTATION[plan.id];
  const records = presentConsoleRecords(plan.id, rows ?? []);
  const bodySafeNextAction = declaredSafeNextAction(body);
  const bodyDiagnostic = declaredDiagnostic(body);
  return {
    id: plan.id,
    title: plan.label,
    path: plan.path,
    quality,
    ...(observation ? { observedAt: observation } : {}),
    source: declaredSource(body, `API ${plan.path}`),
    ...(rows ? { recordCount: rows.length } : {}),
    verifiedEmpty,
    summary:
      quality === 'unknown'
        ? 'Tenant registration or reconciliation metadata is incomplete. Zero records is not treated as an authoritative empty state.'
        : verifiedEmpty
          ? presentation.emptyMessage
          : rows
            ? plan.id === 'posture'
              ? `${rows.length} governed domain${rows.length === 1 ? '' : 's'} reported.`
              : plan.id === 'operations'
                ? `${rows.length} declared runtime component${rows.length === 1 ? '' : 's'} reconciled against the backend.`
                : `${rows.length} tenant-scoped record${rows.length === 1 ? '' : 's'} observed.`
            : 'A response was received, but required tenant, freshness, or collection metadata is incomplete.',
    description: presentation.description,
    emptyMessage: presentation.emptyMessage,
    detailsLabel: presentation.detailsLabel,
    records,
    facts: presentSectionFacts(plan.id, body),
    hiddenRecordCount: rows ? Math.max(0, rows.length - records.length) : 0,
    ...(bodyDiagnostic ? { diagnostic: bodyDiagnostic } : {}),
    ...(bodySafeNextAction
      ? { safeNextAction: bodySafeNextAction }
      : quality === 'unknown'
        ? {
            safeNextAction:
              'Review the API contract metadata; do not infer status from this section.',
          }
        : {}),
  };
}

export async function loadConsole(
  plans: readonly DomainPlan[],
  session: OperatorSessionContext,
): Promise<readonly ConsoleSectionState[]> {
  return Promise.all(plans.map((plan) => loadConsoleSection(plan, session)));
}
