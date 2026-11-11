-- Categorii si traseu liniar: 1 Samuel -> 2 Samuel -> epistola -> ciclu nou.
-- Se aplica dupa cheia epistolelor, fara rescrierea scorurilor/ciclurilor vechi.
begin;

create or replace function public.category_epistle(p_category_id text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case p_category_id
    when 'preschool_1' then 'iuda'
    when 'grades_2_3' then 'iuda'
    when 'grades_4_5' then '1petru'
    when 'grades_6_7' then 'filipeni'
    when 'grades_8_9' then 'galateni'
    when 'grades_10_11' then 'evrei'
    when 'adults_18_35' then 'evrei'
    when 'adults_35_plus' then 'evrei'
  end;
$$;

create or replace function public.reading_book_key(p_chapter_ref text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_chapter_ref like '1 Samuel %' then '1samuel'
    when p_chapter_ref like '2 Samuel %' then '2samuel'
    when p_chapter_ref like 'Iuda %' then 'iuda'
    when p_chapter_ref like '1 Petru %' then '1petru'
    when p_chapter_ref like 'Filipeni %' then 'filipeni'
    when p_chapter_ref like 'Evrei %' then 'evrei'
    when p_chapter_ref like 'Galateni %' then 'galateni'
  end;
$$;

create table if not exists public.reading_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  category_id text,
  epistle_revision integer not null default 0 check (epistle_revision >= 0),
  updated_at timestamptz not null default now(),
  constraint reading_profiles_category_check check (
    category_id is null or category_id in (
      'preschool_1', 'grades_2_3', 'grades_4_5', 'grades_6_7',
      'grades_8_9', 'grades_10_11', 'adults_18_35', 'adults_35_plus'
    )
  )
);
alter table public.reading_profiles enable row level security;
drop policy if exists reading_profiles_select_own on public.reading_profiles;
create policy reading_profiles_select_own on public.reading_profiles
  for select to authenticated using (user_id = auth.uid());
revoke all on public.reading_profiles from anon, authenticated;
grant select on public.reading_profiles to authenticated;

alter table public.events add column if not exists epistle_revision integer not null default 0;

-- Conturile existente pastreaza categoria NULL pana la alegerea explicita.
insert into public.reading_profiles(user_id)
select id from auth.users on conflict (user_id) do nothing;

create or replace function public.create_reading_profile()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_category text := new.raw_user_meta_data ->> 'category_id';
begin
  if v_category is not null and public.category_epistle(v_category) is null then
    raise exception 'Invalid reading category';
  end if;
  insert into public.reading_profiles(user_id, category_id)
  values (new.id, v_category) on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists create_reading_profile_after_signup on auth.users;
create trigger create_reading_profile_after_signup after insert on auth.users
  for each row execute function public.create_reading_profile();

create or replace function public.set_reading_category(p_category_id text)
returns public.reading_profiles
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_profile public.reading_profiles;
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  if p_category_id is null or public.category_epistle(p_category_id) is null then
    raise exception 'Invalid reading category';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_user_id::text));
  insert into public.reading_profiles(user_id) values (v_user_id)
    on conflict (user_id) do nothing;
  update public.reading_profiles
  set epistle_revision = epistle_revision + case
        when category_id is not null
          and public.category_epistle(category_id) <> public.category_epistle(p_category_id)
        then 1 else 0 end,
      category_id = p_category_id,
      updated_at = now()
  where user_id = v_user_id returning * into v_profile;
  return v_profile;
end;
$$;

-- Indicii paginilor raman globali, inclusiv dupa schimbarea categoriei.
create or replace function public.reading_route_pages(p_user_id uuid)
returns table(page_index integer, page_size integer, book_key text)
language sql stable security definer set search_path = public, pg_temp as $$
  select v.page_index, max(v.page_size)::integer, public.reading_book_key(v.chapter_ref)
  from public.verse_answers v
  join public.reading_profiles p on p.user_id = p_user_id
  where p.category_id is not null
    and public.reading_book_key(v.chapter_ref) in (
      '1samuel', '2samuel', public.category_epistle(p.category_id)
    )
  group by v.page_index, public.reading_book_key(v.chapter_ref);
