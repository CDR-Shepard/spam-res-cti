/**
 * Route-level tests for GET/PATCH /auth/me — the rep's own settings. The
 * PATCH is a partial update: a hold-music-only body must never touch the
 * no-answer forwarding number (and vice versa), because wiping the failover
 * number silently stops inbound callbacks rolling to the rep's cell.
 * Harness idiom: routes/admin-team.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { YOUTUBE_LINK_ERROR } from '@cti/contracts';

const state = vi.hoisted(() => ({
  authedUser: null as {
    userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean;
  } | null,
  userRow: null as {
    noAnswerForwardE164: string | null;
    dialerHoldMusic: boolean;
    dialerHoldMusicChoice: string;
    dialerYoutubeListId: string | null;
    dialerYoutubeVideoId: string | null;
  } | null,
  lastUpdateSet: null as unknown,
}));

vi.mock('../config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../salesforce/oauth.js', () => ({
  buildStartArtifacts: () => { throw new Error('unused in this test'); },
  exchangeCodeForTokens: async () => { throw new Error('unused in this test'); },
  fetchProfileName: async () => null,
  fetchProfilePhoto: async () => null,
  fetchUserInfo: async () => null,
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.authedUser,
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      query: {
        users: { findFirst: async () => state.userRow },
        salesforceConnections: { findFirst: async () => null },
        outboundNumbers: { findFirst: async () => null },
      },
      update: (_table: unknown) => ({
        set: (values: unknown) => {
          state.lastUpdateSet = values;
          return { where: async (_w: unknown) => undefined };
        },
      }),
    }),
  };
});

import { registerAuthRoutes } from './auth.js';

const rep = { userId: 'u1', orgId: 'o1', email: 'rep@x.com', isAdmin: false, powerDialerEnabled: true };

let app: FastifyInstance;
beforeEach(async () => {
  state.authedUser = rep;
  state.userRow = {
    noAnswerForwardE164: '+16195550100',
    dialerHoldMusic: true,
    dialerHoldMusicChoice: 'classical',
    dialerYoutubeListId: null,
    dialerYoutubeVideoId: null,
  };
  state.lastUpdateSet = null;
  app = Fastify();
  await registerAuthRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: '/auth/me', payload: payload as Record<string, unknown> });

describe('PATCH /auth/me — partial updates', () => {
  it('a hold-music-only body writes the legacy mapping and nothing else (the forwarding number survives)', async () => {
    const res = await patch({ dialerHoldMusic: false });
    expect(res.statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusic: false, dialerHoldMusicChoice: 'off' });
    expect(res.json()).toEqual({ ok: true, dialerHoldMusic: false, dialerHoldMusicChoice: 'off' });
  });

  it('a forwarding-only body writes the normalized number and nothing else (hold music survives)', async () => {
    const res = await patch({ noAnswerForwardE164: '619-555-0100' });
    expect(res.statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ noAnswerForwardE164: '+16195550100' });
  });

  it('clearing the forwarding number writes null for it only', async () => {
    expect((await patch({ noAnswerForwardE164: null })).statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ noAnswerForwardE164: null });
  });

  it('both fields at once are written together', async () => {
    expect((await patch({ noAnswerForwardE164: null, dialerHoldMusic: true })).statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ noAnswerForwardE164: null, dialerHoldMusic: true });
  });

  it('an empty body is 400 and writes nothing', async () => {
    expect((await patch({})).statusCode).toBe(400);
    expect(state.lastUpdateSet).toBeNull();
  });

  it('401 without a session, and nothing is written', async () => {
    state.authedUser = null;
    expect((await patch({ dialerHoldMusic: false })).statusCode).toBe(401);
    expect(state.lastUpdateSet).toBeNull();
  });
});

describe('PATCH /auth/me — hold-music choices', () => {
  it('PATCH a preset writes the choice and keeps the legacy column in step — nothing else', async () => {
    const res = await patch({ holdMusic: { choice: 'ambient' } });
    expect(res.statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusicChoice: 'ambient', dialerHoldMusic: true });
  });

  it('PATCH Off → legacy false', async () => {
    await patch({ holdMusic: { choice: 'off' } });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusicChoice: 'off', dialerHoldMusic: false });
  });

  it('PATCH YouTube with a valid link stores the ids, never the link', async () => {
    await patch({
      holdMusic: {
        choice: 'youtube',
        youtubeLink: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
      },
    });
    expect(state.lastUpdateSet).toEqual({
      dialerHoldMusicChoice: 'youtube',
      dialerHoldMusic: true,
      dialerYoutubeListId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
      dialerYoutubeVideoId: 'dQw4w9WgXcQ',
    });
  });

  it('PATCH YouTube with a bad link → 400 with the exact sentence, nothing written', async () => {
    const res = await patch({ holdMusic: { choice: 'youtube', youtubeLink: 'https://vimeo.com/1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: YOUTUBE_LINK_ERROR });
    expect(state.lastUpdateSet).toBeNull();
  });

  it('PATCH YouTube with no link: allowed when ids are already stored (switching back), refused when not', async () => {
    state.userRow = { ...state.userRow!, dialerYoutubeListId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf' };
    expect((await patch({ holdMusic: { choice: 'youtube' } })).statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusicChoice: 'youtube', dialerHoldMusic: true });

    state.lastUpdateSet = null;
    state.userRow = { ...state.userRow!, dialerYoutubeListId: null, dialerYoutubeVideoId: null };
    expect((await patch({ holdMusic: { choice: 'youtube' } })).statusCode).toBe(400);
    expect(state.lastUpdateSet).toBeNull();
  });

  it('a preset or Off leaves the stored YouTube ids alone', async () => {
    await patch({ holdMusic: { choice: 'rock' } });
    expect(state.lastUpdateSet).not.toHaveProperty('dialerYoutubeListId');
  });

  it('legacy tab: dialerHoldMusic false → Off', async () => {
    await patch({ dialerHoldMusic: false });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusic: false, dialerHoldMusicChoice: 'off' });
  });

  it('legacy tab: dialerHoldMusic true brings Off back to Classical, and never overwrites a chosen preset or YouTube', async () => {
    state.userRow = { ...state.userRow!, dialerHoldMusicChoice: 'off' };
    await patch({ dialerHoldMusic: true });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusic: true, dialerHoldMusicChoice: 'classical' });

    state.userRow = { ...state.userRow!, dialerHoldMusicChoice: 'ambient' };
    await patch({ dialerHoldMusic: true });
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusic: true });
  });
});

describe('GET /auth/me', () => {
  it('returns the hold-music preference, and defaults it to on when the profile row is missing', async () => {
    state.userRow = { ...state.userRow!, noAnswerForwardE164: null, dialerHoldMusic: false, dialerHoldMusicChoice: 'off' };
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).json().user.dialerHoldMusic).toBe(false);
    state.userRow = null;
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).json().user.dialerHoldMusic).toBe(true);
  });

  it('GET returns the choice and the stored YouTube ids, plus the legacy boolean', async () => {
    state.userRow = {
      ...state.userRow!,
      dialerHoldMusicChoice: 'youtube',
      dialerYoutubeListId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
      dialerYoutubeVideoId: null,
    };
    const me = (await app.inject({ method: 'GET', url: '/auth/me' })).json();
    expect(me.user.holdMusic).toEqual({
      choice: 'youtube',
      youtube: { listId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf', videoId: null },
    });
    expect(me.user.dialerHoldMusic).toBe(true);
  });

  it('GET: Off → legacy false; no ids → youtube null; an unknown stored value reads as Classical', async () => {
    state.userRow = { ...state.userRow!, dialerHoldMusicChoice: 'off' };
    let me = (await app.inject({ method: 'GET', url: '/auth/me' })).json();
    expect(me.user.holdMusic).toEqual({ choice: 'off', youtube: null });
    expect(me.user.dialerHoldMusic).toBe(false);

    state.userRow = {
      ...state.userRow!,
      dialerHoldMusicChoice: 'classical',
      dialerYoutubeListId: null,
      dialerYoutubeVideoId: null,
    };
    me = (await app.inject({ method: 'GET', url: '/auth/me' })).json();
    expect(me.user.holdMusic).toEqual({ choice: 'classical', youtube: null });
    expect(me.user.dialerHoldMusic).toBe(true);

    state.userRow = { ...state.userRow!, dialerHoldMusicChoice: 'some-retired-value' };
    me = (await app.inject({ method: 'GET', url: '/auth/me' })).json();
    expect(me.user.holdMusic).toEqual({ choice: 'classical', youtube: null });
    expect(me.user.dialerHoldMusic).toBe(true);
  });
});
