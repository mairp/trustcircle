import { createHash } from 'node:crypto';

import { NatsConnection } from './nats-topology-bootstrap.mjs';

const STREAM = 'GOVERNANCE_EVENTS';
const CONSUMER = 'governance-evidence-projector';
const [mode, syntheticId, valueHash] = process.argv.slice(2);

if (!['create', 'read'].includes(mode)) throw new Error('mode must be create or read');
if (!/^[0-9a-f-]{36}$/.test(syntheticId ?? '')) throw new Error('invalid synthetic identifier');
if (!/^[0-9a-f]{64}$/.test(valueHash ?? '')) throw new Error('invalid witness value hash');

const subject = `governance.witness.evidence.${syntheticId}`;

function stableHash(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function pullWitness(connection) {
  const inbox = `_INBOX.witness.${syntheticId.replaceAll('-', '')}`;
  const sid = connection.subscribe(inbox);
  const messagePromise = connection.waitFor(sid, 10_000);
  await connection.flush();
  connection.publish(
    `$JS.API.CONSUMER.MSG.NEXT.${STREAM}.${CONSUMER}`,
    JSON.stringify({ batch: 1, expires: 7_000_000_000 }),
    inbox,
  );
  const message = await messagePromise;
  connection.unsubscribe(sid);
  if (/NATS\/1\.0\s+[45]\d\d/.test(message.headers)) {
    throw new Error(`JetStream pull failed: ${message.headers.split('\r\n')[0]}`);
  }
  if (message.subject !== subject || message.data !== valueHash || !message.reply) {
    throw new Error('durable-consumer witness subject, hash, or acknowledgement identity mismatch');
  }
  return message;
}

async function readStoredMessage(connection) {
  const response = await connection.request(
    `$JS.API.STREAM.MSG.GET.${STREAM}`,
    JSON.stringify({ last_by_subj: subject }),
  );
  const message = response.message;
  const data = Buffer.from(message.data, 'base64').toString('utf8');
  if (message.subject !== subject || data !== valueHash || !Number.isInteger(message.seq)) {
    throw new Error('stored JetStream witness subject, hash, or sequence mismatch');
  }
  return message;
}

const connection = await new NatsConnection(process.env.NATS_URL ?? 'nats://nats:4222').connect();
try {
  const account = await connection.request('$JS.API.INFO');
  const stream = await connection.request(`$JS.API.STREAM.INFO.${STREAM}`);
  const consumerBefore = await connection.request(`$JS.API.CONSUMER.INFO.${STREAM}.${CONSUMER}`);

  if (!stream.config?.subjects?.includes('governance.*.evidence.*')) {
    throw new Error('approved evidence subject is absent from the existing stream');
  }
  if (
    consumerBefore.config?.filter_subject !== 'governance.*.evidence.*' ||
    consumerBefore.config?.ack_policy !== 'explicit'
  ) {
    throw new Error('approved durable evidence consumer configuration drifted');
  }

  let publishSequence = null;
  if (mode === 'create') {
    const acknowledgement = await connection.request(subject, valueHash);
    if (acknowledgement.stream !== STREAM || !Number.isInteger(acknowledgement.seq)) {
      throw new Error('invalid JetStream publish acknowledgement');
    }
    publishSequence = acknowledgement.seq;
  }

  const stored = await readStoredMessage(connection);
  const delivered = await pullWitness(connection);
  const ackParts = delivered.reply.split('.');
  const deliveredStreamSequence = Number(ackParts[5]);
  if (deliveredStreamSequence !== stored.seq) {
    throw new Error('durable-consumer and stored-message sequence identities differ');
  }

  connection.publish(delivered.reply, mode === 'create' ? '-NAK' : '+ACK');
  await connection.flush();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const consumerAfter = await connection.request(`$JS.API.CONSUMER.INFO.${STREAM}.${CONSUMER}`);

  const output = {
    witness_type: 'nats-jetstream',
    mode,
    synthetic_id: syntheticId,
    value_hash: valueHash,
    server_id: connection.serverInfo?.server_id ?? null,
    server_version: connection.serverInfo?.version ?? null,
    account_scope_hash: stableHash({ domain: account.domain ?? null, limits: account.limits }),
    stream: STREAM,
    stream_config_hash: stableHash({
      name: stream.config.name,
      subjects: stream.config.subjects,
      storage: stream.config.storage,
      num_replicas: stream.config.num_replicas,
      deny_delete: stream.config.deny_delete,
      deny_purge: stream.config.deny_purge,
    }),
    subject,
    stream_sequence: stored.seq,
    publish_sequence: publishSequence,
    durable_consumer: CONSUMER,
    consumer_config_hash: stableHash({
      durable_name: consumerAfter.config.durable_name,
      filter_subject: consumerAfter.config.filter_subject,
      ack_policy: consumerAfter.config.ack_policy,
      deliver_policy: consumerAfter.config.deliver_policy,
    }),
    delivery_state: {
      delivered_consumer_sequence: consumerAfter.delivered?.consumer_seq ?? null,
      delivered_stream_sequence: consumerAfter.delivered?.stream_seq ?? null,
      ack_floor_consumer_sequence: consumerAfter.ack_floor?.consumer_seq ?? null,
      ack_floor_stream_sequence: consumerAfter.ack_floor?.stream_seq ?? null,
      num_ack_pending: consumerAfter.num_ack_pending,
      num_pending: consumerAfter.num_pending,
      num_redelivered: consumerAfter.num_redelivered,
      last_disposition:
        mode === 'create'
          ? 'negative-ack-for-restart-redelivery'
          : 'acknowledged-after-restart-proof',
    },
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
} finally {
  connection.close();
}
