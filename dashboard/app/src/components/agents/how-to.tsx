// How does it work?: the pipeline as one canvas, drawn the way a workflow tool lays it out.
// Everything here mirrors docs/ARCHITECTURE.md: the hosts, the bridge, the block order, and the rtk loop.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Card, Page, PageHeader } from "@/components/charts";
import { AgentLogo } from "@/components/agent-logos";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import { fetchHealth } from "@/lib/data";
import type { ModeState } from "./shell";
import { useToast } from "../toaster";
import { cn } from "cn";

type Point = readonly [number, number];
type EdgeKey = "hosts" | "omp" | "pi" | "opencode" | "combo" | "caveman" | "pstack" | "rtk" | "ponytail";

/** `null` means this page has no answer yet: an exported file reads no settings, so it draws every node as lit. */
type Lit = boolean | null;

const isOff = (value: Lit): boolean => value === false;

interface Box {
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

type NodeId =
  | "hosts"
  | "host-omp"
  | "host-pi"
  | "host-opencode"
  | "combo"
  | "session"
  | "caveman"
  | "pstack"
  | "rtk"
  | "ponytail"
  | "model"
  | "tool"
  | "filtered"
  | "reply";

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
  /** The filtered output's route back to the model, drawn dashed. */
  loop: ReadonlyArray<Point>;
  captions: readonly Caption[];
}

/**
 * Three design spaces, one per class of screen. Each is drawn at its own coordinates and then scaled to
 * the card width, so the diagram is the same diagram at every size and never clips a node.
 */
