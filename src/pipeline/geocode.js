import { join } from 'node:path';
import { config, activeRegion } from '../config.js';
import { projectRoot } from '../util/env.js';
import { fetchJson, mapLimit, sleep } from '../util/http.js';
import { writeFileAtomic, loadStateFile } from '../util/fsafe.js';
import { resolveHard, isHardCandidate } from './geocodeHard.js';
import { oneLine } from '../util/address.js';

// ---------------------------------------------------------------------------
// Geocoding with a fallback chain + a persistent disk cache.
//
//   1. U.S. Census geocoder — free, no key, fast/concurrent. Great coverage of
//      *established* addresses, but it systematically misses brand-new
//      construction (the address isn't in its file yet) — exactly what we track.
//   2. Fallback — OpenStreetMap/Nominatim (free, no key) or LocationIQ (free key,
//      faster). Different underlying data, so it recovers many of Census's misses.
//
// Every lookup (hit OR miss) is cached to data/geocode-cache.json keyed by the
// query string, with the providers tried and WHEN (`at`). Re-runs are nearly
// instant for known addresses, and adding a new fallback automatically retries
// old misses. Two behaviors matter for a product that tracks BRAND-NEW
// construction:
//
//   • Negatives EXPIRE (60d): new addresses enter Census TIGER / OSM months
//     after registration — exactly our records — so a miss is retried once the
//     entry goes stale instead of being dead forever (pre-2026-07, 20% of the
//     dataset was permanently invisible this way).
//   • Out-of-bbox hits are KEPT and bbox-checked at read time per active city,
//     so a Houston-preset run can't poison the shared cache for statewide runs.
//
// Each hit records a precision tier ('address' | 'street' | 'area') so the map
// can badge pins that only matched a road or a city centroid.
// ---------------------------------------------------------------------------

const SINGLE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const LOCATIONIQ_URL = 'https://us1.locationiq.com/v1/search';
const CACHE_PATH = join(projectRoot, config.output.dir, 'geocode-cache.json');
const NEGATIVE_TTL_DAYS = 60; // a miss older than this is worth asking again

export async function geocodeMissing(records, { log = () => {} } = {}) {
  const cache = loadCache();
  const bbox = activeRegion().bbox;
  const needs = records.filter((r) => !r.location && oneLine(r.address));

  // Each pending item carries the providers already tried (from cache).
  // A provider counts as "tried" if it returned a hit (its answer stands), or
  // if its negative is still fresh — stale negatives are retried.
  const pending = [];
  for (const rec of needs) {
    const key = oneLine(rec.address);
    const c = cache[key];
    if (c && c.lat != null && inBbox(c, bbox)) { applyHit(rec, c); continue; } // cached hit — instant
    const tried = new Set(
      c?.lat != null ? c.tried || [] : (c?.tried || []).filter((prov) => negativeIsFresh(c, prov))
    );
    pending.push({ rec, key, tried, prior: c });
  }
  const fromCache = needs.length - pending.length;

  // Pass 1 — Census, concurrent, for anything not already tried there.
  const censusTodo = pending.filter((p) => !p.tried.has('census'));
  if (censusTodo.length) log(`[geocode] census: ${censusTodo.length} addresses (${fromCache} already cached)...`);
  await mapLimit(censusTodo, config.geocoder.concurrency, async (p) => {
    const hit = await geocodeCensus(p.key);
    record(cache, p, hit, 'census', bbox);
  });
  const placedByCensus = pending.filter((p) => p.rec.location).length;
  log(`[geocode] census placed ${fromCache + placedByCensus}/${needs.length}; ${pending.length - placedByCensus} still missing.`);

  // Pass 2 — fallback provider, serial + rate-limited + capped per run.
  const provider = fallbackProvider();
  let fallbackUsed = 0;
  let fallbackHits = 0;
  let dirty = 0;
  if (provider) {
    const todo = pending.filter((p) => !p.rec.location && !p.tried.has(provider.name));
    const limit = Math.min(todo.length, config.geocoder.fallbackMax);
    if (limit) {
      const mins = Math.ceil((limit * provider.minIntervalMs) / 60000);
      log(`[geocode] ${provider.name} fallback: trying ${limit} of ${todo.length} misses (~${mins} min at ${(1000 / provider.minIntervalMs).toFixed(1)}/s)...`);
    }
    for (const p of todo) {
      if (fallbackUsed >= config.geocoder.fallbackMax) break;
      const hit = await provider.fn(p.key);
      fallbackUsed++;
      record(cache, p, hit, provider.name, bbox);
      if (hit && inBbox(hit, bbox)) fallbackHits++;
      if (fallbackUsed % 100 === 0) log(`[geocode] ${provider.name} ${fallbackUsed}/${limit} (+${fallbackHits} recovered)`);
      if (++dirty % 200 === 0) saveCache(cache); // checkpoint long runs
      await sleep(provider.minIntervalMs);
    }
  }

  // Pass 3 — hard cases via a region-specific address-point provider (texas:
  // TxGIO statewide points — brand-new addresses the classic geocoders don't
  // know yet, nearest-number street snaps, and "A & B" intersections). The
  // provider is chosen by the region manifest; GEOCODER_HARD overrides.
  const hardName = config.geocoder.hard ?? activeRegion().geocoder?.hard ?? 'none';
  let hardUsed = 0;
  let hardHits = 0;
  if (hardName !== 'none' && hardName !== 'txpts') {
    log(`[geocode] unknown hard-tier provider "${hardName}" — skipping pass 3.`);
  } else if (hardName === 'txpts') {
    const todo = pending.filter(
      (p) => !p.rec.location && !p.tried.has(hardName) && isHardCandidate(p.rec.address.line1)
    );
    const limit = Math.min(todo.length, config.geocoder.hardMax);
    if (limit) log(`[geocode] ${hardName} hard cases: trying ${limit} of ${todo.length} (address points: exact / nearest-number / intersections)...`);
    await mapLimit(todo.slice(0, limit), 4, async (p) => {
      const hit = await resolveHard({
        line1: p.rec.address.line1,
        city: p.rec.address.city,
        county: p.rec.address.county,
      }).catch(() => null);
      record(cache, p, hit, hardName, bbox);
      hardUsed++;
      if (hit && inBbox(hit, bbox)) hardHits++;
      if (hardUsed % 100 === 0) {
        log(`[geocode] ${hardName} ${hardUsed}/${limit} (+${hardHits} recovered)`);
        saveCache(cache); // checkpoint
      }
    });
    if (limit) log(`[geocode] ${hardName} done: +${hardHits}/${hardUsed} placed.`);
  }

  saveCache(cache);
  const matched = needs.filter((r) => r.location).length;
  return {
    matched,
    missed: needs.length - matched,
    attempted: needs.length,
    fromCache,
    fallback: provider ? { provider: provider.name, used: fallbackUsed, hits: fallbackHits } : null,
    hard: hardUsed ? { provider: hardName, used: hardUsed, hits: hardHits } : null,
  };
}

