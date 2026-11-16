// Client HTTP: sezioni, variabili, invio dal backend con timeout, rotte Express trovate nel
// codice, autorizzazione per tipologia di utenza (basic, token incollato, login, OAuth) e
// azioni dopo il token, contro un server di prova e un provider OAuth finto
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { startServer, tmpDir } = require('../../../lib/testkit');
const { discover, stripComments } = require('../discover');
const { jwtExpiry } = require('../auth');
const vaultLib = require('../../../lib/vault-crypto');

const freePort = () => new Promise(resolve => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const jwt = (payload) => {
  const part = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.x`;
};

// ---- server di prova: eco, lentezza, login, risorsa protetta, provider OAuth ----

let lastTokenForm = null; // ultima richiesta all'endpoint del token (finto)
let api, apiUrl, logins = 0, codes = new Map(), refreshCalls = 0;
function startApi() {
  api = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const u = new URL(req.url, 'http://x');
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
    switch (u.pathname.startsWith('/echo') ? '/echo' : u.pathname) {
      case '/echo': return json(200, { method: req.method, url: req.url, headers: req.headers, body });
      case '/slow': return setTimeout(() => json(200, { ok: true }), 3000);
      case '/text': res.writeHead(201, { 'Content-Type': 'text/plain', 'X-Custom': 'yes' }); return res.end('ciao');
      case '/binary': res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(Buffer.alloc(300, 1));
      case '/big': res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('x'.repeat(6 * 1024 * 1024));
      case '/login': {
        const b = JSON.parse(body || '{}');
        if (b.username !== 'mario' || b.password !== 'pa"ss') return json(401, { error: 'bad' });
        logins++;
        return json(200, { data: { token: `login-${logins}`, ttl: 3600 } });
      }
      case '/me': return bearer ? json(200, { user: bearer }) : json(401, { error: 'no token' });
      case '/tenant': return bearer ? json(200, { tenant: 't-42' }, { 'X-Csrf': 'csrf-1' }) : json(401, {});
      case '/exchange': return json(200, { second: `second-for-${bearer}` });
      // provider OAuth / OIDC
      case '/realm/.well-known/openid-configuration':
        return json(200, { issuer: `${apiUrl}/realm`, authorization_endpoint: `${apiUrl}/realm/auth`, token_endpoint: `${apiUrl}/realm/token`, code_challenge_methods_supported: ['S256'] });
      case '/realm/auth': {
        const p = u.searchParams;
        const redirect = new URL(p.get('redirect_uri'));
        if (p.get('response_type') === 'token') {
          res.writeHead(302, { Location: `${redirect}#access_token=implicit-token&token_type=bearer&expires_in=600&state=${p.get('state')}` });
          return res.end();
        }
        const code = crypto.randomBytes(6).toString('hex');
        codes.set(code, { challenge: p.get('code_challenge'), clientId: p.get('client_id') });
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', p.get('state'));
        res.writeHead(302, { Location: redirect.toString() });
        return res.end();
      }
      case '/realm/token': {
        const p = new URLSearchParams(body);
        if (p.get('grant_type') === 'refresh_token') {
          refreshCalls++;
          return p.get('refresh_token') === 'refresh-1' ? json(200, { access_token: 'refreshed-token', expires_in: 600 }) : json(400, { error: 'invalid_grant' });
        }
        const c = codes.get(p.get('code'));
        lastTokenForm = p;
        if (!c) return json(400, { error: 'invalid_grant' });
        if (c.challenge) {
          const expected = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url');
          if (expected !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' });
        } else if (p.get('client_secret') !== 'secret-xyz') return json(401, { error: 'invalid_client' });
        // token già scaduto: la richiesta successiva deve usare il refresh token
        return json(200, { access_token: jwt({ sub: 'oauth', exp: Math.floor(Date.now() / 1000) + 3600 }), expires_in: 3600, refresh_token: 'refresh-1' });
      }
      default: return json(404, { error: 'not found' });
    }
  });
  return new Promise(resolve => api.listen(0, '127.0.0.1', () => { apiUrl = `http://127.0.0.1:${api.address().port}`; resolve(); }));
}

