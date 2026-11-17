// Rulează 20261117_01 pe PostgreSQL real (PGlite): după privilegiile implicite
// Supabase (EXECUTE pentru anon/authenticated la CREATE FUNCTION), funcțiile
// interne trebuie să fie închise, iar RPC-urile publice să rămână apelabile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const read = file => fs.readFileSync(path.join(__dirname, '../supabase', file), 'utf8');
const migration = read('20261117_01_revoke_internal_function_execute.sql');
const validateMigration = read('20261117_02_revoke_validate_citim_event_insert.sql');

const INTERNAL = {
  compute_user_points: 'uuid, timestamptz', verse_total_pages: '',
  recalculate_scores_after_event_insert: '', completed_page_count: 'uuid, integer, timestamptz',
  recalculate_score_for_user: 'uuid, text', verify_event_before_insert: '',
  validate_citim_event_insert: '',
};
const PUBLIC_RPC = { get_public_leaderboard: 'integer, integer', get_own_score: '',
  upsert_own_score: 'text, integer', set_reading_category: 'text' };

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated;
      grant usage on schema public to anon, authenticated;
      alter default privileges in schema public grant execute on functions to anon, authenticated;`);
    for (const [name, args] of Object.entries({ ...INTERNAL, ...PUBLIC_RPC })) {
      const returns = name.includes('trigger') || name.startsWith('verify_') || name.startsWith('validate_') || name.startsWith('recalculate_scores') ? 'trigger' : 'integer';
      const body = returns === 'trigger' ? 'begin return new; end;' : 'begin return 1; end;';
      await db.exec(`create function public.${name}(${args}) returns ${returns} language plpgsql security definer as $$ ${body} $$;`);
      await db.exec(`revoke all on function public.${name}(${args}) from public;`);
    }
    const can = async (role, name, args) => (await db.query(
      `select has_function_privilege($1, 'public.${name}(${args})', 'execute') as ok`, [role])).rows[0].ok;
    for (const [name, args] of Object.entries(INTERNAL)) {
      assert.equal(await can('authenticated', name, args), true, `${name}: fixture mimics Supabase default grants`);
    }
    await db.exec(migration);
    await db.exec(migration);
    assert.equal(await can('authenticated', 'validate_citim_event_insert', ''), true, 'Migration 01 leaves the live-only trigger function alone');
    await db.exec(validateMigration);
    await db.exec(validateMigration);
    for (const role of ['anon', 'authenticated']) {
      for (const [name, args] of Object.entries(INTERNAL)) {
        assert.equal(await can(role, name, args), false, `${role} must not execute ${name}`);
      }
    }
    for (const [name, args] of Object.entries(PUBLIC_RPC)) {
      assert.equal(await can('authenticated', name, args), true, `${name} stays callable by signed-in users`);
    }
    console.log('Function privileges: internal functions closed to anon/authenticated, public RPCs untouched, idempotent.');
    const empty = new PGlite();
    try { await empty.exec('create role anon; create role authenticated;'); await empty.exec(validateMigration); }
    finally { await empty.close(); }
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
