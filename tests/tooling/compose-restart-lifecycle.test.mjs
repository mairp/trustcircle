import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import yaml from 'js-yaml';

const APPLICATION_SERVICES = ['api', 'command-worker', 'projector', 'discovery-agent', 'web'];
const CORE_SERVICES = [
  'postgres',
  'object-storage',
  'nats',
  'opa',
  'collector',
  ...APPLICATION_SERVICES,
];

const composePath = new URL('../../deploy/compose/control-plane.yml', import.meta.url);
const rootComposePath = new URL('../../compose.yaml', import.meta.url);

function loadCompose() {
  return yaml.load(readFileSync(composePath, 'utf8'), { schema: yaml.DEFAULT_SCHEMA });
}

test('plain compose up rebuilds every application image from the checked-out source', () => {
  const compose = loadCompose();

  for (const serviceName of APPLICATION_SERVICES) {
    const service = compose.services[serviceName];
    assert.ok(service?.build, `${serviceName} must retain a local build definition`);
    assert.equal(
      service.pull_policy,
      'build',
      `${serviceName} must rebuild on plain compose up instead of reusing a stale local image`,
    );
  }
});

test('docker compose from the repository root resolves the governed control-plane topology', () => {
  const rootCompose = yaml.load(readFileSync(rootComposePath, 'utf8'), {
    schema: yaml.DEFAULT_SCHEMA,
  });

  assert.deepEqual(rootCompose, {
    include: [{ path: 'deploy/compose/control-plane.yml' }],
  });
});

test('the full core stack recovers after Docker restarts unless an operator stopped it', () => {
  const compose = loadCompose();

  assert.deepEqual(Object.keys(compose.services).sort(), [...CORE_SERVICES].sort());
  for (const serviceName of CORE_SERVICES) {
    assert.equal(
      compose.services[serviceName]?.restart,
      'unless-stopped',
      `${serviceName} must recover after a Docker daemon restart`,
    );
  }
});

test('application containers use an init process and bounded graceful shutdown', () => {
  const compose = loadCompose();

  for (const serviceName of APPLICATION_SERVICES) {
    const service = compose.services[serviceName];
    assert.equal(
      service?.init,
      true,
      `${serviceName} must reap child processes and forward signals`,
    );
    assert.match(
      String(service?.stop_grace_period ?? ''),
      /^\d+s$/,
      `${serviceName} must declare a bounded stop_grace_period`,
    );
  }
});
