import { describe, expect, test } from 'vitest';
import { isHeadroomWrapTarget, isVendorTool } from '../../cli/dashboard.ts';

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
