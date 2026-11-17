-- REFERINȚĂ, citită din producție la 2026-11-17. Vezi README.md din acest folder.

create table if not exists public.citim_verse_catalog (
  verse_ref text primary key,
  correct_answer text not null,
  valid_choices text[] not null check (cardinality(valid_choices) = 4),
  page_index integer not null check (page_index >= 0),
  page_size smallint not null check (page_size >= 1 and page_size <= 5),
  chapter_ref text not null,
  chapter_size smallint not null check (chapter_size >= 1 and chapter_size <= 100)
);
alter table public.citim_verse_catalog enable row level security;

CREATE OR REPLACE FUNCTION public.validate_citim_event_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
declare
  v_answer text; v_choices text[]; v_page_index integer; v_page_size smallint;
  v_chapter_ref text; v_chapter_size smallint; v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    raise exception 'Events may only be created for the authenticated user';
  end if;
  select c.correct_answer, c.valid_choices, c.page_index, c.page_size, c.chapter_ref, c.chapter_size
    into v_answer, v_choices, v_page_index, v_page_size, v_chapter_ref, v_chapter_size
    from public.citim_verse_catalog c where c.verse_ref = new.verse_ref;
  if not found then raise exception 'Unknown verse reference'; end if;
  if new.chosen is null or not (new.chosen = any(v_choices)) then
    raise exception 'Chosen answer is not a valid option for this verse';
  end if;
  if new.answer is distinct from v_answer then
    raise exception 'Submitted answer does not match the canonical answer';
  end if;
  if new.correct is distinct from (new.chosen = v_answer) then
    raise exception 'Submitted correctness does not match the chosen answer';
  end if;
  if coalesce(new.cycle, 0) < 0 then raise exception 'Cycle must not be negative'; end if;
  -- Do not permit the browser to choose scoring metadata or event times.
  new.page_index := v_page_index; new.page_size := v_page_size;
  new.chapter_ref := v_chapter_ref; new.chapter_size := v_chapter_size;
  new.recorded_at := v_now; new.created_at := v_now;
  new.user_name := coalesce(nullif(trim(auth.jwt() -> 'user_metadata' ->> 'username'), ''), nullif(trim(new.user_name), ''), 'Utilizator');
  return new;
end;
$function$;

-- Reformatat pentru lizibilitate; semantica este cea din producție.
CREATE TRIGGER events_validate_citim_insert BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION validate_citim_event_insert();
