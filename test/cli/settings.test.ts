import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { cliEnv } from "../helpers/env.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installer = path.join(root, "dist", "tersio.js");

function writeLock(home: string, settings: Record<string, unknown>): void {
  const dir = path.join(home, ".tersio");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings), "utf8");
}

function readLock(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, ".tersio", "settings.json"), "utf8")) as Record<string, unknown>;
}

test("settings --dry-run previews without writing", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, {
      comboDefault: "off",
      cavemanDefault: "off",
      rtkDefault: false,
      ponytailDefault: "off",
    });
    const result = spawnSync(process.execPath, [installer, "settings", "--dry-run", "--combo-default", "balanced"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/│ Setting +│ Current +│ Valid values +│/);
    expect(result.stdout).toMatch(/│ combo +│ off +│/);
    expect(result.stdout).toMatch(/│ pstack +│ off +│/);
    expect(result.stdout).toMatch(/Stored: .*\.tersio\/settings\.json/);
    expect(result.stdout).toMatch(/\[dry-run\] would set defaults: combo=balanced \(caveman=full · rtk=on · ponytail=full · pstack=on\)/);
    expect(readLock(home).comboDefault, "dry-run must not write").toBe("off");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings --currency writes the display default without touching modes", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, {
      comboDefault: "balanced",
      cavemanDefault: "full",
      rtkDefault: true,
      ponytailDefault: "full",
      currency: "USD",
    });
    const result = spawnSync(process.execPath, [installer, "settings", "--currency", "php"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/currency=PHP/);
    const saved = readLock(home);
    expect(saved.currency).toBe("PHP");
    expect(saved.comboDefault, "mode defaults preserved").toBe("balanced");
    expect(saved.ponytailDefault, "mode defaults preserved").toBe("full");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings table hides the currency default (dashboard owns it)", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, { currency: "JPY" });
    const result = spawnSync(process.execPath, [installer, "settings", "--dry-run", "--combo-default", "off"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toMatch(/│ currency /);
    expect(result.stdout).toMatch(/would set defaults: combo=off.*currency=JPY/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings with flags writes combo preset + overrides", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, { comboDefault: "max" });
    const result = spawnSync(
      process.execPath,
      [installer, "settings", "--combo-default", "medium", "--caveman-default", "ultra"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15000,
        env: cliEnv(home),
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Defaults: combo=medium \(caveman=ultra · rtk=on · ponytail=lite · pstack=on\)/);
    const saved = readLock(home);
    expect(saved.comboDefault).toBe("medium");
    expect(saved.cavemanDefault).toBe("ultra");
    expect(saved.rtkDefault).toBe(true);
    expect(saved.ponytailDefault).toBe("lite");
    expect(saved.currency, "the display default is written here too").toBe("USD");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings rejects an unknown setting name", () => {
  const result = spawnSync(process.execPath, [installer, "settings", "bogus"], {
    encoding: "utf8",
    cwd: root,
    env: cliEnv(mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"))),
    timeout: 15000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Invalid setting: bogus/);
});

test("settings without flags and no TTY prints usage", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    const result = spawnSync(process.execPath, [installer, "settings"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/│ Setting +│ Current +│ Valid values +│/);
    expect(result.stdout).toMatch(/Usage: tersio settings/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings --subagent-marker writes the marker list", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, { comboDefault: "off", cavemanDefault: "off", rtkDefault: false, ponytailDefault: "off" });
    const result = spawnSync(process.execPath, [installer, "settings", "--subagent-marker", "You are a delegated worker."], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readLock(home).subagentMarkers).toEqual(["You are a delegated worker."]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings --subagent-marker accepts repeats and keeps the mode defaults", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, { comboDefault: "balanced", cavemanDefault: "full", rtkDefault: true, ponytailDefault: "full" });
    const result = spawnSync(process.execPath, [
      installer, "settings", "--subagent-marker", "first marker", "--subagent-marker", "second marker",
    ], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    const saved = readLock(home);
    expect(saved.subagentMarkers).toEqual(["first marker", "second marker"]);
    expect(saved.comboDefault, "mode defaults preserved").toBe("balanced");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("settings drops blank markers so one cannot match every turn", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, {
      comboDefault: "off",
      subagentMarkers: ["real marker", "", "   "],
    });
    const result = spawnSync(process.execPath, [installer, "settings", "--currency", "EUR"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readLock(home).subagentMarkers).toEqual(["real marker"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the settings table reports the default marker when none is set", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, { comboDefault: "off", cavemanDefault: "off", rtkDefault: false, ponytailDefault: "off" });
    const result = spawnSync(process.execPath, [installer, "settings"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/│ markers +│ default +│ host subagent prompt text +│/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The walk needs a TTY, so guard the source: a per-mode prompt must not come back.
test("the full settings walk asks only the Combo preset", () => {
  const source = readFileSync(path.join(root, "cli", "settings.ts"), "utf8");
  const walk = source.slice(source.indexOf("async function askProfile"), source.indexOf("async function askSubagentMarkers"));
  for (const label of ["Caveman default", "RTK default", "Ponytail default"]) {
    expect(walk, `${label} prompt is back`).not.toContain(label);
  }
});

test("settings markers accepts a jump to the single setting", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-settings-"));
  try {
    writeLock(home, { comboDefault: "off", cavemanDefault: "off", rtkDefault: false, ponytailDefault: "off" });
    // No TTY: the jump must reject rather than prompt and hang.
    const result = spawnSync(process.execPath, [installer, "settings", "markers"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Single-setting jump needs a terminal/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The dashboard's own pstack surface: the rows its Diagnosis pane renders, and the default it reads and writes.
interface DoctorRow {
  label: string;
  ok: boolean;
  detail: string;
  group: string;
}

interface SettingsPayload {
  comboDefault?: string;
  pstackDefault?: string;
}

function serverEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    TERSIO_USAGE_FILE: path.join(home, "usage.jsonl"),
    TERSIO_SESSIONS_DIR: path.join(home, "no-sessions"),
    TERSIO_RTK_DB: path.join(home, "no-rtk.db"),
    TERSIO_USAGE_DB: path.join(home, "no-usage.db"),
    TERSIO_RESET_FILE: path.join(home, "reset.json"),
  };
}

/** Resolves on the line the server prints once it listens, so nothing waits on a guessed duration. */
function startDashboard(home: string): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(process.execPath, [installer, "dashboard", "--port", "0"], {
      cwd: root,
      env: serverEnv(home),
    });
    let out = "";
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.on("error", (err) => { done(() => { reject(err); }); });
    // A server that dies before printing its URL fails here, where the cause is visible.
    child.on("exit", (code) => { done(() => { reject(new Error(`dashboard exited ${code}: ${out}`)); }); });
    const watch = (chunk: unknown): void => {
      out += String(chunk);
      const match = /\[ok\] Dashboard live → (http:\/\/\S+)/.exec(out);
      if (match) done(() => { resolve({ child, url: match[1] }); });
    };
    child.stdout?.on("data", watch);
    child.stderr?.on("data", watch);
  });
}

async function stopDashboard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  expect(res.status, `GET ${url}`).toBe(200);
  return (await res.json()) as T;
}

async function postSettings(url: string, body: Record<string, unknown>): Promise<{ status: number; json: { ok?: boolean; error?: string } }> {
  const res = await fetch(`${url}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { ok?: boolean; error?: string } };
}

test("the dashboard shows pstack in its diagnosis and reads and writes its default", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-dash-pstack-"));
  const { child, url } = await startDashboard(home);
  try {
    const report = await getJson<{ rows: DoctorRow[] }>(`${url}/doctor?fresh=1`);
    const rows = report.rows;
    expect(rows.map((r) => r.label)).toContain("pstack extension");
    expect(rows.map((r) => r.label)).toContain("pstack rule");
    expect(rows.find((r) => r.label === "pstack extension")?.group).toBe("Extensions");
    expect(rows.find((r) => r.label === "pstack rule")?.group).toBe("Add-ons");
    // The rows must name the trees that exist today, never the retired `-session` names they once checked.
    expect(rows.filter((r) => /caveman-session|rtk-session/.test(r.detail)).map((r) => r.label)).toEqual([]);

    expect((await getJson<SettingsPayload>(`${url}/settings`)).pstackDefault).toBe("off");

    const on = await postSettings(url, { pstackDefault: "on" });
    expect(on.status).toBe(200);
    expect(on.json.ok).toBe(true);
    expect((await getJson<SettingsPayload>(`${url}/settings`)).pstackDefault).toBe("on");

    const bad = await postSettings(url, { pstackDefault: "loud" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("unknown pstack level");
    expect((await getJson<SettingsPayload>(`${url}/settings`)).pstackDefault, "a refused write changes nothing").toBe("on");

    const off = await postSettings(url, { pstackDefault: "off" });
    expect(off.status).toBe(200);
    expect(off.json.ok).toBe(true);
    expect((await getJson<SettingsPayload>(`${url}/settings`)).pstackDefault).toBe("off");
  } finally {
    await stopDashboard(child);
    rmSync(home, { recursive: true, force: true });
  }
}, 40000);
