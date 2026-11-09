// Ordine delle tab (sezione "layout" del core): API, validazione, codici sconosciuti scartati,
// ripristino dell'ordine dei manifest, import
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../lib/testkit');
const { sampleExtensions } = require('./fixtures');

let srv;
before(async () => { srv = await startServer(undefined, { extensions: sampleExtensions() }); });
after(() => srv?.stop());

const call = (m, p, body) => srv.request(m, `/api/core${p}`, body !== undefined ? { body } : {});

test('ordine predefinito: lista vuota', async () => {
  assert.deepEqual((await call('GET', '/layout')).json, { tabs: [], positions: {}, theme: { id: '', system: false, light: '', dark: '' } });
});

test('salvataggio: duplicati e codici sconosciuti o non di tab scartati', async () => {
  const r = await call('PUT', '/layout/tabs', { tabs: ['third', 'nope', 'sample', 'third', 'panel', 'second'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.tabs, ['third', 'sample', 'second']); // panel è un pulsante dell'header
  assert.deepEqual(srv.readConfig().layout, { tabs: ['third', 'sample', 'second'] });
  assert.deepEqual((await call('GET', '/layout')).json.tabs, ['third', 'sample', 'second']);
});

test('validazione della lista', async () => {
  for (const tabs of [undefined, 'git', [1, 2], [{}]]) {
    const r = await call('PUT', '/layout/tabs', { tabs });
    assert.equal(r.status, 400, JSON.stringify(tabs));
    assert.equal(r.json.code, 'core.layout_tabs');
  }
  // dall'import: codici non validi o ripetuti rifiutati
  let r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { tabs: ['third', 'third'] } } });
  assert.equal(r.status, 400);
  r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { tabs: ['Git!'] } } });
  assert.equal(r.status, 400);
  r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { tabs: ['second', 'old-extension'], extra: 1 } } });
  assert.equal(r.status, 200, r.text);
  // un'estensione rimossa resta nella lista salvata ma la shell la ignora
  assert.deepEqual(srv.readConfig().layout, { tabs: ['second', 'old-extension'] });
});

test('ripristino dell\'ordine predefinito', async () => {
  const r = await call('DELETE', '/layout/tabs');
  assert.deepEqual(r.json.tabs, []);
  assert.deepEqual(srv.readConfig().layout, {});
});

test('posizione: tab o header diversa dal manifest, ripristinabile; le tab spostate contano nell\'ordine', async () => {
  const ext = async code => (await call('GET', '/extensions')).json.find(e => e.code === code);
  assert.deepEqual([(await ext('panel')).position, (await ext('panel')).manifestPosition], ['header', 'header']);
  let r = await call('PUT', '/layout/positions/panel', { position: 'tab' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.positions, { panel: 'tab' });
  assert.equal((await ext('panel')).position, 'tab');
  // ora è una tab: entra nell'ordine salvato
  r = await call('PUT', '/layout/tabs', { tabs: ['panel', 'sample'] });
  assert.deepEqual(r.json.tabs, ['panel', 'sample']);
  await call('PUT', '/layout/positions/second', { position: 'header' });
  assert.deepEqual(srv.readConfig().layout.positions, { panel: 'tab', second: 'header' });
  // la posizione del manifest o null tolgono l'override
  await call('PUT', '/layout/positions/panel', { position: 'header' });
  await call('PUT', '/layout/positions/second', { position: null });
  assert.equal(srv.readConfig().layout.positions, undefined);
  assert.equal((await ext('second')).position, 'tab');
  assert.equal((await call('PUT', '/layout/positions/second', { position: 'sidebar' })).json.code, 'core.layout_positions');
  assert.equal((await call('PUT', '/layout/positions/nope', { position: 'tab' })).json.code, 'core.layout_no_ui');
  r = await call('POST', '/config/import', { mode: 'replace', config: { layout: { positions: { second: 'altrove' } } } });
  assert.equal(r.json.code, 'core.layout_positions');
});
