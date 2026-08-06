import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';

const DEFAULT_TOPOLOGY_URL = new URL('../nats/topology.json', import.meta.url);
const DEFAULT_SCHEMA_URL = new URL('../nats/topology.schema.json', import.meta.url);

export function durationToNanoseconds(value) {
  if (value === null || value === undefined) return 0;
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`unsupported NATS duration ${JSON.stringify(value)}`);
  const multiplier = { ms: 1_000_000, s: 1_000_000_000, m: 60_000_000_000, h: 3_600_000_000_000 }[
    match[2]
  ];
  return Number(match[1]) * multiplier;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function stableHash(value) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function streamConfigFor(definition, replicas = 1) {
  const retention = definition.retention;
  return {
    name: definition.name,
    description: definition.description,
    subjects: definition.subjects,
    retention: retention.policy,
    max_consumers: -1,
    max_msgs: retention.maxMsgs,
    max_bytes: retention.maxBytes,
    max_age: durationToNanoseconds(retention.maxAge),
    max_msgs_per_subject: retention.maxMsgsPerSubject,
    max_msg_size: retention.maxMsgSize,
    storage: definition.storage,
    num_replicas: replicas,
    discard: retention.discard,
    duplicate_window: durationToNanoseconds(definition.duplicateWindow),
    allow_rollup_hdrs: definition.allowRollup,
    deny_delete: definition.denyDelete,
    deny_purge: definition.denyPurge,
  };
}

export function consumerConfigFor(definition) {
  const config = {
    durable_name: definition.durable,
    description: definition.name,
    deliver_policy: definition.deliverPolicy,
    ack_policy: definition.ackPolicy,
    ack_wait: durationToNanoseconds(definition.ackWait),
    max_deliver: definition.maxDeliver,
    filter_subject: definition.filterSubject,
    replay_policy: 'instant',
    max_ack_pending: definition.maxAckPending,
  };
  if (definition.backoff) config.backoff = definition.backoff.map(durationToNanoseconds);
  return config;
}

function streamIdentity(config) {
  return {
    name: config?.name,
    subjects: [...(config?.subjects ?? [])].sort(),
    retention: config?.retention,
    max_consumers: config?.max_consumers,
    max_msgs: config?.max_msgs,
    max_bytes: config?.max_bytes,
    max_age: config?.max_age,
    max_msgs_per_subject: config?.max_msgs_per_subject,
    max_msg_size: config?.max_msg_size,
    storage: config?.storage,
    num_replicas: config?.num_replicas,
    discard: config?.discard,
    duplicate_window: config?.duplicate_window,
    allow_rollup_hdrs: config?.allow_rollup_hdrs,
    deny_delete: config?.deny_delete,
    deny_purge: config?.deny_purge,
  };
}

function consumerIdentity(config) {
  return {
    durable_name: config?.durable_name,
    deliver_policy: config?.deliver_policy,
    ack_policy: config?.ack_policy,
    ack_wait: config?.ack_wait,
    max_deliver: config?.max_deliver,
    filter_subject: config?.filter_subject,
    replay_policy: config?.replay_policy,
    max_ack_pending: config?.max_ack_pending,
    backoff: [...(config?.backoff ?? [])],
  };
}

function declaredConsumerIdentity(definition) {
  const config = consumerConfigFor(definition);
  return consumerIdentity({
    ...config,
    // JetStream defines the first backoff interval as the effective AckWait.
    // The server therefore reports backoff[0], not the separately supplied ack_wait.
    ack_wait: config.backoff?.[0] ?? config.ack_wait,
  });
}

function assertEqual(actual, expected, label) {
  if (JSON.stringify(canonicalize(actual)) !== JSON.stringify(canonicalize(expected))) {
    throw new Error(`${label} does not match declared topology`);
  }
}

export function validateTopology(topology, schema) {
  if (
    schema?.$id !== 'https://trustcircle.governance/deploy/nats/topology.schema.json' ||
    schema?.properties?.kind?.const !== 'NatsJetStreamTopology'
  ) {
    throw new Error('unrecognized NATS topology schema');
  }
  if (
    topology?.$schema !== './topology.schema.json' ||
    topology?.kind !== 'NatsJetStreamTopology' ||
    !/^\d+\.\d+\.\d+$/.test(topology.topologyVersion ?? '') ||
    !Array.isArray(topology.streams) ||
    topology.streams.length < 2 ||
    !Array.isArray(topology.consumers) ||
    topology.consumers.length < 1
  ) {
    throw new Error('invalid NATS topology declaration');
  }

  const streamNames = new Set();
  for (const stream of topology.streams) {
    if (
      !/^[A-Z0-9_]+$/.test(stream.name ?? '') ||
      streamNames.has(stream.name) ||
      stream.storage !== 'file' ||
      stream.denyDelete !== true ||
      stream.denyPurge !== true ||
      !Array.isArray(stream.subjects) ||
      stream.subjects.length === 0 ||
      stream.subjects.some((subject) => !subject.startsWith('governance.'))
    ) {
      throw new Error(`invalid stream declaration ${JSON.stringify(stream?.name)}`);
    }
    streamNames.add(stream.name);
    streamConfigFor(stream, 1);
  }

  const consumerNames = new Set();
  for (const consumer of topology.consumers) {
    const identity = `${consumer.stream}/${consumer.durable}`;
    if (
      consumerNames.has(identity) ||
      !streamNames.has(consumer.stream) ||
      consumer.type !== 'pull' ||
      consumer.ackPolicy !== 'explicit' ||
      !consumer.filterSubject?.startsWith('governance.')
    ) {
      throw new Error(`invalid consumer declaration ${JSON.stringify(identity)}`);
    }
    consumerNames.add(identity);
    consumerConfigFor(consumer);
  }
}

