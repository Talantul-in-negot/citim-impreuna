# Lessons — Citim împreună

## L01 — PWA service workers need their own file to change, or updates never reach installed clients (2026-07-04)

Deployed two rounds of content/logic changes to `sergiunicoara.github.io/citim-impreuna` without touching `sw.js`. Browsers only re-check a service worker when the service worker *script's own bytes* change — untouched `sw.js` means the browser never re-installs it, so a cache-first `fetch` handler keeps serving whatever was cached on first visit forever, no matter how many times the underlying app files are pushed. User reported "still the same version on my phone" after two live deploys.

I had actually already written this exact warning into `tasks/todo.md` after the first cache issue (during local dev) — but the note only said "remember to bump `CACHE` in `sw.js`," and I didn't apply it when redeploying to the live site twice.

**Fix applied:** switched `sw.js`'s fetch handler from cache-first to network-first (try network, fall back to cache only when offline) — this makes the staleness bug structurally impossible going forward, instead of relying on remembering to bump a version string every deploy.

**Rule:** Any time an app has a service worker with a cache-first strategy, deploying new app content is *not* enough — either bump the cache-version string in the SW file itself with every deploy, or (preferred) use network-first/stale-while-revalidate so it self-heals. Prefer the structural fix over a "remember to do X" note — notes get missed under time pressure; a self-healing design doesn't.

**How to apply:** Before considering any static-asset deploy "done," check whether the project has a service worker and whether its fetch strategy could mask the very update just shipped.

## L02 — `display` set on the same selector as `[hidden]` silently breaks the `hidden` attribute (2026-07-04)

Wrote `.modal-backdrop { display: flex; ... }` for the name-entry modal, toggled via `element.hidden = true/false` in JS. This never actually hid the modal: CSS cascade origin ordering means *any* author-stylesheet rule beats the user-agent stylesheet's default `[hidden] { display: none }`, regardless of selector specificity. So the modal (full-viewport, `position: fixed`, `z-index: 20`) stayed visually on top and kept intercepting every tap, even though the JS `hidden` property correctly read `true`. Symptom from the user: "it got stuck on the first page after answering the name" — the modal was invisible-in-my-testing-assumption but very much still there and blocking.

Caught only by checking `getComputedStyle(el).display` directly — checking `el.hidden` (the JS/IDL property) or the accessibility snapshot was not enough, both looked "correct" while the element was still fully rendered and click-blocking.

**Rule:** Any time a component's CSS sets `display` unconditionally on an element that JS also toggles via the `hidden` attribute, add an explicit `.the-class[hidden] { display: none; }` override. Don't rely on the bare `hidden` attribute once the class already declares `display`.

**How to apply:** When building any show/hide overlay (modal, drawer, toast) styled with `display: flex/grid/block` in its base class, immediately add the `[hidden]` override in the same edit — don't wait to discover it by symptom. When diagnosing a "toggle doesn't seem to do anything" bug, check `getComputedStyle` first, not just the JS property.

## L03 — Enabling Supabase RLS with no policies silently blocks the anon key: reads return `[]`, not an error (2026-07-16)

Hit twice now. First on `events` (RLS auto-enabled when Supabase Auth was added — the leaderboard went empty with no error anywhere). Then again on `scores`: the table was created and RLS enabled, but without policies the anon key got `200 []` on SELECT and `401 / 42501 "new row violates row-level security policy"` on INSERT.

The nasty part is the asymmetry: **writes fail loudly, reads fail silently.** A blocked SELECT is not an error — RLS filters every row, so the client receives a perfectly valid empty array and cannot distinguish "table is empty" from "I am not allowed to see anything." Any `catch`-based error handling sails right past it.

Also note: `Prefer: resolution=merge-duplicates` (upsert) needs **both** an `insert` and an `update` policy — an insert policy alone makes the second write of the same key fail.

**Rule:** RLS is deny-by-default. Enabling it without policies does not "secure" a table — it disconnects it. After enabling RLS on any table this app reads with the anon key, immediately probe both verbs (`SELECT` and an upsert) with the anon key before assuming it works. Never infer "the table is empty" from `[]` on an RLS-enabled table.

