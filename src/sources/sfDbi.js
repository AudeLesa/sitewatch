import { activeRegion } from '../config.js';
import { lookbackFloorIso } from '../pipeline/filter.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';
import { fetchDataset } from './socrata.js';

// ---------------------------------------------------------------------------
// San Francisco DBI building permits — data.sfgov.org dataset i98e-djp9
// (license: ODC Public Domain Dedication, verified 2026-07-10).
//
// A deliberately SPARSE region, launched with eyes open: SF issued only ~21
// non-residential new-construction permits in the 24 months before launch.
// Most of the map is commercial-use additions/alterations (type 3 filtered by
// proposed_use — office, retail, schools, clinics). No owner, architect, or
// contractor fields anywhere; estimated/revised cost carries the valuation.
// No public permit-number URL survives unauthenticated (dbiweb02 500s), so
// records ship without deep links.
// ---------------------------------------------------------------------------

export const id = 'dbi_sf';
export const PERMIT_PREFIX = 'SF-'; // permit numbers are bare digits

export const STATUS_MAP = {
  'issued':     { status: STATUS.ISSUED, confidence: 0.8, stage: 'building' },
  'reinstated': { status: STATUS.ISSUED, confidence: 0.8, stage: 'building' },
  'approved':   { status: STATUS.APPLIED, confidence: 0.55, stage: 'review' },
  'filed':      { status: STATUS.APPLIED, confidence: 0.35, stage: 'review' },
  'suspend':    { status: STATUS.ACTIVE, confidence: 0.25, stage: 'building' }, // work halted — faded, never hot
  'appeal':     { status: STATUS.APPLIED, confidence: 0.3, stage: 'review' },
  'plancheck':  { status: STATUS.APPLIED, confidence: 0.4, stage: 'review' },
  'complete':   { status: STATUS.FINALIZED, confidence: 0, stage: 'closed' },
  'cancelled':  { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
  'withdrawn':  { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
  'expired':    { status: STATUS.EXPIRED, confidence: 0, stage: 'closed' },
  'revoked':    { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
  'disapproved': { status: STATUS.WITHDRAWN, confidence: 0, stage: 'closed' },
};

// permit_type: 1 = new construction, 2 = new construction wood frame,
// 3 = additions/alterations/repairs (kept only for commercial uses).
const TYPE_MAP = { 1: WORK_CLASS.NEW_CONSTRUCTION, 2: WORK_CLASS.NEW_CONSTRUCTION, 3: WORK_CLASS.ADDITION };

// proposed_use (falling back to existing_use) drives both the residential
// screen and the category. The use vocabulary is DBI's own (probed live).
const RESIDENTIAL_USE = /dwelling|apartment|residns|residential/i;
const INSTITUTIONAL_USE = /school|clinic|church|hospital|day care|museum|library/i;
const INDUSTRIAL_USE = /warehouse|manufactur|pdr|storage|automobile|repair/i;

export async function fetchPermits({ log = console.error } = {}) {
  const cfg = activeRegion().dbi;
  if (!cfg) return []; // this source only exists for the SF region

  const iso = lookbackFloorIso();
  const rows = await fetchDataset({
    domain: cfg.domain,
    datasetId: cfg.datasetId,
    where:
      `permit_type IN ('1','2','3')` +
      ` AND (issued_date >= '${iso}' OR (issued_date IS NULL AND filed_date >= '${iso}'))`,
    order: 'permit_number', log, tag: id,
  });

  // Multi-parcel permits appear as one row PER ADDRESS (2245 + 2255 Post St
  // under one permit_number) — but it's one project and one stable id; keep
  // the first row per permit or id-keyed consumers (the DB upsert) collapse
  // records unpredictably.
  const byPermit = new Map();
  for (const row of rows) {
    if (!row.permit_number) continue;
    if (!byPermit.has(row.permit_number)) byPermit.set(row.permit_number, row);
  }

  const records = [];
  let unknownStatus = 0, residential = 0;
  for (const row of byPermit.values()) {
    const use = row.proposed_use || row.existing_use || '';
    if (RESIDENTIAL_USE.test(use)) { residential++; continue; }
    const st = STATUS_MAP[String(row.status || '').toLowerCase()];
    if (!st) unknownStatus++;
    records.push(mapRow(row, st || { status: STATUS.UNKNOWN, confidence: null, stage: null }, use));
  }
  if (unknownStatus > records.length * 0.02 && unknownStatus > 5) {
    throw new Error(`${unknownStatus}/${records.length} rows carry statuses missing from STATUS_MAP — DBI status drift, aborting.`);
  }
  log(`[${id}] ${rows.length} rows → ${records.length} commercial-use records (${residential} residential-use dropped)`);
  return records;
}

function mapRow(row, st, use) {
  const desc = clean(row.description);
  const work = TYPE_MAP[Number(row.permit_type)] ?? WORK_CLASS.UNKNOWN;
  const workLabel = work === WORK_CLASS.NEW_CONSTRUCTION ? 'New construction' : 'Addition/alteration';
  // The dataset serves `location` as a GeoJSON Point ({coordinates:[lng,lat]})
  // — reading .latitude silently dropped EVERY source coordinate and let the
  // census fallback re-place the whole region 10–1,200 m off (audit-caught).
  // Both shapes handled in case Socrata ever flips the representation back.
  const coords = Array.isArray(row.location?.coordinates) ? { lat: Number(row.location.coordinates[1]), lng: Number(row.location.coordinates[0]) }
    : row.location?.latitude != null ? { lat: Number(row.location.latitude), lng: Number(row.location.longitude) } : null;
  const loc = coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng) && coords.lat !== 0 ? coords : null;
  const cost = Number(row.revised_cost ?? row.estimated_cost);
  const line1 = clean([row.street_number, row.street_number_suffix, row.street_name, row.street_suffix].filter(Boolean).join(' '));
  const zip = clean(row.zipcode) || null;
  const category = INSTITUTIONAL_USE.test(use) ? CATEGORY.INSTITUTIONAL
    : INDUSTRIAL_USE.test(use) ? CATEGORY.INDUSTRIAL : CATEGORY.COMMERCIAL;

  return makeRecord({
    source: id,
    sourceId: row.permit_number,
    permitNumber: PERMIT_PREFIX + row.permit_number,
    category,
    workClass: work,
    status: st.status,
    confidence: st.confidence,
    lifecycleStage: st.stage,
    description: `${workLabel}${desc ? ` — ${truncate(desc.replace(/[()]/g, ''), 140)}` : ''} (${row.status || 'Unknown'})`,
    scopeOfWork: desc || null,
    valuation: Number.isFinite(cost) && cost >= 100 ? cost : null, // $1 placeholders → null
    appliedDate: day(row.filed_date),
    issuedDate: day(row.issued_date),
    finalizedDate: day(row.completed_date),
    estStartDate: day(row.first_construction_document_date) || day(row.issued_date),
    estEndDate: null, // no expiry column; the lookback bounds staleness
    facilityName: null,
    address: {
      line1,
      city: 'San Francisco',
      state: 'CA',
      zip,
      full: [line1, 'San Francisco', zip ? `CA ${zip}` : 'CA'].filter(Boolean).join(', ') || null,
    },
    location: loc,
    geocode: loc ? { source: 'dbi', precision: 'address', matched: 'source location' } : null,
    raw: null,
  });
}

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim() || null;
const day = (s) => (s ? String(s).slice(0, 10) : null);
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
