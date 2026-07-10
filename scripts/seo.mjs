// Static SEO page generator. Turns the datasets into crawlable HTML so Google
// can index it — the growth engine. Multi-region: every public region gets its
// own URL namespace (its lowercased state code) so datasets never collide.
// Produces, into dist/:
//   data/shards/p-XX.json    render data for /project/<permit> pages — the pages
//                            themselves render on demand (functions/project/) so
//                            14k+ projects stop eating Cloudflare's 20k-file cap.
//                            Shards are shared across regions (permit prefixes
//                            keep the keys collision-free).
//   <ns>/<city>.html         a landing page per metro ("construction in Houston, TX")
//   <ns>/index.html          a browsable directory of the region's metros
//   <ns>/company/<slug>.html a page per owner/architect ("everything Hines is building")
//   <ns>/companies.html      directory of the region's most active companies
//   <ns>/insights.html       the region's construction market report
//   sitemap.xml              a sitemap INDEX → sitemap-core.xml + sitemap-<region>.xml
//   robots.txt               so search engines discover everything
//   p.css                    one shared stylesheet (cached across all pages)
// Called from build.mjs. Pure string templating — no dependencies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc, usd, head, foot, fileOf, CAT, TX_REGION, shardOf, TEMPLATE_MODIFIED } from './lib/project-page.mjs';

const MIN_COMPANY_PROJECTS = 3; // a company needs this many projects to get its own page

const short = (n) => (!n ? '$0' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + n);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tx';
// City slugs share the region namespace with the fixed pages — a city whose
// slug collides with one of those (address data is messy) gets a suffix rather
// than clobbering /tx/insights or the /tx/company/ directory.
const RESERVED_SLUGS = new Set(['insights', 'companies', 'company', 'index', 'sitemap']);
const citySlug = (name) => { const s = slug(name); return RESERVED_SLUGS.has(s) ? `${s}-city` : s; };

