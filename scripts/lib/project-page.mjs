// Shared project-page renderer — the ONE template for /project/<permit> pages.
// Used by two callers that must produce byte-identical HTML:
//   • scripts/seo.mjs (build): bakes each project into a render-shard entry
//     (dist/data/shards/) and uses these helpers for the other page types.
//   • functions/project/[[permit]].js (Pages Function): renders the page
//     on demand from the shard entry — project pages stopped being static
//     files when they became 87% of Cloudflare Pages' 20k-file budget.
// Zero dependencies, pure string templating. Number formatting pins 'en-US'
// so Node (build) and workerd (edge) emit identical bytes.

// Bump when the template output changes — it feeds the function's ETag so
// crawlers re-fetch after a template deploy instead of 304ing stale copies.
export const TEMPLATE_VERSION = '1';

export const CAT = { commercial: 'Commercial', industrial: 'Industrial', institutional: 'Institutional', multifamily: 'Multifamily', residential: 'Residential', unknown: 'Project' };
export const WORK = { new_construction: 'New construction', addition: 'Addition', shell: 'Shell', remodel: 'Renovation', other: 'Construction', unknown: 'Construction' };

export const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
export const num = (n) => Number(n).toLocaleString('en-US');
export const usd = (n) => (n ? '$' + num(n) : null);
export const fileOf = (permit) => String(permit || '').replace(/[^A-Za-z0-9_-]/g, '');

// Region copy defaults — the Texas launch region. Callers merge their region
// manifest entry over these; a region-less render is exactly the classic page.
export const TX_REGION = {
  label: 'Texas',
  state: 'TX',
  stateName: 'Texas',
  sourceShort: 'TDLR',
  exampleCities: 'Houston, Dallas, Austin, San Antonio',
  permitLinks: [{ prefix: 'TABS', label: 'TDLR', url: 'https://www.tdlr.texas.gov/TABS/Search/Project/{permit}' }],
};

// Official source record for a permit, from the region's per-source templates.
export const srcLink = (permit, region) => {
  const l = (region.permitLinks || []).find((x) => permit && String(permit).startsWith(x.prefix));
  return l ? l.url.replace('{permit}', permit) : null;
};

