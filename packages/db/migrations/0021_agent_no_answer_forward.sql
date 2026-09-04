-- Agent-level no-answer failover. When an inbound callback to ANY DID a rep is
-- rung on isn't answered on their softphone within the forward window, the call
-- rings this number (their cell) before falling back to voicemail. One number
-- per rep, applied to every number they own — set by the rep themselves via
-- PATCH /auth/me. Null = ring the softphone the full default window, then
-- voicemail (unchanged behavior).
alter table users
  add column if not exists no_answer_forward_e164 text;
