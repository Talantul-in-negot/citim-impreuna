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

// Aceeași lungime a streakului poate include sau nu ziua curentă.
vm.runInContext(source.match(/function calculateReadingStreak\([^]*?\n}/)[0], sandbox);
vm.runInContext(source.match(/function renderReadingStreak\([^]*?\n}/)[0], sandbox);
const now = Date.parse('2026-11-10T12:00:00+02:00');
sandbox.Date = class extends Date { static now() { return now; } };
const event = (date, verse = '1') => ({
  correct: true, chapter_ref: '1 Samuel 1', chapter_size: 2,
  verse_ref: verse, recorded_at: `${date}T12:00:00+02:00`,
});
const previousWeek = Array.from({ length: 7 }, (_, i) => {
  const date = `2026-11-${String(i + 3).padStart(2, '0')}`;
  return [event(date), event(date, '2')];
}).flat();
function element() {
  const classes = new Set();
  return {
    textContent: '', attributes: {},
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      contains: name => classes.has(name),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  };
}
sandbox.el = { streakStars: element(), streakCaption: element(), streakToday: element() };
sandbox.el.streakStars.children = Array.from({ length: 7 }, element);
for (const [events, days, earned, position] of [
  [[], 0, false, 0],
  [previousWeek, 7, false, 0],
  [[...previousWeek, event('2026-11-10'), event('2026-11-10')], 7, false, 0],
  [[...previousWeek, event('2026-11-10'), event('2026-11-10', '2')], 8, true, 0],
  [[...previousWeek.slice(2), event('2026-11-10'), event('2026-11-10', '2')], 7, true, 6],
]) {
  const status = sandbox.calculateReadingStreak(events, null);
  assert.equal(status.days, days);
  assert.equal(status.todayCompleted, earned);
  sandbox.readingStreakStatus = status;
  sandbox.readingStreakDays = status.days;
  sandbox.renderReadingStreak();
  const stars = sandbox.el.streakStars.children;
  assert.equal(stars.filter(s => s.classList.contains('is-today')).length, 1);
  assert.equal(stars[position].classList.contains('is-today'), true);
  assert.equal(stars[position].classList.contains('is-pending'), !earned);
  assert.equal(stars[position].classList.contains('is-lit'), earned);
  assert.match(sandbox.el.streakToday.textContent, earned ? /câștigată/ : /completează un capitol/);
}
console.log('Streak today: pending, duplicate verses, earned, and seven-day rollover passed.');
