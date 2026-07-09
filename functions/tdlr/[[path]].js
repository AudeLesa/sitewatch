// Cloudflare Pages Function — reverse proxy for TDLR TABS at /tdlr/*
//
// Why this exists: since ~2026-07-08 TDLR's WAF (Cloudflare bot-fight) drops
// connections from datacenter/Azure IP ranges — exactly where GitHub Actions
// runs — so the nightly pull fails with "fetch failed". It does NOT block
// Cloudflare's own egress (verified: 200 in ~145ms from the edge). Routing the
// pull through this function launders it via Cloudflare, so CI can self-refresh
// again. Set TABS_BASE_URL=https://<site>/tdlr/TABS on the pull to use it.
//
// Gated by a shared secret (TABS_PROXY_KEY) so it isn't an open TDLR proxy.
// Zero dependencies (plain fetch), per project convention.

const ORIGIN = 'https://www.tdlr.texas.gov';

export async function onRequest({ request, env, params }) {
  // Auth: only our pipeline (which sends the matching X-Proxy-Key) may use it.
  // Unset key = disabled (fail closed) so a misconfigured deploy can't proxy.
  if (!env.TABS_PROXY_KEY || request.headers.get('x-proxy-key') !== env.TABS_PROXY_KEY) {
    return new Response('forbidden', { status: 403 });
  }

  const inUrl = new URL(request.url);
  const path = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');
  const target = `${ORIGIN}/${path}${inUrl.search}`;

  // Forward the request headers, but present same-origin Origin/Referer to
  // TDLR regardless of the proxy hostname, and drop hop/identity headers.
  const headers = new Headers(request.headers);
  for (const h of ['x-proxy-key', 'host', 'cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'cf-ray', 'cf-visitor']) headers.delete(h);
  headers.set('Origin', ORIGIN);
  const ref = headers.get('referer');
  if (ref) headers.set('referer', ref.replace(inUrl.origin, ORIGIN));

  const method = request.method;
  const resp = await fetch(target, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
  });

  // Pass the response through. Set-Cookie MUST be preserved as separate headers
  // (the session cookie the pull captures from /search) — iterating Headers
  // comma-folds them, which breaks cookie parsing, so re-append via getSetCookie.
  const out = new Headers();
  for (const [k, v] of resp.headers) {
    if (k.toLowerCase() === 'set-cookie') continue;
    out.set(k, v);
  }
  for (const c of resp.headers.getSetCookie?.() || []) out.append('set-cookie', c);

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: out });
}
