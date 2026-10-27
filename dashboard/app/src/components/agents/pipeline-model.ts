// Quick start data model: the pipeline's types, tables, and layout, plus every derivation the canvas
// and the fold panel read. No JSX here, so the host surfaces stay in the component modules.
import type { ModeState } from "./shell";


export type Point = readonly [number, number];
export type EdgeKey = "hosts" | "omp" | "pi" | "opencode" | "combo" | "caveman" | "pstack" | "headroom" | "rtk" | "ponytail";

export type HostAction = "install" | "uninstall" | "update";

/** `null` means this page has no answer yet: an exported file reads no settings, so it draws every node as lit. */
export type Lit = boolean | null;

export const isOff = (value: Lit): boolean => value === false;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Link {
  p: ReadonlyArray<Point>;
  k?: EdgeKey;
  arrow?: boolean;
}

export type NodeId =
  | "output"
  | "caveman"
  | "pstack"
  | "headroom"
  | "rtk"
  | "ponytail"
  | `host-${string}`
  | `combo-${string}`;

interface Caption {
  x: number;
  y: number;
  text: string;
  anchor?: "start" | "end";
}

interface Layout {
  w: number;
  h: number;
  nodes: ReadonlyArray<readonly [NodeId, Box]>;
  links: readonly Link[];
  captions: readonly Caption[];
}

/**
 * One design space, drawn per agent: the hosts stack as host-plus-preset pairs on the left, the mode
 * blocks run as one row in injection order, and the output closes the row. The row reads left to right
 * the way the blocks append, so the canvas spends its width instead of its height. Adding an agent
 * lengthens the left stack, never the width, so the card pans and zooms instead of squeezing the nodes.
 */
export function pipelineLayout(hosts: ReadonlyArray<{ id: string }>, compact: boolean): Layout {
  const nodes: Array<readonly [NodeId, Box]> = [];
  const links: Link[] = [];
  const BLOCKS: ReadonlyArray<NodeId> = ["caveman", "pstack", "headroom", "rtk", "ponytail"];
  if (compact) {
    // Narrow card: agent and its preset stack as pairs on the left, blocks and output on the right.
    hosts.forEach((host, i) => {
      const top = 20 + i * 126;
      nodes.push(
        [`host-${host.id}` as NodeId, { x: 16, y: top, w: 190, h: 56 }],
        [`combo-${host.id}` as NodeId, { x: 16, y: top + 62, w: 190, h: 56 }],
      );
      links.push({ p: [[111, top + 56], [111, top + 62]], k: host.id as EdgeKey, arrow: true });
      links.push({ p: [[206, top + 90], [218, top + 90], [218, 51]] , k: host.id as EdgeKey });
    });
    BLOCKS.forEach((block, j) => {
      nodes.push([block, { x: 230, y: 20 + j * 76, w: 210, h: 62 }]);
      if (j > 0) links.push({ p: [[335, 20 + (j - 1) * 76 + 62], [335, 20 + j * 76]], k: block as EdgeKey, arrow: true });
    });
    links.push({ p: [[218, 51], [230, 51]], k: "caveman", arrow: true });
    nodes.push(["output", { x: 230, y: 20 + BLOCKS.length * 76 + 8, w: 210, h: 56 }]);
    const pairBottom = hosts.length ? 20 + hosts.length * 126 + 30 : 0;
    const blocksBottom = 20 + BLOCKS.length * 76 + 64;
    return {
      w: 456,
      h: Math.max(pairBottom, blocksBottom) + 40,
      nodes,
      links,
      captions: [{ x: 230, y: Math.max(pairBottom, blocksBottom) + 20, text: "appended in this order, one block each" }],
    };
  }
  // Wide card: one host-plus-preset pair per agent on the left, then the shared block row, then output.
  hosts.forEach((host, i) => {
    const top = 24 + i * 124;
    nodes.push(
      [`host-${host.id}` as NodeId, { x: 20, y: top, w: 190, h: 54 }],
      [`combo-${host.id}` as NodeId, { x: 20, y: top + 60, w: 190, h: 54 }],
    );
    links.push({ p: [[115, top + 54], [115, top + 60]], k: host.id as EdgeKey, arrow: true });
  });
  const trunkX = 234;
  const rowX = 250;
  const rowY = 24;
  hosts.forEach((host, i) => {
    const comboY = 24 + i * 124 + 60 + 27;
    // Every preset feeds one trunk, and the trunk enters the block row once.
    links.push({ p: [[210, comboY], [trunkX, comboY], [trunkX, rowY + 29]], k: host.id as EdgeKey });
  });
  if (hosts.length > 0) links.push({ p: [[trunkX, rowY + 29], [rowX, rowY + 29]], k: "caveman", arrow: true });
  BLOCKS.forEach((block, j) => {
    nodes.push([block, { x: rowX + j * 214, y: rowY, w: 190, h: 58 }]);
    if (j > 0) links.push({ p: [[rowX + (j - 1) * 214 + 190, rowY + 29], [rowX + j * 214, rowY + 29]], k: block as EdgeKey, arrow: true });
  });
  const outputX = rowX + BLOCKS.length * 214 + 14;
  nodes.push(["output", { x: outputX, y: rowY, w: 200, h: 58 }]);
  links.push({ p: [[rowX + (BLOCKS.length - 1) * 214 + 190, rowY + 29], [outputX, rowY + 29]], k: "ponytail", arrow: true });
  const stackBottom = hosts.length > 0 ? 24 + hosts.length * 124 - 4 : rowY + 58;
  return {
    w: outputX + 200 + 20,
    h: Math.max(stackBottom, rowY + 58) + 62,
    nodes,
    links,
    captions: [{ x: rowX, y: Math.max(stackBottom, rowY + 58) + 26, text: "appended in this order, one block each" }],
  };
}

