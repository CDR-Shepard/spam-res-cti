import { sfFetch } from './client.js';

export function parseChatterMeId(json: unknown): string | null {
  if (json && typeof json === 'object' && typeof (json as { id?: unknown }).id === 'string') {
    return (json as { id: string }).id;
  }
  return null;
}

/** The rep's Salesforce User Id (005…). */
export async function salesforceUserId(userId: string): Promise<string> {
  const res = await sfFetch(userId, '/chatter/users/me');
  const id = res.status < 400 ? parseChatterMeId(res.json) : null;
  if (!id) throw new Error(`could not resolve Salesforce user id (status ${res.status})`);
  return id;
}
