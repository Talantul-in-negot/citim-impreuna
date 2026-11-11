// Rulează js/tracker.js real, cu serverul simulat, pe scenariile de recuperare a
// cozii offline: refuzuri definitive (evenimente învechite) trebuie să ajungă în
// carantină fără să blocheze restul cozii, iar orice eroare temporară trebuie să
// păstreze coada intactă și în ordine. Plus regula de salvare a primei categorii.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'tracker.js'), 'utf8');
const USER = 'user-1';

function load(server) {
  const storage = new Map();
  const calls = [];
  let uuid = 0;
  const context = {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    Auth: { getUserId: () => USER, getAccessToken: async () => 'token' },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: {},
    crypto: { randomUUID: () => `id-${++uuid}` },
    window: { addEventListener: () => {} },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    console,
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ url, body });
      return server(url, body);
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.Tracker = Tracker;`, context);
  return { Tracker: context.Tracker, storage, calls };
}

const response = (status, body = null) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const stale = (detail) => response(400, { code: 'P0001', message: 'refresh reading progress', details: detail });
const queueRefs = (storage) => JSON.parse(storage.get('ci_pending_events') || '[]').map((e) => e.verse_ref);
const rejected = (storage) => JSON.parse(storage.get('ci_rejected_events') || '[]');

function seed(Tracker, refs) {
  for (const verse_ref of refs) Tracker.log({ verse_ref, chosen: 'x', cycle: 0 });
}

async function main() {
  // 1) Un eveniment învechit în mijlocul lotului: lotul pică atomic, apoi
  //    câte unul — valizii intră, cel învechit merge în carantină.
  {
    const { Tracker, storage, calls } = load((url, body) => {
      if (!url.includes('/rest/v1/events')) return response(404);
      if (body.length > 1) return stale('STALE_READING_PAGE');
      return body[0].verse_ref === 'B' ? stale('STALE_READING_REVISION') : response(201);
    });
    seed(Tracker, ['A', 'B', 'C']);
    assert.equal(await Tracker.flush(), true);
    assert.deepEqual(queueRefs(storage), [], 'Valid answers after a stale one must still be sent');
    assert.deepEqual(rejected(storage).map((e) => [e.verse_ref, e._ci_rejected_reason]), [['B', 'STALE_READING_REVISION']]);
    assert.deepEqual(calls.filter((c) => c.body?.length === 1).map((c) => c.body[0].verse_ref), ['A', 'B', 'C'],
      'Per-event fallback must keep the original order');
    assert.equal(Tracker.hasPendingEvents(), false);
    assert.equal(Tracker.takeUnseenRejections(), 1);
    assert.equal(Tracker.takeUnseenRejections(), 0, 'A rejection is reported once');
    assert.equal(rejected(storage).length, 1, 'Rejected answers are kept for review, not deleted');
  }

  // 2) Erori temporare: coada rămâne intactă și nimic nu ajunge în carantină.
  for (const [label, reply] of [
    ['server down', response(503)],
    ['expired session', response(401, { message: 'JWT expired' })],
    ['rate limit', response(429)],
    ['no category yet', response(400, { code: 'P0001', message: 'Choose a reading category before continuing' })],
    ['unknown error', response(400, { code: 'XX000', message: 'boom' })],
    ['unknown verse (server not updated yet)', response(400, { code: 'P0001', message: 'Unknown verse reference' })],
  ]) {
    const { Tracker, storage } = load(() => reply);
    seed(Tracker, ['A', 'B']);
    await Tracker.flush();
    assert.deepEqual(queueRefs(storage), ['A', 'B'], `${label}: queue must be preserved`);
    assert.equal(rejected(storage).length, 0, `${label}: nothing may be quarantined`);
    assert.equal(Tracker.hasPendingEvents(), true);
  }

  // 3) Eșec temporar în timpul trimiterii câte unul: ne oprim, ordinea rămâne.
  {
    const { Tracker, storage } = load((url, body) => {
      if (body.length > 1) return stale('STALE_READING_CYCLE');
      if (body[0].verse_ref === 'A') return response(201);
      if (body[0].verse_ref === 'B') throw new Error('offline');
      return response(201);
    });
    seed(Tracker, ['A', 'B', 'C']);
    await Tracker.flush();
    assert.deepEqual(queueRefs(storage), ['B', 'C'], 'Stop at the first transient failure, keep order');
    assert.equal(rejected(storage).length, 0);
  }

  // 4) Prima categorie se salvează chiar dacă există răspunsuri în așteptare
  //    (serverul le refuză până există o categorie); schimbările ulterioare nu.
  {
    const { Tracker, calls } = load((url, body) => {
      if (url.includes('set_reading_category')) return response(200, { category_id: body.p_category_id, epistle_revision: 0 });
      return response(400, { code: 'P0001', message: 'Choose a reading category before continuing' });
    });
    seed(Tracker, ['A']);
    await new Promise((r) => setImmediate(r)); // lasă trimiterea pornită de log() să se termine
    const before = calls.length;
    const profile = await Tracker.saveCategory('grades_4_5', { initial: true });
    assert.equal(profile.category_id, 'grades_4_5');
    assert.equal(Tracker.hasPendingEvents(), true, 'The pending answer is still queued');
    assert.deepEqual(calls.slice(before).map((c) => c.url.split('/').pop()), ['set_reading_category'],
      'Initial save must not try to flush the queue first');
    await assert.rejects(Tracker.saveCategory('grades_6_7'), /sincronizarea/, 'A change requires an empty queue');
  }

  console.log('Offline queue: stale answers quarantined without blocking, transient errors preserved, first category saves with a pending queue.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
