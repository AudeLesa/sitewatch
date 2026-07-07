#!/usr/bin/env node
import { config, activeCity } from './config.js';
import * as tdlrTabs from './sources/tdlrTabs.js';
import * as shovels from './sources/shovels.js';
import * as houston from './sources/houstonSoldPermits.js';
import * as demo from './sources/demo.js';
import { dedupe } from './pipeline/dedupe.js';
import { applyFilter } from './pipeline/filter.js';
import { geocodeMissing, geocodeOne } from './pipeline/geocode.js';
import { applyHistory } from './pipeline/history.js';
import { writeOutputs } from './output/writers.js';

const log = console.error; // keep stdout clean for piping

// tdlrTabs is the primary (free, statewide) source; the others supplement it.
const SOURCES = [tdlrTabs, shovels, houston]; // demo is opt-in via the `demo` command

async function main() {
  const cmd = process.argv[2] || 'help';
  switch (cmd) {
    case 'pull':
      return pull(SOURCES, { cityId: process.argv[3] });
    case 'demo':
      // Writes to <city>-demo.* so it never clobbers a real pull's output.
      return pull([demo], { outputId: `${activeCity().id}-demo` });
    case 'sources':
      return listSources();
    case 'geocode-test':
      return geocodeTest();
    default:
      return help();
  }
}

async function pull(sources, { cityId, outputId } = {}) {
  if (cityId) config.city = cityId; // so activeCity() everywhere reflects the override
  const city = activeCity();
  const outId = outputId || city.id;
  log(`\n▶ SiteWatch pull — ${city.label} (lookback ${config.lookbackMonths}mo)\n`);

  // 1. Fetch from every source.
  let records = [];
  for (const src of sources) {
    try {
      const got = await src.fetchPermits({ log });
      records.push(...got);
    } catch (err) {
      log(`[${src.id}] ERROR: ${err.message}`);
      // A source that *threw* (vs. returning []) is a real failure. Finish the
      // run with whatever we have, but exit non-zero so CI won't deploy it.
      process.exitCode = 1;
    }
  }
  log(`\nFetched ${records.length} raw records.`);
  if (records.length === 0) {
    log('Nothing to process. Add a Shovels key or finalize Houston, or try: npm run demo\n');
    return;
  }

  // 2. Merge the same project seen by multiple sources.
  records = dedupe(records);
  log(`After cross-source dedupe: ${records.length}.`);

  // 3. Keep only "currently under commercial construction".
  const { kept, reasons } = applyFilter(records);
  log(`After filter: ${kept.length} under-construction.  Dropped: ${fmt(reasons)}`);

  // 4. Geocode the records that didn't arrive with coordinates.
  const geo = await geocodeMissing(kept, { log });
  const fb = geo.fallback ? `, ${geo.fallback.provider} +${geo.fallback.hits}/${geo.fallback.used}` : '';
  log(`Geocoded: ${geo.matched}/${geo.attempted} (missed ${geo.missed}; ${geo.fromCache} cached${fb}).`);

  // 5. Diff status across runs → first-seen, status changes, and "new starts".
  const hist = applyHistory(kept);
  log(`History: tracking ${hist.tracked}; +${hist.added} new, ${hist.started} just started construction, ${hist.changed} status changes.`);

  // 6. Write map-ready outputs.
  const res = await writeOutputs(outId, kept);
  log(`\n✔ Wrote ${res.geocoded} points -> ${res.dir}\\${res.geojson}`);
  log(`  (${res.ungeocoded} ungeocoded, see ${outId}.ungeocoded.json)\n`);
}

function listSources() {
  log('Configured sources:');
  log(`  tdlr_tabs            ${config.sources.tdlrTabs.enabled ? 'ENABLED (free, no key)' : 'disabled (TABS_ENABLED=false)'}`);
  log(`  shovels              ${config.sources.shovels.enabled ? 'ENABLED' : 'disabled (set SHOVELS_API_KEY)'}`);
  const h = config.sources.houstonSoldPermits;
  log(`  houston_sold_permits ${h.servlet && h.ibifEx ? 'ENABLED' : 'not finalized (run npm run probe:houston)'}`);
  log('  demo                 always available via `npm run demo`');
}

async function geocodeTest() {
  const samples = ['1500 McKinney St, Houston, TX 77010', '2800 Post Oak Blvd, Houston, TX 77056'];
  for (const s of samples) {
    const hit = await geocodeOne(s);
    log(hit ? `OK   ${s}  ->  ${hit.lat}, ${hit.lng}  (${hit.matched})` : `MISS ${s}  ->  no match`);
  }
}

function help() {
  log(`SiteWatch — commercial construction data pipeline

Usage:
  npm run pull            Fetch the Houston metro -> data/houston.geojson
  npm run pull:texas      Fetch the WHOLE STATE -> data/texas.geojson (long run)
  npm run demo            Run the full pipeline on bundled sample Houston data
  npm run sources         Show which sources are configured
  npm run geocode:test    Hit the Census geocoder on two sample addresses
  npm run probe:houston   Discover the Houston WebFOCUS servlet + report name
`);
}

function fmt(obj) {
  const e = Object.entries(obj);
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(', ') : 'none';
}

main().catch((err) => {
  log('FATAL:', err.stack || err.message);
  process.exit(1);
});
