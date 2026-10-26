// Quick start: the pipeline as one canvas, drawn the way a workflow tool lays it out.
// Everything here mirrors docs/ARCHITECTURE.md: the hosts, the block order, and the turn it produces.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Card, Page, PageHeader } from "@/components/charts";
import { AgentLogo } from "@/components/agent-logos";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePending } from "@/hooks/use-pending";
import { fetchHealth } from "@/lib/data";
import type { ModeState } from "./shell";
import { useToast } from "../toaster";
import { cn } from "cn";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";

type Point = readonly [number, number];
type EdgeKey = "hosts" | "omp" | "pi" | "opencode" | "combo" | "caveman" | "pstack" | "headroom" | "rtk" | "ponytail";

type HostAction = "install" | "uninstall" | "update";

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
 * One design space, drawn per agent: each installed agent owns a column with its dedicated combo
 * preset, the mode blocks stay one shared column in injection order, and the output closes the turn.
 * Adding an agent widens the canvas, so the card pans and zooms instead of squeezing the nodes.
 */
function pipelineLayout(hosts: ReadonlyArray<{ id: string }>, compact: boolean): Layout {
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
      h: Math.max(pairBottom, blocksBottom) + 34,
      nodes,
      links,
      captions: [{ x: 230, y: Math.max(pairBottom, blocksBottom) + 20, text: "appended in this order, one block each" }],
    };
  }
  // Wide card: one column per agent, then the shared block column, then the output.
  hosts.forEach((host, i) => {
    const colX = 20 + i * 244;
    nodes.push(
      [`host-${host.id}` as NodeId, { x: colX, y: 24, w: 200, h: 56 }],
      [`combo-${host.id}` as NodeId, { x: colX, y: 96, w: 200, h: 58 }],
    );
    links.push({ p: [[colX + 100, 80], [colX + 100, 96]], k: host.id as EdgeKey, arrow: true });
  });
  const busY = 430;
  const blockX = 20 + hosts.length * 244 + 40;
  hosts.forEach((host, i) => {
    const colX = 20 + i * 244;
    // Every preset feeds one bus, and the bus enters the block column once.
    links.push({ p: [[colX + 100, 154], [colX + 100, busY], [blockX - 20, busY]], k: host.id as EdgeKey });
  });
  if (hosts.length > 0) links.push({ p: [[blockX - 20, busY], [blockX - 20, 55], [blockX, 55]], k: "caveman", arrow: true });
  BLOCKS.forEach((block, j) => {
    nodes.push([block, { x: blockX, y: 24 + j * 78, w: 230, h: 62 }]);
    if (j > 0) links.push({ p: [[blockX + 115, 24 + (j - 1) * 78 + 62], [blockX + 115, 24 + j * 78]], k: block as EdgeKey, arrow: true });
  });
  const outputX = blockX + 230 + 40;
  nodes.push(["output", { x: outputX, y: 179, w: 240, h: 64 }]);
  links.push({ p: [[blockX + 115, 398], [blockX + 115, 412], [outputX + 120, 412], [outputX + 120, 211], [outputX, 211]], k: "ponytail", arrow: true });
  return {
    w: outputX + 240 + 20,
    h: 480,
    nodes,
    links,
    captions: [{ x: blockX, y: 462, text: "appended in this order, one block each" }],
  };
}

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
  { key: "headroom", glyph: "🍃", name: "headroom", role: "compression", note: "compresses traffic below the shell" },
  { key: "rtk", glyph: "🗜️", name: "rtk", role: "tooling", note: "rewrites and condenses shell" },
  { key: "ponytail", glyph: "🧠", name: "ponytail", role: "size", note: "smallest complete change" },
] as const;

const TURN = [
  { id: "output", icon: "arrow-right", title: "Output", note: "the turn's result" },
] as const;

