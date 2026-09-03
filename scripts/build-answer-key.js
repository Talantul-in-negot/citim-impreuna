/* Generează supabase/20260903_01_verse_answer_key.sql — cheia de răspunsuri pe
   care serverul o folosește ca să NU mai creadă browserul pe cuvânt.

   Fiecare rând poartă tot ce triggerul din Supabase trebuie să deducă singur
   pentru un eveniment: răspunsul corect, pagina și capitolul. Ordinea (și deci
   `page_index`) trebuie să fie identică cu js/verses.js — 1 Samuel, apoi 2 Samuel.

     node scripts/build-answer-key.js            # (re)scrie migrarea
     node scripts/build-answer-key.js --check    # doar verifică, pentru CI
*/

const fs = require("fs");
const path = require("path");
const { loadVerseArray } = require("./validate-verses");

const PAGE_SIZE = 5; // trebuie să rămână egal cu PAGE_SIZE din js/app.js
const ROOT = path.resolve(__dirname, "..");
// Prefixul numeric ordonează aplicarea: cheia de răspunsuri trebuie să existe
// înainte ca triggerul din 20260903_02_... să o consulte.
const OUT_FILE = path.join(ROOT, "supabase", "20260903_01_verse_answer_key.sql");
const CHUNK = 200;

function sqlText(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function loadVerses() {
  return [
    ...loadVerseArray(path.join(ROOT, "js", "verses-1samuel.js"), "VERSES_1SAMUEL"),
    ...loadVerseArray(path.join(ROOT, "js", "verses-2samuel.js"), "VERSES_2SAMUEL"),
  ];
}

function buildRows(verses) {
  const chapterOf = (ref) => ref.replace(/:\d+$/, "");

  const chapterSizes = new Map();
  for (const v of verses) {
    const c = chapterOf(v.ref);
    chapterSizes.set(c, (chapterSizes.get(c) || 0) + 1);
  }
  const pageSizes = new Map();
  verses.forEach((_, i) => {
    const p = Math.floor(i / PAGE_SIZE);
    pageSizes.set(p, (pageSizes.get(p) || 0) + 1);
  });

  const seen = new Set();
  return verses.map((v, ordinal) => {
    if (seen.has(v.ref)) throw new Error(`referință duplicată: ${v.ref}`);
    seen.add(v.ref);
    if (!Array.isArray(v.blanks) || v.blanks.length !== 1) {
      throw new Error(`${v.ref}: se aștepta exact un blank`);
    }
    const chapterRef = chapterOf(v.ref);
    const chapterSize = chapterSizes.get(chapterRef);
    // events_chapter_size_check permite 1..100
    if (chapterSize > 100) throw new Error(`${chapterRef}: ${chapterSize} versete, peste limita de 100`);
    const pageIndex = Math.floor(ordinal / PAGE_SIZE);
    const pageSize = pageSizes.get(pageIndex);
    // events_page_size_check permite 1..5
    if (pageSize > PAGE_SIZE) throw new Error(`pagina ${pageIndex}: ${pageSize} versete`);
    return {
      verse_ref: v.ref,
      ordinal,
      answer: v.blanks[0].answer,
      page_index: pageIndex,
      page_size: pageSize,
      chapter_ref: chapterRef,
      chapter_size: chapterSize,
    };
  });
}

function renderSql(rows) {
  const lines = [];
  lines.push("-- GENERAT AUTOMAT de scripts/build-answer-key.js — nu edita direct.");
  lines.push("-- Regenerează cu: npm run build:answer-key");
  lines.push("--");
  lines.push("-- Cheia de răspunsuri a serverului. Fără ea, `events.correct` este");
  lines.push("-- exact ce a trimis browserul, iar tot recalculul „server-derived\" de");
  lines.push("-- mai jos nu face decât să reaplice formula peste date neverificate.");
  lines.push(`-- ${rows.length} versete, ${rows[rows.length - 1].page_index + 1} pagini.`);
  lines.push("");
  lines.push("begin;");
  lines.push("");
  lines.push("create table if not exists public.verse_answers (");
  lines.push("  verse_ref    text primary key,");
  lines.push("  ordinal      integer not null unique,");
  lines.push("  answer       text not null,");
  lines.push("  page_index   integer not null,");
  lines.push("  page_size    smallint not null,");
  lines.push("  chapter_ref  text not null,");
  lines.push("  chapter_size smallint not null");
  lines.push(");");
  lines.push("");
  lines.push("alter table public.verse_answers enable row level security;");
  lines.push("-- Nicio politică: niciun client nu citește tabelul direct. Triggerul și");
  lines.push("-- funcțiile de scor sunt SECURITY DEFINER, deci trec pe lângă RLS.");
  lines.push("");
  lines.push("create index if not exists verse_answers_page_idx on public.verse_answers (page_index);");
  lines.push("");
  lines.push("-- Reîncărcare completă: rularea de două ori dă același rezultat.");
  lines.push("delete from public.verse_answers;");
  lines.push("");

  const cols = "(verse_ref, ordinal, answer, page_index, page_size, chapter_ref, chapter_size)";
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    lines.push(`insert into public.verse_answers ${cols} values`);
    chunk.forEach((r, k) => {
      const value =
        `  (${sqlText(r.verse_ref)}, ${r.ordinal}, ${sqlText(r.answer)}, ` +
        `${r.page_index}, ${r.page_size}, ${sqlText(r.chapter_ref)}, ${r.chapter_size})`;
      lines.push(value + (k === chunk.length - 1 ? ";" : ","));
    });
    lines.push("");
  }

  lines.push("commit;");
  lines.push("");
  return lines.join("\n");
}

function main() {
  const check = process.argv.includes("--check");
  const rows = buildRows(loadVerses());
  const sql = renderSql(rows);

  if (check) {
    const current = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : "";
    if (current.replace(/\r\n/g, "\n") !== sql) {
      console.error(
        `${path.relative(ROOT, OUT_FILE)} nu corespunde versetelor livrate.\n` +
          "Rulează: npm run build:answer-key"
      );
      process.exit(1);
    }
    console.log(`Cheia de răspunsuri e la zi: ${rows.length} versete.`);
    return;
  }

  fs.writeFileSync(OUT_FILE, sql, "utf8");
  console.log(
    `Scris ${path.relative(ROOT, OUT_FILE)}: ${rows.length} versete, ` +
      `${rows[rows.length - 1].page_index + 1} pagini.`
  );
}

if (require.main === module) main();

module.exports = { buildRows, renderSql, loadVerses };
