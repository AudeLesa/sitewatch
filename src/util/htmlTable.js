// Minimal dependency-free HTML <table> -> array-of-objects parser.
// WebFOCUS report output is plain HTML tables, so this turns a report page into
// rows keyed by their column headers. Tolerant of the messy markup these old
// reporting engines emit.

export function parseTables(html) {
  const tables = [];
  for (const m of html.matchAll(/<table[\s\S]*?<\/table>/gi)) {
    const rows = parseRows(m[0]);
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/** Parse a single table's markup into rows of {header: cellText}. */
export function parseRows(tableHtml) {
  const rawRows = [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) =>
    [...r[0].matchAll(/<t[hd][\s\S]*?<\/t[hd]>/gi)].map((c) => clean(c[0]))
  );
  if (rawRows.length < 2) return [];

  // First row with the most non-empty cells is treated as the header.
  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(rawRows.length, 3); i++) {
    const filled = rawRows[i].filter(Boolean).length;
    if (filled > best) {
      best = filled;
      headerIdx = i;
    }
  }
  const headers = rawRows[headerIdx].map((h, i) => h || `col${i}`);

  const out = [];
  for (let i = headerIdx + 1; i < rawRows.length; i++) {
    const cells = rawRows[i];
    if (!cells.some(Boolean)) continue;
    const obj = {};
    headers.forEach((h, idx) => (obj[h] = cells[idx] ?? null));
    out.push(obj);
  }
  return out;
}

function clean(cellHtml) {
  return cellHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
