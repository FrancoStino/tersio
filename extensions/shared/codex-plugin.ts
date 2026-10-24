// The Codex plugin tree and the mode context its hooks add to every turn.
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCavemanDefault, readComboDefault, readPluginSettings, readPonytailDefault, readPstackDefault } from './plugin-settings.ts';
import { COMBO_LEVELS, normalizeMode } from './session-state.ts';
import { findPackageRoot, homeDir } from './utils.ts';
import type { ComboState } from './types.ts';

export const CODEX_MARKETPLACE_NAME = 'tersio';
export const CODEX_PERSONAL_MARKETPLACE_NAME = 'tersio-personal';
export const CODEX_PLUGIN_NAME = 'tersio';
export const CODEX_PLUGIN_ID = `${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`;
export const CODEX_PERSONAL_PLUGIN_ID = `${CODEX_PLUGIN_NAME}@${CODEX_PERSONAL_MARKETPLACE_NAME}`;
export const CODEX_MARKETPLACE_SOURCE = 'KurutoDenzeru/tersio';
export const CODEX_MARKETPLACE_SPARSE = ['.agents/plugins', `plugins/${CODEX_PLUGIN_NAME}`] as const;
/** Codex discovers this marketplace without a registration command. */
export function codexPersonalMarketplaceFile(): string {
  return path.join(homeDir(), '.agents', 'plugins', 'marketplace.json');
}
export function codexPersonalPluginDir(): string {
  return path.join(homeDir(), '.tersio', 'codex-plugin');
}
/** The five files a marketplace plugin carries. Its commands use the Tersio CLI on PATH. */
export const CODEX_MARKETPLACE_PLUGIN_FILES = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'skills/status/SKILL.md',
  'package.json',
] as const;
/** The complete local fallback: the marketplace files plus a self-contained CLI runtime. */
export const CODEX_BUNDLED_PLUGIN_FILES = [
  ...CODEX_MARKETPLACE_PLUGIN_FILES,
  'tersio',
  'dist/tersio.js',
  'extensions/caveman/rule.md',
  'extensions/caveman/rule-lite.md',
  'extensions/caveman/rule-ultra.md',
  'extensions/caveman/rule-megacave-lite.md',
  'extensions/caveman/rule-megacave.md',
  'extensions/caveman/rule-megacave-ultra.md',
  'extensions/ponytail/hooks/ponytail-instructions.js',
  'extensions/pstack/rule.md',
] as const;
export type CodexPluginLayout = 'marketplace' | 'bundled';
/** The full runtime closure: copying only @clack leaves its hoisted dependencies behind. */
export const CODEX_RUNTIME_PACKAGES = [
  '@clack/core',
  '@clack/prompts',
  'fast-string-truncated-width',
  'fast-string-width',
  'fast-wrap-ansi',
  'sisteransi',
] as const;

const ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const EXTENSIONS = path.join(ROOT, 'extensions');
const PONYTAIL = path.join(EXTENSIONS, 'ponytail');

function read(root: string, file: string): string {
  return readFileSync(path.join(root, ...file.split('/')), 'utf8');
}

export function codexPluginManifest(): string {
  const pkg = JSON.parse(read(ROOT, 'package.json')) as { version?: unknown };
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  return `${JSON.stringify({
    name: CODEX_PLUGIN_NAME,
    version,
    description: 'Tersio modes and session usage for Codex.',
    author: { name: 'KurutoDenzeru' },
    homepage: 'https://github.com/KurutoDenzeru/tersio',
    repository: 'https://github.com/KurutoDenzeru/tersio',
    license: 'MIT',
    skills: './skills/',
    mcpServers: './.mcp.json',
    hooks: './hooks/hooks.json',
    interface: {
      displayName: 'Tersio',
      shortDescription: 'Terse agent modes and usage',
      longDescription: 'Keep Tersio modes active in Codex, and read local agent usage through the Tersio MCP server.',
      developerName: 'KurutoDenzeru',
      category: 'Developer Tools',
      capabilities: ['Read', 'Write', 'Lifecycle hooks'],
      websiteURL: 'https://github.com/KurutoDenzeru/tersio',
      defaultPrompt: ['Show my Tersio mode status', 'Show my local agent usage'],
      brandColor: '#D97706',
    },
  }, null, 2)}\n`;
}

/**
 * The plugin files. A bundled plugin runs its own CLI with the absolute Node path that installed it.
 * A marketplace plugin uses the Tersio CLI on PATH, because its source carries no build output.
 */