**How to apply:** When adding any new Supabase table the client touches, ship the policies in the same SQL as the `create table`, then verify with a live read+write probe. Design the client to degrade safely, so an RLS misconfiguration costs performance, never correctness. *(2026-09-03: `renderStats`' full-scan fallback was removed — it recomputed the score from raw events with a third copy of the scoring rules. It now shows an explicit „clasamentul nu este disponibil” message instead of a silently different number.)*

**Related caveat (rezolvat 2026-08):** `tracker.js` trimitea odată doar cheia anon publică, deci fiecare cerere ajungea la Postgres ca rol `anon` — ceea ce forța politici `using (true)`, echivalente practic cu RLS oprit. Acum `authHeaders()` pune JWT-ul sesiunii în `Authorization`, iar politicile din `supabase/00000000_baseline_schema.sql` chiar restrâng la `user_id = auth.uid()`.

## L04 — `\b` in JavaScript is ASCII-only, even under the `/u` flag (2026-09-03)

Shipped the same bug twice, independently. `app.js` capitalised leaderboard names with `/\b\w/g`; `auth.js` capitalised usernames with `/\b\p{L}/gu` and *looked* correct because it used a Unicode property escape and a `ro-RO` locale. Both produced „ȘTefan” for „ștefan”.

The cause is that `\b` is defined in terms of `\w = [A-Za-z0-9_]`, and the `u` flag does not change that. So in „ștefan” the first word boundary sits *between* „ș” and „t” — the regex skips the real first letter and uppercases the second.

Worse, during the audit I read `auth.js`, saw `\p{L}` plus `toLocaleUpperCase('ro-RO')`, concluded it was the correct implementation, and made `app.js` delegate to it — propagating the bug instead of fixing it. It only surfaced because the fix was executed in the browser (`displayName('ștefan')` still returned „șTefan”) rather than reasoned about.

**Rule:** never use `\b` on text that can contain non-ASCII letters. Match the position explicitly: `/(^|[\s\-'’])(\p{L})/gu`. And when a regex „looks Unicode-aware”, check which parts actually are — `\p{...}` being Unicode-aware says nothing about `\b` next to it.

**How to apply:** any string-casing or word-splitting helper in this repo gets a diacritic case in `scripts/check-username-normalizer.js` before it is trusted. Run the function on real input; don't approve it by reading.

## L05 — „Server-derived” means the server derives the *inputs*, not just re-runs the formula (2026-09-03)

Three migrations were titled around making scores server-derived, and the SQL comments said the browser could no longer send a point total that might be altered. True — but the browser still computed `correct` (`s.value === s.dataset.answer`) and sent it, along with `cycle`, `page_index`, `page_size` and the chapter fields. The server faithfully re-applied the scoring formula to numbers it had never checked.

Because points are counted once per `(cycle, verse_ref)` and `cycle` had no constraint at all — `page_index` and `page_size` did — one request containing 1505 verses × 100 cycles was worth ~1.5 million points.

**Rule:** when moving a calculation server-side, list every field the formula reads and ask, for each one, *who produced this value*. A recomputation over attacker-supplied inputs is not a recomputation. If the server cannot independently derive a field, it needs its own copy of the ground truth — here, `public.verse_answers`, generated from the same verse files the client ships.

**How to apply:** the trigger `verify_event_before_insert` now overwrites every scoring input from the answer key, so `chosen` is the only thing the client still decides. If a new scoring input is ever added to `events`, it belongs in that trigger on the same day it is added.

## L06 — Read-then-write recompute needs a lock, or the last commit wins with stale data (2026-09-03)

Shipped a scoring recompute (`recalculate_score_for_user`) that reads all of a user's events, sums a total, then `UPDATE`s `scores.points`. Correct in isolation. Not correct under concurrency, because there are genuinely two independent triggers per answered page: the `AFTER INSERT` statement trigger on `events`, and `tracker.js`'s `flush()` calling the `upsert_own_score` RPC right after. Nothing serialized them.

Live symptom: a user's score rose after answering, then dropped back down on its own a moment later. Classic lost-update: transaction B starts its SELECT before transaction A's UPDATE commits, so B's snapshot doesn't include A's new events; B computes a smaller total from what it saw and commits it AFTER A, silently overwriting A's correct, larger number. The system had no way to know B's number was stale rather than a correction.

**Rule:** any „read current state, compute a new value, write it back” function that can be invoked concurrently for the same entity needs a lock spanning the read *and* the write — not just a lock around the write. `pg_advisory_xact_lock(hashtext(key::text))` at the top of the function is enough: it serializes every call for that key, and under READ COMMITTED the next call's SELECT (issued after the lock is granted) sees everything the previous call just committed, so recomputes become a strict superset instead of a race.

**How to apply:** before shipping any server-side recompute-and-store function, ask „can two of these run for the same row at once?” If yes (any client-triggered path plus any automatic trigger both writing the same aggregate counts as yes), it needs the lock from day one — don't wait for it to show up as a live symptom. Also remove redundant recompute triggers where one already covers the case: `flush()` was calling `upsert_own_score` after an events insert whose own `AFTER INSERT STATEMENT` trigger had already recomputed the score synchronously in the same transaction — a second call added nothing but doubled the race window.

## L07 — Never trust „am rulat” without confirming the project ref (2026-09-04)

Spent an entire live-debugging session chasing a score bug through two increasingly specific hypotheses (missing table grants, then a lost-update race) and two matching fixes — both correctly diagnosed, both genuinely shipped in `supabase/`, and **neither fixed the live symptom**, because the user was applying every migration to a different Supabase project (`llnlzbczdcjarzoizwgi`) than the one the live site actually points to (`szwrfxcshcbqgdtfqqfp`, from `js/config.js`). Both projects apparently share enough surface (tables named the same way) that „Success” in the SQL Editor looked identical either way.

The tell, in hindsight, was there from the very first message of that session: the pre-flight check (`select count(*) from pg_policies ...`) returned zero rows and `select ... from public.scores` errored with „relation does not exist” — on a site that had supposedly been live for months. I read that as „clean slate, proceed,” which was locally consistent, but I never asked the one question that would have caught the actual problem: is this the same project the app uses? I only asked for the project ref after two full fix-and-verify cycles had already failed to move the needle.

**Rule:** before treating any „I ran it” as ground truth for a live system with more than one possible target (multiple Supabase projects, multiple environments, multiple branches deployed to different places), get the identifier that disambiguates it — here, the project ref from the dashboard URL, compared against the ref embedded in the code the live site actually serves — before proposing or verifying any fix, not after the fix fails to help.

**How to apply:** the first diagnostic message in any „live thing isn't behaving as expected” conversation should include an explicit target-identity check whenever the surface (a cloud console, a dashboard, a deployed app) could plausibly have more than one instance. Don't infer „correct target” from a plausible-looking result; ask for the identifier directly. `supabase/apply_all.sql` (generated by `scripts/build-apply-all.js`) also reduces the blast radius of this class of mistake going forward: one paste, one project tab, no multi-step sequencing to get wrong.

## L08 — `revoke ... from public` does not revoke a grant held directly by a named role (2026-09-04)

Independent verification after the project-ref fix (L07) found a genuine security leak: `get_public_leaderboard` — real names and scores, all users — answered unauthenticated (`anon`) requests with a full 200 and real data, despite `20260903_02_server_verified_events.sql` doing `revoke all on function get_public_leaderboard(integer, integer) from public;` immediately after creating it. The identical pattern on `get_own_score` and `upsert_own_score` (created earlier, same revoke-then-grant shape) correctly returned 401 for the same anon key in the same probe. Same code shape, different live result — which is the tell that this isn't a logic bug in one file, it's a gap in what `revoke ... from public` actually reaches: it removes what the `PUBLIC` pseudo-role has, not a privilege a specific named role (`anon`) holds directly, however that grant originated (default privileges, an earlier migration on the same function name before a `drop`/`create`, or anything else).

**Rule:** `revoke ... from public` is not sufficient to lock a function or table down to specific roles. Revoke from every role that might have an independent grant, by name — `revoke all ... from public, anon;` at minimum on anything that must be authenticated-only — rather than assuming PUBLIC is the only thing to clean up.

**How to apply:** any migration that creates a `SECURITY DEFINER` function or a table meant to be restricted should immediately verify it live with the unauthenticated key, not just read the SQL and trust it. This is the second time in one session that „I read the migration and it looks right” was wrong (see L07) — the incident-review habit going forward is: after any grant/RLS change, curl the actual endpoint with the least-privileged key it should reject, and confirm the rejection, before considering the change done.

## L09 — L07's lesson (confirm the live target) applies to the static host too, not just the database (2026-09-07)

Spent a full session diagnosing a cross-device progress-sync bug — two real client-side fixes shipped, both correctly diagnosed, both genuinely pushed to `main` on `Talantul-in-negot/citim-impreuna` — and the user still saw the exact same broken behavior after each one. The site the user actually visits, `sergiunicoara.github.io/citim-impreuna`, turned out to be served from a completely different repository (`sergiunicoara/sergiunicoara.github.io`, `citim-impreuna/` subfolder), last pushed **2026-08-24** — two weeks stale, missing every fix from this session and several before it. `git remote -v` in this checkout only ever pointed at the org repo, so every push landed on `talantul-in-negot.github.io/citim-impreuna`, a URL nobody visits.

This is L07's exact lesson (never trust "I pushed it" without confirming the live target) but one layer up the stack — L07 was about picking the wrong Supabase *project*, this was about pushing to the wrong Git *repository* entirely, for a static site with no CI/CD step that would have caught the mismatch (no deploy workflow, no visible link from repo to live URL anywhere in-repo). Worse, the two copies had **diverged in both directions**: the stale live copy had independently gained a realistic photo-backdrop feature (`js/scenes.js`, `media/scenes/*.webp`) that was never ported back to the org repo — so a naive "just overwrite the live copy with what's in git" sync would have silently deleted a live, working feature nobody remembered was never merged back.

**Rule:** the moment a "live site doesn't reflect what I just shipped" symptom appears *after* confirming the push succeeded and the CI/deploy pipeline (if any) ran clean, stop trusting the repo-to-URL assumption and verify it directly: fetch the actual live URL's JS and grep for a string unique to the just-shipped change (`curl <live-url>/app.js | grep <new-function-name>`). Do this *before* proposing a second fix for the same symptom — a second correctly-diagnosed fix that still doesn't move the needle is itself the signal (same pattern as L07's two failed fix-and-verify cycles).

**How to apply:** for any project deployed as a static site, get the actual serving URL and its backing repo confirmed once, early — don't infer it from the repo's own remote or its README. When reconciling two diverged copies of the same app, diff every file before mirroring in either direction; do not assume "older push timestamp" means "strictly behind" — check for features present only in the copy about to be overwritten.

## L10 — A schema column added without backfill is a landmine for every row written before it, and a later "clean fresh-start" migration can silently make it permanent (2026-09-07)

Same session as L09, after the deploy-target fix didn't resolve the symptom either: a user with 1505/1505 verses answered correctly (verified client-side, straight from `verse_ref`) still had `scores.current_cycle` stuck at 0 forever — every new event kept re-stamping `cycle:0` no matter how much further reading happened. Two independent, compounding causes, found one at a time because each one alone looked sufficient to explain the symptom:

1. `page_index`/`page_size` were added to `events` via plain `alter table ... add column` (`20260813_server_derived_scores.sql`) with **no backfill**. Every event written before that migration got `page_index = NULL` forever. `completed_page_count()` requires `page_index is not null`, so any page made up entirely of pre-migration events could never be counted as complete — confirmed live: 453 of the oldest 1000 events had `page_index: null`.
2. Even after backfilling `page_index` (`20260907_01`), the cycle was *still* stuck. `completed_page_count()` also filtered `recorded_at > baseline_at` — a column that same `20260813` migration had set to `now()` for every existing user, specifically so `compute_user_points()` wouldn't double-count points already folded into `baseline_points`. That's correct for *points*. But `completed_page_count()` isn't computing points — it's answering "was this page ever read to completion," and it had inherited the same filter by copy-paste proximity, not by any actual need. Result: 27 of 301 pages had been genuinely completed, but only *before* `baseline_at`, so they could never count — confirmed by recomputing the same completion check client-side with and without the baseline filter and diffing the two page counts.

Both bugs were invisible to `git diff`-style code review (the SQL reads as reasonable in isolation) and invisible to points-based testing (points were always correct, because `compute_user_points()` was never wrong — only the *separate* cycle-completion function was). They were only found by comparing the client's own reconstruction of "is the book done" (built independently from `verse_ref`, ignoring the server's stored `page_index`/`cycle` entirely) against the server's answer, for the same real account, and pulling the thread on every point of disagreement instead of stopping at the first plausible-looking cause.

**Rule:** `alter table ... add column` on a table with existing rows creates two populations — rows with the new column meaningfully set, and rows without — and every function that reads that column needs to be *deliberately* correct for both, not just accidentally not-yet-tested against the old ones. A "preserve existing totals, start fresh from here" migration (any `baseline_at`/`baseline_points`-shaped pattern) is doing something similar but worse: it's not silent about old data, it's *permanently excluding* it from every function that later reuses the same filter — including functions whose actual job has nothing to do with why the filter was added in the first place (see also L05: know who produced each value a formula reads, and *why* — a filter correct for one purpose copied into a function with a different purpose is a bug that reads as intentional).

**How to apply:** when adding a column to a table with existing rows, either backfill it in the same migration or make every reader explicitly handle `NULL` as "unknown, not false." When adding a `baseline_*`-style fresh-start cutoff, grep every function that will filter by it and check, for each one, whether that function's actual question is about money (correct to filter) or about history/state (almost certainly wrong to filter) — don't let one migration's filter propagate into unrelated functions just because they happen to read the same timestamp column. When a live symptom survives a fix that was correctly diagnosed and correctly shipped, that itself means there's a second, independent cause — go looking for it immediately rather than re-verifying the first fix again.
