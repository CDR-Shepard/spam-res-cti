-- =============================================================================
-- 0036_tenancy.sql — organizations become real tenants; users get kind /
-- external auth id / super-admin; email uniqueness moves from global to
-- per-tenant; every existing org gets an "AI Agent" service user.
-- Spec: docs/superpowers/specs/2026-09-03-outreach-foundation-design.md §4
-- =============================================================================

alter table organizations add column if not exists slug text;
alter table organizations add column if not exists timezone text not null default 'America/Los_Angeles';
alter table organizations add column if not exists settings jsonb not null default '{}'::jsonb;
alter table organizations add column if not exists status text not null default 'active';
alter table organizations add column if not exists workos_org_id text;

-- Backfill slugs from names: lowercase, runs of non-alphanumerics -> '-', trimmed.
update organizations
   set slug = trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')))
 where slug is null;
-- Empty results and collisions (all but the lowest id in a group) get 8 chars of the id.
update organizations o
   set slug = coalesce(nullif(o.slug, ''), 'org') || '-' || left(o.id::text, 8)
 where o.slug = ''
    or exists (select 1 from organizations x where x.slug = o.slug and x.id < o.id);

alter table organizations alter column slug set not null;
create unique index if not exists organizations_slug_unique on organizations (slug);
create unique index if not exists organizations_workos_org_id_unique
  on organizations (workos_org_id) where workos_org_id is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_status_check') then
    alter table organizations add constraint organizations_status_check check (status in ('active', 'suspended'));
  end if;
end $$;

alter table users add column if not exists kind text not null default 'human';
alter table users add column if not exists external_auth_id text;
alter table users add column if not exists is_super_admin boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_kind_check') then
    alter table users add constraint users_kind_check check (kind in ('human', 'service'));
  end if;
end $$;

-- Per-tenant email uniqueness (the same person may be a user in two tenants).
drop index if exists users_email_unique;
create unique index if not exists users_org_email_unique on users (org_id, email);
create unique index if not exists users_external_auth_id_unique
  on users (external_auth_id) where external_auth_id is not null;

-- One AI Agent service user per existing tenant. New tenants get theirs from createTenant().
insert into users (org_id, email, display_name, kind, timezone)
select o.id, 'ai-agent@' || o.slug || '.internal', 'AI Agent', 'service', o.timezone
  from organizations o
 where not exists (select 1 from users u where u.org_id = o.id and u.kind = 'service');
