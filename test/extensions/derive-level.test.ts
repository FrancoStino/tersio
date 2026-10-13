import { expect, test } from "vitest";
import {
  deriveLevel,
  isComboPresetActive,
  resetSharedComboState,
  setSharedComboLevel,
} from "../../extensions/shared/session-state.ts";

test("deriveLevel maps every preset back to its level, including balanced", () => {
  expect(deriveLevel({ caveman: "off", rtk: "off", ponytail: "off", pstack: "off" })).toBe("off");
  expect(deriveLevel({ caveman: "lite", rtk: "on", ponytail: "lite", pstack: "off" })).toBe("medium");
  expect(deriveLevel({ caveman: "full", rtk: "on", ponytail: "full", pstack: "off" })).toBe("balanced");
  expect(deriveLevel({ caveman: "ultra", rtk: "on", ponytail: "ultra", pstack: "off" })).toBe("max");
});

test("deriveLevel returns custom for mixed modes", () => {
  expect(deriveLevel({ caveman: "full", rtk: "off", ponytail: "full", pstack: "off" })).toBe("custom");
});

// pstack rides no preset, so turning it on leaves every preset behind.
test("deriveLevel returns custom when pstack is on", () => {
  expect(deriveLevel({ caveman: "full", rtk: "on", ponytail: "full", pstack: "on" })).toBe("custom");
  expect(deriveLevel({ caveman: "off", rtk: "off", ponytail: "off", pstack: "on" })).toBe("custom");
});

test("isComboPresetActive is true for presets, false for off", () => {
  try {
    for (const level of ["medium", "balanced", "max"]) {
      setSharedComboLevel(level);
      expect(isComboPresetActive()).toBe(true);
    }
    setSharedComboLevel("off");
    expect(isComboPresetActive()).toBe(false);
  } finally {
    resetSharedComboState();
  }
});
