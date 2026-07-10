import { config, activeRegion } from '../config.js';
import { lookbackFloorIso } from '../pipeline/filter.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';
import { fetchDataset } from './socrata.js';

// ---------------------------------------------------------------------------
// Seattle SDCI building permits — data.seattle.gov dataset 76t5-zqzr
// (license: Public Domain; refreshed daily; verified 2026-07-10).
//
// Field reality vs TABS: rows arrive PRE-GEOCODED (latitude/longitude) with a
// declared cost and the CONTRACTOR name (which TABS lacks) — but no owner,
// architect, square footage, or funding source. The region manifest's
// capability flags tell the UI what to degrade.
//
// Lifecycle semantics (probed against the portal's own status counts —
// never trust a source's statuses unaudited; TABS shipped inverted once):
//   intake/review statuses  → permit not yet issued: construction has not
//                             legally begun (stage pre/review, like TABS).
//   Issued / Phase Issued   → construction authorized and, in practice, under
//                             way — Seattle issues at construction start, not
//                             months ahead. estStart=issueddate and
//                             estEnd=expiresdate bound the decay model.
//   Inspections Completed / → final inspection passed / occupancy granted:
//   Approved to Occupy        the building is DONE. Mapped terminal on
//                             purpose (the TABS scar: these must never read
//                             as "hot sites").
//   Completed/Closed/…      → terminal.
// ---------------------------------------------------------------------------

export const id = 'sdci_seattle';
export const PERMIT_PREFIX = 'SEA-'; // registered in SOURCE_PERMIT_PREFIXES

