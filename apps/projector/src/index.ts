// @trustcircle/projector package boundary entry point.
//
// The projector hosts the consumer side of the durable-delivery pipeline: it consumes governance
// events off the bus through a durable INBOX that recognises duplicates, applies events to the
// read model IN AGGREGATE ORDER, quarantines unsafe/ambiguous events from execution while keeping
// them visible, and records the consume acknowledgement with bounded retries and dead-lettering
// (Phase 28 / T028 / GAR-008). This is the supported consumer surface.
export * from './inbox-consumer.ts';

// The governed PROJECTION-WORKER bootstrap, durable cursors, rebuild mode, and stale-state
// signaling (Phase 48 / T2KV3HBNG3BGWSEXZ58RXEHQ3T / VO-6acaf6470d0810df4c93,
// VO-53a014009bdfebd7af13). Turns the durable inbox consumer above into a governed long-running
// projection worker whose ownership, health, failures, retries, continuity + lease, buffered
// evidence, rebuild state, per-stream freshness, and safe next action are all current and
// fail-visible through a single ProjectorStatus. Additive, backward-compatible export surface.
export * from './main.ts';
