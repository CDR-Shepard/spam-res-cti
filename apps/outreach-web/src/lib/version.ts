import { DEV_COMMIT, shortCommit } from '@cti/contracts';

/**
 * The commit this tab's bundle was built from: the Docker build hands Railway's commit sha to Vite as VITE_APP_COMMIT.
 * 'dev' when the build had none (local runs, a build without the arg). Read where it is used, not at import time.
 */
export function bakedCommit(): string {
  return shortCommit(import.meta.env.VITE_APP_COMMIT);
}

/**
 * This open tab is older than the live app: both commits are known and they differ. While either is unknown ('dev')
 * nothing can be said to be older, so no refresh is asked for.
 */
export function isStaleBuild(baked: string, live: string): boolean {
  return baked !== DEV_COMMIT && live !== DEV_COMMIT && baked !== live;
}

/** "Oct 13, 2:41 PM" in the viewer's own zone. A plain space before AM/PM (newer ICU builds put a narrow no-break one). */
export function formatDeployed(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d
    .toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) })
    .replace(/[  ]/g, ' ');
}
