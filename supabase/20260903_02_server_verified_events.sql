-- Scoruri cu adevărat derivate de server.
--
-- Până acum browserul calcula `correct` (js/app.js: `s.value === s.dataset.answer`)
-- și îl trimitea, iar serverul doar reaplica formula peste el. La fel pentru
-- `cycle`, `page_index`, `page_size`, `chapter_ref`, `chapter_size`. Cum punctele
-- se numără o dată per (cycle, verse_ref) și `cycle` nu avea nicio constrângere,
-- o singură cerere cu 1505 versete × 100 cicluri producea ~1,5 milioane de puncte.
--
-- De aici încolo, un trigger BEFORE INSERT deduce toate câmpurile care
-- influențează scorul din public.verse_answers (vezi 20260903_01_...). Ce trimite
-- clientul rămâne relevant doar prin `chosen` — răspunsul ales.
--
-- Aceeași migrare colapsează CTE-ul de punctaj, copiat până acum în trei funcții,
-- într-o singură definiție: public.compute_user_points.
--
-- NECESITĂ: 00000000_baseline_schema.sql și 20260903_01_verse_answer_key.sql.

begin;

-- `cycle` e acum ștampilat de server, dar constrângerea rămâne ca plasă de
-- siguranță dacă cineva scrie vreodată direct în tabel.
alter table public.events drop constraint if exists events_cycle_check;
alter table public.events
  add constraint events_cycle_check check (cycle is null or cycle >= 0);

-- ------------------------------------------------------------- ajutoare ------

create or replace function public.verse_total_pages()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(max(page_index) + 1, 0)::integer from public.verse_answers;
$$;

-- Câte pagini a terminat complet utilizatorul în ciclul dat.
create or replace function public.completed_page_count(
  p_user_id uuid,
  p_cycle integer,
  p_baseline_at timestamptz
)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::integer
  from (
    select e.page_index
    from public.events e
    where e.user_id = p_user_id
      and coalesce(e.cycle, 0) = p_cycle
      and e.correct is true
      and e.recorded_at > p_baseline_at
      and e.page_index is not null
    group by e.page_index
    having count(distinct e.verse_ref) >= coalesce(max(e.page_size), 5)
  ) done;
$$;

-- --------------------------------------------------- trigger de verificare ---

create or replace function public.verify_event_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id     uuid := auth.uid();
  v_key         public.verse_answers%rowtype;
  v_cycle       integer;
  v_baseline_at timestamptz;
  v_total_pages integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required to record an event';
  end if;
  new.user_id := v_user_id;

  select * into v_key
  from public.verse_answers
  where verse_ref = new.verse_ref;

  if not found then
    -- Un verset necunoscut ar fi altfel punctat ca oricare altul, deci
    -- respingem zgomotos în loc să acceptăm în tăcere date neverificabile.
    raise exception 'Unknown verse reference: %', new.verse_ref;
  end if;

  -- Tot ce intră în formula de punctaj vine din cheia de răspunsuri.
  new.answer       := v_key.answer;
  new.correct      := (new.chosen is not null and new.chosen = v_key.answer);
  new.page_index   := v_key.page_index;
  new.page_size    := v_key.page_size;
  new.chapter_ref  := v_key.chapter_ref;
  new.chapter_size := v_key.chapter_size;

  select s.current_cycle, s.baseline_at
    into v_cycle, v_baseline_at
  from public.scores s
  where s.user_id = v_user_id;

  v_cycle       := coalesce(v_cycle, 0);
  v_baseline_at := coalesce(v_baseline_at, 'epoch'::timestamptz);

  -- Ciclul creşte doar când cartea a fost parcursă integral. Verificarea e per
  -- rând, nu per lot, ca ultima pagină a unui ciclu și prima pagină a
  -- următorului să nu primească aceeași ștampilă când sosesc împreună din coada
  -- offline.
  v_total_pages := public.verse_total_pages();
  if v_total_pages > 0
     and public.completed_page_count(v_user_id, v_cycle, v_baseline_at) >= v_total_pages then
    v_cycle := v_cycle + 1;
    update public.scores set current_cycle = v_cycle where user_id = v_user_id;
  end if;
  new.cycle := v_cycle;

  new.user_name := coalesce(
    nullif(trim(auth.jwt() -> 'user_metadata' ->> 'username'), ''),
    'Utilizator'
  );

  new.recorded_at := now();
  -- `created_at` rămâne al clientului — ordinea răspunsurilor date offline
  -- decide bonusul de pagină curată — dar mărginit: niciodată în viitor și
  -- niciodată mai vechi de 30 de zile, ca să nu se poată fabrica un streak.
  new.created_at := greatest(
    least(coalesce(new.created_at, now()), now()),
    now() - interval '30 days'
  );

  return new;
end;
$$;

drop trigger if exists events_verify_before_insert on public.events;
create trigger events_verify_before_insert
before insert on public.events
for each row
execute function public.verify_event_before_insert();

