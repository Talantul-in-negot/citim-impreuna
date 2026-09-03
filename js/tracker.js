/* Urmărirea activității: coadă offline în localStorage + trimitere batch la Supabase.
   Dacă js/config.js nu are chei, totul devine no-op și aplicația merge ca înainte. */

const Tracker = (() => {
  const QUEUE_KEY = "ci_pending_events";
  const QUEUE_LOCK_KEY = "ci_pending_events_lock";
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
          const payload = batch.map(({ [EVENT_ID_FIELD]: eventId, [EVENT_OWNER_FIELD]: _ownerId, ...evt }) => ({
            ...evt,
            client_event_id: eventId,
            user_id: userId,
          }));
          try {
            // `on_conflict=client_event_id` e obligatoriu: fără el,
            // resolution=ignore-duplicates se rezolvă pe cheia primară
            // (generată, deci mereu nouă) și nu deduplică niciodată.
            const res = await fetch(`${SUPABASE_URL}/rest/v1/events?on_conflict=client_event_id`, {
              method: "POST",
              headers: await authHeaders({
                "Content-Type": "application/json",
                Prefer: "resolution=ignore-duplicates,return=minimal",
              }),
              body: JSON.stringify(payload),
            });
            if (!res.ok) return sentAny;
            // Evenimente adăugate în timpul trimiterii sunt procesate în următoarea
            // iterație înainte ca apelantul să poată citi scorul serverului.
            const sentIds = new Set(batch.map((evt) => evt[EVENT_ID_FIELD]));
            writeQueue(readQueue().filter((evt) => !sentIds.has(evt[EVENT_ID_FIELD])));
            sentAny = true;
            await refreshScore();
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

  async function fetchUserEvents(userName) {
    if (!enabled || !userName) return [];
    const userId = currentUserId();
    if (!userId) return [];
    // Paginat (cap Supabase = 1000/cerere) ca scorul să fie corect chiar și
    // pentru cine depășește 1000 de evenimente.
    const PAGE = 1000;
    let all = [];
    for (let offset = 0; offset < 100000; offset += PAGE) {
      const url =
        `${SUPABASE_URL}/rest/v1/events` +
        `?select=verse_ref,correct,created_at,cycle,answer,chosen` +
        `&user_id=eq.${encodeURIComponent(userId)}` +
        `&order=created_at.desc&limit=${PAGE}&offset=${offset}`;
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

  return { enabled, log, flush, refreshScore, fetchUserEvents, fetchScores, fetchOwnScore };
})();