// Entity resolution for company names: "Tesla, Inc." / "TESLA INC" / "Tesla"
// are one company and must share one page and one ranking tally. Conservative
// on purpose — only punctuation, case, "the", &/and, and trailing LEGAL
// suffixes are normalized; word differences ("Tesla Energy") stay distinct.
const LEGAL_SUFFIX = /\s+(L\s*L\s*C|L\s*L\s*P|L\s*P|INC(ORPORATED)?|CORP(ORATION)?|CO(MPANY)?|LTD|LIMITED|PLLC|P\s*C|PLC|GP|PARTNERS(HIP)?( LTD| LP)?)\.?$/;
function companyKey(name) {
  let s = String(name || '').toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^THE\s+/, '');
  let prev;
  do { prev = s; s = s.replace(LEGAL_SUFFIX, '').trim(); } while (s !== prev && s.includes(' '));
  return s || String(name || '').toUpperCase().trim();
}
const cityOf = (addr) => { const p = String(addr || '').split(','); return p.length >= 2 ? p[p.length - 2].trim() : ''; };
const JUNK = /^(n\/?a|tbd|to be determined|unknown|none|owner|self|same|various|n\.a\.)$/i;
const isCompany = (n) => n && String(n).trim().length >= 3 && !JUNK.test(String(n).trim());
// Valuation for totals/rankings — flagged-implausible values count as 0 so a
// fat-fingered number can't headline "largest projects".
const val = (p) => (p.valuationSuspect ? 0 : p.valuation || 0);

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const urlset = (urls) => XML_HEAD +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${esc(u.loc)}</loc><lastmod>${esc(u.lastmod)}</lastmod></url>`).join('\n') + `\n</urlset>\n`;

/**
 * Generate all SEO artifacts for every public region in one pass.
 * sets: [{ region, features }] — region is the registry/manifest entry (must
 * carry ns, state, stateName, sourceShort); features its GeoJSON features.
 * Region namespaces must be unique (build.mjs asserts) — two regions in one
 * state would clobber each other's pages.
 */
export function generateSeoAll(dist, sets, { siteUrl } = {}) {
  const site = (siteUrl || 'https://sitewatch-eyt.pages.dev').replace(/\/$/, '');
  mkdirSync(join(dist, 'data', 'shards'), { recursive: true });
  writeFileSync(join(dist, 'p.css'), CSS);

  const today = new Date().toISOString().slice(0, 10);
  const shards = new Map(); // shared across regions — permit prefixes keep keys unique
  const sitemaps = [];      // { file } entries for the sitemap index
  let shardEntries = 0, staticPages = 0;

  for (const { region, features } of sets) {
    // The registry entry is authoritative; TX defaults only backstop a
    // region-less dev call. (Never merge TX copy over a real other region —
    // Seattle must not inherit "Houston, Dallas…" example cities.)
    const R = region ? { ...region } : { ...TX_REGION };
    if (!R.ns) R.ns = String(R.state || 'tx').toLowerCase();
    const nsDir = join(dist, R.ns);
    mkdirSync(join(nsDir, 'company'), { recursive: true });

    // ---- index pass: cities + companies (owner/architect) ----
    const cities = new Map();    // slug -> { name, items[] }
    const companies = new Map(); // slug -> { name, variants, owned[], designed[], built[] }
    const valid = [];
    const addCo = (name, p, role) => {
      if (!isCompany(name)) return;
      const s = slug(companyKey(name));
      if (!companies.has(s)) companies.set(s, { name: '', variants: new Map(), owned: [], designed: [], built: [] });
      const c = companies.get(s);
      const raw = String(name).trim();
      c.variants.set(raw, (c.variants.get(raw) || 0) + 1);
      c[role].push(p);
    };
    for (const f of features) {
      const p = f.properties || {};
      if (!p.permitNumber) continue;
      valid.push(p);
      const cn = cityOf(p.address), cs = citySlug(cn);
      if (cn) { if (!cities.has(cs)) cities.set(cs, { name: cn, items: [] }); cities.get(cs).items.push(p); }
      addCo(p.owner, p, 'owned');
      addCo(p.designFirm, p, 'designed');
      addCo(p.contractor, p, 'built'); // Seattle-class sources name the GC and nobody else
    }
    // A merged company displays as its most frequent spelling.
    for (const c of companies.values()) c.name = [...c.variants.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const coCount = (c) => c.owned.length + c.designed.length + c.built.length;
    const paged = new Set([...companies].filter(([, c]) => coCount(c) >= MIN_COMPANY_PROJECTS).map(([s]) => s));
    const coLink = (name) => { const s = slug(companyKey(name)); return isCompany(name) && paged.has(s) ? `/${R.ns}/company/${s}` : null; };

    // URLs are EXTENSIONLESS everywhere (canonicals, sitemap, internal links):
    // Cloudflare Pages 308-redirects `/x.html` to `/x`, so linking the .html form
    // made every canonical point at a redirect. Files are still written as .html —
    // Pages serves them at the clean path.
    const urls = [
      { loc: `${site}/${R.ns}/insights`, lastmod: today },
      { loc: `${site}/${R.ns}/`, lastmod: today },
    ];

    // ---- project render shards (the pages themselves render on demand in
    // functions/project/[[permit]].js from exactly this data + the shared
    // template — see scripts/lib/project-page.mjs) ----
    for (const p of valid) {
      const file = fileOf(p.permitNumber);
      if (!file) continue;
      const cn = cityOf(p.address), cs = citySlug(cn), url = `${site}/project/${file}`;
      const entry = {
        p, cname: cn, cslug: cs, r: R.id || 'texas',
        // company links resolved NOW, against the set that actually got pages
        links: { owner: coLink(p.owner), arch: coLink(p.designFirm), contractor: coLink(p.contractor), tenant: coLink(p.tenantName), ras: coLink(p.rasName) },
      };
      const sh = shardOf(file);
      if (!shards.has(sh)) shards.set(sh, {});
      const bucket = shards.get(sh);
      // Shards are one namespace across regions. The permit-prefix contract
      // (src/config.js SOURCE_PERMIT_PREFIXES) is supposed to make keys unique;
      // enforce it — a collision would silently serve the wrong region's
      // project at /project/<permit> and leak a dead URL into a sitemap.
      if (Object.hasOwn(bucket, file)) {
        throw new Error(`project shard key collision: '${file}' emitted by region '${bucket[file].r}' and '${entry.r}' — give the newer source a permit prefix (SOURCE_PERMIT_PREFIXES).`);
      }
      bucket[file] = entry;
      shardEntries++;
      // Sitemap lastmod floors at the template's change date (same rule as the
      // renderer's Last-Modified): a template deploy really did change every
      // page, and this is what tells crawlers to come re-read them.
      const dataMod = p.statusChangedAt || p.firstSeenAt || today;
      urls.push({ loc: url, lastmod: TEMPLATE_MODIFIED > dataMod ? TEMPLATE_MODIFIED : dataMod });
    }

    // ---- metro pages ----
    const cityList = [...cities.entries()].filter(([, c]) => c.items.length >= 3).sort((a, b) => b[1].items.length - a[1].items.length);
    for (const [cs, c] of cityList) { writeFileSync(join(nsDir, `${cs}.html`), cityPage(c, cs, `${site}/${R.ns}/${cs}`, site, cityList, R)); urls.push({ loc: `${site}/${R.ns}/${cs}`, lastmod: today }); }
    writeFileSync(join(nsDir, 'index.html'), directoryPage(cityList, site, R));

    // ---- company pages + directory ----
    const coList = [...companies.entries()].filter(([s]) => paged.has(s)).sort((a, b) => coCount(b[1]) - coCount(a[1]));
    for (const [cs, c] of coList) { writeFileSync(join(nsDir, 'company', `${cs}.html`), companyPage(c, cs, `${site}/${R.ns}/company/${cs}`, site, R)); urls.push({ loc: `${site}/${R.ns}/company/${cs}`, lastmod: today }); }
    // A region with no companies yet (sparse party data — Seattle's contractor
    // field fills in slowly) still gets the page so nav links resolve, but
    // noindexed and out of the sitemap until it has content.
    writeFileSync(join(nsDir, 'companies.html'), companiesIndex(coList, site, R));
    if (coList.length) urls.push({ loc: `${site}/${R.ns}/companies`, lastmod: today });

    // ---- market report ----
    writeFileSync(join(nsDir, 'insights.html'), insightsPage(valid, cityList, coList, site, R));

    // ---- the region's sitemap ----
    const smFile = `sitemap-${R.id || R.ns}.xml`;
    writeFileSync(join(dist, smFile), urlset(urls));
    sitemaps.push({ file: smFile });

    staticPages += cityList.length + coList.length + 3;
    console.log(`  + [${R.ns}] ${valid.length} projects → ${cityList.length} metro + ${coList.length} company pages + insights, ${smFile} (${urls.length} urls)`);
  }

  // ---- shards (all regions merged — one namespace, prefix-disambiguated) ----
  for (const [sh, m] of shards) writeFileSync(join(dist, 'data', 'shards', `p-${sh}.json`), JSON.stringify(m));

  // ---- sitemap index + core sitemap + robots ----
  writeFileSync(join(dist, 'sitemap-core.xml'), urlset([{ loc: `${site}/`, lastmod: today }]));
  writeFileSync(join(dist, 'sitemap.xml'), XML_HEAD +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [{ file: 'sitemap-core.xml' }, ...sitemaps].map((s) => `  <sitemap><loc>${esc(`${site}/${s.file}`)}</loc><lastmod>${esc(today)}</lastmod></sitemap>`).join('\n') +
    `\n</sitemapindex>\n`);
  writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);

  console.log(`  + ${shardEntries} project pages via ${shards.size} render shards; sitemap index (${sitemaps.length} region sitemap${sitemaps.length === 1 ? '' : 's'})`);
  if (staticPages > 15000) console.log('  ⚠ approaching Cloudflare Pages 20k-file limit — move company pages to SSR next.');
}

// ---------------------------------------------------------------------------
// (head/foot/projectPage live in scripts/lib/project-page.mjs — shared with
// the on-demand renderer so both emit byte-identical HTML.)

function cityPage(c, cslug, url, site, cityList, R) {
  const total = c.items.reduce((s, p) => s + val(p), 0);
  // No-valuation regions sort by recency (a value sort over nulls is
  // arbitrary) and must not claim "largest by value" in the truncation copy.
  const hasVal = total > 0;
  const items = c.items.slice().sort((a, b) => (hasVal ? val(b) - val(a) : String(b.issuedDate || '').localeCompare(String(a.issuedDate || ''))));
  const title = `Commercial construction in ${c.name}, ${R.state} — ${items.length} active projects | SiteWatch`;
  const desc = `${items.length} commercial construction projects tracked in ${c.name}, ${R.stateName}` + (total ? `, ${usd(total)} in declared value` : '') + `. Owners, architects, value and status from public permit records.`;
  const list = items.slice(0, 250).map((p) => `<li><a href="/project/${fileOf(p.permitNumber)}">${esc(p.facilityName || p.address || 'Project')}</a> <span class="m">${[p.valuation ? short(p.valuation) : null, CAT[p.category]].filter(Boolean).join(' · ')}</span></li>`).join('');
  const others = cityList.filter(([s]) => s !== cslug).slice(0, 24).map(([s, cc]) => `<a href="/${R.ns}/${s}">${esc(cc.name)}</a>`).join(' · ');
  return head(title, desc, url, null) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/${R.ns}/">All metros</a></nav></header>
<main>
<h1>Commercial construction in ${esc(c.name)}, ${R.stateName}</h1>
<p class="sub"><strong>${items.length}</strong> active projects${total ? ` · <strong>${usd(total)}</strong> declared value` : ''}. From public ${R.sourceShort} building-permit records.</p>
<p class="cta"><a class="btn" href="/">Explore ${esc(c.name)} on the live map →</a></p>
<ul class="projlist">${list}</ul>
${items.length > 250 ? `<p class="rel">Showing the 250 ${hasVal ? 'largest by value' : 'most recent'} — see all on the <a href="/">live map</a>.</p>` : ''}
<p class="rel">Other ${R.stateName} metros: ${others}</p>
</main>` + foot(site, R);
}