const LAYOUTS: Record<"wide" | "medium" | "narrow", Layout> = {
  wide: {
    w: 1040,
    h: 430,
    nodes: [
      ["host-omp", { x: 20, y: 64, w: 190, h: 58 }],
      ["host-pi", { x: 20, y: 138, w: 190, h: 58 }],
      ["host-opencode", { x: 20, y: 212, w: 190, h: 58 }],
      ["combo", { x: 246, y: 24, w: 200, h: 58 }],
      ["session", { x: 246, y: 196, w: 200, h: 76 }],
      ["caveman", { x: 486, y: 40, w: 230, h: 62 }],
      ["pstack", { x: 486, y: 122, w: 230, h: 62 }],
      ["rtk", { x: 486, y: 204, w: 230, h: 62 }],
      ["ponytail", { x: 486, y: 286, w: 230, h: 62 }],
      ["model", { x: 752, y: 40, w: 240, h: 66 }],
      ["tool", { x: 752, y: 140, w: 240, h: 66 }],
      ["filtered", { x: 752, y: 240, w: 240, h: 66 }],
      ["reply", { x: 752, y: 340, w: 240, h: 66 }],
    ],
    links: [
      { p: [[210, 93], [230, 93]], k: "omp" },
      { p: [[210, 167], [230, 167]], k: "pi" },
      { p: [[210, 241], [230, 241]], k: "opencode" },
      { p: [[230, 93], [230, 241]] },
      { p: [[230, 241], [246, 241]], arrow: true },
      { p: [[346, 82], [346, 196]], k: "combo", arrow: true },
      { p: [[446, 234], [466, 234], [466, 71], [486, 71]], k: "caveman", arrow: true },
      { p: [[601, 102], [601, 122]], k: "pstack", arrow: true },
      { p: [[601, 184], [601, 204]], k: "rtk", arrow: true },
      { p: [[601, 266], [601, 286]], k: "ponytail", arrow: true },
      { p: [[716, 317], [734, 317], [734, 73], [752, 73]], k: "ponytail", arrow: true },
      { p: [[872, 106], [872, 140]], k: "rtk", arrow: true },
      { p: [[872, 206], [872, 240]], k: "rtk", arrow: true },
      { p: [[872, 306], [872, 340]], k: "rtk", arrow: true },
    ],
    loop: [[992, 273], [1016, 273], [1016, 73], [992, 73]],
    captions: [
      { x: 486, y: 372, text: "appended in this order, one block each" },
      { x: 1008, y: 28, text: "returns to the model", anchor: "end" },
    ],
  },
  medium: {
    w: 780,
    h: 360,
    nodes: [
      ["hosts", { x: 16, y: 16, w: 212, h: 72 }],
      ["session", { x: 16, y: 104, w: 212, h: 70 }],
      ["combo", { x: 16, y: 188, w: 212, h: 56 }],
      ["caveman", { x: 252, y: 16, w: 230, h: 64 }],
      ["pstack", { x: 252, y: 96, w: 230, h: 64 }],
      ["rtk", { x: 252, y: 176, w: 230, h: 64 }],
      ["ponytail", { x: 252, y: 256, w: 230, h: 64 }],
      ["model", { x: 520, y: 16, w: 240, h: 64 }],
      ["tool", { x: 520, y: 96, w: 240, h: 64 }],
      ["filtered", { x: 520, y: 176, w: 240, h: 64 }],
      ["reply", { x: 520, y: 256, w: 240, h: 64 }],
    ],
    links: [
      { p: [[122, 88], [122, 104]], k: "hosts", arrow: true },
      { p: [[122, 188], [122, 174]], k: "combo", arrow: true },
      { p: [[228, 139], [240, 139], [240, 48], [252, 48]], k: "caveman", arrow: true },
      { p: [[367, 80], [367, 96]], k: "pstack", arrow: true },
      { p: [[367, 160], [367, 176]], k: "rtk", arrow: true },
      { p: [[367, 240], [367, 256]], k: "ponytail", arrow: true },
      { p: [[482, 288], [500, 288], [500, 48], [520, 48]], k: "ponytail", arrow: true },
      { p: [[640, 80], [640, 96]], k: "rtk", arrow: true },
      { p: [[640, 160], [640, 176]], k: "rtk", arrow: true },
      { p: [[640, 240], [640, 256]], k: "rtk", arrow: true },
    ],
    loop: [[760, 208], [774, 208], [774, 48], [760, 48]],
    captions: [
      { x: 252, y: 344, text: "appended in this order, one block each" },
      { x: 760, y: 344, text: "returns to the model", anchor: "end" },
    ],
  },
  narrow: {
    w: 440,
    h: 810,
    nodes: [
      ["hosts", { x: 20, y: 16, w: 190, h: 88 }],
      ["combo", { x: 230, y: 16, w: 190, h: 56 }],
      ["session", { x: 20, y: 116, w: 400, h: 64 }],
      ["caveman", { x: 20, y: 196, w: 400, h: 64 }],
      ["pstack", { x: 20, y: 268, w: 400, h: 64 }],
      ["rtk", { x: 20, y: 340, w: 400, h: 64 }],
      ["ponytail", { x: 20, y: 412, w: 400, h: 64 }],
      ["model", { x: 20, y: 500, w: 400, h: 64 }],
      ["tool", { x: 20, y: 572, w: 400, h: 64 }],
      ["filtered", { x: 20, y: 644, w: 400, h: 64 }],
      ["reply", { x: 20, y: 716, w: 400, h: 64 }],
    ],
    links: [
      { p: [[115, 104], [115, 116]], k: "hosts", arrow: true },
      { p: [[325, 72], [325, 116]], k: "combo", arrow: true },
      { p: [[220, 180], [220, 196]], k: "caveman", arrow: true },
      { p: [[220, 260], [220, 268]], k: "pstack", arrow: true },
      { p: [[220, 332], [220, 340]], k: "rtk", arrow: true },
      { p: [[220, 404], [220, 412]], k: "ponytail", arrow: true },
      { p: [[220, 476], [220, 500]], k: "ponytail", arrow: true },
      { p: [[220, 564], [220, 572]], k: "rtk", arrow: true },
      { p: [[220, 636], [220, 644]], k: "rtk", arrow: true },
      { p: [[220, 708], [220, 716]], k: "rtk", arrow: true },
    ],
    loop: [[420, 676], [432, 676], [432, 532], [420, 532]],
    captions: [
      { x: 20, y: 190, text: "one block each, in order" },
      { x: 420, y: 800, text: "returns to the model", anchor: "end" },
    ],
  },
};

/** An orthogonal route through these points, with every corner rounded by `radius`. */
function ortho(points: ReadonlyArray<Point>, radius = 8): string {
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
function versionOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const tail = raw.split("/").pop() ?? raw;
  const version = tail.replace(/^(omp|pi|opencode)\s+/i, "").trim();
  return version || null;
}

/** The three hosts, in the order the installer writes them. */
const HOSTS = [
  { id: "omp", label: "Oh My Pi" },
  { id: "pi", label: "pi" },
  { id: "opencode", label: "OpenCode" },
] as const;

