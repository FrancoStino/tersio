// gateway.ts — on-disk capture store for the gateway: config, per-session turn JSONL, and the session index.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { tersioHome } from './utils.ts';

export const GATEWAY_PORT_DEFAULT = 3428;

export function gatewayConfigPath(): string {
  return path.join(tersioHome(), 'gateway.json');
}

export function gatewayTurnsDir(): string {
  return path.join(tersioHome(), 'gateway', 'turns');
}

export function gatewaySessionsFile(): string {
  return path.join(tersioHome(), 'gateway', 'sessions.jsonl');
}

export interface GatewayProviderConfig {
  host: 'pi' | 'opencode';
  provider: string;
  /** The upstream base URL the host used before wiring; unwire restores it. */
  url: string;
  /** Set when wiring added pi's session-affinity compat flag, so unwire removes exactly what it added. */
  compatAdded?: boolean;
}

export interface GatewayConfig { port: number; record: boolean; providers: Record<string, GatewayProviderConfig> }

/** Missing or corrupt config reads as the defaults, so a typo never wedges the server. */
export function readGatewayConfig(): GatewayConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(gatewayConfigPath(), 'utf8')) as Partial<GatewayConfig>;
    const providers: Record<string, GatewayProviderConfig> = {};
    for (const [key, value] of Object.entries(raw.providers ?? {})) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const v = value as Partial<GatewayProviderConfig>;
      if ((v.host === 'pi' || v.host === 'opencode') && typeof v.provider === 'string' && typeof v.url === 'string') {
        providers[key] = { host: v.host, provider: v.provider, url: v.url, ...(v.compatAdded === true ? { compatAdded: true } : {}) };
      }
    }
    return {
      port: typeof raw.port === 'number' && Number.isFinite(raw.port) && raw.port > 0 ? raw.port : GATEWAY_PORT_DEFAULT,
      record: raw.record === true,
      providers,
    };
  } catch {
    return { port: GATEWAY_PORT_DEFAULT, record: false, providers: {} };
  }
}

export function writeGatewayConfig(cfg: GatewayConfig): void {
  const file = gatewayConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
}

export function gatewayRouteKey(host: 'pi' | 'opencode', provider: string): string {
  return `${host === 'pi' ? 'pi' : 'oc'}--${provider}`;
}

export function gatewayIdentity(host: string, session: string): string {
  return createHash('sha256').update(`${host}\n${session}`).digest('hex').slice(0, 16);
}

/** The opening user text of a captured request body, for a session title; '' when the shape is unknown. */
export function firstUserTextOf(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null) return '';
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== 'user') continue;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .map((part) => (typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
      .trim();
  }
  return '';
}

export interface GatewayTurn {
  t: number;
  model: string;
  status: 'completed' | 'error';
  code?: number;
  in: string;
  out: string;
  tools: string[];
  ttftMs?: number;
  durMs?: number;
  cut?: boolean;
}

const TURN_CAP_BYTES = 64 * 1024;

/** Trim a payload to the cap; a torn multibyte tail decodes with replacement chars, which is fine for a log. */
function capPayload(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= TURN_CAP_BYTES) return text;
  return Buffer.from(text, 'utf8').subarray(0, TURN_CAP_BYTES).toString('utf8');
}

function bucketOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function appendGatewayTurn(cfg: GatewayConfig, host: string, session: string, turn: GatewayTurn): void {
  if (!cfg.record) return;
  const cut = Buffer.byteLength(turn.in, 'utf8') > TURN_CAP_BYTES || Buffer.byteLength(turn.out, 'utf8') > TURN_CAP_BYTES;
  const stored: GatewayTurn = { ...turn, in: capPayload(turn.in), out: capPayload(turn.out), ...(cut ? { cut: true } : {}) };
  const dir = path.join(gatewayTurnsDir(), bucketOf(turn.t));
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${gatewayIdentity(host, session)}.jsonl`), JSON.stringify(stored) + '\n', 'utf8');

  const sessions = readGatewaySessionIndex();
  const existing = sessions.find((e) => e.host === host && e.session === session);
  if (existing) {
    existing.first = Math.min(existing.first, turn.t);
    existing.last = Math.max(existing.last, turn.t);
  } else {
    // The title comes from the session's first turn, so only a fresh entry carries one.
    const title = firstUserTextOf(turn.in).replace(/\s+/g, ' ').slice(0, 80);
    sessions.push({ host, session, first: turn.t, last: turn.t, ...(title ? { title } : {}) });
  }
  fs.mkdirSync(path.dirname(gatewaySessionsFile()), { recursive: true });
  fs.writeFileSync(gatewaySessionsFile(), sessions.map((e) => JSON.stringify(e) + '\n').join(''), 'utf8');
}

/** The newest `limit` turns across the last 8 date buckets, oldest first; a torn trailing line is skipped. */
export function readGatewayTurns(host: string, session: string, limit = 128): GatewayTurn[] {
  const file = `${gatewayIdentity(host, session)}.jsonl`;
  const turns: GatewayTurn[] = [];
  for (let i = 0; i < 8; i += 1) {
    const bucket = bucketOf(Date.now() - i * 86_400_000);
    let text: string;
    try {
      text = fs.readFileSync(path.join(gatewayTurnsDir(), bucket, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as GatewayTurn;
        if (typeof parsed.t === 'number' && typeof parsed.in === 'string') turns.push(parsed);
      } catch { /* torn trailing line */ }
    }
  }
  const sorted = turns.toSorted((a, b) => a.t - b.t);
  return sorted.slice(Math.max(0, sorted.length - limit));
}

export interface GatewaySessionIndexEntry { host: string; session: string; first: number; last: number; title?: string }

export function readGatewaySessionIndex(): GatewaySessionIndexEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(gatewaySessionsFile(), 'utf8');
  } catch {
    return [];
  }
  const entries: GatewaySessionIndexEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<GatewaySessionIndexEntry>;
      if (typeof e.host === 'string' && typeof e.session === 'string' && typeof e.first === 'number' && typeof e.last === 'number') {
        entries.push({ host: e.host, session: e.session, first: e.first, last: e.last, title: e.title });
      }
    } catch { /* skip corrupt lines */ }
  }
  return entries;
}

export const GATEWAY_RETENTION_DAYS = 7;
export const GATEWAY_STORE_MAX_BYTES = 256 * 1024 * 1024;

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return total;
}

/** Drops whole date buckets: first past retention, then oldest-mtime until the store fits the cap. */
export function pruneGatewayStore(now: number = Date.now()): { removed: number } {
  let removed = 0;
  const turnsDir = gatewayTurnsDir();
  let buckets: string[];
  try {
    buckets = fs.readdirSync(turnsDir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).toSorted();
  } catch {
    return { removed: 0 };
  }
  const cutoff = bucketOf(now - GATEWAY_RETENTION_DAYS * 86_400_000);
  for (const bucket of buckets) {
    if (bucket >= cutoff) continue;
    fs.rmSync(path.join(turnsDir, bucket), { recursive: true, force: true });
    removed += 1;
  }
  const alive = (): Array<{ name: string; mtime: number; bytes: number }> => {
    const list: Array<{ name: string; mtime: number; bytes: number }> = [];
    for (const name of fs.readdirSync(turnsDir)) {
      const dir = path.join(turnsDir, name);
      try {
        list.push({ name, mtime: fs.statSync(dir).mtimeMs, bytes: dirBytes(dir) });
      } catch { /* vanished mid-prune */ }
    }
    return list;
  };
  for (const bucket of alive()) {
    const total = alive().reduce((sum, b) => sum + b.bytes, 0);
    if (total <= GATEWAY_STORE_MAX_BYTES) break;
    fs.rmSync(path.join(turnsDir, bucket.name), { recursive: true, force: true });
    removed += 1;
  }
  return { removed };
}
