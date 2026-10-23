import { describe, expect, test } from 'vitest';
import { handleMessage } from '../../cli/mcp.ts';

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
