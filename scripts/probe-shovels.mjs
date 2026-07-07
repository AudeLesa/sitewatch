#!/usr/bin/env node
// Probe the live Shovels API: bootstrap Harris County's geo_id from a Houston
// ZIP, then sample real commercial permits to see the type/subtype vocabulary
// (so the "under construction" filter is designed on real data, not guesses).
import { loadEnv } from '../src/util/env.js';
loadEnv();

const BASE = 'https://api.shovels.ai/v2';
const headers = { 'X-API-Key': process.env.SHOVELS_API_KEY, Accept: 'application/json' };
const iso = (d) => d.toISOString().slice(0, 10);

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers, signal: AbortSignal.timeout(30000) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 1. Bootstrap geo ids from a central Houston ZIP.
const seed = await get(`/permits/search?geo_id=77002&permit_from=2024-01-01&permit_to=${iso(new Date())}&property_type=commercial&size=1`);
const geo = seed.json?.items?.[0]?.geo_ids;
console.log('Houston 77002 geo_ids:', JSON.stringify(geo));
const cityId = geo?.city_id;
const countyId = geo?.county_id;
const targetId = cityId || countyId; // Houston city preferred; county as fallback
if (!targetId) { console.log('could not resolve a geo id'); process.exit(1); }

// 2. Sample commercial permits across Harris County, last 24mo, status active.
const from = new Date(); from.setMonth(from.getMonth() - 24);
const subtypes = new Map();
const types = new Map();
let total = 0, withIssue = 0, withValue = 0, withLatLng = 0, cursor = '';
for (let page = 0; page < 5; page++) {
  const r = await get(
    `/permits/search?geo_id=${targetId}&permit_from=${iso(from)}&permit_to=${iso(new Date())}` +
    `&property_type=commercial&permit_status=active&size=100${cursor ? `&cursor=${cursor}` : ''}`
  );
  const items = r.json?.items || [];
  for (const p of items) {
    total++;
    types.set(p.type, (types.get(p.type) || 0) + 1);
    subtypes.set(p.subtype, (subtypes.get(p.subtype) || 0) + 1);
    if (p.issue_date) withIssue++;
    if (p.job_value > 0) withValue++;
    if (p.address?.latlng) withLatLng++;
  }
  cursor = r.json?.next_cursor;
  if (!cursor || items.length === 0) break;
}

console.log(`\nHouston (geo_id=${targetId})`);
console.log(`sampled ${total} active commercial permits (24mo)`);
console.log(`  with issue_date: ${withIssue}   job_value>0: ${withValue}   latlng: ${withLatLng}`);
const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
console.log('\nTop `type` values:'); for (const [k, v] of top(types)) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log('\nTop `subtype` values:'); for (const [k, v] of top(subtypes)) console.log(`  ${String(v).padStart(4)}  ${k}`);