/** An orthogonal route through these points, with every corner rounded by `radius`. */
export function ortho(points: ReadonlyArray<Point>, radius = 8): string {
  const [first, ...rest] = points;
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 0; i < rest.length; i += 1) {
    const [x, y] = rest[i];
    if (i === rest.length - 1) {
      d += ` L${x} ${y}`;
      break;
    }
    const [px, py] = points[i];
    const [nx, ny] = rest[i + 1];
    const inX = Math.sign(x - px);
    const inY = Math.sign(y - py);
    const outX = Math.sign(nx - x);
    const outY = Math.sign(ny - y);
    // A straight run has no corner to round.
    if ((inX !== 0 && outX !== 0) || (inY !== 0 && outY !== 0)) {
      d += ` L${x} ${y}`;
      continue;
    }
    d += ` L${x - inX * radius} ${y - inY * radius}`;
    d += ` Q${x} ${y} ${x + outX * radius} ${y + outY * radius}`;
  }
  return d;
}

/** `/health` reports `omp/18.12.6` and `opencode/opencode v2.1.3`, so the node keeps only the version. */
export function versionOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tail = raw.split("/").pop() ?? raw;
  const version = tail.replace(/^(omp|pi|opencode)\s+/i, "").trim();
  return version || null;
}

/** The three hosts, in the order the installer writes them. */
export const HOSTS = [
  { id: "omp", label: "Oh My Pi" },
  { id: "pi", label: "pi" },
  { id: "opencode", label: "OpenCode" },
] as const;

export const MODES = [
  { key: "caveman", glyph: "🪨", name: "caveman", role: "voice", note: "terse replies, filler gone" },
  { key: "pstack", glyph: "🥔", name: "pstack", role: "approach", note: "playbook, checks, design" },
  { key: "headroom", glyph: "🍃", name: "headroom", role: "compression", note: "compresses traffic below the shell" },
  { key: "rtk", glyph: "🗜️", name: "rtk", role: "tooling", note: "rewrites and condenses shell" },
  { key: "ponytail", glyph: "🧠", name: "ponytail", role: "size", note: "smallest complete change" },
] as const;

const TURN = [
  { id: "output", icon: "arrow-right", title: "Output", note: "the turn's result" },
] as const;

