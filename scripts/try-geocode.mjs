// Exercise the geocoder fallback + cache on addresses that previously missed.
//   node scripts/try-geocode.mjs [city] [n]
// Defaults: city=texas, n=6. Reads <city>.ungeocoded.json for sample addresses.
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { geocodeMissing } from '../src/pipeline/geocode.js';

const city = process.argv[2] || 'texas';
const n = Number(process.argv[3] || 6);
config.city = city; // so the bbox sanity-check matches the region

const miss = JSON.parse(readFileSync(`data/${city}.ungeocoded.json`, 'utf8'));
const sample = miss.filter((r) => r.address?.line1).slice(0, n);
console.error(`Testing ${sample.length} previously-missed ${city} addresses:\n`);

// Fresh copies so location starts null.
const recs = sample.map((r) => ({ address: r.address, location: null, geocode: null }));

console.time('pass 1 (live)');
const a = await geocodeMissing(recs);
console.timeEnd('pass 1 (live)');
console.error('result:', JSON.stringify(a), '\n');
for (const r of recs) {
  console.error(r.location ? `  OK  [${r.geocode.source}] ${r.address.full}` : `  --  MISS          ${r.address.full}`);
}

// Second pass on fresh copies — should be all cache hits, near-instant.
const recs2 = sample.map((r) => ({ address: r.address, location: null, geocode: null }));
console.time('pass 2 (cached)');
const b = await geocodeMissing(recs2);
console.timeEnd('pass 2 (cached)');
console.error('result:', JSON.stringify(b));
