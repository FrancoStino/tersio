// Quick start data model: the pipeline graph, its tables, and every derivation the canvas and the
// dialogs read. No JSX here, so the host surfaces stay in the component modules.
import type { ModeState } from "./shell";

export type Point = readonly [number, number];

export type EdgeKey = "hosts" | "omp" | "pi" | "pig" | "opencode" | "combo" | "headroom" | "caveman" | "pstack" | "rtk" | "ponytail";

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
  | "prompt"
  | "output"
  | "caveman"
  | "pstack"
  | "headroom"
  | "rtk"
  | "ponytail"
  | `host-${string}`
  | `combo-${string}`;

export interface GraphEdge {
  from: NodeId;
  to: NodeId;
}

/** The injection order: each block appends to the prompt in this sequence. */
export const CHAIN = ["caveman", "pstack", "rtk", "ponytail"] as const;

/** The turn order the chains read, plus one preset-and-agent pair per installed host. */
export function pipelineGraph(installedHosts: ReadonlyArray<string>): { nodes: NodeId[]; edges: GraphEdge[] } {
  const nodes: NodeId[] = ["prompt", ...CHAIN, "headroom", "output"];
  for (const host of installedHosts) nodes.push(`combo-${host}` as NodeId, `host-${host}` as NodeId);
  const edges: GraphEdge[] = [
    { from: "prompt", to: "caveman" },
    ...CHAIN.slice(0, -1).map((id, i) => ({ from: id, to: CHAIN[i + 1] as NodeId })),
    { from: "ponytail", to: "output" },
    { from: "prompt", to: "headroom" },
    { from: "headroom", to: "output" },
  ];
  for (const host of installedHosts) {
    edges.push({ from: `combo-${host}` as NodeId, to: `host-${host}` as NodeId });
    edges.push({ from: `host-${host}` as NodeId, to: "output" });
  }
  return { nodes, edges };
}

export const NODE_W = 200;
export const NODE_H = 56;

/** Everything lands on this grid, so nodes line up with the dot background and with each other. */
export const GRID_SNAP = 8;

export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SNAP) * GRID_SNAP;
}

export type PortSide = "left" | "right" | "top" | "bottom";

/** The midpoint of one side: the port an edge leaves from or arrives at. */
export function portPoint(box: Box, side: PortSide): Point {
  if (side === "left") return [box.x, box.y + box.h / 2];
  if (side === "right") return [box.x + box.w, box.y + box.h / 2];
  if (side === "top") return [box.x + box.w / 2, box.y];
  return [box.x + box.w / 2, box.y + box.h];
}

