#!/usr/bin/env node
// Quick quality check on the output GeoJSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fc = JSON.parse(readFileSync(join(root, 'data', 'houston.geojson'), 'utf8'));
const feats = fc.features;
console.log(`features: ${feats.length}`);

const withVal = feats.filter((f) => f.properties.valuation > 0).map((f) => f.properties.valuation);
withVal.sort((a, b) => a - b);
const sum = withVal.reduce((a, b) => a + b, 0);
console.log(`with job_value: ${withVal.length}`);
if (withVal.length) {
  const fmt = (n) => '$' + n.toLocaleString();
  console.log(`  median: ${fmt(withVal[Math.floor(withVal.length / 2)])}   max: ${fmt(withVal.at(-1))}   total: ${fmt(sum)}`);
}
const status = {};
for (const f of feats) status[f.properties.status] = (status[f.properties.status] || 0) + 1;
console.log('status:', JSON.stringify(status));

console.log('\n10 highest-value sites:');
[...feats].sort((a, b) => (b.properties.valuation || 0) - (a.properties.valuation || 0)).slice(0, 10).forEach((f) => {
  const p = f.properties;
  console.log(`  ${p.valuation ? '$' + p.valuation.toLocaleString() : '(no val)'} | ${p.issuedDate || 'no date'} | ${p.address}`);
  console.log(`      ${p.description}`);
});
