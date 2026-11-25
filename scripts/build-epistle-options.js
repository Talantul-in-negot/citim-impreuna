// Generează supabase/20261125_01_epistle_options.sql.
//
// Triggerul live validate_citim_event_insert acceptă un răspuns doar dacă
// varianta aleasă este în public.citim_verse_catalog.valid_choices. Când
// generatorul schimbă variantele greșite, catalogul trebuie să le accepte pe
// cele noi FĂRĂ să le respingă pe cele vechi: telefoanele cu aplicația veche și
// răspunsurile aflate în coada offline trimit încă variantele vechi, iar un
// refuz ar bloca coada. De aceea migrarea reunește listele (și relaxează
// constrângerea „exact 4"). 20261110_03, deja aplicată, rămâne neschimbată.
// Trebuie rulată pe producție ÎNAINTE de publicarea aplicației cu variantele noi.
//
// node scripts/build-epistle-options.js [--check]
const fs = require('node:fs');
const path = require('node:path');
const { catalogChoices } = require('./build-epistle-catalog');

const OUTPUT = path.join(__dirname, '..', 'supabase/20261125_01_epistle_options.sql');

function renderSql(rows) {
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const values = rows
    .map((row) => `      (${quote(row.ref)}, array[${row.options.map(quote).join(', ')}]::text[])`)
    .join(',\n');
  return [
    '-- GENERAT de scripts/build-epistle-options.js. Nu modifica manual.',
    '-- Adaugă variantele noi ale epistolelor în catalogul triggerului live, păstrându-le',
    '-- pe cele vechi. Rulează ÎNAINTE de publicarea aplicației. Sigur la rulări repetate.',
    '-- Fără catalog (bază nouă) nu face nimic.',
    'begin;',
    'do $$',
    'declare',
    '  v_rows integer;',
    '  v_constraint text;',
    'begin',
    "  if to_regclass('public.citim_verse_catalog') is null then",
    "    raise notice 'public.citim_verse_catalog lipsește; nimic de făcut';",
    '    return;',
    '  end if;',
    '  lock table public.citim_verse_catalog in share row exclusive mode;',
    '  for v_constraint in',
    '    select conname from pg_constraint',
    "    where conrelid = 'public.citim_verse_catalog'::regclass and contype = 'c'",
    "      and pg_get_constraintdef(oid) ilike '%cardinality(valid_choices)%'",
    '  loop',
    "    execute format('alter table public.citim_verse_catalog drop constraint %I', v_constraint);",
    '  end loop;',
    '  alter table public.citim_verse_catalog',
    '    add constraint citim_verse_catalog_valid_choices_check check (cardinality(valid_choices) >= 4);',
    '  update public.citim_verse_catalog c',
    '  set valid_choices = c.valid_choices || array(',
    '    select t.choice from unnest(n.choices) with ordinality as t(choice, position)',
    '    where not (t.choice = any(c.valid_choices)) order by t.position)',
    '  from (values',
    values,
    '  ) as n(verse_ref, choices)',
    '  where c.verse_ref = n.verse_ref;',
    '  get diagnostics v_rows = row_count;',
    `  if v_rows <> ${rows.length} then`,
    `    raise exception 'Variante epistole: % rânduri în loc de ${rows.length}. Rulează întâi 20261110_03.', v_rows;`,
    '  end if;',
    'end;',
    '$$;',
    'commit;',
    '',
  ].join('\n');
}

// 20261125_01 este aplicată în producție și rămâne înghețată. Variantele și
// răspunsurile noi se publică prin scripts/build-epistle-answers.js.

module.exports = { OUTPUT };
