// The Headroom gateway: one local proxy every agent can point at, and the process tersio started.
// Routing a host rewrites that agent's own provider baseUrls to the gateway — first-party providers
// only, originals persisted tersio-side, and stopping the proxy unroutes everything before it dies.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if (state.pid === null && !(readRoutingState(home).ymlInstances ?? []).length) return { ok: true, detail: 'no proxy started by tersio', proxy: state };
  try { if (state.pid !== null) process.kill(state.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (const instance of readRoutingState(home).ymlInstances ?? []) {
    if (instance.pid === null) continue;
    try { process.kill(instance.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const next = readRoutingState(home);
  delete next.ymlInstances;
  writeRoutingState(home, next);
  writeFileSync(proxyStateFile(home), `${JSON.stringify({ pid: null, port: state.port }, null, 2)}\n`, 'utf8');
  return { ok: true, detail: `stopped pid ${state.pid ?? '?'}`, proxy: readHeadroomProxy(home, port) };
}


/** The first-party APIs the gateway actually forwards to; a custom provider routed here would break. */
const FIRST_PARTY = /api\.anthropic\.com|api\.openai\.com/;

export interface ProviderRoute {
  provider: string;
  original: string | null;
}

export interface RoutingState {
  hosts: Record<string, ProviderRoute[]>;
  /** The gateway instances the omp models.yml route started, one per provider upstream. */
  ymlInstances?: YmlInstance[];
  /** The models.yml baseUrl lines tersio replaced, so unroute can put the originals back. */
  ymlRewrites?: YmlRewrite[];
}

function routingFile(home: string): string {
  return path.join(home, '.tersio', 'headroom-routes.json');
}

function readRoutingState(home: string): RoutingState {
  try { return JSON.parse(readFileSync(routingFile(home), 'utf8')) as RoutingState; } catch { return { hosts: {} }; }
}

function writeRoutingState(home: string, state: RoutingState): void {
  mkdirSync(path.dirname(routingFile(home)), { recursive: true });
  writeFileSync(routingFile(home), JSON.stringify(state, null, 2), 'utf8');
}

/** The hosts whose providers currently point at the gateway, omp's models.yml route included. */
export function routedHosts(home: string): string[] {
  const state = readRoutingState(home);
  const hosts = new Set(Object.keys(state.hosts));
  if (state.ymlInstances && state.ymlInstances.length > 0) hosts.add('omp');
  return [...hosts].sort();
}

function modelsFile(home: string, host: 'omp' | 'pi'): string | null {
  if (host === 'pi') return path.join(home, '.pi', 'agent', 'models.json');
  if (host === 'omp') return path.join(home, '.omp', 'agent', 'models.json');
  return null;
}

/** One gateway process for one omp provider: its port and the upstream it forwards to. */
export interface YmlInstance {
  provider: string;
  port: number;
  pid: number | null;
  target: string;
}

/** One provider baseUrl line tersio moved from its original upstream to a gateway port. */
export interface YmlRewrite {
  provider: string;
  original: string;
  gateway: string;
}

function ompModelsYml(home: string): string {
  return path.join(home, '.omp', 'agent', 'models.yml');
}

/** The providers models.yml declares, each with the baseUrl that names its upstream (null for built-ins). */
export function ompProvidersFromYml(home: string): Array<{ provider: string; baseUrl: string | null }> {
  const file = ompModelsYml(home);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const providers: Array<{ provider: string; baseUrl: string | null }> = [];
  let inProviders = false;
  let current: { provider: string; baseUrl: string | null } | null = null;
  for (const line of lines) {
    if (/^providers:\s*$/.test(line)) { inProviders = true; continue; }
    if (!inProviders) continue;
    if (/^\S/.test(line)) { inProviders = false; current = null; continue; }
    const name = line.match(/^  ([A-Za-z0-9._-]+):\s*$/);
    if (name) { current = { provider: name[1], baseUrl: null }; providers.push(current); continue; }
    const baseUrl = current && line.match(/^    baseUrl:\s*(\S+)\s*$/);
    if (baseUrl && current) current.baseUrl = baseUrl[1];
  }
  return providers;
}

/** The line range of one provider's block: from its `  name:` line up to the next sibling or root key. */
function providerBlockRange(lines: string[], provider: string): { start: number; end: number } | null {
  const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((line) => new RegExp(`^  ${escaped}:\\s*$`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {0,2}\S/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/** Sets, inserts, or removes a provider's baseUrl line, leaving every other byte of models.yml alone. */
function setProviderBaseUrl(home: string, provider: string, value: string | null): boolean {
  const file = ompModelsYml(home);
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, 'utf8').split('\n');
  const range = providerBlockRange(lines, provider);
  if (!range) return false;
  const existing = lines.findIndex((line, i) => i > range.start && i < range.end && /^    baseUrl:/.test(line));
  if (existing > 0) {
    if (value === null) lines.splice(existing, 1);
    else lines[existing] = `    baseUrl: ${value}`;
  } else if (value !== null) {
    lines.splice(range.start + 1, 0, `    baseUrl: ${value}`);
  } else {
    return true;
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
  return true;
}

function withV1(url: string): string {
  return /\/v1\/?$/.test(url) ? url : `${url.replace(/\/$/, '')}/v1`;
}

/** The first routed gateway's port; the tests move it so a live gateway on 8787 cannot collide. */
function gatewayBasePort(): number {
  const override = Number(process.env.TERSIO_HEADROOM_PORT);
  return Number.isInteger(override) && override > 0 && override < 65535 ? override : 8787;
}

function spawnGateway(bin: string, port: number, target: string): number | null {
  const child = spawn(bin, ['proxy', '--port', String(port), '--openai-api-url', target], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid ?? null;
}

/**
 * Routes omp through the gateway: one instance per models.yml provider, each forwarding to that
 * provider's original upstream, and a baseUrl rewrite in models.yml pointing omp at its instance.
 * The credential never moves — only the URL does.
 */
async function routeOmpViaYml(home: string): Promise<{ ok: boolean; detail: string }> {
  const declared = ompProvidersFromYml(home);
  if (declared.length === 0) return { ok: false, detail: 'no ~/.omp/agent/models.yml on this machine — run omp once so it writes one, then route' };
  const routable = declared.filter((entry): entry is { provider: string; baseUrl: string } => entry.baseUrl !== null);
  const bare = declared.filter((entry) => entry.baseUrl === null).map((entry) => entry.provider);
  if (routable.length === 0) return { ok: false, detail: 'no provider in models.yml declares a baseUrl — nothing to point at the gateway' };
  const state = readRoutingState(home);
  if (state.ymlInstances && state.ymlInstances.length > 0) return { ok: true, detail: 'already routed through the gateway' };
  const bin = resolveHeadroomBinary();
  if (!bin) return { ok: false, detail: 'headroom binary not found in PATH — install it, then route' };
  // A plain gateway on the primary port has no forwarding target, so the routed set replaces it.
  if (readHeadroomProxy(home).running) {
    const stopped = stopHeadroomProxy(home);
    if (!stopped.ok) return { ok: false, detail: `could not replace the running gateway: ${stopped.detail}` };
  }
  const instances: YmlInstance[] = routable.map((entry, i) => ({ provider: entry.provider, port: gatewayBasePort() + i, pid: null, target: withV1(entry.baseUrl) }));
  try {
    for (const instance of instances) instance.pid = spawnGateway(bin, instance.port, instance.target);
    const ready = await Promise.all(instances.map((instance) => waitForProxy(instance.port, 25_000)));
    if (!ready.every(Boolean)) throw new Error('a gateway instance never answered its health endpoint');
  } catch (e) {
    for (const instance of instances) {
      if (instance.pid === null) continue;
      try { process.kill(instance.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    return { ok: false, detail: (e as Error).message };
  }
  const rewrites: YmlRewrite[] = [];
  for (const instance of instances) {
    const original = routable.find((entry) => entry.provider === instance.provider)?.baseUrl;
    if (!original || !setProviderBaseUrl(home, instance.provider, `http://127.0.0.1:${instance.port}/v1`)) continue;
    rewrites.push({ provider: instance.provider, original, gateway: `http://127.0.0.1:${instance.port}/v1` });
  }
  state.ymlInstances = instances;
  state.ymlRewrites = rewrites;
  writeRoutingState(home, state);
  // The primary instance doubles as the gateway the dashboard watches and stops.
  const primary = instances[0];
  writeFileSync(proxyStateFile(home), `${JSON.stringify({ pid: primary.pid, port: primary.port, startedAt: Date.now() }, null, 2)}\n`, 'utf8');
  const skipped = bare.length > 0 ? ` — skipped ${bare.join(', ')}: no baseUrl to move` : '';
  return { ok: true, detail: `routed ${rewrites.map((entry) => entry.provider).join(', ')} through the gateway — new omp sessions pick it up${skipped}` };
}

function unrouteOmpYml(home: string, state: RoutingState): { ok: boolean; detail: string } {
  const instances = state.ymlInstances ?? [];
  for (const instance of instances) {
    if (instance.pid === null) continue;
    try { process.kill(instance.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  // Put every rewritten baseUrl back exactly as it was before the route.
  for (const rewrite of state.ymlRewrites ?? []) setProviderBaseUrl(home, rewrite.provider, rewrite.original);
  delete state.ymlInstances;
  delete state.ymlRewrites;
  writeRoutingState(home, state);
  const primaryPort = instances[0]?.port ?? 8787;
  writeFileSync(proxyStateFile(home), `${JSON.stringify({ pid: null, port: primaryPort }, null, 2)}\n`, 'utf8');
  return { ok: true, detail: 'restored the original provider base URLs and stopped the gateway instances' };
}

/**
 * Routes a host through the gateway: every first-party (or unset) provider baseUrl becomes the
 * gateway's OpenAI URL, originals persist tersio-side, and custom providers are left alone and named.
 * A host with no models.json (omp) routes through a managed models.yml instead, one gateway instance
 * per discovered provider upstream.
 */
export async function routeHost(home: string, host: 'omp' | 'pi', urls: { openai: string; anthropic: string }): Promise<{ ok: boolean; detail: string }> {
  const file = modelsFile(home, host);
  if (!file || !existsSync(file)) {
    if (host === 'omp') return routeOmpViaYml(home);
    return { ok: false, detail: 'this agent reads no models.json — set the base URL in its environment instead' };
  }
  let parsed: { providers?: Record<string, { baseUrl?: string }> } = {};
  try { parsed = JSON.parse(readFileSync(file, 'utf8')) as typeof parsed; } catch { return { ok: false, detail: 'the agent models.json does not parse — fix it by hand first' }; }
  const providers = parsed.providers ?? {};
  const names = Object.keys(providers);
  if (names.length === 0) return { ok: false, detail: 'the agent has no providers configured — set the base URL in its environment instead' };
  const state = readRoutingState(home);
  if (state.hosts[host]) return { ok: true, detail: 'already routed through the gateway' };
  const originals: ProviderRoute[] = [];
  const customs: string[] = [];
  for (const name of names) {
    const current = providers[name]?.baseUrl ?? null;
    if (current && !FIRST_PARTY.test(current)) { customs.push(name); continue; }
    originals.push({ provider: name, original: current });
    providers[name] = { ...providers[name], baseUrl: urls.openai };
  }
  if (originals.length === 0) return { ok: false, detail: `every provider is custom (${customs.join(', ')}) — the gateway forwards to the first-party API, so routing would break them` };
  parsed.providers = providers;
  writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
  state.hosts[host] = originals;
  writeRoutingState(home, state);
  return { ok: true, detail: `routed ${originals.length} provider(s) through the gateway${customs.length ? ` — skipped custom: ${customs.join(', ')}` : ''}` };
}

/** Restores a host's original provider baseUrls and forgets the route. */
export function unrouteHost(home: string, host: 'omp' | 'pi'): { ok: boolean; detail: string } {
  const state = readRoutingState(home);
  if (host === 'omp' && state.ymlInstances) return unrouteOmpYml(home, state);
  const originals = state.hosts[host];
  if (!originals) return { ok: true, detail: 'not routed' };
  const file = modelsFile(home, host);
  if (file && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { providers?: Record<string, { baseUrl?: string }> };
      for (const entry of originals) {
        if (!parsed.providers?.[entry.provider]) continue;
        if (entry.original === null) delete parsed.providers[entry.provider].baseUrl;
        else parsed.providers[entry.provider].baseUrl = entry.original;
      }
      writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
    } catch { /* a broken models.json stays as-is rather than making it worse */ }
  }
  delete state.hosts[host];
  writeRoutingState(home, state);
  return { ok: true, detail: 'restored the original provider baseUrls' };
}

/** Stopping the proxy unroutes every host first: a routed agent against a dead proxy cannot reach a model. */
export function unrouteAll(home: string): string[] {
  const done: string[] = [];
  const state = readRoutingState(home);
  if (state.ymlInstances && unrouteHost(home, 'omp').ok) done.push('omp');
  for (const host of routedHosts(home)) if (unrouteHost(home, host as 'omp' | 'pi').ok) done.push(host);
  return done;
}

