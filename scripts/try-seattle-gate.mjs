// Seattle SDCI quality gate — run AFTER `npm run pull:seattle`. Read-only.
//
// Every new source passes this before its region goes public (the inverted-
// TABS-confidence scar: never trust a source's status semantics unaudited):
//   1. status distribution: our pull vs the portal's own live counts
//   2. terminal-status ceiling: nothing mapped may carry a terminal status
//   3. confidence monotonicity: mean confidence must rise pre → review →
//      building and collapse at closed
//   4. placement: ≥90% of kept records must be on the map
//   5. a 50-record audit sample written for human review
import { readFileSync, writeFileSync } from 'node:fs';
import { lookbackFloorIso } from '../src/pipeline/filter.js';
import { join } from 'node:path';
import { fetchAggregate } from '../src/sources/socrata.js';
import { STATUS_MAP, PERMIT_PREFIX } from '../src/sources/seattleSdci.js';

const root = join(import.meta.dirname, '..');
const geo = JSON.parse(readFileSync(join(root, 'data', 'seattle.geojson'), 'utf8')).features.map((f) => f.properties);
const all = JSON.parse(readFileSync(join(root, 'data', 'seattle.json'), 'utf8'));
let fail = 0;
const verdict = (ok, name, detail) => { console.log(`${ok ? '  ✔' : '  ✘'} ${name}: ${detail}`); if (!ok) fail++; };

// The same window the adapter pulls (24mo lookback on issued-or-applied),
// PLUS the pipeline's keep-predicate (build classes only, non-terminal
// statuses) applied server-side — data/seattle.json holds post-filter records,
// so the portal side must be filtered identically for the counts to be
// comparable. What this catches: records we lost that we should have kept.
const iso = lookbackFloorIso();
const TERMINAL_LABELS = Object.entries(STATUS_MAP).filter(([, v]) => v.stage === 'closed').map(([k]) => k);
const where = `permitclassmapped = 'Non-Residential' AND permittypemapped = 'Building'` +
  ` AND (issueddate >= '${iso}' OR (issueddate IS NULL AND applieddate >= '${iso}'))` +
  ` AND permittypedesc IN ('New','Addition/Alteration')` +
  ` AND statuscurrent NOT IN (${TERMINAL_LABELS.map((s) => `'${s}'`).join(',')})` +
  ` AND completeddate IS NULL`; // the pipeline drops any record with a completion date (filter reason: finalized)

// ---- 1. status distribution vs the portal ----
console.log('\n1. Status distribution — our kept records vs the portal (same predicate):');
const portal = await fetchAggregate({
  domain: 'data.seattle.gov', datasetId: '76t5-zqzr',
  select: 'statuscurrent,count(*)', where, group: 'statuscurrent',
});
const portalCounts = new Map(portal.map((r) => [r.statuscurrent ?? '(null)', Number(r.count)]));
const ourCounts = new Map();
for (const r of all) {
  const label = (/\(([^)]+)\)\s*$/.exec(r.description || '') || [])[1] || '(unparsed)';
  ourCounts.set(label, (ourCounts.get(label) || 0) + 1);
}
let drift = 0;
for (const [status, n] of [...portalCounts].sort((a, b) => b[1] - a[1])) {
  const ours = ourCounts.get(status) || 0;
  const off = ours !== n;
  if (off) drift++;
  console.log(`     ${String(n).padStart(6)} portal | ${String(ours).padStart(6)} pulled  ${status}${off ? '  ← MISMATCH' : ''}`);
}
verdict(drift === 0, 'per-status parity', drift === 0 ? 'every status count matches the portal exactly' : `${drift} statuses differ from the portal`);

// ---- 2. terminal-status ceiling ----
const TERMINAL = new Set(Object.entries(STATUS_MAP).filter(([, v]) => v.stage === 'closed').map(([k]) => k));
const mappedTerminal = geo.filter((p) => {
  const label = (/\(([^)]+)\)\s*$/.exec(p.description || '') || [])[1];
  return TERMINAL.has(label);
});
verdict(mappedTerminal.length === 0, 'terminal ceiling', `${mappedTerminal.length} mapped records carry a terminal portal status (must be 0)`);

