/* Verifică faptul pe care sw.js îl cere printr-un comentariu: lista ASSETS
   trebuie să conțină EXACT aceleași URL-uri cache-busted ca index.html.
   CacheStorage potrivește și query string-ul, deci `js/app.js` precache-uit nu
   face `js/app.js?v=56` disponibil offline — divergența nu se vede decât la o
   instalare curată, pe telefonul altcuiva. (vezi tasks/lessons.md L01) */

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");

// URL-urile locale (nu cele de pe CDN) referite de index.html
const referenced = new Set();
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url = m[1];
  if (/^(https?:)?\/\//.test(url) || url.startsWith("data:") || url.startsWith("#")) continue;
  referenced.add(url);
}

const assetsBlock = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
if (!assetsBlock) {
  console.error("sw.js: nu am găsit lista ASSETS");
  process.exit(1);
}
const precached = new Set(
  [...assetsBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
);

const errors = [];

for (const url of referenced) {
  if (!precached.has(url)) {
    errors.push(`index.html cere "${url}", dar sw.js nu îl precache-uiește`);
  }
}

// Fiecare intrare din ASSETS trebuie să existe pe disc (cache.addAll eșuează
// în bloc la un singur 404, lăsând aplicația fără NICIUN fișier offline).
for (const url of precached) {
  if (url === "." || url === "./") continue;
  const filePath = path.join(root, url.split("?")[0]);
  if (!fs.existsSync(filePath)) {
    errors.push(`sw.js precache-uiește "${url}", dar fișierul nu există`);
  }
}

// Aceeași cale cu două versiuni diferite = exact bug-ul pe care lista îl previne.
const byPath = new Map();
for (const url of [...referenced, ...precached]) {
  const [file, query] = url.split("?");
  if (!byPath.has(file)) byPath.set(file, new Set());
  byPath.get(file).add(query || "");
}
for (const [file, queries] of byPath) {
  if (queries.size > 1) {
    errors.push(`"${file}" apare cu versiuni diferite: ${[...queries].join(" / ")}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Asset versions in sync: ${referenced.size} referite, ${precached.size} precache-uite.`);
