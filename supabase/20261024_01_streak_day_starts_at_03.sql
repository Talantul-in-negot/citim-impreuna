-- Ziua de streak incepe la 03:00, ora Europe/Bucharest.
-- Conversia in ora locala preceda scaderea celor 3 ore, inclusiv la DST.
-- Formula pentru versete si pagini este pastrata; se schimba doar ziua bonusului.
begin;

create or replace function public.compute_user_points(
  p_user_id uuid,
  p_baseline_at timestamptz
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with first_correct as (
    select
      coalesce(e.cycle, 0) as cycle_number,
      e.page_index,
      e.verse_ref,
      min(e.created_at) as first_correct_at
    from public.events e
    where e.user_id = p_user_id
      and e.correct is true
      and e.recorded_at > p_baseline_at
    group by coalesce(e.cycle, 0), e.page_index, e.verse_ref
  ),
  page_requirements as (
    select
      coalesce(e.cycle, 0) as cycle_number,
      e.page_index,
      max(e.page_size) as expected_answers
    from public.events e
    where e.user_id = p_user_id
      and e.recorded_at > p_baseline_at
      and e.page_index is not null
      and e.page_size is not null
    group by coalesce(e.cycle, 0), e.page_index
  ),
  completed_pages as (
    select
      r.cycle_number,
      r.page_index,
      r.expected_answers,
      count(f.verse_ref) as correct_answers,
      max(f.first_correct_at) as completed_at
    from page_requirements r
    left join first_correct f
      on f.cycle_number = r.cycle_number
      and f.page_index = r.page_index
    group by r.cycle_number, r.page_index, r.expected_answers
  ),
  clean_page_bonus as (
    select count(*) * 20 as bonus
    from completed_pages p
    where p.correct_answers >= p.expected_answers
      and not exists (
        select 1
        from public.events wrong
        where wrong.user_id = p_user_id
          and wrong.recorded_at > p_baseline_at
          and coalesce(wrong.cycle, 0) = p.cycle_number
          and wrong.page_index = p.page_index
          and wrong.correct is false
          and wrong.created_at < p.completed_at
      )
  ),
  daily_chapters as (
    select
      ((e.recorded_at at time zone 'Europe/Bucharest') - interval '3 hours')::date as reading_date,
      e.chapter_ref,
      max(e.chapter_size) as expected_verses,
      count(distinct e.verse_ref) filter (where e.correct is true) as correct_verses
    from public.events e
    where e.user_id = p_user_id
      and e.recorded_at > p_baseline_at
      and e.chapter_ref is not null
      and e.chapter_size is not null
    group by ((e.recorded_at at time zone 'Europe/Bucharest') - interval '3 hours')::date, e.chapter_ref
  ),
  qualifying_days as (
    select distinct reading_date
    from daily_chapters
    where correct_verses >= expected_verses
  ),
  sequenced_days as (
    select
      reading_date,
      reading_date - row_number() over (order by reading_date)::integer as streak_group
    from qualifying_days
  ),
  streaks as (
    select count(*)::integer as day_count
    from sequenced_days
    group by streak_group
  ),
  streak_bonus as (
    select coalesce(sum((day_count / 7) * 2000), 0) as bonus
    from streaks
  )
  select (
      (select count(*) * 10 from first_correct)
    + coalesce((select bonus from clean_page_bonus), 0)
    + coalesce((select bonus from streak_bonus), 0)
  )::integer;
$$;

do $$
declare
  v_user_id uuid;
begin
  for v_user_id in select user_id from public.scores where user_id is not null loop
    perform public.recalculate_score_for_user(v_user_id);
  end loop;
end;
$$;

commit;