export class NatsConnection {
  #socket;
  #buffer = Buffer.alloc(0);
  #subscriptions = new Map();
  #nextSid = 1;
  #pongWaiters = [];
  #infoPromise;
  #infoResolve;
  #infoReject;

  constructor(url = 'nats://nats:4222') {
    this.url = new URL(url);
    this.serverInfo = null;
    this.#infoPromise = new Promise((resolve, reject) => {
      this.#infoResolve = resolve;
      this.#infoReject = reject;
    });
  }

  async connect() {
    this.#socket = net.createConnection({
      host: this.url.hostname,
      port: Number(this.url.port || 4222),
    });
    this.#socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#parse();
    });
    this.#socket.on('error', (error) => {
      this.#infoReject?.(error);
      for (const subscription of this.#subscriptions.values()) subscription.reject?.(error);
    });
    this.serverInfo = await Promise.race([
      this.#infoPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('NATS INFO timeout')), 5000)),
    ]);
    this.#write(
      'CONNECT {"verbose":false,"pedantic":true,"lang":"node","version":"trustcircle-runtime-1"}\r\n',
    );
    await this.flush();
    return this;
  }

  close() {
    this.#socket?.end();
  }

  #write(value) {
    this.#socket.write(value);
  }

  #parse() {
    while (this.#buffer.length > 0) {
      const lineEnd = this.#buffer.indexOf('\r\n');
      if (lineEnd < 0) return;
      const line = this.#buffer.subarray(0, lineEnd).toString('utf8');
      if (line.startsWith('MSG ') || line.startsWith('HMSG ')) {
        const parts = line.split(' ');
        const withHeaders = parts[0] === 'HMSG';
        const sid = Number(parts[2]);
        const headerBytes = withHeaders ? Number(parts.at(-2)) : 0;
        const totalBytes = Number(parts.at(-1));
        const reply = parts.length === (withHeaders ? 6 : 5) ? parts[3] : null;
        const frameBytes = lineEnd + 2 + totalBytes + 2;
        if (this.#buffer.length < frameBytes) return;
        const frame = this.#buffer.subarray(lineEnd + 2, lineEnd + 2 + totalBytes);
        this.#buffer = this.#buffer.subarray(frameBytes);
        const headers = headerBytes ? frame.subarray(0, headerBytes).toString('utf8') : '';
        const data = frame.subarray(headerBytes).toString('utf8');
        this.#subscriptions.get(sid)?.resolve?.({ subject: parts[1], reply, headers, data });
        continue;
      }
      this.#buffer = this.#buffer.subarray(lineEnd + 2);
      if (line.startsWith('INFO ')) this.#infoResolve?.(JSON.parse(line.slice(5)));
      else if (line === 'PONG') this.#pongWaiters.shift()?.();
      else if (line.startsWith('-ERR')) {
        const error = new Error(`NATS protocol error: ${line}`);
        for (const subscription of this.#subscriptions.values()) subscription.reject?.(error);
      }
    }
  }

  subscribe(subject) {
    const sid = this.#nextSid++;
    this.#write(`SUB ${subject} ${sid}\r\n`);
    return sid;
  }

  unsubscribe(sid) {
    this.#subscriptions.delete(sid);
    this.#write(`UNSUB ${sid}\r\n`);
  }

  waitFor(sid, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#subscriptions.delete(sid);
        reject(new Error('NATS message timeout'));
      }, timeoutMs);
      this.#subscriptions.set(sid, {
        resolve: (message) => {
          clearTimeout(timeout);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  publish(subject, data, reply = null) {
    const body = Buffer.from(data, 'utf8');
    const prefix = reply
      ? `PUB ${subject} ${reply} ${body.length}\r\n`
      : `PUB ${subject} ${body.length}\r\n`;
    this.#socket.write(Buffer.concat([Buffer.from(prefix), body, Buffer.from('\r\n')]));
  }

  async flush() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('NATS PONG timeout')), 5000);
      this.#pongWaiters.push(() => {
        clearTimeout(timeout);
        resolve();
      });
      this.#write('PING\r\n');
    });
  }

  async request(subject, body = '') {
    const inbox = `_INBOX.${randomBytes(16).toString('hex')}`;
    const sid = this.subscribe(inbox);
    const responsePromise = this.waitFor(sid);
    await this.flush();
    this.publish(subject, body, inbox);
    const response = await responsePromise;
    this.unsubscribe(sid);
    const parsed = JSON.parse(response.data);
    if (parsed.error) {
      const error = new Error(`JetStream API ${parsed.error.code}: ${parsed.error.description}`);
      error.apiCode = parsed.error.code;
      throw error;
    }
    return parsed;
  }
}

