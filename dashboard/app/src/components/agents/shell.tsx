// The shell: a glass topbar (brand, mode banner, range, theme) over a page-jumping rail whose footer holds Settings.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "cn";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarInset, SidebarTrigger, SidebarRail,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/charts";
import { Icon } from "@/components/icon";
import { SocialLinks } from "@/components/brand";
import { useTheme } from "@/components/theme-provider";
import { AGENT_RANGES, isFileExport } from "@/lib/data";
import type { AgentRange } from "@/lib/data";
import { useDevMode } from "@/lib/dev-mode";
import { useIsMobile } from "@/hooks/use-mobile";
import { NAV, NAV_ITEMS } from "./nav";
import type { SectionId } from "./nav";

export const DEFAULT_RANGE: AgentRange = "24h";

const RANGE_TEXT: Record<AgentRange, string> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  "90d": "90d",
  all: "All",
};

const RANGE_TITLE: Record<AgentRange, string> = {
  "1h": "Last hour",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  all: "All time",
};

/** The theme button in the topbar: cycles system, light, dark. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const label = theme === "system" ? "System theme" : theme === "light" ? "Light theme" : "Dark theme";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`${label}. Click for ${next}.`}
      title={`${label} · click to switch`}
      className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border border-line text-ink transition-[background] duration-200 hover:bg-accent-soft"
    >
      <Icon name={theme === "system" ? "monitor" : theme === "light" ? "sun" : "moon"} className="size-4" />
    </button>
  );
}

/** The five session-start mode fields the banner reads. */
export interface ModeState {
  comboDefault: string;
  /** The level the banner may claim: `custom` once the four modes stop matching the preset. */
  comboLevel: string;
  cavemanDefault: string;
  rtkDefault: boolean;
  ponytailDefault: string;
  pstackDefault: string;
}

/** One glyph and one short name per mode, in the order the combo names them; pstack trails the three. */
const MODE_GLYPHS = [
  { key: "caveman", glyph: "🪨", label: "caveman", level: (m: ModeState) => (m.cavemanDefault ?? "off").toUpperCase() },
  { key: "rtk", glyph: "🗜️", label: "rtk", level: (m: ModeState) => (m.rtkDefault ? "ON" : "OFF") },
  { key: "ponytail", glyph: "🧠", label: "ponytail", level: (m: ModeState) => (m.ponytailDefault ?? "off").toUpperCase() },
  { key: "pstack", glyph: "🥔", label: "pstack", level: (m: ModeState) => (m.pstackDefault ?? "off").toUpperCase() },
] as const;

