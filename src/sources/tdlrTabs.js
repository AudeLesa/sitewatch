import { join } from 'node:path';
import { config, activeCity } from '../config.js';
import { projectRoot } from '../util/env.js';
import { writeFileAtomic, loadStateFile } from '../util/fsafe.js';
import { fetchWithRetry, fetchText, mapLimit } from '../util/http.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';

// ---------------------------------------------------------------------------
// TDLR TABS — Texas Architectural Barriers System.  FREE · statewide · no key.
//
// Texas law (Gov. Code ch. 469) requires every non-residential "building or
// facility to which the public has access" with construction cost ≥ $50k to be
// registered with the state *before construction begins*. That makes TABS the
// closest thing Texas has to an "ADS-B for buildings": one mandatory, statewide
// signal for commercial construction, with a real lifecycle we can lean on.
//
// It's a jQuery-DataTables search backed by a plain JSON endpoint (reverse-
// engineered from /TABS/search + its projectSearch bundle):
//
//   POST /TABS/Search/SearchProjects     DataTables body + filter fields
//        -> { draw, recordsTotal, recordsFiltered, data:[ row, ... ] }
//        row = { ProjectNumber, ProjectId, ProjectName, FacilityName,
//                City (code), County (code), TypeOfWork (code), EstimatedCost,
//                ProjectStatus (code), ProjectCreatedOn, EstimatedStartDate,
//                EstimatedEndDate, DataVersionId }
//   GET  /TABS/Search/Project/{number}   HTML detail page — adds the street
//        address, owner, design firm (architect) and square footage.
//
// Filter fields (we use these): LocationCounty, RegistrationDateBegin/End
// (mm/dd/yyyy). City/County come back as numeric codes decoded via the `Lookup`
// table embedded in the search page.
// ---------------------------------------------------------------------------

export const id = 'tdlr_tabs';

// TypeOfWork codes -> normalized work class.
const WORK_TYPE = {
  9001: WORK_CLASS.NEW_CONSTRUCTION,
  9002: WORK_CLASS.REMODEL, // Renovation/Alteration (tenant build-outs)
  9003: WORK_CLASS.ADDITION,
  9004: WORK_CLASS.OTHER, // Historic Preservation
  9005: WORK_CLASS.OTHER, // Public Right of Way
};

// ProjectStatus code -> { status, stage prior, lifecycle stage }. The prior is
// P(actively being built) *for the stage alone*; src/pipeline/lifecycle.js then
// adjusts it with the declared start/end dates and expires finished projects.
//
// Stage semantics (Gov. Code ch. 469): registration precedes construction; RAS
// plan review happens before/early in the build; the accessibility INSPECTION
// happens at/after COMPLETION (§469.105) — so inspection stages mean the
// project is finishing or finished, not peak-active (the pre-2026-07 mapping
// had this inverted, scoring finished buildings 0.9).
const STATUS_MAP = {
  3008: { status: STATUS.ISSUED, confidence: 0.55, stage: 'pre',       label: 'Project Registered' },
  3010: { status: STATUS.ISSUED, confidence: 0.6,  stage: 'review',    label: 'Review Pending' },
  3004: { status: STATUS.ISSUED, confidence: 0.6,  stage: 'review',    label: 'Preliminary Plan Review' },
  3006: { status: STATUS.ISSUED, confidence: 0.6,  stage: 'review',    label: 'Preliminary Review Pending' },
  3005: { status: STATUS.ISSUED, confidence: 0.5,  stage: 'review',    label: 'Miscellaneous' },
  3009: { status: STATUS.ACTIVE, confidence: 0.7,  stage: 'building',  label: 'Review Complete' },
  3003: { status: STATUS.ACTIVE, confidence: 0.35, stage: 'finishing', label: 'Inspection Scheduled' },
  3002: { status: STATUS.ACTIVE, confidence: 0.3,  stage: 'finishing', label: 'Inspection Process' },
  3001: { status: STATUS.ACTIVE, confidence: 0.12, stage: 'finished',  label: 'Inspection Completed' },
  3007: { status: STATUS.FINALIZED, confidence: 0, stage: 'closed',    label: 'Project Closed' },
};