export function codexPluginFiles(
  bundled = true,
  nodePath = process.execPath,
  bundledLauncher = '${PLUGIN_ROOT}/tersio',
): Record<string, string> {
  const command = bundled ? `"${nodePath}" "\${PLUGIN_ROOT}/tersio"` : 'tersio';
  const files: Record<string, string> = {
    '.codex-plugin/plugin.json': codexPluginManifest(),
    '.mcp.json': `${JSON.stringify({
      mcpServers: {
        tersio: {
          command: bundled ? nodePath : 'tersio',
          args: bundled ? [bundledLauncher, 'mcp'] : ['mcp'],
          env: { TERSIO_MCP_RUNTIME: 'node' },
        },
      },
    }, null, 2)}\n`,
    'hooks/hooks.json': `${JSON.stringify({
      hooks: {
        // UserPromptSubmit runs before every prompt, including startup and resume.
        // It owns the context so one turn never receives the same mode block twice.
        UserPromptSubmit: [{
          hooks: [{
            type: 'command',
            command: `${command} codex-hook user-prompt-submit`,
            statusMessage: 'Refreshing Tersio modes',
          }],
        }],
      },
    }, null, 2)}\n`,
    'skills/status/SKILL.md': `---
name: status
description: Use when the user asks for Tersio mode status or local agent usage.
---

# Tersio status

Read the current mode defaults from \`~/.tersio/settings.json\`.

Call the \`tersio_stats\` MCP tool for usage totals.
State the range and the source of each figure.
`,
    'package.json': read(ROOT, 'package.json'),
  };
  if (bundled) files.tersio = '#!/usr/bin/env node\nimport "./dist/tersio.js";\n';
  return files;
}

/** Add the Tersio entry to the personal marketplace, and keep every other entry. */
export function addCodexPersonalMarketplace(existing: string | null): string {
  let parsed: Record<string, unknown> = {};
  if (existing !== null) {
    try {
      const value: unknown = JSON.parse(existing);
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch { /* replace an unreadable marketplace only when the user asked for this install */ }
  }
  const plugins = Array.isArray(parsed.plugins) ? [...parsed.plugins] : [];
  const entry = {
    name: CODEX_PLUGIN_NAME,
    source: {
      source: 'local',
      path: `./${path.relative(homeDir(), codexPersonalPluginDir()).split(path.sep).join('/')}`,
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Developer Tools',
  };
  const index = plugins.findIndex((plugin) => (
    plugin !== null
    && typeof plugin === 'object'
    && (plugin as { name?: unknown }).name === CODEX_PLUGIN_NAME
  ));
  if (index === -1) plugins.push(entry);
  else plugins[index] = entry;
  return `${JSON.stringify({
    ...parsed,
    name: typeof parsed.name === 'string' && parsed.name ? parsed.name : CODEX_PERSONAL_MARKETPLACE_NAME,
    interface: parsed.interface ?? { displayName: 'Tersio' },
    plugins,
  }, null, 2)}\n`;
}

/** The name Codex will use for the personal marketplace, including a user's existing name. */
export function codexPersonalMarketplaceName(existing: string | null): string {
  if (existing === null) return CODEX_PERSONAL_MARKETPLACE_NAME;
  try {
    const value: unknown = JSON.parse(existing);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const name = (value as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) return name;
    }
  } catch { /* an unreadable file is replaced by the install */ }
  return CODEX_PERSONAL_MARKETPLACE_NAME;
}

/** The plugin ID for the personal marketplace that is on disk. */
export function codexPersonalPluginId(existing: string | null): string {
  return `${CODEX_PLUGIN_NAME}@${codexPersonalMarketplaceName(existing)}`;
}

/** Remove only the Tersio entry. Keep a user's other personal plugins. */
export function removeCodexPersonalMarketplace(existing: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(existing);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }
  const plugins = Array.isArray(parsed.plugins)
    ? parsed.plugins.filter((plugin) => (
      plugin === null
      || typeof plugin !== 'object'
      || (plugin as { name?: unknown }).name !== CODEX_PLUGIN_NAME
    ))
    : [];
  if (plugins.length === 0) return null;
  return `${JSON.stringify({ ...parsed, plugins }, null, 2)}\n`;
}

/** The plugin files the public marketplace package carries. */
export function codexMarketplacePluginFiles(): Record<string, string> {
  return codexPluginFiles(false);
}

/** The old direct writer is not a Codex registration, so keep its path only for cleanup. */
export function codexLegacyPluginDir(): string {
  return path.join(homeDir(), '.codex', 'plugins', CODEX_PLUGIN_NAME);
}

