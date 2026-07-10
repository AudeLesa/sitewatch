// Philadelphia L&I quality gate — run AFTER `npm run pull:philly`. Read-only.
import { readFileSync, writeFileSync } from 'node:fs';
import { lookbackFloorIso } from '../src/pipeline/filter.js';
import { join } from 'node:path';
import { fetchJson } from '../src/util/http.js';
import { STATUS_MAP } from '../src/sources/phillyLni.js';

const root = join(import.meta.dirname, '..');
const geo = JSON.parse(readFileSync(join(root, 'data', 'philly.geojson'), 'utf8')).features.map((f) => f.properties);
const all = JSON.parse(readFileSync(join(root, 'data', 'philly.json'), 'utf8'));
let fail = 0;
const verdict = (ok, name, detail) => { console.log(`${ok ? '  ✔' : '  ✘'} ${name}: ${detail}`); if (!ok) fail++; };
const labelOf = (p) => (/\(([^)]+)\)\s*$/.exec(p.description || '') || [])[1] || '(unparsed)';

// ---- 1. per-status parity vs the portal (same predicate incl. the pipeline's
// finalized/terminal drops: completed-date null + non-terminal status) ----
const iso = lookbackFloorIso();
const TERMINAL = Object.entries(STATUS_MAP).filter(([, v]) => v.stage === 'closed').map(([k]) => k);
const TYPES = ['New Construction', 'New Construction (Shell Only)', 'New construction, addition, GFA change', 'New Construction or Additions', 'Addition and/or Alteration', 'Addition and/or Alterations'];
const sql =
  `SELECT status, count(*) FROM permits` +
  ` WHERE commercialorresidential = 'Commercial' AND permittype = 'Building'` +
  ` AND typeofwork IN (${TYPES.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})` +
  ` AND permitissuedate >= '${iso}'` +
  ` AND status NOT IN (${TERMINAL.map((s) => `'${s}'`).join(',')})` +
  ` AND permitcompleteddate IS NULL GROUP BY status ORDER BY count DESC`;
const portal = (await fetchJson(`https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}`)).rows;
const ourCounts = new Map();
for (const r of all) ourCounts.set(labelOf(r), (ourCounts.get(labelOf(r)) || 0) + 1);
let drift = 0;
console.log('1. Status distribution — kept records vs the portal (same predicate):');
for (const { status, count } of portal) {
  const ours = ourCounts.get(status) || 0;
  if (ours !== Number(count)) drift++;
  console.log(`     ${String(count).padStart(6)} portal | ${String(ours).padStart(6)} pulled  ${status}${ours !== Number(count) ? '  ← MISMATCH' : ''}`);
}
verdict(drift === 0, 'per-status parity', drift === 0 ? 'every status count matches the portal exactly' : `${drift} statuses differ`);

// ---- 2. terminal ceiling + no finished/closed ----
const mappedTerminal = geo.filter((p) => TERMINAL.includes(labelOf(p)));
verdict(mappedTerminal.length === 0, 'terminal ceiling', `${mappedTerminal.length} mapped with terminal status (must be 0)`);
const zombie = geo.filter((p) => p.lifecycleStage === 'closed' || p.lifecycleStage === 'finished');
verdict(zombie.length === 0, 'no finished/closed on map', `${zombie.length}`);

// ---- 3. valuation absence honored ----
const withVal = geo.filter((p) => p.valuation != null).length;
verdict(withVal === 0, 'no-valuation capability', `${withVal} records carry a valuation (source has none — must be 0)`);

// ---- 4. city integrity + placement ----
const cityOf = (addr) => { const p = String(addr || '').split(','); return p.length >= 2 ? p[p.length - 2].trim() : ''; };
const badCity = geo.filter((p) => cityOf(p.address) !== 'Philadelphia');
verdict(badCity.length === 0, 'city integrity', badCity.length === 0 ? `all ${geo.length} parse to Philadelphia` : `${badCity.length} bad`);
const ungeo = JSON.parse(readFileSync(join(root, 'data', 'philly.ungeocoded.json'), 'utf8')).length;
verdict(geo.length / (geo.length + ungeo) >= 0.9, 'placement ≥90%', `${geo.length}/${geo.length + ungeo} (${(geo.length / (geo.length + ungeo) * 100).toFixed(1)}%)`);

// ---- 5. audit sample ----
const shuffled = geo.slice();
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const lines = ['# Philadelphia 50-record audit sample', '', `Generated ${new Date().toISOString().slice(0, 10)}.`, ''];
for (const p of shuffled.slice(0, 50)) {
  const raw = p.permitNumber.replace(/^PHL-/, '');
  lines.push(`- **${p.permitNumber}** ${p.status}/${p.lifecycleStage} conf=${p.confidence} · ${p.workClass}${p.contractor ? ' · GC: ' + p.contractor : ''}${p.owner ? ' · owner: ' + p.owner : ''}`);
  lines.push(`  ${p.address} · ${p.description}`);
  lines.push(`  [atlas](${p.sourceUrl || '(none)'}) · [dataset row](https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(`SELECT * FROM permits WHERE permitnumber='${raw}'`)})`);
}
writeFileSync(join(root, 'data', 'philly-audit-50.md'), lines.join('\n') + '\n');
console.log('\naudit sample → data/philly-audit-50.md');
console.log(fail === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fail})`);
process.exitCode = fail === 0 ? 0 : 1;
