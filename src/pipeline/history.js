import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { projectRoot } from '../util/env.js';

// ---------------------------------------------------------------------------
// Project history & "new starts" detection.
//
// Each refresh is a snapshot; this stage persists the last-known state of every
// project (data/history.json) and diffs the current run against it to detect:
//   • firstSeenAt    — when we first tracked this project
//   • statusChangedAt — when its status/confidence last moved
//   • startedAt       — when it crossed into *construction* (confidence ≥ 0.8,
//                       i.e. inspections began). Only set when we actually OBSERVE
//                       the transition — we never claim a start we didn't witness.
//   • justStarted     — startedAt within the last `justStartedDays`
//
// "confidence ≥ 0.8" maps to the inspection stages of the TABS lifecycle (see
// tdlrTabs STATUS_MAP), so this works for any source that sets a lifecycle
// confidence. The store survives across runs (and CI, via the workflow cache).
// ---------------------------------------------------------------------------

const HISTORY_PATH = join(projectRoot, config.output.dir, 'history.json');
const START_CONFIDENCE = 0.8;

export function applyHistory(records, now = new Date()) {
  const hist = load();
  const today = now.toISOString().slice(0, 10);
  const justDays = config.justStartedDays;
  let added = 0, started = 0, changed = 0;

  for (const r of records) {
    const key = r.permitNumber || r.id;
    if (!key) continue;
    const conf = r.confidence ?? 0;
    const prev = hist[key];

    let firstSeenAt, statusChangedAt, startedAt, prevStatus = null;
    if (!prev) {
      firstSeenAt = today;
      statusChangedAt = today;
      startedAt = null; // newly tracked — we didn't witness when it started
      added++;
    } else {
      firstSeenAt = prev.firstSeenAt || today;
      const moved = (prev.confidence ?? 0) !== conf || prev.status !== r.status;
      statusChangedAt = moved ? today : prev.statusChangedAt || firstSeenAt;
      if (moved) { changed++; prevStatus = prev.statusLabel || null; }
      const wasBuilding = (prev.confidence ?? 0) >= START_CONFIDENCE;
      const isBuilding = conf >= START_CONFIDENCE;
      if (!wasBuilding && isBuilding) { startedAt = today; started++; } // a genuine new start
      else startedAt = prev.startedAt || null;
    }
    const justStarted = !!startedAt && daysBetween(startedAt, today) <= justDays;

    r.firstSeenAt = firstSeenAt;
    r.statusChangedAt = statusChangedAt;
    r.startedAt = startedAt;
    r.justStarted = justStarted;
    r.prevStatus = prevStatus;

    hist[key] = { firstSeenAt, lastSeenAt: today, status: r.status, confidence: conf, statusLabel: statusLabelOf(r), statusChangedAt, startedAt };
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
  try { return JSON.parse(readFileSync(HISTORY_PATH, 'utf8')); } catch { return {}; }
}
function save(hist) {
  mkdirSync(dirname(HISTORY_PATH), { recursive: true });
  writeFileSync(HISTORY_PATH, JSON.stringify(hist));
}
