// The capture gateway: forwarding, usage rows, turn recording, retention, and native-file dedupe.
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { startGatewayServer } from '../../cli/gateway.ts';
import { gatewayProviderUrl, unwireGatewayHost, wireGatewayHost, printGatewayWiring, WIRED_HOST_IDS } from '../../cli/gateway-wire.ts';
import { gatewayTurnsDir, pruneGatewayStore, readGatewayConfig, readGatewaySessionIndex, readGatewayTurns, writeGatewayConfig } from '../../extensions/shared/gateway.ts';
import { syncUsageDb, usageDbPath } from '../../extensions/shared/usage-store.ts';
import { sqliteRead } from '../../extensions/shared/sqlite.ts';
import type { GatewayProviderConfig } from '../../extensions/shared/gateway.ts';

const REAL_HOME = process.env.HOME;
const seen: Array<{ url: string; body: string }> = [];
let home = '';
let upstream: http.Server | null = null;
let gateway: http.Server | null = null;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tersio-gw-'));
  process.env.HOME = home;
  process.env.TERSIO_HOME = path.join(home, '.tersio');
  seen.length = 0;
});

afterEach(() => {
  gateway?.close();
  upstream?.close();
  gateway = null;
  upstream = null;
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
  delete process.env.TERSIO_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/** One upstream for both protocols: an anthropic SSE reply, or an OpenAI chat stream with usage on its last chunk. */
function startUpstream(): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if ((req.url ?? '').includes('/chat/completions')) {
        res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":7}}}\n\n');
      res.write('event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"read"}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n');
      res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n');
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  server.listen(0, '127.0.0.1', () => {
    upstream = server;
    const address = server.address();
    resolve(typeof address === 'object' && address ? address.port : 0);
  });
  return promise;
}

async function startGateway(providers: Record<string, GatewayProviderConfig>, record = false): Promise<string> {
  // Port 0: the store's own port is irrelevant here, the server binds an ephemeral one.
  writeGatewayConfig({ port: 0, record, providers });
  const server = await startGatewayServer(0);
  gateway = server;
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

function gatewayRows(): string[][] {
  try {
    return sqliteRead(usageDbPath(),
      `SELECT m.h, m.p, m.i, m.o, m.cr, m.cw, m.model, m.st, m.tools FROM messages m ` +
      `JOIN files f ON f.id = m.file_id WHERE f.path LIKE 'gateway://%';`)
      .split('\n').filter((line) => line.trim()).map((line) => line.split('\t'));
  } catch {
    return [];
  }
}

test('an anthropic reply is proxied untouched and recorded as one usage row', async () => {
  const upstreamPort = await startUpstream();
  const base = await startGateway({ 'pi--magpie': { host: 'pi', provider: 'magpie', url: `http://127.0.0.1:${upstreamPort}` } });
  const body = JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] });
  const answer = await fetch(`${base}/gw/pi--magpie/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': 'S1' },
    body,
  });
  const text = await answer.text();
  expect(answer.status).toBe(200);
  // The client sees the upstream's own bytes, and its query string reached the upstream.
  expect(text).toContain('message_stop');
  expect(seen[0].url).toBe('/v1/messages?beta=true');

  const [row] = gatewayRows();
  expect(row.slice(0, 6)).toEqual(['pi', 'magpie', '100', '25', '40', '7']);
  expect(row[6]).toBe('claude-x');
  expect(row[7]).toBe('completed');
  expect(row[8]).toContain('read');
});

test('an OpenAI stream gets include_usage, and recording stores the turn and its title', async () => {
  const upstreamPort = await startUpstream();
  const base = await startGateway({ 'opencode--zen': { host: 'opencode', provider: 'zen', url: `http://127.0.0.1:${upstreamPort}/v1` } }, true);
  const body = JSON.stringify({ model: 'glm-4', stream: true, messages: [{ role: 'user', content: 'fix the login bug' }] });
  const answer = await fetch(`${base}/gw/opencode--zen/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': 'OC1' },
    body,
  });
  await answer.text();

  // The upstream already ends in /v1, so the forwarded path must not repeat it.
  expect(seen[0].url).toBe('/v1/chat/completions');
  expect(JSON.parse(seen[0].body).stream_options).toEqual({ include_usage: true });

  const [turn] = readGatewayTurns('opencode', 'OC1');
  expect(turn.out).toBe('hi');
  expect(turn.model).toBe('glm-4');
  expect(typeof turn.ttftMs).toBe('number');
  expect(readGatewaySessionIndex().find((entry) => entry.session === 'OC1')?.title).toBe('fix the login bug');
  const [row] = gatewayRows();
  expect(row[0]).toBe('opencode');
  expect(row[1]).toBe('zen');
  expect(row.slice(2, 5)).toEqual(['10', '5', '2']);
});

test('recording off keeps the usage row and writes no turns', async () => {
  const upstreamPort = await startUpstream();
  const base = await startGateway({ 'pi--magpie': { host: 'pi', provider: 'magpie', url: `http://127.0.0.1:${upstreamPort}` } });
  await fetch(`${base}/gw/pi--magpie/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': 'S2' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
  }).then((res) => res.text());

  expect(readGatewayTurns('pi', 'S2')).toEqual([]);
  expect(fs.existsSync(gatewayTurnsDir())).toBe(false);
});

test('the store drops a date bucket past retention', () => {
  const stale = path.join(gatewayTurnsDir(), '2020-01-01');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'deadbeef.jsonl'), '{}\n');
  expect(pruneGatewayStore().removed).toBeGreaterThan(0);
  expect(fs.existsSync(stale)).toBe(false);
});

/** A pi transcript row the parser counts: one assistant message with usage. */
function piTranscript(): string {
  return '{"timestamp":"2026-09-01T10:00:00.000Z","type":"message","id":"a","message":{"role":"assistant","model":"glm-4","usage":{"input":10,"output":1}}}\n';
}

test('a pi transcript for a captured session adds no rows of its own', async () => {
  const upstreamPort = await startUpstream();
  const base = await startGateway({ 'pi--magpie': { host: 'pi', provider: 'magpie', url: `http://127.0.0.1:${upstreamPort}` } }, true);
  await fetch(`${base}/gw/pi--magpie/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': 'GW1' },
    body: JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: 'hi' }] }),
  }).then((res) => res.text());

  const sessions = path.join(home, '.pi', 'agent', 'sessions', '--proj--');
  fs.mkdirSync(sessions, { recursive: true });
  // One file the gateway captured and one it did not, so a green result proves the sync really ran.
  const captured = path.join(sessions, '2026-09-01T10-00-00Z_GW1.jsonl');
  const native = path.join(sessions, '2026-09-01T10-00-00Z_NATIVE.jsonl');
  fs.writeFileSync(captured, piTranscript());
  fs.writeFileSync(native, piTranscript());
  expect(syncUsageDb()).toBe(true);

  const paths = sqliteRead(usageDbPath(), `SELECT path FROM files WHERE path LIKE '%sessions%';`)
    .split('\n').filter((line) => line.trim());
  expect(paths).toEqual([native]);
  const piRows = sqliteRead(usageDbPath(), `SELECT COUNT(*) FROM messages WHERE h = 'pi';`).split('\n')[0];
  // The one native row plus the one gateway row; the captured transcript doubled nothing.
  expect(piRows).toBe('2');
});

test('wiring rewrites the provider URL and unwiring restores the file', async () => {
  const modelsFile = path.join(home, '.pi', 'agent', 'models.json');
  fs.mkdirSync(path.dirname(modelsFile), { recursive: true });
  const original = {
    providers: { magpie: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:3425/v1', models: [] } },
  };
  fs.writeFileSync(modelsFile, `${JSON.stringify(original, null, 2)}\n`);

  await wireGatewayHost('pi', 'magpie');
  const cfg = readGatewayConfig();
  expect(cfg.providers['pi--magpie'].url).toBe('http://127.0.0.1:3425/v1');
  expect(gatewayProviderUrl('pi', 'magpie')).toBe(`http://127.0.0.1:${cfg.port}/gw/pi--magpie`);
  // pi only names its session when this flag is on, which is what groups the turns.
  const wired = JSON.parse(fs.readFileSync(modelsFile, 'utf8')) as { providers: { magpie: { compat?: { sendSessionAffinityHeaders?: boolean } } } };
  expect(wired.providers.magpie.compat?.sendSessionAffinityHeaders).toBe(true);

  await unwireGatewayHost('pi');
  expect(JSON.parse(fs.readFileSync(modelsFile, 'utf8'))).toEqual(original);
  expect(readGatewayConfig().providers).toEqual({});
});

test('status names the adapter hosts instead of hard-coding two of them', () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => { lines.push(parts.join(' ')); };
  try {
    printGatewayWiring();
  } finally {
    console.log = original;
  }
  const output = lines.join('\n');
  // Both the empty-state hint and the footer read the adapter table.
  expect(output).toContain(`--host <${WIRED_HOST_IDS.join('|')}>`);
  expect(output).toContain(`Adapter hosts: ${WIRED_HOST_IDS.join(', ')}`);
});

test('wiring an unknown provider names the ones the host has', async () => {
  const configFile = path.join(home, '.config', 'opencode', 'opencode.json');
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify({ provider: { zen: { options: { baseURL: 'https://opencode.ai/zen/v1' } } } }, null, 2)}\n`);
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...parts: unknown[]): void => { errors.push(parts.join(' ')); };
  const before = process.exitCode;
  try {
    await wireGatewayHost('opencode', 'nope');
  } finally {
    console.error = originalError;
    process.exitCode = before;
  }
  expect(errors.join('\n')).toContain('available: zen');
});
