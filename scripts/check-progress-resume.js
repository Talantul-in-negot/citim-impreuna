const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
// Paginile 0–1 sunt Samuel (comune tuturor categoriilor), pagina 2 e epistola
// categoriei: acolo contează doar răspunsurile din revizia activă a epistolei.
const verses = Array.from({ length: 12 }, (_, i) => ({ ref: i < 10 ? `Samuel ${i}` : `Epistle ${i}` }));
const context = {
  VERSES: verses, PAGE_SIZE: 5, totalPages: 3,
  PAGES: [verses.slice(0, 5), verses.slice(5, 10), verses.slice(10)],
  REF_PAGE: new Map(verses.map((v, i) => [v.ref, Math.floor(i / 5)])),
  cycle: 1, page: 2, solvedThisCycle: new Set([0, 2]),
  saves: 0, renders: 0, notices: [],
  readingEpistleRevision: 1, creditedThisCycle: new Set(), correctThisCycle: new Set(),
  ReadingPath: { isSamuelRef: (ref) => ref.startsWith('Samuel') },
  Auth: { getUserId: () => 'user-1' },
  hasReadingCategory: () => true, categorySaving: false,
};
context.showSyncNotice = (text) => context.notices.push(text);
context.save = () => context.saves++;
context.renderPage = () => context.renders++;
vm.createContext(context);
for (const name of ['isCurrentPathEvent', 'firstUnsolvedPage', 'resumePageFromEvents', 'computeSolvedPagesForCycle', 'showFinal']) {
  const fn = source.match(new RegExp(`function ${name}\\([^]*?\\n}`));
  assert(fn, `Missing ${name}`);
  vm.runInContext(fn[0], context);
}
const answered = (indices, cycle = 1, correct = true, epistle_revision = 1) => indices.map(i => ({
  verse_ref: verses[i].ref, cycle, correct, epistle_revision,
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
// Epistola dintr-o revizie veche (categorie schimbată) nu mai contează ca rezolvată,
// dar Samuel rămâne valabil indiferent de revizie.
const oldRevision = [...answered([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 1, true, 0), ...answered([10, 11], 1, true, 0)];
assert.equal(context.resumePageFromEvents(oldRevision, 1), 2, 'Old epistle revision must not count as solved');
assert.equal(context.computeSolvedPagesForCycle(oldRevision, 1).has(1), true, 'Samuel ignores the epistle revision');
assert.equal(context.computeSolvedPagesForCycle(oldRevision, 1).has(2), false);
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
      enabled: true, flush: async () => {}, hasPendingEvents: () => false, takeUnseenRejections: () => 0,
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
  context.progressSynced = false;
  context.Tracker.takeUnseenRejections = () => 2;
  await context.syncProgressFromCloud();
  assert.equal(context.notices.length, 1, 'Rejected stale answers must be reported visibly');
  assert.equal(context.progressSynced, true, 'Rejected answers must not block reconciliation');
  context.Tracker.takeUnseenRejections = () => 0;

  context.progressSynced = false;
  context.Tracker.fetchUserEvents = async () => [];
  context.Tracker.fetchOwnCycle = async () => 3;
  await context.syncProgressFromCloud();
  assert.equal(context.cycle, 3, 'A new cloud cycle starts even without events');
  assert.equal(context.page, 0);
  console.log('Progress resume: gaps, premature completion, server cycles and pending uploads checked.');
}
checkCloudReconciliation().catch((error) => { console.error(error); process.exitCode = 1; });
