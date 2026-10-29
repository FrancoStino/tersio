import { expect, test } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { withHome } from "../helpers/env.ts";
import { configEntries, defaultProfile, saveHostDefaults } from "../../cli/profile.ts";

// The shared store is the single source; a host section only holds real overrides.
test("each setting reports its value and where it came from", async () => {
  await withHome(async (home) => {
    const dir = path.join(home, ".tersio");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
      comboDefault: "balanced",
      cavemanDefault: "full",
      hosts: {
        omp: { comboDefault: "lite" },
        pi: { comboDefault: "inherit" },
        pig: { cavemanDefault: "nonsense" },
      },
    }), "utf8");

    const omp = configEntries("omp");
    expect(omp.find((entry) => entry.key === "comboDefault")).toEqual({ key: "comboDefault", value: "lite", source: "override" });
    expect(omp.find((entry) => entry.key === "cavemanDefault")).toEqual({ key: "cavemanDefault", value: "full", source: "inherited" });

    const pi = configEntries("pi").find((entry) => entry.key === "comboDefault");
    expect(pi, "an explicit inherit reads the shared store").toEqual({ key: "comboDefault", value: "balanced", source: "inherited" });

    const pig = configEntries("pig").find((entry) => entry.key === "cavemanDefault");
    expect(pig?.source, "an invalid value never reads as a real choice").toBe("invalid");
    expect(pig?.value, "the safe fallback is the shared value").toBe("full");
  });
});

test("writing inherit removes that agent's override", async () => {
  await withHome(async (home) => {
    const dir = path.join(home, ".tersio");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({ comboDefault: "balanced", hosts: { omp: { comboDefault: "lite" } } }), "utf8");

    await saveHostDefaults("omp", ["comboDefault"], { ...defaultProfile(), comboDefault: "inherit" }, { dryRun: false, quiet: true, verbose: false });
    const stored = JSON.parse(readFileSync(file, "utf8")) as { hosts?: Record<string, Record<string, unknown>> };
    expect(stored.hosts?.omp?.comboDefault).toBeUndefined();
    expect(configEntries("omp").find((entry) => entry.key === "comboDefault")?.source).toBe("inherited");
  });
});
