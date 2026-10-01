# Power-dial recordings and connected-call Tasks

Every power-dial call bridged to a rep gets a row in `dialer_connects`, a
dual-channel recording of the prospect's leg (from the bridge on), and ONE
completed Call Task on the screen-popped record with the public recording link
in `tdc_cti__Recording_URL__c`. Design:
`docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md`.

## Switches (Railway `@cti/api` variables — changing one restarts the service)

| Variable | Default | `off` means |
|---|---|---|
| `TWILIO_RECORD_CALLS` | `true` | NO calls are recorded — click-to-dial and power dial |
| `DIALER_RECORDING` | `on` | power-dial calls are not recorded; Tasks still logged |
| `DIALER_CONNECT_TASKS` | `on` | no power-dial Tasks or links; rows still written; turning it back on logs only the last 24 h |

A two-party org (`campaign_configs.recording_consent_mode = 'two_party'` on the
`default` campaign) never has power-dial calls recorded — that path has no
automated disclosure.

## Reading a row

- `recording_state`: `pending` (row just written) · `requested` (started) · `start_failed` (Twilio refused —
  usually the prospect hung up first) · `skipped_consent` · `skipped_switch`.
- `task_state`: `pending` · `created` · `skipped_not_owner` (the rep does not own
  the record — the click-to-dial rule) · `expired` (bridged > 24 h ago) ·
  `failed` (6 tries; see `last_error`).
- `recording_link_synced_at` set with `last_error = 'recording link field
  rejected'` → the rep lacks the tdc_cti package license (UserPackageLicense).

## Checks (read-only SQL, via `railway run -s Postgres`)

```sql
-- Today's bridged calls by outcome
select task_state, recording_state, count(*)
from dialer_connects
where bridged_at > now() - interval '1 day'
group by 1, 2 order by 3 desc;

-- Anything stuck or failing
select id, user_id, task_state, task_attempts, link_attempts, last_error, bridged_at
from dialer_connects
where (task_state = 'failed')
   or (task_state = 'pending' and bridged_at < now() - interval '30 minutes')
   or (task_state = 'created' and recording_url is not null and recording_link_synced_at is null
       and updated_at < now() - interval '30 minutes')
order by bridged_at desc limit 50;
```

## Not covered

Power-dial calls before this shipped were never recorded — there is no audio to
recover.
