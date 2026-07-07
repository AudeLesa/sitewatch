import { loadEnv } from './util/env.js';

loadEnv();

// City presets. Each preset describes how to target a metro across sources.
// bbox is used both to sanity-filter geocoded points and (later) to request
// only the relevant tiles from each source.
export const CITIES = {
  houston: {
    id: 'houston',
    label: 'Houston, TX',
    state: 'TX',
    // Harris County-ish bounding box [W,S,E,N]
    bbox: { minLng: -95.96, minLat: 29.49, maxLng: -94.91, maxLat: 30.17 },
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

  // Whole-state preset. TABS is statewide, so we skip the county filter entirely
  // and page the registry by date in one pass (~50k projects / 24mo; ~19k once
  // filtered to new construction + additions). A full run is long — see README.
  texas: {
    id: 'texas',
    label: 'Texas (all)',
    state: 'TX',
    // Texas bounding box [W,S,E,N] (El Paso → Orange, Brownsville → Panhandle).
    bbox: { minLng: -106.65, minLat: 25.84, maxLng: -93.51, maxLat: 36.5 },
    tabs: {
      statewide: true, // no LocationCounty filter — query the whole state at once
      maxDetails: 100000, // effectively uncapped; override with TABS_MAX_DETAILS
    },
  },
};

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
      baseUrl: env.TABS_BASE_URL || 'https://www.tdlr.texas.gov/TABS',
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
    locationiqKey: env.LOCATIONIQ_KEY || '',
    // Nominatim requires a real, identifying User-Agent.
    userAgent: env.GEOCODER_USER_AGENT || 'SiteWatch construction map (contact: audelesauvage@gmail.com)',
  },

  output: { dir: 'data' },
};

export function activeCity() {
  return cityById(config.city);
}

export function cityById(id) {
  const c = CITIES[id];
  if (!c) throw new Error(`Unknown city preset: ${id}. Known: ${Object.keys(CITIES).join(', ')}`);
  return c;
}
