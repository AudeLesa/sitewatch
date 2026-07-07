import { dedupeKey } from '../schema.js';

// Field "richness" used to pick the survivor when two sources describe the same
// physical project. More non-null fields + having coordinates = more complete.
function richness(rec) {
  let score = 0;
  for (const v of Object.values(rec)) if (v != null && v !== '') score++;
  if (rec.location) score += 5;
  if (rec.valuation != null) score += 1;
  return score;
}

/**
 * Collapse records that refer to the same physical project across sources.
 * Keeps the richest record but records every source that saw it in
 * `contributingSources`, and back-fills null fields from the duplicates.
 */
export function dedupe(records) {
  const byKey = new Map();

  for (const rec of records) {
    const key = dedupeKey(rec);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, rec);
      continue;
    }
    const [winner, loser] = richness(rec) > richness(existing) ? [rec, existing] : [existing, rec];
    backfill(winner, loser);
    const sources = new Set([...(winner.contributingSources || []), ...(loser.contributingSources || [])]);
    winner.contributingSources = [...sources];
    byKey.set(key, winner);
  }

  return [...byKey.values()];
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