export async function fetchPermits({ log = console.error } = {}) {
  const cfg = config.sources.tdlrTabs;
  if (!cfg.enabled) {
    log('[tdlr_tabs] disabled (TABS_ENABLED=false) — skipping.');
    return [];
  }

  const cityTabs = activeCity().tabs || {};
  const statewide = cityTabs.statewide === true;
  const counties = statewide ? [null] : cfg.countyCodes || cityTabs.countyCodes || [];
  if (!counties.length) {
    log('[tdlr_tabs] no county codes for this city — skipping.');
    return [];
  }
  // maxDetails precedence: env (cfg.maxDetails) > city preset > 4000 default.
  const maxDetails = cfg.maxDetails ?? cityTabs.maxDetails ?? 4000;

  // 1. One page load establishes a session cookie and gives us the code lookups.
  const session = await openSession(cfg, log);
  // Schema-drift tripwire: empty lookups mean the search page markup changed.
  // Without city names every address loses its city and geocoding collapses —
  // better to fail the run than publish a silently degraded dataset.
  if (!Object.keys(session.lookup.CITIES).length || !Object.keys(session.lookup.COUNTIES).length) {
    throw new Error('TABS search page no longer exposes the CITIES/COUNTIES lookups — markup drift, aborting.');
  }
  const from = mmddyyyy(monthsAgo(config.lookbackMonths));
  const to = mmddyyyy(new Date());

  // 2. Page through each county (or the whole state at once), keeping only build
  //    work types (client-side).
  const rows = [];
  for (const county of counties) {
    const got = await searchCounty(cfg, session, county, from, to, log);
    rows.push(...got);
  }
  const builds = rows.filter((r) => cfg.workTypes.includes(r.TypeOfWork) && r.ProjectStatus !== 3007);
  const scope = statewide ? 'statewide' : `${counties.length} counties`;
  log(`[tdlr_tabs] ${rows.length} projects across ${scope} → ${builds.length} build-type & active.`);

  // 3. Enrich with the per-project detail page (street address, owner, architect).
  //    These fields are static once a project is registered, so we cache them to
  //    disk; re-runs skip TDLR entirely and maxDetails caps only NEW fetches.
  const detailCache = loadDetailCache();
  const cached = [];
  const uncached = [];
  for (const row of builds) {
    const hit = detailCache[row.ProjectNumber];
    if (hit) {
      row._detail = hit;
      cached.push(row);
    } else {
      uncached.push(row);
    }
  }
  const toFetch = uncached.slice(0, maxDetails);
  const leftover = uncached.length - toFetch.length;
  log(
    `[tdlr_tabs] details: ${cached.length} cached, fetching ${toFetch.length} new` +
      (leftover > 0 ? ` (maxDetails=${maxDetails}; ${leftover} left — re-run to fetch them)` : '') +
      '.'
  );

  let done = 0;
  let failed = 0;
  await mapLimit(toFetch, cfg.detailConcurrency, async (row) => {
    const detail = await fetchDetail(cfg, session, row.ProjectNumber).catch(() => null);
    row._detail = detail;
    // Only cache parses that actually captured content: an empty {} here means
    // the page markup drifted (or an error page slipped through), and the cache
    // never expires — caching it would freeze this project as address-less even
    // after the parser is fixed. Uncached rows retry on the next run.
    if (detail && (detail['location address'] || detail['owner name'])) detailCache[row.ProjectNumber] = detail;
    else failed++;
    done++;
    if (done % 100 === 0) log(`[tdlr_tabs] details ${done}/${toFetch.length}`);
    if (done % 1000 === 0) saveDetailCache(detailCache); // checkpoint long runs
  });
  saveDetailCache(detailCache);
  if (failed) log(`[tdlr_tabs] ${failed} detail fetches failed (not cached — will retry next run).`);

  // Only emit projects we actually have detail for (others lack an address).
  const enriched = [...cached, ...toFetch.filter((r) => r._detail != null)];
  return enriched.map((row) => mapProject(row, session.lookup));
}

