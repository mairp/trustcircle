export function operationsStatusLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

export function operationsQualityMessage(quality: string): string {
  if (quality === 'current' || quality === 'verified_empty') return 'Coverage is current.';
  if (quality === 'stale') return 'Coverage is stale; ordering may not reflect recent changes.';
  if (quality === 'partial' || quality === 'degraded')
    return 'Coverage is incomplete; absence is not a healthy result.';
  if (quality === 'unavailable') return 'One or more authoritative sources are unavailable.';
  return 'Coverage could not be verified.';
}

export function operationsDeadlineLabel(iso: string | undefined, now = Date.now()): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return 'No verified target';
  const difference = Date.parse(iso) - now;
  const absoluteMinutes = Math.round(Math.abs(difference) / 60_000);
  if (difference < 0) return `Breached by ${absoluteMinutes} minutes`;
  return `Due in ${absoluteMinutes} minutes`;
}

export function operationPriorityClass(priority: string): string {
  return priority === 'critical' || priority === 'high'
    ? 'operations-pill operations-pill--urgent'
    : 'operations-pill';
}
