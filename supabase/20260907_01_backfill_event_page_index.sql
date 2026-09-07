-- Repară `events.page_index` / `page_size` / `chapter_ref` / `chapter_size`
-- NULL pe rândurile scrise înainte de `20260813_server_derived_scores.sql`
-- (care a adăugat page_index/page_size) și `20260813_daily_chapter_streak_bonus.sql`
-- (chapter_ref/chapter_size) — ambele cu `alter table ... add column`, fără
-- niciun backfill pentru rândurile deja existente.
--
-- Efect live, confirmat empiric pe un cont care terminase de mult întreaga
-- carte (1505/1505 versete unice corecte, verificat client-side din
-- verse_ref): `completed_page_count()` (20260903_02_server_verified_events.sql)
-- cere explicit `e.page_index is not null`, deci orice pagină compusă din
-- evenimente dinainte de migrarea care a adăugat coloana nu putea fi
-- numărată NICIODATĂ ca terminată pe server. Rezultat: `scores.current_cycle`
-- rămânea blocat pe 0 la nesfârșit — triggerul de la fiecare insert nou
-- recalcula mereu „cartea nu e completă" și ștampila tot ce urma tot cu
-- ciclul 0, oricât de mult se continua cititul. Clientul, care reconstruiește
-- pagina din `verse_ref` (nu din `page_index`-ul stocat), vedea cartea 100%
-- terminată și arăta mereu ecranul de final — vezi tasks/lessons.md.
--
-- NECESITĂ: 20260903_01_verse_answer_key.sql (sursa valorilor corecte) și
-- 20260903_02_server_verified_events.sql (completed_page_count,
-- recalculate_score_for_user).

begin;

update public.events e
set page_index   = v.page_index,
    page_size    = v.page_size,
    chapter_ref  = v.chapter_ref,
    chapter_size = v.chapter_size
from public.verse_answers v
where e.verse_ref = v.verse_ref
  and e.page_index is null;

-- Recalculează scorul — și, prin plasa de siguranță din
-- recalculate_score_for_user (fișierul 02), ciclul — pentru fiecare
-- utilizator afectat. Fără asta, cine era deja blocat pe ciclul 0 rămâne
-- blocat până la următorul lui răspuns (care ar fi declanșat oricum
-- verificarea, dar de ce să aștepte).
do $$
declare
  v_user_id uuid;
begin
  for v_user_id in
    select distinct user_id from public.events where user_id is not null
  loop
    perform public.recalculate_score_for_user(v_user_id);
  end loop;
end;
$$;

commit;
