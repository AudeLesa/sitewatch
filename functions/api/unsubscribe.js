// Cloudflare Pages Function — GET /api/unsubscribe?id=<subscriber uuid>
// One-click unsubscribe for the free weekly digest. The id is the random uuid
// from the digest email — unguessable, so no further auth is needed.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('id') || '';
  const page = (msg) =>
    new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SiteWatch digest</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f2dcd8;font-family:'Segoe UI',system-ui,sans-serif;color:#232a52">
<div style="text-align:center;background:#fdf6f0;padding:44px 52px;border-radius:26px;box-shadow:0 18px 44px rgba(49,63,159,.13)">
<p style="margin:0 0 20px;font-size:16px">${msg}</p>
<a href="/" style="background:#313f9f;color:#fff;text-decoration:none;padding:11px 24px;border-radius:999px;font-weight:600">Back to the map</a>
</div></body>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );

  if (!/^[0-9a-f-]{36}$/i.test(id)) return page('That unsubscribe link looks incomplete — no changes made.');
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/digest_subscribers?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ active: false }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return page("You're unsubscribed from the weekly digest. ✓");
  } catch {
    return page('Something went wrong — please try the link again in a minute.');
  }
}
