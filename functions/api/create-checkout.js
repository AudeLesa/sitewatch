// Cloudflare Pages Function — POST /api/create-checkout
// Creates a Stripe Checkout Session for the signed-in user's Pro subscription and
// returns its URL. The frontend redirects the browser there. Zero dependencies
// (Stripe REST over fetch). Env vars (Pages → Settings → Environment variables):
//   STRIPE_SECRET_KEY, STRIPE_PRICE_ID, SUPABASE_URL, SUPABASE_ANON_KEY
export async function onRequestPost({ request, env }) {
  try {
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'Not signed in' }, 401);

    // Validate the Supabase session and get the user (id + email).
    const u = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!u.ok) return json({ error: 'Invalid session' }, 401);
    const user = await u.json();

    const origin = new URL(request.url).origin;
    const body = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price]': env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      success_url: `${origin}/?upgraded=1`,
      cancel_url: `${origin}/?canceled=1`,
      client_reference_id: user.id, // maps the subscription back to this user
      customer_email: user.email,
      allow_promotion_codes: 'true',
    });
    const s = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
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
