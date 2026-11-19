// Folderul publicat pe Pages trebuie să conțină tot ce cer index.html și sw.js
// (altfel o instalare PWA curată rămâne fără fișiere), dar nimic din interne.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, referencedFiles } = require('./build-pages-site');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'citim-pages-'));
try {
  build(out);
  const published = new Set();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else published.add(path.relative(out, full).split(path.sep).join('/'));
    }
  })(out);

  const referenced = referencedFiles();
  assert.ok(referenced.length >= 15, `expected the app's local files, got ${referenced.length}`);
  for (const file of referenced) {
    assert.ok(published.has(file), `index.html/sw.js require "${file}", but it is not in the published site`);
  }

  // Resurse cerute în timpul rulării (imagini din scenes.js, manifest, css) care nu apar
  // în index.html: orice cale locală către un fișier media trebuie să fie publicată.
  const runtime = ['manifest.webmanifest', 'css/style.css', 'js/scenes.js', 'js/app.js', 'js/tracker.js'];
  let runtimeRefs = 0;
  for (const file of runtime) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const m of text.matchAll(/["'(]((?:\.\/|\.\.\/)?(?:media|icons)\/[A-Za-z0-9_\/.-]+\.(?:jpg|jpeg|png|svg|webp|gif))/g)) {
      const ref = m[1].replace(/^(\.\.?\/)+/, '');
      runtimeRefs += 1;
      assert.ok(published.has(ref), `${file} uses "${ref}", but it is not in the published site`);
    }
  }
  assert.ok(runtimeRefs > 0, 'expected at least one runtime media reference');

  const forbidden = ['supabase/', 'tasks/', 'scripts/', 'graphify-out/', '.github/', 'node_modules/', '.claude/', 'CLAUDE.md', 'package.json', 'package-lock.json', 'validate.js', 'validate2sam.js'];
  for (const file of published) {
    for (const prefix of forbidden) {
      assert.ok(!file.startsWith(prefix) && file !== prefix, `"${file}" must not be published`);
    }
  }
  // Nici fișiere sensibile ascunse în folderele permise.
  for (const file of published) {
    assert.ok(!/\.(sql|md|ps1|env|pem|key)$/i.test(file) && !/(^|\/)\.[^/]/.test(file), `"${file}" looks internal`);
  }
  assert.ok(published.has('js/vendor/supabase.min.js'), 'The self-hosted SDK must be published');
  console.log(`Pages site: ${published.size} files, every file index.html and sw.js need is published, no internal folders.`);
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
