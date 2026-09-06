import { z } from 'zod';

/** Every non-2xx body from outreach-api. `code` is stable for clients; `error` is for humans. */
export const ApiError = z.object({
  error: z.string(),
  code: z.string(),
  requestId: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiError>;
