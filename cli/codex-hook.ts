// Codex lifecycle hooks print mode context, which Codex adds as developer context.
import { codexModeContext } from '../extensions/shared/codex-plugin.ts';

export function runCodexHook(event: string): void {
  if (event !== 'session-start' && event !== 'user-prompt-submit') {
    console.error(`[fail] Unknown Codex hook event: ${event}`);
    process.exitCode = 1;
    return;
  }
  const context = codexModeContext();
  if (context) process.stdout.write(`${context}\n`);
}
