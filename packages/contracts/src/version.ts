import { z } from 'zod';

/** What a build shows when the platform did not say which commit it is (local runs, a build without the arg). */
export const DEV_COMMIT = 'dev';

const SHORT_COMMIT_LENGTH = 7;
/** A git sha as the platform injects it: 7 to 40 hex characters. Anything else is never shown. */
const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * The 7-character commit for a platform-injected sha (Railway's RAILWAY_GIT_COMMIT_SHA, or the value baked into the web
 * build). Missing, empty or not a sha → 'dev', so a stray value is never echoed into a response or the UI.
 */
export function shortCommit(value: string | null | undefined): string {
  const sha = value?.trim() ?? '';
  return COMMIT_SHA.test(sha) ? sha.slice(0, SHORT_COMMIT_LENGTH).toLowerCase() : DEV_COMMIT;
}

/**
 * GET /api/version: which commit the live app is on (outreach-web and outreach-api share one build) and when this
 * outreach-api process started, plus the commit @cti/api (the AI voice server) runs. `calls` is null when it could not be reached.
 */
export const AppVersion = z.object({
  app: z.object({ commit: z.string(), startedAt: z.string().datetime() }),
  calls: z.object({ commit: z.string() }).nullable(),
});
export type AppVersion = z.infer<typeof AppVersion>;

/** The part of cti-api's /healthz that outreach-api reads: its short commit. */
export const CtiBuildHealth = z.object({ commit: z.string() });
export type CtiBuildHealth = z.infer<typeof CtiBuildHealth>;
