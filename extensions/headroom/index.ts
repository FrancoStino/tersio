// /headroom session mode: tracks the user's Headroom (headroomlabs-ai) install. Opt-in, so no preset turns it on.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getSharedComboState, hasModeState, isOmpSubagentPrompt, lastCustomValue, normalizeInputCommand, normalizeMode, reconcileSharedComboEntries, sessionEntries, setSharedComboListener, setSharedComboMode, systemPromptIncludes } from '../shared/session-state.ts';
import { injectPromptText, onHostEvent, sessionChangeEvents, setExtensionLabel } from '../shared/host.ts';
import { announceStatus } from '../shared/status.ts';
import { readHeadroomDefault } from '../shared/plugin-settings.ts';
import { providerBaseUrl, setProviderBaseUrlInLines } from '../shared/models-yml.ts';
import { hostIdOf } from '../shared/host.ts';
import { homeDir, resolveHeadroomBinary } from '../shared/utils.ts';
import type { ExtensionApi, ExtensionCtx, InputEvent, SessionEntry, SystemPromptEvent } from '../shared/types.ts';

const DEFAULT_MODE = 'off';
export const HEADROOM_INSTALL_HINT = 'pip install "headroom-ai[all]"';

// The proxy compresses traffic below the shell layer, so the block only tells the model what changes and how to recover detail.
export function headroomInstruction(): string {
  return '🍃 HEADROOM MODE ACTIVE — level: on\nHeadroom compression is enabled for this session: tool outputs, file reads, and history may be compressed before reaching you. A compressed result can elide details; treat its elision markers as real. Recover the original before acting on missing detail: run `headroom inspect`, or call the headroom_retrieve MCP tool where wired.';
}

function resolveMode(entries: SessionEntry[] | null | undefined, fallback: string = DEFAULT_MODE): string {
  return lastCustomValue(entries, 'headroom-mode', (data) => normalizeMode('headroom', data?.mode)) ?? fallback;
}

/**
 * omp regenerates its models.yml and silently wipes tersio's gateway rewrite, so routed traffic drifts
 * back to the raw upstream while the state file still claims otherwise. On session start, re-apply the
 * recorded rewrites while the gateway is alive and the file still shows the original baseUrl — a
 * provider the user moved elsewhere stays untouched. Returns what it healed, or null.
 */
export function healOmpRoute(home: string): string | null {
  try {
    const state = JSON.parse(readFileSync(path.join(home, '.tersio', 'headroom-routes.json'), 'utf8')) as {
      ymlRewrites?: Array<{ provider: string; original: string; gateway: string }>;
    };
    const rewrites = state.ymlRewrites ?? [];
    if (rewrites.length === 0) return null;
    const proxy = JSON.parse(readFileSync(path.join(home, '.tersio', 'headroom-proxy.json'), 'utf8')) as { pid?: number | null };
    if (!proxy.pid) return null;
    try { process.kill(proxy.pid, 0); } catch { return null; }
    const file = path.join(home, '.omp', 'agent', 'models.yml');
    if (!existsSync(file)) return null;
    let lines = readFileSync(file, 'utf8').split('\n');
    const healed: string[] = [];
    for (const rewrite of rewrites) {
      if (providerBaseUrl(lines, rewrite.provider) !== rewrite.original) continue;
      const next = setProviderBaseUrlInLines(lines, rewrite.provider, rewrite.gateway);
      if (!next) continue;
      lines = next;
      healed.push(rewrite.provider);
    }
    if (healed.length === 0) return null;
    writeFileSync(file, lines.join('\n'), 'utf8');
    return `re-routed ${healed.join(', ')} through the gateway — omp had rewritten its models.yml`;
  } catch {
    return null;
  }
}

// The shared off phrase; every mode honours it, so one word clears the session.
function isOffCommand(text: unknown): boolean {
  return normalizeInputCommand(text) === 'normal mode';
}

