import { expect, test } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import plugin from "../../extensions/server.ts";

/** The repo root, so a rule body can be read from the file the extension reads. */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");

// The bash rewrite shells out to the rtk on PATH, so each test owns PATH and HOME.
async function withFakeRtk(script: string | null, work: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-oc-rtk-"));
  const previous = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    if (script !== null) {
      const rtk = path.join(bin, "rtk");
      writeFileSync(rtk, script, "utf8");
      chmodSync(rtk, 0o755);
    }
    process.env.PATH = bin;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    await work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeCtx(): {
  ctx: unknown;
  hooks: Record<string, Array<(event: never) => unknown>>;
  commands: Map<string, { execute: (input: never) => Promise<void> }>;
  prompts: Array<{ sessionID: string; text: string }>;
  store: Map<string, unknown>;
  skills: Array<{ id: string; name: string; description: string; path: string; content: string }>;
} {
  const hooks: Record<string, Array<(event: never) => unknown>> = {};
  const commands = new Map<string, { execute: (input: never) => Promise<void> }>();
  const prompts: Array<{ sessionID: string; text: string }> = [];
  const store = new Map<string, unknown>();
  const skills: Array<{ id: string }> = [];
  const ctx = {
    storage: {
      get: async (key: string): Promise<unknown> => store.get(key),
      set: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
    },
    location: { directory: path.join(os.tmpdir(), "tersio-oc-work") },
    command: {
      transform: async (fn: (editor: { add: (cmd: never) => void }) => void): Promise<void> => {
        fn({ add: (cmd: never) => commands.set((cmd as { name: string }).name, cmd as never) });
      },
    },
    skill: {
      transform: async (fn: (editor: { add: (skill: never) => void }) => void): Promise<void> => {
        fn({ add: (skill: never) => skills.push(skill as never) });
      },
    },
    tool: {
      transform: async (): Promise<void> => {},
      hook: async (name: string, fn: (event: never) => unknown): Promise<void> => {
        (hooks[name] ??= []).push(fn);
      },
    },
    session: {
      hook: async (name: string, fn: (event: never) => unknown): Promise<void> => {
        (hooks[name] ??= []).push(fn);
      },
      prompt: async (req: { sessionID: string; text: string }): Promise<void> => {
        prompts.push(req);
      },
    },
  };
  return { ctx, hooks, commands, prompts, store, skills };
}

async function fire(hooks: Record<string, Array<(event: never) => unknown>>, name: string, event: unknown): Promise<void> {
  for (const fn of hooks[name] ?? []) await fn(event as never);
}

// The fake host implements only what the mode extensions touch, so it cannot wear the real Context type.
function setup(ctx: unknown): Promise<void> {
  return (plugin as unknown as { setup(c: unknown): Promise<void> }).setup(ctx);
}

async function runCommand(
  commands: Map<string, { execute: (input: never) => Promise<void> }>,
  prompts: Array<{ sessionID: string; text: string }>,
  sid: string,
  text: string,
): Promise<string> {
  const combo = commands.get("combo");
  expect(combo, "combo command registered").toBeDefined();
  await combo?.execute({ sessionID: sid, prompt: { text } } as never);
  expect(prompts.length).toBeGreaterThan(0);
  return prompts[prompts.length - 1].text;
}

// A plugin dir gets no node_modules walk, so the ruleset ships beside the entry and must be found from there.
test("the opencode entry registers the bundled ponytail skills", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-oc-skills-"));
  const prevHome = process.env.TERSIO_HOME;
  try {
    process.env.TERSIO_HOME = path.join(home, ".tersio");
    mkdirSync(process.env.TERSIO_HOME, { recursive: true });
    // The installer writes this beside the entry; the test seeds it where the entry resolves it from.
    const bundle = path.join(root, "extensions", "ponytail-bundle", "skills");
    mkdirSync(bundle, { recursive: true });
    const names = ["ponytail", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help", "ponytail-review"];
    for (const name of names) {
      mkdirSync(path.join(bundle, name), { recursive: true });
      writeFileSync(
        path.join(bundle, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: >\n  A bundled skill for the ${name} command.\n  Wrapped the way upstream writes it.\n---\n\nBODY FOR ${name}.\n`,
        "utf8",
      );
    }
    const { ctx, skills } = fakeCtx();
    await setup(ctx);

    expect(skills.map((skill) => skill.id).sort()).toEqual([...names].sort());
    for (const skill of skills) {
      // A folded description that leaked its marker or newline reads to the model as a truncated one.
      expect(skill.description, `${skill.id} description is one line`).not.toMatch(/[\n>]/);
      expect(skill.description, `${skill.id} description is non-empty`).toContain("bundled skill");
      expect(skill.content, `${skill.id} carries its body`).toContain(`BODY FOR ${skill.id}`);
    }
  } finally {
    rmSync(path.join(root, "extensions", "ponytail-bundle"), { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.TERSIO_HOME;
    else process.env.TERSIO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// Unseen session IDs restore their own entries, or fall back to the default.
test("opencode sessions restore modes independently", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-oc-home-"));
  const prevHome = process.env.TERSIO_HOME;
  try {
    process.env.TERSIO_HOME = path.join(home, ".tersio");
    mkdirSync(process.env.TERSIO_HOME, { recursive: true });
    writeFileSync(
      path.join(process.env.TERSIO_HOME, "settings.json"),
      JSON.stringify({ comboDefault: "balanced", cavemanDefault: "full", rtkDefault: true, ponytailDefault: "full", pstackDefault: "on" }),
      "utf8",
    );
    const { ctx, hooks, commands, prompts, store } = fakeCtx();
    await setup(ctx);

    await fire(hooks, "prompt", { sessionID: "ses-a", prompt: { text: "hi" } });
    const offReply = await runCommand(commands, prompts, "ses-a", "/combo off");
    expect(offReply).toMatch(/OFF/);

    await fire(hooks, "prompt", { sessionID: "ses-b", prompt: { text: "hi" } });
    const statusReply = await runCommand(commands, prompts, "ses-b", "/combo status");
    expect(statusReply).toMatch(/BALANCED/);

    const lastLevel = (key: string): string | undefined => {
      const all = ((store.get(key) ?? []) as Array<{ customType?: string; data?: { level?: string } }>)
        .filter((e) => e.customType === "combo-level")
        .map((e) => String(e.data?.level));
      return all[all.length - 1];
    };
    expect(lastLevel("entries:ses-a")).toBe("off");
    expect(lastLevel("entries:ses-b")).toBe("balanced");
  } finally {
    if (prevHome === undefined) delete process.env.TERSIO_HOME;
    else process.env.TERSIO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// rtk ships no OpenCode plugin of its own, so this hook is the whole integration.
test("the bash hook rewrites a command through the resolved rtk binary", async () => {
  await withFakeRtk("#!/bin/sh\necho \"rtk compact $2\"\n", async () => {
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const event = { tool: "bash", input: { command: "git status" } };
    await fire(hooks, "execute.before", event);
    expect(event.input.command).toBe("rtk compact git status");
  });
});

// The after-hook is the only surface for built-in grep and glob output, and it must mutate in place.
test("the after hook condenses a large grep result and leaves the rest untouched", async () => {
  const big = `src/a.ts:1:${"a line of grep output \n".repeat(120)}`;
  await withFakeRtk("#!/bin/sh\necho '2 matches in 1F:'\n", async () => {
    const { ctx, hooks, store } = fakeCtx();
    await setup(ctx);
    store.set("entries:ses-on", [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
    store.set("entries:ses-off", [{ type: "custom", customType: "rtk-mode", data: { enabled: false } }]);

    const hit = { tool: "grep", status: "completed", sessionID: "ses-on", result: { content: [{ type: "text", text: big }] } };
    await fire(hooks, "execute.after", hit);
    expect(hit.result.content).toEqual([{ type: "text", text: "2 matches in 1F:\n" }]);

    // An error carries no result, so there is nothing to replace.
    const failed = { tool: "grep", status: "error", sessionID: "ses-on", error: { message: "boom" } };
    await fire(hooks, "execute.after", failed);
    expect(failed).not.toHaveProperty("result");

    // A small result stays byte for byte: the spawn would cost more than it saves.
    const small = { tool: "grep", status: "completed", sessionID: "ses-on", result: { content: [{ type: "text", text: "one hit" }] } };
    await fire(hooks, "execute.after", small);
    expect(small.result.content).toEqual([{ type: "text", text: "one hit" }]);

    const other = { tool: "read", status: "completed", sessionID: "ses-on", result: { content: [{ type: "text", text: big }] } };
    await fire(hooks, "execute.after", other);
    expect(other.result.content).toEqual([{ type: "text", text: big }]);

    // A session with rtk off keeps its output, so the mode is per session.
    const off = { tool: "glob", status: "completed", sessionID: "ses-off", result: { content: [{ type: "text", text: big }] } };
    await fire(hooks, "execute.after", off);
    expect(off.result.content).toEqual([{ type: "text", text: big }]);
  });
});

test("the after hook keeps the original when rtk is absent", async () => {
  const big = "x".repeat(2000);
  await withFakeRtk(null, async () => {
    const { ctx, hooks, store } = fakeCtx();
    await setup(ctx);
    store.set("entries:ses-on", [{ type: "custom", customType: "rtk-mode", data: { enabled: true } }]);
    const event = { tool: "glob", status: "completed", sessionID: "ses-on", result: { content: [{ type: "text", text: big }] } };
    await fire(hooks, "execute.after", event);
    expect(event.result.content).toEqual([{ type: "text", text: big }]);
  });
});

test("the bash hook leaves other tools and rtk-less hosts alone", async () => {
  await withFakeRtk("#!/bin/sh\necho \"rtk compact $2\"\n", async () => {
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const other = { tool: "read", input: { command: "git status" } };
    await fire(hooks, "execute.before", other);
    expect(other.input.command).toBe("git status");
  });

  await withFakeRtk(null, async () => {
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);
    const bash = { tool: "bash", input: { command: "git status" } };
    await fire(hooks, "execute.before", bash);
    expect(bash.input.command).toBe("git status");
  });
});

// OpenCode shares the omp extension code, so the mode bodies must land here too; nothing asserted it before.
test("the context hook injects the Caveman, Ponytail, and RTK bodies", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-oc-inject-"));
  const prevHome = process.env.TERSIO_HOME;
  try {
    process.env.TERSIO_HOME = path.join(home, ".tersio");
    mkdirSync(process.env.TERSIO_HOME, { recursive: true });
    writeFileSync(
      path.join(process.env.TERSIO_HOME, "settings.json"),
      JSON.stringify({ cavemanDefault: "full", ponytailDefault: "full", rtkDefault: true, comboDefault: "off" }),
      "utf8",
    );
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);

    const event = { sessionID: "ses-inject", system: [{ type: "text", text: "BASE" }] };
    await fire(hooks, "context", event);
    const joined = event.system.map((part) => part.text).join("\n");

    // The Caveman body is the rule file itself, byte for byte, so it tracks upstream exactly.
    const rule = readFileSync(
      path.join(root, "extensions", "caveman", "rule.md"),
      "utf8",
    );
    expect(joined).toContain(rule);
    // Ponytail comes from the hoisted package, not from the built-in fallback.
    expect(joined).toMatch(/PONYTAIL MODE ACTIVE — level: full/);
    expect(joined).toMatch(/RTK guidance active/);
    // The base prompt is untouched and nothing is injected twice.
    expect(event.system[0].text).toBe("BASE");
    const occurrences = joined.split(rule).length - 1;
    expect(occurrences, "the rule body appears exactly once").toBe(1);
  } finally {
    if (prevHome === undefined) delete process.env.TERSIO_HOME;
    else process.env.TERSIO_HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// Ponytail is the one add-on the plugin does not own on pi: upstream's pi extension writes it.
test("the context hook skips Ponytail on a pi host and keeps the rest", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-oc-pi-"));
  const prevHome = process.env.TERSIO_HOME;
  const prevPi = process.env.PI_CODING_AGENT;
  const prevPiDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.TERSIO_HOME = path.join(home, ".tersio");
    mkdirSync(process.env.TERSIO_HOME, { recursive: true });
    writeFileSync(
      path.join(process.env.TERSIO_HOME, "settings.json"),
      JSON.stringify({ cavemanDefault: "full", ponytailDefault: "full", rtkDefault: true, comboDefault: "off" }),
      "utf8",
    );
    process.env.PI_CODING_AGENT = "true";
    // The skip needs the marker on disk, so pin the agent dir. Reading the real one
    // made this test pass only where an upstream extension happened to be installed.
    process.env.PI_CODING_AGENT_DIR = path.join(home, "pi-agent");
    mkdirSync(path.join(process.env.PI_CODING_AGENT_DIR, "ponytail", "pi-extension"), { recursive: true });
    writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR, "ponytail", "pi-extension", "index.js"),
      "// upstream marker\n",
      "utf8",
    );
    const { ctx, hooks } = fakeCtx();
    await setup(ctx);

    const event = { sessionID: "ses-pi", system: [{ type: "text", text: "BASE" }] };
    await fire(hooks, "context", event);
    const joined = event.system.map((part) => part.text).join("\n");

    const rule = readFileSync(path.join(root, "extensions", "caveman", "rule.md"), "utf8");
    expect(joined).toContain(rule);
    expect(joined).toMatch(/RTK guidance active/);
    expect(joined).not.toMatch(/PONYTAIL MODE ACTIVE/);
  } finally {
    if (prevHome === undefined) delete process.env.TERSIO_HOME;
    else process.env.TERSIO_HOME = prevHome;
    if (prevPi === undefined) delete process.env.PI_CODING_AGENT;
    else process.env.PI_CODING_AGENT = prevPi;
    if (prevPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevPiDir;
    rmSync(home, { recursive: true, force: true });
  }
});