function companyPage(c, cslug, url, site, R) {
  const all = [...new Map([...c.owned, ...c.designed, ...c.built].map((p) => [p.permitNumber, p])).values()];
  const total = all.reduce((s, p) => s + val(p), 0);
  const roles = [c.owned.length ? `owner on ${c.owned.length}` : null, c.designed.length ? `architect on ${c.designed.length}` : null, c.built.length ? `contractor on ${c.built.length}` : null].filter(Boolean).join(', ');
  const title = `${c.name} — ${R.stateName} construction projects | SiteWatch`;
  const desc = `${c.name} is tracked on ${all.length} commercial construction projects in ${R.stateName} (${roles})${total ? `, ${usd(total)} in declared value` : ''}. Locations, value and status.`;
  const role = (p) => c.owned.includes(p) ? (c.designed.includes(p) ? 'owner & architect' : 'owner') : c.designed.includes(p) ? 'architect' : 'contractor';
  const list = all.sort((a, b) => val(b) - val(a)).slice(0, 300).map((p) =>
    `<li><a href="/project/${fileOf(p.permitNumber)}">${esc(p.facilityName || p.address || 'Project')}</a> <span class="m">${[p.valuation ? short(p.valuation) : null, cityOf(p.address), role(p)].filter(Boolean).join(' · ')}</span></li>`).join('');
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'Organization', name: c.name, url };
  return head(title, desc, url, breadcrumb) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/${R.ns}/companies">All companies</a></nav></header>