// --- session / lookups ------------------------------------------------------

async function openSession(cfg, log) {
  const res = await fetchWithRetry(`${cfg.baseUrl}/search`, { headers: { 'User-Agent': UA } });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const html = await res.text();
  const lookup = {
    CITIES: grabLookup(html, 'CITIES'),
    COUNTIES: grabLookup(html, 'COUNTIES'),
  };
  log(`[tdlr_tabs] session ok (${Object.keys(lookup.CITIES).length} cities, ${Object.keys(lookup.COUNTIES).length} counties)`);
  return { cookie, lookup };
}

// The page ships `Lookup.CITIES = {...}; Lookup.COUNTIES = {...};` inline.
function grabLookup(html, name) {
  const key = `Lookup.${name} = `;
  const i = html.indexOf(key);
  if (i < 0) return {};
  const start = html.indexOf('{', i);
  let depth = 0;
  for (let j = start; j < html.length; j++) {
    if (html[j] === '{') depth++;
    else if (html[j] === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, j + 1));
      } catch {
        return {};
      }
    }
  }
  return {};
}

// --- search -----------------------------------------------------------------

async function searchCounty(cfg, session, county, from, to, log) {
  const label = county == null ? 'statewide' : `county ${county}`;

  // First page also returns the total, so we can fetch the rest in parallel.
  const first = await searchPage(cfg, session, county, from, to, 0, log);
  if (!first) {
    // Can't even fetch page one after retries: fail loudly rather than let the
    // run "succeed" with zero rows for this scope.
    throw new Error(`TABS search failed for ${label} after retries.`);
  }
  // Schema-drift tripwire: DataTables always returns a numeric total; anything
  // else means the response shape changed and pagination would silently stop.
  const found = first.total ?? first.rows.length;
  if (!Number.isFinite(Number(found)) || (first.rows.length > 0 && !first.rows[0].ProjectNumber)) {
    throw new Error('TABS SearchProjects response shape changed (no total / no ProjectNumber) — aborting.');
  }
  // Statewide is bounded only by the result count; per-county respects maxPerCounty.
  const limit = county == null ? found : Math.min(found, cfg.maxPerCounty);

  const offsets = [];
  for (let s = cfg.pageSize; s < limit; s += cfg.pageSize) offsets.push(s);

  const out = [...first.rows];
  const failed = [];
  await mapLimit(offsets, cfg.searchConcurrency, async (start) => {
    const page = await searchPage(cfg, session, county, from, to, start, log);
    if (page) out.push(...page.rows);
    else failed.push(start); // collect to retry — never silently drop a page
  });
  // Retry any pages that failed under concurrency (transient errors), serially.
  const stillFailed = [];
  for (const start of failed) {
    const page = await searchPage(cfg, session, county, from, to, start, log);
    if (page) out.push(...page.rows);
    else stillFailed.push(start);
  }
  // `found` is sampled once and the registry moves under us, so tolerate a few
  // rows of drift — but a genuinely lost page is up to pageSize rows, way past it.
  const expected = Math.min(limit, found);
  if (stillFailed.length || out.length < expected - 3) {
    // A permanently-missing page means we'd publish a silently short dataset.
    // Finish the run (caches still fill in), but exit non-zero so CI treats it
    // as a failure and does not deploy the shrunken output.
    log(`[tdlr_tabs] ⚠ ${label}: collected ${out.length} of ~${expected} — ${stillFailed.length} page(s) permanently failed; marking run incomplete.`);
    process.exitCode = 1;
  }

  log(`[tdlr_tabs] ${label}: ${out.length} projects (registered ${from}–${to}).`);
  return out;
}

