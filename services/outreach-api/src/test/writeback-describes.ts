/**
 * Plan 1D write-back test fixtures: Lead and Opportunity describes carrying the production org's (_t2) labels, types and
 * ACTIVE picklist values for every allowlisted field (read-only `sf sobject describe -o _t2`, 2026-10-06), plus
 * `AI_Last_Call_Changes__c` (deployed by Task 6). Every field is updateable and not calculated.
 */
import type { SObjectDescribe, SObjectField } from '@cti/salesforce';

type Spec = [name: string, type: string, label: string, picklist?: string[]];

const toField = ([name, type, label, picklist]: Spec): SObjectField => ({
  name,
  type,
  label,
  updateable: true,
  calculated: false,
  ...(picklist ? { picklistValues: picklist.map((value) => ({ value, label: value, active: true })) } : {}),
});

const CHANGES: Spec = ['AI_Last_Call_Changes__c', 'textarea', 'AI Last Call Changes'];

const LEAD: Spec[] = [
  ["Status", "picklist", "Status", ["New","Working","Long Term Follow-Up","Unqualified","Duplicate","Qualified"]],
  ["Rating", "picklist", "Rating", ["Hot","Warm","Cold"]],
  ["Unqualified_Reason__c", "picklist", "Unqualified Reason", ["Could not find phone number","Already sold (MLS)","Already sold (Other Investor)","Doesn't have a property to sell at all","Hostile/Remove from list","Other","Outside buy area","Spam","Not Interested","Went with Competition","Unqualified - In Contract","Unqualified - In Negotiation","Unqualified - Calling for Specific Team Mate","Insufficient lead information"]],
  ["Removal_Status__c", "picklist", "Removal Status", ["Remove me","Spam"]],
  ["DoNotCall", "boolean", "Do Not Call"],
  ["Skip_on_Dialer__c", "boolean", "Skip on Dialer"],
  ["Motivation__c", "picklist", "Motivation", ["1031 Exchange","2nd Home for Family","COVID","Death","Divorce","Downsizing","Financial Burden","Financial Burden - NOD Filed","First Time Homebuyer","I Didn't Ask","Illness","Inherited","Medical Bills","Neighborhood Nuisance","Other","Political Reason","Relocating In-State","Relocating Locally","Relocating OOS","Repairs/Damage","Retiring","Seller Wouldn't Say","Investment Property","Tired Landlord","Upgrading","Vacation Property","More Land","Selling Investment"]],
  ["SecondaryMotivation__c", "picklist", "Secondary Motivation", ["1031 Exchange","2nd Home for Family","COVID","Death","Divorce","Downsizing","Financial Burden","Financial Burden - NOD Filed","First Time Homebuyer","I Didn't Ask","Illness","Inherited","Medical Bills","Neighborhood Nuisance","Other","Political Reason","Relocating In-State","Relocating Locally","Relocating OOS","Repairs/Damage","Retiring","Seller Wouldn't Say","Investment Property","Tired Landlord","Upgrading","Vacation Property","More Land","Selling Investment"]],
  ["Timeline__c", "picklist", "Timeline", ["Urgent < 7 Days","30 Days","90 Days","180 Days","365 Days","2 Years","Didn't Ask","Seller Wouldn't Disclose"]],
  ["Condition__c", "picklist", "Condition", ["1 - Vacant Land","2 - Tear Down","3 - Major Fixer with Major Issues","4 - Fixer - Needs New Floorplan","5 - Cosmetic Fixer","6 - Outdated - Would Pass Conv Fin","7 - Semi Remodeled","8 - Mostly Remodeled","9 - Fully Remodeled","10 - New Construction","Seller Didn't Say","I Didn't Ask"]],
  ["Major_Repairs_Needed__c", "multipicklist", "Major Repairs Needed", ["Electrical","Fire Damage","Foundation","Mold Remediation","No Major Repairs Needed","Other","Plumbing","Pool Repairs","Roof","Termite Damage","Unsure"]],
  ["Roof_Issues__c", "boolean", "Roof Issues"],
  ["Foundation_Issues__c", "boolean", "Foundation Issues"],
  ["Mold__c", "boolean", "Mold"],
  ["Occupancy__c", "picklist", "Occupancy", ["Owner Occupied","Family Member Occupied","Tenant Occupied","Squatter Occupied","Vacant","Land only"]],
  ["Seller_s_Asking_Price__c", "currency", "Seller's Asking Price"],
  ["Competition__c", "multipicklist", "Competition", ["I Didn't Ask","Seller Didn't Say","Realtor Competition","Other Investors","Has Offers","No Competition"]],
  ["Amount_Owed__c", "currency", "Amount Owed"],
  ["Spanish_Speaker__c", "boolean", "Spanish Speaker"],
  CHANGES,
];

