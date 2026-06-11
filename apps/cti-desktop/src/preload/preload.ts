import { contextBridge, ipcRenderer } from 'electron';

const cti = {
  apiRequest: (path: string, init?: unknown) => ipcRenderer.invoke('cti:apiRequest', { path, init }),
  openExternal: (url: string) => ipcRenderer.invoke('cti:openExternal', url),
  getSession: () => ipcRenderer.invoke('cti:getSession'),
  saveSession: (token: string, userId: string, email: string) =>
    ipcRenderer.invoke('cti:saveSession', { token, userId, email }),
  clearSession: () => ipcRenderer.invoke('cti:clearSession'),
  appVersion: () => ipcRenderer.invoke('cti:appVersion'),
  hideWindow: () => ipcRenderer.invoke('cti:hideWindow'),
  quit: () => ipcRenderer.invoke('cti:quit'),

  /** Subscribe to inbound tel: URLs. Returns an unsubscribe fn. */
  onTelUrl: (cb: (number: string) => void): (() => void) => {
    const handler = (_evt: unknown, num: unknown): void => {
      if (typeof num === 'string' && num.length > 0) cb(num);
    };
    ipcRenderer.on('cti:telUrl', handler);
    return () => ipcRenderer.removeListener('cti:telUrl', handler);
  },
  /** Pulls any tel: URL that arrived before we were subscribed. */
  consumePendingTel: (): Promise<string | null> => ipcRenderer.invoke('cti:consumePendingTel'),
};

contextBridge.exposeInMainWorld('cti', cti);
