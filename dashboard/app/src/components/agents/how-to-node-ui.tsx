// Node option surfaces: shadcn dialogs for the mode levels, side drawers for hosts and the wrap center.
// Every control that used to live in the fold panel or the Modes tab lands here.
import { useCallback, useEffect, useState } from "react";
import { AgentLogo } from "@/components/agent-logos";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle,
} from "@/components/ui/drawer";
import { MarkGlyph } from "@/components/brand";
import { luminance, MARK_BG } from "../../../../../extensions/shared/brand-marks.ts";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "../toaster";
import { cn } from "cn";
import { fetchWrapTargets, postHeadroomWrap } from "@/lib/data";
import {
  ABOUT, DEFAULT_ROWS_UI, HOSTS, MODES, OFF_DEFAULTS, PICKER, nodeGlyph, nodeState, nodeTitle, nodeValue, versionOf,
} from "./pipeline-model";
import type { DefaultsPayload, HostAction, HostState, NodeId } from "./pipeline-model";
import type { ModeState } from "./shell";

type HostId = "omp" | "pi" | "pig" | "opencode";

export interface NodeSurfaceProps {
  node: NodeId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modes: ModeState | null;
  hostState: HostState;
  busy: NodeId | null;
  onSet: (node: NodeId, field: string, value: string | boolean, host?: HostId) => void;
  onHostAction: (node: NodeId, action: HostAction) => void;
  onSaved: () => void;
}

