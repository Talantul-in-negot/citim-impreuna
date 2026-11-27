// Aplică în js/verses-1samuel.js și js/verses-2samuel.js corecturile din
// scripts/samuel-choices.json (doar versetele cu probleme: variante greșite care erau
// de fapt corecte, sau un cuvânt de completat fără sens).
//
// Fișierele Samuel sunt generate de scripts/build-window.js dintr-un master care NU
// e în repo. Dacă sunt regenerate din master, corecturile se pierd: --check (în CI)
// semnalează asta, iar o nouă rulare a acestui script le reaplică.
//
//   node scripts/apply-samuel-choices.js          # aplică (idempotent)
//   node scripts/apply-samuel-choices.js --check  # verifică doar că sunt aplicate
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CHOICES_PATH = path.join(__dirname, 'samuel-choices.json');
const FILES = ['js/verses-1samuel.js', 'js/verses-2samuel.js'];
const BLOCK = /(    ref: )("(?:[^"\\]|\\.)*")(,\n    text: )("(?:[^"\\]|\\.)*")(,\n    blanks: \[\{ answer: )("(?:[^"\\]|\\.)*")(, options: )(\[[^\]]*\])( \}\],)/g;

function hash(text) {
  let value = 2166136261;
  for (const character of text) {
    value ^= character.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

const lower = (word) => word.toLocaleLowerCase('ro-RO');

function loadChoices() {
  const raw = JSON.parse(fs.readFileSync(CHOICES_PATH, 'utf8'));
  return new Map(Object.entries(raw).filter(([ref]) => !ref.startsWith('_')));
}

// Versetul cu noul cuvânt de completat; textul biblic rămâne identic.
function applyChoice(ref, text, answer, choice) {
  const [nextAnswer, ...wrong] = choice;
  const full = text.replace('{0}', answer);
  const words = [...full.matchAll(/[\p{L}\p{M}]+/gu)];
  if (nextAnswer === answer) {
    // Doar variantele se schimbă (răspunsul poate fi și compus, de ex. „Eben-Ezer").
    const inVerse = new Set(words.map((match) => lower(match[0])));
    if (wrong.length !== 3 || new Set(wrong.map(lower)).size !== 3 || wrong.some((w) => inVerse.has(lower(w)) || lower(w) === lower(answer))) {
      throw new Error(`${ref}: trebuie 3 variante greșite distincte, care nu apar în verset`);
    }
    const options = [...wrong];
    options.splice(hash(`${ref}:answer`) % 4, 0, answer);
    return { text, answer, options };
  }
  const same = words.filter((match) => lower(match[0]) === lower(nextAnswer));
  if (same.length !== 1 || same[0][0] !== nextAnswer) {
    throw new Error(`${ref}: "${nextAnswer}" trebuie să apară exact o dată, scris ca în verset`);
  }
  const inVerse = new Set(words.map((match) => lower(match[0])));
  if (wrong.length !== 3 || new Set(wrong.map(lower)).size !== 3 || wrong.some((w) => inVerse.has(lower(w)) || lower(w) === lower(nextAnswer))) {
    throw new Error(`${ref}: trebuie 3 variante greșite distincte, care nu apar în verset`);
  }
  const index = same[0].index;
  const options = [...wrong];
  options.splice(hash(`${ref}:answer`) % 4, 0, nextAnswer);
  return {
    text: `${full.slice(0, index)}{0}${full.slice(index + nextAnswer.length)}`,
    answer: nextAnswer,
    options,
  };
}

function main() {
  const check = process.argv.includes('--check');
  const choices = loadChoices();
  const seen = new Set();
  const stale = [];
  let changed = 0;
  for (const file of FILES) {
    const filePath = path.join(ROOT, file);
    const source = fs.readFileSync(filePath, 'utf8');
    const crlf = source.includes('\r\n');
    const body = source.replace(/\r\n/g, '\n');
    const next = body.replace(BLOCK, (all, a, refJson, b, textJson, c, answerJson, d, optionsJson, e) => {
      const ref = JSON.parse(refJson);
      const choice = choices.get(ref);
      if (!choice) return all;
      seen.add(ref);
      const text = JSON.parse(textJson);
      const answer = JSON.parse(answerJson);
      const options = JSON.parse(optionsJson);
      const sameSet = (x, y) => x.length === y.length && x.every((item) => y.includes(item));
      if (answer === choice[0] && sameSet(options, choice)) return all; // deja aplicat
      if (check) { stale.push(ref); return all; }
      const updated = applyChoice(ref, text, answer, choice);
      changed++;
      return `${a}${refJson}${b}${JSON.stringify(updated.text)}${c}${JSON.stringify(updated.answer)}${d}${JSON.stringify(updated.options)}${e}`;
    });
    if (!check && next !== body) fs.writeFileSync(filePath, crlf ? next.replace(/\n/g, '\r\n') : next, 'utf8');
  }
  const missing = [...choices.keys()].filter((ref) => !seen.has(ref));
  if (missing.length) throw new Error(`samuel-choices.json: versete negăsite: ${missing.join(', ')}`);
  if (check) {
    if (stale.length) throw new Error(`Corecturi Samuel neaplicate (${stale.length}): rulează node scripts/apply-samuel-choices.js`);
    console.log(`Corecturile Samuel sunt aplicate: ${choices.size} versete.`);
  } else {
    console.log(`Corecturi Samuel: ${changed} versete actualizate din ${choices.size}.`);
  }
}

if (require.main === module) main();
module.exports = { applyChoice, loadChoices };