/** Write a result (hit or miss) into the cache; apply to the record only when
 * the hit falls inside the active city's bbox (the hit itself is kept either
 * way — another preset with a different bbox may use it). */
function record(cache, p, hit, providerName, bbox) {
  p.tried.add(providerName);
  const at = { ...(p.prior?.at || {}), [providerName]: new Date().toISOString().slice(0, 10) };
  if (hit) {
    cache[p.key] = { lat: hit.lat, lng: hit.lng, matched: hit.matched, precision: hit.precision ?? null, source: providerName, tried: [...p.tried], at };
    if (inBbox(hit, bbox)) applyHit(p.rec, cache[p.key]);
  } else if (p.prior && p.prior.lat != null) {
    // Never let a later negative clobber an existing (possibly out-of-bbox) hit.
    cache[p.key] = { ...p.prior, tried: [...p.tried], at };
  } else {
    cache[p.key] = { tried: [...p.tried], at }; // negative cache (no lat/lng)
  }
}

function applyHit(rec, entry) {
  rec.location = { lat: entry.lat, lng: entry.lng };
  rec.geocode = {
    source: entry.source || 'cache',
    score: entry.score ?? null,
    matched: entry.matched ?? null,
    precision: entry.precision ?? inferPrecision(entry),
  };
  // Sources often omit the ZIP, but the geocoder's matched string usually has
  // it — backfill using the active region's ZIP ranges (texas: 75xxx–79xxx).
  // Output enrichment only: the cache key was computed from the original
  // address, so lookups stay stable.
  if (rec.address && !rec.address.zip) {
    const zip = zipRegexForRegion().exec(String(entry.matched || ''))?.[1];
    if (zip) {
      rec.address.zip = zip;
      if (rec.address.full && !rec.address.full.includes(zip)) rec.address.full += ` ${zip}`;
    }
  }
}

let zipRegexCache = { regionId: null, re: null };
function zipRegexForRegion() {
  const region = activeRegion();
  if (zipRegexCache.regionId !== region.id) {
    const prefixes = region.zipPrefixes?.length ? region.zipPrefixes : ['\\d\\d'];
    zipRegexCache = {
      regionId: region.id,
      re: new RegExp(`\\b((?:${prefixes.join('|')})\\d{3})(?:-\\d{4})?\\b`),
    };
  }
  return zipRegexCache.re;
}

/** Is this provider's cached negative still trustworthy? Entries from before
 * timestamps existed count as stale — they're exactly the long-frozen misses
 * the TTL is meant to revive. */
