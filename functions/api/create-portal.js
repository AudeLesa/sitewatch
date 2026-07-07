// Cloudflare Pages Function — POST /api/create-portal
// Creates a Stripe customer-portal session for the signed-in Pro user so they
// can manage/cancel their subscription (there is no other self-serve cancel
// path). Zero dependencies. Env vars (same set as the other functions):
//   STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY
export async function onRequestPost({ request, env }) {
  try {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Not signed in' }, 401);

    // Validate the Supabase session and get the user id.
    const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!u.ok) return json({ error: 'Invalid session' }, 401);
    const user = await u.json();

    // Look up their Stripe customer id (service key — profiles RLS is read-own
    // only and we must not trust a client-supplied customer id).
    const p = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?user_id=eq.${encodeURIComponent(user.id)}&select=stripe_customer_id`,
      { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
    );
    const rows = p.ok ? await p.json() : [];
    const customer = rows[0]?.stripe_customer_id;
    if (!customer) return json({ error: 'No subscription found for this account' }, 404);

    const origin = new URL(request.url).origin;
    const s = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customer, return_url: `${origin}/` }),
    });
    const session = await s.json();
    if (!s.ok) return json({ error: session.error?.message || 'Stripe error' }, 502);
    return json({ url: session.url });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
