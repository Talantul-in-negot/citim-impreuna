const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ReadingPath = require('../js/reading-path');
const { loadVerses } = require('./build-answer-key');
const { loadEpistles } = require('./build-epistle-answer-key');
const { buildChapterPages } = require('../js/pagination');
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const common = loadVerses();
const epistles = loadEpistles();
for (const category of ReadingPath.categories) {
  const pages = buildChapterPages(ReadingPath.buildVerses(category.id, common, epistles));
  const elements = [];
  const element = () => ({style:{}, events:{}, children:[],
    appendChild(child) { this.children.push(child); },
    addEventListener(name, handler) { this.events[name] = handler; },
  });
  const context = {
    PAGES:pages, totalPages:pages.length, page:323, cycle:4, score:1234,
    categorySaving:false, hasReadingCategory:() => true,
    solvedThisCycle:new Set(Array.from({length:324}, (_, i) => i)),
    correctThisCycle:new Set(common.map(verse => verse.ref)), creditedThisCycle:new Set(),
    save:() => {}, saveSolvedThisCycle:() => {},
    renderPage:() => { context.renderedRef = pages[context.page][0].ref; },
    document:{createElement:() => { const node=element(); elements.push(node); return node; }},
    el:{progress:{},cheer:{},checkBtn:{},nextBtn:{},container:element()},
  };
  vm.createContext(context);
  for (const name of ['firstUnsolvedPage', 'nextUnsolvedPageAfter', 'nextPage', 'showFinal']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0], context);
  }
  assert.equal(pages[323].at(-1).ref, '2 Samuel 24:25');
  context.nextPage();
  assert.equal(context.page, 324);
  assert.equal(context.renderedRef, epistles[category.epistle][0].ref);
  assert.equal(context.cycle, 4, 'Samuel completion must not reset the client cycle');
  context.page = pages.length - 1;
  context.nextPage();
  assert.equal(context.cycle, 4, 'An unanswered epistle page cannot finish the cycle');
  context.solvedThisCycle = new Set(pages.map((_, i) => i));
  context.nextPage();
  assert.equal(context.cycle, 5);
  assert.equal(context.page, 0);
  assert.equal(context.solvedThisCycle.size, 0);
  const restart = elements.find(node => node.textContent === 'Reia de la început');
  assert(restart, 'Show the normal restart button after the epistle');
  restart.events.click();
  assert.equal(context.renderedRef, '1 Samuel 1:1');
  console.log(`Browser logic verified: ${category.label}, ${pages.length} pages, ${epistles[category.epistle][0].ref} -> restart.`);
}
