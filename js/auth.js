/* Autentificare Supabase Auth.
   Username-ul este mapat la `username@citim.app` în câmpul email — utilizatorul
   vede doar câmpul "Nume utilizator", niciodată adresa de email internă.

   SETUP NECESAR în Supabase Dashboard:
     Authentication → Settings → dezactivează „Enable email confirmations"
*/

const Auth = (() => {
  const DOMAIN = '@citim.app';
  // Domeniu vechi, folosit pentru conturile create înainte de fix-ul care a
  // aliniat codul cu acest comentariu (DOMAIN era hardcodat greșit '@test.com').
  // Conturile existente rămân valide la autentificare; doar cele noi merg pe
  // DOMAIN de mai sus.
  const LEGACY_DOMAIN = '@test.com';
  let _client = null;
  let _session = null;
  let _onChangeCb = null;

  function client() {
    if (!_client && typeof supabase !== 'undefined') {
      _client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, storageKey: 'ci_auth' },
      });
    }
    return _client;
  }

  function toEmail(username, domain) {
    return username.trim().toLowerCase().replace(/\s+/g, '_') + (domain || DOMAIN);
  }

  // \b nu ajută aici: în JavaScript granița de cuvânt e definită prin \w =
  // [A-Za-z0-9_], chiar și cu flag-ul /u. Pentru „ștefan” prima graniță cade
  // între „ș” și „t”, deci /\b\p{L}/ producea „șTefan”. Se potrivește
  // explicit prima literă de după început, spațiu, cratimă sau apostrof.
  function normalizeUsername(username) {
    return String(username || '')
      .trim()
      .toLocaleLowerCase('ro-RO')
      .replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep, letter) => sep + letter.toLocaleUpperCase('ro-RO'));
  }

  function extractUsername(user) {
    if (!user) return null;
    const raw = user.user_metadata?.username ||
                (user.email || '').replace(DOMAIN, '').replace(LEGACY_DOMAIN, '') ||
                null;
    if (!raw) return null;
    return normalizeUsername(raw);
  }

  function isInvalidCredentials(error) {
    const msg = error?.message || '';
    return msg.includes('Invalid login') || msg.includes('invalid_credentials');
  }

  function translateError(msg) {
    if (!msg) return 'Eroare necunoscută.';
    if (msg.includes('Invalid login') || msg.includes('invalid_credentials')) return 'Nume sau parolă incorectă.';
    if (msg.includes('already registered') || msg.includes('already been registered')) return 'Acest nume de utilizator este deja folosit.';
    if (msg.includes('Password should')) return 'Parola trebuie să aibă cel puțin 6 caractere.';
    if (msg.includes('same_password') || msg.includes('different from the old')) return 'Alege o parolă diferită de cea actuală.';
    if (msg.includes('Current password required') || msg.includes('current_password')) return 'Parola actuală este necesară pentru a o schimba. Reîncearcă.';
    if (msg.includes('reauthentication') || msg.includes('reauthenticate')) return 'Intră din nou în cont, apoi reîncearcă schimbarea parolei.';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return 'Nu se poate contacta serverul. Verifică conexiunea la internet.';
    if (msg.includes('rate limit') || msg.includes('over_email_send_rate_limit')) return 'Prea multe încercări. Încearcă mai târziu.';
    if (msg.includes('Email not confirmed')) return 'Confirmarea prin email este activată — contactează administratorul.';
    return msg;
  }

  async function init(onChangeCb) {
    _onChangeCb = onChangeCb;
    const c = client();
    if (!c) return null; // SDK indisponibil (offline la prima încărcare)
    const { data } = await c.auth.getSession();
    _session = data.session;
    c.auth.onAuthStateChange((_, session) => {
      _session = session;
      if (_onChangeCb) _onChangeCb(currentUser());
    });
    return currentUser();
  }

  async function signIn(username, password) {
    if (!client()) throw new Error('Serviciul de autentificare nu este disponibil. Verifică conexiunea la internet.');
    let { data, error } = await client().auth.signInWithPassword({
      email: toEmail(username, DOMAIN),
      password,
    });
    // Conturile create înainte de fix-ul de domeniu sunt încă pe @test.com —
    // dacă noul domeniu nu găsește contul, încearcă domeniul vechi.
    // Doar o autentificare respinsă justifică a doua încercare. Reîncercarea
    // oarbă dubla fiecare cerere către limitatorul de rată Supabase și
    // înlocuia mesajul corect al primei erori (ex. „prea multe încercări").
    if (error && isInvalidCredentials(error)) {
      const retry = await client().auth.signInWithPassword({
        email: toEmail(username, LEGACY_DOMAIN),
        password,
      });
      data = retry.data;
      error = retry.error;
    }
    if (error) throw new Error(translateError(error.message));
    _session = data.session;
    return currentUser();
  }

  async function signUp(username, password, categoryId) {
    if (!client()) throw new Error('Serviciul de autentificare nu este disponibil. Verifică conexiunea la internet.');
    const trimmed = normalizeUsername(username);
    if (trimmed.length < 2) throw new Error('Numele trebuie să aibă cel puțin 2 caractere.');
    if (password.length < 6) throw new Error('Parola trebuie să aibă cel puțin 6 caractere.');
    const { data, error } = await client().auth.signUp({
      email: toEmail(trimmed),
      password,
      options: { data: { username: trimmed, category_id: categoryId || null } },
    });
    if (error) throw new Error(translateError(error.message));
    if (data.user && !data.session) {
      throw new Error('Confirmarea prin email este activată în Supabase — dezactiveaz-o din Dashboard → Auth → Settings.');
    }
    _session = data.session;
    return currentUser();
  }

  async function signOut() {
    if (client()) await client().auth.signOut();
    _session = null;
  }

  async function changePassword(currentPassword, newPassword, confirmation) {
    const c = client();
    const owner = getUserId();
    if (!c || !owner) throw new Error('Intră în cont pentru a schimba parola.');
    if (!currentPassword) throw new Error('Completează parola actuală.');
    if (newPassword.length < 6) throw new Error('Parola nouă trebuie să aibă cel puțin 6 caractere.');
    if (newPassword.length > 50) throw new Error('Parola nouă poate avea cel mult 50 de caractere.');
    if (newPassword !== confirmation) throw new Error('Parolele noi nu coincid.');
    if (newPassword === currentPassword) throw new Error('Alege o parolă diferită de cea actuală.');

    // O adresă redenumită de administrator poate fi încă veche în sesiunea
    // locală; citim identitatea actuală de pe server înainte de verificare.
    const account = await c.auth.getUser();
    if (account.error) throw new Error(translateError(account.error.message));
    const email = account.data?.user?.email;
    if (!email || account.data.user.id !== owner || getUserId() !== owner) {
      throw new Error('Contul s-a schimbat. Reîncearcă din contul dorit.');
    }

    // Verificarea nu trebuie să înlocuiască sesiunea din ci_auth. Folosim
    // adresa reală, inclusiv pentru conturile vechi sau nume duplicate.
    const verifier = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
        storageKey: 'ci_password_check' },
    });
    try {
      const { data, error } = await verifier.auth.signInWithPassword({ email, password: currentPassword });
      if (error) throw new Error(isInvalidCredentials(error) ? 'Parola actuală este incorectă.' : translateError(error.message));
      if (data?.user?.id !== owner || getUserId() !== owner) {
        throw new Error('Contul s-a schimbat. Reîncearcă din contul dorit.');
      }
      // Actualizăm numai identitatea verificată, chiar dacă alt tab schimbă
      // contul principal în timp ce această cerere este în curs.
      // Proiectul Supabase cere parola actuală la schimbare ("Secure password
      // change"); fără `current_password` serverul răspunde „Current password
      // required when setting new password”. Câmpul trece neschimbat prin
      // updateUser către API.
      const updated = await verifier.auth.updateUser({ password: newPassword, current_password: currentPassword });
      if (updated.error) throw new Error(translateError(updated.error.message));
    } finally {
      // O eroare de logout nu transformă o schimbare reușită în eșec.
      try { await verifier.auth.signOut({ scope: 'local' }); } catch { /* cleanup */ }
    }
    if (getUserId() === owner) {
      // Schimbarea parolei poate revoca celelalte sesiuni: cerem o conectare
      // nouă și curățăm sesiunea veche numai pentru contul inițiator.
      try { await c.auth.signOut({ scope: 'local' }); } catch { /* password already changed */ }
      if (getUserId() === owner) {
        _session = null;
        if (_onChangeCb) _onChangeCb(null);
      }
    }
  }

  function currentUser() {
    if (!_session) return null;
    return extractUsername(_session.user);
  }

  function isLoggedIn() { return !!_session; }

  // Tokenul de sesiune (JWT) al utilizatorului logat, pentru cererile către
  // Supabase. getSession() îl reîmprospătează singur dacă a expirat, deci se
  // cere de fiecare dată, niciodată memorat. null = neautentificat.
  async function getAccessToken() {
    const c = client();
    if (!c) return null;
    try {
      const { data } = await c.auth.getSession();
      return data.session?.access_token || null;
    } catch {
      return null;
    }
  }

  // uid-ul Supabase (auth.uid()) al utilizatorului logat — trimis explicit la
  // scrierile din events/scores, pentru că DEFAULT auth.uid() pe coloană nu
  // se completează fiabil la inserare (confirmat empiric); politicile RLS
  // verifică user_id = auth.uid(), deci fără el scrisul e respins mereu (403).
  function getUserId() {
    return _session?.user?.id || null;
  }

  return { init, signIn, signUp, signOut, changePassword, currentUser, isLoggedIn, getAccessToken, getUserId, normalizeUsername };
})();
