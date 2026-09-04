-- Every dispositioned call also posts ONE Chatter feed item on its related
-- record (ruling 2026-08-26). This id makes that idempotent across sync
-- retries: once set, syncOne never posts again for this call.
alter table calls
  add column if not exists chatter_feed_element_id text;