export const STATUS_MAP = {
  // intake — application exists, plans not through review
  'Initiated':                 { status: STATUS.APPLIED, confidence: 0.3,  stage: 'pre' },
  'Ready for Intake':          { status: STATUS.APPLIED, confidence: 0.3,  stage: 'pre' },
  'Pending':                   { status: STATUS.APPLIED, confidence: 0.3,  stage: 'pre' },
  'Application Accepted':      { status: STATUS.APPLIED, confidence: 0.35, stage: 'pre' },
  'Application Completed':     { status: STATUS.APPLIED, confidence: 0.35, stage: 'pre' },
  'Scheduled':                 { status: STATUS.APPLIED, confidence: 0.35, stage: 'pre' },
  'Scheduled and Submitted':   { status: STATUS.APPLIED, confidence: 0.35, stage: 'pre' },
  // plan review — moving toward issuance
  'Awaiting Information':      { status: STATUS.APPLIED, confidence: 0.4,  stage: 'review' },
  'Additional Info Requested': { status: STATUS.APPLIED, confidence: 0.4,  stage: 'review' },
  'Reviews In Process':        { status: STATUS.APPLIED, confidence: 0.45, stage: 'review' },
  'Corrections Required':      { status: STATUS.APPLIED, confidence: 0.45, stage: 'review' },
  'Corrections Submitted':     { status: STATUS.APPLIED, confidence: 0.45, stage: 'review' },
  'Reviews Completed':         { status: STATUS.APPLIED, confidence: 0.55, stage: 'review' },
  'Ready for Issuance':        { status: STATUS.APPLIED, confidence: 0.6,  stage: 'review' },
  // issued — active construction window
  'Issued':                    { status: STATUS.ISSUED,  confidence: 0.8,  stage: 'building' },
  'Phase Issued':              { status: STATUS.ISSUED,  confidence: 0.8,  stage: 'building' },
  'Active':                    { status: STATUS.ACTIVE,  confidence: 0.8,  stage: 'building' },
  // done — final inspection / occupancy. Terminal on purpose (see header).
  'Inspections Completed':     { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
  'Approved to Occupy':        { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
  'Completed':                 { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
  'Closed':                    { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
  'Expired':                   { status: STATUS.EXPIRED,   confidence: 0, stage: 'closed' },
  'Withdrawn':                 { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
  'Canceled':                  { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
  'Denied':                    { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
};

const CLASS_MAP = {
  'Commercial': CATEGORY.COMMERCIAL,
  'Industrial': CATEGORY.INDUSTRIAL,
  'Institutional': CATEGORY.INSTITUTIONAL,
  'Vacant Land': CATEGORY.COMMERCIAL, // non-res development on empty parcels
};

const WORK_MAP = {
  'New': WORK_CLASS.NEW_CONSTRUCTION,
  'Addition/Alteration': WORK_CLASS.ADDITION, // Seattle lumps additions + alterations in one bucket
  'Tenant Improvment': WORK_CLASS.REMODEL,    // (sic — the portal's own spelling)
  'Tenant Improvement': WORK_CLASS.REMODEL,   // in case they ever fix it
  'Demolition': WORK_CLASS.DEMOLITION,
  'Deconstruction': WORK_CLASS.DEMOLITION,
  'Temporary': WORK_CLASS.OTHER,
  'Change of Use Only - No Construction': WORK_CLASS.OTHER,
};

export async function fetchPermits({ log = console.error } = {}) {
  const cfg = activeRegion().sdci;
  if (!cfg) return []; // this source only exists for the Seattle region

  const iso = lookbackFloorIso();
  // Non-residential BUILDING permits, recent by issue date — or, for permits
  // still in intake/review (no issueddate yet), recent by application date so
  // decade-old zombie applications never enter the pipeline (the downstream
  // lookback filter only bounds issuedDate).
  const where =
    `permitclassmapped = 'Non-Residential' AND permittypemapped = 'Building'` +
    ` AND (issueddate >= '${iso}' OR (issueddate IS NULL AND applieddate >= '${iso}'))`;

  const rows = await fetchDataset({
    domain: cfg.domain,
    datasetId: cfg.datasetId,
    where,
    order: 'permitnum',
    log,
    tag: id,
  });

  const records = [];
  let unknownStatus = 0;
  for (const row of rows) {
    if (!row.permitnum) continue;
    const st = STATUS_MAP[row.statuscurrent];
    if (!st) unknownStatus++;
    records.push(mapRow(row, st || { status: STATUS.UNKNOWN, confidence: null, stage: null }));
  }
  // Schema-drift tripwire: a burst of unmapped statuses means SDCI renamed
  // their workflow states — bail rather than publish half-scored data.
  if (unknownStatus > rows.length * 0.02 && unknownStatus > 5) {
    throw new Error(`${unknownStatus}/${rows.length} rows carry statuses missing from STATUS_MAP — SDCI status drift, aborting.`);
  }
  if (unknownStatus) log(`[${id}] ⚠ ${unknownStatus} rows with unmapped statuses (kept as unknown)`);
  return records;
}

function mapRow(row, st) {
  const desc = clean(row.description);
  const work = WORK_MAP[row.permittypedesc] ?? WORK_CLASS.UNKNOWN;
  const workLabel = work === WORK_CLASS.NEW_CONSTRUCTION ? 'New construction'
    : work === WORK_CLASS.ADDITION ? 'Addition/alteration'
    : row.permittypedesc || 'Construction';
  const lat = Number(row.latitude), lng = Number(row.longitude);
  const located = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  const cost = Number(row.estprojectcost);

  return makeRecord({
    source: id,
    sourceId: row.permitnum,
    // Seattle permit numbers are bare ('6905992-PH') — the synthetic prefix
    // keeps history keys and the DB permit_number unique across sources. The
    // deep-link template strips it back off via {raw}.
    permitNumber: PERMIT_PREFIX + row.permitnum,
    category: CLASS_MAP[row.permitclass] ?? CATEGORY.UNKNOWN,
    workClass: work,
    status: st.status,
    confidence: st.confidence,
    lifecycleStage: st.stage,
    // TABS convention: description ends with "(Status Label)" — the project
    // page's Status row and history's change detection both parse it. The
    // scope snippet must carry no parens of its own: an unmatched '(' (native,
    // or a ')' lost to truncation) would swallow the status suffix in that
    // trailing-parens parse. scopeOfWork keeps the raw text.
    description: `${workLabel}${desc ? ` — ${truncate(desc.replace(/[()]/g, ''), 140)}` : ''} (${row.statuscurrent || 'Unknown'})`,
    scopeOfWork: desc || null,
    valuation: Number.isFinite(cost) && cost > 0 ? cost : null,
    appliedDate: day(row.applieddate),
    issuedDate: day(row.issueddate),
    finalizedDate: day(row.completeddate),
    // Issued ≈ construction start; permit expiry bounds the decay model the
    // same way TABS declared end dates do (renewals push it forward daily).
    estStartDate: day(row.issueddate),
    estEndDate: day(row.expiresdate),
    contractor: clean(row.contractorcompanyname) || null,
    address: addressOf(row),
    location: located ? { lat, lng } : null,
    geocode: located ? { source: 'sdci', precision: 'address', matched: 'source latlon' } : null,
    raw: null, // keep data/seattle.json lean; the portal row is one API call away
  });
}

// `full` must be built in the TABS shape — "line1, City, ST zip" (state+zip in
// ONE comma part). The naive [line1, city, state, zip] join makes the city the
// third-from-last part, and cityOf() (SEO city pages) reads second-from-last:
// every zip-carrying record would land on a city page literally named "WA".
function addressOf(row) {
  const line1 = clean(row.originaladdress1);
  const city = titleCase(clean(row.originalcity)) || 'Seattle';
  const state = row.originalstate || 'WA';
  const zip = row.originalzip || null;
  const full = [line1, city, zip ? `${state} ${zip}` : state].filter(Boolean).join(', ');
  return { line1, city, state, zip, full: full || null };
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || null;
const day = (s) => (s ? String(s).slice(0, 10) : null);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const titleCase = (s) => (s ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);
