// Trasporti dei tunnel (capacità tunnel-transport, M9): un'estensione finta che apre un vero
// server TCP sulla porta locale. Elenco dei trasporti, campi che dipendono dai valori, server
// salvati con i parametri validati dal provider, avvio e "pronto", uscita e riconnessione,
// ensureTunnel per le altre estensioni, trasporto spento mentre il tunnel gira, non installato.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, manifest, writeExtension } = require('../../../lib/testkit');

const EXT = path.join(__dirname, '..', '..');
let srv;
const api = (m, p, body) => srv.request(m, `/api/ext/tunnels${p}`, body !== undefined ? { body } : {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const logsOf = async id => (await api('GET', `/tunnels/${id}/logs`)).json.map(l => l.text).join('\n');
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await sleep(100); }
}

// Provider finto: "zona" → "servizio" (dipende dalla zona); start apre un server TCP sulla porta
// locale in un processo figlio (che la route /crash della fixture fa uscire)
const FAKE_SERVER = `
const { spawn } = require('child_process');
const children = new Set();
const SERVICES = { eu: ['api', 'db'], us: ['web'] };
module.exports = ctx => ({
  providers: {
    fake: {
      fields(values) {
        return [
          { key: 'zone', label: { it: 'Zona', en: 'Zone' }, type: 'select', required: true, options: Object.keys(SERVICES).map(z => ({ value: z, label: z.toUpperCase() })) },
          { key: 'service', label: 'Servizio', type: 'select', required: true, dependsOn: ['zone'], options: (SERVICES[values.zone] || []).map(s => ({ value: s, label: s })) },
        ];
      },
      validate(params) {
        if (!SERVICES[params.zone] || !SERVICES[params.zone].includes(params.service)) throw ctx.error(400, 'bad_target');
        return { zone: params.zone, service: params.service };
      },
      describe: p => p.zone + '/' + p.service,
      start(params, localPort, { onOutput, onReady, onExit }) {
        const child = spawn(process.execPath, ['-e', "const s=require('net').createServer(c=>c.end('ok')).listen(" + localPort + ",'127.0.0.1',()=>console.log('Forwarding from 127.0.0.1:" + localPort + "'))"]);
        children.add(child);
        child.stdout.on('data', d => { onOutput(String(d)); if (String(d).includes('Forwarding')) onReady(); });
        child.on('close', code => { children.delete(child); onExit(code); });
        return { pid: child.pid, stop: () => child.kill() };
      },
    },
  },
  handlers: { crash(req, res) { for (const c of children) c.kill('SIGKILL'); res.json({ ok: true }); } },
  shutdown() { for (const c of children) c.kill(); },
});`;

before(async () => {
  const root = tmpDir('kelbo-transports-');
  writeExtension(root, 'faketp', {
    'setting.json': manifest('faketp', {
      backend: { module: 'server.js', routes: [{ method: 'POST', path: '/crash', handler: 'crash' }] },
      provides: [{ capability: 'tunnel-transport', id: 'fake', title: { it: 'Finto', en: 'Fake' }, handler: 'fake' }],
    }),
    'server.js': FAKE_SERVER,
    'i18n/it.json': JSON.stringify({ 'errors.bad_target': 'Destinazione non valida' }),
    'i18n/en.json': JSON.stringify({ 'errors.bad_target': 'Invalid target' }),
  });
  srv = await startServer({
    groups: [{ key: 'g', label: 'G', color: '#336699', servers: ['ghost'] }],
    // tunnel di un trasporto che non c'è: resta, segnato come non disponibile
    servers: [{ key: 'ghost', label: 'Ghost', port: 46100, type: 'TCP', transport: 'k8s', transportFrom: 'kubectl', params: { context: 'prod' } }],
    projects: [],
  }, { extensions: null, install: [path.join(EXT, 'tunnels'), path.join(root, 'faketp')] });
});
after(() => srv?.stop());

test('trasporti disponibili e campi che dipendono dai valori', async () => {
  let r = await api('GET', '/state');
  assert.deepEqual(r.json.transports, [{ id: 'fake', title: { it: 'Finto', en: 'Fake' }, extension: 'faketp' }]);
  const ghost = r.json.servers.find(s => s.key === 'ghost');
  assert.deepEqual([ghost.unavailable, ghost.transportFrom], [true, 'kubectl']);
  r = await api('POST', '/transports/fake/fields', { values: {} });
  assert.deepEqual(r.json.fields.map(f => [f.key, (f.options || []).length]), [['zone', 2], ['service', 0]]);
  r = await api('POST', '/transports/fake/fields', { values: { zone: 'eu' } });
  assert.deepEqual(r.json.fields[1].options.map(o => o.value), ['api', 'db']);
  assert.equal((await api('POST', '/transports/nope/fields', { values: {} })).json.code, 'tunnels.transport_missing');
  assert.equal((await api('POST', '/transports/fake/fields', { values: { x: { y: 1 } } })).json.code, 'tunnels.params_invalid');
});