const OPPORTUNITY: Spec[] = [
  ["StageName", "picklist", "Stage", ["New Opportunity","Pending Appointment","Appointment Set","Followup","Negotiation","New Buyer","Investigation","Preapproved","BRE Signed","Writing Offers","Offer Accepted","Misqualified","Duplicate","Contract Signed","Closed Lost","Closed Won (Buyer)","Verbal Submitted","Verbal Submitted – Pending Walkthrough","Verbal Submitted – No Walkthrough Needed","Walkthrough Invited","Walkthrough Attended","Final Offer Submitted","Offer Rejected","Assignment Contract Sent","Contract in Escrow","Buyer Cancelled Escrow","Offer Rescinded"]],
  ["Rating__c", "picklist", "Rating", ["Hot","Warm","Cool","Cold"]],
  ["Loss_Reason__c", "picklist", "Opportunity Stage Status Reason", ["Lost to Competitor","No Budget / Lost Funding","No Decision / Non-Responsive","Price","Other","Sold on MLS","Sold to Other Investor","Sold to iBuyer","Hostile/Remove From List","Land","Wholesaler","No Info from Skiptrace","Dead deal management approved","Fake Lead","Duplicate Opportunity"]],
  ["Closed_Lost_Reason__c", "picklist", "Closed/Lost Reason", ["Sold on MLS","Sold To Other Investor","Sold to iBuyer","Decided to List (Our Team)","Hostile/Remove From List","Outside buy area","Other","Bought from Other Agent","Sold to Family Member"]],
  ["Next_Follow_Up_Date__c", "datetime", "Next Follow-Up Date"],
  ["Skip_on_Dialer__c", "boolean", "Skip on Dialer"],
  ["Motivation__c", "picklist", "Motivation", ["1031 Exchange","2nd Home for Family","COVID","Death","Divorce","Downsizing","Financial Burden","Financial Burden - NOD Filed","First Time Homebuyer","I Didn't Ask","Illness","Inherited","Medical Bills","Neighborhood Nuisance","Other","Political Reason","Relocating In-State","Relocating Locally","Relocating OOS","Repairs/Damage","Retiring","Seller Wouldn't Say","Investment Property","Tired Landlord","Upgrading","Vacation Property","More Land","Selling Investment"]],
  ["SecondaryMotivation__c", "picklist", "Secondary Motivation", ["1031 Exchange","2nd Home for Family","COVID","Death","Divorce","Downsizing","Financial Burden","Financial Burden - NOD Filed","First Time Homebuyer","I Didn't Ask","Illness","Inherited","Medical Bills","Neighborhood Nuisance","Other","Political Reason","Relocating In-State","Relocating Locally","Relocating OOS","Repairs/Damage","Retiring","Seller Wouldn't Say","Investment Property","Tired Landlord","Upgrading","Vacation Property","More Land","Selling Investment"]],
  ["Timeline__c", "picklist", "Timeline", ["Urgent < 7 Days","30 Days","90 Days","180 Days","365 Days","2 Years","Didn't Ask","Seller Wouldn't Disclose"]],
  ["Condition__c", "picklist", "Condition", ["1 - Vacant Land","2 - Tear Down","3 - Major Fixer with Major Issues","4 - Fixer - Needs New Floorplan","5 - Cosmetic Fixer","6 - Outdated - Would Pass Conv Fin","7 - Semi Remodeled","8 - Mostly Remodeled","9 - Fully Remodeled","10 - New Construction","Seller Didn't Say","I Didn't Ask"]],
  ["Major_Repairs_Needed__c", "multipicklist", "Major Repairs Needed", ["Electrical","Fire Damage","Foundation","Mold Remediation","No Major Repairs Needed","Other","Plumbing","Pool Repairs","Roof","Termite Damage","Unsure"]],
  ["Occupancy__c", "picklist", "Current Occupancy", ["Owner Occupied","Family Member Occupied","Tenant Occupied","Squatter Occupied","Vacant","Land only"]],
  ["SellersAskingPrice__c", "currency", "Seller's Asking Price"],
  ["Competition__c", "multipicklist", "Competition", ["I Didn't Ask","Seller Didn't Say","Realtor Competition","Other Investors","Has Offers","No Competition"]],
  ["Amount_Owed__c", "currency", "Amount Owed"],
  ["Reason_For_Selling__c", "textarea", "Reason For Selling?"],
  ["Spanish_Speaker__c", "boolean", "Spanish Speaker"],
  CHANGES,
];

/** A fresh copy each call: tests may change it. `drop` leaves fields out (a field the org lacks). */
export function prodDescribe(sfObject: 'Lead' | 'Opportunity', drop: readonly string[] = []): SObjectDescribe {
  const specs = sfObject === 'Lead' ? LEAD : OPPORTUNITY;
  return { name: sfObject, fields: specs.filter(([n]) => !drop.includes(n)).map(toField) };
}
