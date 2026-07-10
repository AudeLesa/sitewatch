// San Francisco DBI quality gate — run AFTER `npm run pull:sf`. Read-only.
import { readFileSync, writeFileSync } from 'node:fs';
import { lookbackFloorIso } from '../src/pipeline/filter.js';
import { join } from 'node:path';
import { fetchAggregate } from '../src/sources/socrata.js';
import { STATUS_MAP } from '../src/sources/sfDbi.js';

const root = join(import.meta.dirname, '..');
const geo = JSON.parse(readFileSync(join(root, 'data', 'sf.geojson'), 'utf8')).features.map((f) => f.properties);
const all = JSON.parse(readFileSync(join(root, 'data', 'sf.json'), 'utf8'));
let fail = 0;
const verdict = (ok, name, detail) => { console.log(`${ok ? '  ✔' : '  ✘'} ${name}: ${detail}`); if (!ok) fail++; };
const labelOf = (p) => (/\(([^)]+)\)\s*$/.exec(p.description || '') || [])[1] || '(unparsed)';

// ---- 1. no-inflation vs the portal: our kept 'issued' count must not exceed
// the portal's issued rows under the adapter's WHERE (the residential-use and
// finalized drops only subtract; use-classification is ours, not the portal's,
// so exact parity is not derivable server-side) ----
const iso = lookbackFloorIso();
const portal = await fetchAggregate({
  domain: 'data.sfgov.org', datasetId: 'i98e-djp9',
  select: 'status,count(*)',
  where: `permit_type IN ('1','2','3') AND (issued_date >= '${iso}' OR (issued_date IS NULL AND filed_date >= '${iso}'))`,
  group: 'status',
});
const portalIssued = portal.filter((r) => /^(issued|reinstated)$/i.test(r.status || '')).reduce((s, r) => s + Number(r.count), 0);
const oursIssued = all.filter((r) => /^(issued|reinstated)$/i.test(labelOf(r))).length;
verdict(oursIssued > 0 && oursIssued <= portalIssued, 'no inflation', `${oursIssued} issued kept vs ${portalIssued} in the portal (ours must be ≤)`);

// ---- 2. terminal ceiling ----
const TERMINAL = new Set(Object.entries(STATUS_MAP).filter(([, v]) => v.stage === 'closed').map(([k]) => k));
const mappedTerminal = geo.filter((p) => TERMINAL.has(String(labelOf(p)).toLowerCase()));
verdict(mappedTerminal.length === 0, 'terminal ceiling', `${mappedTerminal.length} mapped with terminal status (must be 0)`);
const zombie = geo.filter((p) => p.lifecycleStage === 'closed' || p.lifecycleStage === 'finished');
verdict(zombie.length === 0, 'no finished/closed on map', `${zombie.length}`);

// ---- 3. residential screen held ----
const resLeak = geo.filter((p) => /dwelling|apartment|residns/i.test(p.scopeOfWork || ''));
console.log(`   (scope-text residential mentions on map: ${resLeak.length} — alterations at mixed buildings may legitimately mention them)`);
const tiny = geo.filter((p) => p.valuation != null && p.valuation < 100);
verdict(tiny.length === 0, 'no placeholder valuations', `${tiny.length} under $100 (must be 0)`);

// ---- 4. city integrity + placement ----
const cityOf = (addr) => { const p = String(addr || '').split(','); return p.length >= 2 ? p[p.length - 2].trim() : ''; };
const badCity = geo.filter((p) => cityOf(p.address) !== 'San Francisco');
verdict(badCity.length === 0, 'city integrity', badCity.length === 0 ? `all ${geo.length} parse to San Francisco` : `${badCity.length} bad`);
const ungeo = JSON.parse(readFileSync(join(root, 'data', 'sf.ungeocoded.json'), 'utf8')).length;
verdict(geo.length / (geo.length + ungeo) >= 0.9, 'placement ≥90%', `${geo.length}/${geo.length + ungeo} (${(geo.length / (geo.length + ungeo) * 100).toFixed(1)}%)`);

// ---- 5. audit sample ----
const shuffled = geo.slice();
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const lines = ['# San Francisco 50-record audit sample', '', `Generated ${new Date().toISOString().slice(0, 10)}.`, ''];
for (const p of shuffled.slice(0, 50)) {
  const raw = p.permitNumber.replace(/^SF-/, '');
  lines.push(`- **${p.permitNumber}** ${p.status}/${p.lifecycleStage} conf=${p.confidence} · ${p.workClass} · ${p.category} · ${p.valuation ? '$' + p.valuation.toLocaleString('en-US') : 'no value'}`);
  lines.push(`  ${p.address} · ${p.description}`);
  lines.push(`  [dataset row](https://data.sfgov.org/resource/i98e-djp9.json?permit_number=${encodeURIComponent(raw)})`);
}
writeFileSync(join(root, 'data', 'sf-audit-50.md'), lines.join('\n') + '\n');
console.log('\naudit sample → data/sf-audit-50.md');
console.log(fail === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fail})`);
process.exitCode = fail === 0 ? 0 : 1;
