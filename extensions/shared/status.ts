// One status string every surface renders: host footer, CLI title, dashboard banner. Nothing else formats mode state.
import { getSharedComboState } from './session-state.ts';
import type { ExtensionCtx, UiApi } from './types.ts';

export interface StatusState {
  level: string;
  caveman: string;
  rtk: string;
  ponytail: string;
}

/** OFF collapses the three modes into one word; a preset or a mix names itself. */
export function formatStatus(state: StatusState): string {
  const { level, caveman, rtk, ponytail } = state;
  if (level === 'off' && caveman === 'off' && rtk === 'off' && ponytail === 'off') return '🧩 combo OFF';
  const label = level === 'custom' ? 'CUSTOM' : level.toUpperCase();
  return `🧩 combo ${label}: 🪨caveman=${caveman.toUpperCase()} ⚡rtk=${rtk.toUpperCase()} 🦥ponytail=${ponytail.toUpperCase()}`;
}

// The string upstream's skill tells the model to relay for `/caveman status`; `off` is a mode, so it reads as one.
export function formatCavemanStatus(mode: string): string {
  return `Caveman mode: ${mode || 'unknown'}`;
}

// Stale ctx access throws, so never let it abort a mode restore.
function statusUi(ctx: ExtensionCtx | undefined): UiApi | undefined {
  try {
    const ui = ctx?.ui;
    return ui?.setStatus ? ui : undefined;
  } catch {
    return undefined;
  }
}

// Subagents and bare restores must not mute the bar on the real session.
let remembered: ExtensionCtx | undefined;
let lastText: string | undefined;
let lastUi: UiApi | undefined;

// Paint the host footer bar; same text on the same UI is skipped, a new ctx repaints it.
// One key only: the combo line already names the caveman mode, and a second key renders as a second footer line.
export function announceStatus(ctx: ExtensionCtx | undefined): void {
  const state = getSharedComboState();
  const text = formatStatus(state);
  const ui = statusUi(ctx) ?? statusUi(remembered);
  if (statusUi(ctx)) remembered = ctx;
  if (!ui) return;
  if (text === lastText && ui === lastUi) return;
  lastText = text;
  lastUi = ui;
  ui.setStatus?.('tersio', text);
}
