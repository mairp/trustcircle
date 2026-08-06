// @trustcircle/adapter-kanban — read-only Kanban board/card client (T250 / US6 / FR-036..FR-042).
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE IS
// ───────────────────────────────────────────────────────────────────────────────────────────
// Reads Kanban boards, cards, archives, workflow links, and the change stream (SSE) THROUGH THE
// OWNING KANBAN API — never SQLite, never a direct DB. The API surface is supplied as an INJECTED
// `KanbanApiPort` so this module is a PURE function over already-collected raw responses: it does no
// wall-clock reads (callers pass `observedAt`), no `Math.random`, and no real network I/O. It is
// independently testable offline with an in-memory port, exactly like the wiggum snapshot pattern
// ("callers pass already-collected raw observations; this module normalizes and freezes them").
//
// LOAD-BEARING SAFETY INVARIANT (a fail-visible discipline, independently testable):
//   * A CONNECTOR IS NEVER GRANTED GOVERNANCE AUTHORITY. Every card observation preserves the RAW
//     column and RAW workflow status verbatim. `done` is NEVER approval/acceptance/closure — it is
//     reported as-is; the mapping to `source_reports_done` lives in reconciliation, never here, and
//     card movement can never approve, accept risk, release quarantine, or close verified work.
//   * ARCHIVE/DELETION IS A TOMBSTONE, never a governance closure — emitted with `tombstone: true`.
//
// Dependency-free (Node built-in `crypto` only): pure, no I/O, no wall clock. Runs under Node 22
// `--experimental-strip-types`.

import { createHash } from 'node:crypto';

import type { ObservationEnvelope, Semver } from '@trustcircle/adapter-sdk';

// ---------------------------------------------------------------------------
// Pinned adapter identity (stamped on every observation).
// ---------------------------------------------------------------------------

export const KANBAN_ADAPTER_ID = 'kanban';
export const KANBAN_SOURCE_CLASS = 'kanban';

/** The schema major this client emits observations under (matches the manifest contract range). */
export const KANBAN_SCHEMA_MAJOR = 1;

// ---------------------------------------------------------------------------
// Raw Kanban API shapes — exactly what the OWNING API returns. Read-only.
// ---------------------------------------------------------------------------

/** A raw board as returned by the owning Kanban API. Columns are the source's own vocabulary. */
export interface RawKanbanBoard {
  readonly boardId: string;
  readonly title: string;
  /** Ordered column identifiers as the source defines them (e.g. ['todo','doing','done']). */
  readonly columns: readonly string[];
  readonly revision: string;
  readonly aggregateSequence: number | null;
}

/** A raw card as returned by the owning Kanban API. `column` + `workflowStatus` are preserved verbatim. */
export interface RawKanbanCard {
  readonly cardId: string;
  readonly boardId: string;
  readonly title: string;
  /** The source's raw column identifier — NEVER interpreted as approval here. */
  readonly column: string;
  /** Ordering position within the column, as the source reports it. */
  readonly position: number;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  /** Optional link to a workflow run/item this card mirrors. */
  readonly workflowLink?: string;
  /** The raw workflow status the source stamped — preserved verbatim, never inferred. */
  readonly workflowStatus?: string;
  readonly revision: string;
  readonly aggregateSequence: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** True when the source reports this card archived/deleted — a tombstone, never a closure. */
  readonly archived: boolean;
}

/** A raw change-stream (SSE) datum from the owning API. Ordering is by aggregateSequence. */
export interface RawKanbanEvent {
  readonly eventId: string;
  readonly boardId: string;
  readonly cardId: string;
  readonly kind: 'card_created' | 'card_moved' | 'card_updated' | 'card_archived' | 'card_deleted' | 'card_restored';
  readonly aggregateSequence: number | null;
  readonly occurredAt: number;
  /** The raw card snapshot carried by the event, if the source includes one. */
  readonly card?: RawKanbanCard;
}

