// Trei curse din client, rulate pe codul real din js/app.js și sw.js:
//  1) streakul unui cont nu se refolosește pentru alt cont (nici cu același nume afișat);
//  2) la înregistrare, categoria se salvează sub categorySaving, ca sincronizarea pornită
//     de evenimentul de autentificare să nu deschidă fereastra de categorie;
//  3) service worker-ul servește offline un script/stil dintr-o versiune ?v= anterioară.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '../sw.js'), 'utf8');
const pick = (source, pattern, label) => {
  const match = source.match(pattern);
  assert.ok(match, `${label} not found`);
  return match[0];
};
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const stubElement = () => new Proxy({}, { get: (target, key) => target[key] ??= { hidden: true, value: '', textContent: '', focus() {}, setAttribute() {} } });

async function checkStreak() {
  let owner = 'owner-a';
  const fetches = [];
  const context = {
    userName: 'Sergiu', // același nume afișat pentru ambele conturi
    el: stubElement(),
    renderReadingStreak() {},
    calculateReadingStreak: (events) => ({ days: events }),
    Auth: { getUserId: () => owner },
    Tracker: { enabled: true, fetchOwnReadingData: () => { const d = deferred(); fetches.push(d); return d.promise; } },
  };
  vm.createContext(context);
  vm.runInContext(`let readingStreakDays = null; let readingStreakStatus = null;
    ${pick(app, /let streakFetchPromise = null;\r?\nlet streakFetchOwner = null;/, 'streak state')}
    ${pick(app, /async function refreshReadingStreak\([^]*?\n}/, 'refreshReadingStreak')}`, context);

  const first = vm.runInContext('refreshReadingStreak()', context);
  await tick();
  vm.runInContext('refreshReadingStreak()', context); // același cont: refolosește cererea
  await tick();
  assert.equal(fetches.length, 1, 'The same account must reuse its in-flight request');

  owner = 'owner-b'; // cont nou, același nume
  const second = vm.runInContext('refreshReadingStreak()', context);
  await tick();
  assert.equal(fetches.length, 2, "Another account must not receive the previous account's request");

  fetches[1].resolve({ events: 3, baselineAt: null });
  await second;
  fetches[0].resolve({ events: 9, baselineAt: null }); // răspunsul întârziat al contului A
  await first;
  assert.equal(vm.runInContext('readingStreakDays', context), 3, "A late answer of the previous account must be ignored");
}

async function checkRegister() {
  const log = [];
  let categorySavingAtSave = null;
  let categorySavingAtSync = null;
  let failSave = false;
  const context = {
    el: stubElement(), userName: '', categorySaving: false,
    ReadingPath: { getCategory: () => ({}) },
    Auth: { signUp: async () => 'Nume', getUserId: () => 'owner' },
    Tracker: { saveCategory: async () => { categorySavingAtSave = context.categorySaving; if (failSave) throw new Error('offline'); return {}; } },
    guardAgainstAccountSwitch() {}, applyReadingProfile() {}, hideAuthModal() {}, updateUserChip() {}, showWelcomeMessage() {},
    setAuthError() {}, hasReadingCategory: () => true,
    openCategoryModal: () => log.push('openCategoryModal'),
    syncSessionFromCloud: async () => { categorySavingAtSync = context.categorySaving; },
  };
  context.el.loginUsername.value = 'nume';
  context.el.loginPassword.value = 'parola1';
  context.el.registerCategory.value = 'grades_2_3';
  vm.createContext(context);
  vm.runInContext(pick(app, /async function handleRegister\(\)[^]*?\n}/, 'handleRegister'), context);

  await vm.runInContext('handleRegister()', context);
  assert.equal(categorySavingAtSave, true, 'The category must be saved while categorySaving is set');
  assert.equal(categorySavingAtSync, false, 'The own sync must run after categorySaving is released (it returns early otherwise)');

  failSave = true;
  context.el.loginPassword.value = 'parola1'; // handleRegister golește câmpul după succes
  await vm.runInContext('handleRegister()', context);
  assert.equal(context.categorySaving, false, 'A failed save must still release categorySaving');
  assert.ok(log.includes('openCategoryModal'), 'A failed save still lets the user retry the category');
}

async function checkServiceWorker() {
  const handlers = {};
  const cached = new Map([['https://app.test/js/app.js?v=72', 'OLD_APP'], ['https://app.test/css/style.css?v=55', 'CSS'], ['https://app.test/js/auth.js?v=50', 'AUTH_EXACT']]);
  const normalize = (url, ignoreSearch) => (ignoreSearch ? url.split('?')[0] : url);
  const context = {
    URL,
    self: { location: { origin: 'https://app.test' }, addEventListener: (type, fn) => { handlers[type] = fn; }, skipWaiting() {}, clients: { claim() {} }, registration: {} },
    caches: {
      match: async (request, options = {}) => {
        const wanted = normalize(request.url, options.ignoreSearch);
        for (const [url, body] of cached) if (normalize(url, options.ignoreSearch) === wanted) return body;
        return undefined;
      },
      open: async () => ({ put() {} }), keys: async () => [], delete: async () => true,
    },
    fetch: () => Promise.reject(new Error('offline')),
    clients: { matchAll: async () => [] }, indexedDB: {}, Promise,
  };
  vm.createContext(context);
  vm.runInContext(sw, context);
  const serve = async (url) => {
    let answer;
    handlers.fetch({ request: { method: 'GET', url }, respondWith: (promise) => { answer = promise; } });
    return answer;
  };
  assert.equal(await serve('https://app.test/js/auth.js?v=50'), 'AUTH_EXACT', 'An exact cache hit wins');
  assert.equal(await serve('https://app.test/js/app.js?v=73'), 'OLD_APP', 'A newer ?v= script falls back to the cached version offline');
  assert.equal(await serve('https://app.test/css/style.css?v=56'), 'CSS', 'Same for stylesheets');
  assert.equal(await serve('https://app.test/media/bible-book.jpg?v=3'), undefined, 'Other files keep the exact-match rule');
}

(async () => {
  await checkStreak();
  await checkRegister();
  await checkServiceWorker();
  console.log('Client races: streak bound to the account, register saves the category under categorySaving, service worker falls back to an older ?v= script offline.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
