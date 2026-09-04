/* Genereaza supabase/apply_all.sql prin concatenarea, in ordine, a migratiilor
   pe care README.md le recomanda pentru o baza de date noua. Fiecare fisier
   isi pastreaza propriul begin;...commit; (tranzactii separate, secventiale),
   deci rezultatul poate fi lipit si rulat dintr-o singura data in SQL Editor.

   Sursa de adevar ramane fiecare fisier individual - README.md explica de ce
   ordinea asta (nu alfabetica simpla) conteaza. Acesta e doar o comoditate,
   ca sa nu mai existe loc pentru "am rulat unele fisiere, nu toate, in ordine
   gresita, in alt tab" - vezi tasks/lessons.md L07.

   Adauga o migratie noua in FILES de mai jos, apoi ruleaza:
     node scripts/build-apply-all.js
*/

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_FILE = path.join(ROOT, "supabase", "apply_all.sql");

// Ordinea recomandata pentru o baza de date noua, per supabase/README.md.
const FILES = [
  "00000000_baseline_schema.sql",
  "20260903_01_verse_answer_key.sql",
  "20260903_02_server_verified_events.sql",
  "20260903_03_grant_authenticated.sql",
  "20260903_04_fix_score_race_condition.sql",
  "20260904_05_lock_down_anon_execute.sql",
];

function main() {
  const relFiles = FILES.map((f) => path.join("supabase", f));

  const header = [
    "-- APLICARE COMBINATA - GENERAT AUTOMAT de scripts/build-apply-all.js, nu edita direct.",
    "-- Regenereaza cu: node scripts/build-apply-all.js",
    "--",
    "-- Concatenarea, in ordine, a fisierelor de mai jos. Fiecare are propriul",
    "-- begin;...commit; (tranzactii separate, secventiale), deci scriptul poate",
    "-- fi lipit si rulat dintr-o singura data in SQL Editor.",
    "--",
    "-- Sursa de adevar ramane fiecare fisier individual din supabase/ - README.md",
    "-- descrie de ce ordinea asta si nu alfabetica simpla. Fisierul asta e doar o",
    "-- comoditate ca sa nu mai existe loc pentru \"am rulat unele, nu toate, in",
    "-- ordine gresita, in alt proiect\" - vezi tasks/lessons.md L07.",
    "--",
    "-- Idempotent in intregime: sigur de rulat de mai multe ori, inclusiv peste",
    "-- o baza de date pe care unele dintre aceste fisiere au rulat deja partial.",
    "--",
    "-- Inainte sa rulezi: confirma ca esti pe proiectul corect (bara de adrese a",
    "-- dashboard-ului trebuie sa contina codul din SUPABASE_URL din js/config.js).",
    "--",
    "-- Fisiere incluse, in aceasta ordine:",
    ...relFiles.map((f) => `--   ${f}`),
    "",
    "",
  ].join("\n");

  const parts = [header];
  for (const rel of relFiles) {
    const filePath = path.join(ROOT, rel);
    if (!fs.existsSync(filePath)) {
      console.error(`Lipseste: ${rel}`);
      process.exit(1);
    }
    const content = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").trimEnd();
    parts.push("-- " + "=".repeat(76));
    parts.push(`-- ${rel}`);
    parts.push("-- " + "=".repeat(76));
    parts.push("");
    parts.push(content);
    parts.push("");
    parts.push("");
  }

  fs.writeFileSync(OUT_FILE, parts.join("\n"), "utf8");
  console.log(`Scris ${path.relative(ROOT, OUT_FILE)}: ${relFiles.length} fisiere combinate.`);
}

main();
