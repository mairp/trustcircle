// @trustcircle/command-worker package boundary entry point.
//
// The command-worker hosts the asynchronous side of the transactional-outbox pattern: it claims
// `pending` outbox rows written atomically by the unit-of-work (@trustcircle/persistence), then
// publishes them to the message bus with bounded retries and durable publish acknowledgements
// (Phase 27 / T027). This is the supported consumer surface.
export * from './outbox-publisher.ts';

// The governed worker bootstrap, lease ownership, checkpointing, and safe shutdown (Phase 47 /
// VO-6acaf6470d0810df4c93). `bootstrapWorker` wires the outbox publisher into a long-running,
// singleton-leased, checkpointing worker whose full state — ownership, health, failures,
// retries, continuity mode + lease, buffered evidence, and safe next action — is fail-visible
// through a single `WorkerStatus` snapshot.
export * from './main.ts';
