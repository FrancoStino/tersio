// Eligible command heads, taken from rtk's own contract rather than a hardcoded guess.
// `rtk rewrite <probe>` prints a rewrite and exits 0 or 3 when rtk handles the command,
// and exits 1 when no equivalent exists. Each probe below is a representative workload
// command, because subcommand-scoped tools such as `gh` rewrite `gh pr list` but not `gh`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRtkVersion, tersioDataPath } from './utils.ts';

/** Verified against rtk 1.0.1; the drift test fails when rtk's set moves. */
export const FALLBACK_ELIGIBLE_HEADS: readonly string[] = [
  'rtk', 'git', 'gh', 'glab', 'docker', 'kubectl', 'psql', 'aws', 'bunx', 'npx',
  'pytest', 'mypy', 'cat', 'grep', 'rg', 'find', 'tree', 'diff', 'ls', 'ast-grep',
  'wget', 'prettier', 'playwright', 'prisma', 'jest', 'vitest', 'ctest', 'lint',
  'wc', 'tsc', 'curl', 'cargo', 'npm', 'pnpm', 'bun', 'go', 'ruff', 'next',
  'dotnet', 'oc', 'jq', 'make',
];

const PROBES: Record<string, string> = {
  git: 'git log', gh: 'gh pr list', glab: 'glab mr list', docker: 'docker ps',
  kubectl: 'kubectl get pods', psql: 'psql --version', aws: 'aws --version',
  bunx: 'bunx --version', npx: 'npx --version', pytest: 'pytest --version',
  mypy: 'mypy --version', cat: 'cat README.md', grep: 'grep rtk README.md',
  rg: 'rg rtk README.md', find: 'find . -name x', tree: 'tree .', diff: 'diff a b',
  ls: 'ls -la', 'ast-grep': 'ast-grep --version', wget: 'wget --version',
  prettier: 'prettier --version', playwright: 'playwright --version', prisma: 'prisma --version',
  jest: 'jest --version', vitest: 'vitest --version', ctest: 'ctest --version',
  lint: 'lint .', wc: 'wc -l x', tsc: 'tsc --version', curl: 'curl --version',
  cargo: 'cargo test', npm: 'npm run build', pnpm: 'pnpm run build', bun: 'bun run test',
  go: 'go test ./...', ruff: 'ruff check .', next: 'next build', dotnet: 'dotnet build',
  oc: 'oc get pods', jq: 'jq . x', make: 'make',
};

function probe(bin: string, command: string): boolean {
  try {
    const out = execFileSync(bin, ['rewrite', command], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return out.trim().length > 0;
  } catch (e) {
    // Non-zero exit throws; exit 3 still prints a rewrite, exits 1 and 2 do not.
    const err = e as { status?: number; stdout?: string | Buffer };
    if (err.status !== 0 && err.status !== 3) return false;
    return String(err.stdout ?? '').trim().length > 0;
  }
}

/** One set of heads for this rtk build, read straight from its rewrite contract. */
export function deriveEligibleHeads(bin: string): Set<string> {
  const heads = new Set<string>(['rtk']);
  for (const [head, command] of Object.entries(PROBES)) {
    if (probe(bin, command)) heads.add(head);
  }
  return heads;
}

function rtkVersion(bin: string): string {
  try {
    return normalizeRtkVersion(execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true }));
  } catch {
    return '';
  }
}

/**
 * Heads rtk rewrites, cached per binary version so an upgrade re-derives once.
 * Without a binary, or on any read failure, the verified fallback stands.
 */
export function eligibleHeads(bin: string | null): ReadonlySet<string> {
  if (!bin) return new Set(FALLBACK_ELIGIBLE_HEADS);
  const version = rtkVersion(bin);
  const file = tersioDataPath('rtk-eligible.json', 'rtk-eligible.json');
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; heads?: unknown };
    if (cached.version === version && Array.isArray(cached.heads) && cached.heads.every((h) => typeof h === 'string')) {
      return new Set(cached.heads as string[]);
    }
  } catch { /* derive below */ }
  const heads = deriveEligibleHeads(bin);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version, heads: [...heads] })}\n`, 'utf8');
  } catch { /* the cache is best-effort */ }
  return heads;
}