// GET seguendo i redirect (il "browser" del login OAuth)
async function browse(url, hops = 5) {
  for (let i = 0; i < hops; i++) {
    const res = await fetch(url, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) { url = new URL(res.headers.get('location'), url).toString(); continue; }
    return { status: res.status, text: await res.text(), url };
  }
  throw new Error('troppi redirect');
}

// ---- progetto Express su più file ----

function writeProject(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const EXPRESS_APP = {
  'package.json': JSON.stringify({ name: 'fx', scripts: { start: 'node src/server.js' } }),
  '.env': 'NODE_ENV=dev\nPORT=4123\n',
  'src/server.js': `const express = require('express');
const config = require('./config');
const { API } = require('./constants');
const users = require('./routes/users');
const app = express();
app.use(express.json());
// app.get('/commented', h)
/* app.post('/also-commented', h) */
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('env');
app.use(API, users);
app.use(\`\${API}/v2\`, require('./api'));
app.use(config.prefix, require('./routes/admin'));
app.use('/files', require('./routes/files')(config));
require('./routes/legacy')(app);
require('./auto')(app);
app.listen(3000);
`,
  'src/constants.js': "const BASE = '/api';\nmodule.exports = { API: BASE };\n",
  'src/config.js': 'module.exports = { prefix: process.env.PREFIX };\n',
  'src/routes/users.js': `const { Router } = require('express');
const router = Router();
const USERS = '/users';
router.get(USERS, list);
router.post(USERS + '/:id', h);
router.route('/me').get(a).put(b);
const s = "router.get('/in-a-string', h)";
module.exports = router;
`,
  'src/routes/admin.js': "const express = require('express');\nconst r = express.Router();\nr.delete('/cache', h);\nmodule.exports = r;\n",
  'src/routes/files.js': "const { Router } = require('express');\nmodule.exports = (config) => {\n  const router = Router();\n  router.get('/:name', h);\n  return router;\n};\n",
  'src/routes/legacy.js': "module.exports = function (app) {\n  app.get('/old', h);\n};\n",
  'src/api/index.ts': "import { Router } from 'express';\nimport orders from './orders.js';\nconst router: Router = Router();\nrouter.use('/orders', orders);\nexport default router;\n",
  'src/api/orders.ts': "import { Router, Request } from 'express';\nconst router = Router();\nrouter.patch('/:id', (req: Request, res) => res.send('x'));\nexport default router;\n",
  'src/auto/index.js': "const fs = require('fs');\nmodule.exports = app => fs.readdirSync(__dirname).forEach(f => app.use('/' + f, require('./' + f)));\n",
  'src/auto/things.js': "const router = require('express').Router();\nrouter.get('/list', h);\nmodule.exports = router;\n",
  'tests/app.test.js': "const app = require('express')();\napp.get('/only-in-tests', h);\n",
};

test('rotte Express: prefissi composti tra file, costanti, TS, factory, parti da completare', () => {
  const root = writeProject(tmpDir(), EXPRESS_APP);
  const r = discover(root);
  assert.deepEqual(r.entry, { file: 'src/server.js', from: 'start' });
  const list = r.routes.map(x => `${x.method} ${x.path}${x.complete ? '' : ' ?'}`).sort();
  assert.deepEqual(list, [
    'DELETE /«config.prefix»/cache ?',
    'GET /«?»/list ?',
    'GET /api/me',
    'GET /api/users',
    'GET /files/:name',
    'GET /health',
    'GET /old',
    'PATCH /api/v2/orders/:id',
    'POST /api/users/:id',
    'PUT /api/me',
  ].sort());
  assert.deepEqual(r.autoloaders, ['src/auto/index.js']);
  const cache = r.routes.find(x => x.path.endsWith('/cache'));
  assert.deepEqual([cache.file, cache.line, cache.unresolved], ['src/routes/admin.js', 3, ['config.prefix']]);
  // main di package.json, import ESM con estensione
  const esm = writeProject(tmpDir(), {
    'package.json': JSON.stringify({ main: 'app.mjs' }),
    'app.mjs': "import express from 'express';\nimport * as routes from './routes.mjs';\nconst app = express();\napp.use('/v1', routes.api);\n",
    'routes.mjs': "import { Router } from 'express';\nexport const PREFIX = '/items';\nexport const api = Router();\napi.get(PREFIX, h);\napi.post(`${PREFIX}/:id/tags`, h);\n",
  });
  assert.deepEqual(discover(esm).routes.map(x => `${x.method} ${x.path}`), ['GET /v1/items', 'POST /v1/items/:id/tags']);
  assert.equal(stripComments("a // b\n'//c' /* d\ne */ f").split('\n').length, 3);
});

test('scadenza dai JWT', () => {
  assert.equal(jwtExpiry(jwt({ exp: 2000000000 })), 2000000000 * 1000);
  assert.equal(jwtExpiry('opaco'), null);
});

let srv, project, redirectPort;
before(async () => {
  await startApi();
  project = writeProject(path.join(tmpDir(), 'app'), EXPRESS_APP);
  redirectPort = await freePort();
  srv = await startServer({ groups: [], servers: [], projects: [{ id: 'app', label: 'App', path: project }] }, { env: { DEVDOCK_NO_BROWSER: '1' } });
});
after(async () => { await srv?.stop(); api?.close(); });

const call = (m, p, body) => srv.request(m, `/api/ext/http-client${p}`, body !== undefined ? { body } : {});

let sectionId;
test('sezioni e richieste: URL di base dal .env, variabili, validazione, export', async () => {
  let r = await call('GET', '/base-url?project=app');
  assert.deepEqual(r.json, { port: 4123, source: '.env', baseUrl: 'http://localhost:4123' });
  r = await call('POST', '/sections', { label: 'API', projectId: 'app', baseUrl: apiUrl, variables: [{ name: 'version', value: 'v1' }, { name: 'q', value: 'a b&c' }] });
  assert.equal(r.status, 200, r.text);
  sectionId = r.json.id;
  assert.equal((await call('POST', '/sections', { label: 'X', variables: [{ name: 'baseUrl', value: 'x' }] })).json.code, 'http-client.section_variable');
  assert.equal((await call('POST', '/sections', { label: 'X', projectId: 'nessuno' })).status, 400);
  r = await call('POST', `/sections/${sectionId}/requests`, { label: 'Eco', method: 'POST', url: '{{baseUrl}}/echo/{{version}}', query: [{ name: 'q', value: '{{q}}' }, { name: 'off', value: '1', enabled: false }], headers: [{ name: 'X-Version', value: '{{ version }}' }], bodyType: 'json', body: '{"v":"{{version}}"}' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await call('POST', `/sections/${sectionId}/requests`, { label: 'X', method: 'FETCH' })).json.code, 'http-client.request_method');
  const list = (await call('GET', '/sections')).json;
  assert.equal(list[0].requests[0].url, '{{baseUrl}}/echo/{{version}}');
  const exp = await srv.request('GET', '/api/core/config/export?sections=httpSections');
  assert.equal(JSON.parse(exp.text).httpSections[0].label, 'API');
});

test('invio dal backend: metodo, header, query, body, variabili; risposta con stato, tempo e header', async () => {
  const req = (await call('GET', '/sections')).json[0].requests[0];
  let r = await call('POST', '/send', { section: sectionId, request: req });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 200, r.json.body);
  assert.equal(r.json.json, true);
  const echo = JSON.parse(r.json.body);
  assert.equal(echo.method, 'POST');
  assert.equal(echo.url, '/echo/v1?q=a+b%26c');
  assert.equal(echo.headers['x-version'], 'v1');
  assert.equal(echo.headers['content-type'], 'application/json');
  assert.equal(echo.body, '{"v":"v1"}');
  assert.ok(r.json.ms >= 0 && r.json.size > 0);
  // testo, header della risposta, binario, risposta troppo grande
  r = await call('POST', '/send', { section: sectionId, request: { method: 'GET', url: '{{baseUrl}}/text' } });
  assert.deepEqual([r.json.status, r.json.body, r.json.binary], [201, 'ciao', false]);
  assert.ok(r.json.headers.some(([k, v]) => k === 'X-Custom' && v === 'yes'));
  r = await call('POST', '/send', { section: sectionId, request: { method: 'GET', url: '{{baseUrl}}/binary' } });
  assert.deepEqual([r.json.binary, r.json.body, r.json.size], [true, null, 300]);
  r = await call('POST', '/send', { section: sectionId, request: { method: 'GET', url: '{{baseUrl}}/big' } });
  assert.equal(r.json.truncated, true);
  assert.equal(r.json.body.length, 5 * 1024 * 1024);
  // errori: variabile sconosciuta, URL non http, timeout, server che non risponde
  r = await call('POST', '/send', { section: sectionId, request: { method: 'GET', url: '{{baseUrl}}/{{nope}}' } });
  assert.deepEqual([r.status, r.json.code, r.json.params.name], [400, 'http-client.variable_unknown', 'nope']);
  r = await call('POST', '/send', { section: sectionId, request: { method: 'GET', url: 'file:///etc/passwd' } });
  assert.equal(r.json.code, 'http-client.url_protocol');
  r = await call('POST', '/send', { section: sectionId, request: { method: 'GET', url: '{{baseUrl}}/slow' }, timeoutMs: 1000 });
  assert.deepEqual([r.status, r.json.code], [504, 'http-client.timeout']);
  r = await call('POST', '/send', { section: sectionId, request: { method: 'GET', url: `http://127.0.0.1:${await freePort()}/` } });
  assert.deepEqual([r.status, r.json.code], [502, 'http-client.network']);
});

