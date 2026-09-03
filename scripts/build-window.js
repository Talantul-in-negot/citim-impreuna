// Generează js/verses-1samuel.js și js/verses-2samuel.js din fișierele master
// (niciodată distribuite ca atare). Publică TOT conținutul disponibil — nu mai
// există fereastră săptămânală (aplicația are acum acord legal pentru textul
// integral). Rulează manual după orice modificare a fișierelor master:
//   node scripts/build-window.js
//
// SIGURANȚĂ: scriptul refuză să scrie dacă un fișier master lipsește sau dacă
// rezultatul ar avea mai puține versete decât fișierul deja generat. Varianta
// anterioară scria necondiționat, iar `loadMaster` întorcea [] pentru un master
// absent — adică o singură rulare într-un checkout fără master (cazul acestui
// repo) ștergea toate cele 1505 versete și aplicația rămânea goală.

const fs = require("fs");
const path = require("path");
const { loadVerseArray } = require("./validate-verses");

const FORCE = process.argv.includes("--force");

function masterPath(fileName) {
  return path.join(__dirname, "..", "js", fileName);
}

function loadMaster(fileName, exportName) {
  const filePath = masterPath(fileName);
  if (!fs.existsSync(filePath)) return null;
  delete require.cache[require.resolve(filePath)];
  return require(filePath)[exportName] || [];
}

function existingCount(outFileName, varName) {
  const filePath = path.join(__dirname, "..", "js", outFileName);
  if (!fs.existsSync(filePath)) return 0;
  try {
    return loadVerseArray(filePath, varName).length;
  } catch {
    return 0;
  }
}

function serializeVerse(v) {
  const blanksStr = v.blanks
    .map(
      (b) =>
        `{ answer: ${JSON.stringify(b.answer)}, options: ${JSON.stringify(b.options)} }`
    )
    .join(", ");
  return `  {\n    ref: ${JSON.stringify(v.ref)},\n    text: ${JSON.stringify(
    v.text
  )},\n    blanks: [${blanksStr}],\n  },`;
}

function writeFile(bookLabel, varName, outFileName, verses) {
  const header = `// GENERAT AUTOMAT din fișierul master de scripts/build-window.js — nu edita direct.\n// Conținut complet (${bookLabel}).\n\n`;
  const body = `const ${varName} = [\n${verses.map(serializeVerse).join("\n")}\n];\n`;
  fs.writeFileSync(path.join(__dirname, "..", "js", outFileName), header + body, "utf8");
  return verses.length;
}

const BOOKS = [
  {
    label: "1 Samuel",
    master: "verses-1samuel-master.js",
    masterExport: "VERSES_1SAMUEL_MASTER",
    out: "verses-1samuel.js",
    varName: "VERSES_1SAMUEL",
  },
  {
    label: "2 Samuel",
    master: "verses-2samuel-master.js",
    masterExport: "VERSES_2SAMUEL_MASTER",
    out: "verses-2samuel.js",
    varName: "VERSES_2SAMUEL",
  },
];

function main() {
  const loaded = BOOKS.map((book) => ({
    ...book,
    verses: loadMaster(book.master, book.masterExport),
    current: existingCount(book.out, book.varName),
  }));

  const problems = [];
  for (const book of loaded) {
    if (book.verses === null) {
      problems.push(
        `${book.label}: lipsește js/${book.master} — nu pot regenera js/${book.out} ` +
          `(are acum ${book.current} versete).`
      );
      continue;
    }
    if (book.verses.length < book.current) {
      problems.push(
        `${book.label}: masterul are ${book.verses.length} versete, dar js/${book.out} ` +
          `are deja ${book.current}. Scrierea ar pierde ${book.current - book.verses.length}.`
      );
    }
  }

  if (problems.length > 0 && !FORCE) {
    console.error("Nu s-a scris nimic:\n" + problems.map((p) => "  - " + p).join("\n"));
    console.error("\nAdaugă fișierele master, sau rulează cu --force dacă pierderea e intenționată.");
    process.exit(1);
  }
  if (problems.length > 0) {
    console.warn("--force: se scrie în ciuda avertismentelor:\n" + problems.map((p) => "  - " + p).join("\n"));
  }

  const counts = loaded.map((book) =>
    writeFile(book.label, book.varName, book.out, book.verses || [])
  );
  console.log(
    `Publicat integral: ${loaded.map((b, i) => `${b.label}=${counts[i]} versete`).join(", ")}`
  );
}

if (require.main === module) main();

module.exports = { loadMaster };
