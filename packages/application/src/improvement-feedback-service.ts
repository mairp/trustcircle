import { governedDigest } from '@trustcircle/domain';

export const PRODUCT_EXPERIENCE_METRICS = [
  'time_to_find',
  'time_to_acknowledge',
  'time_to_resolve',
  'workflow_abandonment',
  'failed_search',
  'workspace_adoption',
  'saved_view_adoption',
] as const;

export type ProductExperienceMetric = (typeof PRODUCT_EXPERIENCE_METRICS)[number];
export type ImprovementHypothesisStatus = 'proposed' | 'approved' | 'rejected' | 'concluded';
export type ImprovementDeliveryStatus = 'not_started' | 'in_progress' | 'delivered';
export type ImprovementDecision = 'approve' | 'reject';

export interface AggregateProductMeasure {
  readonly ref: string;
  readonly schemaVersion: number;
  readonly metric: ProductExperienceMetric;
  readonly routeFamily: string;
  readonly windowStart: number;
  readonly windowEnd: number;
  readonly sampleCount: number;
  readonly aggregation: 'duration_bucket_distribution' | 'count' | 'rate' | 'adoption_rate';
  readonly retentionPolicyId: string;
  readonly collectionPolicyDecisionId: string;
}

export interface ImprovementHistoryEntry {
  readonly sequence: number;
  readonly action: 'proposed' | ImprovementDecision | ImprovementDeliveryStatus | 'conclude';
  readonly actorPrincipalId: string;
  readonly authorityDecisionId?: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly occurredAt: number;
  readonly recordDigest: string;
}

export interface ImprovementHypothesis {
  readonly id: string;
  readonly tenantId: string;
  readonly productScope: string;
  readonly analyticsSchemaVersion: number;
  readonly aggregateMeasureRefs: readonly string[];
  readonly aggregateMeasures: readonly AggregateProductMeasure[];
  readonly hypothesis: string;
  readonly ownerPrincipalId: string;
  readonly createdByPrincipalId: string;
  readonly expectedOutcome: string;
  readonly baselineWindow: Readonly<{ start: number; end: number }>;
  readonly targetWindow: Readonly<{ start: number; end: number }>;
  readonly status: ImprovementHypothesisStatus;
  readonly decisionRefs: readonly string[];
  readonly deliveryStatus: ImprovementDeliveryStatus;
  readonly outcomeMeasures: readonly AggregateProductMeasure[];
  readonly conclusion?: string;
  readonly resourceVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly history: readonly ImprovementHistoryEntry[];
}

export interface CreateImprovementHypothesisInput {
  readonly id: string;
  readonly tenantId: string;
  readonly productScope: string;
  readonly analyticsSchemaVersion: number;
  readonly aggregateMeasures: readonly AggregateProductMeasure[];
  readonly hypothesis: string;
  readonly ownerPrincipalId: string;
  readonly createdByPrincipalId: string;
  readonly expectedOutcome: string;
  readonly baselineWindow: Readonly<{ start: number; end: number }>;
  readonly targetWindow: Readonly<{ start: number; end: number }>;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly now: number;
}

export interface DecideImprovementHypothesisInput {
  readonly hypothesis: ImprovementHypothesis;
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly decision: ImprovementDecision;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly now: number;
}

export interface UpdateImprovementDeliveryInput {
  readonly hypothesis: ImprovementHypothesis;
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly deliveryStatus: Exclude<ImprovementDeliveryStatus, 'not_started'>;
  readonly actorPrincipalId: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly now: number;
}

