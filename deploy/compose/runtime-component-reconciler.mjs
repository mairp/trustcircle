const RUNTIME_SET_TO_AVAILABILITY = Object.freeze({
  'core-required': 'core',
  'on-demand': 'on-demand',
  optional: 'optional',
  external: 'optional',
  'intentionally-inactive': 'optional',
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function dependenciesOf(component) {
  if (!Array.isArray(component.dependsOn)) {
    throw new TypeError(`component ${component.id} dependsOn must be an array`);
  }
  return component.dependsOn.map((dependency) => {
    if (typeof dependency === 'string') return nonEmpty(dependency, 'dependency component');
    if (isRecord(dependency)) return nonEmpty(dependency.component, 'dependency component');
    throw new TypeError(`component ${component.id} has a malformed dependency`);
  });
}

function inactiveState(runtimeSet) {
  if (runtimeSet === 'intentionally-inactive') return 'intentionally-inactive';
  if (runtimeSet === 'external') return 'unobserved';
  return 'expected-offline';
}

function inactiveAction(componentKey, runtimeSet) {
  if (runtimeSet === 'intentionally-inactive') {
    return 'No activation is expected; retain the approved inactive state until its owner changes the profile.';
  }
  if (runtimeSet === 'external') {
    return `Onboard and observe ${componentKey} through its owning API before claiming governance coverage.`;
  }
  if (runtimeSet === 'on-demand') {
    return `Activate ${componentKey} through its owner-approved on-demand workflow when required.`;
  }
  return `Enable ${componentKey} only when its optional capability is required.`;
}

function workloadAction(component) {
  if (component.role === 'projector') {
    return 'Start the governed projector workload; dependency reachability alone is not projection health.';
  }
  if (component.role === 'discovery') {
    return 'Start the governed discovery workload with an approved least-privilege scan boundary.';
  }
  if (component.role === 'worker') {
    return 'Start the governed command-worker workload; dependency reachability alone is not execution health.';
  }
  return `Restore the governed ${component.id} workload and verify its operational status.`;
}

function declaration(component, profileVersion) {
  if (!isRecord(component)) throw new TypeError('component declaration must be an object');
  const id = nonEmpty(component.id, 'component id');
  const role = nonEmpty(component.role, `component ${id} role`);
  const runtimeSet = nonEmpty(component.runtimeSet, `component ${id} runtimeSet`);
  const availability = RUNTIME_SET_TO_AVAILABILITY[runtimeSet];
  if (!availability)
    throw new TypeError(`component ${id} has unsupported runtimeSet ${runtimeSet}`);
  const owner = nonEmpty(component.owner, `component ${id} owner`);
  const purpose = nonEmpty(component.purpose, `component ${id} purpose`);
  const mayExecute = isRecord(component.authority) && component.authority.mayExecute === true;
  return Object.freeze({
    id,
    profileVersion,
    role,
    runtimeSet,
    availability,
    owner,
    purpose,
    dependencies: Object.freeze(dependenciesOf(component)),
    mayExecute,
  });
}

/**
 * Reconcile an owner-approved component profile with current, disclosure-safe live observations.
 * The function never upgrades a missing observation to healthy and never treats expected-offline
 * components as incidents. Returned rows are the operator read model; they grant no authority.
 */
export function reconcileRuntimeComponentProfile(profile, observations, observedAtMs) {
  if (!isRecord(profile)) throw new TypeError('component profile must be an object');
  const profileVersion = nonEmpty(profile.profileVersion, 'profileVersion');
  if (!Array.isArray(profile.components))
    throw new TypeError('component profile components must be an array');
  if (!isRecord(observations)) throw new TypeError('component observations must be an object');
  if (!Number.isFinite(observedAtMs) || observedAtMs < 0) {
    throw new RangeError('observedAtMs must be a non-negative finite number');
  }

  const seen = new Set();
  return Object.freeze(
    profile.components.map((raw) => {
      const component = declaration(raw, profileVersion);
      if (seen.has(component.id)) throw new TypeError(`duplicate component id ${component.id}`);
      seen.add(component.id);
      const observation = observations[component.id];

      if (component.runtimeSet !== 'core-required' && !isRecord(observation)) {
        return Object.freeze({
          component_key: component.id,
          profile_version: component.profileVersion,
          role: component.role,
          runtime_set: component.runtimeSet,
          availability_class: component.availability,
          owner: component.owner,
          purpose: component.purpose,
          dependencies: component.dependencies,
          may_execute: component.mayExecute,
          runtime_state: inactiveState(component.runtimeSet),
          health: 'unknown',
          freshness: 'unknown',
          observation_source: 'profile-declaration',
          observation_detail: null,
          observed_at: observedAtMs,
          safe_next_action: inactiveAction(component.id, component.runtimeSet),
        });
      }

      const observed = isRecord(observation) ? observation : {};
      const reachable = observed.reachable === true;
      const operational = observed.operational === true;
      const runtimeState =
        typeof observed.runtimeState === 'string' && observed.runtimeState.length > 0
          ? observed.runtimeState
          : reachable
            ? operational
              ? 'running'
              : 'degraded'
            : isRecord(observation)
              ? 'unavailable'
              : 'unobserved';
      const detail =
        typeof observed.detail === 'string' && observed.detail.length > 0 ? observed.detail : null;
      const health = reachable ? (operational ? 'healthy' : 'degraded') : 'unavailable';
      const freshness = isRecord(observation) ? 'fresh' : 'unknown';
      const safeNextAction =
        health === 'healthy'
          ? null
          : reachable
            ? workloadAction(component)
            : `Restore ${component.id} reachability and reconcile its accountable owner before relying on it.`;

      return Object.freeze({
        component_key: component.id,
        profile_version: component.profileVersion,
        role: component.role,
        runtime_set: component.runtimeSet,
        availability_class: component.availability,
        owner: component.owner,
        purpose: component.purpose,
        dependencies: component.dependencies,
        may_execute: component.mayExecute,
        runtime_state: runtimeState,
        health,
        freshness,
        observation_source: isRecord(observation) ? 'live-probe' : 'profile-declaration',
        observation_detail: detail,
        observed_at: observedAtMs,
        safe_next_action: safeNextAction,
      });
    }),
  );
}