/** The nodes a click can set, the field each writes, and the levels that field takes. Every per-agent preset node shares the combo entry. */
const PICKER: Record<"combo" | "caveman" | "rtk" | "ponytail" | "pstack" | "headroom", { field: string; options: ReadonlyArray<{ id: string; label: string }> }> = {
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

/** What the folder says about a node. The per-agent preset nodes share the combo entry. */
const ABOUT: Partial<Record<NodeId, string>> & { combo: string } = {
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

const STEPS = [
  {
    title: "Install into an agent",
    body: "One package writes the extension tree for the agent you pick. Every extension speaks the same API, so the tree is the only difference.",
    command: "tersio install --host omp|pi|opencode",
  },
  {
    title: "Pick a preset",
    body: "Combo sets caveman, RTK, and Ponytail together. It leaves pstack and headroom where you had them, because both are opt-in.",
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
  dashed,
  label,
  onSelect,
  onHover,
  children,
}: {
  box: Box;
  off?: boolean;
  selected: boolean;
  accent?: boolean;
  dashed?: boolean;
  label: string;
  onSelect: () => void;
  onHover: (on: boolean) => void;
  children: React.ReactNode;
}) {
  // A mode switch or a finished install changes the label; that change gets one soft ring.
  const [pulse, setPulse] = useState<string | null>(null);
  const previous = useRef(label);
  useEffect(() => {
    if (previous.current === label) return;
    previous.current = label;
    setPulse(label);
    const timer = window.setTimeout(() => setPulse(null), 600);
    return () => window.clearTimeout(timer);
  }, [label]);

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
        "howto-node absolute flex cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded-xl border border-line bg-panel px-3 py-2 text-left outline-none",
        "hover:border-accent/50 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40",
        dashed && "items-center border-2 border-dashed bg-panel text-dim hover:border-accent/50 hover:text-ink",
        off && "border-2 border-dashed opacity-55",
        accent && "border-accent/40",
        selected && "border-accent ring-2 ring-accent/30",
      )}
    >
      {pulse ? <span key={pulse} aria-hidden="true" className="howto-pulse pointer-events-none absolute inset-0 rounded-xl ring-2 ring-accent/50" /> : null}
      {children}
    </button>
  );
}

/** One small action in the node menu: a level, a host command, or an install. */
function MenuAction({ onClick, disabled, danger, children }: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "mono cursor-pointer rounded-md border px-1.5 py-1 text-[10px] transition-colors disabled:cursor-default disabled:opacity-40",
        danger
          ? "border-destructive/50 text-destructive hover:bg-destructive/10"
          : "border-line text-dim hover:border-accent/50 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

/** The folder menu hangs off the node in screen space, so it keeps its type size at any zoom. */
const MENU_WIDTH = 292;

/**
 * The node menu as a file folder: a tab carries the mode's name, and the body unfolds from under it
 * in one 3D fold while the option sheets stagger in. A selection change remounts the folder, so the
 * fold replays; reduced-motion readers get the final state immediately.
 */
function NodeFolder({
  title,
  glyph,
  stateLabel,
  about,
  busy,
  x,
  y,
  onClose,
  children,
  footer,
}: {
  title: string;
  glyph: string | null;
  stateLabel: string | null;
  about: string;
  busy: boolean;
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    if (!sheet.current) return;
    const sheets = root.current?.querySelectorAll("[data-sheet]") ?? [];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      gsap.set(sheet.current, { rotateX: 0, opacity: 1 });
      gsap.set(sheets, { y: 0, opacity: 1, scale: 1 });
      return;
    }
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.fromTo(
      sheet.current,
      { rotateX: -72, opacity: 0.35 },
      { rotateX: 0, opacity: 1, duration: 0.5, ease: "back.out(1.5)", transformOrigin: "top center" },
    ).fromTo(
      sheets,
      { y: 12, opacity: 0, scale: 0.96 },
      { y: 0, opacity: 1, scale: 1, duration: 0.34, stagger: 0.045 },
      "-=0.18",
    );
    return () => { tl.kill(); };
  }, { scope: root });

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`${title} options`}
      className="absolute z-20"
      style={{ left: x, top: y, width: MENU_WIDTH }}
    >
      <div className="relative z-10 ml-3 inline-flex h-8 max-w-full items-center gap-2 rounded-t-lg border border-b-0 border-line bg-track px-3">
        {glyph ? <span aria-hidden="true" className="text-[11px] leading-none">{glyph}</span> : null}
        <span className="text-[12px] font-semibold leading-none">{title}</span>
        {stateLabel ? (
          <span className="mono rounded border border-line px-1 py-px text-[9px] leading-none text-dim">{stateLabel}</span>
        ) : null}
        {busy ? <span className="mono text-[9px] leading-none text-accent">working</span> : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close options"
          className="ml-auto grid size-5 cursor-pointer place-items-center rounded text-dim hover:bg-panel hover:text-ink"
        >
          <Icon name="x" className="size-3" />
        </button>
      </div>
      <div style={{ perspective: "900px" }}>
        <div
          ref={sheet}
          className="grid gap-1 rounded-b-xl rounded-tr-xl border border-line bg-panel p-2.5 shadow-xl will-change-transform"
        >
          <p data-sheet className="m-0 text-[10px] leading-relaxed text-dim">{about}</p>
          {children}
          {footer}
        </div>
      </div>
    </div>
  );
}

