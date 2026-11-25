// Generează exercițiile fără a modifica textul biblic de referință.
// node scripts/build-epistles.js [--check]
const fs = require('node:fs');
const path = require('node:path');
const { EPISTLE_BOOKS, parseEpistleReference } = require('./epistle-reference');
const { validate } = require('./validate-verses');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'js/verses-epistles.js');
// Cuvântul de completat și variantele greșite alese de mână, pe verset. Au
// prioritate față de alegerea automată de mai jos, care rămâne doar pentru
// versetele încă nealese.
const CHOICES_PATH = path.join(__dirname, 'epistle-choices.json');
const STOP_WORDS = new Set([
  'acest', 'această', 'aceste', 'aceștia', 'aceasta', 'acestea', 'acela', 'aceea',
  'acelor', 'acestei', 'acesteia', 'acelei', 'acelui', 'aceluia', 'acele', 'aceia',
  'astfel', 'atunci', 'care', 'căci', 'când', 'dacă', 'deci', 'deși', 'doar',
  'după', 'este', 'fiind', 'fiindcă', 'fost', 'fără', 'însă', 'între', 'încât',
  'nici', 'numai', 'pentru', 'prin', 'sunt', 'toate', 'toată', 'totul', 'totuși',
  'voastră', 'voastre', 'vostru', 'voștri', 'noastră', 'noastre', 'nostru', 'noștri',
]);

