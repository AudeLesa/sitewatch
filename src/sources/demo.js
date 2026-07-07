import { makeRecord, CATEGORY, WORK_CLASS, STATUS } from '../schema.js';

// Real Houston commercial addresses used to exercise the pipeline end-to-end
// without a Shovels key or a finalized Houston scrape. The geocoder hits these
// against the live Census service, so the resulting GeoJSON has real points.
const today = new Date();
const monthsAgo = (n) => {
  const d = new Date(today);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
};

const SAMPLES = [
  { addr: '1500 McKinney St', zip: '77010', desc: 'New commercial high-rise', val: 240000000, m: 3 },
  { addr: '800 Bell St', zip: '77002', desc: 'New construction office tower', val: 175000000, m: 8 },
  { addr: '5000 Westheimer Rd', zip: '77056', desc: 'New commercial mixed-use shell', val: 96000000, m: 5 },
  { addr: '2800 Post Oak Blvd', zip: '77056', desc: 'New commercial retail building', val: 42000000, m: 14 },
  { addr: '1000 Louisiana St', zip: '77002', desc: 'New office core & shell', val: 310000000, m: 2 },
  { addr: '1801 Main St', zip: '77002', desc: 'Commercial remodel — interior only', val: 1200000, m: 4, work: WORK_CLASS.REMODEL },
  { addr: '6100 Main St', zip: '77005', desc: 'New institutional research building', val: 88000000, m: 7, cat: CATEGORY.INSTITUTIONAL },
];

export const id = 'demo';

export async function fetchPermits({ log = console.error } = {}) {
  log(`[demo] emitting ${SAMPLES.length} sample Houston permits (real addresses, fake permit data).`);
  return SAMPLES.map((s, i) =>
    makeRecord({
      source: id,
      sourceId: `demo-${i + 1}`,
      permitNumber: `DEMO-${1000 + i}`,
      category: s.cat || CATEGORY.COMMERCIAL,
      workClass: s.work || WORK_CLASS.NEW_CONSTRUCTION,
      status: STATUS.ISSUED,
      description: s.desc,
      valuation: s.val,
      issuedDate: monthsAgo(s.m),
      address: { line1: s.addr, city: 'Houston', state: 'TX', zip: s.zip },
    })
  );
}
