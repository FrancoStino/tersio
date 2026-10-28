// Quick start data model: the pipeline's types, tables, and layout, plus every derivation the canvas
// and the fold panel read. No JSX here, so the host surfaces stay in the component modules.
import type { ModeState } from "./shell";

export type Point = readonly [number, number];

export const MODE_KEYS = ["caveman", "pstack", "rtk", "ponytail"] as const;
export type ModeKey = (typeof MODE_KEYS)[number];

export type EdgeKey = "hosts" | "omp" | "pi" | "opencode" | "combo" | "headroom" | ModeKey | `${ModeKey}-${string}`;

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

export type NodeId =
  | "output"
  | "caveman"
  | "pstack"
  | "headroom"
  | "rtk"
  | "ponytail"
  | `host-${string}`
  | `combo-${string}`
  | `${ModeKey}-${string}`;

/** A lane block id (`caveman-omp`) names one agent's own copy of a mode block; null for every other id. */
export function laneBlockOf(id: NodeId): { block: ModeKey; host: string } | null {
  const cut = id.lastIndexOf("-");
  if (cut <= 0) return null;
  const block = id.slice(0, cut);
  const host = id.slice(cut + 1);
  return (MODE_KEYS as ReadonlyArray<string>).includes(block) && host !== "" ? { block: block as ModeKey, host } : null;
}

const FIELD_OF: Record<ModeKey, "cavemanDefault" | "pstackDefault" | "rtkDefault" | "ponytailDefault"> = {
  caveman: "cavemanDefault", pstack: "pstackDefault", rtk: "rtkDefault", "ponytail": "ponytailDefault",
};

interface Link {
  p: ReadonlyArray<Point>;
  k?: EdgeKey;
}

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

const BLOCK_COLUMN_H = 4 * 76 + 8;

/**
 * One design space, one lane per agent: the host and its preset feed that agent's own row of mode
 * blocks, and every lane closes in its own output. The blocks dim by that agent's saved defaults, so
 * two agents with different sections draw two different flows instead of one shared pipe. Adding an
 * agent adds a lane, so the card pans and zooms instead of squeezing the nodes. Gaps stay generous:
 * the pair link, the block arrows, and the row wrap all need visible room to read as flow.
 */
export function pipelineLayout(hosts: ReadonlyArray<{ id: string }>, compact: boolean): Layout {
  const nodes: Array<readonly [NodeId, Box]> = [];
  const links: Link[] = [];
  if (compact) {
    // Narrow card: each lane stacks its pair on the left and its blocks in a column on the right.
    // Lane pitch clears the lane's last block plus a gap, so lanes never overlap.
    const lanePitch = BLOCK_COLUMN_H + 86;
    hosts.forEach((host, i) => {
      const laneY = 88 + i * lanePitch;
      nodes.push(
        [`host-${host.id}` as NodeId, { x: 16, y: laneY, w: 190, h: 54 }],
        [`combo-${host.id}` as NodeId, { x: 16, y: laneY + 70, w: 190, h: 54 }],
      );
      links.push({ p: [[115, laneY + 54], [115, laneY + 70]], k: host.id as EdgeKey });
      links.push({ p: [[206, laneY + 97], [222, laneY + 97], [222, laneY + 31], [238, laneY + 31]], k: `caveman-${host.id}` as EdgeKey });
      MODE_KEYS.forEach((block, j) => {
        nodes.push([`${block}-${host.id}` as NodeId, { x: 238, y: laneY + j * 76, w: 210, h: 62 }]);
        if (j > 0) links.push({ p: [[343, laneY + (j - 1) * 76 + 62], [343, laneY + j * 76]], k: `${block}-${host.id}` as EdgeKey });
      });
    });
    // The one proxy sits above every lane; a quiet drop line ties it to the lanes' entry row.
    nodes.push(["headroom", { x: 123, y: 14, w: 210, h: 54 }]);
    if (hosts.length > 0) links.push({ p: [[228, 68], [228, 80], [343, 80], [343, 88]] });
    const laneBottom = (i: number): number => 88 + i * lanePitch + BLOCK_COLUMN_H + 8;
    return {
      w: 456,
      h: hosts.length ? laneBottom(hosts.length - 1) + 52 : 96,
      nodes,
      links,
      captions: [],
    };
  }
  // Wide card: one lane per agent — the host and its preset feed that agent's own row of mode blocks.
  // Gaps stay generous: the pair link, the block arrows, and the trunk all need visible room to read
  // as flow. Headroom is not a step in any flow: the one proxy sits above every lane.
  hosts.forEach((host, i) => {
    const y = 118 + i * 158;
    nodes.push(
      [`host-${host.id}` as NodeId, { x: 20, y, w: 190, h: 54 }],
      [`combo-${host.id}` as NodeId, { x: 20, y: y + 78, w: 190, h: 54 }],
    );
    links.push({ p: [[115, y + 54], [115, y + 78]], k: host.id as EdgeKey });
    // The preset feeds this lane's first block, and the blocks chain left to right in injection order.
    links.push({ p: [[210, y + 105], [226, y + 105], [226, y + 66], [262, y + 66]], k: `caveman-${host.id}` as EdgeKey });
    MODE_KEYS.forEach((block, j) => {
      nodes.push([`${block}-${host.id}` as NodeId, { x: 262 + j * 210, y: y + 37, w: 180, h: 58 }]);
      if (j > 0) links.push({ p: [[262 + (j - 1) * 210 + 180, y + 66], [262 + j * 210, y + 66]], k: `${block}-${host.id}` as EdgeKey });
    });
  });
  const rowEnd = 262 + MODE_KEYS.length * 210 - 30;
  nodes.push(["headroom", { x: rowEnd / 2 - 95, y: 12, w: 190, h: 54 }]);
  if (hosts.length > 0) links.push({ p: [[rowEnd / 2, 66], [rowEnd / 2, 118 + 37]] });
  const lastLaneBottom = hosts.length ? 118 + (hosts.length - 1) * 158 + 132 : 118;
  return {
    w: rowEnd + 20,
    h: lastLaneBottom + 66,
    nodes,
    links,
    captions: [],
  };
}

