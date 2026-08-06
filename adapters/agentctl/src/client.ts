// @trustcircle/adapter-agentctl — governed compatibility-facade client (T256 / US6 / FR-036..FR-042).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// agentctl is a GOVERNED COMPATIBILITY FACADE. This client PREFERS the workflow API (the authoritative
// dispatch surface) and, only when the API is unavailable, falls back to a VERSION-PINNED JSON CLI. The
// CLI fallback NEVER parses prose: it demands structured `--json` output and refuses/parse-errors on any
// non-JSON. Both surfaces are INJECTED ports (`AgentctlApiPort`, `AgentctlCliPort`) so this module does
// no real I/O, no wall-clock reads (callers pass `observedAt`), and no `Math.random`; it is testable
// offline.
//
// LOAD-BEARING SAFETY INVARIANTS:
//   * PREFER THE API. The CLI is a fallback, never the first choice.
//   * NEVER PARSE PROSE. Only version-pinned `--json` structured output is authoritative; non-JSON is a
//     parse error, never a best-effort interpretation.
//   * A CONNECTOR IS NEVER GRANTED GOVERNANCE AUTHORITY. Dispatch results are raw observations; a CLI
//     exit code is never an approval or closure.
//
// Dependency-free (Node built-in `crypto` only): pure, no I/O, no wall clock. Runs under Node 22
// `--experimental-strip-types`.

import { createHash } from 'node:crypto';

import type { Semver } from '@trustcircle/adapter-sdk';

// ---------------------------------------------------------------------------
// Pinned adapter identity + CLI version pin.
// ---------------------------------------------------------------------------

export const AGENTCTL_ADAPTER_ID = 'agentctl';
export const AGENTCTL_SOURCE_CLASS = 'agentctl';
export const AGENTCTL_SCHEMA_MAJOR = 1;

// ---------------------------------------------------------------------------
// Dispatch request + injected ports.
// ---------------------------------------------------------------------------

/** A dispatch the platform asks agentctl to perform. Carries the idempotency/operation id. */
export interface AgentctlDispatchRequest {
  readonly operationId: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Idempotency key (source_operation_id mode) so a retry yields exactly one effect. */
  readonly idempotencyKey: string;
}

/** The raw structured result the OWNING workflow API returns for a dispatch. */
export interface RawApiDispatchResult {
  readonly operationId: string;
  readonly accepted: boolean;
  readonly runId?: string;
  readonly status: string;
  readonly revision: string;
}

/** The raw structured result of a CLI invocation. `stdout`/`stderr` are captured for digesting. */
export interface RawCliInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The pinned CLI version the invocation reported (`--version`). */
  readonly reportedVersion: string;
  /** True when the invocation exceeded its timeout — UNCERTAIN, not a failure. */
  readonly timedOut: boolean;
}

/** The read-only, OWNING workflow API dispatch seam (preferred). Injected. */
export interface AgentctlApiPort {
  readonly available: () => Promise<boolean>;
  readonly dispatch: (request: AgentctlDispatchRequest) => Promise<RawApiDispatchResult>;
}

/** The version-pinned CLI seam (fallback only). Injected. Emits structured `--json` output. */
export interface AgentctlCliPort {
  /** The version this CLI port is pinned to; mismatch is refused before any invocation. */
  readonly pinnedVersion: Semver;
  readonly invoke: (request: AgentctlDispatchRequest) => Promise<RawCliInvocation>;
}

// ---------------------------------------------------------------------------
// Errors — fail-visible refusals.
// ---------------------------------------------------------------------------

export class AgentctlProseRefusedError extends Error {
  constructor(readonly stdoutDigest: string) {
    super(
      'agentctl CLI fallback refused: output was not structured JSON. The facade never parses prose; ' +
        'only version-pinned --json output is authoritative.',
    );
    this.name = 'AgentctlProseRefusedError';
  }
}

export class AgentctlVersionPinError extends Error {
  constructor(
    readonly expected: Semver,
    readonly actual: string,
  ) {
    super(`agentctl CLI version pin mismatch: expected ${expected}, got ${actual}. Refusing to invoke.`);
    this.name = 'AgentctlVersionPinError';
  }
}

// ---------------------------------------------------------------------------
// Digest.
// ---------------------------------------------------------------------------

/** SHA-256 hex digest over a UTF-8 string (command/stdout/stderr capture anchors). */
export function textDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Dispatch observation — raw data, never a conclusion.
// ---------------------------------------------------------------------------

export type DispatchSurface = 'workflow_api' | 'cli_fallback';

/** The outcome the adapter can assert about a dispatch. A timeout is UNCERTAIN, never a failure. */
export type DispatchOutcome = 'accepted' | 'rejected' | 'uncertain';

