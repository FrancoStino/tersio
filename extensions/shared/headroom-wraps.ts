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
