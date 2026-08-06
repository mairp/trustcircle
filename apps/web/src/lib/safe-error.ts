export type SafeFailure =
  | 'authentication_required'
  | 'forbidden'
  | 'timeout'
  | 'malformed_response'
  | 'incompatible_version'
  | 'upstream_unavailable'
  | 'unknown';

export function classifyFailure(error: unknown, status?: number): SafeFailure {
  if (status === 401) return 'authentication_required';
  if (status === 403) return 'forbidden';
  if (status !== undefined && status >= 500) return 'upstream_unavailable';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof SyntaxError) return 'malformed_response';
  return 'unknown';
}

export function safeNextAction(failure: SafeFailure): string {
  switch (failure) {
    case 'authentication_required':
      return 'Sign in again through the approved identity provider.';
    case 'forbidden':
      return 'Ask the tenant owner to review your read permission.';
    case 'timeout':
    case 'upstream_unavailable':
      return 'Check readiness and escalate to the service owner if the condition persists.';
    case 'incompatible_version':
      return 'Use a console version compatible with API v1.';
    case 'malformed_response':
    case 'unknown':
      return 'Inspect the correlation-safe service diagnostics and escalate.';
  }
}
