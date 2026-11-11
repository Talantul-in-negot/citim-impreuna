// Rulează migrația 20261110_03 pe un PostgreSQL real (PGlite), cu
// public.citim_verse_catalog recreat exact ca în baza live (aceleași coloane și
// constrângeri, citite din producție pe 2026-11-11).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.CI_PGLITE_MODULE || '@electric-sql/pglite');
const { catalogChoices } = require('./build-epistle-catalog');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, 'supabase', file), 'utf8');

const CATALOG_DDL = `
create table public.citim_verse_catalog (
  verse_ref text primary key,
  correct_answer text not null,
  valid_choices text[] not null check (cardinality(valid_choices) = 4),
  page_index integer not null check (page_index >= 0),
  page_size smallint not null check (page_size >= 1 and page_size <= 5),
  chapter_ref text not null,
  chapter_size smallint not null check (chapter_size >= 1 and chapter_size <= 100)
);
insert into public.citim_verse_catalog values
  ('1 Samuel 1:1', 'Elcana', array['Elcana','Eli','Ionatan','Saul'], 0, 5, '1 Samuel 1', 28);`;

async function freshDb({ withKey, withCatalog }) {
  const db = new PGlite();
  await db.exec(read('20260903_01_verse_answer_key.sql'));
  if (withKey) await db.exec(read('20261110_01_epistle_answer_key.sql'));
  if (withCatalog) await db.exec(CATALOG_DDL);
  return db;
}

async function main() {
  const migration = read('20261110_03_citim_catalog_epistles.sql');
  const expected = catalogChoices();

  // 1) Ordinea corectă: cheia canonică, apoi catalogul.
  const db = await freshDb({ withKey: true, withCatalog: true });
  await db.exec(migration);
  const { rows } = await db.query(`
    select c.verse_ref, c.correct_answer, c.valid_choices, c.page_index, c.chapter_ref,
           v.answer, v.page_index as key_page, v.chapter_ref as key_chapter
    from public.citim_verse_catalog c join public.verse_answers v using (verse_ref)
    where c.verse_ref !~ '^[12] Samuel '`);
  assert.equal(rows.length, expected.length, 'Every epistle verse must be in the catalog');
  for (const row of rows) {
    assert.equal(row.correct_answer, row.answer, `${row.verse_ref}: answer follows verse_answers`);
    assert(row.valid_choices.includes(row.correct_answer), `${row.verse_ref}: answer is one of the choices`);
    assert.equal(row.page_index, row.key_page);
    assert.equal(row.chapter_ref, row.key_chapter);
  }
  const byRef = new Map(expected.map((e) => [e.ref, [...e.options]])); // vm realm -> array obișnuit
  for (const row of rows) assert.deepEqual([...row.valid_choices], byRef.get(row.verse_ref), `${row.verse_ref}: choices match the app`);
  const samuel = await db.query(`select * from public.citim_verse_catalog where verse_ref = '1 Samuel 1:1'`);
  assert.equal(samuel.rows[0].page_index, 0, 'Existing Samuel rows are untouched');

  // 2) Reaplicarea e sigură (idempotentă).
  await db.exec(migration);
  const again = await db.query(`select count(*)::int as n from public.citim_verse_catalog`);
  assert.equal(again.rows[0].n, expected.length + 1);

  // 3) Ordine greșită (fără cheia epistolelor): eșuează zgomotos, nu inserează nimic.
  const early = await freshDb({ withKey: false, withCatalog: true });
  await assert.rejects(early.exec(migration), /Rulează întâi 20261110_01/);
  await early.exec('rollback'); // ca după o rulare eșuată în SQL Editor
  const none = await early.query(`select count(*)::int as n from public.citim_verse_catalog`);
  assert.equal(none.rows[0].n, 1, 'A failed run must leave the catalog unchanged');

  // 4) Bază nouă, fără catalog (apply_all.sql): nu face nimic și nu eșuează.
  const fresh = await freshDb({ withKey: true, withCatalog: false });
  await fresh.exec(migration);

  console.log(`Epistle catalog: ${expected.length} verses added consistently with the answer key; idempotent; wrong order fails; no-op without catalog.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
