-- completed_page_count() filtra dupa `recorded_at > p_baseline_at`, ca să nu
-- dubleze PUNCTELE (baseline_points acoperă deja tot ce s-a întâmplat până la
-- baseline_at — vezi 20260813_server_derived_scores.sql). Dar funcția asta nu
-- calculează puncte — decide dacă o pagină a fost CITITĂ vreodată până la
-- capăt, o întrebare despre istoricul real de citire, nu despre bani.
--
-- Efect: orice pagină terminată (răspunsuri corecte la toate versetele)
-- exclusiv ÎNAINTE de baseline_at nu se putea număra niciodată ca terminată,
-- indiferent cât se continua cititul după — confirmat live, pe un cont cu
-- 1505/1505 versete corecte (istoric complet): 27 din 301 pagini erau
-- terminate doar înainte de baseline, ceea ce ținea `current_cycle` blocat pe
-- 0 la nesfârșit, chiar și după backfill-ul de page_index din
-- 20260907_01_backfill_event_page_index.sql.
--
-- `compute_user_points()` — funcția care CHIAR calculează punctele — rămâne
-- complet neatinsă; filtrarea ei după baseline_at e corectă și necesară.
--
-- Semnătura rămâne cu 3 parametri (compatibilă cu apelanții existenți din
-- 20260903_02_server_verified_events.sql — trigger-ul și
-- recalculate_score_for_user); p_baseline_at e acceptat dar ignorat.
--
-- NECESITĂ: 20260903_02_server_verified_events.sql.

begin;

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
      and e.page_index is not null
    group by e.page_index
    having count(distinct e.verse_ref) >= coalesce(max(e.page_size), 5)
  ) done;
$$;

-- Recalculează — scorul rămâne identic (compute_user_points e neschimbat),
-- dar ciclul se poate acum, în sfârșit, avansa corect prin plasa de
-- siguranță din recalculate_score_for_user.
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
