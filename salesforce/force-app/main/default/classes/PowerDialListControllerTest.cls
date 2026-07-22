@isTest
private class PowerDialListControllerTest {
  private class Mock implements HttpCalloutMock {
    private final Integer code;
    Mock(Integer c) {
      this.code = c;
    }
    public HttpResponse respond(HttpRequest req) {
      HttpResponse r = new HttpResponse();
      r.setStatusCode(code);
      r.setBody('{"handoffId":"x"}');
      return r;
    }
  }

  private static void setSecret() {
    Power_Dial_Setting__c s = Power_Dial_Setting__c.getOrgDefaults();
    if (s.Id == null) {
      s = new Power_Dial_Setting__c(SetupOwnerId = UserInfo.getOrganizationId());
    }
    s.Handoff_Shared_Secret__c = 'a-test-shared-secret-value';
    upsert s;
  }

  // SeeAllData: getSelected() needs a real SObject in the StandardSetController
  // (it can't be mocked), and Opportunity insert trips this org's automation, so
  // we borrow an existing record. The callout is still mocked.
  @isTest(SeeAllData=true)
  static void run_withSelection_startsPowerDial() {
    List<Opportunity> opps = [SELECT Id FROM Opportunity LIMIT 1];
    if (opps.isEmpty()) {
      return; // no data to exercise the happy path in this org
    }
    setSecret();
    Test.setMock(HttpCalloutMock.class, new Mock(200));
    ApexPages.StandardSetController ssc = new ApexPages.StandardSetController(opps);
    ssc.setSelected(opps);
    PowerDialListController ctrl = new PowerDialListController(ssc);
    Test.startTest();
    ctrl.run();
    Test.stopTest();
    System.assertEquals(false, ctrl.isError, ctrl.message);
  }

  @isTest
  static void run_noSelection_showsError() {
    ApexPages.StandardSetController ssc = new ApexPages.StandardSetController(new List<Opportunity>());
    PowerDialListController ctrl = new PowerDialListController(ssc);
    ctrl.run();
    System.assertEquals(true, ctrl.isError);
    System.assert(ctrl.message.contains('No records selected'), ctrl.message);
  }
}