/** A missing mode body fails loud, so a requested mode never reads as active with no rule. */
function rule(name: string, file: string): string {
  try {
    return read(EXTENSIONS, `${name}/${file}`);
  } catch {
    return `Tersio ${name} mode requested, but ${file} is missing. Run: tersio install --host codex`;
  }
}

function cavemanRule(mode: string): string {
  const files: Record<string, string> = {
    lite: 'rule-lite.md',
    full: 'rule.md',
    ultra: 'rule-ultra.md',
    'megacave-lite': 'rule-megacave-lite.md',
    'megacave-full': 'rule-megacave.md',
    'megacave-ultra': 'rule-megacave-ultra.md',
  };
  return `Caveman ${mode} active for this session.\n${rule('caveman', files[mode] ?? 'rule.md')}`;
}

function ponytailRule(mode: string): string {
  try {
    const require = createRequire(import.meta.url);
    const loaded = require(path.join(PONYTAIL, 'hooks', 'ponytail-instructions.js')) as {
      getPonytailInstructions?: (level: string) => string;
      default?: { getPonytailInstructions?: (level: string) => string };
    };
    const build = loaded.getPonytailInstructions ?? loaded.default?.getPonytailInstructions;
    if (build) return build(mode);
  } catch { /* fall through to the bundled text */ }
  return `PONYTAIL MODE ACTIVE - level: ${mode}\nUse the minimum correct solution. Delete or reuse before adding.`;
}

function storedModes(): Pick<ComboState, 'caveman' | 'rtk' | 'ponytail' | 'pstack'> {
  const settings = readPluginSettings();
  const hasModeDefaults = ['cavemanDefault', 'rtkDefault', 'ponytailDefault', 'pstackDefault'].some((key) => key in settings);
  if (hasModeDefaults) {
    return {
      caveman: readCavemanDefault(),
      rtk: settings.rtkDefault === true ? 'on' : 'off',
      ponytail: readPonytailDefault(),
      pstack: readPstackDefault(),
    };
  }
  return { ...COMBO_LEVELS[readComboDefault()] ?? COMBO_LEVELS.off, pstack: 'off' };
}

/** The mode blocks a Codex hook adds as developer context. Off modes add no text. */
export function codexModeContext(): string {
  const modes = storedModes();
  const blocks: string[] = [];
  const caveman = normalizeMode('caveman', modes.caveman);
  const ponytail = normalizeMode('ponytail', modes.ponytail);
  const pstack = normalizeMode('pstack', modes.pstack);
  if (caveman && caveman !== 'off') blocks.push(cavemanRule(caveman));
  if (ponytail && ponytail !== 'off') blocks.push(ponytailRule(ponytail));
  if (pstack === 'on') {
    const home = `Leaves, playbooks, and skills live at: ${EXTENSIONS}/pstack.`;
    blocks.push(`pstack mode active for this session.\n${rule('pstack', 'rule.md')}\n${home}`);
  }
  return blocks.join('\n\n');
}

export function codexPluginDir(): string {
  return codexPersonalPluginDir();
}

function personalMarketplaceNames(): string[] {
  let name = CODEX_PERSONAL_MARKETPLACE_NAME;
  try {
    name = codexPersonalMarketplaceName(readFileSync(codexPersonalMarketplaceFile(), 'utf8'));
  } catch { /* no personal marketplace */ }
  return [...new Set([CODEX_PERSONAL_MARKETPLACE_NAME, name])];
}

/** The expected file set for a path. The local fallback is bundled; a marketplace cache is not. */
export function codexPluginLayoutForDir(dir: string): CodexPluginLayout {
  const normalized = path.resolve(dir);
  if (normalized === path.resolve(codexPersonalPluginDir())) return 'bundled';
  const cacheRoot = path.join(homeDir(), '.codex', 'plugins', 'cache');
  if (personalMarketplaceNames().some((name) => (
    normalized.startsWith(path.join(path.resolve(cacheRoot), name, CODEX_PLUGIN_NAME))
  ))) return 'bundled';
  return 'marketplace';
}

export function codexPluginFilesForLayout(layout: CodexPluginLayout): readonly string[] {
  return layout === 'bundled' ? CODEX_BUNDLED_PLUGIN_FILES : CODEX_MARKETPLACE_PLUGIN_FILES;
}

