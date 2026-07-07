// Prove the history stage detects a project crossing into construction.
//   node scripts/try-history.mjs
// Uses a throwaway history.json so it doesn't touch a real one.
import { rmSync } from 'node:fs';
import { applyHistory } from '../src/pipeline/history.js';
import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../src/schema.js';

rmSync('data/history.json', { force: true }); // clean slate

const mk = (conf, label) =>
  makeRecord({
    source: 'test', permitNumber: 'T-1', category: CATEGORY.COMMERCIAL, workClass: WORK_CLASS.NEW_CONSTRUCTION,
    status: conf >= 0.8 ? STATUS.ACTIVE : STATUS.ISSUED, confidence: conf, description: `New construction — X (${label})`,
  });

const r1 = [mk(0.3, 'Project Registered')];
const s1 = applyHistory(r1);
console.log('run 1 (registered):', JSON.stringify({ started: s1.started, startedAt: r1[0].startedAt, justStarted: r1[0].justStarted, firstSeenAt: r1[0].firstSeenAt }));

const r2 = [mk(0.85, 'Inspection Process')];
const s2 = applyHistory(r2);
console.log('run 2 (inspecting):', JSON.stringify({ started: s2.started, changed: s2.changed, startedAt: r2[0].startedAt, justStarted: r2[0].justStarted, prevStatus: r2[0].prevStatus, firstSeenAt: r2[0].firstSeenAt }));

const ok = s1.started === 0 && r1[0].startedAt === null && s2.started === 1 && r2[0].justStarted === true && r2[0].prevStatus === 'Project Registered';
console.log(ok ? '\nPASS — start detected on the transition, not on first sight.' : '\nFAIL');

rmSync('data/history.json', { force: true }); // cleanup so real pulls start fresh
process.exit(ok ? 0 : 1);
