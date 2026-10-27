// Headroom's durable savings, read through its own CLI so the ledger schema stays upstream's business.
// Mirrors rtk-gain.ts: measured=false plus a failure string, never a zero that reads as data.
// Sync by contract: readAgentStats is sync, and the 5s memo keeps a poll from shelling out each render.

import { execFileSync } from 'node:child_process';
import { resolveHeadroomBinary, shimCommand } from './utils.ts';

export interface HeadroomWindow {
  tokensSaved: number;
  tokensBefore: number;
  costUsd: number;
  calls: number;
  savingsPercent: number;
}

export interface HeadroomClientRow {
  client: string;
  calls: number;
  tokensSaved: number;
}

export interface HeadroomModelRow {
  model: string;
  costUsd: number;
}

export interface HeadroomGain {
  measured: boolean;
  failure: string;
  lifetime: HeadroomWindow;
  windows: { today: HeadroomWindow; last7Days: HeadroomWindow; last30Days: HeadroomWindow };
  byClient: HeadroomClientRow[];
  byModel: HeadroomModelRow[];
}

export interface HeadroomGainOptions {
  /** Test seam: a fake binary path, else the PATH probe. `null` skips the call entirely. */
  binary?: string | null;
  budgetMs?: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function window(raw: unknown): HeadroomWindow {
  const w = (raw ?? {}) as Record<string, unknown>;
  return {
    tokensSaved: num(w.tokens_saved),
    tokensBefore: num(w.tokens_before),
    costUsd: num(w.cost_usd),
    calls: num(w.calls),
    savingsPercent: num(w.savings_percent),
  };
}

// Field names differ between schema versions; every read tolerates a miss and prices it zero.
export function parseHeadroomSavings(raw: string): HeadroomGain {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const windows = (parsed.windows ?? {}) as Record<string, unknown>;
  const clients = Array.isArray(parsed.by_client) ? parsed.by_client : [];
  const models = Array.isArray(parsed.by_model) ? parsed.by_model : [];
  return {
    measured: true,
    failure: '',
    lifetime: window(parsed.lifetime),
    windows: {
      today: window(windows.today),
      last7Days: window(windows.last_7_days),
      last30Days: window(windows.last_30_days),
    },
    byClient: clients.map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return { client: String(r.client ?? 'unknown'), calls: num(r.calls), tokensSaved: num(r.tokens_saved ?? r.tokens) };
    }),
    byModel: models.map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return { model: String(r.model ?? 'unknown'), costUsd: num(r.cost_usd ?? r.cost) };
    }),
  };
}

export function emptyHeadroomGain(failure: string): HeadroomGain {
  const zero = { tokensSaved: 0, tokensBefore: 0, costUsd: 0, calls: 0, savingsPercent: 0 };
  return {
    measured: false,
    failure,
    lifetime: { ...zero },
    windows: { today: { ...zero }, last7Days: { ...zero }, last30Days: { ...zero } },
    byClient: [],
    byModel: [],
  };
}

export interface HeadroomCheck {
  name: string;
  status: string;
  summary: string;
  hint: string | null;
}

export interface HeadroomDoctor {
  measured: boolean;
  failure: string;
  exitCode: number | null;
  version: string | null;
  checks: HeadroomCheck[];
}

// The probe costs a subprocess plus localhost round-trips; the dashboard polls, so hold it briefly.
const DOCTOR_MEMO_MS = 15000;
let doctorMemo: { at: number; value: HeadroomDoctor } | null = null;

/** Tests only: drops the doctor memo so a refetch re-runs the probe. */
export function resetHeadroomDoctorMemo(): void {
  doctorMemo = null;
}

export function parseHeadroomDoctor(raw: string): HeadroomDoctor {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  return {
    measured: true,
    failure: '',
    exitCode: typeof parsed.exit_code === 'number' ? parsed.exit_code : null,
    version: typeof parsed.installed_version === 'string' ? parsed.installed_version : null,
    checks: checks.map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return {
        name: String(r.name ?? 'check'),
        status: String(r.status ?? 'unknown'),
        summary: String(r.summary ?? ''),
        hint: typeof r.hint === 'string' ? r.hint : null,
      };
    }),
  };
}

/**
 * Headroom's own routing check: proxy reachable, agents routed, wrap marker present. It exits 2 when a
 * check fails and still prints the JSON, so a non-zero exit is a reading, not a failure to read.
 */
export function readHeadroomDoctor(options: HeadroomGainOptions = {}): HeadroomDoctor {
  const binary = options.binary !== undefined ? options.binary : resolveHeadroomBinary();
  if (!binary) return { measured: false, failure: 'headroom binary not found in PATH', exitCode: null, version: null, checks: [] };
  if (doctorMemo && Date.now() - doctorMemo.at < DOCTOR_MEMO_MS) return doctorMemo.value;
  try {
    // A Windows install can land as `headroom.cmd`, and cmd.exe only runs through the shim.
    const shim = shimCommand(binary, ['doctor', '--json']);
    const stdout = execFileSync(shim.cmd, shim.args, {
      timeout: options.budgetMs ?? 8000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    const value = parseHeadroomDoctor(stdout);
    doctorMemo = { at: Date.now(), value };
    return value;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    if (typeof err.stdout === 'string' && err.stdout.trim().startsWith('{')) {
      const value = parseHeadroomDoctor(err.stdout);
      doctorMemo = { at: Date.now(), value };
      return value;
    }
    doctorMemo = null;
    return {
      measured: false,
      failure: err.killed ? 'headroom doctor timed out' : (err.stderr?.trim() || err.message || 'headroom doctor failed'),
      exitCode: null,
      version: null,
      checks: [],
    };
  }
}

// The dashboard polls per render, and a subprocess per poll is too much for a ledger that moves slowly.
const MEMO_MS = 5000;
let memo: { at: number; gain: HeadroomGain } | null = null;

/** Tests only: drops the memo so a refetch re-runs the CLI. */
export function resetHeadroomGainMemo(): void {
  memo = null;
}

export function readHeadroomSavings(options: HeadroomGainOptions = {}): HeadroomGain {
  const binary = options.binary !== undefined ? options.binary : resolveHeadroomBinary();
  if (!binary) return emptyHeadroomGain('headroom binary not found in PATH');
  if (memo && Date.now() - memo.at < MEMO_MS) return memo.gain;
  try {
    // A Windows install can land as `headroom.cmd`, and cmd.exe only runs through the shim.
    const shim = shimCommand(binary, ['savings', '--json']);
    const stdout = execFileSync(shim.cmd, shim.args, {
      timeout: options.budgetMs ?? 5000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    const gain = parseHeadroomSavings(stdout);
    memo = { at: Date.now(), gain };
    return gain;
  } catch (e) {
    const err = e as { message?: string; stderr?: string; killed?: boolean };
    memo = null;
    return emptyHeadroomGain(err.killed ? 'headroom savings timed out' : (err.stderr?.trim() || err.message || 'headroom savings failed'));
  }
}
