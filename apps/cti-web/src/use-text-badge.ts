/**
 * The count on the Texts tab: texts that arrived after the newest one the rep
 * has seen. Asks the API (a database read, no Salesforce) right away and every
 * TEXTS_BADGE_POLL_MS while active, and again the moment another tab marks
 * texts seen. A hidden page (a background Salesforce tab) skips the timed
 * check and catches up when shown: a rep's every Salesforce tab runs the
 * softphone, and an office shares one IP against the API's rate limit.
 * Inactive — the rep is on the Texts tab — it shows nothing.
 */
import { useEffect, useState } from 'react';
import { fetchNewTextCount, readTextsSeenAt, textsSeenKey } from './texts';

export const TEXTS_BADGE_POLL_MS = 60_000;

export interface UseTextBadgeOptions {
  userId: string;
  /** False while the rep is looking at the Texts tab. */
  active: boolean;
}

export function useTextBadge({ userId, active }: UseTextBadgeOptions): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!active) {
      setCount(0);
      return;
    }
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const n = await fetchNewTextCount(readTextsSeenAt(userId));
        if (!cancelled) setCount(n);
      } catch {
        // Offline or signed out: keep the last count and try again next tick.
      }
    };
    const onStorage = (e: StorageEvent): void => {
      if (e.key === textsSeenKey(userId)) void check();
    };
    const onVisibility = (): void => {
      if (!document.hidden) void check();
    };
    void check();
    const id = window.setInterval(() => { if (!document.hidden) void check(); }, TEXTS_BADGE_POLL_MS);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [userId, active]);

  return active ? count : 0;
}