export function head(title, desc, canonical, jsonld) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/p.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head><body>`;
}

export const foot = (site, region) => `<footer>SiteWatch — live commercial construction across ${region.stateName}, from public building-permit records. <a href="${site}/">Map</a> · <a href="${site}/insights">Market report</a> · <a href="${site}/where/">Metros</a> · <a href="${site}/companies">Companies</a></footer></body></html>`;

/**
 * Render one project page.
 * entry: { p: geojson feature properties, cname, cslug,
 *          links: { owner, arch, tenant, ras } — precomputed /company/<slug>
 *          hrefs (or null) for each party, resolved at build time against the
 *          set of companies that actually got pages }
 */
export function renderProjectPage(entry, { site, region }) {
  const { p, cname, cslug, links = {} } = entry;
  const R = region;
  const url = `${site}/project/${fileOf(p.permitNumber)}`;
  const name = p.facilityName || p.address || 'Construction project';
  const work = WORK[p.workClass] || 'Construction', cat = CAT[p.category] || 'Commercial';
  const title = `${name} — ${cname ? cname + ', ' : ''}${R.state} ${cat.toLowerCase()} construction | SiteWatch`;
  const desc = `${name}${cname ? ` in ${cname}, ${R.state}` : ''}. ${[work, usd(p.valuation), p.squareFeet ? num(p.squareFeet) + ' ft²' : null, p.owner ? `Owner ${p.owner}` : null].filter(Boolean).join(' · ')}.`;
  const rows = [];
  const add = (k, v) => { if (v) rows.push(`<tr><th>${k}</th><td>${v}</td></tr>`); };
  const tel = (n) => { const d = String(n || '').replace(/[^0-9+]/g, ''); return d ? `<a href="tel:${d}">${esc(n)}</a>` : ''; };
  const party = (nm, ph, h) => { if (!nm) return null; const lbl = h ? `<a href="${h}">${esc(nm)}</a>` : esc(nm); return lbl + (ph ? ' · ' + tel(ph) : ''); };
  add('Type', work); add('Category', cat); add('Declared value', usd(p.valuation));
  add('Square footage', p.squareFeet ? num(p.squareFeet) + ' ft²' : null);
  add('Scope', esc(p.scopeOfWork));
  add('Status', esc((/\(([^)]+)\)\s*$/.exec(p.description || '') || [])[1] || p.status));
  add('Est. timeline', (p.estStartDate || p.estEndDate) ? `${esc(p.estStartDate || '?')} → ${esc(p.estEndDate || '?')}` : null);
  add('Registered', esc(p.issuedDate));
  if (p.startedAt) add('Construction started', `🚧 ${esc(p.startedAt)}`);
  else if (p.statusChangedAt && p.firstSeenAt && p.statusChangedAt !== p.firstSeenAt) add('Status updated', esc(p.statusChangedAt) + (p.prevStatus ? ` (from ${esc(p.prevStatus)})` : ''));
  add('Address', esc(p.address));
  add('Owner', party(p.owner, p.ownerPhone, links.owner));
  add('Architect', party(p.designFirm, p.designFirmPhone, links.arch));
  add('Tenant', party(p.tenantName, p.tenantPhone, links.tenant));
  add('Accessibility specialist', party(p.rasName, p.rasPhone, links.ras));
  add('Contact', esc(p.contactName));
  add('Funding', p.publicFunds == null ? null : (p.publicFunds ? 'Public' : 'Private'));
  add('Permit', esc(p.permitNumber));
  const breadcrumb = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
    { '@type': 'ListItem', position: 1, name: `${R.stateName} construction`, item: `${site}/where/` },
    cname ? { '@type': 'ListItem', position: 2, name: `${cname}, ${R.state}`, item: `${site}/where/${cslug}` } : null,
    { '@type': 'ListItem', position: cname ? 3 : 2, name, item: url }].filter(Boolean) };
  const official = srcLink(p.permitNumber, R);
  return head(title, desc, url, breadcrumb) +
    `<header><a class="logo" href="/">● SiteWatch</a><nav>${cname ? `<a href="/where/${cslug}">${esc(cname)}, ${R.state}</a> · ` : ''}<a href="/insights">Report</a></nav></header>
<main>
<h1>${esc(name)}</h1>
<p class="sub">${esc(work)}${cname ? ` in ${esc(cname)}, ${R.stateName}` : ''}${p.valuation ? ` — <strong>${usd(p.valuation)}</strong>` : ''}</p>
<table>${rows.join('')}</table>
<p class="cta"><a class="btn" href="/#p=${encodeURIComponent(p.permitNumber)}">View on the live map →</a>${official ? ` <a href="${official}" rel="nofollow">State ${R.sourceShort} record ↗</a>` : ''}</p>
${cname ? `<p class="rel">More <a href="/where/${cslug}">commercial construction in ${esc(cname)}, ${R.state}</a>.</p>` : ''}
</main>` + foot(site, R);
}

// Deterministic shard assignment for a permit's render entry. 64 shards is
// ~280 KB average at Texas scale (14.5k projects) — small enough to fetch and
// parse per request, few enough files to be negligible against the 20k budget.
// Internal to one deployment: build and function always agree because they
// ship together, so the hash may change freely between deploys.
export const SHARD_COUNT = 64;
export function shardOf(permitFile) {
  let h = 0;
  for (let i = 0; i < permitFile.length; i++) h = (h * 31 + permitFile.charCodeAt(i)) >>> 0;
  // Avalanche (murmur3 finalizer): plain 31-polynomial hashes degenerate mod
  // powers of two (31² ≡ 1 mod 64), which skewed shards 22 KB–636 KB. This
  // spreads all input bits into the low 6 before reducing.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0; // XOR yields a SIGNED int32 — coerce before modulo
  return (h % SHARD_COUNT).toString(16).padStart(2, '0');
}
