import { config, activeRegion } from '../config.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';
import { fetchDataset } from './socrata.js';

// ---------------------------------------------------------------------------
// New York City DOB — the dual-feed source (data.cityofnewyork.us, "no
// restrictions on the use of Open Data", verified 2026-07-10).
//
//   Feed A: DOB NOW Job Application Filings (w9ak-ipjd) — every job filed
//     since ~2020. job_type='New Building' + building_type='Other' +
//     zero/null dwelling units = non-residential new construction (mixed-use
//     towers with units are multifamily — out of scope, same as Texas).
//     Carries cost, floor area, owner, BIN/BBL, lat/lon, and the lifecycle
//     (filing statuses → Permit Entire → LOC/CO Issued/signoff).
//   Feed A': DOB NOW Approved Permits (rbx6-tga4) — per-work-type permits.
//     Joined by job root for the GC contractor name AND the latest GC permit
//     issue/expiry: renewals bump `issuedDate`, which is what keeps a
//     multi-year tower inside the lookback window while it's genuinely
//     active (and lets expiry decay fade jobs whose permits lapsed).
//   Feed B: legacy BIS permit issuance (ipu4-2q9a) — pre-DOB-NOW jobs still
//     building on renewed permits. Text MM/DD/YYYY dates (LIKE-year filter),
//     one row per permit sequence/renewal → collapsed per job, newest wins.
//
//   Merge: a building (BIN) with an active job in BOTH feeds keeps the DOB
//   NOW record (current system, richer lifecycle); the BIS twin only donates
//   missing fields. Unit-tested in scripts/try-nyc-merge.mjs with fixtures.
//
// Permit numbers get per-feed synthetic prefixes (NYCN-/NYCB-) — DOB NOW
// roots are 'Q08054172', BIS jobs are bare digits; both would collide with
// other cities' numeric permits. Deep links are computed here (sourceUrl):
// the DOB NOW public portal is login-walled, so both feeds link to the
// public BIS-web pages (property profile by BIN / job query by number).
// ---------------------------------------------------------------------------

export const id = 'nyc_dob';
export const PREFIX_DOBNOW = 'NYCN-';
export const PREFIX_BIS = 'NYCB-';

