// Generează supabase/20261126_01_epistle_curated_answers.sql.
//
// Cuvântul de completat din epistole a fost ales de mână (scripts/epistle-choices.json),
// deci răspunsul corect se schimbă la multe versete. Serverul verifică răspunsul în
// două locuri: public.verse_answers (verify_event_before_insert) și, pe producție,
// public.citim_verse_catalog (validate_citim_event_insert). Migrarea:
//  1. păstrează răspunsul vechi al fiecărui verset schimbat în public.verse_answer_legacy;
//  2. actualizează răspunsul în verse_answers și în catalog și adaugă variantele noi
//     la cele acceptate (cele vechi rămân acceptate);
//  3. adaugă triggerul events_accept_legacy_answer, care rulează înaintea celorlalte
//     (ordine alfabetică) și traduce un răspuns trimis de o aplicație veche (sau aflat
//     în coada offline) în răspunsul nou, ca să nu fie respins și să fie punctat corect.
// 20261110_01 și 20261125_01, deja aplicate, rămân înghețate. Rulează pe producție
// ÎNAINTE de publicarea aplicației cu cuvintele noi. Sigur la rulări repetate.
//
// node scripts/build-epistle-answers.js [--check]
const fs = require('node:fs');
const path = require('node:path');
const { loadEpistles, BOOK_ORDER } = require('./build-epistle-answer-key');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'supabase/20261126_01_epistle_curated_answers.sql');
const FROZEN_KEY = path.join(ROOT, 'supabase/20261110_01_epistle_answer_key.sql');

