// Cartelle e sottocartelle delle richieste, sotto un'utenza (o fuori da tutte): creazione,
// richieste dentro, spostamenti (anche sotto un'altra utenza, con tutto il contenuto), cicli
// rifiutati, eliminazione che fa salire il contenuto, utenza eliminata, config non valida
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../../../lib/testkit');

let srv, sid, admin, guest;
const call = (m, p, body) => srv.request(m, `/api/ext/http-client${p}`, body !== undefined ? { body } : {});
const sec = async () => (await call('GET', '/sections')).json.find(s => s.id === sid);

before(async () => {
  srv = await startServer({ projects: [] });
  await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-hc' } });
  sid = (await call('POST', '/sections', { label: 'Shop API', baseUrl: 'http://127.0.0.1:9' })).json.id;
  admin = (await call('POST', `/sections/${sid}/users`, { label: 'Admin', auth: { type: 'none' } })).json.id;
  guest = (await call('POST', `/sections/${sid}/users`, { label: 'Guest', auth: { type: 'none' } })).json.id;
});
after(() => srv?.stop());

test('cartelle e sottocartelle sotto un\'utenza, richieste dentro; spostamenti e cicli', async () => {
  let r = await call('POST', `/sections/${sid}/folders`, { label: 'Ordini', userType: admin });
  assert.equal(r.status, 200, r.text);
  const orders = r.json;
  assert.deepEqual([orders.label, orders.userType, orders.parent], ['Ordini', admin, undefined]);
  // la sottocartella prende l'utenza della cartella che la contiene
  const refunds = (await call('POST', `/sections/${sid}/folders`, { label: 'Rimborsi', parent: orders.id, userType: guest })).json;
  assert.deepEqual([refunds.parent, refunds.userType], [orders.id, admin]);
  assert.equal((await call('POST', `/sections/${sid}/folders`, { label: '  ' })).json.code, 'http-client.folder_label');
  assert.equal((await call('POST', `/sections/${sid}/folders`, { label: 'X', parent: 'nope' })).status, 404);

  // richiesta nella sottocartella; una cartella di un'altra utenza è un errore
  const req = (await call('POST', `/sections/${sid}/requests`, { label: 'Rimborso', method: 'POST', url: '{{baseUrl}}/refunds', userType: admin, folder: refunds.id })).json;
  assert.equal(req.folder, refunds.id);
  assert.equal((await call('POST', `/sections/${sid}/requests`, { label: 'X', userType: guest, folder: refunds.id })).json.code, 'http-client.folder_user');
  // cambiando utenza dall'editor (stessa cartella nel corpo) la richiesta esce dalla cartella
  r = await call('PUT', `/sections/${sid}/requests/${req.id}`, { ...req, userType: guest });
  assert.deepEqual([r.json.userType, r.json.folder], [guest, undefined]);
  r = await call('PUT', `/sections/${sid}/requests/${req.id}`, { ...r.json, userType: admin, folder: refunds.id });
  assert.equal(r.json.folder, refunds.id);

  // una cartella non va dentro se stessa né in una sua sottocartella
  assert.equal((await call('PUT', `/sections/${sid}/folders/${orders.id}`, { parent: refunds.id })).json.code, 'http-client.folder_parent');
  assert.equal((await call('PUT', `/sections/${sid}/folders/${orders.id}`, { parent: orders.id })).json.code, 'http-client.folder_parent');

  // "Ordini" sotto Guest: sottocartelle e richieste la seguono
  r = await call('PUT', `/sections/${sid}/folders/${orders.id}`, { parent: null, userType: guest, label: 'Ordini (guest)' });
  assert.equal(r.status, 200, r.text);
  let s = await sec();
  assert.deepEqual(s.folders.map(f => [f.label, f.userType]), [['Ordini (guest)', guest], ['Rimborsi', guest]]);
  assert.deepEqual([s.requests[0].userType, s.requests[0].folder], [guest, refunds.id]);

  // "Rimborsi" alla radice di Admin, poi di nuovo dentro "Ordini" (torna Guest)
  await call('PUT', `/sections/${sid}/folders/${refunds.id}`, { parent: null, userType: admin });
  s = await sec();
  assert.deepEqual([s.folders[1].parent, s.folders[1].userType, s.requests[0].userType], [undefined, admin, admin]);
  await call('PUT', `/sections/${sid}/folders/${refunds.id}`, { parent: orders.id });
  s = await sec();
  assert.deepEqual([s.folders[1].parent, s.requests[0].userType], [orders.id, guest]);

  // eliminata "Ordini": "Rimborsi" sale alla radice di Guest con la sua richiesta
  assert.equal((await call('DELETE', `/sections/${sid}/folders/${orders.id}`)).status, 200);
  s = await sec();
  assert.deepEqual(s.folders.map(f => [f.label, f.parent, f.userType]), [['Rimborsi', undefined, guest]]);
  assert.equal(s.requests[0].folder, refunds.id);
  // eliminata "Rimborsi": la richiesta resta, fuori dalle cartelle
  await call('DELETE', `/sections/${sid}/folders/${refunds.id}`);
  s = await sec();
  assert.deepEqual([s.folders.length, s.requests.length, s.requests[0].folder], [0, 1, undefined]);
});

test('utenza eliminata: le sue cartelle restano, con le richieste, senza autorizzazione', async () => {
  const f = (await call('POST', `/sections/${sid}/folders`, { label: 'Admin tools', userType: admin })).json;
  const req = (await call('POST', `/sections/${sid}/requests`, { label: 'Reset', userType: admin, folder: f.id })).json;
  assert.equal((await call('DELETE', `/sections/${sid}/users/${admin}`)).status, 200);
  const s = await sec();
  const folder = s.folders.find(x => x.id === f.id);
  const r = s.requests.find(x => x.id === req.id);
  assert.deepEqual([folder.userType, r.userType, r.folder], [undefined, undefined, f.id]);
});

test('config importata: cartelle e richieste validate', async () => {
  const base = { id: 'abc123', label: 'Import', baseUrl: '', variables: [], userTypes: [], requests: [] };
  const put = list => srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { httpSections: list } } });
  const bad = async (section, code) => {
    const r = await put([section]);
    assert.notEqual(r.status, 200, `accettata: ${JSON.stringify(section)}`);
    assert.match(r.text, code);
  };
  await bad({ ...base, folders: [{ id: 'f1', label: 'A', parent: 'f1' }] }, /folder_invalid|f1/);
  await bad({ ...base, folders: [{ id: 'f1', label: 'A', parent: 'f2' }, { id: 'f2', label: 'B', parent: 'f1' }] }, /folder_invalid|f1|f2/);
  await bad({ ...base, folders: [{ id: 'f1', label: 'A', userType: 'ghost' }] }, /folder_invalid|f1/);
  await bad({ ...base, folders: [], requests: [{ id: 'r1', label: 'R', method: 'GET', url: '/', folder: 'nope' }] }, /request_folder|r1/);
});
