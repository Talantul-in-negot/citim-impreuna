-- Fix: get_public_leaderboard was callable by the unauthenticated `anon` role
-- and returned real user names and scores, despite `revoke all ... from
-- public` immediately after its creation in 20260903_02_server_verified_events.sql.
--
-- `revoke ... from public` only removes what the PUBLIC pseudo-role has.
-- It does NOT remove a privilege granted directly to a named role (`anon`),
-- even when that grant originated from PostgreSQL's default-privileges
-- mechanism at CREATE FUNCTION time. Verified live: get_own_score and
-- upsert_own_score (same revoke-then-grant pattern) correctly return 401 for
-- anon, while get_public_leaderboard returned 200 with real data - the
-- inconsistency between functions using the identical pattern means this
-- isn't a logic bug in one file, it's a gap in what `revoke ... from public`
-- actually covers.
--
-- Fix is defensive and explicit rather than diagnosing the exact mechanism
-- further: revoke from `anon` BY NAME on every function that should be
-- authenticated-only, on top of the existing `from public` revokes. This is
-- correct regardless of root cause and safe to run repeatedly.

begin;

revoke all on function public.get_public_leaderboard(integer, integer) from anon;
revoke all on function public.get_own_score() from anon;
revoke all on function public.upsert_own_score(text, integer) from anon;
revoke all on function public.verse_total_pages() from anon;
revoke all on function public.completed_page_count(uuid, integer, timestamptz) from anon;
revoke all on function public.compute_user_points(uuid, timestamptz) from anon;
revoke all on function public.recalculate_score_for_user(uuid, text) from anon;
revoke all on function public.recalculate_scores_after_event_insert() from anon;
revoke all on function public.verify_event_before_insert() from anon;

commit;
