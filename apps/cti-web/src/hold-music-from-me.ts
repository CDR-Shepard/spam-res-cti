import type { HoldMusicSetting } from '@cti/contracts';

/** The subset of `/auth/me`'s `user` that `holdMusicFromMe` needs — kept
 *  narrow so this module (and its test) never has to import the rest of
 *  `App.tsx`'s heavier `MeResponse` shape. */
export interface HoldMusicUser {
  holdMusic?: HoldMusicSetting;
  /** Legacy on/off flag — still read while an older API/session may still send it. */
  dialerHoldMusic?: boolean;
}

/** The hold-music setting to render, from `/auth/me`'s `user` — the new
 *  `holdMusic` object when the API sends it, else derived from the legacy
 *  on/off `dialerHoldMusic` flag so an older API (or a stale cached session)
 *  still shows something sensible. Shared by SettingsPanel and (Task 8)
 *  DialerPanel via App.tsx. */
export function holdMusicFromMe(user: HoldMusicUser): HoldMusicSetting {
  return user.holdMusic ?? { choice: user.dialerHoldMusic === false ? 'off' : 'classical', youtube: null };
}
