/**
 * Electron main process — macOS menubar tray app.
 *
 * Hardened defaults: contextIsolation, no nodeIntegration, sandbox, CSP per
 * navigation, narrow IPC bridge. Renderer talks only via `window.cti`.
 *
 * UX: a 380x620 frameless window anchors below the tray icon, toggled by
 * clicking the icon (or the dock — we keep a hidden dock icon for cmd+tab).
 * Closing the window hides it; quit via the tray menu.
 */
import {
  app, BrowserWindow, ipcMain, session, shell, safeStorage, systemPreferences,
  Tray, Menu, nativeImage, screen, type Rectangle,
} from 'electron';
import { join } from 'node:path';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL as NodeURL } from 'node:url';

/**
 * Resolve the backend base URL for the PACKAGED app. VITE_API_BASE_URL only
 * exists at Vite build time for the renderer — the main process never sees it
 * in a packaged build, so without this the shipped app hardcodes localhost.
 * Resolution order: explicit main-process env → an admin-editable config.json
 * in userData → bundled default → localhost (dev).
 */
function resolveApiBaseUrl(): string {
  const fromEnv = process.env.CTI_API_BASE_URL ?? process.env.VITE_API_BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  try {
    for (const p of [
      join(app.getPath('userData'), 'config.json'),
      join(app.getAppPath(), 'config.json'),
    ]) {
      if (existsSync(p)) {
        const cfg = JSON.parse(readFileSync(p, 'utf8')) as { apiBaseUrl?: string };
        if (cfg.apiBaseUrl) return cfg.apiBaseUrl.replace(/\/+$/, '');
      }
    }
  } catch { /* app not ready or malformed config — fall back */ }
  return 'http://localhost:4000';
}

const API_BASE_URL = resolveApiBaseUrl();
const DEV_RENDERER_URL = process.env.ELECTRON_RENDERER_URL;

const WIN_WIDTH = 380;
const WIN_HEIGHT = 640;

let tray: Tray | null = null;
let popover: BrowserWindow | null = null;

// ---------- session storage (Keychain via safeStorage) ----------------------

function sessionFilePath(): string {
  return join(app.getPath('userData'), 'session.bin');
}
async function readSession(): Promise<{ token: string | null; userId: string | null; email: string | null }> {
  const fp = sessionFilePath();
  if (!existsSync(fp)) return { token: null, userId: null, email: null };
  try {
    const buf = await readFile(fp);
    const plain = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return JSON.parse(plain);
  } catch { return { token: null, userId: null, email: null }; }
}
async function writeSession(token: string, userId: string, email: string): Promise<void> {
  const fp = sessionFilePath();
  await mkdir(app.getPath('userData'), { recursive: true });
  const payload = JSON.stringify({ token, userId, email });
  const bytes = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(payload) : Buffer.from(payload, 'utf8');
  await writeFile(fp, bytes, { mode: 0o600 });
}
async function clearSessionFile(): Promise<void> {
  const fp = sessionFilePath();
  if (existsSync(fp)) await rm(fp, { force: true });
}

// ---------- thin http client (no fetch in main; keep zero deps) -------------

function nodeFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new NodeURL(url);
    const reqFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = reqFn({
      method: init.method,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: init.headers,
    }, (res) => {
      let buf = '';
      res.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: buf }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function isAllowedApiPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  if (path.includes('..') || path.includes('://')) return false;
  return true;
}

// ---------- tray icon -------------------------------------------------------

/**
 * Tray icon. PNG template images live in apps/cti-desktop/assets/ and are
 * loaded by path so macOS automatically picks the @2x version on retina.
 * `setTemplateImage(true)` makes macOS tint the icon for light/dark menubar.
 * We also set a text title so the icon is unmistakable even if the glyph
 * fails to render.
 */
function buildTrayIcon(): Electron.NativeImage {
  // __dirname is dist/main/main when packaged; assets live at app root.
  // Walk up to apps/cti-desktop/assets/trayTemplate.png.
  const candidates = [
    join(__dirname, '../../../assets/trayTemplate.png'),
    join(app.getAppPath(), 'assets/trayTemplate.png'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        img.setTemplateImage(true);
        return img;
      }
    }
  }
  // Last-resort 1x1 transparent so Tray doesn't throw — the title carries us.
  return nativeImage.createEmpty();
}

// ---------- popover window + positioning ------------------------------------

