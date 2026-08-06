import type { OperatorSessionContext } from './session-context.ts';
import { classifyFailure, safeNextAction, type SafeFailure } from './safe-error.ts';
import { safeDiagnostic } from './read-model.ts';

if (typeof window !== 'undefined') throw new Error('API client is server-only');

export interface ApiReadResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body?: unknown;
  readonly failure?: SafeFailure;
  readonly diagnostic?: string;
  readonly safeNextAction?: string;
  readonly receivedAt: string;
}

function apiBaseUrl(): string {
  const configured = process.env['API_BASE_URL'] ?? 'http://api:3000';
  const parsed = new URL(configured);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported API protocol');
  return parsed.origin;
}

export async function apiRead(
  path: `/v1/${string}`,
  session: OperatorSessionContext,
  timeoutMs = Number(process.env['WEB_API_TIMEOUT_MS'] ?? 2500),
): Promise<ApiReadResult> {
  const receivedAt = new Date().toISOString();
  if (!session.authenticated || !session.tenantId) {
    return {
      ok: false,
      status: 401,
      failure: 'authentication_required',
      safeNextAction: safeNextAction('authentication_required'),
      receivedAt,
    };
  }
  const requestHeaders = new Headers({ accept: 'application/json' });
  if (session.authorization) requestHeaders.set('authorization', session.authorization);
  if (session.cookie) requestHeaders.set('cookie', session.cookie);
  if (session.correlationId) requestHeaders.set('x-correlation-id', session.correlationId);
  try {
    const response = await fetch(`${apiBaseUrl()}${path}`, {
      method: 'GET',
      headers: requestHeaders,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return {
        ok: false,
        status: response.status,
        failure: 'malformed_response',
        safeNextAction: safeNextAction('malformed_response'),
        receivedAt,
      };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      const failure = classifyFailure(error);
      return {
        ok: false,
        status: response.status,
        failure,
        safeNextAction: safeNextAction(failure),
        receivedAt,
      };
    }
    if (!response.ok) {
      const failure = classifyFailure(undefined, response.status);
      const diagnostic = safeDiagnostic(body);
      return {
        ok: false,
        status: response.status,
        failure,
        ...(diagnostic ? { diagnostic } : {}),
        safeNextAction: safeNextAction(failure),
        receivedAt,
      };
    }
    const diagnostic = safeDiagnostic(body);
    return {
      ok: true,
      status: response.status,
      body,
      ...(diagnostic ? { diagnostic } : {}),
      receivedAt,
    };
  } catch (error) {
    const failure = classifyFailure(error);
    return { ok: false, status: 503, failure, safeNextAction: safeNextAction(failure), receivedAt };
  }
}

export interface ApiCommandResult extends ApiReadResult {
  readonly etag?: string;
  readonly location?: string;
}

export interface ApiCommandOptions {
  readonly idempotencyKey: string;
  readonly ifMatch?: string;
}

export async function apiCommand(
  path: `/v1/${string}`,
  session: OperatorSessionContext,
  body: unknown,
  options: ApiCommandOptions,
  timeoutMs = Number(process.env['WEB_API_TIMEOUT_MS'] ?? 2500),
): Promise<ApiCommandResult> {
  const receivedAt = new Date().toISOString();
  if (!session.authenticated || !session.tenantId) {
    return {
      ok: false,
      status: 401,
      failure: 'authentication_required',
      safeNextAction: safeNextAction('authentication_required'),
      receivedAt,
    };
  }
  const requestHeaders = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'idempotency-key': options.idempotencyKey,
  });
  if (session.authorization) requestHeaders.set('authorization', session.authorization);
  if (session.cookie) requestHeaders.set('cookie', session.cookie);
  if (session.csrfToken) requestHeaders.set('x-csrf-token', session.csrfToken);
  if (session.correlationId) requestHeaders.set('x-correlation-id', session.correlationId);
  if (options.ifMatch) requestHeaders.set('if-match', options.ifMatch);
  try {
    const response = await fetch(`${apiBaseUrl()}${path}`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return {
        ok: false,
        status: response.status,
        failure: 'malformed_response',
        safeNextAction: safeNextAction('malformed_response'),
        receivedAt,
      };
    }
    const responseBody: unknown = await response.json();
    if (!response.ok) {
      const failure = classifyFailure(undefined, response.status);
      return {
        ok: false,
        status: response.status,
        body: responseBody,
        failure,
        ...(safeDiagnostic(responseBody)
          ? { diagnostic: safeDiagnostic(responseBody) as string }
          : {}),
        safeNextAction: safeNextAction(failure),
        receivedAt,
      };
    }
    return {
      ok: true,
      status: response.status,
      body: responseBody,
      receivedAt,
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag') as string } : {}),
      ...(response.headers.get('location')
        ? { location: response.headers.get('location') as string }
        : {}),
    };
  } catch (error) {
    const failure = classifyFailure(error);
    return { ok: false, status: 503, failure, safeNextAction: safeNextAction(failure), receivedAt };
  }
}
