// The omp models.yml route: each provider with a baseUrl gets its own gateway instance, the file's
// baseUrl line moves to that instance, and unroute puts the original line back byte for byte. The
// fake headroom binary serves /health so readiness is real and logs argv so the spawn contract holds.
import { afterAll, beforeAll, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ompProvidersFromYml, routeHost, routedHosts, stopHeadroomProxy, unrouteHost } from "../../cli/headroom-route.ts";

const homes: string[] = [];

// A live gateway on 8787 (a real routed machine) must not collide with the fake instances.
beforeAll(() => {
  process.env.TERSIO_HEADROOM_PORT = "18800";
});

afterAll(() => {
  delete process.env.TERSIO_HEADROOM_PORT;
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-omp-route-"));
  homes.push(home);
  return home;
}

/** A models.yml shaped like omp writes it: a local provider with models, plus one built-in entry. */
const MODELS_YML = `providers:
  magpie:
    api: openai-completions
    auth: none
    baseUrl: http://127.0.0.1:3425/v1
    headers:
      User-Agent: omp
    models:
      - contextWindow: 1048576
        id: auto/beam-free
        maxTokens: 131072
        name: Beam 1.0 (free)
        reasoning: true
  builtin:
    apiKey: FROM_ENV
    api: openai-responses
    models:
      - id: builtin-large
        baseUrl: https://api.example.com/v2
`;

function writeModels(home: string, body = MODELS_YML): string {
  const dir = path.join(home, ".omp", "agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "models.yml");
  writeFileSync(file, body, "utf8");
  return file;
}

/** A fake headroom binary: binds --port, answers /health, and appends its argv for the spawn contract. */
function fakeHeadroom(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, "headroom");
  const log = path.join(dir, "argv.log");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const http = require("node:http");
const port = Number(args[args.indexOf("--port") + 1]);
http.createServer((q, s) => { s.writeHead(200, { "content-type": "application/json" }); s.end("{}"); }).listen(port, "127.0.0.1");
`, { mode: 0o755 });
  return log;
}

function withFakePath(home: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = `${path.join(home, "bin")}:${previous ?? ""}`;
  return run().finally(() => { process.env.PATH = previous; });
}

test("ompProvidersFromYml reads each provider's own baseUrl and ignores a model-level one", () => {
  const home = tempHome();
  writeModels(home);
  const providers = ompProvidersFromYml(home);
  expect(providers).toEqual([
    { provider: "magpie", baseUrl: "http://127.0.0.1:3425/v1" },
    { provider: "builtin", baseUrl: null },
  ]);
});

// The instance tests spawn the fake gateway: a POSIX script a Windows spawn cannot exec, so they
// run everywhere the fake can. The yml rewrite assertions inside them are platform-independent,
// and the refusal tests below cover the Windows path.
test.skipIf(process.platform === "win32")("routing omp points the provider at its gateway and starts the instance on the original upstream", async () => {
  const home = tempHome();
  const file = writeModels(home);
  const argvLog = fakeHeadroom(path.join(home, "bin"));
  await withFakePath(home, async () => {
    const result = await routeHost(home, "omp", { openai: "http://127.0.0.1:8787/v1", anthropic: "http://127.0.0.1:8787" });
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toContain("routed magpie");
    expect(result.detail).toContain("skipped builtin");
    const body = readFileSync(file, "utf8");
    expect(body).toContain("baseUrl: http://127.0.0.1:18800/v1");
    expect(body).not.toContain("http://127.0.0.1:3425/v1");
    // Everything else in the file survives the rewrite.
    expect(body).toContain("id: auto/beam-free");
    expect(body).toContain("baseUrl: https://api.example.com/v2");
    const spawns = readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(spawns[0]).toEqual(["proxy", "--port", "18800", "--openai-api-url", "http://127.0.0.1:3425/v1"]);
    expect(routedHosts(home)).toContain("omp");
  });
  expect(stopHeadroomProxy(home).ok).toBe(true);
}, 60_000);

test.skipIf(process.platform === "win32")("routing twice is idempotent, and unroute restores the original baseUrl exactly", async () => {
  const home = tempHome();
  const file = writeModels(home);
  fakeHeadroom(path.join(home, "bin"));
  await withFakePath(home, async () => {
    expect((await routeHost(home, "omp", { openai: "http://127.0.0.1:8787/v1", anthropic: "http://127.0.0.1:8787" })).ok).toBe(true);
    const second = await routeHost(home, "omp", { openai: "http://127.0.0.1:8787/v1", anthropic: "http://127.0.0.1:8787" });
    expect(second.detail).toContain("already routed");
    const unrouted = unrouteHost(home, "omp");
    expect(unrouted.ok).toBe(true);
    // The restored file matches the original bytes, so a later omp session reads what it wrote.
    expect(readFileSync(file, "utf8")).toBe(MODELS_YML);
    expect(routedHosts(home)).not.toContain("omp");
    expect(readFileSync(path.join(home, ".tersio", "headroom-proxy.json"), "utf8")).toContain('"pid": null');
  });
}, 60_000);

test("routing omp refuses when no models.yml exists and when no provider declares a baseUrl", async () => {
  const missing = tempHome();
  const refused = await routeHost(missing, "omp", { openai: "http://127.0.0.1:8787/v1", anthropic: "http://127.0.0.1:8787" });
  expect(refused.ok).toBe(false);
  expect(refused.detail).toContain("no ~/.omp/agent/models.yml");

  const bare = tempHome();
  writeModels(bare, "providers:\n  builtin:\n    apiKey: FROM_ENV\n    api: openai-responses\n");
  const noUpstream = await routeHost(bare, "omp", { openai: "http://127.0.0.1:8787/v1", anthropic: "http://127.0.0.1:8787" });
  expect(noUpstream.ok).toBe(false);
  expect(noUpstream.detail).toContain("no provider in models.yml declares a baseUrl");
});

test("a models.json host still routes first-party providers and refuses all-custom sets", async () => {
  const home = tempHome();
  const dir = path.join(home, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "models.json");
  writeFileSync(file, JSON.stringify({ providers: { anthropic: { baseUrl: "https://api.anthropic.com" }, mine: { baseUrl: "https://custom.example/v1" } } }), "utf8");
  const routed = await routeHost(home, "pi", { openai: "http://127.0.0.1:8787/v1", anthropic: "http://127.0.0.1:8787" });
  expect(routed.ok, routed.detail).toBe(true);
  expect(routed.detail).toContain("skipped custom: mine");
  const body = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, { baseUrl?: string }> };
  expect(body.providers.anthropic.baseUrl).toBe("http://127.0.0.1:8787/v1");
  expect(body.providers.mine.baseUrl).toBe("https://custom.example/v1");

  const customHome = tempHome();
  const customDir = path.join(customHome, ".pi", "agent");
  mkdirSync(customDir, { recursive: true });
  writeFileSync(path.join(customDir, "models.json"), JSON.stringify({ providers: { mine: { baseUrl: "https://custom.example/v1" } } }), "utf8");
  const refused = await routeHost(customHome, "pi", { openai: "http://127.0.0.1:8787/v1", anthropic: "http://127.0.0.1:8787" });
  expect(refused.ok).toBe(false);
  expect(refused.detail).toContain("every provider is custom");
  expect(existsSync(path.join(customHome, ".tersio", "headroom-routes.json"))).toBe(false);
});
