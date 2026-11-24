// Environment della sezione (dev, staging, prod…): variabili proprie e URL di base proprio sopra
// quelli comuni, environment attivo usato negli invii, creazione/modifica/eliminazione, config
// validata (anche importata)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer, freePort } = require('../../../lib/testkit');

let srv, sid, apiA, apiB, portA, portB;
const call = (m, p, body) => srv.request(m, `/api/ext/http-client${p}`, body !== undefined ? { body } : {});
const echo = name => http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ server: name, url: req.url, h: req.headers['x-tenant'] || null })); });

before(async () => {
  portA = await freePort(); apiA = echo('A').listen(portA, '127.0.0.1');
  portB = await freePort(); apiB = echo('B').listen(portB, '127.0.0.1');
  srv = await startServer({ projects: [] });
  sid = (await call('POST', '/sections', { label: 'Shop', baseUrl: `http://127.0.0.1:${portA}`, variables: [{ name: 'tenant', value: 'common' }, { name: 'ver', value: 'v1' }] })).json.id;
});
after(async () => { apiA?.close(); apiB?.close(); await srv?.stop(); });

const send = () => call('POST', '/send', { section: sid, request: { method: 'GET', url: '{{baseUrl}}/{{ver}}/x', query: [], headers: [{ name: 'X-Tenant', value: '{{tenant}}' }], bodyType: 'none', body: '' } });

test('environment: variabili e URL di base sopra quelli comuni, il primo diventa attivo', async () => {
  let r = await send();
  assert.deepEqual(JSON.parse(r.json.body), { server: 'A', url: '/v1/x', h: 'common' });
  // staging: altro server e tenant, "ver" resta quella comune
  r = await call('POST', `/sections/${sid}/environments`, { label: 'staging', baseUrl: `http://127.0.0.1:${portB}/`, variables: [{ name: 'tenant', value: 'acme' }] });
  assert.equal(r.status, 200, r.text);
  const staging = r.json.environments[0];
  assert.equal(r.json.activeEnvironment, staging.id, 'il primo environment è attivo');
  assert.deepEqual(JSON.parse((await send()).json.body), { server: 'B', url: '/v1/x', h: 'acme' });
  // dev: senza URL proprio (quello della sezione), ver sovrascritta
  r = await call('POST', `/sections/${sid}/environments`, { label: 'dev', variables: [{ name: 'ver', value: 'v2' }] });
  const dev = r.json.environments[1];
  assert.equal(r.json.activeEnvironment, staging.id, 'il secondo non cambia quello attivo');
  r = await call('PUT', `/sections/${sid}/active-environment`, { id: dev.id });
  assert.equal(r.json.activeEnvironment, dev.id);
  assert.deepEqual(JSON.parse((await send()).json.body), { server: 'A', url: '/v2/x', h: 'common' });
  // modifica, nessun environment, eliminazione di quello attivo
  r = await call('PUT', `/sections/${sid}/environments/${dev.id}`, { label: 'dev', variables: [{ name: 'ver', value: 'v3' }, { name: 'tenant', value: 'local' }] });
  assert.deepEqual(JSON.parse((await send()).json.body), { server: 'A', url: '/v3/x', h: 'local' });
  r = await call('PUT', `/sections/${sid}/active-environment`, { id: null });
  assert.equal(r.json.activeEnvironment, null);
  assert.deepEqual(JSON.parse((await send()).json.body), { server: 'A', url: '/v1/x', h: 'common' });
  await call('PUT', `/sections/${sid}/active-environment`, { id: dev.id });
  r = await call('DELETE', `/sections/${sid}/environments/${dev.id}`);
  assert.deepEqual([r.json.environments.map(e => e.label), r.json.activeEnvironment], [['staging'], staging.id], 'attivo il primo rimasto');
  // errori
  assert.equal((await call('POST', `/sections/${sid}/environments`, { label: ' ' })).json.code, 'http-client.environment_label');
  assert.equal((await call('PUT', `/sections/${sid}/active-environment`, { id: 'nope' })).status, 404);
  assert.equal((await call('POST', `/sections/${sid}/environments`, { label: 'x', variables: [{ name: 'baseUrl', value: 'y' }] })).status, 400, 'baseUrl riservata');
});

test('config: environment validati anche in import', async () => {
  const base = { id: 'imp01', label: 'Import', baseUrl: '', variables: [], userTypes: [], requests: [] };
  const put = s => srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { httpSections: [s] } } });
  assert.equal((await put({ ...base, environments: [{ id: 'e1', label: 'dev', variables: [] }], activeEnvironment: 'nope' })).status, 400);
  assert.equal((await put({ ...base, environments: [{ id: 'e1', label: 'dev', variables: [{ name: 'a b', value: '1' }] }] })).status, 400);
  assert.equal((await put({ ...base, environments: [{ id: 'e1', label: 'dev' }, { id: 'e1', label: 'prod' }] })).status, 400);
  const ok = await put({ ...base, environments: [{ id: 'e1', label: 'dev', variables: [{ name: 'a', value: '1' }] }], activeEnvironment: 'e1' });
  assert.equal(ok.status, 200, ok.text);
});

test('token per environment: quello incollato con staging attivo non vale con prod', async () => {
  await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-env' } });
  const s2 = (await call('POST', '/sections', { label: 'Auth', baseUrl: `http://127.0.0.1:${portA}` })).json.id;
  const uid = (await call('POST', `/sections/${s2}/users`, { label: 'Admin', auth: { type: 'manual' } })).json.id;
  const staging = (await call('POST', `/sections/${s2}/environments`, { label: 'staging' })).json.environments[0].id;
  const prod = (await call('POST', `/sections/${s2}/environments`, { label: 'prod' })).json.environments[1].id;
  const req = { method: 'GET', url: '{{baseUrl}}/me', query: [], headers: [], bodyType: 'none', body: '', userType: uid };
  assert.equal((await call('POST', `/sections/${s2}/users/${uid}/token`, { token: 'tok-staging' })).status, 200);
  let r = await call('POST', '/send', { section: s2, request: req });
  assert.equal(r.status, 200, r.text);
  await call('PUT', `/sections/${s2}/active-environment`, { id: prod });
  r = await call('POST', '/send', { section: s2, request: req });
  assert.equal(r.json.code, 'http-client.token_missing', 'in prod serve un altro token');
  await call('PUT', `/sections/${s2}/active-environment`, { id: staging });
  assert.equal((await call('POST', '/send', { section: s2, request: req })).status, 200, 'tornando a staging il suo token c\'è ancora');
});
