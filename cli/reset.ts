// Clears tersio-owned stats only; transcripts and RTK data stay on disk.
import { clearUsageLedger, markReset, readUsage } from '../extensions/shared/usage-ledger.ts';
import { clearUsageDb } from '../extensions/shared/usage-store.ts';
import { readRtkGain } from '../extensions/shared/rtk-gain.ts';

/** What a reset clears, cheap enough to answer a settings request with. */
function resetCounts(): { rows: number; rtk: number } {
  return { rows: readUsage().length, rtk: readRtkGain(1).commands };
}

/** Clear the ledger and hide what it summarised. Sessions, RTK history, and snapshots stay. */
function resetStatistics(): { rows: number; db: number; ts: number } {
  const rows = clearUsageLedger();
  const db = clearUsageDb();
  return { rows, db, ts: markReset() };
}

export { resetCounts, resetStatistics };
