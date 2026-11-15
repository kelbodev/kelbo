// Add-on: estensioni che estendono un'altra estensione (host) nei punti che quella offre.
// Manifest (addon, addonPoints), host come dipendenza obbligatoria, versioni dell'host e punti
// controllati all'avvio, tipo "addon", file serviti, servizi dell'host dal backend dell'add-on,
// host spento o aggiornato a una versione non compatibile
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, manifest, writeExtension, validateManifest, extensionKinds } = require('../lib/testkit');

let srv, root;
const hostManifest = version => manifest('host', {
  version, frontend: { js: 'view.js' },
  addonPoints: [{ id: 'item-menu', description: { it: 'Menu di una voce', en: 'Item menu' } }, { id: 'workspace-tab' }],
  backend: { module: 'server.js', routes: [] },
});
const addon = (code, addonDef, extra = {}) => ({
  'setting.json': manifest(code, { position: undefined, addon: addonDef, ...extra }),
  'addon.js': 'export default { activate(ctx, host) { host.add(ctx.code); } };',
  'addon.css': '.x{}',
  'i18n/it.json': JSON.stringify({ hello: 'Ciao' }),
  'i18n/en.json': JSON.stringify({ hello: 'Hello' }),
});
const list = async () => (await srv.request('GET', '/api/core/extensions')).json;
const ext = async code => (await list()).find(e => e.code === code);

before(async () => {
  root = tmpDir('kelbo-addons-');
  writeExtension(root, 'host', {
    'setting.json': hostManifest('1.2.0'),
    'view.js': 'export default { mount() {} };',
    'server.js': 'module.exports = () => ({ handlers: {}, services: { greet: n => `ciao ${n}` } });',
  });
  writeExtension(root, 'plain', { 'setting.json': manifest('plain'), 'view.js': 'export default { mount() {} };' });
  writeExtension(root, 'good', addon('good', { host: 'host', version: '>=1.1', js: 'addon.js', css: 'addon.css', points: ['item-menu', 'workspace-tab'] }, {
    backend: { module: 'server.js', routes: [{ method: 'GET', path: '/greet', handler: 'greet' }] },
  }));
  fs.writeFileSync(path.join(root, 'good', 'server.js'), "module.exports = ctx => ({ handlers: { greet(req, res) { res.json({ text: ctx.require('host').greet('add-on') }); } } });");
  writeExtension(root, 'too-new', addon('too-new', { host: 'host', version: '^2.0', js: 'addon.js', points: ['item-menu'] }));
  writeExtension(root, 'bad-point', addon('bad-point', { host: 'host', version: '>=1.0', js: 'addon.js', points: ['toolbar'] }));
  writeExtension(root, 'not-host', addon('not-host', { host: 'plain', version: '>=1.0', js: 'addon.js' }));
  writeExtension(root, 'orphan', addon('orphan', { host: 'ghost', version: '>=1.0', js: 'addon.js' }));
  // facoltativi: una sezione propria che funziona anche senza l'host
  const optional = (code, host, version) => {
    writeExtension(root, code, { ...addon(code, { host, version, js: 'addon.js', points: ['item-menu'], optional: true }, { position: 'tab', frontend: { js: 'view.js' }, backend: { module: 'server.js', routes: [{ method: 'GET', path: '/ping', handler: 'ping' }] } }),
      'view.js': 'export default { mount() {} };' });
    fs.writeFileSync(path.join(root, code, 'server.js'), "let started = Date.now(); module.exports = () => ({ handlers: { ping(req, res) { res.json({ started }); } } });");
  };
  optional('opt-ok', 'host', '>=1.1');
  optional('opt-new', 'host', '^2.0');
  optional('opt-ghost', 'ghost', '>=1.0');
  srv = await startServer({ projects: [] }, { extensions: null, install: [path.join(root, 'host'), path.join(root, 'plain'), path.join(root, 'good'), path.join(root, 'too-new'), path.join(root, 'bad-point'), path.join(root, 'not-host'), path.join(root, 'orphan'), path.join(root, 'opt-ok'), path.join(root, 'opt-new'), path.join(root, 'opt-ghost')] });
});
after(() => srv?.stop());

test('manifest: addon e addonPoints validati, host come dipendenza obbligatoria, tipo addon', () => {
  const m = validateManifest(manifest('a', { position: undefined, addon: { host: 'db-client', version: '>=1.1', js: 'addon.js', points: ['table-menu'] } }), 'a');
  assert.deepEqual(m.dependencies, [{ code: 'db-client', required: true }]);
  assert.deepEqual(m.addon, { host: 'db-client', version: '>=1.1', js: 'addon.js', css: null, points: ['table-menu'], optional: false });
  assert.deepEqual(extensionKinds(m), ['addon']);
  const bad = (addonDef, re, extra = {}) => assert.throws(() => validateManifest(manifest('a', { position: undefined, addon: addonDef, ...extra }), 'a'), re);
  bad({ host: 'a', version: '>=1' }, /addon\.host/);
  bad({ host: 'x', version: 'boh' }, /addon\.version/);
  bad({ host: 'x', version: '>=1', js: '../x.js' }, /addon\.js/);
  bad({ host: 'x', version: '>=1', points: ['Menu!'] }, /addon\.points/);
  bad({ host: 'x', version: '>=1', points: ['menu'] }, /richiede "addon\.js"/);
  bad({ host: 'x', version: '>=1' }, /facoltative/, { dependencies: [{ code: 'x', required: false }] });
  bad({ host: 'x', version: '>=1', optional: 'si' }, /addon\.optional/);
  // facoltativo: l'host non diventa una dipendenza; l'estensione può avere anche una sua sezione
  const opt = validateManifest(manifest('t', { frontend: { js: 'view.js' }, addon: { host: 'npm', version: '>=1.1', js: 'addon.js', points: ['script-actions'], optional: true } }), 't');
  assert.deepEqual(opt.dependencies, []);
  assert.equal(opt.addon.optional, true);
  assert.deepEqual(extensionKinds(opt), ['component', 'addon']);
  assert.throws(() => validateManifest(manifest('h', { addonPoints: [{ id: 'a' }, { id: 'a' }] }), 'h'), /duplicato/);
  assert.throws(() => validateManifest(manifest('h', { addonPoints: [{ id: 'A b' }] }), 'h'), /addonPoints/);
});