/** One option sheet inside the folder: a full-width row with a check chip, so no label ever wraps. */
function OptionSheet({
  label,
  active,
  disabled,
  onClick,
  hint,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  hint?: string;
}) {
  return (
    <button
      data-sheet
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition-all duration-300 ease-out",
        active
          ? "border-accent/60 bg-accent-soft"
          : "border-transparent hover:border-line hover:bg-track/60",
        disabled && "cursor-default opacity-50",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
          active ? "border-accent bg-accent text-panel" : "border-line text-transparent group-hover:border-dim",
        )}
      >
        <Icon name="check" className="size-3" />
      </span>
      <span className={cn("mono truncate text-[11px]", active ? "text-ink" : "text-dim group-hover:text-ink")}>{label}</span>
      <span className={cn("mono ml-auto shrink-0 text-[9px]", active ? "text-accent" : "text-transparent")}>
        {hint ?? "current"}
      </span>
    </button>
  );
}

function PipelineCanvas({
  modes,
  hostState,
  onSet,
  onHostAction,
  busy,
}: {
  modes: ModeState | null;
  hostState: HostState;
  onSet: (node: NodeId, field: string, value: string | boolean, host?: "omp" | "pi" | "opencode") => void;
  onHostAction: (node: NodeId, action: HostAction) => void;
  busy: NodeId | null;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<NodeId | null>(null);
  // The combo folder scopes its preset: the shared default, or one agent's own section. Opening a
  // per-agent preset node starts on that agent's scope.
  const [scope, setScope] = useState<"all" | "omp" | "pi" | "opencode">("all");
  const [confirming, setConfirming] = useState<NodeId | null>(null);
  const [panning, setPanning] = useState(false);
  const [hovered, setHovered] = useState<NodeId | null>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  // The canvas draws at its own width and the card scales it; drag and the zoom controls reach the rest.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = (): void => setContainerW(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

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
    if (key === "headroom") return modes.headroomDefault !== "off";
    return modes.pstackDefault !== "off";
  };
  // An unknown host stays on the canvas: an exported file reads no host list.
  const shownHosts = HOSTS.filter((host) => hostState.installed[host.id] !== false);
  const compact = containerW > 0 && containerW < 620;
  const layout = pipelineLayout(shownHosts, compact);
  const fit = containerW > 0 ? containerW / layout.w : 1;
  const scale = fit * zoom;

  const isNodeOff = (id: NodeId): boolean => {
    if (id.startsWith("host-")) return isOff(lit(id.slice(5) as EdgeKey));
    if (id.startsWith("combo-")) {
      const host = id.slice(6);
      const own = modes?.hosts?.[host]?.comboDefault;
      const level = typeof own === "string" ? own : modes?.comboLevel || modes?.comboDefault || "on";
      return level === "off";
    }
    if (id === "caveman" || id === "pstack" || id === "headroom" || id === "rtk" || id === "ponytail") return isOff(lit(id));
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
    if (id.startsWith("combo-")) {
      const host = id.slice(6);
      const label = HOSTS.find((h) => h.id === host)?.label ?? host;
      const own = modes?.hosts?.[host]?.comboDefault;
      const level = typeof own === "string" ? own : modes?.comboLevel || modes?.comboDefault || "on";
      return (
        <>
          <span className="flex items-center gap-1.5 text-[13px] font-semibold">
            <span aria-hidden="true">🧩</span> Combo · {label}
          </span>
          <span className="mono text-[10px] text-dim">
            {level === "off" ? "off" : typeof own === "string" ? `${level} — this agent` : `${level} — shared`}
          </span>
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
    return (
      <>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Icon name="arrow-right" className="size-3.5 shrink-0 text-dim" /> Output
        </span>
        <span className="mono truncate text-[10px] text-dim">the turn's result</span>
      </>
    );
  };

  const titleOf = (id: NodeId): string => {
    if (id.startsWith("host-")) return HOSTS.find((h) => `host-${h.id}` === id)?.label ?? id;
    if (id.startsWith("combo-")) {
      const label = HOSTS.find((h) => `combo-${h.id}` === id)?.label ?? id.slice(6);
      return `Combo · ${label}`;
    }
    const mode = MODES.find((m) => m.key === id);
    if (mode) return mode.name;
    return TURN.find((t) => t.id === id)?.title ?? id;
  };

  const glyphOf = (id: NodeId): string | null => {
    if (id.startsWith("combo-")) return "🧩";
    return MODES.find((m) => m.key === id)?.glyph ?? null;
  };

  const stateOf = (id: NodeId): { label: string; on: boolean | null } => {
    if (id.startsWith("host-")) {
      const key = id.slice(5);
      const on = lit(key as EdgeKey);
      return { label: isOff(on) ? "not installed" : versionOf(hostState.versions[key]) ?? "installed", on };
    }
    if (id.startsWith("combo-")) {
      const host = id.slice(6);
      const own = modes?.hosts?.[host]?.comboDefault;
      const level = typeof own === "string" ? own : modes?.comboLevel || modes?.comboDefault || "on";
      return { label: level, on: level !== "off" };
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
    if (id === "headroom") {
      const on = lit("headroom");
      return { label: isOff(on) ? "off" : "on", on };
    }
    if (id === "rtk") {
      const on = lit("rtk");
      return { label: isOff(on) ? "off" : "on", on };
    }
    return { label: "on", on: true };
  };

  const selectedState = selected ? stateOf(selected) : null;
  const MENU_WIDTH = 292;
  const MENU_ESTIMATE = 240;
  const viewportW = layout.w * fit;
  const viewportH = layout.h * fit;
  const selectedBox = selected ? layout.nodes.find(([id]) => id === selected)?.[1] ?? null : null;
  const hostId = selected?.startsWith("host-") ? selected.slice("host-".length) : null;
  const hostInstalled = hostId !== null && !isOff(lit(hostId as EdgeKey));
  // The menu hangs off the node in screen space, so it keeps its type size at any zoom.
  const menu = selectedBox
    ? {
      left: Math.min(Math.max(8, selectedBox.x * scale + pan.x), Math.max(8, viewportW - MENU_WIDTH - 8)),
      top: (selectedBox.y + selectedBox.h) * scale + pan.y + MENU_ESTIMATE <= viewportH
        ? (selectedBox.y + selectedBox.h) * scale + pan.y + 8
        : Math.max(8, selectedBox.y * scale + pan.y - MENU_ESTIMATE - 8),
    }
    : null;
  const pickerKey = selected == null ? null : selected.startsWith("combo-") ? "combo" : selected;
  const picker = pickerKey !== null && pickerKey in PICKER ? PICKER[pickerKey as keyof typeof PICKER] : undefined;
  const currentValue = (id: NodeId): string | null => {
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
  };
  const current = selected ? currentValue(selected) : null;
  // A host scope without its own section inherits the shared value, so the sheet says so.
  const inherited = selected?.startsWith("combo-") && scope !== "all" && typeof modes?.hosts?.[scope]?.comboDefault !== "string";
  // `custom` is what the three modes say, so it matches no preset button and names no command.
  const picked = picker && current !== null && picker.options.some((option) => option.id === current) ? current : null;

  useEffect(() => {
    // Opening a per-agent preset node starts on that agent's scope; the shared node starts on all.
    setScope(selected?.startsWith("combo-") ? (selected.slice(6) as "omp" | "pi" | "opencode") : "all");
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const zoomBy = (factor: number): void => {
    setZoom((z) => Math.min(2.4, Math.max(0.6, Number((z * factor).toFixed(2)))));
  };

  return (
    <div className="relative">
      <div
        ref={boxRef}
        role="group"
        aria-label="Pipeline canvas"
        className={cn(
          // A drag pans the canvas; it never selects a label or a file path on the way.
          "relative touch-none overflow-hidden rounded-lg border border-line select-none",
          "[background-image:radial-gradient(circle_at_1px_1px,var(--line)_1px,transparent_0)] [background-size:16px_16px]",
        )}
        style={{ height: layout.h * fit, cursor: panning ? "grabbing" : "grab" }}
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button")) return;
          setSelected(null);
          if (event.pointerType !== "mouse") return;
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
        onDragStart={(event) => event.preventDefault()}
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
                    className="howto-link"
                    stroke="var(--line)"
                    strokeWidth={1.5}
                    strokeOpacity={dim ? 0.4 : off ? 0.45 : 1}
                    markerEnd={link.arrow && !off && !dim ? "url(#howto-arrow)" : undefined}
                  />
                );
              })}
              {layout.links
                .filter((link) => !(link.k && isOff(lit(link.k))))
                .map((link) => (
                  <path
                    key={`flow-${ortho(link.p)}`}
                    d={ortho(link.p)}
                    className="flow-line howto-link"
                    stroke="var(--accent)"
                    strokeWidth={1.5}
                    // A focused node keeps its own dashes bright; the rest stay readable, just quiet.
                    strokeOpacity={focus === null || touches(link.p, focus) ? 0.75 : 0.3}
                  />
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
                dashed={false}
                label={`${titleOf(id)}, ${state.label}`.replace(/, $/, "")}
                onSelect={() => { setSelected((open) => (open === id ? null : id)); setConfirming(null); }}
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

      {selected && selectedState && menu ? (
        <NodeFolder
          key={selected}
          x={menu.left}
          y={menu.top}
          title={titleOf(selected)}
          glyph={glyphOf(selected)}
          stateLabel={selectedState.label}
          about={ABOUT[selected] ?? ""}
          busy={busy === selected}
          onClose={() => setSelected(null)}
          footer={
            picker ? (
              <div data-sheet className="mt-0.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-1.5">
                {picked ? (
                  <code className="mono rounded bg-track/40 px-1.5 py-0.5 text-[10px] text-ink">/{selected} {picked}</code>
                ) : null}
                <span className="mono ml-auto text-[9px] text-dim">
                  {selected?.startsWith("combo-") && scope !== "all" ? `saves for ${scope} only` : "every agent reads this"}
                </span>
              </div>
            ) : undefined
          }
        >
          {hostId ? (
            <div data-sheet className="flex flex-wrap items-center gap-1.5">
              {hostInstalled ? (
                <MenuAction disabled={busy !== null} onClick={() => onHostAction(selected, "update")}>Update</MenuAction>
              ) : (
                <MenuAction disabled={busy !== null} onClick={() => onHostAction(selected, "install")}>Install</MenuAction>
              )}
              {hostInstalled ? (
                confirming === selected ? (
                  <MenuAction danger disabled={busy !== null} onClick={() => onHostAction(selected, "uninstall")}>Confirm uninstall</MenuAction>
                ) : (
                  <MenuAction disabled={busy !== null} onClick={() => setConfirming(selected)}>Uninstall</MenuAction>
                )
              ) : null}
            </div>
          ) : null}
          {selected?.startsWith("combo-") && picker ? (
            <div data-sheet className="flex items-center gap-1">
              {(["all", "omp", "pi", "opencode"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={scope === s}
                  onClick={() => setScope(s)}
                  className={cn(
                    "mono flex-1 cursor-pointer rounded-md border px-1 py-1 text-[9px] transition-colors",
                    scope === s ? "border-accent bg-accent-soft text-ink" : "border-line text-dim hover:border-accent/50 hover:text-ink",
                  )}
                >
                  {s === "all" ? "all agents" : s}
                </button>
              ))}
            </div>
          ) : null}
          {picker ? (
            picker.options.map((option) => (
              <OptionSheet
                key={option.id}
                label={option.label}
                active={current === option.id}
                disabled={busy !== null}
                hint={inherited && current === option.id ? "inherited" : undefined}
                onClick={() => onSet(selected, picker.field, picker.field === "rtkDefault" ? option.id === "on" : option.id, selected.startsWith("combo-") && scope !== "all" ? scope : undefined)}
              />
            ))
          ) : null}
        </NodeFolder>
      ) : null}
      <p className="mono m-0 mt-2 text-[10px] text-dim">
        Click a node for its options. Drag to pan, and use the controls to zoom.
      </p>
    </div>
  );
}

/** The canvas's shape while the host list is still out: agent column, mode column, output. */
function PipelineSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading the pipeline"
      className="flex min-h-[260px] flex-wrap items-center gap-6 rounded-lg border border-line p-4"
    >
      <div className="grid gap-3">
        {[0, 1, 2].map((row) => <Skeleton key={row} className="h-12 w-40 rounded-xl" />)}
      </div>
      <div className="grid gap-3">
        {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-12 w-44 rounded-xl" />)}
      </div>
      <Skeleton className="h-16 w-52 rounded-xl" />
    </div>
  );
}

/** An exported file has no server, so a failed read leaves the hosts unknown and every node lit. */
function readHosts(): Promise<Array<{ id: string; installed: boolean }> | null> {
  return fetch("/api/hosts")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

export function HowToPage({ modes, onModesChanged }: { modes: ModeState | null; onModesChanged: () => void }) {
  const toast = useToast();
  const [hostState, setHostState] = useState<HostState>({ installed: {}, versions: {} });
  const [busy, setBusy] = useState<NodeId | null>(null);
  // Adding an agent lives in the card header, separate from the mode workflow it feeds.
  const [addOpen, setAddOpen] = useState(false);
  const missingHosts = HOSTS.filter((host) => hostState.installed[host.id] === false);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const pipelinePending = usePending(!hostsLoaded);

  useEffect(() => {
    void readHosts()
      .then((rows) => {
        if (rows) setHostState((s) => ({ ...s, installed: Object.fromEntries(rows.map((row) => [row.id, row.installed])) }));
      })
      .finally(() => setHostsLoaded(true));
    void fetchHealth().then((report) => {
      if (!report) return;
      setHostState((s) => ({
        ...s,
        versions: { omp: versionOf(report.omp), pi: versionOf(report.pi), opencode: versionOf(report.opencode) },
      }));
    });
  }, []);

  const save = (node: NodeId, field: string, value: string | boolean, host?: "omp" | "pi" | "opencode"): void => {
    setBusy(node);
    void fetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value, ...(host ? { host } : {}) }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; error?: string } | null) => {
        if (d?.ok) {
          toast(`${node} ${typeof value === "boolean" ? (value ? "on" : "off") : value}`, "Applies to new sessions.", "check");
          onModesChanged();
        } else {
          toast("Could not save", d?.error ?? "The server refused the change.", "circle-alert");
        }
      })
      .catch(() => toast("Could not save", "The dashboard server did not answer.", "circle-alert"))
      .finally(() => setBusy(null));
  };

  // The CLI runs install, uninstall, and update in its own process, so the page asks the server
  // whether that child is still running instead of guessing from the tree on disk.
  const hostAction = (node: NodeId, action: HostAction): void => {
    const host = node.slice("host-".length);
    setBusy(node);
    void fetch("/api/hosts/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, action }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; error?: string } | null) => {
        if (!d?.ok) {
          toast(`Could not ${action} ${host}`, d?.error ?? "The server refused the request.", "circle-alert");
          setBusy(null);
          return;
        }
        toast(`${host}: ${action} started`, "It runs in the background.", "check");
        const started = Date.now();
        const timer = window.setInterval(() => {
          void fetch("/api/hosts/action")
            .then((r) => (r.ok ? r.json() : null))
            .then((jobs: Array<{ host: string; action: string; code: number | null }> | null) => {
              const job = jobs?.find((entry) => entry.host === host && entry.action === action && entry.code !== null);
              // A child that never reports back still has to hand the menu back.
              if (!job && Date.now() - started < 120_000) return;
              window.clearInterval(timer);
              setBusy(null);
              void readHosts().then((rows) => {
                if (rows) setHostState((s) => ({ ...s, installed: Object.fromEntries(rows.map((row) => [row.id, row.installed])) }));
              });
              void fetchHealth().then((report) => {
                if (!report) return;
                const version = versionOf(report[host as "omp" | "pi" | "opencode"]);
                if (version) setHostState((s) => ({ ...s, versions: { ...s.versions, [host]: version } }));
              });
              if (job?.code === 0) {
                toast(`${host}: ${action} done`, "The agent list is up to date.", "check");
              } else if (job) {
                toast(`${host}: ${action} failed`, `The command exited with code ${job.code}.`, "circle-alert");
              } else {
                toast(`${host}: ${action} is still running`, "Reload the page in a moment to see the result.", "circle-alert");
              }
            })
            .catch(() => { /* the next tick tries again */ });
        }, 1000);
      })
      .catch(() => {
        toast(`Could not ${action} ${host}`, "The dashboard server did not answer. Restart it to load the host actions.", "circle-alert");
        setBusy(null);
      });
  };

  return (
    <Page>
      <PageHeader
        title="Quick start"
        description="One package, three agents, five modes. This is the path a turn takes from your prompt to the reply, drawn from what this machine has on."
      />

      <Card
        title="The pipeline"
        icon="workflow"
        description="Each mode appends one block to the prompt, and RTK rewrites and filters what runs. A dimmed node is off or uninstalled — click a node to switch it."
        actions={
          missingHosts.length > 0 ? (
            <div className="relative">
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAddOpen((open) => !open)}>
                <Icon name="plus" className="size-3.5" />
                Add agent
              </Button>
              {addOpen ? (
                <div className="absolute right-0 top-full z-30 mt-1 w-60 rounded-xl border border-line bg-panel p-2 shadow-xl">
                  <p className="mono m-0 px-1 pb-1 text-[9px] text-dim">Installs the Tersio tree for this agent</p>
                  {missingHosts.map((host) => (
                    <div key={host.id} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-track/60">
                      <AgentLogo host={host.id} className="size-3.5 shrink-0" />
                      <span className="truncate text-[11px]">{host.label}</span>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => { setAddOpen(false); hostAction(`host-${host.id}`, "install"); }}
                        className="mono ml-auto cursor-pointer rounded-md border border-line px-1.5 py-1 text-[10px] text-dim transition-colors hover:border-accent/50 hover:text-ink disabled:cursor-default disabled:opacity-40"
                      >
                        Install
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : undefined
        }
      >
        {pipelinePending ? <PipelineSkeleton /> : (
          <PipelineCanvas modes={modes} hostState={hostState} onSet={save} onHostAction={hostAction} busy={busy} />
        )}
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
