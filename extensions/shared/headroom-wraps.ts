import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tersioHome } from './utils.ts';

// The wrap record Tersio keeps (`~/.tersio/headroom-wraps.json`) and headroom's own view of routing.

/** One check row from `headroom doctor --json`. */
export type HeadroomDoctorCheck = { name: string; status: string; summary: string };

/** The stored record corrected by headroom's checks: a pass adds, a warn or fail clears, and a skip keeps the flag. */
export function mergeHeadroomWraps(
  stored: Record<string, unknown>,
  checks: HeadroomDoctorCheck[],
  targets: readonly string[],
): Record<string, true> {
  const merged: Record<string, true> = {};
  for (const name of targets) if (stored[name] === true) merged[name] = true;
  for (const check of checks) {
    if (!targets.includes(check.name)) continue;
    if (check.status === 'pass' && /routed via/i.test(check.summary)) merged[check.name] = true;
    else if (check.status === 'warn' || check.status === 'fail') delete merged[check.name];
  }
  return merged;
}

/** Where the wrap record lives; the dashboard and the CLI installer both write it. */
export function headroomWrapsFile(): string {
  return path.join(tersioHome(), 'headroom-wraps.json');
}

/** One name on or off in the stored record; a failed write only costs the next read. */
export function setStoredWrap(name: string, on: boolean): void {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(readFileSync(headroomWrapsFile(), 'utf8')) as Record<string, unknown>;
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) stored = {};
  } catch { /* none yet */ }
  if (on) stored[name] = true;
  else delete stored[name];
  try {
    mkdirSync(path.dirname(headroomWrapsFile()), { recursive: true });
    writeFileSync(headroomWrapsFile(), JSON.stringify(stored, null, 2) + '\n', 'utf8');
  } catch { /* best effort */ }
}