export function codexPluginInstalled(dir = codexPluginDir(), layout = codexPluginLayoutForDir(dir)): boolean {
  return codexPluginFilesForLayout(layout).every((file) => existsSync(path.join(dir, ...file.split('/'))));
}

export interface CodexPluginState {
  dir: string;
  pluginId: string | null;
  layout: CodexPluginLayout;
  version: string | null;
  complete: boolean;
  enabled: boolean;
  missing: string[];
}

function pluginVersion(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * The install on disk. A partial cache is not a valid install, but its marketplace and ID still
 * let a repair run `plugin add` again.
 */
export function codexPluginState(dir: string): CodexPluginState {
  const layout = codexPluginLayoutForDir(dir);
  const files = codexPluginFilesForLayout(layout);
  const missing = files.filter((file) => !existsSync(path.join(dir, ...file.split('/'))));
  const pluginId = codexPluginIdForDir(dir);
  return {
    dir,
    pluginId,
    layout,
    version: pluginVersion(dir),
    complete: missing.length === 0,
    enabled: pluginId !== null && codexPluginEnabled(pluginId),
    missing,
  };
}

/** A directory Codex registered, even when the cache is short of files. */
export function codexRegisteredPluginState(): CodexPluginState | null {
  return codexExistingPluginDirs().map(codexPluginState).find((state) => state.enabled) ?? null;
}

/** A marketplace install lives under the cache; a direct install lives at the local plugin path. */
export function codexPluginInstallDirs(): string[] {
  const cacheRoot = path.join(homeDir(), '.codex', 'plugins', 'cache');
  const names = [...new Set([CODEX_MARKETPLACE_NAME, ...personalMarketplaceNames()])];
  const dirs: string[] = [];
  for (const name of names) {
    const root = path.join(cacheRoot, name, CODEX_PLUGIN_NAME);
    let versions: string[] = [];
    try {
      versions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch { /* no cache for this marketplace */ }
    dirs.push(...versions.map((version) => path.join(root, version)));
  }
  return [...dirs, codexPluginDir()];
}

/**
 * Every Tersio plugin directory that exists, including a partial download with no manifest.
 * Doctor and install can then repair the directory instead of treating it as absent.
 */
export function codexExistingPluginDirs(): string[] {
  const cacheRoot = path.join(homeDir(), '.codex', 'plugins', 'cache');
  const names = [...new Set([CODEX_MARKETPLACE_NAME, ...personalMarketplaceNames()])];
  const dirs: string[] = [];
  for (const name of names) {
    const root = path.join(cacheRoot, name, CODEX_PLUGIN_NAME);
    let versions: string[] = [];
    try {
      versions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch { /* no cache for this marketplace */ }
    dirs.push(...versions.map((version) => path.join(root, version)));
  }
  if (existsSync(codexPersonalPluginDir())) dirs.push(codexPersonalPluginDir());
  return dirs;
}

/** The plugin ID Codex reads for a cache path, or the personal ID for the local fallback. */
export function codexPluginIdForDir(dir: string): string | null {
  const normalized = path.resolve(dir);
  if (normalized === path.resolve(codexPersonalPluginDir())) {
    let existing: string | null = null;
    try { existing = readFileSync(codexPersonalMarketplaceFile(), 'utf8'); } catch { /* no file */ }
    return codexPersonalPluginId(existing);
  }
  const cacheRoot = path.resolve(homeDir(), '.codex', 'plugins', 'cache');
  const relative = path.relative(cacheRoot, normalized);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const [marketplace, plugin] = relative.split(path.sep);
  if (!marketplace || plugin !== CODEX_PLUGIN_NAME) return null;
  return `${plugin}@${marketplace}`;
}

/** Whether Codex enables this plugin. A complete directory alone does not load. */
export function codexPluginEnabled(pluginId = CODEX_PLUGIN_ID): boolean {
  const config = path.join(homeDir(), '.codex', 'config.toml');
  let text = '';
  try {
    text = readFileSync(config, 'utf8');
  } catch {
    return false;
  }
  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\[plugins\\."${escaped}"\\]\\s*\\n(?:[^\\n]*\\n)*?enabled\\s*=\\s*true`, 'm').test(text);
}

/** The first complete install, and its manifest version when the manifest is readable. */
export function codexInstalledPlugin(): { dir: string; version: string | null; layout: CodexPluginLayout } | null {
  for (const dir of codexPluginInstallDirs()) {
    const layout = codexPluginLayoutForDir(dir);
    if (!codexPluginInstalled(dir, layout)) continue;
    return { dir, version: pluginVersion(dir), layout };
  }
  return null;
}
