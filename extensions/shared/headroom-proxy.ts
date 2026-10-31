// Headroom's proxy as the fallback route: the tools `headroom wrap` cannot reach (pi, PiG today)
// still route through the same local proxy by pointing their base URL at it. One proxy serves
// every agent, so this module starts at most one and records what it owns.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { tersioHome } from './utils.ts';

const execFileP = promisify(execFile);

/** The agents Tersio installs that headroom has no wrap target for; they route through the shared proxy. */
export const PROXY_HOSTS: readonly string[] = ['pi', 'pig'];

/** The address the proxy serves; headroom's own default. */
export const HEADROOM_PROXY_PORT = 8787;

/** Where the owned-proxy record lives. Absent means Tersio started nothing. */
function proxyStateFile(): string {
  return path.join(tersioHome(), 'headroom-proxy.json');
}

export interface HeadroomProxyState {
  pid: number;
  port: number;
  startedAt: number;
  /** The OpenAI-shaped upstream this proxy forwards to, so a restart keeps the same route. */
  openaiTarget?: string;
}

/** The proxy Tersio started, when its process is still alive. */
export function readProxyState(): HeadroomProxyState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(proxyStateFile(), 'utf8')) as HeadroomProxyState;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    try {
      process.kill(parsed.pid, 0);
      return parsed;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** Whether anything answers on the proxy port; headroom started it itself, or an older session did. */
export async function proxyAnswers(port: number = HEADROOM_PROXY_PORT, budgetMs = 400): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(budgetMs) });
    await res.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/**
 * One proxy for every agent: reuse a live one, else start a detached one and record it.
 * Returns the port an agent should point at, and whether Tersio owns the process.
 */
export async function ensureProxy(bin: string, openaiTarget?: string): Promise<{ port: number; owned: boolean; started: boolean }> {
  const existing = readProxyState();
  if (existing && (await proxyAnswers(existing.port))) return { port: existing.port, owned: true, started: false };
  if (await proxyAnswers(HEADROOM_PROXY_PORT)) return { port: HEADROOM_PROXY_PORT, owned: false, started: false };
  // The recorded upstream wins: a proxy restarted for a routed agent must forward to the same place.
  const target = openaiTarget ?? existing?.openaiTarget;
  const child = spawn(bin, ['proxy'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: target ? { ...process.env, OPENAI_TARGET_API_URL: target } : process.env,
  });
  child.unref();
  // A cold start loads the model set; wait past the first seconds before giving up.
  for (let tick = 0; tick < 60; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await proxyAnswers(HEADROOM_PROXY_PORT, 500)) {
      try {
        fs.mkdirSync(path.dirname(proxyStateFile()), { recursive: true });
        fs.writeFileSync(proxyStateFile(), JSON.stringify({ pid: child.pid ?? 0, port: HEADROOM_PROXY_PORT, startedAt: Date.now(), openaiTarget: target }));
      } catch { /* the proxy still runs; only the record is missing */ }
      return { port: HEADROOM_PROXY_PORT, owned: true, started: true };
    }
    if (child.exitCode !== null) break;
  }
  throw new Error('the headroom proxy did not come up; run `headroom proxy` to see why');
}

/** Stop a proxy Tersio started. A proxy headroom or the user owns is never touched. */
export function stopOwnedProxy(): boolean {
  const state = readProxyState();
  if (!state) return false;
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch { /* already gone */ }
  try {
    fs.rmSync(proxyStateFile(), { force: true });
  } catch { /* best effort */ }
  return true;
}

/** The env lines an agent needs to route through the proxy, so the answer names the exact paste. */
export function proxyEnvLines(port: number = HEADROOM_PROXY_PORT): string[] {
  return [
    `ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`,
    `OPENAI_BASE_URL=http://127.0.0.1:${port}/v1`,
  ];
}

/** A headroom command's output, or an empty string: the caller decides what a failure means. */
async function headroomText(bin: string, args: string[], timeoutMs: number): Promise<string> {
  try {
    const run = await execFileP(bin, args, { timeout: timeoutMs });
    return String(run.stdout ?? '') + '\n' + String(run.stderr ?? '');
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return String(err.stdout ?? '') + '\n' + String(err.stderr ?? '');
  }
}