export interface ConcludeImprovementHypothesisInput {
  readonly hypothesis: ImprovementHypothesis;
  readonly tenantId: string;
  readonly expectedVersion: number;
  readonly actorPrincipalId: string;
  readonly authorityDecisionId: string;
  readonly outcomeMeasures: readonly AggregateProductMeasure[];
  readonly conclusion: string;
  readonly reason: Readonly<{ code: string; text: string }>;
  readonly now: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGGREGATE_REF_RE = /^aggregate:\/\/product\/[a-z][a-z0-9_]*\/[0-9]{4}-[0-9]{2}$/;
const ROUTE_FAMILIES = new Set([
  '/',
  '/posture',
  '/operations',
  '/inventory',
  '/assets',
  '/gaps',
  '/decisions',
  '/integrity',
  '/registers',
  '/controllers',
  '/runtime',
  '/integrations',
  '/compliance',
  '/evidence',
  '/trends',
  '/automation',
  '/ai-governance',
  '/copilot',
  '/search',
]);
const MEASURE_FIELDS = new Set([
  'ref',
  'schemaVersion',
  'metric',
  'routeFamily',
  'windowStart',
  'windowEnd',
  'sampleCount',
  'aggregation',
  'retentionPolicyId',
  'collectionPolicyDecisionId',
]);

function text(value: unknown, label: string, max = 2_000): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(label + ' must be bounded non-empty text');
  }
}

function uuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new TypeError(label + ' must be a UUID');
  }
}

function epoch(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError(label + ' must be a non-negative epoch-ms');
  }
}

function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(label + ' must be a positive integer');
  }
}

function reason(
  value: Readonly<{ code: string; text: string }>,
): Readonly<{ code: string; text: string }> {
  text(value?.code, 'reason code', 128);
  text(value?.text, 'reason text', 2_000);
  return Object.freeze({ code: value.code.trim(), text: value.text.trim() });
}

function window(
  value: Readonly<{ start: number; end: number }>,
  label: string,
): Readonly<{ start: number; end: number }> {
  epoch(value?.start, label + ' start');
  epoch(value?.end, label + ' end');
  if (value.end <= value.start) throw new RangeError(label + ' end must be after start');
  return Object.freeze({ start: value.start, end: value.end });
}

function aggregateMeasure(
  value: AggregateProductMeasure,
  analyticsSchemaVersion: number,
): AggregateProductMeasure {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('aggregate measure must be an object');
  }
  if (Object.keys(value).some((field) => !MEASURE_FIELDS.has(field))) {
    throw new TypeError('aggregate measure contains a privacy-prohibited or unknown field');
  }
  if (!AGGREGATE_REF_RE.test(value.ref)) {
    throw new TypeError('aggregate measure ref must identify a bounded monthly product aggregate');
  }
  positiveInteger(value.schemaVersion, 'aggregate measure schema version');
  if (value.schemaVersion !== analyticsSchemaVersion) {
    throw new RangeError('aggregate measure schema version must match the hypothesis schema');
  }
  if (!PRODUCT_EXPERIENCE_METRICS.includes(value.metric)) {
    throw new TypeError('aggregate measure metric is unsupported');
  }
  if (!ROUTE_FAMILIES.has(value.routeFamily)) {
    throw new TypeError('aggregate measure route must be a disclosure-safe route family');
  }
  epoch(value.windowStart, 'aggregate measure window start');
  epoch(value.windowEnd, 'aggregate measure window end');
  if (value.windowEnd <= value.windowStart) {
    throw new RangeError('aggregate measure window must have a positive duration');
  }
  positiveInteger(value.sampleCount, 'aggregate measure sample count');
  if (value.sampleCount < 5) {
    throw new RangeError('aggregate measure sample count is below the privacy threshold');
  }
  if (
    !['duration_bucket_distribution', 'count', 'rate', 'adoption_rate'].includes(value.aggregation)
  ) {
    throw new TypeError('aggregate measure aggregation is unsupported');
  }
  text(value.retentionPolicyId, 'aggregate measure retention policy id', 256);
  text(value.collectionPolicyDecisionId, 'aggregate measure collection policy decision id', 256);
  return Object.freeze({ ...value });
}

function measures(
  values: readonly AggregateProductMeasure[],
  analyticsSchemaVersion: number,
): readonly AggregateProductMeasure[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('at least one aggregate measure is required');
  }
  const validated = values.map((value) => aggregateMeasure(value, analyticsSchemaVersion));
  if (new Set(validated.map((value) => value.ref)).size !== validated.length) {
    throw new TypeError('aggregate measure refs must be unique');
  }
  return Object.freeze(validated);
}

