const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8');

function load(overrides = {}) {
  const calls = [];
  let callback;
  const session = {user:{id:'new-user',email:'test_nou@citim.app',user_metadata:{username:'Test Nou'}}};
  const auth = {
    getSession: async () => ({data:{session:null}}),
    onAuthStateChange: handler => { callback = handler; },
    signUp: async args => { calls.push(args); return {data:{session,user:session.user},error:null}; },
    signInWithPassword: async args => { calls.push(args); return {data:{session},error:null}; },
    signOut: async () => {},
    ...overrides,
  };
  const context = {SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'anon',
    supabase:{createClient:() => ({auth})}};
  vm.createContext(context);
  vm.runInContext(source + '\nthis.api = Auth;', context);
  return {api:context.api,calls,session,auth,change:value => callback('SIGNED_IN', value)};
}

async function main() {
  const test = load();
  await test.api.init(() => {});
  assert.equal(test.api.currentUser(), null);
  await assert.rejects(() => test.api.signUp('x','abcdef','grades_2_3'), /cel puțin 2/);
  await assert.rejects(() => test.api.signUp('Test Nou','short','grades_2_3'), /cel puțin 6/);
  assert.equal(test.calls.length, 0, 'Invalid signup must not send a request');
  assert.equal(await test.api.signUp('  test nou  ','example-password','grades_2_3'), 'Test Nou');
  assert.equal(test.calls[0].email, 'test_nou@citim.app');
  assert.equal(test.calls[0].options.data.category_id, 'grades_2_3');
  assert.equal(test.calls[0].options.data.username, 'Test Nou');
  assert.equal(test.api.getUserId(), 'new-user');
  await test.api.signOut();
  assert.equal(test.api.currentUser(), null);
  assert.equal(test.api.getUserId(), null);
  test.change({user:{id:'manual',email:'test@citim.app',user_metadata:{}}});
  assert.equal(test.api.currentUser(), 'Test', 'Manually created accounts use the internal identifier');

  const fallback = load();
  fallback.auth.signInWithPassword = async args => {
    fallback.calls.push(args.email);
    return args.email.endsWith('@citim.app')
      ? {data:{},error:{message:'Invalid login credentials'}}
      : {data:{session:fallback.session},error:null};
  };
  assert.equal(await fallback.api.signIn('TEST NOU','example-password'), 'Test Nou');
  assert.deepEqual(fallback.calls, ['test_nou@citim.app','test_nou@test.com']);
  for (const message of ['Failed to fetch', 'rate limit exceeded']) {
    const failed = load({signInWithPassword:async () => ({data:{},error:{message}})});
    let attempts = 0;
    const original = failed.auth.signInWithPassword;
    failed.auth.signInWithPassword = async args => { attempts++; return original(args); };
    await assert.rejects(() => failed.api.signIn('Test','example-password'));
    assert.equal(attempts, 1, 'Network/rate-limit failures must not trigger a second authentication request');
  }
  const duplicate = load({signUp:async () => ({data:{},error:{message:'User already registered'}})});
  await assert.rejects(() => duplicate.api.signUp('Test','example-password','grades_2_3'), /deja folosit/);
  console.log('Auth flows: signup validation, category metadata, logout, manual accounts, legacy login and network errors passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
