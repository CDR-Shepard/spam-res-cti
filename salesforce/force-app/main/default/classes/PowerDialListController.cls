/**
 * Controller extension for the Power Dial list-view buttons (the Lead and
 * Opportunity VF pages). Reads the rows the rep checked via the
 * StandardSetController's SERVER-SIDE selection (getSelected) — which survives
 * Lightning Console navigation, unlike a URL button's ?ids= param — and hands
 * them to the CTI relay (PowerDialRelay.sendToCti, admin-gated).
 */
public with sharing class PowerDialListController {
  private final ApexPages.StandardSetController setCon;

  @TestVisible
  public String message { get; private set; }
  @TestVisible
  public Boolean isError { get; private set; }

  public PowerDialListController(ApexPages.StandardSetController controller) {
    this.setCon = controller;
  }

  /** Fires on page load (the VF page's action attribute). */
  public PageReference run() {
    try {
      List<Id> ids = new List<Id>();
      List<SObject> selected = setCon.getSelected();
      if (selected != null) {
        for (SObject s : selected) {
          Id rid = (Id) s.get('Id');
          if (rid != null) {
            ids.add(rid);
          }
        }
      }
      if (ids.isEmpty()) {
        isError = true;
        message = 'No records selected. Go back to the list, check the rows you want to dial, then click Power Dial.';
        return null;
      }
      String objectApiName = String.valueOf(ids[0].getSObjectType());
      PowerDialRelay.sendToCti(objectApiName, ids);
      isError = false;
      message =
        'Power Dial started for ' + ids.size() + ' ' + objectApiName +
        ' record(s). Your CTI softphone will begin dialing.';
    } catch (Exception e) {
      isError = true;
      message = e.getMessage();
    }
    return null;
  }
}
