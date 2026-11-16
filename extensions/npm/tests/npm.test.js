const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, makeRepo } = require('../../../lib/testkit');

let srv, projectDir;
before(async () => {
  projectDir = makeRepo(path.join(tmpDir(), 'app'), {
    scripts: { hello: 'echo ciao-devdock', serve: 'node -e "setTimeout(()=>{},30000)"' },
    dependencies: { 'left-pad': '1.0.0' },
  });
  srv = await startServer({ groups: [], servers: [], projects: [{ id: 'app', label: 'App', path: projectDir }] });
});
after(() => srv.stop());

const start = script => srv.request('POST', '/api/ext/npm/projects/app/run', { body: { script } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('package.json del progetto', async () => {
  const r = await srv.request('GET', '/api/ext/npm/projects/app/package');
  assert.deepEqual(Object.keys(r.json.scripts), ['hello', 'serve']);
});

test('solo script definiti in package.json', async () => {
  for (const script of ['--foo', 'constructor', 'hello; rm -rf /', '']) {
    assert.equal((await start(script)).status, 400, `atteso 400 per ${JSON.stringify(script)}`);
  }
});

test('esecuzione di uno script con log ed exit code', async () => {
  const r = await start('hello');
  assert.equal(r.status, 200);
  let logs;
  for (let i = 0; i < 50; i++) {
    logs = (await srv.request('GET', `/api/ext/npm/processes/${r.json.id}/logs`)).json;
    if (!logs.running) break;
    await sleep(100);
  }
  assert.equal(logs.exitCode, 0);
  assert.match(logs.logs.map(l => l.text).join(''), /ciao-devdock/);

  // stream SSE di un processo terminato: storico + exit
  const stream = await srv.request('GET', `/api/ext/npm/processes/${r.json.id}/stream`);
  assert.equal(stream.events[0].type, 'history');
  assert.match(stream.events[0].data, /ciao-devdock/);
  assert.equal(stream.events.at(-1).type, 'exit');
  assert.equal((await srv.request('DELETE', `/api/ext/npm/processes/${r.json.id}/dismiss`)).status, 200);
});

test('il riavvio non segna come terminato il processo nuovo', async () => {
  const { json } = await start('serve');
  await sleep(500);
  assert.equal((await srv.request('POST', `/api/ext/npm/processes/${json.id}/restart`, { body: {} })).status, 200);
  await sleep(800);
  const list = (await srv.request('GET', '/api/ext/npm/processes')).json;
  assert.equal(list.find(p => p.id === json.id).running, true);
  assert.equal((await srv.request('DELETE', `/api/ext/npm/processes/${json.id}`)).status, 200);
});

test('npm update solo per pacchetti dichiarati', async () => {
  for (const pkg of ['--global', 'express', '../x']) {
    const r = await srv.request('POST', '/api/ext/npm/projects/app/update', { body: { package: pkg } });
    assert.equal(r.status, 400, `atteso 400 per ${pkg}`);
  }
});

test('installed-versions ignora nomi non validi', async () => {
  const r = await srv.request('POST', '/api/ext/npm/projects/app/installed-versions', { body: { packages: ['../../../../etc', 'left-pad'] } });
  assert.deepEqual(r.json, { 'left-pad': null });
});

test('host di add-on: punto script-actions (pulsanti sulla riga di uno script)', async () => {
  const npm = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'npm');
  assert.deepEqual(npm.addonPoints.map(p => p.id), ['script-actions']);
  const [major, minor] = npm.version.split('.').map(Number);
  assert.ok(major === 1 && minor >= 1, npm.version);
});
