#!/usr/bin/env node
// One-off diagnostic: POST the WebFOCUS report with candidate report names and
// show what comes back, so we can lock HOUSTON_WF_SERVLET / HOUSTON_WF_EX.
import { parseTables } from '../src/util/htmlTable.js';

const SERVLET = 'http://cohtora.houstontx.gov/ibi_apps/WFServlet';
const FORM_URL = 'http://cohtora.houstontx.gov/approot/soldpermits/online_permit.htm';
const CANDIDATES = ['app/online_permit_se.fex', 'online_permit_se.fex', 'online_per_se.fex', 'soldpermits/online_permit_se.fex'];

function yyyymmdd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}
const from = new Date();
from.setMonth(from.getMonth() - 6);

// Warm a session: GET the form, capture any Set-Cookie to send back on the POST.
let cookie = '';
try {
  const warm = await fetch(FORM_URL, { signal: AbortSignal.timeout(20000) });
  const sc = warm.headers.getSetCookie?.() || [];
  cookie = sc.map((c) => c.split(';')[0]).join('; ');
  console.log(`warmed session, cookie: ${cookie || '(none)'}\n`);
} catch (e) {
  console.log(`warm failed: ${e.message}\n`);
}

for (const ex of CANDIDATES) {
  const body = new URLSearchParams({
    IBIF_ex: ex,
    IBIC_server: 'EDASERVE',
    ibiapp_app: 'soldpermits',
    action: 'MR_STD_REPORT',
    SELTD: 'CM',
    PTYPE: '13',
    BDT: yyyymmdd(from),
    EDT: yyyymmdd(new Date()),
    edit4: '',
    edit5: '',
    SRH: '',
  });
  try {
    const res = await fetch(`${SERVLET}?action=MR_STD_REPORT`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: FORM_URL,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    const tables = parseTables(text);
    const biggest = tables.sort((a, b) => b.length - a.length)[0];
    console.log(`\n=== IBIF_ex=${ex} -> HTTP ${res.status}, ${text.length} bytes, ${tables.length} tables ===`);
    if (biggest?.length) {
      console.log(`  biggest table: ${biggest.length} rows`);
      console.log(`  columns: ${Object.keys(biggest[0]).join(' | ')}`);
      console.log(`  row[0]: ${JSON.stringify(biggest[0])}`);
    } else {
      const snippet = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      console.log(`  no data table. text: ${snippet}`);
    }
  } catch (e) {
    console.log(`\n=== IBIF_ex=${ex} -> ERROR ${e.message} ===`);
  }
}
