import { api } from './api';

export interface TeamUser {
  id: string;
  email: string;
  displayName: string | null;
  isAdmin: boolean;
  powerDialerEnabled: boolean;
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
