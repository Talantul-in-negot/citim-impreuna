const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const fn = source.match(/function readingDayNumber\([^]*?\n}/);
assert(fn);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fn[0], sandbox);
const day = (date) => Date.parse(`${date}T00:00:00Z`) / 86400000;
const cases = [
  ['2026-10-24T02:59:59+03:00', '2026-10-23'],
  ['2026-10-24T03:00:00+03:00', '2026-10-24'],
  ['2026-12-01T00:00:00+02:00', '2026-11-30'],
  ['2026-12-01T02:59:59+02:00', '2026-11-30'],
  ['2026-12-01T03:00:00+02:00', '2026-12-01'],
  ['2027-01-01T02:59:59+02:00', '2026-12-31'],
  // Ora de vară sare de la 02:59:59 la 04:00 în România.
  ['2026-03-29T00:59:59Z', '2026-03-28'],
  ['2026-03-29T01:00:00Z', '2026-03-29'],
  // La revenirea la ora de iarnă, ambele apariții ale orei 03 aparțin zilei noi.
  ['2026-10-24T23:59:59Z', '2026-10-24'],
  ['2026-10-25T00:00:00Z', '2026-10-25'],
  ['2026-10-25T01:00:00Z', '2026-10-25'],
];
for (const [timestamp, expected] of cases) {
  assert.equal(sandbox.readingDayNumber(timestamp), day(expected), timestamp);
}
const sql = fs.readFileSync(path.join(root, 'supabase/20261024_01_streak_day_starts_at_03.sql'), 'utf8');
assert.equal((sql.match(/\(\(e\.recorded_at at time zone 'Europe\/Bucharest'\) - interval '3 hours'\)::date/g) || []).length, 2,
  'SQL must group and select by the same local 03:00 boundary');
console.log(`Reading day: ${cases.length} timezone and 03:00 boundary cases passed.`);
