# Deploying SiteWatch to the web

The app is a **static site** — one HTML file plus the map-ready GeoJSON. There's no
server to run in production: you generate the data locally, build a `dist/` folder,
and upload it to any static host. Free, fast, and scales to a lot of traffic.

## The two commands

```bash
npm run pull:texas    # 1. refresh the data  -> data/texas.geojson
npm run build         # 2. assemble dist/    (minified GeoJSON + the map)
```

`dist/` then contains everything the browser needs:

```
dist/
  index.html          the map app
  data/texas.geojson  the sites (minified; hosts gzip it ~5× smaller over the wire)
  _redirects          SPA fallback (ignored by hosts that don't use it)
```

## Put it online (pick one)

### Cloudflare Pages — recommended (free, fast, generous limits)
```bash
npm i -g wrangler          # one time
wrangler login             # one time
npm run build
wrangler pages deploy dist --project-name sitewatch
```
You get a `https://sitewatch.pages.dev` URL immediately; add a custom domain in the
Cloudflare dashboard.

### Netlify
```bash
npm i -g netlify-cli       # one time
npm run build
netlify deploy --dir=dist --prod
```
(Or just drag the `dist/` folder onto https://app.netlify.com/drop.)

### GitHub Pages
Commit `dist/` to a `gh-pages` branch (or use the `actions/deploy-pages` action).

## Keeping it fresh

One command rebuilds the data and the bundle:

```bash
npm run refresh     # = pull:texas + build  (re-deploy after with `npm run deploy`)
npm run publish     # = refresh + deploy    (the whole thing, end to end)
```

A warm refresh takes **~9–10 minutes**. The two expensive steps are eliminated by the
caches (`data/*-cache.json`): a re-pull skips TDLR for known projects and skips
geocoding for known addresses, so only genuinely *new* permits cost anything. What
remains is the statewide search scan (~500 pages), fetched with bounded concurrency
(`TABS_SEARCH_CONCURRENCY`, default 4) — the floor here is TDLR's side: deep result
pages (`OFFSET 40000`) are slow to serve. The *first* refresh after a clean checkout
is much slower — it seeds the caches (full detail fetch + geocoding) — then every run
after is the ~10-minute path.

> **Why a full re-pull, not an "incremental" one?** A project's *status* changes over
> time (registered → review → inspecting → closed), and that status — your "being
> built now" signal — comes from the search row on every run. A narrowed "only new
> permits" pull would leave existing projects' statuses stale. The cache already makes
> the full, always-correct refresh fast, so that's what we do.

### Automate it (updates itself daily)

`.github/workflows/refresh.yml` runs `refresh` + deploys on a daily cron (and on a
manual button). One-time setup:

1. **Push this repo to GitHub** (`git init && git remote add … && git push`).
2. Create a Cloudflare API token: Cloudflare → *My Profile → API Tokens → Create* →
   template **"Edit Cloudflare Pages"**.
3. In the GitHub repo, **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN` — the token above
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare → *Workers & Pages → Account ID*
4. Done. It deploys to the `sitewatch-eyt` project nightly; trigger a test run from
   the **Actions** tab → *Refresh SiteWatch → Run workflow*.

The workflow persists `data/*-cache.json` between runs via `actions/cache`, and caps
the OSM fallback (`GEOCODER_FALLBACK_MAX=800`) so each run stays inside CI limits —
the long tail of geocodes fills in over the first several daily runs.

*Prefer not to use GitHub?* The same `npm run publish` works from Windows Task
Scheduler (your local caches are already warm) — just set a `CLOUDFLARE_API_TOKEN`
env var so `wrangler` can deploy non-interactively.

## Heads-up
- The GeoJSON is a single ~7 MB file (gzips to ~1.5 MB). That's fine up to ~50k
  points; beyond that, move to a tile server or an API with viewport queries
  (the README roadmap covers this).
- Don't deploy while a `pull` is running — build reads `texas.geojson`, which the
  pull rewrites at the end.
