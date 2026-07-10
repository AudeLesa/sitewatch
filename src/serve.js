import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { projectRoot } from './util/env.js';

// Minimal zero-dependency static server (file:// fetches are blocked by browsers).
//   node src/serve.js          → serves the map only (/web + /data)  on :5173
//   node src/serve.js dist     → serves the whole built site (dist/) on :8788
// The `dist` mode mirrors production: all the generated pages (insights, project/,
// where/, company/, sitemap…) plus an index.html fallback for unknown paths.
const DIST = process.argv.includes('dist');
const ROOT = DIST ? join(projectRoot, 'dist') : projectRoot;
const PORT = Number(process.env.PORT || (DIST ? 8788 : 5173));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.geojson': 'application/json', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain', '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (urlPath === '/') urlPath = '/index.html';

    let filePath;
    if (DIST) {
      filePath = normalize(join(ROOT, urlPath));
    } else {
      if (urlPath === '/index.html') urlPath = '/web/index.html';
      if (!urlPath.startsWith('/web/') && !urlPath.startsWith('/data/')) {
        res.writeHead(404).end('not found');
        return;
      }
      filePath = normalize(join(projectRoot, urlPath));
    }
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    // Project pages aren't files anymore — in production a Pages Function
    // renders them from the shards (functions/project/[[permit]].js). Mirror
    // that here with the same shared template so local previews stay honest.
    if (DIST && /^\/project\/[^/]+$/.test(urlPath)) {
      const html = await renderProject(urlPath.slice('/project/'.length));
      if (html) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }
      const nf = await readFile(join(ROOT, '404.html')).catch(() => 'not found');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(nf);
      return;
    }

    let body, ext = extname(filePath);
    try {
      body = await readFile(filePath);
    } catch (err) {
      if (DIST && err.code === 'ENOENT' && !ext) {
        // Pretty URLs, like Cloudflare Pages: /insights -> insights.html,
        // /where/ -> where/index.html.
        try {
          const pretty = urlPath.endsWith('/') ? join(filePath, 'index.html') : `${filePath}.html`;
          body = await readFile(pretty);
          ext = '.html';
        } catch {
          body = await readFile(join(ROOT, '404.html')).catch(() => 'not found');
          res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(body);
          return;
        }
      } else throw err;
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(String(err.code || err.message));
  }
});

// Same lookup the Pages Function does: sanitize → shard → shared template.
async function renderProject(rawName) {
  let raw = rawName;
  try { raw = decodeURIComponent(raw); } catch { return null; }
  if (raw.endsWith('.html')) raw = raw.slice(0, -5); // serve the canonical content
  const { renderProjectPage, TX_REGION, fileOf, shardOf } = await import('../scripts/lib/project-page.mjs');
  const file = fileOf(raw);
  if (!file || file !== raw) return null;
  let shard;
  try { shard = JSON.parse(await readFile(join(ROOT, 'data', 'shards', `p-${shardOf(file)}.json`), 'utf8')); } catch { return null; }
  const entry = Object.hasOwn(shard, file) ? shard[file] : null;
  if (!entry) return null;
  let region = TX_REGION;
  try {
    const regions = JSON.parse(await readFile(join(ROOT, 'data', 'regions.json'), 'utf8'));
    const found = regions.find((x) => x.id === (entry.r || 'texas'));
    if (found) region = { ...TX_REGION, ...found };
  } catch {}
  const site = (process.env.SITE_URL || 'https://sitewatch-eyt.pages.dev').replace(/\/$/, '');
  return renderProjectPage(entry, { site, region });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — stop the other server (Ctrl+C in its window), or pick another:  set PORT=8789 && npm run preview`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => console.error(`SiteWatch ${DIST ? 'site (full)' : 'map'} → http://localhost:${PORT}`));
