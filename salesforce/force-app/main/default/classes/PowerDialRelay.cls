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
