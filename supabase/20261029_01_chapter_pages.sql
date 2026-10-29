-- Fiecare capitol incepe o pagina noua (maximum 5 versete/pagina).
-- Se ruleaza atomic pe cheia EXISTENTA: nu aplica separat cheia regenerata
-- pe live inaintea acestei migrari. Referintele si raspunsurile nu se schimba.
begin;

lock table public.events, public.scores, public.verse_answers in share row exclusive mode;

create temporary table ci_chapter_paging_scores on commit drop as
select user_id, points from public.scores;
alter table ci_chapter_paging_scores enable row level security;

with chapters as (
  select chapter_ref, min(ordinal) as first_ordinal, count(*)::integer as verse_count
  from public.verse_answers group by chapter_ref
), offsets as (
  select chapter_ref, verse_count,
    coalesce(sum((verse_count + 4) / 5) over (
      order by first_ordinal rows between unbounded preceding and 1 preceding
    ), 0)::integer as page_offset
  from chapters
), positions as (
  select verse_ref, chapter_ref,
    (row_number() over (partition by chapter_ref order by ordinal) - 1)::integer as chapter_position
  from public.verse_answers
)
update public.verse_answers v
set page_index = o.page_offset + p.chapter_position / 5,
    page_size = least(5, o.verse_count - (p.chapter_position / 5) * 5),
    chapter_size = o.verse_count
from positions p join offsets o using (chapter_ref)
where v.verse_ref = p.verse_ref;

update public.events e
set page_index = v.page_index, page_size = v.page_size,
    chapter_ref = v.chapter_ref, chapter_size = v.chapter_size
from public.verse_answers v
where e.verse_ref = v.verse_ref
  and (e.page_index, e.page_size, e.chapter_ref, e.chapter_size)
      is distinct from (v.page_index, v.page_size, v.chapter_ref, v.chapter_size);

-- Noua grupare poate modifica bonusurile istorice de pagina. Pastram exact
-- totalurile deja castigate prin offset-ul baseline_points (poate fi semnat).
-- baseline_at ramane neschimbat: versetele deja corecte NU primesc credit nou.
update public.scores s
set baseline_points = previous.points - public.compute_user_points(
  s.user_id, coalesce(s.baseline_at, 'epoch'::timestamptz)
)
from ci_chapter_paging_scores previous
where s.user_id = previous.user_id;

do $$
declare v_user_id uuid;
begin
  for v_user_id in select user_id from ci_chapter_paging_scores loop
    perform public.recalculate_score_for_user(v_user_id);
  end loop;
  if exists (
    select 1 from public.scores s join ci_chapter_paging_scores previous using (user_id)
    where s.points <> previous.points
  ) then
    raise exception 'Chapter pagination must preserve existing scores';
  end if;
  if exists (
    select page_index from public.verse_answers group by page_index
    having count(distinct chapter_ref) <> 1 or count(*) <> min(page_size)
      or min(page_size) <> max(page_size) or count(*) not between 1 and 5
  ) then
    raise exception 'Each page must contain 1-5 verses from exactly one chapter';
  end if;
end;
$$;

commit;
