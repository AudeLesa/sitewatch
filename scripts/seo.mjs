// Static SEO page generator. Turns the dataset into crawlable HTML so Google can
// index it — the growth engine. Produces, into dist/:
//   project/<permit>.html   one rich page per project (the long tail)
//   where/<city>.html        a landing page per metro ("construction in Houston, TX")
//   where/index.html         a browsable directory of all metros
//   company/<slug>.html      a page per owner/architect ("everything Hines is building")
//   companies.html           directory of the most active companies
//   insights.html            a Texas construction market report (stats, the analyst hook)
//   sitemap.xml + robots.txt so search engines discover everything
//   p.css                    one shared stylesheet (cached across all pages)
// Called from build.mjs. Pure string templating — no dependencies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MIN_COMPANY_PROJECTS = 3; // a company needs this many projects to get its own page

const CAT = { commercial: 'Commercial', industrial: 'Industrial', institutional: 'Institutional', multifamily: 'Multifamily', residential: 'Residential', unknown: 'Project' };
const WORK = { new_construction: 'New construction', addition: 'Addition', shell: 'Shell', remodel: 'Renovation', other: 'Construction', unknown: 'Construction' };

const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
const usd = (n) => (n ? '$' + Number(n).toLocaleString() : null);
const short = (n) => (!n ? '$0' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : '$' + n);
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'tx';
const cityOf = (addr) => { const p = String(addr || '').split(','); return p.length >= 2 ? p[p.length - 2].trim() : ''; };
const fileOf = (permit) => String(permit || '').replace(/[^A-Za-z0-9_-]/g, '');
const JUNK = /^(n\/?a|tbd|to be determined|unknown|none|owner|self|same|various|n\.a\.)$/i;
const isCompany = (n) => n && String(n).trim().length >= 3 && !JUNK.test(String(n).trim());

