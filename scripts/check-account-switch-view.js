// După o schimbare de cont, fereastra „Contul meu" nu are voie să arate
// categoria contului anterior cât timp profilul noului cont nu s-a încărcat.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const ReadingPath = require('../js/reading-path');

const el = new Proxy({}, { get: (target, key) => target[key] ??= { hidden: true, textContent: '', focus() {} } });
let signedIn = 'user-a';
const context = {
  el, ReadingPath, readingProfile: { category_id: ReadingPath.categories[2].id }, categoryOwnerId: 'user-a',
  passwordFormOwner: null, resetPasswordForm() {}, appVersionText: () => 'v',
  Auth: { isLoggedIn: () => !!signedIn, getUserId: () => signedIn, currentUser: () => 'Utilizator' },
};
vm.createContext(context);
vm.runInContext(app.match(/function showAuthModal\([^]*?\n}/)[0], context);

context.showAuthModal();
assert.equal(el.accountCategory.textContent, ReadingPath.categories[2].label, 'The owner sees their own category');
signedIn = 'user-b';
context.showAuthModal();
assert.equal(el.accountCategory.textContent, 'Categoria nu este aleasă',
  'Another account must not see the previous account category');
context.categoryOwnerId = 'user-b';
context.readingProfile = { category_id: ReadingPath.categories[0].id };
context.showAuthModal();
assert.equal(el.accountCategory.textContent, ReadingPath.categories[0].label);
console.log('Account switch view: category label follows the signed-in account.');
