import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { deriveEligibleHeads, eligibleHeads, FALLBACK_ELIGIBLE_HEADS } from "../../extensions/shared/rtk-eligible.ts";
import { resolveRtkBinary } from "../../extensions/shared/utils.ts";

const bin = resolveRtkBinary();

test("without a binary the fallback list stands", () => {
  expect([...eligibleHeads(null)].sort()).toEqual([...FALLBACK_ELIGIBLE_HEADS].sort());
});

test.skipIf(bin === null)("rtk's rewrite contract matches the fallback list", () => {
  // The fallback is the contract snapshot; a drift fails here, not in the dashboard.
  expect([...deriveEligibleHeads(bin as string)].sort()).toEqual([...FALLBACK_ELIGIBLE_HEADS].sort());
});

test.skipIf(bin === null)("the derived set is cached per binary version", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "tersio-rtk-eligible-"));
  const prev = process.env.TERSIO_HOME;
  process.env.TERSIO_HOME = home;
  try {
    const first = eligibleHeads(bin);
    const second = eligibleHeads(bin);
    expect([...second].sort()).toEqual([...first].sort());
    expect(first.size).toBeGreaterThan(20);
  } finally {
    if (prev === undefined) delete process.env.TERSIO_HOME;
    else process.env.TERSIO_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
