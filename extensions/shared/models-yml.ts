// omp's models.yml is omp's own file, and two surfaces edit it: the cli route (route/unroute) and the
// session-start heal in the headroom extension. Both need the same block-aware baseUrl edit, so the
// logic lives here as pure line surgery. A provider block is a two-space key under `providers:` that
// runs until the next key at the same or shallower indent.

export interface ProviderBlockRange {
  start: number;
  end: number;
}

export function providerBlockRange(lines: string[], provider: string): ProviderBlockRange | null {
  const escaped = provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((line) => new RegExp(`^  ${escaped}:\\s*$`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {0,2}\S/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/** The provider's current `baseUrl:` value, or null when the block has none or the provider is missing. */
export function providerBaseUrl(lines: string[], provider: string): string | null {
  const range = providerBlockRange(lines, provider);
  if (!range) return null;
  for (let i = range.start + 1; i < range.end; i += 1) {
    const line = lines[i];
    if (line.startsWith('    baseUrl:')) return line.slice('    baseUrl:'.length).trim();
  }
  return null;
}

/**
 * Set (or with null, drop) the provider's `baseUrl:` line. Returns new lines, or null when there is
 * nothing to change: an unknown provider, or a drop on a block that has no line.
 */
export function setProviderBaseUrlInLines(lines: string[], provider: string, value: string | null): string[] | null {
  const range = providerBlockRange(lines, provider);
  if (!range) return null;
  const next = [...lines];
  const existing = next.findIndex((line, i) => i > range.start && i < range.end && line.startsWith('    baseUrl:'));
  if (existing > 0) {
    if (value === null) next.splice(existing, 1);
    else next[existing] = `    baseUrl: ${value}`;
  } else if (value !== null) {
    next.splice(range.start + 1, 0, `    baseUrl: ${value}`);
  } else {
    return null;
  }
  return next;
}
