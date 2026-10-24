const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const verses = Array.from({ length: 12 }, (_, i) => ({ ref: `Verse ${i}` }));
const context = {
  VERSES: verses, PAGE_SIZE: 5, totalPages: 3,
  REF_PAGE: new Map(verses.map((v, i) => [v.ref, Math.floor(i / 5)])),
  cycle: 1, page: 2, solvedThisCycle: new Set([0, 2]),
  saves: 0, renders: 0,
};
context.save = () => context.saves++;
context.renderPage = () => context.renders++;
vm.createContext(context);
for (const name of ['firstUnsolvedPage', 'resumePageFromEvents', 'computeSolvedPagesForCycle', 'showFinal']) {
  const fn = source.match(new RegExp(`function ${name}\\([^]*?\\n}`));
  assert(fn, `Missing ${name}`);
  vm.runInContext(fn[0], context);
}
const answered = (indices, cycle = 1, correct = true) => indices.map(i => ({
  verse_ref: verses[i].ref, cycle, correct,
}));
assert.equal(context.resumePageFromEvents([], 1), -1);
assert.equal(context.resumePageFromEvents(answered([0], 0), 1), -1);
assert.equal(context.resumePageFromEvents(answered([10, 11]), 1), 0);
assert.equal(context.resumePageFromEvents(answered([0, 1, 2, 3, 4, 10, 11]), 1), 1,
  'A solved last page must not hide an earlier gap');
assert.equal(context.resumePageFromEvents(answered([0, 1, 2, 3]), 1), 0);
assert.equal(context.resumePageFromEvents(answered([0, 1, 2, 3, 4]), 1), 1);
assert.equal(context.resumePageFromEvents(answered([0, 0, 0, 0, 0]), 1), 0);
assert.equal(context.resumePageFromEvents(answered([0, 1, 2, 3, 4], 1, false), 1), 0);
assert.equal(context.resumePageFromEvents(answered(verses.map((_, i) => i)), 1), 2);
context.showFinal();
assert.equal(context.cycle, 1, 'Incomplete cycles must not advance');
assert.equal(context.page, 1);
assert.equal(context.solvedThisCycle.size, 2, 'Existing progress must be preserved');
assert.equal(context.saves, 1);
assert.equal(context.renders, 1);
async function checkCloudReconciliation() {
  Object.assign(context, {
    userName: 'Sergiu', progressSynced: false, cycle: 2, page: 0,
    Tracker: {
      enabled: true, flush: async () => {}, hasPendingEvents: () => false,
      fetchUserEvents: async () => answered([0, 1, 2, 3, 4, 10, 11]),
      fetchOwnCycle: async () => 1,
    },
    refreshAndSyncScore: async () => {}, refreshReadingStreak: async () => {}, saveSolvedThisCycle: () => {},
    pageHadMistakeBeforeCompletion: () => false,
    setPageMistake: () => {}, clearPageMistake: () => {},
  });
  const fn = source.match(/async function syncProgressFromCloud\([^]*?\n}/);
  assert(fn);
  vm.runInContext(fn[0], context);
  await context.syncProgressFromCloud();
  assert.equal(context.cycle, 1, 'Server cycle repairs a premature local restart');
  assert.equal(context.page, 1, 'Reconciliation must resume at the missing page');
  assert.equal(context.progressSynced, true);

  context.progressSynced = false;
  context.cycle = 2;
  await context.syncProgressFromCloud();
  assert.equal(context.page, 1, 'Correcting the cycle must preserve an already selected missing page');

  context.progressSynced = false;
  context.cycle = 2;
  context.page = 0;
  context.Tracker.hasPendingEvents = () => true;
  await context.syncProgressFromCloud();
  assert.equal(context.progressSynced, false, 'Pending uploads must be retried');
  assert.equal(context.cycle, 2, 'Pending offline progress must be preserved');
  assert.equal(context.page, 0);

  context.Tracker.hasPendingEvents = () => false;
  context.Tracker.fetchUserEvents = async () => [];
  context.Tracker.fetchOwnCycle = async () => 3;
  await context.syncProgressFromCloud();
  assert.equal(context.cycle, 3, 'A new cloud cycle starts even without events');
  assert.equal(context.page, 0);
  console.log('Progress resume: gaps, premature completion, server cycles and pending uploads checked.');
}
checkCloudReconciliation().catch((error) => { console.error(error); process.exitCode = 1; });