test('rotte del progetto collegato', async () => {
  const r = await call('GET', `/sections/${sectionId}/routes`);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.routes.some(x => x.method === 'PATCH' && x.path === '/api/v2/orders/:id'));
  const other = (await call('POST', '/sections', { label: 'Senza progetto' })).json;
  assert.equal((await call('GET', `/sections/${other.id}/routes`)).json.code, 'http-client.section_no_project');
  await call('DELETE', `/sections/${other.id}`);
});

// ---- autorizzazione ----

const userBase = uid => `/sections/${sectionId}/users${uid ? `/${uid}` : ''}`;
const sendAs = (userType, url = '{{baseUrl}}/me') => call('POST', '/send', { section: sectionId, request: { method: 'GET', url, userType } });
const state = async uid => (await call('GET', `/sections/${sectionId}/auth`)).json.users.find(u => u.id === uid);

test('nessuna autorizzazione e token incollato con scadenza', async () => {
  // utenze e token solo con la master password, anche senza segreti
  let r0 = await call('POST', userBase(), { label: 'Anonimo', auth: { type: 'none' } });
  assert.deepEqual([r0.status, r0.json.code], [423, 'core.vault_missing']);
  await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-1' } });
  const none = (await call('POST', userBase(), { label: 'Anonimo', auth: { type: 'none' } })).json;
  let r = await sendAs(none.id);
  assert.equal(r.json.status, 401);
  const manual = (await call('POST', userBase(), { label: 'Incollato', auth: { type: 'manual' }, header: 'Authorization', format: 'Bearer {token}' })).json;
  r = await sendAs(manual.id);
  assert.deepEqual([r.status, r.json.code], [409, 'http-client.token_missing']);
  r = await call('POST', `${userBase(manual.id)}/token`, { token: 'pasted-1' });
  assert.equal(r.json.hasToken, true);
  r = await sendAs(manual.id);
  assert.equal(JSON.parse(r.json.body).user, 'pasted-1');
  // scadenza manuale passata, poi JWT con exp passato
  await call('POST', `${userBase(manual.id)}/token`, { token: 'pasted-2', expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await sendAs(manual.id)).json.code, 'http-client.token_expired');
  await call('POST', `${userBase(manual.id)}/token`, { token: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }) });
  assert.equal((await state(manual.id)).expired, true);
  await call('DELETE', `${userBase(manual.id)}/token`);
  assert.equal((await state(manual.id)).hasToken, false);
  // formato e header personalizzati
  await call('PUT', userBase(manual.id), { label: 'Incollato', auth: { type: 'manual' }, header: 'X-Api-Key', format: 'Key {token}' });
  await call('POST', `${userBase(manual.id)}/token`, { token: 'k1' });
  r = await sendAs(manual.id, '{{baseUrl}}/echo');
  assert.equal(JSON.parse(r.json.body).headers['x-api-key'], 'Key k1');
  // vault bloccato: i token in memoria vengono dimenticati e non se ne incollano altri
  await srv.request('POST', '/api/core/vault/lock', { body: {} });
  assert.equal((await state(manual.id)).hasToken, false);
  r = await call('POST', `${userBase(manual.id)}/token`, { token: 'k2' });
  assert.deepEqual([r.status, r.json.code], [423, 'core.vault_locked']);
  await srv.request('POST', '/api/core/vault/unlock', { body: { password: 'master-password-1' } });
});

