import { loadEnv } from './util/env.js';

loadEnv();

// Region registry. A region is one publishable dataset: how to pull it (which
// sources, targeted how), how to geocode it, and how the product presents it
// (labels, metro chips, permit deep links). Adding a market = adding an entry
// here + a source adapter; ids drive output filenames (data/<id>.geojson) and
// the `region` value on every record, so they must never be renamed casually.
// `public: true` regions are exported to dist/data/regions.json for the map;
// the rest are operational pull presets.
export const REGIONS = {
  houston: {
    id: 'houston',
    label: 'Houston, TX',
    state: 'TX',
    stateName: 'Texas',
    public: false, // pull preset only — the public Texas region covers it
    // Records pulled with this preset are a subset of the public Texas dataset
    // and must carry ITS region, or a houston load would flip shared DB rows
    // out of 'texas' and hide them from alerts and the digest.
    publicRegion: 'texas',
    // Harris County-ish bounding box [W,S,E,N]
    bbox: { minLng: -95.96, minLat: 29.49, maxLng: -94.91, maxLat: 30.17 },
    zipPrefixes: ['75', '76', '77', '78', '79'],
    valuation: { floor: 50000, cap: 5e9 },
    geocoder: { hard: 'txpts' },
    permitLinks: [{ prefix: 'TABS', label: 'TDLR ↗', url: 'https://www.tdlr.texas.gov/TABS/Search/Project/{permit}' }],
    sourceShort: 'TDLR',
    sourceName: 'TDLR TABS permit registrations',
    attribution: 'data: TDLR TABS',
    // Shovels targets geographies by id. Harris County (resolved from permit
    // geo_ids) spans the Houston metro core — Houston, Katy, Spring, Cypress,
    // Baytown, Bellaire, Tomball, etc. seedZip is a bootstrap fallback only.
    shovels: {
      seedZip: '77002',
      // Houston-MSA counties (resolved from permit geo_ids via scripts/probe-geo.mjs).
      geoIds: [
        '60WvITp61BU', // Harris (Houston, Katy, Spring, Cypress, Bellaire, Tomball)
        '6xlmh_sPvk0', // Fort Bend (Sugar Land, Missouri City)
        '65Sl5F-dH5o', // Montgomery (Conroe, The Woodlands)
        '68bGUg9BFD4', // Galveston (League City, Galveston)
        '63n8Th0_Tmk', // Chambers (Baytown side)
      ],
      // Known gap: Brazoria (Pearland/Lake Jackson) — its county_id wasn't
      // resolvable from sampled permits; revisit if that area looks thin.
    },
    // TDLR TABS targets geographies by numeric county code (see data/lookups/).
    // Houston-MSA core counties. Covers Houston, Katy, Sugar Land, Pasadena,
    // Spring, Cypress, The Woodlands, Conroe, Pearland, League City, Baytown, etc.
    tabs: {
      countyCodes: [
        2101, // Harris   (Houston, Katy, Spring, Cypress, Pasadena, Baytown, Tomball)
        2079, // Fort Bend (Sugar Land, Missouri City, Katy-south, Rosenberg)
        2167, // Montgomery (Conroe, The Woodlands, Spring-north)
        2084, // Galveston (League City, Galveston, Texas City, Friendswood)
        2020, // Brazoria  (Pearland, Lake Jackson, Alvin)
        2036, // Chambers  (Baytown-east, Mont Belvieu)
      ],
    },
  },

  // Whole-state region. TABS is statewide, so we skip the county filter entirely
  // and page the registry by date in one pass (~50k projects / 24mo; ~19k once
  // filtered to new construction + additions). A full run is long — see README.
  texas: {
    id: 'texas',
    label: 'Texas',
    state: 'TX',
    stateName: 'Texas',
    public: true,
    // Texas bounding box [W,S,E,N] (El Paso → Orange, Brownsville → Panhandle).
    bbox: { minLng: -106.65, minLat: 25.84, maxLng: -93.51, maxLat: 36.5 },
    // Pre-data map view + the quick-jump chips the app's Places pane shows.
    map: { center: [31.2, -98.5], zoom: 6 },
    metros: [
      { name: 'Houston', lat: 29.76, lng: -95.37, zoom: 10 },
      { name: 'DFW', lat: 32.85, lng: -97.03, zoom: 9 },
      { name: 'Austin', lat: 30.27, lng: -97.74, zoom: 10 },
      { name: 'San Antonio', lat: 29.42, lng: -98.49, zoom: 10 },
      { name: 'El Paso', lat: 31.77, lng: -106.44, zoom: 10 },
    ],
    // ZIP ranges for geocoder backfill; valuation sanity window ("fat-fingered"
    // flagging — TABS's legal floor is $50k, nothing in Texas exceeds a few $B).
    zipPrefixes: ['75', '76', '77', '78', '79'],
    valuation: { floor: 50000, cap: 5e9 },
    // Hard-case geocode tier: TxGIO statewide address points (Texas-only data).
    geocoder: { hard: 'txpts' },
    // Per-source permit deep links (prefix-matched against permitNumber).
    permitLinks: [{ prefix: 'TABS', label: 'TDLR ↗', url: 'https://www.tdlr.texas.gov/TABS/Search/Project/{permit}' }],
    sourceShort: 'TDLR',
    // Reads as "projects from <sourceName>" in the Ask-the-map prompt — keep
    // it phrased that way (matches the endpoint's Texas fallback exactly).
    sourceName: 'TDLR TABS permit registrations',
    attribution: 'data: TDLR TABS',
    exampleCities: 'Houston, Dallas, Austin, San Antonio', // SEO metro-directory copy
    tabs: {
      statewide: true, // no LocationCounty filter — query the whole state at once
      maxDetails: 100000, // effectively uncapped; override with TABS_MAX_DETAILS
    },
  },

  // First non-Texas region: Seattle city limits via SDCI building permits
  // (src/sources/seattleSdci.js — Socrata, Public Domain, daily refresh,
  // rows arrive pre-geocoded). Much thinner than statewide TABS: ~100 new
  // non-res builds + ~2k addition/alterations per 24 months.
  seattle: {
    id: 'seattle',
    label: 'Seattle, WA',
    state: 'WA',
    stateName: 'Washington',
    // Flips true at launch — after the per-source quality gate passes AND the
    // user signs off. public:false keeps it out of regions.json/SEO/CI deploys
    // while the pipeline and gate remain fully runnable locally.
    public: false,
    // Seattle city limits-ish [W,S,E,N]
    bbox: { minLng: -122.46, minLat: 47.47, maxLng: -122.2, maxLat: 47.76 },
    map: { center: [47.62, -122.33], zoom: 11 },
    metros: [
      { name: 'Downtown', lat: 47.605, lng: -122.334, zoom: 14 },
      { name: 'South Lake Union', lat: 47.625, lng: -122.337, zoom: 14 },
      { name: 'U District', lat: 47.661, lng: -122.313, zoom: 13 },
      { name: 'Ballard', lat: 47.668, lng: -122.384, zoom: 13 },
      { name: 'West Seattle', lat: 47.566, lng: -122.387, zoom: 13 },
    ],
    zipPrefixes: ['98'],
    // No legal registration floor (unlike TABS's $50k) — small permits are
    // legitimate; only flag the truly implausible.
    valuation: { floor: 500, cap: 2e9 },
    geocoder: {}, // rows carry lat/lon; Census picks up the stragglers, no hard tier
    permitLinks: [
      // {raw} = permit number with the synthetic 'SEA-' prefix stripped —
      // the portal only knows the bare number.
      { prefix: 'SEA-', label: 'Seattle SDCI ↗', url: 'https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId={raw}' },
    ],
    sourceShort: 'SDCI',
    sourceName: 'Seattle SDCI building permits',
    recordNoun: 'Official', // "Official SDCI record ↗" (a city agency, not a state one)
    attribution: 'data: Seattle SDCI',
    // What this source actually provides — the UI degrades from these flags
    // (no owner/architect means no "owner" filters or empty company sections).
    capabilities: { valuation: true, contractor: true, owner: false, architect: false, squareFeet: false, publicFunds: false, tenant: false },
    sdci: { domain: 'data.seattle.gov', datasetId: '76t5-zqzr' },
  },

  // New York City — dual-feed DOB source (src/sources/nycDob.js): DOB NOW
  // job filings + GC-permit join, plus legacy BIS permits for pre-2021 jobs
  // still building on renewals; BIN-keyed cross-feed merge. Non-residential
  // New Building only (mixed-use towers with dwelling units = multifamily,
  // out of scope like Texas).
  nyc: {
    id: 'nyc',
    label: 'New York City',
    state: 'NY',
    stateName: 'New York',
    public: false, // flips true at launch — after the quality gate + user sign-off
    // NYC five-borough bounding box [W,S,E,N]
    bbox: { minLng: -74.26, minLat: 40.49, maxLng: -73.69, maxLat: 40.92 },
    map: { center: [40.71, -73.98], zoom: 11 },
    metros: [
      { name: 'Manhattan', lat: 40.776, lng: -73.971, zoom: 12 },
      { name: 'Brooklyn', lat: 40.65, lng: -73.95, zoom: 12 },
      { name: 'Queens', lat: 40.73, lng: -73.79, zoom: 12 },
      { name: 'Bronx', lat: 40.85, lng: -73.87, zoom: 12 },
      { name: 'Staten Island', lat: 40.58, lng: -74.15, zoom: 12 },
    ],
    zipPrefixes: ['10', '11'],
    valuation: { floor: 1000, cap: 5e9 },
    geocoder: {}, // rows carry lat/lon; Census picks up stragglers
    permitLinks: [], // deep links are record-computed (sourceUrl) — the DOB NOW portal is login-walled
    sourceShort: 'DOB',
    sourceName: 'NYC DOB permit filings',
    recordNoun: 'Official',
    attribution: 'data: NYC DOB',
    capabilities: { valuation: true, contractor: true, owner: true, architect: false, squareFeet: true, publicFunds: false, tenant: false },
    nycDob: {
      domain: 'data.cityofnewyork.us',
      filingsDataset: 'w9ak-ipjd',  // DOB NOW: Build – Job Application Filings
      permitsDataset: 'rbx6-tga4',  // DOB NOW: Build – Approved Permits (GC join)
      bisDataset: 'ipu4-2q9a',      // legacy DOB Permit Issuance (BIS)
    },
  },
};

