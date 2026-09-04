-- Sticky caller ID per (rep, lead): the DID a rep last called a recipient (lead)
-- from, so future calls to that lead reuse the same number (better answer rates
-- + reputation). Keyed per-rep because rotation only ever dials a rep's OWN pool
-- — a single shared row would just thrash between reps. Last-used-wins.
create table if not exists sticky_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  assigned_user_id uuid not null references users(id) on delete cascade,
  recipient_e164 text not null,
  e164 text not null,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists sticky_org_user_recipient_unique
  on sticky_numbers (org_id, assigned_user_id, recipient_e164);
