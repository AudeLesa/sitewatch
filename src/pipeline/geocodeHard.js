import { fetchJson } from '../util/http.js';

// ---------------------------------------------------------------------------
// Hard-case resolver: the addresses normal geocoders can't place.
//
// Backed by TxGIO's statewide StratMap ADDRESS POINTS service (free ArcGIS
// REST, no key) — the 911-addressing dataset counties publish, which gains
// brand-new subdivisions long before Census TIGER or OSM do. (The statewide
// parcel service was probed too, but its REST endpoint has query disabled;
// per-county CAD services remain a future tier.)
//
// Three strategies, in order:
//   1. exact     — house number + street (+ county) matches a point → 'address'
//   2. nearest   — the street exists but not the number (typical for permits on
//                  land being platted): snap to the closest house number on the
//                  same street → 'street'
//   3. crossing  — "A & B" intersection addresses: fetch both streets' points,
//                  take the midpoint of the closest pair when they approach
//                  within ~500 m → 'street'
// ---------------------------------------------------------------------------

const AP_QUERY =
  'https://feature.geographic.texas.gov/arcgis/rest/services/Address_Points/stratmap_address_points_48_most_recent/MapServer/0/query';

const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'NORTH', 'SOUTH', 'EAST', 'WEST', 'NB', 'SB', 'EB', 'WB']);
const STREET_TYPES = new Set([
  'ST', 'STREET', 'RD', 'ROAD', 'DR', 'DRIVE', 'LN', 'LANE', 'AVE', 'AVENUE', 'BLVD', 'BOULEVARD', 'PKWY', 'PARKWAY',
  'CT', 'COURT', 'CIR', 'CIRCLE', 'WAY', 'TRL', 'TRAIL', 'PL', 'PLACE', 'HWY', 'HIGHWAY', 'FWY', 'FREEWAY', 'EXPY',
  'PASS', 'PATH', 'RUN', 'BND', 'BEND', 'XING', 'CROSSING', 'LOOP', 'ROW', 'TER', 'TERRACE', 'SQ', 'COVE', 'CV',
]);
const ROUTE_CLASSES = /^(I|IH|US|SH|FM|RM|RR|CR|PR|HWY|LOOP|SPUR|BUS|SL|BI)$/;

/** Is this the kind of address the hard tier can plausibly place? */
export function isHardCandidate(line1) {
  const p = parseLine(line1);
  return p != null;
}

/**
 * Resolve one hard case. `address` = { line1, city, county }.
 * Returns { lat, lng, matched, precision } or null.
 */
export async function resolveHard(address) {
  const parsed = parseLine(address.line1);
  if (!parsed) return null;

  if (parsed.type === 'addr') {
    const pts = await streetPoints(parsed.street, address, 250);
    if (!pts.length) return null;
    // Prefer candidates whose street TYPE matches ours when both are known
    // ("266 Audrey LN" should not snap to "266 Audrey CT").
    const typed = parsed.suffix ? pts.filter((p) => (p.a.st_postyp || '').toUpperCase() === parsed.suffix) : pts;
    const pool = typed.length ? typed : pts;
    const exact = pool.filter((p) => Number(p.a.add_number) === parsed.num);
    if (exact.length) return hitFrom(exact[0], 'address');
    let best = null;
    for (const p of pool) {
      const d = Math.abs(Number(p.a.add_number) - parsed.num);
      if (Number.isFinite(d) && (!best || d < best.d)) best = { p, d };
    }
    // Within a plausible numbering distance of the real spot; big lots on rural
    // roads jump hundreds per parcel, so this is generous on purpose.
    if (best && best.d <= 2000) return hitFrom(best.p, 'street');
    return null;
  }

  if (parsed.type === 'intersection') {
    const [a, b] = await Promise.all([
      streetPoints(parsed.a, address, 250),
      streetPoints(parsed.b, address, 250),
    ]);
    // Both streets known to the address grid: midpoint of the closest pair.
    if (a.length && b.length) {
      let best = null;
      for (const pa of a) {
        for (const pb of b) {
          const d = metersBetween(pa, pb);
          if (!best || d < best.d) best = { pa, pb, d };
        }
      }
      if (best && best.d <= 500) {
        return {
          lat: (best.pa.lat + best.pb.lat) / 2,
          lng: (best.pa.lng + best.pb.lng) / 2,
          matched: `${parsed.a.label} & ${parsed.b.label} (closest address points ${Math.round(best.d)}m apart)`,
          precision: 'street',
        };
      }
    }
    // Highways don't live in the address grid under their route number
    // ("I-635" is addressed as "LBJ Fwy") — fetch the route's actual geometry
    // from TIGERweb and snap to its closest approach to the cross-street.
    const routeSide = parsed.a.route ? parsed.a : parsed.b.route ? parsed.b : null;
    const localPts = parsed.a.route ? b : a;
    if (routeSide && localPts.length) {
      const snap = await snapToRoute(routeSide, localPts);
      if (snap) return { ...snap, matched: `${parsed.a.label} & ${parsed.b.label} (road geometry snap)`, precision: 'street' };
    }
    return null;
  }

  return null;
}

