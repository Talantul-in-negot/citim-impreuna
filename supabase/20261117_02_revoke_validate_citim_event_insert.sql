-- validate_citim_event_insert() este funcția triggerului live
-- events_validate_citim_insert (vezi supabase/live-only/). Funcțiile de trigger
-- nu pot fi apelate direct, dar fiindcă a fost creată în afara repo-ului a
-- păstrat EXECUTE pentru anon și authenticated (privilegiile implicite
-- Supabase). Triggerul rulează ca proprietar și nu depinde de aceste drepturi.
-- Pe o bază fără funcție (bază nouă) nu face nimic. Sigur la rulări repetate.
begin;
do $$
begin
  if to_regprocedure('public.validate_citim_event_insert()') is null then
    raise notice 'public.validate_citim_event_insert() lipsește; nimic de făcut';
    return;
  end if;
  revoke all on function public.validate_citim_event_insert() from public, anon, authenticated;
end $$;
commit;