<main>
<h1>${esc(c.name)}</h1>
<p class="sub"><strong>${all.length}</strong> ${R.stateName} construction projects · ${esc(roles)}${total ? ` · <strong>${usd(total)}</strong> declared value` : ''}.</p>
<ul class="projlist">${list}</ul>
<p class="rel"><a href="/${R.ns}/insights">${R.stateName} construction market report →</a></p>
</main>` + foot(site, R);
}

function companiesIndex(coList, site, R) {
  const title = `Top ${R.stateName} construction owners & architects | SiteWatch`;
  const desc = `The most active owners and architecture firms in ${R.stateName} commercial construction, by project count.`;
  const links = coList.slice(0, 600).map(([s, c]) => `<li><a href="/${R.ns}/company/${s}">${esc(c.name)}</a> <span class="m">${c.owned.length + c.designed.length + c.built.length}</span></li>`).join('');
  return head(title, desc, `${site}/${R.ns}/companies`, null, { noindex: coList.length === 0 }) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/${R.ns}/insights">Report</a></nav></header>
<main>
<h1>Most active companies in ${R.stateName} construction</h1>
<p class="sub">Owners and architecture firms ranked by tracked projects.</p>
${coList.length ? `<ul class="dirlist">${links}</ul>` : `<p class="rel">No companies tracked yet — this region's permit feed names companies on only a slice of records, so rankings appear as data accrues.</p>`}
</main>` + foot(site, R);
}

function insightsPage(valid, cityList, coList, site, R) {
  const total = valid.length, totalVal = valid.reduce((s, p) => s + val(p), 0);
  const byCat = {}; const byFund = { Public: 0, Private: 0 }; let started = 0;
  for (const p of valid) {
    const c = CAT[p.category] || 'Other'; byCat[c] = byCat[c] || { n: 0, v: 0 }; byCat[c].n++; byCat[c].v += val(p);
    if (p.publicFunds === true) byFund.Public++; else if (p.publicFunds === false) byFund.Private++;
    if (p.justStarted) started++;
  }
  const metros = cityList.slice(0, 12).map(([, c]) => ({ name: c.name, n: c.items.length, v: c.items.reduce((s, p) => s + val(p), 0) }));
  const owners = coList.filter(([, c]) => c.owned.length).sort((a, b) => b[1].owned.length - a[1].owned.length).slice(0, 12).map(([s, c]) => ({ s, name: c.name, n: c.owned.length }));
  const archs = coList.filter(([, c]) => c.designed.length).sort((a, b) => b[1].designed.length - a[1].designed.length).slice(0, 12).map(([s, c]) => ({ s, name: c.name, n: c.designed.length }));
  const gcs = coList.filter(([, c]) => c.built.length).sort((a, b) => b[1].built.length - a[1].built.length).slice(0, 12).map(([s, c]) => ({ s, name: c.name, n: c.built.length }));
  const bars = (rows, max, fmt, link) => rows.map((r) => `<div class="bar"><span class="bl">${link && r.s ? `<a href="/${R.ns}/company/${r.s}">${esc(r.name)}</a>` : esc(r.name)}</span><span class="bt" style="width:${Math.max(4, Math.round((r._w / max) * 100))}%"></span><span class="bv">${fmt(r)}</span></div>`).join('');
  const withW = (rows, key) => rows.map((r) => ({ ...r, _w: r[key] }));
  // A region whose source publishes no valuations (Philadelphia) degrades to
  // count-based copy and charts — "$0 across 2,000 projects" is a bug report.
  const hasVal = totalVal > 0;
  const title = hasVal
    ? `${R.stateName} commercial construction report — ${short(totalVal)} across ${total.toLocaleString()} projects | SiteWatch`
    : `${R.stateName} commercial construction report — ${total.toLocaleString()} active projects | SiteWatch`;
  const desc = hasVal
    ? `Live market report: ${total.toLocaleString()} commercial construction projects across ${R.stateName} worth ${short(totalVal)}, by metro, category, owner and architect. Updated from public permit records.`
    : `Live market report: ${total.toLocaleString()} commercial construction projects across ${R.stateName}, by metro and category. Updated from public permit records.`;
  const catRows = Object.entries(byCat).sort((a, b) => (hasVal ? b[1].v - a[1].v : b[1].n - a[1].n)).map(([k, v]) => ({ name: k, n: v.n, v: v.v, _w: hasVal ? v.v : v.n }));
  const maxCatV = Math.max(...catRows.map((r) => r.v), 1);
  const maxMetroV = Math.max(...metros.map((m) => m.v), 1);
  const maxOwn = Math.max(...owners.map((o) => o.n), 1), maxArch = Math.max(...archs.map((a) => a.n), 1);
  // Party sections render only when the source names that party (Seattle has
  // contractors and nothing else; TABS has owners + architects) — an empty
  // "Most active owners" heading would read as a bug, not a capability.
  const partySections = [
    owners.length ? `<h2>Most active owners</h2><div class="bars">${bars(withW(owners, 'n'), maxOwn, (r) => `${r.n} projects`, true)}</div>` : null,
    archs.length ? `<h2>Most active architecture firms</h2><div class="bars">${bars(withW(archs, 'n'), maxArch, (r) => `${r.n} projects`, true)}</div>` : null,
    gcs.length ? `<h2>Most active contractors</h2><div class="bars">${bars(withW(gcs, 'n'), Math.max(...gcs.map((g) => g.n), 1), (r) => `${r.n} projects`, true)}</div>` : null,
  ].filter(Boolean).join('\n');
  const fmtBar = hasVal ? (r) => `${short(r.v)} · ${r.n}` : (r) => `${r.n} projects`;
  return head(title, desc, `${site}/${R.ns}/insights`, null) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/${R.ns}/">Metros</a> · <a href="/${R.ns}/companies">Companies</a></nav></header>
<main>
<h1>${R.stateName} commercial construction — live market report</h1>
<p class="sub"><strong>${total.toLocaleString()}</strong> active projects${hasVal ? ` · <strong>${usd(totalVal)}</strong> declared value` : ''} · ${cityList.length} metros tracked${started ? ` · <strong>${started}</strong> just started construction` : ''}. From public ${R.sourceShort} permit records.</p>
<h2>By category</h2><div class="bars">${bars(catRows, hasVal ? maxCatV : Math.max(...catRows.map((r) => r.n), 1), fmtBar, false)}</div>
<h2>Top metros by ${hasVal ? 'value' : 'project count'}</h2><div class="bars">${bars(withW(metros, hasVal ? 'v' : 'n'), hasVal ? maxMetroV : Math.max(...metros.map((m) => m.n), 1), fmtBar, false)}</div>
${partySections}
<h2>Funding</h2><div class="bars">${bars([{ name: 'Private', _w: byFund.Private, n: byFund.Private }, { name: 'Public', _w: byFund.Public, n: byFund.Public }], Math.max(byFund.Private, byFund.Public, 1), (r) => `${r.n}`, false)}</div>
<p class="cta"><a class="btn" href="/">Explore on the live map →</a></p>
</main>` + foot(site, R);
}