test('segreti: senza master password rifiutati, poi cifrati e mai in chiaro nel config', async () => {
  await srv.request('POST', '/api/core/vault/lock', { body: {} });
  let r = await call('POST', userBase(), { label: 'Basic', auth: { type: 'basic', username: 'mario', password: 'pw-segreta' } });
  assert.deepEqual([r.status, r.json.code], [423, 'core.vault_locked']);
  await srv.request('POST', '/api/core/vault/unlock', { body: { password: 'master-password-1' } });
  r = await call('POST', userBase(), { label: 'Basic', auth: { type: 'basic', username: 'mario', password: 'pw-segreta' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.auth.hasPassword, true);
  assert.equal(r.json.auth.password, undefined);
  const basicId = r.json.id;
  r = await sendAs(basicId, '{{baseUrl}}/echo');
  assert.equal(JSON.parse(r.json.body).headers.authorization, `Basic ${Buffer.from('mario:pw-segreta').toString('base64')}`);
  // modifica senza password: resta quella salvata
  await call('PUT', userBase(basicId), { label: 'Basic 2', auth: { type: 'basic', username: 'mario' } });
  r = await sendAs(basicId, '{{baseUrl}}/echo');
  assert.equal(JSON.parse(r.json.body).headers.authorization, `Basic ${Buffer.from('mario:pw-segreta').toString('base64')}`);
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /pw-segreta/);
  // vault bloccato: 423 con il codice del core
  await srv.request('POST', '/api/core/vault/lock', { body: {} });
  r = await sendAs(basicId, '{{baseUrl}}/echo');
  assert.deepEqual([r.status, r.json.code], [423, 'core.vault_locked']);
  await srv.request('POST', '/api/core/vault/unlock', { body: { password: 'master-password-1' } });
});

let loginId;
test('token da una richiesta di login: credenziali con escape, percorso del token, riuso e scadenza', async () => {
  let r = await call('POST', userBase(), {
    label: 'Login', auth: { type: 'login', method: 'POST', url: '{{baseUrl}}/login', contentType: 'json',
      body: '{"username":"{{username}}","password":"{{password}}"}', username: 'mario', password: 'pa"ss', tokenPath: 'data.token', expiresPath: 'data.ttl' },
  });
  assert.equal(r.status, 200, r.text);
  loginId = r.json.id;
  const before = logins;
  r = await sendAs(loginId);
  assert.equal(JSON.parse(r.json.body).user, `login-${before + 1}`);
  r = await sendAs(loginId);
  assert.equal(logins, before + 1, 'token riusato finché valido');
  const st = await state(loginId);
  assert.ok(Date.parse(st.expiresAt) > Date.now() + 3500 * 1000);
  // percorso sbagliato
  await call('PUT', userBase(loginId), { label: 'Login', auth: { type: 'login', method: 'POST', url: '{{baseUrl}}/login', contentType: 'json', body: '{"username":"{{username}}","password":"{{password}}"}', username: 'mario', tokenPath: 'data.nope' } });
  r = await sendAs(loginId);
  assert.equal(r.json.code, 'http-client.login_no_token');
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /pa\\"ss|login-\d/);
});

test('azioni dopo il token: variabili estratte e secondo token', async () => {
  await call('PUT', userBase(loginId), {
    label: 'Login', auth: { type: 'login', method: 'POST', url: '{{baseUrl}}/login', contentType: 'json', body: '{"username":"{{username}}","password":"{{password}}"}', username: 'mario', tokenPath: 'data.token' },
    afterToken: [
      { method: 'GET', url: '{{baseUrl}}/tenant', extract: [{ name: 'tenant', from: 'tenant' }, { name: 'csrf', from: 'header:X-Csrf' }] },
      { method: 'POST', url: '{{baseUrl}}/exchange', bodyType: 'json', body: '{"tenant":"{{tenant}}"}', extract: [{ name: 'token', from: 'second' }] },
    ],
  });
  let r = await sendAs(loginId, '{{baseUrl}}/echo?t={{tenant}}&c={{csrf}}');
  assert.equal(r.status, 200, r.text);
  const echo = JSON.parse(r.json.body);
  assert.equal(echo.url, '/echo?t=t-42&c=csrf-1');
  assert.match(echo.headers.authorization, /^Bearer second-for-login-\d+$/);
  assert.deepEqual((await state(loginId)).vars, ['tenant', 'csrf']);
  // un'azione che fallisce: niente token
  await call('PUT', userBase(loginId), {
    label: 'Login', auth: { type: 'login', method: 'POST', url: '{{baseUrl}}/login', contentType: 'json', body: '{"username":"{{username}}","password":"{{password}}"}', username: 'mario', tokenPath: 'data.token' },
    afterToken: [{ method: 'GET', url: '{{baseUrl}}/tenant', extract: [{ name: 'x', from: 'missing.path' }] }],
  });
  r = await sendAs(loginId);
  assert.equal(r.json.code, 'http-client.after_token_extract');
  assert.equal((await state(loginId)).hasToken, false);
  assert.equal((await call('PUT', userBase(loginId), { label: 'Login', auth: { type: 'manual' }, afterToken: [{ method: 'GET', url: 'x', extract: [{ name: 'baseUrl', from: 'a' }] }] })).json.code, 'http-client.user_after_token');
});

test('OAuth: PKCE con login nel browser che sblocca la richiesta in attesa, refresh token, implicit, client secret', async () => {
  let r = await call('POST', '/oidc-discovery', { issuer: `${apiUrl}/realm` });
  assert.equal(r.json.tokenEndpoint, `${apiUrl}/realm/token`);
  r = await call('POST', userBase(), {
    label: 'Keycloak', auth: { type: 'oauth', issuer: `${apiUrl}/realm`, clientId: 'devdock', scope: 'openid', flow: 'pkce', redirectUri: `http://127.0.0.1:${redirectPort}/cb`, container: 'Lavoro' },
  });
  assert.equal(r.status, 200, r.text);
  const oid = r.json.id;
  // la richiesta resta in attesa del login; il "browser" segue l'URL di autorizzazione
  const pending = sendAs(oid);
  let st;
  for (let i = 0; i < 50 && !(st = await state(oid)).pendingLogin; i++) await new Promise(res => setTimeout(res, 50));
  assert.match(st.pendingLogin, /code_challenge_method=S256/);
  const page = await browse(st.pendingLogin);
  assert.equal(page.status, 200);
  assert.match(page.text, /Keycloak/);
  r = await pending;
  assert.equal(r.status, 200, r.text);
  assert.match(JSON.parse(r.json.body).user, /^[\w-]+\.[\w-]+\.x$/);
  assert.equal((await state(oid)).refreshable, true);
  // il listener del redirect è chiuso dopo il login
  await assert.rejects(fetch(`http://127.0.0.1:${redirectPort}/cb`));
  // login di nuovo: prima il refresh token, senza browser
  r = await call('POST', `${userBase(oid)}/login`, {});
  assert.equal(r.json.pendingLogin, null);
  assert.equal(refreshCalls, 1);
  assert.equal(JSON.parse((await sendAs(oid)).json.body).user, 'refreshed-token');

  // implicit: il token arriva nel frammento e la pagina lo rimanda
  r = await call('PUT', userBase(oid), { label: 'Implicit', auth: { type: 'oauth', issuer: `${apiUrl}/realm`, clientId: 'devdock', flow: 'implicit', redirectUri: `http://localhost:${redirectPort}/cb` } });
  r = await call('POST', `${userBase(oid)}/login`, {});
  assert.match(r.json.pendingLogin, /response_type=token/);
  const cb = await browse(r.json.pendingLogin);
  assert.match(cb.text, /location\.hash/);
  const hash = new URL(cb.url).hash.slice(1);
  const done = await fetch(`http://127.0.0.1:${redirectPort}/cb`, { method: 'POST', body: hash });
  assert.equal(done.status, 200);
  assert.equal(JSON.parse((await sendAs(oid)).json.body).user, 'implicit-token');

  // authorization code con client secret cifrato
  r = await call('PUT', userBase(oid), { label: 'Secret', auth: { type: 'oauth', authorizationEndpoint: `${apiUrl}/realm/auth`, tokenEndpoint: `${apiUrl}/realm/token`, clientId: 'devdock', flow: 'code', clientSecret: 'secret-xyz', redirectUri: `http://127.0.0.1:${redirectPort}/cb` } });
  assert.equal(r.json.auth.hasClientSecret, true);
  r = await call('POST', `${userBase(oid)}/login`, {});
  await browse(r.json.pendingLogin);
  assert.equal((await state(oid)).hasToken, true);
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /secret-xyz|refresh-1|implicit-token/);

  // PKCE con client secret (client "confidential" di Keycloak): inviati entrambi
  r = await call('PUT', userBase(oid), { label: 'Secret', auth: { type: 'oauth', authorizationEndpoint: `${apiUrl}/realm/auth`, tokenEndpoint: `${apiUrl}/realm/token`, clientId: 'devdock', flow: 'pkce', redirectUri: `http://127.0.0.1:${redirectPort}/cb` } });
  assert.equal(r.json.auth.hasClientSecret, true); // il secret salvato resta
  await call('DELETE', `${userBase(oid)}/token`);
  r = await call('POST', `${userBase(oid)}/login`, {});
  await browse(r.json.pendingLogin);
  assert.equal((await state(oid)).hasToken, true);
  assert.equal(lastTokenForm.get('client_secret'), 'secret-xyz');
  assert.ok(lastTokenForm.get('code_verifier'));

  // porta del redirect occupata
  const busy = net.createServer().listen(redirectPort, '127.0.0.1');
  await new Promise(res => busy.on('listening', res));
  await call('DELETE', `${userBase(oid)}/token`);
  r = await call('POST', `${userBase(oid)}/login`, {});
  assert.deepEqual([r.status, r.json.code], [409, 'http-client.oauth_port_busy']);
  busy.close();
});