test('stati: compatibile, versione dell\'host fuori range, punto mancante, host che non accoglie add-on, host assente', async () => {
  const all = await list();
  const by = Object.fromEntries(all.map(e => [e.code, e]));
  assert.equal(by.good.state, 'ok');
  assert.deepEqual(by.good.kinds, ['addon']);
  assert.deepEqual(by.good.addon, { host: 'host', version: '>=1.1', js: 'addon.js', css: 'addon.css', points: ['item-menu', 'workspace-tab'], optional: false });
  assert.equal(by.good.addonActive, true);
  assert.deepEqual(by.host.addonPoints.map(p => p.id), ['item-menu', 'workspace-tab']);
  assert.deepEqual([by['too-new'].state, by['too-new'].errorInfo.code, by['too-new'].errorInfo.params], ['disabled', 'core.ext_addon_host_version', { host: 'host', range: '^2.0', version: '1.2.0' }]);
  assert.deepEqual([by['bad-point'].state, by['bad-point'].errorInfo.code, by['bad-point'].errorInfo.params.points], ['disabled', 'core.ext_addon_points', 'toolbar']);
  assert.deepEqual([by['not-host'].state, by['not-host'].errorInfo.code], ['disabled', 'core.ext_addon_not_host']);
  assert.deepEqual([by.orphan.state, by.orphan.errorInfo.code], ['disabled', 'core.ext_dep_missing']);
});

test('file serviti: modulo, foglio e cataloghi dell\'add-on; il backend usa i servizi dell\'host', async () => {
  assert.equal((await srv.request('GET', '/ext/good/addon.js')).status, 200);
  assert.equal((await srv.request('GET', '/ext/good/addon.css')).status, 200);
  assert.equal((await srv.request('GET', '/ext/good/i18n/en.json')).json.hello, 'Hello');
  assert.equal((await srv.request('GET', '/ext/good/setting.json')).status, 404);
  assert.equal((await srv.request('GET', '/ext/too-new/addon.js')).status, 404, 'add-on non attivo: niente file');
  assert.deepEqual((await srv.request('GET', '/api/ext/good/greet')).json, { text: 'ciao add-on' });
});

test('host spento: l\'add-on si ferma; host aggiornato a una versione incompatibile: disattivato', async () => {
  let r = await srv.request('POST', '/api/core/extensions-admin/host/enabled', { body: { enabled: false } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await ext('good')).state, 'disabled');
  await srv.request('POST', '/api/core/extensions-admin/host/enabled', { body: { enabled: true } });
  assert.equal((await ext('good')).state, 'ok');
  // nuova versione dell'host (1.0.0): l'add-on chiede >=1.1
  const dir = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'host').dir;
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(hostManifest('1.0.0')));
  r = await srv.request('POST', '/api/core/extensions-admin/host/reload', { body: {} });
  assert.equal(r.status, 200, r.text);
  const good = await ext('good');
  assert.deepEqual([good.state, good.errorInfo?.code], ['disabled', 'core.ext_addon_host_version']);
  fs.writeFileSync(path.join(dir, 'setting.json'), JSON.stringify(hostManifest('1.2.0')));
  await srv.request('POST', '/api/core/extensions-admin/host/reload', { body: {} });
  assert.equal((await ext('good')).state, 'ok');
});

test('add-on facoltativo: attivo con l\'host compatibile, altrimenti solo la sua sezione; host spento senza riavviarlo', async () => {
  const by = Object.fromEntries((await list()).map(e => [e.code, e]));
  assert.equal(by['opt-ok'].error, null);
  assert.deepEqual([by['opt-ok'].state, by['opt-ok'].addonActive, by['opt-ok'].addonProblem, by['opt-ok'].dependencies], ['ok', true, null, []]);
  assert.deepEqual([by['opt-new'].state, by['opt-new'].addonActive, by['opt-new'].addonProblem.code], ['ok', false, 'core.ext_addon_host_version']);
  assert.deepEqual([by['opt-ghost'].state, by['opt-ghost'].addonActive, by['opt-ghost'].addonProblem.code], ['ok', false, 'core.ext_addon_host_missing']);
  assert.equal((await srv.request('GET', '/ext/opt-ok/addon.js')).status, 200);
  const before = (await srv.request('GET', '/api/ext/opt-ok/ping')).json.started;
  // host spento: la parte add-on si ferma, l'estensione no (e non viene riavviata)
  await srv.request('POST', '/api/core/extensions-admin/host/enabled', { body: { enabled: false } });
  let e = await ext('opt-ok');
  assert.deepEqual([e.state, e.addonActive, e.addonProblem.code], ['ok', false, 'core.ext_addon_host_off']);
  assert.equal((await srv.request('GET', '/api/ext/opt-ok/ping')).json.started, before);
  await srv.request('POST', '/api/core/extensions-admin/host/enabled', { body: { enabled: true } });
  e = await ext('opt-ok');
  assert.deepEqual([e.state, e.addonActive], ['ok', true]);
  assert.equal((await srv.request('GET', '/api/ext/opt-ok/ping')).json.started, before);
});
