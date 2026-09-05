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

/**
 * Paths outreach-api owns (mirrors its routes/spa.ts `isApiPath`): the SPA
 * cannot render them, so `returnTo=/api/auth/logout` would end a successful
 * sign-in on a JSON 404. Matched by path segment — `/api-docs` is still an app path.
 */
const RESERVED_PATH_PREFIXES = ['/api', '/healthz', '/readyz'] as const;

function isReservedPath(value: string): boolean {
  const path = value.split(/[?#]/, 1)[0] ?? value;
  return RESERVED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Syntactically same-origin (`SAFE_RETURN_TO`) and not an API-owned path. */
export function isSafeReturnTo(value: string): boolean {
  return SAFE_RETURN_TO.test(value) && !isReservedPath(value);
}