// DOB NOW filing_status → lifecycle. Semantics audited against the portal's
// own flow: plan review → Approved (permits not yet pulled — construction has
// NOT begun) → Permit Entire/Issued (building) → LOC/CO Issued + signoff
// (DONE — terminal, the inverted-TABS scar class).
export const DOBNOW_STATUS = {
  'Pending Plan Examiner Assignment': { status: STATUS.APPLIED, confidence: 0.3, stage: 'pre' },
  'Pending CPE/ACPE Assignment':      { status: STATUS.APPLIED, confidence: 0.3, stage: 'pre' },
  'Pending Prof Cert QA Assignment':  { status: STATUS.APPLIED, confidence: 0.3, stage: 'pre' },
  'Pending SO PE Assignment':         { status: STATUS.APPLIED, confidence: 0.3, stage: 'pre' },
  'Plan Examiner Review':             { status: STATUS.APPLIED, confidence: 0.35, stage: 'review' },
  'SO Plan Examiner Review':          { status: STATUS.APPLIED, confidence: 0.35, stage: 'review' },
  'Chief Plan Examiner/ Assistant Chief Plan Examiner Review': { status: STATUS.APPLIED, confidence: 0.35, stage: 'review' },
  'Prof Cert QA Review':              { status: STATUS.APPLIED, confidence: 0.35, stage: 'review' },
  'QA Failed':                        { status: STATUS.APPLIED, confidence: 0.3, stage: 'review' },
  'Objections':                       { status: STATUS.APPLIED, confidence: 0.4, stage: 'review' },
  'Incomplete':                       { status: STATUS.APPLIED, confidence: 0.3, stage: 'review' },
  'Approved':                         { status: STATUS.APPLIED, confidence: 0.55, stage: 'review' },
  'Permit Entire':                    { status: STATUS.ISSUED, confidence: 0.8, stage: 'building' },
  'Permit Issued':                    { status: STATUS.ISSUED, confidence: 0.8, stage: 'building' },
  'LOC Issued':                       { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
  'CO Issued':                        { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
  'Filing Withdrawn':                 { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
};
// On Hold – …: several administrative variants — prefix-matched to review.
const onHold = { status: STATUS.APPLIED, confidence: 0.3, stage: 'review' };

const BIS_STATUS = {
  'ISSUED':    { status: STATUS.ISSUED, confidence: 0.8, stage: 'building' },
  'RE-ISSUED': { status: STATUS.ISSUED, confidence: 0.8, stage: 'building' },
  'IN PROCESS': { status: STATUS.APPLIED, confidence: 0.4, stage: 'review' },
};

const BOROUGH = {
  MANHATTAN: 'Manhattan', BROOKLYN: 'Brooklyn', QUEENS: 'Queens',
  BRONX: 'Bronx', 'STATEN ISLAND': 'Staten Island',
};

export async function fetchPermits({ log = console.error } = {}) {
  const cfg = activeRegion().nycDob;
  if (!cfg) return []; // this source only exists for the NYC region

  const from = new Date();
  from.setMonth(from.getMonth() - config.lookbackMonths);
  const iso = from.toISOString().slice(0, 10);
  const domain = cfg.domain;

  // Feed A: non-residential New Building initial filings — every unfinished
  // permitted job regardless of age (permit renewals decide recency below),
  // plus the pre-permit pipeline bounded by filing date.
  const jobs = await fetchDataset({
    domain, datasetId: cfg.filingsDataset,
    where:
      `job_type = 'New Building' AND building_type = 'Other'` +
      ` AND (proposed_dwelling_units IS NULL OR proposed_dwelling_units = '0')` +
      ` AND job_filing_number LIKE '%-I1'` +
      ` AND ((first_permit_date IS NOT NULL AND signoff_date IS NULL) OR (first_permit_date IS NULL AND filing_date > '${iso}'))`,
    order: 'job_filing_number', log, tag: `${id}/filings`,
  });

  // Feed A': GC permits issued in-window → contractor + latest issue/expiry
  // per job root. Renewals appear as fresh rows; newest issue wins.
  const gcRows = await fetchDataset({
    domain, datasetId: cfg.permitsDataset,
    select: 'job_filing_number,issued_date,expired_date,applicant_business_name,filing_reason',
    where: `work_type = 'General Construction' AND issued_date > '${iso}'`,
    // ~83k GC permits per 24mo citywide (measured 2026-07) — slim columns,
    // big pages, and headroom for growth. Truncation here would silently
    // null contractors and misfire the too_old filter on renewed jobs.
    order: 'job_filing_number', max: 250000, pageSize: 10000, log, tag: `${id}/gc-permits`,
  });
  const gcByRoot = new Map();
  for (const p of gcRows) {
    const root = String(p.job_filing_number || '').replace(/-[A-Z]\d+$/, '');
    const prev = gcByRoot.get(root);
    if (!prev || String(p.issued_date || '') > String(prev.issued_date || '')) gcByRoot.set(root, p);
  }

  // Feed B: legacy BIS non-residential NB permits with recent issuance
  // (initial or renewal). Text dates — filter by year server-side, precisely
  // client-side. Collapse to one row per job, newest issuance wins.
  const years = new Set();
  for (let d = new Date(from); d <= new Date(); d.setFullYear(d.getFullYear() + 1)) years.add(d.getFullYear());
  years.add(new Date().getFullYear());
  const bisRows = await fetchDataset({
    domain, datasetId: cfg.bisDataset,
    where:
      `job_type = 'NB' AND residential IS NULL` +
      ` AND (${[...years].map((y) => `issuance_date LIKE '%/${y}'`).join(' OR ')})`,
    order: 'job__', log, tag: `${id}/bis`,
  });
  const bisByJob = new Map();
  for (const r of bisRows) {
    const when = usDate(r.issuance_date);
    if (!when || when < iso) continue;
    const prev = bisByJob.get(r.job__);
    if (!prev || when > usDate(prev.issuance_date)) bisByJob.set(r.job__, r);
  }

  const dobRecords = jobs.map((j) => mapDobNow(j, gcByRoot)).filter(Boolean);
  const bisRecords = [...bisByJob.values()].map(mapBis).filter(Boolean);
  const { merged, dropped } = mergeByBin(dobRecords, bisRecords);
  log(`[${id}] ${dobRecords.length} DOB NOW + ${bisRecords.length} BIS jobs → ${merged.length} (${dropped} BIS twins folded by BIN)`);
  return merged;
}

/**
 * Cross-feed merge: a BIN with an active DOB NOW job absorbs its BIS twin —
 * the same building double-filed across systems must not become two pins.
 * The BIS record only donates fields the DOB NOW record lacks (contractor,
 * mostly). Distinct BINs pass through untouched.
 */
export function mergeByBin(dobRecords, bisRecords) {
  const byBin = new Map();
  for (const r of dobRecords) if (r.raw?.bin) byBin.set(r.raw.bin, r);
  const merged = [...dobRecords];
  let dropped = 0;
  for (const b of bisRecords) {
    const twin = b.raw?.bin ? byBin.get(b.raw.bin) : null;
    if (!twin) { merged.push(b); continue; }
    dropped++;
    for (const field of ['contractor', 'owner', 'squareFeet', 'valuation']) {
      if (twin[field] == null && b[field] != null) twin[field] = b[field];
    }
    if (!twin.contributingSources.includes(id)) twin.contributingSources.push(id);
  }
  return { merged, dropped };
}

function mapDobNow(j, gcByRoot) {
  const root = String(j.job_filing_number || '').replace(/-I1$/, '');
  if (!root) return null;
  let st = j.signoff_date ? DOBNOW_STATUS['LOC Issued'] : DOBNOW_STATUS[j.filing_status];
  if (!st && /^On ?Hold/i.test(j.filing_status || '')) st = onHold;
  if (!st) st = { status: STATUS.UNKNOWN, confidence: null, stage: null };
  const gc = gcByRoot.get(root);
  const lat = Number(j.latitude), lng = Number(j.longitude);
  const located = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  const cost = Number(j.initial_cost);
  const sqft = Number(j.total_construction_floor_area);
  const desc = clean(j.job_description);
  const statusLabel = j.signoff_date ? 'Signed Off' : (j.filing_status || 'Unknown');
  // issuedDate = the LATEST GC permit issue (renewals included), falling back
  // to the job's first permit — this is what the lookback filter sees, so a
  // long-running tower stays only while its permits stay fresh.
  const issued = day(gc?.issued_date) || day(j.first_permit_date);

  return makeRecord({
    source: id,
    sourceId: j.job_filing_number,
    permitNumber: PREFIX_DOBNOW + root,
    category: CATEGORY.COMMERCIAL,
    workClass: WORK_CLASS.NEW_CONSTRUCTION,
    status: st.status,
    confidence: st.confidence,
    lifecycleStage: st.stage,
    description: `New construction${desc ? ` — ${truncate(desc.replace(/[()]/g, ''), 140)}` : ''} (${statusLabel})`,
    scopeOfWork: desc || null,
    valuation: Number.isFinite(cost) && cost > 0 ? cost : null,
    squareFeet: Number.isFinite(sqft) && sqft > 0 ? Math.round(sqft) : null,
    appliedDate: day(j.filing_date),
    issuedDate: issued,
    estStartDate: day(j.first_permit_date),
    estEndDate: day(gc?.expired_date),
    owner: clean(j.owner_s_business_name) || [clean(j.owner_first_name), clean(j.owner_last_name)].filter(Boolean).join(' ') || null,
    contractor: clean(gc?.applicant_business_name) || null,
    address: nyAddress(j.house_no, j.street_name, j.borough, j.postcode ?? j.zip),
    location: located ? { lat, lng } : null,
    geocode: located ? { source: 'nyc_dob', precision: 'address', matched: 'source latlon' } : null,
    sourceUrl: j.bin ? `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=${encodeURIComponent(j.bin)}` : null,
    raw: { bin: j.bin || null, bbl: j.bbl || null },
  });
}

function mapBis(r) {
  if (!r.job__) return null;
  const st = BIS_STATUS[r.permit_status] || { status: STATUS.UNKNOWN, confidence: null, stage: null };
  const lat = Number(r.gis_latitude), lng = Number(r.gis_longitude);
  const located = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  return makeRecord({
    source: id,
    sourceId: r.job__,
    permitNumber: PREFIX_BIS + r.job__,
    category: CATEGORY.COMMERCIAL,
    workClass: WORK_CLASS.NEW_CONSTRUCTION,
    status: st.status,
    confidence: st.confidence,
    lifecycleStage: st.stage,
    description: `New construction (${r.permit_status || 'Unknown'})`,
    valuation: null, // the BIS permit table carries no job cost
    appliedDate: usDate(r.filing_date),
    issuedDate: usDate(r.issuance_date),
    estStartDate: usDate(r.job_start_date) || usDate(r.issuance_date),
    estEndDate: usDate(r.expiration_date),
    owner: clean(r.owner_s_business_name) || [clean(r.owner_s_first_name), clean(r.owner_s_last_name)].filter(Boolean).join(' ') || null,
    contractor: clean(r.permittee_s_business_name) || null,
    address: nyAddress(r.house__, r.street_name, r.borough, r.zip_code),
    location: located ? { lat, lng } : null,
    geocode: located ? { source: 'nyc_dob', precision: 'address', matched: 'source latlon' } : null,
    sourceUrl: `https://a810-bisweb.nyc.gov/bisweb/JobsQueryByNumberServlet?passjobnumber=${encodeURIComponent(r.job__)}&passdocnumber=01`,
    raw: { bin: r.bin__ || null, bbl: r.bbl || null },
  });
}

// "10/07/2025" (BIS text dates) → "2025-10-07"; ISO timestamps pass through day().
function usDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(s || ''));
  return m ? `${m[3]}-${m[1]}-${m[2]}` : day(s);
}

function nyAddress(houseNo, street, borough, zip) {
  const line1 = [clean(houseNo), clean(street)].filter(Boolean).join(' ') || null;
  const city = BOROUGH[String(borough || '').toUpperCase().trim()] || 'New York';
  const z = clean(zip);
  const full = [line1, city, z ? `NY ${z}` : 'NY'].filter(Boolean).join(', ');
  return { line1, city, state: 'NY', zip: z, full: full || null };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || null;
const day = (s) => (s ? String(s).slice(0, 10) : null);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
