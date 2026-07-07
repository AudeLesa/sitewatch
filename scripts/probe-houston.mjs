#!/usr/bin/env node
// Reconnaissance for the Houston "Sold Permits" WebFOCUS form. Finds the two
// unknowns needed to finalize the scrape: the servlet path and the report name
// (IBIF_ex). Scans the form page + its linked scripts for tell-tale strings,
// then probes candidate servlet URLs. Run: npm run probe:houston

const FORM_URL = 'http://cohtora.houstontx.gov/approot/soldpermits/online_permit.htm';
const ORIGIN = 'http://cohtora.houstontx.gov';

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  return { status: res.status, text: await res.text() };
}

function findAll(text, re) {
  return [...new Set([...text.matchAll(re)].map((m) => m[0]))];
}

async function main() {
  console.log(`\nFetching form: ${FORM_URL}`);
  const form = await get(FORM_URL);
  console.log(`  status ${form.status}, ${form.text.length} bytes`);

  // 1. Collect linked scripts and inline JS, then scan everything together.
  const scripts = findAll(form.text, /src\s*=\s*["']([^"']+\.js[^"']*)["']/gi).map((s) =>
    s.replace(/^src\s*=\s*["']/i, '').replace(/["']$/, '')
  );
  let blob = form.text;
  for (const s of scripts) {
    const url = s.startsWith('http') ? s : new URL(s, FORM_URL).href;
    try {
      const js = await get(url);
      blob += '\n' + js.text;
      console.log(`  + script ${url} (${js.text.length} bytes)`);
    } catch (e) {
      console.log(`  ! script ${url} failed: ${e.message}`);
    }
  }

  // 2. Hunt for the WebFOCUS plumbing.
  console.log('\n--- candidates found in page/scripts ---');
  report('servlet paths', findAll(blob, /[\/\w.-]*WFServlet[\w./?=&-]*/gi));
  report('ibi_apps paths', findAll(blob, /[\/\w.-]*ibi_apps[\w./?=&-]*/gi));
  report('report names (.fex)', findAll(blob, /[\w./-]+\.fex/gi));
  report('IBIF_ex refs', findAll(blob, /IBIF_ex[^"'&\s]{0,60}/gi));
  report('soldpermits refs', findAll(blob, /soldpermits[\w./-]*/gi));
  report('form action attrs', findAll(blob, /action\s*=\s*["'][^"']+["']/gi));

  // 3. Probe likely servlet endpoints.
  console.log('\n--- probing candidate servlets ---');
  const candidates = [
    `${ORIGIN}/ibi_apps/WFServlet`,
    `${ORIGIN}/approot/soldpermits/WFServlet`,
    `${ORIGIN}/cgi-bin/ibiweb/WFServlet`,
  ];
  for (const url of candidates) {
    try {
      const r = await get(url);
      console.log(`  ${r.status}  ${url}`);
    } catch (e) {
      console.log(`  ERR  ${url}  (${e.message})`);
    }
  }

  console.log(`
Next:
  1. Pick the real servlet URL + report name (.fex) from above.
  2. Put them in .env:
       HOUSTON_WF_SERVLET=<servlet url>
       HOUSTON_WF_EX=<report name, e.g. soldpermits/something.fex>
  3. Run: npm run pull
  If nothing obvious surfaced, open ${FORM_URL} in a browser with DevTools >
  Network, run a Commercial search, and copy the POST request's URL + form data.
`);
}

function report(label, items) {
  console.log(`${label}: ${items.length ? '' : '(none)'}`);
  for (const i of items.slice(0, 12)) console.log(`   ${i}`);
}

main().catch((e) => {
  console.error('probe failed:', e.message);
  process.exit(1);
});
