#!/usr/bin/env node
// Resolve Houston-MSA county ids from seed ZIPs in each county, so we can target
// the full metro (not just Harris). Prints county_id + a sample city per seed.
import { loadEnv } from '../src/util/env.js';
loadEnv();

const BASE = 'https://api.shovels.ai/v2';
const headers = { 'X-API-Key': process.env.SHOVELS_API_KEY, Accept: 'application/json' };
const iso = (d) => d.toISOString().slice(0, 10);
const from = new Date(); from.setMonth(from.getMonth() - 24);
const FROM = iso(from), TO = iso(new Date());

// One representative ZIP per Houston-MSA county.
const SEEDS = {
  Harris: '77002',
  'Fort Bend': '77479',   // Sugar Land
  Montgomery: '77301',    // Conroe / The Woodlands
  Galveston: '77573',     // League City
  Brazoria: '77584',      // Pearland
  Waller: '77484',        // Waller
  Liberty: '77575',       // Liberty
  Chambers: '77523',      // Baytown (Chambers side)
};

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(30000) });
  return r.json().catch(() => null);
}

const resolved = {};
for (const [name, zip] of Object.entries(SEEDS)) {
  const j = await get(`/permits/search?geo_id=${zip}&permit_from=${FROM}&permit_to=${TO}&property_type=commercial&size=50`);
  const counts = new Map();
  let sampleCity = '';
  for (const p of j?.items || []) {
    const c = p.geo_ids?.county_id;
    if (c) counts.set(c, (counts.get(c) || 0) + 1);
    if (!sampleCity && p.address?.city) sampleCity = p.address.city;
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '(none)';
  resolved[name] = top;
  console.log(`${name.padEnd(12)} ZIP ${zip} -> county_id=${top}  (e.g. ${sampleCity})`);
}

console.log('\nConfig snippet (geoIds):');
console.log(JSON.stringify(Object.values(resolved).filter((v) => v !== '(none)')));