export default function headroomSessionExtension(pi: ExtensionApi): void {
  const host = hostIdOf(pi);
  let currentMode = DEFAULT_MODE;
  let lastInjected: string | undefined = undefined;

  function setMode(mode: string, ctx?: ExtensionCtx): boolean {
    const normalized = normalizeMode('headroom', mode);
    if (!normalized) return false;
    currentMode = normalized;
    pi.appendEntry?.('headroom-mode', { mode: normalized });
    setSharedComboMode('headroom', normalized);
    announceStatus(ctx);
    return true;
  }

  setExtensionLabel(pi, 'Headroom session toggle');

  // Adopt a /tersio or /combo switch at once, so the next turn needs no reload.
  function syncFromShared(state: { headroom: string }): void {
    const mode = normalizeMode('headroom', state.headroom);
    if (mode) currentMode = mode;
  }
  setSharedComboListener('headroom', syncFromShared);

  pi.registerCommand?.('headroom', {
    description: 'Toggle the Headroom token-saver mode for this session',
    handler: async (args, ctx) => {
      const arg = String(args || '').trim().toLowerCase();
      if (!arg || arg === 'on') {
        setMode('on', ctx);
        // The mode can be on while the tool is absent; never silent about it, never installing on our own.
        if (!resolveHeadroomBinary()) {
          ctx?.ui?.notify?.(`Headroom binary not found on PATH. Install it yourself with: ${HEADROOM_INSTALL_HINT}`, 'warning');
        }
        return;
      }
      if (arg === 'status') {
        announceStatus(ctx);
        return;
      }
      if (!setMode(arg, ctx)) {
        ctx?.ui?.notify?.('Usage: /headroom [on|off|status]', 'warning');
      }
    },
  });

  onHostEvent<InputEvent>(pi, 'input', async (event) => {
    if (event?.source === 'extension') return;
    if (currentMode !== 'off' && isOffCommand(event?.text)) setMode('off');
  });

  function restoreMode(ctx?: ExtensionCtx): void {
    const entries = sessionEntries(ctx);
    // A subagent's branch has no Tersio entries; reconciling it would wipe shared state.
    if (hasModeState(entries)) reconcileSharedComboEntries(entries);
    // Persisted state wins, then a mode already chosen, then the configured default. `off` is the start value, not unset.
    const persisted = resolveMode(entries, '');
    const alreadyChosen = currentMode !== DEFAULT_MODE;
    currentMode = persisted || (alreadyChosen ? currentMode : normalizeMode('headroom', readHeadroomDefault(host))) || DEFAULT_MODE;
    announceStatus(ctx);
  }

  // Start, resume, and branch all land here, so every session type shows it.
  pi.on('session_start', async (_event, ctx) => {
    restoreMode(ctx);
    // The route is a machine-level fact, so the heal runs regardless of this session's mode.
    const healed = healOmpRoute(homeDir());
    if (healed) ctx?.ui?.notify?.(`🍃 headroom: ${healed}`, 'info');
  });

  // The host adapter names the switch events it emits, so this stays free of any one host's naming.
  for (const event of sessionChangeEvents(pi)) {
    onHostEvent(pi, event, async (_event, ctx) => {
      restoreMode(ctx);
    });
  }

  pi.on<SystemPromptEvent>('before_agent_start', async (event: SystemPromptEvent) => {
    const mode = isOmpSubagentPrompt(event.systemPrompt) ? getSharedComboState().headroom : currentMode;
    if (!mode || mode === 'off') return;
    // Nothing is compressed when the tool is absent, so the block would lie to the model.
    if (!resolveHeadroomBinary()) return;
    const instruction = headroomInstruction();
    // Match the whole instruction, so a re-presented prompt cannot stack it.
    if (systemPromptIncludes(event.systemPrompt, instruction)) return;
    // The previous block is replaced, not stacked on.
    const stale = lastInjected;
    lastInjected = instruction;
    return injectPromptText(pi, event, { text: instruction, staleMarker: stale, sectionTag: 'headroom' });
  });
}
