import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('operator console routing contract', () => {
  const compose = readFileSync('deploy/compose/control-plane.yml', 'utf8');

  it('preserves exactly the approved public web and API mappings', () => {
    const published = [...compose.matchAll(/- '(\d+):(\d+)'/g)].map(
      (match) => `${match[1]}:${match[2]}`,
    );
    expect(published).toEqual(['14001:3000', '14000:8080']);
  });

  it('keeps web readiness dependent on API while liveness owns the healthcheck', () => {
    expect(compose).toContain("API_BASE_URL: 'http://api:3000'");
    expect(compose).toContain("LOCAL_OPERATOR_PREVIEW: 'true'");
    expect(compose).toContain('http://localhost:8080/healthz');
    expect(compose).toContain('condition: service_started');
  });
});
