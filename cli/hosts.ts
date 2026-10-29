// cli/hosts.ts — agent hosts Tersio installs into, and what is on disk. One detector shared by doctor and menus.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { HOME, OMP_PLUGINS_DIR, PACKAGE_NAME, PACKAGE_VERSION } from './common.ts';
import { treeFilesFor } from './manifest.ts';
import { piAgentDir, pigAgentDir } from '../extensions/shared/utils.ts';

export type HostId = 'omp' | 'pi' | 'opencode' | 'pig';

export interface HostEntry {
  id: HostId;
  label: string;
  bin: string;
  installCmd: string;
  removeCmd: string;
  installed: boolean;
  /** How it is installed: a written tree, or the npm package. */
  via: 'tree' | 'package' | null;
  /** The pi source pi has declared, when the host keeps one. */
  declared: string | null;
  version: string | null;
  /** The extension tree, or the package dir, depending on `via`. */
  dir: string | null;
}

/** One detected host, as `detectHosts` returns it. */
export type DetectedHost = HostEntry;



export function hostExtensionsDir(id: HostId, agentDir = id === 'pig' ? pigAgentDir() : piAgentDir()): string {
  if (id === 'omp') return path.join(HOME, '.omp', 'agent', 'extensions');
  if (id === 'opencode') return path.join(HOME, '.config', 'opencode', 'plugins', 'tersio');
  return path.join(agentDir, 'extensions');
}

function missingTreeFiles(id: HostId, agentDir = id === 'pig' ? pigAgentDir() : piAgentDir()): string[] {
  const dir = hostExtensionsDir(id, agentDir);
  return treeFilesFor(id).filter((file) => !existsSync(path.join(dir, file)));
}

export function ompPackageDir(): string {
  return path.join(OMP_PLUGINS_DIR, 'node_modules', ...PACKAGE_NAME.split('/'));
}

function piPackageDir(agentDir = piAgentDir()): string {
  return path.join(agentDir, 'npm', 'node_modules', ...PACKAGE_NAME.split('/'));
}

export function pigPackageDir(agentDir = pigAgentDir()): string {
  return path.join(agentDir, 'npm', 'node_modules', ...PACKAGE_NAME.split('/'));
}

function piSettingsFile(agentDir = piAgentDir()): string {
  return path.join(agentDir, 'settings.json');
}

export function pigSettingsFile(agentDir = pigAgentDir()): string {
  return path.join(agentDir, 'settings.json');
}

// pi installs Ponytail as a local path package, so settings.json names the loaded directory; the npm spec is older.
export function piPonytailPackageDir(agentDir = piAgentDir()): string {
  let packages: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(piSettingsFile(agentDir), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { packages?: unknown }).packages)) {
      packages = (parsed as { packages: unknown[] }).packages;
    }
  } catch { /* no settings file, or unreadable */ }
  for (const entry of packages) {
    const source = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source;
    if (typeof source !== 'string') continue;
    const trimmed = source.trim().replace(/[/\\]+$/, '');
    if (path.isAbsolute(trimmed) && path.basename(trimmed) === 'ponytail') return trimmed;
  }
  return path.join(agentDir, 'npm', 'node_modules', '@dietrichgebert', 'ponytail');
}

/** pi and PiG read the same settings shape, so the one lookup serves both. */
export function pigPonytailPackageDir(agentDir = pigAgentDir()): string {
  return piPonytailPackageDir(agentDir);
}

