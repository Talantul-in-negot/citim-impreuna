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
