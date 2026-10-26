// gateway.ts — the capture gateway CLI: wire/unwire/status, config flags, and the forwarding server.
import { createHash } from 'node:crypto';
import http from 'node:http';

import {
  appendGatewayTurn,
  firstUserText,
  gatewayRouteKey,
  pruneGatewayStore,
  readGatewayConfig,
  readGatewayTurns,
  writeGatewayConfig,
  type GatewayConfig,
  type GatewayTurn,
} from '../extensions/shared/gateway.ts';
import { priceFor } from '../extensions/shared/pricing.ts';
import { insertGatewayRow, usageDbPath, type GatewayStoreRow } from '../extensions/shared/usage-store.ts';
import { isRecord } from '../extensions/shared/utils.ts';
import { WIRED_HOST_IDS, printGatewayWiring, unwireGatewayHost, wireGatewayHost } from './gateway-wire.ts';
import type { WiredHost } from './gateway-wire.ts';

function flagOf(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i !== -1) return args[i + 1];
  const prefix = `${name}=`;
  const paired = args.find((a) => a.startsWith(prefix));
  return paired === undefined ? undefined : paired.slice(prefix.length);
}

function parseWiredHost(raw: string | undefined): WiredHost | null {
  return WIRED_HOST_IDS.find((id) => id === raw) ?? null;
}

async function runWireSubcommand(sub: string, rest: string[]): Promise<void> {
  const host = parseWiredHost(flagOf(rest, '--host'));
  const provider = flagOf(rest, '--provider');
  if (sub === 'status') {
    printGatewayWiring();
    const cfg = readGatewayConfig();
    let ok = false;
    try {
      const answer = await fetch(`http://127.0.0.1:${cfg.port}/gw/health`, { signal: AbortSignal.timeout(500) });
      ok = answer.ok;
    } catch { /* server not running */ }
    console.log(`server ${ok ? 'answering' : 'not answering'} on port ${cfg.port}`);
    return;
  }
  if (!host) {
    console.error(`[fail] gateway wire needs --host <${WIRED_HOST_IDS.join('|')}> and --provider <name>`);
    process.exitCode = 1;
    return;
  }
  if (sub === 'wire') {
    if (!provider) {
      console.error('[fail] gateway wire needs --provider <name>');
      process.exitCode = 1;
      return;
    }
    await wireGatewayHost(host, provider);
    return;
  }
  // Unwire without a provider releases every wired provider of that host.
  await unwireGatewayHost(host, provider);
}

export async function runGatewayCommand(args: string[]): Promise<void> {
  // The CLI switch passes the full argv; only what follows the `gateway` token belongs to us.
  const at = args.indexOf('gateway');
  const rest = at === -1 ? args : args.slice(at + 1);
  const sub = rest[0];
  if (sub === 'wire' || sub === 'unwire' || sub === 'status') {
    await runWireSubcommand(sub, rest.slice(1));
    return;
  }

  const record = flagOf(rest, '--record');
  if (record !== undefined) {
    const cfg = readGatewayConfig();
    cfg.record = record === 'on';
    writeGatewayConfig(cfg);
    console.log(`[ok] Gateway recording ${cfg.record ? 'on' : 'off'}`);
    return;
  }
  const portFlag = flagOf(rest, '--port');
  if (portFlag !== undefined) {
    const cfg = readGatewayConfig();
    const port = Number.parseInt(portFlag, 10);
    if (!Number.isFinite(port) || port <= 0) {
      console.error('[fail] Invalid --port');
      process.exitCode = 1;
      return;
    }
    const changed = port !== cfg.port;
    cfg.port = port;
    writeGatewayConfig(cfg);
    console.log(`[ok] Gateway port set to ${port}`);
    if (changed && Object.keys(cfg.providers).length > 0) {
      console.log('Wired providers point at the old port; run `tersio gateway wire` again to rewire them.');
    }
    return;
  }
  await serveGateway();
}

/** One server for the CLI and the tests: the tests pass an ephemeral port and close it themselves. */
export async function startGatewayServer(port?: number): Promise<http.Server> {
  pruneGatewayStore();
  const server = http.createServer((req, res) => {
    void handleGatewayRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end('gateway error');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port ?? readGatewayConfig().port, '127.0.0.1', () => resolve());
  });
  return server;
}