$$;

create or replace function public.completed_page_count(
  p_user_id uuid, p_cycle integer, p_baseline_at timestamptz
)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer from (
    select r.page_index
    from public.reading_route_pages(p_user_id) r
    join public.reading_profiles p on p.user_id = p_user_id
    join public.events e on e.user_id = p_user_id
      and coalesce(e.cycle, 0) = p_cycle and e.correct is true
      and e.page_index = r.page_index
      and (r.book_key in ('1samuel', '2samuel') or e.epistle_revision = p.epistle_revision)
    group by r.page_index, r.page_size
    having count(distinct e.verse_ref) >= r.page_size
  ) done;
$$;

create or replace function public.next_reading_page(p_user_id uuid, p_cycle integer)
returns integer language sql stable security definer set search_path = public, pg_temp as $$
  select min(pending.page_index) from (
    select r.page_index
    from public.reading_route_pages(p_user_id) r
    join public.reading_profiles p on p.user_id = p_user_id
    left join public.events e on e.user_id = p_user_id
      and coalesce(e.cycle, 0) = p_cycle and e.correct is true
      and e.page_index = r.page_index
      and (r.book_key in ('1samuel', '2samuel') or e.epistle_revision = p.epistle_revision)
    group by r.page_index, r.page_size
    having count(distinct e.verse_ref) < r.page_size
  ) pending;
$$;

