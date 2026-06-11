/**
 * Thin wrapper around Salesforce's Open CTI JS API.
 *
 * The script `opencti_min.js` is loaded dynamically (different SF orgs serve
 * it from different hostnames; we read the org host from a `?sf=` URL param
 * supplied by the Call Center definition).
 *
 * Docs: https://developer.salesforce.com/docs/atlas.en-us.api_cti.meta/api_cti/
 */

type OpenCtiCallback<T = unknown> = (result: { success: boolean; returnValue?: T; errors?: unknown }) => void;

interface SforceOpenCti {
  enableClickToDial(args: { callback?: OpenCtiCallback }): void;
  disableClickToDial(args: { callback?: OpenCtiCallback }): void;
  onClickToDial(args: { listener: (e: ClickToDialEvent) => void }): void;
  notifyInitializationComplete(): void;
  getCallCenterSettings(args: { callback?: OpenCtiCallback }): void;
  screenPop(args: { type: string; params: Record<string, unknown>; callback?: OpenCtiCallback }): void;
  saveLog(args: { value: Record<string, unknown>; callback?: OpenCtiCallback }): void;
  setSoftphonePanelVisibility?(args: { visible: boolean; callback?: OpenCtiCallback }): void;
}

export interface ClickToDialEvent {
  number: string;
  recordId?: string;
  recordName?: string;
  objectType?: string;
}

declare global {
  interface Window {
    sforce?: { opencti?: SforceOpenCti };
  }
}

interface InitResult {
  ready: boolean;
  reason?: string;
  scriptUrl?: string;
  sfHost?: string;
}

/**
 * Loads opencti_min.js from the SF instance specified via the `sf` URL param
 * (e.g. `?sf=gghomes.my.salesforce.com`), then resolves once `window.sforce.opencti`
 * is available. Returns ready=false outside of Salesforce so the dev page still works.
 */
/**
 * Resolve the Salesforce host that's iframing us, in priority order:
 *   1. ?sf=… URL param (explicit override)
 *   2. document.referrer (parent page URL — set by SF when iframing)
 *   3. window.location.ancestorOrigins[0] (Chrome-only, but reliable)
 * Returns null if we can't determine an SF-shaped host.
 */
function detectSfHost(): string | null {
  const params = new URLSearchParams(window.location.search);
  const candidates: string[] = [];
  const explicit = params.get('sf');
  if (explicit) candidates.push(explicit);
  if (document.referrer) {
    try { candidates.push(new URL(document.referrer).hostname); } catch { /* */ }
  }
  // ancestorOrigins is a non-standard but Chrome-supported list of parent frames
  const ancestors = (window.location as unknown as { ancestorOrigins?: { length: number; item(i: number): string | null } }).ancestorOrigins;
  if (ancestors && ancestors.length > 0) {
    const first = ancestors.item(0);
    if (first) {
      try { candidates.push(new URL(first).hostname); } catch { /* */ }
    }
  }
  const sfShape = (h: string): boolean =>
    /\.salesforce\.com$/i.test(h) || /\.force\.com$/i.test(h) ||
    /\.lightning\.force\.com$/i.test(h) || /\.visualforce\.com$/i.test(h);
  for (const h of candidates) {
    if (h && sfShape(h)) return h;
  }
  return null;
}

export async function initOpenCti(): Promise<InitResult> {
  const sfHost = detectSfHost();
  if (!sfHost) {
    return { ready: false, reason: 'Not running inside Salesforce (no SF-shaped parent host).' };
  }
  // Lightning hosts (e.g. acme.lightning.force.com) need the API at the
  // matching .my.salesforce.com domain. Map common forms.
  const scriptHost = sfHost
    .replace(/\.lightning\.force\.com$/i, '.my.salesforce.com')
    .replace(/\.visualforce\.com$/i, '.my.salesforce.com');
  const scriptUrl = `https://${scriptHost}/support/api/60.0/lightning/opencti_min.js`;
  try {
    await loadScript(scriptUrl);
  } catch (err) {
    return { ready: false, reason: `Could not load ${scriptUrl}: ${(err as Error).message}` };
  }
  if (!window.sforce?.opencti) {
    return { ready: false, reason: 'opencti_min.js loaded but window.sforce.opencti missing.', scriptUrl };
  }
  return { ready: true, scriptUrl, sfHost };
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-cti-src="${src}"]`);
    if (existing) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.ctiSrc = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

export function notifyReady(): void {
  window.sforce?.opencti?.notifyInitializationComplete();
}

export function onClickToDial(handler: (e: ClickToDialEvent) => void): void {
  if (!window.sforce?.opencti) return;
  window.sforce.opencti.enableClickToDial({
    callback: () => { /* enabled */ },
  });
  window.sforce.opencti.onClickToDial({ listener: handler });
}

/**
 * After a call completes, save a Task via Open CTI. This lets Salesforce
 * attach the Task to the WhoId/WhatId we already know from the click event
 * (passed in `value`), bypassing our SOSL match. Falls back gracefully when
 * Open CTI isn't available (e.g. standalone dev page).
 */
export function saveCallLog(value: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const opencti = window.sforce?.opencti;
    if (!opencti) { resolve(false); return; }
    opencti.saveLog({
      value: { entityApiName: 'Task', ...value },
      callback: (res) => resolve(Boolean(res?.success)),
    });
  });
}

export function screenPopRecord(recordId: string): void {
  window.sforce?.opencti?.screenPop({
    type: 'sObject',
    params: { recordId },
  });
}

/**
 * Auto-show the softphone panel (e.g. after a click-to-dial fires while the
 * panel is collapsed). No-op when Open CTI isn't available.
 */
export function setPanelVisibility(visible: boolean): void {
  window.sforce?.opencti?.setSoftphonePanelVisibility?.({ visible });
}