// --- TIGERweb road-geometry snap ----------------------------------------------

const TIGER_BASE = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer';
// Primary roads (interstates), secondary (US/state/FM), local — in that order.
const TIGER_LAYERS = [2, 6, 8];

async function snapToRoute(route, localPts) {
  // Envelope around the cross-street's address points, padded ~3 km.
  const lats = localPts.map((p) => p.lat), lngs = localPts.map((p) => p.lng);
  const pad = 0.03;
  const env = `${Math.min(...lngs) - pad},${Math.min(...lats) - pad},${Math.max(...lngs) + pad},${Math.max(...lats) + pad}`;
  const word = new RegExp(`(^|[^0-9])${route.core}([^0-9]|$)`);

  for (const layer of TIGER_LAYERS) {
    const url =
      `${TIGER_BASE}/${layer}/query?where=${encodeURIComponent(`UPPER(NAME) LIKE '%${route.core}%'`)}` +
      `&geometry=${encodeURIComponent(env)}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=NAME&returnGeometry=true&outSR=4326&f=json`;
    let data;
    try {
      data = await fetchJson(url, {}, { retries: 1, timeoutMs: 20000 });
    } catch {
      continue;
    }
    const roads = (data?.features || []).filter((f) => {
      const name = String(f.attributes?.NAME || '').toUpperCase();
      return word.test(name) && (!route.routeClass || !/[A-Z]/.test(name) || routeFamilyOk(route.routeClass, name));
    });
    if (!roads.length) continue;

    // Closest approach between the route polylines and the cross-street points.
    let best = null;
    for (const f of roads) {
      for (const path of f.geometry?.paths || []) {
        for (let i = 0; i + 1 < path.length; i++) {
          for (const p of localPts) {
            const s = closestOnSegment(p, path[i], path[i + 1]);
            if (!best || s.d < best.d) best = s;
          }
        }
      }
    }
    if (best && best.d <= 400) return { lat: best.lat, lng: best.lng };
  }
  return null;
}

/** Closest point on segment [a,b] (each [lng,lat]) to point p; distance in meters. */
function closestOnSegment(p, a, b) {
  const cos = Math.cos((p.lat * Math.PI) / 180);
  const ax = a[0] * cos, ay = a[1], bx = b[0] * cos, by = b[1], px = p.lng * cos, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  const d = Math.sqrt((x - px) ** 2 + (y - py) ** 2) * 111320;
  return { d, lat: y, lng: x / cos };
}

// --- address-point queries ---------------------------------------------------

async function streetPoints(street, address, cap) {
  const clauses = [];
  if (street.route) {
    // Route number matching is done client-side (word boundary + class family);
    // the server just narrows to names containing the number.
    clauses.push(`st_name LIKE '%${street.core}%'`);
  } else {
    clauses.push(`UPPER(st_name) LIKE '${sqlEscape(street.core)}%'`);
  }
  const county = cleanCounty(address.county);
  if (county) clauses.push(`UPPER(county) = '${sqlEscape(county)}'`);
  else if (address.city) clauses.push(`UPPER(post_comm) = '${sqlEscape(address.city.toUpperCase())}'`);

  const url =
    `${AP_QUERY}?where=${encodeURIComponent(clauses.join(' AND '))}` +
    `&outFields=${encodeURIComponent('add_number,st_name,st_postyp,full_addr,post_comm,county')}` +
    `&returnGeometry=true&outSR=4326&resultRecordCount=${cap}&f=json`;
  let data;
  try {
    data = await fetchJson(url, {}, { retries: 2, timeoutMs: 20000 });
  } catch {
    return [];
  }
  let pts = (data?.features || [])
    .filter((f) => f.geometry && Number.isFinite(f.geometry.x))
    .map((f) => ({ lat: f.geometry.y, lng: f.geometry.x, a: f.attributes || {} }));
  if (street.route) {
    const num = street.core;
    const word = new RegExp(`(^|[^0-9])${num}([^0-9]|$)`);
    pts = pts.filter((p) => {
      const name = String(p.a.st_name || '').toUpperCase();
      if (!word.test(name)) return false;
      // If our route has a class (FM/US/I…), reject candidates that clearly
      // belong to a different family (FM 407 must not snap to CR 407).
      if (street.routeClass && /[A-Z]/.test(name)) return routeFamilyOk(street.routeClass, name);
      return true;
    });
  }
  return pts;
}

