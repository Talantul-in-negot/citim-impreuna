# Handoff — categorii de vârstă și epistole

## Stop requested by user

The user explicitly asked to stop implementation here and hand it to another AI coding agent. Resume only when the user authorizes the next agent to continue. Work is uncommitted and local. No new migrations were applied to production and no feature changes were pushed. All implementation subagents were stopped or had completed.

Workspace: `C:\Users\Sergiu\Desktop\Projects\Talantul-in-negot\citim-impreuna`.
Branch: `main`. Last existing published commit: `717a2e1` (today's streak star).
Remote: `https://github.com/Talantul-in-negot/citim-impreuna.git`.

## Accepted requirements

- Signup requires an age-category combobox. Existing accounts without a saved category must choose one after login before reading.
- Categories: `preschool_1`, `grades_2_3` -> Iuda; `grades_4_5` -> 1 Petru; `grades_6_7` -> Filipeni; `grades_8_9` -> Galateni; `grades_10_11`, `adults_18_35`, `adults_35_plus` -> Evrei.
- Reading is strictly sequential: **1 Samuel -> 2 Samuel -> category epistle -> restart at 1 Samuel**. No book selector, backward navigation or skipping unanswered pages.
- Keep existing Samuel progress, scores and cycles. Existing completed Samuel in the current cycle continues into the epistle. Previously advanced cycles remain advanced.
- Category can be changed from account. Shared Samuel progress stays. Changing to a different epistle restarts that epistle from its first page, while previously credited answers/pages cannot earn points again within that cycle.
- Every chapter starts a new page, up to five verses per page.
- Streak day begins at 03:00 Europe/Bucharest. Preserve today-star UI and celebration fades.
- App is also used for practice by people who do not compete. Use inclusive wording for all ages.
- All source references should have the same Markdown format. User explicitly requested `*.md`.
- **Ask before push and before production migrations. Do not send any emails without explicit confirmation.**

SBIR email approval explicitly covers all five epistles Iuda, 1 Petru, Filipeni, Evrei, Galateni in addition to 1/2 Samuel. No more OT books were granted. Existing copyright attribution remains.

## Implemented files

### Frontend

- `js/reading-path.js` (new): UMD category catalog. Exposes `ReadingPath.categories`, `getCategory`, `buildVerses(categoryId, samuel, epistles)`, `isSamuelRef`, `bookName`.
- `js/app.js`: mutable selected-route PAGES/REF_PAGE/CHAPTER_SIZES, category gates and dialog, account editing, per-uid verified profile cache, revision-aware epistle progress, all-revision credited verse set, changed book titles and final screen, async identity guards.
- `js/auth.js`: signup accepts category and stores `category_id` in auth metadata.
- `index.html`, `css/style.css`: signup selector, compulsory category dialog, account category settings, explanatory text. Includes two new script tags.
- `js/tracker.js`: `fetchOwnProfile()` reads own `reading_profiles`; `saveCategory(id)` calls RPC `set_reading_category(p_category_id)`; fetchUserEvents now also returns `epistle_revision`.

### Sources and exercise generation

- Five new `tasks/{iuda,1petru,filipeni,evrei,galateni}-reference-text.md` files converted from supplied TXT files, matching Samuel's Markdown header/body/note convention.
- All **686** epistle verses retained exactly. Filipeni 4:1 text was already present but lacked its number; restored numeric marker and documented it in reference note.
- Counts: Iuda25/1 chapter, 1Petru105/5, Filipeni104/4, Evrei303/13, Galateni149/6.
- `scripts/epistle-reference.js`: parser, explicit heading whitelist and expected chapter lengths.
- `scripts/build-epistles.js`: deterministic one-blank/four-option exercise generator, supports `--check` and existing validation.
- `js/verses-epistles.js`: global `EPISTLES` arrays keyed `iuda`, `1petru`, `filipeni`, `evrei`, `galateni`.
- `scripts/audit-reference-text.js` now audits all seven books.

### Database

- `scripts/build-epistle-answer-key.js` and generated `supabase/20261110_01_epistle_answer_key.sql`: append canonical answer-key rows after original 1505 Samuel verses /324 pages. Canonical epistle page IDs are unique across ALL five epistles, while client selected-route indices always append one epistle after324. Server ignores client page_index and stamps canonical IDs. This distinction is intentional.
- `supabase/20261110_02_reading_categories.sql`:
  - `reading_profiles(user_id, category_id, epistle_revision, updated_at)` with own-read RLS, writes only through authenticated RPC.
  - Auth signup trigger validates and initializes category metadata.
  - `set_reading_category(p_category_id)` returns composite profile row, serializes on same advisory lock as event writes/scoring.
  - `events.epistle_revision` added. Changing mapped epistle increments revision. Samuel progress ignores revision, epistle progress matches active revision. Scores dedupe across revisions.
  - Helpers `category_epistle`, `reading_book_key`, `reading_route_pages`, `next_reading_page`.
  - Replaces route completion, event verification and score-recalc cycle advancement. Enforces current page, category, cycle, revision, server-owned answers.
  - Exact event-ID retry, already-correct same-cycle replay and previously completed old-cycle replay return NULL under lock rather than receive fresh credit.
  - Stale-event errors have details `STALE_READING_REVISION`, `STALE_READING_CATEGORY`, `STALE_READING_CYCLE`, `STALE_READING_PAGE`.
  - Supports offline batch crossing completed cycle into next one when supplied cycle=current+1.
  - Preserves historical points and current_cycle on migration.
- `scripts/build-apply-all.js`, generated `supabase/apply_all.sql`, `supabase/README.md`: ordered two new migrations and fail-fast guard preventing full legacy bundle reapplication to a category-enabled database. Historical migrations would otherwise temporarily reinstall old cycle logic and corrupt advancement. For existing category deployments use incremental migrations, not full bundle.

## Verification already completed

- Text agent ran generator, reproducibility `--check`, existing exercise validation, full seven-book reference audit and syntax checks. Epistles have zero text or formatting differences. Compared full reference maps before and after Markdown conversion, all686 identical.
- Frontend agent ran syntax and an isolated VM harness covering selected routes, revision changes, all-revision credit retention, and stale-account guards. Harness was temporary, not committed as a test script.
- Root added `scripts/check-category-database.js`, executing real PostgreSQL through PGlite with local Supabase auth stubs and actual migrations. It PASSED on current code for migration preservation, all8 routes, RLS, invalid category rejection, signup metadata, strict order, epistle switches/revisions, score dedupe, another-device replays, cycle restart and incremental migration reapplication.
- PGlite installed temporarily at `C:\Users\Sergiu\AppData\Local\Temp\citim-sql-check\node_modules\@electric-sql\pglite` (0.5.16). It is NOT yet in package.json or CI. Run from PowerShell:

```powershell
$env:CI_PGLITE_MODULE='C:\Users\Sergiu\AppData\Local\Temp\citim-sql-check\node_modules\@electric-sql\pglite'
node scripts/check-category-database.js
```

**Full suite and real-browser verification have not yet been run for this feature. Do not treat the feature as finished.**

## Integration status (2026-11-10, second agent)

All local, uncommitted, not pushed, no production migrations applied.

1. DONE — First category saves before flushing: `handleCategorySave` reads the authoritative profile; `Tracker.saveCategory(id, { initial })` skips the empty-queue gate only for the first category.
2. DONE — `handleCategorySave` awaits an in-flight `sessionSyncPromise` before reading/saving the profile.
3. DONE — `Tracker.flush`: on a rejected batch with an explicit permanent reason (`STALE_READING_*` detail or unknown verse) it retries one event at a time in order; permanent rejections go to `localStorage.ci_rejected_events` (kept, never restamped), the first transient failure stops and keeps order. Everything else (offline, 401/403/429/5xx, "choose a category", unknown errors) keeps the queue. `syncProgressFromCloud` shows a visible notice via `Tracker.takeUnseenRejections()`.
4. DONE — `sw.js` precaches the two new scripts; bumped CSS v53, auth v47, tracker v57, app v68, cache v90.
5. DONE — `check-progress-resume.js` and `check-chapter-pages.js` load the real `isCurrentPathEvent` (plus an old-revision epistle case); new `scripts/check-offline-queue.js`; `package.json` adds `check:syntax`, `check:generated`, `check:offline-queue`, `check:category-db`; PGlite 0.5.16 pinned as devDependency with `package-lock.json`; CI runs `npm ci` and every check; `node_modules/` gitignored.
6. PARTLY — Verified in a local browser at 375px with stubbed backend: compulsory modal cannot be dismissed (Escape, backdrop, hidden cancel) and blocks reading; first-category save with pending queue; change with pending queue refused; race ordering; sync notice layout. Fixed a 3px overflow of "Salvează categoria". NOT verified: real login/register against Supabase (no test credentials; production-only backend), a real device.
7. OPEN — Label texts kept as written; see review note to the user.
8. DONE locally — `npm test` green, generated files `--check` clean. Commit, push and production migrations await user approval.

## Known remaining integration fixes — priority (original list)

1. **First-category save deadlock with pre-upgrade offline queue.** Both app `handleCategorySave()` and Tracker.saveCategory currently flush and refuse category save if pending events remain. Backend rejects events for profile.category_id=NULL, so an old account with pending Samuel answers cannot choose a category. First category assignment must save first, then flush; only subsequent changes require flushing before save. Fetch authoritative profile to decide initial-vs-change, preserving account guards.

2. **Category-save versus existing session sync race.** In `handleCategorySave`, wait for any existing `sessionSyncPromise` after marking categorySaving=true, before changing the profile. Otherwise an older in-flight profile fetch/sync can reapply the old category/revision after a new save.

3. **Obsolete offline events can poison queue.** Tracker.flush currently returns immediately on ANY non-ok POST and keeps whole batch forever. Backend intentionally rejects stale revision/category/cycle/page (details listed above). Need explicit recovery: preserve rejected answers for review, report a clear user-visible sync issue, and permit valid later events plus authoritative profile/progress reconciliation. Never blindly restamp old events with new cycle/category. A rejected batch is atomic; per-event fallback can identify obsolete events while submitting valid ones in order. Design carefully, do not silently lose legitimate pending progress. No implementation was made for this yet.

4. **Assets/cache not integrated yet.** `index.html` includes new `js/verses-epistles.js?v=1` and `js/reading-path.js?v=1`, but `sw.js` ASSETS lacks them. Bump versions for changed app/auth/tracker/CSS and cache version, keep URLs identical between index and sw. Current base versions: cachev89, CSSv52, authv46, trackerv56, appv67.

5. **Test harnesses/package/CI not integrated yet.** Existing `scripts/check-progress-resume.js` extracts functions and needs newly required harness context (hasReadingCategory stub, isCurrentPathEvent, Auth.getUserId, creditedThisCycle). `check-chapter-pages.js` likewise needs isCurrentPathEvent for extracted helpers. Adapt tests meaningfully, don't remove coverage. Add new generator/key `--check`, category frontend and database checks to package/CI; currently package.json and workflow remain unchanged. If adding PGlite devDependency, CI needs npm ci and package-lock.

6. **More verification needed.** Exercise stale queue recovery, no-category pending queue, mixed offline batch crossing cycle boundary, concurrent category edits, verified profile offline reload, and actual browser mobile layouts/login/register/settings. Chrome exists at `C:\Program Files\Google\Chrome\Application\chrome.exe`. No browser tooling installed for this task yet.

7. Review user-facing age labels and registration flow. Signup category is shown on shared login/register form but login does not require selection. Ensure compulsory modal cannot be bypassed and appropriate focus behavior works.

8. Regenerate answer key and combined migration bundle after final corpus/schema edits, run complete suite once final integration is ready, update `tasks/todo.md` checklist and review. Final deliverable should explain local completion and request approval for production migrations/push as specified by user.

## Repository hygiene

`graphify-out/**` had MANY modified/deleted/untracked files BEFORE this feature. They are unrelated user changes. Do not revert, stage or include them in the feature commit. No commits were made for the feature. Some new files are untracked and must be included by next agent when authorized.

The old URL `https://sergiunicoara.github.io/citim-impreuna/` is already deployed as a redirect to the Talantul app, via another repository `sergiunicoara/sergiunicoara.github.io`, commit74d6a4a. Future app updates need only Talantul repository. Git auth `sergiunicoara` has push rights, Credential Manager defaults once used wrong snicoara-dev account. Previously successful command used `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push origin main`, but push still requires user's confirmation for this feature.
