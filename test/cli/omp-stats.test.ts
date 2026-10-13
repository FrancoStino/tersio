// Pins the aggregate against a fixture store: one assertion per metric-contract rule, so drift fails loudly.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { errorSignature, readAgentStats, readSessionTrace } from '../../extensions/shared/agent-stats.ts';
import { hasSqlite } from '../helpers/env.ts';
import { sessionPath, writeQuotaDb, writeSessionFixture, writeUsageStore } from '../helpers/omp-fixture.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

let dir = '';
let previous: { stats?: string; agent?: string };

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tersio-omp-'));
  previous = { stats: process.env.TERSIO_AGENT_STATS_DB, agent: process.env.TERSIO_AGENT_SESSIONS_DB };
});

afterEach(() => {
  for (const [key, value] of Object.entries({ TERSIO_AGENT_STATS_DB: previous.stats, TERSIO_AGENT_SESSIONS_DB: previous.agent })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Five rows: two priced and cached, one free with no duration, one error, one aborted. */
function seed(): { now: number } {
  const now = Date.now();
  const s1 = sessionPath(dir, '-proj-a', 's1.jsonl');
  const s2 = sessionPath(dir, '-proj-b', 's2.jsonl');
  process.env.TERSIO_AGENT_STATS_DB = writeUsageStore(path.join(dir, 'usage.db'), {
    messages: [
      { session: s1, entry: 'e1', model: 'commandcode/priced-model', ts: now - 5 * HOUR, duration: 2000, ttft: 500, input: 1000, output: 500, cacheRead: 4000, cost: 0.10, tools: ['read', 'bash'] },
      { session: s1, entry: 'e2', model: 'commandcode/priced-model', ts: now - 4 * HOUR, duration: 4000, ttft: 1500, input: 2000, output: 1000, cacheRead: 8000, cost: 0.20 },
      { session: s2, entry: 'e3', model: 'magpie/free-model', ts: now - 3 * HOUR, duration: null, input: 100, output: 50, agentType: 'subagent' },
      { session: s2, entry: 'e4', model: 'xai-oauth/free-model', ts: now - 2 * HOUR, stop: 'error', error: '429 Too Many Requests retry-after-ms=37044000 req_abcdef123456', duration: 3000, input: 10, agentType: 'advisor' },
      { session: s1, entry: 'e5', model: 'xai-oauth/free-model-2', ts: now - 10 * 60_000, stop: 'aborted', duration: 1000, input: 20 },
    ],
  });
  process.env.TERSIO_AGENT_SESSIONS_DB = writeQuotaDb(path.join(dir, 'agent.db'), [
    { ts: now - 3 * HOUR, provider: 'openai-codex', accountKey: 'oauth|a', email: 'a@example.com', limitId: 'openai-codex:primary', label: '30 days', windowLabel: '30 days', usedFraction: 0.2, status: 'ok', resetsAt: now + DAY },
    { ts: now - 2 * HOUR, provider: 'openai-codex', accountKey: 'oauth|a', email: 'a@example.com', limitId: 'openai-codex:primary', label: '30 days', windowLabel: '30 days', usedFraction: 0.6, status: 'ok', resetsAt: now + DAY },
  ]);
  return { now };
}

describe.skipIf(!hasSqlite())('omp aggregate', () => {
  test('matches the metric contract on every figure', () => {
    seed();
    const omp = readAgentStats('all');
    expect(omp.available).toBe(true);

    expect(omp.overall.requests).toBe(5);
    expect(omp.overall.failed).toBe(1);
    expect(omp.overall.successful).toBe(4);
    expect(omp.overall.errorRate).toBeCloseTo(1 / 5, 12);
    expect(omp.overall.input).toBe(3130);
    expect(omp.overall.output).toBe(1550);
    expect(omp.overall.cacheRead).toBe(12000);
    expect(omp.overall.cacheWrite).toBe(0);
    expect(omp.overall.total).toBe(16680);
    expect(omp.overall.cacheRate).toBeCloseTo(12000 / 15130, 12);
    expect(omp.overall.costUsd).toBeCloseTo(0.3, 12);
    // The store keeps only the host's reported cost, never a split, so nothing reads as an unpriced route.
    expect(omp.overall.unpricedRequests).toBe(0);
    expect(omp.overall.avgDurationMs).toBeCloseTo(2500, 9);
    // Two of the five rows carry a latency, so the average covers only those two: 500ms and 1500ms.
    expect(omp.overall.avgTtftMs).toBeCloseTo(1000, 9);
    expect(omp.overall.avgTokensPerSecond).toBeCloseTo(125, 9);
    // The fixture spans five hours, minus the ten minutes of the newest row.
    expect(omp.overall.lastTs! - omp.overall.firstTs!).toBe(5 * HOUR - 10 * 60_000);
  });

  test('reports the host cost whole, with no per-component split', () => {
    seed();
    const omp = readAgentStats('all');

    const mix = omp.byModel.find((row) => row.key === 'commandcode/priced-model')?.costMix;
    expect(mix?.input).toBe(0);
    expect(mix?.cacheRead).toBe(0);
    expect(mix?.cacheWrite).toBe(0);
    expect(mix?.total).toBeCloseTo(0.3, 12);
    expect(mix!.input + mix!.output + mix!.cacheRead + mix!.cacheWrite).toBeCloseTo(mix!.total, 12);
    expect(omp.overall.costMix.total).toBeCloseTo(0.3, 12);
  });

  test('groups by model and provider, by provider, by project, and by agent type', () => {
    seed();
    const omp = readAgentStats('all');

    expect(omp.byModel.map((row) => `${row.key}|${row.provider}`).toSorted()).toEqual([
      'commandcode/priced-model|commandcode',
      'magpie/free-model|magpie',
      'xai-oauth/free-model-2|xai-oauth',
      'xai-oauth/free-model|xai-oauth',
    ]);
    expect(omp.byModel[0].key).toBe('commandcode/priced-model');
    expect(omp.byModel[0].requests).toBe(2);
    expect(omp.byModel[0].costUsd).toBeCloseTo(0.3, 12);

    const byProvider = Object.fromEntries(omp.byProvider.map((row) => [row.key, row]));
    expect(byProvider.commandcode.requests).toBe(2);
    expect(byProvider.commandcode.models).toBe(1);
    expect(byProvider['xai-oauth'].models).toBe(2);
    expect(byProvider.magpie.failed).toBe(0);

    const byProject = Object.fromEntries(omp.byProject.map((row) => [row.key, row.requests]));
    expect(byProject['-proj-a']).toBe(3);
    expect(byProject['-proj-b']).toBe(2);

    const byAgent = Object.fromEntries(omp.byAgentType.map((row) => [row.agentType, row.requests]));
    expect(byAgent).toEqual({ main: 3, subagent: 1, advisor: 1 });
  });

  test('buckets the series by range and keeps the totals additive', () => {
    seed();
    for (const [range, bucketMs] of [['1h', 300_000], ['24h', HOUR], ['7d', DAY], ['30d', DAY], ['90d', DAY], ['all', DAY]] as const) {
      const omp = readAgentStats(range);
      expect(omp.bucketMs).toBe(bucketMs);
      expect(omp.series.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(omp.overall.requests);
      expect(omp.series.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBe(omp.overall.total);
      for (const bucket of omp.series) expect(bucket.ts % bucketMs).toBe(0);
    }
    // A one hour window holds only the row written ten minutes ago.
    const hour = readAgentStats('1h');
    expect(hour.overall.requests).toBe(1);
    expect(hour.series.length).toBe(1);
  });

  test('splits provider and hour series, and fills every hour slot it has data for', () => {
    seed();
    const omp = readAgentStats('all');
    const providers = omp.seriesByProvider.map((series) => series.provider);
    // Every provider fits under the series cap here, ordered by cost, so commandcode leads.
    expect(providers.toSorted()).toEqual(['commandcode', 'magpie', 'xai-oauth']);
    expect(providers[0]).toBe('commandcode');
    const commandcode = omp.seriesByProvider.find((series) => series.provider === 'commandcode');
    expect(commandcode?.points.reduce((sum, point) => sum + point.requests, 0)).toBe(2);
    expect(commandcode?.points.every((point) => point.ts % DAY === 0)).toBe(true);

    expect(omp.hourOfDay.reduce((sum, slot) => sum + slot.requests, 0)).toBe(5);
    expect(omp.hourOfDay.every((slot) => slot.hour >= 0 && slot.hour < 24)).toBe(true);
    expect(omp.modelSeries.length).toBeGreaterThan(0);
  });

  test('reads the recent rows and groups failures by normalized signature', () => {
    seed();
    const omp = readAgentStats('all');
    expect(omp.recent.length).toBe(5);
    expect(omp.recent[0].entryId).toBe('e5');
    // e1 carries 500ms and e5 none, so a row reads its own latency or null, never a fill value.
    expect(omp.recent.find((row) => row.entryId === 'e1')?.ttftMs).toBe(500);
    expect(omp.recent.find((row) => row.entryId === 'e5')?.ttftMs).toBe(null);

    expect(omp.errorGroups.length).toBe(1);
    expect(omp.errorGroups[0].count).toBe(1);
    expect(omp.errorGroups[0].latest.entryId).toBe('e4');
    expect(omp.errorGroups[0].models).toEqual([{ model: 'xai-oauth/free-model', provider: 'xai-oauth', count: 1 }]);
    expect(omp.errorModels).toEqual([{ model: 'xai-oauth/free-model', provider: 'xai-oauth', count: 1 }]);
    expect(omp.errorGroups[0].signature).toBe('429 Too Many Requests retry-after-ms=N <id>');
  });

  test('averages throughput per model, provider, and bucket', () => {
    seed();
    const omp = readAgentStats('all', 'models');
    const priced = omp.modelPerformance.find((series) => series.model === 'commandcode/priced-model' && series.provider === 'commandcode');
    expect(priced).toBeDefined();
    // Rows an hour apart may straddle UTC midnight; assert only what holds either way: 250 tok/s each.
    expect(priced?.points.reduce((sum, point) => sum + point.requests, 0)).toBe(2);
    expect(priced?.points.every((point) => point.avgTokensPerSecond === 250)).toBe(true);
    // e1: 500/2000ms, e2: 1000/4000ms, both 250 tok/s; latencies average 1000ms, a point reads the mean.
    expect(priced?.points.every((point) => point.avgTtftMs === 1000)).toBe(true);
    // A provider with no timed message carries null, not a zero that would draw a flat line.
    const magpie = omp.modelPerformance.find((series) => series.provider === 'magpie');
    expect(magpie?.points.every((p) => p.avgTokensPerSecond === null && p.avgTtftMs === null)).toBe(true);
    // The models view carries the group, and a view that does not need it skips it.
    expect(readAgentStats('all', 'traces').modelPerformance).toEqual([]);
  });

  test('counts a tool name as one whole call of its message', () => {
    seed();
    const omp = readAgentStats('all');
    const read = omp.tools.find((row) => row.tool === 'read');
    const bash = omp.tools.find((row) => row.tool === 'bash');
    expect(omp.tools.length).toBe(2);
    expect(read?.calls).toBe(1);
    expect(read?.model).toBe('commandcode/priced-model');
    // The store keeps names, not per-call rows, so one name is one whole call: tokens and cost are its share.
    expect(read?.totalTokensShare).toBeCloseTo(5500, 9);
    expect(read?.outputTokensShare).toBeCloseTo(500, 9);
    expect(read?.costShare).toBeCloseTo(0.10, 12);
    expect(read?.argsChars).toBe(0);
    expect(read?.resultChars).toBe(0);
    expect(read?.errors).toBe(0);
    expect(bash?.calls).toBe(1);
    expect(omp.tools[0].tool).toBe('read');
    expect(omp.toolsByModel.length).toBe(2);
    expect(omp.toolsByModel[0].model).toBe('commandcode/priced-model');
    expect(omp.toolSeries.reduce((sum, point) => sum + point.calls, 0)).toBe(2);
  });

  test('groups messages into session traces and counts their tool calls', () => {
    seed();
    const traces = readAgentStats('all').traces;
    expect(traces.length).toBe(2);
    const first = traces[0];
    expect(first.sessionFile).toBe(sessionPath(dir, '-proj-a', 's1.jsonl'));
    expect(first.requests).toBe(3);
    expect(first.toolCalls).toBe(2);
    expect(first.lastTs).toBeGreaterThan(first.firstTs);
    expect(traces[1].project).toBe('-proj-b');
  });

  test('reads the quota windows, their accounts, and the peak utilization', () => {
    seed();
    const omp = readAgentStats('all', 'providers');
    expect(omp.windowInsights.length).toBe(1);
    const insight = omp.windowInsights[0];
    expect(insight.provider).toBe('openai-codex');
    expect(insight.windowKey).toBe('openai-codex:primary');
    expect(insight.windowLabel).toBe('30 days');
    expect(insight.accounts).toBe(1);
    expect(insight.cycles).toBe(0);
    expect(insight.fractionConsumed).toBeCloseTo(0.4, 9);
    expect(insight.peakConcurrentFraction).toBeCloseTo(0.6, 9);
    expect(insight.idealAccounts).toBe(1);
    expect(insight.exhaustedEvents).toBe(0);
    // No message in the fixture ran through openai-codex, so no window capacity can be extrapolated.
    expect(insight.estTokensPerWindow).toBeNull();
    expect(omp.usageSeries.length).toBe(1);
    expect(omp.usageSeries[0].accountLabel).toBe('a@example.com');
    expect(omp.usageSeries[0].points.map((point) => point.usedFraction)).toEqual([0.2, 0.6]);
  });

  test('runs only the query groups a view asks for', () => {
    seed();
    const projects = readAgentStats('all', 'projects');
    expect(projects.overall.requests).toBe(5);
    expect(projects.byModel).toEqual([]);
    expect(projects.traces).toEqual([]);

    const traces = readAgentStats('all', 'traces');
    expect(traces.traces.length).toBe(2);
    expect(traces.byModel).toEqual([]);
    expect(traces.overall.requests).toBe(0);
  });

  test('cuts a session transcript into spans, tracks, and totals', () => {
    const at = (s: string): number => Date.parse(`2026-01-01T00:00:${s}Z`);
    const file = writeSessionFixture(path.join(dir, 'agent', 'sessions', '-proj-a', 's.jsonl'), [
      { role: 'user', timestamp: '2026-01-01T00:00:02.000Z', content: [{ type: 'text', text: 'hello there' }] },
      {
        role: 'assistant',
        timestamp: '2026-01-01T00:00:05.000Z',
        startedAt: at('03.500'),
        model: 'deepseek/deepseek-v4.1-flash',
        provider: 'commandcode',
        duration: 1500,
        stopReason: 'toolUse',
        content: [{ type: 'text', text: 'looking' }, { type: 'toolCall', id: 'call-1', name: 'read' }],
        usage: { totalTokens: 1200, cost: { total: 0.002 } },
      },
      {
        role: 'toolResult',
        timestamp: '2026-01-01T00:00:06.000Z',
        toolName: 'read',
        toolCallId: 'call-1',
        isError: true,
        content: [{ type: 'text', text: 'ENOENT: no such file' }],
      },
    ]);
    const trace = readSessionTrace(file);
    const spans = trace.tracks[0].spans;
    expect(spans.map((span) => span.kind)).toEqual(['turn', 'model', 'tool']);

    // The prompt runs to the next call; the model span runs back from its stamp by its duration.
    expect(spans[0]).toMatchObject({ label: 'Prompt', detail: 'hello there', start: at('02'), end: at('03.500') });
    expect(spans[1]).toMatchObject({ label: 'deepseek/deepseek-v4.1-flash', start: at('03.500'), end: at('05') });
    expect(spans[1].tokens).toBe(1200);
    expect(spans[1].costUsd).toBeCloseTo(0.002, 9);

    // The tool span opens at the message that emitted the call and closes on its result.
    expect(spans[2]).toMatchObject({ tool: 'read', isError: true, detail: 'ENOENT: no such file', start: at('05'), end: at('06') });

    expect(trace.summary).toMatchObject({
      wallMs: 4000, modelMs: 1500, toolMs: 1000, idleMs: 1500,
      turns: 1, requests: 1, toolCalls: 1, totalTokens: 1200,
    });
    expect(trace.summary.costUsd).toBeCloseTo(0.002, 9);
    expect(trace.toolStats[0]).toMatchObject({ tool: 'read', calls: 1, errors: 1, totalMs: 1000, avgMs: 1000, maxMs: 1000 });
    expect(trace.markers.map((marker) => marker.kind)).toEqual(['session']);
    expect(trace.truncated).toBe(false);
    expect(trace.project).toBe('-proj-a');
  });

  test('folds a subagent transcript into its root session row', () => {
    const now = Date.parse('2026-01-01T12:00:00.000Z');
    const root = sessionPath(dir, '-proj-a', 'root.jsonl');
    const child = path.join(path.dirname(root), 'root', 'PageTile.jsonl');
    // The root file carries the session's own line and title, which the row reads from its head.
    writeSessionFixture(root, [
      { role: 'user', timestamp: '2026-01-01T11:00:00.000Z', content: [{ type: 'text', text: 'hello' }] },
    ]);
    mkdirSync(path.dirname(child), { recursive: true });
    writeFileSync(child, '');
    process.env.TERSIO_AGENT_STATS_DB = writeUsageStore(path.join(dir, 'usage.db'), {
      messages: [
        { session: root, entry: 'e1', model: 'commandcode/priced-model', ts: now - 2 * HOUR, duration: 2000, input: 100, cost: 0.10, tools: ['read'] },
        { session: child, entry: 'e2', model: 'commandcode/sub-model', ts: now - 1 * HOUR, duration: 3000, input: 200, cost: 0.20, agentType: 'subagent', tools: ['edit'] },
      ],
    });

    const traces = readAgentStats('all', 'traces').traces;
    expect(traces).toHaveLength(1);
    const [row] = traces;
    // One row per root: the child's work, models, and tool calls fold into it.
    expect(row.sessionFile).toBe(root);
    expect(row.requests).toBe(2);
    expect(row.toolCalls).toBe(2);
    expect(row.subagents).toBe(1);
    expect(row.models).toEqual(['commandcode/priced-model', 'commandcode/sub-model']);
    expect(row.tokens).toBe(300);
    expect(row.costUsd).toBeCloseTo(0.3, 9);
    // The row's clock spans both files and counts the last message's duration.
    expect(row.firstTs).toBe(now - 2 * HOUR);
    expect(row.lastTs).toBe(now - 1 * HOUR + 3000);
  });

  test('degrades to an empty result instead of throwing when a source is gone', () => {
    process.env.TERSIO_AGENT_STATS_DB = path.join(dir, 'missing.db');
    process.env.TERSIO_AGENT_SESSIONS_DB = path.join(dir, 'missing-agent.db');
    const omp = readAgentStats('all');
    expect(omp.available).toBe(false);
    expect(omp.overall.requests).toBe(0);
    expect(omp.byModel).toEqual([]);
    expect(omp.windowInsights).toEqual([]);
    expect(omp.usageSeries).toEqual([]);
  });

  test('still reads the quota half when only stats.db is missing', () => {
    seed();
    process.env.TERSIO_AGENT_STATS_DB = path.join(dir, 'missing.db');
    const omp = readAgentStats('all');
    expect(omp.available).toBe(false);
    expect(omp.windowInsights.length).toBe(1);
  });
});

/** An uncapped range once hid everything older than the newest page and reported the cap as its total. */
describe.skipIf(!hasSqlite())('request log paging', () => {
  const CAP = 200;

  /** One transcript of `count` assistant rows, one minute apart, inside the last 24 hours. */
  function seedRows(count: number): number {
    const now = Date.now();
    const file = sessionPath(dir, '-proj-a', 's.jsonl');
    process.env.TERSIO_AGENT_STATS_DB = writeUsageStore(path.join(dir, 'usage.db'), {
      messages: Array.from({ length: count }, (_, k) => ({
        session: file,
        entry: `e${String(k).padStart(4, '0')}`,
        model: 'commandcode/paged-model',
        ts: now - (count - k) * 60_000,
        duration: 1000,
        input: 10,
        output: 5,
        cost: 0.01,
        // The oldest row is the one the cap used to hide; give it a name to look for.
        tools: k === 0 ? ['read'] : [],
      })),
    });
    return now;
  }

  test('reports the range total, not the shipped row cap', () => {
    seedRows(CAP + 50);
    const omp = readAgentStats('all', 'requests');
    // The aggregate row is exact over the range; the shipped rows stop at the cap.
    expect(omp.requestStats.requests).toBe(CAP + 50);
    expect(omp.recent.length).toBe(CAP);
    expect(omp.requestStats.shipped).toBe(CAP);
    // Tokens and cost come from the same aggregate, so they cover every row, not just these 200.
    expect(omp.requestStats.tokens).toBe((CAP + 50) * 15);
    expect(omp.requestStats.costUsd).toBeCloseTo((CAP + 50) * 0.01, 9);
  });

  test('pages back without a gap or an overlap, down to the row the cap used to hide', () => {
    seedRows(CAP + 50);
    const newest = readAgentStats('all', 'requests', Date.now(), 0).recent;
    const older = readAgentStats('all', 'requests', Date.now(), CAP).recent;

    // The two payloads are contiguous: the older one starts where the newer one ends.
    expect(older.length).toBe(CAP + 50 - CAP);
    expect(Math.max(...older.map((row) => row.ts))).toBeLessThanOrEqual(Math.min(...newest.map((row) => row.ts)));
    const last = older.reduce((a, b) => (a.ts <= b.ts ? a : b));
    expect(last.entryId).toBe('e0000');
    expect(last.input).toBe(10);
  });

  test('a negative or fractional offset floors to whole rows', () => {
    seedRows(CAP + 20);
    const bad = readAgentStats('all', 'requests', Date.now(), -5).recent;
    const good = readAgentStats('all', 'requests', Date.now(), 0).recent;
    expect(bad.map((row) => row.entryId)).toEqual(good.map((row) => row.entryId));
    // 3.7 floors to 3, so the run starts three rows in and keeps its full limit.
    const halfway = readAgentStats('all', 'requests', Date.now(), 3.7).recent;
    const overlap = good.slice(3);
    expect(halfway.slice(0, overlap.length).map((row) => row.entryId)).toEqual(overlap.map((row) => row.entryId));
    expect(halfway.length).toBe(overlap.length + 3);
    // Past the cap the floor still holds, and the run reaches the oldest row in the range.
    const past = readAgentStats('all', 'requests', Date.now(), CAP + 3 + 0.9).recent;
    expect(past.map((row) => row.entryId))
      .toEqual(readAgentStats('all', 'requests', Date.now(), CAP + 3).recent.map((row) => row.entryId));
    expect(past[past.length - 1].entryId).toBe('e0000');
  });

  test('an offset past the end of the range returns nothing but keeps the true total', () => {
    seedRows(30);
    const omp = readAgentStats('all', 'requests', Date.now(), 500);
    expect(omp.recent).toEqual([]);
    expect(omp.requestStats.requests).toBe(30);
    expect(omp.requestStats.shipped).toBe(0);
  });
});

describe('error signatures', () => {
  test('normalizes ids and counters but keeps an HTTP status', () => {
    expect(errorSignature('429 Too Many Requests retry-after-ms=37044000 req_abcdef123456'))
      .toBe('429 Too Many Requests retry-after-ms=N <id>');
    expect(errorSignature('session 01a121a3-819c-75b4-ac63-f912798f4f86 failed'))
      .toBe('session <id> failed');
    expect(errorSignature('body a1b2c3d4e5f60718 rejected')).toBe('body <hex> rejected');
    expect(errorSignature('rate limit after 1.5s')).toBe('rate limit after Ns');
  });

  test('names an empty message and clips a long one', () => {
    expect(errorSignature(null)).toBe('Unknown error');
    expect(errorSignature('   ')).toBe('Unknown error');
    expect(errorSignature('x'.repeat(400)).length).toBe(180);
    expect(errorSignature('x'.repeat(400)).endsWith('…')).toBe(true);
  });
});
