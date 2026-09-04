-- Attempt limits become per-(customer, number): each of a rep's numbers gets its
-- own maxAttempts budget to a customer (so rotation can swap numbers), guarded by
-- an overall per-customer ceiling across all numbers (anti-harassment backstop).
alter table campaign_configs
  add column if not exists per_customer_max_attempts integer not null default 15;
