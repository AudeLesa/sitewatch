import { config, activeRegion } from '../config.js';
import { fetchJson } from '../util/http.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';

// ---------------------------------------------------------------------------
// Shovels v2 adapter.  Docs: https://docs.shovels.ai/api-reference/permits/search-permits
//   GET /permits/search   auth: X-API-Key header
//   params:  geo_id (req), permit_from/permit_to (req, YYYY-MM-DD), property_type
//   paging:  cursor-based (size<=100, next_cursor)
//   permit:  { id, number, type, subtype, status, property_type, description,
//              job_value (CENTS), file_date, issue_date, final_date,
//              address:{ street_no, street, city, state, zip_code, latlng:[lat,lng] },
//              geo_ids:{ city_id, county_id, jurisdiction_id } }
//
// Houston reality (measured): property_type=commercial returns 10k+ rows, but
// most are noise (registrations, signs, "not construction related"). We pull
// broadly and classify client-side, keeping only positively-identified builds.
// ---------------------------------------------------------------------------

export const id = 'shovels';

export async function fetchPermits({ log = console.error } = {}) {
  const cfg = config.sources.shovels;
  if (!cfg.apiKey) {
    log('[shovels] no SHOVELS_API_KEY set — skipping.');
    return [];
  }

  const geoIds = await resolveGeoIds(log);
  if (!geoIds.length) {
    log('[shovels] no geo target for this city preset (e.g. statewide texas) — skipping.');
    return [];
  }
  const from = isoDate(monthsAgo(config.lookbackMonths));
  const to = isoDate(new Date());
  const focus = cfg.focusQuery ? `&permit_q=${encodeURIComponent(cfg.focusQuery)}` : '';
  const out = [];

  let stop = false; // set when the API signals quota exhaustion (402) etc.
  for (const geoId of geoIds) {
    if (stop) break;
    for (const propertyType of cfg.propertyTypes) {
      if (stop) break;
      let cursor = '';
      let pulled = 0;
      while (pulled < cfg.maxRecords) {
        const url =
          `${cfg.baseUrl}/permits/search?geo_id=${encodeURIComponent(geoId)}` +
          `&permit_from=${from}&permit_to=${to}&property_type=${propertyType}${focus}` +
          `&size=${cfg.pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

        let data;
        try {
          data = await fetchJson(url, { headers: authHeaders(cfg) });
        } catch (err) {
          // Don't discard everything fetched so far — keep partial results. A 402
          // means the account is out of credits; further calls are pointless.
          const quota = /HTTP 402/.test(err.message);
          log(`[shovels] stopped after ${out.length} records: ${err.message}${quota ? ' (API quota/credits exhausted)' : ''}`);
          stop = true;
          break;
        }
        const items = data.items || [];
        for (const item of items) out.push(mapPermit(item));
        pulled += items.length;

        cursor = data.next_cursor;
        if (!cursor || items.length === 0) break;
      }
      log(`[shovels] ${propertyType} @ ${geoId}: scanned ${pulled}${focus ? ` (q="${cfg.focusQuery}")` : ''}`);
    }
  }

  return out;
}

/** Resolve the geo_id(s) to query: env override, city preset, else bootstrap from a seed ZIP. */
export async function resolveGeoIds(log = console.error) {
  const cfg = config.sources.shovels;
  if (cfg.geoIds?.length) return cfg.geoIds; // SHOVELS_GEO_IDS override

  const city = activeRegion();
  if (city.shovels?.geoIds?.length) return city.shovels.geoIds; // preset (Harris County)

  const zip = city.shovels?.seedZip;
  if (!zip) return []; // no Shovels geo target for this preset (e.g. statewide texas)

  // Bootstrap a geo_id from a seed ZIP. Tolerate failure (e.g. 402 out-of-credits)
  // by returning [] so the source just skips instead of aborting the whole pull.
  try {
    const url =
      `${cfg.baseUrl}/permits/search?geo_id=${zip}&permit_from=2024-01-01` +
      `&permit_to=${isoDate(new Date())}&property_type=commercial&size=1`;
    const data = await fetchJson(url, { headers: authHeaders(cfg) });
    const geo = data.items?.[0]?.geo_ids;
    const resolved = geo?.city_id || geo?.county_id;
    if (!resolved) return [];
    log(`[shovels] bootstrapped geo_id=${resolved} from seed ZIP ${zip}`);
    return [resolved];
  } catch (err) {
    log(`[shovels] geo bootstrap failed (${err.message}) — skipping.`);
    return [];
  }
}

function authHeaders(cfg) {
  return { 'X-API-Key': cfg.apiKey, Accept: 'application/json' };
}

function mapPermit(p) {
  const a = p.address || {};
  const line1 = [a.street_no, a.street].filter(Boolean).join(' ') || null;
  return makeRecord({
    source: id,
    sourceId: p.id,
    permitNumber: p.number,
    category: refineCategory(mapCategory(p.property_type), p),
    workClass: classifyWork(p),
    status: mapStatus(p.status, p.final_date),
    description: p.description || p.subtype || p.type || null,
    valuation: centsToDollars(p.job_value),
    appliedDate: p.file_date || null,
    issuedDate: p.issue_date || null,
    finalizedDate: p.final_date || null,
    contractor: p.contractor_id ? `shovels:${p.contractor_id}` : null,
    address: { line1, city: a.city, state: a.state, zip: a.zip_code },
    location: latlng(a),
    raw: p,
  });
}

// --- classification ---------------------------------------------------------

const EXCLUDE = [
  'not construction related', 'contractor registration', 'registration',
  'right-of-way', 'right of way', 'driveway', 'backflow', 'sign', 'banner',
  'fireworks', 'special event', 'temporary', 'change of occupancy',
  'occupancy inspection', 'license', 'fence', 'irrigation',
];

// Census-style structure-type subtypes that denote *new* nonresidential builds.
const NEW_STRUCTURE = [
  'stores & other', 'mercantile', 'merchantile', 'amusement', 'recreational',
  'office', 'bank', 'professional', 'industrial', 'service station',
  'school', 'educational', 'hospital', 'institutional', 'parking garage',
  'hotel', 'motel', 'tourist', 'church', 'religious', 'public works',
  'other nonresidential', 'structures other than buildings',
];

const ALTER_WORDS = ['alteration', 'remodel', 'renovation', 'repair', 'tenant', 'finish out', 'build out', 'buildout', 'interior', 'addition to'];

function classifyWork(p) {
  const s = [p.subtype, p.type, p.description].filter(Boolean).join(' ').toLowerCase();
  if (!s) return WORK_CLASS.UNKNOWN;
  if (EXCLUDE.some((w) => s.includes(w))) return WORK_CLASS.OTHER;
  if (/\bdemo/.test(s)) return WORK_CLASS.DEMOLITION;
  if (s.includes('shell')) return WORK_CLASS.SHELL;
  if (/\baddition\b/.test(s) && !s.includes('addition to')) return WORK_CLASS.ADDITION;
  if (/\bnew\b/.test(s)) return WORK_CLASS.NEW_CONSTRUCTION; // \bnew\b ignores "renew"/"renovation"
  const isAlter = ALTER_WORDS.some((w) => s.includes(w));
  if (!isAlter && NEW_STRUCTURE.some((w) => s.includes(w))) return WORK_CLASS.NEW_CONSTRUCTION;
  if (isAlter) return WORK_CLASS.REMODEL;
  return WORK_CLASS.UNKNOWN;
}

function mapCategory(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('office')) return CATEGORY.COMMERCIAL;
  if (s.includes('commercial')) return CATEGORY.COMMERCIAL;
  if (s.includes('industrial')) return CATEGORY.INDUSTRIAL;
  if (s.includes('institution') || s.includes('exempt') || s.includes('public')) return CATEGORY.INSTITUTIONAL;
  if (s.includes('residential')) return CATEGORY.RESIDENTIAL;
  return CATEGORY.UNKNOWN;
}

// Shovels mislabels some single-family homes as "commercial"; reclassify them to
// residential (then the commercial filter drops them). Apartments/multifamily
// are left as-is — they're commercial-scale development.
const SFR = /\b(s\.?\s?f\.?\s?res|single[- ]family|sfr|townhome|duplex|accessory dwelling|adu)\b/;
function refineCategory(category, p) {
  const desc = `${p.description || ''} ${p.subtype || ''}`.toLowerCase();
  if (SFR.test(desc) && !desc.includes('apt') && !desc.includes('apartment')) return CATEGORY.RESIDENTIAL;
  return category;
}

function mapStatus(v, finalDate) {
  const s = String(v || '').toLowerCase();
  if (finalDate || s === 'final') return STATUS.FINALIZED;
  if (s === 'inactive') return STATUS.EXPIRED;
  if (s === 'active') return STATUS.ACTIVE;
  if (s === 'in_review') return STATUS.APPLIED;
  return STATUS.UNKNOWN;
}

// --- helpers ----------------------------------------------------------------

function centsToDollars(cents) {
  const n = Number(cents);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 100) : null;
}
function latlng(a) {
  const ll = a.latlng;
  if (Array.isArray(ll) && ll.length === 2) return { lat: ll[0], lng: ll[1] };
  return null;
}
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
