# SiteWatch backend — saved searches + email alerts

The paid feature: a user saves a search ("new warehouses > $5M within 50 mi of
Houston") and gets emailed when a matching project appears. Built on **Supabase**
(Postgres + Auth + the PostgREST API) so there's almost no server code — the
database *is* the API.

## Pieces

| File | What it is |
|---|---|
| [`schema.sql`](schema.sql) | Tables (`projects`, `saved_searches`, `alerts_sent`), the `projects_matching()` / `pending_alerts()` functions, and row-level security. |
| [`load.mjs`](load.mjs) | Upserts a pipeline run (`data/texas.json`) into `projects`. Preserves `first_seen` (the alert trigger). `npm run load` |
| [`alert-worker.mjs`](alert-worker.mjs) | Emails each user a digest of new matches via Resend, records them so they're never repeated. `npm run alerts` |

**There is no custom API.** The frontend talks to Supabase directly with the user's
login; RLS guarantees a user only ever sees/edits their *own* saved searches, while
`projects` stays public-read. Create/list/delete saved searches = plain Supabase
client calls. "Preview matches" = call the `projects_matching` RPC.

## Data flow

```
pull:texas ─► data/texas.json ─► load.mjs ─► projects table
                                                 │ (first_seen set on new rows)
                                                 ▼
                          alert-worker.mjs ◄─ pending_alerts()  ─►  Resend ─► 📧 user
                                                 │
                                                 ▼  records in alerts_sent (no repeats)
```

## One-time setup (when you're ready to go live)

1. **Create a Supabase project** (free) → supabase.com. Note the project URL, the
   **anon** key (public, for the frontend) and the **service-role** key (secret).
2. **Apply the schema:** Supabase dashboard → SQL editor → paste `schema.sql` → run.
   (Enables PostGIS, creates everything.)
3. **Create a Resend account** (free) → resend.com → verify a sending domain → get an
   API key.
4. **Load data + send alerts** (locally or in the refresh workflow), with secrets in
   the environment (never in git):
   ```bash
   export SUPABASE_URL=…  SUPABASE_SERVICE_KEY=…  RESEND_API_KEY=…  ALERT_FROM="SiteWatch <alerts@yourdomain>"
   npm run load     # push the latest projects into Postgres
   npm run alerts   # email new matches
   ```
   In CI, add these as repo secrets and append `load` + `alerts` to
   `.github/workflows/refresh.yml` after the build step.
5. **Frontend:** open `web/index.html`, find the `window.SITEWATCH` block near the
   bottom, and paste your Supabase URL + **anon** (public) key:
   ```js
   window.SITEWATCH = { supabaseUrl: 'https://xxxx.supabase.co', supabaseAnonKey: 'eyJ…' };
   ```
   Then `npm run build` + deploy. The "Sign in for alerts" / "🔔 Alert me about this
   search" UI activates automatically; with the keys blank, the public map runs
   exactly as before (the alert UI stays hidden).

## Notes
- `load.mjs` / `alert-worker.mjs` are **zero-dependency** (plain `fetch` against
  PostgREST + Resend), matching the rest of the repo.
- Alerts are idempotent: `alerts_sent` is the source of truth, so re-running the
  worker never double-sends.
- `filters` JSON mirrors the map's sidebar controls
  (`categories`, `workClasses`, `minValue`, `minConfidence`, `q`, `center`,
  `radiusMi`), so "save this exact view as an alert" is a direct mapping.