-- ------------------------------------------- punctajul, într-un singur loc ---
-- 10 puncte per verset corect (o dată per ciclu), 20 bonus per pagină terminată
-- fără nicio greșeală înainte de finalizare, 2000 per fiecare 7 zile calendar
-- (Europe/Bucharest) consecutive cu cel puțin un capitol complet.

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
      (e.recorded_at at time zone 'Europe/Bucharest')::date as reading_date,
      e.chapter_ref,
      max(e.chapter_size) as expected_verses,
      count(distinct e.verse_ref) filter (where e.correct is true) as correct_verses
    from public.events e
    where e.user_id = p_user_id
      and e.recorded_at > p_baseline_at
      and e.chapter_ref is not null
      and e.chapter_size is not null
    group by (e.recorded_at at time zone 'Europe/Bucharest')::date, e.chapter_ref
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

-- ------------------------------------------------------------- recalcul ------

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

  -- Plasă de siguranță pentru avansarea ciclului: triggerul o face deja la
  -- inserare, dar un import în masă sau o corecție manuală nu trec pe acolo.
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

create or replace function public.upsert_own_score(
  p_user_name text default null,
  p_points integer default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := coalesce(
    nullif(trim(auth.jwt() -> 'user_metadata' ->> 'username'), ''),
    'Utilizator'
  );
begin
  if v_user_id is null then
    raise exception 'Authentication is required';
  end if;
  -- p_user_name și p_points rămân opționale doar ca să nu se rupă clienții
  -- vechi. Nici una dintre valori nu e citită.
  perform public.recalculate_score_for_user(v_user_id, v_name);
end;
$$;

create or replace function public.recalculate_scores_after_event_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select distinct user_id
    from new_events
    where user_id is not null
  loop
    perform public.recalculate_score_for_user(v_user_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists events_recalculate_scores on public.events;
create trigger events_recalculate_scores
after insert on public.events
referencing new table as new_events
for each statement
execute function public.recalculate_scores_after_event_insert();

-- ----------------------------------------------------------- clasament -------
-- `p_offset` exista în apelul clientului (js/tracker.js) dar nu și în funcție.
-- PostgREST rezolvă RPC-urile pe potrivirea EXACTĂ a numelor argumentelor, deci
-- fiecare cerere primea PGRST202 și clasamentul nu se încărca niciodată.
--
-- Păstrează și separarea pe domenii din 20260824_leaderboard_domain_split.sql,
-- care se pierdea la o reaplicare în ordine alfabetică a directorului
-- (`domain_split` < `user_id`, deși intenția era invers).

drop function if exists public.get_public_leaderboard(integer);
drop function if exists public.get_public_leaderboard(integer, integer);

create function public.get_public_leaderboard(
  p_limit integer default 5,
  p_offset integer default 0
)
returns table(user_id uuid, user_name text, points integer)
language sql
stable
security definer
set search_path = 'public', 'pg_temp'
as $function$
  select s.user_id, s.user_name::text, s.points::integer
  from public.scores s
  join auth.users u on u.id = s.user_id
  where s.user_name is not null
    and lower(u.email) like '%@' || (
      case
        when lower(auth.jwt() ->> 'email') like '%@citim.app' then 'citim.app'
        else 'test.com'
      end
    )
  -- user_id în ORDER BY: fără el, două scoruri egale pot să-și schimbe locul
  -- între pagini, deci paginarea cu OFFSET ar sări sau dubla rânduri.
  order by s.points desc, s.user_name asc, s.user_id asc
  limit greatest(1, least(coalesce(p_limit, 5), 1000))
  offset greatest(0, coalesce(p_offset, 0));
$function$;

-- Ecranul de statistici cere deja autentificare (js/app.js: renderStats), deci
-- clasamentul nu mai e expus și rolului anonim.
revoke all on function public.get_public_leaderboard(integer, integer) from public;
grant execute on function public.get_public_leaderboard(integer, integer) to authenticated;

revoke all on function public.verse_total_pages() from public;
revoke all on function public.completed_page_count(uuid, integer, timestamptz) from public;
revoke all on function public.compute_user_points(uuid, timestamptz) from public;
revoke all on function public.recalculate_score_for_user(uuid, text) from public;
revoke all on function public.recalculate_scores_after_event_insert() from public;
revoke all on function public.verify_event_before_insert() from public;
revoke all on function public.upsert_own_score(text, integer) from public;
grant execute on function public.upsert_own_score(text, integer) to authenticated;

-- --------------------------------------------------------------- backfill ----

-- Ciclul devine ștampilat de server. Un utilizator care terminase deja cartea
-- avea local cycle=1; fără preluarea valorii, evenimentele noi ar fi fost
-- ștampilate cu 0 și s-ar fi ciocnit cu cele vechi (puncte o dată per ciclu),
-- deci reluarea cărții nu i-ar mai fi adus nimic.
update public.scores s
set current_cycle = greatest(
  s.current_cycle,
  coalesce((select max(coalesce(e.cycle, 0)) from public.events e where e.user_id = s.user_id), 0)
);

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
