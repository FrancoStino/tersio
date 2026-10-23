// The MCP server: stdio for clients that spawn a command, local HTTP for clients that take a URL and a header.
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readActivity } from './activity.ts';
import { COMBO_DEFAULTS, PACKAGE_VERSION } from './common.ts';
import { formatCurrency, readStoredCurrency } from './currency.ts';
import { runDoctor } from './doctor.ts';
import { agentStats } from './dashboard.ts';
import { applyComboPreset, formatProfile, storedProfile, writePluginSettings } from './profile.ts';
import { isRangeKey, RANGES } from '../extensions/shared/agent-stats.ts';
import { patchState, readState } from '../extensions/shared/state.ts';
import type { RangeKey } from '../extensions/shared/agent-stats.ts';

/** The spec version this server speaks; a client naming another is answered with this one. */
const PROTOCOL_VERSION = '2025-06-18';

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/** Compact counts for a model reading numbers: `2.9M`, not `2945123`. */
function shortCount(n: number): string {
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

interface StatsToolArgs {
  range?: unknown;
}

interface ActivityToolArgs {
  limit?: unknown;
}

interface ModesToolArgs {
  combo?: unknown;
}

/**
 * The only stdout a client ever sees is the protocol, so a tool that prints (doctor's report,
 * the settings save line) is captured and its text becomes the tool's answer.
 */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const value = await fn();
    return { value, text: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

function statsText(range: RangeKey): string {
  const stats = agentStats(range);
  if (!stats.available) return `No agent data for ${range} yet. Stats appear once sessions run with Tersio installed.`;
  const currency = readStoredCurrency();
  const o = stats.overall;
  const lines = [
    `Tersio usage, last ${range}: ${o.requests.toLocaleString('en-US')} requests (${o.failed.toLocaleString('en-US')} failed, ${pct(o.errorRate)})`,
    `Tokens: ${shortCount(o.total)} total — ${shortCount(o.input)} in, ${shortCount(o.output)} out, ${shortCount(o.cacheRead)} cache read, ${shortCount(o.cacheWrite)} cache write`,
    `Cache rate: ${pct(o.cacheRate)} · API-equivalent cost: ${formatCurrency(o.costUsd, currency)} (${currency})`,
  ];
  for (const model of stats.topModels.slice(0, 3)) {
    lines.push(`Model ${model.key}: ${shortCount(model.total)} tokens, ${formatCurrency(model.costUsd, currency)}`);
  }
  for (const provider of stats.byProvider.slice(0, 3)) {
    lines.push(`Provider ${provider.provider}: ${shortCount(provider.total)} tokens, ${formatCurrency(provider.costUsd, currency)}`);
  }
  return lines.join('\n');
}

function activityText(limit: number): string {
  const entries = readActivity(limit);
  if (entries.length === 0) return 'No activity recorded yet. The log fills as Tersio changes modes, installs, or updates.';
  return entries.map((e) => `${new Date(e.at).toISOString()} [${e.kind}] ${e.title}${e.detail ? ` — ${e.detail}` : ''}`).join('\n');
}

async function doctorText(): Promise<string> {
  const { value, text } = await captureLog(() => runDoctor(false));
  return `${text}\n${value.ok} ok, ${value.warn} warnings, ${value.missing} missing.`.trim();
}

async function modesText(combo: string | null): Promise<string> {
  const profile = await storedProfile();
  if (combo === null) return `Current session defaults: ${formatProfile(profile)}. Pass combo (${[...COMBO_DEFAULTS].join(', ')}) to switch the preset.`;
  const next = applyComboPreset(profile, combo);
  const { text } = await captureLog(() => writePluginSettings(next, { quiet: true }));
  return [text, `Combo preset set to ${combo}: ${formatProfile(next)}`].filter(Boolean).join('\n');
}

/** JSON Schema per tool, the shape every MCP client knows how to render. */
const TOOLS = [
  {
    name: 'tersio_stats',
    description: 'Agent usage for a time range: requests, errors, tokens, cache rate, cost, and the top models and providers.',
    inputSchema: {
      type: 'object',
      properties: { range: { type: 'string', enum: [...RANGES], description: `Time range, default 24h. One of ${RANGES.join(', ')}.` } },
    },
  },
  {
    name: 'tersio_activity',
    description: 'What Tersio changed on this machine, newest first: mode switches, installs, updates, removals, doctor runs.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Entries to return, 1-200, default 20.' } },
    },
  },
  {
    name: 'tersio_doctor',
    description: 'Health check of the Tersio installation: extensions, registrations, RTK, rules, CLI.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tersio_modes',
    description: 'Read the session-start mode defaults, or set the Combo preset (which sets Caveman, RTK, and Ponytail together).',
    inputSchema: {
      type: 'object',
      properties: { combo: { type: 'string', enum: [...COMBO_DEFAULTS], description: `Combo preset to apply: ${[...COMBO_DEFAULTS].join(', ')}. Omit to only read.` } },
    },
  },
] as const;

