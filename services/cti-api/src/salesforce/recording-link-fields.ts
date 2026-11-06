/**
 * Where a call's recording link goes on its Salesforce Task — every writer
 * (salesforce/sync.ts, salesforce/dialer-connect-worker.ts) goes through here.
 *
 * TWO FIELDS (2026-11-06). The 360 CTI package's tdc_cti__Recording_URL__c is
 * gated by the tdc_cti package license: Salesforce rejects it (INVALID_FIELD)
 * for a rep without a seat, and hides it from anyone without one who opens the
 * Task. So the link ALSO goes in Activity.CTI_Recording_Link__c ("Call
 * Recording", salesforce/force-app), our own unpackaged URL field that every
 * profile can see. The package field is still written for the reports and
 * licensed users that already read it.
 *
 * Not the Description: the org's "Task - After Create or Update" flow posts a
 * call Task's Description to Chatter every time it changes.
 *
 * Separate PATCHes, ours first: one rejected field fails a whole PATCH, and the
 * package field is the one expected to fail. Ours THROWING (a validation rule,
 * a flow fault) must not cost a licensed rep the package link they had before
 * this field existed, so the package PATCH still runs and the error is
 * rethrown after it — the caller's retry rewrites both, harmlessly.
 */
export const CALL_RECORDING_FIELD = 'CTI_Recording_Link__c';
export const PACKAGE_RECORDING_FIELD = 'tdc_cti__Recording_URL__c';

export type TaskFieldUpdater = (
  userId: string,
  taskId: string,
  fields: Record<string, string>,
) => Promise<{ updated: boolean }>;

/** Which field Salesforce accepted. A throw (auth, 5xx, timeout) propagates. */
export interface RecordingLinkWrite {
  callRecording: boolean;
  packageField: boolean;
}

export async function writeRecordingLink(
  update: TaskFieldUpdater,
  userId: string,
  taskId: string,
  url: string,
): Promise<RecordingLinkWrite> {
  let ours: { updated: boolean } | null = null;
  let oursError: unknown = null;
  try {
    ours = await update(userId, taskId, { [CALL_RECORDING_FIELD]: url });
  } catch (err) {
    oursError = err;
  }
  const pkg = await update(userId, taskId, { [PACKAGE_RECORDING_FIELD]: url });
  if (!ours) throw oursError;
  return { callRecording: ours.updated, packageField: pkg.updated };
}
