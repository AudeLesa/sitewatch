import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../util/env.js';
import { config } from '../config.js';

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

  const geojson = {
    type: 'FeatureCollection',
    features: geocoded.map(toFeature),
  };

  await writeFile(join(dir, `${cityId}.geojson`), JSON.stringify(geojson, null, 2));
  await writeFile(join(dir, `${cityId}.json`), JSON.stringify(records, null, 2));
  await writeFile(join(dir, `${cityId}.ungeocoded.json`), JSON.stringify(ungeocoded, null, 2));

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
