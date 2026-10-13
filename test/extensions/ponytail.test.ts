import { expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import comboToggleExtension from "../../extensions/combo/index.ts";
import {
  OMP_SUBAGENT_MARKER,
  resetSharedComboState,
  setSharedComboMode,
} from "../../extensions/shared/session-state.ts";
import type { ExtensionApi, ExtensionCtx } from "../../extensions/shared/types.ts";

process.env.HOME = new URL("../definitely-missing-home", import.meta.url).pathname;
process.env.USERPROFILE = process.env.HOME;

type EventHandler = (event: unknown, ctx: ExtensionCtx | undefined) => Promise<unknown>;

function injectHandler(): EventHandler {
  let handler!: EventHandler;
  comboToggleExtension({
    // The injected zod is how the extensions recognise an OMP host.
    zod: { z: {} },
    setLabel() {},
    registerCommand() {},
    registerTool() {},
    appendEntry() {},
    on(event: string, h: EventHandler) { if (event === "before_agent_start") handler = h; },
  } as unknown as ExtensionApi);
  return handler;
}

async function injectMarked(ponytail: string): Promise<string> {
  resetSharedComboState();
  setSharedComboMode("ponytail", ponytail);
  const result = await injectHandler()({ systemPrompt: `Base.\n${OMP_SUBAGENT_MARKER}` }, undefined);
  const prompt = (result as { systemPrompt?: string[] } | undefined)?.systemPrompt;
  return prompt?.at(-1) ?? "";
}


test("a marked subagent prompt gets the installed ponytail instructions", async () => {
  // Ponytail is a Tersio dependency, so the package resolves beside the extension in every install layout.
  expect(await injectMarked("ultra")).toMatch(/# Ponytail/);
  expect(await injectMarked("ultra")).toMatch(/PONYTAIL MODE ACTIVE — level: ultra/);
});

test("existing ponytail guidance is not duplicated", async () => {
  resetSharedComboState();
  setSharedComboMode("ponytail", "ultra");
  const result = await injectHandler()(
    { systemPrompt: [OMP_SUBAGENT_MARKER, "PONYTAIL MODE ACTIVE — level: ultra"] },
    undefined,
  );
  expect(result).toBe(undefined);
});

test("review is not a runtime mode", async () => {
  expect(await injectMarked("review")).toBe("");
});

async function inject(prompt: string): Promise<string | undefined> {
  const result = await injectHandler()({ systemPrompt: prompt }, undefined);
  return (result as { systemPrompt?: string[] } | undefined)?.systemPrompt?.at(-1);
}

test("off mode gets no injection, on mode gets it on any turn", async () => {
  resetSharedComboState();
  setSharedComboMode("ponytail", "off");
  expect(await inject(`Base.\n${OMP_SUBAGENT_MARKER}`)).toBe(undefined);
  expect(await inject("Base.")).toBe(undefined);

  // Main sessions count now: ponytail used to need a subagent marker, so it never fired on the user's turn.
  resetSharedComboState();
  setSharedComboMode("ponytail", "ultra");
  expect(await inject("Base.")).toMatch(/PONYTAIL MODE ACTIVE/);
  expect(await inject(`Base.\n${OMP_SUBAGENT_MARKER}`)).toMatch(/PONYTAIL MODE ACTIVE/);
});

// The header is the only level-specific text; YAGNI appears in every level.
test("each level injects its own header", async () => {
  for (const level of ["lite", "full", "ultra"] as const) {
    const text = await injectMarked(level);
    expect(text, `level ${level}`).toMatch(new RegExp(`PONYTAIL MODE ACTIVE — level: ${level}`));
  }
});

test("ponytail reaches a subagent that the marker does not recognise", async () => {
  // Ponytail reads shared state with no marker check, so it survives drift.
  resetSharedComboState();
  setSharedComboMode("ponytail", "ultra");
  const drifted = "Some entirely different subagent wording after a host update.";
  expect(await inject(drifted)).toMatch(/PONYTAIL MODE ACTIVE/);
});

// The block a previous level added is ours, so a switch replaces it, never stacks.
function promptOf(result: unknown): string[] {
  if (result && typeof result === "object" && "systemPrompt" in result) {
    const value = result.systemPrompt;
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
  }
  return [];
}

test("a level switch replaces the previous level's block", async () => {
  resetSharedComboState();
  const handler = injectHandler();
  setSharedComboMode("ponytail", "ultra");
  const first = promptOf(await handler({ systemPrompt: "Base." }, undefined));

  setSharedComboMode("ponytail", "lite");
  const joined = promptOf(await handler({ systemPrompt: first }, undefined)).join("\n");

  expect(joined).toMatch(/level: lite/);
  expect(joined).not.toMatch(/level: ultra/);
});

// pi defers to upstream only when installed; with no ponytail package in its settings it injected nothing.
test("pi without an upstream ponytail gets the built-in fallback", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-pi-nopony-"));
  const prevPi = process.env.PI_CODING_AGENT;
  const prevHome = process.env.HOME;
  try {
    // A HOME with no pi agent dir at all: nothing is declared and nothing is on disk.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PI_CODING_AGENT = "true";
    resetSharedComboState();
    setSharedComboMode("ponytail", "full");
    const result = await injectHandler()({ systemPrompt: "Base." }, undefined);
    const prompt = (result as { systemPrompt?: string[] } | undefined)?.systemPrompt;
    expect(prompt?.at(-1)).toMatch(/PONYTAIL MODE ACTIVE/);
  } finally {
    if (prevPi === undefined) delete process.env.PI_CODING_AGENT; else process.env.PI_CODING_AGENT = prevPi;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// With upstream installed, pi still defers: Tersio must not double-inject.
test("pi with an upstream ponytail defers to it", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-pi-pony-"));
  const prevPi = process.env.PI_CODING_AGENT;
  const prevHome = process.env.HOME;
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const agent = path.join(home, ".pi", "agent");
    mkdirSync(agent, { recursive: true });
    writeFileSync(
      path.join(agent, "settings.json"),
      JSON.stringify({ packages: [path.join(home, ".pi", "agent", "ponytail")] }),
      "utf8",
    );
    process.env.PI_CODING_AGENT = "true";
    resetSharedComboState();
    setSharedComboMode("ponytail", "full");
    const result = await injectHandler()({ systemPrompt: "Base." }, undefined);
    expect((result as { systemPrompt?: string[] } | undefined)?.systemPrompt).toBeUndefined();
  } finally {
    if (prevPi === undefined) delete process.env.PI_CODING_AGENT; else process.env.PI_CODING_AGENT = prevPi;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});
