@isTest
private class PowerDialRelayTest {
  /** Minimal HttpCalloutMock returning a fixed status/body for every request. */
  private class FixedResponseMock implements HttpCalloutMock {
    private final Integer statusCode;
    private final String responseBody;

    FixedResponseMock(Integer statusCode, String responseBody) {
      this.statusCode = statusCode;
      this.responseBody = responseBody;
    }

    public HttpResponse respond(HttpRequest req) {
      System.assertEquals('callout:CTI_PowerDial/dialer/handoffs', req.getEndpoint());
      System.assertEquals('POST', req.getMethod());
      System.assertEquals('application/json', req.getHeader('Content-Type'));
      System.assertNotEquals(null, req.getHeader('x-handoff-secret'));

      HttpResponse res = new HttpResponse();
      res.setStatusCode(statusCode);
      res.setBody(responseBody);
      return res;
    }
  }

  private static void setSharedSecret(String secret) {
    Power_Dial_Setting__c settings = Power_Dial_Setting__c.getOrgDefaults();
    if (settings.Id == null) {
      settings = new Power_Dial_Setting__c();
      settings.SetupOwnerId = UserInfo.getOrganizationId();
    }
    settings.Handoff_Shared_Secret__c = secret;
    upsert settings;
  }

  @isTest
  static void sendToCti_success_returnsStatus() {
    setSharedSecret('a-test-shared-secret-value');
    Test.setMock(HttpCalloutMock.class, new FixedResponseMock(200, '{"handoffId":"abc-123"}'));

    Test.startTest();
    Integer status = PowerDialRelay.sendToCti('Lead', new List<Id>{ UserInfo.getUserId() });
    Test.stopTest();

    System.assertEquals(200, status);
  }

  @isTest
  static void sendToCti_nonTwoXx_throwsAuraHandledException() {
    setSharedSecret('a-test-shared-secret-value');
    Test.setMock(HttpCalloutMock.class, new FixedResponseMock(401, '{"error":"Unauthorized"}'));

    Boolean threw = false;
    Test.startTest();
    try {
      PowerDialRelay.sendToCti('Lead', new List<Id>{ UserInfo.getUserId() });
    } catch (AuraHandledException ex) {
      threw = true;
    }
    Test.stopTest();

    System.assert(threw, 'Expected a non-2xx callout response to throw AuraHandledException.');
  }

  @isTest
  static void sendToCti_missingSecret_throwsAuraHandledException() {
    // No shared secret configured — org defaults are unset for this test run.
    Boolean threw = false;
    try {
      PowerDialRelay.sendToCti('Lead', new List<Id>{ UserInfo.getUserId() });
    } catch (AuraHandledException ex) {
      threw = true;
    }

    System.assert(threw, 'Expected a missing shared secret to throw AuraHandledException.');
  }

  @isTest
  static void sendToCti_blankObjectApiName_throwsAuraHandledException() {
    Boolean threw = false;
    try {
      PowerDialRelay.sendToCti('', new List<Id>{ UserInfo.getUserId() });
    } catch (AuraHandledException ex) {
      threw = true;
    }

    System.assert(threw, 'Expected a blank objectApiName to throw AuraHandledException.');
  }

  @isTest
  static void sendToCti_emptyRecordIds_throwsAuraHandledException() {
    Boolean threw = false;
    try {
      PowerDialRelay.sendToCti('Lead', new List<Id>());
    } catch (AuraHandledException ex) {
      threw = true;
    }

    System.assert(threw, 'Expected an empty recordIds list to throw AuraHandledException.');
  }

  @isTest
  static void canUsePowerDial_trueForAdmin() {
    // Tests run as the (admin) deploying user → the rollout gate is open.
    System.assertEquals(true, PowerDialRelay.canUsePowerDial(),
      'A System Administrator should be allowed to use Power Dial.');
  }

  @isTest
  static void sendToCti_nonAdmin_throwsAuraHandledException() {
    // Use an existing active non-admin user (no User insert — inserting one
    // trips this org's User-creation flow). Skip cleanly if the org has none.
    List<User> nonAdmins = [
      SELECT Id FROM User
      WHERE IsActive = true AND Profile.Name != 'System Administrator'
      LIMIT 1
    ];
    if (nonAdmins.isEmpty()) {
      return;
    }
    Boolean threw = false;
    System.runAs(nonAdmins[0]) {
      System.assertEquals(false, PowerDialRelay.canUsePowerDial(),
        'A non-admin should not be allowed to use Power Dial.');
      try {
        PowerDialRelay.sendToCti('Lead', new List<Id>{ UserInfo.getUserId() });
      } catch (AuraHandledException ex) {
        threw = true;
      }
    }
    System.assert(threw, 'Expected a non-admin caller to be blocked by the rollout gate.');
  }
}
