// The host mark reads the agent from the transcript path; a wrong omp path drew the pi logo on every OMP row.
import { homedir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { hostOfSession } from "../../dashboard/app/src/lib/format.ts";

const root = path.join(homedir(), ".omp", "agent", "sessions");

test("an omp session path reads as the OMP host", () => {
  // This is the shape omp writes today: `~/.omp/agent/sessions/<project>/<file>.jsonl`.
  expect(hostOfSession(path.join(root, "-Documents-Projects-Personal-tersio", "2026-10-12T14-48-05-216Z_x.jsonl")))
    .toEqual({ label: "OMP", host: "omp" });
});

test("the older `.agent/agent/sessions` spelling still reads as OMP", () => {
  expect(hostOfSession("/Users/u/.agent/agent/sessions/-proj/s.jsonl")).toEqual({ label: "OMP", host: "omp" });
});

test("pi and OpenCode keep their own hosts", () => {
  expect(hostOfSession(path.join(homedir(), ".pi", "agent", "sessions", "-proj", "s.jsonl")))
    .toEqual({ label: "Pi", host: "pi" });
  expect(hostOfSession(path.join(homedir(), ".config", "opencode", "agent", "sessions", "-proj", "s.jsonl")))
    .toEqual({ label: "OpenCode", host: "opencode" });
});

test("an unrelated path falls back to OMP rather than guessing a host", () => {
  expect(hostOfSession("/tmp/elsewhere/s.jsonl")).toEqual({ label: "OMP", host: "unknown" });
});
