// Generează exercițiile fără a modifica textul biblic de referință.
// node scripts/build-epistles.js [--check]
const fs = require('node:fs');
const path = require('node:path');
const { EPISTLE_BOOKS, parseEpistleReference } = require('./epistle-reference');
const { validate } = require('./validate-verses');

const ROOT = path.join(__dirname, '..');
const OUTPUT = path.join(ROOT, 'js/verses-epistles.js');
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

function makeExercise(ref, text, vocabulary) {
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
  if (!uniqueWords.length) throw new Error(`${ref}: nu există un cuvânt unic potrivit pentru exercițiu`);
  const chosen = uniqueWords[hash(ref) % uniqueWords.length];
  const answer = chosen[0];
  const lowerAnswer = answer.toLocaleLowerCase('ro-RO');
  const candidates = vocabulary.filter((word) => word !== lowerAnswer
    && Math.abs(word.length - answer.length) <= 2);
  const start = hash(`${ref}:options`) % candidates.length;
  const distractors = [];
  for (let offset = 0; distractors.length < 3 && offset < candidates.length; offset++) {
    const word = candidates[(start + offset) % candidates.length];
    const option = answer[0] === answer[0].toLocaleUpperCase('ro-RO')
      ? word[0].toLocaleUpperCase('ro-RO') + word.slice(1) : word;
    distractors.push(option);
  }
  if (distractors.length !== 3) throw new Error(`${ref}: variante insuficiente`);
  const options = [...distractors];
  options.splice(hash(`${ref}:answer`) % 4, 0, answer);
  return {
    ref,
    text: `${text.slice(0, chosen.index)}{0}${text.slice(chosen.index + answer.length)}`,
    blanks: [{ answer, options }],
  };
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
  return Object.fromEntries(references.map(({ book, verses }) => [
    book.id, [...verses].map(([ref, text]) => makeExercise(ref, text, vocabulary)),
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
module.exports = { buildEpistles, makeExercise };
