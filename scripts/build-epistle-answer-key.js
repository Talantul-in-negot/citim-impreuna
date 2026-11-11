// Adaugă epistolele după cele 324 de pagini Samuel, fără repaginarea istoricului.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildRows, loadVerses } = require('./build-answer-key');
const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'supabase/20261110_01_epistle_answer_key.sql');
const BOOK_ORDER = ['iuda', '1petru', 'filipeni', 'evrei', 'galateni'];

function loadEpistles() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/verses-epistles.js'), 'utf8') + '\nglobalThis.books = EPISTLES;', context);
  return context.books;
}

function buildEpistleRows() {
  const common = loadVerses();
  const books = loadEpistles();
  return buildRows([...common, ...BOOK_ORDER.flatMap(id => books[id])]).slice(common.length);
}

function renderSql(rows) {
  const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
  const lines = [
    '-- GENERAT de scripts/build-epistle-answer-key.js. Nu modifica manual.',
    '-- Aplică înainte de 20261110_02_reading_categories.sql și înainte de publicarea aplicației.',
    'begin;',
    'lock table public.verse_answers in share row exclusive mode;',
  ];
  for (let start = 0; start < rows.length; start += 200) {
    const chunk = rows.slice(start, start + 200);
    lines.push('insert into public.verse_answers (verse_ref, ordinal, answer, page_index, page_size, chapter_ref, chapter_size) values');
    lines.push(chunk.map(row => `  (${quote(row.verse_ref)}, ${row.ordinal}, ${quote(row.answer)}, ${row.page_index}, ${row.page_size}, ${quote(row.chapter_ref)}, ${row.chapter_size})`).join(',\n'));
    lines.push('on conflict (verse_ref) do update set ordinal = excluded.ordinal, answer = excluded.answer, page_index = excluded.page_index, page_size = excluded.page_size, chapter_ref = excluded.chapter_ref, chapter_size = excluded.chapter_size;');
  }
  lines.push('commit;', '');
  return lines.join('\n');
}

if (require.main === module) {
  const rows = buildEpistleRows();
  const sql = renderSql(rows);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') !== sql) {
      throw new Error('Cheia epistolelor trebuie regenerată: node scripts/build-epistle-answer-key.js');
    }
    console.log(`Cheia epistolelor verificată: ${rows.length} versete.`);
  } else {
    fs.writeFileSync(OUTPUT, sql, 'utf8');
    console.log(`Cheia epistolelor generată: ${rows.length} versete.`);
  }
}

module.exports = { loadEpistles, buildEpistleRows, BOOK_ORDER };