test('server di un trasporto: parametri validati dal provider, descrizione', async () => {
  let r = await api('POST', '/servers', { key: 'api', label: 'API', port: 46101, type: 'HTTP', transport: 'fake', params: { zone: 'eu', service: 'web' }, groupKey: 'g' });
  assert.equal(r.json.code, 'faketp.bad_target');
  r = await api('POST', '/servers', { key: 'api', label: 'API', port: 46101, type: 'HTTP', transport: 'fake', params: { zone: 'eu', service: 'api', extra: 'x' }, groupKey: 'g' });
  assert.equal(r.status, 200, r.text);
  const saved = srv.readConfig().servers.find(s => s.key === 'api');
  assert.deepEqual([saved.transport, saved.transportFrom, saved.params, saved.remote, saved.alias], ['fake', 'faketp', { zone: 'eu', service: 'api' }, undefined, undefined]);
  r = await api('GET', '/state');
  assert.equal(r.json.servers.find(s => s.key === 'api').description, 'eu/api');
  // da SSH a trasporto e ritorno
  await api('POST', '/servers', { key: 'ssh1', label: 'SSH', port: 46102, remote: 'db:5432', alias: 'x.invalid' });
  r = await api('PUT', '/servers/ssh1', { transport: 'fake', params: { zone: 'us', service: 'web' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(srv.readConfig().servers.find(s => s.key === 'ssh1').alias, undefined);
  r = await api('PUT', '/servers/ssh1', { transport: 'ssh', remote: 'db:5432', alias: 'x.invalid' });
  assert.deepEqual(['transport', 'params'].map(k => srv.readConfig().servers.find(s => s.key === 'ssh1')[k]), [undefined, undefined]);
  // import con parametri non validi: rifiutato
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { servers: [{ key: 'bad', label: 'B', port: 1, transport: 'fake', params: { a: { b: 1 } } }] } } });
  assert.equal(r.status, 400);
});

test('avvio, pronto, uscita e riconnessione con lo stesso trasporto', async () => {
  let r = await api('POST', '/tunnels', { serverKey: 'api' });
  assert.equal(r.status, 200, r.text);
  const id = r.json.id;
  assert.ok(r.json.pid);
  await until(async () => /Pronto su 127\.0\.0\.1:46101/.test(await logsOf(id)));
  assert.match(await logsOf(id), /Avvio con Finto su 127\.0\.0\.1:46101/);
  const first = (await api('GET', '/state')).json.tunnels.find(t => t.id === id).pid;
  await srv.request('POST', '/api/ext/faketp/crash', { body: {} });
  await until(async () => /Riconnessione tra 5 s/.test(await logsOf(id)));
  const again = await until(async () => { const t = (await api('GET', '/state')).json.tunnels.find(x => x.id === id); return t && !t.reconnecting && t.pid !== first && t; }, 10000);
  assert.ok(again.pid);
  assert.equal((await api('DELETE', `/tunnels/${id}`)).status, 200);
  // trasporto non installato: non parte
  assert.equal((await api('POST', '/tunnels', { serverKey: 'ghost' })).json.code, 'tunnels.transport_missing');
});

test('trasporto spento mentre il tunnel gira: il tunnel si ferma e dice perché', async () => {
  const r = await api('POST', '/tunnels', { serverKey: 'api' });
  await until(async () => /Pronto/.test(await logsOf(r.json.id)));
  assert.equal((await srv.request('POST', '/api/core/extensions-admin/faketp/enabled', { body: { enabled: false } })).status, 200);
  const st = await until(async () => { const s = (await api('GET', '/state')).json; return !s.tunnels.some(t => t.id === r.json.id) && s; }, 10000);
  assert.equal(st.errors.api.code, 'tunnels.transport_missing');
  assert.equal(st.servers.find(s => s.key === 'api').unavailable, true);
  await srv.request('POST', '/api/core/extensions-admin/faketp/enabled', { body: { enabled: true } });
  assert.equal((await api('GET', '/state')).json.servers.find(s => s.key === 'api').unavailable, false);
});
