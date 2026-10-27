// The Modes view: one accordion item per scope, and the session-start rows an open item lays out.
import { useCallback, useEffect, useState } from "react";
import { AgentLogo } from "@/components/agent-logos";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "../toaster";
import { cn } from "cn";
import { fetchHeadroomProxy, postHeadroomProxy } from "@/lib/data";
import type { HeadroomProxyReport } from "@/lib/data";
import { DEFAULT_ROWS_UI, HOSTS, OFF_DEFAULTS } from "./pipeline-model";
import type { DefaultsPayload, HostState } from "./pipeline-model";


/**
 * The session-start defaults for one scope: the shared store every agent falls back to, or one
 * agent's own section, which wins over it. Rows read the section first and mark what is inherited.
 */
function AgentModes({ host, onSaved }: { host: "omp" | "pi" | "opencode" | null; onSaved: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState<DefaultsPayload>(OFF_DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    fetch("/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: (Partial<DefaultsPayload> & { hosts?: Record<string, Partial<Record<string, string | boolean>>> }) | null) => {
        if (!d) return;
        const shared = d as Partial<Record<string, string | boolean>>;
        const section: Partial<Record<string, string | boolean>> = host ? d.hosts?.[host] ?? {} : shared;
        const pick = (key: keyof DefaultsPayload, fallback: string | boolean): string | boolean => section[key] ?? shared[key] ?? fallback;
        setCurrent({
          comboDefault: String(pick("comboDefault", "off")),
          comboLevel: host ? "custom" : String(d.comboLevel ?? "off"),
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
      body: JSON.stringify({ [row.field]: value, ...(host ? { host } : {}) }),
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; error?: string }) => {
        if (d?.ok) {
          // A preset rewrites the three modes it owns, and the combo row reads the derived level; read the saved state back.
          load();
          // The canvas nodes and the top banner read the same store, so they refresh with this save too.
          onSaved();
          toast(`${row.label} saved`, host ? `Applies to new ${host} sessions` : "Applies to new sessions on every agent", "check");
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
        const value = row.field === "comboDefault"
          ? (current.comboLevel && current.comboLevel !== "custom" ? current.comboLevel : current.comboDefault)
          : isRtk ? (raw ? "on" : "off") : String(raw ?? "off");
        // The shared store locks the three modes a live preset owns; a host section is the operator's own mix, so every row stays live.
        const presetOn = !host && current.comboLevel !== "off" && current.comboLevel !== "custom";
        const locked = !loaded || (presetOn && row.field !== "comboDefault" && row.field !== "pstackDefault" && row.field !== "headroomDefault");
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
                aria-label={`${row.label} default${host ? ` for ${host}` : ""}`}
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
              <SelectTrigger size="sm" className="w-[132px] shrink-0" aria-label={`${row.label} default${host ? ` for ${host}` : ""}`}>
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
      {host ? (
        <p className="mono m-0 text-[10px] text-dim">
          Rows left off inherit the shared default — only what you set here belongs to {host}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The agent list beside the canvas: one accordion item per scope, shared first. A missing agent keeps its
 * row but never opens. The shared item carries the one gateway every agent points at, so nothing here
 * rewrites an agent's own config.
 */
export function AgentsAccordion({ hostState, onSaved }: { hostState: HostState; onSaved: () => void }) {
  const [proxy, setProxy] = useState<HeadroomProxyReport | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyDetail, setProxyDetail] = useState<string | null>(null);
  useEffect(() => {
    void fetchHeadroomProxy().then(setProxy);
  }, []);
  const toggleProxy = (): void => {
    setProxyBusy(true);
    setProxyDetail(null);
    void postHeadroomProxy(proxy?.running ? "stop-proxy" : "start-proxy")
      .then((result) => {
        setProxyDetail(result?.detail ?? "the dashboard server did not answer");
        void fetchHeadroomProxy().then(setProxy);
      })
      .finally(() => setProxyBusy(false));
  };
  return (
    <Accordion className="gap-2.5">
      <AccordionItem value="shared" className="overflow-hidden rounded-xl border border-line bg-panel">
        <AccordionTrigger className="px-4 py-3.5 transition-colors hover:no-underline [&_[data-slot=accordion-trigger-icon]]:text-dim">
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-semibold">All agents — shared default</span>
          <span className="mono mr-3 shrink-0 text-[9px] text-dim">fallback for every agent</span>
        </AccordionTrigger>
        <AccordionContent className="px-4 pb-6 pt-1">
          {/* One soft zone per concern: the mode rows, then the gateway. The padding is the breathing room
              an open row needs, so the controls never sit against the card's own edges. */}
          <div className="rounded-lg bg-track/40 p-4">
            <AgentModes host={null} onSaved={onSaved} />
          </div>
          {/* The gateway: one proxy, every agent, no agent config touched. */}
          <div className="mt-3 rounded-lg bg-track/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-[10px] uppercase tracking-[0.12em] text-dim">gateway</span>
              <span
                className={cn(
                  "mono rounded border px-1.5 py-0.5 text-[10px]",
                  proxy?.running ? "border-success/40 text-success" : "border-line text-dim",
                )}
              >
                {proxy?.running ? `running on :${proxy.port}` : "stopped"}
              </span>
              <button
                type="button"
                disabled={proxyBusy}
                onClick={toggleProxy}
                className="mono ml-auto cursor-pointer rounded-md border border-line px-2 py-1 text-[10px] text-dim transition-colors hover:border-accent/50 hover:text-ink disabled:cursor-default disabled:opacity-40"
              >
                {proxyBusy ? "working" : proxy?.running ? "stop proxy" : "start proxy"}
              </button>
            </div>
            <dl className="mt-3.5 grid gap-2">
              <div className="flex items-baseline gap-3">
                <dt className="mono w-20 shrink-0 text-[9px] uppercase tracking-[0.1em] text-dim">anthropic</dt>
                <dd className="mono m-0 truncate text-[10px] text-ink">ANTHROPIC_BASE_URL={proxy?.anthropicUrl ?? "http://127.0.0.1:8787"}</dd>
              </div>
              <div className="flex items-baseline gap-3">
                <dt className="mono w-20 shrink-0 text-[9px] uppercase tracking-[0.1em] text-dim">openai</dt>
                <dd className="mono m-0 truncate text-[10px] text-ink">OPENAI_BASE_URL={proxy?.openaiUrl ?? "http://127.0.0.1:8787/v1"}</dd>
              </div>
            </dl>
            <p className="m-0 mt-3.5 text-[11px] leading-relaxed text-dim">
              Set either variable in an agent&apos;s environment and its traffic compresses. This is the one
              wiring every agent shares, including pi.
            </p>
            {proxyDetail ? <p className="mono m-0 mt-2 text-[10px] text-dim">{proxyDetail}</p> : null}
          </div>
        </AccordionContent>
      </AccordionItem>
      {HOSTS.map((h) => {
        const installed = hostState.installed[h.id] !== false;
        return (
          <AccordionItem key={h.id} value={h.id} className="overflow-hidden rounded-xl border border-line bg-panel">
            <AccordionTrigger
              disabled={!installed}
              className={cn(
                "px-4 py-3.5 transition-colors hover:no-underline [&_[data-slot=accordion-trigger-icon]]:text-dim",
                !installed && "cursor-default opacity-60",
              )}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-semibold">
                <AgentLogo host={h.id} className="size-4 shrink-0" /> {h.label}
                <span className={cn("mono rounded border px-1 text-[9px]", installed ? "border-accent/40 text-accent" : "border-line text-dim")}>
                  {installed ? "installed" : "not installed"}
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-4 pb-6 pt-1">
              <div className="rounded-lg bg-track/40 p-4">
                <AgentModes host={h.id} onSaved={onSaved} />
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}