const MODES = [
  { key: "caveman", glyph: "🪨", name: "caveman", role: "voice", note: "terse replies, filler gone" },
  { key: "pstack", glyph: "🥔", name: "pstack", role: "approach", note: "playbook, checks, design" },
  { key: "rtk", glyph: "🗜️", name: "rtk", role: "tooling", note: "rewrites and condenses shell" },
  { key: "ponytail", glyph: "🧠", name: "ponytail", role: "size", note: "smallest complete change" },
] as const;

const TURN = [
  { id: "model", icon: "sparkles", title: "Model turn", note: "one block per mode in context" },
  { id: "tool", icon: "terminal", title: "Tool call", note: "RTK rewrites it before it runs", offNote: "runs unchanged", rtk: true },
  { id: "filtered", icon: "filter", title: "Filtered output", note: "signal kept, noise dropped", offNote: "no filter applied", rtk: true },
  { id: "reply", icon: "message-square", title: "Reply", note: "caveman voice, ponytail size" },
] as const;

/** The nodes a click can switch, and the values a switch writes. */
const TOGGLE: Partial<Record<NodeId, { field: string; onValue: string | boolean; offValue: string | boolean }>> = {
  combo: { field: "comboDefault", onValue: "lite", offValue: "off" },
  caveman: { field: "cavemanDefault", onValue: "lite", offValue: "off" },
  pstack: { field: "pstackDefault", onValue: "on", offValue: "off" },
  rtk: { field: "rtkDefault", onValue: true, offValue: false },
  ponytail: { field: "ponytailDefault", onValue: "lite", offValue: "off" },
};

/** What the detail panel says about a node. */
const ABOUT: Record<NodeId, string> = {
  hosts: "Every agent loads the same extension tree. Only the way each host loads it differs, so a mode behaves the same in all three.",
  "host-omp": "Oh My Pi loads the extensions from its plugin package.",
  "host-pi": "pi auto-discovers the same tree from its extensions directory.",
  "host-opencode": "OpenCode loads the tree as one plugin, registered in opencode.json.",
  combo: "One preset for caveman, RTK, and Ponytail. pstack keeps its own switch.",
  session: "A session start restores the saved defaults, then shares that state with every mode, so nothing needs a reload.",
  caveman: "Voice. Terse replies; code, commands, paths, and errors stay exact.",
  pstack: "Approach. Picks the playbook, the checks, and the design.",
  rtk: "Tooling. Rewrites a shell command and condenses its output before the model sees it.",
  ponytail: "Size. Caps the diff at the smallest complete change.",
  model: "The turn itself, with one block per active mode in context.",
  tool: "A tool call leaves the model. RTK rewrites it first when RTK is on.",
  filtered: "The result the model reads: signal kept, noise dropped.",
  reply: "What comes back, in caveman's voice at ponytail's size.",
};

const STEPS = [
  {
    title: "Install into an agent",
    body: "One package writes the extension tree for the agent you pick. Every extension speaks the same API, so the tree is the only difference.",
    command: "tersio install --host omp|pi|opencode",
  },
  {
    title: "Pick a preset",
    body: "Combo sets caveman, RTK, and Ponytail together. It leaves pstack where you had it, because pstack is opt-in.",
    command: "/combo balanced",
  },
  {
    title: "Turn a mode on its own",
    body: "Each mode answers to its own command, and a switch reaches every sibling through the shared bridge without a reload.",
    command: "/pstack on",
  },
  {
    title: "Check what ran",
    body: "This dashboard reads the one store every host feeds. Doctor checks the install, and upstream compares the ported bodies to their pins.",
    command: "tersio doctor",
  },
] as const;

interface HostState {
  installed: Record<string, boolean>;
  versions: Record<string, string | null>;
}

function NodeButton({
  box,
  off,
  selected,
  accent,
  label,
  onSelect,
  onHover,
  children,
}: {
  box: Box;
  off?: boolean;
  selected: boolean;
  accent?: boolean;
  label: string;
  onSelect: () => void;
  onHover: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
      className={cn(
        "absolute flex cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded-xl border border-line bg-panel px-3 py-2 text-left transition-[opacity,border-color,box-shadow] duration-200 outline-none",
        "hover:border-accent/50 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40",
        off && "border-dashed opacity-45",
        accent && "border-accent/40",
        selected && "border-accent ring-2 ring-accent/30",
      )}
    >
      {children}
    </button>
  );
}

