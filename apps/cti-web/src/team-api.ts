import { api } from './api';

export interface TeamUser {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  powerDialerEnabled: boolean;
  /** When an admin last asked to reset this user's softphone (ISO), or null. */
  ctiResetRequestedAt: string | null;
  /** When a softphone tab last finished a reset (ISO), or null. */
  ctiResetCompletedAt: string | null;
}

/** Admin-only: the org's users with their capability flags. */
export async function listTeam(): Promise<{ users: TeamUser[] }> {
  return api('/admin/team', { method: 'GET' });
}

/** Admin-only: grant/revoke power dialing for one user. */
export async function setPowerDialer(
  userId: string,
  powerDialerEnabled: boolean,
): Promise<{ user: { id: string; powerDialerEnabled: boolean } }> {
  return api(`/admin/team/${userId}`, { method: 'PATCH', body: { powerDialerEnabled } });
}

/** Admin-only: reset one user's web softphone (it happens when they are next idle). */
export async function resetCti(
  userId: string,
): Promise<{ user: { id: string; ctiResetRequestedAt: string | null; ctiResetCompletedAt: string | null } }> {
  return api(`/admin/team/${encodeURIComponent(userId)}/reset-cti`, { method: 'POST' });
}

/** Admin-only: reset every human user in the org except the admin asking. */
export async function resetCtiEveryone(): Promise<{ count: number }> {
  return api('/admin/team/reset-cti', { method: 'POST' });
}
