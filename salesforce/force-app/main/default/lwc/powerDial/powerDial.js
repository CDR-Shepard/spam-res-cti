import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import sendToCti from '@salesforce/apex/PowerDialRelay.sendToCti';

/**
 * Power Dial handoff component.
 *
 * Resolves a set of Lead/Opportunity record ids — supplied by a Screen Flow
 * (the realistic list-view path), a single-record Quick Action, or manual
 * design-time attributes for testing — and hands them to the CTI power
 * dialer via the `PowerDialRelay.sendToCti` Apex server relay.
 *
 * Read README.md's "Handoff mechanism" section for why this uses a server
 * relay rather than `window.postMessage`: a raw cross-iframe postMessage
 * from an LWC cannot reliably reach the CTI softphone's utility-bar iframe
 * under Lightning Web Security. The relay instead has Apex POST the
 * selection to `services/cti-api` (`POST /dialer/handoffs`, shared-secret
 * authed), and the rep's already-signed-in CTI softphone picks it up on its
 * next poll (`GET /dialer/handoffs/pending`) and auto-starts the run.
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

  /** True while the Apex relay call is in flight, to guard against double-clicks. */
  sending = false;

  /** Set if the Apex relay call throws. */
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
    return `${this.recordCount} ${this.objectApiName} record(s) ready to send to the CTI power dialer.`;
  }

  handlePowerDialClick() {
    this.sendToCtiRelay();
  }

  /**
   * Calls the PowerDialRelay.sendToCti Apex method, which POSTs the
   * selection to services/cti-api's handoff relay endpoint. See the
   * class-level comment and README.md for the full setup (Named Credential,
   * shared secret) this depends on.
   */
  async sendToCtiRelay() {
    this.lastError = undefined;
    this.sending = true;
    try {
      await sendToCti({
        objectApiName: this.objectApiName,
        recordIds: this.resolvedRecordIds,
      });
      this.dispatchEvent(
        new ShowToastEvent({
          title: 'Power Dial started',
          message: `Sent ${this.recordCount} ${this.objectApiName} record(s) to your CTI softphone.`,
          variant: 'success',
        })
      );
    } catch (err) {
      this.lastError = this.extractErrorMessage(err);
      this.dispatchEvent(
        new ShowToastEvent({
          title: 'Power Dial failed',
          message: this.lastError,
          variant: 'error',
        })
      );
    } finally {
      this.sending = false;
    }
  }

  /** Normalizes an Apex/AuraHandledException error shape into a display string. */
  extractErrorMessage(err) {
    if (err && err.body && typeof err.body.message === 'string') {
      return err.body.message;
    }
    if (err instanceof Error) {
      return err.message;
    }
    return 'Unknown error sending the record ids to the CTI power dialer.';
  }
}
