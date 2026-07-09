-- ===========================================================================
-- SiteWatch backend schema  (Supabase / Postgres + PostGIS)
--
-- Powers the first paid feature: users save a search ("new warehouses > $5M
-- within 50 mi of Houston") and get an email when a matching project appears.
--
-- Layers:
--   projects        — the live dataset, loaded from each pipeline refresh.
--   saved_searches  — a user's named filter + alert preference.
--   alerts_sent     — what we've already emailed (so we never double-send).
--
-- Auth/users come from Supabase's built-in `auth.users`; we only reference it.
-- Apply with:  psql "$DATABASE_URL" -f backend/schema.sql   (or the SQL editor).
-- ===========================================================================

create extension if not exists postgis;

-- ---------------------------------------------------------------------------
-- projects: one row per construction site, upserted by the loader each refresh.
-- `first_seen` is the alert trigger — a row whose first_seen is newer than a
-- saved search's last check is a candidate to email.
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id              text primary key,              -- stable record id from the pipeline
  permit_number   text unique,                    -- prefix-scoped per source (pipeline-asserted)
  region          text not null default 'texas',  -- region registry id (src/config.js REGIONS)
  category        text,                           -- commercial | industrial | institutional
  work_class      text,                           -- new_construction | addition | ...
  status          text,
  confidence      real,                           -- 0..1  (P actively building)
  description     text,
  facility_name   text,
  valuation       bigint,
  square_feet     integer,
  issued_date     date,                           -- registration date
  est_start_date  date,
  est_end_date    date,
  started_at      date,                            -- observed cross into construction (inspections)
  status_changed_at date,
  address         text,
  city            text,
  county          text,
  zip             text,
  lat             double precision,
  lng             double precision,
  -- Auto-derived from lat/lng so the loader never touches PostGIS directly.
  geom            geography(Point, 4326)
                    generated always as (st_setsrid(st_makepoint(lng, lat), 4326)::geography) stored,
  owner           text,
  owner_phone     text,
  owner_address   text,
  architect       text,
  architect_phone text,
  tenant          text,           -- who's moving in (retail/office build-outs)
  tenant_phone    text,
  ras_name        text,           -- registered accessibility specialist on the project
  ras_phone       text,
  contact_name    text,
  scope_of_work   text,
  public_funds    boolean,
  contractor      text,           -- general contractor (not in free TX data; reserved)
  source          text,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now()
);

create index if not exists projects_geom_idx       on projects using gist (geom);
create index if not exists projects_first_seen_idx  on projects (first_seen desc);
create index if not exists projects_category_idx    on projects (category);
create index if not exists projects_value_idx       on projects (valuation desc);
create index if not exists projects_region_idx      on projects (region);
-- (databases created before regions existed: apply backend/migrations/2026-07-09-region.sql)

-- ---------------------------------------------------------------------------
-- profiles: per-user billing state (is_pro is flipped by the Stripe webhook).
-- Lives here (not billing.sql) because pending_alerts depends on it: alerts
-- stop the moment a subscription lapses, even if a webhook was missed.
-- RLS/policies for it are in billing.sql.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  is_pro             boolean not null default false,
  stripe_customer_id text,
  status             text,            -- active | trialing | past_due | canceled | ...
  current_period_end timestamptz,
  updated_at         timestamptz not null default now()
);
create index if not exists profiles_customer_idx on profiles (stripe_customer_id);