test('cambio della master password: i segreti delle utenze vengono ri-cifrati; reset: cancellati', async () => {
  let r = await srv.request('POST', '/api/core/vault/change', { body: { oldPassword: 'master-password-1', newPassword: 'nuova-master-2' } });
  assert.equal(r.status, 200, r.text + srv.output());
  const cfg = srv.readConfig();
  const key = await vaultLib.openVault(cfg.vault, 'nuova-master-2');
  const basic = cfg.httpSections[0].userTypes.find(u => u.auth.type === 'basic');
  assert.equal(vaultLib.decrypt(key, basic.auth.password), 'pw-segreta');
  r = await srv.request('POST', '/api/core/vault/reset', { body: { confirm: 'RESET' } });
  assert.equal(r.status, 200);
  const after = srv.readConfig().httpSections[0].userTypes;
  assert.ok(after.every(u => !u.auth.password && !u.auth.clientSecret));
});

test('eliminazione di una tipologia: le richieste restano senza autorizzazione', async () => {
  const s = (await call('GET', '/sections')).json.find(x => x.id === sectionId);
  const uid = s.userTypes[0].id;
  const req = (await call('POST', `/sections/${sectionId}/requests`, { label: 'Con utenza', method: 'GET', url: '{{baseUrl}}/me', userType: uid })).json;
  assert.equal(req.userType, uid);
  await call('DELETE', userBase(uid));
  const after = (await call('GET', '/sections')).json.find(x => x.id === sectionId);
  assert.equal(after.requests.find(r => r.id === req.id).userType, undefined);
});

test('host di add-on: punto response-actions (pulsanti sulla risposta)', async () => {
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'http-client');
  assert.deepEqual(ext.addonPoints.map(p => p.id), ['response-actions']);
});
