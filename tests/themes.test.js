// Temi (M11): contratto nel manifest, fogli serviti, elenco nell'API, scelta salvata in
// layout.theme (validazione, ultimo tema per schema, import)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, manifest, writeExtension, validateManifest } = require('../lib/testkit');

let srv, root;
const CSS = ':root[data-theme] { --bg: #ffffff; --text: #1f2328; }';
before(async () => {
  root = tmpDir('kelbo-themes-');
  // un'estensione solo di temi: niente frontend né "position"
  const m = manifest('colori', { themes: [
    { id: 'chiaro', name: { it: 'Chiaro', en: 'Light' }, scheme: 'light', css: 'themes/light.css' },
    { id: 'notte', name: 'Notte', scheme: 'dark', css: 'themes/night.css' },
  ] });
  delete m.position;
  writeExtension(root, 'colori', { 'setting.json': m, 'themes/light.css': CSS, 'themes/night.css': CSS, 'secret.css': 'x' });
  srv = await startServer({ projects: [] }, { extensions: null, install: [path.join(root, 'colori')] });
});
after(() => srv?.stop());

const call = (m, p, body) => srv.request(m, `/api/core${p}`, body !== undefined ? { body } : {});

test('manifest: temi validati, errori chiari', () => {
  const ok = validateManifest(manifest('x', { themes: [{ id: 'a', name: 'A', scheme: 'dark', css: 'a.css' }] }), 'x');
  assert.deepEqual(ok.themes, [{ id: 'a', name: 'A', scheme: 'dark', css: 'a.css' }]);
  assert.deepEqual(validateManifest(manifest('x'), 'x').themes, []);
  const bad = [
    [{ id: 'A', name: 'A', scheme: 'dark', css: 'a.css' }, /id/],
    [{ id: 'a', scheme: 'dark', css: 'a.css' }, /name/],
    [{ id: 'a', name: 'A', scheme: 'blue', css: 'a.css' }, /scheme/],
    [{ id: 'a', name: 'A', scheme: 'dark', css: '../a.css' }, /css/],
    [{ id: 'a', name: 'A', scheme: 'dark', css: 'a.js' }, /css/],
  ];
  for (const [th, re] of bad) assert.throws(() => validateManifest(manifest('x', { themes: [th] }), 'x'), re);
  assert.throws(() => validateManifest(manifest('x', { themes: [{ id: 'a', name: 'A', scheme: 'dark', css: 'a.css' }, { id: 'a', name: 'B', scheme: 'light', css: 'b.css' }] }), 'x'), /duplicato/);
  // con un frontend "position" resta obbligatoria
  const m = manifest('x', { frontend: { js: 'view.js' } });
  delete m.position;
  assert.throws(() => validateManifest(m, 'x'), /position/);
});

test('API: temi delle estensioni e fogli serviti (solo quelli dichiarati)', async () => {
  const ext = (await call('GET', '/extensions')).json.find(e => e.code === 'colori');
  assert.equal(ext.state, 'ok');
  assert.deepEqual(ext.themes.map(t => [t.id, t.scheme, t.css]), [['chiaro', 'light', 'themes/light.css'], ['notte', 'dark', 'themes/night.css']]);
  const css = await srv.request('GET', '/ext/colori/themes/light.css');
  assert.equal(css.status, 200);
  assert.match(css.text, /--bg: #ffffff/);
  assert.equal((await srv.request('GET', '/ext/colori/secret.css')).status, 404);
});

test('scelta del tema: salvata in layout.theme, ultimo tema per schema', async () => {
  let r = await call('PUT', '/layout/theme', { id: 'colori/chiaro', scheme: 'light', system: false });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.theme, { id: 'colori/chiaro', system: false, light: 'colori/chiaro', dark: '' });
  r = await call('PUT', '/layout/theme', { id: 'colori/notte', scheme: 'dark' });
  assert.deepEqual(r.json.theme, { id: 'colori/notte', system: false, light: 'colori/chiaro', dark: 'colori/notte' });
  r = await call('PUT', '/layout/theme', { system: true });
  assert.deepEqual(r.json.theme, { id: 'colori/notte', system: true, light: 'colori/chiaro', dark: 'colori/notte' });
  assert.deepEqual(srv.readConfig().layout.theme, r.json.theme);
  // il tema del core
  r = await call('PUT', '/layout/theme', { id: '', system: false });
  assert.deepEqual(r.json.theme, { id: '', system: false, light: 'colori/chiaro', dark: '' });
  assert.deepEqual((await call('GET', '/layout')).json.theme, r.json.theme);
});

test('validazione del tema, anche dall\'import', async () => {
  for (const body of [{ id: 'Colori/X' }, { id: 'senza-barra' }, { system: 'si' }, { id: 'a/b', scheme: 'blue' }, { light: 3 }]) {
    const r = await call('PUT', '/layout/theme', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, 'core.layout_theme');
  }
  let r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { theme: { id: '../x' } } } });
  assert.equal(r.status, 400);
  r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { theme: { id: 'altro/tema', extra: 1 } } } });
  assert.equal(r.status, 200, r.text);
  // un tema non (più) installato resta salvato: la shell usa quello del core
  assert.deepEqual(srv.readConfig().layout.theme, { id: 'altro/tema', system: false, light: '', dark: '' });
});

test('testkit: il tema del core supera il controllo dei temi', () => {
  const fs = require('fs');
  const { themeProblems, themeTokens, ROOT } = require('../lib/testkit');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'core', 'shell.css'), 'utf8');
  const root = /:root\s*\{[^}]*\}/.exec(css)[0];
  assert.deepEqual(themeProblems(root), []);
  assert.ok(themeTokens().includes('--bg') && themeTokens().includes('--note-gray-fg') && !themeTokens().includes('--font'));
  assert.match(themeProblems(':root { --bg: #fff; color: red } body { --x: 1 }').join('\n'), /solo variabili[\s\S]*selettore non ammesso[\s\S]*variabili mancanti/);
});
