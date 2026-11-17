-- Funcțiile interne SECURITY DEFINER nu trebuie apelate direct de utilizatori.
--
-- `revoke ... from public` (20260903_02) nu retrage drepturile acordate direct
-- rolurilor `anon`/`authenticated` de privilegiile implicite Supabase la
-- CREATE FUNCTION. 20260904_05 a retras `anon`, 20261110_02 a retras și
-- `authenticated` doar pentru completed_page_count, recalculate_score_for_user
-- și verify_event_before_insert. Rămâneau apelabile de orice utilizator logat,
-- prin /rest/v1/rpc/..., fiindcă rulează ca proprietar și primesc un uuid
-- arbitrar:
--   compute_user_points(uuid, timestamptz)   -> punctele oricărui cont
--   verse_total_pages()                      -> intern
--   recalculate_scores_after_event_insert()  -> funcție de trigger
--
-- Triggerele nu au nevoie de EXECUTE pentru rolul apelant: funcțiile
-- SECURITY DEFINER apelate din alte funcții SECURITY DEFINER rulează ca
-- proprietar. RPC-urile publice rămân neschimbate: get_public_leaderboard,
-- get_own_score, upsert_own_score, set_reading_category.
-- Sigur la rulări repetate.

begin;

revoke all on function public.compute_user_points(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.verse_total_pages() from public, anon, authenticated;
revoke all on function public.recalculate_scores_after_event_insert() from public, anon, authenticated;
-- Redundant cu 20261110_02, repetat ca migrarea să fie autosuficientă.
revoke all on function public.completed_page_count(uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.recalculate_score_for_user(uuid, text) from public, anon, authenticated;
revoke all on function public.verify_event_before_insert() from public, anon, authenticated;

commit;
