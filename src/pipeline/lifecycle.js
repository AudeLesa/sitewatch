import { STATUS } from '../schema.js';

// ---------------------------------------------------------------------------
// Lifecycle-aware confidence: P(actively under construction NOW).
//
// The 2026-07 audit found the original mapping semantically inverted: TABS
// inspections are accessibility (RAS) inspections that happen AT or AFTER
// construction completion (Tex. Gov't Code §469.105 — within a year *after*),
// yet "Inspection Completed" was scored 0.9 "actively building". Measured
// result: half the map was finished buildings shown as the hottest sites.
//
// New model: confidence = stage prior (set by the source, see tdlrTabs
// STATUS_MAP) × a timeline factor from the declared start/end dates:
//
//   before estStartDate      → ×0.4 (far) / ×0.6 (within 60d)   "upcoming"
//   within [start, end]      → ×1.15 (capped at 0.95)           "building"
//   past estEndDate + grace  → ×exp(-monthsPast/6), floor 0.05  "overdue"
//
// estEndDate is a contractor estimate and overruns are routine, so nothing is
// dropped for being past-due alone — it just decays. The one hard drop is the
// 'finished' stage (Inspection Completed) once the declared end has passed:
// that combination means the building is done, and keeping it contradicts the
// product's core promise.
// ---------------------------------------------------------------------------

const DAY = 864e5;
const GRACE_DAYS = 60; // don't start decaying the moment an estimate slips

export function applyLifecycle(records, now = new Date()) {
  const kept = [];
  let finished = 0;
  for (const r of records) {
    const stage = r.lifecycleStage;
    const past = r.estEndDate ? (now - new Date(r.estEndDate)) / DAY : null;

    if (stage === 'finished' && (past == null || past > 0)) {
      // Accessibility inspection passed and the declared end date has come and
      // gone (or was never set) — this is a completed building, not a site.
      r.status = STATUS.FINALIZED;
      r.finalizedDate = r.finalizedDate || r.estEndDate || null;
      finished++;
      kept.push(r); // the filter drops terminal statuses and tallies the reason
      continue;
    }

    r.confidence = timelineAdjusted(r.confidence, r.estStartDate, past, now);
    // Registrants fat-finger valuations; flag the implausible ones so rankings
    // ("largest projects", top-owner tallies) can skip them. TABS's legal floor
    // is $50k, and nothing in Texas legitimately exceeds a few $B.
    r.valuationSuspect = r.valuation != null && (r.valuation < 50000 || r.valuation > 5e9);
    kept.push(r);
  }
  return { records: kept, finished };
}

function timelineAdjusted(prior, estStartDate, daysPastEnd, now) {
  if (prior == null) return prior;
  let conf = prior;

  if (estStartDate) {
    const untilStart = (new Date(estStartDate) - now) / DAY;
    if (untilStart > 60) conf *= 0.4; // registered, but shovels are months out
    else if (untilStart > 0) conf *= 0.6; // starting soon
    else if (daysPastEnd == null || daysPastEnd <= GRACE_DAYS) conf *= 1.15; // inside the declared window
  }
  if (daysPastEnd != null && daysPastEnd > GRACE_DAYS) {
    const monthsPast = (daysPastEnd - GRACE_DAYS) / 30;
    conf *= Math.exp(-monthsPast / 6);
  }

  return Math.max(0.05, Math.min(0.95, Math.round(conf * 100) / 100));
}
