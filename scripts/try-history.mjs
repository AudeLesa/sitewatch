// Prove the history stage: construction starts are detected from the declared
// estStartDate arriving (registration precedes construction in TABS), never
// from the finishing/finished stages, and status changes are still diffed.
//   node scripts/try-history.mjs
// History stores are per-region now, so the test runs against its own
// throwaway region ('history-test') and never touches the real baselines.
import { rmSync } from 'node:fs';
import { applyHistory } from '../src/pipeline/history.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../src/schema.js';

const TEST_STORE = 'data/history-history-test.json';
rmSync(TEST_STORE, { force: true }); // stale store from an aborted run would fail run 1

const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const mk = (permit, { stage, label, estStart }) =>
  makeRecord({
    source: 'test', permitNumber: permit, category: CATEGORY.COMMERCIAL, workClass: WORK_CLASS.NEW_CONSTRUCTION,
    status: STATUS.ISSUED, confidence: 0.6, lifecycleStage: stage, estStartDate: estStart,
    description: `New construction — X (${label})`,
  });

let ok = false;
try {
  // Run 1: declared start is in the future -> tracked, but NOT started.
  const r1 = [mk('T-1', { stage: 'pre', label: 'Project Registered', estStart: day(+10) })];
  const s1 = applyHistory(r1, { regionId: 'history-test' });
  console.log('run 1 (start in future): ', JSON.stringify({ started: s1.started, startedAt: r1[0].startedAt, justStarted: r1[0].justStarted }));

  // Run 2: the declared start has arrived (5 days ago) -> started + justStarted,
  // and the review->building label move registers as a status change.
  const r2 = [mk('T-1', { stage: 'building', label: 'Review Complete', estStart: day(-5) })];
  const s2 = applyHistory(r2, { regionId: 'history-test' });
  console.log('run 2 (start arrived):   ', JSON.stringify({ started: s2.started, changed: s2.changed, startedAt: r2[0].startedAt, justStarted: r2[0].justStarted, prevStatus: r2[0].prevStatus }));

  // A finished-stage project whose start long passed must NOT read as a start —
  // that would advertise a completed building as breaking ground.
  const r3 = [mk('T-2', { stage: 'finished', label: 'Inspection Completed', estStart: day(-400) })];
  const s3 = applyHistory(r3, { regionId: 'history-test' });
  console.log('finished-stage project:  ', JSON.stringify({ started: s3.started, startedAt: r3[0].startedAt, justStarted: r3[0].justStarted }));

  ok =
    s1.started === 0 && r1[0].startedAt === null &&
    s2.started === 1 && r2[0].startedAt === day(-5) && r2[0].justStarted === true && r2[0].prevStatus === 'Project Registered' &&
    s3.started === 0 && r3[0].startedAt === null;
  console.log(ok ? '\nPASS — starts come from the declared start date arriving, never from inspection stages.' : '\nFAIL');
} finally {
  rmSync(TEST_STORE, { force: true }); // the test region's store is throwaway
}
process.exit(ok ? 0 : 1);
