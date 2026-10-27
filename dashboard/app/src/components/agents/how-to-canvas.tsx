// The pipeline canvas: node buttons, the fold panel that opens beneath a node, and the pan/zoom loop.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AgentLogo } from "@/components/agent-logos";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/ui/skeleton";
import type { ModeState } from "./shell";
import { cn } from "cn";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  ABOUT, edgeLit, HOSTS, MODES, isOff, nodeOff, nodeState, nodeTitle, nodeValue, ortho,
  pipelineLayout, PICKER, versionOf,
} from "./pipeline-model";
import type { Box, EdgeKey, HostAction, HostState, Lit, NodeId, Point } from "./pipeline-model";


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

/** One node's glyph, shared by the canvas button and the fold panel header. */
function nodeGlyph(id: NodeId): string | null {
  if (id.startsWith("combo-")) return "🧩";
  return MODES.find((m) => m.key === id)?.glyph ?? null;
}

/**
 * The properties fold: a screen-space overlay anchored beneath the clicked node, unfolding from the node's
 * edge. When the space below runs out it flips above and folds from the bottom instead. It keeps its own
 * type size at any zoom, because it never lives inside the canvas transform.
 */
function NodePanel({
  hostRef,
  modes,
  hostState,
  node,
  busy,
  confirming,
  onConfirm,
  onSet,
  onHostAction,
  onClose,
  anchor,
  bounds,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>;
  modes: ModeState | null;
  hostState: HostState;
  node: NonNullable<NodeId | null>;
  busy: NodeId | null;
  confirming: NodeId | null;
  onConfirm: (node: NodeId | null) => void;
  onSet: (node: NodeId, field: string, value: string | boolean, host?: "omp" | "pi" | "opencode") => void;
  onHostAction: (node: NodeId, action: HostAction) => void;
  onClose: () => void;
  anchor: { x: number; y: number; w: number; h: number };
  bounds: { w: number; h: number };
}) {
  const panel = useRef<HTMLElement>(null);
  const WIDTH = 280;
  const GAP = 10;
  // Placement first: measure the rendered panel, pick below or above the node, clamp into the canvas.
  const [place, setPlace] = useState<{ left: number; top: number; origin: "top" | "bottom" } | null>(null);
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    const h = el.offsetHeight;
    let left = Math.round(anchor.x + anchor.w / 2 - WIDTH / 2);
    left = Math.max(8, Math.min(left, Math.max(8, bounds.w - WIDTH - 8)));
    let top = Math.round(anchor.y + anchor.h + GAP);
    let origin: "top" | "bottom" = "top";
    if (top + h > bounds.h - 8) {
      top = Math.round(anchor.y - h - GAP);
      origin = "bottom";
    }
    if (top < 8) {
      // Neither side fits whole: pin below the node's top edge and let the panel's own scroll take over.
      top = 8;
      origin = "top";
    }
    setPlace({ left, top, origin });
  }, [anchor.x, anchor.y, anchor.w, anchor.h, bounds.w, bounds.h, node, modes]);

  useGSAP(() => {
    if (!panel.current || !place) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      gsap.set(panel.current, { rotateX: 0, y: 0, opacity: 1 });
      gsap.set(panel.current.querySelectorAll("[data-sheet]"), { y: 0, opacity: 1 });
      return;
    }
    // The fold: the panel swings out of the node's edge, and the rows rise in behind it.
    const from = place.origin === "top" ? -7 : 7;
    const tl = gsap.timeline({ defaults: { ease: "power3.out" } });
    tl.fromTo(
      panel.current,
      { rotateX: from, y: place.origin === "top" ? -10 : 10, opacity: 0 },
      { rotateX: 0, y: 0, opacity: 1, duration: 0.34, transformOrigin: `${place.origin} center` },
    );
    tl.fromTo(
      panel.current.querySelectorAll("[data-sheet]"),
      { y: 8, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.2, stagger: 0.03 },
      "-=0.12",
    );
    return () => { tl.kill(); };
  }, { scope: panel, dependencies: [node, place?.top, place?.left] });

  const state = nodeState(node, modes, hostState);
  const glyph = nodeGlyph(node);
  const about = ABOUT[node.startsWith("combo-") ? "combo" : node] ?? "";
  const pickerKey = node.startsWith("combo-") ? "combo" : node;
  const picker = pickerKey in PICKER ? PICKER[pickerKey as keyof typeof PICKER] : undefined;
  // A per-agent preset node IS the scope: the panel writes that agent's section and nothing else.
  const scope = node.startsWith("combo-") ? (node.slice(6) as "omp" | "pi" | "opencode") : "all";
  const current = nodeValue(node, scope, modes);
  // A host scope without its own section inherits the shared value, so the row says so.
  const inherited = node.startsWith("combo-") && scope !== "all" && typeof modes?.hosts?.[scope]?.comboDefault !== "string";
  // `custom` is what the three modes say, so it matches no preset button and names no command.
  const picked = picker && current !== null && picker.options.some((option) => option.id === current) ? current : null;
  const hostId = node.startsWith("host-") ? node.slice("host-".length) : null;
  const hostInstalled = hostId !== null && !isOff(edgeLit(hostId as EdgeKey, modes, hostState));
  // No modes yet: a mode node's live state is unknowable, so the skeleton stands in instead of fake "off" rows.
  const pendingRows = !node.startsWith("host-") && !node.startsWith("combo-") && modes === null;

  return (
    <div ref={hostRef} data-node-panel>
      <aside
        ref={panel}
        aria-label="Node properties"
        style={{
          left: place?.left ?? anchor.x,
          top: place?.top ?? anchor.y + anchor.h,
          width: WIDTH,
          transformOrigin: place ? `${place.origin} center` : "top center",
          visibility: place ? undefined : "hidden",
        }}
        className="absolute z-20 flex max-h-[calc(100%-16px)] min-h-0 flex-col rounded-xl border border-line bg-panel shadow-xl shadow-black/25"
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
          {glyph ? <span aria-hidden="true" className="text-[12px] leading-none">{glyph}</span> : null}
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{nodeTitle(node)}</span>
          <span className="mono shrink-0 rounded border border-line px-1.5 py-0.5 text-[9px] leading-none text-dim">{state.label}</span>
          {busy !== null ? <span className="mono shrink-0 text-[9px] leading-none text-accent">working</span> : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close properties"
            className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-dim transition-colors hover:bg-track hover:text-ink"
          >
            <Icon name="x" className="size-3" />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto p-3">
          <p data-sheet className="m-0 pb-0.5 text-[11px] leading-relaxed text-dim">{about}</p>
          {hostId ? (
            <div data-sheet className="flex flex-wrap items-center gap-1.5">
              {hostInstalled ? (
                <MenuAction disabled={busy !== null} onClick={() => onHostAction(node, "update")}>Update</MenuAction>
              ) : (
                <MenuAction disabled={busy !== null} onClick={() => onHostAction(node, "install")}>Install</MenuAction>
              )}
              {hostInstalled ? (
                confirming === node ? (
                  <MenuAction danger disabled={busy !== null} onClick={() => onHostAction(node, "uninstall")}>Confirm uninstall</MenuAction>
                ) : (
                  <MenuAction disabled={busy !== null} onClick={() => onConfirm(node)}>Uninstall</MenuAction>
                )
              ) : null}
            </div>
          ) : null}
          {pendingRows ? (
            <div className="grid gap-1.5" aria-busy="true" aria-hidden="true">
              <Skeleton className="h-8 w-full rounded-md" />
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
          ) : picker ? (
            picker.options.map((option) => (
              <OptionRow
                key={option.id}
                label={option.label}
                active={current === option.id}
                disabled={busy !== null}
                hint={inherited && current === option.id ? "inherited" : undefined}
                onClick={() => onSet(node, picker.field, picker.field === "rtkDefault" ? option.id === "on" : option.id, scope === "all" ? undefined : scope)}
              />
            ))
          ) : null}
        </div>
        {picker ? (
          <footer data-sheet className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
            {picked ? (
              <code className="mono rounded bg-track/40 px-1.5 py-0.5 text-[10px] text-ink">/{node} {picked}</code>
            ) : null}
            <span className="mono ml-auto text-[9px] text-dim">
              {scope !== "all" ? `saves for ${scope} only` : "every agent reads this"}
            </span>
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

/** One option row in the properties panel: a full-width control with the active state carried by a check. */
function OptionRow({
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
        "group flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors duration-150",
        active
          ? "border-accent/60 bg-accent-soft"
          : "border-transparent hover:border-line hover:bg-track/60",
        disabled && "cursor-default opacity-50",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded border transition-colors",
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


/** What the folder says about a node. The per-agent preset nodes share the combo entry. */
export function PipelineCanvas({
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
  const [panning, setPanning] = useState(false);
  const [hovered, setHovered] = useState<NodeId | null>(null);
  // `selected` is the node the panel is for; `shown` is the node actually on screen, so a closing fold
  // can finish before the panel unmounts while a new selection replays the entrance instead.
  const [selected, setSelected] = useState<NodeId | null>(null);
  const [shown, setShown] = useState<NodeId | null>(null);
  const [confirming, setConfirming] = useState<NodeId | null>(null);
  const panelHost = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const toggleNode = (id: NodeId): void => {
    setConfirming(null);
    if (selected === id) { closePanel(); return; }
    setSelected(id);
    setShown(id);
  };

  const closePanel = (): void => {
    const closing = selected;
    setSelected(null);
    if (!closing) return;
    const panel = panelHost.current?.querySelector("aside");
    if (!panel || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(null); return; }
    // The fold away: the panel swings back into the node's edge before it leaves the layout.
    const up = (panel as HTMLElement).style.transformOrigin.includes("bottom");
    gsap.to(panel, {
      rotateX: up ? 6 : -6, y: up ? 8 : -8, opacity: 0, duration: 0.16, ease: "power2.in",
      transformOrigin: (panel as HTMLElement).style.transformOrigin,
      onComplete: () => setShown((cur) => (cur === closing ? null : cur)),
    });
  };

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

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

  const lit = (key: EdgeKey): Lit => edgeLit(key, modes, hostState);
  // An unknown host stays on the canvas: an exported file reads no host list.
  const shownHosts = HOSTS.filter((host) => hostState.installed[host.id] !== false);
  const compact = containerW > 0 && containerW < 620;
  const layout = pipelineLayout(shownHosts, compact);
  // Natural size only: a wide canvas overflows the card, so drag-pan and zoom reach the later agents instead of the nodes shrinking.
  const fit = containerW > 0 ? Math.min(1, containerW / layout.w) : 1;
  const scale = fit * zoom;

  const isNodeOff = (id: NodeId): boolean => nodeOff(id, modes, hostState);

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

  const zoomBy = (factor: number): void => {
    setZoom((z) => Math.min(2.4, Math.max(0.6, Number((z * factor).toFixed(2)))));
  };


  // The fold panel anchors to the shown node in screen space and flips above when the space below runs out.
  const shownBox = shown ? layout.nodes.find(([id]) => id === shown)?.[1] ?? null : null;
  const panelAnchor = shownBox ? { x: shownBox.x * scale + pan.x, y: shownBox.y * scale + pan.y, w: shownBox.w * scale, h: shownBox.h * scale } : null;
  const panelBounds = { w: containerW, h: Math.round(layout.h * fit) };
  return (
    <div className="relative min-w-0" style={{ perspective: "900px" }}>
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
            if (target.closest("button") || target.closest("[data-node-panel]")) return;
            if (selected) closePanel();
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
              const state = nodeState(id, modes, hostState);
              return (
                <NodeButton
                  key={id}
                  box={box}
                  off={isNodeOff(id)}
                  selected={selected === id}
                  label={`${nodeTitle(id)}, ${state.label}`.replace(/, $/, "")}
                  onSelect={() => toggleNode(id)}
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
    {/* The fold panel lives in screen space beside the node, so its type stays crisp at any zoom. */}
    {shown && panelAnchor ? (
      <NodePanel
        hostRef={panelHost}
        modes={modes}
        hostState={hostState}
        node={shown}
        busy={busy}
        confirming={confirming}
        onConfirm={setConfirming}
        onSet={onSet}
        onHostAction={onHostAction}
        onClose={closePanel}
        anchor={panelAnchor}
        bounds={panelBounds}
      />
    ) : null}
    </div>
  );
}



/** The canvas's shape while the host list is still out: agent column, mode column, output. */
export function PipelineSkeleton() {
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

