// Quick start: the pipeline as one canvas, drawn the way a workflow tool lays it out.
// Everything here mirrors docs/ARCHITECTURE.md: the hosts, the block order, and the turn it produces.
import { useEffect, useState } from "react";
import { Card, Page, PageHeader, Segmented } from "@/components/charts";
import { AgentLogo } from "@/components/agent-logos";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/icon";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { usePending } from "@/hooks/use-pending";
import { isFileExport } from "@/lib/data";
import { fetchHealth } from "@/lib/data";
import type { ModeState } from "./shell";
import { useToast } from "../toaster";
import { AgentsAccordion } from "./how-to-modes";
import { PipelineCanvas, PipelineSkeleton } from "./how-to-canvas";
import { HOSTS, readHosts, versionOf } from "./pipeline-model";
import type { HostAction, HostState, NodeId } from "./pipeline-model";


export function HowToPage({ modes, onModesChanged }: { modes: ModeState | null; onModesChanged: () => void }) {
  const toast = useToast();
  const [hostState, setHostState] = useState<HostState>({ installed: {}, versions: {} });
  const [busy, setBusy] = useState<NodeId | null>(null);
  // Adding an agent lives in the card header, separate from the mode workflow it feeds.
  const [addOpen, setAddOpen] = useState(false);
  const missingHosts = HOSTS.filter((host) => hostState.installed[host.id] === false);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  // An exported file has no server: /settings never answers, so the documented every-node-lit reading holds
  // there instead of a permanent skeleton.
  const pipelinePending = usePending(!hostsLoaded || (!isFileExport() && modes === null));
  // The pipeline card carries both views: the interactive canvas, and the agent list beside it.
  const [pipelineView, setPipelineView] = useState<"canvas" | "agents">("canvas");

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
        description="Each mode appends one block to the prompt, and RTK rewrites and filters what runs. A dimmed node is off or uninstalled. Click a node to switch it."
        actions={
          <div className="flex items-center gap-2">
            {pipelinePending ? (
              <Skeleton className="h-7 w-40 rounded-lg" aria-hidden="true" />
            ) : (
              <Segmented
                label="Pipeline view"
                value={pipelineView}
                options={[
                  { value: "canvas", label: "Canvas", title: "The interactive pipeline" },
                  { value: "agents", label: "Modes", title: "Every agent and the mode defaults it can turn on" },
                ]}
                onChange={setPipelineView}
              />
            )}
            {pipelinePending ? (
              <Skeleton className="h-8 w-28 rounded-lg" aria-hidden="true" />
            ) : missingHosts.length > 0 ? (
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
                          className="mono ml-auto flex items-center gap-1.5 cursor-pointer rounded-md border border-line px-1.5 py-1 text-[10px] text-dim transition-colors hover:border-accent/50 hover:text-ink disabled:cursor-default disabled:opacity-40"
                        >
                          {busy === `host-${host.id}` ? <Spinner className="size-3 shrink-0 text-accent" /> : null}
                          {busy === `host-${host.id}` ? "working" : "Install"}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        }
      >
        {pipelinePending ? <PipelineSkeleton /> : pipelineView === "canvas" ? (
          <PipelineCanvas modes={modes} hostState={hostState} onSet={save} onHostAction={hostAction} busy={busy} />
        ) : (
          <AgentsAccordion hostState={hostState} onSaved={onModesChanged} />
        )}
      </Card>
    </Page>
  );
}

