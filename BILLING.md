# Billing — the Stripe Pro tier

**Model:** the map (all sites + contacts) is free forever. **Pro** unlocks
saved-search **email alerts** — the automation people pay for.

Implemented as **Cloudflare Pages Functions** (deploy with the site, zero deps):

| Route | File | Does |
|---|---|---|
| `POST /api/create-checkout` | [functions/api/create-checkout.js](functions/api/create-checkout.js) | Verifies the user's Supabase session, opens a Stripe Checkout subscription, returns the URL. |
| `POST /api/stripe-webhook` | [functions/api/stripe-webhook.js](functions/api/stripe-webhook.js) | Verifies the Stripe signature, flips `profiles.is_pro` in Supabase. |

Enforcement is in the database: [backend/billing.sql](backend/billing.sql) makes the
`saved_searches` **INSERT** policy require `profiles.is_pro`, so even a crafted
request can't create an alert without an active subscription. The frontend mirrors it
(free users get an "Upgrade to Pro" sheet instead of the save dialog).

## One-time setup

1. **Supabase:** after `schema.sql`, run [backend/billing.sql](backend/billing.sql)
   (owns the saved_searches write policies; gates alert creation AND edits to Pro).
   Re-apply it after any schema.sql re-run.
2. **Stripe → Product + Price:** create a Product with a recurring **Price**. The
   $29/mo placeholder is deliberately low — comparable construction-lead products
   (Dodge, ConstructConnect, Shovels at $599/mo) anchor 10–20× higher; consider a
   founding-member price nearer $79–149/mo and validate against real customers.
   Copy the **Price ID** (`price_…`).
3. **Cloudflare Pages → Settings → Environment variables** (Production), add:
   ```
   STRIPE_SECRET_KEY      sk_live_…   (or sk_test_… while testing)
   STRIPE_PRICE_ID        price_…
   STRIPE_WEBHOOK_SECRET  whsec_…     (from step 4)
   SUPABASE_URL           https://xxxx.supabase.co
   SUPABASE_ANON_KEY      eyJ…        (public)
   SUPABASE_SERVICE_KEY   eyJ…        (secret — webhook/portal/unsubscribe use it)
   ```
4. **Stripe → Developers → Webhooks → Add endpoint:**
   `https://<your-site>/api/stripe-webhook`, listening for
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Copy its **Signing secret** → `STRIPE_WEBHOOK_SECRET`.
5. **Stripe → Settings → Billing → Customer portal:** enable it (the site's
   "Billing" link opens it via `/api/create-portal` so subscribers can cancel
   self-serve).
6. **Deploy:** `npm run deploy` — wrangler bundles `functions/` from the repo root
   (they are deliberately NOT copied into `dist/`, which would expose their source
   as static files). After deploying, verify `POST /api/create-checkout` returns
   401/405 — anything but 404 means the functions are routing.

## Test it (Stripe test mode)

Use `sk_test_…` keys, sign in on the live site, click **Upgrade to Pro**, and pay with
card `4242 4242 4242 4242` (any future expiry/CVC). On success you land back on
`/?upgraded=1`, the webhook sets `is_pro`, and the "🔔 Alert me about this search"
button starts saving alerts. Verify in Supabase that the user's `profiles.is_pro` is
`true`.

## Notes
- The webhook checks the Stripe signature with a 5-minute replay window (Web Crypto
  HMAC) — unsigned/forged calls are rejected, so Pro can't be granted by spoofing.
- Cancellations flow through `customer.subscription.deleted/updated` → `is_pro=false`,
  and the DB policy immediately stops new alert creation (existing alerts remain).
- Frontend gating + DB RLS are belt-and-suspenders: the UI is the UX, RLS is the lock.
