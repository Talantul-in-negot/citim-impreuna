-- Fix: RLS policies without the underlying table-level GRANT block every
-- request, silently. `create policy ... for insert to authenticated` only
-- restricts WHICH rows a role may touch once it is already allowed to attempt
-- the operation — Postgres still requires the plain `GRANT INSERT`/`GRANT
-- SELECT` first, or the request is rejected before the policy is ever
-- evaluated (`42501 permission denied for table events`).
--
-- 00000000_baseline_schema.sql created the RLS policies but never granted the
-- table privileges to `authenticated`, so every logged-in user's event insert
-- has been failing since that migration was applied. tracker.js's flush()
-- treats a non-ok response as "retry later" with no visible error, so the
-- symptom was silent: score never updates, on the page or in the leaderboard.
--
-- SECURITY DEFINER functions (verify_event_before_insert, get_own_score,
-- upsert_own_score, get_public_leaderboard, ...) are unaffected by this —
-- they run as their owner, not as the caller — which is why the earlier
-- verification (checking that get_public_leaderboard rejects anon with the
-- new two-argument signature) looked correct without catching this.

begin;

grant select, insert on public.events to authenticated;
grant select on public.scores to authenticated;

commit;
