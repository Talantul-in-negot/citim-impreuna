/* Regresie pentru numele cu diacritice.

   Bug-ul a apărut de două ori, independent: o dată în app.js (`normName`, cu
   /\b\w/) și o dată în auth.js (`normalizeUsername`, cu /\b\p{L}/u). În ambele
   cazuri vinovat e `\b`: în JavaScript granița de cuvânt se definește prin
   \w = [A-Za-z0-9_] chiar și sub flag-ul /u, deci pentru „ștefan" prima
   graniță cade între „ș" și „t" — rezultat „șTefan", în clasament, pentru
   oricine are un nume care începe cu diacritică. */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const authPath = path.resolve(__dirname, "..", "js", "auth.js");
const context = { window: {}, navigator: {}, localStorage: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(authPath, "utf8") + "\nglobalThis.__auth = Auth;", context, {
  filename: authPath,
});
const { normalizeUsername } = context.__auth;

const CASES = [
  ["ștefan", "Ștefan"],
  ["ȘTEFAN", "Ștefan"],
  ["Ștefan", "Ștefan"],
  ["ăsta țone", "Ăsta Țone"],
  ["ana-maria", "Ana-Maria"],
  ["ioan", "Ioan"],
  ["  gheorghe  ", "Gheorghe"],
  ["", ""],
];

const failures = [];
for (const [input, expected] of CASES) {
  const actual = normalizeUsername(input);
  if (actual !== expected) {
    failures.push(`  normalizeUsername(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, așteptat ${JSON.stringify(expected)}`);
  }
}

if (failures.length > 0) {
  console.error("Normalizarea numelor e greșită:\n" + failures.join("\n"));
  process.exit(1);
}
console.log(`Normalizarea numelor: ${CASES.length} cazuri, toate corecte.`);
