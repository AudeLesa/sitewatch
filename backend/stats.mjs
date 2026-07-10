// Print engagement counts to the nightly CI log — the log history IS the
// time series (RLS hides these tables from the anon key by design, so this is
// the one place growth is visible without opening the Supabase dashboard).
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node backend/stats.mjs
// Read-only; exits 0 even when a count fails so stats can never break a deploy.
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in the environment.');
  process.exit(1);
}

// HEAD + count=exact returns the row count in Content-Range without any body.
// `key` must be a real column on the table (profiles has no `id`).
async function count(table, key, filter = '') {
  try {
    const res = await fetch(`${URL}/rest/v1/${table}?select=${key}${filter}`, {
      method: 'HEAD',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact' },
    });
    if (!res.ok) return `error ${res.status}`;
    return res.headers.get('content-range')?.split('/')[1] ?? '?';
  } catch (err) {
    return `error (${err.message})`;
  }
}

const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
console.log('Engagement counts:');
console.log(`  digest subscribers : ${await count('digest_subscribers', 'id', '&active=eq.true')}`);
console.log(`  saved searches     : ${await count('saved_searches', 'id', '&active=eq.true')}`);
console.log(`  pro accounts       : ${await count('profiles', 'user_id', '&is_pro=eq.true')}`);
console.log(`  alerts sent (24h)  : ${await count('alerts_sent', 'project_id', `&sent_at=gte.${encodeURIComponent(dayAgo)}`)}`);
