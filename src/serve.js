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

    let body, ext = extname(filePath);
    try {
      body = await readFile(filePath);
    } catch (err) {
      if (DIST && err.code === 'ENOENT') {
        body = await readFile(join(ROOT, 'index.html')); // SPA-style fallback (matches _redirects)
        ext = '.html';
      } else throw err;
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500).end(String(err.code || err.message));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use — stop the other server (Ctrl+C in its window), or pick another:  set PORT=8789 && npm run preview`);
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, () => console.error(`SiteWatch ${DIST ? 'site (full)' : 'map'} → http://localhost:${PORT}`));
