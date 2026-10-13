import { shortCommit } from '@cti/contracts';

/** Which commit this process was deployed from, and when it started. Both are safe to show: no secrets. */
export interface BuildInfo {
  commit: string;
  startedAt: string;
}

/** When this process started, taken once at load from the process clock. */
const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** Railway injects RAILWAY_GIT_COMMIT_SHA into every GitHub-sourced deploy; without it (local runs) the commit is 'dev'. */
export function currentBuild(env: { RAILWAY_GIT_COMMIT_SHA?: string } = process.env): BuildInfo {
  return { commit: shortCommit(env.RAILWAY_GIT_COMMIT_SHA), startedAt: STARTED_AT };
}
