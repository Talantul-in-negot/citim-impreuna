// Rulează 20261126_01 pe PostgreSQL real (PGlite), peste cheia și catalogul deja
// aplicate în producție, cu validatorul live (supabase/live-only/) activ:
//  - răspunsurile și variantele noi ajung în verse_answers și în catalog;
//  - răspunsurile vechi rămân acceptate și sunt traduse în cele noi, ca o aplicație
//    neactualizată sau coada offline să nu fie respinsă și să fie punctată corect;
//  - migrarea e idempotentă și nu face nimic pe o bază fără epistole sau catalog.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { answerRows } = require('./build-epistle-answers');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'supabase', file), 'utf8');
const USER = '00000000-0000-4000-8000-000000000001';

const SETUP = `
create role anon; create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select '${USER}'::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$ select '{"user_metadata":{"username":"Test"}}'::jsonb $$;
create table public.events (
  id bigserial primary key, user_id uuid, verse_ref text, chosen text, answer text, correct boolean,
  cycle integer, page_index integer, page_size integer, chapter_ref text, chapter_size integer,
  recorded_at timestamptz, created_at timestamptz, user_name text
);`;

async function productionLikeDb() {
  const db = new PGlite();
  await db.exec(SETUP);
  await db.exec(read('20260903_01_verse_answer_key.sql'));
  await db.exec(read('20261110_01_epistle_answer_key.sql'));
  await db.exec(read('live-only/validate_citim_event_insert.sql'));
  await db.exec(read('20261110_03_citim_catalog_epistles.sql'));
  await db.exec(read('20261125_01_epistle_options.sql'));
  return db;
}

const insert = (db, verse, chosen, answer) => db.query(
  `insert into public.events (user_id, verse_ref, chosen, answer, correct, cycle)
   values ($1, $2, $3, $4, $5, 0) returning chosen, answer, correct`,
  [USER, verse, chosen, answer, chosen === answer]).then((r) => r.rows[0]);

async function main() {
  const rows = answerRows();
  const changed = rows.filter((row) => row.answer !== row.previous);
  assert(changed.length > 0, 'expected at least one curated answer change');
  const migration = read('20261126_01_epistle_curated_answers.sql');

  const db = await productionLikeDb();
  const before = new Map((await db.query('select verse_ref, valid_choices from public.citim_verse_catalog')).rows
    .map((row) => [row.verse_ref, [...row.valid_choices]]));
  await db.exec(migration);
  await db.exec(migration);

  const key = new Map((await db.query('select verse_ref, answer from public.verse_answers')).rows.map((r) => [r.verse_ref, r.answer]));
  const catalog = new Map((await db.query('select verse_ref, correct_answer, valid_choices from public.citim_verse_catalog')).rows
    .map((r) => [r.verse_ref, r]));
  const legacy = (await db.query('select verse_ref, answer from public.verse_answer_legacy')).rows;
  assert.equal(legacy.length, changed.length, 'One legacy answer per changed verse');
  for (const row of rows) {
    assert.equal(key.get(row.ref), row.answer, `${row.ref}: verse_answers has the new answer`);
    const c = catalog.get(row.ref);
    assert.equal(c.correct_answer, row.answer, `${row.ref}: catalog has the new answer`);
    for (const choice of [...row.options, ...before.get(row.ref)]) {
      assert(c.valid_choices.includes(choice), `${row.ref}: "${choice}" stays accepted`);
    }
    assert.equal(new Set(c.valid_choices).size, c.valid_choices.length, `${row.ref}: no duplicate choices`);
  }

  // Aplicația nouă: răspunsul nou, corect și greșit.
  const sample = changed[0];
  const newWrong = sample.options.find((o) => o !== sample.answer);
  assert.deepEqual(await insert(db, sample.ref, sample.answer, sample.answer), { chosen: sample.answer, answer: sample.answer, correct: true });
  assert.deepEqual(await insert(db, sample.ref, newWrong, sample.answer), { chosen: newWrong, answer: sample.answer, correct: false });
  // Aplicația veche sau coada offline: răspunsul vechi corect devine răspunsul nou, corect.
  for (const row of changed) {
    assert.deepEqual(await insert(db, row.ref, row.previous, row.previous),
      { chosen: row.answer, answer: row.answer, correct: true }, `${row.ref}: old correct answer is accepted and scored`);
  }
  // Clientul vechi trimite correct=false dacă alegerea lui nu era răspunsul vechi; dacă acea
  // alegere e chiar cuvântul nou, triggerul recalculează correct ca validatorul să nu-l respingă.
  assert.deepEqual(await db.query(`insert into public.events (user_id, verse_ref, chosen, answer, correct, cycle)
    values ($1, $2, $3, $4, false, 0) returning chosen, answer, correct`, [USER, sample.ref, sample.answer, sample.previous]).then((r) => r.rows[0]),
    { chosen: sample.answer, answer: sample.answer, correct: true }, 'An old event can never block the queue');
  // O variantă greșită veche rămâne greșită, dar nu e respinsă.
  const oldWrong = before.get(sample.ref).find((o) => o !== sample.previous && o !== sample.answer);
  assert.deepEqual(await insert(db, sample.ref, oldWrong, sample.previous), { chosen: oldWrong, answer: sample.answer, correct: false });
  // Un verset neschimbat nu e atins.
  const same = rows.find((row) => row.answer === row.previous);
  if (same) assert.deepEqual(await insert(db, same.ref, same.answer, same.answer), { chosen: same.answer, answer: same.answer, correct: true });
  // Un răspuns inventat e respins în continuare de validatorul live.
  await assert.rejects(insert(db, sample.ref, 'cuvântinexistent', sample.answer), /not a valid option/);

  // Rerularea cheii vechi (20261110_01) e oprită, nu readuce răspunsurile vechi.
  await assert.rejects(db.exec(read('20261110_01_epistle_answer_key.sql')), /nu rerula 20261110_01/);
  await db.exec('rollback');
  assert.equal((await db.query('select answer from public.verse_answers where verse_ref = $1', [sample.ref])).rows[0].answer, sample.answer);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1, 'public.accept_legacy_answer()', 'execute') as ok`, [role])).rows[0].ok, false);
    assert.equal((await db.query(`select has_function_privilege($1, 'public.refuse_legacy_answer()', 'execute') as ok`, [role])).rows[0].ok, false);
    assert.equal((await db.query(`select has_table_privilege($1, 'public.verse_answer_legacy', 'select') as ok`, [role])).rows[0].ok, false);
  }
  await db.close();

  // Bază nouă: fără epistole și fără catalog, migrarea nu are ce schimba și nu eșuează.
  const fresh = new PGlite();
  await fresh.exec(SETUP);
  await fresh.exec(read('20260903_01_verse_answer_key.sql'));
  await fresh.exec(migration);
  await fresh.close();

  console.log(`Epistle answers: ${changed.length} curated answers applied, old answers still accepted and scored, idempotent, no-op on a fresh database.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
