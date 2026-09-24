import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOLD_MUSIC, HOLD_MUSIC_CHOICES, HOLD_MUSIC_LABELS, isHoldMusicChoice, parseYouTubeLink,
  toHoldMusicChoice, YOUTUBE_LINK_ERROR, youtubeLinkFor,
} from './hold-music.js';

const V = 'dQw4w9WgXcQ';
const L = 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';
// Off-by-one lengths for the id regexes: video must be exactly 11, list 10-64.
const V10 = 'dQw4w9WgXc';
const V12 = 'dQw4w9WgXcQQ';
const L9 = 'A'.repeat(9);
const L65 = 'A'.repeat(65);

describe('hold-music choices', () => {
  it('eight choices in picker order, with labels, default Classical', () => {
    expect(HOLD_MUSIC_CHOICES).toEqual(['off', 'classical', 'ambient', 'electronica', 'guitars', 'rock', 'softrock', 'youtube']);
    expect(HOLD_MUSIC_LABELS.softrock).toBe('Soft rock');
    expect(HOLD_MUSIC_LABELS.youtube).toBe('YouTube');
    expect(DEFAULT_HOLD_MUSIC).toBe('classical');
  });
  it('toHoldMusicChoice: valid passes, anything else is Classical (never keep a rep out of their music)', () => {
    expect(toHoldMusicChoice('rock')).toBe('rock');
    for (const bad of ['jazz', '', null, undefined, 3, 'Rock']) expect(toHoldMusicChoice(bad)).toBe('classical');
    expect(isHoldMusicChoice('softrock')).toBe(true);
    expect(isHoldMusicChoice('soft rock')).toBe(false);
  });
  it('the error sentence is exact', () => { expect(YOUTUBE_LINK_ERROR).toBe("That doesn't look like a YouTube link."); });
});

describe('parseYouTubeLink', () => {
  it.each([
    [`https://www.youtube.com/playlist?list=${L}`, { listId: L, videoId: null }],
    [`https://youtube.com/watch?v=${V}`, { listId: null, videoId: V }],
    [`https://www.youtube.com/watch?v=${V}&list=${L}&index=3`, { listId: L, videoId: V }],
    [`https://youtu.be/${V}`, { listId: null, videoId: V }],
    [`https://youtu.be/${V}?list=${L}`, { listId: L, videoId: V }],
    [`https://m.youtube.com/watch?v=${V}`, { listId: null, videoId: V }],
    [`https://music.youtube.com/playlist?list=${L}`, { listId: L, videoId: null }],
    [`youtube.com/playlist?list=${L}`, { listId: L, videoId: null }],
    [`  https://www.youtube.com/watch?v=${V}  `, { listId: null, videoId: V }],
  ])('accepts %s', (input, expected) => { expect(parseYouTubeLink(input)).toEqual(expected); });

  it.each([
    '', 'not a link', 'https://vimeo.com/123', `https://youtube.com.evil.com/watch?v=${V}`,
    `javascript:alert(1)//youtube.com/watch?v=${V}`, 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/playlist?list=bad!chars', 'https://www.youtube.com/playlist',
    `ftp://youtube.com/watch?v=${V}`, 'https://www.youtube.com/',
    // Video id must be exactly 11 chars — 10 and 12 are both invalid, not "close enough".
    `https://www.youtube.com/watch?v=${V10}`, `https://www.youtube.com/watch?v=${V12}`,
    `https://youtu.be/${V10}`, `https://youtu.be/${V12}`,
    // Playlist id must be 10-64 chars — 9 and 65 are both invalid.
    `https://www.youtube.com/playlist?list=${L9}`, `https://www.youtube.com/playlist?list=${L65}`,
  ])('rejects %s', (input) => { expect(parseYouTubeLink(input)).toBeNull(); });
});

describe('youtubeLinkFor — the canonical link for a stored ref (Settings prefill)', () => {
  it('playlist, video, video-in-playlist, nothing', () => {
    expect(youtubeLinkFor({ listId: L, videoId: null })).toBe(`https://www.youtube.com/playlist?list=${L}`);
    expect(youtubeLinkFor({ listId: null, videoId: V })).toBe(`https://www.youtube.com/watch?v=${V}`);
    expect(youtubeLinkFor({ listId: L, videoId: V })).toBe(`https://www.youtube.com/watch?v=${V}&list=${L}`);
    expect(youtubeLinkFor({ listId: null, videoId: null })).toBeNull();
  });
  it('round-trips through parseYouTubeLink', () => {
    for (const ref of [{ listId: L, videoId: null }, { listId: null, videoId: V }, { listId: L, videoId: V }]) {
      expect(parseYouTubeLink(youtubeLinkFor(ref)!)).toEqual(ref);
    }
  });
});
