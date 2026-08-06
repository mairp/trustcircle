import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileRuntimeComponentProfile } from '../../deploy/compose/runtime-component-reconciler.mjs';

const profile = {
  profileVersion: '1.0.0',
  components: [
    {
      id: 'postgres',
      role: 'infrastructure',
      runtimeSet: 'core-required',
      owner: 'platform/data',
      purpose: 'Canonical governance store.',
      dependsOn: [],
      authority: { mayExecute: false },
    },
    {
      id: 'projector',
      role: 'projector',
      runtimeSet: 'core-required',
      owner: 'platform/governance',
      purpose: 'Builds read models.',
      dependsOn: [{ component: 'postgres', required: true }],
      authority: { mayExecute: false },
    },
    {
      id: 'workflow-orchestration',
      role: 'connector',
      runtimeSet: 'external',
      owner: 'governance/workflows',
      purpose: 'External governed workflow source.',
      dependsOn: [],
      authority: { mayExecute: false },
    },
    {
      id: 'legacy-jira-connector',
      role: 'connector',
      runtimeSet: 'intentionally-inactive',
      owner: 'governance/legacy',
      purpose: 'Retained for provenance.',
      dependsOn: [],
      authority: { mayExecute: false },
    },
  ],
};

test('reconciles declared components with live observations without fabricating external health', () => {
  const rows = reconcileRuntimeComponentProfile(
    profile,
    {
      postgres: { reachable: true, operational: true, runtimeState: 'running' },
      projector: {
        reachable: true,
        operational: false,
        runtimeState: 'dependency-supervisor',
        detail: 'module loaded; projection loop not started',
      },
    },
    1_785_824_000_000,
  );

  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    component_key: 'postgres',
    profile_version: '1.0.0',
    role: 'infrastructure',
    runtime_set: 'core-required',
    availability_class: 'core',
    owner: 'platform/data',
    purpose: 'Canonical governance store.',
    dependencies: [],
    may_execute: false,
    runtime_state: 'running',
    health: 'healthy',
    freshness: 'fresh',
    observation_source: 'live-probe',
    observation_detail: null,
    observed_at: 1_785_824_000_000,
    safe_next_action: null,
  });

  assert.match(rows[1].observation_detail, /projection loop not started/);
  assert.equal(rows[1].health, 'degraded');
  assert.equal(rows[1].freshness, 'fresh');
  assert.match(rows[1].safe_next_action, /start the governed projector workload/i);

  assert.deepEqual(
    rows.slice(2).map((row) => ({
      key: row.component_key,
      state: row.runtime_state,
      health: row.health,
      freshness: row.freshness,
      source: row.observation_source,
    })),
    [
      {
        key: 'workflow-orchestration',
        state: 'unobserved',
        health: 'unknown',
        freshness: 'unknown',
        source: 'profile-declaration',
      },
      {
        key: 'legacy-jira-connector',
        state: 'intentionally-inactive',
        health: 'unknown',
        freshness: 'unknown',
        source: 'profile-declaration',
      },
    ],
  );
});

test('rejects malformed component declarations instead of silently dropping them', () => {
  assert.throws(
    () =>
      reconcileRuntimeComponentProfile(
        { profileVersion: '1.0.0', components: [{ id: '' }] },
        {},
        1,
      ),
    /component id/i,
  );
});
