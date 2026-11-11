// Avertismentul la schimbarea categoriei apare doar când se schimbă epistola.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ReadingPath = require('../js/reading-path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const context = { ReadingPath, readingProfile: null, hasReadingCategory: () => !!context.readingProfile };
vm.createContext(context);
vm.runInContext(source.match(/const EPISTLE_NAMES = [^\n]+/)[0].replace('const ', 'var '), context);
vm.runInContext(source.match(/function categoryChangeWarning\([^]*?\n}/)[0], context);

const warn = (from, to) => { context.readingProfile = from && { category_id: from }; return context.categoryChangeWarning(to); };

assert.equal(warn(null, 'grades_4_5'), null, 'First choice needs no warning');
assert.equal(warn('grades_4_5', 'grades_4_5'), null, 'Same category needs no warning');
assert.equal(warn('adults_18_35', 'adults_35_plus'), null, 'Same epistle (Evrei) loses nothing');
assert.equal(warn('grades_10_11', 'adults_18_35'), null, 'Same epistle (Evrei) loses nothing');
assert.equal(warn('grades_2_3', 'preschool_1'), null, 'Same epistle (Iuda) loses nothing');

const text = warn('grades_10_11', 'grades_4_5');
assert(text, 'A different epistle must warn');
assert(text.includes('din Evrei în 1 Petru'), 'Names both epistles');
assert(text.includes('prima pagină') && text.includes('Punctele câștigate se păstrează'));

// Fiecare pereche de categorii cu epistole diferite avertizează; cu aceeași epistolă, nu.
for (const a of ReadingPath.categories) {
  for (const b of ReadingPath.categories) {
    assert.equal(!!warn(a.id, b.id), a.epistle !== b.epistle, `${a.id} -> ${b.id}`);
  }
}
console.log('Category change warning: shown only when the epistle changes, for all category pairs.');
