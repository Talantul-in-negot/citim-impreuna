const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8');

function setup(email = 'darius@test.com') {
  let onChange;
  const owner = { id: 'owner', email, user_metadata: { username: 'Darius' } };
  const requests = [], options = [];
  const main = {
    getSession: async () => ({ data: { session: { user: owner } } }),
    getUser: async () => ({ data: { user: owner } }),
    onAuthStateChange: callback => { onChange = callback; },
    signOut: async args => { requests.push(['mainLogout', args]); onChange('SIGNED_OUT', null); },
  };
  const verifier = {
    signInWithPassword: async args => { requests.push(['verify', args]); return { data: { user: owner }, error: null }; },
    updateUser: async args => { requests.push(['update', args]); return { data: { user: owner }, error: null }; },
    signOut: async args => { requests.push(['cleanup', args]); },
  };
  const context = {
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'public-key',
    supabase: { createClient: (_url, _key, config) => {
      options.push(config);
      return { auth: config.auth.storageKey === 'ci_auth' ? main : verifier };
    } },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.api = Auth;', context);
  return { api: context.api, owner, requests, options, main, verifier,
    switchAccount: () => onChange('SIGNED_IN', { user: { id: 'other', email: 'other@citim.app' } }) };
}

async function checkForm() {
  const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  let owner = 'owner', submitted;
  const input = () => ({ value: '', focus() { this.focused = true; } });
  const el = {
    currentPassword: input(), newPassword: input(), confirmPassword: input(), loginPassword: input(),
    passwordError: {}, passwordSuccess: {}, passwordSaveBtn: {},
    changePasswordBtn: { setAttribute(name, value) { this[name] = value; } },
    passwordForm: { reset() { for (const key of ['currentPassword', 'newPassword', 'confirmPassword']) el[key].value = ''; } },
  };
  const context = {
    el, userName: 'Darius',
    Auth: {
      getUserId: () => owner, isLoggedIn: () => !!owner, currentUser: () => owner ? 'Darius' : null,
      changePassword: async (...args) => { submitted = args; owner = null; },
    },
    updateUserChip: () => {}, showAuthModal: () => context.resetPasswordForm(),
  };
  vm.createContext(context);
  vm.runInContext('let passwordSaving = false; let passwordFormOwner = null;', context);
  for (const name of ['resetPasswordForm', 'showPasswordForm', 'handlePasswordChange', 'setAuthError']) {
    const match = app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
    assert(match, name);
    vm.runInContext(match[0], context);
  }
  context.showPasswordForm();
  assert.equal(el.passwordForm.hidden, false);
  assert.equal(el.currentPassword.focused, true);
  el.currentPassword.value = 'old-password';
  el.newPassword.value = el.confirmPassword.value = 'new-password';
  await context.handlePasswordChange({ preventDefault() {} });
  assert.deepEqual(submitted, ['old-password', 'new-password', 'new-password']);
  assert.equal(el.passwordSuccess.hidden, false);
  assert.match(el.passwordSuccess.textContent, /Intră din nou/);
  assert.equal(el.passwordForm.hidden, true);
  assert.equal(el.newPassword.value, '', 'Success clears password fields');
  assert.equal(el.passwordSaveBtn.disabled, false);

  owner = 'owner';
  context.showPasswordForm();
  context.Auth.changePassword = async () => { throw new Error('Parola actuală este incorectă.'); };
  await context.handlePasswordChange({ preventDefault() {} });
  assert.equal(el.passwordError.hidden, false);
  assert.match(el.passwordError.textContent, /incorectă/);
  assert.equal(el.passwordSaveBtn.disabled, false);
  el.currentPassword.value = 'secret';
  context.resetPasswordForm();
  assert.equal(el.currentPassword.value, '', 'Closing/cancelling clears sensitive fields');

  context.showPasswordForm();
  owner = 'other';
  submitted = null;
  context.Auth.changePassword = async (...args) => { submitted = args; };
  await context.handlePasswordChange({ preventDefault() {} });
  assert.equal(submitted, null, 'A form opened by another account cannot submit');
}

async function main() {
  for (const email of ['darius@test.com', 'darius@citim.app']) {
    const test = setup(email);
    await test.api.init(() => {});
    await test.api.changePassword('old-password', 'new-password', 'new-password');
    assert.equal(test.requests[0][1].email, email, 'Must verify the actual account, never a username fallback');
    assert.equal(test.requests.filter(([kind]) => kind === 'verify').length, 1);
    assert.equal(test.requests.find(([kind]) => kind === 'update')[1].password, 'new-password');
    assert.equal(test.api.getUserId(), null, 'Successful changes require fresh login');
    const isolated = test.options[1].auth;
    assert.equal(isolated.persistSession, false);
    assert.equal(isolated.autoRefreshToken, false);
    assert.equal(isolated.detectSessionInUrl, false);
    assert.notEqual(isolated.storageKey, 'ci_auth');
    for (const [kind, args] of test.requests) {
      if (kind === 'cleanup' || kind === 'mainLogout') assert.equal(args.scope, 'local');
    }
  }

  const invalid = setup();
  await assert.rejects(() => invalid.api.changePassword('old-password', 'new-password', 'new-password'), /Intră în cont/);
  await invalid.api.init(() => {});
  for (const args of [
    ['', 'new-password', 'new-password'], ['old-password', 'short', 'short'],
    ['old-password', 'new-password', 'different'], ['old-password', 'old-password', 'old-password'],
    ['old-password', 'x'.repeat(51), 'x'.repeat(51)],
  ]) await assert.rejects(() => invalid.api.changePassword(...args));
  assert.equal(invalid.requests.length, 0, 'Validation must happen before network access');

  const renamed = setup('darius@citim.app');
  await renamed.api.init(() => {});
  renamed.main.getUser = async () => ({ data: { user: { ...renamed.owner, email: 'darius@test.com' } } });
  await renamed.api.changePassword('old-password', 'new-password', 'new-password');
  assert.equal(renamed.requests[0][1].email, 'darius@test.com', 'An administrator rename must use the current server address');

  for (const message of ['Invalid login credentials', 'Failed to fetch']) {
    const test = setup();
    await test.api.init(() => {});
    test.verifier.signInWithPassword = async () => ({ error: { message } });
    await assert.rejects(() => test.api.changePassword('old-password', 'new-password', 'new-password'),
      message.startsWith('Invalid') ? /actuală este incorectă/ : /conexiunea/);
    assert(!test.requests.some(([kind]) => kind === 'update' || kind === 'mainLogout'));
    assert.equal(test.api.getUserId(), 'owner');
  }

  const rejected = setup();
  await rejected.api.init(() => {});
  rejected.verifier.updateUser = async () => ({ error: { message: 'Password should meet server policy' } });
  await assert.rejects(() => rejected.api.changePassword('old-password', 'new-password', 'new-password'));
  assert.equal(rejected.api.getUserId(), 'owner');

  for (const wrongIdentity of [false, true]) {
    const test = setup();
    await test.api.init(() => {});
    test.verifier.signInWithPassword = async () => {
      if (!wrongIdentity) test.switchAccount();
      return { data: { user: wrongIdentity ? { id: 'other' } : test.owner } };
    };
    await assert.rejects(() => test.api.changePassword('old-password', 'new-password', 'new-password'), /Contul s-a schimbat/);
    assert(!test.requests.some(([kind]) => kind === 'update' || kind === 'mainLogout'));
  }

  const switched = setup();
  await switched.api.init(() => {});
  switched.verifier.updateUser = async () => { switched.switchAccount(); return { data: { user: switched.owner } }; };
  await switched.api.changePassword('old-password', 'new-password', 'new-password');
  assert.equal(switched.api.getUserId(), 'other', 'Completion must not sign out a different account');
  assert(!switched.requests.some(([kind]) => kind === 'mainLogout'));

  const cleanupFailure = setup();
  await cleanupFailure.api.init(() => {});
  cleanupFailure.verifier.signOut = async () => { throw new Error('Network cleanup failed'); };
  cleanupFailure.main.signOut = async () => { throw new Error('Old session already revoked'); };
  await cleanupFailure.api.changePassword('old-password', 'new-password', 'new-password');
  assert.equal(cleanupFailure.api.getUserId(), null, 'Cleanup errors must not misreport successful password changes');
  await checkForm();
  console.log('Password change: validation, legacy identity, wrong password, account switches, isolated session and cleanup passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
