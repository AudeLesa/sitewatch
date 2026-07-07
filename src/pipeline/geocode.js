import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config, activeCity } from '../config.js';
import { projectRoot } from '../util/env.js';
import { fetchJson, mapLimit, sleep } from '../util/http.js';
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
// query string, with the set of providers already tried. So: re-runs are nearly
// instant for known addresses; adding a new fallback automatically retries old
// misses; and a known-dead address is never re-queried. Results are bbox-checked
// against the active city so a fuzzy match can't drop a pin in the wrong state.
// ---------------------------------------------------------------------------

const SINGLE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const LOCATIONIQ_URL = 'https://us1.locationiq.com/v1/search';
const CACHE_PATH = join(projectRoot, config.output.dir, 'geocode-cache.json');

export async function geocodeMissing(records, { log = () => {} } = {}) {
  const cache = loadCache();
  const bbox = activeCity().bbox;
  const needs = records.filter((r) => !r.location && oneLine(r.address));

  // Each pending item carries the providers already tried (from cache).
  const pending = [];
  for (const rec of needs) {
    const key = oneLine(rec.address);
    const c = cache[key];
    if (c && c.lat != null) applyHit(rec, c); // cached hit — instant
    else pending.push({ rec, key, tried: new Set(c?.tried || []) });
  }
  const fromCache = needs.length - pending.length;

  // Pass 1 — Census, concurrent, for anything not already tried there.
  const censusTodo = pending.filter((p) => !p.tried.has('census'));
  if (censusTodo.length) log(`[geocode] census: ${censusTodo.length} addresses (${fromCache} already cached)...`);
  await mapLimit(censusTodo, config.geocoder.concurrency, async (p) => {
    const hit = await geocodeCensus(p.key);
    record(cache, p, hit && inBbox(hit, bbox) ? hit : null, 'census');
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
      const ok = hit && inBbox(hit, bbox);
      record(cache, p, ok ? hit : null, provider.name);
      if (ok) fallbackHits++;
      if (fallbackUsed % 100 === 0) log(`[geocode] ${provider.name} ${fallbackUsed}/${limit} (+${fallbackHits} recovered)`);
      if (++dirty % 200 === 0) saveCache(cache); // checkpoint long runs
      await sleep(provider.minIntervalMs);
    }
  }

  saveCache(cache);
  const matched = needs.filter((r) => r.location).length;
  return {
    matched,
    missed: needs.length - matched,
    attempted: needs.length,
    fromCache,
    fallback: provider ? { provider: provider.name, used: fallbackUsed, hits: fallbackHits } : null,
  };
}

/** Write a result (hit or miss) into both the record and the cache. */
function record(cache, p, hit, providerName) {
  p.tried.add(providerName);
  if (hit) {
    cache[p.key] = { lat: hit.lat, lng: hit.lng, matched: hit.matched, source: providerName, tried: [...p.tried] };
    applyHit(p.rec, cache[p.key]);
  } else {
    cache[p.key] = { tried: [...p.tried] }; // negative cache (no lat/lng)
  }
}

function applyHit(rec, entry) {
  rec.location = { lat: entry.lat, lng: entry.lng };
  rec.geocode = { source: entry.source || 'cache', score: entry.score ?? null, matched: entry.matched ?? null };
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
    return { lat: match.coordinates.y, lng: match.coordinates.x, matched: match.matchedAddress };
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
    return { lat: Number(m.lat), lng: Number(m.lon), matched: m.display_name };
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
    return { lat: Number(m.lat), lng: Number(m.lon), matched: m.display_name };
  } catch {
    return null;
  }
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
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveCache(cache) {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
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
