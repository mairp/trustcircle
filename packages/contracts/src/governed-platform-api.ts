export class GovernedPlatformContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GovernedPlatformContractError';
    this.code = code;
  }
}

export interface GovernedReason {
  readonly code: string;
  readonly text: string;
}

export interface GovernedCommand {
  readonly schema_version: number;
  readonly reason: GovernedReason;
  readonly authority_decision_id?: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface GovernedSignature {
  readonly algorithm: string;
  readonly key_id: string;
  readonly digest: string;
  readonly value: string;
}

export interface GovernedSignedCommand extends GovernedCommand {
  readonly signature: GovernedSignature;
}
export interface GovernedTransition {
  readonly transition: string;
  readonly reason: GovernedReason;
  readonly authority_decision_id: string;
  readonly input?: Readonly<Record<string, unknown>>;
}

export interface GovernedPageCursor {
  readonly source_cursor: string;
  readonly offset: number;
  readonly query_digest: string;
}

const REASON_CODE = /^[a-z][a-z0-9_.-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function fail(code: string, message: string): never {
  throw new GovernedPlatformContractError(code, message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_' + field, field + ' must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail('unknown_field', field + ' contains unknown field ' + key + '.');
  }
  for (const key of required) {
    if (!(key in value)) fail('missing_field', field + ' requires field ' + key + '.');
  }
}

function reason(value: unknown): GovernedReason {
  const candidate = object(value, 'reason');
  exactKeys(candidate, ['code', 'text'], ['code', 'text'], 'reason');
  if (typeof candidate['code'] !== 'string' || !REASON_CODE.test(candidate['code'])) {
    fail('invalid_reason_code', 'reason.code must use the governed reason vocabulary.');
  }
  if (
    typeof candidate['text'] !== 'string' ||
    candidate['text'].trim().length < 3 ||
    candidate['text'].length > 4000
  ) {
    fail('invalid_reason_text', 'reason.text must contain 3 to 4000 characters.');
  }
  return Object.freeze({ code: candidate['code'], text: candidate['text'].trim() });
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    fail('invalid_uuid', field + ' must be a UUID.');
  }
  return value;
}

function inputObject(value: unknown): Readonly<Record<string, unknown>> {
  return Object.freeze({ ...object(value, 'input') });
}

export function parseGovernedCommand(value: unknown): GovernedCommand {
  const candidate = object(value, 'command');
  exactKeys(
    candidate,
    ['schema_version', 'reason', 'authority_decision_id', 'input'],
    ['schema_version', 'reason', 'input'],
    'command',
  );
  if (
    typeof candidate['schema_version'] !== 'number' ||
    !Number.isSafeInteger(candidate['schema_version']) ||
    candidate['schema_version'] < 1
  ) {
    fail('invalid_schema_version', 'schema_version must be a positive integer.');
  }
  const authority =
    candidate['authority_decision_id'] === undefined
      ? undefined
      : uuid(candidate['authority_decision_id'], 'authority_decision_id');
  return Object.freeze({
    schema_version: candidate['schema_version'],
    reason: reason(candidate['reason']),
    ...(authority === undefined ? {} : { authority_decision_id: authority }),
    input: inputObject(candidate['input']),
  });
}

export function parseGovernedSignedCommand(value: unknown): GovernedSignedCommand {
  const candidate = object(value, 'signed_command');
  exactKeys(
    candidate,
    ['schema_version', 'reason', 'authority_decision_id', 'input', 'signature'],
    ['schema_version', 'reason', 'input', 'signature'],
    'signed_command',
  );
  const signatureCandidate = object(candidate['signature'], 'signature');
  exactKeys(
    signatureCandidate,
    ['algorithm', 'key_id', 'digest', 'value'],
    ['algorithm', 'key_id', 'digest', 'value'],
    'signature',
  );
  const bounded = (member: unknown, field: string): string => {
    if (typeof member !== 'string' || member.trim().length < 1 || member.length > 4096) {
      fail('invalid_signature', field + ' must be bounded text.');
    }
    return member.trim();
  };
  const digest = bounded(signatureCandidate['digest'], 'signature.digest');
  if (!DIGEST.test(digest)) fail('invalid_signature', 'signature.digest must be SHA-256.');
  const unsigned: Record<string, unknown> = {
    schema_version: candidate['schema_version'],
    reason: candidate['reason'],
    input: candidate['input'],
    ...(candidate['authority_decision_id'] === undefined
      ? {}
      : { authority_decision_id: candidate['authority_decision_id'] }),
  };
  const command = parseGovernedCommand(unsigned);
  return Object.freeze({
    ...command,
    signature: Object.freeze({
      algorithm: bounded(signatureCandidate['algorithm'], 'signature.algorithm'),
      key_id: bounded(signatureCandidate['key_id'], 'signature.key_id'),
      digest,
      value: bounded(signatureCandidate['value'], 'signature.value'),
    }),
  });
}
export function parseGovernedTransition(value: unknown): GovernedTransition {
  const candidate = object(value, 'transition');
  exactKeys(
    candidate,
    ['transition', 'reason', 'authority_decision_id', 'input'],
    ['transition', 'reason', 'authority_decision_id'],
    'transition',
  );
  if (
    typeof candidate['transition'] !== 'string' ||
    !/^[a-z][a-z0-9_-]{1,63}$/.test(candidate['transition'])
  ) {
    fail('invalid_transition', 'transition must use the governed transition vocabulary.');
  }
  return Object.freeze({
    transition: candidate['transition'],
    reason: reason(candidate['reason']),
    authority_decision_id: uuid(candidate['authority_decision_id'], 'authority_decision_id'),
    ...(candidate['input'] === undefined ? {} : { input: inputObject(candidate['input']) }),
  });
}

function requiredHeader(value: string | null | undefined, name: string): string {
  if (typeof value !== 'string' || !HEADER.test(value)) {
    fail('invalid_header', name + ' must contain 8 to 128 safe characters.');
  }
  return value;
}

export function requireGovernedCorrelationId(value: string | null | undefined): string {
  return requiredHeader(value, 'X-Correlation-Id');
}

export function requireGovernedIdempotencyKey(value: string | null | undefined): string {
  return requiredHeader(value, 'Idempotency-Key');
}

export function requireGovernedIfMatch(value: string | null | undefined): number {
  if (typeof value !== 'string') fail('missing_if_match', 'If-Match is required.');
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  if (!match) fail('invalid_if_match', 'If-Match must contain the quoted resource version.');
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) fail('invalid_if_match', 'If-Match version is out of range.');
  return version;
}

