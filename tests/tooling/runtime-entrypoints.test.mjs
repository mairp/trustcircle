import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  consumerConfigFor,
  durationToNanoseconds,
  reconcileNatsTopology,
  streamConfigFor,
} from '../../deploy/compose/nats-topology-bootstrap.mjs';
import { SERVICE_DEPENDENCIES, checkDependencies } from '../../deploy/compose/runtime-health.mjs';

const dockerfile = await readFile(
  new URL('../../deploy/compose/Dockerfile', import.meta.url),
  'utf8',
);
const rootManifest = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
);
const packageLock = JSON.parse(
  await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'),
);
const contractsManifest = JSON.parse(
  await readFile(new URL('../../packages/contracts/package.json', import.meta.url), 'utf8'),
);
const workerRuntime = await readFile(
  new URL('../../deploy/compose/worker-runtime.mjs', import.meta.url),
  'utf8',
);
const apiRuntime = await readFile(
  new URL('../../deploy/compose/api-runtime.mjs', import.meta.url),
  'utf8',
);
const topologyBootstrap = await readFile(
  new URL('../../deploy/compose/nats-topology-bootstrap.mjs', import.meta.url),
  'utf8',
);
const natsWitness = await readFile(
  new URL('../../deploy/compose/nats-witness.mjs', import.meta.url),
  'utf8',
);
const natsTopology = JSON.parse(
  await readFile(new URL('../../deploy/nats/topology.json', import.meta.url), 'utf8'),
);
const natsTopologySchema = JSON.parse(
  await readFile(new URL('../../deploy/nats/topology.schema.json', import.meta.url), 'utf8'),
);

class FakeJetStreamConnection {
  constructor() {
    this.serverInfo = { server_id: 'test-server', version: '2.10-test' };
    this.streams = new Map();
    this.consumers = new Map();
    this.subjects = [];
  }

  notFound() {
    const error = new Error('not found');
    error.apiCode = 404;
    throw error;
  }

  async request(subject, body = '') {
    this.subjects.push(subject);
    let match = /^\$JS\.API\.STREAM\.INFO\.([A-Z0-9_]+)$/.exec(subject);
    if (match) return this.streams.get(match[1]) ?? this.notFound();

    match = /^\$JS\.API\.STREAM\.CREATE\.([A-Z0-9_]+)$/.exec(subject);
    if (match) {
      const info = { config: JSON.parse(body) };
      this.streams.set(match[1], info);
      return info;
    }

    match = /^\$JS\.API\.CONSUMER\.INFO\.([A-Z0-9_]+)\.([a-z0-9-]+)$/.exec(subject);
    if (match) return this.consumers.get(`${match[1]}/${match[2]}`) ?? this.notFound();

    match = /^\$JS\.API\.CONSUMER\.DURABLE\.CREATE\.([A-Z0-9_]+)\.([a-z0-9-]+)$/.exec(subject);
    if (match) {
      const request = JSON.parse(body);
      const config = structuredClone(request.config);
      if (config.backoff?.length > 0) config.ack_wait = config.backoff[0];
      const info = { stream_name: request.stream_name, name: match[2], config };
      this.consumers.set(`${match[1]}/${match[2]}`, info);
      return info;
    }

    throw new Error(`unexpected test subject ${subject}`);
  }
}

test('application Docker targets execute explicit long-running runtime entrypoints', () => {
  assert.match(
    dockerfile,
    /CMD \["node", "--experimental-strip-types", "deploy\/compose\/api-runtime\.mjs"\]/,
  );
  for (const service of ['command-worker', 'projector', 'discovery-agent']) {
    assert.match(
      dockerfile,
      new RegExp(
        `CMD \\["node", "--experimental-strip-types", "deploy/compose/worker-runtime\\.mjs", "${service}"\\]`,
      ),
    );
  }
});

test('runtime-imported js-yaml survives the root production-only Docker install', () => {
  assert.equal(rootManifest.dependencies?.['js-yaml'], '4.3.0');
  assert.equal(rootManifest.devDependencies?.['js-yaml'], undefined);
  assert.equal(contractsManifest.dependencies?.['js-yaml'], '4.3.0');
  assert.equal(packageLock.packages?.['node_modules/js-yaml']?.version, '4.3.0');
  assert.notEqual(packageLock.packages?.['node_modules/js-yaml']?.dev, true);
});

