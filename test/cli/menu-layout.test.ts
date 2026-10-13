// Clack anchors to the cursor, so an over-tall welcome scrolls; proving it needs `pyte`, and skips without it.
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const installer = path.join(root, "dist", "tersio.js");

const PY = [
  "import os, pty, select, fcntl, termios, struct, time, sys, json",
  "rows = int(sys.argv[1])",
  "argv = sys.argv[2:]",
  "pid, fd = pty.fork()",
  "if pid == 0:",
  '    os.environ["TERM"] = "xterm-256color"',
  "    os.execvp(argv[0], argv)",
  "fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, 100, 0, 0))",
  "buf = b''",
  "end = time.time() + 4",
  "while time.time() < end:",
  "    r, _, _ = select.select([fd], [], [], 0.2)",
  "    if not r:",
  "        continue",
  "    try:",
  "        d = os.read(fd, 65536)",
  "    except OSError:",
  "        break",
  "    if not d:",
  "        break",
  "    buf += d",
  "try:",
  "    os.write(fd, b'\\x03')",
  "except OSError:",
  "    pass",
  "time.sleep(0.3)",
  "for close in (lambda: os.close(fd), lambda: os.kill(pid, 9)):",
  "    try:",
  "        close()",
  "    except OSError:",
  "        pass",
  "import pyte",
  "screen = pyte.Screen(100, rows)",
  "pyte.Stream(screen).feed(buf.decode('utf8', 'replace'))",
  "out = ['' for _ in range(rows)]",
  "for y in range(rows):",
  "    line = ''",
  "    for x in range(100):",
  "        line += screen.buffer[y][x].data or ' '",
  "    out[y] = line.rstrip()",
  "sys.stdout.write(json.dumps(out))",
].join("\n");

const havePyte = spawnSync("python3", ["-c", "import pyte"], { encoding: "utf8" }).status === 0;

/** The visible screen, one string per terminal row. One capture per row count, shared by every test. */
const screenCache = new Map<number, string[]>();
function screenAt(rows: number): string[] {
  const cached = screenCache.get(rows);
  if (cached) return cached;
  const result = spawnSync("python3", ["-c", PY, String(rows), process.execPath, installer], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, TERM: "xterm-256color" },
  });
  expect(result.status, result.stderr).toBe(0);
  const lines = JSON.parse(result.stdout) as string[];
  screenCache.set(rows, lines);
  return lines;
}

const LABELS = ["Install add-ons", "Update", "Doctor", "Settings", "Usage", "Dashboard", "Uninstall"];

// Slow the registry past a spinner frame: Clack's CI spinner residue once pushed tips off a 20-row screen.
function screenAtCi(rows: number): string[] {
  const bin = mkdtempSync(path.join(os.tmpdir(), "tersio-slow-npm-"));
  try {
    writeFileSync(`${bin}/npm`, "#!/bin/sh\nsleep 1\necho 2.25.1\n", { mode: 0o755 });
    const result = spawnSync("python3", ["-c", PY, String(rows), process.execPath, installer], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, TERM: "xterm-256color", CI: "true", PATH: `${bin}${process.env.PATH ? `:${process.env.PATH}` : ""}` },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as string[];
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

describe.skipIf(!havePyte)("menu layout", () => {
  for (const rows of [40, 30, 24, 20]) {
    test(`the whole welcome fits without scrolling at ${rows} rows`, () => {
      const lines = screenAt(rows);

      for (const label of LABELS) {
        expect(lines.some((l) => l.includes(label)), `${label} present at ${rows} rows`).toBe(true);
      }
      // The intro and every option must survive; scrolling them away showed a blank gap and sliced art.
      expect(lines.some((l) => l.includes("set up add-ons")), `tips visible at ${rows} rows`).toBe(true);
      expect(lines.some((l) => l.includes("Uninstall")), `last option visible at ${rows} rows`).toBe(true);
    }, 20000);
  }

  test("a slow update check leaves no spinner residue under CI at 20 rows", () => {
    const lines = screenAtCi(20);
    expect(lines.some((l) => l.includes("set up add-ons")), "tips visible").toBe(true);
    expect(lines.some((l) => l.includes("Install add-ons")), "menu visible").toBe(true);
    expect(lines.some((l) => l.includes("Checking npm registry")), "no spinner residue").toBe(false);
  }, 20000);

  test("the scissor art renders whole on a full-height terminal", () => {
    const lines = screenAt(30);
    const artAt = lines.findIndex((l) => l.includes("██"));

    expect(artAt, "art present").toBeGreaterThan(-1);
    // Six rows, so the last art row must sit at artAt + 5 with nothing missing.
    for (let i = 0; i < 6; i++) {
      expect(lines[artAt + i], `art row ${i} present`).toBeDefined();
      expect(lines[artAt + i], `art row ${i} is not blank`).not.toBe("");
    }
  }, 20000);

  test("the combo is a header line, not a menu option", () => {
    const lines = screenAt(30);
    const titleAt = lines.findIndex((l) => l.includes("what next?"));
    const comboAt = lines.findIndex((l) => l.includes("combo "));
    const firstOptionAt = lines.findIndex((l) => l.includes("Install add-ons"));

    expect(titleAt, "title present").toBeGreaterThan(-1);
    expect(comboAt, "combo present").toBeGreaterThan(titleAt);
    expect(firstOptionAt, "first option present").toBeGreaterThan(comboAt);
    // Under the title, not the option list, so no radio marker marks it selectable.
    expect(lines[comboAt], "combo is not a selectable option").not.toMatch(/[●○]/);
  }, 20000);

  test("the menu follows the intro with no gap", () => {
    const lines = screenAt(30);
    const introAt = lines.findIndex((l) => l.includes("tersio v"));
    const artAt = lines.findIndex((l) => l.includes("██"));
    const menuAt = lines.findIndex((l) => l.includes("what next?"));

    expect(introAt, "intro present").toBeGreaterThan(-1);
    expect(artAt, "art present").toBeGreaterThan(introAt);
    expect(menuAt, "menu present").toBeGreaterThan(artAt);
    // Intro + art + menu is 24 rows; more than that means the frame scrolled.
    expect(menuAt - introAt, "no blank gap above the menu").toBeLessThanOrEqual(16);
  }, 20000);
});
