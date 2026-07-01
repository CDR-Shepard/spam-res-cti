-- Full human-readable call record kept in our DB so the Salesforce Task
-- Description can stay lean (rep notes + time) and org Chatter automations that
-- repost the disposition/description don't publish CTI diagnostics.
alter table calls
  add column if not exists sync_detail text;
