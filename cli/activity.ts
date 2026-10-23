// cli/activity.ts — the Tersio activity log: one JSON line per change the CLI or the dashboard makes.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tersioDataPath } from '../extensions/shared/utils.ts';

export type ActivityKind = 'mode' | 'agent' | 'file' | 'doctor';

export interface ActivityEntry {
  /** Epoch milliseconds. */
  at: number;
  kind: ActivityKind;
  title: string;
  /** The file, agent, or command the entry is about. */
  detail?: string;
  /** Absent when the entry reports no outcome of its own. */
  ok?: boolean;
}

const FILE = 'activity.jsonl';
const MAX_LINES = 4000;
/** Old entries go once the file passes this size; a log never grows without a ceiling. */
const MAX_BYTES = 512 * 1024;

/** `~/.tersio/activity.jsonl`; the legacy name is absent, so the migration is a no-op. */
function logFile(): string {
  return tersioDataPath(FILE, FILE);
}

export function shortPath(target: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home && target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

function trim(file: string): void {
  try {
    if (statSync(file).size < MAX_BYTES) return;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MAX_LINES);
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch { /* the next write tries again */ }
}

/** Appends one entry. A log line never fails the command that produced it. */
export function recordActivity(kind: ActivityKind, title: string, detail?: string, ok?: boolean): void {
  try {
    const entry: ActivityEntry = { at: Date.now(), kind, title };
    if (detail) entry.detail = detail;
    if (ok !== undefined) entry.ok = ok;
    const file = logFile();
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    trim(file);
  } catch { /* a log line never fails the command */ }
}

/** Newest first, capped at `limit`. A damaged line is skipped, not fatal. */
export function readActivity(limit = 500): ActivityEntry[] {
  try {
    const file = logFile();
    if (!existsSync(file)) return [];
    const entries: ActivityEntry[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n').slice(-limit)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ActivityEntry;
        if (typeof parsed.at === 'number' && typeof parsed.title === 'string') entries.push(parsed);
      } catch { /* skip the damaged line */ }
    }
    return entries.reverse();
  } catch {
    return [];
  }
}
