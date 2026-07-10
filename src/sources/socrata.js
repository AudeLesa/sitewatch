import { fetchJson } from '../util/http.js';

// ---------------------------------------------------------------------------
// Shared Socrata (SODA 2.1) plumbing. Many city open-data portals — Seattle,
// NYC, Chicago, SF — are Socrata under the hood, differing only in domain,
// dataset id, and field names. This module owns the transport (SoQL paging,
// retries via fetchJson, stable ordering); each city gets a thin source module
// that supplies the query and maps rows into normalized records.
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000; // SODA allows up to 50k/page unauthenticated, but big pages time out more

/**
 * Fetch every row of a dataset matching a SoQL query. Pages by $offset until a
 * short page arrives or `max` rows are collected. A page that fails all of
 * fetchJson's retries throws — a silent gap would read as a record-count
 * collapse downstream and trip the publish guard anyway, so fail loudly here.
 */
export async function fetchDataset({ domain, datasetId, where, select, order, max = 50000, log = console.error, tag = 'socrata' }) {
  const rows = [];
  const base = `https://${domain}/resource/${datasetId}.json`;
  for (let offset = 0; offset < max; offset += PAGE_SIZE) {
    const params = new URLSearchParams({ $limit: String(PAGE_SIZE), $offset: String(offset) });
    if (select) params.set('$select', select);
    if (where) params.set('$where', where);
    if (order) params.set('$order', order); // stable order — unordered paging can skip/dup rows between pages
    const page = await fetchJson(`${base}?${params}`, { headers: { Accept: 'application/json' } });
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  log(`[${tag}] ${rows.length} rows from ${domain}/${datasetId}`);
  return rows;
}

/** One aggregate query (e.g. select 'status,count(*)' grouped by 'status'). */
export async function fetchAggregate({ domain, datasetId, select, where, group }) {
  const params = new URLSearchParams({ $select: select, $group: group });
  if (where) params.set('$where', where);
  return fetchJson(`https://${domain}/resource/${datasetId}.json?${params}`, { headers: { Accept: 'application/json' } });
}