/** One option row: a full-width control with the active state carried by a check. */
export function OptionRow({
  label, active, disabled, onClick, hint,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors duration-150",
        active ? "border-accent/60 bg-accent-soft" : "border-transparent hover:border-line hover:bg-track/60",
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

function SurfaceHeader({ node, modes, hostState }: { node: NodeId; modes: ModeState | null; hostState: HostState }) {
  const glyph = nodeGlyph(node);
  const state = nodeState(node, modes, hostState);
  return (
    // pr-7 clears the dialog's own close button, which floats over the row's right edge.
    <span className="flex items-center gap-2 pr-7">
      {glyph ? <span aria-hidden="true" className="text-[13px] leading-none">{glyph}</span> : null}
      <span className="min-w-0 truncate text-sm font-semibold">{nodeTitle(node)}</span>
      <span className="mono ml-auto shrink-0 rounded border border-line px-1.5 py-0.5 text-[9px] leading-none text-dim">
        {state.label}
      </span>
    </span>
  );
}

/** The mode levels for one agent's own section, which wins over the shared store it inherits from. */
function AgentModes({ host, onSaved }: { host: HostId; onSaved: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState<DefaultsPayload>(OFF_DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    fetch("/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: (Partial<DefaultsPayload> & { hosts?: Record<string, Partial<Record<string, string | boolean>>> }) | null) => {
        if (!d) return;
        const section: Partial<Record<string, string | boolean>> = d.hosts?.[host] ?? {};
        const pick = (key: keyof DefaultsPayload, fallback: string | boolean): string | boolean => section[key] ?? (d as Partial<Record<string, string | boolean>>)[key] ?? fallback;
        setCurrent({
          comboDefault: String(pick("comboDefault", "off")),
          comboLevel: "custom",
          cavemanDefault: String(pick("cavemanDefault", "off")),
          rtkDefault: typeof pick("rtkDefault", false) === "boolean" ? Boolean(pick("rtkDefault", false)) : false,
          ponytailDefault: String(pick("ponytailDefault", "off")),
          pstackDefault: String(pick("pstackDefault", "off")),
          headroomDefault: String(pick("headroomDefault", "off")),
        });
      })
      .catch(() => { /* keep what is on screen; the rows still save */ })
      .finally(() => setLoaded(true));
  }, [host]);
  useEffect(() => {
    load();
  }, [load]);

  const save = (row: (typeof DEFAULT_ROWS_UI)[number], id: string): void => {
    const value: string | boolean = row.field === "rtkDefault" ? id === "on" : id;
    setCurrent((c) => ({ ...c, [row.field]: value }));
    void fetch("/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [row.field]: value, host }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; error?: string }) => {
        if (d?.ok) {
          // A preset rewrites the three modes it owns, and the combo row reads the derived level; read the saved state back.
          load();
          onSaved();
          toast(`${row.label} saved`, `Applies to new ${host} sessions`, "check");
        } else {
          toast("Could not save", d?.error ?? "Unknown level", "circle-alert");
        }
      })
      .catch(() => toast("Could not save", "The dashboard server did not answer.", "circle-alert"));
  };

  return (
    <div className="grid gap-5">
      {DEFAULT_ROWS_UI.map((row) => {
        const raw = current[row.field];
        const isRtk = row.field === "rtkDefault";
        const value = String(raw ?? "off");
        const locked = !loaded;
        if (isRtk) {
          return (
            <div key={row.field} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="m-0 text-[13px] font-semibold">
                  <span aria-hidden="true" className="mr-1.5">{row.glyph}</span>{row.label}
                </p>
                <p className="mt-0.5 mb-0 text-xs text-dim">{row.hint}</p>
              </div>
              <Switch
                size="sm"
                checked={Boolean(raw)}
                onCheckedChange={(on: boolean) => save(row, on ? "on" : "off")}
                disabled={locked}
                aria-label={`${row.label} default for ${host}`}
              />
            </div>
          );
        }
        return (
          <div key={row.field} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="m-0 text-[13px] font-semibold">
                <span aria-hidden="true" className="mr-1.5">{row.glyph}</span>{row.label}
              </p>
              <p className="mt-0.5 mb-0 text-xs text-dim">{row.hint}</p>
            </div>
            <Select value={value} onValueChange={(v) => save(row, v ?? "off")} disabled={locked}>
              <SelectTrigger size="sm" className="w-[132px] shrink-0" aria-label={`${row.label} default for ${host}`}>
                {/* SelectValue needs children or it shows the raw value. */}
                <SelectValue placeholder="Off">{row.options.find((o) => o.id === value)?.label ?? "Off"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {/* Custom is what the four modes say, never a level to pick. */}
                  {row.options.map((o) => (
                    <SelectItem key={o.id} value={o.id} disabled={o.id === "custom"}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        );
      })}
      <p className="mono m-0 text-[10px] text-dim">
        Rows left off inherit the shared default — only what you set here belongs to {host}.
      </p>
    </div>
  );
}

/** Mode nodes open a dialog: the level list, and the scope the level writes to. */
export function ModeDialog({ node, open, onOpenChange, modes, hostState, busy, onSet }: NodeSurfaceProps) {
  const key = (MODES.find((m) => m.key === node)?.key ?? "headroom") as keyof typeof PICKER;
  const picker = PICKER[key];
  const installed = HOSTS.filter((h) => hostState.installed[h.id] !== false).map((h) => h.id as HostId);
  const [scope, setScope] = useState<HostId | "all">("all");
  useEffect(() => {
    if (open) setScope("all");
  }, [open]);
  const current = nodeValue(node, scope, modes);
  const picked = picker.options.some((option) => option.id === current) ? current : null;
  // A scope without its own section inherits the shared value, so the row says so.
  const section = scope !== "all" ? (modes?.hosts?.[scope] ?? {}) as Partial<Record<string, string | boolean>> : undefined;
  const inherited = modes !== null && section !== undefined && section[picker.field as "comboDefault"] === undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-0">
        <DialogHeader>
          <DialogTitle><SurfaceHeader node={node} modes={modes} hostState={hostState} /></DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">
            {ABOUT[node] ?? ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <div className="mb-1 flex items-center gap-2">
            <span className="mono text-[10px] tracking-[0.1em] text-dim uppercase">scope</span>
            <Select value={scope} onValueChange={(v) => setScope(v as HostId | "all")}>
              <SelectTrigger size="sm" className="ml-auto w-[170px]" aria-label="Who this level applies to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All agents (shared)</SelectItem>
                  {installed.map((h) => (
                    <SelectItem key={h} value={h}>{HOSTS.find((x) => x.id === h)?.label ?? h} only</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {modes === null ? (
            <div className="grid gap-1.5" aria-busy="true" aria-hidden="true">
              <Skeleton className="h-8 w-full rounded-md" />
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
          ) : (
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
          )}
        </div>
        <DialogFooter className="mt-3 flex-row items-center justify-between border-t border-line pt-2.5">
          {picked ? (
            <code className="mono rounded bg-track/40 px-1.5 py-0.5 text-[10px] text-ink">/{key} {picked}</code>
          ) : <span />}
          <span className="mono text-[9px] text-dim">
            {scope !== "all" ? `saves for ${scope} only` : "every agent reads this"}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A host node opens the side drawer: install actions, then its own defaults rows. */
export function HostDrawer({ node, open, onOpenChange, hostState, busy, onHostAction, onSaved }: NodeSurfaceProps) {
  const hostId = node.slice("host-".length) as HostId;
  const host = HOSTS.find((h) => h.id === hostId);
  const installed = hostState.installed[hostId] !== false;
  const [running, setRunning] = useState<HostAction | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (busy !== node) setRunning(null);
  }, [busy, node]);
  useEffect(() => {
    if (open) setConfirming(false);
  }, [open, node]);
  const start = (action: HostAction): void => {
    setRunning(action);
    onHostAction(node, action);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent>
        <DrawerHeader className="border-b border-line pb-3.5 px-6 pt-4">
          <DrawerTitle>
            <span className="flex items-center gap-2">
              <AgentLogo host={hostId} className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{host?.label ?? hostId}</span>
              <span className={cn(
                "mono ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[9px]",
                installed ? "border-success/40 text-success" : "border-line text-dim",
              )}
              >
                {installed ? versionOf(hostState.versions[hostId]) ?? "installed" : "not installed"}
              </span>
            </span>
          </DrawerTitle>
          <DrawerDescription className="text-[11px] leading-relaxed">{ABOUT[node] ?? ""}</DrawerDescription>
        </DrawerHeader>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-6 py-4">
          {installed ? (
            <div className="rounded-lg bg-track/40 p-4">
              <AgentModes host={hostId} onSaved={onSaved} />
            </div>
          ) : (
            <p className="m-0 text-[11px] leading-relaxed text-dim">
              Install writes the Tersio tree for this agent; its own defaults rows appear here once it runs.
            </p>
          )}
        </div>
        <DrawerFooter className="border-t border-line px-6 pb-4 pt-3.5">
          <div className="grid w-full grid-cols-2 gap-2">
            {installed ? (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => start("update")} className="w-full gap-1.5">
                {busy === node && running === "update" ? <Spinner className="size-3 text-accent" /> : <Icon name="circle-arrow-up" className="size-3.5" />}
                Update
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => start("install")} className="w-full gap-1.5">
                {busy === node && running === "install" ? <Spinner className="size-3 text-accent" /> : <Icon name="plus" className="size-3.5" />}
                Install
              </Button>
            )}
            {installed ? (
              confirming ? (
                <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => start("uninstall")} className="w-full gap-1.5">
                  {busy === node && running === "uninstall" ? <Spinner className="size-3" /> : <Icon name="trash" className="size-3.5" />}
                  Confirm uninstall
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(true)} className="w-full gap-1.5 text-dim">
                  <Icon name="trash" className="size-3.5" />
                  Uninstall
                </Button>
              )
            ) : null}
          </div>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** One icon per wrap target, so the list reads as tools rather than strings. */
/** The lucide glyph a wrap target falls back to when the house marks carry no slug for it. */
const WRAP_ICONS: Record<string, string> = {
  codex: "terminal", vscode: "code", "vscode-claude": "code", aider: "book-open", openclaude: "rocket",
  vibe: "zap", grok: "at-sign", cursor: "mouse-pointer-2", "grok-build": "hammer", "continue": "circle-arrow-right",
  goose: "feather", openhands: "hand", openclaw: "anchor",
};

/** The wrap targets the house mark system has a slug (and brand accent) for. */
const WRAP_SLUGS: Record<string, string> = {
  claude: "claudecode", copilot: "githubcopilot", cline: "cline",
};

function BrandMark({ name, className }: { name: string; className: string }) {
  const slug = WRAP_SLUGS[name];
  if (slug === undefined) return <Icon name={WRAP_ICONS[name] ?? "terminal"} className={className} />;
  const color = MARK_BG[slug];
  if (color === undefined) return <Icon name={WRAP_ICONS[name] ?? "terminal"} className={className} />;
  // A brand color near black or white disappears on the theme, so those marks fall back to the row's ink.
  const lum = luminance(color);
  return <MarkGlyph slug={slug} className={className} color={lum < 60 || lum > 225 ? "currentColor" : color} />;
}

/** The headroom node opens the wrap drawer: one switch per installed tool, run by Tersio itself. */
export function HeadroomDrawer({ open, onOpenChange, modes, hostState, busy, onSet, onSaved }: Omit<NodeSurfaceProps, "node" | "onHostAction">) {
  const [detail, setDetail] = useState<string | null>(null);
  const [wrapTargets, setWrapTargets] = useState<Array<{ name: string; available: boolean }> | null>(null);
  // Which durable integrations the dashboard has installed; optimistic, kept across drawer opens.
  const [wrapped, setWrapped] = useState<Record<string, true>>(() => {
    try { return JSON.parse(localStorage.getItem("tersio.headroom.wrap.v1") ?? "{}") as Record<string, true>; } catch { return {}; }
  });
  const [wrapBusy, setWrapBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void fetchWrapTargets().then(setWrapTargets);
  }, [open]);
  const picker = PICKER.headroom;
  const current = nodeValue("headroom", "all", modes);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent>
        <DrawerHeader className="border-b border-line pb-3.5 px-6 pt-4">
          <DrawerTitle>
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="text-[13px] leading-none">🍃</span>
              <span className="min-w-0 truncate">headroom</span>
            </span>
          </DrawerTitle>
          <DrawerDescription className="text-[11px] leading-relaxed">{ABOUT.headroom}</DrawerDescription>
        </DrawerHeader>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-6 py-4 pb-5">
          <div className="grid gap-1.5">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold">
              <Icon name="package" className="size-3.5 text-dim" /> Wrap an installed tool
              <span className="mono ml-auto shrink-0 rounded border border-accent/40 px-1.5 py-0.5 text-[9px] text-accent">recommended</span>
            </p>
            <p className="m-0 text-[10px] leading-relaxed text-dim">
              Flip the switch and Tersio runs headroom's own integration for that tool — no terminal,
              nothing to copy. Tools without a durable install launch through headroom instead.
            </p>
            {wrapTargets === null ? (
              <Skeleton className="h-8 w-full rounded-md" />
            ) : (
              <div className="grid gap-1">
                {wrapTargets.map((target) => {
                  const on = wrapped[target.name] === true;
                  return (
                    <div
                      key={target.name}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 transition-colors",
                        on ? "border-success/30 bg-success/5" : target.available ? "border-line" : "border-dashed border-line/60",
                      )}
                    >
                      <BrandMark name={target.name} className={cn("size-3.5", on ? "" : "text-dim")} />
                      <span className={cn("mono min-w-0 flex-1 truncate text-[11px]", on ? "text-ink" : target.available ? "text-dim" : "text-dim/60")}>{target.name}</span>
                      <span className={cn("mono shrink-0 rounded border px-1 py-0.5 text-[9px]", on ? "border-success/40 text-success" : "border-line text-dim")}>
                        {target.available ? (on ? "wrapped" : "ready") : "not installed"}
                      </span>
                      <Switch
                        size="sm"
                        checked={on}
                        disabled={!target.available || wrapBusy !== null}
                        onCheckedChange={(next: boolean) => {
                          if (!next) return;
                          setWrapBusy(target.name);
                          setDetail(null);
                          void postHeadroomWrap(target.name)
                            .then((result) => {
                              if (result?.ok) {
                                setWrapped((current) => {
                                  const nextMap: Record<string, true> = { ...current, [target.name]: true };
                                  try { localStorage.setItem("tersio.headroom.wrap.v1", JSON.stringify(nextMap)); } catch { /* private mode */ }
                                  return nextMap;
                                });
                              }
                              setDetail(result?.detail ?? "the dashboard server did not answer");
                            })
                            .finally(() => setWrapBusy(null));
                        }}
                        aria-label={`Wrap ${target.name} through headroom`}
                      />
                    </div>
                  );
                })}
              </div>
            )}
            {wrapBusy !== null ? (
              <p className="mono m-0 flex items-center gap-1.5 text-[10px] text-accent">
                <Spinner className="size-3" /> wrapping {wrapBusy}…
              </p>
            ) : detail ? <p className="mono m-0 text-[10px] text-accent">{detail}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold">
              <Icon name="bot" className="size-3.5 text-dim" /> Tersio agents on this machine
            </p>
            <div className="grid gap-1">
              {HOSTS.filter((h) => hostState.installed[h.id] !== false).map((h) => (
                <div key={h.id} className="flex items-center gap-2.5 rounded-md border border-line px-2.5 py-1.5">
                  <AgentLogo host={h.id} className="size-3.5 shrink-0" />
                  <span className="mono min-w-0 flex-1 truncate text-[11px] text-dim">{h.label}</span>
                  <span className="mono shrink-0 text-[9px] text-dim">
                    {h.id === "opencode" ? "wraps · see above" : "no wrap · see its node"}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            <p className="m-0 text-[13px] font-semibold">Session default</p>
            {modes === null ? (
              <Skeleton className="h-8 w-full rounded-md" />
            ) : (
              picker.options.map((option) => (
                <OptionRow
                  key={option.id}
                  label={option.label}
                  active={current === option.id}
                  disabled={busy !== null}
                  onClick={() => { onSet("headroom", picker.field, option.id); onSaved(); }}
                />
              ))
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** The add-agent picker: every agent with its install state, so what is missing is obvious at a glance. */
export function AddAgentDialog({
  open, onOpenChange, missingHosts, hostState, busy, onHostAction,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  missingHosts: Array<{ id: string; label: string }>;
  hostState: HostState;
  busy: NodeId | null;
  onHostAction: (node: NodeId, action: HostAction) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add an agent</DialogTitle>
          <DialogDescription className="text-[11px] leading-relaxed">
            Installing writes the Tersio tree for the agent and puts its node on the canvas.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          {HOSTS.map((host) => {
            const installed = hostState.installed[host.id] !== false;
            const missing = missingHosts.some((m) => m.id === host.id);
            return (
              <div key={host.id} className={cn("flex items-center gap-2 rounded-lg border px-2.5 py-2", installed ? "border-line" : "border-dashed border-line")}>
                <AgentLogo host={host.id as "omp"} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[12px]">{host.label}</span>
                <span
                  className={cn(
                    "mono flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[9px]",
                    installed ? "border-success/40 text-success" : "border-line text-dim",
                  )}
                >
                  <span aria-hidden="true" className={cn("size-1.5 rounded-full", installed ? "bg-success" : "bg-dim")} />
                  {installed ? versionOf(hostState.versions[host.id]) ?? "installed" : "not installed"}
                </span>
                {!installed ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null || !missing}
                    onClick={() => onHostAction(`host-${host.id}` as NodeId, "install")}
                    className="h-7 gap-1.5 px-2 text-[11px]"
                  >
                    {busy === `host-${host.id}` ? <Spinner className="size-3 text-accent" /> : <Icon name="plus" className="size-3.5" />}
                    Install
                  </Button>
                ) : null}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
