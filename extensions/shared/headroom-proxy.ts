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
export async function ensureProxy(bin: string): Promise<{ port: number; owned: boolean; started: boolean }> {
  const existing = readProxyState();
  if (existing && (await proxyAnswers(existing.port))) return { port: existing.port, owned: true, started: false };
  if (await proxyAnswers(HEADROOM_PROXY_PORT)) return { port: HEADROOM_PROXY_PORT, owned: false, started: false };
  const child = spawn(bin, ['proxy'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  // A cold start loads the model set; wait past the first seconds before giving up.
  for (let tick = 0; tick < 60; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await proxyAnswers(HEADROOM_PROXY_PORT, 500)) {
      try {
        fs.mkdirSync(path.dirname(proxyStateFile()), { recursive: true });
        fs.writeFileSync(proxyStateFile(), JSON.stringify({ pid: child.pid ?? 0, port: HEADROOM_PROXY_PORT, startedAt: Date.now() }));
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