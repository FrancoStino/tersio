// Single list of install writes, shared by installer, doctor, and tests.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findPackageRoot, readTextIfExists } from '../extensions/shared/utils.ts';
import { writeIfChanged, WriteOptions } from './common.ts';

export const EXT_DIR = path.join(findPackageRoot(path.dirname(fileURLToPath(import.meta.url))), 'extensions');

/** Every file in the tree, as paths relative to the extensions directory. */
export const TREE_FILES: readonly string[] = [
  'shared/host.ts',
  'shared/session-state.ts',
  'shared/status.ts',
  'shared/types.ts',
  'shared/plugin-settings.ts',
  'shared/usage-ledger.ts',
  'shared/sqlite.ts',
  'shared/pricing.ts',
  'shared/carbon.ts',
  'shared/utils.ts',
  'caveman/index.ts',
  'caveman/rule.md',
  'caveman/rule-ultra.md',
  'caveman/rule-megacave.md',
  'pstack/index.ts',
  'pstack/rule.md',
  'rtk/session.ts',
  'rtk/filter.ts',
  'timing/index.ts',
  'combo/index.ts',
  'commands/index.ts',
  'updater/index.ts',
  'server.ts',
];

export function sourcePath(relative: string): string {
  return path.join(EXT_DIR, ...relative.split('/'));
}

/** The entries under one directory, as source paths and tree-relative targets. */
export function filesUnder(dir: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const file of TREE_FILES) {
    if (file.startsWith(`${dir}/`)) found.push([sourcePath(file), file]);
  }
  return found;
}

/** The entries at the extensions root, which `filesUnder` cannot name because it takes a directory. */
export function rootFiles(): Array<[string, string]> {
  return TREE_FILES.filter((file) => !file.includes('/')).map((file) => [sourcePath(file), file]);
}

/** The OpenCode plugin entry: imports `@opencode/plugin`, absent from omp and pi loaders, so it ships there alone. */
export const OPENCODE_ENTRY = 'server.ts';

/** pi's rtk entry manifest, generated rather than copied: no other host loads rtk that way. */
export const PI_RTK_MANIFEST = 'rtk/package.json';

/** pi's rtk entry manifest, generated rather than copied: no other host loads rtk that way. */
export const PI_RTK_MANIFEST_BODY = `${JSON.stringify({ pi: { extensions: ['./session.ts', './filter.ts'] } }, null, 2)}\n`;

/** Files the install generates, keyed by tree path, so one repair path handles copied and generated alike. */
export const GENERATED_TREE_FILES: Readonly<Record<string, string>> = {
  [PI_RTK_MANIFEST]: PI_RTK_MANIFEST_BODY,
};

/** The files one host's extension tree holds. The package tree holds all of them. */
export function treeFilesFor(id: 'omp' | 'pi' | 'opencode'): readonly string[] {
  if (id === 'opencode') return TREE_FILES;
  const files = TREE_FILES.filter((file) => file !== OPENCODE_ENTRY);
  return id === 'pi' ? [...files, PI_RTK_MANIFEST] : files;
}

/** Obsolete install debris; explicit, not a sweep, because these trees are shared with tersio's other steps. */
const OBSOLETE_DIRS = ['caveman-session', 'rtk-filter', 'rtk-session', 'combo-toggle', 'tersio-commands', 'ai-addons-updater', 'lib', 'opencode'] as const;

/** Debris test for a tree-relative path; one definition shared by detection and repair. */
export function isObsoleteTreeFile(rel: string, id: 'omp' | 'pi' | 'opencode'): boolean {
  if (rel.endsWith('.bak') || rel === '.DS_Store') return true;
  if (OBSOLETE_DIRS.includes(rel.split('/')[0] as (typeof OBSOLETE_DIRS)[number])) return true;
  return rel === 'server.ts' && id !== 'opencode';
}

/** A tree file's text: copied files come from the repo, generated ones from their own definition. */
export function treeFileText(file: string): string | null {
  const generated = GENERATED_TREE_FILES[file];
  if (generated !== undefined) return generated;
  try { return readFileSync(sourcePath(file), 'utf8'); } catch { return null; }
}

/** The ponytail ruleset this build ships, copied to every host that cannot install the package. */
export const PONYTAIL_SKILL_NAMES = ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'] as const;

/** The OpenCode bundle: no node_modules there, so the ruleset rides along as files. */
export const PONYTAIL_BUNDLE_FILES = [
  'hooks/ponytail-instructions.js',
  'hooks/ponytail-config.js',
  ...PONYTAIL_SKILL_NAMES.map((skill) => `skills/${skill}/SKILL.md`),
] as const;

/** pi's local package: the same ruleset, plus the extension that injects it. */
export const PI_PONYTAIL_FILES = ['pi-extension/index.js', ...PONYTAIL_BUNDLE_FILES] as const;

/** The shipped package manifest, one level above the extension tree. */
const MANIFEST_PATH = path.join(path.dirname(EXT_DIR), 'package.json');

/** The `omp` block a host reads for what to load: extensions, features, and the settings schema. */
export function shippedOmpManifest(): Record<string, unknown> | null {
  try {
    const pkg = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { omp?: unknown };
    return typeof pkg.omp === 'object' && pkg.omp !== null ? pkg.omp as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Write the shipped `omp` block over an installed plugin's manifest. The tree files come from this
 * build, so an entry added here reaches the host only when its manifest names it.
 */
export async function syncPluginManifest(pluginDir: string, options: WriteOptions = {}): Promise<void> {
  const omp = shippedOmpManifest();
  if (omp === null) return;
  const pkgPath = path.join(pluginDir, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  if (JSON.stringify(pkg.omp) === JSON.stringify(omp)) return;
  pkg.omp = omp;
  await writeIfChanged(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, options);
}

/** Copy bundled files into `dest`; misses are reported and skipped, `skip` keeps newer fetched rule bodies. */
export async function syncTreeFiles(
  dest: string,
  files: readonly string[],
  options: { dryRun?: boolean; verbose?: boolean },
  skip?: (file: string) => boolean,
): Promise<string[]> {
  const missing: string[] = [];
  for (const file of files) {
    if (skip?.(file)) continue;
    const generated = GENERATED_TREE_FILES[file];
    if (generated !== undefined) {
      await writeIfChanged(path.join(dest, ...file.split('/')), generated, options);
      continue;
    }
    const from = sourcePath(file);
    const text = await readTextIfExists(from);
    if (text === null) {
      missing.push(from);
      continue;
    }
    await writeIfChanged(path.join(dest, ...file.split('/')), text, options);
  }
  return missing;
}