function createPopover(): BrowserWindow {
  const preloadPath = join(__dirname, '../preload/preload.js');
  const win = new BrowserWindow({
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: '#0d0f14',
    hasShadow: true,
    movable: false,
    title: 'Caller Reputation CTI',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // CSP — narrow what the renderer can fetch / load.
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [[
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline'",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' data: https://fonts.gstatic.com",
          "img-src 'self' data:",
          "media-src 'self' blob: mediastream:",
          `connect-src 'self' ${API_BASE_URL} ${DEV_RENDERER_URL ?? ''} ws: wss: https://eventgw.twilio.com https://chunderw-vpc-gll.twilio.com https://fonts.googleapis.com https://fonts.gstatic.com`,
        ].join('; ')],
      },
    });
  });

  // Block all new-window opens; route http(s) to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block navigation away from our app.
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = [DEV_RENDERER_URL, 'file://'];
    if (!allowed.some((a) => a && url.startsWith(a))) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void shell.openExternal(url);
      }
    }
  });

  // Hide instead of close so the tray icon can re-show it.
  win.on('close', (e) => {
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Hide when focus is lost (classic menubar behavior). Keep open during dev
  // so devtools doesn't immediately close the panel.
  if (!DEV_RENDERER_URL) {
    win.on('blur', () => win.hide());
  }

  if (DEV_RENDERER_URL) {
    void win.loadURL(DEV_RENDERER_URL);
    // Detached devtools so they don't crash the small frameless panel.
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // main.js lives at dist/main/main/main.js; the built renderer is at
    // dist/renderer/index.html — two levels up, not one. The previous
    // ../renderer path pointed at a non-existent dir, so the packaged window
    // loaded nothing (blank app).
    void win.loadFile(join(__dirname, '../../renderer/index.html'));
  }
  return win;
}

function positionPopover(win: BrowserWindow, trayBounds: Rectangle): void {
  const winBounds = win.getBounds();
  // Center horizontally on tray icon; clamp to the screen the tray is on.
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const workArea = display.workArea;
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2);
  let y = Math.round(trayBounds.y + trayBounds.height + 6);
  // Clamp inside screen
  if (x + winBounds.width > workArea.x + workArea.width - 8) {
    x = workArea.x + workArea.width - winBounds.width - 8;
  }
  if (x < workArea.x + 8) x = workArea.x + 8;
  // macOS menu bar sits at workArea.y; below it is fine.
  win.setPosition(x, y, false);
}

function togglePopover(): void {
  if (!popover || !tray) return;
  if (popover.isVisible()) {
    popover.hide();
  } else {
    positionPopover(popover, tray.getBounds());
    popover.show();
    popover.focus();
  }
}

// ---------- IPC bridge ------------------------------------------------------

ipcMain.handle('cti:apiRequest', async (_evt, args: unknown) => {
  if (!args || typeof args !== 'object') throw new Error('Bad args');
  const { path, init } = args as { path: string; init?: Record<string, unknown> };
  if (!isAllowedApiPath(path)) throw new Error('Bad path');
  const method = (init?.method as string) ?? 'GET';
  if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw new Error('Bad method');
  const authed = init?.authed !== false;

  const headers: Record<string, string> = {};
  if (authed) {
    const s = await readSession();
    if (s.token) headers.authorization = `Bearer ${s.token}`;
  }
  const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await nodeFetch(`${API_BASE_URL}${path}`, { method, headers, body });
  let data: unknown = null;
  if (res.text) {
    try { data = JSON.parse(res.text); } catch { data = { raw: res.text }; }
  }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, data };
});

ipcMain.handle('cti:openExternal', async (_evt, url: unknown) => {
  if (typeof url !== 'string') throw new Error('Bad url');
  if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('Bad protocol');
  await shell.openExternal(url);
});
ipcMain.handle('cti:getSession', async () => readSession());
ipcMain.handle('cti:saveSession', async (_evt, args: unknown) => {
  if (!args || typeof args !== 'object') throw new Error('Bad args');
  const { token, userId, email } = args as { token: string; userId: string; email: string };
  if (typeof token !== 'string' || typeof userId !== 'string' || typeof email !== 'string') throw new Error('Bad args');
  await writeSession(token, userId, email);
});
ipcMain.handle('cti:clearSession', async () => clearSessionFile());
ipcMain.handle('cti:appVersion', async () => app.getVersion());
ipcMain.handle('cti:hideWindow', () => popover?.hide());
ipcMain.handle('cti:quit', () => {
  (app as unknown as { isQuitting?: boolean }).isQuitting = true;
  app.quit();
});