async function serveGateway(): Promise<void> {
  const cfg = readGatewayConfig();
  const server = await startGatewayServer(cfg.port);
  // Prune while serving, so a long-lived gateway honours retention rather than only its start.
  const pruner = setInterval(() => pruneGatewayStore(), 3_600_000);
  pruner.unref();
  try { process.title = 'tersio gateway'; } catch { /* non-POSIX shells keep node */ }
  console.log(`[ok] Gateway live → http://127.0.0.1:${cfg.port} (Ctrl-C to stop)`);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      clearInterval(pruner);
      server.close(() => resolve());
      server.closeIdleConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const SESSION_HEADERS = [
  'x-opencode-session',
  'x-session-affinity',
  'x-session-id',
  'x-claude-code-session-id',
  'x-conversation-id',
] as const;

function sessionIdOf(req: http.IncomingMessage, parsed: Record<string, unknown> | null): string {
  for (const header of SESSION_HEADERS) {
    const value = req.headers[header];
    if (typeof value === 'string' && value.trim() !== '') return value.slice(0, 128);
  }
  if (typeof parsed?.prompt_cache_key === 'string' && parsed.prompt_cache_key.trim() !== '') {
    return parsed.prompt_cache_key.slice(0, 128);
  }
  const text = firstUserText(parsed);
  const digest = text === '' ? '' : createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `gw-${digest || 'nouser'}`;
}

interface Captured {
  i: number;
  o: number;
  cr: number;
  cw: number;
  tools: string[];
  out: string;
  finished: boolean;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Marks an OpenAI `data: [DONE]` line, which is not JSON but still ends the stream. */
const STREAM_DONE = Symbol('stream-done');

function sseEvents(text: string, streamed: boolean): unknown[] {
  if (!streamed) return [text];
  const events: unknown[] = [];
  let done = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'data: [DONE]') {
      done = true;
      continue;
    }
    if (!trimmed.startsWith('data:')) continue;
    try {
      events.push(JSON.parse(trimmed.slice(5).trim()));
    } catch { /* skip partial or non-JSON data lines */ }
  }
  if (done) events.push(STREAM_DONE);
  return events;
}

function parseAnthropicReply(text: string, streamed: boolean): Captured {
  const captured: Captured = { i: 0, o: 0, cr: 0, cw: 0, tools: [], out: '', finished: false };
  for (const event of sseEvents(text, streamed)) {
    if (event === STREAM_DONE) {
      captured.finished = true;
      continue;
    }
    if (!isRecord(event)) continue;
    const message = isRecord(event.message) ? event.message : null;
    const usage = isRecord(event.usage) ? event.usage : message !== null && isRecord(message.usage) ? message.usage : null;
    if (usage) {
      // A delta repeats cumulative counts, so each field keeps the highest seen instead of summing.
      captured.i = Math.max(captured.i, num(usage.input_tokens));
      captured.o = Math.max(captured.o, num(usage.output_tokens));
      captured.cr = Math.max(captured.cr, num(usage.cache_read_input_tokens));
      captured.cw = Math.max(captured.cw, num(usage.cache_creation_input_tokens));
    }
    if (event.type === 'message_stop') captured.finished = true;
    if (event.type === 'content_block_start' && isRecord(event.content_block) && event.content_block.type === 'tool_use' && typeof event.content_block.name === 'string') {
      captured.tools.push(event.content_block.name);
    }
    if (event.type === 'content_block_delta' && isRecord(event.delta) && event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
      captured.out += event.delta.text;
    }
  }
  return captured;
}

function parseOpenAiReply(text: string, streamed: boolean): Captured {
  const captured: Captured = { i: 0, o: 0, cr: 0, cw: 0, tools: [], out: '', finished: false };
  for (const event of sseEvents(text, streamed)) {
    if (event === STREAM_DONE) {
      captured.finished = true;
      continue;
    }
    if (!isRecord(event)) continue;
    if (isRecord(event.usage)) {
      const usage = event.usage;
      captured.i = Math.max(captured.i, num(usage.prompt_tokens));
      captured.o = Math.max(captured.o, num(usage.completion_tokens));
      captured.cr = Math.max(captured.cr, num(isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details.cached_tokens : 0));
      captured.cw = Math.max(captured.cw, num(usage.cache_write_tokens));
      // OpenAI puts usage on the final chunk only, so its arrival marks a finished stream.
      captured.finished = true;
    }
    const choice = Array.isArray(event.choices) && isRecord(event.choices[0]) ? event.choices[0] : null;
    if (!choice) continue;
    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : null;
    if (!delta) continue;
    if (typeof delta.content === 'string') captured.out += delta.content;
    const calls = delta.tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        const name = isRecord(call) && isRecord(call.function) && typeof call.function.name === 'string' ? call.function.name : null;
        if (name && !captured.tools.includes(name)) captured.tools.push(name);
      }
    }
    if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') captured.finished = true;
  }
  return captured;
}

// One file row per session, so the cumulative turn count doubles as its size.
const turnCounts = new Map<string, number>();

function storeRow(row: GatewayStoreRow, db: string, fileKey: string): void {
  try {
    insertGatewayRow(db, fileKey, row);
  } catch {
    try {
      insertGatewayRow(db, fileKey, row);
    } catch { /* never crash the server on a store error */ }
  }
}

function costUsd(captured: Captured, model: string): number | undefined {
  try {
    const price = priceFor(model).price;
    return (captured.i * price.input + captured.o * price.output + captured.cr * price.cacheRead + captured.cw * price.cacheWrite) / 1e6;
  } catch {
    return undefined;
  }
}