/** The combo preset this machine starts sessions with and the modes under it; a click opens Settings. */
export function ModeBanner({ modes, onOpen }: { modes: ModeState | null; onOpen: () => void }) {
  const level = modes?.comboLevel ?? modes?.comboDefault ?? "off";
  const on = level !== "off";
  const label = on ? `COMBO ${level.toUpperCase()}` : "COMBO OFF";
  const boxRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState(false);
  // The mode row scrolls only when it cannot fit, so a short row stays still. The first copy alone is measured: the loop's duplicate would otherwise double the width it compares.
  useEffect(() => {
    const box = boxRef.current;
    const track = trackRef.current;
    if (!box || !track) return;
    const measure = (): void => {
      const first = track.firstElementChild as HTMLElement | null;
      setScroll(first !== null && first.offsetWidth > box.clientWidth + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [modes]);
  const row = (key: string): ReactNode => (
    <span key={key} className="flex shrink-0 items-center">
      {MODE_GLYPHS.map((m, i) => (
        <span key={m.key} className="inline-flex items-center">
          {i > 0 && <span className="mr-1.5 text-dim">|</span>}
          <span className="mr-1.5 inline-flex items-center gap-0.5">
            <span className="text-[12px]">{m.glyph}</span>
            <span className="text-dim">{m.label}=</span>
            <span className={on ? "font-semibold text-ink" : "text-dim"}>{modes ? m.level(modes) : "OFF"}</span>
          </span>
        </span>
      ))}
    </span>
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${label}: ${MODE_GLYPHS.map((m) => `${m.label}=${modes ? m.level(modes) : "OFF"}`).join(", ")}. Open Settings to change it.`}
      className={cn(
        "mono flex h-8 min-w-0 max-w-[540px] cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-[11px] transition-[background,border-color] duration-200 hover:bg-track",
        on ? "border-ink/25 bg-panel" : "border-line bg-panel/60",
      )}
    >
      <span className="shrink-0 text-[13px]">🧩</span>
      <span className={cn("shrink-0", on ? "font-semibold text-ink" : "text-dim")}>{label}:</span>
      {/* The modes ride a marquee: shown from `sm` up, scrolling only when the row outgrows the bar.
          Reduced motion freezes the row, and the button's title still names every mode. */}
      <span ref={boxRef} className="hidden min-w-0 overflow-hidden sm:block">
        <span ref={trackRef} className={cn("flex w-max items-center", scroll && "animate-tick")}>
          {row("single")}
          {scroll && row("loop")}
        </span>
      </span>
    </button>
  );
}

/** The window every page reads. An exported file carries one, so it is a label there. */
export function RangePicker({ range, onPick }: { range: AgentRange; onPick: (next: AgentRange) => void }) {
// Too narrow on a phone for six ranges beside the banner and buttons, so two drop out; `1`-`6` still pick all.
  const compact = useIsMobile();
  const options = AGENT_RANGES.filter((value) => !compact || value === "1h" || value === "24h" || value === "7d" || value === "all");
  if (isFileExport()) {
    return (
      <Badge variant="outline" className="mono h-7 rounded-lg border-line px-2 text-[11px] text-dim">
        {RANGE_TEXT[range]} · exported
      </Badge>
    );
  }
  return (
    <Segmented
      label="Time range"
      value={range}
      onChange={onPick}
      options={options.map((value) => ({ value, label: RANGE_TEXT[value], title: RANGE_TITLE[value] }))}
    />
  );
}

/** `1`-`6` pick a window, `g` then a letter opens a page. */
export function useShortcuts({
  onRange,
  onSection,
}: {
  onRange: (range: AgentRange) => void;
  onSection: (section: SectionId) => void;
}): void {
  const dev = useDevMode();
  useEffect(() => {
    if (isFileExport()) return;
    let armed = 0;
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      if (armed && Date.now() - armed < 1200) {
        armed = 0;
        const item = NAV_ITEMS.find((candidate) => candidate.hotkey === key && (dev || !candidate.devOnly));
        if (item) {
          event.preventDefault();
          onSection(item.id);
        }
        return;
      }
      if (key === "g") {
        armed = Date.now();
        return;
      }
      const index = Number(key) - 1;
      if (Number.isInteger(index) && index >= 0 && index < AGENT_RANGES.length) {
        event.preventDefault();
        onRange(AGENT_RANGES[index]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dev, onRange, onSection]);
}

function SidebarAction({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-dim transition-[background,color] duration-200 hover:bg-track hover:text-ink group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
    >
      <Icon name={icon} className="size-4 shrink-0" />
      <span className="group-data-[collapsible=icon]:hidden">{label}</span>
    </button>
  );
}

export function AppSidebar({
  section,
  onSection,
  agentAvailable,
  onSettings,
}: {
  section: SectionId;
  onSection: (section: SectionId) => void;
  agentAvailable: boolean;
  onSettings: () => void;
}) {
  // A hidden developer page must not keep its slot in the rail, and the hotkey map follows it.
  const dev = useDevMode();
  // z-50 keeps the rail header above the inset's sticky one, so the trigger stays clickable where the two overlap.
  return (
    <Sidebar collapsible="icon" className="z-50 border-r border-line bg-panel text-ink">
      <SidebarHeader className="h-12 shrink-0 justify-center border-b border-line p-0 px-2">
        <div className="flex h-8 w-full items-center gap-2.5 px-1.5">
          {/* The mark hides with the rail: a 24 pixel mark beside the trigger overflows the 48
              pixel strip and leaves the trigger hanging outside the rail. */}
          <img
            src="brand.webp"
            alt=""
            width="24"
            height="24"
            className="size-6 shrink-0 rounded-[8px] group-data-[collapsible=icon]:hidden"
          />
          <span className="min-w-0 truncate text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Tersio <span className="font-normal text-dim">stats</span>
          </span>
          <SidebarTrigger className="ml-auto shrink-0 text-dim hover:text-ink" aria-label="Toggle navigation" />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((group) => {
          const items = group.items.filter((item) => (agentAvailable || !item.agentOnly) && (dev || !item.devOnly));
          if (items.length === 0) return null;
          return (
            <SidebarGroup key={group.heading}>
              <SidebarGroupLabel className="mono text-[10px] uppercase tracking-[0.16em] text-dim">
                {group.heading}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={section === item.id}
                        tooltip={item.label}
                        onClick={() => onSection(item.id)}
                        className="mono text-[13px] text-dim hover:bg-track hover:text-ink data-[active]:bg-track data-[active]:font-bold data-[active]:text-ink"
                      >
                        <Icon name={item.icon} className="size-4" />
                        <span className="truncate">{item.label}</span>
                        <kbd className="mono ml-auto hidden shrink-0 text-[10px] opacity-70 group-data-[collapsible=offcanvas]:inline">
                          G {item.hotkey.toUpperCase()}
                        </kbd>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter className="gap-2 border-t border-line p-2">
        <SidebarAction icon="settings" label="Settings" onClick={onSettings} />
        {/* The collapsed rail is an icon strip, so the credits, the marks, and the shortcut hint
            hide there. Each of them would run past the 48 pixel rail and clip mid-word. */}
        <div className="mono flex items-center gap-1 px-1 text-[10px] text-dim group-data-[collapsible=icon]:hidden">
          <span className="truncate">© 2026 Tersio</span>
          <SocialLinks className="ml-auto flex items-center gap-0.5 text-ink" />
        </div>
        <p className="mono hidden px-1 text-[10px] leading-relaxed text-dim group-data-[collapsible=offcanvas]:block">
          <kbd>1</kbd>-<kbd>6</kbd> window · <kbd>G</kbd> then a letter to jump
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

export function Topbar({
  range,
  onRange,
  modes,
  onShare,
  onOpenSettings,
}: {
  range: AgentRange;
  onRange: (range: AgentRange) => void;
  modes: ModeState | null;
  onShare: () => void;
  onOpenSettings: () => void;
}) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        // The rule always shows, lining up with the rail header's; below `sm` the row wraps rather than clipping the modes.
        "sticky top-0 z-40 flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-3 py-1.5 backdrop-blur-md transition-[background] duration-200 sm:h-12 sm:flex-nowrap sm:gap-2 sm:py-0",
        scrolled ? "bg-panel/85" : "bg-transparent",
      )}
    >
      {/* On a phone the rail is a sheet, and its own header lives inside the sheet, so the topbar
          carries the trigger that opens it. From `sm` up the rail header keeps its own. */}
      <SidebarTrigger
        aria-label="Toggle navigation"
        className="grid size-8 shrink-0 place-items-center rounded-lg border border-line text-ink transition-[background] duration-200 hover:bg-accent-soft sm:hidden"
      />
      {/* The rail's own header carries the expand/collapse control; the banner names the modes. */}
      <ModeBanner modes={modes} onOpen={onOpenSettings} />
      {/* The right group never shrinks: it holds the three buttons a narrow viewport still needs,
          and the banner truncates instead. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <RangePicker range={range} onPick={onRange} />
        <button
          type="button"
          onClick={onShare}
          aria-label="Share usage"
          title="Share usage"
          className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border border-line text-ink transition-[background] duration-200 hover:bg-accent-soft"
        >
          <Icon name="share-2" className="size-4" />
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}

/** Rail plus topbar plus one routed page. */
export function Shell({
  section,
  onSection,
  range,
  onRange,
  modes,
  agentAvailable,
  onSettings,
  onShare,
  children,
}: {
  section: SectionId;
  onSection: (section: SectionId) => void;
  range: AgentRange;
  onRange: (range: AgentRange) => void;
  modes: ModeState | null;
  agentAvailable: boolean;
  onSettings: () => void;
  onShare: () => void;
  children: React.ReactNode;
}) {
  return (
    <SidebarProvider defaultOpen className="[--sidebar-width:13.5rem]">
      <AppSidebar
        section={section}
        onSection={onSection}
        agentAvailable={agentAvailable}
        onSettings={onSettings}
      />
      <SidebarInset className="min-w-0 bg-transparent">
        <div
          className="pointer-events-none fixed inset-0 [background-image:linear-gradient(var(--grid)_1px,transparent_1px),linear-gradient(90deg,var(--grid)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_90%_70%_at_50%_0%,black_30%,transparent_75%)]"
          aria-hidden="true"
        />
        <Topbar range={range} onRange={onRange} modes={modes} onShare={onShare} onOpenSettings={onSettings} />
        <main className="relative w-full max-w-full overflow-x-clip">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
