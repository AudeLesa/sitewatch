// Send saved-search alert emails for newly-appeared projects.
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… RESEND_API_KEY=… ALERT_FROM="SiteWatch <alerts@yourdomain>" \
//   node backend/alert-worker.mjs
//
// Flow: ask Postgres for every (active search × new matching project) not yet sent
// (the pending_alerts function), group by recipient, email one digest each via
// Resend, then record what we sent in alerts_sent so it's never repeated. Run it
// right after `npm run load` on each refresh. Zero dependencies (plain fetch).
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND = process.env.RESEND_API_KEY;
const FROM = process.env.ALERT_FROM || 'SiteWatch <alerts@sitewatch.app>';
const SITE = process.env.SITE_URL || 'https://sitewatch-eyt.pages.dev';
const LOOKBACK_DAYS = Number(process.env.ALERT_LOOKBACK_DAYS || 14);

for (const [k, v] of Object.entries({ SUPABASE_URL: URL, SUPABASE_SERVICE_KEY: KEY, RESEND_API_KEY: RESEND })) {
  if (!v) { console.error(`Missing ${k} in the environment.`); process.exit(1); }
}

const sb = (path, opts = {}) =>
  fetch(`${URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });

// 1. Pull everything pending.
const res = await sb('rpc/pending_alerts', { method: 'POST', body: JSON.stringify({ lookback_days: LOOKBACK_DAYS }) });
if (!res.ok) { console.error(`pending_alerts failed: HTTP ${res.status}\n${await res.text()}`); process.exit(1); }
const pending = await res.json();
if (!pending.length) { console.error('No pending alerts.'); process.exit(0); }

// 2. Group by recipient.
const byEmail = new Map();
for (const row of pending) {
  if (!byEmail.has(row.email)) byEmail.set(row.email, []);
  byEmail.get(row.email).push(row);
}
console.error(`Sending ${pending.length} matches to ${byEmail.size} recipient(s)…`);

// 3. Email each recipient a digest, then record what we sent.
let sentRows = 0;
for (const [email, rows] of byEmail) {
  try {
    await sendEmail(email, rows);
    const recs = rows.map((r) => ({ saved_search_id: r.saved_search_id, project_id: r.project_id }));
    const ins = await sb('alerts_sent', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(recs),
    });
    if (!ins.ok) console.error(`  recorded send to ${email} but alerts_sent insert failed: HTTP ${ins.status}`);
    // Advance last_alert_at for the searches we just notified.
    const searchIds = [...new Set(rows.map((r) => r.saved_search_id))];
    await sb(`saved_searches?id=in.(${searchIds.join(',')})`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_alert_at: new Date().toISOString() }),
    });
    sentRows += rows.length;
    console.error(`  ✔ ${email}: ${rows.length} project(s)`);
  } catch (err) {
    console.error(`  ✗ ${email}: ${err.message} — will retry next run (not recorded)`);
  }
}
console.error(`Done. Emailed ${sentRows} matches.`);

// --- email -----------------------------------------------------------------

async function sendEmail(to, rows) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject: subjectFor(rows), html: htmlFor(rows) }),
  });
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}: ${await r.text()}`);
}

function subjectFor(rows) {
  const n = rows.length;
  const searches = [...new Set(rows.map((r) => r.search_name))];
  return `${n} new construction ${n === 1 ? 'site' : 'sites'} — ${searches.slice(0, 2).join(', ')}${searches.length > 2 ? '…' : ''}`;
}

function htmlFor(rows) {
  const fmt = (n) => (n ? '$' + Number(n).toLocaleString() : '—');
  const esc = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));
  const items = rows
    .map(
      (r) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #1f2a3a">
          <a href="${SITE}/#p=${encodeURIComponent(r.permit_number || '')}" style="color:#38bdf8;text-decoration:none;font-weight:600">
            ${esc(r.facility_name || r.address || 'New project')}
          </a>
          <div style="color:#8499b3;font-size:13px;margin-top:2px">
            ${esc(r.address || '')} · ${esc(r.category || '')} · <span style="color:#34d399">${fmt(r.valuation)}</span>
          </div>
          ${r.owner ? `<div style="color:#8499b3;font-size:13px;margin-top:2px">Owner: ${esc(r.owner)}${r.owner_phone ? ` · <a href="tel:${esc(String(r.owner_phone).replace(/[^0-9+]/g, ''))}" style="color:#38bdf8">${esc(r.owner_phone)}</a>` : ''}</div>` : ''}
        </td>
      </tr>`
    )
    .join('');
  return `<div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#e6eef8;background:#0f1722;padding:24px;border-radius:12px">
    <h2 style="margin:0 0 4px">New on SiteWatch</h2>
    <p style="color:#8499b3;margin:0 0 16px;font-size:14px">${rows.length} new site(s) match your saved search.</p>
    <table style="width:100%;border-collapse:collapse">${items}</table>
    <p style="margin-top:20px"><a href="${SITE}" style="color:#38bdf8">Open the map →</a></p>
  </div>`;
}
