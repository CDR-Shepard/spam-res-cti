/**
 * Server relay for the Power Dial LWC (see lwc/powerDial/README.md, "the
 * recommended server-relay fix"). Replaces the unreliable cross-iframe
 * `window.postMessage` attempt with a real HTTP callout: the rep's selected
 * Lead/Opportunity ids are POSTed to the CTI API's
 * `POST /dialer/handoffs` endpoint, which the rep's already-signed-in CTI
 * softphone then polls and atomically claims (`GET /dialer/handoffs/pending`,
 * services/cti-api/src/routes/dialer.ts).
 *
 * Auth: a shared secret sent as the `x-handoff-secret` header, read from a
 * protected custom setting/custom metadata record — NEVER hardcoded here.
 * See lwc/powerDial/README.md for how to provision
 * `Power_Dial_Setting__c.Handoff_Shared_Secret__c` (or your chosen
 * protected Custom Metadata Type) and the matching `CTI_PowerDial` Named
 * Credential.
 *
 * The callout target is `callout:CTI_PowerDial/dialer/handoffs` — the
 * `CTI_PowerDial` Named Credential supplies the CTI API's base URL (and, if
 * you use Named-Credential-managed auth instead of a custom setting, can
 * also supply the secret as a Named Principal header — see the README).
 */
public with sharing class PowerDialRelay {
  /**
   * Salesforce profiles whose users may use Power Dial: admins plus the reps'
   * "Sales" profile. Mirrors the CTI's own rule (POWER_DIALER_PROFILES, default
   * "Sales", plus app-admins), which the CTI enforces again on the relay —
   * POST /dialer/handoffs refuses anyone whose power dialer is switched off.
   */
  @TestVisible
  private static final Set<String> ALLOWED_PROFILES = new Set<String>{ 'System Administrator', 'Sales' };

  /**
   * Sends the selected record ids to the CTI power dialer.
   *
   * @param objectApiName 'Lead' or 'Opportunity' — the object the selected
   *        records belong to.
   * @param recordIds the selected record ids (from GETRECORDIDS() on a list
   *        view button, via the Screen Flow — see the LWC README).
   * @return the CTI API's HTTP status code on success (2xx).
   */
  @AuraEnabled
  public static Integer sendToCti(String objectApiName, List<Id> recordIds) {
    // Profile gate: Power Dial is open to the System Administrator and Sales
    // profiles. Enforced server-side so it holds even if the button is surfaced
    // (or the Apex is called) from any other profile's context.
    if (!isAllowedProfile()) {
      throw new AuraHandledException('Power Dial is available to Sales and System Administrator users only.');
    }
    if (String.isBlank(objectApiName)) {
      throw new AuraHandledException('objectApiName is required.');
    }
    if (recordIds == null || recordIds.isEmpty()) {
      throw new AuraHandledException('At least one record id is required.');
    }

    String secret = getHandoffSharedSecret();
    if (String.isBlank(secret)) {
      throw new AuraHandledException(
        'Power Dial relay is not configured — the handoff shared secret is missing. ' +
        'See the powerDial LWC README for setup.'
      );
    }

    Map<String, Object> body = new Map<String, Object>{
      'salesforceUserId' => UserInfo.getUserId(),
      'objectType' => objectApiName,
      'recordIds' => recordIds
    };

    HttpRequest req = new HttpRequest();
    req.setEndpoint('callout:CTI_PowerDial/dialer/handoffs');
    req.setMethod('POST');
    req.setHeader('Content-Type', 'application/json');
    req.setHeader('x-handoff-secret', secret);
    req.setBody(JSON.serialize(body));
    req.setTimeout(10000);

    Http http = new Http();
    HttpResponse res;
    try {
      res = http.send(req);
    } catch (System.CalloutException ex) {
      throw new AuraHandledException('Could not reach the CTI power dialer: ' + ex.getMessage());
    }

    Integer status = res.getStatusCode();
    if (status < 200 || status >= 300) {
      throw new AuraHandledException(
        'CTI power dialer rejected the request (HTTP ' + status + '). ' + res.getBody()
      );
    }
    return status;
  }

  /**
   * Flow entry point — the Power Dial Screen Flow launched from a Lead/Opportunity
   * list-view button. Salesforce passes the selected record ids in a lowercase
   * `ids` Text collection; we derive the object type from the ids themselves and
   * hand off to `sendToCti` (which enforces the profile gate + does the relay).
   * Returns a status instead of throwing so the flow can show a clean message.
   */
  @InvocableMethod(
    label='Power Dial selected records'
    description='Sends selected Lead/Opportunity records to the CTI power dialer'
  )
  public static List<FlowResult> powerDialFromFlow(List<FlowRequest> requests) {
    List<FlowResult> out = new List<FlowResult>();
    for (FlowRequest req : requests) {
      FlowResult r = new FlowResult();
      try {
        List<Id> recordIds = new List<Id>();
        for (String s : (req.ids == null ? new List<String>() : req.ids)) {
          if (String.isNotBlank(s)) {
            recordIds.add((Id) s);
          }
        }
        if (recordIds.isEmpty()) {
          r.success = false;
          r.message = 'No records were selected.';
        } else {
          String objectApiName = String.valueOf(recordIds[0].getSObjectType());
          sendToCti(objectApiName, recordIds);
          r.success = true;
          r.message =
            'Power Dial started for ' + recordIds.size() + ' ' + objectApiName +
            ' record(s). Your CTI softphone will begin dialing.';
        }
      } catch (Exception e) {
        r.success = false;
        r.message = e.getMessage();
      }
      out.add(r);
    }
    return out;
  }

  public class FlowRequest {
    @InvocableVariable(label='Selected record ids')
    public List<String> ids;
  }

  public class FlowResult {
    @InvocableVariable(label='Success')
    public Boolean success;
    @InvocableVariable(label='Message')
    public String message;
  }

  /**
   * Whether the running user may use Power Dial: a System Administrator or Sales
   * profile user (ALLOWED_PROFILES). The LWC calls this (cacheable) to hide the
   * button for everyone else; `sendToCti` enforces it again server-side.
   */
  @AuraEnabled(cacheable=true)
  public static Boolean canUsePowerDial() {
    return isAllowedProfile();
  }

  private static Boolean isAllowedProfile() {
    Profile p = [SELECT Name FROM Profile WHERE Id = :UserInfo.getProfileId() LIMIT 1];
    return p != null && ALLOWED_PROFILES.contains(p.Name);
  }

  /**
   * Reads the shared secret used to authenticate to the CTI API's
   * `POST /dialer/handoffs` endpoint. Deliberately NOT hardcoded — this
   * reads a protected custom setting so the secret lives in org
   * configuration, not source control.
   *
   * This implementation expects a protected Custom Setting named
   * `Power_Dial_Setting__c` (Hierarchy or List, org-wide) with a text field
   * `Handoff_Shared_Secret__c`. See lwc/powerDial/README.md for the exact
   * setup steps (and a Custom Metadata Type alternative, which some orgs
   * prefer for read-only-at-runtime secrets).
   */
  private static String getHandoffSharedSecret() {
    Power_Dial_Setting__c setting = Power_Dial_Setting__c.getInstance();
    if (setting == null) {
      return null;
    }
    return setting.Handoff_Shared_Secret__c;
  }
}
