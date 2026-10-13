// An imported module missing from the manifest only fails at host load time.
import { expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GENERATED_TREE_FILES, TREE_FILES, sourcePath, treeFilesFor } from "../../cli/manifest.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  keywords: string[];
  omp: { extensions: string[]; skills: string[] };
  // Optional: pi loads the tree by convention; keywords make the package discoverable in the gallery.
  pi?: { extensions?: string[]; skills?: string[] };
};

const entries = [...pkg.omp.extensions, ...(pkg.pi?.extensions ?? [])];

function relativeImports(file: string): string[] {
  const body = readFileSync(path.join(root, file), "utf8");
  const specs: string[] = [];
  for (const re of [
    /(?:import|export)[^'"]*?from\s*['"](\.[^'"]+)['"]/g,
    /import\s*['"](\.[^'"]+)['"]/g,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]) {
    for (const m of body.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

// The transitive closure of relative imports under extensions/.
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry.replace(/^\.\//, "")];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !file.startsWith("extensions/")) continue;
    seen.add(file);
    for (const spec of relativeImports(file)) {
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).replace(/\.(ts|js)$/, ".ts"));
    }
  }
  return [...seen];
}

test("the extension entries in both manifests exist", () => {
  for (const entry of entries) {
    expect(() => readFileSync(path.join(root, entry), "utf8"), entry).not.toThrow();
  }
});

test("every module the extensions import is in the install manifest", () => {
  const installed = new Set(TREE_FILES);
  const missing: string[] = [];
  for (const entry of entries) {
    for (const file of importClosure(entry)) {
      const dest = file.replace(/^extensions\//, "");
      if (!installed.has(dest)) missing.push(`${entry} imports ${file} → ${dest}`);
    }
  }
  expect(missing, `the installed tree would fail to load:\n${missing.join("\n")}`).toEqual([]);
});

test("every manifest entry exists in the source tree", () => {
  for (const file of TREE_FILES) {
    expect(existsSync(sourcePath(file)), file).toBe(true);
  }
});

test("the package keeps the pi keywords, so the gallery can find it", () => {
  expect(pkg.keywords).toContain("pi");
  expect(pkg.keywords).toContain("pi-package");
});

test("no manifest points at a dependency path, which npm hoists out of the package", () => {
  // The bundled ponytail declares its own skills; a path through node_modules never exists in an installed package.
  for (const entry of [...pkg.omp.extensions, ...(pkg.pi?.extensions ?? [])]) {
    expect(entry, "manifest entries resolve inside the published package").not.toContain("node_modules/");
  }
});

test("the first-token timer is installed for pi", () => {
  // pi records no first-token latency; every host tree carries the file, and pi's loader is what runs it.
  expect(treeFilesFor("pi"), "pi loads the timer").toContain("timing/index.ts");
  expect(TREE_FILES, "the shared tree carries it, so pi's install can write it").toContain("timing/index.ts");
});

test("every host's tree declares the manifest entries it installs", () => {
  // A generated entry has no repo file, so the tree list, not TREE_FILES, is what each host must satisfy.
  for (const id of ["omp", "pi", "opencode"] as const) {
    const files = treeFilesFor(id);
    for (const file of files) {
      if (GENERATED_TREE_FILES[file] !== undefined) continue;
      expect(existsSync(sourcePath(file)), `${id} declares ${file}`).toBe(true);
    }
    // OpenCode alone loads server.ts; every other host must not receive it.
    if (id !== "opencode") expect(files, `${id} must not receive the OpenCode entry`).not.toContain("server.ts");
    if (id === "opencode") expect(files, "OpenCode needs its entry").toContain("server.ts");
  }
});