function hash(text) {
  let value = 2166136261;
  for (const character of text) {
    value ^= character.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function tokens(text) {
  return [...text.matchAll(/[\p{L}\p{M}]+/gu)];
}

const lower = (word) => word.toLocaleLowerCase('ro-RO');
const isCapitalized = (word) => word[0] !== lower(word[0]);
const capitalize = (word) => word[0].toLocaleUpperCase('ro-RO') + word.slice(1);

// Cuvinte care nu apar niciodată ca variantă greșită: jignitoare sau nepotrivite
// lângă textul biblic într-un joc pentru copii.
const FORBIDDEN_DISTRACTOR = /^(ticălo|păcăto|drac|diavol|satan|curv|preacurv|desfrân|blestem|nebun|mincino|ucig|hoț|spurc|necurat|scârb|scârn|porc|măgar|câin|beți|bețiv|idol|prost|urât)/;

// Pentru numele sfinte, variantele vin din liste fixe, cu aceeași formă
// gramaticală, ca să nu apară cuvinte la întâmplare lângă ele.
const PERSONS = ['moise', 'avraam', 'david', 'pavel', 'petru', 'iacov', 'ilie', 'samuel', 'isaac', 'iosif'];
const TITLES = ['împăratul', 'apostolul', 'proorocul', 'preotul', 'stăpânul', 'învățătorul', 'îngerul'];
const TITLES_GENITIVE = ['împăratului', 'apostolului', 'proorocului', 'preotului', 'stăpânului', 'învățătorului', 'îngerului'];
const TITLES_VOCATIVE = ['împărate', 'stăpâne', 'învățătorule', 'proorocule'];
const HOLY_DISTRACTORS = new Map([
  ...['dumnezeu', 'isus', 'hristos', 'iisus', 'mesia', 'emanuel'].map((w) => [w, PERSONS]),
  ...['domnul', 'duhul', 'tatăl', 'fiul', 'mântuitorul'].map((w) => [w, TITLES]),
  ...['dumnezeului', 'domnului', 'duhului', 'tatălui', 'fiului', 'mântuitorului', 'hristosului'].map((w) => [w, TITLES_GENITIVE]),
  ...['doamne', 'dumnezeule', 'tată'].map((w) => [w, TITLES_VOCATIVE]),
]);

// Variantele greșite trebuie să semene gramatical cu răspunsul, altfel acesta se
// ghicește fără să cunoști versetul. Se aproximează prin terminație (întâi 4
// litere, apoi tot mai puține) și prin tipul cuvântului (nume propriu sau nu).
// Fiecare treaptă: [litere comune la final, același tip, diferență de lungime].
const MATCH_STEPS = [[4, true, 3], [3, true, 3], [3, false, 4], [2, true, 2], [2, false, 4], [1, false, 3], [0, false, 6]];

function pickDistractors(ref, answer, text, vocabulary, properNames) {
  const key = lower(answer);
  const inVerse = new Set(tokens(text).map((match) => lower(match[0])));
  const order = (list) => [...list].sort((a, b) => hash(`${ref}:${a}`) - hash(`${ref}:${b}`));
  const shape = (word) => (isCapitalized(answer) ? capitalize(word) : word);
  const holy = HOLY_DISTRACTORS.get(key);
  if (holy) return order(holy.filter((word) => !inVerse.has(word))).slice(0, 3).map(shape);

  const proper = isCapitalized(answer) && properNames.has(key);
  const chosen = [];
  for (const [suffix, sameKind, spread] of MATCH_STEPS) {
    if (chosen.length === 3) break;
    const tail = suffix ? key.slice(-suffix) : '';
    const candidates = vocabulary.filter((word) => word !== key && !inVerse.has(word)
      && !chosen.includes(word) && !FORBIDDEN_DISTRACTOR.test(word) && !HOLY_DISTRACTORS.has(word)
      && word.endsWith(tail) && Math.abs(word.length - key.length) <= spread
      && (!sameKind || properNames.has(word) === proper));
    chosen.push(...order(candidates).slice(0, 3 - chosen.length));
  }
  return chosen.map(shape);
}

// Cuvinte scrise aproape mereu cu majusculă în referință (nume proprii).
function findProperNames(texts) {
  const seen = new Map();
  for (const text of texts) {
    for (const match of tokens(text)) {
      const entry = seen.get(lower(match[0])) || { capitalized: 0, total: 0 };
      entry.total += 1;
      if (isCapitalized(match[0])) entry.capitalized += 1;
      seen.set(lower(match[0]), entry);
    }
  }
  return new Set([...seen].filter(([, e]) => e.capitalized / e.total > 0.8).map(([word]) => word));
}

function makeExercise(ref, text, vocabulary, properNames, choices) {
  const matches = tokens(text);
  const occurrences = new Map();
  for (const match of matches) {
    const key = match[0].toLocaleLowerCase('ro-RO');
    occurrences.set(key, (occurrences.get(key) || 0) + 1);
  }
  const uniqueWords = matches.filter((match) => {
    const word = match[0].toLocaleLowerCase('ro-RO');
    return word.length >= 4 && occurrences.get(word) === 1 && !STOP_WORDS.has(word);
  });
  const curated = choices && choices[ref];
  let chosen;
  let distractors;
  if (curated) {
    const [word, ...wrong] = curated;
    const same = matches.filter((match) => match[0].toLocaleLowerCase('ro-RO') === word.toLocaleLowerCase('ro-RO'));
    if (same.length !== 1 || same[0][0] !== word) {
      throw new Error(`${ref}: cuvântul ales "${word}" trebuie să apară exact o dată, scris ca în verset`);
    }
    const inVerse = new Set(matches.map((match) => match[0].toLocaleLowerCase('ro-RO')));
    if (wrong.length !== 3 || wrong.some((w) => inVerse.has(w.toLocaleLowerCase('ro-RO')))) {
      throw new Error(`${ref}: trebuie 3 variante greșite care nu apar în verset`);
    }
    chosen = same[0];
    distractors = wrong;
  } else {
    if (!uniqueWords.length) throw new Error(`${ref}: nu există un cuvânt unic potrivit pentru exercițiu`);
    chosen = uniqueWords[hash(ref) % uniqueWords.length];
    distractors = pickDistractors(ref, chosen[0], text, vocabulary, properNames);
  }
  const answer = chosen[0];
  if (distractors.length !== 3) throw new Error(`${ref}: variante insuficiente`);
  const options = [...distractors];
  options.splice(hash(`${ref}:answer`) % 4, 0, answer);
  return {
    ref,
    text: `${text.slice(0, chosen.index)}{0}${text.slice(chosen.index + answer.length)}`,
    blanks: [{ answer, options }],
  };
}

function loadChoices(knownRefs) {
  if (!fs.existsSync(CHOICES_PATH)) return {};
  const raw = JSON.parse(fs.readFileSync(CHOICES_PATH, 'utf8'));
  const choices = Object.fromEntries(Object.entries(raw).filter(([ref]) => !ref.startsWith('_')));
  const unknown = Object.keys(choices).filter((ref) => !knownRefs.has(ref));
  if (unknown.length) throw new Error(`epistle-choices.json: referințe necunoscute: ${unknown.join(', ')}`);
  return choices;
}

function buildEpistles() {
  const references = EPISTLE_BOOKS.map((book) => ({
    book,
    verses: parseEpistleReference(fs.readFileSync(path.join(ROOT, book.referencePath), 'utf8'), book),
  }));
  const vocabulary = [...new Set(references.flatMap(({ verses }) =>
    [...verses.values()].flatMap((text) => tokens(text)
      .map((match) => match[0].toLocaleLowerCase('ro-RO'))
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word)))))].sort();
  const properNames = findProperNames(references.flatMap(({ verses }) => [...verses.values()]));
  const choices = loadChoices(new Set(references.flatMap(({ verses }) => [...verses.keys()])));
  return Object.fromEntries(references.map(({ book, verses }) => [
    book.id, [...verses].map(([ref, text]) => makeExercise(ref, text, vocabulary, properNames, choices)),
  ]));
}

function main() {
  const epistles = buildEpistles();
  const content = '// GENERAT AUTOMAT de scripts/build-epistles.js din referințele furnizate în tasks/.\n'
    + '// Text integral, cu un singur cuvânt de completat în fiecare verset.\n'
    + `const EPISTLES = ${JSON.stringify(epistles, null, 2)};\n`;
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
    if (current.replace(/\r\n/g, '\n') !== content) {
      throw new Error('js/verses-epistles.js trebuie regenerat cu node scripts/build-epistles.js');
    }
  } else {
    fs.writeFileSync(OUTPUT, content, 'utf8');
  }
  for (const book of EPISTLE_BOOKS) {
    validate(book.name, 'js/verses-epistles.js', `EPISTLES[${JSON.stringify(book.id)}]`);
  }
}

if (require.main === module) main();
module.exports = { buildEpistles, makeExercise, HOLY_DISTRACTORS, FORBIDDEN_DISTRACTOR };
