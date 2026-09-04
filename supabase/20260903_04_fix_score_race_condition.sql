-- Fix: lost-update race in score recalculation.
--
-- Symptom reported live: a user's score rose after answering, then dropped
-- back down on its own a moment later.
--
-- Cause: recalculate_score_for_user() is read-then-write — it SELECTs all of
-- a user's events, computes a total in application logic, then UPDATEs
-- scores.points. Nothing serializes concurrent calls for the same user, and
-- there are legitimately two independent triggers per answered page:
--   1. the AFTER INSERT STATEMENT trigger on events (events_recalculate_scores)
--   2. tracker.js's flush() calling the upsert_own_score RPC right after
-- If a second answer's insert (or a second device, or a retried flush) starts
-- its own recompute before the first one's UPDATE commits, both transactions
-- read a snapshot that doesn't yet include each other's events. Whichever
-- commits LAST overwrites scores.points with ITS total — even if that total
-- is smaller, because it was computed from an earlier snapshot. This is the
-- textbook lost-update problem: two "read some value, then write a new value
-- computed from it" transactions running concurrently, with no lock between
-- the read and the write.
--
-- Fix: take a per-user advisory lock (`pg_advisory_xact_lock`, released
-- automatically at transaction end) before reading anything. A second
-- concurrent call for the same user blocks until the first transaction
-- commits, and PostgreSQL gives every new statement a fresh snapshot under
-- READ COMMITTED — so once unblocked, the second call's SELECT sees
-- everything the first one just committed, and its recompute is a strict
-- superset. No more "last commit wins with stale data."
--
-- `hashtext(uuid::text)` collapses the uuid to an int4 for the lock key.
-- Different users can theoretically collide and serialize unnecessarily
-- against each other — a rare performance cost, never a correctness issue,
-- since collision only means two recomputes that could have run in parallel
-- now run one after another.

begin;

create or replace function public.recalculate_score_for_user(
  p_user_id uuid,
  p_user_name text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_baseline_points integer := 0;
  v_baseline_at     timestamptz := 'epoch'::timestamptz;
  v_existing_name   text;
  v_current_cycle   integer := 0;
  v_name            text;
  v_new_points      integer := 0;
  v_total_pages     integer;
begin
  if p_user_id is null then
    return;
  end if;

  -- Serializes every recompute for this user. Released automatically at
  -- transaction end (both AFTER INSERT STATEMENT triggers and RPC calls are
  -- each their own transaction), so this never needs an explicit unlock.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  select s.baseline_points, s.baseline_at, s.user_name, s.current_cycle
    into v_baseline_points, v_baseline_at, v_existing_name, v_current_cycle
  from public.scores s
  where s.user_id = p_user_id;

  v_baseline_points := coalesce(v_baseline_points, 0);
  v_baseline_at     := coalesce(v_baseline_at, 'epoch'::timestamptz);
  v_current_cycle   := coalesce(v_current_cycle, 0);

  v_name := nullif(trim(p_user_name), '');
  if v_name is null then
    select nullif(trim(u.raw_user_meta_data ->> 'username'), '')
      into v_name
    from auth.users u
    where u.id = p_user_id;
  end if;
  v_name := coalesce(v_name, v_existing_name, 'Utilizator');

  v_new_points := public.compute_user_points(p_user_id, v_baseline_at);

  v_total_pages := public.verse_total_pages();
  if v_total_pages > 0
     and public.completed_page_count(p_user_id, v_current_cycle, v_baseline_at) >= v_total_pages then
    v_current_cycle := v_current_cycle + 1;
  end if;

  update public.scores
  set user_name     = v_name,
      points        = v_baseline_points + v_new_points,
      current_cycle = v_current_cycle,
      updated_at    = now()
  where user_id = p_user_id;

  if not found then
    insert into public.scores (
      user_id, user_name, points, baseline_points, baseline_at, current_cycle, updated_at
    ) values (
      p_user_id, v_name, v_new_points, 0, 'epoch'::timestamptz, v_current_cycle, now()
    );
  end if;
end;
$$;

-- Self-heal: every user's stored score gets recomputed under the new,
-- race-free function. compute_user_points is a pure function of the events
-- table (not incremental), so this restores the correct total regardless of
-- how many lost updates happened before this migration.
do $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select distinct user_id
    from public.events
    where user_id is not null
  loop
    perform public.recalculate_score_for_user(v_user_id);
  end loop;
end;
$$;

commit;