function routeFamilyOk(cls, candidateName) {
  const fam = {
    I: /\b(I|IH|INTERSTATE)\b/, IH: /\b(I|IH|INTERSTATE)\b/,
    US: /\b(US|U S|UNITED STATES|HIGHWAY)\b/,
    SH: /\b(SH|STATE|HWY|HIGHWAY|TX)\b/, HWY: /\b(SH|STATE|HWY|HIGHWAY|US|FM|RM)\b/,
    FM: /\b(FM|FARM)\b/, RM: /\b(RM|RANCH)\b/, RR: /\b(RR|RANCH)\b/,
    CR: /\b(CR|COUNTY)\b/, PR: /\b(PR|PARK)\b/,
    LOOP: /\bLOOP\b/, SPUR: /\bSPUR\b/, BUS: /\b(BUS|BUSINESS)\b/, SL: /\b(SL|LOOP)\b/, BI: /\b(BI|BUSINESS)\b/,
  }[cls];
  return fam ? fam.test(candidateName) : true;
}

// --- parsing ------------------------------------------------------------------

function parseLine(line1) {
  if (!line1) return null;
  let s = String(line1).toUpperCase().replace(/\./g, ' ')
    .replace(/([A-Z])(\d)/g, '$1 $2') // "FM1171" -> "FM 1171"
    .replace(/\s+/g, ' ').trim();

  // Intersections: "SWC OF A & B", "INTERSECTION OF A AND B", "A @ B", "A / B".
  // "A Rd/B Rd & C Dr" means (A-or-B) crossing C — keep the first alternative.
  const ix = s
    .replace(/^(THE )?(NORTH|SOUTH|EAST|WEST)?\s*(NWC|NEC|SWC|SEC|NW|NE|SW|SE|N W|N E|S W|S E)?\s*(QUADRANT|CORNER|Q)?\s*(OF)?\s*/i, '')
    .replace(/^INTERSECTION OF\s*/i, '')
    .replace(/\(.*?\)/g, ' ');
  const parts = ix.split(/\s*(?:&|\bAND\b|@|\bAT\b)\s*/i).filter(Boolean).map((p) => p.split('/')[0].trim()).filter(Boolean);
  if (parts.length === 2 && !/^\d+\s/.test(s)) {
    const a = streetCore(parts[0]);
    const b = streetCore(parts[1]);
    if (a && b) return { type: 'intersection', a, b };
    return null;
  }

  // Plain "number street": "266 AUDREY LN", "14174 W US 290"
  const m = /^(\d+)[A-Z]?\s+(.+)$/.exec(s);
  if (m) {
    const street = streetCore(m[2]);
    if (!street) return null;
    return { type: 'addr', num: Number(m[1]), street, suffix: street.suffix || null };
  }
  return null;
}

/** Reduce a street string to its lookup core: "N BELTLINE RD" -> BELTLINE,
 * "W US 290" / "US HWY 290" -> route 290 (class US). */
function streetCore(str) {
  let tokens = String(str).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  while (tokens.length && DIRECTIONALS.has(tokens[0])) tokens.shift();
  while (tokens.length && (DIRECTIONALS.has(tokens[tokens.length - 1]))) tokens.pop();
  if (!tokens.length) return null;

  // Route form: [class tokens]* number — e.g. US 290, FM 1488, INTERSTATE 10
  const routeIdx = tokens.findIndex((t) => /^\d+$/.test(t));
  if (routeIdx >= 0) {
    const before = tokens.slice(0, routeIdx).join(' ');
    const clsTok = tokens
      .slice(0, routeIdx)
      .map((t) => (t === 'INTERSTATE' ? 'I' : t === 'HIGHWAY' ? 'HWY' : t === 'FARM' || t === 'FM' ? 'FM' : t === 'RANCH' ? 'RM' : t))
      .find((t) => ROUTE_CLASSES.test(t));
    if (clsTok || /\b(HWY|HIGHWAY|INTERSTATE|STATE)\b/.test(before)) {
      return { core: tokens[routeIdx], route: true, routeClass: clsTok || 'HWY', label: tokens.join(' ') };
    }
  }

  let suffix = null;
  if (tokens.length > 1 && STREET_TYPES.has(tokens[tokens.length - 1])) suffix = tokens.pop();
  if (!tokens.length) return null;
  return { core: tokens.join(' '), route: false, suffix, label: [...tokens, suffix].filter(Boolean).join(' ') };
}

// --- helpers -------------------------------------------------------------------

function hitFrom(p, precision) {
  const a = p.a;
  return { lat: p.lat, lng: p.lng, matched: [a.full_addr, a.post_comm].filter(Boolean).join(', '), precision };
}

function metersBetween(a, b) {
  const dLat = (a.lat - b.lat) * 111320;
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function cleanCounty(county) {
  if (!county) return null;
  return String(county).toUpperCase().replace(/\s+COUNTY$/, '').trim() || null;
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}