test(
  'the standalone clean production-only gate imports js-yaml without workspace node_modules',
  { timeout: 120_000 },
  () => {
    const verification = spawnSync(process.execPath, ['scripts/verify-production-install.mjs'], {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
      timeout: 100_000,
    });
    assert.equal(verification.status, 0, verification.stderr || verification.stdout);
    const result = JSON.parse(verification.stdout);
    assert.equal(result.verdict, 'PRODUCTION INSTALL: PASS');
    assert.equal(result.installedVersion, '4.3.0');
    assert.equal(result.lockDevOnly, false);
    assert.equal(result.usedExistingWorkspaceNodeModules, false);
  },
);

test('command worker maps the complete declared append-only JetStream topology', () => {
  assert.equal(natsTopology.kind, 'NatsJetStreamTopology');
  assert.equal(natsTopology.streams.length, 2);
  assert.equal(natsTopology.consumers.length, 9);
  assert.match(workerRuntime, /if \(service === 'command-worker'\)/);
  assert.match(workerRuntime, /await ensureNatsTopology\(\)/);
  assert.match(workerRuntime, /JSON\.stringify\(topology\)/);
  assert.doesNotMatch(workerRuntime, /topology\.streamsCreated/);

  const governanceStream = natsTopology.streams.find(
    (stream) => stream.name === 'GOVERNANCE_EVENTS',
  );
  const streamConfig = streamConfigFor(governanceStream, 1);
  assert.equal(streamConfig.storage, 'file');
  assert.equal(streamConfig.num_replicas, 1);
  assert.equal(streamConfig.deny_delete, true);
  assert.equal(streamConfig.deny_purge, true);
  assert.ok(streamConfig.subjects.includes('governance.*.evidence.*'));

  const evidenceConsumer = natsTopology.consumers.find(
    (consumer) => consumer.durable === 'governance-evidence-projector',
  );
  const consumerConfig = consumerConfigFor(evidenceConsumer);
  assert.deepEqual(consumerConfig, {
    durable_name: 'governance-evidence-projector',
    description: 'governance-evidence-projector',
    deliver_policy: 'all',
    ack_policy: 'explicit',
    ack_wait: durationToNanoseconds('30s'),
    max_deliver: 8,
    filter_subject: 'governance.*.evidence.*',
    replay_policy: 'instant',
    max_ack_pending: 512,
    backoff: ['1s', '5s', '15s', '30s', '1m', '5m', '10m'].map(durationToNanoseconds),
  });
});

test('bootstrap creates only absent resources then makes a complete matching no-op', async () => {
  const connection = new FakeJetStreamConnection();
  const first = await reconcileNatsTopology(connection, natsTopology, natsTopologySchema, {
    replicas: 1,
    topologyDeclarationHash: 'sha256:declaration',
    topologySchemaHash: 'sha256:schema',
  });
  assert.equal(first.counts.streamsCreated, 2);
  assert.equal(first.counts.consumersCreated, 9);
  assert.equal(
    first.streams.every(
      ({ outcome, configHash }) => outcome === 'created' && configHash.startsWith('sha256:'),
    ),
    true,
  );
  assert.equal(
    first.consumers.every(
      ({ outcome, configHash }) => outcome === 'created' && configHash.startsWith('sha256:'),
    ),
    true,
  );
  assert.deepEqual(first.prohibitedOperations, {
    update: 0,
    delete: 0,
    purge: 0,
    messageDelete: 0,
  });
  assert.equal(
    connection.consumers.get('GOVERNANCE_EVENTS/governance-inventory-projector').config.ack_wait,
    durationToNanoseconds('1s'),
  );

  const subjectCountAfterCreate = connection.subjects.length;
  const second = await reconcileNatsTopology(connection, natsTopology, natsTopologySchema);
  assert.equal(second.counts.streamsCreated, 0);
  assert.equal(second.counts.consumersCreated, 0);
  assert.equal(
    second.streams.every(({ outcome }) => outcome === 'existing'),
    true,
  );
  assert.equal(
    second.consumers.every(({ outcome }) => outcome === 'existing'),
    true,
  );
  assert.equal(
    connection.subjects
      .slice(subjectCountAfterCreate)
      .every((subject) => subject.includes('.INFO.')),
    true,
  );
});

