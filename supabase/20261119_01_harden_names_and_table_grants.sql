-- 1) Numele din clasament nu mai poate fi ales liber de utilizator.
--
-- account_display_name() lua mai întâi raw_user_meta_data->>'username'. Orice
-- utilizator logat își poate schimba metadatele (auth.updateUser({data:...})),
-- deci își putea pune numele altui participant sau unul jignitor, iar triggerul
-- zz_scores_account_display_name îl copia în clasament.
--
-- Acum numele din metadate se folosește doar dacă, transformat exact ca la
-- înregistrare (trim, litere mici, spațiile -> '_'), coincide cu partea locală a
-- adresei contului, pe care utilizatorul nu o poate schimba. Altfel se ia
-- partea locală a adresei. Verificat pe producție la 2026-11-19: din 39 de
-- conturi, 36 au metadate consistente, 3 nu au metadate, 0 inconsistente, deci
-- niciun nume afișat azi nu se schimbă.
-- Adresele din alt domeniu nu se afișează niciodată (ar publica emailul), iar
-- metadatele lor nu pot fi verificate: apar ca 'Utilizator'. Pe producție nu
-- există astfel de conturi (verificat la 2026-11-19). Nu se mai păstrează numele
-- vechi din scores, ca un nume falsificat anterior să nu rămână definitiv.
--
-- LIMITĂ CUNOSCUTĂ: regula împiedică schimbarea ulterioară a numelui, dar nu
-- poate împiedica o înregistrare nouă cu același nume (aplicația permite deja
-- sergiu@citim.app și sergiu@test.com, ambele afișate „Sergiu”). Nume unice se
-- obțin doar printr-o regulă de unicitate la înregistrare: decizie de produs.
begin;

create or replace function public.account_display_name(p_user_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when u.email ~* '@(citim\.app|test\.com)$' then
        coalesce(
          case when nullif(trim(u.raw_user_meta_data ->> 'username'), '') is not null
                and lower(regexp_replace(trim(u.raw_user_meta_data ->> 'username'), '\s+', '_', 'g'))
                    = lower(split_part(u.email, '@', 1))
            then trim(u.raw_user_meta_data ->> 'username') end,
          nullif(split_part(u.email, '@', 1), ''))
      end
     from auth.users u where u.id = p_user_id),
    'Utilizator'
  );
$$;

revoke all on function public.account_display_name(uuid) from public, anon, authenticated;

-- Reparație exclusiv de nume, fără recalcularea punctajelor sau a ciclurilor.
update public.scores s set user_name = public.account_display_name(s.user_id)
where s.user_name is distinct from public.account_display_name(s.user_id);

-- 2) Drepturi pe tabele reduse la strictul necesar.
--
-- Supabase acordă implicit ALL (inclusiv TRUNCATE) lui anon și authenticated pe
-- tabelele noi; RLS blochează azi scrierile, dar e singura linie de apărare, iar
-- orice politică permisivă adăugată ulterior le-ar deschide. Aplicația folosește
-- doar: POST pe events, GET pe events/scores/reading_profiles și RPC-uri
-- (SECURITY DEFINER, deci nu depind de drepturile pe tabele).
-- verse_answers este cheia de răspunsuri; app_config e citit public.
-- Tabelele care există doar pe producție sunt tratate condiționat.
do $$
begin
  if to_regclass('public.verse_answers') is not null then
    revoke all on table public.verse_answers from anon, authenticated;
  end if;
  if to_regclass('public.events') is not null then
    revoke all on table public.events from anon, authenticated;
    grant select, insert on table public.events to authenticated;
  end if;
  if to_regclass('public.scores') is not null then
    revoke all on table public.scores from anon, authenticated;
    grant select on table public.scores to authenticated;
  end if;
  if to_regclass('public.reading_profiles') is not null then
    revoke all on table public.reading_profiles from anon, authenticated;
    grant select on table public.reading_profiles to authenticated;
  end if;
  if to_regclass('public.app_config') is not null then
    revoke insert, update, delete, truncate, references, trigger
      on table public.app_config from anon, authenticated;
  end if;
end $$;

commit;
