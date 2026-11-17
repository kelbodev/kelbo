// Mock server: rotte con parametri e *, ordine, chiamate senza rotta, ritardo, CORS e preflight,
// registro con body JSON e testo, porta occupata, rotta da una chiamata registrata, tool MCP
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { startServer } = require('../../../lib/testkit');
const { pathRegex, matchRoute } = require('../server');

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

test('percorsi: parametri, * e ordine delle rotte', () => {
  assert.ok(pathRegex('/users/:id').test('/users/42'));
  assert.ok(!pathRegex('/users/:id').test('/users/42/orders'));
  assert.ok(pathRegex('/api/*').test('/api/a/b/c'));
  assert.ok(pathRegex('/files/*.json').test('/files/x/y.json'));
  assert.ok(pathRegex('/a.b').test('/a.b') && !pathRegex('/a.b').test('/aXb'));
  const routes = [{ id: '1', method: 'GET', path: '/users/me' }, { id: '2', method: 'ANY', path: '/users/:id' }, { id: '3', method: 'GET', path: '*' }];
  assert.equal(matchRoute(routes, 'GET', '/users/me').id, '1');
  assert.equal(matchRoute(routes, 'DELETE', '/users/7').id, '2');
  assert.equal(matchRoute(routes, 'HEAD', '/x').id, '3');
  assert.equal(matchRoute(routes, 'POST', '/x'), null);
});

let srv, port;
before(async () => {
  srv = await startServer();
  port = await freePort(); // dopo l'avvio: la porta libera trovata prima poteva toccare a Kelbo
});
after(() => srv?.stop());

const call = (m, p, body) => srv.request(m, `/api/ext/mock-server${p}`, body !== undefined ? { body } : m === 'POST' ? { body: {} } : {});
const mockUrl = p => `http://127.0.0.1:${port}${p}`;

test('host di add-on: punto route-body (pulsanti accanto al corpo della risposta)', async () => {
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'mock-server');
  assert.deepEqual(ext.addonPoints.map(p => p.id), ['route-body']);
});
let id;