-- ---------------------------------------------------------------------------
-- digest_subscribers: the free weekly-digest list — the ungated top of the
-- funnel. Anyone may subscribe (insert); nobody may read the list back through
-- the anon API. The worker (service key) reads it and sends the digest.
-- ---------------------------------------------------------------------------
create table if not exists digest_subscribers (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique,
  region     text not null default 'texas',  -- which region's digest they get
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table digest_subscribers enable row level security;
drop policy if exists digest_public_insert on digest_subscribers;
create policy digest_public_insert on digest_subscribers
  for insert to anon, authenticated with check (true);

-- ---------------------------------------------------------------------------
-- saved_searches: a user's filter + how/whether to alert on it.
-- `filters` mirrors the front-end controls; `last_alert_at` marks how far we've
-- already notified so the worker only considers newer projects.
-- ---------------------------------------------------------------------------
create table if not exists saved_searches (
  id            uuid primary key default gen_random_uuid(),
  -- default auth.uid(): the client insert doesn't (and shouldn't) send user_id;
  -- without the default every insert fails the not-null constraint.
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name          text not null,
  email         text,                             -- notify-to address (set from the user's email at save time)
  filters       jsonb not null default '{}',      -- {region, categories, workClasses, minValue, minConfidence, q, center:{lat,lng}, radiusMi}
  alert_email   boolean not null default true,
  active        boolean not null default true,
  last_alert_at timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- (idempotent for databases created before the default existed)
alter table saved_searches alter column user_id set default auth.uid();

create index if not exists saved_searches_user_idx on saved_searches (user_id);

-- ---------------------------------------------------------------------------
-- alerts_sent: dedupe ledger — one row per (search, project) already emailed.
-- ---------------------------------------------------------------------------
create table if not exists alerts_sent (
  saved_search_id uuid not null references saved_searches (id) on delete cascade,
  project_id      text not null references projects (id) on delete cascade,
  sent_at         timestamptz not null default now(),
  primary key (saved_search_id, project_id)
);

-- ---------------------------------------------------------------------------
-- matcher: given a saved search, return projects first seen since `since` that
-- satisfy its filters. Used by the alert worker and by "preview matches" in the UI.
-- ---------------------------------------------------------------------------
create or replace function projects_matching(s saved_searches, since timestamptz)
returns setof projects
language sql stable as $$
  select p.* from projects p
  -- a normal alert fires when a project first appears; a "started" alert fires when
  -- it crosses into construction (started_at). null started_at is excluded for those.
  where (case when s.filters->>'event' = 'started' then p.started_at::timestamptz else p.first_seen end) > since
    -- region scoping: a search only ever matches its own region's projects.
    -- Searches saved before regions existed carry no region key -> 'texas'.
    and p.region = coalesce(s.filters->>'region', 'texas')
    and (s.filters->'categories'   is null or p.category   = any (select jsonb_array_elements_text(s.filters->'categories')))
    and (s.filters->'workClasses'  is null or p.work_class = any (select jsonb_array_elements_text(s.filters->'workClasses')))
    and (s.filters->>'minValue'      is null or p.valuation  >= (s.filters->>'minValue')::bigint)
    and (s.filters->>'minConfidence' is null or coalesce(p.confidence,0) >= (s.filters->>'minConfidence')::real)
    -- q searches the same fields the map's search box does (address, description,
    -- owner, architect, facility) so a saved alert matches what the user saw.
    and (s.filters->>'q' is null or
         (p.address ilike '%'||(s.filters->>'q')||'%' or p.facility_name ilike '%'||(s.filters->>'q')||'%'
          or p.owner ilike '%'||(s.filters->>'q')||'%' or p.architect ilike '%'||(s.filters->>'q')||'%'
          or p.description ilike '%'||(s.filters->>'q')||'%'))
    and (s.filters->'center' is null or p.geom is null or
         st_dwithin(
           p.geom,
           st_point((s.filters#>>'{center,lng}')::float, (s.filters#>>'{center,lat}')::float)::geography,
           coalesce((s.filters->>'radiusMi')::float, 50) * 1609.34   -- miles → metres
         ));
$$;

-- ---------------------------------------------------------------------------
-- pending_alerts: every (active search × newly-seen matching project) that hasn't
-- been emailed yet. The alert worker selects this, emails, then records in
-- alerts_sent. Bounded to projects first seen in the last `lookback_days` so the
-- scan stays small; alerts_sent guarantees no duplicates.
-- ---------------------------------------------------------------------------
create or replace function pending_alerts(lookback_days int default 14)
returns table (
  saved_search_id uuid, email text, search_name text,
  project_id text, permit_number text, facility_name text, address text,
  category text, valuation bigint, confidence real, owner text, owner_phone text
)
language sql stable as $$
  select s.id, s.email, s.name,
         p.id, p.permit_number, p.facility_name, p.address, p.category, p.valuation, p.confidence,
         p.owner, p.owner_phone
  from saved_searches s
  -- Alerts are the Pro product: gate on is_pro HERE, not just at insert time,
  -- so a canceled subscriber's surviving searches stop emailing immediately —
  -- even if a Stripe webhook was missed.
  join profiles pr on pr.user_id = s.user_id and pr.is_pro
  -- Per-search floor at last_alert_at: a brand-new search starts from its
  -- creation moment instead of dumping the whole lookback window as "new".
  cross join lateral projects_matching(
    s, greatest(coalesce(s.last_alert_at, now()), now() - make_interval(days => lookback_days))
  ) p
  where s.active and s.alert_email and s.email is not null
    and not exists (
      select 1 from alerts_sent a where a.saved_search_id = s.id and a.project_id = p.id
    );
$$;

-- ---------------------------------------------------------------------------
-- Row-level security: projects are public-readable; saved searches & the alert
-- ledger are private to their owner. (Writes to projects happen via the loader's
-- service-role key, which bypasses RLS.)
-- ---------------------------------------------------------------------------
alter table projects       enable row level security;
alter table saved_searches enable row level security;
alter table alerts_sent    enable row level security;

drop policy if exists projects_public_read on projects;
create policy projects_public_read on projects
  for select using (true);

-- Owners can read and delete their searches. WRITE policies (insert/update)
-- live canonically in billing.sql, where they also require an active Pro
-- subscription — defining them here too caused a footgun: re-running this file
-- after billing.sql would silently re-open un-gated writes (Postgres ORs
-- policies together). Without billing.sql applied, saves are denied — safe.
drop policy if exists saved_searches_owner on saved_searches;
drop policy if exists saved_searches_select on saved_searches;
drop policy if exists saved_searches_delete on saved_searches;
create policy saved_searches_select on saved_searches
  for select using (auth.uid() = user_id);
create policy saved_searches_delete on saved_searches
  for delete using (auth.uid() = user_id);

drop policy if exists alerts_sent_owner on alerts_sent;
create policy alerts_sent_owner on alerts_sent
  for select using (
    exists (select 1 from saved_searches s where s.id = alerts_sent.saved_search_id and s.user_id = auth.uid())
  );
