import { expect, test } from "vitest";

import { errorRateTone } from "../../dashboard/app/src/lib/format.ts";

// omp's error-rate thresholds: 1% stops being noise, 5% stops being acceptable.
test("an error rate picks its tone on the omp stats thresholds", () => {
  expect(errorRateTone(0)).toBe("ok");
  expect(errorRateTone(0.004)).toBe("ok");
  expect(errorRateTone(0.0099)).toBe("ok");
  expect(errorRateTone(0.01)).toBe("warn");
  expect(errorRateTone(0.0499)).toBe("warn");
  expect(errorRateTone(0.05)).toBe("bad");
  expect(errorRateTone(0.5)).toBe("bad");
});
