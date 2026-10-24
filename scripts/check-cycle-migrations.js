// Regresie: reaplicarea bundle-ului nu trebuie să anuleze reparațiile pentru
// utilizatorii care au terminat cartea înainte de introducerea baseline-ului.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "apply_all.sql"), "utf8");
const backfill = sql.lastIndexOf("-- supabase/20260907_01_backfill_event_page_index.sql");
const completionFix = sql.lastIndexOf("-- supabase/20260907_02_fix_completed_page_count_baseline.sql");
assert(backfill >= 0, "Bundle-ul trebuie să repare metadatele evenimentelor vechi");
assert(completionFix > backfill, "Repararea completării trebuie să urmeze backfill-ului");

const definitions = [...sql.matchAll(
  /create or replace function public\.completed_page_count\([\s\S]*?as \$\$([\s\S]*?)\$\$;/gi
)];
assert(definitions.length > 0, "Lipsește completed_page_count");
const finalDefinition = definitions.at(-1);
assert(finalDefinition.index > completionFix, "Ultima definiție trebuie să fie cea reparată");
const body = finalDefinition[1].replace(/--[^\n]*/g, "");
assert(!/\b(?:recorded_at|p_baseline_at)\b/i.test(body),
  "Completarea istorică nu poate exclude paginile terminate înainte de baseline");
assert(/coalesce\(e\.cycle,\s*0\)\s*=\s*p_cycle/i.test(body),
  "Completarea trebuie verificată separat pentru fiecare parcurgere");
assert(/count\(distinct e\.verse_ref\)/i.test(body),
  "Răspunsurile repetate la același verset nu pot completa o pagină");
assert(/perform public\.recalculate_score_for_user\(v_user_id\)/i.test(sql.slice(completionFix)),
  "Conturile deja blocate trebuie recalculate după repararea completării");
console.log("Cycle migrations: backfill și completare istorică păstrate în bundle.");
