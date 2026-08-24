# `salesforce/` — the sfdx project for the production org

This directory is a normal sfdx project (`sfdx-project.json`, package directory `force-app`) used to deploy the CTI app's Salesforce-side metadata.

- **Target org:** alias `_t2` — `00D5f000005w2kWEAQ`, `gghsd.my.salesforce.com`. **This is PRODUCTION.** The sandbox alias `gghsd-maindev` is not the target.
- **API version:** 67.0.

## The one rule that matters: `layouts/` is a SNAPSHOT, not a source of truth

`force-app/main/default/layouts/` holds **point-in-time snapshots retrieved from the org on 2026-08-24**. Unlike the rest of this tree (Apex, LWC, named credentials, the CTI custom fields), page layouts are owned and edited by admins **in the org**, through the Setup UI, whenever they like. The repo copy goes stale the moment an admin drags a field.

That matters because **a layout deploy is a WHOLE-FILE REPLACEMENT.** The Metadata API does not merge layout changes; it overwrites the layout with exactly what you send. Deploying a stale snapshot silently reverts every admin edit made in the org since the retrieve — with no warning and no error, because from the API's point of view the deploy succeeded.

Three rules follow:

1. **Always re-retrieve a layout immediately before editing it.**

   ```bash
   sf project retrieve start -o _t2 -m "Layout:Opportunity-Management"
   ```

   Then diff (`git diff -- salesforce/`) to see whether the org has moved since the last snapshot, and make your edit on top of the fresh file.

2. **Always deploy layouts individually, with a targeted `-m "Layout:<name>"`.** One layout per deploy, and read the `Status: Succeeded` line for each. If a layout fails on unrelated drift, skip it and record which — never force it through.

   ```bash
   sf project deploy start -o _t2 -m "Layout:Opportunity-Management"
   ```

3. **Never blanket-deploy this directory or the whole package.** In particular, do NOT run

   ```bash
   sf project deploy start -o _t2 -d force-app            # ← NO
   sf project deploy start -o _t2 -d force-app/main/default # ← NO
   ```

   Both sweep `layouts/` in, pushing all 12 snapshots back over whatever the org currently has. (The wholesale-deploy line in `force-app/main/default/lwc/powerDial/README.md` predates `layouts/` existing and is not safe as written.) Deploy the specific directory or the specific metadata member you actually changed:

   ```bash
   sf project deploy start -o _t2 -d force-app/main/default/objects -d force-app/main/default/permissionsets
   ```

## Why the layouts are tracked at all

They document exactly what was deployed for `Skip_on_Dialer__c` (launch spec item 6): the checkbox is present on all 6 Lead and all 6 Opportunity layouts, inserted as a single `<layoutItems>` block in the first `<layoutColumns>` of each layout's first data section. Keeping the full retrieved file — rather than a fragment — is what makes that diffable. It is not a claim that the repo owns those layouts.

## Everything else in `force-app`

Apex classes, LWC, named credentials, custom objects/fields and permission sets here ARE repo-owned and safe to deploy by directory. Additive-only remains the standing rule for this org: add fields and permsets, never delete or repurpose existing org metadata.
