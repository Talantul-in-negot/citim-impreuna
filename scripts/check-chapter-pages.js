const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildChapterPages } = require('../js/pagination');
const { buildRows, loadVerses } = require('./build-answer-key');
const root = path.join(__dirname, '..');
const verses = loadVerses();
const pages = buildChapterPages(verses);
const chapterOf = (ref) => ref.replace(/:\d+$/, '');
assert.equal(pages.length, 324);
assert.deepEqual(pages.flat(), verses, 'Every verse must remain in order, exactly once');
for (let i = 0; i < pages.length; i++) {
  assert(pages[i].length >= 1 && pages[i].length <= 5);
  assert.equal(new Set(pages[i].map(v => chapterOf(v.ref))).size, 1);
  if (i && chapterOf(pages[i][0].ref) === chapterOf(pages[i - 1][0].ref)) {
    assert.equal(pages[i - 1].length, 5, 'Only the final page of a chapter may be short');
  }
}
assert.equal(pages[5].length, 3);
assert.equal(pages[6][0].ref, '1 Samuel 2:1');
const rows = buildRows(verses);
const pageByRef = new Map(pages.flatMap((p, i) => p.map(v => [v.ref, i])));
for (const row of rows) {
  assert.equal(row.page_index, pageByRef.get(row.verse_ref));
  assert.equal(row.page_size, pages[row.page_index].length);
}

// Offline progress originally stored numeric global-page indices.
const storage = new Map([
  ['ci_page_mistakes', JSON.stringify({ '1:5': true })],
  ['ci_pending_events', '[{"verse_ref":"1 Samuel 2:1"}]'],
]);
const context = {
  VERSES: verses, PAGES: pages, PAGE_SIZE: 5, REF_PAGE: pageByRef,
  STORAGE_PAGE_LAYOUT: 'ci_page_layout', PAGE_LAYOUT_VERSION: 'chapters-v1',
  STORAGE_PAGE_MISTAKES: 'ci_page_mistakes',
  cycle: 1, page: 6, solvedThisCycle: new Set([0, 1, 2, 3, 4, 5]), correctThisCycle: new Set(),
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  save: () => {}, saveSolvedThisCycle: () => {},
};
const source = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
const fn = source.match(/function migrateLocalPagination\([^]*?\n}/);
assert(fn);
vm.createContext(context);
vm.runInContext(fn[0], context);
context.migrateLocalPagination();
assert.equal(context.page, 6);
assert.equal(context.solvedThisCycle.size, 6);
assert(context.solvedThisCycle.has(5), 'Short chapter ending remains solved');
assert(!context.solvedThisCycle.has(6), 'Two old answers do not finish the next chapter page');
assert(context.correctThisCycle.has('1 Samuel 2:1'), 'Previously correct verses in partial pages remain locked');
assert(context.correctThisCycle.has('1 Samuel 2:2'));
assert.deepEqual(JSON.parse(storage.get('ci_page_mistakes')), { '1:5': true, '1:6': true });
assert.equal(storage.get('ci_pending_events'), '[{"verse_ref":"1 Samuel 2:1"}]');
context.migrateLocalPagination();
assert.equal(context.page, 6, 'Local migration must be idempotent');

// Partial/short pages and gaps are reconstructed from references, not indices.
Object.assign(context, { totalPages: pages.length });
for (const name of ['firstUnsolvedPage', 'resumePageFromEvents', 'computeSolvedPagesForCycle', 'pageHadMistakeBeforeCompletion']) {
  vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0], context);
}
const events = verses.slice(0, 28).map(v => ({ verse_ref: v.ref, cycle: 1, correct: true }));
assert.equal(context.resumePageFromEvents(events, 1), 6);
assert(context.computeSolvedPagesForCycle(events, 1).has(5));
assert.equal(context.pageHadMistakeBeforeCompletion(events, 5, 1), false);
console.log('Chapter pages: 324 pages; shared server mapping, short pages and offline migration verified.');
