-- =============================================================================
-- 0043_hold_music_choice.sql — what a rep hears between Power Dial calls.
--
-- users.dialer_hold_music_choice   off | classical | ambient | electronica |
--                                  guitars | rock | softrock | youtube.
--                                  Classical is Twilio's default conference
--                                  music — what everyone heard until now — so
--                                  it is the default, and "hold music off"
--                                  carries over as 'off'.
-- users.dialer_youtube_list_id     the rep's YouTube playlist id (ids only —
-- users.dialer_youtube_video_id    a link is never stored).
-- dialer_hold_music (boolean) stays one release for softphone tabs that have
-- not reloaded; the API keeps it in step and a later migration drops it.
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_hold_music_choice text NOT NULL DEFAULT 'classical';
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_list_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_youtube_video_id text;

UPDATE users SET dialer_hold_music_choice = 'off' WHERE dialer_hold_music = false AND dialer_hold_music_choice = 'classical';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_dialer_hold_music_choice_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_dialer_hold_music_choice_check
      CHECK (dialer_hold_music_choice IN ('off','classical','ambient','electronica','guitars','rock','softrock','youtube'));
  END IF;
END $$;
