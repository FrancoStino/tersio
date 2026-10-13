// The pstack rigor mode. It rides no preset, so only the command or its own stored default turns it on.
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pstackSessionExtension from "../../extensions/pstack/index.ts";
import comboToggleExtension from "../../extensions/combo/index.ts";
import { getSharedComboState, resetSharedComboState } from "../../extensions/shared/session-state.ts";
import type { ExtensionApi, ExtensionCtx, SessionEntry } from "../../extensions/shared/types.ts";

process.env.HOME = new URL("../definitely-missing-home", import.meta.url).pathname;
process.env.TERSIO_HOME = process.env.HOME;

const BODY = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extensions", "pstack", "rule.md"),
  "utf8",
);

type CommandHandler = (args: string, ctx: ExtensionCtx) => Promise<void>;
type EventHandler = (event: never, ctx?: ExtensionCtx) => Promise<unknown>;

interface TestPi {
  commands: Map<string, CommandHandler>;
  handlers: Map<string, EventHandler>;
  zod: unknown;
  setLabel(): void;
  registerCommand(name: string, config: { handler: CommandHandler }): void;
  on(event: string, handler: EventHandler): void;
  appendEntry(customType: string, data: Record<string, unknown>): void;
}

function instantiate(factory: (pi: ExtensionApi) => void, entries: SessionEntry[] = []): TestPi {
  const commands = new Map<string, CommandHandler>();
  const handlers = new Map<string, EventHandler>();
  const pi: TestPi = {
    commands,
    handlers,
    // Present `zod` marks this as the OMP host, so the adapter treats `systemPrompt` as an array.
    zod: { z: { object: (shape: unknown) => shape } },
    setLabel() { },
    registerCommand(name, config) { commands.set(name, config.handler); },
    on(event, handler) { handlers.set(event, handler); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  factory(pi as unknown as ExtensionApi);
  return pi;
}

interface Harness {
  statuses: string[];
  notices: string[];
  ctx: ExtensionCtx;
}

function context(entries: SessionEntry[] = []): Harness {
  const statuses: string[] = [];
  const notices: string[] = [];
  const ctx = {
    hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (message: string) => { notices.push(message); },
      setStatus: (_name: string, value?: string) => { if (value !== undefined) statuses.push(value); },
    },
  } as unknown as ExtensionCtx;
  return { statuses, notices, ctx };
}

async function inject(pi: TestPi, ctx: ExtensionCtx): Promise<string> {
  const event = { systemPrompt: ["BASE"] };
  const result = await pi.handlers.get("before_agent_start")!(event as never, ctx) as { systemPrompt?: string[] } | undefined;
  return (result?.systemPrompt ?? event.systemPrompt).join("\n");
}

test("/pstack on reaches the prompt body and the footer names the mode", async () => {
  resetSharedComboState();
  const entries: SessionEntry[] = [];
  const pi = instantiate(pstackSessionExtension, entries);
  const { statuses, ctx } = context(entries);

  await pi.commands.get("pstack")!("on", ctx);

  expect(statuses.at(-1)).toBe("🧩 combo CUSTOM: 🪨caveman=OFF ⚡rtk=OFF 🦥ponytail=OFF 🥔pstack=ON");
  expect(await inject(pi, ctx)).toContain(BODY);
});

test("/pstack off clears the footer and stops injecting", async () => {
  resetSharedComboState();
  const entries: SessionEntry[] = [];
  const pi = instantiate(pstackSessionExtension, entries);
  const { statuses, ctx } = context(entries);

  await pi.commands.get("pstack")!("on", ctx);
  await pi.commands.get("pstack")!("off", ctx);

  expect(statuses.at(-1)).toBe("🧩 combo OFF");
  expect(await inject(pi, ctx)).not.toContain(BODY);
});

test("an unknown pstack level warns and leaves the mode alone", async () => {
  resetSharedComboState();
  const entries: SessionEntry[] = [];
  const pi = instantiate(pstackSessionExtension, entries);
  const { notices, ctx } = context(entries);

  await pi.commands.get("pstack")!("loud", ctx);

  expect(notices.at(-1)).toBe("Usage: /pstack [on|off|status]");
  expect(getSharedComboState().pstack).toBe("off");
});

test("a stored pstack entry restores the mode on a new session", async () => {
  resetSharedComboState();
  const entries: SessionEntry[] = [{ type: "custom", customType: "pstack-mode", data: { mode: "on" } }];
  const pi = instantiate(pstackSessionExtension, entries);

  await pi.handlers.get("session_start")!({} as never, context(entries).ctx);

  expect(getSharedComboState().pstack).toBe("on");
});

// The opt-in contract: no preset turns pstack on, and a preset turns it back off.
test("a combo preset clears pstack, so the level never overstates the modes", async () => {
  resetSharedComboState();
  const entries: SessionEntry[] = [];
  const pstack = instantiate(pstackSessionExtension, entries);
  await pstack.commands.get("pstack")!("on", context(entries).ctx);
  expect(getSharedComboState().pstack).toBe("on");

  const combo = instantiate(comboToggleExtension, entries);
  const { statuses, ctx } = context(entries);
  await combo.commands.get("combo")!("balanced", ctx);

  expect(getSharedComboState().pstack).toBe("off");
  expect(statuses.at(-1)).toBe("🧩 combo BALANCED: 🪨caveman=FULL ⚡rtk=ON 🦥ponytail=FULL 🥔pstack=OFF");
});
