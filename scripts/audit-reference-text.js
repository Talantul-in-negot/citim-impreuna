/* Compară textele integrale, inclusiv continuările pe rânduri nenumerotate.
   Folosește exclusiv referințele furnizate de utilizator în tasks/.
   node scripts/audit-reference-text.js --report tasks/reference-audit-YYYY-MM-DD */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadVerseArray } = require('./validate-verses');
const ROOT = path.join(__dirname, '..');
const HEADINGS = require('../tasks/reference-section-headings.json');
const BOOKS = [
  { id: '1samuel', name: '1 Samuel', variable: 'VERSES_1SAMUEL', count: 810, chapters: 31 },
  { id: '2samuel', name: '2 Samuel', variable: 'VERSES_2SAMUEL', count: 695, chapters: 24 },
];
const normalize = (text) => text.normalize('NFC').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș')
  .replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/\s+/g, ' ').trim();
const words = (text) => normalize(text).toLocaleLowerCase('ro-RO').match(/[\p{L}\p{M}\p{N}]+/gu) || [];
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function parseReference(raw, book) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const headings = new Set(HEADINGS[book.id]);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^---\s*$/.test(line)) break; // nota editorială de după text
    if (line.startsWith('#')) continue;
    if ((i === 0 || !lines[i - 1].trim()) && headings.has(line)) continue;
    kept.push(lines[i]);
  }
  const text = kept.join('\n').trim();
  const markers = [...text.matchAll(/(?:^|\s)(\d{1,3})\s+/g)];
  const references = new Map();
  let chapter = 0, previous = 0;
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i], number = Number(marker[1]);
    if (number === 1) { chapter++; previous = 0; }
    if (number !== previous + 1) throw new Error(`${book.name}: număr neașteptat ${chapter}:${number} după ${previous}`);
    const verseText = normalize(text.slice(marker.index + marker[0].length, markers[i + 1]?.index ?? text.length));
    if (!verseText) throw new Error(`${book.name} ${chapter}:${number}: text gol`);
    references.set(`${book.name} ${chapter}:${number}`, verseText);
    previous = number;
  }
  if (chapter !== book.chapters || references.size !== book.count) {
    throw new Error(`${book.name}: referință incompletă (${chapter} capitole, ${references.size} versete)`);
  }
  return references;
}

function restoreVerse(verse) {
  return normalize(verse.text.replace(/\{(\d+)\}/g, (_, index) => {
    if (!verse.blanks[index]?.answer) throw new Error(`${verse.ref}: răspuns lipsă pentru {${index}}`);
    return verse.blanks[index].answer;
  }));
}

// Diferență prin cea mai lungă secvență comună: ordinea cuvintelor contează.
function wordDiff(reference, actual) {
  const a = words(reference), b = words(actual);
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const missing = [], extra = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (i < a.length && (j >= b.length || dp[i + 1][j] >= dp[i][j + 1])) missing.push(a[i++]);
    else extra.push(b[j++]);
  }
  return { missing, extra };
}

function auditBook(book) {
  const referencePath = `tasks/${book.id}-reference-text.md`;
  const appPath = `js/verses-${book.id}.js`;
  const raw = fs.readFileSync(path.join(ROOT, referencePath), 'utf8');
  const references = parseReference(raw, book);
  const verses = loadVerseArray(path.join(ROOT, appPath), book.variable);
  const actualByRef = new Map();
  for (const verse of verses) {
    if (actualByRef.has(verse.ref)) throw new Error(`${verse.ref}: referință duplicată în aplicație`);
    actualByRef.set(verse.ref, restoreVerse(verse));
  }
  const mismatches = [], formatting = [];
  let exact = 0;
  for (const [ref, reference] of references) {
    const actual = actualByRef.get(ref);
    if (actual == null) { mismatches.push({ ref, category: 'missing_verse', reference, actual: null }); continue; }
    if (reference === actual) { exact++; continue; }
    if (words(reference).join(' ') === words(actual).join(' ')) {
      formatting.push({ ref, reference, actual });
      continue;
    }
    const diff = wordDiff(reference, actual);
    const category = words(reference).join('') === words(actual).join('') ? 'word_spacing'
      : diff.extra.length === 0 ? 'omission' : diff.missing.length === 0 ? 'addition' : 'changed_words';
    mismatches.push({ ref, category, reference, actual, missingWords: diff.missing, extraWords: diff.extra });
  }
  for (const [ref, actual] of actualByRef) {
    if (!references.has(ref)) mismatches.push({ ref, category: 'extra_verse', reference: null, actual });
  }
  return {
    book: book.name, referencePath, appPath, referenceSha256: sha256(raw),
    appSha256: sha256(fs.readFileSync(path.join(ROOT, appPath), 'utf8')),
    referenceCount: references.size, appCount: verses.length, exact,
    formattingOnly: formatting.length, contentDifferences: mismatches.length,
    categories: Object.fromEntries([...new Set(mismatches.map(x => x.category))].map(k => [k, mismatches.filter(x => x.category === k).length])),
    mismatches, formatting,
  };
}

