const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/20261111_02_account_display_names.sql'), 'utf8');

async function main() {
  const db = new PGlite();
  const ids = Array.from({length: 5}, (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`);
  const read = async () => (await db.query('select user_id,user_name,points,current_cycle from public.scores order by user_id')).rows;
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
      create table public.scores(user_id uuid primary key, user_name text, points integer, current_cycle integer);
      create table public.events(user_id uuid, user_name text);`);
    const fixtures = [
      ['test@citim.app', {}, 'Utilizator', 'test'],
      ['old@test.com', {}, 'Utilizator', 'old'],
      ['unused@citim.app', {username:' Ștefan Pop '}, 'Utilizator', 'Ștefan Pop'],
      ['private.person@example.org', {}, 'Existing Name', 'Existing Name'],
      ['fallback@citim.app', {username:'   '}, null, 'fallback'],
    ];
    for (let i = 0; i < fixtures.length; i++) {
      const [email, metadata, name] = fixtures[i];
      await db.query('insert into auth.users values ($1,$2,$3)', [ids[i], email, metadata]);
      await db.query('insert into public.scores values ($1,$2,$3,$4)', [ids[i], name, 70 + i, 2 + i]);
    }
    const before = await read();
    await db.exec(migration);
    const after = await read();
    for (let i = 0; i < after.length; i++) {
      assert.equal(after[i].user_name, fixtures[i][3]);
      assert.equal(after[i].points, before[i].points);
      assert.equal(after[i].current_cycle, before[i].current_cycle);
    }
    await db.query("update public.scores set user_name='Utilizator',points=140 where user_id=$1", [ids[0]]);
    assert.equal((await read())[0].user_name, 'test', 'Recalculation must not restore the generic name');
    await db.query("insert into public.events values ($1,'Forged name')", [ids[0]]);
    assert.equal((await db.query('select user_name from public.events')).rows[0].user_name, 'test');
    await db.query('delete from public.scores where user_id=$1', [ids[1]]);
    await db.query("insert into public.scores values ($1,'Utilizator',10,0)", [ids[1]]);
    assert.equal((await read())[1].user_name, 'old', 'First score insert must resolve the account name');
    const unchanged = await read();
    await db.exec(migration);
    assert.deepEqual(await read(), unchanged, 'Migration must be idempotent');
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => db.query('select public.account_display_name($1)', [ids[0]]), /permission denied/);
      await db.exec('reset role');
    }
    console.log('Account names: internal account fallback, metadata priority, privacy, future writes and score preservation passed.');
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
