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
      // Only a settled checkout grants Pro — an async payment method can
      // complete the session while the charge later fails (that path arrives
      // as checkout.session.async_payment_failed, which we treat as no-op and
      // the subscription.deleted event cleans up).
      if (obj.payment_status !== 'paid' && obj.payment_status !== 'no_payment_required') {
        return new Response('ok (unpaid session ignored)');
      }
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
// The header may carry SEVERAL v1 signatures (Stripe sends one per active
// signing secret during rotation) — accept if ANY of them verifies.
async function verify(payload, header, secret) {
  if (!secret || !header) return false;
  let t = null;
  const v1s = [];
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=');
    if (i < 0) continue;
    const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1s.push(v);
  }
  if (!t || !v1s.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // replay guard
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return v1s.some((v1) => constantTimeEqual(hex, v1));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
    method: 'PATCH', headers: sbHeaders(env, { Prefer: 'return=representation' }), body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`profiles patch ${r.status}: ${await r.text()}`);
  // A 204/empty result means no profile carries this customer id (e.g. the
  // checkout event never landed). Fail loudly so Stripe retries and the miss
  // is visible in its dashboard instead of a subscription change silently
  // never reaching the database.
  const rows = await r.json().catch(() => []);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`profiles patch matched 0 rows for customer ${customer}`);
  }
}
