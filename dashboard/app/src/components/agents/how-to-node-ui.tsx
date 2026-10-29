// Node option surfaces: shadcn dialogs for the mode levels, side drawers for hosts and the wrap center.
// Every control that used to live in the fold panel or the Modes tab lands here.
import { useCallback, useEffect, useState } from "react";
import { AgentLogo } from "@/components/agent-logos";
import { Icon } from "@/components/icon";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle,
} from "@/components/ui/drawer";
import { MarkGlyph } from "@/components/brand";
import { imageMark, maskMark } from "@/lib/marks";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { luminance, MARK_BG } from "../../../../../extensions/shared/brand-marks.ts";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "../toaster";
import { cn } from "cn";
import { checkVendor, fetchHeadroomWraps, fetchHealth, fetchWrapTargets, postHeadroomWrap, postHeadroomWraps, postVendorAction, readStoredWraps, runHeadroomAction, storeWraps, type HealthReport, type VendorRow } from "@/lib/data";
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

/** One selectable level card: label, optional hint, and a check that pops in on select. */
function LevelCard({
  label, hint, active, disabled, onClick,
}: {
  label: string;
  hint?: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "group relative flex min-h-[52px] flex-col items-start justify-center gap-0.5 overflow-hidden rounded-lg border px-3 py-2 text-left transition-all duration-200",
        active
          ? "border-accent/60 bg-accent-soft"
          : "border-line hover:-translate-y-px hover:border-accent/40 hover:bg-track/40",
        disabled && "cursor-default opacity-50 hover:translate-y-0",
      )}
    >
      <span className={cn("mono truncate text-[11px] font-semibold", active ? "text-ink" : "text-dim group-hover:text-ink")}>{label}</span>
      {hint ? <span className="mono truncate text-[9px] text-dim">{hint}</span> : null}
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-2 right-2 grid size-3.5 place-items-center rounded-full border transition-transform duration-150",
          active ? "scale-100 border-accent bg-accent text-panel" : "scale-0 border-line",
        )}
      >
        <Icon name="check" className="size-2.5" />
      </span>
    </button>
  );
}

