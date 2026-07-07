-- ===========================================================================
-- SiteWatch billing — Stripe Pro tier.  Run this AFTER schema.sql.
--
-- Pro unlocks saved-search email alerts; the public map (and contacts) stay free.
-- `profiles.is_pro` is flipped by the Stripe webhook (Cloudflare Pages Function);
-- the saved_searches INSERT policy enforces it in the database itself, so even a
-- crafted request can't create an alert without an active subscription.
-- ===========================================================================

create table if not exists profiles (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  is_pro             boolean not null default false,
  stripe_customer_id text,
  status             text,            -- active | trialing | past_due | canceled | ...
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists profiles_customer_idx on profiles (stripe_customer_id);

alter table profiles enable row level security;
-- A user may read their own profile (to know if they're Pro). All writes happen via
-- the webhook's service-role key, which bypasses RLS.
drop policy if exists profiles_self_read on profiles;
create policy profiles_self_read on profiles for select using (auth.uid() = user_id);

-- Replace the single owner policy from schema.sql with granular ones so that
-- creating an alert (INSERT) additionally requires an active Pro subscription.
drop policy if exists saved_searches_owner       on saved_searches;
drop policy if exists saved_searches_select       on saved_searches;
drop policy if exists saved_searches_update       on saved_searches;
drop policy if exists saved_searches_delete       on saved_searches;
drop policy if exists saved_searches_insert_pro   on saved_searches;

create policy saved_searches_select on saved_searches
  for select using (auth.uid() = user_id);
create policy saved_searches_update on saved_searches
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy saved_searches_delete on saved_searches
  for delete using (auth.uid() = user_id);
create policy saved_searches_insert_pro on saved_searches
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from profiles p where p.user_id = auth.uid() and p.is_pro)
  );
