import { config } from '../config.js';
import { fetchText, fetchWithRetry } from '../util/http.js';
import { parseTables } from '../util/htmlTable.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';

// ---------------------------------------------------------------------------
// City of Houston "Sold Permits" — free, site-level, 3-year history.
//
// It's a WebFOCUS self-service form (ibiapp_app=soldpermits, server=EDASERVE).
// Captured field map from the live form (online_permit.htm):
//   BDT / EDT     begin / end date   (format YYYYMMDD)
//   edit4 / edit5 valuation min / max
//   SELTD=CM      Commercial (Category B)   [RD=residential, MF=multifamily]
//   PTYPE         discipline: 13=Structural, MD=Multi Discipline, ...
//
// TWO UNKNOWNS remain — the servlet path and the report name (IBIF_ex) — because
// WebFOCUS builds its POST in JavaScript. Finalize them with `npm run probe:houston`,
// then set HOUSTON_WF_SERVLET and HOUSTON_WF_EX in .env. Until then this source
// throws a clear, actionable error instead of guessing wrong.
// ---------------------------------------------------------------------------

export const id = 'houston_sold_permits';

export async function fetchPermits({ log = console.error } = {}) {
  const { servlet, ibifEx } = config.sources.houstonSoldPermits;
  if (!servlet || !ibifEx) {
    log(
      '[houston] not finalized: set HOUSTON_WF_SERVLET and HOUSTON_WF_EX in .env ' +
        '(run `npm run probe:houston` to discover them). Skipping for now.'
    );
    return [];
  }

  const html = await fetchReport({ servlet, ibifEx });
  const rows = bestTable(parseTables(html));
  log(`[houston] report returned ${rows.length} rows`);
  return rows.map(mapRow).filter(Boolean);
}

/** POST the WebFOCUS report request and return the raw HTML. */
export async function fetchReport({ servlet, ibifEx, from, to, structural = true }) {
  const fromD = from || yyyymmdd(monthsAgo(config.lookbackMonths));
  const toD = to || yyyymmdd(new Date());

  const body = new URLSearchParams({
    IBIF_ex: ibifEx,
    IBIC_server: 'EDASERVE',
    ibiapp_app: 'soldpermits',
    // input variables from the captured form:
    SELTD: 'CM', // Commercial (Category B)
    PTYPE: structural ? '13' : 'MD', // Structural vs Multi Discipline
    BDT: fromD,
    EDT: toD,
    edit4: '', // valuation min (blank = no floor)
    edit5: '', // valuation max
    SRH: '',
  });

  return fetchText(servlet, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: config.sources.houstonSoldPermits.formUrl,
    },
    body: body.toString(),
  });
}

// Pick the largest table on the page (the report grid).
function bestTable(tables) {
  return tables.sort((a, b) => b.length - a.length)[0] || [];
}

// Column names are confirmed against a live report during the probe step; we map
// tolerantly by fuzzy header match so small label differences don't break us.
function mapRow(row) {
  const get = (...needles) => {
    for (const [k, v] of Object.entries(row)) {
      const key = k.toLowerCase();
      if (needles.some((n) => key.includes(n))) return v;
    }
    return null;
  };

  const address = get('address', 'job site', 'location');
  const permitNo = get('permit', 'project', 'proj');
  if (!address && !permitNo) return null;

  const desc = get('desc', 'work', 'type of', 'scope');
  return makeRecord({
    source: id,
    sourceId: permitNo,
    permitNumber: permitNo,
    category: CATEGORY.COMMERCIAL, // SELTD=CM constrains the query to commercial
    workClass: mapWorkClass(desc),
    status: STATUS.ISSUED, // "sold permit" == issued; no lifecycle field in this report
    description: desc,
    valuation: num(get('valuation', 'value', 'cost', 'amount')),
    issuedDate: date(get('date', 'sold', 'issue')),
    owner: get('buyer', 'owner', 'applicant'),
    address: { line1: address, city: 'Houston', state: 'TX', zip: get('zip') },
    raw: row,
  });
}

function mapWorkClass(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('new')) return WORK_CLASS.NEW_CONSTRUCTION;
  if (s.includes('shell')) return WORK_CLASS.SHELL;
  if (s.includes('addition')) return WORK_CLASS.ADDITION;
  if (s.includes('demo')) return WORK_CLASS.DEMOLITION;
  if (s.includes('remodel') || s.includes('alter') || s.includes('repair')) return WORK_CLASS.REMODEL;
  return WORK_CLASS.UNKNOWN;
}

function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function date(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}
function yyyymmdd(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export { fetchWithRetry }; // re-exported for the probe script's convenience
