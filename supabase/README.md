# Migrări Supabase

## Categorii și epistole — ediția 2027

Pentru proiectul live deja actualizat cu paginarea pe capitole, aplică în ordine,
înainte de publicarea noului client:

1. `20261110_01_epistle_answer_key.sql` adaugă cheia epistolelor după paginile
   existente din Samuel. Indicii paginilor și răspunsurile din Samuel se păstrează.
2. `20261110_02_reading_categories.sql` adaugă profilul de lectură, categoria,
   revizia epistolei și validarea traseului. Migrarea nu rescrie punctajele,
   pragurile `baseline_at` sau ciclurile existente.
3. `20261110_03_citim_catalog_epistles.sql` (generată de
   `scripts/build-epistle-catalog.js`) adaugă cele 686 de versete din epistole în
   `public.citim_verse_catalog`. Rulează după 01; se oprește cu eroare dacă 01
   lipsește și nu face nimic pe o bază fără catalog.

4. `20261111_01_events_scores_fk_cascade.sql` face `on delete cascade` cheile
   `events.user_id` și `scores.user_id` spre `auth.users`. Pe live erau `NO ACTION`
   (tabelele create manual, înainte de migrații), deci un cont cu răspunsuri sau
   scor nu putea fi șters din dashboard. Idempotentă, nu modifică rânduri.

**Diferență între repo și baza live (descoperită pe 2026-11-11):** producția are
un al doilea trigger `BEFORE INSERT` pe `events`, `events_validate_citim_insert`
→ `validate_citim_event_insert()`, plus tabelul `public.citim_verse_catalog`.
Niciunul nu e în repo. Triggerul rulează înaintea lui `events_verify_before_insert`
(ordine alfabetică) și respinge orice verset absent din catalog sau orice alegere
care nu e una dintre cele 4 variante. Fără pasul 3, orice răspuns la o epistolă
ar fi refuzat. Când se schimbă corpusul, regenerează și această migrare.

Aplicarea în producție necesită confirmarea utilizatorului. Pentru o bază nouă,
`apply_all.sql` include și aceste două migrări la final. Pentru o bază live cu
categorii deja activate, aplică numai migrările noi relevante. Nu reaplica
întregul istoric pentru actualizarea categoriei sau a corpusului. Garda de la
începutul bundle-ului oprește execuția înaintea modificărilor dacă există deja
`reading_profiles`, deoarece istoricul ar reinstala regulile bazate numai pe Samuel.

`reading_profiles` permite citirea exclusiv a propriului profil. Categoria se
modifică prin RPC-ul autentificat `set_reading_category(p_category_id)`, care
validează identificatorul și întoarce profilul actualizat. La înscriere, categoria
validă din `auth.users.raw_user_meta_data.category_id` se copiază în profil.
Conturile vechi primesc categoria NULL, pentru alegerea explicită în client.

Traseul se calculează din categoria salvată: 1 Samuel, 2 Samuel, apoi epistola.
Serverul validează pagina curentă, ciclul și revizia epistolei. Toate scrierile
de categorie și evenimentele sunt serializate per utilizator cu același lacăt
ca recalculul scorului. Clientul sincronizează coada înaintea schimbării categoriei.

Schimbarea către altă epistolă mărește `epistle_revision`. Progresul epistolei
folosește această revizie, astfel încât noua epistolă începe de la prima pagină.
Progresul din Samuel și deduplicarea punctelor continuă să folosească ciclul,
independent de revizie. Revenirea la o epistolă deja punctată în același ciclu
nu mai acordă punctele respective. Ciclul se încheie după toate paginile traseului
selectat. Ciclurile istorice nu se redeschid.

Coada offline trebuie să transmită `cycle` și `epistle_revision`. Reîncercarea
aceluiași `client_event_id` este ignorată înainte de verificarea progresului,
inclusiv după trecerea la ciclul următor. Răspunsurile deja corecte trimise de
alt dispozitiv sunt și ele ignorate, inclusiv în cicluri anterioare. Evenimentele
neacceptate anterior, cu un ciclu sau o revizie expirată, sunt respinse pentru
resincronizare, nu mutate în ciclul nou. Detaliile erorii PostgREST sunt
`STALE_READING_CYCLE`, `STALE_READING_REVISION`, `STALE_READING_CATEGORY` sau
`STALE_READING_PAGE`, pentru ca clientul să poată păstra separat intrările
expirate și să informeze utilizatorul fără blocarea întregii cozi.