/** The two ports an edge uses, chosen by the target's direction from the source — n8n lets lines leave any side. */
export function edgePorts(s: Box, t: Box): { from: PortSide; to: PortSide } {
  const dx = t.x + t.w / 2 - (s.x + s.w / 2);
  const dy = t.y + t.h / 2 - (s.y + s.h / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { from: "right", to: "left" } : { from: "left", to: "right" };
  return dy >= 0 ? { from: "bottom", to: "top" } : { from: "top", to: "bottom" };
}

const PORT_NORMAL: Record<PortSide, Point> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

/** One n8n-style cubic: leaves the source port along its outward normal, arrives along the target's. */
export function bezierEdge(s: Point, t: Point, from: PortSide, to: PortSide): string {
  const outFrom = PORT_NORMAL[from];
  const outTo = PORT_NORMAL[to];
  const dx = t[0] - s[0];
  const dy = t[1] - s[1];
  const reach = Math.max(48, Math.hypot(dx, dy) * 0.45);
  return `M${s[0]} ${s[1]} C${s[0] + outFrom[0] * reach} ${s[1] + outFrom[1] * reach}, ${t[0] + outTo[0] * reach} ${t[1] + outTo[1] * reach}, ${t[0]} ${t[1]}`;
}

const EDGE_CLEARANCE = 12;
const EDGE_BOW = 30;

/** How close a dragged edge or center must be to another node's before it snaps. */
export const ALIGN_THRESHOLD = 6;

export interface GuideLine {
  /** The coordinate the line sits at (x for vertical, y for horizontal). */
  at: number;
  /** The line's span across the other axis. */
  from: number;
  to: number;
}

export interface Alignment {
  box: Box;
  vertical: GuideLine[];
  horizontal: GuideLine[];
}

/**
 * Figma-style snapping: the dragged node's edges and center snap to every other node's edges and
 * center within the threshold, winning over the pixel grid, and reports the guide lines to draw.
 */
export function alignDrag(id: string, next: Box, boxes: ReadonlyArray<readonly [string, Box]>): Alignment {
  const pick = (axis: "x" | "y"): { delta: number; line: GuideLine } | null => {
    const size = axis === "x" ? next.w : next.h;
    const origin = axis === "x" ? next.x : next.y;
    const mine = [origin, origin + size / 2, origin + size];
    let best: { delta: number; line: GuideLine } | null = null;
    for (const [otherId, b] of boxes) {
      if (otherId === id) continue;
      const otherOrigin = axis === "x" ? b.x : b.y;
      const otherSize = axis === "x" ? b.w : b.h;
      for (const theirs of [otherOrigin, otherOrigin + otherSize / 2, otherOrigin + otherSize]) {
        for (const m of mine) {
          const delta = theirs - m;
          if (Math.abs(delta) > ALIGN_THRESHOLD) continue;
          if (best && Math.abs(delta) >= Math.abs(best.delta)) continue;
          const cross = axis === "x"
            ? [Math.min(next.y, b.y), Math.max(next.y + next.h, b.y + b.h)]
            : [Math.min(next.x, b.x), Math.max(next.x + next.w, b.x + b.w)];
          best = { delta, line: { at: theirs, from: cross[0], to: cross[1] } };
        }
      }
    }
    return best;
  };
  const vertical = pick("x");
  const horizontal = pick("y");
  return {
    box: { ...next, x: next.x + (vertical?.delta ?? 0), y: next.y + (horizontal?.delta ?? 0) },
    vertical: vertical ? [vertical.line] : [],
    horizontal: horizontal ? [horizontal.line] : [],
  };
}

/**
 * The connector between two nodes, bowing around any node the straight run would cross: the path
 * detours through a waypoint just off the face it exits, so lines never run under a node card.
 */
export function edgePath(s: Box, t: Box, others: ReadonlyArray<Box>): string {
  const ports = edgePorts(s, t);
  const sp = portPoint(s, ports.from);
  const tp = portPoint(t, ports.to);
  let waypoint: Point | null = null;
  let normal: Point = [0, -1];
  for (const b of others) {
    for (let i = 1; i < 16 && !waypoint; i += 1) {
      const px = sp[0] + ((tp[0] - sp[0]) * i) / 16;
      const py = sp[1] + ((tp[1] - sp[1]) * i) / 16;
      if (px <= b.x - EDGE_CLEARANCE || px >= b.x + b.w + EDGE_CLEARANCE) continue;
      if (py <= b.y - EDGE_CLEARANCE || py >= b.y + b.h + EDGE_CLEARANCE) continue;
      // The face nearest the crossing point is where the path climbs out.
      const left = px - b.x;
      const right = b.x + b.w - px;
      const top = py - b.y;
      const bottom = b.y + b.h - py;
      const face = Math.min(left, right, top, bottom);
      const clamped: Point = face === left ? [b.x, py] : face === right ? [b.x + b.w, py] : face === top ? [px, b.y] : [px, b.y + b.h];
      normal = face === left ? [-1, 0] : face === right ? [1, 0] : face === top ? [0, -1] : [0, 1];
      waypoint = [clamped[0] + normal[0] * EDGE_BOW, clamped[1] + normal[1] * EDGE_BOW];
    }
    if (waypoint) break;
  }
  if (!waypoint) return bezierEdge(sp, tp, ports.from, ports.to);
  const reach = 40;
  const w = waypoint;
  const inFrom: Point = [sp[0] + PORT_NORMAL[ports.from][0] * reach, sp[1] + PORT_NORMAL[ports.from][1] * reach];
  const apexIn: Point = [w[0] - normal[0] * reach, w[1] - normal[1] * reach];
  const apexOut: Point = [w[0] + normal[0] * reach, w[1] + normal[1] * reach];
  const inTo: Point = [tp[0] + PORT_NORMAL[ports.to][0] * reach, tp[1] + PORT_NORMAL[ports.to][1] * reach];
  return `M${sp[0]} ${sp[1]} C${inFrom[0]} ${inFrom[1]}, ${apexIn[0]} ${apexIn[1]}, ${w[0]} ${w[1]} C${apexOut[0]} ${apexOut[1]}, ${inTo[0]} ${inTo[1]}, ${tp[0]} ${tp[1]}`;
}

/** The n8n reading: columns left to right, the shared chain on the main line, the traffic layer above, agents below. */
export function defaultPositions(installedHosts: ReadonlyArray<string>): Record<string, Box> {
  const positions: Record<string, Box> = {
    prompt: { x: 40, y: 296, w: NODE_W, h: NODE_H },
    headroom: { x: 320, y: 120, w: NODE_W, h: NODE_H },
    output: { x: 1440, y: 296, w: NODE_W, h: NODE_H },
  };
  CHAIN.forEach((id, i) => {
    positions[id] = { x: 320 + i * 280, y: 296, w: NODE_W, h: NODE_H };
  });
  installedHosts.forEach((host, i) => {
    positions[`combo-${host}`] = { x: 600, y: 456 + i * 104, w: NODE_W, h: NODE_H };
    positions[`host-${host}`] = { x: 880, y: 456 + i * 104, w: NODE_W, h: NODE_H };
  });
  return positions;
}

const POSITIONS_KEY = "tersio.pipeline.positions.v1";

/** Node positions survive reloads; a corrupt or missing store falls back to the default layout. */
export function loadPositions(): Record<string, Box> | null {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const boxes = parsed as Record<string, unknown>;
    const clean: Record<string, Box> = {};
    for (const [id, box] of Object.entries(boxes)) {
      if (
        box && typeof box === "object" &&
        typeof (box as Box).x === "number" && typeof (box as Box).y === "number" &&
        typeof (box as Box).w === "number" && typeof (box as Box).h === "number"
      ) clean[id] = box as Box;
    }
    return Object.keys(clean).length > 0 ? clean : null;
  } catch {
    return null;
  }
}

