export interface GovernedReviewComparisonView {
  readonly id: string;
  readonly compatibility: 'compatible' | 'incompatible';
  readonly incompatibilityReasons: readonly string[];
  readonly addedRefs: readonly string[];
  readonly removedRefs: readonly string[];
  readonly improvedRefs: readonly string[];
  readonly regressedRefs: readonly string[];
  readonly unchangedRefs: readonly string[];
  readonly unknownRefs: readonly string[];
  readonly sourceDigest: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function parseGovernedReviewComparison(
  value: unknown,
): GovernedReviewComparisonView | undefined {
  const candidate = object(value);
  const compatibility = candidate?.['compatibility'];
  const id = text(candidate?.['id']);
  const sourceDigest = text(candidate?.['source_digest']);
  if (
    !candidate ||
    !id ||
    (compatibility !== 'compatible' && compatibility !== 'incompatible') ||
    !sourceDigest ||
    !/^[a-f0-9]{64}$/.test(sourceDigest)
  ) {
    return undefined;
  }
  return {
    id,
    compatibility,
    incompatibilityReasons: strings(candidate['incompatibility_reasons']),
    addedRefs: strings(candidate['added_refs']),
    removedRefs: strings(candidate['removed_refs']),
    improvedRefs: strings(candidate['improved_refs']),
    regressedRefs: strings(candidate['regressed_refs']),
    unchangedRefs: strings(candidate['unchanged_refs']),
    unknownRefs: strings(candidate['unknown_refs']),
    sourceDigest,
  };
}
