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
  try {
    prevCount = JSON.parse(await readFile(geojsonPath, 'utf8')).features?.length ?? 0;
  } catch {} // no previous output — first run, nothing to guard
  if (prevCount >= 500 && geocoded.length < prevCount * 0.7 && process.env.SITEWATCH_FORCE_PUBLISH !== '1') {
    throw new Error(
      `Refusing to publish ${cityId}: ${geocoded.length} mapped sites vs ${prevCount} previously (>30% drop — ` +
        `likely a partial pull). Set SITEWATCH_FORCE_PUBLISH=1 to override.`
    );
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
      sources: rec.contributingSources,
    },
  };
}
