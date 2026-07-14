import { LightningElement, api } from 'lwc';

/**
 * Power Dial handoff component.
 *
 * Resolves a set of Lead/Opportunity record ids — supplied by a Screen Flow
 * (the realistic list-view path), a single-record Quick Action, or manual
 * design-time attributes for testing — and makes a best-effort attempt to
 * hand them to the CTI power dialer via `window.postMessage`.
 *
 * IMPORTANT — read README.md's "Handoff mechanism" section before relying on
 * this in production. The `window.postMessage` call below is very unlikely
 * to reach the CTI softphone iframe from inside Salesforce Lightning
 * Experience (Locker/LWS iframe isolation). It is included because the task
 * asked for a best-effort attempt with the exact documented message shape,
 * not because it is known to work end-to-end. The README documents the
 * recommended server-relay alternative as a separate, user-gated follow-up.
 */
export default class PowerDial extends LightningElement {
  /**
   * The object API name for the selected records ('Lead' | 'Opportunity').
   * Set by a Screen Flow input (lightning__FlowScreen) or, for manual
   * testing, an App/Home Page design-time attribute.
   */
  @api objectApiName;

  /**
   * Multi-record ids, e.g. a Screen Flow's collection variable built from
   * GETRECORDIDS() on a list view button, or a manual test value.
   */
  @api recordIds = [];

  /**
   * Single-record id, auto-injected by Salesforce when this component is
   * used as a lightning__RecordAction quick action on one Lead/Opportunity
   * record (not a list-view selection).
   */
  @api recordId;

  /** True briefly while sendToCti() runs, to guard against double-clicks. */
  sending = false;

  /** Set if the best-effort postMessage attempt throws. */
  lastError;

  /** Ids to dial: the multi-record list if present, else the single id. */
  get resolvedRecordIds() {
    if (Array.isArray(this.recordIds) && this.recordIds.length > 0) {
      return this.recordIds;
    }
    return this.recordId ? [this.recordId] : [];
  }

  get recordCount() {
    return this.resolvedRecordIds.length;
  }

  get buttonLabel() {
    return `Power Dial (${this.recordCount})`;
  }

  get isDisabled() {
    return this.sending || this.recordCount === 0 || !this.objectApiName;
  }

  get helperText() {
    if (!this.objectApiName) {
      return 'Waiting for an object type — this component needs to be wired via a Screen Flow input, Quick Action context, or a manual test attribute. See README.md.';
    }
    if (this.recordCount === 0) {
      return 'No records selected.';
    }
    return `${this.recordCount} ${this.objectApiName} record(s) ready — this only queues a best-effort message, see README.md for the reliable path.`;
  }

  handlePowerDialClick() {
    this.sendToCti();
  }

  /**
   * Builds the POWER_DIAL payload and makes a best-effort attempt to deliver
   * it via window.postMessage. See the class-level comment and README.md —
   * this is not guaranteed (and in the real Lightning Experience embedding,
   * is unlikely) to reach the CTI softphone iframe.
   */
  sendToCti() {
    this.lastError = undefined;
    const payload = {
      type: 'POWER_DIAL',
      objectType: this.objectApiName,
      recordIds: this.resolvedRecordIds,
    };
    this.sending = true;
    try {
      window.postMessage(payload, '*');
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Unknown error sending the POWER_DIAL message.';
    } finally {
      this.sending = false;
    }
  }
}