/** An orthogonal route through these points, with every corner rounded by `radius`. */
export function ortho(points: ReadonlyArray<Point>, radius = 8): string {
  const [first, ...rest] = points;
  let d = `M${first[0]} ${first[1]}`;
  for (let i = 0; i < rest.length; i += 1) {
    const [x, y] = rest[i];
    const [prevX, prevY] = rest[i - 1] ?? first;
    const cornerX = Math.abs(x - prevX) > radius ? (x > prevX ? x - radius : x + radius) : x;
    const cornerY = Math.abs(y - prevY) > radius ? (y > prevY ? y - radius : y + radius) : y;
    d += ` L${prevX === x ? prevX : cornerX} ${prevY === y ? prevY : cornerY} L${x} ${y}`;
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
  { key: "rtk", glyph: "🗜️", name: "rtk", role: "tooling", note: "rewrites and condenses shell calls" },
  { key: "ponytail", glyph: "🧠", name: "ponytail", role: "size", note: "smallest complete change" },
] as const;

export const TURN = [
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
  "ponytail": {
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

/** What the fold says about a node. The per-agent preset nodes share the combo entry. */
export const ABOUT: Partial<Record<NodeId, string>> & { combo: string } = {
  "host-omp": "Oh My Pi loads the extensions from its plugin package.",
  "host-pi": "pi auto-discovers the same tree from its extensions directory.",
  "host-opencode": "OpenCode loads the tree as one plugin, registered in opencode.json.",
  combo: "One preset per agent: scope it to all agents, or give one agent its own. A host's own section wins over the shared default.",
  caveman: "Voice. Terse replies; code, commands, paths, and errors stay exact.",
  pstack: "Approach. Picks the playbook, the checks, and the design.",
  headroom: "Compression below the shell layer. Your own Headroom install compresses tool outputs and history; Tersio tracks it and reads its savings.",
  rtk: "Tooling. Rewrites a shell command and condenses its output before the model sees it.",
  "ponytail": "Size. Caps the diff at the smallest complete change.",
};

export interface HostState {
  installed: Record<string, boolean>;
  versions: Record<string, string | null>;
}

/** One definition of a node's live state, read by the canvas and the fold panel alike. */
export function edgeLit(key: EdgeKey, modes: ModeState | null, hostState: HostState): Lit {
  const lane = laneBlockOf(key as NodeId);
  if (lane) return nodeState(`${lane.block}-${lane.host}` as NodeId, modes, hostState).on;
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
  const lane = laneBlockOf(id);
  if (lane) return `${MODES.find((mm) => mm.key === lane.block)?.name ?? lane.block} · ${HOSTS.find((h) => h.id === lane.host)?.label ?? lane.host}`;
  if (id.startsWith("host-")) return HOSTS.find((h) => `host-${h.id}` === id)?.label ?? id;
  if (id.startsWith("combo-")) {
    const label = HOSTS.find((h) => `combo-${h.id}` === id)?.label ?? id.slice(6);
    return `Combo · ${label}`;
  }
  const mode = MODES.find((mm) => mm.key === id);
  if (mode) return mode.name;
  return TURN.find((t) => t.id === id)?.title ?? id;
}

export function nodeState(id: NodeId, modes: ModeState | null, hostState: HostState): { label: string; on: boolean | null } {
  const lane = laneBlockOf(id);
  if (lane) {
    if (!modes) return { label: "off", on: false };
    const section = (modes.hosts?.[lane.host] ?? {}) as Partial<Record<string, string | boolean>>;
    const shared = modes as unknown as Partial<Record<string, string | boolean>>;
    const raw = section[FIELD_OF[lane.block]] ?? shared[FIELD_OF[lane.block]];
    const level = lane.block === "rtk" ? (raw === true ? "on" : "off") : String(raw ?? "off");
    return { label: level, on: level !== "off" };
  }
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
  const lane = laneBlockOf(id);
  if (lane) return isOff(nodeState(id, modes, hostState).on);
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
  const lane = laneBlockOf(id);
  if (lane) {
    if (!modes) return null;
    const section = (modes.hosts?.[lane.host] ?? {}) as Partial<Record<string, string | boolean>>;
    const raw = section[FIELD_OF[lane.block]] ?? (modes as unknown as Partial<Record<string, string | boolean>>)[FIELD_OF[lane.block]];
    return lane.block === "rtk" ? (raw === true ? "on" : "off") : String(raw ?? "off");
  }
  if (!modes) return null;
  if (id.startsWith("combo-")) {
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

export function nodeGlyph(id: NodeId): string | null {
  if (id.startsWith("combo-")) return "🧩";
  const lane = laneBlockOf(id);
  if (lane) return MODES.find((mm) => mm.key === lane.block)?.glyph ?? null;
  return MODES.find((mm) => mm.key === id)?.glyph ?? null;
}

/** An exported file has no server, so a failed read leaves the hosts unknown and every node lit. */
export function readHosts(): Promise<Array<{ id: string; installed: boolean }> | null> {
  return fetch("/api/hosts")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}
