// Brand marks resolve to a URL; the CLI export inlines them once (`window.__TERSIO_MARKS`), keeping it offline.
import { isColoredMark, markUrl } from "../../../../../extensions/shared/brand-marks.ts";
import { INLINE_MARKS } from "./inline.ts";

/** The export's inlined copies. The live dashboard never sets this. */
function embedded(): Record<string, string> {
const scope = globalThis as { __TERSIO_MARKS?: Record<string, string> | null };
return scope.__TERSIO_MARKS ?? {};
}

/** A maskable mark for the slug, or null when the mark is monochrome-otherwise or unknown. */
export function maskMark(slug: string): string | null {
  if (isColoredMark(slug)) return null;
  return embedded()[slug] ?? INLINE_MARKS[slug] ?? markUrl(slug);
}

/** A full-color mark for the slug, or null when it is monochrome or unknown, so a slug resolves to one mark. */
export function imageMark(slug: string): string | null {
  const url = embedded()[slug] ?? INLINE_MARKS[slug] ?? markUrl(slug);
  return isColoredMark(slug) ? url : null;
}

export function hasMark(slug: string): boolean {
  return imageMark(slug) !== null || maskMark(slug) !== null;
}
