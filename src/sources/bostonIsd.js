import { activeRegion } from '../config.js';
import { lookbackFloorIso } from '../pipeline/filter.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';
import { fetchJson } from '../util/http.js';

// ---------------------------------------------------------------------------
// Boston ISD approved building permits — CKAN datastore (data.boston.gov,
// license: PDDL, verified 2026-07-10).
//
// Scope: 'Erect/New Construction' + the 'Long Form/Alteration Permit' major-
// work bucket (additions AND renovations mixed — rides as ADDITION, the same
// call made for Seattle's Addition/Alteration bucket), filtered to
// occupancytype='Comm'. Mixed-use ('Mixed') and 1-4FAM/Multi are residential
// territory — out of scope like everywhere else.
//
// Thin lifecycle: status is just Open/Closed. Open + recent issue = active;
// expiration_date drives the decay model. declared_valuation arrives as a
// currency STRING ("$36,500.00").
// ---------------------------------------------------------------------------

export const id = 'isd_boston';
export const PERMIT_PREFIX = 'BOS-';

export const STATUS_MAP = {
  // 0.7 prior (not the 0.8 other regions give issued permits): Open/Closed is
  // the entire lifecycle here, and 'Open' cannot distinguish mobilized from
  // BANKED — the launch audit found the region's largest permit ($362.8M,
  // 380 Stuart St) pulled explicitly to hold the entitlement while the lot
  // sits idle. Weaker evidence, weaker confidence.
  'Open':   { status: STATUS.ISSUED, confidence: 0.7, stage: 'building' },
  'Closed': { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
};

const TYPE_MAP = {
  'Erect/New Construction': WORK_CLASS.NEW_CONSTRUCTION,
  'Long Form/Alteration Permit': WORK_CLASS.ADDITION,
};

const PAGE = 5000;

export async function fetchPermits({ log = console.error } = {}) {
  const cfg = activeRegion().isd;
  if (!cfg) return []; // this source only exists for the Boston region

  const iso = lookbackFloorIso();
  const types = Object.keys(TYPE_MAP).map((t) => `'${t}'`).join(',');

  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const sql =
      `SELECT permitnumber, permittypedescr, description, comments, applicant, declared_valuation,` +
      ` issued_date, expiration_date, status, occupancytype, sq_feet, address, city, state, zip,` +
      ` y_latitude, x_longitude` +
      ` FROM "${cfg.resourceId}"` +
      ` WHERE issued_date >= '${iso}' AND permittypedescr IN (${types}) AND occupancytype = 'Comm'` +
      ` ORDER BY permitnumber LIMIT ${PAGE} OFFSET ${offset}`;
    const res = await fetchJson(
      `https://${cfg.domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.success) throw new Error(`[${id}] datastore_search_sql failed: ${JSON.stringify(res.error || {}).slice(0, 200)}`);
    rows.push(...(res.result.records || []));
    if ((res.result.records || []).length < PAGE) break;
  }
  // The datastore carries literal duplicate rows (same permit, same dates —
  // 261 of them found on the first pull, each becoming a second pin). One row
  // per permit, newest issuance wins.
  const byPermit = new Map();
  for (const row of rows) {
    if (!row.permitnumber) continue;
    const prev = byPermit.get(row.permitnumber);
    if (!prev || String(row.issued_date || '') > String(prev.issued_date || '')) byPermit.set(row.permitnumber, row);
  }
  log(`[${id}] ${rows.length} commercial permit rows → ${byPermit.size} distinct permits from ${cfg.domain}`);

  const records = [];
  let unknownStatus = 0;
  for (const row of byPermit.values()) {
    const st = STATUS_MAP[row.status];
    if (!st) unknownStatus++;
    records.push(mapRow(row, st || { status: STATUS.UNKNOWN, confidence: null, stage: null }));
  }
  // Numerator counts collapsed permits, so the threshold must too — against
  // raw rows (incl. duplicates) the tripwire would be diluted.
  if (unknownStatus > byPermit.size * 0.02 && unknownStatus > 5) {
    throw new Error(`${unknownStatus}/${byPermit.size} permits carry statuses missing from STATUS_MAP — ISD status drift, aborting.`);
  }
  return records;
}

function mapRow(row, st) {
  // "Interior/Exterior Work" (description) is the category label; comments is
  // the real scope text.
  const desc = clean(row.comments) || clean(row.description);
  const work = TYPE_MAP[row.permittypedescr] ?? WORK_CLASS.UNKNOWN;
  const workLabel = work === WORK_CLASS.NEW_CONSTRUCTION ? 'New construction' : 'Addition/alteration';
  const lat = Number(row.y_latitude), lng = Number(row.x_longitude);
  const located = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  const cost = Number(String(row.declared_valuation || '').replace(/[$,\s]/g, ''));
  const sqft = Number(row.sq_feet);
  const line1 = clean(row.address);
  const city = titleCase(clean(row.city)) || 'Boston';
  const zip = clean(row.zip)?.padStart(5, '0') || null;

  return makeRecord({
    source: id,
    sourceId: row.permitnumber,
    permitNumber: PERMIT_PREFIX + row.permitnumber,
    category: CATEGORY.COMMERCIAL,
    workClass: work,
    status: st.status,
    confidence: st.confidence,
    lifecycleStage: st.stage,
    description: `${workLabel}${desc ? ` — ${truncate(desc.replace(/[()]/g, ''), 140)}` : ''} (${row.status || 'Unknown'})`,
    scopeOfWork: desc || null,
    // "$0.01"/"$1" placeholders are declarations of nothing — null beats a
    // literal penny on the page; the region floor suspect-flags the rest.
    valuation: Number.isFinite(cost) && cost >= 100 ? cost : null,
    squareFeet: Number.isFinite(sqft) && sqft > 0 ? Math.round(sqft) : null,
    issuedDate: day(row.issued_date),
    estStartDate: day(row.issued_date),
    estEndDate: day(row.expiration_date),
    contactName: clean(row.applicant) || null, // 'applicant' is ambiguous (contractor OR owner) — kept neutral
    address: {
      line1, city, state: row.state || 'MA', zip,
      full: [line1, city, zip ? `MA ${zip}` : 'MA'].filter(Boolean).join(', ') || null,
    },
    location: located ? { lat, lng } : null,
    geocode: located ? { source: 'isd', precision: 'address', matched: 'source latlon' } : null,
    raw: null,
  });
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || null;
const day = (s) => (s ? String(s).slice(0, 10) : null);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const titleCase = (s) => (s ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);
