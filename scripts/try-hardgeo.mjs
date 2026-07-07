// Measure the hard-case resolver's yield against REAL failed addresses.
//   node scripts/try-hardgeo.mjs [sampleSize=45]
// Samples data/texas.ungeocoded.json across the three failure classes and runs
// resolveHard on each (read-only; touches no caches). Prints per-class yield.
import { readFileSync } from 'node:fs';
import { resolveHard, isHardCandidate } from '../src/pipeline/geocodeHard.js';

const N = Number(process.argv[2] || 45);
const recs = JSON.parse(readFileSync('data/texas.ungeocoded.json', 'utf8'));
const counties = JSON.parse(readFileSync('data/lookups/tabs-counties.json', 'utf8'));

const classify = (a) =>
  /( & | AND | @ |\bSWC\b|\bNWC\b|\bNEC\b|\bSEC\b|CORNER|INTERSECTION)/i.test(a) ? 'intersection'
  : /^\d/.test(a.trim()) ? 'numbered' : 'other';

const byClass = { numbered: [], intersection: [], other: [] };
for (const r of recs) {
  const line1 = r.address?.line1;
  if (!line1) continue;
  byClass[classify(line1)].push(r);
}
console.log(`ungeocoded: ${recs.length} — numbered ${byClass.numbered.length}, intersection ${byClass.intersection.length}, other ${byClass.other.length}\n`);

const per = Math.ceil(N / 2);
const sample = (arr, n) => arr.filter((_, i) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
const cases = [...sample(byClass.numbered, per), ...sample(byClass.intersection, per)];

const stats = {};
for (const r of cases) {
  const line1 = r.address.line1;
  const cls = classify(line1);
  stats[cls] = stats[cls] || { tried: 0, hit: 0, byPrecision: {} };
  stats[cls].tried++;
  if (!isHardCandidate(line1)) { console.log(`  – not a candidate: ${line1}`); continue; }
  const county = counties[String(r.raw?.County)] || null;
  const hit = await resolveHard({ line1, city: r.address.city, county }).catch((e) => (console.log('  ! error', e.message), null));
  if (hit) {
    stats[cls].hit++;
    stats[cls].byPrecision[hit.precision] = (stats[cls].byPrecision[hit.precision] || 0) + 1;
    console.log(`  ✔ [${hit.precision}] ${line1}, ${r.address.city || ''} -> ${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}  (${hit.matched.slice(0, 60)})`);
  } else {
    console.log(`  ✗ ${line1}, ${r.address.city || ''} (${county || 'no county'})`);
  }
}
console.log('\nYield:', JSON.stringify(stats, null, 1));
