# Audit remediation — 2026-09-03

Implements every finding from the repo audit. Ordered by the audit's severity.

## Blocking / high

- [x] 1. `get_public_leaderboard` gains a real `p_offset` parameter so the client's
      paginated RPC call resolves (PostgREST matches on exact argument names).
- [x] 2. Version-control the schema the client depends on: `events`, `scores`,
      every RLS policy, and `get_own_score`.
- [x] 3. Stop trusting the browser for `correct` / `cycle` / page + chapter
      metadata. Ship a server-side answer key and a BEFORE INSERT trigger that
      derives all of it, so scores are genuinely server-derived.
- [x] 4. Fix migration apply-order ambiguity (README + `00000000_` baseline) and
      collapse the triplicated scoring CTE into one `compute_user_points`.
- [x] 5. Add SRI to the jsDelivr supabase-js tag; tighten CSP with `form-action`.
- [x] 6. Service worker must not cache non-`ok` responses; precache the milestone
      image so the 1000-point celebration works offline.
- [x] 7. `normName` mangles Romanian diacritics — fixed at the root (see review).
- [x] 8. `scripts/build-window.js` must refuse to write when a master file is
      missing (today it silently empties the corpus).

## Low

- [x] 9. Retry the legacy `@test.com` login only on invalid-credential errors.
- [x] 10. Replace the non-atomic localStorage queue lock with `navigator.locks`.
- [x] 11. Stop silently evicting owned events; expire unclaimed ones instead.

## Smaller items

- [x] 12. Login button label regression (`"Intră"` → `"Intră în cont"`).
- [x] 13. Revoke the `anon` grant on `get_public_leaderboard`.
- [x] 14. Strip the UTF-8 BOM from `index.html`.
- [x] 15. Delete dead code: `Tracker.fetchAll`, `Tracker.fetchConfig`,
      `pushScore`, `renderStatsContent`, `groupByUser`, `computePointsForUser`.
- [x] 16. `package.json` + CI so the verse validators actually run.
- [ ] 17. NOT DOING: untracking `graphify-out/`. `CLAUDE.md` documents it as a
      committed feature of this repo, so removing it contradicts project
      instructions. Left as-is deliberately.

## Review

### Client

`js/auth.js` — legacy-domain retry now fires only on `invalid_credentials`, so a
rate-limited login no longer doubles its requests or replaces the accurate error
message. `normalizeUsername` exported for reuse, and **fixed**: it had the same
`\b` defect as `app.js` (see below).

`js/tracker.js` — queue mutual exclusion moved to `navigator.locks` (the
localStorage lock remains as fallback); `log()` stays synchronous by buffering in
memory, and `flush()` drains the buffer before sending. The 500-event cap now
applies only to *owned* events, so unclaimed anonymous ones can no longer evict
real points; unclaimed entries expire after 7 days, capped at 100. Added
`?on_conflict=client_event_id` to the events POST — without it
`resolution=ignore-duplicates` resolved on the generated primary key and never
deduplicated anything. `fetchAll` / `fetchConfig` deleted.

`js/app.js` — `pushScore`, `renderStatsContent`, `groupByUser` and
`computePointsForUser` deleted (~3.3 KB); `normName` replaced by `displayName`;
login button label restored.

`index.html` — BOM stripped, `form-action 'none'` added, and SRI on the
supabase-js tag (`sha384-AkNSQdpt…`, computed from the pinned 2.57.4 build).

`sw.js` — only `response.ok` is cached; `media/bible-book.jpg?v=2` precached;
`CACHE` bumped to v73 with all `?v=` values re-synced.

### Server

Three new files under `supabase/`, plus a README that documents the real apply
order and the two places where alphabetical order silently disagreed with intent.

`00000000_baseline_schema.sql` is idempotent and safe on the live database, but
it **cannot delete permissive policies it does not know the names of** — the
README opens with the `pg_policies` query to run first.

`20260903_02_server_verified_events.sql` is the substantive one: a BEFORE INSERT
trigger derives `correct`, `answer`, `page_index`, `page_size`, `chapter_ref`,
`chapter_size` and `cycle` from `public.verse_answers`, clamps `created_at` to a
30-day window, and stamps `recorded_at` server-side. `cycle` is now tracked in
`scores.current_cycle` and advances only when every page of the current cycle is
complete; the migration seeds it from each user's existing maximum so nobody's
progression resets. The scoring CTE that lived in three functions is now only in
`compute_user_points`.

### The one that was wrong in the audit

The audit said `Auth.normalizeUsername` was the correct diacritic-aware
implementation and `app.js` should delegate to it. It wasn't: JavaScript's `\b`
is defined via `\w = [A-Za-z0-9_]` even under the `/u` flag, so `/\b\p{L}/gu`
fails on exactly the same names `/\b\w/g` does. Delegating propagated the bug;
running `displayName('ștefan')` in the browser caught it. Fixed at the root and
pinned by `scripts/check-username-normalizer.js`. Recorded as L04 in
`tasks/lessons.md`.

### Verification

`npm test` (verse validators, asset-version lock-step, name normalizer) passes,
every shipped JS file parses, and the app was exercised in the browser:
supabase-js loads under SRI, a page of five verses scores 70 (5×10 + 20), the
service worker precaches all 14 assets including the milestone image, the queue
trim keeps 480 owned events while dropping 250 unclaimed ones, and the
leaderboard still escapes an injected `<img onerror>` name.

The SQL was **not** executed — there is no local Postgres. It is reviewed and
internally consistent, but it must be applied in the README's order, against a
backup of `scores`, before the client changes reach production: until the trigger
and the answer key exist, the leaderboard stays broken exactly as it is today.

## Post-deploy incident (2026-09-04) — closed

Applying the SQL live surfaced three more issues, none of them caught by
review — all found and fixed in follow-up commits:

- **`c262a96`** — `events`/`scores` had RLS policies but no table-level `GRANT`
  to `authenticated`. Every logged-in insert was silently rejected.
- **`88dd379`** — lost-update race in `recalculate_score_for_user` (two
  concurrent recompute triggers per answer, no lock spanning read+write).
  Fixed with a per-user `pg_advisory_xact_lock`; removed the redundant
  client-triggered recompute that doubled the race window.
- **Wrong Supabase project** — the user was applying migrations 03/04 to a
  different project (`llnlzbczdcjarzoizwgi`) than the live site
  (`szwrfxcshcbqgdtfqqfp`). Neither fix above ever reached production until
  this was caught. `supabase/apply_all.sql` (`02af553`) now bundles every
  migration into one paste, and `supabase/README.md` opens with a
  project-ref check to prevent a repeat. See `tasks/lessons.md` L07.
- **`ed4a5ff`** — independent live re-verification after the project fix
  found `get_public_leaderboard` was still readable by the unauthenticated
  `anon` role: `revoke ... from public` doesn't reach a grant a named role
  holds directly. Fixed with an explicit `revoke ... from anon`. See L08.

**Final state, confirmed 2026-09-04:**
- `get_public_leaderboard` verified live via `curl` with the anon key → `401`.
- User tested live, logged in, answering several pages in sequence: score
  holds correctly, no reversion.

Both the original bug report and everything found while chasing it are
closed.
