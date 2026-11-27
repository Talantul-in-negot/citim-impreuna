// Rulează 20261127_01 pe PostgreSQL real (PGlite), după migrările deja aplicate în
// producție și cu validatorul live activ: corecturile Samuel ajung în cheie și în
// catalog, răspunsurile și variantele vechi rămân acceptate, iar un răspuns vechi
// corect (aplicație neactualizată, coada offline) e punctat corect.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { fixRows } = require('./build-samuel-answers');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'supabase', file), 'utf8');
const USER = '00000000-0000-4000-8000-000000000001';

async function main() {
  const rows = fixRows();
  assert(rows.length > 0, 'expected Samuel corrections');
  const changed = rows.filter((row) => row.answer !== row.previous);
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select '${USER}'::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{"user_metadata":{"username":"Test"}}'::jsonb $$;
    create table public.events (
      id bigserial primary key, user_id uuid, verse_ref text, chosen text, answer text, correct boolean,
      cycle integer, page_index integer, page_size integer, chapter_ref text, chapter_size integer,
      recorded_at timestamptz, created_at timestamptz, user_name text
    );`);
  await db.exec(read('20260903_01_verse_answer_key.sql'));
  await db.exec(read('20261110_01_epistle_answer_key.sql'));
  await db.exec(read('live-only/validate_citim_event_insert.sql'));
  // Catalogul Samuel live nu e creat de nicio migrare din repo: îl reconstruim din cheie,
  // cu răspunsul publicat și trei variante vechi fictive pentru fiecare verset corectat.
  await db.exec(`insert into public.citim_verse_catalog
    select verse_ref, answer, array[answer, 'vechi1', 'vechi2', 'vechi3'], page_index, page_size, chapter_ref, chapter_size
    from public.verse_answers where verse_ref ~ '^[12] Samuel '`);
  for (const file of ['20261110_03_citim_catalog_epistles.sql', '20261125_01_epistle_options.sql', '20261126_01_epistle_curated_answers.sql']) {
    await db.exec(read(file));
  }
  const migration = read('20261127_01_samuel_fixes.sql');
  await db.exec(migration);
  await db.exec(migration);

  const key = new Map((await db.query('select verse_ref, answer from public.verse_answers')).rows.map((r) => [r.verse_ref, r.answer]));
  const catalog = new Map((await db.query('select verse_ref, correct_answer, valid_choices from public.citim_verse_catalog')).rows.map((r) => [r.verse_ref, r]));
  const legacy = new Set((await db.query(`select verse_ref || '=' || answer as k from public.verse_answer_legacy where verse_ref ~ '^[12] Samuel '`)).rows.map((r) => r.k));
  assert.equal(legacy.size, changed.length, 'One legacy answer per changed Samuel verse');
  for (const row of rows) {
    assert.equal(key.get(row.ref), row.answer, `${row.ref}: key has the corrected answer`);
    const c = catalog.get(row.ref);
    assert.equal(c.correct_answer, row.answer, `${row.ref}: catalog has the corrected answer`);
    for (const choice of [...row.options, row.previous, 'vechi1']) assert(c.valid_choices.includes(choice), `${row.ref}: "${choice}" stays accepted`);
    if (row.answer !== row.previous) assert(legacy.has(`${row.ref}=${row.previous}`), `${row.ref}: old answer kept`);
  }

  const insert = (verse, chosen, answer) => db.query(
    `insert into public.events (user_id, verse_ref, chosen, answer, correct, cycle) values ($1, $2, $3, $4, $5, 0)
     returning chosen, answer, correct`, [USER, verse, chosen, answer, chosen === answer]).then((r) => r.rows[0]);
  const sample = rows[0];
  const wrong = sample.options.find((o) => o !== sample.answer);
  assert.deepEqual(await insert(sample.ref, sample.answer, sample.answer), { chosen: sample.answer, answer: sample.answer, correct: true });
  assert.deepEqual(await insert(sample.ref, wrong, sample.answer), { chosen: wrong, answer: sample.answer, correct: false });
  for (const row of changed) {
    assert.deepEqual(await insert(row.ref, row.previous, row.previous), { chosen: row.answer, answer: row.answer, correct: true },
      `${row.ref}: an old correct answer is accepted and scored`);
  }
  assert.deepEqual(await insert(sample.ref, 'vechi1', sample.previous), { chosen: 'vechi1', answer: sample.answer, correct: false },
    'An old wrong option stays wrong and is not rejected');
  if (changed.length) {
    // Rerularea cheii vechi e refuzată (trigger sau cheie străină restrict), nu readuce răspunsurile vechi.
    await assert.rejects(db.exec(read('20260903_01_verse_answer_key.sql')), /nu rerula 20261110_01|violates RESTRICT/);
    await db.exec('rollback');
  }
  await db.close();
  console.log(`Samuel fixes: ${rows.length} verses corrected (${changed.length} new answers), old answers and options still accepted, idempotent.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
