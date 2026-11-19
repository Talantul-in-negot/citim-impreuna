-- Limită de viteză pe răspunsurile corecte: cel mult 1000 într-o fereastră de
-- 24 de ore, per cont.
--
-- Cheia de răspunsuri ajunge în aplicație (jocul merge și offline), deci un
-- script poate trimite răspunsurile corecte în ordine și poate parcurge un
-- ciclu întreg în minute, repetat la nesfârșit. Limita nu oprește un script
-- hotărât, dar îi plafonează câștigul la ~2/3 dintr-un ciclu pe zi.
--
-- De ce 1000 pe 24 h și nu o limită pe oră: recorded_at este momentul inserării,
-- iar un lot offline trimis după reconectare apare ca o rafală. Pe producție,
-- la 2026-11-19, maximul a fost 740 de răspunsuri corecte într-o oră și 775
-- într-o zi (p99: 287 pe oră, 426 pe zi), deci o limită orară ar bloca citiri
-- legitime. 1000 pe 24 h le lasă loc.
--
-- Refuzul nu duce la pierderea răspunsurilor: clientul tratează orice eroare
-- în afara STALE_READING_* ca temporară și păstrează coada, iar fereastra
-- glisantă eliberează locuri pe măsură ce trece timpul.
--
-- Ordine triggere BEFORE INSERT (alfabetică): events_validate_citim_insert,
-- events_verify_before_insert (stabilește user_id și correct, întoarce NULL
-- pentru duplicate), events_verify_rate_limit (acesta), zz_events_account_display_name.
-- Un lot offline e un singur INSERT cu mai multe rânduri: dacă un rând depășește
-- limita, tot lotul eșuează și rămâne în coada clientului până se eliberează
-- fereastra. Serializarea pe cont o face advisory lock-ul luat în
-- verify_event_before_insert, care rulează înaintea acestui trigger (ordinea
-- depinde de sortarea alfabetică a numelor: 'events_verify_b' < 'events_verify_r').
-- Modificarea pragului: editează constanta v_limit și rulează din nou.
begin;

-- Numărătoarea de mai jos filtrează după user_id și recorded_at.
-- Parțial (doar răspunsurile corecte), deci mic și potrivit exact numărătorii.
create index if not exists events_user_recorded_idx on public.events (user_id, recorded_at)
  where correct is true;

create or replace function public.enforce_event_rate_limit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_limit constant integer := 1000;
  v_recent integer;
begin
  if new.correct is not true or new.user_id is null then return new; end if;
  select count(*) into v_recent from public.events e
  where e.user_id = new.user_id and e.correct is true
    and e.recorded_at > now() - interval '24 hours';
  if v_recent >= v_limit then
    -- PT429 = HTTP 429 prin PostgREST; clientul îl tratează ca temporar.
    raise exception using message = 'Daily answer limit reached; try again later',
      detail = 'RATE_LIMITED', errcode = 'PT429';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_event_rate_limit() from public, anon, authenticated;

drop trigger if exists events_verify_rate_limit on public.events;
create trigger events_verify_rate_limit before insert on public.events
  for each row execute function public.enforce_event_rate_limit();

commit;
