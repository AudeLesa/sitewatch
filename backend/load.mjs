// Load a pipeline run into the Supabase `projects` table.
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node backend/load.mjs [city]
//
// Upserts every record from data/<city>.json (default texas) keyed on `id`.
// We deliberately DON'T send `first_seen`, so Postgres keeps the original value on
// updates and only sets it (default now()) on genuinely new rows — that's what the
// alert worker watches. `last_seen` is bumped every run. Zero dependencies: this
// talks to Supabase's PostgREST endpoint over plain fetch.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const city = process.argv[2] || 'texas';
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
const BATCH = 500;

if (!URL || !KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY (service-role key) in the environment.');
  process.exit(1);
}

const file = join(process.cwd(), 'data', `${city}.json`);
let records;
try {
  records = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}. Run a pull first (npm run pull:texas).`);
  process.exit(1);
}

const rows = records.map(toRow);
console.error(`Loading ${rows.length} ${city} projects into Supabase…`);

let done = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const res = await fetch(`${URL}/rest/v1/projects?on_conflict=id`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(batch),
  });
  if (!res.ok) {
    console.error(`\nBatch @${i} failed: HTTP ${res.status}\n${await res.text()}`);
    process.exit(1);
  }
  done += batch.length;
  process.stderr.write(`\r  upserted ${done}/${rows.length}`);
}
console.error(`\n✔ Loaded ${done} projects into ${URL}/rest/v1/projects`);

// Map a normalized pipeline record -> a `projects` table row (snake_case columns).
function toRow(r) {
  const a = r.address || {};
  return {
    id: r.id,
    permit_number: r.permitNumber ?? null,
    category: r.category ?? null,
    work_class: r.workClass ?? null,
    status: r.status ?? null,
    confidence: r.confidence ?? null,
    description: r.description ?? null,
    facility_name: r.facilityName ?? null,
    valuation: r.valuation ?? null,
    square_feet: r.squareFeet ?? null,
    issued_date: r.issuedDate ?? null,
    est_start_date: r.estStartDate ?? null,
    est_end_date: r.estEndDate ?? null,
    started_at: r.startedAt ?? null,
    status_changed_at: r.statusChangedAt ?? null,
    address: a.full ?? a.line1 ?? null,
    city: a.city ?? null,
    county: a.county ?? (r.raw?.County != null ? String(r.raw.County) : null),
    zip: a.zip ?? null,
    lat: r.location?.lat ?? null,
    lng: r.location?.lng ?? null,
    owner: r.owner ?? null,
    owner_phone: r.ownerPhone ?? null,
    owner_address: r.ownerAddress ?? null,
    architect: r.designFirm ?? null,
    architect_phone: r.designFirmPhone ?? null,
    tenant: r.tenantName ?? null,
    tenant_phone: r.tenantPhone ?? null,
    ras_name: r.rasName ?? null,
    ras_phone: r.rasPhone ?? null,
    contact_name: r.contactName ?? null,
    scope_of_work: r.scopeOfWork ?? null,
    public_funds: r.publicFunds ?? null,
    contractor: r.contractor ?? null,
    source: (r.contributingSources || [r.source]).filter(Boolean).join(','),
    last_seen: new Date().toISOString(),
    // first_seen intentionally omitted — preserved on update, defaulted on insert.
  };
}
