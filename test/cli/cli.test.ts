import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { cliEnv } from "../helpers/env.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installer = path.join(root, "dist", "tersio.js");
const { version } = createRequire(import.meta.url)("../../package.json");

function run(...args: string[]) {
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
}

for (const alias of [["version"], ["--version"], ["-v"]]) {
  test(`${alias[0]} prints only the package version`, () => {
    const result = run(...alias);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
    expect(result.stderr).toBe("");
  });
}

for (const alias of [["help"], ["--help"], ["-h"]]) {
  test(`${alias[0]} prints help`, () => {
    const result = run(...alias);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^Usage:/);
    for (const command of ["install", "update", "doctor", "uninstall", "usage", "dashboard", "reset", "settings", "version", "help"]) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command}\\s`, "m"));
    }
    expect(result.stderr).toBe("");
  });
}

test("an unknown command fails with usage and no installer output", () => {
  const result = run("definitely-not-a-command");

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Unknown command: definitely-not-a-command/);
  expect(result.stdout).toMatch(/^Usage:/);
  expect(result.stdout).not.toMatch(/Prerequisites:|Installing|Will remove:/);
});

test("dry-run previews shared bridge before dependent extensions without writing", () => {
  const missingHome = path.join(root, "test", "definitely-missing-home");
  const result = spawnSync(
    process.execPath,
    [installer, "install", "--dry-run"],
    {
      encoding: "utf8",
      cwd: path.join(root, "test"),
      env: cliEnv(missingHome),
    }
  );

  expect(result.status, result.stderr).toBe(0);
  const shared = result.stdout.indexOf("Shared files — sync session bridge");
  const rtk = result.stdout.indexOf("RTK session — install session mode");
  const caveman = result.stdout.indexOf("Caveman — install session mode and rule bodies");
  expect(shared >= 0, result.stdout).toBeTruthy();
  expect(rtk > shared, result.stdout).toBeTruthy();
  expect(caveman > shared, result.stdout).toBeTruthy();
  expect(result.stdout).toMatch(/Ponytail — ensure bundled plugin/);
  expect(result.stdout).toMatch(/Tersio — register plugin/);
  expect(result.stdout).not.toMatch(/\/tmp|\/Users|\.omp\/agent\/extensions\/shared\/session-state\.js/);
  expect(existsSync(path.join(root, "extensions", "shared-session-state.js"))).toBe(false);
});

test("user dry-run installs commands without retired reinforcement", () => {
  const missingHome = path.join(root, "test", "definitely-missing-home");
  const result = spawnSync(
    process.execPath,
    [installer, "install", "--dry-run"],
    {
      encoding: "utf8",
      cwd: root,
      env: cliEnv(missingHome),
    }
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Ponytail — ensure bundled plugin/);
  expect(result.stdout).toMatch(/Combo — install preset switch/);
  expect(result.stdout).toMatch(/Tersio — register plugin/);
  expect(result.stdout).not.toMatch(/mode reinforcement/i);
});
test("verbose dry-run reveals file paths hidden by default", () => {
  const missingHome = path.join(root, "test", "definitely-missing-home");
  const result = spawnSync(
    process.execPath,
    [installer, "install", "--dry-run", "--verbose"],
    {
      encoding: "utf8",
      cwd: root,
      env: cliEnv(missingHome),
    }
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/\[dry-run\] would write .*shared[\\/]session-state\.ts/);
  expect(result.stdout).toMatch(/\[dry-run\] would write .*commands[\\/]index\.ts/);
});

test("reinstall refreshes a named host and verifies it", () => {
  // A temp home: the install writes a real plugin tree, and parallel siblings share the fixture as HOME.
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-reinstall-"));
  try {
    const result = spawnSync(process.execPath, [installer, "reinstall", "--host", "omp", "--dry-run", "--yes"], {
      encoding: "utf8",
      timeout: 60000,
      cwd: root,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Reinstall — Tersio v[\d.]+ into Oh My Pi/);
    expect(result.stdout).toMatch(/Preview — no changes will be written/);
    // The plugin manifest's tree, not the agent tree, is what a reinstall refreshes.
    expect(result.stdout).toMatch(/plugins\/node_modules\/@krtclcdy\/tersio\/extensions/);
    // dry-run writes nothing, so the verification pass has nothing to report.
    expect(result.stdout, "a dry run must not re-run the doctor").not.toMatch(/Reinstall verified/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reinstall says so instead of guessing when no agent has tersio", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-reinstall-empty-"));
  try {
    const result = spawnSync(process.execPath, [installer, "reinstall", "--yes"], {
      encoding: "utf8",
      timeout: 60000,
      cwd: root,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Nothing to reinstall/);
    expect(result.stdout).toMatch(/tersio install/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the menu offers reinstall right below install", () => {
  const menu = readFileSync(path.join(root, "cli", "install.ts"), "utf8");
  const installAt = menu.indexOf("{ value: 'install',");
  const reinstallAt = menu.indexOf("{ value: 'reinstall',");
  expect(installAt, "install option").toBeGreaterThan(-1);
  expect(reinstallAt, "reinstall option").toBeGreaterThan(installAt);
  const updateAt = menu.indexOf("{ value: 'update',");
  expect(reinstallAt).toBeLessThan(updateAt);
});

test("bare dry-run never prompts for the pending update and exits 0", () => {
  const missingHome = path.join(root, "test", "definitely-missing-home");
  const result = spawnSync(
    process.execPath,
    [installer, "--dry-run"],
    {
      encoding: "utf8",
      cwd: root,
      env: cliEnv(missingHome),
    }
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toMatch(/Install it now\?/);
});

test("uninstall dry-run previews shared bridge removal", () => {
  const missingHome = path.join(root, "test", "definitely-missing-home");
  const result = spawnSync(
    process.execPath,
    [installer, "uninstall", "--dry-run", "--yes"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: cliEnv(missingHome),
    }
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/\[dry-run\] would remove .*extensions[\\/]shared(?:\r?\n|$)/);
  expect(result.stdout).toMatch(/\[dry-run\] would remove .*extensions[\\/]aaa-combo-boot(?:\r?\n|$)/);
});

// npm nests an old copy when the published range excludes the pin, so the override makes the pinned version load.
test("install pins the bundled ponytail range with an override", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-ponytail-override-"));
  try {
    const pluginsDir = path.join(home, ".omp", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    const pkgPath = path.join(pluginsDir, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "@dietrichgebert/ponytail": "^4.12.0" } }, null, 2),
      "utf8",
    );
    const result = spawnSync(process.execPath, [installer, "doctor", "--fix", "ponytail", "--yes", "--dry-run"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env: cliEnv(home),
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/\[dry-run\] .*@dietrichgebert\/ponytail → \^5/);
    expect(result.stdout).toMatch(/overrides/);
    expect(JSON.parse(readFileSync(pkgPath, "utf8")).overrides, "a dry run must not write").toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall dry-run with --remove-ponytail previews full ponytail removal", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-uninstall-"));
  try {
    const pluginsDir = path.join(home, ".omp", "plugins");
    mkdirSync(path.join(pluginsDir, "node_modules", "@dietrichgebert"), { recursive: true });
    writeFileSync(
      path.join(pluginsDir, "package.json"),
      JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "@dietrichgebert/ponytail": "github:DietrichGebert/ponytail" } }),
      "utf8",
    );
    writeFileSync(
      path.join(pluginsDir, "omp-plugins.lock.json"),
      JSON.stringify({ plugins: { "@dietrichgebert/ponytail": { version: "4.9.0" } }, settings: {} }),
      "utf8",
    );
    const result = spawnSync(
      process.execPath,
      [installer, "uninstall", "--dry-run", "--yes", "--remove-ponytail"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        env: cliEnv(home),
      }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/\[dry-run\] would remove @dietrichgebert\/ponytail from .*package\.json/);
    expect(result.stdout).toMatch(/\[dry-run\] would remove .*@dietrichgebert[\\/]ponytail(?:\r?\n|$)/);
    expect(result.stdout).toMatch(/\[dry-run\] would remove @dietrichgebert\/ponytail from .*omp-plugins\.lock\.json/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("uninstall dry-run includes ponytail by default; --keep-ponytail omits it", () => {
  const missingHome = path.join(root, "test", "definitely-missing-home");
  const spawn = (args: string[]) =>
    spawnSync(process.execPath, [installer, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: cliEnv(missingHome),
    });

  const def = spawn(["uninstall", "--dry-run", "--yes"]);
  expect(def.status, def.stderr).toBe(0);
  expect(def.stdout, "ponytail removal is part of the default dry-run plan").toMatch(/dietrichgebert/);

  const keep = spawn(["uninstall", "--dry-run", "--yes", "--keep-ponytail"]);
  expect(keep.status, keep.stderr).toBe(0);
  expect(keep.stdout).not.toMatch(/dietrichgebert/);
});

test("uninstall dry-run never prompts for confirmation", () => {
  const missingHome = path.join(root, "test", "definitely-missing-home");
  const result = spawnSync(
    process.execPath,
    [installer, "uninstall", "--dry-run"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
      env: cliEnv(missingHome),
    }
  );

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toMatch(/Proceed\?/);
  expect(result.stdout).toMatch(/\[dry-run\] would remove .*extensions[\\/]shared(?:\r?\n|$)/);
});

test("usage with an empty ledger and no sessions prints the empty state and exits 0", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-usage-empty-"));
  const missing = path.join(root, "test", "definitely-missing-home", "no-ledger.jsonl");
  const noSessions = path.join(root, "test", "definitely-missing-home", "no-sessions");
  const result = spawnSync(process.execPath, [installer, "usage"], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, TERSIO_USAGE_FILE: missing, TERSIO_SESSIONS_DIR: noSessions, TERSIO_RESET_FILE: path.join(root, "test", "definitely-missing-home", "no-reset.json"), TERSIO_USAGE_DB: path.join(dir, "usage.db") },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/No ledger rows or session tokens yet/);
  expect(result.stdout).toMatch(/· stored ===/);
  rmSync(dir, { recursive: true, force: true });
});

test("dashboard --export writes a self-contained html file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-dash-"));
  const out = path.join(dir, "dash.html");
  const result = spawnSync(process.execPath, [installer, "dashboard", "--export", out], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      TERSIO_SESSIONS_DIR: path.join(dir, "no-sessions"),
      TERSIO_RTK_DB: path.join(dir, "no-rtk.db"),
      TERSIO_USAGE_DB: path.join(dir, "no-usage.db"),
      TERSIO_RESET_FILE: path.join(dir, "reset.json"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const html = existsSync(out) ? "present" : "missing";
  expect(html).toBe("present");
  const body = readFileSync(out, "utf8");
  expect(body).toMatch(/Tersio Dashboard/);
  expect(body).toMatch(/Oh My Pi/);
  expect(body).toMatch(/ompPath/);
  expect(body).toMatch(/"agent":/);
  expect(body).toMatch(/"currency":"USD"/);
  expect(body.split("</body>").length - 1).toBe(1);
  expect(body.split("</html>").length - 1).toBe(1);
  rmSync(dir, { recursive: true, force: true });
}, 30000); // Full CLI export exceeds the 5s default on slow disks.

test("gain is no longer a public dashboard command", () => {
  const result = run("gain", "--export", path.join(os.tmpdir(), "tersio-obsolete-gain.html"));
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Unknown command: gain/);
  expect(existsSync(path.join(os.tmpdir(), "tersio-obsolete-gain.html"))).toBe(false);
});

test("reset --dry-run keeps the seeded ledger", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-reset-"));
  const ledger = path.join(dir, "usage.jsonl");
  writeFileSync(ledger, '{"ts":1,"kind":"command","detail":"x"}\n{"ts":2,"kind":"toggle","detail":"y"}\n', "utf8");
  const result = spawnSync(process.execPath, [installer, "reset", "--dry-run"], {
    encoding: "utf8",
    cwd: root,
    input: "n\n",
    env: {
      ...process.env,
      TERSIO_USAGE_FILE: ledger,
      TERSIO_RESET_FILE: path.join(dir, "reset.json"),
      TERSIO_SESSIONS_DIR: path.join(dir, "no-sessions"),
      TERSIO_RTK_DB: path.join(dir, "no-rtk.db"),
      TERSIO_USAGE_DB: path.join(dir, "no-usage.db"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Will clear: 2 usage ledger rows/);
  expect(result.stdout).toMatch(/\[dry-run\] nothing written/);
  expect(existsSync(ledger)).toBe(true);
});

test("reset --yes clears the seeded ledger and writes the watermark", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-reset-"));
  const ledger = path.join(dir, "usage.jsonl");
  const marker = path.join(dir, "reset.json");
  writeFileSync(ledger, '{"ts":1,"kind":"command","detail":"x"}\n', "utf8");
  const result = spawnSync(process.execPath, [installer, "reset", "--yes"], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      TERSIO_USAGE_FILE: ledger,
      TERSIO_RESET_FILE: marker,
      TERSIO_SESSIONS_DIR: path.join(dir, "no-sessions"),
      TERSIO_RTK_DB: path.join(dir, "no-rtk.db"),
      TERSIO_USAGE_DB: path.join(dir, "no-usage.db"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/\[ok\] reset — removed 1 usage rows; statistics view starts at /);
  expect(existsSync(ledger)).toBe(false);
  expect(existsSync(marker)).toBe(true);
});

test("reset asks Y/N and aborts without writing on N", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-reset-"));
  const ledger = path.join(dir, "usage.jsonl");
  const marker = path.join(dir, "reset.json");
  writeFileSync(ledger, '{"ts":1,"kind":"command","detail":"x"}\n', "utf8");
  const result = spawnSync(process.execPath, [installer, "reset"], {
    encoding: "utf8",
    cwd: root,
    input: "n\n",
    env: {
      ...process.env,
      TERSIO_USAGE_FILE: ledger,
      TERSIO_RESET_FILE: marker,
      TERSIO_SESSIONS_DIR: path.join(dir, "no-sessions"),
      TERSIO_RTK_DB: path.join(dir, "no-rtk.db"),
      TERSIO_USAGE_DB: path.join(dir, "no-usage.db"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Proceed\? \[y\/N\]/);
  expect(result.stdout).toMatch(/Aborted\./);
  expect(existsSync(ledger), "ledger kept on abort").toBe(true);
  expect(existsSync(marker), "no watermark written on abort").toBe(false);
});

test("reset accepts lowercase y and writes the watermark", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-reset-"));
  const ledger = path.join(dir, "usage.jsonl");
  const marker = path.join(dir, "reset.json");
  writeFileSync(ledger, '{"ts":1,"kind":"command","detail":"x"}\n', "utf8");
  const result = spawnSync(process.execPath, [installer, "reset"], {
    encoding: "utf8",
    cwd: root,
    input: "y\n",
    env: {
      ...process.env,
      TERSIO_USAGE_FILE: ledger,
      TERSIO_RESET_FILE: marker,
      TERSIO_SESSIONS_DIR: path.join(dir, "no-sessions"),
      TERSIO_RTK_DB: path.join(dir, "no-rtk.db"),
      TERSIO_USAGE_DB: path.join(dir, "no-usage.db"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/\[ok\] reset — removed 1 usage rows/);
  expect(existsSync(ledger)).toBe(false);
  expect(existsSync(marker)).toBe(true);
});

test("reset --yes on empty stores prints nothing-to-reset without prompting", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-reset-"));
  const ledger = path.join(dir, "usage.jsonl");
  const result = spawnSync(process.execPath, [installer, "reset", "--yes"], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      TERSIO_USAGE_FILE: ledger,
      TERSIO_RESET_FILE: path.join(dir, "reset.json"),
      TERSIO_SESSIONS_DIR: path.join(dir, "no-sessions"),
      TERSIO_RTK_DB: path.join(dir, "no-rtk.db"),
      TERSIO_USAGE_DB: path.join(dir, "no-usage.db"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Nothing to reset — no statistics recorded/);
  expect(existsSync(ledger)).toBe(false);
});

test("doctor prints record store paths", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-doctor-"));
  const ledger = path.join(dir, "usage.jsonl");
  writeFileSync(ledger, '{"ts":1,"kind":"command","detail":"x"}\n', "utf8");
  const result = spawnSync(process.execPath, [installer, "doctor"], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      TERSIO_USAGE_FILE: ledger,
      TERSIO_SESSIONS_DIR: path.join(dir, "no-sessions"),
      TERSIO_RTK_DB: path.join(dir, "no-rtk.db"),
      TERSIO_USAGE_DB: path.join(dir, "no-usage.db"),
      TERSIO_RESET_FILE: path.join(dir, "reset.json"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^Usage & records$/m);
  expect(result.stdout).toMatch(/Usage DB \(tersio-owned/);
  expect(result.stdout).not.toMatch(/Usage ledger/);
  expect(result.stdout).not.toMatch(/Session transcripts/);
  expect(result.stdout).not.toMatch(/RTK history/);
  rmSync(dir, { recursive: true, force: true });
});

test("dashboard --export bakes the agent empty states", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tersio-dash-"));
  const out = path.join(dir, "dash.html");
  const result = spawnSync(process.execPath, [installer, "dashboard", "--export", out], {
    encoding: "utf8",
    cwd: root,
    env: {
      ...process.env,
      TERSIO_USAGE_FILE: path.join(dir, "usage.jsonl"),
      TERSIO_SESSIONS_DIR: path.join(dir, "no-sessions"),
      TERSIO_RTK_DB: path.join(dir, "no-rtk.db"),
      TERSIO_USAGE_DB: path.join(dir, "no-usage.db"),
      TERSIO_RESET_FILE: path.join(dir, "reset.json"),
    },
  });
  expect(result.status, result.stderr).toBe(0);
  const body = readFileSync(out, "utf8");
  // The agent pages' empty states, baked with the payload, plus the picker label an exported file cannot control.
  expect(body).toMatch(/No usage in this range/);
  expect(body).toMatch(/No provider activity in this range/);
  expect(body).toMatch(/No requests in this range/);
  expect(body).toMatch(/Try a longer range/);
  expect(body).toMatch(/Diagnosis/);
  expect(body).toMatch(/"agent"/);
  rmSync(dir, { recursive: true, force: true });
});
