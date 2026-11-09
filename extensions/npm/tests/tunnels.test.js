// Tunnel SSH collegati ai progetti npm: salvataggio validato, avvio prima dello script (un tunnel
// che non parte non blocca lo script), casella di export, collegamenti nel pannello Progetti
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const path = require('path');
const { startServer, tmpDir, makeRepo, freePort } = require('../../../lib/testkit');

let srv, listener, busyPort, freeP;
before(async () => {
  // porta già in ascolto: il tunnel risulta subito pronto, senza ssh verso un server vero
  busyPort = await freePort();
  listener = net.createServer(s => s.end()).listen(busyPort, '127.0.0.1');
  freeP = await freePort();
  const repo = makeRepo(path.join(tmpDir(), 'app'), { scripts: { hello: 'node -e "console.log(\'ciao\')"' } });
  srv = await startServer({
    projects: [{ id: 'app', label: 'App', path: repo }],
    groups: [],
    servers: [
      { key: 'db', label: 'Database', port: busyPort, remote: 'db.internal:5432', alias: 'bastion.example.invalid' },
      { key: 'cache', label: 'Cache', port: freeP, remote: 'redis.internal:6379', alias: 'nowhere.example.invalid' },
    ],
  });
});
after(async () => { listener?.close(); await srv?.stop(); });

const api = (m, p, body) => srv.request(m, `/api/ext/npm${p}`, body !== undefined ? { body } : {});

async function outputOf(id) {
  let r;
  for (let i = 0; i < 100; i++) {
    r = (await api('GET', `/processes/${id}/logs`)).json;
    if (!r.running && /\[exit/.test(r.logs.map(l => l.text).join(''))) break;
    await new Promise(res => setTimeout(res, 100));
  }
  return r.logs.map(l => l.text).join('');
}

test('tunnel del progetto: lettura, salvataggio, validazione', async () => {
  assert.deepEqual((await api('GET', '/projects/app/tunnels')).json, { tunnels: [], available: true });
  for (const tunnels of [undefined, 'db', [1], ['Db!']]) {
    const r = await api('PUT', '/projects/app/tunnels', { tunnels });
    assert.equal(r.status, 400, JSON.stringify(tunnels));
  }
  assert.equal((await api('PUT', '/projects/app/tunnels', { tunnels: ['nope'] })).json.code, 'npm.tunnel_unknown');
  assert.equal((await api('PUT', '/projects/nope/tunnels', { tunnels: [] })).status, 404);
  const r = await api('PUT', '/projects/app/tunnels', { tunnels: ['db', 'db'] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.tunnels, ['db']);
  assert.deepEqual(srv.readConfig().npmTunnels, { app: ['db'] });
  // export e import: la sezione è dell'estensione, validata
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'npm');
  assert.deepEqual(ext.export.map(x => x.sections), [['npmTunnels']]);
  const bad = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { npmTunnels: { app: ['db', 'db'] } } } });
  assert.equal(bad.status, 400);
  // collegamento mostrato nel pannello Progetti
  const links = (await srv.request('GET', '/api/core/projects/app/links')).json;
  assert.ok(JSON.stringify(links).includes('links.tunnels'), JSON.stringify(links));
});

test('i tunnel partono prima dello script; uno che non parte non lo blocca', async () => {
  await api('PUT', '/projects/app/tunnels', { tunnels: ['db', 'cache'] });
  const r = await api('POST', '/projects/app/run', { script: 'hello' });
  assert.equal(r.status, 200, r.text);
  const out = await outputOf(r.json.id);
  assert.match(out, new RegExp(`\\$ tunnel Database → 127\\.0\\.0\\.1:${busyPort}`));
  assert.match(out, /! tunnel Cache: /);
  assert.ok(out.indexOf('tunnel Database') < out.indexOf('$ npm run hello'), out);
  assert.match(out, /ciao/);
  // senza tunnel: nessuna riga in più
  await api('PUT', '/projects/app/tunnels', { tunnels: [] });
  assert.deepEqual(srv.readConfig().npmTunnels, {});
  const r2 = await api('POST', '/projects/app/run', { script: 'hello' });
  assert.doesNotMatch(await outputOf(r2.json.id), /tunnel/);
});