function guardCurrent(
  item: ImprovementHypothesis,
  tenantId: string,
  expectedVersion: number,
): void {
  if (item.tenantId !== tenantId) throw new RangeError('improvement hypothesis tenant mismatch');
  if (item.resourceVersion !== expectedVersion) {
    throw new RangeError('improvement hypothesis changed; reload its current version');
  }
}

function historyEntry(
  item: Omit<ImprovementHypothesis, 'history'>,
  action: ImprovementHistoryEntry['action'],
  actorPrincipalId: string,
  authorityDecisionId: string | undefined,
  why: Readonly<{ code: string; text: string }>,
  occurredAt: number,
): ImprovementHistoryEntry {
  return Object.freeze({
    sequence: item.resourceVersion,
    action,
    actorPrincipalId,
    ...(authorityDecisionId === undefined ? {} : { authorityDecisionId }),
    reason: why,
    occurredAt,
    recordDigest: governedDigest({
      id: item.id,
      tenantId: item.tenantId,
      status: item.status,
      deliveryStatus: item.deliveryStatus,
      decisionRefs: item.decisionRefs,
      aggregateMeasureRefs: item.aggregateMeasureRefs,
      outcomeMeasureRefs: item.outcomeMeasures.map((measure) => measure.ref),
      conclusion: item.conclusion ?? null,
      resourceVersion: item.resourceVersion,
    }),
  });
}

function freezeItem(
  item: Omit<ImprovementHypothesis, 'history'>,
  history: readonly ImprovementHistoryEntry[],
): ImprovementHypothesis {
  return Object.freeze({
    ...item,
    aggregateMeasureRefs: Object.freeze([...item.aggregateMeasureRefs]),
    aggregateMeasures: Object.freeze([...item.aggregateMeasures]),
    decisionRefs: Object.freeze([...item.decisionRefs]),
    outcomeMeasures: Object.freeze([...item.outcomeMeasures]),
    history: Object.freeze([...history]),
  });
}

