import { activeRegion } from '../config.js';
import { lookbackFloorIso } from '../pipeline/filter.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';
import { fetchJson } from '../util/http.js';

// ---------------------------------------------------------------------------
// Philadelphia L&I permits — Carto SQL API (phl.carto.com, OpenDataPhilly).
//
// The table mixes EVERY permit type (Zoning, Electrical, Plumbing, …) — only
// permittype='Building' rows are construction authorizations, and the
// commercialorresidential flag is literal (Title Case; ~588k legacy rows have
// it null and are excluded). NO VALUATION anywhere in the dataset — the
// region's capabilities.valuation:false drives the UI's $-free degradation.
// What it does carry that TABS-class sources don't always: OPA owner,
// contractor name, and rich approved-scope text.
//
// Statuses are simple: Issued (active) / Completed / Expired / Cancelled
// (terminal) / Stop Work (site exists, work halted — shown faded, never hot)
// / Amendment * (the base permit is issued; an amendment is being processed).
// ---------------------------------------------------------------------------

export const id = 'lni_philly';
export const PERMIT_PREFIX = 'PHL-';

export const STATUS_MAP = {
  'Issued':    { status: STATUS.ISSUED, confidence: 0.8, stage: 'building' },
  'Stop Work': { status: STATUS.ACTIVE, confidence: 0.25, stage: 'building' },
  'Amendment Requested':              { status: STATUS.ISSUED, confidence: 0.7, stage: 'building' },
  'Amendment Review':                 { status: STATUS.ISSUED, confidence: 0.7, stage: 'building' },
  'Amendment Applicant Revisions':    { status: STATUS.ISSUED, confidence: 0.7, stage: 'building' },
  'Amendment Application Incomplete': { status: STATUS.ISSUED, confidence: 0.7, stage: 'building' },
  'Amendment Ready For Issue':        { status: STATUS.ISSUED, confidence: 0.7, stage: 'building' },
  'Amendment Denied':                 { status: STATUS.ISSUED, confidence: 0.7, stage: 'building' },
  'Completed': { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
  'Expired':   { status: STATUS.EXPIRED, confidence: 0, stage: 'closed' },
  'Cancelled': { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
};

// typeofwork → workClass. 'Alterations' (pure) and Make Safe are out of scope,
// same as Texas excluding 9002 renovations; the mixed Addition/Alteration
// buckets ride as additions (the Seattle precedent).
const WORK_MAP = {
  'New Construction': WORK_CLASS.NEW_CONSTRUCTION,
  'New Construction (Shell Only)': WORK_CLASS.SHELL,
  'New construction, addition, GFA change': WORK_CLASS.NEW_CONSTRUCTION,
  'New Construction or Additions': WORK_CLASS.NEW_CONSTRUCTION,
  'Addition and/or Alteration': WORK_CLASS.ADDITION,
  'Addition and/or Alterations': WORK_CLASS.ADDITION,
};

const PAGE = 5000;

export async function fetchPermits({ log = console.error } = {}) {
  const cfg = activeRegion().lni;
  if (!cfg) return []; // this source only exists for the Philadelphia region

  const iso = lookbackFloorIso();
  const types = Object.keys(WORK_MAP).map((t) => `'${t.replace(/'/g, "''")}'`).join(',');

  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const sql =
      `SELECT permitnumber, permittype, typeofwork, status, permitissuedate, permitcompleteddate,` +
      ` address, zip, opa_owner, contractorname, approvedscopeofwork, numberofstories,` +
      ` ST_Y(the_geom) AS lat, ST_X(the_geom) AS lng` +
      ` FROM permits` +
      ` WHERE commercialorresidential = 'Commercial' AND permittype = 'Building'` +
      ` AND typeofwork IN (${types}) AND permitissuedate >= '${iso}'` +
      ` ORDER BY permitnumber LIMIT ${PAGE} OFFSET ${offset}`;
    const res = await fetchJson(`https://${cfg.domain}/api/v2/sql?q=${encodeURIComponent(sql)}`, { headers: { Accept: 'application/json' } });
    rows.push(...(res.rows || []));
    if ((res.rows || []).length < PAGE) break;
  }
  log(`[${id}] ${rows.length} commercial building-permit rows from ${cfg.domain}`);

  const records = [];
  let unknownStatus = 0;
  for (const row of rows) {
    if (!row.permitnumber) continue;
    const st = STATUS_MAP[row.status];
    if (!st) unknownStatus++;
    records.push(mapRow(row, st || { status: STATUS.UNKNOWN, confidence: null, stage: null }));
  }
  if (unknownStatus > rows.length * 0.02 && unknownStatus > 5) {
    throw new Error(`${unknownStatus}/${rows.length} rows carry statuses missing from STATUS_MAP — L&I status drift, aborting.`);
  }
  if (unknownStatus) log(`[${id}] ⚠ ${unknownStatus} rows with unmapped statuses (kept as unknown)`);
  return records;
}

function mapRow(row, st) {
  const desc = clean(row.approvedscopeofwork);
  const work = WORK_MAP[row.typeofwork] ?? WORK_CLASS.UNKNOWN;
  const workLabel = work === WORK_CLASS.NEW_CONSTRUCTION ? 'New construction'
    : work === WORK_CLASS.SHELL ? 'Shell construction'
    : work === WORK_CLASS.ADDITION ? 'Addition/alteration' : 'Construction';
  const lat = Number(row.lat), lng = Number(row.lng);
  const located = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  const address = clean(row.address);

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
    valuation: null, // L&I publishes no project costs — capabilities.valuation:false
    issuedDate: day(row.permitissuedate),
    finalizedDate: day(row.permitcompleteddate),
    estStartDate: day(row.permitissuedate),
    estEndDate: null, // no expiry column; the lookback bounds staleness
    owner: clean(row.opa_owner) || null,
    contractor: clean(row.contractorname) || null,
    address: {
      line1: address,
      city: 'Philadelphia',
      state: 'PA',
      zip: clean(row.zip)?.slice(0, 5) || null,
      full: [address, 'Philadelphia', clean(row.zip) ? `PA ${clean(row.zip).slice(0, 5)}` : 'PA'].filter(Boolean).join(', ') || null,
    },
    location: located ? { lat, lng } : null,
    geocode: located ? { source: 'lni', precision: 'address', matched: 'source geometry' } : null,
    // Atlas is the city's own property viewer — permit-number URLs don't exist.
    sourceUrl: address ? `https://atlas.phila.gov/${encodeURIComponent(address)}/permits` : null,
    raw: null,
  });
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || null;
const day = (s) => (s ? String(s).slice(0, 10) : null);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