export function savePositions(positions: Record<string, Box>): void {
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // Private mode: the layout just does not persist.
  }
}

/** `/health` reports `omp/18.12.6` and `opencode/opencode v2.1.3`, so the node keeps only the version. */
export function versionOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tail = raw.split("/").pop() ?? raw;
  const version = tail.replace(/^(omp|pi|pig|opencode)\s+/i, "").trim();
  return version || null;
}

/** The hosts, in the order the installer writes them. */
export const HOSTS = [
  { id: "omp", label: "Oh My Pi" },
  { id: "pi", label: "pi" },
  { id: "pig", label: "PiG" },
  { id: "opencode", label: "OpenCode" },
] as const;

export const MODES = [
  { key: "caveman", glyph: "🪨", name: "caveman", role: "voice", note: "terse replies, filler gone" },
  { key: "pstack", glyph: "🥔", name: "pstack", role: "approach", note: "playbook, checks, design" },
  { key: "headroom", glyph: "🍃", name: "headroom", role: "compression", note: "compresses traffic below the shell" },
  { key: "rtk", glyph: "🗜️", name: "rtk", role: "tooling", note: "rewrites and condenses shell calls" },
  { key: "ponytail", glyph: "🧠", name: "ponytail", role: "size", note: "smallest complete change" },
] as const;

/** The nodes a click can set, the field each writes, and the levels that field takes. Every per-agent preset shares the combo entry. */
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

