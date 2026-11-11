-- Numele conturilor create fără metadata.username folosește identificatorul
-- intern @citim.app / @test.com, la fel ca Auth.extractUsername din browser.
begin;

create or replace function public.account_display_name(p_user_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select coalesce(
      nullif(trim(u.raw_user_meta_data ->> 'username'), ''),
      case when u.email ~* '@(citim\.app|test\.com)$'
        then nullif(split_part(u.email, '@', 1), '') end
    ) from auth.users u where u.id = p_user_id),
    (select nullif(nullif(trim(s.user_name), ''), 'Utilizator')
      from public.scores s where s.user_id = p_user_id),
    'Utilizator'
  );
$$;

create or replace function public.stamp_account_display_name()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.user_name := public.account_display_name(new.user_id);
  return new;
end;
$$;

-- Rulează după verificarea evenimentului, care stabilește user_id autoritativ.
drop trigger if exists zz_events_account_display_name on public.events;
create trigger zz_events_account_display_name before insert on public.events
  for each row execute function public.stamp_account_display_name();
drop trigger if exists zz_scores_account_display_name on public.scores;
create trigger zz_scores_account_display_name before insert or update on public.scores
  for each row execute function public.stamp_account_display_name();

revoke all on function public.account_display_name(uuid) from public, anon, authenticated;
revoke all on function public.stamp_account_display_name() from public, anon, authenticated;

-- Reparație exclusiv de nume, fără recalcularea punctajelor sau a ciclurilor.
update public.scores s set user_name = public.account_display_name(s.user_id)
where s.user_name is distinct from public.account_display_name(s.user_id);

commit;
