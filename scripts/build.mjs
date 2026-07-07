// Assemble a static, deployable site into dist/.
//   node scripts/build.mjs   (or: npm run build)
// Copies the map (web/index.html) and the map-ready GeoJSON into dist/, which
// any static host (Cloudflare Pages, Netlify, GitHub Pages) can serve as-is.
// It never touches the geocode/detail caches the pipeline relies on.
import { readdirSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, existsSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { generateSeo } from './seo.mjs';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true }); // clean build — no stale/orphaned pages
mkdirSync(join(dist, 'data'), { recursive: true });

// 1. The app shell.
copyFileSync(join(root, 'web', 'index.html'), join(dist, 'index.html'));

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

// 3. Cloudflare Pages Functions (Stripe checkout + webhook), if present.
if (existsSync(join(root, 'functions'))) {
  cpSync(join(root, 'functions'), join(dist, 'functions'), { recursive: true });
  console.log('  + functions/ (Pages Functions: Stripe checkout + webhook)');
}

// 4. SEO: static project + metro pages, sitemap, robots.txt (crawlable long tail).
const texasPath = join(dataDir, 'texas.geojson');
if (existsSync(texasPath)) {
  const fc = JSON.parse(readFileSync(texasPath, 'utf8'));
  generateSeo(dist, fc.features || [], { siteUrl: process.env.SITE_URL });
}

// 5. SPA-friendly fallback (Functions + static assets take priority over this).
writeFileSync(join(dist, '_redirects'), '/*  /index.html  200\n');

const mb = (bytes / 1e6).toFixed(1);
console.log(`\n✔ Built dist/ — index.html + ${copied} GeoJSON file(s), ${mb} MB.`);
if (copied === 0) console.log('  (No GeoJSON found — run `npm run pull:texas` first.)');
console.log('  Deploy it with:  npx wrangler pages deploy dist   (or drag dist/ into Netlify)');