/** The nodes a click can set, the field each writes, and the levels that field takes. Every per-agent preset node shares the combo entry. */
export const PICKER: Record<"combo" | "caveman" | "rtk" | "ponytail" | "pstack" | "headroom", { field: string; options: ReadonlyArray<{ id: string; label: string }> }> = {
  combo: {
    field: "comboDefault",
    options: [
      { id: "off", label: "Off" }, { id: "lite", label: "Lite" },
      { id: "balanced", label: "Balanced" }, { id: "max", label: "Max" },
    ],
  },
  caveman: {
    field: "cavemanDefault",
    options: [
      { id: "off", label: "Off" }, { id: "lite", label: "Lite" }, { id: "full", label: "Full" },
      { id: "ultra", label: "Ultra" }, { id: "megacave-lite", label: "Megacave lite" },
      { id: "megacave-full", label: "Megacave full" }, { id: "megacave-ultra", label: "Megacave ultra" },
    ],
  },
  rtk: { field: "rtkDefault", options: [{ id: "off", label: "Off" }, { id: "on", label: "On" }] },
  ponytail: {
    field: "ponytailDefault",
    options: [
      { id: "off", label: "Off" }, { id: "lite", label: "Lite" },
      { id: "full", label: "Full" }, { id: "ultra", label: "Ultra" },
    ],
  },
  pstack: { field: "pstackDefault", options: [{ id: "off", label: "Off" }, { id: "on", label: "On" }] },
  headroom: { field: "headroomDefault", options: [{ id: "off", label: "Off" }, { id: "on", label: "On" }] },
};

/** The session-start defaults one scope carries; `comboLevel` exists only on the shared store. */
export interface DefaultsPayload {
  comboDefault: string;
  comboLevel: string;
  cavemanDefault: string;
  rtkDefault: boolean;
  ponytailDefault: string;
  pstackDefault: string;
  headroomDefault: string;
}

export const DEFAULT_ROWS_UI: Array<{ field: keyof DefaultsPayload; label: string; glyph: string; hint: string; options: Array<{ id: string; label: string }> }> = [
  {
    field: "comboDefault",
    label: "Combo preset",
    glyph: "🧩",
    hint: "Sets caveman, RTK and Ponytail together. pstack is separate.",
    options: [
      { id: "off", label: "Off" },
      { id: "lite", label: "Lite" },
      { id: "balanced", label: "Balanced (Recommended)" },
      { id: "max", label: "Max" },
      { id: "custom", label: "Custom" },
    ],
  },
  {
    field: "cavemanDefault",
    label: "Caveman",
    glyph: "🪨",
    hint: "Terse-reply mode for a new or resumed session.",
    options: [
      { id: "off", label: "Off" }, { id: "lite", label: "Lite" },
      { id: "full", label: "Full" }, { id: "ultra", label: "Ultra" },
      { id: "megacave-lite", label: "Megacave lite" }, { id: "megacave-full", label: "Megacave full" },
      { id: "megacave-ultra", label: "Megacave ultra" },
    ],
  },
  {
    field: "rtkDefault",
    label: "RTK",
    glyph: "🗜️",
    hint: "Rewrite eligible Bash calls through rtk.",
    options: [{ id: "on", label: "On" }, { id: "off", label: "Off" }],
  },
  {
    field: "ponytailDefault",
    label: "Ponytail",
    glyph: "🧠",
    hint: "Lazy-code mode for a new or resumed session.",
    options: [
      { id: "off", label: "Off" }, { id: "lite", label: "Lite" },
      { id: "full", label: "Full" }, { id: "ultra", label: "Ultra" },
    ],
  },
  {
    field: "pstackDefault",
    label: "pstack",
    glyph: "🥔",
    hint: "Rigor mode. Opt-in, so no preset turns it on or off.",
    options: [{ id: "off", label: "Off" }, { id: "on", label: "On" }],
  },
];

export const OFF_DEFAULTS: DefaultsPayload = {
  comboDefault: "off", comboLevel: "off", cavemanDefault: "off", rtkDefault: false, ponytailDefault: "off", pstackDefault: "off", headroomDefault: "off",
};

/** What the folder says about a node. The per-agent preset nodes share the combo entry. */
export const ABOUT: Partial<Record<NodeId, string>> & { combo: string } = {
  "host-omp": "Oh My Pi loads the extensions from its plugin package.",
  "host-pi": "pi auto-discovers the same tree from its extensions directory.",
  "host-opencode": "OpenCode loads the tree as one plugin, registered in opencode.json.",
  combo: "One preset per agent: scope it to all agents, or give one agent its own. A host's own section wins over the shared default.",
  caveman: "Voice. Terse replies; code, commands, paths, and errors stay exact.",
  pstack: "Approach. Picks the playbook, the checks, and the design.",
  headroom: "Compression below the shell layer. Your own Headroom install compresses tool outputs and history; Tersio tracks it and reads its savings.",
  rtk: "Tooling. Rewrites a shell command and condenses its output before the model sees it.",
  ponytail: "Size. Caps the diff at the smallest complete change.",
  output: "One turn, start to finish: the prompt blocks go in, the model runs, and the reply comes back.",
};

