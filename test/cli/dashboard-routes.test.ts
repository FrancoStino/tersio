import { describe, expect, test } from 'vitest';
import { agentJson, healthJson, isHeadroomWrapTarget, isVendorTool, statusJson } from '../../cli/dashboard.ts';
import { withHome } from '../helpers/env.ts';

// The route handlers pass these names straight to a child process, so the guards are the boundary.
describe('dashboard route guards', () => {
  test('only headroom wrap targets reach the wrap command', () => {
    expect(isHeadroomWrapTarget('omp')).toBe(true);
    expect(isHeadroomWrapTarget('claude')).toBe(true);
    expect(isHeadroomWrapTarget('--force')).toBe(false);
    expect(isHeadroomWrapTarget('')).toBe(false);
  });

  test('only the two managed binaries reach the vendor routes', () => {
    expect(isVendorTool('headroom')).toBe(true);
    expect(isVendorTool('rtk')).toBe(true);
    expect(isVendorTool('caveman')).toBe(false);
    expect(isVendorTool('')).toBe(false);
  });
});

// These three build their own JSON string, and `json()` would double-encode one; the routes send them as text.
describe('dashboard payloads are serialized once', () => {
  test('health, status, and agent answers parse to objects, never to a string', async () => {
    await withHome(async () => {
      const health: unknown = JSON.parse(healthJson());
      expect(health).toBeTypeOf('object');
      expect(health).toHaveProperty('tersio');
      expect(health).toHaveProperty('headroom');

      const status: unknown = JSON.parse(await statusJson());
      expect(status).toBeTypeOf('object');
      expect(status).toHaveProperty('status');

      const agent: unknown = JSON.parse(agentJson('24h', 'overview', 0));
      expect(agent).toBeTypeOf('object');
      expect(agent).toHaveProperty('range', '24h');
      expect(agent).toHaveProperty('agent');
    });
  });
});