// ---------------------------------------------------------------------------
// The injected OWNING-API port (never SQLite / never a direct DB).
// ---------------------------------------------------------------------------

/**
 * The read-only seam onto the OWNING Kanban API. Injected so this module performs no real I/O and is
 * testable offline. Every method returns already-collected raw responses; correlation is pure and
 * happens above this port.
 */
export interface KanbanApiPort {
  readonly getBoard: (boardId: string) => Promise<RawKanbanBoard>;
  readonly listCards: (boardId: string) => Promise<readonly RawKanbanCard[]>;
  readonly listArchivedCards: (boardId: string) => Promise<readonly RawKanbanCard[]>;
  readonly getWorkflowLink: (cardId: string) => Promise<string | null>;
  /** Drain the change stream (SSE) as an already-collected ordered batch. */
  readonly readEvents: (boardId: string, sinceSequence: number | null) => Promise<readonly RawKanbanEvent[]>;
}

// ---------------------------------------------------------------------------
// Observation payloads — RAW data, never a governance conclusion.
// ---------------------------------------------------------------------------

/** The card payload carried in an observation: raw column + raw workflow status preserved verbatim. */
export interface KanbanCardObservationPayload {
  readonly cardId: string;
  readonly boardId: string;
  readonly title: string;
  readonly rawColumn: string;
  readonly position: number;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly workflowLink: string | null;
  readonly rawWorkflowStatus: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
}

export interface KanbanBoardObservationPayload {
  readonly boardId: string;
  readonly title: string;
  readonly columns: readonly string[];
}

export interface KanbanEventObservationPayload {
  readonly eventId: string;
  readonly boardId: string;
  readonly cardId: string;
  readonly kind: RawKanbanEvent['kind'];
  readonly occurredAt: number;
}

// ---------------------------------------------------------------------------
// Canonicalization + digest (stable content hash over the raw payload).
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** SHA-256 hex digest over the canonicalized value. */
export function payloadDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Envelope construction (deep-frozen, digest-witnessed, no inference).
// ---------------------------------------------------------------------------

function seal<T>(env: Omit<ObservationEnvelope<T>, 'payloadDigest'>): ObservationEnvelope<T> {
  return Object.freeze({ ...env, payloadDigest: payloadDigest(env.payload) }) as ObservationEnvelope<T>;
}

function cardPayload(card: RawKanbanCard, workflowLink: string | null): KanbanCardObservationPayload {
  return {
    cardId: card.cardId,
    boardId: card.boardId,
    title: card.title,
    rawColumn: card.column,
    position: card.position,
    labels: card.labels,
    assignees: card.assignees,
    workflowLink: card.workflowLink ?? workflowLink,
    rawWorkflowStatus: card.workflowStatus ?? null,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    archived: card.archived,
  };
}