export function encodeGovernedPageCursor(cursor: GovernedPageCursor): string {
  validateCursor(cursor);
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeGovernedPageCursor(value: string): GovernedPageCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    fail('invalid_cursor', 'cursor must be a bounded opaque value.');
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const candidate = object(decoded, 'cursor');
    exactKeys(
      candidate,
      ['source_cursor', 'offset', 'query_digest'],
      ['source_cursor', 'offset', 'query_digest'],
      'cursor',
    );
    const cursor: GovernedPageCursor = {
      source_cursor:
        typeof candidate['source_cursor'] === 'string' ? candidate['source_cursor'] : '',
      offset: typeof candidate['offset'] === 'number' ? candidate['offset'] : -1,
      query_digest: typeof candidate['query_digest'] === 'string' ? candidate['query_digest'] : '',
    };
    validateCursor(cursor);
    return Object.freeze(cursor);
  } catch (error) {
    if (error instanceof GovernedPlatformContractError) throw error;
    fail('invalid_cursor', 'cursor is malformed.');
  }
}

function validateCursor(cursor: GovernedPageCursor): void {
  if (
    cursor.source_cursor.length < 1 ||
    cursor.source_cursor.length > 512 ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    !DIGEST.test(cursor.query_digest)
  ) {
    fail('invalid_cursor', 'cursor state is outside the governed page boundary.');
  }
}