// ---------- tel: URL handler ------------------------------------------------

/** Pending number captured before the renderer was ready. */
let pendingTelNumber: string | null = null;

/** Pulls digits + optional leading + from a tel: URL and returns whatever is
 *  there. We leave normalization to the backend's libphonenumber.
 *  Accepts tel:+15551234567, tel:5551234567, tel://...;ext=4321 etc. */
function parseTelUrl(url: string): string | null {
  if (typeof url !== 'string') return null;
  const m = /^tel:(?:\/\/)?([+\d\-\s().*#]+)/i.exec(url);
  if (!m || !m[1]) return null;
  // Strip whitespace, parens, dashes but keep + and digits and *#.
  const cleaned = m[1].replace(/[\s\-().]/g, '');
  return cleaned || null;
}

function deliverTelToRenderer(num: string): void {
  if (popover && !popover.isDestroyed() && popover.webContents) {
    if (popover.webContents.isLoading()) {
      pendingTelNumber = num;
      popover.webContents.once('did-finish-load', () => {
        popover?.webContents.send('cti:telUrl', num);
        pendingTelNumber = null;
      });
    } else {
      popover.webContents.send('cti:telUrl', num);
    }
  } else {
    pendingTelNumber = num;
  }
  // Surface the window so the rep sees it
  if (popover && tray) {
    positionPopover(popover, tray.getBounds());
    popover.show();
    popover.focus();
  }
}

// Renderer asks for the buffered URL on mount (handles the
// "macOS launches the app *because* of a tel: click" cold-start case).
ipcMain.handle('cti:consumePendingTel', () => {
  const v = pendingTelNumber;
  pendingTelNumber = null;
  return v;
});

// macOS delivers tel: clicks via the 'open-url' event.
app.on('open-url', (event, url) => {
  event.preventDefault();
  const num = parseTelUrl(url);
  if (num) deliverTelToRenderer(num);
});

// Windows/Linux deliver via a second-instance launch with argv.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const telArg = argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith('tel:'));
    if (telArg) {
      const num = parseTelUrl(telArg);
      if (num) deliverTelToRenderer(num);
    } else if (popover && tray) {
      // Plain re-launch — just bring the popover forward.
      positionPopover(popover, tray.getBounds());
      popover.show();
      popover.focus();
    }
  });
  // Also handle a tel: URL that arrived in our own argv at cold start (Win/Linux).
  const firstArg = process.argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith('tel:'));
  if (firstArg) {
    const num = parseTelUrl(firstArg);
    if (num) pendingTelNumber = num;
  }
}

// ---------- lifecycle -------------------------------------------------------

app.whenReady().then(() => {
  // Register as the system handler for tel: URLs so phone links in Salesforce,
  // Gmail, etc route to us. macOS may prompt the user the first time.
  try { app.setAsDefaultProtocolClient('tel'); } catch { /* non-fatal */ }

  // Microphone access — without this the renderer's getUserMedia (and therefore
  // the Twilio WebRTC call) is silently denied in the packaged app. Grant the
  // `media` permission to our own content and prompt for the macOS system
  // microphone entitlement up front.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
    permission === 'media' || permission === 'mediaKeySystem',
  );
  if (process.platform === 'darwin') {
    try {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      if (status !== 'granted') void systemPreferences.askForMediaAccess('microphone');
    } catch { /* non-fatal: user can grant in System Settings */ }
  }

  // Hide from dock — we're a menubar app.
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }
  popover = createPopover();
  tray = new Tray(buildTrayIcon());
  // Always show a text title so the icon is visible even if the PNG didn't
  // load. macOS renders this next to the icon in the menubar.
  tray.setTitle(' CTI');
  tray.setToolTip('Caller Reputation CTI');
  tray.on('click', () => togglePopover());
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: () => togglePopover() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          (app as unknown as { isQuitting?: boolean }).isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray?.popUpContextMenu(menu);
  });

  app.on('web-contents-created', (_evt, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
  });
});

app.on('window-all-closed', () => {
  // Don't quit; we live in the tray. (No preventDefault needed — Electron's
  // default quit behavior is suppressed when we own a Tray.)
});

app.on('before-quit', () => {
  (app as unknown as { isQuitting?: boolean }).isQuitting = true;
});

process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
});
