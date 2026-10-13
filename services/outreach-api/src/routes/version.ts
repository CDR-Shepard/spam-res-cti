/**
 * GET /api/version (any signed-in member): which commit the live app runs and when this outreach-api process started,
 * and which commit @cti/api (the AI voice server) runs. outreach-web shows both in the sidebar so the owner knows
 * whether a push has deployed. Commits and a start time only; `calls` is null when cti-api cannot be reached.
 */
import type { FastifyInstance } from 'fastify';
import type { AppVersion } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { BuildInfo } from '../build-info.js';
import { requireContext } from '../tenancy/scope.js';
import type { CtiCommit } from '../version/cti-version.js';

export interface VersionRouteDeps {
  db: Db;
  build: BuildInfo;
  /** The commit cti-api runs, or null; see version/cti-version.ts. */
  calls: () => Promise<CtiCommit | null>;
}

export async function registerVersionRoutes(app: FastifyInstance, deps: VersionRouteDeps): Promise<void> {
  const { db, build, calls } = deps;

  app.get('/version', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return reply;
    const cti = await calls().catch(() => null);
    return { app: { commit: build.commit, startedAt: build.startedAt }, calls: cti ? { commit: cti.commit } : null } satisfies AppVersion;
  });
}
