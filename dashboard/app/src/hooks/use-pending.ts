import { useEffect, useState } from "react";

/**
 * True once `pending` has lasted past `delay`. A local read usually answers in a few milliseconds,
 * and a skeleton that appears for one frame reads as a flicker, not as progress.
 */
export function usePending(pending: boolean, delay = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!pending) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delay);
    return () => window.clearTimeout(timer);
  }, [pending, delay]);
  return shown;
}

/**
 * True once `pending` has held past `ms`. A read that hangs (a huge aggregate still crunching on the
 * server) should not hold a skeleton up forever: after the cap the UI degrades to its real controls.
 */
export function useStuckPending(pending: boolean, ms = 6000): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!pending) {
      setStuck(false);
      return;
    }
    const timer = window.setTimeout(() => setStuck(true), ms);
    return () => window.clearTimeout(timer);
  }, [pending, ms]);
  return stuck;
}
