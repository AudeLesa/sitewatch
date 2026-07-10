// Cloudflare Pages Function — GET /project/<permit>
//
// Project pages render on demand from build-time shards (dist/data/shards/,
// written by scripts/seo.mjs) using the same template the static generator
// used (scripts/lib/project-page.mjs) — so the HTML is byte-identical to the
// static files these pages used to be, at 64 files instead of 14k+ against
// Cloudflare Pages' 20k-file cap. URLs are unchanged: /project/<permit>.
//
// Zero dependencies; data comes from env.ASSETS (this deployment's own static
// files), so a deploy atomically updates data + renderer together and no
// database sits in the SEO critical path.
//
// Caching, three layers (Pages-Function responses are NOT edge-cached by
// Cloudflare on their own — s-maxage alone would be inert):
//   • caches.default (Cache API): rendered 200s, per-PoP, honors s-maxage
//   • a module-level parsed-shard Map: isolates persist across requests
//   • ETag/Last-Modified + 304s: crawlers revalidate instead of re-downloading

import { renderProjectPage, TX_REGION, TEMPLATE_VERSION, fileOf, shardOf } from '../../scripts/lib/project-page.mjs';

// Must match the build's canonical origin (scripts/seo.mjs siteUrl default).
// When a custom domain lands, set SITE_URL in BOTH the CI build env and the
// Pages project env so canonicals stay consistent.
const DEFAULT_SITE = 'https://sitewatch-eyt.pages.dev';

// Parsed shards, cached for the isolate's lifetime. Worst case (all 64 shards,
// ~18 MB at Texas scale) sits comfortably under the 128 MB isolate limit.
const shardCache = new Map();

export async function onRequest({ request, env, params, waitUntil }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  // Trailing-slash duplicates: the static site 308'd /project/X/ → /project/X
  // (Pages pretty-URLs); keep that contract rather than serving 200 twins.
  const reqUrl = new URL(request.url);
  if (reqUrl.pathname.length > '/project/'.length && reqUrl.pathname.endsWith('/')) {
    reqUrl.pathname = reqUrl.pathname.replace(/\/+$/, '');
    return Response.redirect(reqUrl.toString(), 301);
  }

  // Pages hands the catch-all param percent-ENCODED; the static server used to
  // decode before matching files, so decode for parity (malformed → 404).
  let raw = Array.isArray(params.permit) ? params.permit.join('/') : (params.permit || '');
  try { raw = decodeURIComponent(raw); } catch { return notFound(); }

  // Legacy .html form (old static files, pre-SSR): 301 to the extensionless
  // canonical, which is what the sitemap and every internal link use.
  if (raw.endsWith('.html')) {
    reqUrl.pathname = `/project/${raw.slice(0, -5)}`;
    return Response.redirect(reqUrl.toString(), 301);
  }

  // Only sanitized permit filenames exist; anything else was never a page.
  const file = fileOf(raw);
  if (!file || file !== raw) return notFound();

  // Cache API: serve a prior render if this PoP has one (canonical URL key,
  // query stripped so ?utm= variants share the entry).
  const cacheKey = new Request(new URL(`/project/${file}`, request.url), { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return maybe304(request, cached);

  const shard = await loadShard(env, request.url, shardOf(file));
  // Own-property lookup: permits named like Object.prototype members
  // (__proto__, constructor, …) must 404, not crash the render.
  const entry = shard && Object.hasOwn(shard, file) ? shard[file] : null;
  if (!entry) return notFound(); // unknown/expired permit — the SSR publish guard

  // Region copy for the template: the deployment's manifest entry merged over
  // the Texas defaults (fallback when the manifest is missing/unreadable).
  let region = TX_REGION;
  try {
    const r = await env.ASSETS.fetch(new URL('/data/regions.json', request.url));
    const found = ((await r.json()) || []).find((x) => x.id === (entry.r || 'texas'));
    if (found) region = { ...TX_REGION, ...found };
  } catch (e) { /* fall back to Texas copy rather than 500 */ }

  const html = renderProjectPage(entry, { site: env.SITE_URL || DEFAULT_SITE, region });
  const lastmod = entry.p.statusChangedAt || entry.p.firstSeenAt || null;
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    // max-age: browsers, 5 min. s-maxage: honored by caches.default below.
    // Content changes at most daily; an hour of edge staleness after the
    // nightly deploy roughly matches the old static freshness.
    'Cache-Control': 'public, max-age=300, s-maxage=3600',
    // Weak validators so crawlers get 304s like they did for static files.
    // TEMPLATE_VERSION busts them when the template itself changes.
    ETag: `W/"${file}-${lastmod || 'x'}-${TEMPLATE_VERSION}"`,
  };
  if (lastmod && !Number.isNaN(Date.parse(lastmod))) headers['Last-Modified'] = new Date(lastmod).toUTCString();

  const response = new Response(html, { headers });
  if (waitUntil) waitUntil(cache.put(cacheKey, response.clone()));
  return maybe304(request, response);
}

// Answer conditional requests with 304 when a validator matches. Note:
// Cloudflare's pages.dev layer strips custom ETags from delivered responses,
// so crawlers mostly revalidate via If-Modified-Since — support both.
function maybe304(request, response) {
  const etag = response.headers.get('ETag');
  const inm = request.headers.get('If-None-Match');
  if (inm && etag && inm.split(',').map((s) => s.trim()).includes(etag)) {
    return new Response(null, { status: 304, headers: response.headers });
  }
  const ims = Date.parse(request.headers.get('If-Modified-Since') || '');
  const lm = Date.parse(response.headers.get('Last-Modified') || '');
  if (!Number.isNaN(ims) && !Number.isNaN(lm) && lm <= ims) {
    return new Response(null, { status: 304, headers: response.headers });
  }
  return response;
}

async function loadShard(env, requestUrl, sh) {
  if (shardCache.has(sh)) return shardCache.get(sh);
  const res = await env.ASSETS.fetch(new URL(`/data/shards/p-${sh}.json`, requestUrl));
  if (!res.ok) return null;
  const shard = await res.json();
  shardCache.set(sh, shard);
  return shard;
}

function notFound() {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Not found — SiteWatch</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f7ddda;font-family:'Segoe UI',system-ui,sans-serif;color:#232a52">
<div style="text-align:center;background:#fdf3ec;padding:48px 56px;border-radius:28px;box-shadow:0 24px 60px rgba(49,63,159,.14)">
<div style="font-size:44px;font-weight:700;color:#313f9f">404</div>
<p style="margin:10px 0 22px;color:#7a7f9e">No project page here (the permit may have left the active dataset).</p>
<a href="/" style="background:#313f9f;color:#fff;text-decoration:none;padding:12px 26px;border-radius:999px;font-weight:600">Back to the map</a>
</div></body>`,
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } }
  );
}
