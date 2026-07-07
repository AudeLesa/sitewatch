// Cloudflare Pages Function — POST /api/stripe-webhook
// Receives Stripe subscription events, verifies the signature, and flips the user's
// Pro status in Supabase (service-role key, bypasses RLS). Zero dependencies — the
// signature is checked with Web Crypto. Env vars:
//   STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
export async function onRequestPost({ request, env }) {
  const payload = await request.text();
  const sig = request.headers.get('Stripe-Signature') || '';
  if (!(await verify(payload, sig, env.STRIPE_WEBHOOK_SECRET))) {
    return new Response('Bad signature', { status: 400 });
  }

  let event;
  try { event = JSON.parse(payload); } catch { return new Response('Bad payload', { status: 400 }); }
  const obj = event.data?.object || {};

  try {
    if (event.type === 'checkout.session.completed') {
      await upsertProfile(env, {
        user_id: obj.client_reference_id,
        stripe_customer_id: obj.customer,
        is_pro: true,
        status: 'active',
        updated_at: new Date().toISOString(),
      });
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const active = event.type !== 'customer.subscription.deleted' &&
        ['active', 'trialing', 'past_due'].includes(obj.status);
      await patchByCustomer(env, obj.customer, {
        is_pro: active,
        status: obj.status,
        current_period_end: obj.current_period_end ? new Date(obj.current_period_end * 1000).toISOString() : null,
        updated_at: new Date().toISOString(),
      });
    }
    return new Response('ok');
  } catch (err) {
    return new Response('Handler error: ' + err, { status: 500 });
  }
}

// --- Stripe signature (t=…,v1=…) via HMAC-SHA256, with a 5-minute tolerance -----
async function verify(payload, header, secret) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false; // replay guard
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${parts.t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // constant-time compare
  if (hex.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

// --- Supabase writes (service-role key) ----------------------------------------
function sbHeaders(env, extra = {}) {
  return { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...extra };
}
async function upsertProfile(env, row) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?on_conflict=user_id`, {
    method: 'POST', headers: sbHeaders(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`profiles upsert ${r.status}: ${await r.text()}`);
}
async function patchByCustomer(env, customer, patch) {
  if (!customer) return;
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?stripe_customer_id=eq.${encodeURIComponent(customer)}`, {
    method: 'PATCH', headers: sbHeaders(env, { Prefer: 'return=minimal' }), body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`profiles patch ${r.status}: ${await r.text()}`);
}