function cardObservation(
  adapterVersion: Semver,
  card: RawKanbanCard,
  workflowLink: string | null,
  observedAt: number,
): ObservationEnvelope<KanbanCardObservationPayload> {
  // Archive/deletion is a TOMBSTONE — never a governance closure.
  const isTombstone = card.archived;
  return seal({
    adapterId: KANBAN_ADAPTER_ID,
    adapterVersion,
    sourceClass: KANBAN_SOURCE_CLASS,
    sourceRevision: card.revision,
    aggregateRef: `${card.boardId}/card/${card.cardId}`,
    sequence: card.aggregateSequence ?? 0,
    schemaMajor: KANBAN_SCHEMA_MAJOR,
    observedAt,
    dedupKey: `${card.boardId}:${card.cardId}:${card.revision}`,
    payload: cardPayload(card, workflowLink),
    // Conditional spread for exactOptionalPropertyTypes — omit `tombstone` unless true.
    ...(isTombstone ? { tombstone: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// The read-only client — PURE over the injected port.
// ---------------------------------------------------------------------------

export interface KanbanClientInput {
  readonly boardId: string;
  readonly adapterVersion: Semver;
  /** Injected — this module never reads the wall clock. */
  readonly observedAt: number;
  /** Optional cursor for the change stream drain. */
  readonly sinceSequence?: number | null;
}

/** The correlated, deep-frozen result of one read pass. Raw observations only — no conclusions. */
export interface KanbanReadResult {
  readonly board: ObservationEnvelope<KanbanBoardObservationPayload>;
  readonly cards: readonly ObservationEnvelope<KanbanCardObservationPayload>[];
  /** Archived/deleted cards, each carrying `tombstone: true`. */
  readonly tombstones: readonly ObservationEnvelope<KanbanCardObservationPayload>[];
  readonly events: readonly ObservationEnvelope<KanbanEventObservationPayload>[];
}

/**
 * Read a Kanban board + its cards + archives + workflow links + change stream through the OWNING API,
 * returning RAW observations. No approval is ever inferred: raw column and raw workflow status are
 * preserved verbatim on every card observation, and archives are emitted as tombstones.
 */
export async function readKanbanBoard(
  port: KanbanApiPort,
  input: KanbanClientInput,
): Promise<KanbanReadResult> {
  const { boardId, adapterVersion, observedAt } = input;
  const sinceSequence = input.sinceSequence ?? null;

  const rawBoard = await port.getBoard(boardId);
  const rawCards = await port.listCards(boardId);
  const rawArchived = await port.listArchivedCards(boardId);
  const rawEvents = await port.readEvents(boardId, sinceSequence);

  const board = seal({
    adapterId: KANBAN_ADAPTER_ID,
    adapterVersion,
    sourceClass: KANBAN_SOURCE_CLASS,
    sourceRevision: rawBoard.revision,
    aggregateRef: `${rawBoard.boardId}/board`,
    sequence: rawBoard.aggregateSequence ?? 0,
    schemaMajor: KANBAN_SCHEMA_MAJOR,
    observedAt,
    dedupKey: `${rawBoard.boardId}:board:${rawBoard.revision}`,
    payload: {
      boardId: rawBoard.boardId,
      title: rawBoard.title,
      columns: rawBoard.columns,
    } satisfies KanbanBoardObservationPayload,
  });

  const cards: ObservationEnvelope<KanbanCardObservationPayload>[] = [];
  for (const card of rawCards) {
    const link = card.workflowLink ?? (await port.getWorkflowLink(card.cardId));
    cards.push(cardObservation(adapterVersion, card, link, observedAt));
  }

  const tombstones: ObservationEnvelope<KanbanCardObservationPayload>[] = [];
  for (const card of rawArchived) {
    // Force the tombstone flag: an archived/deleted card is a tombstone regardless of the source flag.
    const link = card.workflowLink ?? (await port.getWorkflowLink(card.cardId));
    tombstones.push(cardObservation(adapterVersion, { ...card, archived: true }, link, observedAt));
  }

  const events = rawEvents.map((ev) =>
    seal({
      adapterId: KANBAN_ADAPTER_ID,
      adapterVersion,
      sourceClass: KANBAN_SOURCE_CLASS,
      sourceRevision: ev.eventId,
      aggregateRef: `${ev.boardId}/card/${ev.cardId}`,
      sequence: ev.aggregateSequence ?? 0,
      schemaMajor: KANBAN_SCHEMA_MAJOR,
      observedAt,
      dedupKey: `${ev.boardId}:event:${ev.eventId}`,
      payload: {
        eventId: ev.eventId,
        boardId: ev.boardId,
        cardId: ev.cardId,
        kind: ev.kind,
        occurredAt: ev.occurredAt,
      } satisfies KanbanEventObservationPayload,
      // Archive/deletion events are tombstones; restore/create/move/update are not.
      ...(ev.kind === 'card_archived' || ev.kind === 'card_deleted' ? { tombstone: true } : {}),
    }),
  );

  return Object.freeze({
    board,
    cards: Object.freeze(cards),
    tombstones: Object.freeze(tombstones),
    events: Object.freeze(events),
  });
}
