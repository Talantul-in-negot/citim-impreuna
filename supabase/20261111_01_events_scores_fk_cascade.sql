-- Ștergerea unui cont din dashboard eșua ("Failed to delete user") dacă avea
-- răspunsuri sau scor: în baza live, FK-urile events.user_id și scores.user_id
-- spre auth.users erau NO ACTION. Tabelele fuseseră create manual înainte de
-- migrații, iar 00000000_baseline_schema.sql folosește `create table if not
-- exists`, deci `on delete cascade` din repo nu s-a aplicat niciodată pe live
-- (descoperit pe 2026-11-11). reading_profiles, sesiunile și identitățile se
-- ștergeau deja în cascadă.
--
-- Recreează cele două FK-uri cu `on delete cascade`. Caută numele constrângerii
-- în catalog (pe live nu e cunoscut), așa că merge oricum se numesc. Idempotentă:
-- dacă FK-ul e deja în cascadă, nu face nimic. Nu modifică niciun rând.
begin;

do $$
declare
  v_table text;
  v_constraint record;
begin
  foreach v_table in array array['events', 'scores'] loop
    if exists (
      select 1 from pg_constraint
      where conrelid = ('public.' || v_table)::regclass
        and contype = 'f' and confrelid = 'auth.users'::regclass and confdeltype = 'c'
    ) then
      continue;
    end if;

    for v_constraint in
      select conname from pg_constraint
      where conrelid = ('public.' || v_table)::regclass
        and contype = 'f' and confrelid = 'auth.users'::regclass
    loop
      execute format('alter table public.%I drop constraint %I', v_table, v_constraint.conname);
    end loop;

    execute format(
      'alter table public.%I add constraint %I foreign key (user_id) references auth.users (id) on delete cascade',
      v_table, v_table || '_user_id_fkey'
    );
  end loop;

  -- Verificare finală: ambele FK-uri trebuie să existe și să fie în cascadă.
  if (
    select count(*) from pg_constraint
    where conrelid in ('public.events'::regclass, 'public.scores'::regclass)
      and contype = 'f' and confrelid = 'auth.users'::regclass and confdeltype = 'c'
  ) <> 2 then
    raise exception 'events/scores trebuie să aibă exact câte un FK cascade spre auth.users';
  end if;
end;
$$;

commit;
