// Fail on unknown Icon names, including dynamic sources lucide may rename.
import { expect, test } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "../../dashboard/app");
const components = path.join(appDir, "src/components");

// Resolve lucide-react from the dashboard app, not the root package.
const require = createRequire(path.join(appDir, "package.json"));
const { icons } = require("lucide-react") as { icons: Record<string, unknown> };

// Must match Icon.tsx's toPascal: "trash-2" -> "Trash2".
function toPascal(name: string): string {
  return name
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("");
}

function iconNamesIn(file: string): Array<string> {
  const src = readFileSync(file, "utf8");
  // `s` matches a name on its own line; only string literals, so name={foo} is skipped, not guessed.
  const direct = [...src.matchAll(/<Icon\b[^>]*?\bname="([^"]+)"/gs)].map((m) => m[1]);
  // EmptyState renders an Icon internally, so its icon prop counts too.
  const empty = [...src.matchAll(/<EmptyState\b[^>]*?\bicon="([^"]+)"/gs)].map((m) => m[1]);
  // Dynamic icons reach <Icon name={...}> through icon: "..." pairs.
  const meta = [...src.matchAll(/\bicon:\s*"([^"]+)"/g)].map((m) => m[1]);
  return [...direct, ...empty, ...meta];
}

const libFiles = ["src/lib/format.ts", "src/lib/carbon.ts"].map((f) => path.join(appDir, f));

function zoneGlyphsIn(file: string): Array<string> {
  const src = readFileSync(file, "utf8");
  // Zone helpers return ["glyph", "label", "cls"]; the glyph is the icon name.
  return [...src.matchAll(/return\s*\[\s*"([^"]+)"/g)].map((m) => m[1]);
}

const files = readdirSync(components)
  .filter((f) => f.endsWith(".tsx") && f !== "Icon.tsx")
  .map((f) => path.join(components, f));

const all = files.flatMap((f) => iconNamesIn(f).map((name) => ({ file: path.basename(f), name })));
const libNames = libFiles.flatMap((f) => zoneGlyphsIn(f).map((name) => ({ file: path.relative(appDir, f), name })));
// The token strip lived in savings.tsx, which went with the usage page; nothing replaces it.
const dynamic = libNames;

test("every icon name resolves to a real lucide icon", () => {
  const broken = [...all, ...dynamic]
    .filter(({ name }) => !(toPascal(name) in icons))
    .map(({ file, name }) => `${file}: "${name}" -> ${toPascal(name)} not in lucide`);
  expect(broken, broken.join("\n")).toEqual([]);
});