export function createImprovementHypothesis(
  input: CreateImprovementHypothesisInput,
): ImprovementHypothesis {
  uuid(input.id, 'improvement hypothesis id');
  uuid(input.tenantId, 'tenant id');
  uuid(input.ownerPrincipalId, 'owner principal id');
  uuid(input.createdByPrincipalId, 'creator principal id');
  text(input.productScope, 'product scope', 256);
  positiveInteger(input.analyticsSchemaVersion, 'analytics schema version');
  text(input.hypothesis, 'hypothesis');
  text(input.expectedOutcome, 'expected outcome');
  epoch(input.now, 'created at');
  const baselineWindow = window(input.baselineWindow, 'baseline window');
  const targetWindow = window(input.targetWindow, 'target window');
  if (targetWindow.start <= baselineWindow.start) {
    throw new RangeError('target window must follow the baseline start');
  }
  const aggregateMeasures = measures(input.aggregateMeasures, input.analyticsSchemaVersion);
  const why = reason(input.reason);
  const base: Omit<ImprovementHypothesis, 'history'> = {
    id: input.id,
    tenantId: input.tenantId,
    productScope: input.productScope.trim(),
    analyticsSchemaVersion: input.analyticsSchemaVersion,
    aggregateMeasureRefs: Object.freeze(aggregateMeasures.map((measure) => measure.ref)),
    aggregateMeasures,
    hypothesis: input.hypothesis.trim(),
    ownerPrincipalId: input.ownerPrincipalId,
    createdByPrincipalId: input.createdByPrincipalId,
    expectedOutcome: input.expectedOutcome.trim(),
    baselineWindow,
    targetWindow,
    status: 'proposed',
    decisionRefs: Object.freeze([]),
    deliveryStatus: 'not_started',
    outcomeMeasures: Object.freeze([]),
    resourceVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return freezeItem(base, [
    historyEntry(base, 'proposed', input.createdByPrincipalId, undefined, why, input.now),
  ]);
}

export function decideImprovementHypothesis(
  input: DecideImprovementHypothesisInput,
): ImprovementHypothesis {
  guardCurrent(input.hypothesis, input.tenantId, input.expectedVersion);
  if (input.hypothesis.status !== 'proposed') {
    throw new RangeError('only a proposed improvement hypothesis can be decided');
  }
  uuid(input.actorPrincipalId, 'decision actor principal id');
  text(input.authorityDecisionId, 'authority decision id', 256);
  epoch(input.now, 'decision time');
  if (
    input.actorPrincipalId === input.hypothesis.ownerPrincipalId ||
    input.actorPrincipalId === input.hypothesis.createdByPrincipalId
  ) {
    throw new RangeError('independent review is required; self-approval is denied');
  }
  const why = reason(input.reason);
  const next: Omit<ImprovementHypothesis, 'history'> = {
    ...input.hypothesis,
    status: input.decision === 'approve' ? 'approved' : 'rejected',
    decisionRefs: Object.freeze([...input.hypothesis.decisionRefs, input.authorityDecisionId]),
    resourceVersion: input.hypothesis.resourceVersion + 1,
    updatedAt: input.now,
  };
  return freezeItem(next, [
    ...input.hypothesis.history,
    historyEntry(
      next,
      input.decision,
      input.actorPrincipalId,
      input.authorityDecisionId,
      why,
      input.now,
    ),
  ]);
}

export function updateImprovementDelivery(
  input: UpdateImprovementDeliveryInput,
): ImprovementHypothesis {
  guardCurrent(input.hypothesis, input.tenantId, input.expectedVersion);
  if (input.hypothesis.status !== 'approved') {
    throw new RangeError('delivery can advance only for an approved improvement hypothesis');
  }
  if (
    input.hypothesis.deliveryStatus === 'delivered' ||
    (input.hypothesis.deliveryStatus === 'in_progress' && input.deliveryStatus !== 'delivered')
  ) {
    throw new RangeError('improvement delivery status cannot move backward or repeat');
  }
  uuid(input.actorPrincipalId, 'delivery actor principal id');
  epoch(input.now, 'delivery update time');
  const why = reason(input.reason);
  const next: Omit<ImprovementHypothesis, 'history'> = {
    ...input.hypothesis,
    deliveryStatus: input.deliveryStatus,
    resourceVersion: input.hypothesis.resourceVersion + 1,
    updatedAt: input.now,
  };
  return freezeItem(next, [
    ...input.hypothesis.history,
    historyEntry(next, input.deliveryStatus, input.actorPrincipalId, undefined, why, input.now),
  ]);
}

export function concludeImprovementHypothesis(
  input: ConcludeImprovementHypothesisInput,
): ImprovementHypothesis {
  guardCurrent(input.hypothesis, input.tenantId, input.expectedVersion);
  if (input.hypothesis.status !== 'approved' || input.hypothesis.deliveryStatus !== 'delivered') {
    throw new RangeError('only a delivered, approved improvement hypothesis can be concluded');
  }
  uuid(input.actorPrincipalId, 'outcome reviewer principal id');
  text(input.authorityDecisionId, 'outcome authority decision id', 256);
  text(input.conclusion, 'improvement conclusion');
  epoch(input.now, 'conclusion time');
  if (input.actorPrincipalId === input.hypothesis.ownerPrincipalId) {
    throw new RangeError('outcome review must be distinct from the improvement owner');
  }
  const outcomeMeasures = measures(input.outcomeMeasures, input.hypothesis.analyticsSchemaVersion);
  const why = reason(input.reason);
  const next: Omit<ImprovementHypothesis, 'history'> = {
    ...input.hypothesis,
    status: 'concluded',
    decisionRefs: Object.freeze([...input.hypothesis.decisionRefs, input.authorityDecisionId]),
    outcomeMeasures,
    conclusion: input.conclusion.trim(),
    resourceVersion: input.hypothesis.resourceVersion + 1,
    updatedAt: input.now,
  };
  return freezeItem(next, [
    ...input.hypothesis.history,
    historyEntry(
      next,
      'conclude',
      input.actorPrincipalId,
      input.authorityDecisionId,
      why,
      input.now,
    ),
  ]);
}
