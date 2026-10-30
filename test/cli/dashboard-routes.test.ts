import { describe, expect, test } from 'vitest';
import { agentJson, awaitHeadroomProxy, headroomDashboardPlan, headroomProxyAnswers, lanUrls, proxyChildAlive, resolveBind, headroomProxyRequests, healthJson, isHeadroomWrapTarget, isVendorTool, json, statusJson } from '../../cli/dashboard.ts';
import { createServer } from 'node:http';
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

test('json refuses a pre-serialized string, so a folded route cannot double-encode', () => {
  const res = { writeHead: () => res, end: () => res };
  expect(() => json(res, 200, healthJson())).toThrow(/jsonText/);
});

// Every interface is the default, so a phone can open it; `local` is the opt-out.
test('the dashboard binds every interface unless loopback is asked for', () => {
  expect(resolveBind(null)).toBe('0.0.0.0');
  expect(resolveBind('')).toBe('0.0.0.0');
  expect(resolveBind('lan')).toBe('0.0.0.0');
  expect(resolveBind('0.0.0.0')).toBe('0.0.0.0');
  expect(resolveBind('192.168.1.20')).toBe('192.168.1.20');
  expect(resolveBind('not an address')).toBe('0.0.0.0');
  expect(resolveBind('local')).toBe('127.0.0.1');
  expect(resolveBind('localhost')).toBe('127.0.0.1');
  expect(lanUrls(8080, '127.0.0.1')).toEqual([]);
  expect(lanUrls(8080, '192.168.1.20')).toEqual(['http://192.168.1.20:8080']);
});
// A killed child keeps exitCode null and reports a signal, so liveness must read both fields.
test('a signalled proxy child no longer counts as running', () => {
  expect(proxyChildAlive({ exitCode: null, signalCode: null })).toBe(true);
  expect(proxyChildAlive({ exitCode: 0, signalCode: null })).toBe(false);
  expect(proxyChildAlive({ exitCode: null, signalCode: 'SIGTERM' })).toBe(false);
  expect(proxyChildAlive(null)).toBe(false);
});
// The dashboard command prints its URL with the proxy down, so the drawer only opens a port that answers.
test('the proxy probe tells a live port from a refused one', async () => {
  const server = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    expect(await headroomProxyAnswers(`http://127.0.0.1:${port}/dashboard`)).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  expect(await headroomProxyAnswers(`http://127.0.0.1:${port}/dashboard`, 400)).toBe(false);
});

// The route's fork: an answering proxy redirects, a silent one explains how to start it.
test('the dashboard plan redirects only when the proxy answers', () => {
  expect(headroomDashboardPlan('http://127.0.0.1:8787/dashboard', true)).toEqual({ kind: 'redirect', url: 'http://127.0.0.1:8787/dashboard' });
  expect(headroomDashboardPlan('http://127.0.0.1:9001/dashboard', false)).toEqual({ kind: 'explain', port: '9001' });
  expect(headroomDashboardPlan(null, false)).toEqual({ kind: 'explain', port: '8787' });
});

// A started proxy takes a few seconds to answer, so the wait retries instead of reading one probe.
test('the proxy wait retries until the port answers, then gives up', async () => {
  let probes = 0;
  const late = await awaitHeadroomProxy(async () => { probes += 1; return probes === 3; }, 5, 1);
  expect(late).toBe(true);
  expect(probes).toBe(3);

  let dry = 0;
  const never = await awaitHeadroomProxy(async () => { dry += 1; return false; }, 2, 1);
  expect(never).toBe(false);
  expect(dry).toBe(3);
});
// Closing the tab must not pull the proxy out from under a routed session.
test('the stop guard reads the proxy traffic counters, and fails safe', async () => {
  const start = async (payload: string): Promise<{ url: string; close: () => Promise<void> }> => {
    const server = createServer((req, res) => {
      if (req.url !== '/stats') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(payload);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  };

  const idle = await start(JSON.stringify({ summary: { api_requests: 0, compression: { requests_compressed: 0 } } }));
  try { expect(await headroomProxyRequests(idle.url)).toBe(0); } finally { await idle.close(); }

  const busy = await start(JSON.stringify({ summary: { api_requests: 3, compression: { requests_compressed: 1 } } }));
  try { expect(await headroomProxyRequests(busy.url)).toBe(3); } finally { await busy.close(); }

  const junk = await start('not json');
  try { expect(await headroomProxyRequests(junk.url)).toBeNull(); } finally { await junk.close(); }

  expect(await headroomProxyRequests('http://127.0.0.1:9', 400)).toBeNull();
});
