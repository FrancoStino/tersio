// Copies the rule bodies into dist, where the hosts load them. Node rather than cp, so `bun run build` runs under cmd.exe too.
import { copyFileSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCE_DIRS = ['caveman', 'pstack'];

for (const name of SOURCE_DIRS) {
  const from = join(root, 'extensions', name);
  const to = join(root, 'dist', 'extensions', name);
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      cpSync(join(from, entry.name), join(to, entry.name), { recursive: true });
    } else if (entry.name.endsWith('.md')) {
      copyFileSync(join(from, entry.name), join(to, entry.name));
    }
  }
}