## Istoricul migrărilor

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
| 12 | `20260904_05_lock_down_anon_execute.sql` | **`get_public_leaderboard` era public** — `revoke ... from public` nu acoperă un grant făcut direct rolului `anon`. |
| 13 | `20260907_01_backfill_event_page_index.sql` | **Reparație pentru date live existente** — `page_index`/`page_size`/`chapter_ref`/`chapter_size` erau NULL pe evenimentele scrise înainte ca acele coloane să fie adăugate (fără backfill), ceea ce bloca `completed_page_count()` sub totalul real și ținea `current_cycle` blocat pe 0 la nesfârșit. Nu e nevoie pe o bază de date nouă (fără evenimente vechi) — doar pe proiectul live existent. Inclusă în `apply_all.sql`, pentru reaplicare sigură. |
| 14 | `20260907_02_fix_completed_page_count_baseline.sql` | **`completed_page_count()` filtra greșit după `baseline_at`** — corect pentru puncte (evită dublarea cu `baseline_points`), greșit pentru „a fost pagina asta citită vreodată" (nu are legătură cu banii). Pagini terminate doar înainte de `baseline_at` nu se numărau niciodată, ținând ciclul blocat pe 0. `compute_user_points()` (scorul propriu-zis) rămâne neatins. Inclusă la final în `apply_all.sql`, ca reaplicarea să nu anuleze corecția. |

Pe o bază de date **nouă** e suficient să rulezi 1, 8, 9, 10, 11, 12, 13 și 14 (sau, mai simplu,
`apply_all.sql`, care le conține pe toate în ordine) — fișierele 2–7 sunt istoric.

## Ziua de streak începe la 03:00

Migrarea `20261024_01_streak_day_starts_at_03.sql` mută începutul zilei la
**03:00, Europe/Bucharest**, inclusiv la schimbările orei de vară. Răspunsurile
de la 00:00 până la 02:59 se grupează cu ziua precedentă. Migrarea recalculează
scorurile folosind noua grupare a zilelor și este inclusă ultima în `apply_all.sql`.
Clientul folosește aceeași regulă pentru cele șapte stele.

## Paginare pe capitole

`20261029_01_chapter_pages.sql` mută începutul fiecărui capitol pe o pagină
nouă (maximum cinci versete). Pentru corpusul actual rezultă 324 de pagini.
Aplică această migrare pe live **înainte de publicarea clientului nou**.
Ea actualizează atomic cheia existentă și metadatele evenimentelor, blochează
scrierile pe durata migrării și verifică păstrarea punctajelor.

Nu aplica separat cheia regenerată pe o bază live înaintea acestei migrări.
`baseline_at` rămâne neschimbat; `baseline_points` devine offset-ul semnat
care păstrează totalul anterior în ciuda regrupării bonusurilor istorice de pagină.
O reaplicare nu modifică punctajele. Bundle-ul include migrarea la final.
În browser, indicii locali vechi se mută după referințele versetelor;
coada offline rămâne intactă.

## Cel mai simplu: un singur fișier

`apply_all.sql` concatenează migrările necesare unei baze noi, inclusiv paginarea,
epistolele și categoriile. Regenerează-l cu `node scripts/build-apply-all.js` dacă
se adaugă o migrație nouă. `npm run check:migrations` verifică sincronizarea și
păstrarea corecțiilor de ciclu. După activarea categoriilor, folosește numai
migrările incrementale. Garda bundle-ului refuză reaplicarea istoricului complet
pe o bază care are deja `reading_profiles`.

**Pentru punctaj blocat după terminarea cărții:** verifică pe proiectul live dacă
evenimentele vechi au metadatele paginii și dacă `completed_page_count()` exclude
greșit evenimentele dinainte de `baseline_at`. Reaplicarea vechiului bundle putea
anula corecția din 7 septembrie. Pentru aceste două cauze, aplică în ordine
`20260907_01_backfill_event_page_index.sql` și
`20260907_02_fix_completed_page_count_baseline.sql`; acestea recalculează și ciclul.
Bundle-ul actual include ambele reparații la final, inclusiv pe o bază nouă,
pentru ca o reaplicare ulterioară să nu reinstaleze regula greșită. Nu reseta
manual punctajul sau ciclul în browser: serverul stabilește ciclul evenimentelor.

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