// Permit-number prefixes, by source id. A source that declares one guarantees
// every permitNumber it emits carries it (asserted at pull time) — that is what
// keeps history keys and the DB's permit_number collision-safe across regions.
// Multi-feed sources declare one prefix per feed (an array). Sources without
// a prefix get history-keyed by the source-scoped record id.
export const SOURCE_PERMIT_PREFIXES = { tdlr_tabs: 'TABS', sdci_seattle: 'SEA-', nyc_dob: ['NYCN-', 'NYCB-'] };

const env = process.env;

export const config = {
  city: env.SITEWATCH_CITY || 'houston',

  // "Currently under construction" is a heuristic: neither source exposes a
  // true "construction in progress" flag, so we approximate it as
  //   new-construction commercial permit, issued within `lookbackMonths`,
  //   not yet finalized / closed / expired.
  lookbackMonths: Number(env.SITEWATCH_LOOKBACK_MONTHS || 24),

  // A project counts as a "new start" for this many days after we observe it cross
  // into construction (inspections). Drives the map's "Just started" feed + alerts.
  justStartedDays: Number(env.SITEWATCH_JUST_STARTED_DAYS || 30),

  // Normalized categories that count as "commercial" for the MVP.
  commercialCategories: ['commercial', 'industrial', 'institutional'],
  includeMultifamily: false,

  // Work classes that count as "under construction" (vs. a sign permit etc.).
  buildWorkClasses: ['new_construction', 'addition', 'shell'],

  // Require a positive build classification. Shovels "commercial" is mostly noise
  // (registrations, signs, "not construction related"), so for precision we drop
  // anything we can't positively identify as new construction.
  requireBuildClass: true,

  sources: {
    shovels: {
      enabled: Boolean(env.SHOVELS_API_KEY),
      apiKey: env.SHOVELS_API_KEY || '',
      baseUrl: env.SHOVELS_BASE_URL || 'https://api.shovels.ai/v2',
      // Comma-separated geo override; else the city preset's geoIds (Harris).
      geoIds: env.SHOVELS_GEO_IDS ? env.SHOVELS_GEO_IDS.split(',').map((s) => s.trim()) : null,
      propertyTypes: ['commercial', 'office', 'industrial'],
      // Server-side description focus. 'new' cuts the 10k+ commercial firehose down
      // to permits whose description mentions "new" (new construction), keeping the
      // scan fast and on-target. Set SHOVELS_FOCUS_QUERY='' for an exhaustive scan.
      focusQuery: env.SHOVELS_FOCUS_QUERY ?? 'new',
      // permit_status=active is barely populated in Houston, so we don't filter on it.
      maxRecords: Number(env.SHOVELS_MAX_RECORDS || 10000),
      pageSize: 100,
    },
    // TDLR TABS — Texas Architectural Barriers System. FREE, statewide, no key,
    // no login. State law requires every non-residential project ≥ $50k to be
    // registered here *before construction begins*, and exposes a real lifecycle
    // (Registered → Review → Inspection → Closed) — our best "is it actually being
    // built" signal. This is the primary source; Shovels/Houston are supplemental.
    tdlrTabs: {
      enabled: env.TABS_ENABLED ? env.TABS_ENABLED !== 'false' : true,
      // TDLR blocks datacenter IPs (CI runners). Point TABS_BASE_URL at the
      // Cloudflare Pages proxy (/tdlr/TABS) + set TABS_PROXY_KEY to route the
      // pull through Cloudflare's egress. Unset = hit TDLR directly (works from
      // residential IPs / local runs).
      baseUrl: env.TABS_BASE_URL || 'https://www.tdlr.texas.gov/TABS',
      proxyKey: env.TABS_PROXY_KEY || '',
      // County codes to pull; else the active city preset's tabs.countyCodes.
      countyCodes: env.TABS_COUNTY_CODES
        ? env.TABS_COUNTY_CODES.split(',').map((s) => Number(s.trim()))
        : null,
      // TDLR "Type of Work" codes to keep. 9001 New Construction, 9003 Additions.
      // Add 9002 (Renovation/Alteration — i.e. tenant build-outs) via TABS_INCLUDE_RENOVATIONS=1.
      workTypes: env.TABS_INCLUDE_RENOVATIONS ? [9001, 9003, 9002] : [9001, 9003],
      pageSize: 100, // TDLR caps page length at 100 regardless of what we ask
      // Fetch search pages with bounded concurrency (the statewide scan is ~500
      // pages). Kept modest to stay polite to a government server.
      searchConcurrency: Number(env.TABS_SEARCH_CONCURRENCY || 4),
      maxPerCounty: Number(env.TABS_MAX_PER_COUNTY || 5000),
      // Cap detail-page fetches per run (politeness + speed). Address/owner/architect
      // come from the per-project page; new-construction is a minority of rows, so
      // this rarely binds. Precedence: env > city preset (tabs.maxDetails) > 4000.
      maxDetails: env.TABS_MAX_DETAILS ? Number(env.TABS_MAX_DETAILS) : null,
      detailConcurrency: Number(env.TABS_DETAIL_CONCURRENCY || 5),
    },
    houstonSoldPermits: {
      enabled: true,
      formUrl: 'http://cohtora.houstontx.gov/approot/soldpermits/online_permit.htm',
      // CONFIRMED via a real captured submit:
      //   servlet = /ibi_apps/WFServlet.ibfs (https), server = EDASERVE,
      //   Managed Reporting needs a session (JSESSIONID + Citrix cookies) AND an
      //   IBIWF_SES_AUTH_TOKEN obtained from a WF_CHECKSERVERACCESS handshake.
      // STILL NEEDED: the report-execution request's body (sub_action + IBIF_ex/
      //   fex + the SELTD/BDT/EDT amper vars) — captured next.
      servlet: env.HOUSTON_WF_SERVLET || 'https://cohtora.houstontx.gov/ibi_apps/WFServlet.ibfs',
      ibifEx: env.HOUSTON_WF_EX || '',
    },
  },

  geocoder: {
    // U.S. Census geocoder — free, no key, no rate-limit auth.
    benchmark: 'Public_AR_Current',
    concurrency: 6,
    // Fallback for Census misses (mostly brand-new construction addresses):
    //   'nominatim' (default, free, no key, ≤1 req/s) | 'none' to disable.
    // If LOCATIONIQ_KEY is set, LocationIQ is used instead (free key, faster).
    fallback: env.GEOCODER_FALLBACK || 'nominatim',
    // Max fallback lookups per run (politeness + bounded runtime). The disk cache
    // makes runs additive — re-run to keep filling in misses. Raise/lower freely.
    fallbackMax: Number(env.GEOCODER_FALLBACK_MAX || 2500),
    // Hard-case tier (e.g. 'txpts' — TxGIO statewide address points: exact
    // new-address hits, nearest-number street snaps, intersections). Default
    // comes from the active region's manifest; GEOCODER_HARD overrides
    // ('none' disables).
    hard: env.GEOCODER_HARD || null,
    hardMax: Number(env.GEOCODER_HARD_MAX || 800),
    locationiqKey: env.LOCATIONIQ_KEY || '',
    // Nominatim requires a real, identifying User-Agent.
    userAgent: env.GEOCODER_USER_AGENT || 'SiteWatch construction map (contact: audelesauvage@gmail.com)',
  },

  output: { dir: 'data' },
};

export function activeRegion() {
  return regionById(config.city);
}

export function regionById(id) {
  const r = REGIONS[id];
  if (!r) throw new Error(`Unknown region preset: ${id}. Known: ${Object.keys(REGIONS).join(', ')}`);
  return r;
}