export function generateSeo(dist, features, { siteUrl }) {
  const site = (siteUrl || 'https://sitewatch-eyt.pages.dev').replace(/\/$/, '');
  mkdirSync(join(dist, 'project'), { recursive: true });
  mkdirSync(join(dist, 'where'), { recursive: true });
  mkdirSync(join(dist, 'company'), { recursive: true });
  writeFileSync(join(dist, 'p.css'), CSS);

  // ---- index pass: cities + companies (owner/architect) ----
  const cities = new Map();    // slug -> { name, items[] }
  const companies = new Map(); // slug -> { name, owned[], designed[] }
  const valid = [];
  const addCo = (name, p, role) => {
    if (!isCompany(name)) return;
    const s = slug(name);
    if (!companies.has(s)) companies.set(s, { name: String(name).trim(), owned: [], designed: [] });
    companies.get(s)[role].push(p);
  };
  for (const f of features) {
    const p = f.properties || {};
    if (!p.permitNumber) continue;
    valid.push(p);
    const cn = cityOf(p.address), cs = slug(cn);
    if (cn) { if (!cities.has(cs)) cities.set(cs, { name: cn, items: [] }); cities.get(cs).items.push(p); }
    addCo(p.owner, p, 'owned');
    addCo(p.designFirm, p, 'designed');
  }
  const paged = new Set([...companies].filter(([, c]) => c.owned.length + c.designed.length >= MIN_COMPANY_PROJECTS).map(([s]) => s));
  const coLink = (name) => { const s = slug(name); return isCompany(name) && paged.has(s) ? `/company/${s}.html` : null; };

  const urls = [`${site}/`, `${site}/insights.html`, `${site}/where/index.html`, `${site}/companies.html`];

  // ---- project pages ----
  for (const p of valid) {
    const file = fileOf(p.permitNumber);
    if (!file) continue;
    const cn = cityOf(p.address), cs = slug(cn), url = `${site}/project/${file}.html`;
    writeFileSync(join(dist, 'project', `${file}.html`), projectPage(p, cn, cs, url, site, coLink));
    urls.push(url);
  }

  // ---- metro pages ----
  const cityList = [...cities.entries()].filter(([, c]) => c.items.length >= 3).sort((a, b) => b[1].items.length - a[1].items.length);
  for (const [cs, c] of cityList) { writeFileSync(join(dist, 'where', `${cs}.html`), cityPage(c, cs, `${site}/where/${cs}.html`, site, cityList)); urls.push(`${site}/where/${cs}.html`); }
  writeFileSync(join(dist, 'where', 'index.html'), directoryPage(cityList, site));

  // ---- company pages + directory ----
  const coList = [...companies.entries()].filter(([s]) => paged.has(s)).sort((a, b) => (b[1].owned.length + b[1].designed.length) - (a[1].owned.length + a[1].designed.length));
  for (const [cs, c] of coList) { writeFileSync(join(dist, 'company', `${cs}.html`), companyPage(c, cs, `${site}/company/${cs}.html`, site)); urls.push(`${site}/company/${cs}.html`); }
  writeFileSync(join(dist, 'companies.html'), companiesIndex(coList, site));

  // ---- market report ----
  writeFileSync(join(dist, 'insights.html'), insightsPage(valid, cityList, coList, site));

  // ---- sitemap + robots ----
  writeFileSync(join(dist, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n') + `\n</urlset>\n`);
  writeFileSync(join(dist, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);

  console.log(`  + ${valid.length} project, ${cityList.length} metro, ${coList.length} company pages + insights, sitemap (${urls.length} urls)`);
  if (urls.length > 19000) console.log('  ⚠ approaching Cloudflare Pages 20k-file limit — raise MIN_COMPANY_PROJECTS or move project pages to SSR.');
}

// ---------------------------------------------------------------------------

function head(title, desc, canonical, jsonld) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(canonical)}">
<link rel="stylesheet" href="/p.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head><body>`;
}
const foot = (site) => `<footer>SiteWatch — live commercial construction across Texas, from public building-permit records. <a href="${site}/">Map</a> · <a href="${site}/insights.html">Market report</a> · <a href="${site}/where/index.html">Metros</a> · <a href="${site}/companies.html">Companies</a></footer></body></html>`;

function projectPage(p, cname, cslug, url, site, coLink) {
  const name = p.facilityName || p.address || 'Construction project';
  const work = WORK[p.workClass] || 'Construction', cat = CAT[p.category] || 'Commercial';
  const title = `${name} — ${cname ? cname + ', ' : ''}TX ${cat.toLowerCase()} construction | SiteWatch`;
  const desc = `${name}${cname ? ` in ${cname}, TX` : ''}. ${[work, usd(p.valuation), p.squareFeet ? Number(p.squareFeet).toLocaleString() + ' ft²' : null, p.owner ? `Owner ${p.owner}` : null].filter(Boolean).join(' · ')}.`;
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<tr><th>${k}</th><td>${v}</td></tr>`); };
  const tel = (n) => { const d = String(n || '').replace(/[^0-9+]/g, ''); return d ? `<a href="tel:${d}">${esc(n)}</a>` : ''; };
  const party = (nm, ph) => { if (!nm) return null; const h = coLink(nm); const lbl = h ? `<a href="${h}">${esc(nm)}</a>` : esc(nm); return lbl + (ph ? ' · ' + tel(ph) : ''); };
  add('Type', work); add('Category', cat); add('Declared value', usd(p.valuation));
  add('Square footage', p.squareFeet ? Number(p.squareFeet).toLocaleString() + ' ft²' : null);
  add('Scope', esc(p.scopeOfWork));
  add('Status', esc((/\(([^)]+)\)\s*$/.exec(p.description || '') || [])[1] || p.status));
  add('Est. timeline', (p.estStartDate || p.estEndDate) ? `${esc(p.estStartDate || '?')} → ${esc(p.estEndDate || '?')}` : null);
  add('Registered', esc(p.issuedDate));
  if (p.startedAt) add('Construction started', `🚧 ${esc(p.startedAt)}`);
  else if (p.statusChangedAt && p.firstSeenAt && p.statusChangedAt !== p.firstSeenAt) add('Status updated', esc(p.statusChangedAt) + (p.prevStatus ? ` (from ${esc(p.prevStatus)})` : ''));
  add('Address', esc(p.address));
  add('Owner', party(p.owner, p.ownerPhone));
  add('Architect', party(p.designFirm, p.designFirmPhone));
  add('Contact', esc(p.contactName));
  add('Funding', p.publicFunds == null ? null : (p.publicFunds ? 'Public' : 'Private'));
  add('Permit', esc(p.permitNumber));
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: 'Texas construction', item: `${site}/where/index.html` },
    cname ? { '@type': 'ListItem', position: 2, name: `${cname}, TX`, item: `${site}/where/${cslug}.html` } : null,
    { '@type': 'ListItem', position: cname ? 3 : 2, name, item: url }].filter(Boolean) };
  const tdlr = /^TABS/.test(p.permitNumber || '') ? `https://www.tdlr.texas.gov/TABS/Search/Project/${p.permitNumber}` : null;
  return head(title, desc, url, breadcrumb) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav>${cname ? `<a href="/where/${cslug}.html">${esc(cname)}, TX</a> · ` : ''}<a href="/insights.html">Report</a></nav></header>
<main>
<h1>${esc(name)}</h1>
<p class="sub">${esc(work)}${cname ? ` in ${esc(cname)}, Texas` : ''}${p.valuation ? ` — <strong>${usd(p.valuation)}</strong>` : ''}</p>
<table>${rows.join('')}</table>
<p class="cta"><a class="btn" href="/#p=${encodeURIComponent(p.permitNumber)}">View on the live map →</a>${tdlr ? ` <a href="${tdlr}" rel="nofollow">State TDLR record ↗</a>` : ''}</p>
${cname ? `<p class="rel">More <a href="/where/${cslug}.html">commercial construction in ${esc(cname)}, TX</a>.</p>` : ''}
</main>` + foot(site);
}

function cityPage(c, cslug, url, site, cityList) {
  const items = c.items.slice().sort((a, b) => (b.valuation || 0) - (a.valuation || 0));
  const total = items.reduce((s, p) => s + (p.valuation || 0), 0);
  const title = `Commercial construction in ${c.name}, TX — ${items.length} active projects | SiteWatch`;
  const desc = `${items.length} commercial construction projects tracked in ${c.name}, Texas` + (total ? `, ${usd(total)} in declared value` : '') + `. Owners, architects, value and status from public permit records.`;
  const list = items.slice(0, 250).map((p) => `<li><a href="/project/${fileOf(p.permitNumber)}.html">${esc(p.facilityName || p.address || 'Project')}</a> <span class="m">${[short(p.valuation), CAT[p.category]].filter(Boolean).join(' · ')}</span></li>`).join('');
  const others = cityList.filter(([s]) => s !== cslug).slice(0, 24).map(([s, cc]) => `<a href="/where/${s}.html">${esc(cc.name)}</a>`).join(' · ');
  return head(title, desc, url, null) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/where/index.html">All metros</a></nav></header>
<main>
<h1>Commercial construction in ${esc(c.name)}, Texas</h1>
<p class="sub"><strong>${items.length}</strong> active projects${total ? ` · <strong>${usd(total)}</strong> declared value` : ''}. From public TDLR building-permit records.</p>
<p class="cta"><a class="btn" href="/">Explore ${esc(c.name)} on the live map →</a></p>
<ul class="projlist">${list}</ul>
${items.length > 250 ? `<p class="rel">Showing the 250 largest by value — see all on the <a href="/">live map</a>.</p>` : ''}
<p class="rel">Other Texas metros: ${others}</p>
</main>` + foot(site);
}

function companyPage(c, cslug, url, site) {
  const all = [...new Map([...c.owned, ...c.designed].map((p) => [p.permitNumber, p])).values()];
  const total = all.reduce((s, p) => s + (p.valuation || 0), 0);
  const roles = [c.owned.length ? `owner on ${c.owned.length}` : null, c.designed.length ? `architect on ${c.designed.length}` : null].filter(Boolean).join(', ');
  const title = `${c.name} — Texas construction projects | SiteWatch`;
  const desc = `${c.name} is tracked on ${all.length} commercial construction projects in Texas (${roles})${total ? `, ${usd(total)} in declared value` : ''}. Locations, value and status.`;
  const role = (p) => c.owned.includes(p) ? (c.designed.includes(p) ? 'owner & architect' : 'owner') : 'architect';
  const list = all.sort((a, b) => (b.valuation || 0) - (a.valuation || 0)).slice(0, 300).map((p) =>
    `<li><a href="/project/${fileOf(p.permitNumber)}.html">${esc(p.facilityName || p.address || 'Project')}</a> <span class="m">${[short(p.valuation), cityOf(p.address), role(p)].filter(Boolean).join(' · ')}</span></li>`).join('');
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'Organization', name: c.name, url };
  return head(title, desc, url, breadcrumb) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/companies.html">All companies</a></nav></header>
<main>
<h1>${esc(c.name)}</h1>
<p class="sub"><strong>${all.length}</strong> Texas construction projects · ${esc(roles)}${total ? ` · <strong>${usd(total)}</strong> declared value` : ''}.</p>
<ul class="projlist">${list}</ul>
<p class="rel"><a href="/insights.html">Texas construction market report →</a></p>
</main>` + foot(site);
}

function companiesIndex(coList, site) {
  const title = `Top Texas construction owners & architects | SiteWatch`;
  const desc = `The most active owners and architecture firms in Texas commercial construction, by project count.`;
  const links = coList.slice(0, 600).map(([s, c]) => `<li><a href="/company/${s}.html">${esc(c.name)}</a> <span class="m">${c.owned.length + c.designed.length}</span></li>`).join('');
  return head(title, desc, `${site}/companies.html`, null) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/insights.html">Report</a></nav></header>
<main>
<h1>Most active companies in Texas construction</h1>
<p class="sub">Owners and architecture firms ranked by tracked projects.</p>
<ul class="dirlist">${links}</ul>
</main>` + foot(site);
}

