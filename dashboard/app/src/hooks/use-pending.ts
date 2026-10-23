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
