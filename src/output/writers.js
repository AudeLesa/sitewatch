import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../util/env.js';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/fsafe.js';

/**
 * Write the run's outputs:
 *   <city>.geojson      — points with geometry (map-ready; this is the product)
 *   <city>.json         — full normalized records (incl. ungeocoded)
 *   <city>.ungeocoded.json — records we couldn't place, for follow-up
 */
export async function writeOutputs(cityId, records) {
  const dir = join(projectRoot, config.output.dir);
  await mkdir(dir, { recursive: true });

  const geocoded = records.filter((r) => r.location);
  const ungeocoded = records.filter((r) => !r.location);

  // Publish guard: a partial upstream failure (TDLR outage, expired session)
  // must never silently replace a good dataset with a shrunken one. Compare
  // against whatever we published last; a big drop needs an explicit override.
  const geojsonPath = join(dir, `${cityId}.geojson`);
  let prevCount = 0;
  let prevBySource = new Map();
  try {
    const prev = JSON.parse(await readFile(geojsonPath, 'utf8')).features ?? [];
    prevCount = prev.length;
    prevBySource = countBySource(prev.map((f) => f.properties?.sources));
  } catch {} // no previous output — first run, nothing to guard
  const force = process.env.SITEWATCH_FORCE_PUBLISH === '1';
  if (prevCount >= 500 && geocoded.length < prevCount * 0.7 && !force) {
    throw new Error(
      `Refusing to publish ${cityId}: ${geocoded.length} mapped sites vs ${prevCount} previously (>30% drop — ` +
        `likely a partial pull). Set SITEWATCH_FORCE_PUBLISH=1 to override.`
    );
  }

  // Per-source tripwire: in a multi-source region the total can look healthy
  // while one feed silently collapses (auth expiry, schema change, portal
  // outage). Same 30% rule, per contributing source — and the printed counts
  // double as a per-source time series in the nightly CI log.
  const bySource = countBySource(geocoded.map((r) => r.contributingSources));
  for (const [src, n] of new Map([...prevBySource, ...bySource])) {
    const prev = prevBySource.get(src) ?? 0;
    const now = bySource.get(src) ?? 0;
    console.log(`  source ${src}: ${now} mapped site(s)${prev ? ` (previous run: ${prev})` : ' (new source)'}`);
    if (prev >= 200 && now < prev * 0.7 && !force) {
      throw new Error(
        `Refusing to publish ${cityId}: source '${src}' fell to ${now} mapped sites vs ${prev} previously ` +
          `(>30% drop — likely a broken or partial feed). Set SITEWATCH_FORCE_PUBLISH=1 to override.`
      );
    }
  }

  const geojson = {
    type: 'FeatureCollection',
    features: geocoded.map(toFeature),
  };

  writeFileAtomic(geojsonPath, JSON.stringify(geojson, null, 2));
  writeFileAtomic(join(dir, `${cityId}.json`), JSON.stringify(records, null, 2));
  writeFileAtomic(join(dir, `${cityId}.ungeocoded.json`), JSON.stringify(ungeocoded, null, 2));

  return {
    dir,
    geojson: `${cityId}.geojson`,
    total: records.length,
    geocoded: geocoded.length,
    ungeocoded: ungeocoded.length,
  };
}

// Tally records per contributing source. `lists` is an iterable of
// sources-arrays (['tdlr_tabs'], possibly several per merged record).
function countBySource(lists) {
  const counts = new Map();
  for (const list of lists) {
    for (const src of list || []) counts.set(src, (counts.get(src) || 0) + 1);
  }
  return counts;
}

function toFeature(rec) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [rec.location.lng, rec.location.lat] },
    properties: {
      id: rec.id,
      permitNumber: rec.permitNumber,
      category: rec.category,
      workClass: rec.workClass,
      status: rec.status,
      confidence: rec.confidence,
      lifecycleStage: rec.lifecycleStage,
      geocodePrecision: rec.geocode?.precision ?? null,
      description: rec.description,
      facilityName: rec.facilityName,
      valuation: rec.valuation,
      squareFeet: rec.squareFeet,
      issuedDate: rec.issuedDate,
      estStartDate: rec.estStartDate,
      estEndDate: rec.estEndDate,
      firstSeenAt: rec.firstSeenAt,
      statusChangedAt: rec.statusChangedAt,
      startedAt: rec.startedAt,
      justStarted: rec.justStarted,
      prevStatus: rec.prevStatus,
      scopeOfWork: rec.scopeOfWork,
      publicFunds: rec.publicFunds,
      address: rec.address.full,
      owner: rec.owner,
      ownerPhone: rec.ownerPhone,
      ownerAddress: rec.ownerAddress,
      contractor: rec.contractor,
      designFirm: rec.designFirm,
      designFirmPhone: rec.designFirmPhone,
      designFirmAddress: rec.designFirmAddress,
      contactName: rec.contactName,
      tenantName: rec.tenantName,
      tenantPhone: rec.tenantPhone,
      rasName: rec.rasName,
      rasPhone: rec.rasPhone,
      zip: rec.address.zip,
      valuationSuspect: rec.valuationSuspect || undefined,
      sourceUrl: rec.sourceUrl || undefined,
      sources: rec.contributingSources,
    },
  };
}
