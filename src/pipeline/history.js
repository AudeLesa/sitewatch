import { join } from 'node:path';
import { config } from '../config.js';
import { projectRoot } from '../util/env.js';
import { writeFileAtomic, loadStateFile } from '../util/fsafe.js';

// ---------------------------------------------------------------------------
// Project history & "new starts" detection.
//
// Each refresh is a snapshot; this stage persists the last-known state of every
// project (data/history.json) and diffs the current run against it to detect:
//   • firstSeenAt    — when we first tracked this project
//   • statusChangedAt — when its lifecycle status last moved (label/status diff;
//                       NOT confidence, which now drifts daily by design as the
//                       lifecycle model decays past-due projects)
//   • startedAt       — when construction (most likely) began: the declared
//                       estStartDate once it arrives, while the project is still
//                       pre-inspection. TABS registration legally precedes
//                       construction and inspections follow completion, so the
//                       declared start is the best shovels-in-the-ground signal
//                       the registry offers. (The pre-2026-07 rule — confidence
//                       crossing 0.8 — mapped to the inspection stages and would
//                       have flagged buildings as "started" as they FINISHED.)
//   • justStarted     — startedAt within the last `justStartedDays`
//
// The store survives across runs (and CI, via the workflow cache).
// ---------------------------------------------------------------------------

const HISTORY_PATH = join(projectRoot, config.output.dir, 'history.json');
const DONE_STAGES = new Set(['finishing', 'finished', 'closed']);

export function applyHistory(records, now = new Date()) {
  const hist = load();
  const today = now.toISOString().slice(0, 10);
  const justDays = config.justStartedDays;
  let added = 0, started = 0, changed = 0;

  for (const r of records) {
    const key = r.permitNumber || r.id;
    if (!key) continue;
    const prev = hist[key];
    const label = statusLabelOf(r);

    let firstSeenAt, statusChangedAt, prevStatus = null;
    if (!prev) {
      firstSeenAt = today;
      statusChangedAt = today;
      added++;
    } else {
      firstSeenAt = prev.firstSeenAt || today;
      const moved = prev.status !== r.status || (prev.statusLabel || null) !== label;
      statusChangedAt = moved ? today : prev.statusChangedAt || firstSeenAt;
      if (moved) { changed++; prevStatus = prev.statusLabel || null; }
    }

    // Construction start: the declared start date has arrived and the project
    // hasn't already moved into the finishing/finished stages (whose start is
    // long past — flagging those would advertise completions as starts).
    let startedAt = prev?.startedAt || null;
    if (!startedAt && r.estStartDate && r.estStartDate <= today && !DONE_STAGES.has(r.lifecycleStage)) {
      startedAt = r.estStartDate;
      if (daysBetween(startedAt, today) <= justDays) started++; // only count fresh ones
    }
    const justStarted = !!startedAt && daysBetween(startedAt, today) <= justDays;

    r.firstSeenAt = firstSeenAt;
    r.statusChangedAt = statusChangedAt;
    r.startedAt = startedAt;
    r.justStarted = justStarted;
    r.prevStatus = prevStatus;

    hist[key] = { firstSeenAt, lastSeenAt: today, status: r.status, confidence: r.confidence ?? 0, statusLabel: label, statusChangedAt, startedAt };
  }

  save(hist);
  return { tracked: Object.keys(hist).length, added, started, changed };
}

function statusLabelOf(r) {
  const m = /\(([^)]+)\)\s*$/.exec(r.description || '');
  return m ? m[1] : r.status || null;
}
function daysBetween(a, b) {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}
function load() {
  return loadStateFile(HISTORY_PATH);
}
function save(hist) {
  writeFileAtomic(HISTORY_PATH, JSON.stringify(hist));
}