export interface AgentctlDispatchObservation {
  readonly adapterId: string;
  readonly adapterVersion: Semver;
  readonly sourceClass: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly surface: DispatchSurface;
  readonly outcome: DispatchOutcome;
  readonly observedAt: number;
  readonly commandDigest: string;
  /** Present only for the CLI surface. */
  readonly exitCode: number | null;
  readonly stdoutDigest: string | null;
  readonly stderrDigest: string | null;
  /** True when a CLI invocation timed out — actual state must be reconciled by operation id. */
  readonly timedOut: boolean;
  /** The raw structured JSON payload the surface returned, if any. */
  readonly jsonPayload: Readonly<Record<string, unknown>> | null;
  readonly payloadDigest: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function commandDigestOf(request: AgentctlDispatchRequest): string {
  return textDigest([request.command, ...request.args].join(' '));
}

// ---------------------------------------------------------------------------
// The client — PREFER the API; version-pinned JSON CLI fallback.
// ---------------------------------------------------------------------------

export interface AgentctlDispatchInput {
  readonly request: AgentctlDispatchRequest;
  readonly adapterVersion: Semver;
  /** Injected — this module never reads the wall clock. */
  readonly observedAt: number;
}

/**
 * Parse the CLI's `--json` stdout, REFUSING any non-JSON (never parses prose). Returns the parsed
 * object or throws `AgentctlProseRefusedError`.
 */
function parseJsonStrict(stdout: string): Readonly<Record<string, unknown>> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) throw new AgentctlProseRefusedError(textDigest(stdout));
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new AgentctlProseRefusedError(textDigest(stdout));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentctlProseRefusedError(textDigest(stdout));
  }
  return Object.freeze({ ...(parsed as Record<string, unknown>) });
}

/**
 * Dispatch through agentctl. PREFERS the workflow API; falls back to the version-pinned JSON CLI only
 * when the API is unavailable. Returns a deep-frozen raw observation. A CLI timeout yields an
 * `uncertain` outcome (never a failure) so the caller reconciles actual state by operation id.
 */
export async function dispatchAgentctl(
  apiPort: AgentctlApiPort,
  cliPort: AgentctlCliPort,
  input: AgentctlDispatchInput,
): Promise<AgentctlDispatchObservation> {
  const { request, adapterVersion, observedAt } = input;
  const commandDigest = commandDigestOf(request);

  if (await apiPort.available()) {
    const result = await apiPort.dispatch(request);
    const payload = {
      operationId: result.operationId,
      accepted: result.accepted,
      status: result.status,
      revision: result.revision,
      ...(result.runId !== undefined ? { runId: result.runId } : {}),
    } satisfies Record<string, unknown>;
    return Object.freeze({
      adapterId: AGENTCTL_ADAPTER_ID,
      adapterVersion,
      sourceClass: AGENTCTL_SOURCE_CLASS,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      surface: 'workflow_api',
      outcome: result.accepted ? 'accepted' : 'rejected',
      observedAt,
      commandDigest,
      exitCode: null,
      stdoutDigest: null,
      stderrDigest: null,
      timedOut: false,
      jsonPayload: Object.freeze(payload),
      payloadDigest: textDigest(canonicalJson(payload)),
    });
  }

  // Fallback: version-pinned JSON CLI. Refuse a version mismatch BEFORE trusting output.
  const invocation = await cliPort.invoke(request);
  if (invocation.reportedVersion !== cliPort.pinnedVersion) {
    throw new AgentctlVersionPinError(cliPort.pinnedVersion, invocation.reportedVersion);
  }

  const stdoutDigest = textDigest(invocation.stdout);
  const stderrDigest = textDigest(invocation.stderr);

  // A timeout is UNCERTAIN, not a failure — do not parse output; caller reconciles by operation id.
  if (invocation.timedOut) {
    return Object.freeze({
      adapterId: AGENTCTL_ADAPTER_ID,
      adapterVersion,
      sourceClass: AGENTCTL_SOURCE_CLASS,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      surface: 'cli_fallback',
      outcome: 'uncertain',
      observedAt,
      commandDigest,
      exitCode: invocation.exitCode,
      stdoutDigest,
      stderrDigest,
      timedOut: true,
      jsonPayload: null,
      payloadDigest: textDigest(canonicalJson({ timedOut: true, operationId: request.operationId })),
    });
  }

  // Never parse prose — demand structured JSON (throws AgentctlProseRefusedError otherwise).
  const jsonPayload = parseJsonStrict(invocation.stdout);
  const accepted = jsonPayload['accepted'] === true || invocation.exitCode === 0;

  return Object.freeze({
    adapterId: AGENTCTL_ADAPTER_ID,
    adapterVersion,
    sourceClass: AGENTCTL_SOURCE_CLASS,
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    surface: 'cli_fallback',
    outcome: accepted ? 'accepted' : 'rejected',
    observedAt,
    commandDigest,
    exitCode: invocation.exitCode,
    stdoutDigest,
    stderrDigest,
    timedOut: false,
    jsonPayload,
    payloadDigest: textDigest(canonicalJson(jsonPayload)),
  });
}
