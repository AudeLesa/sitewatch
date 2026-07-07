// Send saved-search alert emails for newly-appeared projects — and, with the
// `digest` argument, the free weekly digest to digest_subscribers.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… RESEND_API_KEY=… ALERT_FROM="SiteWatch <alerts@yourdomain>" \
//   node backend/alert-worker.mjs            # per-search Pro alerts (run after each `npm run load`)
//   node backend/alert-worker.mjs digest     # weekly statewide digest (run weekly, e.g. Monday cron)
//
// Alert flow: ask Postgres for every (active Pro search × new matching project)
// not yet sent (pending_alerts), group by recipient, email one digest each via
// Resend, then record in alerts_sent. Sends carry an Idempotency-Key derived
// from the exact recipient+projects set, so a crash between "email sent" and
// "alerts_sent recorded" can't double-email on the retry — Resend dedupes it.
// Zero dependencies (plain fetch).
import { createHash } from 'node:crypto';

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

if (process.argv[2] === 'digest') await runDigest();
else await runAlerts();

// ── Pro saved-search alerts ─────────────────────────────────────────────────

async function runAlerts() {
  const res = await sb('rpc/pending_alerts', { method: 'POST', body: JSON.stringify({ lookback_days: LOOKBACK_DAYS }) });
  if (!res.ok) { console.error(`pending_alerts failed: HTTP ${res.status}\n${await res.text()}`); process.exit(1); }
  const pending = await res.json();
  if (!pending.length) { console.error('No pending alerts.'); return; }

  const byEmail = new Map();
  for (const row of pending) {
    if (!byEmail.has(row.email)) byEmail.set(row.email, []);
    byEmail.get(row.email).push(row);
  }
  console.error(`Sending ${pending.length} matches to ${byEmail.size} recipient(s)…`);

  let sentRows = 0;
  for (const [email, rows] of byEmail) {
    try {
      // Idempotency key = exactly this recipient + this set of matches; a retry
      // after a mid-loop crash reuses the key and Resend suppresses the dupe.
      const idem = 'alert-' + createHash('sha256')
        .update(email + '|' + rows.map((r) => `${r.saved_search_id}:${r.project_id}`).sort().join(','))
        .digest('hex').slice(0, 32);
      await sendEmail(email, subjectFor(rows), alertHtml(rows), idem);
      const recs = rows.map((r) => ({ saved_search_id: r.saved_search_id, project_id: r.project_id }));
      const ins = await sb('alerts_sent', {
        method: 'POST',
        headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(recs),
      });
      if (!ins.ok) console.error(`  sent to ${email} but alerts_sent insert failed: HTTP ${ins.status}`);
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
}

// ── Free weekly digest ──────────────────────────────────────────────────────

async function runDigest() {
  const subsRes = await sb('digest_subscribers?active=eq.true&select=id,email');
  if (!subsRes.ok) { console.error(`digest_subscribers failed: HTTP ${subsRes.status}\n${await subsRes.text()}`); process.exit(1); }
  const subs = await subsRes.json();
  if (!subs.length) { console.error('No digest subscribers.'); return; }

  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const top = await (await sb(
    `projects?select=permit_number,facility_name,address,category,valuation,owner&first_seen=gte.${since}&order=valuation.desc.nullslast&limit=12`
  )).json();
  const newCount = await countWhere(`first_seen=gte.${since}`);
  const startedCount = await countWhere(`started_at=gte.${since.slice(0, 10)}`);
  if (!newCount && !startedCount) { console.error('Nothing new this week — skipping digest.'); return; }

  const subject = `This week in Texas construction: ${newCount.toLocaleString()} new project${newCount === 1 ? '' : 's'}`;
  const week = new Date().toISOString().slice(0, 10);
  console.error(`Digest to ${subs.length} subscriber(s): ${newCount} new, ${startedCount} started…`);

  let ok = 0;
  for (const s of subs) {
    try {
      const idem = 'digest-' + createHash('sha256').update(`${s.id}|${week}`).digest('hex').slice(0, 32);
      await sendEmail(s.email, subject, digestHtml(top, newCount, startedCount, s.id), idem);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${s.email}: ${err.message}`);
    }
  }
  console.error(`Done. Digest sent to ${ok}/${subs.length}.`);
}

async function countWhere(filter) {
  const r = await sb(`projects?select=id&${filter}&limit=1`, { headers: { Prefer: 'count=exact' } });
  const range = r.headers.get('content-range') || '';
  return Number(range.split('/')[1] || 0);
}

// ── email ────────────────────────────────────────────────────────────────────

async function sendEmail(to, subject, html, idempotencyKey) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  if (!r.ok) throw new Error(`Resend HTTP ${r.status}: ${await r.text()}`);
}

function subjectFor(rows) {
  const n = rows.length;
  const searches = [...new Set(rows.map((r) => r.search_name))];
  return `${n} new construction ${n === 1 ? 'site' : 'sites'} — ${searches.slice(0, 2).join(', ')}${searches.length > 2 ? '…' : ''}`;
}

const fmt = (n) => (n ? '$' + Number(n).toLocaleString() : '—');
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])));

function projectRows(rows) {
  return rows
    .map(
      (r) => `
      <tr>
        <td style="padding:11px 0;border-bottom:1px solid #efdcd3">
          <a href="${SITE}/#p=${encodeURIComponent(r.permit_number || '')}" style="color:#313f9f;text-decoration:none;font-weight:600">
            ${esc(r.facility_name || r.address || 'New project')}
          </a>
          <div style="color:#7a7f9e;font-size:13px;margin-top:2px">
            ${esc(r.address || '')} · ${esc(r.category || '')} · <span style="color:#3f9d77;font-weight:600">${fmt(r.valuation)}</span>
          </div>
          ${r.owner ? `<div style="color:#7a7f9e;font-size:13px;margin-top:2px">Owner: ${esc(r.owner)}${r.owner_phone ? ` · <a href="tel:${esc(String(r.owner_phone).replace(/[^0-9+]/g, ''))}" style="color:#313f9f">${esc(r.owner_phone)}</a>` : ''}</div>` : ''}
        </td>
      </tr>`
    )
    .join('');
}

function shell(inner) {
  return `<div style="background:#f2dcd8;padding:24px 12px">
    <div style="font-family:'Segoe UI',system-ui,sans-serif;max-width:560px;margin:auto;color:#232a52;background:#fdf6f0;padding:26px;border-radius:22px">
    ${inner}
    </div></div>`;
}

function alertHtml(rows) {
  return shell(`
    <h2 style="margin:0 0 4px">New on SiteWatch</h2>
    <p style="color:#7a7f9e;margin:0 0 16px;font-size:14px">${rows.length} new site(s) match your saved search.</p>
    <table style="width:100%;border-collapse:collapse">${projectRows(rows)}</table>
    <p style="margin-top:20px"><a href="${SITE}" style="display:inline-block;background:#313f9f;color:#fff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:999px">Open the map →</a></p>`);
}

function digestHtml(top, newCount, startedCount, subscriberId) {
  return shell(`
    <h2 style="margin:0 0 4px">This week in Texas construction</h2>
    <p style="color:#7a7f9e;margin:0 0 16px;font-size:14px">
      <b style="color:#232a52">${newCount.toLocaleString()}</b> new project${newCount === 1 ? '' : 's'} registered
      · <b style="color:#232a52">${startedCount.toLocaleString()}</b> broke ground
    </p>
    <table style="width:100%;border-collapse:collapse">${projectRows(top)}</table>
    <p style="margin-top:20px"><a href="${SITE}" style="display:inline-block;background:#313f9f;color:#fff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:999px">Explore the live map →</a></p>
    <p style="color:#aab0c8;font-size:12px;margin-top:18px">You signed up for the free SiteWatch weekly digest ·
      <a href="${SITE}/api/unsubscribe?id=${encodeURIComponent(subscriberId)}" style="color:#7a7f9e">unsubscribe</a></p>`);
}