/** Fetch one page of search results. Returns { rows, total } or null on failure. */
async function searchPage(cfg, session, county, from, to, start, log) {
  try {
    const res = await fetchWithRetry(`${cfg.baseUrl}/Search/SearchProjects`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: `${cfg.baseUrl}/search`,
        Origin: 'https://www.tdlr.texas.gov',
        Cookie: session.cookie,
      },
      body: searchBody({ county, from, to, start, length: cfg.pageSize }),
    });
    const data = await res.json();
    return { rows: data.data || [], total: data.recordsFiltered ?? data.recordsTotal };
  } catch (err) {
    log(`[tdlr_tabs] ${county == null ? 'statewide' : `county ${county}`} page@${start} failed: ${err.message}`);
    return null;
  }
}

// DataTables server-side payload + the SearchProjects filter fields.
const COLUMNS = [
  ['ProjectId', false, false], ['ProjectNumber', true, true], ['ProjectName', true, true],
  ['ProjectCreatedOn', true, true], ['ProjectStatus', true, true], ['FacilityName', true, true],
  ['City', true, true], ['County', true, true], ['TypeOfWork', true, true],
  ['EstimatedCost', true, true], ['DataVersionId', false, true],
];
function searchBody({ county, from, to, start, length }) {
  const p = new URLSearchParams();
  p.set('draw', '1');
  COLUMNS.forEach(([name, searchable, orderable], i) => {
    p.append(`columns[${i}][data]`, String(i));
    p.append(`columns[${i}][name]`, name);
    p.append(`columns[${i}][searchable]`, String(searchable));
    p.append(`columns[${i}][orderable]`, String(orderable));
    p.append(`columns[${i}][search][value]`, '');
    p.append(`columns[${i}][search][regex]`, 'false');
  });
  p.append('order[0][column]', '3'); // ProjectCreatedOn
  p.append('order[0][dir]', 'desc');
  p.set('start', String(start));
  p.set('length', String(length));
  p.set('search[value]', '');
  p.set('search[regex]', 'false');
  if (county != null) p.set('LocationCounty', String(county)); // omitted = statewide
  p.set('RegistrationDateBegin', from);
  p.set('RegistrationDateEnd', to);
  return p.toString();
}

// --- detail page ------------------------------------------------------------

async function fetchDetail(cfg, session, projectNumber) {
  const html = await fetchText(
    `${cfg.baseUrl}/Search/Project/${encodeURIComponent(projectNumber)}`,
    { headers: { 'User-Agent': UA, Cookie: session.cookie } },
    { retries: 2, timeoutMs: 15000 }
  );
  return parseDetail(html);
}

// The detail page renders label/value pairs as <label>Foo:</label><span>Bar</span>
// (and dt/dd, strong/span variants). Collect them into a lowercase-keyed map.
function parseDetail(html) {
  const pairs = {};
  const re =
    /<(?:dt|th|label|strong|b)[^>]*>\s*([A-Za-z][^<>]{1,40}?)\s*:?\s*<\/(?:dt|th|label|strong|b)>\s*<(?:dd|td|span|p|div)[^>]*>\s*([^<]{1,160})\s*</gi;
  let m;
  while ((m = re.exec(html))) {
    const k = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    const v = decodeEntities(m[2].trim());
    if (v && !(k in pairs)) pairs[k] = v;
  }
  return pairs;
}

// --- mapping ----------------------------------------------------------------

