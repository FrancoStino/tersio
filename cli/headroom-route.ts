// The Headroom gateway: one local proxy every agent can point at, and the process tersio started.
// No agent config is rewritten. `headroom wrap` edits an agent's own files and has to be undone per
// agent; a proxy URL works for any client, including ones upstream cannot wrap, and leaves no marker.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveHeadroomBinary } from '../extensions/shared/utils.ts';

export interface HeadroomProxyState {
  running: boolean;
  port: number;
  pid: number | null;
  /** The URLs a client points at, so the UI never has to restate them. */
  anthropicUrl: string;
  openaiUrl: string;
  detail: string;
}

/** The pid/port tersio started, so the toggle stops exactly that process and never a hand-run proxy. */
function proxyStateFile(home: string): string {
  return path.join(home, '.tersio', 'headroom-proxy.json');
}

export function readHeadroomProxy(home: string, port = 8787): HeadroomProxyState {
  const file = proxyStateFile(home);
  let stored: { pid?: unknown; port?: unknown } = {};
  try { stored = JSON.parse(readFileSync(file, 'utf8')) as typeof stored; } catch { /* never started */ }
  const pid = typeof stored.pid === 'number' ? stored.pid : null;
  const activePort = typeof stored.port === 'number' ? stored.port : port;
  const urls = { anthropicUrl: `http://127.0.0.1:${activePort}`, openaiUrl: `http://127.0.0.1:${activePort}/v1` };
  if (pid === null) return { running: false, port: activePort, pid: null, ...urls, detail: 'not started by tersio' };
  try {
    process.kill(pid, 0);
    return { running: true, port: activePort, pid, ...urls, detail: `pid ${pid} on port ${activePort}` };
  } catch {
    return { running: false, port: activePort, pid: null, ...urls, detail: 'the proxy this started has exited' };
  }
}

/** Polls the proxy's own health endpoint; nothing is compressed until it answers. */
async function waitForProxy(port: number, budgetMs: number): Promise<boolean> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 500);
    await promise;
  }
  return false;
}

/** Starts the proxy detached and reports ready only once its health endpoint answers. */
export async function startHeadroomProxy(home: string, port = 8787): Promise<{ ok: boolean; detail: string; proxy: HeadroomProxyState }> {
  const bin = resolveHeadroomBinary();
  if (!bin) return { ok: false, detail: 'headroom binary not found in PATH', proxy: readHeadroomProxy(home, port) };
  const current = readHeadroomProxy(home, port);
  if (current.running) return { ok: true, detail: current.detail, proxy: current };
  try {
    const child = spawn(bin, ['proxy', '--port', String(port)], { detached: true, stdio: 'ignore' });
    child.unref();
    mkdirSync(path.dirname(proxyStateFile(home)), { recursive: true });
    writeFileSync(proxyStateFile(home), `${JSON.stringify({ pid: child.pid, port, startedAt: Date.now() }, null, 2)}\n`, 'utf8');
    const ready = await waitForProxy(port, 25_000);
    return {
      ok: ready,
      detail: ready ? `started pid ${child.pid ?? '?'} on port ${port}` : `pid ${child.pid ?? '?'} started but its health endpoint never answered`,
      proxy: readHeadroomProxy(home, port),
    };
  } catch (e) {
    return { ok: false, detail: (e as Error).message, proxy: readHeadroomProxy(home, port) };
  }
}

/** Stops only the proxy this tool started; a proxy the user runs by hand is never touched. */
export function stopHeadroomProxy(home: string, port = 8787): { ok: boolean; detail: string; proxy: HeadroomProxyState } {
  const state = readHeadroomProxy(home, port);
  if (state.pid === null) return { ok: true, detail: 'no proxy started by tersio', proxy: state };
  try {
    process.kill(state.pid, 'SIGTERM');
    writeFileSync(proxyStateFile(home), `${JSON.stringify({ pid: null, port: state.port }, null, 2)}\n`, 'utf8');
    return { ok: true, detail: `stopped pid ${state.pid}`, proxy: readHeadroomProxy(home, port) };
  } catch (e) {
    return { ok: false, detail: (e as Error).message, proxy: readHeadroomProxy(home, port) };
  }
}