test('mock: creazione, validazione, avvio, rotte modificate a mock avviato', async () => {
  let r = await call('POST', '/mocks', { label: 'Pagamenti', port });
  assert.equal(r.status, 200, r.text);
  id = r.json.id;
  assert.equal(r.json.cors, true);
  assert.equal((await call('POST', '/mocks', { label: 'Altro', port })).json.code, 'mock-server.port_duplicate');
  assert.equal((await call('POST', '/mocks', { label: 'Altro', port: 70000 })).json.code, 'mock-server.mock_port');
  r = await call('POST', `/mocks/${id}/routes`, { method: 'GET', path: '/users/:id', status: 200, bodyType: 'json', body: '{"id": 1}', headers: [{ name: 'X-Mock', value: 'yes' }] });
  assert.equal(r.status, 200, r.text);
  const userRoute = r.json.id;
  assert.equal((await call('POST', `/mocks/${id}/routes`, { method: 'GET', path: 'no spaces allowed' })).json.code, 'mock-server.route_path');
  assert.equal((await call('POST', `/mocks/${id}/routes`, { method: 'GET', path: '/x', status: 99 })).json.code, 'mock-server.route_status');
  r = await call('POST', `/mocks/${id}/start`);
  assert.equal(r.json.running, true, r.text);
  let res = await fetch(mockUrl('/users/42'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-mock'), 'yes');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await res.json(), { id: 1 });
  // modificata mentre il mock è avviato: vale subito
  await call('PUT', `/mocks/${id}/routes/${userRoute}`, { status: 201, body: '{"id": 2}' });
  res = await fetch(mockUrl('/users/42'));
  assert.deepEqual([res.status, await res.json()], [201, { id: 2 }]);
  // ordine: una rotta * prima di /users/:id la sostituisce
  const any = (await call('POST', `/mocks/${id}/routes`, { method: 'ANY', path: '/*', status: 418, bodyType: 'text', body: 'teapot' })).json;
  assert.equal((await fetch(mockUrl('/users/1'))).status, 201);
  assert.equal((await call('PUT', `/mocks/${id}/order`, { ids: [any.id] })).json.code, 'mock-server.order_invalid');
  await call('PUT', `/mocks/${id}/order`, { ids: [any.id, userRoute] });
  res = await fetch(mockUrl('/users/1'));
  assert.deepEqual([res.status, await res.text()], [418, 'teapot']);
  await call('DELETE', `/mocks/${id}/routes/${any.id}`);
});

test('chiamata senza rotta, ritardo, CORS e preflight', async () => {
  let res = await fetch(mockUrl('/nope?x=1'), { method: 'POST' });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'no_mock_route', message: 'No route of this mock matches the request', method: 'POST', path: '/nope' });
  const slow = (await call('POST', `/mocks/${id}/routes`, { method: 'GET', path: '/slow', status: 200, bodyType: 'none', delayMs: 400 })).json;
  const t0 = Date.now();
  res = await fetch(mockUrl('/slow'));
  assert.ok(Date.now() - t0 >= 380, 'ritardo');
  assert.equal(await res.text(), '');
  await call('DELETE', `/mocks/${id}/routes/${slow.id}`);
  // CORS
  res = await fetch(mockUrl('/users/1'), { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  res = await fetch(mockUrl('/users/1'), { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,x-token' } });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('access-control-allow-methods'), /PUT/);
  assert.equal(res.headers.get('access-control-allow-headers'), 'content-type,x-token');
  // CORS disattivato: niente header e niente risposta automatica al preflight
  await call('PUT', `/mocks/${id}`, { cors: false });
  res = await fetch(mockUrl('/users/1'), { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('access-control-allow-origin'), null);
  await call('PUT', `/mocks/${id}`, { cors: true });
});

test('registro: body JSON, testo e binario, query e header, streaming', async () => {
  await call('DELETE', `/mocks/${id}/calls`);
  // streaming: le nuove chiamate arrivano come eventi
  const events = [];
  const ctrl = new AbortController();
  const stream = fetch(`http://127.0.0.1:${srv.port}/api/ext/mock-server/mocks/${id}/events`, { headers: { Host: `127.0.0.1:${srv.port}` }, signal: ctrl.signal })
    .then(async r => { for await (const chunk of r.body) events.push(Buffer.from(chunk).toString()); }).catch(() => {});
  await new Promise(r => setTimeout(r, 150));
  await fetch(mockUrl('/orders?status=new'), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer segreto', 'X-Api-Key': 'k-1' }, body: JSON.stringify({ items: [1, 2] }) });
  await fetch(mockUrl('/notes'), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'ciao' });
  await fetch(mockUrl('/upload'), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(100, 1) });
  await fetch(mockUrl('/users/5'));
  await new Promise(r => setTimeout(r, 150));
  ctrl.abort();
  await stream;
  const log = (await call('GET', `/mocks/${id}/calls`)).json.calls;
  assert.equal(log.length, 4);
  const [order, note, upload, user] = log;
  assert.deepEqual([order.method, order.path, order.query, order.route, order.status], ['POST', '/orders', [['status', 'new']], null, 404]);
  assert.deepEqual(order.body, { kind: 'json', size: 15, text: '{"items":[1,2]}' });
  assert.ok(order.headers.some(([k, v]) => k === 'Authorization' && v === 'Bearer segreto'), 'nella UI gli header restano interi');
  assert.deepEqual(note.body, { kind: 'text', size: 4, text: 'ciao', truncated: false });
  assert.deepEqual(upload.body, { kind: 'binary', size: 100, type: 'application/octet-stream' });
  assert.equal(user.status, 201);
  assert.ok(user.route);
  const streamed = events.join('').split('\n\n').filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5)));
  assert.deepEqual(streamed.filter(e => e.type === 'call').map(e => e.data.path), ['/orders', '/notes', '/upload', '/users/5']);
});

test('rotta creata da una chiamata registrata senza corrispondenza', async () => {
  const unmatched = (await call('GET', `/mocks/${id}/calls`)).json.calls.find(c => !c.route && c.path === '/orders');
  // la UI propone metodo e percorso della chiamata; si aggiunge la risposta
  const r = await call('POST', `/mocks/${id}/routes`, { method: unmatched.method, path: unmatched.path, status: 201, bodyType: 'json', body: '{"created":true}' });
  assert.equal(r.status, 200, r.text);
  const res = await fetch(mockUrl('/orders?status=new'), { method: 'POST', body: '{}' });
  assert.deepEqual([res.status, await res.json()], [201, { created: true }]);
});

test('MCP: chiamate con filtri e credenziali oscurate', async () => {
  const token = (await srv.request('GET', '/api/core/mcp')).json.token;
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const tools = (await client.listTools()).tools.map(x => x.name);
  assert.ok(tools.includes('mock_server_requests') && tools.includes('mock_server_list'));
  const list = (await client.callTool({ name: 'mock_server_list', arguments: {} })).structuredContent;
  assert.deepEqual(list.mocks.map(m => [m.id, m.running]), [[id, true]]);
  let r = (await client.callTool({ name: 'mock_server_requests', arguments: { mock: id, unmatched: true } })).structuredContent;
  assert.deepEqual(r.calls.map(c => c.path), ['/upload', '/notes', '/orders']);
  const order = r.calls.find(c => c.path === '/orders');
  assert.ok(order.headers.some(([k, v]) => k === 'Authorization' && v === '[redacted]'));
  assert.ok(order.headers.some(([k, v]) => k === 'X-Api-Key' && v === '[redacted]'));
  assert.doesNotMatch(JSON.stringify(r), /segreto|k-1/);
  r = (await client.callTool({ name: 'mock_server_requests', arguments: { mock: id, method: 'put', limit: 1 } })).structuredContent;
  assert.deepEqual([r.calls.length, r.calls[0].path], [1, '/notes']);
  r = (await client.callTool({ name: 'mock_server_requests', arguments: { mock: id, path: '/ord', limit: 1 } })).structuredContent;
  assert.deepEqual([r.total, r.truncated], [2, true]);
  const bad = await client.callTool({ name: 'mock_server_requests', arguments: { mock: 'nope' } });
  assert.equal(bad.isError, true);
  await client.close();
});

test('porta occupata con il proprietario, cambio porta a mock avviato, arresto', async () => {
  const busy = await freePort();
  const holder = net.createServer().listen(busy, '127.0.0.1');
  await new Promise(r => holder.on('listening', r));
  const other = (await call('POST', '/mocks', { label: 'Occupato', port: busy })).json;
  const r = await call('POST', `/mocks/${other.id}/start`);
  assert.equal(r.status, 409);
  assert.match(r.json.code, /^mock-server\.port_busy/);
  assert.equal(r.json.params.port, busy);
  holder.close();
  await call('DELETE', `/mocks/${other.id}`);
  // cambio porta: il mock riparte sulla nuova
  const next = await freePort();
  await call('PUT', `/mocks/${id}`, { port: next });
  assert.equal((await fetch(`http://127.0.0.1:${next}/users/1`)).status, 201);
  await assert.rejects(fetch(mockUrl('/users/1')));
  port = next;
  await call('POST', `/mocks/${id}/stop`);
  await assert.rejects(fetch(mockUrl('/users/1')));
  assert.equal((await call('GET', '/mocks')).json[0].running, false);
  // il registro resta dopo l'arresto, fino allo svuotamento
  assert.ok((await call('GET', `/mocks/${id}/calls`)).json.calls.length > 0);
  await call('DELETE', `/mocks/${id}/calls`);
  assert.equal((await call('GET', `/mocks/${id}/calls`)).json.calls.length, 0);
});

test('i mock avviati si fermano con Kelbo', async () => {
  await call('POST', `/mocks/${id}/start`);
  assert.equal((await fetch(mockUrl('/users/1'))).status, 201);
  await srv.stop();
  await assert.rejects(fetch(mockUrl('/users/1')));
  srv = null;
});
