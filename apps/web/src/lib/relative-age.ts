/** Human-readable age of an ISO timestamp ("3 min ago"), or undefined when it cannot be parsed. */
export function relativeAge(iso: string | undefined, now: number = Date.now()): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 0) return 'in the future';
  if (seconds < 60) return 'just now';
  const units: [number, string][] = [
    [60 * 60 * 24, 'd'],
    [60 * 60, 'h'],
    [60, 'min'],
  ];
  for (const [size, label] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)} ${label} ago`;
  }
  return 'just now';
}