// ---- 3. confidence monotonicity ----
console.log('\n3. Confidence by lifecycle stage (mapped records):');
const byStage = new Map();
for (const p of geo) {
  if (!byStage.has(p.lifecycleStage)) byStage.set(p.lifecycleStage, []);
  byStage.get(p.lifecycleStage).push(p.confidence ?? 0);
}
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stages = ['pre', 'review', 'building'];
const means = stages.map((s) => mean(byStage.get(s) || []));
for (const [i, s] of stages.entries()) console.log(`     ${s.padEnd(9)} n=${String((byStage.get(s) || []).length).padStart(5)}  mean conf ${means[i].toFixed(2)}`);
const mono = means.every((m, i) => i === 0 || means[i - 1] === 0 || m >= means[i - 1]);
verdict(mono, 'monotonic confidence', mono ? 'pre ≤ review ≤ building' : `means ${means.map((m) => m.toFixed(2)).join(' → ')} not monotonic`);
const zombie = geo.filter((p) => p.lifecycleStage === 'closed' || p.lifecycleStage === 'finished');
verdict(zombie.length === 0, 'no finished/closed on map', `${zombie.length} mapped records in finished/closed stages`);

// ---- 3b. city-page integrity: no state codes masquerading as cities ----
// (caught live once: a 4-part address `full` made cityOf() return 'WA' and
// most of the region landed on a city page literally named "WA")
const cityOf = (addr) => { const p = String(addr || '').split(','); return p.length >= 2 ? p[p.length - 2].trim() : ''; };
const cities = new Map();
for (const p of geo) { const c = cityOf(p.address); cities.set(c, (cities.get(c) || 0) + 1); }
const badCities = [...cities.keys()].filter((c) => /^[A-Z]{2}$/.test(c) || !c);
verdict(badCities.length === 0, 'city integrity', badCities.length === 0
  ? `cities parse cleanly (${[...cities.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c}:${n}`).join(', ')})`
  : `suspicious city values: ${badCities.join(', ')}`);

// ---- 4. placement rate ----
const rate = geo.length / all.filter((r) => r).length;
// kept = records that survived the filter — seattle.json holds ALL records incl. unfiltered;
// mapped/kept is what writers.js reported. Recompute conservatively: geo / (geo + ungeocoded).
const ungeo = JSON.parse(readFileSync(join(root, 'data', 'seattle.ungeocoded.json'), 'utf8')).length;
const placed = geo.length / (geo.length + ungeo);
verdict(placed >= 0.9, 'placement ≥90%', `${geo.length}/${geo.length + ungeo} kept records placed (${(placed * 100).toFixed(1)}%)`);

// ---- 5. audit sample ----
const shuffled = geo.slice();
for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
const sample = shuffled.slice(0, 50);
const lines = ['# Seattle 50-record audit sample', '', `Generated ${new Date().toISOString().slice(0, 10)} — verify each against the portal link.`, ''];
for (const p of sample) {
  const raw = p.permitNumber.slice(PERMIT_PREFIX.length);
  lines.push(`- **${p.permitNumber}** ${p.status}/${p.lifecycleStage} conf=${p.confidence} · ${p.workClass} · ${p.category} · ${p.valuation ? '$' + p.valuation.toLocaleString('en-US') : 'no value'}`);
  lines.push(`  ${p.address} · ${p.description}`);
  lines.push(`  [portal](https://services.seattle.gov/portal/customize/LinkToRecord.aspx?altId=${raw}) · [dataset row](https://data.seattle.gov/resource/76t5-zqzr.json?permitnum=${encodeURIComponent(raw)})`);
}
const auditPath = join(root, 'data', 'seattle-audit-50.md');
writeFileSync(auditPath, lines.join('\n') + '\n');
console.log(`\n5. Audit sample → ${auditPath}`);

console.log(fail === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fail} check(s) failed)`);
process.exitCode = fail === 0 ? 0 : 1; // not process.exit(): a hard exit races undici's keep-alive teardown on Windows
