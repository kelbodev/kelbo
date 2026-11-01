// Widget (M3): contratto nel manifest, moduli serviti, elenco nell'API; cartella dati delle
// estensioni (ctx.dataDir). Le estensioni di prova bastano: le integrate hanno i loro test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, manifest, writeExtension, validateManifest } = require('../lib/testkit');

let srv, root;
before(async () => {
  root = tmpDir('kelbo-widgets-');
  writeExtension(root, 'wid', {
    'setting.json': manifest('wid', {
      config: ['widData'],
      backend: { module: 'server.js', routes: [{ method: 'GET', path: '/data-dir', handler: 'dataDir' }] },
      widgets: [
        { id: 'small', title: { it: 'Piccolo', en: 'Small' }, size: 's', js: 'widget.js' },
        { id: 'plain', title: 'Senza dimensione', js: 'other.js' },
      ],
    }),
    'server.js': `module.exports = ctx => ({
      config: { widData: { empty: {} } },
      handlers: { dataDir: (req, res) => res.json({ dir: ctx.dataDir() }) },
    });`,
    'widget.js': 'export default { mount(ctx, el) { el.textContent = "ok"; } };',
    'other.js': 'export default { mount() { throw new Error("rotto"); } };',
    'secret.js': '// non elencato: non va servito',
  });
  writeExtension(root, 'spenta', {
    'setting.json': manifest('spenta', { widgets: [{ id: 'w', title: 'W', js: 'widget.js' }] }),
    'widget.js': 'export default {};',
  });
  srv = await startServer({ projects: [], extensions: { disabled: ['spenta'] } },
    { extensions: null, install: [path.join(root, 'wid'), path.join(root, 'spenta')] });
});
after(() => srv?.stop());

test('manifest: widget validati, dimensione predefinita "m", errori chiari', () => {
  const m = validateManifest(manifest('x', { widgets: [{ id: 'a', title: 'A', js: 'a.js' }] }), 'x');
  assert.deepEqual(m.widgets, [{ id: 'a', title: 'A', js: 'a.js', scope: 'project', size: 'm' }]);
  const bad = widgets => assert.throws(() => validateManifest(manifest('x', { widgets }), 'x'));
  bad('no');
  bad([{ id: 'A b', title: 'A', js: 'a.js' }]);
  bad([{ id: 'a', js: 'a.js' }]);                             // titolo mancante
  bad([{ id: 'a', title: 'A', js: '../fuori.js' }]);          // file fuori dalla cartella
  bad([{ id: 'a', title: 'A', js: 'a.js', size: 'xl' }]);
  bad([{ id: 'a', title: 'A', js: 'a.js', scope: 'global' }]);
  bad([{ id: 'a', title: 'A', js: 'a.js' }, { id: 'a', title: 'B', js: 'b.js' }]);
  assert.deepEqual(validateManifest(manifest('x'), 'x').widgets, []);
});

test('API: widget delle estensioni attive, moduli serviti solo se dichiarati', async () => {
  const list = (await srv.request('GET', '/api/core/extensions')).json;
  const wid = list.find(e => e.code === 'wid');
  assert.deepEqual(wid.widgets.map(w => [w.id, w.size, w.js]), [['small', 's', 'widget.js'], ['plain', 'm', 'other.js']]);
  assert.deepEqual(wid.widgets[0].title, { it: 'Piccolo', en: 'Small' });
  assert.deepEqual(list.find(e => e.code === 'spenta').widgets, []); // spenta: niente widget
  const get = p => srv.request('GET', p);
  assert.equal((await get('/ext/wid/widget.js')).status, 200);
  assert.equal((await get('/ext/wid/other.js')).status, 200);
  assert.equal((await get('/ext/wid/secret.js')).status, 404);
  assert.equal((await get('/ext/wid/server.js')).status, 404);
  assert.equal((await get('/ext/spenta/widget.js')).status, 404);
});

test('ctx.dataDir(): cartella dei dati dell\'estensione nella home di Kelbo', async () => {
  const { dir } = (await srv.request('GET', '/api/ext/wid/data-dir')).json;
  assert.equal(dir, path.join(srv.home, 'data', 'wid'));
  assert.ok(fs.statSync(dir).isDirectory());
});

