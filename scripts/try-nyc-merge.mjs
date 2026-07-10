// Golden-file unit test for the NYC dual-feed BIN merge (src/sources/nycDob.js).
// Run: node scripts/try-nyc-merge.mjs — exits non-zero on any deviation.
import { mergeByBin } from '../src/sources/nycDob.js';

const rec = (over) => ({
  permitNumber: 'NYCN-X', contractor: null, owner: null, squareFeet: null,
  valuation: null, contributingSources: ['nyc_dob'], raw: { bin: null }, ...over,
});

let fail = 0;
const t = (name, cond) => { console.log(`${cond ? '  ✔' : '  ✘'} ${name}`); if (!cond) fail++; };

// 1. Same BIN in both feeds: BIS twin folds into the DOB NOW record.
{
  const dob = rec({ permitNumber: 'NYCN-Q0001', owner: 'ACME DEV', raw: { bin: '4000001' } });
  const bis = rec({ permitNumber: 'NYCB-140000001', contractor: 'BUILDCO', valuation: 5e6, raw: { bin: '4000001' } });
  const { merged, dropped } = mergeByBin([dob], [bis]);
  t('twin folded: one record survives', merged.length === 1 && dropped === 1);
  t('DOB NOW record wins the identity', merged[0].permitNumber === 'NYCN-Q0001');
  t('missing fields donated (contractor)', merged[0].contractor === 'BUILDCO');
  t('missing fields donated (valuation)', merged[0].valuation === 5e6);
  t('present fields NOT overwritten (owner)', merged[0].owner === 'ACME DEV');
}

// 2. Distinct BINs pass through untouched.
{
  const dob = rec({ permitNumber: 'NYCN-B0002', raw: { bin: '3000001' } });
  const bis = rec({ permitNumber: 'NYCB-320000001', raw: { bin: '3999999' } });
  const { merged, dropped } = mergeByBin([dob], [bis]);
  t('distinct BINs: both survive', merged.length === 2 && dropped === 0);
}

// 3. Null/missing BINs never merge (no accidental null-key collisions).
{
  const dob = rec({ permitNumber: 'NYCN-M0003', raw: { bin: null } });
  const bis = rec({ permitNumber: 'NYCB-100000003', raw: { bin: null } });
  const { merged, dropped } = mergeByBin([dob], [bis]);
  t('null BINs never collide', merged.length === 2 && dropped === 0);
}

// 4. Two BIS jobs on one DOB NOW BIN: both fold (renewal sequences of one job).
{
  const dob = rec({ permitNumber: 'NYCN-Q0004', raw: { bin: '4000004' } });
  const bis1 = rec({ permitNumber: 'NYCB-440000004', contractor: 'GC ONE', raw: { bin: '4000004' } });
  const bis2 = rec({ permitNumber: 'NYCB-440000005', contractor: 'GC TWO', raw: { bin: '4000004' } });
  const { merged, dropped } = mergeByBin([dob], [bis1, bis2]);
  t('multiple BIS twins all fold', merged.length === 1 && dropped === 2);
  t('first donor wins on conflicts', merged[0].contractor === 'GC ONE');
}

// 5. BIS-only building (legacy tower not in DOB NOW) survives as itself.
{
  const bis = rec({ permitNumber: 'NYCB-120000006', contractor: 'LEGACY GC', raw: { bin: '1000006' } });
  const { merged } = mergeByBin([], [bis]);
  t('BIS-only record passes through', merged.length === 1 && merged[0].permitNumber === 'NYCB-120000006');
}

console.log(fail === 0 ? 'PASS — BIN merge behaves per contract.' : `FAIL (${fail})`);
process.exitCode = fail === 0 ? 0 : 1;
