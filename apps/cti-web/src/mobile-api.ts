import { api } from './api';

/** POST /mobile/pair/start response — a fresh, still-live pairing code. */
export interface PairStartResponse {
  code: string;
  expiresAt: string;
}

export interface PairedDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

/** Mint a 6-digit pairing code for this rep (softphone session auth). The
 *  rep reads it off screen and types it into the companion iPhone app. */
export async function startPairing(): Promise<PairStartResponse> {
  return api('/mobile/pair/start', { method: 'POST' });
}

/** The rep's own paired devices. */
export async function listPairedDevices(): Promise<{ devices: PairedDevice[] }> {
  return api('/mobile/devices', { method: 'GET' });
}

/** Revoke one of the rep's own paired devices. */
export async function revokeDevice(id: string): Promise<{ ok: boolean }> {
  return api(`/mobile/devices/${id}`, { method: 'DELETE' });
}