function insightsPage(valid, cityList, coList, site) {
  const total = valid.length, totalVal = valid.reduce((s, p) => s + (p.valuation || 0), 0);
  const byCat = {}; const byFund = { Public: 0, Private: 0 }; let started = 0;
  for (const p of valid) {
    const c = CAT[p.category] || 'Other'; byCat[c] = byCat[c] || { n: 0, v: 0 }; byCat[c].n++; byCat[c].v += p.valuation || 0;
    if (p.publicFunds === true) byFund.Public++; else if (p.publicFunds === false) byFund.Private++;
    if (p.justStarted) started++;
  }
  const metros = cityList.slice(0, 12).map(([, c]) => ({ name: c.name, n: c.items.length, v: c.items.reduce((s, p) => s + (p.valuation || 0), 0) }));
  const owners = coList.filter(([, c]) => c.owned.length).sort((a, b) => b[1].owned.length - a[1].owned.length).slice(0, 12).map(([s, c]) => ({ s, name: c.name, n: c.owned.length }));
  const archs = coList.filter(([, c]) => c.designed.length).sort((a, b) => b[1].designed.length - a[1].designed.length).slice(0, 12).map(([s, c]) => ({ s, name: c.name, n: c.designed.length }));
  const bars = (rows, max, fmt, link) => rows.map((r) => `<div class="bar"><span class="bl">${link && r.s ? `<a href="/company/${r.s}.html">${esc(r.name)}</a>` : esc(r.name)}</span><span class="bt" style="width:${Math.max(4, Math.round((r._w / max) * 100))}%"></span><span class="bv">${fmt(r)}</span></div>`).join('');
  const withW = (rows, key) => rows.map((r) => ({ ...r, _w: r[key] }));
  const title = `Texas commercial construction report — ${short(totalVal)} across ${total.toLocaleString()} projects | SiteWatch`;
  const desc = `Live market report: ${total.toLocaleString()} commercial construction projects across Texas worth ${short(totalVal)}, by metro, category, owner and architect. Updated from public permit records.`;
  const catRows = Object.entries(byCat).sort((a, b) => b[1].v - a[1].v).map(([k, v]) => ({ name: k, n: v.n, v: v.v, _w: v.v }));
  const maxCatV = Math.max(...catRows.map((r) => r.v), 1);
  const maxMetroV = Math.max(...metros.map((m) => m.v), 1);
  const maxOwn = Math.max(...owners.map((o) => o.n), 1), maxArch = Math.max(...archs.map((a) => a.n), 1);
  return head(title, desc, `${site}/insights.html`, null) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/where/index.html">Metros</a> · <a href="/companies.html">Companies</a></nav></header>
<main>
<h1>Texas commercial construction — live market report</h1>
<p class="sub"><strong>${total.toLocaleString()}</strong> active projects · <strong>${usd(totalVal)}</strong> declared value · ${cityList.length} metros tracked${started ? ` · <strong>${started}</strong> just started construction` : ''}. From public TDLR permit records.</p>
<h2>By category</h2><div class="bars">${bars(catRows, maxCatV, (r) => `${short(r.v)} · ${r.n}`, false)}</div>
<h2>Top metros by value</h2><div class="bars">${bars(withW(metros, 'v'), maxMetroV, (r) => `${short(r.v)} · ${r.n}`, false)}</div>
<h2>Most active owners</h2><div class="bars">${bars(withW(owners, 'n'), maxOwn, (r) => `${r.n} projects`, true)}</div>
<h2>Most active architecture firms</h2><div class="bars">${bars(withW(archs, 'n'), maxArch, (r) => `${r.n} projects`, true)}</div>
<h2>Funding</h2><div class="bars">${bars([{ name: 'Private', _w: byFund.Private, n: byFund.Private }, { name: 'Public', _w: byFund.Public, n: byFund.Public }], Math.max(byFund.Private, byFund.Public, 1), (r) => `${r.n}`, false)}</div>
<p class="cta"><a class="btn" href="/">Explore on the live map →</a></p>
</main>` + foot(site);
}

function directoryPage(cityList, site) {
  const title = `Commercial construction by Texas metro | SiteWatch`;
  const desc = `Browse active commercial construction projects across ${cityList.length} Texas cities — Houston, Dallas, Austin, San Antonio and more.`;
  const links = cityList.map(([s, c]) => `<li><a href="/where/${s}.html">${esc(c.name)}, TX</a> <span class="m">${c.items.length}</span></li>`).join('');
  return head(title, desc, `${site}/where/index.html`, null) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav><a href="/insights.html">Report</a></nav></header>
<main>
<h1>Texas commercial construction by metro</h1>
<p class="sub">Active projects tracked across ${cityList.length} cities, live from public permit records.</p>
<ul class="dirlist">${links}</ul>
</main>` + foot(site);
}

