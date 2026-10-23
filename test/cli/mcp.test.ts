import { describe, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleMessage, installMcpConfig, mcpHttpConfig, startMcpHttpServer } from '../../cli/mcp.ts';

// One collector stands in for the wire, so the tests assert what a client receives.
function collector(): { sent: unknown[]; send: (msg: unknown) => void } {
  const sent: unknown[] = [];
  return { sent, send: (msg: unknown) => { sent.push(msg); } };
}

const call = (id: number, method: string, params?: unknown): { jsonrpc: string; id: number; method: string; params?: unknown } => ({
  jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }),
});
describe('the MCP server protocol', () => {
  test('initialize answers with the server identity and the version the server speaks', async () => {
    const { sent, send } = collector();
    await handleMessage(call(1, 'initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 't', version: '0' } }), send);
    expect(sent).toHaveLength(1);
    // The collector holds raw wire objects; one cast names the answer's shape for the reads below.
    const answer = sent[0] as { result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } } };
    // The spec wants a version the server supports, not an echo of whatever the client asked.
    expect(answer.result.protocolVersion).toBe('2025-06-18');
    expect(answer.result.capabilities.tools).toEqual({});
    expect(answer.result.serverInfo.name).toBe('tersio');
  });


  test('tools/list names every tool a client can call', async () => {
    const { sent, send } = collector();
    await handleMessage(call(2, 'tools/list'), send);
    const answer = sent[0] as { result: { tools: Array<{ name: string }> } };
    expect(answer.result.tools.map((t) => t.name)).toEqual(['tersio_stats', 'tersio_activity', 'tersio_doctor', 'tersio_modes']);
  });

  test('a bad range and an unknown tool answer with invalid-params', async () => {
    const { sent, send } = collector();
    await handleMessage(call(3, 'tools/call', { name: 'tersio_stats', arguments: { range: 'bogus' } }), send);
    await handleMessage(call(4, 'tools/call', { name: 'nope', arguments: {} }), send);
    const rangeError = sent[0] as { error: { code: number; message: string } };
    const toolError = sent[1] as { error: { code: number; message: string } };
    expect(rangeError.error.code).toBe(-32602);
    expect(rangeError.error.message).toContain('range must be one of');
    expect(toolError.error.code).toBe(-32602);
    expect(toolError.error.message).toContain('unknown tool');
  });

  test('an unknown method answers with method-not-found, and ping answers empty', async () => {
    const { sent, send } = collector();
    await handleMessage(call(5, 'resources/list'), send);
    await handleMessage(call(6, 'ping'), send);
    const methodError = sent[0] as { error: { code: number } };
    const pong = sent[1] as { result: unknown };
    expect(methodError.error.code).toBe(-32601);
    expect(pong.result).toEqual({});
  });

  test('a notification and a malformed method draw no answer', async () => {
    const { sent, send } = collector();
    await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, send);
    await handleMessage({ jsonrpc: '2.0', id: 7, method: 42 }, send);
    expect(sent).toHaveLength(0);
  });
});

describe('the MCP modes tool', () => {
  const modes = async (args: Record<string, unknown>): Promise<{ text: string; error?: { message: string } }> => {
    const { sent, send } = collector();
    await handleMessage(call(11, 'tools/call', { name: 'tersio_modes', arguments: args }), send);
    const answer = sent[0] as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
    if (answer.error) return { text: '', error: answer.error };
    return { text: answer.result.content[0].text };
  };

  test('an unknown level answers with invalid-params naming the mode', async () => {
    const { error } = await modes({ caveman: 'bogus' });
    expect(error?.message).toContain('caveman must be one of');
  });

  test('a single mode overrides its piece of the preset and lands in settings', async () => {
    // Isolated homes, so the write never touches the real settings or the ponytail mirror.
    const home = await mkdtemp(path.join(tmpdir(), 'tersio-modes-'));
    const previousTersio = process.env.TERSIO_HOME;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.TERSIO_HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, 'config');
    try {
      const set = await modes({ combo: 'balanced', caveman: 'ultra' });
      expect(set.text).toContain('Session defaults saved');
      expect(set.text).toContain('caveman=ultra');
      // balanced sets rtk on; the read-back proves the whole profile persisted.
      const read = await modes({});
      expect(read.text).toContain('caveman=ultra');
      expect(read.text).toContain('rtk=on');
      const stored = JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')) as { cavemanDefault: string };
      expect(stored.cavemanDefault).toBe('ultra');
    } finally {
      process.env.TERSIO_HOME = previousTersio;
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });
});

describe('the MCP HTTP endpoint', () => {
  test('answers only the bearer token it issued', async () => {
    // An isolated TERSIO_HOME, so the token this test mints never touches the real one.
    const home = await mkdtemp(path.join(tmpdir(), 'tersio-mcp-'));
    const previous = process.env.TERSIO_HOME;
    process.env.TERSIO_HOME = home;
    const { server, url, token } = await startMcpHttpServer(0);
    try {
     const post = (body: unknown, headers: Record<string, string>) => fetch(url, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', ...headers },
       body: JSON.stringify(body),
     });
     expect((await post(call(1, 'initialize', {}), {})).status).toBe(401);
     expect((await post(call(1, 'initialize', {}), { Authorization: 'Bearer wrong' })).status).toBe(401);
     const init = await post(call(1, 'initialize', { protocolVersion: '2025-03-26' }), { Authorization: `Bearer ${token}` });
     expect(init.status).toBe(200);
     const answer = await init.json() as { result: { protocolVersion: string; serverInfo: { name: string } } };
     expect(answer.result.protocolVersion).toBe('2025-06-18');
    const notified = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: `Bearer ${token}` });
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe('');
     expect(answer.result.serverInfo.name).toBe('tersio');
     expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
    } finally {
      process.env.TERSIO_HOME = previous;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the MCP config writer', () => {
  test('adds the entry and keeps every other server and key', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tersio-cfg-'));
    const file = path.join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ mcpServers: { other: { command: 'other' } }, theme: 'dark' }));
    await installMcpConfig(file, null);
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { theme: string; mcpServers: Record<string, { command?: string; args?: string[] }> };
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.other.command).toBe('other');
    expect(parsed.mcpServers.tersio.command).toBe('tersio');
    expect(parsed.mcpServers.tersio.args).toEqual(['mcp']);
  });

  test('writes the url and header form when given an endpoint', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tersio-cfg-'));
    const file = path.join(dir, 'config.json');
    await installMcpConfig(file, { url: 'http://127.0.0.1:7677/mcp', token: 'abc123' });
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { mcpServers: Record<string, { url?: string; headers?: Record<string, string> }> };
    expect(parsed.mcpServers.tersio.url).toBe('http://127.0.0.1:7677/mcp');
    expect(parsed.mcpServers.tersio.headers?.Authorization).toBe('Bearer abc123');
  });

  test('refuses a file that is not a JSON object and leaves it alone', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tersio-cfg-'));
    const file = path.join(dir, 'config.json');
    await writeFile(file, 'not json');
    await expect(installMcpConfig(file, null)).rejects.toThrow('is not a JSON object');
    expect(await readFile(file, 'utf8')).toBe('not json');
  });

  test('the printed entry parses back to the same url and header', () => {
    const parsed = JSON.parse(mcpHttpConfig('http://127.0.0.1:7677/mcp', 'tok')) as { mcpServers: Record<string, { url: string; headers: Record<string, string> }> };
    expect(parsed.mcpServers.tersio.url).toBe('http://127.0.0.1:7677/mcp');
    expect(parsed.mcpServers.tersio.headers.Authorization).toBe('Bearer tok');
  });
});
