// @trustcircle/projector package boundary entry point.
//
// The projector hosts the consumer side of the durable-delivery pipeline: it consumes governance
// events off the bus through a durable INBOX that recognises duplicates, applies events to the
// read model IN AGGREGATE ORDER, quarantines unsafe/ambiguous events from execution while keeping
// them visible, and records the consume acknowledgement with bounded retries and dead-lettering
// (Phase 28 / T028 / GAR-008). This is the supported consumer surface.
export * from './inbox-consumer.ts';