function mapProject(row, lookup) {
  const d = row._detail || {};
  const cityName = lookup.CITIES?.[String(row.City)] || null;
  const line1 = cleanLine(d['location address']) || null;
  const st = STATUS_MAP[row.ProjectStatus] || { status: STATUS.UNKNOWN, confidence: null, stage: null, label: null };
  const facility = row.FacilityName || d['facility name'] || null;

  return makeRecord({
    source: id,
    sourceId: row.ProjectId,
    permitNumber: row.ProjectNumber,
    category: classifyCategory(`${row.ProjectName || ''} ${facility || ''}`),
    workClass: WORK_TYPE[row.TypeOfWork] || WORK_CLASS.UNKNOWN,
    status: st.status,
    confidence: st.confidence,
    lifecycleStage: st.stage,
    description: describe(row, facility, st.label),
    valuation: num(row.EstimatedCost),
    squareFeet: num(d['square footage']),
    issuedDate: isoDay(row.ProjectCreatedOn),
    estStartDate: isoDay(row.EstimatedStartDate),
    estEndDate: isoDay(row.EstimatedEndDate),
    finalizedDate: row.ProjectStatus === 3007 ? isoDay(row.EstimatedEndDate) : null,
    owner: d['owner name'] || null,
    ownerPhone: d['owner phone'] || null,
    ownerAddress: d['owner address'] || null,
    designFirm: d['design firm name'] || null,
    designFirmPhone: d['design firm phone'] || null,
    designFirmAddress: d['design firm address'] || null,
    contactName: d['contact name'] || null,
    scopeOfWork: d['scope of work'] || null,
    publicFunds: fundsToBool(d['type of funds']),
    facilityName: facility,
    address: {
      line1,
      city: cityName,
      county: lookup.COUNTIES?.[String(row.County)] || null,
      state: 'TX',
      zip: null,
      // Detail page only gives a street; pair it with the city decoded from the row.
      full: line1 && cityName ? `${line1}, ${cityName}, TX` : line1 || (facility && cityName ? null : null),
    },
    raw: row,
  });
}

function describe(row, facility, statusLabel) {
  const work = WORK_LABEL[row.TypeOfWork] || 'Construction';
  const name = row.ProjectName || facility || '';
  const bits = [work];
  if (name) bits.push(`— ${name}`);
  if (statusLabel) bits.push(`(${statusLabel})`);
  return bits.join(' ');
}

const WORK_LABEL = {
  9001: 'New construction', 9002: 'Renovation/alteration', 9003: 'Addition',
  9004: 'Historic preservation', 9005: 'Public right of way',
};

// TABS is non-residential by law; split into the map's color buckets by keyword.
const INSTITUTIONAL = /\b(hospital|medical|clinic|health|surgery|school|isd|elementary|middle school|high school|academy|university|college|campus|church|worship|chapel|library|courthouse|city hall|fire station|police|jail|detention|civic|museum|va )\b/i;
const INDUSTRIAL = /\b(warehouse|distribution|logistics|manufactur|plant|refinery|industrial|fabrication|terminal|cold storage|data center)\b/i;
function classifyCategory(text) {
  if (INSTITUTIONAL.test(text)) return CATEGORY.INSTITUTIONAL;
  if (INDUSTRIAL.test(text)) return CATEGORY.INDUSTRIAL;
  return CATEGORY.COMMERCIAL;
}

// --- helpers ----------------------------------------------------------------

const UA = 'Mozilla/5.0 (SiteWatch; +https://github.com/sitewatch) construction-radar';

// Strip unit/building/floor designators and half-addresses that defeat the
// Census geocoder; the bare street number + name geocodes far more reliably.
function cleanLine(s) {
  if (!s) return s;
  let t = String(s)
    .replace(/\b(bldg|building|bld|ste|suite|unit|apt|rm|room|fl|floor)\b\.?\s*#?\s*[\w-]+/gi, '')
    .replace(/#\s*[\w-]+/g, '')
    .replace(/\b\d+\/\d+\b/g, '') // "25810 1/2" -> "25810"
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim();
  return t || String(s).trim();
}

function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
// TABS "type of funds" -> public (true) / private (false) / unknown (null).
function fundsToBool(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('public') || s.includes('federal')) return true;
  if (s.includes('private')) return false;
  return null;
}
function isoDay(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}
function mmddyyyy(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}

// --- detail cache -----------------------------------------------------------
// Parsed project detail keyed by ProjectNumber. Detail fields are immutable once
// registered, so entries never expire — delete the file to force a re-fetch.
const DETAIL_CACHE_PATH = join(projectRoot, config.output.dir, 'tabs-detail-cache.json');

function loadDetailCache() {
  return loadStateFile(DETAIL_CACHE_PATH);
}
function saveDetailCache(cache) {
  writeFileAtomic(DETAIL_CACHE_PATH, JSON.stringify(cache));
}