async function requestOrNull(connection, subject, body = '') {
  try {
    return await connection.request(subject, body);
  } catch (error) {
    if (error.apiCode === 404) return null;
    throw error;
  }
}

async function ensureStream(connection, definition, replicas) {
  let info = await requestOrNull(connection, `$JS.API.STREAM.INFO.${definition.name}`);
  let outcome = 'existing';
  if (!info) {
    info = await connection.request(
      `$JS.API.STREAM.CREATE.${definition.name}`,
      JSON.stringify(streamConfigFor(definition, replicas)),
    );
    outcome = 'created';
  }
  const expected = streamIdentity(streamConfigFor(definition, replicas));
  const observed = streamIdentity(info.config);
  assertEqual(observed, expected, `stream ${definition.name} configuration`);
  return { name: definition.name, outcome, configHash: stableHash(observed) };
}

async function ensureConsumer(connection, definition) {
  let info = await requestOrNull(
    connection,
    `$JS.API.CONSUMER.INFO.${definition.stream}.${definition.durable}`,
  );
  let outcome = 'existing';
  if (!info) {
    info = await connection.request(
      `$JS.API.CONSUMER.DURABLE.CREATE.${definition.stream}.${definition.durable}`,
      JSON.stringify({ stream_name: definition.stream, config: consumerConfigFor(definition) }),
    );
    outcome = 'created';
  }
  if (info.stream_name !== definition.stream || info.name !== definition.durable) {
    throw new Error(`consumer ${definition.durable} identity does not match declared topology`);
  }
  const expected = declaredConsumerIdentity(definition);
  const observed = consumerIdentity(info.config);
  assertEqual(observed, expected, `consumer ${definition.durable} configuration`);
  return {
    name: definition.durable,
    stream: definition.stream,
    outcome,
    configHash: stableHash(observed),
  };
}

export async function reconcileNatsTopology(
  connection,
  topology,
  schema,
  { replicas = 1, topologyDeclarationHash = null, topologySchemaHash = null } = {},
) {
  validateTopology(topology, schema);
  if (replicas !== 1) throw new Error('local control-plane topology must use one replica');

  const streamResults = [];
  const consumerResults = [];
  for (const stream of topology.streams) {
    streamResults.push(await ensureStream(connection, stream, replicas));
  }
  for (const consumer of topology.consumers) {
    consumerResults.push(await ensureConsumer(connection, consumer));
  }
  return {
    topologyDeclarationHash,
    topologySchemaHash,
    serverId: connection.serverInfo?.server_id ?? null,
    serverVersion: connection.serverInfo?.version ?? null,
    streams: streamResults,
    consumers: consumerResults,
    counts: {
      streamsDeclared: topology.streams.length,
      consumersDeclared: topology.consumers.length,
      streamsCreated: streamResults.filter(({ outcome }) => outcome === 'created').length,
      consumersCreated: consumerResults.filter(({ outcome }) => outcome === 'created').length,
    },
    prohibitedOperations: { update: 0, delete: 0, purge: 0, messageDelete: 0 },
  };
}

export async function ensureNatsTopology({
  natsUrl = process.env.NATS_URL ?? 'nats://nats:4222',
  topologyUrl = DEFAULT_TOPOLOGY_URL,
  schemaUrl = DEFAULT_SCHEMA_URL,
  replicas = Number(process.env.NATS_TOPOLOGY_REPLICAS ?? 1),
} = {}) {
  const topologySource = await readFile(topologyUrl, 'utf8');
  const schemaSource = await readFile(schemaUrl, 'utf8');
  const topology = JSON.parse(topologySource);
  const schema = JSON.parse(schemaSource);
  const connection = await new NatsConnection(natsUrl).connect();
  try {
    return await reconcileNatsTopology(connection, topology, schema, {
      replicas,
      topologyDeclarationHash: stableHash(topologySource),
      topologySchemaHash: stableHash(schemaSource),
    });
  } finally {
    connection.close();
  }
}