/** A settings row: the title and hint on the left, a switch on the right. */
function ToggleRow({
  title, hint, checked, disabled, onCheckedChange,
}: {
  title: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-track/20 px-3.5 py-3">
      <div className="min-w-0">
        <p className="m-0 text-[12px] font-semibold">{title}</p>
        <p className="m-0 mt-0.5 text-[10px] leading-snug text-dim">{hint}</p>
      </div>
      <Switch size="sm" checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}

/** Shown when a vendor binary is not on the machine: configure nothing, install from the footer. */
function NotInstalledNote({ tool }: { tool: string }) {
  return (
    <Alert>
      <Icon name="circle-alert" className="size-4" />
      <AlertTitle className="mono text-[11px]">{tool} is not installed</AlertTitle>
      <AlertDescription className="text-[10px] leading-snug">
        Install it from the footer below to configure it and see its version.
      </AlertDescription>
    </Alert>
  );
}

function SurfaceHeader({ node, modes, hostState }: { node: NodeId; modes: ModeState | null; hostState: HostState }) {
  const glyph = nodeGlyph(node);
  const state = nodeState(node, modes, hostState);
  return (
    <span className="flex items-center gap-2">
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

/** Mode nodes open a side drawer: the level list, and the scope the level writes to. */
export function ModeDrawer({ node, open, onOpenChange, modes, hostState, busy, onSet }: NodeSurfaceProps) {
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
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent>
        <DrawerHeader className="border-b border-line pb-3.5 px-6 pt-4">
          <DrawerTitle><SurfaceHeader node={node} modes={modes} hostState={hostState} /></DrawerTitle>
          <DrawerDescription className="text-[11px] leading-relaxed">{ABOUT[node] ?? ""}</DrawerDescription>
        </DrawerHeader>
        <div className="grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto px-6 py-4 pb-5">
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
            <div className="grid grid-cols-2 gap-1.5 [&>*:last-child:nth-child(odd)]:col-span-2">
              {picker.options.map((option) => (
                <LevelCard
                  key={option.id}
                  label={option.label}
                  hint={inherited && current === option.id ? "inherited" : undefined}
                  active={current === option.id}
                  disabled={busy !== null || option.id === "custom"}
                  onClick={() => onSet(node, picker.field, picker.field === "rtkDefault" ? option.id === "on" : option.id, scope === "all" ? undefined : scope)}
                />
              ))}
            </div>
          )}
          <p className="mono m-0 mt-1 text-[9px] text-dim">
            {scope !== "all" ? `saves for ${scope} only` : "every agent reads this"}
            {picked ? ` · /${key} ${picked}` : ""}
          </p>
        </div>
      </DrawerContent>
    </Drawer>
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
  const image = imageMark(slug);
  if (image) return <img src={image} alt="" className={cn("shrink-0 object-contain", className)} />;
  const mask = maskMark(slug);
  if (!mask) return <Icon name={WRAP_ICONS[name] ?? "terminal"} className={className} />;
  // A brand color near black or white disappears on the theme, so those marks fall back to the row's ink.
  const color = MARK_BG[slug];
  const lum = color === undefined ? 0 : luminance(color);
  return <MarkGlyph slug={slug} className={className} color={color !== undefined && lum >= 60 && lum <= 225 ? color : "currentColor"} />;
}

/** The footer under a vendor drawer: check the release feed, update, or remove the binary. */
export function VendorFooter({
  tool, source, open, installed, onAfter,
}: {
  tool: "headroom" | "rtk";
  source: "Headroom" | "RTK";
  open: boolean;
  installed: boolean;
  onAfter: () => void;
}) {
  const toast = useToast();
  const [phase, setPhase] = useState<"idle" | "checking" | "update" | "confirm-uninstall" | "busy">("idle");
  const [busyLabel, setBusyLabel] = useState("");
  const [row, setRow] = useState<VendorRow | null>(null);
  useEffect(() => {
    if (!open) { setPhase("idle"); setRow(null); }
  }, [open]);
  const busy = phase === "busy";
  const updateReady = phase === "update";
  const confirming = phase === "confirm-uninstall";
  const dots = (
    <span aria-hidden="true" className="flex items-center gap-0.5">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1 rounded-full bg-current animate-bounce" style={{ animationDelay: `${i * 130}ms` }} />
      ))}
    </span>
  );
  const check = async (): Promise<void> => {
    setPhase("checking");
    const found = await checkVendor(source);
    setRow(found);
    setPhase(found?.upstream && found.pin !== found.upstream ? "update" : "idle");
  };
  const runVendor = async (action: "update" | "uninstall"): Promise<void> => {
    setBusyLabel(action === "uninstall" ? `uninstalling ${tool}` : installed ? `updating ${tool}` : `installing ${tool}`);
    setPhase("busy");
    const result = await postVendorAction(tool, action);
    if (!result?.ok) {
      toast(result?.error ?? "the dashboard server did not answer", "Nothing changed.", "circle-alert");
      setPhase("idle");
      return;
    }
    toast(result.detail, "Runs in the background.", "check");
    // The job is detached, so the bar rides a health poll: it ends when the binary state flips.
    const key = tool === "headroom" ? "headroom" : "rtk";
    const wasVersion = row?.pin ?? null;
    for (let tick = 0; tick < 30; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const report = await fetchHealth();
      const state = report?.[key];
      if (!state) continue;
      if (action === "uninstall" && !state.present) break;
      if (action === "update" && state.present && state.version !== wasVersion) break;
    }
    setPhase("idle");
    setRow(null);
    onAfter();
  };
  const updateLabel = row?.upstream ? `Update to ${row.upstream}` : "Update";
  const openDashboard = async (): Promise<void> => {
    const result = await runHeadroomAction("dashboard");
    if (!result) toast("Could not open the dashboard", "The dashboard server did not answer.", "circle-alert");
    else if (!result.ok) toast(result.error ?? "headroom refused", "Start its proxy first — headroom dashboard needs one.", "circle-alert");
    else toast(result.detail ?? "Headroom dashboard opened", "Its own savings view, in a new tab.", "check");
  };
  return (
    <DrawerFooter className="border-t border-line px-6 pb-4 pt-3.5">
      {phase === "busy" ? <Progress value={null} className="w-full" /> : null}
      <div className="grid w-full grid-cols-2 gap-2">
        {installed ? (
          updateReady ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void runVendor("update")} className="w-full gap-1.5 border-accent/40 text-accent">
              {busy ? busyLabel : updateLabel}
              {busy ? dots : <Icon name="circle-arrow-up" className="size-3.5" />}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={busy || phase === "confirm-uninstall"} onClick={() => void check()} className="w-full gap-1.5">
              {phase === "checking" ? "checking" : row ? "check again" : "Check for updates"}
              {phase === "checking" ? dots : <Icon name="refresh-cw" className="size-3.5" />}
            </Button>
          )
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void runVendor("update")} className="w-full gap-1.5">
            {busy ? busyLabel : "Install"}
            {busy ? dots : <Icon name="plus" className="size-3.5" />}
          </Button>
        )}
        {confirming ? (
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void runVendor("uninstall")} className="w-full gap-1.5">
            {busy ? busyLabel : "Confirm uninstall"}
            {busy ? dots : <Icon name="trash" className="size-3.5" />}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !installed}
            onClick={() => { setPhase("confirm-uninstall"); setRow(null); }}
            className="w-full gap-1.5 text-dim"
          >
            <Icon name="trash" className="size-3.5" />
            Uninstall
          </Button>
        )}
      </div>
      {tool === "headroom" && installed ? (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openDashboard()} className="w-full gap-1.5 text-dim">
          <Icon name="gauge" className="size-3.5" />
          Headroom dashboard
        </Button>
      ) : null}
      {row && installed ? (
        <p className="mono m-0 text-center text-[9px] text-dim">
          {row.pin ?? "not installed"}{row.upstream ? ` · latest ${row.upstream}` : ""}
        </p>
      ) : null}
    </DrawerFooter>
  );
}

