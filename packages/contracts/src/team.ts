import { z } from 'zod';

export const ROLE_SLUGS = ['admin', 'member'] as const;
export const RoleSlug = z.enum(ROLE_SLUGS);
export type RoleSlug = z.infer<typeof RoleSlug>;

export const TeamMember = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  isAdmin: z.boolean(),
  powerDialerEnabled: z.boolean(),
  /** True once the user has signed in to the product (WorkOS id linked). */
  signedIn: z.boolean(),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamResponse = z.object({ members: z.array(TeamMember) });
export type TeamResponse = z.infer<typeof TeamResponse>;

export const InviteRequest = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: RoleSlug.default('member'),
});
export type InviteRequest = z.infer<typeof InviteRequest>;

export const Invite = z.object({
  id: z.string(),
  email: z.string(),
  role: RoleSlug.nullable(),
  state: z.enum(['pending', 'accepted', 'expired', 'revoked']),
  expiresAt: z.string(),
});
export type Invite = z.infer<typeof Invite>;

export const InvitesResponse = z.object({ invites: z.array(Invite) });
export type InvitesResponse = z.infer<typeof InvitesResponse>;

export const UpdateTeamMemberRequest = z.object({ isAdmin: z.boolean() });
export type UpdateTeamMemberRequest = z.infer<typeof UpdateTeamMemberRequest>;
