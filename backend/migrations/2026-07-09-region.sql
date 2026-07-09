-- ===========================================================================
-- Stage 0 expansion migration: region becomes a first-class column.
--
-- APPLY THIS BEFORE deploying the Stage 0 loader/worker (Supabase SQL editor,
-- or: psql "$DATABASE_URL" -f backend/migrations/2026-07-09-region.sql).
-- Everything here is idempotent; existing rows backfill to 'texas'.
--
-- Why: saved-search alerts and the weekly digest query the shared projects
-- table with no region scoping. The day a second region loads, every broad
-- Texas saved search would start emailing that region's projects to Texas
-- subscribers. projects_matching() below scopes every alert to the search's
-- region (searches saved before this change coalesce to 'texas').
-- ===========================================================================

alter table projects add column if not exists region text not null default 'texas';
create index if not exists projects_region_idx on projects (region);

alter table digest_subscribers add column if not exists region text not null default 'texas';

-- Replaces schema.sql's matcher: identical filters plus the region predicate.
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