/** What the option surface says about a node. */
export const ABOUT: Partial<Record<NodeId, string>> & { combo: string } = {
  prompt: "Your message starts the turn. Every block below appends to it before the agent sees it.",
  "host-omp": "Oh My Pi loads the extensions from its plugin package.",
  "host-pi": "pi auto-discovers the same tree from its extensions directory.",
  "host-pig": "PiG loads the same tree from its own agent directory, the way pi does.",
  "host-opencode": "OpenCode loads the tree as one plugin, registered in opencode.json.",
  combo: "One preset per agent: scope it to all agents, or give one agent its own. A host's own section wins over the shared default.",
  caveman: "Voice. Terse replies; code, commands, paths, and errors stay exact.",
  pstack: "Approach. Picks the playbook, the checks, and the design.",
  headroom: "Compression below the shell layer. Your own Headroom install compresses tool outputs and history; Tersio tracks it and reads its savings.",
  rtk: "Tooling. Rewrites a shell command and condenses its output before the model sees it.",
  "ponytail": "Size. Caps the diff at the smallest complete change.",
  output: "The turn's result: what the agent answers after every block applied.",
};

export interface HostState {
  installed: Record<string, boolean>;
  versions: Record<string, string | null>;
}

/** One definition of a node's live state, read by the canvas and the dialogs alike. */
export function edgeLit(key: EdgeKey, modes: ModeState | null, hostState: HostState): Lit {
  if (key === "hosts") {
    const installed = Object.values(hostState.installed);
    return installed.length ? installed.some(Boolean) : null;
  }
  if (key === "omp" || key === "pi" || key === "opencode") {
    const installed = hostState.installed[key];
    return installed === undefined ? null : installed;
  }
  if (key === "pig") {
    const installed = hostState.installed.pig;
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
  const mode = MODES.find((mm) => mm.key === id);
  if (mode) return mode.name;
  if (id === "prompt") return "Prompt";
  return "Output";
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

/** What the node's control reads right now, in the scope the dialog writes to. */
export function nodeValue(id: NodeId, scope: "all" | "omp" | "pi" | "pig" | "opencode", modes: ModeState | null): string | null {
  if (!modes) return null;
  if (id.startsWith("combo-")) {
    if (scope !== "all") {
      const own = modes.hosts?.[scope]?.comboDefault;
      if (typeof own === "string") return own;
    }
    return modes.comboLevel || modes.comboDefault;
  }
  if (id === "caveman") {
    if (scope !== "all") {
      const own = modes.hosts?.[scope]?.cavemanDefault;
      if (typeof own === "string") return own;
    }
    return modes.cavemanDefault;
  }
  if (id === "ponytail") {
    if (scope !== "all") {
      const own = modes.hosts?.[scope]?.ponytailDefault;
      if (typeof own === "string") return own;
    }
    return modes.ponytailDefault;
  }
  if (id === "pstack") {
    if (scope !== "all") {
      const own = modes.hosts?.[scope]?.pstackDefault;
      if (typeof own === "string") return own;
    }
    return modes.pstackDefault;
  }
  if (id === "headroom") {
    if (scope !== "all") {
      const own = modes.hosts?.[scope]?.headroomDefault;
      if (typeof own === "string") return own;
    }
    return modes.headroomDefault;
  }
  if (id === "rtk") {
    if (scope !== "all") {
      const own = modes.hosts?.[scope]?.rtkDefault;
      if (own !== undefined) return own === true ? "on" : "off";
    }
    return modes.rtkDefault ? "on" : "off";
  }
  return null;
}

export function nodeGlyph(id: NodeId): string | null {
  if (id.startsWith("combo-")) return "🧩";
  if (id === "prompt") return "▶";
  if (id === "output") return null;
  return MODES.find((mm) => mm.key === id)?.glyph ?? null;
}

/** An exported file has no server, so a failed read leaves the hosts unknown and every node lit. */
export function readHosts(): Promise<Array<{ id: string; installed: boolean }> | null> {
  return fetch("/api/hosts")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}