function markdownReport(results) {
  const out = ['# Comparație integrală cu textele de referință', '',
    'Sunt reconstruite cuvintele lipsă. Comparația ignoră spațiile repetate, trecerile la rând, punctuația, majusculele și diferența dintre ș/ț cu virgulă și ş/ţ cu sedilă. Ordinea și toate cuvintele contează; scrierea legată/separată este semnalată distinct.', '',
    '| Carte | Referință | Aplicație | Identice | Doar formatare | Diferențe de cuvinte/scriere |',
    '|---|---:|---:|---:|---:|---:|'];
  for (const r of results) out.push(`| ${r.book} | ${r.referenceCount} | ${r.appCount} | ${r.exact} | ${r.formattingOnly} | ${r.contentDifferences} |`);
  out.push('', '## Diferențe față de referință', '');
  if (results.every(r => r.contentDifferences === 0)) out.push('Nicio diferență de cuvinte sau scriere.', '');
  const labels = { omission: 'text lipsă', addition: 'text în plus', changed_words: 'cuvinte diferite', word_spacing: 'scriere legată/separată' };
  for (const r of results) for (const m of r.mismatches) {
    out.push(`### ${m.ref} — ${labels[m.category] || m.category}`, '', `**Referință:** ${m.reference || '(lipsește)'}`, '',
      `**Aplicație:** ${m.actual || '(lipsește)'}`, '');
    if (m.missingWords?.length) out.push(`Cuvinte din referință absente sau înlocuite: ${m.missingWords.join(' ')}`, '');
    if (m.extraWords?.length) out.push(`Cuvinte adăugate sau diferite în aplicație: ${m.extraWords.join(' ')}`, '');
  }
  out.push('## Diferențe numai de formatare', '');
  for (const r of results) out.push(`**${r.book}:** ${r.formatting.map(x => x.ref).join(', ') || 'Niciuna.'}`, '');
  out.push('## Surse și reproducere', '',
    '`node scripts/audit-reference-text.js --report tasks/reference-audit-YYYY-MM-DD`', '',
    'Titlurile de secțiuni sunt excluse prin lista explicită din `tasks/reference-section-headings.json`. Continuările nenumerotate ale versetelor sunt păstrate. Structura referințelor este verificată: 31/24 capitole și 810/695 versete, în ordine fără goluri.', '');
  for (const r of results) out.push(`- ${r.referencePath} · SHA-256: ${r.referenceSha256}`, `- ${r.appPath} · SHA-256: ${r.appSha256}`);
  return out.join('\n') + '\n';
}

if (require.main === module) {
  const results = BOOKS.map(auditBook);
  for (const { book, referenceCount, appCount, exact, formattingOnly, contentDifferences, categories } of results) {
    console.log(JSON.stringify({ book, referenceCount, appCount, exact, formattingOnly, contentDifferences, categories }));
  }
  const reportArg = process.argv.indexOf('--report');
  if (reportArg >= 0) {
    const output = path.resolve(ROOT, process.argv[reportArg + 1]);
    fs.writeFileSync(`${output}.json`, JSON.stringify(results, null, 2) + '\n');
    fs.writeFileSync(`${output}.md`, markdownReport(results));
  }
  if (results.some(r => r.contentDifferences > 0)) process.exitCode = 1;
}
module.exports = { parseReference, restoreVerse, words, wordDiff, auditBook, BOOKS };
