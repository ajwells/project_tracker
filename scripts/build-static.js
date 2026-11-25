// Builds the whole app into one HTML file that runs with no server: open it from disk,
// or put it on any web host. Projects are kept in the browser, as when the server
// runs with SAVE_DATA off.
//
//   npm run build:static            writes dist/project-tracker.html
//   node scripts/build-static.js out.html
//
// Browsers won't load JavaScript modules from a page opened from disk, so each module
// goes into the page as text. At startup a small loader turns each into a blob URL and
// adds an import map from each module's place in the app to its blob, so the modules
// import each other just as they do from the server. Nothing in them is rewritten
// except their import paths, made absolute so the import map can match them.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const out = resolve(process.argv[2] ?? join(root, 'dist', 'project-tracker.html'));

// A made-up address the modules appear to live at. It's never fetched.
const BASE = 'https://project-tracker.invalid/';

const filesIn = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesIn(path) : [path];
});
const webPath = (file) => relative(pub, file).split(sep).join('/');

// Every import of another module, static or dynamic, with a relative or root path.
const IMPORT = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2}\/|\/)[^'"]+)\2/g;

const modules = {};
for (const file of [...filesIn(join(pub, 'js')), ...filesIn(join(pub, 'shared'))].filter((f) => f.endsWith('.js'))) {
  const here = webPath(file);
  const code = readFileSync(file, 'utf8').replace(IMPORT, (match, lead, quote, spec) => {
    const target = spec.startsWith('/') ? spec.slice(1) : posix.normalize(posix.join(posix.dirname(here), spec));
    if (!existsIn(target)) throw new Error(`${here} imports ${spec}, which isn't in public/`);
    return `${lead}${quote}${BASE}${target}${quote}`;
  });
  modules[BASE + here] = code;
}
function existsIn(path) {
  try {
    return statSync(join(pub, ...path.split('/'))).isFile();
  } catch {
    return false;
  }
}

// JSON that can sit inside a <script> without the page's HTML parser seeing a tag in it.
const LS = String.fromCharCode(0x2028); // line and paragraph separators end a line in old JavaScript
const PS = String.fromCharCode(0x2029);
const inline = (value) => JSON.stringify(value).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');

const css = readFileSync(join(pub, 'styles.css'), 'utf8');
const icon = `data:image/svg+xml;base64,${readFileSync(join(pub, 'favicon.svg')).toString('base64')}`;
const pptx = readFileSync(join(pub, 'vendor', 'pptxgen.bundle.js'), 'utf8');
const license = readFileSync(join(pub, 'vendor', 'pptxgen.LICENSE.txt'), 'utf8');

const loader = `
window.PROJECT_TRACKER_STATIC = true;
(() => {
  const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  // The PowerPoint library, as an ordinary script.
  const pptx = document.createElement('script');
  pptx.src = blobUrl(${inline(pptx)});
  document.head.append(pptx);
  const sources = ${inline(modules)};
  const imports = {};
  for (const [url, code] of Object.entries(sources)) imports[url] = blobUrl(code);
  const map = document.createElement('script');
  map.type = 'importmap';
  map.textContent = JSON.stringify({ imports });
  document.head.append(map);
  const start = document.createElement('script');
  start.type = 'module';
  start.textContent = 'import ' + JSON.stringify(${inline(`${BASE}js/app.js`)}) + ';';
  document.body.append(start);
})();
`;

// The page from index.html, with its stylesheet, icon and scripts put inside it.
let html = readFileSync(join(pub, 'index.html'), 'utf8');
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error(`index.html no longer has ${from}`);
  html = html.replace(from, () => to);
};
swap('<link rel="icon" href="/favicon.svg" type="image/svg+xml">', `<link rel="icon" href="${icon}" type="image/svg+xml">`);
swap('<link rel="stylesheet" href="/styles.css">', `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`);
swap('  <script src="/vendor/pptxgen.bundle.js" defer></script>\n', '');
swap('<script type="module" src="/js/app.js"></script>', `<!-- PptxGenJS 4.0.1, included below:\n${license.replace(/--/g, '- -')}\n-->\n  <script>${loader}</script>`);
html = html.replace('<title>Project Tracker</title>', '<title>Project Tracker</title>\n  <meta name="generator" content="Project Tracker single-file build">');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`Wrote ${relative(process.cwd(), out) || out} (${Math.round(Buffer.byteLength(html) / 1024)} KB, ${Object.keys(modules).length} modules)`);
