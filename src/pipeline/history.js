import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { config, SOURCE_PERMIT_PREFIXES } from '../config.js';
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

const DONE_STAGES = new Set(['finishing', 'finished', 'closed']);
// The pre-region store was one shared data/history.json; texas reads it once
// as a seed so first-seen/started baselines survive the per-region split.
const LEGACY_PATH = join(projectRoot, config.output.dir, 'history.json');
const PERMIT_PREFIXES = Object.values(SOURCE_PERMIT_PREFIXES).flat(); // multi-feed sources declare arrays

export function applyHistory(records, { regionId, now = new Date() } = {}) {
  const region = regionId || config.city;
  const path = historyPath(region);
  const hist = load(path, region);
  const today = now.toISOString().slice(0, 10);
  const justDays = config.justStartedDays;
  let added = 0, started = 0, changed = 0;

  for (const r of records) {
    const key = keyOf(r);
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

  save(path, hist);
  return { tracked: Object.keys(hist).length, added, started, changed };
}

// History keys must be collision-safe across regions and sources: a prefixed
// permit number (e.g. TABS…) is globally unique by contract; anything else
// falls back to the source-scoped sha1 record id.
function keyOf(r) {
  if (r.permitNumber && PERMIT_PREFIXES.some((p) => r.permitNumber.startsWith(p))) return r.permitNumber;
  return r.id || null;
}

function statusLabelOf(r) {
  const m = /\(([^)]+)\)\s*$/.exec(r.description || '');
  return m ? m[1] : r.status || null;
}
function daysBetween(a, b) {
  return Math.abs(Date.parse(b) - Date.parse(a)) / 86400000;
}
function historyPath(regionId) {
  return join(projectRoot, config.output.dir, `history-${regionId}.json`);
}
function load(path, regionId) {
  // One-time migration: texas seeds from the legacy shared file if the
  // per-region store doesn't exist yet. Other regions start fresh — the legacy
  // file's keys are Texas's (plus a few old demo runs we're happy to shed).
  // Loud on purpose: after the first run this branch only fires if the live
  // store was LOST (cache eviction, fresh clone without the git seed) — that
  // rolls first-seen/started baselines back to the frozen legacy snapshot.
  if (regionId === 'texas' && !existsSync(path) && existsSync(LEGACY_PATH)) {
    console.error(`[history] ⚠ ${path} missing — seeding from legacy history.json (expected once; afterwards this means the live store was lost).`);
    return loadStateFile(LEGACY_PATH);
  }
  return loadStateFile(path);
}
function save(path, hist) {
  writeFileAtomic(path, JSON.stringify(hist));
}
