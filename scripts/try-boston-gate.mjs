// Boston ISD quality gate — run AFTER `npm run pull:boston`. Read-only.
import { readFileSync, writeFileSync } from 'node:fs';
import { lookbackFloorIso } from '../src/pipeline/filter.js';
import { join } from 'node:path';
import { fetchJson } from '../src/util/http.js';

const root = join(import.meta.dirname, '..');
const geo = JSON.parse(readFileSync(join(root, 'data', 'boston.geojson'), 'utf8')).features.map((f) => f.properties);
const all = JSON.parse(readFileSync(join(root, 'data', 'boston.json'), 'utf8'));
let fail = 0;
const verdict = (ok, name, detail) => { console.log(`${ok ? '  ✔' : '  ✘'} ${name}: ${detail}`); if (!ok) fail++; };
const labelOf = (p) => (/\(([^)]+)\)\s*$/.exec(p.description || '') || [])[1] || '(unparsed)';

// ---- 1. parity vs the portal: distinct Open permits under the same predicate ----
const iso = lookbackFloorIso();
const RID = '6ddcd912-32a0-43df-9908-63574f8c7e77';
const sql = `SELECT count(DISTINCT permitnumber) AS n FROM "${RID}"` +
  ` WHERE issued_date >= '${iso}' AND permittypedescr IN ('Erect/New Construction','Long Form/Alteration Permit')` +
  ` AND occupancytype = 'Comm' AND status = 'Open'`;
const res = await fetchJson(`https://data.boston.gov/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`);
const portalOpen = Number(res.result.records[0].n);
const oursOpen = all.filter((r) => labelOf(r) === 'Open').length;
verdict(oursOpen === portalOpen, 'Open-permit parity', `${oursOpen} kept vs ${portalOpen} distinct in the portal`);

// ---- 2. terminal ceiling ----
const closed = geo.filter((p) => labelOf(p) === 'Closed');
verdict(closed.length === 0, 'terminal ceiling', `${closed.length} Closed permits mapped (must be 0)`);
const zombie = geo.filter((p) => p.lifecycleStage === 'closed' || p.lifecycleStage === 'finished');
verdict(zombie.length === 0, 'no finished/closed on map', `${zombie.length}`);

// ---- 3. duplicates collapsed ----
const perms = new Set(geo.map((p) => p.permitNumber));
verdict(perms.size === geo.length, 'one pin per permit', `${geo.length} records, ${perms.size} distinct permits`);

// ---- 4. valuation sanity: no placeholder pennies ----
const tiny = geo.filter((p) => p.valuation != null && p.valuation < 100);
verdict(tiny.length === 0, 'no placeholder valuations', `${tiny.length} records under $100 (must be 0)`);
const withVal = geo.filter((p) => p.valuation != null).length;
console.log(`   (valuation coverage: ${withVal}/${geo.length} = ${(withVal / geo.length * 100).toFixed(0)}%)`);

// ---- 5. city integrity + placement ----
const cityOf = (addr) => { const p = String(addr || '').split(','); return p.length >= 2 ? p[p.length - 2].trim() : ''; };
const cities = new Map();
for (const p of geo) cities.set(cityOf(p.address), (cities.get(cityOf(p.address)) || 0) + 1);
const badCity = [...cities.keys()].filter((c) => /^[A-Z]{2}$/.test(c) || !c);
verdict(badCity.length === 0, 'city integrity', badCity.length === 0
  ? [...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c, n]) => `${c}:${n}`).join(', ')
  : `bad: ${badCity.join(',')}`);
const ungeo = JSON.parse(readFileSync(join(root, 'data', 'boston.ungeocoded.json'), 'utf8')).length;
verdict(geo.length / (geo.length + ungeo) >= 0.9, 'placement ≥90%', `${geo.length}/${geo.length + ungeo} (${(geo.length / (geo.length + ungeo) * 100).toFixed(1)}%)`);

// ---- 6. audit sample ----
const shuffled = geo.slice();
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const lines = ['# Boston 50-record audit sample', '', `Generated ${new Date().toISOString().slice(0, 10)}.`, ''];
for (const p of shuffled.slice(0, 50)) {
  const raw = p.permitNumber.replace(/^BOS-/, '');
  lines.push(`- **${p.permitNumber}** ${p.status}/${p.lifecycleStage} conf=${p.confidence} · ${p.workClass} · ${p.valuation ? '$' + p.valuation.toLocaleString('en-US') : 'no value'}`);
  lines.push(`  ${p.address} · ${p.description}`);
  lines.push(`  [dataset row](https://data.boston.gov/api/3/action/datastore_search?resource_id=${RID}&filters=${encodeURIComponent(JSON.stringify({ permitnumber: raw }))})`);
}
writeFileSync(join(root, 'data', 'boston-audit-50.md'), lines.join('\n') + '\n');
console.log('\naudit sample → data/boston-audit-50.md');
console.log(fail === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fail})`);
process.exitCode = fail === 0 ? 0 : 1;