function packageVersion(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

// The tersio package pi declared in settings.json, or null; pi names sources, so npm spec, git URL or path count.
export function piTersioSource(agentDir = piAgentDir()): string | null {
  let settings: { packages?: unknown };
  try {
    const parsed: unknown = JSON.parse(readFileSync(piSettingsFile(agentDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    settings = parsed as { packages?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(settings.packages)) return null;
  for (const entry of settings.packages) {
    const source = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source;
    if (typeof source !== 'string') continue;
    const trimmed = source.trim().replace(/[/\\]+$/, '');
    if (trimmed.includes(PACKAGE_NAME) || /(^|[/\\])tersio(\.git)?$/i.test(trimmed)) return source.trim();
  }
  return null;
}

export function pigTersioSource(agentDir = pigAgentDir()): string | null {
  let settings: { packages?: unknown };
  try {
    const parsed: unknown = JSON.parse(readFileSync(pigSettingsFile(agentDir), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    settings = parsed as { packages?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(settings.packages)) return null;
  for (const entry of settings.packages) {
    const source = typeof entry === 'string' ? entry : (entry as { source?: unknown } | null)?.source;
    if (typeof source !== 'string') continue;
    const trimmed = source.trim().replace(/[/\\]+$/, '');
    if (trimmed.includes(PACKAGE_NAME) || /(^|[/\\])tersio(\.git)?$/i.test(trimmed)) return source.trim();
  }
  return null;
}

const HOSTS: Array<Omit<HostEntry, 'installed' | 'via' | 'declared' | 'version' | 'dir'>> = [
  { id: 'omp', label: 'Oh My Pi', bin: 'omp', installCmd: `omp plugin install ${PACKAGE_NAME}`, removeCmd: `omp plugin remove ${PACKAGE_NAME}` },
  { id: 'pi', label: 'Pi', bin: 'pi', installCmd: `pi install npm:${PACKAGE_NAME}`, removeCmd: `pi remove npm:${PACKAGE_NAME}` },
  { id: 'opencode', label: 'OpenCode', bin: 'opencode', installCmd: `tersio install --host opencode`, removeCmd: `tersio uninstall --host opencode` },
  { id: 'pig', label: 'Pi-in-go', bin: 'pig', installCmd: `pig install npm:${PACKAGE_NAME}`, removeCmd: `pig remove npm:${PACKAGE_NAME}` },
];

function detect(agentDir = piAgentDir(), pigDir = pigAgentDir()): HostEntry[] {
  return HOSTS.map((host) => {
    const pkgDir = host.id === 'omp'
      ? ompPackageDir()
      : host.id === 'pi'
        ? piPackageDir(agentDir)
        : host.id === 'pig'
          ? pigPackageDir(pigDir)
          : null;
    const currentAgentDir = host.id === 'pig' ? pigDir : agentDir;
    const tree = hostExtensionsDir(host.id, currentAgentDir);
    // A tree wins: the installer writes it and it carries no package.json, so its version is ours. OpenCode keeps no package to fall back to, so a present tree is the install and drift gets the per-host warning.
    const via = missingTreeFiles(host.id, currentAgentDir).length === 0 || (host.id === 'opencode' && existsSync(tree))
      ? 'tree'
      : pkgDir && existsSync(pkgDir) ? 'package' : null;
    return {
      ...host,
      installed: via !== null,
      via,
      declared: host.id === 'omp'
        ? (pkgDir && existsSync(pkgDir) ? `plugin ${PACKAGE_NAME}` : null)
        : host.id === 'pi'
          ? piTersioSource(agentDir)
          : host.id === 'pig'
            ? pigTersioSource(pigDir)
            : existsSync(tree) ? 'plugin tree' : null,
      version: via === 'tree' ? PACKAGE_VERSION : via === 'package' && pkgDir ? packageVersion(pkgDir) : null,
      dir: via === 'tree' ? tree : via === 'package' ? pkgDir : null,
    };
  });
}

/** Menu label with current state in brackets, so a rerun shows what it replaces. */
export function hostLabel(host: HostEntry): string {
  if (host.installed && host.version) return `${host.label} (installed ${host.version})`;
  if (host.installed) return `${host.label} (installed)`;
  if (host.declared) return `${host.label} (package declared, not on disk)`;
  return `${host.label} (not installed)`;
}

// Hints render inline, so menus name the install and doctor keeps the path.
export function hostHint(host: HostEntry): string {
  if (host.installed && host.via) return host.via === 'tree' ? 'extension tree' : 'plugin package';
  return host.installCmd;
}

/** The rows a host menu draws: the agent, its state, and what a run would touch. */
export function hostOptions(hosts: HostEntry[]): Array<{ value: string; label: string; hint?: string }> {
  return hosts.map((host) => ({ value: host.id, label: hostLabel(host), hint: hostHint(host) }));
}

// `--host omp|pi|opencode|pig` from raw argv, undefined when absent; throws on an unknown value so the caller exits(1).
export function parseHostArg(argv: string[]): HostId | undefined {
  const i = argv.indexOf('--host');
  const raw = (i === -1 ? undefined : argv[i + 1]) ?? argv.find((a) => a.startsWith('--host='))?.slice('--host='.length);
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value !== 'omp' && value !== 'pi' && value !== 'opencode' && value !== 'pig') throw new Error(`Invalid --host: ${raw}. Valid: omp, pi, opencode, pig`);
  return value;
}

export { HOME, detect as detectHosts };
