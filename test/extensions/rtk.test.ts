// Zero coverage once shipped a crashing tool call; keep it covered. Every failure path must keep the original output: a wrong filtered result is worse.
import { expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import rtkFilterExtension, {
  FILTER_BY_TOOL,
  MIN_FILTER_BYTES,
  filterThroughRtk,
  filterableText,
  rtkActive,
} from "../../extensions/rtk/filter.ts";
import type { FilterExec } from "../../extensions/rtk/filter.ts";
import rtkSessionExtension from "../../extensions/rtk/session.ts";
import timingExtension from "../../extensions/timing/index.ts";
import { resetSharedComboState, setSharedComboMode } from "../../extensions/shared/session-state.ts";
import type { ExtensionApi, ExtensionCtx, SessionEntry, ToolResultEvent } from "../../extensions/shared/types.ts";
import { readRtkGain, rtkDbPath } from "../../extensions/shared/rtk-gain.ts";
import { wireRtkOmp, wireRtkOpencode, wireRtkPi, type WiringOptions } from "../../cli/rtk-wiring.ts";
import { findFile, resolveRtkBinary, rtkPlatformSpec } from "../../extensions/shared/utils.ts";
import { sqliteExec } from "../../extensions/shared/sqlite.ts";
import { hasSqlite } from "../helpers/env.ts";

process.env.HOME = new URL("../definitely-missing-home", import.meta.url).pathname;
process.env.USERPROFILE = process.env.HOME;
process.env.TERSIO_HOME = process.env.HOME;

// ===== rtk-filter.test.ts =====

/** A `rtk` file on PATH, so `resolveRtkBinary` finds a binary the stub exec never spawns. */
function withFakeRtk(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "tersio-rtk-bin-"));
  const bin = path.join(dir, "rtk");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(bin, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = dir;
  return work(dir).finally(() => {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
}

function big(marker = "match"): string {
  const line = `src/file.ts:12:${marker} a line of grep output that the filter should drop\n`;
  return line.repeat(Math.ceil(MIN_FILTER_BYTES / line.length) + 5);
}

type Entries = SessionEntry[];
type Handler = (event: ToolResultEvent, ctx: ExtensionCtx) => Promise<unknown>;

function harness(exec: FilterExec | undefined, entries: Entries = []) {
  const handlers = new Map<string, Handler>();
  const api: Record<string, unknown> = {
    setLabel() {},
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    cwd: "/tmp",
  };
  if (exec) api.exec = exec;
  rtkFilterExtension(api as unknown as ExtensionApi);
  const ctx = { hasUI: false, sessionManager: { getBranch: () => entries } } as ExtensionCtx;
  const has = (name: string): boolean => handlers.has(name);
  return { fire: (event: ToolResultEvent) => handlers.get("tool_result")!(event, ctx), has };
}

const grepEvent = (text: string): ToolResultEvent => ({ toolName: "grep", content: [{ type: "text", text }] });

test("a grep result over the threshold is replaced by the rtk filter", async () => {
  await withFakeRtk(async () => {
    resetSharedComboState();
    const calls: Array<{ cmd: string; args: string[]; timeout?: number }> = [];
    const h = harness(async (cmd, args, opts) => {
      calls.push({ cmd, args, timeout: opts?.timeout });
      return { stdout: "3 matches in 1F:\n  src/file.ts (3)\n", code: 0 };
    }, [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);

    const result = await h.fire(grepEvent(big())) as { content: Array<{ type: string; text: string }> };

    expect(result.content).toEqual([{ type: "text", text: "3 matches in 1F:\n  src/file.ts (3)\n" }]);
    expect(calls[0].cmd, "an absolute shell, so a minimal PATH cannot break the spawn").toBe("/bin/sh");
    expect(calls[0].args[0]).toBe("-c");
    expect(calls[0].args[1]).toMatch(/pipe -f grep/);
    // A hung filter must not stall the tool result.
    expect(calls[0].timeout).toBe(5000);
    // The payload file is removed, so the gathered text does not pile up in /tmp.
    const redirected = calls[0].args[1].match(/< "([^"]+)"/);
    expect(redirected, "the filter reads the payload from a file").not.toBeNull();
    expect(existsSync(redirected![1])).toBe(false);
  });
});

test("glob is filtered as find, and read is never filtered", async () => {
  expect(FILTER_BY_TOOL.get("glob")).toBe("find");
  expect(FILTER_BY_TOOL.get("grep")).toBe("grep");
  expect(FILTER_BY_TOOL.get("read"), "a filtered read would not match the file being edited").toBeUndefined();

  await withFakeRtk(async () => {
    resetSharedComboState();
    let called = 0;
    const exec: FilterExec = async () => { called += 1; return { stdout: "small", code: 0 }; };
    const h = harness(exec, [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);

    const globbed = await h.fire({ toolName: "glob", content: [{ type: "text", text: big() }] }) as { content: Array<{ text: string }> };
    expect(globbed.content[0].text).toBe("small");

    expect(await h.fire({ toolName: "read", content: [{ type: "text", text: big() }] })).toBeUndefined();
    expect(called, "read spawns no filter").toBe(1);
  });
});

test("small, error, mixed, and empty results are left alone", async () => {
  await withFakeRtk(async () => {
    resetSharedComboState();
    let called = 0;
    const exec: FilterExec = async () => { called += 1; return { stdout: "x", code: 0 }; };
    const h = harness(exec, [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);

    expect(await h.fire(grepEvent("src/a.ts:1:tiny\n"))).toBeUndefined();
    expect(await h.fire({ ...grepEvent(big()), isError: true })).toBeUndefined();
    expect(await h.fire({ toolName: "grep", content: [{ type: "text", text: big() }, { type: "image" }] })).toBeUndefined();
    expect(await h.fire({ toolName: "grep", content: [] })).toBeUndefined();
    expect(await h.fire({ toolName: "grep" })).toBeUndefined();
    expect(called, "none of those reach the filter").toBe(0);
  });
});

test("rtk off, a failed filter, and a filter that would grow the text all keep the original", async () => {
  await withFakeRtk(async () => {
    resetSharedComboState();
    const text = big();
    const off = harness(async () => ({ stdout: "short", code: 0 }), [{ type: "custom", customType: "rtk-mode", data: { enabled: false } }]);
    expect(await off.fire(grepEvent(text))).toBeUndefined();

    const failing = harness(async () => ({ stdout: "short", code: 2 }), [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
    expect(await failing.fire(grepEvent(text)), "a non-zero exit is untrustworthy").toBeUndefined();

    const growing = harness(async () => ({ stdout: `${text}${text}`, code: 0 }), [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
    expect(await growing.fire(grepEvent(text))).toBeUndefined();

    const blank = harness(async () => ({ stdout: "   \n", code: 0 }), [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
    expect(await blank.fire(grepEvent(text))).toBeUndefined();

    const throwing = harness(async () => { throw new Error("spawn sh ENOENT"); }, [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
    expect(await throwing.fire(grepEvent(text))).toBeUndefined();
  });
});

test("a host without exec registers nothing", () => {
  resetSharedComboState();
  const h = harness(undefined, [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
  expect(h.has("tool_result")).toBe(false);
});

test("rtkActive prefers the session entry over the shared switch", () => {
  resetSharedComboState();
  setSharedComboMode("rtk", "on");
  expect(rtkActive([{ type: "custom", customType: "rtk-mode", data: { enabled: false } }]), "an explicit /rtk off wins").toBe(false);
  expect(rtkActive([{ type: "custom", customType: "rtk-mode", data: { enabled: true } }])).toBe(true);
  expect(rtkActive([{ type: "custom", customType: "rtk-mode", data: { mode: "nonsense" } }]), "a malformed entry falls back").toBe(true);
  expect(rtkActive(undefined)).toBe(true);
  // This file now holds what were separate files, so a switch left on would decide for the tests below.
  resetSharedComboState();
});

test("filterableText decodes plain text parts and refuses everything else", () => {
  expect(filterableText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  expect(filterableText([{ type: "text" }]), "a part with no text reads as empty").toBe("");
  expect(filterableText([{ type: "text", text: "a" }, { type: "image" }])).toBeNull();
  expect(filterableText([])).toBeNull();
  expect(filterableText(undefined)).toBeNull();
  expect(filterableText("already a string"), "OpenCode hands parts, never a bare string").toBeNull();
});

test("filterThroughRtk reports null instead of throwing when the binary is gone", async () => {
  const exec: FilterExec = async () => { throw new Error("spawn sh ENOENT"); };
  const gone = path.join(tmpdir(), "tersio-no-rtk", "rtk");
  expect(await filterThroughRtk(exec, { bin: gone, filter: "grep", text: big() })).toBeNull();
});

// ===== rtk-gain.test.ts =====

function withDb(db: string | undefined, fn: () => void): void {
  const prev = process.env.TERSIO_RTK_DB;
  if (db === undefined) delete process.env.TERSIO_RTK_DB;
  else process.env.TERSIO_RTK_DB = db;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.TERSIO_RTK_DB;
    else process.env.TERSIO_RTK_DB = prev;
  }
}

test("missing rtk db returns empty gain without throwing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-"));
  try {
    withDb(path.join(dir, "nope.db"), () => {
      expect(readRtkGain()).toEqual({ commands: 0, saved: 0, input: 0, avgPct: 0, totalMs: 0, byCommand: [] });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!hasSqlite())("aggregates per-command savings from history.db", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-"));
  const db = path.join(dir, "history.db");
  try {
    sqliteExec(db, [
      "CREATE TABLE commands (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL,",
      "original_cmd TEXT NOT NULL, rtk_cmd TEXT NOT NULL, input_tokens INTEGER NOT NULL,",
      "output_tokens INTEGER NOT NULL, saved_tokens INTEGER NOT NULL, savings_pct REAL NOT NULL,",
      "exec_time_ms INTEGER DEFAULT 0, project_path TEXT DEFAULT '');",
      "INSERT INTO commands VALUES (1,'2026-09-01T00:00:00Z','git status','rtk git status',100,50,50,90.0,20,'/tmp');",
      "INSERT INTO commands VALUES (2,'2026-09-01T00:01:00Z','git status','rtk git status',900,800,100,10.0,40,'/tmp');",
      "INSERT INTO commands VALUES (3,'2026-09-01T00:02:00Z','grep foo','rtk grep',1000,900,100,10.0,600,'/tmp');",
    ].join(" "));
    withDb(db, () => {
      const g = readRtkGain();
      expect(g.commands).toBe(3);
      expect(g.saved).toBe(250);
      expect(g.input).toBe(2000);
      expect(Math.abs(g.avgPct - (250 / 2000) * 100) < 1e-9).toBeTruthy();
      expect(g.byCommand.length).toBe(2);
      expect(g.byCommand[0]).toEqual({ command: "rtk git status", count: 2, saved: 150, avgPct: 15, avgMs: 30 });
      expect(g.byCommand[1]).toEqual({ command: "rtk grep", count: 1, saved: 100, avgPct: 10, avgMs: 600 });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!hasSqlite())("cutoff filters the view without touching the db", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-"));
  const db = path.join(dir, "history.db");
  try {
    sqliteExec(db, [
      "CREATE TABLE commands (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL,",
      "original_cmd TEXT NOT NULL, rtk_cmd TEXT NOT NULL, input_tokens INTEGER NOT NULL,",
      "output_tokens INTEGER NOT NULL, saved_tokens INTEGER NOT NULL, savings_pct REAL NOT NULL,",
      "exec_time_ms INTEGER DEFAULT 0, project_path TEXT DEFAULT '');",
      "INSERT INTO commands VALUES (1,'2026-09-01T00:00:00Z','git status','rtk git status',100,50,50,50.0,20,'/tmp');",
      "INSERT INTO commands VALUES (2,'2026-09-01T00:01:00Z','git status','rtk git status',200,100,100,50.0,40,'/tmp');",
      "INSERT INTO commands VALUES (3,'2026-09-13T12:00:00Z','grep foo','rtk grep',1000,900,100,10.0,600,'/tmp');",
    ].join(" "));
    withDb(db, () => {
      const cutoff = Date.parse("2026-09-13T00:00:00Z");
      const g = readRtkGain(10, cutoff);
      expect(g.commands, "only post-cutoff rows in the view").toBe(1);
      expect(g.saved).toBe(100);
      expect(g.byCommand.length).toBe(1);
      const all = readRtkGain();
      expect(all.commands).toBe(3);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default db path follows the platform", () => {
  withDb(undefined, () => {
    const p = rtkDbPath();
    expect(p.endsWith("history.db"), p).toBeTruthy();
  });
});

test.skipIf(!hasSqlite())("multi-line commands stay one row", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-"));
  const db = path.join(dir, "history.db");
  try {
    sqliteExec(db, [
      "CREATE TABLE commands (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL,",
      "original_cmd TEXT NOT NULL, rtk_cmd TEXT NOT NULL, input_tokens INTEGER NOT NULL,",
      "output_tokens INTEGER NOT NULL, saved_tokens INTEGER NOT NULL, savings_pct REAL NOT NULL,",
      "exec_time_ms INTEGER DEFAULT 0, project_path TEXT DEFAULT '');",
      // heredoc-style command: real rows look like this, newlines and all
      "INSERT INTO commands VALUES (1,'2026-09-01T00:00:00Z','node -e','rtk fallback: node -e",
      "const a = 1;",
      "const b = 2;',300,100,200,66.0,10,'/repos/multi');",
      "INSERT INTO commands VALUES (2,'2026-09-01T00:01:00Z','git status','rtk git status',100,50,50,50.0,20,'/repos/multi');",
    ].join(" "));
    withDb(db, () => {
      const g = readRtkGain(50);
      expect(g.byCommand.length, "one row per command, not one per physical line").toBe(2);
      for (const r of g.byCommand) {
        expect(!r.command.includes("\n"), "commands are flattened for the table").toBeTruthy();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!hasSqlite())("same command across repos folds into one row", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-"));
  const db = path.join(dir, "history.db");
  try {
    sqliteExec(db, [
      "CREATE TABLE commands (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL,",
      "original_cmd TEXT NOT NULL, rtk_cmd TEXT NOT NULL, input_tokens INTEGER NOT NULL,",
      "output_tokens INTEGER NOT NULL, saved_tokens INTEGER NOT NULL, savings_pct REAL NOT NULL,",
      "exec_time_ms INTEGER DEFAULT 0, project_path TEXT DEFAULT '');",
      "INSERT INTO commands VALUES (1,'2026-09-01T00:00:00Z','grep foo','rtk grep',100,50,50,50.0,20,'/repos/busy');",
      "INSERT INTO commands VALUES (2,'2026-09-01T00:01:00Z','grep foo','rtk grep',100,50,50,50.0,20,'/repos/busy');",
      "INSERT INTO commands VALUES (3,'2026-09-01T00:02:00Z','grep foo','rtk grep',100,50,50,50.0,20,'/repos/quiet');",
      "INSERT INTO commands VALUES (4,'2026-09-01T00:03:00Z','bun run build','rtk bun run build (passthrough)',100,0,0,0.0,5,'/repos/quiet');",
      `INSERT INTO commands VALUES (5,'2026-09-01T00:04:00Z','ls','rtk ls -d ${"x".repeat(400)}',100,0,0,0.0,5,'/repos/quiet');`,
    ].join(" "));
    withDb(db, () => {
      const g = readRtkGain(50);
      expect(g.commands, "totals stay machine-wide").toBe(5);
      const grep = g.byCommand.filter((r) => r.command === "rtk grep");
      expect(grep.length, "same command in two repos is one row").toBe(1);
      expect(grep[0].count).toBe(3);
      // A zero-saving command still reaches the table; old rows ranked by tokens saved dropped it.
      expect(g.byCommand.some((r) => r.command === "rtk bun run build (passthrough)")).toBeTruthy();
      expect(g.byCommand.find((r) => r.command.startsWith("rtk ls -d "))?.command.length).toBe(200);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== rtk-omp-wiring.test.ts =====

// Fake rtk binary: logs its argv beside it, exits with the given code; hermetic, never touches a real OMP dir.
function fakeRtk(dir: string, code = 0): string {
  const bin = path.join(dir, "rtk");
  writeFileSync(bin, [
    "#!/bin/sh",
    `echo "$@" >> "${path.join(dir, "invocations.log")}"`,
    `exit ${code}`,
  ].join("\n"), "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

function tempHome(): { dir: string; log: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-wire-"));
  return { dir, log: path.join(dir, "invocations.log") };
}

test("dry-run prints the would-run line and never executes the binary", async () => {
  const { dir, log } = tempHome();
  try {
    const ok = await wireRtkOmp(fakeRtk(dir), { dryRun: true });
    expect(ok).toBe(true);
    expect(existsSync(log), "fake binary must not run in dry-run").toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("success path runs init -g --agent omp once", async () => {
  const { dir, log } = tempHome();
  try {
    const ok = await wireRtkOmp(fakeRtk(dir), {});
    expect(ok).toBe(true);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toEqual(["init -g --agent omp"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failing binary returns false without throwing", async () => {
  const { dir, log } = tempHome();
  try {
    const ok = await wireRtkOmp(fakeRtk(dir, 3), {});
    expect(ok).toBe(false);
    expect(readFileSync(log, "utf8")).toMatch(/init/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("success path registers rtk.ts in a fake HOME config.yml", async () => {
  const { dir } = tempHome();
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-home-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const cfgDir = path.join(home, ".omp", "agent");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(path.join(cfgDir, "config.yml"), "extensions:\n  - /x/combo-toggle/index.js\n", "utf8");
    const ok = await wireRtkOmp(fakeRtk(dir), { quiet: true });
    expect(ok).toBe(true);
    const cfg = readFileSync(path.join(cfgDir, "config.yml"), "utf8");
    expect(cfg).toMatch(/extensions\/rtk\.ts/);
    expect(cfg).toMatch(/combo-toggle/);
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("opencode never installs a separate rtk plugin", async () => {
  const { dir, log } = tempHome();
  try {
    expect(await wireRtkOpencode(fakeRtk(dir), {})).toBe(true);
    expect(existsSync(log), "the tersio plugin owns the rewrite").toBe(false);
    expect(await wireRtkOpencode(fakeRtk(dir), { dryRun: true })).toBe(true);
    expect(await wireRtkOpencode(path.join(dir, "absent-rtk"), {}), "no binary, no rewrite").toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The wiring only invokes rtk; prove the real hook rewrites, skipped when rtk is absent (others cover that).
const realRtk = resolveRtkBinary();

/** Wires one host against real rtk and returns its `tool_call` hook's command; omp and pi share hooks. */
async function rewiredCommand(
  wire: (bin: string, options: WiringOptions) => Promise<boolean>,
  hookPath: string[],
): Promise<{ command: string | null; registered: boolean }> {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-real-"));
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    if (!(await wire(realRtk!, { quiet: true }))) return { command: null, registered: false };

    const hook = path.join(home, ...hookPath);
    if (!existsSync(hook)) return { command: null, registered: false };

    // The generated hook is a TS module whose default export registers a `tool_call` handler.
    const ext = (await import(pathToFileURL(hook).href)).default as (pi: unknown) => Promise<void>;
    let call: { input: { command: string } } | undefined;
    let settled: Promise<unknown> | undefined;
    const api = {
      setLabel() {},
      registerCommand() {},
      registerTool() {},
      appendEntry() {},
      // The hook rewrites via `rtk rewrite`, so `exec` must accept a timeout and signal and report a kill.
      async exec(cmd: string, args: string[], opts?: { timeout?: number; signal?: AbortSignal }) {
        const { execFile } = await import("node:child_process");
        return new Promise((resolve) => {
          execFile(cmd, args, { timeout: opts?.timeout ?? 5000 }, (error, stdout) => {
            if (opts?.signal?.aborted) return resolve({ code: 1, stdout: "", killed: true });
            const raw = (error as { code?: unknown } | null)?.code;
            resolve({ code: typeof raw === "number" ? raw : 0, stdout: String(stdout || ""), killed: false });
          });
        });
      },
      on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
        if (event !== "tool_call") return;
        call = { toolName: "bash", input: { command: "grep -rn foo ." } } as unknown as { input: { command: string } };
        // The handler is async, so the mutation has to be awaited before it can be read.
        settled = Promise.resolve(handler(call, { signal: undefined }));
      },
    };
    await ext(api);
    await settled;
    return { command: call?.input.command ?? null, registered: settled !== undefined };
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const HOOK_TAIL = [".omp", "agent", "extensions", "rtk.ts"] as const;
const PI_HOOK_TAIL = [".pi", "agent", "extensions", "rtk.ts"] as const;

test.skipIf(!realRtk)("the wired omp hook rewrites a bash command", async () => {
  const wired = await rewiredCommand(wireRtkOmp, [...HOOK_TAIL]);
  expect(wired.registered, "rtk init must have written a hook that registers tool_call").toBe(true);
  expect(wired.command, "the generated hook must rewrite a bash command through rtk")
    .toBe("rtk grep -rn foo .");
});

// Same invocation, same hook, different agent directory: pi gets the same proof, not a second integration.
test.skipIf(!realRtk)("the wired pi hook rewrites a bash command", async () => {
  const wired = await rewiredCommand(wireRtkPi, [...PI_HOOK_TAIL]);
  expect(wired.registered, "rtk init must have written a hook that registers tool_call").toBe(true);
  expect(wired.command, "the generated hook must rewrite a bash command through rtk")
    .toBe("rtk grep -rn foo .");
});

// ===== rtk-platform.test.ts =====

test("resolveRtkBinary returns null when PATH has no executable", () => {
  const previous = process.env.PATH;
  process.env.PATH = path.resolve("definitely-missing-bin");
  try {
    expect(resolveRtkBinary(path.resolve("definitely-missing-bin"))).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("resolveRtkBinary falls back to the managed installer directory", () => {
  const previousPath = process.env.PATH;
  const managed = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-managed-"));
  const binary = path.join(managed, process.platform === "win32" ? "rtk.exe" : "rtk");
  writeFileSync(binary, "#!/bin/sh\necho rtk 0.50.0\n", "utf8");
  if (process.platform !== "win32") chmodSync(binary, 0o755);
  process.env.PATH = path.join(managed, "missing");
  try {
    expect(resolveRtkBinary(managed)).toBe(binary);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(managed, { recursive: true, force: true });
  }
});
test("rtkPlatformSpec returns null for unknown platforms", () => {
  expect(rtkPlatformSpec("plan9", "x64")).toBe(null);
});

// ===== rtk-tool.test.ts =====

// resolveRtkBinary checks PATH first, so each test must own PATH.
function withPath(value: string, work: () => Promise<void>): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = value;
  return work().finally(() => { process.env.PATH = previous; });
}

type Exec = (cmd: string, args: string[], opts?: { signal?: AbortSignal; cwd?: string }) => Promise<{
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}>;

type Tool = {
  name: string;
  execute: (id: string, params: { args: string[] }, signal?: AbortSignal, onUpdate?: unknown, ctx?: ExtensionCtx) => Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
};

interface Harness { tool: Tool; ctx: ExtensionCtx; events: string[]; sessionStart: () => Promise<unknown>; }

/** `exec` is optional in the API, so the harness controls whether it exists. */
function rtkToolHarness(exec?: Exec, entries: Array<{ type: string; customType: string; data: Record<string, unknown> }> = []): Harness {
  let tool: Tool | undefined;
  const handlers = new Map<string, (event: unknown, ctx: ExtensionCtx | undefined) => Promise<unknown>>();
  const chain = { min: () => chain, describe: () => chain };
  const api: Record<string, unknown> = {
    setLabel() {},
    registerCommand() {},
    registerTool(t: Tool) { tool = t; },
    appendEntry() {},
    on(event: string, handler: (event: unknown, ctx: ExtensionCtx | undefined) => Promise<unknown>) { handlers.set(event, handler); },
    zod: { z: { object: (shape: Record<string, unknown>) => shape, array: () => chain, string: () => chain } },
    cwd: "/tmp",
  };
  if (exec) api.exec = exec;
  rtkSessionExtension(api as unknown as ExtensionApi);
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: { setStatus() {}, notify() {} },
  } as ExtensionCtx;
  const sessionStart = () => handlers.get("session_start")!({}, ctx);
  return { tool: tool!, ctx, events: [...handlers.keys()], sessionStart };
}

const text = (r: { content: Array<{ text: string }> }): string => r.content.map((c) => c.text).join("\n");

test("rtk_run runs the command plainly while RTK is off", async () => {
  // The tool is the only one left when the host runs with --no-tools, so a refusal there made the model spend turns re-calling it. rtk is the condenser, never the command.
  const cmds: Array<{ cmd: string; args: string[] }> = [];
  const h = rtkToolHarness(async (cmd, args) => { cmds.push({ cmd, args }); return { stdout: "plain out", stderr: "", code: 0, killed: false }; });
  await h.sessionStart();
  const r = await h.tool.execute("1", { args: ["ls"] }, undefined, undefined, h.ctx);
  expect(r.isError).toBe(false);
  expect(text(r)).toContain("plain out");
  expect(cmds).toEqual([{ cmd: "ls", args: ["ls"] }]);
  expect(r.details?.condensed).toBe(false);
});

test("a host without exec reports it instead of throwing", async () => {
  const h = rtkToolHarness(undefined, [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
  await h.sessionStart();
  const r = await h.tool.execute("1", { args: ["ls"] }, undefined, undefined, h.ctx);
  expect(r.isError).toBe(true);
  expect(text(r)).toMatch(/cannot run rtk/);
});

test("a missing rtk binary reports the error instead of crashing the tool", async () => {
  const h = rtkToolHarness(async () => { throw new Error("spawn rtk ENOENT"); },
    [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
  await h.sessionStart();
  const r = await h.tool.execute("1", { args: ["ls"] }, undefined, undefined, h.ctx);
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("spawn rtk ENOENT");
});

test("a non-zero exit is surfaced as an error with its output", async () => {
  const h = rtkToolHarness(async () => ({ stdout: "", stderr: "bad flag", code: 2, killed: false }),
    [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
  await h.sessionStart();
  const r = await h.tool.execute("1", { args: ["--nope"] }, undefined, undefined, h.ctx);
  expect(r.isError).toBe(true);
  expect(text(r)).toContain("bad flag");
});

test("a successful run returns combined output and no error", async () => {
  const seen: string[][] = [];
  const h = rtkToolHarness(async (_cmd, args) => { seen.push(args); return { stdout: "ok", stderr: "", code: 0, killed: false }; },
    [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
  await h.sessionStart();
  const r = await h.tool.execute("1", { args: ["git", "status"] }, undefined, undefined, h.ctx);
  expect(r.isError).toBe(false);
  expect(text(r)).toBe("ok");
  expect(seen).toEqual([["git", "status"]]);
});

test("RTK no longer registers a natural-language input handler", () => {
  // "use rtk" is ordinary English; combo-toggle dropped its input hook for that reason, and RTK does too.
  expect(rtkToolHarness().events).not.toContain("input");
});

test("the tool execs the resolved rtk path, not bare `rtk`", async () => {
  // A GUI-launched host whose PATH lacks ~/.bun/bin ENOENTs on bare 'rtk'.
  await withPath("", async () => {
    const binDir = path.join(process.env.HOME as string, ".bun", "bin");
    mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, "rtk");
    writeFileSync(fake, "#!/bin/sh\necho hi\n", { mode: 0o755 });

    const cmds: string[] = [];
    const h = rtkToolHarness(async (cmd) => { cmds.push(cmd); return { stdout: "ok", stderr: "", code: 0, killed: false }; },
      [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
    await h.sessionStart();
    const r = await h.tool.execute("1", { args: ["git", "status"] }, undefined, undefined, h.ctx);

    expect(r.isError).toBe(false);
    expect(cmds).toEqual([fake]);
    rmSync(binDir, { recursive: true, force: true });
  });
});

test("rtk mode on with no installed binary reports it instead of guessing", async () => {
  await withPath("", async () => {
    const cmds: string[] = [];
    const h = rtkToolHarness(async (cmd) => { cmds.push(cmd); return { stdout: "ok", stderr: "", code: 0, killed: false }; },
      [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
    await h.sessionStart();
    const r = await h.tool.execute("1", { args: ["ls"] }, undefined, undefined, h.ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/rtk binary is not installed/);
    expect(cmds).toEqual([]);
  });
});


// A late subagent registers its listener late, so it keeps the session default and needs shared state.
test("rtk_run uses shared state when a late subagent's own flag is off", async () => {
  resetSharedComboState();
  const binDir = path.join(process.env.HOME as string, ".bun", "bin");
  await withPath("", async () => {
    mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, "rtk");
    writeFileSync(fake, "#!/bin/sh\necho hi\n", { mode: 0o755 });
    setSharedComboMode("rtk", "on");
    const cmds: string[] = [];
    // No session_start: this instance's own flag is still its start-up default.
    const sub = rtkToolHarness(async (cmd) => { cmds.push(cmd); return { stdout: "ok", stderr: "", code: 0, killed: false }; });

    const r = await sub.tool.execute("1", { args: ["git", "status"] }, undefined, undefined, sub.ctx);

    expect(r.isError).toBe(false);
    expect(cmds, "shared state turned rtk on, so the resolved path runs").toEqual([fake]);
    expect(r.details?.condensed).toBe(true);
    resetSharedComboState();
    rmSync(binDir, { recursive: true, force: true });
  });
});

test("rtk mode off with no shared state still runs the command plainly", async () => {
  resetSharedComboState();
  await withPath("", async () => {
    setSharedComboMode("rtk", "off");
    const cmds: string[] = [];
    const h = rtkToolHarness(async (cmd) => { cmds.push(cmd); return { stdout: "ok", stderr: "", code: 0, killed: false }; });

    const r = await h.tool.execute("1", { args: ["git", "status"] }, undefined, undefined, h.ctx);

    expect(r.isError).toBe(false);
    expect(cmds, "the command runs uncondensed, not through rtk").toEqual(["git"]);
    resetSharedComboState();
  });
});

// ===== find-file.test.ts =====

function fixture(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-find-"));
  mkdirSync(path.join(dir, "nested", "deep"), { recursive: true });
  writeFileSync(path.join(dir, "nested", "deep", "rtk"), "bin");
  writeFileSync(path.join(dir, "README.md"), "docs");
  return dir;
}

test("findFile locates a nested binary by exact name", async () => {
  const dir = fixture();
  try {
    expect(await findFile(dir, "rtk")).toBe(path.join(dir, "nested", "deep", "rtk"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findFile skips doc files when matching rtk-like names", async () => {
  const dir = fixture();
  try {
    expect(await findFile(dir, "README.md")).toBe(path.join(dir, "README.md"));
    expect(await findFile(dir, "missing")).toBe(null);
    expect(await findFile("/nonexistent-tersio-dir", "rtk")).toBe(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===== timing.test.ts =====

type timingHandler = (event: unknown, ctx: unknown) => unknown;

function fakeHost(): { handlers: Map<string, timingHandler[]>; fire: (name: string, event: unknown) => Promise<void> } {
  const handlers = new Map<string, timingHandler[]>();
  const pi = {
    hostId: "pi",
    on(event: string, handler: timingHandler) {
      (handlers.get(event) ?? handlers.set(event, []).get(event)!).push(handler);
    },
  };
  timingExtension(pi as never);
  return {
    handlers,
    async fire(name, event) {
      for (const handler of handlers.get(name) ?? []) await handler(event, {});
    },
  };
}

const assistant = (timestamp: number): { role: string; timestamp: number; ttft?: number } => ({ role: "assistant", timestamp });

test("the first token gap is stamped onto the message", async () => {
  const { fire } = fakeHost();
  const started = 1_700_000_000_000;
  const message = assistant(started);
  await fire("message_start", { message });
  // `start` opens the stream with no token yet, so it must not count as the first one.
  await fire("message_update", { message, assistantMessageEvent: { type: "start" } });
  expect(message.ttft, "a bare start is not a token").toBeUndefined();
  await fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "h" } });
  await fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "i" } });
  await fire("message_end", { message });
  expect(message.ttft, "the first delta sets the latency").toBeGreaterThan(0);
});

test("a host that recorded its own latency keeps it", async () => {
  const { fire } = fakeHost();
  const message = { ...assistant(1_700_000_000_000), ttft: 42 };
  await fire("message_start", { message });
  await fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "x" } });
  await fire("message_end", { message });
  expect(message.ttft, "the host's own value wins").toBe(42);
});

test("a message with no first token records nothing", async () => {
  const { fire } = fakeHost();
  const message = assistant(1_700_000_000_000);
  await fire("message_start", { message });
  await fire("message_end", { message });
  expect(message.ttft, "no token means no latency, never zero").toBeUndefined();
});

test("non-assistant messages are left alone", async () => {
  const { fire } = fakeHost();
  const message: { role: string; timestamp: number; ttft?: number } = { role: "toolResult", timestamp: 1_700_000_000_000 };
  await fire("message_start", { message });
  await fire("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "x" } });
  await fire("message_end", { message });
  expect(message.ttft).toBeUndefined();
});