/**
 * The wrap targets headroom offers, read from its own help so a new upstream tool appears
 * without a Tersio release. Null when the help cannot be read; the caller keeps its static list.
 */
export async function discoverWrapTargets(bin: string, timeoutMs = 15_000): Promise<Array<{ name: string; label: string }> | null> {
  const text = await headroomText(bin, ['wrap', '--help'], timeoutMs);
  const targets: Array<{ name: string; label: string }> = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*headroom wrap ([a-z-]+)\s+#\s*(.+)$/);
    if (match) targets.push({ name: match[1], label: match[2].trim() });
  }
  return targets.length > 0 ? targets : null;
}

/** Where a routed agent's original provider addresses are kept, so an unwrap can put them back. */
function providerRoutesFile(): string {
  return path.join(tersioHome(), 'headroom-routes.json');
}

export interface ProviderRoute {
  /** The agent the config belongs to: the directory name under ~/.<agent>/agent. */
  agent: string;
  /** The models.json the provider lives in. */
  file: string;
  /** provider name -> the baseUrl it had before the proxy took the route. */
  original: Record<string, string>;
}

/** The recorded routes, so an unwrap restores exactly what the install changed. */
function readProviderRoutes(): ProviderRoute[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(providerRoutesFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed as ProviderRoute[] : [];
  } catch {
    return [];
  }
}

/**
 * Point the agent's loopback providers at the proxy and keep their originals for the unwrap.
 * Only fires when every loopback provider shares one origin, since one proxy forwards to one upstream;
 * with mixed origins the caller falls back to printing the addresses instead.
 * Returns the origin the proxy must forward to, or null when the config was left alone.
 */
export function routeLocalProvidersThroughProxy(agent: string, file: string, proxyPort: number): { upstream: string; providers: string[] } | null {
  let doc: { providers?: Record<string, { baseUrl?: string }> } = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { providers?: Record<string, { baseUrl?: string }> };
  } catch {
    return null;
  }
  const providers = doc.providers ?? {};
  const loopback = Object.entries(providers).filter(([, p]) => (p.baseUrl ?? '').startsWith('http://127.0.0.1') || (p.baseUrl ?? '').startsWith('http://localhost'));
  if (loopback.length === 0) return null;
  const origins = new Set(loopback.map(([, p]) => new URL(p.baseUrl ?? '').origin));
  if (origins.size !== 1) return null;
  const upstream = loopback[0][1].baseUrl ?? '';
  const record: ProviderRoute = { agent, file, original: {} };
  for (const [name, p] of loopback) {
    record.original[name] = p.baseUrl ?? '';
    p.baseUrl = `http://127.0.0.1:${proxyPort}/v1`;
  }
  try {
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch {
    return null;
  }
  const routes = readProviderRoutes().filter((r) => r.file !== file);
  routes.push(record);
  try {
    fs.mkdirSync(path.dirname(providerRoutesFile()), { recursive: true });
    fs.writeFileSync(providerRoutesFile(), JSON.stringify(routes, null, 2), 'utf8');
  } catch { /* the route is live; only the undo record is missing */ }
  return { upstream, providers: loopback.map(([name]) => name) };
}

/** Put every provider address the install changed back the way it was. */
export function restoreRoutedProviders(agent?: string): number {
  const routes = readProviderRoutes().filter((r) => agent === undefined || r.agent === agent);
  let restored = 0;
  for (const route of routes) {
    try {
      const doc = JSON.parse(fs.readFileSync(route.file, 'utf8')) as { providers?: Record<string, { baseUrl?: string }> };
      for (const [name, baseUrl] of Object.entries(route.original)) {
        if (doc.providers?.[name]) doc.providers[name].baseUrl = baseUrl;
      }
      fs.writeFileSync(route.file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      restored += 1;
    } catch { /* the config is gone; nothing to restore */ }
  }
  try {
    const left = readProviderRoutes().filter((r) => agent === undefined || !routes.some((done) => done.file === r.file));
    if (left.length === 0) fs.rmSync(providerRoutesFile(), { force: true });
    else fs.writeFileSync(providerRoutesFile(), JSON.stringify(left, null, 2), 'utf8');
  } catch { /* best effort */ }
  return restored;
}