export interface HostState {
  installed: Record<string, boolean>;
  versions: Record<string, string | null>;
}

/** One definition of a node's live state, read by the canvas and the properties card alike. */
export function edgeLit(key: EdgeKey, modes: ModeState | null, hostState: HostState): Lit {
  if (key === "hosts") {
    const installed = Object.values(hostState.installed);
    return installed.length ? installed.some(Boolean) : null;
  }
  if (key === "omp" || key === "pi" || key === "opencode") {
    const installed = hostState.installed[key];
    return installed === undefined ? null : installed;
  }
  if (!modes) return null;
  if (key === "combo") return (modes.comboLevel || modes.comboDefault) !== "off";
  if (key === "rtk") return modes.rtkDefault;
  if (key === "caveman") return modes.cavemanDefault !== "off";
  if (key === "ponytail") return modes.ponytailDefault !== "off";
  if (key === "headroom") return modes.headroomDefault !== "off";
  return modes.pstackDefault !== "off";
}

export function nodeTitle(id: NodeId): string {
  if (id.startsWith("host-")) return HOSTS.find((h) => `host-${h.id}` === id)?.label ?? id;
  if (id.startsWith("combo-")) {
    const label = HOSTS.find((h) => `combo-${h.id}` === id)?.label ?? id.slice(6);
    return `Combo · ${label}`;
  }
  const mode = MODES.find((m) => m.key === id);
  if (mode) return mode.name;
  return TURN.find((t) => t.id === id)?.title ?? id;
}

export function nodeState(id: NodeId, modes: ModeState | null, hostState: HostState): { label: string; on: boolean | null } {
  if (id.startsWith("host-")) {
    const key = id.slice(5);
    const on = edgeLit(key as EdgeKey, modes, hostState);
    return { label: isOff(on) ? "not installed" : versionOf(hostState.versions[key]) ?? "installed", on };
  }
  if (id.startsWith("combo-")) {
    const host = id.slice(6);
    const own = modes?.hosts?.[host]?.comboDefault;
    const level = typeof own === "string" ? own : modes?.comboLevel || modes?.comboDefault || "on";
    return { label: level, on: level !== "off" };
  }
  if (id === "caveman" || id === "ponytail") {
    const on = edgeLit(id, modes, hostState);
    const level = id === "caveman" ? modes?.cavemanDefault : modes?.ponytailDefault;
    return { label: isOff(on) ? "off" : level || "on", on };
  }
  if (id === "pstack" || id === "headroom" || id === "rtk") {
    const on = edgeLit(id, modes, hostState);
    return { label: isOff(on) ? "off" : "on", on };
  }
  return { label: "on", on: true };
}

export function nodeOff(id: NodeId, modes: ModeState | null, hostState: HostState): boolean {
  if (id.startsWith("host-")) return isOff(edgeLit(id.slice(5) as EdgeKey, modes, hostState));
  if (id.startsWith("combo-")) {
    const host = id.slice(6);
    const own = modes?.hosts?.[host]?.comboDefault;
    const level = typeof own === "string" ? own : modes?.comboLevel || modes?.comboDefault || "on";
    return level === "off";
  }
  if (id === "caveman" || id === "pstack" || id === "headroom" || id === "rtk" || id === "ponytail") {
    return isOff(edgeLit(id, modes, hostState));
  }
  return false;
}

/** What the node's control reads right now, in the scope the node itself stands for. */
export function nodeValue(id: NodeId, scope: "all" | "omp" | "pi" | "opencode", modes: ModeState | null): string | null {
  if (!modes) return null;
  if (id.startsWith("combo-")) {
    // A host scope shows its own preset when it has one, else the value it inherits.
    if (scope !== "all") {
      const own = modes.hosts?.[scope]?.comboDefault;
      if (typeof own === "string") return own;
    }
    return modes.comboLevel || modes.comboDefault;
  }
  if (id === "caveman") return modes.cavemanDefault;
  if (id === "ponytail") return modes.ponytailDefault;
  if (id === "pstack") return modes.pstackDefault;
  if (id === "headroom") return modes.headroomDefault;
  if (id === "rtk") return modes.rtkDefault ? "on" : "off";
  return null;
}

/** An exported file has no server, so a failed read leaves the hosts unknown and every node lit. */
export function readHosts(): Promise<Array<{ id: string; installed: boolean }> | null> {
  return fetch("/api/hosts")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}
