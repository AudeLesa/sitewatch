// Cloudflare Pages Function — POST /api/ask
// "Ask the map": Claude translates a plain-English question ("tilt-wall
// warehouses near me over $5M", "what is Tesla building in Austin") into the
// map's filter model. The client applies the returned filters locally — no
// data leaves the browser except the question text.
//
// Zero dependencies by project convention (like the Stripe/Supabase functions,
// this calls the REST API with plain fetch). Uses structured outputs so the
// response is guaranteed to parse against the filter schema.
// Env vars: ANTHROPIC_API_KEY (Pages → Settings → Environment variables).
// Without it the endpoint answers 503 and the client falls back to keyword search.

const MODEL = 'claude-sonnet-5';

const SYSTEM = `You translate questions about a Texas commercial-construction map into its filter model. The map shows ~14k projects from TDLR TABS permit registrations, each with: category, work class, declared value (USD), a 0-1 confidence that construction is active now, registration date, scope-of-work free text, owner (the developer/company building it), architect/design firm, tenant, and address.

Rules:
- categories: only commercial | industrial | institutional | multifamily. Warehouses/factories/data centers → industrial. Schools/hospitals/churches/government → institutional. Retail/office/restaurants/hotels → commercial. Apartments → multifamily. Leave null when the question doesn't imply one.
- workClasses: new_construction | addition | remodel. Leave null unless clearly implied ("build-outs"/"renovations" → remodel).
- keywords: lowercase search terms matched (ALL of them, substring) against scope-of-work text, project/facility names, and addresses. Use them for materials, trades, and building types: "tilt wall" → ["tilt"] (catches tilt-up/tiltwall), "metal building" → ["metal"], "car wash" → ["car wash"]. Prefer 1-2 short distinctive terms; never generic words like "construction" or "project". Null when none.
- companies: owner/architect/tenant names mentioned ("what is Tesla building" → ["tesla"]). Lowercase. Null when none.
- City/metro names go in keywords — addresses contain the city ("in San Antonio" → add "san antonio" to keywords). Never set nearMe for a named city.
- minValue: dollars ("over $5M" → 5000000). Null when unstated.
- minConfidence: 0-1. Set ~0.6 only when the user stresses ACTIVE/currently-under-construction sites; otherwise null.
- sinceDays: when the user asks for recent/new registrations ("this month" → 30). Null otherwise.
- startedOnly: true only for "just broke ground"/"just started construction".
- nearMe: true when the user references their own location ("near me", "nearby", "around here"); radiusMi from the question ("within 20 miles" → 20) or null for the default.
- Contractors/GCs are NOT in this data — if asked about contractors, use the term as a company keyword and say in the explanation that general-contractor names aren't in public Texas data (owners and architects are).
- explanation: one short friendly sentence stating the filters you chose.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['categories', 'workClasses', 'keywords', 'companies', 'minValue', 'minConfidence', 'sinceDays', 'startedOnly', 'nearMe', 'radiusMi', 'explanation'],
  properties: {
    categories: { type: ['array', 'null'], items: { type: 'string', enum: ['commercial', 'industrial', 'institutional', 'multifamily'] } },
    workClasses: { type: ['array', 'null'], items: { type: 'string', enum: ['new_construction', 'addition', 'remodel'] } },
    keywords: { type: ['array', 'null'], items: { type: 'string' } },
    companies: { type: ['array', 'null'], items: { type: 'string' } },
    minValue: { type: ['integer', 'null'] },
    minConfidence: { type: ['number', 'null'] },
    sinceDays: { type: ['integer', 'null'] },
    startedOnly: { type: 'boolean' },
    nearMe: { type: 'boolean' },
    radiusMi: { type: ['integer', 'null'] },
    explanation: { type: 'string' },
  },
};

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'AI search is not configured yet' }, 503);

  const body = await request.json().catch(() => null);
  const question = typeof body?.question === 'string' ? body.question.trim().slice(0, 300) : '';
  if (!question) return json({ error: 'Ask a question about construction projects' }, 400);

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      // trim: a secret set via a piped shell can pick up a trailing newline
      'x-api-key': String(env.ANTHROPIC_API_KEY).trim(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      // Sonnet 5 runs adaptive thinking when `thinking` is omitted — explicitly
      // off here: filter translation needs speed, not deliberation.
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: question }],
    }),
  });

  const out = await r.json().catch(() => null);
  if (!r.ok) return json({ error: out?.error?.message || 'AI temporarily unavailable' }, 502);
  if (out.stop_reason === 'refusal') return json({ error: 'Try rephrasing that question' }, 422);

  const text = (out.content || []).find((b) => b.type === 'text')?.text;
  try {
    return json(JSON.parse(text));
  } catch {
    return json({ error: 'AI returned an unreadable answer — try again' }, 502);
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
