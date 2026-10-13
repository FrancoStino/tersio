import { expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ruleBodyProblem } from "../../extensions/shared/utils.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Each extensions/<base> import needs packed .js (CLI) and .ts (OMP); v2.20.0 shipped .ts only and crashed.
function cliExtensionBases(): Set<string> {
  const bases = new Set<string>();
  for (const file of readdirSync(path.join(root, "cli"))) {
    if (!file.endsWith(".ts")) continue;
    for (const line of readFileSync(path.join(root, "cli", file), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("import type ")) continue;
      const match = trimmed.match(/from ["']\.\.\/extensions\/([^"']+)["']/);
      if (match) bases.add(match[1].replace(/\.ts$/, ""));
    }
  }
  return bases;
}

function packedFiles(): Set<string> {
  const which = spawnSync("bun", ["--version"], { encoding: "utf8" });
  expect(which.status, "bun is required to pack (run: bun install)").toBe(0);
  let out: string;
  try {
    out = execFileSync("bun", ["pm", "pack", "--dry-run"], { cwd: root, encoding: "utf8" });
  } catch (e) {
    expect.fail(`bun pm pack --dry-run failed (run bun run build first): ${(e as Error).message}`);
  }
  const files = new Set<string>();
  for (const line of out!.split("\n")) {
    const match = line.match(/^packed\s+\S+\s+(.+)$/);
    if (match) files.add(match[1].trim());
  }
  return files;
}

test("packed tarball carries both .js (CLI runtime) and .ts (OMP) for every CLI-used extension module", () => {
  const bases = cliExtensionBases();
  expect(bases.size > 0, "expected cli/*.ts to import extension modules").toBe(true);
  const packed = packedFiles();
  expect(packed).toContain("dashboard/dist/index.html");
  expect(packed).toContain("dashboard/dist/brand.webp");
  expect(packed).not.toContain("dashboard/app/src/App.tsx");
  expect(packed).not.toContain("dashboard/legacy/template.html");
  for (const base of [...bases].sort()) {
    expect(packed, `missing compiled runtime: dist/extensions/${base}.js`).toContain(`dist/extensions/${base}.js`);
    expect(packed, `missing OMP source: extensions/${base}.ts`).toContain(`extensions/${base}.ts`);
  }
});

test("packed tarball carries every Caveman rule body", () => {
  const packed = packedFiles();
  for (const name of ["rule.md", "rule-ultra.md", "rule-megacave.md"]) {
    expect(packed, `manifest-loaded Caveman must receive ${name}`).toContain(`extensions/caveman/${name}`);
  }
  // Bodies load at runtime; rule.md aliases `ultra`/`wenyan`; contract in test/extensions/caveman.test.ts.
  for (const name of ["rule.md", "rule-ultra.md", "rule-megacave.md"]) {
    expect(ruleBodyProblem(readFileSync(path.join(root, "extensions", "caveman", name), "utf8")),
      `${name} must pass the install-time body gate`).toBeNull();
  }
});

// A packed tree can list every file and still not boot, so run the packed CLI itself.
test.skipIf(process.platform === "win32")("the packed tarball boots and reports its version", () => {
  const version = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-pack-boot-"));
  try {
    execFileSync("bun", ["pm", "pack", "--destination", dir, "--quiet"], { cwd: root, encoding: "utf8" });
    const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz"));
    if (!tarball) expect.unreachable("bun pm pack wrote a tarball");
    execFileSync("tar", ["-xzf", tarball, "-C", dir], { cwd: dir });
    // The repo's own node_modules stands in for an install, so no registry is needed.
    symlinkSync(path.join(root, "node_modules"), path.join(dir, "package", "node_modules"), "dir");
    const out = execFileSync(process.execPath, [path.join(dir, "package", "dist", "tersio.js"), "--version"], { encoding: "utf8" });
    expect(out.trim()).toBe(version);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