create or replace function public.recalculate_score_for_user(
  p_user_id uuid, p_user_name text default null
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_score public.scores;
  v_name text;
  v_points integer;
  v_total_pages integer;
begin
  if p_user_id is null then return; end if;
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  select * into v_score from public.scores where user_id = p_user_id;
  v_score.baseline_points := coalesce(v_score.baseline_points, 0);
  v_score.baseline_at := coalesce(v_score.baseline_at, 'epoch'::timestamptz);
  v_score.current_cycle := coalesce(v_score.current_cycle, 0);
  select nullif(trim(raw_user_meta_data ->> 'username'), '') into v_name
    from auth.users where id = p_user_id;
  v_name := coalesce(nullif(trim(p_user_name), ''), v_name, v_score.user_name, 'Utilizator');
  v_points := public.compute_user_points(p_user_id, v_score.baseline_at);
  select count(*)::integer into v_total_pages from public.reading_route_pages(p_user_id);
  if v_total_pages > 0 and public.completed_page_count(
    p_user_id, v_score.current_cycle, v_score.baseline_at
  ) >= v_total_pages then
    v_score.current_cycle := v_score.current_cycle + 1;
  end if;
  insert into public.scores(user_id, user_name, points, baseline_points, baseline_at, current_cycle, updated_at)
  values (p_user_id, v_name, v_score.baseline_points + v_points, v_score.baseline_points,
    v_score.baseline_at, v_score.current_cycle, now())
  on conflict (user_id) do update set
    user_name = excluded.user_name, points = excluded.points,
    current_cycle = excluded.current_cycle, updated_at = excluded.updated_at;
end;
$$;

create or replace function public.verify_event_before_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user_id uuid := auth.uid();
  v_key public.verse_answers;
  v_profile public.reading_profiles;
  v_cycle integer;
  v_book text;
  v_next_page integer;
begin
  if v_user_id is null then raise exception 'Authentication is required to record an event'; end if;
  perform pg_advisory_xact_lock(hashtext(v_user_id::text));
  -- Reincercarile deja acceptate nu trebuie sa intre in ciclul urmator.
  if new.client_event_id is not null and exists (
    select 1 from public.events where user_id = v_user_id and client_event_id = new.client_event_id
  ) then return null; end if;
  select * into v_profile from public.reading_profiles where user_id = v_user_id;
  if v_profile.category_id is null then raise exception 'Choose a reading category before continuing'; end if;
  select * into v_key from public.verse_answers where verse_ref = new.verse_ref;
  if not found then raise exception 'Unknown verse reference: %', new.verse_ref; end if;
  v_book := public.reading_book_key(v_key.chapter_ref);
  select current_cycle into v_cycle from public.scores where user_id = v_user_id;
  v_cycle := coalesce(v_cycle, 0);
  -- Alt dispozitiv poate fi terminat deja aceleasi raspunsuri sau chiar ciclul.
  -- Pastram creditul existent fara a muta reincercarea in ciclul urmator.
  if coalesce(new.cycle, 0) < v_cycle and exists (
    select 1 from public.events e
    where e.user_id = v_user_id and coalesce(e.cycle, 0) = coalesce(new.cycle, 0)
      and e.verse_ref = new.verse_ref and e.correct is true
  ) then return null; end if;
  v_next_page := public.next_reading_page(v_user_id, v_cycle);
  -- Un lot offline poate contine sfarsitul unui ciclu si inceputul urmatorului.
  if v_next_page is null and coalesce(new.cycle, 0) = v_cycle + 1 then
    v_cycle := v_cycle + 1;
    v_next_page := public.next_reading_page(v_user_id, v_cycle);
    update public.scores set current_cycle = v_cycle where user_id = v_user_id;
  end if;
  if coalesce(new.cycle, 0) <> v_cycle then
    raise exception using message = 'Reading cycle changed; refresh reading progress',
      detail = 'STALE_READING_CYCLE';
  end if;
  if v_book not in ('1samuel', '2samuel')
    and coalesce(new.epistle_revision, 0) <> v_profile.epistle_revision then
    raise exception using message = 'Reading category changed; refresh reading progress',
      detail = 'STALE_READING_REVISION';
  end if;
  if v_book not in ('1samuel', '2samuel', public.category_epistle(v_profile.category_id)) then
    raise exception using message = 'This book is not in the selected reading category',
      detail = 'STALE_READING_CATEGORY';
  end if;
  if exists (
    select 1 from public.events e
    where e.user_id = v_user_id and coalesce(e.cycle, 0) = v_cycle
      and e.verse_ref = new.verse_ref and e.correct is true
      and (v_book in ('1samuel', '2samuel') or e.epistle_revision = v_profile.epistle_revision)
  ) then return null; end if;
  if v_next_page is null or v_key.page_index <> v_next_page then
    raise exception using message = 'Only the current reading page can be answered',
      detail = 'STALE_READING_PAGE';
  end if;
  new.user_id := v_user_id;
  new.answer := v_key.answer;
  new.correct := new.chosen is not null and new.chosen = v_key.answer;
  new.page_index := v_key.page_index;
  new.page_size := v_key.page_size;
  new.chapter_ref := v_key.chapter_ref;
  new.chapter_size := v_key.chapter_size;
  new.cycle := v_cycle;
  new.epistle_revision := v_profile.epistle_revision;
  new.user_name := coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'username'), ''), 'Utilizator');
  new.recorded_at := now();
  new.created_at := greatest(least(coalesce(new.created_at, now()), now()), now() - interval '30 days');
  return new;
end;
$$;

revoke all on function public.category_epistle(text) from public, anon, authenticated;
revoke all on function public.reading_book_key(text) from public, anon, authenticated;
revoke all on function public.create_reading_profile() from public, anon, authenticated;
revoke all on function public.reading_route_pages(uuid) from public, anon, authenticated;
revoke all on function public.next_reading_page(uuid, integer) from public, anon, authenticated;
revoke all on function public.set_reading_category(text) from public, anon, authenticated;
grant execute on function public.set_reading_category(text) to authenticated;
revoke all on function public.completed_page_count(uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.recalculate_score_for_user(uuid, text) from public, anon, authenticated;
revoke all on function public.verify_event_before_insert() from public, anon, authenticated;

commit;
