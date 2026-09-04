import { z } from 'zod';
import { Tenant } from './tenant.js';

/** The session bearer's identity as the product sees it. Service users never appear here. */
export const SessionUser = z.object({
  userId: z.string(),
  orgId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  isAdmin: z.boolean(),
  isSuperAdmin: z.boolean(),
  kind: z.literal('human'),
});
export type SessionUser = z.infer<typeof SessionUser>;

export const SessionResponse = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
  user: SessionUser,
  tenant: Tenant,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

export const MeResponse = z.object({ user: SessionUser, tenant: Tenant });
export type MeResponse = z.infer<typeof MeResponse>;