function Port({ x, y }: { x: number; y: number }) {
  return <circle cx={x} cy={y} r={3} fill="var(--panel)" stroke="var(--dim)" strokeWidth={1.5} />;
}

function PipelineCanvas({
  modes,
  hostState,
  onToggle,
  busy,
}: {
  modes: ModeState | null;
  hostState: HostState;
  onToggle: (node: NodeId, nextOn: boolean) => void;
  busy: NodeId | null;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<{ key: keyof typeof LAYOUTS; fit: number }>({ key: "wide", fit: 1 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<NodeId | null>(null);
  const [panning, setPanning] = useState(false);
  const [hovered, setHovered] = useState<NodeId | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const lastKey = useRef<keyof typeof LAYOUTS>("wide");

  // Pick the design space that suits the width, then stretch it to fill. A layout change is a new
  // canvas, so the pan and zoom start over with it.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = (): void => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const key: keyof typeof LAYOUTS = width < 560 ? "narrow" : width < 900 ? "medium" : "wide";
      if (key !== lastKey.current) {
        lastKey.current = key;
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
      setView({ key, fit: width / LAYOUTS[key].w });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = LAYOUTS[view.key];
  const scale = view.fit * zoom;
  const lit = (key: EdgeKey): Lit => {
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
    return modes.pstackDefault !== "off";
  };
  const rtkOff = isOff(lit("rtk"));
  const cavemanOff = isOff(lit("caveman"));
  const ponytailOff = isOff(lit("ponytail"));
  const replyNote = cavemanOff && ponytailOff
    ? "plain reply"
    : cavemanOff
      ? "ponytail size"
      : ponytailOff
        ? "caveman voice"
        : "caveman voice, ponytail size";

  const isNodeOff = (id: NodeId): boolean => {
    if (id === "hosts") return hostState.installed && !Object.values(hostState.installed).some(Boolean);
    if (id.startsWith("host-")) return isOff(lit(id.slice(5) as EdgeKey));
    if (id === "combo" || id === "caveman" || id === "pstack" || id === "rtk" || id === "ponytail") return isOff(lit(id));
    if (id === "tool" || id === "filtered") return rtkOff;
    return false;
  };

  /** The boxes a point sits on, so a link can name the nodes it joins without a second table. */
  const nodeAt = (p: Point): NodeId | null => {
    for (const [id, b] of layout.nodes) {
      if (p[0] >= b.x - 1 && p[0] <= b.x + b.w + 1 && p[1] >= b.y - 1 && p[1] <= b.y + b.h + 1) return id;
    }
    return null;
  };
  const touches = (points: ReadonlyArray<Point>, id: NodeId): boolean =>
    nodeAt(points[0]) === id || nodeAt(points[points.length - 1]) === id;

  const focus = hovered ?? selected;
  const zoomed = zoom !== 1 || pan.x !== 0 || pan.y !== 0;

  const body = (id: NodeId): React.ReactNode => {
    if (id === "hosts") {
      return (
        <>
          {HOSTS.map((host) => {
            const off = isOff(lit(host.id));
            return (
              <span key={host.id} className={cn("flex min-w-0 items-center gap-1.5", off && "opacity-45")}>
                <AgentLogo host={host.id} className="size-3 shrink-0" />
                <span className="min-w-0 truncate text-[11px] font-semibold">{host.label}</span>
                <span className="mono ml-auto shrink-0 text-[9px] text-dim">
                  {off ? "not installed" : versionOf(hostState.versions[host.id]) ?? "installed"}
                </span>
              </span>
            );
          })}
        </>
      );
    }
    if (id.startsWith("host-")) {
      const host = HOSTS.find((h) => `host-${h.id}` === id);
      if (!host) return null;
      const off = isOff(lit(host.id));
      return (
        <>
          <span className="flex items-center gap-2">
            <AgentLogo host={host.id} className="size-4 shrink-0" />
            <span className="truncate text-[13px] font-semibold">{host.label}</span>
          </span>
          <span className="mono text-[10px] text-dim">
            {off ? "not installed" : versionOf(hostState.versions[host.id]) ?? "installed"}
          </span>
        </>
      );
    }
    if (id === "combo") {
      const off = isOff(lit("combo"));
      return (
        <>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold">
            <span aria-hidden="true">🧩</span> Combo preset
          </span>
          <span className="mono text-[10px] text-dim">{off ? "off" : "caveman · RTK · Ponytail"}</span>
        </>
      );
    }
    if (id === "session") {
      return (
        <>
          <span className="text-[13px] font-semibold">Session start</span>
          <span className="mono text-[10px] leading-snug text-dim">restore defaults, share the mode state</span>
        </>
      );
    }
    const mode = MODES.find((m) => m.key === id);
    if (mode) {
      const off = isOff(lit(mode.key));
      return (
        <>
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="text-[12px]">
              {mode.glyph}
            </span>
            <span className="text-[13px] font-semibold">{mode.name}</span>
            <span
              className={cn(
                "mono ml-auto rounded border px-1 text-[9px]",
                off ? "border-line text-dim" : "border-accent/40 text-accent",
              )}
            >
              {off ? "off" : mode.role}
            </span>
          </span>
          <span className="mono truncate text-[10px] text-dim">{mode.note}</span>
        </>
      );
    }
    const step = TURN.find((t) => t.id === id) ?? TURN[0];
    const off = "rtk" in step && rtkOff;
    return (
      <>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Icon name={step.icon} className="size-3.5 shrink-0 text-dim" /> {step.title}
        </span>
        <span className="mono truncate text-[10px] text-dim">
          {step.id === "reply" ? replyNote : off && "offNote" in step ? step.offNote : step.note}
        </span>
      </>
    );
  };

  const titleOf = (id: NodeId): string => {
    if (id === "hosts") return "Agents";
    if (id.startsWith("host-")) return HOSTS.find((h) => `host-${h.id}` === id)?.label ?? id;
    if (id === "combo") return "Combo preset";
    if (id === "session") return "Session start";
    const mode = MODES.find((m) => m.key === id);
    if (mode) return mode.name;
    return TURN.find((t) => t.id === id)?.title ?? id;
  };

  const stateOf = (id: NodeId): { label: string; on: boolean | null } => {
    if (id.startsWith("host-")) {
      const key = id.slice(5);
      const on = lit(key as EdgeKey);
      return { label: isOff(on) ? "not installed" : versionOf(hostState.versions[key]) ?? "installed", on };
    }
    if (id === "hosts") {
      const count = Object.values(hostState.installed).filter(Boolean).length;
      return { label: `${count} of ${HOSTS.length} installed`, on: count > 0 };
    }
    if (id === "session") return { label: "always on", on: true };
    if (id === "combo") {
      const on = lit("combo");
      return { label: isOff(on) ? "off" : modes?.comboLevel || modes?.comboDefault || "on", on };
    }
    if (id === "caveman" || id === "ponytail") {
      const on = lit(id);
      const level = id === "caveman" ? modes?.cavemanDefault : modes?.ponytailDefault;
      return { label: isOff(on) ? "off" : level || "on", on };
    }
    if (id === "pstack") {
      const on = lit("pstack");
      return { label: isOff(on) ? "off" : "on", on };
    }
    if (id === "rtk") {
      const on = lit("rtk");
      return { label: isOff(on) ? "off" : "on", on };
    }
    const off = (id === "tool" || id === "filtered") && rtkOff;
    return { label: off ? "off" : "on", on: !off };
  };

  const selectedState = selected ? stateOf(selected) : null;
  const spec = selected ? TOGGLE[selected] : undefined;
  const nextOn = selectedState?.on === false;
  const nextValue = spec ? (nextOn ? spec.onValue : spec.offValue) : null;
  // A boolean switch reads as on or off in the command, the way /rtk takes it.
  const commandValue = typeof nextValue === "boolean" ? (nextValue ? "on" : "off") : nextValue;
  const nextCommand = selected && spec ? `/${selected} ${commandValue}` : null;

  const zoomBy = (factor: number): void => {
    setZoom((z) => Math.min(2.4, Math.max(0.6, Number((z * factor).toFixed(2)))));
  };

  return (
    <div>
      <div
        ref={boxRef}
        role="group"
        aria-label="Pipeline canvas"
        className={cn(
          "relative overflow-hidden rounded-lg border border-line",
          "[background-image:radial-gradient(circle_at_1px_1px,var(--line)_1px,transparent_0)] [background-size:16px_16px]",
        )}
        style={{ height: layout.h * view.fit, cursor: panning ? "grabbing" : "grab" }}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          if (event.pointerType !== "mouse" || target.closest("button")) return;
          drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
          setPanning(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          setPan({ x: start.px + (event.clientX - start.x), y: start.py + (event.clientY - start.y) });
        }}
        onPointerUp={() => { drag.current = null; setPanning(false); }}
        onPointerCancel={() => { drag.current = null; setPanning(false); }}
        onWheel={(event) => {
          // A bare wheel belongs to the page; the canvas only takes it with the zoom modifier.
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const px = event.clientX - rect.left;
          const py = event.clientY - rect.top;
          const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
          const next = Math.min(2.4, Math.max(0.6, zoom * factor));
          const ratio = next / zoom;
          setPan((p) => ({ x: px - (px - p.x) * ratio, y: py - (py - p.y) * ratio }));
          setZoom(next);
        }}
        onPointerLeave={() => { drag.current = null; setPanning(false); }}
      >
        <div
          className="absolute origin-top-left"
          style={{ width: layout.w, height: layout.h, transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={layout.w}
            height={layout.h}
            viewBox={`0 0 ${layout.w} ${layout.h}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="howto-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="8"
                markerHeight="8"
                markerUnits="userSpaceOnUse"
                orient="auto-start-reverse"
              >
                <path d="M0 0 L10 5 L0 10 z" fill="var(--dim)" />
              </marker>
            </defs>
            <g fill="none" strokeLinejoin="round" strokeLinecap="round">
              {layout.links.map((link) => {
                const off = link.k ? isOff(lit(link.k)) : false;
                // A focused node keeps its own routes readable and lets the rest recede.
                const dim = focus !== null && !touches(link.p, focus);
                return (
                  <path
                    key={ortho(link.p)}
                    d={ortho(link.p)}
                    stroke="var(--line)"
                    strokeWidth={1.5}
                    strokeOpacity={dim ? 0.18 : off ? 0.3 : 1}
                    markerEnd={link.arrow && !off && !dim ? "url(#howto-arrow)" : undefined}
                  />
                );
              })}
              {layout.links
                .filter((link) => !(link.k && isOff(lit(link.k))))
                .filter((link) => focus === null || touches(link.p, focus))
                .map((link) => (
                  <path
                    key={`flow-${ortho(link.p)}`}
                    d={ortho(link.p)}
                    className="flow-line"
                    stroke="var(--accent)"
                    strokeWidth={1.5}
                    strokeOpacity={0.75}
                  />
                ))}
              <path
                d={ortho(layout.loop)}
                stroke="var(--accent)"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                strokeOpacity={rtkOff ? 0.3 : focus !== null && !touches(layout.loop, focus) ? 0.18 : 1}
                markerEnd={rtkOff ? undefined : "url(#howto-arrow)"}
                className={rtkOff ? undefined : "flow-loop"}
              />
              {layout.links.map((link) => link.p[0]).map(([x, y]) => (
                <Port key={`${x}-${y}`} x={x} y={y} />
              ))}
            </g>
            {layout.captions.map((caption) => (
              <text
                key={caption.text}
                x={caption.x}
                y={caption.y}
                textAnchor={caption.anchor ?? "start"}
                fontSize={10}
                fill="var(--dim)"
                className="mono"
              >
                {caption.text}
              </text>
            ))}
          </svg>

          {layout.nodes.map(([id, box]) => {
            const state = stateOf(id);
            return (
              <NodeButton
                key={id}
                box={box}
                off={isNodeOff(id)}
                selected={selected === id}
                accent={id === "reply" && !(cavemanOff && ponytailOff)}
                label={`${titleOf(id)}, ${state.label}`}
                onSelect={() => setSelected((current) => (current === id ? null : id))}
                onHover={(on) => setHovered(on ? id : null)}
              >
                {body(id)}
              </NodeButton>
            );
          })}
        </div>

        <div className="absolute top-2 right-2 flex items-center gap-1 rounded-lg border border-line bg-panel/90 p-1 backdrop-blur">
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.2)}
            aria-label="Zoom out"
            className="grid size-6 cursor-pointer place-items-center rounded-md text-dim hover:bg-track hover:text-ink"
          >
            <Icon name="zoom-out" className="size-3.5" />
          </button>
          <span className="mono w-9 text-center text-[10px] text-dim">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => zoomBy(1.2)}
            aria-label="Zoom in"
            className="grid size-6 cursor-pointer place-items-center rounded-md text-dim hover:bg-track hover:text-ink"
          >
            <Icon name="zoom-in" className="size-3.5" />
          </button>
          {zoomed ? (
            <button
              type="button"
              onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
              aria-label="Reset the view"
              className="mono grid h-6 cursor-pointer place-items-center rounded-md px-1.5 text-[10px] text-dim hover:bg-track hover:text-ink"
            >
              reset
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-2 min-h-[74px] rounded-xl border border-line px-3 py-2.5">
        {selected && selectedState ? (
          <div className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold">{titleOf(selected)}</span>
              <span className="mono rounded border border-line px-1 text-[9px] text-dim">{selectedState.label}</span>
              {spec ? (
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto h-6 px-2 text-[11px]"
                  disabled={busy !== null}
                  onClick={() => onToggle(selected, nextOn)}
                >
                  {busy === selected ? "Saving" : nextOn ? "Turn on" : "Turn off"}
                </Button>
              ) : null}
            </div>
            <p className="m-0 text-[11px] leading-relaxed text-dim">{ABOUT[selected]}</p>
            {nextCommand ? <code className="mono w-fit rounded bg-track/40 px-1.5 py-0.5 text-[10px] text-ink">{nextCommand}</code> : null}
          </div>
        ) : (
          <p className="m-0 text-[11px] leading-relaxed text-dim">
            Click a node to inspect it. Drag to pan, and use the controls to zoom.
          </p>
        )}
      </div>
    </div>
  );
}

export function HowToPage({ modes, onModesChanged }: { modes: ModeState | null; onModesChanged: () => void }) {
  const toast = useToast();
  const [hostState, setHostState] = useState<HostState>({ installed: {}, versions: {} });
  const [busy, setBusy] = useState<NodeId | null>(null);

  useEffect(() => {
    // An exported file has no server, so a failed read leaves the hosts unknown and every node lit.
    fetch("/api/hosts")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: Array<{ id: string; installed: boolean }> | null) => {
        if (rows) setHostState((s) => ({ ...s, installed: Object.fromEntries(rows.map((row) => [row.id, row.installed])) }));
      })
      .catch(() => { /* keep them unknown */ });
    void fetchHealth().then((report) => {
      if (!report) return;
      setHostState((s) => ({
        ...s,
        versions: { omp: versionOf(report.omp), pi: versionOf(report.pi), opencode: versionOf(report.opencode) },
      }));
    });
  }, []);

  const toggle = (node: NodeId, nextOn: boolean): void => {
    const spec = TOGGLE[node];
    if (!spec) return;
    setBusy(node);
    void fetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [spec.field]: nextOn ? spec.onValue : spec.offValue }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; error?: string } | null) => {
        if (d?.ok) {
          toast(`${node} ${nextOn ? "on" : "off"}`, "Applies to new sessions.", "check");
          onModesChanged();
        } else {
          toast("Could not save", d?.error ?? "The server refused the change.", "circle-alert");
        }
      })
      .catch(() => toast("Could not save", "The dashboard server did not answer.", "circle-alert"))
      .finally(() => setBusy(null));
  };

  return (
    <Page>
      <PageHeader
        title="How does it work?"
        description="One package, three agents, four modes. This is the path a turn takes from your prompt to the reply, drawn from what this machine has on."
      />

      <Card
        title="The pipeline"
        icon="workflow"
        description="The host loads the extensions. Each mode appends one block to the prompt, then RTK rewrites and filters what the model runs. A dimmed node is off, or not installed. Click a node to inspect it, and switch a mode from the panel under the canvas."
      >
        <PipelineCanvas modes={modes} hostState={hostState} onToggle={toggle} busy={busy} />
      </Card>

      <Card title="Start here" icon="list-ordered" description="Four steps from a fresh machine to a session that reports itself.">
        <ol className="m-0 grid list-none gap-2 p-0 md:grid-cols-2">
          {STEPS.map((step, i) => (
            <li key={step.title} className="grid gap-1 rounded-xl border border-line px-3 py-2.5">
              <span className="flex items-center gap-2">
                <span className="mono grid size-5 shrink-0 place-items-center rounded-full border border-line text-[10px] text-dim">
                  {i + 1}
                </span>
                <span className="text-[13px] font-semibold">{step.title}</span>
              </span>
              <span className="text-[11px] leading-relaxed text-dim">{step.body}</span>
              <code className="mono mt-0.5 block truncate rounded bg-track/40 px-2 py-1 text-[10px] text-ink">
                {step.command}
              </code>
            </li>
          ))}
        </ol>
      </Card>
    </Page>
  );
}
