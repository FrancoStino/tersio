import { expect, test } from "vitest";

import { withHome } from "../helpers/env.ts";
import { pigAgentDir } from "../../extensions/shared/utils.ts";

// PiG's documented root order; a wrong answer writes extensions where pig never looks.
test("the PiG agent directory follows PiG's own root order", () => {
  withHome((home) => {
    const previous = {
      PIG_HOME: process.env.PIG_HOME,
      PIG_CODING_AGENT_DIR: process.env.PIG_CODING_AGENT_DIR,
      PIG_USE_PI_DIRS: process.env.PIG_USE_PI_DIRS,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    try {
      delete process.env.PIG_HOME;
      delete process.env.PIG_CODING_AGENT_DIR;
      delete process.env.PIG_USE_PI_DIRS;
      delete process.env.XDG_CONFIG_HOME;
      expect(pigAgentDir(), "the default root is ~/.pig").toBe(`${home}/.pig/agent`);

      process.env.XDG_CONFIG_HOME = `${home}/config`;
      expect(pigAgentDir(), "XDG_CONFIG_HOME/pig comes before the default").toBe(`${home}/config/pig/agent`);

      process.env.PIG_HOME = `${home}/pighome`;
      expect(pigAgentDir(), "PIG_HOME comes before XDG").toBe(`${home}/pighome/agent`);

      process.env.PIG_CODING_AGENT_DIR = `${home}/moved`;
      expect(pigAgentDir(), "the agent-dir override wins outright").toBe(`${home}/moved`);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
