// Node option surfaces: shadcn dialogs for the mode levels, side drawers for hosts and the gateway.
// Every control that used to live in the fold panel or the Modes tab lands here.
import { useCallback, useEffect, useState } from "react";
import { AgentLogo } from "@/components/agent-logos";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle,
} from "@/components/ui/drawer";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "../toaster";
import { cn } from "cn";
import { fetchHeadroomProxy, postHeadroomProxy, postHeadroomRoute } from "@/lib/data";
import type { HeadroomProxyReport } from "@/lib/data";
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
  const key = node.startsWith("combo-") ? "combo" : (MODES.find((m) => m.key === node)?.key ?? "headroom") as keyof typeof PICKER;
  const picker = PICKER[key];
  const comboHost = node.startsWith("combo-") ? node.slice(6) as HostId : null;
  const installed = HOSTS.filter((h) => hostState.installed[h.id] !== false).map((h) => h.id as HostId);
  // A combo node IS the scope: it writes that agent's section and nothing else.
  const [scope, setScope] = useState<HostId | "all">(comboHost ?? "all");
  useEffect(() => {
    if (open) setScope(comboHost ?? "all");
  }, [open, comboHost]);
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
            {comboHost ? ABOUT.combo : ABOUT[node] ?? ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          {comboHost ? null : (
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
          )}
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
        <DrawerHeader className="border-b border-line">
          <DrawerTitle>
            <span className="flex items-center gap-2">
              <AgentLogo host={hostId} className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{host?.label ?? hostId}</span>
              <span className={cn(
                "mono ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[9px]",
                installed ? "border-accent/40 text-accent" : "border-line text-dim",
              )}
              >
                {installed ? versionOf(hostState.versions[hostId]) ?? "installed" : "not installed"}
              </span>
            </span>
          </DrawerTitle>
          <DrawerDescription className="text-[11px] leading-relaxed">{ABOUT[node] ?? ""}</DrawerDescription>
        </DrawerHeader>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-4 py-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {installed ? (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => start("update")} className="gap-1.5">
                {busy === node && running === "update" ? <Spinner className="size-3 text-accent" /> : <Icon name="arrow-up-circle" className="size-3.5" />}
                Update
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => start("install")} className="gap-1.5">
                {busy === node && running === "install" ? <Spinner className="size-3 text-accent" /> : <Icon name="plus" className="size-3.5" />}
                Install
              </Button>
            )}
            {installed ? (
              confirming ? (
                <Button size="sm" variant="destructive" disabled={busy !== null} onClick={() => start("uninstall")} className="gap-1.5">
                  {busy === node && running === "uninstall" ? <Spinner className="size-3" /> : <Icon name="triangle-alert" className="size-3.5" />}
                  Confirm uninstall
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(true)} className="gap-1.5 text-dim">
                  <Icon name="trash-2" className="size-3.5" />
                  Uninstall
                </Button>
              )
            ) : null}
          </div>
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
      </DrawerContent>
    </Drawer>
  );
}

