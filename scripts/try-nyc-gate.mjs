// NYC DOB quality gate — run AFTER `npm run pull:nyc`. Read-only.
//
// NYC's keep-set can't be reproduced with one portal query (the too_old
// filter depends on the GC-permit join), so instead of exact parity this
// gate checks the scar classes directly:
//   1. terminal ceiling — no done/withdrawn statuses on the map
//   2. no-inflation — kept 'Permit Entire/Issued' ≤ the portal's own count
//   3. confidence monotonicity across stages
//   4. BIN uniqueness — the dual-feed merge left no cross-feed twins
//   5. city integrity — every record parses to a real borough
//   6. placement ≥90%
//   7. a 50-record audit sample for human review
import { readFileSync, writeFileSync } from 'node:fs';
import { lookbackFloorIso } from '../src/pipeline/filter.js';
import { join } from 'node:path';
import { fetchAggregate } from '../src/sources/socrata.js';

const root = join(import.meta.dirname, '..');
const geo = JSON.parse(readFileSync(join(root, 'data', 'nyc.geojson'), 'utf8')).features.map((f) => f.properties);
const all = JSON.parse(readFileSync(join(root, 'data', 'nyc.json'), 'utf8'));
let fail = 0;
const verdict = (ok, name, detail) => { console.log(`${ok ? '  ✔' : '  ✘'} ${name}: ${detail}`); if (!ok) fail++; };
const labelOf = (p) => (/\(([^)]+)\)\s*$/.exec(p.description || '') || [])[1] || '(unparsed)';

// ---- 1. terminal ceiling ----
const TERMINAL = new Set(['LOC Issued', 'CO Issued', 'Signed Off', 'Filing Withdrawn', 'COMPLETE', 'Unknown']);
const mappedTerminal = geo.filter((p) => TERMINAL.has(labelOf(p)));
verdict(mappedTerminal.length === 0, 'terminal ceiling', `${mappedTerminal.length} mapped records carry a done/withdrawn status (must be 0)`);
console.log('   status labels on map:', [...geo.reduce((m, p) => m.set(labelOf(p), (m.get(labelOf(p)) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', '));

// ---- 2. no-inflation vs the portal ----
const iso = lookbackFloorIso();
const portal = await fetchAggregate({
  domain: 'data.cityofnewyork.us', datasetId: 'w9ak-ipjd',
  select: 'filing_status,count(*)',
  where: `job_type = 'New Building' AND building_type = 'Other'` +
    ` AND (proposed_dwelling_units IS NULL OR proposed_dwelling_units = '0')` +
    ` AND job_filing_number LIKE '%-I1' AND signoff_date IS NULL`,
  group: 'filing_status',
});
const portalPermitted = portal.filter((r) => /^Permit (Entire|Issued)$/.test(r.filing_status)).reduce((s, r) => s + Number(r.count), 0);
const oursPermitted = geo.filter((p) => /^Permit (Entire|Issued)$/.test(labelOf(p))).length;
verdict(oursPermitted <= portalPermitted && oursPermitted > 0,
  'no inflation', `${oursPermitted} permitted jobs mapped vs ${portalPermitted} in the portal (ours must be ≤ — the too_old filter only subtracts)`);

// ---- 3. confidence monotonicity ----
const byStage = new Map();
for (const p of geo) { if (!byStage.has(p.lifecycleStage)) byStage.set(p.lifecycleStage, []); byStage.get(p.lifecycleStage).push(p.confidence ?? 0); }
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stages = ['pre', 'review', 'building'];
const means = stages.map((s) => mean(byStage.get(s) || []));
for (const [i, s] of stages.entries()) console.log(`   ${s.padEnd(9)} n=${String((byStage.get(s) || []).length).padStart(5)}  mean conf ${means[i].toFixed(2)}`);
verdict(means.every((m, i) => i === 0 || means[i - 1] === 0 || m >= means[i - 1]), 'monotonic confidence', means.map((m) => m.toFixed(2)).join(' → '));
const zombie = geo.filter((p) => p.lifecycleStage === 'closed' || p.lifecycleStage === 'finished');
verdict(zombie.length === 0, 'no finished/closed on map', `${zombie.length} in finished/closed stages`);

// ---- 4. BIN uniqueness across feeds ----
// (raw.bin isn't in the geojson; approximate with coordinates+permit-family:
// a NYCN- and NYCB- record at the same rounded coordinate is a missed twin)
const at = new Map();
let twins = 0;
for (const p of geo) {
  const key = p.address; // same address string across feeds = suspicious
  const fam = p.permitNumber.slice(0, 5);
  if (!at.has(key)) at.set(key, new Set());
  at.get(key).add(fam);
}
for (const fams of at.values()) if (fams.size > 1) twins++;
verdict(twins <= geo.length * 0.01, 'cross-feed twins', `${twins} addresses carry both a NYCN- and NYCB- record (≤1% tolerated; same address ≠ always same job)`);

// ---- 5. city integrity ----
const cityOf = (addr) => { const p = String(addr || '').split(','); return p.length >= 2 ? p[p.length - 2].trim() : ''; };
const BOROUGHS = new Set(['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'New York']);
const badCity = geo.filter((p) => !BOROUGHS.has(cityOf(p.address)));
verdict(badCity.length === 0, 'city integrity', badCity.length === 0
  ? [...geo.reduce((m, p) => m.set(cityOf(p.address), (m.get(cityOf(p.address)) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(', ')
  : `bad cities: ${[...new Set(badCity.map((p) => cityOf(p.address)))].slice(0, 5).join(', ')}`);

// ---- 6. placement ----
const ungeo = JSON.parse(readFileSync(join(root, 'data', 'nyc.ungeocoded.json'), 'utf8')).length;
const placed = geo.length / (geo.length + ungeo);
verdict(placed >= 0.9, 'placement ≥90%', `${geo.length}/${geo.length + ungeo} (${(placed * 100).toFixed(1)}%)`);

// ---- 7. audit sample ----
const shuffled = geo.slice();
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const lines = ['# NYC 50-record audit sample', '', `Generated ${new Date().toISOString().slice(0, 10)} — verify each against its official record link.`, ''];
for (const p of shuffled.slice(0, 50)) {
  lines.push(`- **${p.permitNumber}** ${p.status}/${p.lifecycleStage} conf=${p.confidence} · ${p.valuation ? '$' + p.valuation.toLocaleString('en-US') : 'no value'}${p.contractor ? ' · GC: ' + p.contractor : ''}`);
  lines.push(`  ${p.address} · ${p.description}`);
  lines.push(`  [official record](${p.sourceUrl || '(none)'})`);
}
writeFileSync(join(root, 'data', 'nyc-audit-50.md'), lines.join('\n') + '\n');
console.log(`\naudit sample → data/nyc-audit-50.md`);

console.log(fail === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fail})`);
process.exitCode = fail === 0 ? 0 : 1;
