// provides (M5.1): implementazioni di una capacità offerte da un'estensione e lette da un'altra con
// ctx.providers(); validazione del manifest, provider mancante, spegnimento; tipi delle estensioni
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, manifest, writeExtension, validateManifest, extensionKinds } = require('../lib/testkit');

let srv;
const engine = (code, id) => ({
  'setting.json': manifest(code, {
    provides: [{ capability: 'db-engine', id, title: { it: `Motore ${id}`, en: `Engine ${id}` }, handler: 'engine' }],
    backend: { module: 'server.js' },
  }),
  'server.js': `module.exports = () => ({ providers: { engine: { hello: () => 'ciao da ${id}' } } });`,
});
before(async () => {
  const root = tmpDir('kelbo-providers-');
  const host = manifest('host', {
    backend: { module: 'server.js', routes: [{ method: 'GET', path: '/engines', handler: 'engines' }] },
    frontend: { js: 'view.js' },
  });
  writeExtension(root, 'host', {
    'setting.json': host,
    'server.js': `module.exports = ctx => ({ handlers: { engines: (req, res) => res.json(ctx.providers('db-engine').map(p => ({ id: p.id, extension: p.extension, title: p.title, hello: p.impl.hello() }))) } });`,
    'view.js': 'export default { mount() {} };',
  });
  writeExtension(root, 'eng-a', engine('eng-a', 'alpha'));
  writeExtension(root, 'eng-b', engine('eng-b', 'beta'));
  // provider dichiarato ma assente dal backend: l'estensione non parte
  writeExtension(root, 'eng-bad', { ...engine('eng-bad', 'gamma'), 'server.js': 'module.exports = () => ({ providers: {} });' });
  srv = await startServer({ projects: [] }, { extensions: null, install: ['host', 'eng-a', 'eng-b', 'eng-bad'].map(c => path.join(root, c)) });
});
after(() => srv?.stop());

const engines = async () => (await srv.request('GET', '/api/ext/host/engines')).json;

test('manifest: provides validato', () => {
  const ok = validateManifest(manifest('x', { backend: { module: 's.js' }, provides: [{ capability: 'db-engine', id: 'pg', title: 'PG', handler: 'pg' }] }), 'x');
  assert.deepEqual(ok.provides, [{ capability: 'db-engine', id: 'pg', title: 'PG', handler: 'pg' }]);
  assert.deepEqual(validateManifest(manifest('x'), 'x').provides, []);
  const bad = [
    [{ capability: 'DB', id: 'pg', title: 'PG', handler: 'pg' }, /capability/],
    [{ capability: 'db-engine', id: 'P G', title: 'PG', handler: 'pg' }, /id/],
    [{ capability: 'db-engine', id: 'pg', handler: 'pg' }, /title/],
    [{ capability: 'db-engine', id: 'pg', title: 'PG' }, /handler/],
  ];
  for (const [pr, re] of bad) assert.throws(() => validateManifest(manifest('x', { backend: { module: 's.js' }, provides: [pr] }), 'x'), re);
  assert.throws(() => validateManifest(manifest('x', { provides: [{ capability: 'db-engine', id: 'pg', title: 'PG', handler: 'pg' }] }), 'x'), /backend/);
  assert.throws(() => validateManifest(manifest('x', { backend: { module: 's.js' }, provides: [1, 2].map(() => ({ capability: 'db-engine', id: 'pg', title: 'PG', handler: 'pg' })) }), 'x'), /duplicato/);
});

test('tipi ricavati dal manifest', async () => {
  assert.deepEqual(extensionKinds({ frontend: { js: 'v.js' }, provides: [{}], themes: [{}] }), ['component', 'provider', 'theme']);
  assert.deepEqual(extensionKinds({ themes: [{}] }), ['theme']);
  const list = (await srv.request('GET', '/api/core/extensions')).json;
  const by = Object.fromEntries(list.map(e => [e.code, e]));
  assert.deepEqual(by.host.kinds, ['component']);
  assert.deepEqual(by['eng-a'].kinds, ['provider']);
  assert.deepEqual(by['eng-a'].provides, [{ capability: 'db-engine', id: 'alpha', title: { it: 'Motore alpha', en: 'Engine alpha' } }]);
  assert.equal(by['eng-bad'].state, 'disabled');
  assert.match(by['eng-bad'].error, /provider non trovati/);
});

test('ctx.providers: le implementazioni attive, seguendo spegnimento e riaccensione', async () => {
  assert.deepEqual((await engines()).map(e => [e.id, e.extension, e.hello]), [['alpha', 'eng-a', 'ciao da alpha'], ['beta', 'eng-b', 'ciao da beta']]);
  let r = await srv.request('POST', '/api/core/extensions-admin/eng-a/enabled', { body: { enabled: false } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await engines()).map(e => e.id), ['beta']);
  r = await srv.request('POST', '/api/core/extensions-admin/eng-a/enabled', { body: { enabled: true } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await engines()).map(e => e.id).sort(), ['alpha', 'beta']);
});
