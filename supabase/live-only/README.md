# Obiecte care există doar în baza de producție

Referință, **nu** se aplică automat și nu intră în `apply_all.sql`. Definițiile
au fost citite din producție la 2026-11-17 (`pg_get_functiondef`,
`pg_get_triggerdef`). Dacă baza de producție se reface de la zero, aceste
obiecte trebuie recreate manual înainte de `20261110_03`, altfel catalogul
epistolelor nu are ce completa.

- `validate_citim_event_insert.sql` — funcția triggerului
  `events_validate_citim_insert` (BEFORE INSERT pe `events`, rulează înaintea
  `events_verify_before_insert`), plus `public.citim_verse_catalog`.
- Catalogul are 2191 de rânduri: 1 Samuel, 2 Samuel și cele cinci epistole.
- `citim_verse_catalog`: RLS activ, fără politici, EXECUTE/privilegii doar
  pentru `postgres` și `service_role`.

## Alte obiecte descoperite doar pe producție (2026-11-19)

- `public.app_config` (`id`, `leaderboard_size`; un singur rând, `leaderboard_size = 8`):
  RLS activ, politici `anon read config` și `authenticated read config`
  (`SELECT ... using (true)`). Nu e folosit de JavaScript; probabil îl citește
  `get_public_leaderboard`. Nu e creat de nicio migrare din repo.
- `created_at` al evenimentelor: pe producție îl fixează `validate_citim_event_insert`
  la `now()`. Într-o bază reconstruită doar din repo, `verify_event_before_insert`
  îl lasă controlat de client în ultimele 30 de zile (bonusul de pagină fără greșeli
  compară `created_at`), deci validatorul live trebuie recreat și pe o bază nouă.
