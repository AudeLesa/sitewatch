import { createHash } from 'node:crypto';
import { normalizeAddress } from './util/address.js';

// ---------------------------------------------------------------------------
// The normalized permit record — the common shape every source maps into.
// Everything downstream (dedupe, filter, geocode, output) speaks this language.
// ---------------------------------------------------------------------------

export const CATEGORY = {
  COMMERCIAL: 'commercial',
  INDUSTRIAL: 'industrial',
  INSTITUTIONAL: 'institutional',
  MULTIFAMILY: 'multifamily',
  RESIDENTIAL: 'residential',
  UNKNOWN: 'unknown',
};

export const WORK_CLASS = {
  NEW_CONSTRUCTION: 'new_construction',
  SHELL: 'shell',
  ADDITION: 'addition',
  REMODEL: 'remodel',
  DEMOLITION: 'demolition',
  OTHER: 'other',
  UNKNOWN: 'unknown',
};

export const STATUS = {
  APPLIED: 'applied',
  ISSUED: 'issued',
  ACTIVE: 'active',
  FINALIZED: 'finalized',
  EXPIRED: 'expired',
  WITHDRAWN: 'withdrawn',
  UNKNOWN: 'unknown',
};

// Statuses that mean the project is NOT currently being built.
export const TERMINAL_STATUSES = new Set([STATUS.FINALIZED, STATUS.EXPIRED, STATUS.WITHDRAWN]);

/**
 * Build a normalized record. Sources pass partial fields; we fill defaults and
 * compute a stable id so the same permit always hashes to the same id.
 */
export function makeRecord(partial) {
  const address = {
    line1: partial.address?.line1 ?? null,
    city: partial.address?.city ?? null,
    county: partial.address?.county ?? null,
    state: partial.address?.state ?? null,
    zip: partial.address?.zip ?? null,
    full: partial.address?.full ?? buildFull(partial.address),
  };

  const rec = {
    id: null, // set below
    source: partial.source,
    // Which region dataset this record belongs to (region registry id) —
    // stamped by the pull pipeline; sources may pre-set it.
    region: partial.region ?? null,
    sourceId: partial.sourceId != null ? String(partial.sourceId) : null,
    permitNumber: partial.permitNumber ?? null,
    category: partial.category ?? CATEGORY.UNKNOWN,
    workClass: partial.workClass ?? WORK_CLASS.UNKNOWN,
    status: partial.status ?? STATUS.UNKNOWN,
    description: partial.description ?? null,
    // Whole dollars / whole feet: the DB columns are bigint, and Seattle-class
    // sources declare costs with cents ("2164755.87") — the first unattended
    // multi-region load failed on exactly that.
    valuation: partial.valuation != null ? Math.round(partial.valuation) : null,
    squareFeet: partial.squareFeet != null ? Math.round(partial.squareFeet) : null,
    appliedDate: partial.appliedDate ?? null,
    issuedDate: partial.issuedDate ?? null,
    finalizedDate: partial.finalizedDate ?? null,
    estStartDate: partial.estStartDate ?? null,
    estEndDate: partial.estEndDate ?? null,
    // Filled by the history stage (src/pipeline/history.js) from cross-run diffs.
    firstSeenAt: partial.firstSeenAt ?? null,
    statusChangedAt: partial.statusChangedAt ?? null,
    startedAt: partial.startedAt ?? null,
    justStarted: partial.justStarted ?? false,
    prevStatus: partial.prevStatus ?? null,
    // How confident we are the site is *actively being built* (0–1). The source
    // sets a stage prior; src/pipeline/lifecycle.js adjusts it with the declared
    // start/end dates and expires finished projects.
    confidence: partial.confidence ?? null,
    // Where the project sits in its lifecycle:
    // pre | review | building | finishing | finished | closed (null if unknown).
    lifecycleStage: partial.lifecycleStage ?? null,
    contractor: partial.contractor ?? null,
    designFirm: partial.designFirm ?? null,
    designFirmPhone: partial.designFirmPhone ?? null,
    designFirmAddress: partial.designFirmAddress ?? null,
    owner: partial.owner ?? null,
    ownerPhone: partial.ownerPhone ?? null,
    ownerAddress: partial.ownerAddress ?? null,
    contactName: partial.contactName ?? null,
    // Tenant (who's moving in) and RAS (the accessibility specialist on the
    // project) — TABS detail-page contacts beyond owner/architect.
    tenantName: partial.tenantName ?? null,
    tenantPhone: partial.tenantPhone ?? null,
    rasName: partial.rasName ?? null,
    rasPhone: partial.rasPhone ?? null,
    scopeOfWork: partial.scopeOfWork ?? null,
    publicFunds: partial.publicFunds ?? null,
    facilityName: partial.facilityName ?? null,
    // Full deep link to the official record, when the portal's URL can't be
    // templated from the permit number alone (login-walled portals, BIN-keyed
    // property pages). Takes precedence over the region's permitLinks.
    sourceUrl: partial.sourceUrl ?? null,
    address,
    location: partial.location ?? null, // { lat, lng }
    geocode: partial.geocode ?? null, // { source, score, matched }
    contributingSources: partial.contributingSources ?? [partial.source],
    raw: partial.raw ?? null,
    fetchedAt: partial.fetchedAt ?? new Date().toISOString(),
  };

  rec.id = stableId(rec);
  return rec;
}

function buildFull(addr) {
  if (!addr) return null;
  const parts = [addr.line1, addr.city, addr.state, addr.zip].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function stableId(rec) {
  const basis = [rec.source, rec.permitNumber || rec.sourceId || normalizeAddress(rec.address.full)].join('|');
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

/** A cross-source key used to detect the same physical project in two feeds. */
export function dedupeKey(rec) {
  const addr = normalizeAddress(rec.address.line1 || rec.address.full || '');
  // Bucket by issued month so minor date diffs across sources still collide.
  const month = rec.issuedDate ? rec.issuedDate.slice(0, 7) : '';
  return `${addr}|${month}`;
}
