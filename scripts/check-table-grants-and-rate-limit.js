// Rulează 20261119_01 (drepturi pe tabele) și 20261119_02 (limită de viteză) pe
// PostgreSQL real (PGlite): după privilegiile implicite Supabase (ALL pe tabele
// noi pentru anon/authenticated), tabelele rămân cu strictul necesar, iar al
// 1001-lea răspuns corect într-o fereastră de 24 h este refuzat cu RATE_LIMITED.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const read = file => fs.readFileSync(path.join(__dirname, '../supabase', file), 'utf8');
const grants = read('20261119_01_harden_names_and_table_grants.sql');
const limit = read('20261119_02_event_rate_limit.sql');

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const D = '00000000-0000-4000-8000-00000000000d';

const BASE = `create role anon; create role authenticated;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant execute on functions to anon, authenticated;
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;`;

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`${BASE}
      create table public.scores(user_id uuid primary key, user_name text);
      create table public.reading_profiles(user_id uuid primary key);
      create table public.verse_answers(verse_ref text primary key);
      create table public.app_config(id int primary key, leaderboard_size int);
      create table public.events(id bigserial primary key, user_id uuid, correct boolean,
        client_event_id text unique, recorded_at timestamptz not null default now());
      alter table public.events enable row level security;
      create policy events_insert_own on public.events for insert to authenticated with check (user_id = auth.uid());
      create policy events_select_own on public.events for select to authenticated using (user_id = auth.uid());`);
    const can = async (role, table, priv) => (await db.query(
      'select has_table_privilege($1, $2, $3) as ok', [role, `public.${table}`, priv])).rows[0].ok;

    assert.equal(await can('authenticated', 'events', 'truncate'), true, 'fixture mimics Supabase default grants');
    await db.exec(grants);
    await db.exec(grants);

    for (const role of ['anon', 'authenticated']) {
      for (const priv of ['select', 'insert', 'update', 'delete', 'truncate']) {
        assert.equal(await can(role, 'verse_answers', priv), false, `${role} must not ${priv} verse_answers`);
      }
    }
    assert.equal(await can('anon', 'events', 'select'), false);
    assert.equal(await can('anon', 'events', 'insert'), false);
    assert.equal(await can('authenticated', 'events', 'select'), true, 'Clients read their own events');
    assert.equal(await can('authenticated', 'events', 'insert'), true, 'Clients post events');
    for (const priv of ['update', 'delete', 'truncate']) {
      assert.equal(await can('authenticated', 'events', priv), false, `authenticated must not ${priv} events`);
    }
    for (const table of ['scores', 'reading_profiles']) {
      assert.equal(await can('authenticated', table, 'select'), true, `${table} stays readable`);
      assert.equal(await can('anon', table, 'select'), false);
      for (const priv of ['insert', 'update', 'delete', 'truncate']) {
        assert.equal(await can('authenticated', table, priv), false, `authenticated must not ${priv} ${table}`);
      }
    }
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await can(role, 'app_config', 'select'), true, 'app_config stays publicly readable');
      for (const priv of ['insert', 'update', 'delete', 'truncate']) {
        assert.equal(await can(role, 'app_config', priv), false, `${role} must not ${priv} app_config`);
      }
    }

    // Aplicarea pe o bază fără tabelele doar-live nu are voie să cadă.
    const bare = new PGlite();
    try {
      await bare.exec(`${BASE} create table public.scores(user_id uuid primary key, user_name text);`);
      await bare.exec(grants);
    } finally { await bare.close(); }

    // Limita de viteză.
    await db.exec(`insert into public.events(user_id, correct) select '${A}', true from generate_series(1, 1000);
      insert into public.events(user_id, correct) select '${B}', true from generate_series(1, 999);
      insert into public.events(user_id, correct, recorded_at)
        select '${C}', true, now() - interval '25 hours' from generate_series(1, 1000);`);
    await db.exec(limit);
    await db.exec(limit);

    const insert = (user, correct = true) => db.query(
      'insert into public.events(user_id, correct) values ($1, $2)', [user, correct]);
    await assert.rejects(() => insert(A), error => {
      assert.match(error.message, /Daily answer limit reached/);
      assert.equal(error.detail, 'RATE_LIMITED', 'The client must be able to tell this is not a stale answer');
      assert.equal(error.code, 'PT429', 'PostgREST maps PT429 to HTTP 429, a temporary error for the client');
      return true;
    });
    await insert(A, false); // un răspuns greșit nu contează la limită
    await insert(B); // al 1000-lea al lui B încă intră
    await assert.rejects(() => insert(B), /Daily answer limit reached/);
    await insert(C); // evenimentele mai vechi de 24 h nu se numără
    assert.equal(Number((await db.query('select count(*) n from public.events where user_id=$1', [A])).rows[0].n), 1001,
      'The refused answer must not be stored (1000 + the one incorrect answer)');

    // Un lot offline e un singur INSERT multi-rând: depășirea limitei în mijlocul lui
    // anulează tot lotul (nimic parțial), iar un lot care încape intră întreg.
    await db.exec(`insert into public.events(user_id, correct) select '${D}', true from generate_series(1, 995);`);
    await assert.rejects(() => db.query(
      `insert into public.events(user_id, correct) select $1, true from generate_series(1, 10)`, [D]),
    /Daily answer limit reached/);
    assert.equal(Number((await db.query('select count(*) n from public.events where user_id=$1', [D])).rows[0].n), 995,
      'A rejected batch must leave nothing behind');
    await db.query('insert into public.events(user_id, correct) select $1, true from generate_series(1, 5)', [D]);

    // Calea reală a clientului: ca authenticated, sub RLS, cu ON CONFLICT DO NOTHING.
    await db.exec(`select set_config('app.uid', '${C}', false); set role authenticated;`);
    try {
      const post = () => db.query(
        `insert into public.events(user_id, correct, client_event_id) values ($1, false, 'evt-1')
         on conflict (client_event_id) do nothing`, [C]);
      await post();
      await post(); // retrimitere idempotentă, fără UPDATE sau SELECT suplimentar
      await assert.rejects(() => db.query(
        `insert into public.events(user_id, correct, client_event_id) values ($1, false, 'evt-x')`, [A]),
      /row-level security/, 'RLS still stops writing as another user');
      await assert.rejects(() => db.query('update public.events set correct = true'), /permission denied/);
      await assert.rejects(() => db.query('delete from public.events'), /permission denied/);
      await assert.rejects(() => db.query('truncate public.events'), /permission denied/);
    } finally { await db.exec('reset role'); }
    assert.equal(Number((await db.query("select count(*) n from public.events where client_event_id='evt-1'")).rows[0].n), 1);

    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query(
        `select has_function_privilege($1, 'public.enforce_event_rate_limit()', 'execute') as ok`, [role])).rows[0].ok,
      false, `${role} must not execute the trigger function`);
    }
    console.log('Table grants and rate limit: only needed privileges remain, 1001st correct answer in 24h refused as RATE_LIMITED, idempotent.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