async function callTool(params: unknown): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof call.name === 'string' ? call.name : null;
  const args = (call.arguments ?? {}) as StatsToolArgs & ActivityToolArgs & ModesToolArgs;
  if (name === 'tersio_stats') {
    if (args.range !== undefined && !isRangeKey(args.range)) throw new RpcError(-32602, `range must be one of ${RANGES.join(', ')}`);
    return { content: [{ type: 'text', text: statsText(isRangeKey(args.range) ? args.range : '24h') }] };
  }
  if (name === 'tersio_activity') {
    const limit = args.limit === undefined ? 20 : Math.min(200, Math.max(1, Math.round(Number(args.limit))));
    if (!Number.isFinite(limit)) throw new RpcError(-32602, 'limit must be a number');
    return { content: [{ type: 'text', text: activityText(limit) }] };
  }
  if (name === 'tersio_doctor') {
    try {
      return { content: [{ type: 'text', text: await doctorText() }] };
    } catch (e) {
      // A doctor failure is a finding, not a protocol error; the client sees the tool failed.
      return { content: [{ type: 'text', text: `Doctor run failed: ${(e as Error).message}` }], isError: true };
    }
  }
  if (name === 'tersio_modes') {
    if (args.combo !== undefined && !(typeof args.combo === 'string' && COMBO_DEFAULTS.has(args.combo))) {
      throw new RpcError(-32602, `combo must be one of ${[...COMBO_DEFAULTS].join(', ')}`);
    }
    return { content: [{ type: 'text', text: await modesText(typeof args.combo === 'string' ? args.combo : null) }] };
  }
  throw new RpcError(-32602, `unknown tool: ${name}`);
}

type WireMessage = { jsonrpc?: string; id?: unknown; method?: unknown; params?: unknown };

/** Handles one wire message; exposed so a test can drive the protocol without a process.
 *
 * Async because tools/call awaits the tool.
 */
export async function handleMessage(message: WireMessage, send: (msg: unknown) => void): Promise<void> {
  const { id, method, params } = message;
  // A notification carries no id and wants no answer.
  const reply = id !== undefined && id !== null;
  if (typeof method !== 'string' || method.startsWith('notifications/')) return;
  try {
    let result: unknown;
    if (method === 'initialize') {
      result = {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'tersio', version: PACKAGE_VERSION },
        instructions: 'Tersio watches this machine\'s agent sessions. Ask for usage with tersio_stats, recent changes with tersio_activity, installation health with tersio_doctor, and read or set session modes with tersio_modes.',
      };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'tools/call') result = await callTool(params);
    else throw new RpcError(-32601, `unknown method: ${method}`);
    if (reply) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    if (reply) send({ jsonrpc: '2.0', id, error: { code, message: (e as Error).message } });
  }
}

/** Serves one client over stdio and exits when the client disconnects. */
export async function runMcpServer(): Promise<void> {
  const send = (msg: unknown): void => { process.stdout.write(`${JSON.stringify(msg)}\n`); };
  const lines = createInterface({ input: process.stdin });
  let queue: Promise<void> = Promise.resolve();
  lines.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;
    let message: WireMessage | null = null;
    try {
      message = JSON.parse(text) as WireMessage;
    } catch { /* a malformed line is dropped; the client's own timeout surfaces it */ }
    // A client may call tools in parallel, and the printing tools patch the console, so one
    // handler at a time; an overlapping patch could leak a print onto the wire.
    if (message) queue = queue.then(() => handleMessage(message, send));
  });
  // The server never outlives its client: a closed stream ends the process.
  lines.on('close', () => process.exit(0));
  const { promise } = Promise.withResolvers<void>();
  await promise;
}

/** The token an HTTP client presents as a Bearer header; one random secret, kept in state, so the URL alone is not access. */
export function mcpHttpToken(): string {
  const existing = readState().mcpToken;
  if (typeof existing === 'string' && existing !== '') return existing;
  const token = randomBytes(24).toString('hex');
  patchState({ mcpToken: token });
  return token;
}

/**
 * The streamable-HTTP form: one POST endpoint that answers each JSON-RPC message with JSON.
 * Stateless on purpose — every call carries everything, so no session has to survive a restart.
 */
export function startMcpHttpServer(port: number): Promise<{ server: Server; url: string; token: string }> {
  const token = mcpHttpToken();
  const server = createServer((req, res) => {
    // Localhost only, and the Bearer token gates it: the URL on its own reaches nothing.
    if (req.url !== '/mcp') { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' }).end('POST only'); return; }
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'Content-Type': 'text/plain' }).end('unauthorized'); return; }
    const body: Buffer[] = [];
    req.on('data', (chunk: Buffer) => body.push(chunk));
    req.on('end', () => {
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(body).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('body must be JSON');
        return;
      }
      const messages = Array.isArray(payload) ? payload : [payload];
      const answers: unknown[] = [];
      const send = (msg: unknown): void => { answers.push(msg); };
      // The printing tools patch the console, so calls run one at a time even inside a batch.
      let queue: Promise<void> = Promise.resolve();
      for (const message of messages) {
        if (message === null || typeof message !== 'object') continue;
        queue = queue.then(() => handleMessage(message as WireMessage, send));
      }
      void queue.then(() => {
        // A POST of only notifications wants no answer: the spec's 202, so a client never parses an empty 200 as JSON.
        if (answers.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }
        const out = Array.isArray(payload) ? answers : answers[0];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
  });
  const { promise, resolve } = Promise.withResolvers<{ server: Server; url: string; token: string }>();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const bound = typeof address === 'object' && address !== null ? address.port : port;
    resolve({ server, url: `http://127.0.0.1:${bound}/mcp`, token });
  });
  return promise;
}

/** The `tersio mcp --http` entry: serve until stopped, with the URL and header printed once. */
export async function runMcpHttpServer(port: number): Promise<void> {
  const { url, token } = await startMcpHttpServer(port);
  console.log(`[ok] Tersio MCP (HTTP) -> ${url}`);
  console.log(`     Authorization: Bearer ${token}`);
  const { promise } = Promise.withResolvers<void>();
  await promise;
}
