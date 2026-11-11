// Referințele furnizate în tasks/ și structura completă a fiecărei epistole.
// Titlurile sunt enumerate explicit: un rând nenumerotat poate continua un verset.
const EPISTLE_BOOKS = [
  {
    "id": "iuda",
    "name": "Iuda",
    "referencePath": "tasks/iuda-reference-text.md",
    "chapterSizes": [
      25
    ],
    "headings": [
      "Urare",
      "Împotriva celor nelegiuiți",
      "Îndemn și laudă"
    ]
  },
  {
    "id": "1petru",
    "name": "1 Petru",
    "referencePath": "tasks/1petru-reference-text.md",
    "chapterSizes": [
      25,
      25,
      22,
      19,
      14
    ],
    "headings": [
      "Urare",
      "Mulțumiri pentru nădejdea mântuirii",
      "Îndemn la sfințenie",
      "Hristos, piatra din capul unghiului",
      "Buna purtare și supunerea la stăpâniri",
      "Datoriile slugilor",
      "Datoriile soților",
      "Îndemn la răbdare și la pace",
      "Pilda lui Isus Hristos",
      "Purtarea de acum încolo",
      "Felurite îndemnuri",
      "Mângâieri de nădăjduit",
      "Sfaturi către prezbiteri",
      "Sfaturi către tineri. Smerenia și vegherea",
      "Urări de sănătate"
    ]
  },
  {
    "id": "filipeni",
    "name": "Filipeni",
    "referencePath": "tasks/filipeni-reference-text.md",
    "chapterSizes": [
      30,
      30,
      21,
      23
    ],
    "headings": [
      "Urare",
      "Dragostea lui Pavel pentru filipeni",
      "Închisoarea în folosul Evangheliei",
      "Îndemn la stăruință",
      "Îndemn la smerenie",
      "Îndemn la sfințenie",
      "Pavel îl laudă pe Timotei",
      "Lauda lui Epafrodit",
      "Ferirea de învățători mincinoși",
      "Alipirea de Hristos",
      "Îndemnuri",
      "Îndemn la bucurie și la rugăciune",
      "Pavel mulțumește pentru darurile primite",
      "Urări de sănătate"
    ],
    "markerlessVerse": "De aceea, preaiubiții și mult doriții mei frați, bucuria și cununa mea, rămâneți astfel tari în Domnul, preaiubiților!"
  },
  {
    "id": "evrei",
    "name": "Evrei",
    "referencePath": "tasks/evrei-reference-text.md",
    "chapterSizes": [
      14,
      18,
      19,
      16,
      14,
      20,
      28,
      13,
      28,
      39,
      40,
      29,
      25
    ],
    "headings": [
      "Cea din urmă descoperire a Tatălui",
      "Fiul, mai presus de îngeri",
      "El a vestit o mare mântuire",
      "Dumnezeu I-a supus totul",
      "Isus este mai mare decât Moise",
      "Să nu ne împietrim inima ca israeliții",
      "Să căutăm să intrăm în odihna Lui",
      "Isus, Mare-Preot",
      "Hristos, Mare-Preot după rânduiala lui Melhisedec",
      "Pruncia cititorilor",
      "Cei căzuți de la credință",
      "Făgăduința dată lui Avraam",
      "Melhisedec, mai mare decât Levi",
      "Preoția lui Hristos desființează preoția levitică",
      "Isus mijlocește un nou legământ",
      "Legământul cel nou arată pieirea celui vechi",
      "Descrierea vechiului Cort",
      "Hristos, prin jertfa Lui, este Mare-Preot",
      "Hristos a venit să facă voia lui Dumnezeu",
      "Îndemn la încredere și la tărie în credință",
      "Lupta de la început a cititorilor",
      "Credința",
      "Pilde de credință",
      "Pilda lui Avraam și a Sarei",
      "Pilda lui Isaac, Iacov și Iosif",
      "Pilda lui Moise",
      "Pilda curvei Rahav și a prorocilor",
      "Pilda lui Hristos",
      "Stăruința în încercări",
      "Pilda lui Esau",
      "Îndemn la sfințire",
      "Felurite îndemnuri creștinești",
      "Îndemn la urmarea lui Hristos",
      "Dorințele apostolului",
      "Urări de sănătate"
    ]
  },
  {
    "id": "galateni",
    "name": "Galateni",
    "referencePath": "tasks/galateni-reference-text.md",
    "chapterSizes": [
      24,
      21,
      29,
      31,
      26,
      18
    ],
    "headings": [
      "Urare",
      "Nestatornicia galatenilor",
      "Evanghelia lui Pavel",
      "Încuviințarea apostolilor",
      "Pavel îl înfruntă pe Petru",
      "Legea și credința",
      "Făgăduința și Legea",
      "Moștenitorul și credința",
      "Galatenii și învățătorii mincinoși",
      "Pilda lui Agar și a Sarei",
      "Slobozenia creștină",
      "Îndemn la trăire în dragoste",
      "Faptele firii pământești și Duhul",
      "Îndemn la sprijinirea altora",
      "Dărnicia",
      "Singura laudă a apostolului"
    ]
  }
];

function normalize(text) {
  return text.normalize('NFC').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș')
    .replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/\s+/g, ' ').trim();
}

function parseEpistleReference(raw, book) {
  const headings = new Set(book.headings.map(normalize));
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    const value = normalize(line);
    if (/^---\s*$/.test(value)) break;
    if (value.startsWith('#') || headings.has(value)) continue;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  const markers = [...text.matchAll(/(?:^|\s)(\d{1,3})\s+/g)];
  if (!markers.length || text.slice(0, markers[0].index).trim()) {
    throw new Error(`${book.name}: text nerecunoscut înaintea primului verset`);
  }
  const references = new Map();
  const chapterCounts = [];
  let chapter = 0;
  let previous = 0;
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index];
    const number = Number(marker[1]);
    if (number === 1) {
      chapter++;
      previous = 0;
      chapterCounts.push(0);
    }
    if (!chapter || number !== previous + 1) {
      throw new Error(`${book.name}: verset neașteptat ${chapter}:${number}, după ${previous}`);
    }
    const verseText = normalize(text.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? text.length));
    if (!verseText) throw new Error(`${book.name} ${chapter}:${number}: text gol`);
    references.set(`${book.name} ${chapter}:${number}`, verseText);
    chapterCounts[chapter - 1]++;
    previous = number;
  }
  if (JSON.stringify(chapterCounts) !== JSON.stringify(book.chapterSizes)) {
    throw new Error(`${book.name}: capitole/versete incomplete (${chapterCounts.join(', ')})`);
  }
  return references;
}

module.exports = { EPISTLE_BOOKS, parseEpistleReference, normalize };
