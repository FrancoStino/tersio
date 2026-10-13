// The dashboard's own pstack surface: the rows its Diagnosis pane renders, and the default it reads and writes.
import { expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installer = path.join(root, "dist", "tersio.js");

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