async function handleGatewayRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? '/';
  const queryAt = url.indexOf('?');
  const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
  const query = queryAt === -1 ? '' : url.slice(queryAt);
  if (req.method === 'GET' && pathname === '/gw/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  // Re-read per request: a `--record on` flip in another process takes effect without a restart.
  const cfg = readGatewayConfig();
  const match = /^\/gw\/([A-Za-z0-9_-]+)(\/.*)$/.exec(pathname);
  if (req.method !== 'POST' || !match || !(match[1] in cfg.providers)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const [, key, suffix] = match;
  const provider = cfg.providers[key];
  let forwardPath = suffix;
  if (provider.url.endsWith('/v1') && forwardPath.startsWith('/v1')) forwardPath = forwardPath.slice(3);
  const target = provider.url + forwardPath + query;

  const rawBody = await readBody(req);
  let parsed: Record<string, unknown> | null = null;
  try {
    const body = JSON.parse(rawBody);
    if (isRecord(body)) parsed = body;
  } catch { /* forward non-JSON bodies untouched */ }

  // OpenAI streams omit usage unless the request asks for it.
  if (suffix === '/v1/chat/completions' && parsed && parsed.stream === true && !parsed.stream_options) {
    parsed.stream_options = { include_usage: true };
  }
  const outBody = parsed ? JSON.stringify(parsed) : rawBody;

  const capture = suffix === '/v1/messages' || suffix === '/v1/chat/completions';
  const openaiProtocol = suffix === '/v1/chat/completions';

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name === 'host' || name === 'content-length') continue;
    if (typeof value === 'string') headers[name] = value;
  }

  const start = Date.now();
  let upstream: Response;
  try {
    upstream = await fetch(target, { method: 'POST', headers, body: outBody });
  } catch {
    if (capture) {
      recordCapture(cfg, {
        host: provider.host, provider: provider.provider, parsed: null, rawBody,
        status: 'error', code: undefined, ttftMs: undefined, durMs: undefined,
        session: sessionIdOf(req, parsed), t: start, captured: null,
      });
    }
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('gateway upstream failed');
    return;
  }

  const streamed = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
  let acc = '';
  let ttftMs: number | undefined;
  const decoder = new TextDecoder();
  const reader = upstream.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      const text = decoder.decode(value, { stream: true });
      if (!capture) continue;
      if (ttftMs === undefined && (!streamed || text.includes('data:'))) ttftMs = Date.now() - start;
      acc += text;
    }
  }
  res.end();
  if (!capture) return;

  const captured = openaiProtocol ? parseOpenAiReply(acc, streamed) : parseAnthropicReply(acc, streamed);
  // A whole-body reply carries no terminator, so a 2xx answer is finished by definition.
  if (!streamed && upstream.status >= 200 && upstream.status < 300) captured.finished = true;
  const status = upstream.status >= 200 && upstream.status < 300 && captured.finished ? 'completed' : 'error';
  recordCapture(cfg, {
    host: provider.host,
    provider: provider.provider,
    parsed,
    rawBody,
    status,
    code: upstream.status,
    ttftMs,
    durMs: Date.now() - start,
    session: sessionIdOf(req, parsed),
    t: start,
    captured,
  });
}

interface RecordedTurn {
  host: string;
  provider: string;
  parsed: Record<string, unknown> | null;
  rawBody: string;
  status: 'completed' | 'error';
  code: number | undefined;
  ttftMs: number | undefined;
  durMs: number | undefined;
  session: string;
  t: number;
  captured: Captured | null;
}

function recordCapture(cfg: GatewayConfig, turn: RecordedTurn): void {
  const { captured } = turn;
  const model = typeof turn.parsed?.model === 'string' && turn.parsed.model !== '' ? turn.parsed.model : 'unknown';
  const fileKey = `gateway://${turn.host}/${turn.session}`;
  try {
    if (captured) {
      const count = turnCounts.get(fileKey) ?? readGatewayTurns(turn.host, turn.session, 1_000_000).length;
      turnCounts.set(fileKey, count + 1);
      storeRow({
        t: turn.t,
        model,
        i: captured.i,
        o: captured.o,
        d: turn.durMs,
        tf: turn.ttftMs,
        cr: captured.cr,
        cw: captured.cw,
        usd: costUsd(captured, model),
        st: turn.status,
        code: turn.code,
        tools: captured.tools,
        host: turn.host,
        agent: 'main',
        id: String(turn.t),
        gateway: turn.provider,
        mtime: turn.t,
        size: count + 1,
      }, usageDbPath(), fileKey);
    }
    if (cfg.record) {
      const recorded: GatewayTurn = {
        t: turn.t,
        model,
        status: turn.status,
        ...(turn.code !== undefined ? { code: turn.code } : {}),
        in: turn.rawBody,
        out: captured?.out ?? '',
        tools: captured?.tools ?? [],
        ...(turn.ttftMs !== undefined ? { ttftMs: turn.ttftMs } : {}),
        ...(turn.durMs !== undefined ? { durMs: turn.durMs } : {}),
      };
      appendGatewayTurn(cfg, turn.host, turn.session, recorded);
    }
  } catch { /* capture must never break the proxy path */ }
}

export { gatewayRouteKey };
