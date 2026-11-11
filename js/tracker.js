/* Urmărirea activității: coadă offline în localStorage + trimitere batch la Supabase.
   Dacă js/config.js nu are chei, totul devine no-op și aplicația merge ca înainte. */

const Tracker = (() => {
  const QUEUE_KEY = "ci_pending_events";
  const QUEUE_LOCK_KEY = "ci_pending_events_lock";
  // Răspunsuri pe care serverul le-a refuzat DEFINITIV (categorie/revizie/ciclu/
  // pagină schimbată între timp, verset necunoscut). Nu se mai trimit și nu se
  // reștampilează niciodată cu valori noi, dar nici nu se șterg în tăcere: se
  // păstrează aici pentru verificare, iar aplicația anunță utilizatorul.
  const REJECTED_KEY = "ci_rejected_events";
  const MAX_REJECTED_EVENTS = 300;
  const EVENT_ID_FIELD = "_ci_event_id";
  const EVENT_OWNER_FIELD = "_ci_owner_id";
  // Plafonul se aplică DOAR evenimentelor cu proprietar. Cele nerevendicate
  // (create fără cont) nu se pot trimite niciodată, deci dacă ar intra în
  // același plafon ar împinge afară evenimente reale — adică puncte pierdute
  // în tăcere. Ele au propriul plafon, mult mai mic, plus o expirare.
  const MAX_QUEUE_EVENTS = 500;
  const MAX_UNCLAIMED_EVENTS = 100;
  const UNCLAIMED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const POST_BATCH_SIZE = 100;
  const LOCK_TTL_MS = 60 * 1000;
  const LOCK_BUSY = Symbol("queue-lock-busy");
  const tabId = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const enabled =
    typeof SUPABASE_URL === "string" &&
    SUPABASE_URL.startsWith("https://") &&
    typeof SUPABASE_ANON_KEY === "string" &&
    SUPABASE_ANON_KEY.length > 0;
  // Web Locks oferă excludere mutuală reală între tab-uri. Vechea variantă pe
  // localStorage era citire-apoi-scriere, deci intercalarea scrie(A) → citește(A)
  // → scrie(B) → citește(B) dădea lacătul ambelor tab-uri. Rămâne ca rezervă
  // pentru browserele fără API (mitigată de client_event_id + ignore-duplicates).
  const hasWebLocks =
    typeof navigator !== "undefined" &&
    !!navigator.locks &&
    typeof navigator.locks.request === "function";
  let flushPromise = null;
  let scoreRefreshPromise = null;
  let bufferedEvents = [];
  let bufferedDrainTimer = null;

  // Antetele pentru Supabase. `apikey` rămâne mereu cheia anon (identifică
  // proiectul), dar `Authorization` poartă JWT-ul utilizatorului logat — așa
  // cererea ajunge la Postgres ca rol `authenticated`, cu identitatea dovedită
  // criptografic, nu ca `anon` (cheie publică, oricine o poate copia din
  // js/config.js). Politicile RLS pot astfel impune „doar rândul tău".
  // Fără sesiune se cade înapoi pe cheia anon: scrierile vor fi respinse de
  // RLS și rămân în coadă până la relogare (vezi flush()).
  async function authHeaders(extra) {
    let token = null;
    if (typeof Auth !== "undefined" && Auth.getAccessToken) {
      token = await Auth.getAccessToken();
    }
    return {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
      ...(extra || {}),
    };
  }

  function currentUserId() {
    return typeof Auth !== "undefined" && Auth.getUserId ? Auth.getUserId() : null;
  }

  function makeEventId() {
    return typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function trimQueue(queue) {
    const now = Date.now();
    const fresh = queue.filter((evt) => {
      if (evt[EVENT_OWNER_FIELD]) return true;
      const at = Date.parse(evt.created_at || "");
      return Number.isFinite(at) && now - at < UNCLAIMED_TTL_MS;
    });
    const owned = fresh.filter((evt) => evt[EVENT_OWNER_FIELD]);
    const unclaimed = fresh.filter((evt) => !evt[EVENT_OWNER_FIELD]);
    if (owned.length <= MAX_QUEUE_EVENTS && unclaimed.length <= MAX_UNCLAIMED_EVENTS) {
      return fresh;
    }
    // Se păstrează cele mai recente din fiecare categorie, dar ordinea
    // originală a cozii rămâne neschimbată (identitatea obiectelor).
    const keep = new Set([
      ...owned.slice(Math.max(0, owned.length - MAX_QUEUE_EVENTS)),
      ...unclaimed.slice(Math.max(0, unclaimed.length - MAX_UNCLAIMED_EVENTS)),
    ]);
    return fresh.filter((evt) => keep.has(evt));
  }

  // Pending events belong to the account that was active *when they were
  // created*, never to the account that happens to be active during a later
  // retry. Legacy/anonymous entries deliberately remain unclaimed: without a
  // user choice, assigning them to the next person on a shared device is unsafe.
  function readQueue() {
    try {
      const raw = JSON.parse(localStorage.getItem(QUEUE_KEY)) || [];
      if (!Array.isArray(raw)) return [];
      let migrated = false;
      const queue = raw
        .filter((evt) => evt && typeof evt === "object")
        .map((evt) => {
          if (typeof evt[EVENT_ID_FIELD] === "string" && EVENT_OWNER_FIELD in evt) return evt;
          migrated = true;
          return {
            ...evt,
            [EVENT_ID_FIELD]: typeof evt[EVENT_ID_FIELD] === "string" ? evt[EVENT_ID_FIELD] : makeEventId(),
            [EVENT_OWNER_FIELD]: typeof evt[EVENT_OWNER_FIELD] === "string" ? evt[EVENT_OWNER_FIELD] : null,
          };
        });
      if (migrated) writeQueue(queue);
      return queue;
    } catch {
      return [];
    }
  }

  function writeQueue(q) {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(trimQueue(q)));
  }

  function lockRecord() {
    try {
      const lock = JSON.parse(localStorage.getItem(QUEUE_LOCK_KEY) || "null");
      return lock && typeof lock === "object" ? lock : null;
    } catch {
      return null;
    }
  }

  function tryAcquireQueueLock() {
    const now = Date.now();
    const existing = lockRecord();
    if (existing && existing.owner !== tabId && existing.expiresAt > now) return false;
    const mine = { owner: tabId, expiresAt: now + LOCK_TTL_MS };
    localStorage.setItem(QUEUE_LOCK_KEY, JSON.stringify(mine));
    return lockRecord()?.owner === tabId;
  }

  function releaseQueueLock() {
    if (lockRecord()?.owner === tabId) localStorage.removeItem(QUEUE_LOCK_KEY);
  }

  // Rulează `run` cu acces exclusiv la coadă. Cu Web Locks apelul așteaptă
  // rândul; pe rezervă întoarce LOCK_BUSY dacă alt tab ține lacătul.
  async function withQueueLock(run) {
    if (hasWebLocks) return navigator.locks.request(QUEUE_LOCK_KEY, run);
    if (!tryAcquireQueueLock()) return LOCK_BUSY;
    try {
      return await run();
    } finally {
      releaseQueueLock();
    }
  }

  function scheduleBufferedDrain() {
    if (bufferedDrainTimer) return;
    bufferedDrainTimer = setTimeout(async () => {
      bufferedDrainTimer = null;
      if (await drainBufferedEvents()) flush();
    }, 100);
  }

  async function drainBufferedEvents() {
    if (bufferedEvents.length === 0) return false;
    const pending = bufferedEvents;
    bufferedEvents = [];
    const result = await withQueueLock(() => {
      writeQueue(readQueue().concat(pending));
      return true;
    });
    if (result !== true) {
      // Lacătul de rezervă e ocupat — evenimentele se întorc în buffer, în
      // ordinea originală, și se reîncearcă la următorul tick.
      bufferedEvents = pending.concat(bufferedEvents);
      scheduleBufferedDrain();
      return false;
    }
    return true;
  }

  // Scrierea în coadă are nevoie de lacăt (asincron), dar log() rămâne sincron:
  // evenimentul intră într-un buffer în memorie și e persistat de drenajul
  // următor. flush() drenează întâi bufferul, deci un log() imediat urmat de
  // flush() — cazul din checkAnswers() — trimite tot.
  function log(evt) {
    if (!enabled) return;
    const ownerId = currentUserId();
    bufferedEvents.push({
      ...evt,
      // păstrează momentul real al răspunsului, chiar dacă trimiterea se face mai târziu
      created_at: new Date().toISOString(),
      [EVENT_ID_FIELD]: makeEventId(),
      [EVENT_OWNER_FIELD]: ownerId || null,
    });
    scheduleBufferedDrain();
  }

  // Refuz definitiv = serverul a verificat evenimentul și nu-l va accepta niciodată
  // în forma lui. Doar motivele explicite contează; orice altceva (rețea, 401/403,
  // 429, 5xx, „alege categoria", erori necunoscute) e tratat ca temporar, ca un
  // răspuns legitim să nu fie pierdut din cauza unei erori pe care n-o înțelegem.
  // „Unknown verse reference" NU e definitiv: înseamnă de obicei un server încă
  // neactualizat (ex. catalogul de versete fără epistole, găsit în producție pe
  // 2026-11-11), deci răspunsul rămâne în coadă până serverul îl cunoaște.
  function permanentRejectionReason(status, body) {
    if (status < 400 || status >= 500 || [401, 403, 408, 429].includes(status)) return null;
    const detail = String(body?.details || "");
    if (/^STALE_READING_(REVISION|CATEGORY|CYCLE|PAGE)$/.test(detail)) return detail;
    return null;
  }

  async function readErrorBody(res) {
    try { return await res.json(); } catch { return null; }
  }

  function readRejected() {
    try {
      const raw = JSON.parse(localStorage.getItem(REJECTED_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  function quarantine(evt, reason) {
    const kept = readRejected().concat({ ...evt, _ci_rejected_reason: reason, _ci_rejected_at: new Date().toISOString(), _ci_rejected_seen: false });
    localStorage.setItem(REJECTED_KEY, JSON.stringify(kept.slice(-MAX_REJECTED_EVENTS)));
  }

  function postEvents(batch, userId) {
    const payload = batch.map(({ [EVENT_ID_FIELD]: eventId, [EVENT_OWNER_FIELD]: _ownerId, ...evt }) => ({
      ...evt,
      client_event_id: eventId,
      user_id: userId,
    }));
    return (async () => fetch(`${SUPABASE_URL}/rest/v1/events?on_conflict=client_event_id`, {
      method: "POST",
      headers: await authHeaders({
        "Content-Type": "application/json",
        Prefer: "resolution=ignore-duplicates,return=minimal",
      }),
      body: JSON.stringify(payload),
    }))();
  }

  function removeFromQueue(events) {
    const ids = new Set(events.map((evt) => evt[EVENT_ID_FIELD]));
    writeQueue(readQueue().filter((evt) => !ids.has(evt[EVENT_ID_FIELD])));
  }

  // Un lot e atomic: un singur eveniment învechit îl respinge întreg. Trimitem
  // atunci câte unul, în ordine: cele valide intră, cele refuzate definitiv merg
  // în carantină, iar la primul eșec temporar ne oprim (ordinea rămâne intactă).
  async function submitOneByOne(batch, userId) {
    let sentAny = false;
    for (const evt of batch) {
      const res = await postEvents([evt], userId);
      if (res.ok) {
        removeFromQueue([evt]);
        sentAny = true;
        continue;
      }
      const reason = permanentRejectionReason(res.status, await readErrorBody(res));
      if (!reason) return { sentAny, stopped: true };
      quarantine(evt, reason);
      removeFromQueue([evt]);
    }
    return { sentAny, stopped: false };
  }

  async function flush() {
    if (!enabled) return false;
    if (flushPromise) return flushPromise;

    flushPromise = (async () => {
      await drainBufferedEvents();
      const result = await withQueueLock(async () => {
        let sentAny = false;
        while (true) {
          const userId = currentUserId();
          if (!userId) return sentAny;
          // Send only events explicitly recorded for this account. Unclaimed
          // anonymous events stay local until a future explicit claim flow.
          const batch = readQueue()
            .filter((evt) => evt[EVENT_OWNER_FIELD] === userId)
            .slice(0, POST_BATCH_SIZE);
          if (batch.length === 0) return sentAny;
          try {
            // `on_conflict=client_event_id` e obligatoriu (vezi postEvents): fără
            // el, resolution=ignore-duplicates se rezolvă pe cheia primară
            // (generată, deci mereu nouă) și nu deduplică niciodată.
            const res = await postEvents(batch, userId);
            if (!res.ok) {
              // Doar un refuz definitiv justifică desfacerea lotului; altfel
              // (offline, sesiune expirată, server căzut) reîncercăm mai târziu.
              if (!permanentRejectionReason(res.status, await readErrorBody(res))) return sentAny;
              const outcome = await submitOneByOne(batch, userId);
              sentAny = sentAny || outcome.sentAny;
              if (outcome.stopped) return sentAny;
              continue;
            }
            // Evenimente adăugate în timpul trimiterii sunt procesate în următoarea
            // iterație înainte ca apelantul să poată citi scorul serverului.
            removeFromQueue(batch);
            sentAny = true;
            // NU mai chemăm refreshScore() aici. Triggerul AFTER INSERT STATEMENT
            // de pe `events` (events_recalculate_scores) recalculează deja scorul,
            // în aceeași tranzacție ca insert-ul de mai sus — până când `res.ok`
            // devine adevărat, scorul e deja actualizat pe server. Un al doilea
            // apel explicit aici nu citea nimic nou; dubla doar recalculul, care
            // fără blocare pe utilizator (adăugată în 20260903_04) permitea o
            // cursă „ultima scriere câștigă" cu o valoare mai veche.
            // syncScoreFromServer() din app.js citește deja valoarea proaspătă
            // via Tracker.fetchOwnScore() (get_own_score — doar citire).
          } catch {
            // Offline sau eroare de rețea — coada rămâne pentru următoarea încercare.
            return sentAny;
          }
        }
      });
      return result === LOCK_BUSY ? false : result;
    })().finally(() => {
      flushPromise = null;
      if (bufferedEvents.length > 0) scheduleBufferedDrain();
    });
    return flushPromise;
  }

  // Câte răspunsuri ale contului curent au fost refuzate definitiv de la ultima
  // întrebare; le marchează ca văzute (rămân păstrate în REJECTED_KEY).
  function takeUnseenRejections() {
    const userId = currentUserId();
    if (!userId) return 0;
    const rejected = readRejected();
    let count = 0;
    for (const evt of rejected) {
      if (evt[EVENT_OWNER_FIELD] === userId && !evt._ci_rejected_seen) {
        evt._ci_rejected_seen = true;
        count++;
      }
    }
    if (count) localStorage.setItem(REJECTED_KEY, JSON.stringify(rejected));
    return count;
  }

  function hasPendingEvents() {
    const userId = currentUserId();
    if (!userId) return false;
    return bufferedEvents.concat(readQueue()).some((evt) => evt[EVENT_OWNER_FIELD] === userId);
  }

  async function fetchUserEvents(userName) {
    if (!enabled || !userName) return [];
    const userId = currentUserId();
    if (!userId) return [];
    // Paginat (cap Supabase = 1000/cerere) ca scorul să fie corect chiar și
    // pentru cine depășește 1000 de evenimente. Ordinea trebuie să fie TOTALĂ
    // (created_at nu e unic: răspunsurile unei pagini se scriu împreună), altfel
    // cu offset rândurile egale pot fi sărite sau duplicate la granița dintre
    // loturi, iar o pagină rezolvată apare nerezolvată în alt dispozitiv.
    const PAGE = 1000;
    let all = [];
    for (let offset = 0; offset < 100000; offset += PAGE) {
      const url =
        `${SUPABASE_URL}/rest/v1/events` +
        `?select=verse_ref,correct,created_at,cycle,answer,chosen,epistle_revision` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&order=created_at.desc,id.desc&limit=${PAGE}&offset=${offset}`;
      const res = await fetch(url, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      all = all.concat(rows);
      if (rows.length < PAGE) break;
    }
    return all;
  }

  // Clasamentul agregat: un singur rând per utilizator (user_id, user_name,
  // points), derivat de Supabase din evenimente. Evită descărcarea întregului
  // istoric la fiecare deschidere de statistici.
  const LEADERBOARD_PAGE_SIZE = 1000;

  async function fetchScores() {
    if (!enabled) return [];
    try {
      const all = [];
      for (let offset = 0; offset < 100000; offset += LEADERBOARD_PAGE_SIZE) {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_public_leaderboard`, {
          method: "POST",
          headers: await authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ p_limit: LEADERBOARD_PAGE_SIZE, p_offset: offset }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        all.push(...rows);
        if (rows.length < LEADERBOARD_PAGE_SIZE) break;
      }
      return all;
    } catch {
      // RPC lipsă/offline — apelantul afișează un mesaj, nu un clasament greșit.
      return [];
    }
  }

  async function fetchOwnScore() {
    const userId = currentUserId();
    if (!userId) return null;
    try {
      // The public leaderboard is intentionally limited. This authenticated
      // RPC reads only the caller's score, so reconciliation also works for
      // users who are outside the displayed ranking.
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_own_score`, {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: "{}",
      });
      if (!res.ok) return null;
      const value = await res.json();
      return Number(value) || 0;
    } catch {
      return null;
    }
  }

  // Activitatea proprie necesară pentru streak, cu aceleași coloane și
  // metadatele de chapter verificate de calculul de puncte de pe server.
  async function fetchOwnReadingData() {
    const userId = currentUserId();
    if (!userId) return null;
    const scoreRes = await fetch(
      `${SUPABASE_URL}/rest/v1/scores?select=baseline_at&user_id=eq.${encodeURIComponent(userId)}`,
      { headers: await authHeaders() }
    );
    if (!scoreRes.ok) throw new Error(`HTTP ${scoreRes.status}`);
    const scoreRows = await scoreRes.json();
    if (!scoreRows.length) return null;

    const PAGE = 1000;
    const events = [];
    for (let offset = 0; offset < 100000; offset += PAGE) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/events?select=recorded_at,correct,verse_ref,chapter_ref,chapter_size` +
        `&user_id=eq.${encodeURIComponent(userId)}&order=recorded_at.asc,id.asc&limit=${PAGE}&offset=${offset}`,
        { headers: await authHeaders() }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      events.push(...rows);
      if (rows.length < PAGE) break;
    }
    return { baselineAt: scoreRows[0].baseline_at, events };
  }

  // `current_cycle` e ștampilat de server (vezi 20260903_02_server_verified_events.sql
  // și 20260907_02_fix_completed_page_count_baseline.sql), nu poate fi dedus
  // din maximul `cycle`-ului găsit în evenimente: dacă serverul a avansat
  // ciclul fără să existe încă niciun eveniment nou ștampilat cu noua
  // valoare (ex. imediat după o migrare de recalcul), clientul rămâne orb la
  // avans și recalculează etern pe baza ciclului vechi. `scores_select_own`
  // (00000000_baseline_schema.sql) permite citirea directă a rândului
  // propriu.
  async function fetchOwnCycle() {
    const userId = currentUserId();
    if (!userId) return null;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/scores?select=current_cycle&user_id=eq.${userId}`,
        { headers: await authHeaders() }
      );
      if (!res.ok) return null;
      const rows = await res.json();
      const value = rows[0]?.current_cycle;
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function fetchOwnProfile() {
    const userId = currentUserId();
    if (!enabled || !userId) throw new Error("Conectează-te pentru a alege categoria.");
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/reading_profiles?select=category_id,epistle_revision&user_id=eq.${encodeURIComponent(userId)}`,
      { headers: await authHeaders() }
    );
    if (!res.ok) throw new Error("Categoria nu poate fi încărcată. Verifică conexiunea și încearcă din nou.");
    const rows = await res.json();
    return rows[0] || { category_id: null, epistle_revision: 0 };
  }

  async function saveCategory(categoryId, { initial = false } = {}) {
    if (!enabled || !currentUserId()) throw new Error("Conectează-te pentru a salva categoria.");
    // La prima alegere coada nu se golește aici: serverul respinge evenimentele
    // unui cont fără categorie, deci ea se poate trimite abia după salvare.
    if (!initial) {
      await flush();
      if (hasPendingEvents()) {
        throw new Error("Răspunsurile tale așteaptă sincronizarea. Reconectează-te la internet înainte de a schimba categoria.");
      }
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/set_reading_category`, {
      method: "POST",
      headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ p_category_id: categoryId }),
    });
    if (!res.ok) throw new Error("Categoria nu a putut fi salvată. Verifică conexiunea și încearcă din nou.");
    const value = await res.json();
    const profile = Array.isArray(value) ? value[0] : value;
    if (!profile || profile.category_id !== categoryId) {
      throw new Error("Categoria nu a fost confirmată. Încearcă din nou.");
    }
    return profile;
  }

  // Supabase derivează scorul exclusiv din evenimentele utilizatorului curent.
  // Browserul nu mai transmite niciun total de puncte care ar putea fi modificat.
  async function refreshScore() {
    if (!enabled) return false;
    if (scoreRefreshPromise) return scoreRefreshPromise;
    const userId = currentUserId();
    if (!userId) return false;
    scoreRefreshPromise = (async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_own_score`, {
          method: "POST",
          headers: await authHeaders({
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({}),
        });
        return res.ok;
      } catch {
        // Offline sau eroare de rețea — următorul flush de evenimente reîncearcă.
        return false;
      }
    })().finally(() => {
      scoreRefreshPromise = null;
    });
    return scoreRefreshPromise;
  }

  window.addEventListener("online", () => {
    flush();
    refreshScore();
  });

  return { enabled, log, flush, hasPendingEvents, takeUnseenRejections, refreshScore, fetchUserEvents, fetchScores, fetchOwnScore, fetchOwnCycle, fetchOwnReadingData, fetchOwnProfile, saveCategory };
})();