// Răspunsurile publicate până acum, din migrarea aplicată în producție.
function frozenAnswers() {
  const sql = fs.readFileSync(FROZEN_KEY, 'utf8');
  return new Map([...sql.matchAll(/^  \('((?:[^']|'')+)', \d+, '((?:[^']|'')*)', /gm)]
    .map((m) => [m[1].replace(/''/g, "'"), m[2].replace(/''/g, "'")]));
}

function answerRows() {
  const books = loadEpistles();
  const before = frozenAnswers();
  return BOOK_ORDER.flatMap((id) => books[id]).map((verse) => {
    const { answer, options } = verse.blanks[0];
    if (!before.has(verse.ref)) throw new Error(`${verse.ref}: lipsește din 20261110_01`);
    if (options.length !== 4 || !options.includes(answer)) throw new Error(`${verse.ref}: variante invalide`);
    return { ref: verse.ref, answer, previous: before.get(verse.ref), options: [...options] };
  });
}

function renderSql(rows) {
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const values = rows
    .map((row) => `      (${quote(row.ref)}, ${quote(row.answer)}, array[${row.options.map(quote).join(', ')}]::text[])`)
    .join(',\n');
  const changed = rows.filter((row) => row.answer !== row.previous).length;
  return [
    '-- GENERAT de scripts/build-epistle-answers.js. Nu modifica manual.',
    `-- Cuvinte de completat alese de mână în epistole: ${changed} din ${rows.length} versete au alt răspuns.`,
    '-- Răspunsurile vechi rămân acceptate (aplicații neactualizate, coada offline). Rulează',
    '-- ÎNAINTE de publicarea aplicației. Sigur la rulări repetate.',
    'begin;',
    '',
    'create table if not exists public.verse_answer_legacy (',
    '  verse_ref text not null references public.verse_answers (verse_ref) on delete cascade,',
    '  answer text not null,',
    '  primary key (verse_ref, answer)',
    ');',
    'alter table public.verse_answer_legacy enable row level security;',
    'revoke all on table public.verse_answer_legacy from public, anon, authenticated;',
    '',
    '-- Un răspuns trimis cu cuvântul vechi devine răspunsul cu cuvântul nou. Varianta',
    '-- aleasă se traduce doar dacă era chiar cuvântul vechi (adică răspuns corect);',
    '-- o variantă greșită veche rămâne greșită și e încă acceptată de catalog.',
    'create or replace function public.accept_legacy_answer()',
    'returns trigger language plpgsql security definer set search_path = public, pg_temp as $$',
    'declare',
    '  v_current text;',
    'begin',
    '  if new.answer is null or not exists (',
    '    select 1 from public.verse_answer_legacy l',
    '    where l.verse_ref = new.verse_ref and l.answer = new.answer',
    '  ) then',
    '    return new;',
    '  end if;',
    '  select v.answer into v_current from public.verse_answers v where v.verse_ref = new.verse_ref;',
    '  if v_current is null or v_current = new.answer then return new; end if;',
    '  if new.chosen = new.answer then new.chosen := v_current; end if;',
    '  new.answer := v_current;',
    '  return new;',
    'end;',
    '$$;',
    'revoke all on function public.accept_legacy_answer() from public, anon, authenticated;',
    '',
    '-- Numele sortează înaintea lui events_validate_citim_insert și events_verify_before_insert.',
    'drop trigger if exists events_accept_legacy_answer on public.events;',
    'create trigger events_accept_legacy_answer before insert on public.events',
    '  for each row execute function public.accept_legacy_answer();',
    '',
    'create temporary table epistle_answers_20261126 (verse_ref text primary key, answer text not null, choices text[] not null) on commit drop;',
    'insert into epistle_answers_20261126 (verse_ref, answer, choices) values',
    values.replace(/^      /gm, '  ') + ';',
    '',
    'do $$',
    'declare',
    '  v_missing integer;',
    'begin',
    '  lock table public.verse_answers in share row exclusive mode;',
    '  insert into public.verse_answer_legacy (verse_ref, answer)',
    '  select v.verse_ref, v.answer from public.verse_answers v',
    '  join epistle_answers_20261126 n using (verse_ref)',
    '  where v.answer <> n.answer',
    '  on conflict do nothing;',
    '  update public.verse_answers v set answer = n.answer',
    '  from epistle_answers_20261126 n',
    '  where v.verse_ref = n.verse_ref and v.answer <> n.answer;',
    '  -- Pe o bază fără epistole (bază nouă, înainte de 20261110_01) nu e nimic de verificat.',
    '  select count(*) into v_missing from epistle_answers_20261126 n',
    '  join public.verse_answers v using (verse_ref) where v.answer <> n.answer;',
    "  if v_missing > 0 then raise exception 'Răspunsuri epistole: % neactualizate', v_missing; end if;",
    '',
    "  if to_regclass('public.citim_verse_catalog') is null then return; end if;",
    '  lock table public.citim_verse_catalog in share row exclusive mode;',
    '  update public.citim_verse_catalog c',
    '  set correct_answer = n.answer,',
    '      valid_choices = c.valid_choices || array(',
    '        select t.choice from unnest(n.choices) with ordinality as t(choice, position)',
    '        where not (t.choice = any(c.valid_choices)) order by t.position)',
    '  from epistle_answers_20261126 n',
    '  where c.verse_ref = n.verse_ref',
    '    and (c.correct_answer <> n.answer or not (n.choices <@ c.valid_choices));',
    '  select count(*) into v_missing from epistle_answers_20261126 n',
    '  join public.citim_verse_catalog c using (verse_ref)',
    '  where c.correct_answer <> n.answer or not (n.choices <@ c.valid_choices);',
    "  if v_missing > 0 then raise exception 'Catalog epistole: % neactualizate', v_missing; end if;",
    'end;',
    '$$;',
    'commit;',
    '',
  ].join('\n');
}

if (require.main === module) {
  const rows = answerRows();
  const sql = renderSql(rows);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') !== sql) {
      throw new Error('Răspunsurile epistolelor trebuie regenerate: node scripts/build-epistle-answers.js');
    }
    console.log(`Răspunsurile epistolelor verificate: ${rows.length} versete.`);
  } else {
    fs.writeFileSync(OUTPUT, sql, 'utf8');
    console.log(`Răspunsurile epistolelor generate: ${rows.length} versete, ${rows.filter((r) => r.answer !== r.previous).length} schimbate.`);
  }
}

module.exports = { answerRows, renderSql, OUTPUT };
