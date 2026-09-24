import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { users } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(here, '../migrations/0043_hold_music_choice.sql'), 'utf8');

describe('0043_hold_music_choice', () => {
  it('adds the choice (default Classical) and the YouTube ids, idempotently', () => {
    expect(sql).toContain("ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_hold_music_choice text NOT NULL DEFAULT 'classical';");
    expect(sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_list_id text;');
    expect(sql).toContain('ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_video_id text;');
  });
  it('carries "hold music off" over, and only that', () => {
    expect(sql).toContain("UPDATE users SET dialer_hold_music_choice = 'off' WHERE dialer_hold_music = false AND dialer_hold_music_choice = 'classical';");
  });
  it('refuses any value that is not one of the eight choices', () => {
    expect(sql).toContain("CHECK (dialer_hold_music_choice IN ('off','classical','ambient','electronica','guitars','rock','softrock','youtube'))");
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'users_dialer_hold_music_choice_check'\)/);
  });
  it('the Drizzle schema matches', () => {
    const c = getTableColumns(users);
    expect(c.dialerHoldMusicChoice.name).toBe('dialer_hold_music_choice');
    expect(c.dialerHoldMusicChoice.notNull).toBe(true);
    expect(c.dialerHoldMusicChoice.default).toBe('classical');
    for (const col of [c.dialerYoutubeListId, c.dialerYoutubeVideoId]) { expect(col.notNull).toBe(false); expect(col.hasDefault).toBe(false); }
    expect(c.dialerYoutubeListId.name).toBe('dialer_youtube_list_id');
    expect(c.dialerYoutubeVideoId.name).toBe('dialer_youtube_video_id');
  });
});
