// Un cont fără categorie trebuie să vadă propriul scor, inclusiv valoarea zero.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');

async function main() {
  let owner = 'new-account';
  const storage = new Map([['ci_user', 'previous-account']]);
  const context = {
    score: 70, userName: 'Test', STORAGE_USER: 'ci_user',
    Auth: { getUserId: () => owner },
    localStorage: { getItem: key => storage.get(key) ?? null },
    el: { score: {}, scoreChip: {} },
    saves: 0, save: () => context.saves++,
    categorySaving: false, sessionSyncPromise: null, sessionSyncOwner: null,
    Tracker: { fetchOwnScore: async () => 0 },
    guardAgainstAccountSwitch: () => { context.score = 0; storage.set('ci_user', owner); },
    loadReadingProfile: async () => false,
    refreshAndSyncScore: () => { throw new Error('No category: reading sync must remain gated'); },
  };
  vm.createContext(context);
  for (const name of ['renderScore', 'syncScoreFromServer', 'syncSessionFromCloud']) {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n}`));
    assert(match, name);
    vm.runInContext(match[0], context);
  }
  context.renderScore();
  assert.equal(context.el.score.textContent, '–', 'Never display the previous account score during auth restoration');
  await context.syncSessionFromCloud();
  assert.equal(context.score, 0);
  assert.equal(context.el.score.textContent, 0, 'The category gate must not hide the authoritative zero');
  assert.equal(context.saves, 1);

  // Același cont poate afișa propriul scor salvat când rețeaua e indisponibilă.
  context.score = 120;
  context.Tracker.fetchOwnScore = async () => null;
  await context.syncScoreFromServer();
  context.renderScore();
  assert.equal(context.el.score.textContent, 120);

  let finishRequest;
  context.Tracker.fetchOwnScore = () => new Promise(resolve => { finishRequest = resolve; });
  const pending = context.syncScoreFromServer();
  owner = 'another-account';
  context.score = 25;
  context.renderScore();
  assert.equal(context.el.score.textContent, '–');
  finishRequest(999);
  await pending;
  assert.equal(context.score, 25, 'An earlier account request must not overwrite the current account');
  context.userName = '';
  context.renderScore();
  assert.equal(context.el.score.textContent, '–');
  console.log('Account scores: category gate, account switches, offline cache and stale requests passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
