/* Asamblează folderul publicat pe GitHub Pages dintr-o LISTĂ PERMISĂ.

   Până acum Pages servea întregul depozit (branch main, rădăcina), deci erau
   publice și supabase/ (migrările și logica de apărare), tasks/ (note de
   incident), scripts/ și graphify-out/. Aici intră doar ce are nevoie
   aplicația în browser. Orice fișier nou publicabil se adaugă explicit mai jos.

   Folosire:  node scripts/build-pages-site.js [director-ieșire]   (implicit _site)
   Verificările din scriptul check-pages-site.js rulează în CI. */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = ['index.html', 'sw.js', 'manifest.webmanifest'];
const DIRS = ['css', 'js', 'icons', 'media'];

function build(outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(outDir, file));
  }
  for (const dir of DIRS) {
    fs.cpSync(path.join(ROOT, dir), path.join(outDir, dir), { recursive: true });
  }
  return outDir;
}

// URL-urile locale pe care aplicația le cere: index.html + lista ASSETS din sw.js.
function referencedFiles() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) urls.add(m[1]);
  const block = sw.match(/const ASSETS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('sw.js: nu am găsit lista ASSETS');
  for (const m of block[1].matchAll(/"([^"]+)"/g)) urls.add(m[1]);
  return [...urls]
    .filter((url) => !/^(https?:)?\/\//.test(url) && !url.startsWith('data:') && !url.startsWith('#') && url !== '.')
    .map((url) => url.split('?')[0]);
}

module.exports = { build, referencedFiles, FILES, DIRS };

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(ROOT, '_site'));
  build(out);
  console.log(`Site pregătit în ${out}`);
}