/** The gateway node opens the traffic drawer: the proxy, its base URLs, and the routing list. */
export function HeadroomDrawer({ open, onOpenChange, modes, hostState, busy, onSet, onSaved }: Omit<NodeSurfaceProps, "node" | "onHostAction">) {
  const [proxy, setProxy] = useState<HeadroomProxyReport | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [routeBusy, setRouteBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void fetchHeadroomProxy().then(setProxy);
  }, [open]);
  const toggleProxy = (): void => {
    setProxyBusy(true);
    setDetail(null);
    void postHeadroomProxy(proxy?.running ? "stop-proxy" : "start-proxy")
      .then((result) => {
        setDetail(result?.detail ?? "the dashboard server did not answer");
        void fetchHeadroomProxy().then(setProxy);
      })
      .finally(() => setProxyBusy(false));
  };
  const toggleRoute = (host: HostId): void => {
    setRouteBusy(host);
    setDetail(null);
    const routed = (proxy?.routed ?? []).includes(host);
    void postHeadroomRoute(host, routed ? "unroute-host" : "route-host")
      .then((result) => {
        setDetail(result?.detail ?? "the dashboard server did not answer");
        void fetchHeadroomProxy().then(setProxy);
      })
      .finally(() => setRouteBusy(null));
  };
  const picker = PICKER.headroom;
  const current = nodeValue("headroom", "all", modes);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent>
        <DrawerHeader className="border-b border-line">
          <DrawerTitle>
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="text-[13px] leading-none">🍃</span>
              <span className="min-w-0 truncate">headroom</span>
              <span className={cn(
                "mono ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[9px]",
                proxy?.running ? "border-success/40 text-success" : "border-line text-dim",
              )}
              >
                {proxy?.running ? `running on :${proxy.port}` : "proxy stopped"}
              </span>
            </span>
          </DrawerTitle>
          <DrawerDescription className="text-[11px] leading-relaxed">{ABOUT.headroom}</DrawerDescription>
        </DrawerHeader>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto px-4 py-4">
          <div className="rounded-lg bg-track/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-[10px] tracking-[0.12em] text-dim uppercase">gateway</span>
              <Button size="sm" variant="outline" disabled={proxyBusy} onClick={toggleProxy} className="ml-auto gap-1.5">
                {proxyBusy ? <Spinner className="size-3" /> : <Icon name={proxy?.running ? "square" : "play"} className="size-3.5" />}
                {proxy?.running ? "stop proxy" : "start proxy"}
              </Button>
            </div>
            <dl className="mt-3.5 grid gap-2">
              <div className="flex items-baseline gap-3">
                <dt className="mono w-20 shrink-0 text-[9px] tracking-[0.1em] text-dim uppercase">anthropic</dt>
                <dd className="mono m-0 truncate text-[10px] text-ink">ANTHROPIC_BASE_URL={proxy?.anthropicUrl ?? "http://127.0.0.1:8787"}</dd>
              </div>
              <div className="flex items-baseline gap-3">
                <dt className="mono w-20 shrink-0 text-[9px] tracking-[0.1em] text-dim uppercase">openai</dt>
                <dd className="mono m-0 truncate text-[10px] text-ink">OPENAI_BASE_URL={proxy?.openaiUrl ?? "http://127.0.0.1:8787/v1"}</dd>
              </div>
            </dl>
            <p className="m-0 mt-3.5 text-[11px] leading-relaxed text-dim">
              Route an agent below and Tersio points its providers at the gateway — a custom upstream
              becomes the gateway's own forwarding target. Stopping the proxy unroutes
              everyone first. Measured savings land on the Tools page once calls flow.
            </p>
            <div className="mt-3 grid gap-1.5">
              {HOSTS.filter((h) => hostState.installed[h.id] !== false).map((h) => {
                const routed = (proxy?.routed ?? []).includes(h.id);
                return (
                  <div key={h.id} className="flex items-center gap-2 rounded-md bg-panel/60 px-2 py-1.5">
                    <AgentLogo host={h.id} className="size-3.5 shrink-0" />
                    <span className="truncate text-[11px] text-ink">{h.label}</span>
                    <span className={cn(
                      "mono rounded border px-1.5 py-0.5 text-[9px]",
                      routed ? "border-success/40 text-success" : "border-line text-dim",
                    )}
                    >
                      {routed ? "routed" : "unrouted"}
                    </span>
                    <button
                      type="button"
                      disabled={routeBusy !== null}
                      onClick={() => toggleRoute(h.id as HostId)}
                      className="mono ml-auto cursor-pointer rounded-md border border-line px-2 py-1 text-[10px] text-dim transition-colors hover:border-accent/50 hover:text-ink disabled:cursor-default disabled:opacity-40"
                    >
                      {routeBusy === h.id ? "working" : routed ? "unroute" : "route"}
                    </button>
                  </div>
                );
              })}
            </div>
            {detail ? <p className="mono m-0 mt-2 text-[10px] text-dim">{detail}</p> : null}
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
                  onClick={() => { onSet("headroom", picker.field, option.id === "on"); onSaved(); }}
                />
              ))
            )}
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** No agent on this machine yet: the centered canvas node opens this picker. */
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
            Installs the Tersio tree for this agent and puts its node on the canvas.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          {missingHosts.map((host) => (
            <div key={host.id} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2">
              <AgentLogo host={host.id as "omp"} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-[12px]">{host.label}</span>
              <span className="mono shrink-0 text-[9px] text-dim">
                {hostState.versions[host.id] ? `v${hostState.versions[host.id]}` : ""}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => onHostAction(`host-${host.id}` as NodeId, "install")}
                className="h-7 gap-1.5 px-2 text-[11px]"
              >
                {busy === `host-${host.id}` ? <Spinner className="size-3 text-accent" /> : <Icon name="plus" className="size-3.5" />}
                Install
              </Button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
