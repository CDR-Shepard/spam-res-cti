/**
 * Same-origin relative path only: one leading slash (never "//" or "/\" -- both
 * are browser host-confusion tricks), and no backslash, space, or ASCII
 * control character anywhere else in the path (blocks further host-confusion
 * and header/URL-injection tricks in the eventual redirect target).
 *
 * Shared by outreach-api's OAuth `state` validation and outreach-web's route
 * `validateSearch`, so both enforce exactly the same rule.
 */
export const SAFE_RETURN_TO = /^\/(?![\/\\])[^\\\x00-\x20]*$/;

export function isSafeReturnTo(value: string): boolean {
  return SAFE_RETURN_TO.test(value);
}
