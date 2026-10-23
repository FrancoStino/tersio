// Logs page: every change Tersio made on this machine, newest first.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, Page, PageHeader, PagedTable, Segmented } from "@/components/charts";
import type { Column } from "@/components/charts";
import { EmptyState } from "@/components/common";
import { Icon } from "@/components/icon";
import { cn } from "cn";

type Kind = "mode" | "agent" | "file" | "doctor";

interface Entry {
  at: number;
  kind: Kind;
  title: string;
  detail?: string;
  ok?: boolean;
}

const KIND_LABEL: Record<Kind, string> = {
  mode: "Mode",
  agent: "Agent",
  file: "File",
  doctor: "Doctor",
};

const FILTERS: ReadonlyArray<{ value: "all" | Kind; label: string }> = [
  { value: "all", label: "All" },
  { value: "mode", label: "Modes" },
  { value: "agent", label: "Agents" },
  { value: "file", label: "Files" },
  { value: "doctor", label: "Doctor" },
];

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function stamp(at: number): string {
  return new Date(at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium" });
}

export function LogsPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | Kind>("all");

  const load = useCallback((): void => {
    void fetch("/api/logs?limit=500")
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: Entry[] | null) => { if (Array.isArray(rows)) setEntries(rows); })
      .catch(() => { /* keep what is on screen */ })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    // The CLI writes to the same file from another process, so the page rereads it while open.
    const timer = window.setInterval(load, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const rows = useMemo(
    () => (filter === "all" ? entries : entries.filter((entry) => entry.kind === filter)),
    [entries, filter],
  );

  const columns: Array<Column<Entry>> = [
    {
      key: "at",
      header: "When",
      width: 92,
      sort: (row) => row.at,
      render: (row) => (
        <span className="text-dim" title={stamp(row.at)}>{clock(row.at)}</span>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      width: 82,
      render: (row) => (
        <span className="rounded border border-line px-1 text-[10px] text-dim">{KIND_LABEL[row.kind] ?? row.kind}</span>
      ),
    },
    {
      key: "title",
      header: "Event",
      sort: (row) => row.title,
      render: (row) => (
        <span className={cn("text-[12px]", row.ok === false ? "text-destructive" : "text-ink")}>{row.title}</span>
      ),
    },
    {
      key: "detail",
      header: "Detail",
      render: (row) => (
        <span className="block max-w-[560px] truncate text-[11px] text-dim" title={row.detail}>{row.detail ?? ""}</span>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="Logs"
        description="Every change Tersio makes on this machine, newest first: modes, agents, files, and checks."
      />

      <Card
        title="Activity"
        icon="scroll-text"
        description="Modes and presets, installs and updates, the files the installer rewrites, and doctor runs."
        flush
        actions={(
          <button
            type="button"
            onClick={load}
            aria-label="Refresh log"
            title="Refresh log"
            className="grid size-7 cursor-pointer place-items-center rounded-md text-dim transition-colors duration-200 hover:bg-track hover:text-ink"
          >
            <Icon name="refresh-cw" className="size-3.5" />
          </button>
        )}
      >
        <div className="flex items-center gap-3 border-b border-line px-3.5 py-2">
          <Segmented
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((option) => ({ value: option.value, label: option.label }))}
            label="Filter the log"
          />
          <span className="mono ml-auto text-[11px] text-dim">{rows.length} entries</span>
        </div>
        {loading && entries.length === 0 ? (
          <div className="grid gap-2 p-3.5" aria-busy="true" aria-label="Loading log">
            {Array.from({ length: 6 }, (_, index) => (
              <span key={index} className="h-6 animate-pulse rounded bg-track" />
            ))}
          </div>
        ) : (
          <PagedTable
            columns={columns}
            rows={rows}
            rowKey={(row) => `${row.at}:${row.kind}:${row.title}:${row.detail ?? ""}`}
            initialSort={{ key: "at", dir: "desc" }}
            perPage={25}
            empty={(
              <EmptyState
                icon="scroll-text"
                title="No activity yet"
                desc="Change a mode, install or update an agent, or run the doctor. Every change lands here."
              />
            )}
            ariaLabel="Tersio activity"
          />
        )}
      </Card>
    </Page>
  );
}
