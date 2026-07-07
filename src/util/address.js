// Address helpers for building dedupe keys and geocoder queries.

const STREET_ABBR = {
  street: 'st', str: 'st',
  avenue: 'ave', av: 'ave',
  boulevard: 'blvd',
  drive: 'dr',
  road: 'rd',
  lane: 'ln',
  court: 'ct',
  place: 'pl',
  parkway: 'pkwy',
  highway: 'hwy',
  freeway: 'fwy',
  suite: 'ste',
  north: 'n', south: 's', east: 'e', west: 'w',
};

/**
 * Aggressively normalize an address string so the *same* physical address from
 * two different feeds collapses to one key: lowercase, collapse whitespace,
 * strip punctuation, canonicalize common street-type words.
 */
export function normalizeAddress(input) {
  if (!input) return '';
  let s = String(input).toLowerCase();
  s = s.replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s
    .split(' ')
    .map((w) => STREET_ABBR[w] ?? w)
    .join(' ');
  return s;
}

/** Compose a single-line address suitable for the Census geocoder. */
export function oneLine(address) {
  if (!address) return '';
  if (address.full) return address.full;
  return [address.line1, address.city, address.state, address.zip].filter(Boolean).join(', ');
}
