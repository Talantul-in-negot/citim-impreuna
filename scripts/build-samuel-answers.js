// Generează supabase/20261127_01_samuel_fixes.sql din corecturile Samuel
// (scripts/samuel-choices.json, aplicate în js/verses-*samuel.js).
//
// Folosește mecanismul din 20261126_01 (verse_answer_legacy + triggerul
// events_accept_legacy_answer): răspunsul vechi al unui verset schimbat rămâne
// acceptat și e tradus în cel nou, iar variantele noi se adaugă la cele acceptate
// de catalogul live (cele vechi rămân). 20260903_01, deja aplicată, rămâne
// înghețată. Rulează pe producție ÎNAINTE de publicarea aplicației.
//
// node scripts/build-samuel-answers.js [--check]
const fs = require('node:fs');
const path = require('node:path');
const { loadVerses } = require('./build-answer-key');
const { loadChoices } = require('./apply-samuel-choices');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'supabase/20261127_01_samuel_fixes.sql');
const FROZEN_KEY = path.join(ROOT, 'supabase/20260903_01_verse_answer_key.sql');

function frozenAnswers() {
  const sql = fs.readFileSync(FROZEN_KEY, 'utf8');
  return new Map([...sql.matchAll(/^  \('((?:[^']|'')+)', \d+, '((?:[^']|'')*)', /gm)]
    .map((m) => [m[1].replace(/''/g, "'"), m[2].replace(/''/g, "'")]));
}

function fixRows() {
  const choices = loadChoices();
  const before = frozenAnswers();
  const verses = new Map(loadVerses().map((v) => [v.ref, v]));
  return [...choices.keys()].map((ref) => {
    const verse = verses.get(ref);
    if (!verse) throw new Error(`${ref}: verset inexistent`);
    if (!before.has(ref)) throw new Error(`${ref}: lipsește din 20260903_01`);
    const { answer, options } = verse.blanks[0];
    if (answer !== choices.get(ref)[0]) {
      throw new Error(`${ref}: corectura nu e aplicată; rulează node scripts/apply-samuel-choices.js`);
    }
    return { ref, answer, previous: before.get(ref), options: [...options] };
  });
}

function renderSql(rows) {
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const changed = rows.filter((row) => row.answer !== row.previous).length;
  return [
    '-- GENERAT de scripts/build-samuel-answers.js. Nu modifica manual.',
    `-- Corecturi în 1 și 2 Samuel: ${rows.length} versete (${changed} cu alt cuvânt de completat, restul doar`,
    '-- cu alte variante greșite). Răspunsurile și variantele vechi rămân acceptate.',
    '-- Necesită 20261126_01. Rulează ÎNAINTE de publicarea aplicației. Sigur la rulări repetate.',
    'begin;',
    "set local lock_timeout = '5s';",
    '',
    'create temporary table samuel_fixes_20261127 (verse_ref text primary key, answer text not null, choices text[] not null) on commit drop;',
    'insert into samuel_fixes_20261127 (verse_ref, answer, choices) values',
    rows.map((row) => `  (${quote(row.ref)}, ${quote(row.answer)}, array[${row.options.map(quote).join(', ')}]::text[])`).join(',\n') + ';',
    '',
    'do $$',
    'declare',
    '  v_missing integer;',
    'begin',
    "  if to_regclass('public.verse_answer_legacy') is null or not exists (",
    "    select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'events_accept_legacy_answer'",
    "  ) then",
    "    raise exception 'Rulează întâi 20261126_01_epistle_curated_answers.sql';",
    '  end if;',
    '  lock table public.verse_answers in share row exclusive mode;',
    '  insert into public.verse_answer_legacy (verse_ref, answer)',
    '  select v.verse_ref, v.answer from public.verse_answers v',
    '  join samuel_fixes_20261127 n using (verse_ref)',
    '  where v.answer <> n.answer',
    '  on conflict do nothing;',
    '  update public.verse_answers v set answer = n.answer',
    '  from samuel_fixes_20261127 n',
    '  where v.verse_ref = n.verse_ref and v.answer <> n.answer;',
    '  select count(*) into v_missing from samuel_fixes_20261127 n',
    '  join public.verse_answers v using (verse_ref) where v.answer <> n.answer;',
    "  if v_missing > 0 then raise exception 'Răspunsuri Samuel: % neactualizate', v_missing; end if;",
    '',
    "  if to_regclass('public.citim_verse_catalog') is null then return; end if;",
    '  lock table public.citim_verse_catalog in share row exclusive mode;',
    '  update public.citim_verse_catalog c',
    '  set correct_answer = n.answer,',
    '      valid_choices = c.valid_choices || array(',
    '        select t.choice from unnest(n.choices) with ordinality as t(choice, position)',
    '        where not (t.choice = any(c.valid_choices)) order by t.position)',
    '  from samuel_fixes_20261127 n',
    '  where c.verse_ref = n.verse_ref',
    '    and (c.correct_answer <> n.answer or not (n.choices <@ c.valid_choices));',
    '  select count(*) into v_missing from samuel_fixes_20261127 n',
    '  join public.citim_verse_catalog c using (verse_ref)',
    '  where c.correct_answer <> n.answer or not (n.choices <@ c.valid_choices);',
    "  if v_missing > 0 then raise exception 'Catalog Samuel: % neactualizate', v_missing; end if;",
    'end;',
    '$$;',
    'commit;',
    '',
  ].join('\n');
}

if (require.main === module) {
  const rows = fixRows();
  const sql = renderSql(rows);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') !== sql) {
      throw new Error('Corecturile Samuel trebuie regenerate: node scripts/build-samuel-answers.js');
    }
    console.log(`Corecturile Samuel verificate: ${rows.length} versete.`);
  } else {
    fs.writeFileSync(OUTPUT, sql, 'utf8');
    console.log(`Corecturile Samuel generate: ${rows.length} versete, ${rows.filter((r) => r.answer !== r.previous).length} cu răspuns nou.`);
  }
}

module.exports = { fixRows, renderSql, OUTPUT };