function VersionPill({ version }: { version: string | null }) {
  if (!version) return null;
  return <span className="mono ml-auto shrink-0 rounded border border-success/40 px-1.5 py-0.5 text-[9px] text-success">{version}</span>;
}

/** The headroom node opens the wrap drawer: one switch per installed tool, run by Tersio itself. */
export function HeadroomDrawer({ open, onOpenChange, modes, hostState, busy, onSet, onSaved }: Omit<NodeSurfaceProps, "node" | "onHostAction">) {
  const [detail, setDetail] = useState<string | null>(null);
  const [wrapTargets, setWrapTargets] = useState<Array<{ name: string; available: boolean }> | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  // Which durable integrations the dashboard has installed; optimistic, kept across drawer opens.
  const [wrapped, setWrapped] = useState<Record<string, true>>(readStoredWraps);
  const [wrapBusy, setWrapBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    void fetchWrapTargets().then(setWrapTargets);
    void fetchHealth().then(setHealth);
    void fetchHeadroomWraps().then((server) => {
      if (!server || typeof server !== 'object') return;
      const record = server as Record<string, true>;
      if (Object.keys(record).length > 0) {
        setWrapped(record);
        storeWraps(record);
      } else if (Object.keys(wrapped).length > 0) {
        // A record from before the server copy existed moves up once.
        void postHeadroomWraps(wrapped);
      }
    });
  }, [open]);
  const headroomInstalled = health?.headroom?.present ?? false;
  const picker = PICKER.headroom;
  const current = nodeValue("headroom", "all", modes);

  /** One switch flip: headroom's own command, then the shared record and every other browser. */
  const toggleWrap = (name: string, on: boolean): void => {
    setWrapBusy(name);
    setDetail(null);
    void postHeadroomWrap(name, on ? "wrap" : "unwrap")
      .then((result) => {
        if (result?.ok) {
          const next: Record<string, true> = { ...wrapped };
          if (on) next[name] = true; else delete next[name];
          setWrapped(next);
          storeWraps(next);
          void postHeadroomWraps(next);
        }
        setDetail(result?.ok ? result.detail : result?.error ?? "the dashboard server did not answer");
      })
      .finally(() => setWrapBusy(null));
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent>
        <DrawerHeader className="border-b border-line pb-3.5 px-6 pt-4">
          <DrawerTitle>
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="text-[13px] leading-none">🍃</span>
              <span className="min-w-0 truncate">headroom</span>
              <VersionPill version={health?.headroom?.version ?? null} />
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
              Flip the switch and Tersio runs headroom's own integration — no terminal, nothing to copy.
              claude, codex, copilot, and openclaw install durably (`headroom init -g`); the rest wrap that
              session only, so a shell alias keeps them covered.
            </p>
            {wrapTargets === null ? (
              <Skeleton className="h-8 w-full rounded-md" />
            ) : (
              <div className="grid gap-1">
                {wrapTargets.filter((target) => target.available).map((target) => {
                  const on = wrapped[target.name] === true;
                  return (
                    <div
                      key={target.name}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md border px-2.5 py-1.5 transition-colors",
                        on ? "border-success/30 bg-success/5" : "border-line",
                      )}
                    >
                      {HOSTS.some((h) => h.id === target.name)
                        ? <AgentLogo host={target.name as "omp"} className="size-3.5 shrink-0" />
                        : <BrandMark name={target.name} className={cn("size-3.5", on ? "" : "text-dim")} />}
                      <span className={cn("mono min-w-0 flex-1 truncate text-[11px]", on ? "text-ink" : "text-dim")}>{target.name}</span>
                      <span className={cn("mono shrink-0 rounded border px-1 py-0.5 text-[9px]", on ? "border-success/40 text-success" : "border-line text-dim")}>
                        {on ? "wrapped" : "ready"}
                      </span>
                      <span className="relative inline-flex">
                        <Switch
                          size="sm"
                          checked={on}
                          disabled={!target.available || wrapBusy !== null || !headroomInstalled}
                          onCheckedChange={(next: boolean) => toggleWrap(target.name, next)}
                          aria-label={`Wrap ${target.name} through headroom`}
                        />
                        {wrapBusy === target.name ? (
                          <span className="absolute inset-0 grid place-items-center">
                            <Spinner className="size-3 text-accent" />
                          </span>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
                {wrapTargets.filter((target) => target.available).length === 0 ? (
                  <p className="mono m-0 rounded-md border border-dashed border-line px-2.5 py-2 text-[10px] leading-relaxed text-dim">
                    headroom is not installed on this machine — install it from the footer below, then its tools join this list
                  </p>
                ) : null}
                {HOSTS.filter((h) => hostState.installed[h.id] !== false && !wrapTargets.some((t) => t.available && t.name === h.id)).map((h) => (
                  <div key={h.id} className="flex items-center gap-2.5 rounded-md border border-line px-2.5 py-1.5">
                    <AgentLogo host={h.id} className="size-3.5 shrink-0" />
                    <span className="mono min-w-0 flex-1 truncate text-[11px] text-ink">{h.label}</span>
                    <span className="mono shrink-0 rounded border border-line px-1 py-0.5 text-[9px] text-dim">
                      {h.id === "opencode" ? "wraps above" : "no wrap"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {wrapBusy !== null ? (
              <p className="mono m-0 flex items-center gap-1.5 text-[10px] text-accent">
                <Spinner className="size-3" /> wrapping {wrapBusy}…
              </p>
            ) : detail ? <p className="mono m-0 text-[10px] text-accent">{detail}</p> : null}
          </div>
          <div className="grid gap-1.5">
            <p className="m-0 text-[13px] font-semibold">Session default</p>
            {health === null ? (
              <Skeleton className="h-8 w-full rounded-md" />
            ) : !headroomInstalled ? (
              <NotInstalledNote tool="headroom" />
            ) : modes === null ? (
              <Skeleton className="h-8 w-full rounded-md" />
            ) : (
              <ToggleRow
                title="Compress traffic for new sessions"
                hint="Tool outputs and history compress below the shell; Tersio tracks the savings."
                checked={current === "on"}
                disabled={busy !== null}
                onCheckedChange={(on: boolean) => { onSet("headroom", picker.field, on ? "on" : "off"); onSaved(); }}
              />
            )}
          </div>
        </div>
        <VendorFooter tool="headroom" source="Headroom" open={open} installed={headroomInstalled} onAfter={() => void fetchHealth().then(setHealth)} />
      </DrawerContent>
    </Drawer>
  );
}

/** The rtk node opens its own drawer: the on/off default plus the vendor release footer. */
export function RtkDrawer({ open, onOpenChange, modes, busy, onSet, onSaved }: Omit<NodeSurfaceProps, "node" | "hostState" | "onHostAction">) {
  const [health, setHealth] = useState<HealthReport | null>(null);
  useEffect(() => {
    if (!open) return;
    void fetchHealth().then(setHealth);
  }, [open]);
  const rtkInstalled = health?.rtk?.present ?? false;
  const picker = PICKER.rtk;
  const current = nodeValue("rtk", "all", modes);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="right">
      <DrawerContent>
        <DrawerHeader className="border-b border-line pb-3.5 px-6 pt-4">
          <DrawerTitle>
            <span className="flex items-center gap-2">
              <span aria-hidden="true" className="text-[13px] leading-none">🗜️</span>
              <span className="min-w-0 truncate">rtk</span>
              <VersionPill version={health?.rtk?.version ?? null} />
            </span>
          </DrawerTitle>
          <DrawerDescription className="text-[11px] leading-relaxed">{ABOUT.rtk ?? ""}</DrawerDescription>
        </DrawerHeader>
        <div className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-6 py-4 pb-5">
          {health === null ? (
            <Skeleton className="h-8 w-full rounded-md" />
          ) : !rtkInstalled ? (
            <NotInstalledNote tool="rtk" />
          ) : (
            <div className="grid gap-1.5">
              <p className="m-0 text-[13px] font-semibold">Session default</p>
              {modes === null ? (
                <Skeleton className="h-8 w-full rounded-md" />
              ) : (
                <ToggleRow
                  title="Rewrite Bash calls through rtk"
                  hint="Eligible shell calls are rewritten and their output condensed before the model sees it."
                  checked={current === "on"}
                  disabled={busy !== null}
                  onCheckedChange={(on: boolean) => { onSet("rtk", picker.field, on); onSaved(); }}
                />
              )}
            </div>
          )}
        </div>
        <VendorFooter tool="rtk" source="RTK" open={open} installed={rtkInstalled} onAfter={() => void fetchHealth().then(setHealth)} />
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
