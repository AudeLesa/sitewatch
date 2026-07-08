// Assemble a static, deployable site into dist/.
//   node scripts/build.mjs   (or: npm run build)
// Copies the map (web/index.html) and the map-ready GeoJSON into dist/, which
// any static host (Cloudflare Pages, Netlify, GitHub Pages) can serve as-is.
// It never touches the geocode/detail caches the pipeline relies on.
import { readdirSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { generateSeo } from './seo.mjs';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true }); // clean build — no stale/orphaned pages
mkdirSync(join(dist, 'data'), { recursive: true });

// 1. The app shell + icon + PWA manifest (installable, and a real favicon —
//    browsers were 404ing /favicon.ico on every visit).
copyFileSync(join(root, 'web', 'index.html'), join(dist, 'index.html'));
copyFileSync(join(root, 'web', 'icon.svg'), join(dist, 'icon.svg'));
writeFileSync(
  join(dist, 'manifest.webmanifest'),
  JSON.stringify({
    name: 'SiteWatch — Texas Construction, Live',
    short_name: 'SiteWatch',
    start_url: '/',
    display: 'standalone',
    background_color: '#f2dcd8',
    theme_color: '#313f9f',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  })
);

// 2. Only the map-ready GeoJSON (not *.json / *.ungeocoded.json / *-cache.json).
const dataDir = join(root, 'data');
let copied = 0;
let bytes = 0;
for (const f of readdirSync(dataDir)) {
  if (!f.endsWith('.geojson')) continue;
  // Minify (strip pretty-print whitespace) to shrink the payload the browser fetches.
  const min = JSON.stringify(JSON.parse(readFileSync(join(dataDir, f), 'utf8')));
  writeFileSync(join(dist, 'data', f), min);
  bytes += Buffer.byteLength(min);
  copied++;
  console.log(`  + data/${f}  (${(Buffer.byteLength(min) / 1e6).toFixed(1)} MB)`);
}

// 3. Pages Functions are NOT copied into dist/ — wrangler bundles functions/
//    from the project root at deploy time, and copying them here would serve
//    the backend source as public static files.

// 4. SEO: static project + metro pages, sitemap, robots.txt (crawlable long tail).
const texasPath = join(dataDir, 'texas.geojson');
if (existsSync(texasPath)) {
  const fc = JSON.parse(readFileSync(texasPath, 'utf8'));
  generateSeo(dist, fc.features || [], { siteUrl: process.env.SITE_URL });
}

// 5. A real 404 page. (The old `/* -> /index.html 200` catch-all made every
//    missing URL answer 200 with the app shell — including sitemap.xml before
//    the SEO pages were deployed — which hides deploy drift from crawlers and
//    humans alike. Hash-based deep links mean the app needs no SPA fallback.)
writeFileSync(
  join(dist, '404.html'),
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found — SiteWatch</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f7ddda;font-family:'Segoe UI',system-ui,sans-serif;color:#232a52">
<div style="text-align:center;background:#fdf3ec;padding:48px 56px;border-radius:28px;box-shadow:0 24px 60px rgba(49,63,159,.14)">
<div style="font-size:44px;font-weight:700;color:#313f9f">404</div>
<p style="margin:10px 0 22px;color:#7a7f9e">This page doesn't exist (or isn't built yet).</p>
<a href="/" style="background:#313f9f;color:#fff;text-decoration:none;padding:12px 26px;border-radius:999px;font-weight:600">Back to the map</a>
</div></body>\n`
);

const mb = (bytes / 1e6).toFixed(1);
console.log(`\n✔ Built dist/ — index.html + ${copied} GeoJSON file(s), ${mb} MB.`);
if (copied === 0) console.log('  (No GeoJSON found — run `npm run pull:texas` first.)');
console.log('  Deploy it with:  npx wrangler pages deploy dist   (or drag dist/ into Netlify)');
