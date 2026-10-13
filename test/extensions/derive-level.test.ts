import { expect, test } from "vitest";
import {
  deriveLevel,
  isComboPresetActive,
  resetSharedComboState,
  setSharedComboLevel,
} from "../../extensions/shared/session-state.ts";

test("deriveLevel maps every preset back to its level, including balanced", () => {
  expect(deriveLevel({ caveman: "off", rtk: "off", ponytail: "off", pstack: "off" })).toBe("off");
  expect(deriveLevel({ caveman: "lite", rtk: "on", ponytail: "lite", pstack: "on" })).toBe("medium");
  expect(deriveLevel({ caveman: "full", rtk: "on", ponytail: "full", pstack: "on" })).toBe("balanced");
  expect(deriveLevel({ caveman: "ultra", rtk: "on", ponytail: "ultra", pstack: "on" })).toBe("max");
});

test("deriveLevel returns custom for mixed modes", () => {
  expect(deriveLevel({ caveman: "full", rtk: "off", ponytail: "full", pstack: "off" })).toBe("custom");
});

// A hand-changed mode still leaves every preset behind, with or without pstack.
test("deriveLevel returns custom when a mode is changed by hand", () => {
  expect(deriveLevel({ caveman: "full", rtk: "on", ponytail: "full", pstack: "off" })).toBe("custom");
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
