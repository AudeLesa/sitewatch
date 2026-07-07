-- ===========================================================================
-- SiteWatch billing — Stripe Pro tier.  Run this AFTER schema.sql.
--
-- Pro unlocks saved-search email alerts; the public map (and contacts) stay free.
-- `profiles.is_pro` is flipped by the Stripe webhook (Cloudflare Pages Function);
-- the saved_searches INSERT policy enforces it in the database itself, so even a
-- crafted request can't create an alert without an active subscription.
-- ===========================================================================

-- (The profiles table itself is created in schema.sql — pending_alerts depends
-- on it. This file owns its RLS and the saved_searches write policies.)
alter table profiles enable row level security;
-- A user may read their own profile (to know if they're Pro). All writes happen via
-- the webhook's service-role key, which bypasses RLS.
drop policy if exists profiles_self_read on profiles;
create policy profiles_self_read on profiles for select using (auth.uid() = user_id);

-- The CANONICAL write policies for saved_searches (schema.sql deliberately
-- defines none — see the note there). Both INSERT and UPDATE require an active
-- Pro subscription (otherwise a one-month subscriber could keep retargeting a
-- surviving row forever), and the notify address is locked to the signed-in
-- user's own email so alerts can't be pointed at an arbitrary inbox.
drop policy if exists saved_searches_update       on saved_searches;
drop policy if exists saved_searches_insert_pro   on saved_searches;

create policy saved_searches_insert_pro on saved_searches
  for insert with check (
    auth.uid() = user_id
    and (email is null or lower(email) = lower(auth.jwt()->>'email'))
    and exists (select 1 from profiles p where p.user_id = auth.uid() and p.is_pro)
  );
create policy saved_searches_update on saved_searches
  for update using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and (email is null or lower(email) = lower(auth.jwt()->>'email'))
    and exists (select 1 from profiles p where p.user_id = auth.uid() and p.is_pro)
  );
