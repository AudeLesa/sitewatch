# SiteWatch

A data pipeline for **every commercial construction site currently being built** —
think FlightRadar/MarineTraffic, but for construction. It fetches building-permit
data, normalizes it, merges across sources, filters to "currently under
construction," geocodes it, emits map-ready GeoJSON, and serves a dark
FlightRadar-style [map](#map-web-ui) on top of it.

**MVP scope:** Houston, TX, commercial. Residential and other metros are later.

## Why permits?

Planes and boats are trackable because they *broadcast* their position (ADS-B /
AIS). Construction sites broadcast nothing — the closest thing to a signal is the
**building permit**. A project's lifecycle (applied → issued → inspections →
certificate of occupancy) is the trackable trail. "Under construction now" is
approximated as: a commercial **new-construction** permit, **issued** within the
lookback window, **not yet finalized**.

## Data sources

| Source | Status | Notes |
|---|---|---|
| **TDLR TABS** (`src/sources/tdlrTabs.js`) | ✅ **live · primary** | **Free, statewide, no key, no login.** Texas requires every non-residential project ≥ $50k to be registered before construction begins. Yields ~580 active commercial build sites in Harris County alone per 4 months. This is the spine. See [TDLR TABS](#tdlr-tabs-the-primary-source). |
| **Shovels** (`src/sources/shovels.js`) | ✅ live (paid) | Clean REST API, pre-geocoded. [$599/mo](https://docs.shovels.ai/docs/knowledge-base/getting-started/pricing-structure); free tier is a hard total test cap. Now **supplemental** — use the trial to cross-check/enrich TABS. Set `SHOVELS_API_KEY`. |
| **Houston Sold Permits** (`src/sources/houstonSoldPermits.js`) | deferred | Free, site-level, Houston-only WebFOCUS scrape. **Superseded by TABS** (which covers Houston + the whole metro for free). Left stubbed for optional local depth. |
| **Geocoder** (`src/pipeline/geocode.js`) | ✅ working | Free, no key. **Census → OSM/Nominatim fallback chain + disk cache.** Census misses brand-new construction (address not in its file yet); Nominatim recovers ~half of those. Every lookup is cached to `data/geocode-cache.json`, so re-runs are instant and fill in misses additively. See [Geocoding](#geocoding). |
| **demo** (`src/sources/demo.js`) | ✅ working | Real Houston addresses, fake permit data — exercises the whole pipeline with no credentials. |

### TDLR TABS (the primary source)

The closest thing Texas has to "ADS-B for buildings." State law (Gov. Code ch. 469)
requires every non-residential *"building or facility to which the public has
access"* with construction cost **≥ $50k** to be registered with the state
**before construction begins** — a single, mandatory, statewide signal.

- **Access:** the public search at `tdlr.texas.gov/tabs/search` is a jQuery
  DataTables UI backed by a plain JSON endpoint. **Anonymous, free, no key** —
  `POST /TABS/Search/SearchProjects` returns `{recordsTotal, data:[…]}`; the
  per-project page `GET /TABS/Search/Project/{number}` adds street address, owner,
  design firm (architect) and square footage.
- **Filtering:** by `LocationCounty` (numeric code) + `RegistrationDateBegin/End`
  (mm/dd/yyyy). City/County come back as codes, decoded via the `Lookup` table
  embedded in the search page (also cached in `data/lookups/`). Houston-MSA county
  codes are pinned in the `houston` preset (`src/config.js`).
- **The lifecycle signal we wanted:** `ProjectStatus` is a real funnel —
  `Registered → Review Complete → Inspection Scheduled → Inspection Process →
  Inspection Completed → Closed`. We map each step to a `confidence` ∈ [0,1]
  (≈ P(actively building)); `Closed` is treated as terminal and dropped.
- **Precision:** we keep `TypeOfWork` ∈ {New Construction, Additions} by default
  (set `TABS_INCLUDE_RENOVATIONS=1` to add tenant build-outs), filtered client-side
  before fetching detail pages, so detail traffic stays small and polite.
- **Detail cache:** parsed detail pages are cached to `data/tabs-detail-cache.json`
  keyed by project number. Detail fields are immutable once registered, so entries
  never expire — re-runs skip TDLR for anything already seen, and `TABS_MAX_DETAILS`
  caps only *new* fetches (so coverage fills in additively across runs). Delete the
  file to force a full re-fetch.
- **Knobs:** `TABS_COUNTY_CODES`, `TABS_MAX_PER_COUNTY`, `TABS_MAX_DETAILS`,
  `TABS_DETAIL_CONCURRENCY`, `TABS_INCLUDE_RENOVATIONS`, `TABS_ENABLED=false`.

Rejected during recon (so we don't re-investigate):
- **data.texas.gov (Socrata):** no TABS/project or site-level Houston permit
  dataset — only `TDLR — All Licenses` (people, not projects).
- TABS `SearchProjects` 302s to a login page if the DataTables `columns[]` payload
  is malformed — it is *not* actually auth-gated; send the full column array.

### How the Shovels source works

- **Geo:** `geo_id` is required and the `/geos` lookup 404s, so we bootstrap
  Houston's `city_id` from one permit at a seed ZIP (77002). Override with `SHOVELS_GEO_ID`.
- **Volume vs. noise:** `property_type=commercial` returns 10k+ permits, but most
  are registrations / signs / "not construction related". We scan broadly
  (`SHOVELS_MAX_RECORDS`, default 8000) and **classify client-side**, keeping only
  positively-identified new construction (`requireBuildClass` in `src/config.js`).
- **Caveats on Houston data:** Shovels' `status` is sparsely populated here
  (mostly `in_review`/null), so we lean on `issue_date` + classification rather
  than status. `job_value` is present on a minority of records.

Rejected during recon (kept here so we don't re-investigate):
- Houston ArcGIS `Building_Permits` layer → **aggregate only** (quarterly $ by area), not site-level.
- Weekly `.xls` permit reports → **discontinued Dec 2025**, archive-only.

## Geocoding

Permits arrive with a street address, not coordinates, so we geocode. Two stages
plus a cache:

1. **U.S. Census** (`Public_AR_Current`) — free, no key, runs concurrently. Great
   for established addresses, but it **systematically misses brand-new
   construction** (the address isn't in its TIGER file yet) — i.e. exactly what
   SiteWatch tracks. On a full statewide run it placed ~55% of build projects.
2. **Fallback** — OpenStreetMap **Nominatim** (free, no key, rate-limited to
   ≤1 req/s) recovers roughly half of Census's misses. Set `LOCATIONIQ_KEY` to use
   LocationIQ instead (free key, ~2× faster, higher cap).

Every lookup — hit **or** miss — is cached to `data/geocode-cache.json` keyed by
the query, with the providers already tried. Consequences:

- **Re-runs are near-instant** for addresses already resolved (the demo's cached
  pass returns in ~2 ms).
- **Misses fill in additively**: each run does up to `fallbackMax` *new* fallback
  lookups (default 2500, ~1/s ≈ 45 min), so re-running `pull:texas` a few times
  progressively recovers the long tail without ever re-doing work.
- **Dead addresses** (intersections, "various locations") are negative-cached and
  never retried.
- Results are **bbox-checked** against the active city, so a fuzzy match can't drop
  a pin in the wrong state.

Knobs: `GEOCODER_FALLBACK` (`nominatim` | `none`), `GEOCODER_FALLBACK_MAX`,
`LOCATIONIQ_KEY`, `GEOCODER_USER_AGENT`. Quick check: `node scripts/try-geocode.mjs texas 6`.

## Architecture

```
sources/*  ──►  normalize (schema.js)  ──►  dedupe  ──►  filter  ──►  geocode  ──►  writers
(per-source)    common record shape       merge dup    "under      add lat/lng   GeoJSON +
                                           projects     construction"             JSON
```

Every source maps its raw rows into one **normalized record** (`src/schema.js`),
so adding a new city or feed is just a new file in `src/sources/`.

## Quickstart

```bash
cd sitewatch
node --version          # needs >= 20 (uses global fetch); built/tested on 24
cp .env.example .env    # optional — only needed for Shovels / Houston

npm run demo            # full pipeline on sample data -> data/houston.geojson
npm run geocode:test    # prove the Census geocoder is live
npm run sources         # see which sources are configured
npm run pull            # the real run — Houston metro -> data/houston.geojson
npm run pull:texas      # the WHOLE STATE -> data/texas.geojson (long; see below)
```

### Scope: one metro vs. all of Texas

- `npm run pull` uses the **`houston`** preset (6 Houston-MSA counties).
- `npm run pull:texas` uses the **`texas`** preset — TABS is statewide, so it skips
  the county filter and pages the entire registry in one pass. Expect ~50k projects
  over 24 months, ~19k after filtering to new construction + additions, each needing
  a detail-page fetch + geocode. **It's a long run (tens of minutes) and heavier on
  the state/geocoder servers** — paced politely on purpose. Cap a first pass with
  `$env:TABS_MAX_DETAILS="2000"; npm run pull:texas`.
- The map auto-loads `texas.geojson` if present, else `houston.geojson`, and titles
  itself accordingly.

Outputs land in `data/`:
- `houston.geojson` — map-ready points (this is the product)
- `houston.json` — full normalized records
- `houston.ungeocoded.json` — anything we couldn't place

## Map (web UI)

```bash
npm run serve        # local server at http://localhost:5173
```

A dark, MarineTraffic-style app (`web/index.html`) that loads `data/texas.geojson`
(falling back to `data/houston.geojson`, then the demo). Built for the full ~14k-site
dataset:

- **Collapsible left panel** (MarineTraffic-style ‹/› toggle; map resizes to fill;
  state remembered) and a slide-in **right detail panel** on click.
- **Base-layer switcher** (Dark / Light / **Satellite**), **hover tooltips** (name +
  value), and a **legend** (category colors, just-started/new rings, size ∝ value).
- **Marker clustering** (Leaflet.markercluster) so 10k+ points stay smooth.
- **Filter sidebar** — category & work-type chips, a *min-likelihood-of-active-
  construction* slider (the TABS confidence tier), min declared value, "registered
  within", a **new-this-week** toggle, and full-text search (address/owner/architect/
  project).
- **Results list** synced to the map (sort by newest / value / size); click to fly to
  a site.
- **Detail panel** with the full record + a **deep link back to the project's live
  TDLR page**, plus a shareable `#p=<permit>` URL.
- Live stat counters, "data through" date, and new sites ringed in yellow.

Re-run a pull and refresh — no rebuild, it just re-reads the GeoJSON.

### Ship it to the web

```bash
npm run build        # assemble a static dist/ (minified GeoJSON + the app)
```

`dist/` deploys to any static host (Cloudflare Pages, Netlify, GitHub Pages). Full
steps in [DEPLOY.md](DEPLOY.md).

## Finishing Houston

> **Optional / deferred.** TDLR TABS now covers Houston (and the whole metro)
> for free with no login, so this WebFOCUS scrape is no longer on the critical
> path. Kept only as potential local depth/redundancy.

Status: **validated, not yet automated.** Confirmed via live recon + real captured requests:

- **Servlet:** `https://cohtora.houstontx.gov/ibi_apps/WFServlet.ibfs` (https, `.ibfs` suffix).
- **Server:** `EDASERVE`. **Report:** an `online_permit_se.fex` variant.
- **Field map:** `SELTD=CM` (commercial), `BDT`/`EDT` (dates, YYYYMMDD), `PTYPE`, `edit4/5` (valuation).
- **Session:** Managed Reporting requires `JSESSIONID` + Citrix cookies **and** an
  `IBIWF_SES_AUTH_TOKEN`, obtained on page load via a `WF_CHECKSERVERACCESS`
  handshake. The client also fires `getToolPolicy` housekeeping XHRs.
- **Gotcha:** the report opens in a **popup** and is a *document navigation*
  (not an XHR), so it's invisible under the Network panel's Fetch/XHR filter.

**The one missing piece** is the report-execution request body (the `MR_RUN_FEX`
sub-action + the `SELTD`/`BDT`/`EDT` amper vars). To capture it:

1. Run a **Commercial** search; the results open in a popup.
2. Focus the popup, F12 → **Network**, **All** filter (not XHR), Preserve log on.
3. Reload the popup (Ctrl+R → "Resend"), then **Ctrl+F** in the Network panel and
   search `SELTD` — that highlights the report request.
4. Copy it as cURL. Set `HOUSTON_WF_SERVLET`/`HOUSTON_WF_EX` in `.env` and port the
   body + handshake into `fetchReport()` in `src/sources/houstonSoldPermits.js`.

`scripts/try-houston.mjs` replays the request while dialing it in. (Shovels needs
none of this and already covers Houston — the free source is redundancy + local
depth, so it's safe to defer.)

## Config knobs (`.env`)

- `ANTHROPIC_API_KEY` — **Cloudflare Pages env var** (not `.env`): enables the map's
  "✨ Ask the map" natural-language search (`functions/api/ask.js`, Claude translates
  questions like "tilt-wall warehouses near me over $5M" into filters). Without it
  the box gracefully falls back to keyword search.
- `SITEWATCH_LOOKBACK_MONTHS` (default 24) — how far back an issued permit still counts as "active."
- `SHOVELS_GEO_ID` — pin Shovels to a specific Houston/Harris geography id.
- `commercialCategories`, `includeMultifamily`, `buildWorkClasses` — in `src/config.js`.

## Roadmap

- [x] **Free statewide primary source — TDLR TABS** (`src/sources/tdlrTabs.js`)
- [x] Map UI consuming `*.geojson` (`npm run serve`)
- [x] **Product-grade web app** — clustering, filter sidebar, results list, detail
      panel w/ TDLR deep-links, confidence/value/date filters, new-this-week
- [x] **Static build + deploy** (`npm run build` → `dist/`; see DEPLOY.md)
- [x] Confidence tiers from the permit lifecycle (TABS `ProjectStatus`)
- [x] **Geocode recovery** — Census → OSM/Nominatim (or LocationIQ) fallback chain
- [x] Geocode caching (`data/geocode-cache.json`; instant re-runs, additive fill-in)
- [ ] County-appraisal-district parcel matching for the hardest misses (intersections,
      no-number sites) — the last tier Nominatim still can't place
- [x] Detail-page caching (`data/tabs-detail-cache.json`; re-runs skip TDLR)
- [ ] Optional SQLite output (`node:sqlite`) for incremental/diff runs + history
- [ ] Cross-source dedupe tuning (TABS↔Shovels collide poorly — different date bases)
- [x] **Statewide (all of Texas)** — `npm run pull:texas` (`texas` preset, no
      county filter; ~50k projects / 24mo, ~19k after the build filter)
- [ ] Per-metro presets for focused views (Dallas, Austin, San Antonio) — just
      add county codes like the `houston` preset
- [x] **Live on the web** — Cloudflare Pages (https://sitewatch-eyt.pages.dev)
- [x] **Daily auto-refresh** — `npm run refresh`/`publish` + GitHub Actions workflow
      (cache-accelerated ~10-min re-pulls; concurrent search paging)
- [x] **Alerts backend scaffolded** — Supabase schema + zero-dep loader + email
      alert worker (saved searches → Resend digests). See [backend/](backend/).
- [x] **Frontend auth + "🔔 Alert me about this search"** — sign-in (magic link) +
      save current map filters as an alert; degrades gracefully without config
- [x] **Contact enrichment** — owner & architect **phone + address** and a contact
      name on every project, surfaced from the (already-cached) TABS detail pages →
      map detail panel (click-to-call), GeoJSON, DB, and alert emails
- [x] **Stripe Pro tier** — map stays free; saved-search alerts gated behind a
      subscription (Checkout + signature-verified webhook as Cloudflare Pages
      Functions, Pro-status RLS, upgrade UI). See [BILLING.md](BILLING.md).
- [x] **SEO pages** ([scripts/seo.mjs](scripts/seo.mjs)) — static, crawlable
      `/project/<permit>` pages (one per project) + `/where/<metro>` landing pages +
      `sitemap.xml`/`robots.txt`, generated at build from the dataset, cross-linked
      from the app. ~14.9k indexable URLs. The organic-growth engine.
- [x] **Project history + "new starts"** ([src/pipeline/history.js](src/pipeline/history.js))
      — cross-run status diffing (`data/history.json`) → `firstSeenAt` / `startedAt` /
      "🚧 just started construction" feed + an `event:'started'` alert. Surfaced in the
      map, project pages, and DB. Baseline seeded; starts populate as projects advance.
- [x] **Company pages + market report** — `/company/<slug>` per owner/architect (3+
      projects, ~1.5k pages), `/companies.html` index, and `/insights.html` (a live
      market report: $-by-metro/category, top owners & architects). Cross-linked from
      project pages + the app. `npm run build` now does a clean rebuild (no stale pages).
- [ ] General-**contractor** name — *not* available in free open data (verified:
      Austin & Dallas permit datasets omit it); needs a paid feed or per-jurisdiction
      scraping. The `contractor` field is reserved for it.
- [ ] Per-metro presets for focused views (Dallas, Austin, San Antonio)
- [ ] Finalize Houston WebFOCUS scrape *(optional — superseded by TABS)*
