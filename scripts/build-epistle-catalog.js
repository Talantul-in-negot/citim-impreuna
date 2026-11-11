// Generează supabase/20261110_03_citim_catalog_epistles.sql.
//
// Baza live are un al doilea trigger BEFORE INSERT pe events, nedocumentat în
// repo (events_validate_citim_insert -> validate_citim_event_insert), care
// rulează ÎNAINTEA lui events_verify_before_insert (ordine alfabetică) și
// respinge orice verset absent din public.citim_verse_catalog sau orice
// alegere care nu e una dintre cele 4 variante. Catalogul live conținea doar
// cele 1505 versete Samuel, deci fără acest pas orice răspuns la o epistolă ar
// fi fost refuzat de server.
//
// Răspunsul, pagina și capitolul vin din public.verse_answers (cheia canonică,
// adăugată de 20261110_01), ca cele două tabele să nu poată diverge; din client
// vin doar cele 4 variante afișate. Migrația nu face nimic pe o bază fără
// catalog (bază nouă din apply_all.sql).
const fs = require('node:fs');
const path = require('node:path');
const { loadEpistles, BOOK_ORDER } = require('./build-epistle-answer-key');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'supabase/20261110_03_citim_catalog_epistles.sql');

function catalogChoices() {
  const books = loadEpistles();
  return BOOK_ORDER.flatMap((id) => books[id]).map((verse) => {
    if (!verse.blanks || verse.blanks.length !== 1) throw new Error(`${verse.ref}: exact un spațiu de completat așteptat`);
    const { answer, options } = verse.blanks[0];
    if (!Array.isArray(options) || options.length !== 4 || new Set(options).size !== 4) {
      throw new Error(`${verse.ref}: exact 4 variante distincte așteptate`);
    }
    if (!options.includes(answer)) throw new Error(`${verse.ref}: răspunsul lipsește din variante`);
    return { ref: verse.ref, options };
  });
}

function renderSql(rows) {
  const quote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
  const values = rows
    .map((row) => `      (${quote(row.ref)}, array[${row.options.map(quote).join(', ')}]::text[])`)
    .join(',\n');
  return [
    '-- GENERAT de scripts/build-epistle-catalog.js. Nu modifica manual.',
    '-- Adaugă epistolele în public.citim_verse_catalog, folosit de triggerul live',
    '-- events_validate_citim_insert. Rulează DUPĂ 20261110_01 (cheia canonică) și',
    '-- înainte de publicarea aplicației. Fără catalog (bază nouă) nu face nimic.',
    'begin;',
    'do $$',
    'declare',
    '  v_rows integer;',
    'begin',
    "  if to_regclass('public.citim_verse_catalog') is null then",
    "    raise notice 'public.citim_verse_catalog lipsește; nimic de făcut';",
    '    return;',
    '  end if;',
    '  lock table public.citim_verse_catalog in share row exclusive mode;',
    '  insert into public.citim_verse_catalog',
    '    (verse_ref, correct_answer, valid_choices, page_index, page_size, chapter_ref, chapter_size)',
    '  select v.verse_ref, v.answer, c.choices, v.page_index, v.page_size, v.chapter_ref, v.chapter_size',
    '  from (values',
    values,
    '  ) as c(verse_ref, choices)',
    '  join public.verse_answers v using (verse_ref)',
    '  on conflict (verse_ref) do update set',
    '    correct_answer = excluded.correct_answer,',
    '    valid_choices = excluded.valid_choices,',
    '    page_index = excluded.page_index,',
    '    page_size = excluded.page_size,',
    '    chapter_ref = excluded.chapter_ref,',
    '    chapter_size = excluded.chapter_size;',
    '  get diagnostics v_rows = row_count;',
    `  if v_rows <> ${rows.length} then`,
    `    raise exception 'Catalogul epistolelor: % rânduri în loc de ${rows.length}. Rulează întâi 20261110_01_epistle_answer_key.sql.', v_rows;`,
    '  end if;',
    '  if exists (',
    '    select 1 from public.citim_verse_catalog c',
    "    where c.verse_ref !~ '^[12] Samuel ' and not (c.correct_answer = any(c.valid_choices))",
    '  ) then',
    "    raise exception 'Catalog: răspuns corect absent din variante';",
    '  end if;',
    'end;',
    '$$;',
    'commit;',
    '',
  ].join('\n');
}

if (require.main === module) {
  const rows = catalogChoices();
  const sql = renderSql(rows);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') !== sql) {
      throw new Error('Catalogul epistolelor trebuie regenerat: node scripts/build-epistle-catalog.js');
    }
    console.log(`Catalogul epistolelor verificat: ${rows.length} versete.`);
  } else {
    fs.writeFileSync(OUTPUT, sql, 'utf8');
    console.log(`Catalogul epistolelor generat: ${rows.length} versete.`);
  }
}

module.exports = { catalogChoices, renderSql, OUTPUT };