const CSS = `:root{--bg:#0a0e16;--panel:#0f1722;--border:#1e2a3a;--text:#e6eef8;--muted:#8499b3;--accent:#38bdf8;--good:#34d399}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:14px;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.logo{font-weight:700;color:var(--text)}.logo:hover{text-decoration:none}header nav{font-size:14px;color:var(--muted)}
main{max-width:760px;margin:0 auto;padding:28px 20px 40px}
h1{font-size:26px;line-height:1.2;margin:0 0 6px}h2{font-size:16px;margin:26px 0 10px}.sub{color:var(--muted);margin:0 0 20px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border);font-size:14px;vertical-align:top}
th{color:var(--muted);font-weight:500;width:160px;white-space:nowrap}tr:last-child th,tr:last-child td{border-bottom:none}
.cta{margin:22px 0}.btn{display:inline-block;background:var(--accent);color:#042130;font-weight:700;padding:10px 16px;border-radius:9px}.btn:hover{text-decoration:none}
.cta a:not(.btn){margin-left:12px;font-size:14px}.rel{color:var(--muted);font-size:14px;margin-top:18px}
ul.projlist,ul.dirlist{list-style:none;padding:0;margin:18px 0;border:1px solid var(--border);border-radius:12px;background:var(--panel);overflow:hidden}
ul.projlist li,ul.dirlist li{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);font-size:14px}
ul.projlist li:last-child,ul.dirlist li:last-child{border-bottom:none}.m{color:var(--muted);white-space:nowrap}
.bars{display:flex;flex-direction:column;gap:7px;margin:14px 0}
.bar{display:grid;grid-template-columns:180px 1fr auto;align-items:center;gap:10px;font-size:13px}
.bar .bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar .bt{height:14px;background:var(--accent);border-radius:4px;min-width:4px}.bar .bv{color:var(--muted);white-space:nowrap}
footer{max-width:760px;margin:0 auto;padding:20px;border-top:1px solid var(--border);color:var(--muted);font-size:13px}`;
