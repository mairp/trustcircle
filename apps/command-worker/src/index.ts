// @trustcircle/command-worker package boundary entry point.
//
// The command-worker hosts the asynchronous side of the transactional-outbox pattern: it claims
// `pending` outbox rows written atomically by the unit-of-work (@trustcircle/persistence), then
// publishes them to the message bus with bounded retries and durable publish acknowledgements
// (Phase 27 / T027). This is the supported consumer surface.
export * from './outbox-publisher.ts';
