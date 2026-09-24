/**
 * Hold music during a Power Dial run — the one definition the API (which turns
 * a choice into the rep leg's conference waitUrl) and the softphone (Settings
 * picker, YouTube player) share. Six choices are Twilio's royalty-free sets and
 * play through the phone line; `youtube` plays in the rep's browser instead,
 * because YouTube's audio may not be separated from its own player.
 */
export const HOLD_MUSIC_CHOICES = ['off', 'classical', 'ambient', 'electronica', 'guitars', 'rock', 'softrock', 'youtube'] as const;
export type HoldMusicChoice = (typeof HOLD_MUSIC_CHOICES)[number];

export const HOLD_MUSIC_LABELS: Readonly<Record<HoldMusicChoice, string>> = {
  off: 'Off', classical: 'Classical', ambient: 'Ambient', electronica: 'Electronica',
  guitars: 'Guitars', rock: 'Rock', softrock: 'Soft rock', youtube: 'YouTube',
};

/** Twilio's own default conference music — what every rep heard before choices existed. */
export const DEFAULT_HOLD_MUSIC: HoldMusicChoice = 'classical';

export function isHoldMusicChoice(v: unknown): v is HoldMusicChoice {
  return typeof v === 'string' && (HOLD_MUSIC_CHOICES as readonly string[]).includes(v);
}

/** Anything unreadable is Classical: a bad value must never keep a rep out of their room. */
export function toHoldMusicChoice(v: unknown): HoldMusicChoice {
  return isHoldMusicChoice(v) ? v : DEFAULT_HOLD_MUSIC;
}

export interface YouTubeRef { listId: string | null; videoId: string | null }
export interface HoldMusicSetting { choice: HoldMusicChoice; youtube: YouTubeRef | null }

export const YOUTUBE_LINK_ERROR = "That doesn't look like a YouTube link.";

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);

/**
 * A YouTube playlist / video / video-in-playlist link → its ids, or null. Only
 * ids ever leave this function: the link itself is never stored or embedded.
 * A malformed id is a rejection, not something to drop silently.
 */
export function parseYouTubeLink(input: string): YouTubeRef | null {
  const raw = input.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  const rawVideo = host.endsWith('youtu.be')
    ? url.pathname.split('/')[1] ?? ''
    : url.pathname === '/watch' ? url.searchParams.get('v') ?? '' : '';
  const rawList = url.searchParams.get('list') ?? '';

  if (rawVideo && !VIDEO_ID.test(rawVideo)) return null;
  if (rawList && !LIST_ID.test(rawList)) return null;
  const videoId = rawVideo || null;
  const listId = rawList || null;
  return videoId || listId ? { listId, videoId } : null;
}

/** The canonical link for stored ids (Settings shows it back to the rep). */
export function youtubeLinkFor(ref: YouTubeRef): string | null {
  if (ref.videoId && ref.listId) return `https://www.youtube.com/watch?v=${ref.videoId}&list=${ref.listId}`;
  if (ref.videoId) return `https://www.youtube.com/watch?v=${ref.videoId}`;
  if (ref.listId) return `https://www.youtube.com/playlist?list=${ref.listId}`;
  return null;
}
