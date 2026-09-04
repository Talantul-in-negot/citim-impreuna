# Migrări Supabase

Se aplică **în ordine alfabetică a numelor de fișiere**, din SQL Editor.
Ordinea alfabetică este acum și ordinea corectă — nu a fost mereu, vezi mai jos.

| # | Fișier | Ce face |
|---|--------|---------|
| 1 | `00000000_baseline_schema.sql` | `events`, `scores`, indexuri, politici RLS, `get_own_score`. Idempotent. |
| 2 | `20260813_daily_chapter_streak_bonus.sql` | Coloanele `chapter_ref` / `chapter_size` + bonusul de consecvență. |
| 3 | `20260813_normalize_accounts.sql` | Normalizează conturile `@test.com` vechi și numele afișate. |
| 4 | `20260813_server_derived_scores.sql` | `page_index` / `page_size` / `recorded_at` + `baseline_*`. |
| 5 | `20260813_server_score_trigger.sql` | Recalcul automat la fiecare inserare de eveniment. |
| 6 | `20260824_leaderboard_user_id.sql` | Clasamentul întoarce și `user_id`. |
| 7 | `20260824_leaderboard_domain_split.sql` | Clasament separat pe domeniul contului. |
| 8 | `20260903_01_verse_answer_key.sql` | Cheia de răspunsuri (**generată** — vezi mai jos). |
| 9 | `20260903_02_server_verified_events.sql` | Trigger de verificare, punctaj într-un singur loc, `p_offset` pe clasament. |
| 10 | `20260903_03_grant_authenticated.sql` | **Grant-uri de tabel lipsă** — fără ele, fiecare insert al unui utilizator logat era respins în tăcere. |
| 11 | `20260903_04_fix_score_race_condition.sql` | **Cursa de recalcul a scorului** — două recalculări simultane puteau suprascrie una pe alta cu o valoare mai veche. Blocare per utilizator + rebașeză.

Pe o bază de date **nouă** e suficient să rulezi 1, 8, 9, 10 și 11 — fișierele 2–7 sunt
istoric, iar 1, 8, 9, 10 și 11 conțin deja starea finală a schemei și a funcțiilor.

## Cel mai simplu: un singur fișier

`apply_all.sql` concatenează, în ordine, fișierele 1, 8, 9, 10 și 11 de mai jos într-un singur script — se lipește o singură dată în SQL Editor și se rulează. Regenerează-l cu `node scripts/build-apply-all.js` dacă se adaugă o migrație nouă. Complet idempotent — sigur de rulat chiar dacă unele fișiere au rulat deja parțial pe acel proiect.

**Înainte să rulezi orice, confirmă proiectul.** URL-ul din bara de adrese a dashboard-ului trebuie să conțină exact codul din `SUPABASE_URL` din [`js/config.js`](../js/config.js) (`https://<cod>.supabase.co`). Un cont Supabase cu mai multe proiecte face confuzia asta foarte ușor de făcut — vezi L07 în `tasks/lessons.md`.

## De ce prefixele

Fișierele 2–5 poartă toate data `20260813` și redefinesc `upsert_own_score` unul
peste altul. Aplicate în ordine alfabetică, versiunea cu bonusul de consecvență
(`daily_chapter_streak_bonus`) rulează **prima** și e imediat suprascrisă de
`server_derived_scores`, care nu are bonusul. Rezultatul final e totuși corect,
dar numai pentru că `server_score_trigger` (ultimul alfabetic) delegă către
`recalculate_score_for_user`, care îl conține. A fost noroc, nu proiectare.

La fel la `20260824`: `domain_split` presupune `user_id` deja adăugat de
`leaderboard_user_id`, dar sortează *înaintea* lui. O reaplicare a directorului
în ordine alfabetică ar fi anulat în tăcere separarea pe domenii, unind
clasamentele `@test.com` și `@citim.app`. Tabelul de mai sus dă ordinea reală, iar
fișierul 9 recreează funcția cu ambele proprietăți, ca reaplicarea să nu mai
poată regresa.

**Regulă pentru migrările noi:** dacă într-o zi apar mai multe, numerotează-le
(`YYYYMMDD_01_`, `YYYYMMDD_02_`, …).

## Cheia de răspunsuri e generată

`20260903_01_verse_answer_key.sql` nu se editează manual:

```bash
npm run build:answer-key
```

CI rulează `npm run build:answer-key -- --check` și pică dacă fișierul nu mai
corespunde versetelor din `js/verses-*.js`. Dacă se schimbă corpusul, migrarea
trebuie regenerată **și reaplicată**, altfel triggerul respinge versetele noi cu
`Unknown verse reference`.

## Înainte de a aplica pe baza de date live

1. **Listează politicile existente.** Baseline-ul adaugă politicile corecte, dar
   nu poate șterge politici permisive create manual în Dashboard, al căror nume
   nu îl cunoaște:

   ```sql
   select schemaname, tablename, policyname, cmd, qual, with_check
   from pg_policies where schemaname = 'public';
   ```

   Orice politică pe `events` / `scores` care nu apare în baseline (tipic
   `using (true)`) trebuie ștearsă manual, altfel restrângerea la „doar rândurile
   tale" nu are efect.

2. **Verifică duplicatele din `scores`.** Baseline-ul creează un index unic pe
   `user_id`; dacă există duplicate, migrarea eșuează în întregime (intenționat):

   ```sql
   select user_id, count(*) from public.scores group by user_id having count(*) > 1;
   ```

3. **Fișierul 9 rescrie scorurile tuturor.** Ultimul bloc recalculează fiecare
   utilizator. `baseline_points` / `baseline_at` sunt păstrate, deci rezultatele
   deja obținute nu se pierd — dar merită o copie a tabelului `scores` înainte.

4. **Ordinea client/server contează.** Fișierul 9 respinge orice eveniment cu un
   `verse_ref` necunoscut, așa că aplică 8 înaintea lui 9, iar 9 înainte de a
   publica un corpus de versete modificat.

## Ce a rămas neimplementat

`app_config.leaderboard_size` era citit de `Tracker.fetchConfig`, care nu era
apelat de nicăieri și a fost șters din client. Tabelul nu se mai creează; dacă
mărimea clasamentului devine configurabilă, se adaugă atunci, împreună cu codul
care chiar o folosește.