function directoryPage(cityList, site, R) {
  const examples = R.exampleCities || cityList.slice(0, 4).map(([, c]) => c.name).join(', ');
  const title = `Commercial construction by ${R.stateName} metro | SiteWatch`;
  const desc = `Browse active commercial construction projects across ${cityList.length} ${R.stateName} cities — ${examples} and more.`;
  const links = cityList.map(([s, c]) => `<li><a href="/${R.ns}/${s}">${esc(c.name)}, ${R.state}</a> <span class="m">${c.items.length}</span></li>`).join('');
  return head(title, desc, `${site}/${R.ns}/`, null) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/${R.ns}/insights">Report</a></nav></header>
<main>
<h1>${R.stateName} commercial construction by metro</h1>
<p class="sub">Active projects tracked across ${cityList.length} cities, live from public permit records.</p>
<ul class="dirlist">${links}</ul>
</main>` + foot(site, R);
}

// Soft/pastel identity shared with the map app (web/index.html): blush ground,
// cream cards, deep indigo primary, pill buttons, large radii, soft shadows.
const CSS = `:root{--bg:#f2dcd8;--panel:#fdf6f0;--card:#fff;--border:#efdcd3;--text:#232a52;--muted:#7a7f9e;--accent:#313f9f;--good:#3f9d77}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 Poppins,Segoe UI,system-ui,-apple-system,Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:14px;align-items:center;justify-content:space-between;padding:16px 22px;flex-wrap:wrap;background:var(--panel);box-shadow:0 6px 24px rgba(49,63,159,.08)}
.logo{font-weight:700;color:var(--text)}.logo:hover{text-decoration:none}header nav{font-size:14px;color:var(--muted)}
main{max-width:760px;margin:0 auto;padding:30px 20px 44px}
h1{font-size:26px;line-height:1.25;margin:0 0 6px}h2{font-size:16px;margin:28px 0 10px}.sub{color:var(--muted);margin:0 0 20px}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(49,63,159,.08)}
th,td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;vertical-align:top}
th{color:var(--muted);font-weight:500;width:160px;white-space:nowrap}tr:last-child th,tr:last-child td{border-bottom:none}
.cta{margin:22px 0}.btn{display:inline-block;background:var(--accent);color:#fff;font-weight:600;padding:11px 20px;border-radius:999px;box-shadow:0 8px 20px rgba(49,63,159,.25)}.btn:hover{text-decoration:none;filter:brightness(1.08)}
.cta a:not(.btn){margin-left:12px;font-size:14px}.rel{color:var(--muted);font-size:14px;margin-top:18px}
ul.projlist,ul.dirlist{list-style:none;padding:0;margin:18px 0;border-radius:18px;background:var(--panel);overflow:hidden;box-shadow:0 10px 30px rgba(49,63,159,.08)}
ul.projlist li,ul.dirlist li{display:flex;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);font-size:14px}
ul.projlist li:last-child,ul.dirlist li:last-child{border-bottom:none}.m{color:var(--muted);white-space:nowrap}
.bars{display:flex;flex-direction:column;gap:7px;margin:14px 0}
.bar{display:grid;grid-template-columns:180px 1fr auto;align-items:center;gap:10px;font-size:13px}
.bar .bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar .bt{height:14px;background:var(--accent);border-radius:999px;min-width:4px}.bar .bv{color:var(--muted);white-space:nowrap}
footer{max-width:760px;margin:0 auto;padding:20px;color:var(--muted);font-size:13px}`;
