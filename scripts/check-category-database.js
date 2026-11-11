// Execută migrările în PostgreSQL local (WASM), fără acces la producție.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require(process.env.CI_PGLITE_MODULE || '@electric-sql/pglite');
const { categories, buildVerses } = require('../js/reading-path');
const { loadVerses } = require('./build-answer-key');
const { loadEpistles } = require('./build-epistle-answer-key');
const { buildChapterPages } = require('../js/pagination');
const ROOT = path.join(__dirname, '..');
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';

async function main() {
  const db = new PGlite();
  let answerRows = [];
  const scalar = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  async function asUser(id, run) {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
    await db.exec('set role authenticated');
    try { return await run(); }
    finally { await db.exec('reset role'); }
  }
  async function insertPage(pageIndex, cycle, revision = 0, prefix = 'read') {
    // Ordinea răspunsurilor din coada offline este aceeași ca în pagină.
    const rows = answerRows.filter(row => row.page_index === pageIndex);
    const args = rows.flatMap(row => [row.verse_ref, row.answer, cycle, revision, `${prefix}-${row.verse_ref}`]);
    const values = rows.map((_, index) => `(${Array.from({length:5}, (_, i) => '$' + (index * 5 + i + 1)).join(',')})`).join(',');
    return db.query(`insert into public.events(verse_ref, chosen, cycle, epistle_revision, client_event_id) values ${values}`, args);
  }
  try {
    await db.exec(`create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.jwt() returns jsonb language sql stable as $$
        select jsonb_build_object('email','reader@citim.app','user_metadata',jsonb_build_object('username','Reader')) $$;
      grant usage on schema auth, public to anon, authenticated;
      grant execute on function auth.uid(), auth.jwt() to anon, authenticated;`);
    const buildSource = fs.readFileSync(path.join(ROOT, 'scripts/build-apply-all.js'), 'utf8');
    const files = [...buildSource.match(/const FILES = \[([^]*?)\];/)[1].matchAll(/"([^"]+\.sql)"/g)].map(m => m[1]);
    const newFiles = files.filter(file => file.startsWith('20261110_'));
    assert.deepEqual(newFiles, ['20261110_01_epistle_answer_key.sql', '20261110_02_reading_categories.sql', '20261110_03_citim_catalog_epistles.sql']);
    for (const file of files.filter(file => !newFiles.includes(file))) {
      await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', file), 'utf8'));
    }
    await db.query('insert into auth.users(id,email) values ($1,$2),($3,$4)', [A, 'a@citim.app', B, 'b@citim.app']);
    // Istoric Samuel complet, inclusiv înainte de baseline. Migrarea nu îl redeschide.
    await db.exec('alter table public.events disable trigger user');
    await db.query(`insert into public.events(user_id,verse_ref,chosen,answer,correct,cycle,page_index,page_size,chapter_ref,chapter_size)
      select $1,verse_ref,answer,answer,true,0,page_index,page_size,chapter_ref,chapter_size from public.verse_answers`, [A]);
    await db.exec('alter table public.events enable trigger user');
    await db.query(`insert into public.scores(user_id,points,baseline_points,baseline_at,current_cycle)
      values ($1,9000,9000,now(),0),($2,1234,1234,now(),3)`, [A, B]);
    const before = (await db.query('select user_id,points,current_cycle from public.scores order by user_id')).rows;
    for (const file of newFiles) await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', file), 'utf8'));
    assert.deepEqual((await db.query('select user_id,points,current_cycle from public.scores order by user_id')).rows, before);
    assert.equal(await scalar('select count(*) from public.verse_answers'), 2191);
    answerRows = (await db.query('select verse_ref,answer,page_index from public.verse_answers order by ordinal')).rows;
    await asUser(A, async () => {
      assert.equal(await scalar('select count(*) from public.reading_profiles'), 1, 'RLS exposes only own profile');
      await assert.rejects(() => db.query('update public.reading_profiles set category_id=$1', ['grades_2_3']), /permission denied/);
      await assert.rejects(() => db.query('select public.set_reading_category($1)', ['invalid']), /Invalid reading category/);
      await assert.rejects(() => insertPage(324, 0), /Choose a reading category/);
    });
    const epistles = loadEpistles();
    for (const category of categories) {
      await asUser(A, () => db.query('select public.set_reading_category($1)', [category.id]));
      assert.equal(await scalar('select count(*) from public.reading_route_pages($1)', [A]),
        buildChapterPages(buildVerses(category.id, loadVerses(), epistles)).length);
      assert.equal(await scalar('select current_cycle from public.scores where user_id=$1', [A]), 0);
    }
    await asUser(A, () => db.query('select public.set_reading_category($1)', ['grades_4_5']));
    let revision = await scalar('select epistle_revision from public.reading_profiles where user_id=$1', [A]);
    const peterStart = await scalar("select min(page_index) from public.verse_answers where chapter_ref like '1 Petru %'");
    await asUser(A, async () => {
      await assert.rejects(() => insertPage(324, 0, revision), /not in the selected/);
      await assert.rejects(() => insertPage(peterStart + 1, 0, revision), /current reading page/);
      await assert.rejects(() => insertPage(peterStart, 1, revision), /cycle changed/);
      await insertPage(peterStart, 0, revision, 'peter-first');
    });
    const earned = await scalar('select points from public.scores where user_id=$1', [A]);
    assert.equal(earned, 9070);
    await asUser(A, () => db.query('select public.set_reading_category($1)', ['grades_6_7']));
    await asUser(A, () => db.query('select public.set_reading_category($1)', ['grades_4_5']));
    revision = await scalar('select epistle_revision from public.reading_profiles where user_id=$1', [A]);
    assert.equal(await scalar('select public.next_reading_page($1,0)', [A]), peterStart, 'Returning to an epistle restarts its progress');
    await asUser(A, () => insertPage(peterStart, 0, revision, 'peter-again'));
    assert.equal(await scalar('select points from public.scores where user_id=$1', [A]), earned, 'No repeat verse/page points across category revisions');
    // Un al doilea dispozitiv poate retrimite aceeași pagină cu alte event IDs.
    await asUser(A, () => insertPage(peterStart, 0, revision, 'second-device'));
    assert.equal(await scalar('select points from public.scores where user_id=$1', [A]), earned);
    await asUser(A, () => db.query('select public.set_reading_category($1)', ['grades_2_3']));
    revision = await scalar('select epistle_revision from public.reading_profiles where user_id=$1', [A]);
    const judePages = (await db.query("select distinct page_index from public.verse_answers where chapter_ref like 'Iuda %' order by page_index")).rows;
    await asUser(A, async () => {
      for (const { page_index } of judePages) await insertPage(page_index, 0, revision, 'jude');
    });
    assert.equal(await scalar('select current_cycle from public.scores where user_id=$1', [A]), 1, 'Cycle advances only after the selected epistle');
    await asUser(A, async () => {
      await insertPage(judePages.at(-1).page_index, 0, revision, 'jude'); // exact network retry
      await insertPage(judePages.at(-1).page_index, 0, revision, 'old-device');
      await insertPage(0, 1, revision, 'restart');
      await assert.rejects(() => insertPage(2, 1, revision), /current reading page/);
    });
    assert.equal(await scalar('select current_cycle from public.scores where user_id=$1', [A]), 1);
    // Categoria de la înregistrare este validată și salvată atomic.
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)', [C, 'c@citim.app', {category_id:'adults_35_plus'}]);
    assert.equal(await scalar('select category_id from public.reading_profiles where user_id=$1', [C]), 'adults_35_plus');
    await db.exec('set role anon');
    await assert.rejects(() => db.query('select public.set_reading_category($1)', ['grades_2_3']), /permission denied/);
    await db.exec('reset role');
    for (const file of newFiles) await db.exec(fs.readFileSync(path.join(ROOT, 'supabase', file), 'utf8'));
    assert.equal(await scalar('select current_cycle from public.scores where user_id=$1', [A]), 1, 'Incremental migrations are repeatable');
    console.log('Category database: migrations, preserved history, all routes, RLS, revisions, deduplication and cycle restart passed.');
  } finally { await db.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
