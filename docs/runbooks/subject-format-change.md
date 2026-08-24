# Org dependency sweep — call-subject format change

## Why

Sub-project D+E changes the Task subject string the CTI app writes on every call log, from the old `-`-delimited form:

```
Outbound Call - (619) 555-1234
Inbound Call - (619) 555-1234
```

to the new `|`-delimited form (`services/cti-api/src/salesforce/call-subject.ts`, mirrored in `apps/cti-web/src/call-subject.ts`):

```
Outbound Call | Voicemail | (619) 555-1234 / Jane Doe
Inbound Call | Connected | (619) 555-1234
```

Before that ships, this is a read-only sweep of the production org's automation metadata (Flow, ApexClass, ApexTrigger, WorkflowRule) for anything that parses, matches, or otherwise depends on the **old** `"Outbound Call - "` / `"Inbound Call - "` prefix on `Task.Subject`. Nothing was deployed and no retrieved file was modified — this is a grep-only investigation against a scratch retrieve.

## Scope and method

- **Org:** alias `_t2`, `evren2@gghomessd.com`, org ID `00D5f000005w2kWEAQ`, `gghsd.my.salesforce.com`, API v67.0 (production — source tracking is not available on this org type).
- **Retrieved metadata types:** `Flow`, `ApexClass`, `ApexTrigger`, `WorkflowRule` (all members, `*`).
- **Command actually used** (from `salesforce/`):

  ```bash
  sf project retrieve start -m Flow -m ApexClass -m ApexTrigger -m WorkflowRule -o _t2 \
    --target-metadata-dir /path/to/scratch/org-sweep -z
  ```

  The plan's original command used `-o _t2 --output-dir <scratch>`, but `--output-dir` requires a path inside the sfdx project (`sf` rejects an external path with `OutputDirOutsideProjectError`). `--target-metadata-dir` (metadata-API format, zipped, `-z` to auto-extract) does accept an external path, so the retrieve landed entirely under a scratchpad directory outside the repo and the sfdx project tree (`salesforce/`) was never touched — confirmed clean with `git status --short salesforce/` before and after.
- **Retrieved volume:** 396 `ApexClass` files, 348 `Flow` files, 46 `ApexTrigger` files, 0 `WorkflowRule` files (no `workflows/` directory was created in the retrieve at all — see Finding 3).
- **Grep:** `grep -rn "Outbound Call - "` / `grep -rn "Inbound Call - "` (exact old prefix, case-sensitive) across the full retrieved tree, plus a broader `grep -rli "outbound call"` / `"inbound call"` (case-insensitive, no trailing dash) as a sanity check for anything close to the pattern that a strict prefix match could miss.

## Findings

### Finding 1 — zero hits on the exact old prefix

`grep -rn "Outbound Call - "` and `grep -rn "Inbound Call - "` against all 790 retrieved Flow/ApexClass/ApexTrigger files: **zero matches, both strings.** No Flow, Apex class, Apex trigger, or workflow rule in the org parses, string-matches, or otherwise depends on the literal `"Outbound Call - "` / `"Inbound Call - "` prefix.

### Finding 2 — the only near-miss is unrelated to Task.Subject

The looser, case-insensitive sweep for `"outbound call"` / `"inbound call"` (no dash) turned up exactly one non-matching hit, present verbatim in two files:

- `flows/Omni_Channel_Flow_Voice_Calls_Routing_For_Vonage.flow`, line 62
- `flows/Omni_Channel_Flow_Voice_Calls_Routing_For_Vonage_PROD.flow`, line 62

```xml
<inputParameters>
    <name>queueLabel</name>
    <value>
        <stringValue>VCC Inbound Calls</stringValue>
    </value>
</inputParameters>
```

This is an Omni-Channel routing Flow (Vonage voice) passing a **queue label**, `"VCC Inbound Calls"`, into a `PushToOmniChannel`-style action. It is plural (`Calls`, not `Call`), has no trailing ` - ` delimiter, and is not read from or matched against `Task.Subject` anywhere in the flow — it names an Omni-Channel service queue, unconnected to the CTI app's call-log Subject string. Not a dependency on the old format; no action needed.

### Finding 3 — zero WorkflowRule metadata in the org

The retrieve manifest (`package.xml`) requested `WorkflowRule: *`, and the retrieve succeeded, but no `workflows/` directory was produced — the org has no WorkflowRule metadata at all. (Consistent with a mostly-Flow-based org; nothing to check on that axis.)

### Adjacent automation, noted for context (not a hit)

`flows/Task_After_Create_or_Update.flow` fires on Task create/update and does read CTI-written fields — `tdc_cti__Call_From__c`, `tdc_cti__Call_Type__c`, and a `Subject_Text__c` formula field — to compose Chatter post text (`"Subject: " + Subject_Text__c + " | FROM: " + ... + " | Form Number: " + Call_From + " | " + Call_Type + " | Notes: " + Description`). It does **not** reference the literal `"Outbound Call - "` / `"Inbound Call - "` strings and does not parse `Task.Subject` itself — it builds its own composite string from other fields, and `Subject_Text__c` is a separate formula field, not the native `Subject`. Flagged here only because it is the one automation in the org that touches CTI-authored Task fields; it needs no change for this format switch.

## Overall conclusion

**Zero automations (Flow, ApexClass, ApexTrigger, WorkflowRule) in the production org reference the old `"Outbound Call - "` / `"Inbound Call - "` Task-subject prefix.** The metadata-side dependency sweep is clean — nothing in Apex or Flow needs to change alongside the subject-format switch.

## Residual: reports were not swept (do this manually)

Report column filters (e.g., a report filtering `Task.Subject` `starts with "Outbound Call - "`) are stored as filter criteria on `Report` metadata and are not practically greppable the way Flow/Apex XML is — there isn't a cheap bulk-retrieve-and-grep path for report filter logic across an org's full report library, and a full report metadata retrieve is a much larger, noisier pull for a single string check.

**Action for an admin:** manually check any Salesforce report filtering `Task Subject` `starts with "Outbound Call - "` (or `"Inbound Call - "`) and switch it to `contains "Outbound Call | "` (or `contains "Inbound Call | "`) once the new format ships — a `starts with` filter on the old literal will silently stop matching new rows the day the format flips, with no error, just quietly-empty reports. Check both Outbound and Inbound variants, and any List View filters built the same way.
