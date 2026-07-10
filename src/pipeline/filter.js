import { config } from '../config.js';
import { CATEGORY, WORK_CLASS, TERMINAL_STATUSES } from '../schema.js';

/**
 * First calendar day INSIDE the lookback window (cutoff day + 1, date-only).
 * Source adapters filter server-side with `issuedDate >= '<this>'` and the
 * pipeline filter drops anything before it — same string semantics on both
 * sides, so portal-parity gates reconcile exactly instead of off-by-one on
 * the boundary day (whose rows carry times the old `> cutoff-date` kept).
 */
export function lookbackFloorIso(now = new Date()) {
  const c = new Date(now);
  c.setMonth(c.getMonth() - config.lookbackMonths);
  c.setDate(c.getDate() + 1);
  // Render in the SAME (local) frame as the arithmetic above — a toISOString()
  // render flips the floor a whole day at some local evening hour on non-UTC
  // machines (pull and gate could disagree). Identical to UTC on the CI runner.
  const p = (n) => String(n).padStart(2, '0');
  return `${c.getFullYear()}-${p(c.getMonth() + 1)}-${p(c.getDate())}`;
}

/**
 * "Currently under commercial construction" heuristic.
 *
 * No public permit feed exposes a literal "being built right now" flag, so we
 * approximate: a commercial new-construction permit, issued within the lookback
 * window, that hasn't reached a terminal status (finalized / expired / pulled).
 * Each rejected record is tagged with a reason for debugging.
 */
export function isUnderConstruction(rec, now = new Date()) {
  const cats = new Set(config.commercialCategories);
  if (config.includeMultifamily) cats.add(CATEGORY.MULTIFAMILY);
  if (!cats.has(rec.category)) return reject('not_commercial');

  const builds = new Set(config.buildWorkClasses);
  if (config.requireBuildClass) {
    // Precision mode: only keep positively-identified new construction.
    if (!builds.has(rec.workClass)) return reject('not_new_build');
  } else {
    // Lenient mode: allow unknown through; drop explicit non-build classes.
    if (rec.workClass !== WORK_CLASS.UNKNOWN && !builds.has(rec.workClass)) return reject('not_new_build');
  }

  if (TERMINAL_STATUSES.has(rec.status)) return reject('terminal_status');
  if (rec.finalizedDate) return reject('finalized');

  if (rec.issuedDate && String(rec.issuedDate).slice(0, 10) < lookbackFloorIso(now)) {
    return reject('too_old');
  }

  return { ok: true };
}

function reject(reason) {
  return { ok: false, reason };
}

/** Partition records into kept / rejected (with reason tallies). */
export function applyFilter(records, now = new Date()) {
  const kept = [];
  const reasons = {};
  for (const rec of records) {
    const verdict = isUnderConstruction(rec, now);
    if (verdict.ok) kept.push(rec);
    else reasons[verdict.reason] = (reasons[verdict.reason] || 0) + 1;
  }
  return { kept, reasons };
}
