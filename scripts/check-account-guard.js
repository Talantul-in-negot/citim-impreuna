// Starea locală a unui tab nu are voie să rămână a contului A după ce alt tab
// a conectat contul B și a rescris ci_user în localStorage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

function makeTab(storage, userId) {
  const resets = [];
  const context = {
    STORAGE_USER: 'ci_user',
    localStorage: {
      getItem: (key) => (key in storage ? storage[key] : null),
      setItem: (key, value) => { storage[key] = String(value); },
    },
    Auth: { getUserId: () => context.signedIn },
    signedIn: userId,
    resetLocalProgressForAccountSwitch: () => resets.push(context.signedIn),
  };
  vm.createContext(context);
  vm.runInContext(
    app.match(/let localStateOwner = [^]*?\nfunction guardAgainstAccountSwitch\([^]*?\n}/)[0],
    context);
  return { context, resets };
}

// 1. Primul cont de pe dispozitiv nu resetează nimic (cititorul anonim își păstrează progresul).
{
  const storage = {};
  const { context, resets } = makeTab(storage, 'user-a');
  vm.runInContext('guardAgainstAccountSwitch()', context);
  assert.deepEqual(resets, [], 'The first account must keep local progress');
  assert.equal(storage.ci_user, 'user-a');
}

// 2. Același cont, reîncărcare: fără reset.
{
  const storage = { ci_user: 'user-a' };
  const { context, resets } = makeTab(storage, 'user-a');
  vm.runInContext('guardAgainstAccountSwitch()', context);
  assert.deepEqual(resets, [], 'The same account must not reset');
}

// 3. Alt cont în același tab: reset.
{
  const storage = { ci_user: 'user-a' };
  const { context, resets } = makeTab(storage, 'user-a');
  vm.runInContext('guardAgainstAccountSwitch()', context);
  context.signedIn = 'user-b';
  vm.runInContext('guardAgainstAccountSwitch()', context);
  assert.deepEqual(resets, ['user-b'], 'Switching accounts in the same tab must reset');
}

// 4. Alt tab a conectat B și a rescris ci_user: acest tab trebuie să reseteze oricum.
{
  const storage = { ci_user: 'user-a' };
  const { context, resets } = makeTab(storage, 'user-a');
  vm.runInContext('guardAgainstAccountSwitch()', context);
  storage.ci_user = 'user-b'; // scris de celălalt tab
  context.signedIn = 'user-b'; // evenimentul de autentificare ajunge și aici
  vm.runInContext('guardAgainstAccountSwitch()', context);
  assert.deepEqual(resets, ['user-b'],
    'State owned by account A must be reset when another tab already rewrote ci_user to B');
}

console.log('Account guard: local state is reset on any account switch, including from another tab.');