test('bootstrap rejects stream and complete consumer drift without destructive calls', async () => {
  const connection = new FakeJetStreamConnection();
  await reconcileNatsTopology(connection, natsTopology, natsTopologySchema);

  connection.streams.get('GOVERNANCE_EVENTS').config.deny_purge = false;
  await assert.rejects(
    () => reconcileNatsTopology(connection, natsTopology, natsTopologySchema),
    /stream GOVERNANCE_EVENTS configuration does not match/,
  );
  connection.streams.get('GOVERNANCE_EVENTS').config.deny_purge = true;

  connection.consumers.get(
    'GOVERNANCE_EVENTS/governance-evidence-projector',
  ).config.max_ack_pending = 7;
  await assert.rejects(
    () => reconcileNatsTopology(connection, natsTopology, natsTopologySchema),
    /consumer governance-evidence-projector configuration does not match/,
  );

  assert.equal(
    connection.subjects.some((subject) =>
      /STREAM\.(?:UPDATE|DELETE|PURGE)|CONSUMER\.(?:UPDATE|DELETE)|STREAM\.MSG\.DELETE/.test(
        subject,
      ),
    ),
    false,
  );
  assert.doesNotMatch(
    topologyBootstrap,
    /\$JS\.API\.(?:STREAM\.(?:UPDATE|DELETE|PURGE)|CONSUMER\.(?:UPDATE|DELETE)|STREAM\.MSG\.DELETE)/,
  );
});

test('JetStream witness uses only the predeclared stream and durable consumer', () => {
  assert.match(natsWitness, /const STREAM = 'GOVERNANCE_EVENTS'/);
  assert.match(natsWitness, /const CONSUMER = 'governance-evidence-projector'/);
  assert.match(natsWitness, /STREAM\.MSG\.GET/);
  assert.match(natsWitness, /CONSUMER\.MSG\.NEXT/);
  assert.match(natsWitness, /account_scope_hash/);
  assert.match(natsWitness, /stream_sequence/);
  assert.match(natsWitness, /delivery_state/);
  assert.match(natsWitness, /negative-ack-for-restart-redelivery/);
  assert.match(natsWitness, /acknowledged-after-restart-proof/);
  assert.doesNotMatch(natsWitness, /STREAM\.CREATE|CONSUMER\.DURABLE\.CREATE/);
});

test('worker supervisor covers the exact three worker targets and required substrates', () => {
  assert.deepEqual(Object.keys(SERVICE_DEPENDENCIES).sort(), [
    'api',
    'command-worker',
    'discovery-agent',
    'projector',
  ]);
  assert.deepEqual(
    SERVICE_DEPENDENCIES['command-worker'].map((item) => item.name),
    ['postgres', 'nats', 'opa', 'object-storage'],
  );
  assert.deepEqual(
    SERVICE_DEPENDENCIES.projector.map((item) => item.name),
    ['postgres', 'nats'],
  );
  assert.deepEqual(
    SERVICE_DEPENDENCIES['discovery-agent'].map((item) => item.name),
    ['postgres', 'nats', 'opa'],
  );
  assert.match(workerRuntime, /await import\(new URL\(moduleByService\[service\]/);
  assert.match(workerRuntime, /startHealthSupervisor/);
  assert.match(workerRuntime, /createServer/);
  assert.match(workerRuntime, /processMode: 'dependency-supervisor'/);
  assert.match(workerRuntime, /workloadStarted: false/);
});

test('API runtime serves the existing app and derives readiness from live dependencies', () => {
  assert.match(apiRuntime, /createProductionApiRuntime/);
  assert.match(apiRuntime, /PostgresRuntimeReadModelRepository/);
  assert.match(apiRuntime, /checkDependencies\('api'\)/);
  assert.match(apiRuntime, /trustedPreviewTransport/);
  assert.match(apiRuntime, /shutdown\.markReady\(\)/);
  assert.match(apiRuntime, /server\.listen\(PORT, '0\.0\.0\.0'/);
});

test('unsupported runtime services fail closed before any probe', async () => {
  await assert.rejects(() => checkDependencies('not-a-service'), /unsupported runtime service/);
});
