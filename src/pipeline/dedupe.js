import { dedupeKey } from '../schema.js';

// ---------------------------------------------------------------------------
// Two distinct duplicate problems, two passes:
//
//  1. WITHIN a source: the same project registered more than once (owner
//     resubmits, scope revised → new TABS number, same building). Collapsed by
//     address + facility name — month-independent, because re-registrations
//     happen months apart. The NEWER registration survives (it carries the
//     current status); the older one backfills anything missing.
//
//  2. ACROSS sources: the same physical project seen by two feeds. Collapsed
//     by address + issued month (different sources disagree on exact dates),
//     but ONLY when the collision is unambiguous — one record per source.
//     Same-source records sharing an address+month but with different names
//     (Building A / Building B of one campus) are distinct projects and must
//     NOT merge (they did before 2026-07: the old single-pass collapsed
//     everything sharing address+month).
// ---------------------------------------------------------------------------

// Field "richness" used to pick the survivor when two sources describe the same
// physical project. More non-null fields + having coordinates = more complete.
function richness(rec) {
  let score = 0;
  for (const v of Object.values(rec)) if (v != null && v !== '') score++;
  if (rec.location) score += 5;
  if (rec.valuation != null) score += 1;
  return score;
}

const normName = (s) =>
  String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const normAddr = (rec) => normName(rec.address?.line1 || rec.address?.full || '');

export function dedupe(records) {
  // ---- pass 1: same-source re-registrations (address + name) ----
  const bySelf = new Map();
  const out1 = [];
  for (const rec of records) {
    const addr = normAddr(rec);
    const name = normName(rec.facilityName);
    if (!addr || !name) { out1.push(rec); continue; } // nothing reliable to match on
    const key = `${rec.source}|${addr}|${name}`;
    const existing = bySelf.get(key);
    if (!existing) {
      bySelf.set(key, rec);
      out1.push(rec);
      continue;
    }
    // Same building registered twice: keep the newer registration (it reflects
    // the current lifecycle position), remember we saw it twice.
    const [winner, loser] =
      (rec.issuedDate || '') > (existing.issuedDate || '') ? [rec, existing] : [existing, rec];
    backfill(winner, loser);
    winner.contributingSources = mergeSources(winner, loser);
    if (winner !== existing) {
      out1[out1.indexOf(existing)] = winner;
      bySelf.set(key, winner);
    }
  }

  // ---- pass 2: cross-source collisions (address + month), unambiguous only ----
  const byKey = new Map();
  for (const rec of out1) {
    const key = dedupeKey(rec);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rec);
  }
  const out2 = [];
  for (const group of byKey.values()) {
    const sources = new Set(group.map((r) => r.source));
    if (group.length < 2 || sources.size < 2 || sources.size !== group.length) {
      // single record, single-source group (distinct projects at one address),
      // or an ambiguous many-to-many collision — keep everything as-is.
      out2.push(...group);
      continue;
    }
    // Exactly one record per source: the same project seen by each feed.
    group.sort((a, b) => richness(b) - richness(a));
    const winner = group[0];
    for (const loser of group.slice(1)) {
      backfill(winner, loser);
      winner.contributingSources = mergeSources(winner, loser);
    }
    out2.push(winner);
  }
  return out2;
}

function mergeSources(a, b) {
  return [...new Set([...(a.contributingSources || []), ...(b.contributingSources || [])])];
}

function backfill(winner, loser) {
  for (const field of ['valuation', 'issuedDate', 'finalizedDate', 'contractor', 'owner', 'description', 'permitNumber']) {
    if (winner[field] == null && loser[field] != null) winner[field] = loser[field];
  }
  if (!winner.location && loser.location) {
    winner.location = loser.location;
    winner.geocode = loser.geocode;
  }
}
