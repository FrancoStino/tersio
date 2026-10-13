import { expect, test } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { wireRtkOmp, wireRtkOpencode, wireRtkPi, type WiringOptions } from "../../cli/rtk-wiring.ts";
import { resolveRtkBinary } from "../../extensions/shared/utils.ts";

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
