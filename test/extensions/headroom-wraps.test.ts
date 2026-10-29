import { describe, expect, test } from 'vitest';
import { mergeHeadroomWraps } from '../../extensions/shared/headroom-wraps.ts';

const TARGETS = ['omp', 'claude', 'codex', 'opencode'] as const;

// The record is what Tersio ran; headroom's own checks are the truth when they answer.
describe('mergeHeadroomWraps', () => {
  test('a tool without a doctor check keeps its stored flag', () => {
    expect(mergeHeadroomWraps({ omp: true }, [], TARGETS)).toEqual({ omp: true });
  });

  test('a doctor pass names the config it routed and adds the tool', () => {
    const checks = [{ name: 'claude', status: 'pass', summary: 'routed via /x/settings.local.json' }];
    expect(mergeHeadroomWraps({}, checks, TARGETS)).toEqual({ claude: true });
  });

  test('a stored flag clears when headroom reports the tool not routed', () => {
    const checks = [{ name: 'codex', status: 'warn', summary: 'not routed (no active provider base_url in config.toml)' }];
    expect(mergeHeadroomWraps({ codex: true }, checks, TARGETS)).toEqual({});
    expect(mergeHeadroomWraps({ codex: true }, [{ ...checks[0], status: 'fail' }], TARGETS)).toEqual({});
  });

  test('a skip keeps the stored flag, because headroom could not tell', () => {
    const checks = [{ name: 'omp', status: 'skip', summary: 'proxy not reachable' }];
    expect(mergeHeadroomWraps({ omp: true }, checks, TARGETS)).toEqual({ omp: true });
  });

  test('checks outside the target list and junk stored keys never enter the record', () => {
    const checks = [{ name: 'savings', status: 'pass', summary: 'routed via nothing' }];
    expect(mergeHeadroomWraps({ savings: true, junk: 'yes' }, checks, TARGETS)).toEqual({});
  });
});
