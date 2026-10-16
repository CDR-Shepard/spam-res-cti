import { useBlocker } from '@tanstack/react-router';
import { useEffect } from 'react';

export const LEAVE_WORDS = 'A test call is live — leave and hang up?';

/**
 * Mounted only while a browser test call is up (plan 1E): leaving the page hangs it up, so the top bar and Back ask first
 * (OK leaves, and the page going away ends the call), and so do a reload and closing the tab (browsers show their own words
 * for those). Another page that must not be left by accident (the agent prompt editor's unsaved edits) mounts it with its
 * own `words`.
 */
export function LeaveGuard({ words = LEAVE_WORDS }: { words?: string }): null {
  useBlocker({ shouldBlockFn: () => !window.confirm(words), enableBeforeUnload: false });
  useEffect(() => {
    const ask = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = words; // Older browsers ask only when this is set.
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [words]);
  return null;
}