function negativeIsFresh(entry, providerName) {
  const at = entry?.at?.[providerName];
  if (!at) return false;
  return (Date.now() - Date.parse(at)) / 864e5 < NEGATIVE_TTL_DAYS;
}

/** Precision for cache entries that predate precision capture. Census only
 * answers with matched addresses; for Nominatim-style display names a leading
 * house number means the building matched, otherwise it was road/area-level. */
function inferPrecision(entry) {
  if (!entry || entry.lat == null) return null;
  if (!entry.source || entry.source === 'census') return 'address';
  const m = String(entry.matched || '');
  if (/^\s*\d+[a-z]?\s*,/i.test(m) || /^[^,]+,\s*\d+[a-z]?\s*,/i.test(m)) return 'address';
  return 'street';
}

// --- providers --------------------------------------------------------------

export async function geocodeCensus(address) {
  const url =
    `${SINGLE_URL}?address=${encodeURIComponent(address)}` +
    `&benchmark=${encodeURIComponent(config.geocoder.benchmark)}&format=json`;
  try {
    const data = await fetchJson(url, {}, { retries: 2, timeoutMs: 15000 });
    const match = data?.result?.addressMatches?.[0];
    if (!match) return null;
    return { lat: match.coordinates.y, lng: match.coordinates.x, matched: match.matchedAddress, precision: 'address' };
  } catch {
    return null;
  }
}

async function geocodeNominatim(address) {
  const url =
    `${NOMINATIM_URL}?q=${encodeURIComponent(address)}` +
    `&format=json&limit=1&countrycodes=us&addressdetails=0`;
  try {
    const data = await fetchJson(
      url,
      { headers: { 'User-Agent': config.geocoder.userAgent, Accept: 'application/json' } },
      { retries: 1, timeoutMs: 15000 }
    );
    const m = Array.isArray(data) ? data[0] : null;
    if (!m) return null;
    return { lat: Number(m.lat), lng: Number(m.lon), matched: m.display_name, precision: osmPrecision(m) };
  } catch {
    return null;
  }
}

async function geocodeLocationIQ(address) {
  const key = config.geocoder.locationiqKey;
  const url =
    `${LOCATIONIQ_URL}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(address)}` +
    `&format=json&limit=1&countrycodes=us`;
  try {
    const data = await fetchJson(url, { headers: { Accept: 'application/json' } }, { retries: 1, timeoutMs: 15000 });
    const m = Array.isArray(data) ? data[0] : null;
    if (!m) return null;
    return { lat: Number(m.lat), lng: Number(m.lon), matched: m.display_name, precision: osmPrecision(m) };
  } catch {
    return null;
  }
}

// OSM-style results carry class/type describing WHAT matched: a building/POI,
// a road, or just a place. That's the pin-accuracy tier the map shows.
function osmPrecision(m) {
  const cls = m.class || '';
  if (/^(building|house|amenity|shop|office|leisure|tourism|industrial|man_made|craft)$/.test(cls)) return 'address';
  if (cls === 'place' || cls === 'boundary') return 'area';
  if (cls === 'highway') return 'street';
  return /^\s*\d/.test(String(m.display_name || '')) ? 'address' : 'street';
}

// Pick the fallback provider: a LocationIQ key (faster, ~2/s) if present,
// else public Nominatim (≤1/s), unless disabled with GEOCODER_FALLBACK=none.
function fallbackProvider() {
  if (config.geocoder.fallback === 'none') return null;
  if (config.geocoder.locationiqKey) {
    return { name: 'locationiq', fn: geocodeLocationIQ, minIntervalMs: 550 };
  }
  return { name: 'nominatim', fn: geocodeNominatim, minIntervalMs: 1100 };
}

// --- helpers ----------------------------------------------------------------

function inBbox(hit, bbox) {
  if (!bbox) return true;
  const pad = 0.2; // generous — guards against wrong-state matches, not precision
  return (
    hit.lat >= bbox.minLat - pad &&
    hit.lat <= bbox.maxLat + pad &&
    hit.lng >= bbox.minLng - pad &&
    hit.lng <= bbox.maxLng + pad
  );
}

function loadCache() {
  return loadStateFile(CACHE_PATH);
}
function saveCache(cache) {
  writeFileAtomic(CACHE_PATH, JSON.stringify(cache));
}

/** Geocode a single address through the full chain (used by `geocode-test`). */
export async function geocodeOne(address) {
  const hit = await geocodeCensus(address);
  if (hit) return { ...hit, source: 'census' };
  const provider = fallbackProvider();
  if (!provider) return null;
  const fb = await provider.fn(address);
  return fb ? { ...fb, source: provider.name } : null;
}
