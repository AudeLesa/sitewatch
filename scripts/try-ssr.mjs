// Prove the SSR migration is byte-exact: render every project page the way
// functions/project/[[permit]].js does at request time (shard entry → shared
// template → HTML) and compare against a hash manifest of the pre-SSR static
// pages. Run AFTER a build that emits shards, with a baseline captured BEFORE:
//   node scripts/try-ssr.mjs <baseline.md5>
// Baseline lines look like:  <md5>  project/<permit>.html
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderProjectPage, TX_REGION } from './lib/project-page.mjs';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
const baselinePath = process.argv[2];
if (!baselinePath) { console.error('usage: node scripts/try-ssr.mjs <baseline.md5>'); process.exit(1); }

// Baseline: md5 per project page from the pre-SSR build.
const baseline = new Map();
for (const line of readFileSync(baselinePath, 'utf8').split('\n')) {
  const m = /^([0-9a-f]{32})\s+project\/(.+)\.html$/.exec(line.trim());
  if (m) baseline.set(m[2], m[1]);
}
if (!baseline.size) { console.error('no project/*.html hashes found in the baseline'); process.exit(1); }

// Region resolution — identical to the function's logic: the deployment's
// manifest entry merged over the Texas defaults, defaults on any miss.
let regions = [];
try { regions = JSON.parse(readFileSync(join(dist, 'data', 'regions.json'), 'utf8')); } catch {}
const regionFor = (id) => {
  const found = regions.find((x) => x.id === (id || 'texas'));
  return found ? { ...TX_REGION, ...found } : TX_REGION;
};

const site = (process.env.SITE_URL || 'https://sitewatch-eyt.pages.dev').replace(/\/$/, '');
const shardDir = join(dist, 'data', 'shards');
let total = 0, identical = 0, missingBaseline = 0;
const mismatches = [];
for (const f of readdirSync(shardDir)) {
  if (!f.endsWith('.json')) continue;
  const shard = JSON.parse(readFileSync(join(shardDir, f), 'utf8'));
  for (const [file, entry] of Object.entries(shard)) {
    total++;
    const html = renderProjectPage(entry, { site, region: regionFor(entry.r) });
    const md5 = createHash('md5').update(html).digest('hex');
    const want = baseline.get(file);
    if (!want) { missingBaseline++; continue; } // new permit since the baseline build
    if (md5 === want) identical++;
    else if (mismatches.length < 5) mismatches.push(file);
  }
}
const covered = total - missingBaseline;
console.log(`rendered ${total} pages: ${identical}/${covered} byte-identical to the static baseline` +
  (missingBaseline ? ` (${missingBaseline} new since baseline, no reference)` : ''));
if (baseline.size > covered) console.log(`note: ${baseline.size - covered} baseline pages have no shard entry (dropped from the dataset since)`);
if (mismatches.length) console.log('MISMATCHES (first 5):', mismatches.join(', '));
const ok = covered > 0 && identical === covered;
console.log(ok ? 'PASS — the on-demand renderer reproduces the static pages exactly.' : 'FAIL');
process.exit(ok ? 0 : 1);
