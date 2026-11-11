// Estensioni installabili: anteprima da repository git locali (tag semplici e con prefisso),
// la più recente compatibile, installazione caricata a caldo, catalogo, dipendenze,
// aggiornamento e ritorno alla versione precedente, tag spostato, spegnimento con le
// dipendenti, rimozione, installazione fallita senza tracce, elenco delle installate esportato
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startServer, tmpDir, git, writeExtension, manifest, parseSse } = require('../lib/testkit');

// Repository con un'estensione nella radice; ogni versione è un commit con il suo tag
function rootRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}
function release(repo, folder, code, version, { devdock = '^2.0', tag, extra = {}, changelog } = {}) {
  const dir = folder ? path.join(repo, folder) : repo;
  writeExtension(path.dirname(dir), path.basename(dir), {
    'setting.json': manifest(code, {
      version, devdock, config: [`${code.replace(/-/g, '')}Data`],
      backend: { module: 'server.js', routes: [{ method: 'GET', path: '/hi', handler: 'hi' }] }, ...extra,
    }),
    'server.js': `module.exports = ctx => ({
      config: { ${code.replace(/-/g, '')}Data: { empty: { n: 0 } } },
      handlers: { hi: (req, res) => res.json({ code: '${code}', version: '${version}', data: ctx.config.get('${code.replace(/-/g, '')}Data') }) },
    });`,
    ...(changelog ? { 'CHANGELOG.md': changelog } : {}),
  });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', `${code} ${version}`);
  git(repo, 'tag', tag || (folder ? `${code}@${version}` : `v${version}`));
}

let srv, repoA, repoB, catalogServer, catalogUrl;
const call = (m, p, body) => srv.request(m, `/api/core${p}`, body !== undefined ? { body } : m === 'POST' ? { body: {} } : {});
const admin = async () => (await call('GET', '/extensions-admin')).json;
const ext = async code => (await admin()).extensions.find(e => e.code === code && e.source === 'installed');
const install = async id => {
  const r = await call('POST', '/extensions-admin/install', { id });
  return r.events;
};
const done = events => events.find(e => e.type === 'done')?.data;

before(async () => {
  const base = tmpDir('devdock-repos-');
  repoA = rootRepo(path.join(base, 'hello'));
  release(repoA, null, 'hello', '1.0.0', { changelog: '# Changelog\n\n## [1.0.0]\n- prima\n' });
  release(repoA, null, 'hello', '1.1.0', { changelog: '# Changelog\n\n## [1.1.0]\n- seconda\n\n## [1.0.0]\n- prima\n' });
  release(repoA, null, 'hello', '2.0.0', { devdock: '^9.0' }); // richiede un Kelbo futuro
  repoB = rootRepo(path.join(base, 'tools'));
  release(repoB, 'tools/greet', 'greet', '1.0.0');
  release(repoB, 'tools/greet', 'greet', '1.2.0');
  release(repoB, 'tools/needs', 'needs', '1.0.0', { extra: { dependencies: [{ code: 'hello', required: true }] } });
  release(repoB, 'tools/broken', 'broken', '1.0.0', { extra: { color: 'rosso' } }); // manifest non valido

  catalogServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ extensions: [
      { code: 'greet', name: 'Greet', description: 'Saluta', repo: repoB, path: 'tools/greet', icon: 'notebook-pen', kinds: ['component', 'provider', 'nope', 'component'] },
      { code: 'hello', name: 'Hello', repo: repoA },
      { code: 'bad code!', repo: 'x' },
    ] }));
  });
  await new Promise(r => catalogServer.listen(0, '127.0.0.1', r));
  catalogUrl = `http://127.0.0.1:${catalogServer.address().port}/index.json`;
  srv = await startServer({ projects: [], extensions: { catalogs: [catalogUrl] } }, { extensions: null });
});
after(async () => { await srv?.stop(); catalogServer?.close(); });

test('anteprima da URL: versioni dai tag, la più recente compatibile, changelog, nessuna scrittura', async () => {
  const r = await call('POST', '/extensions-admin/preview', { source: repoA });
  assert.equal(r.status, 200, r.text);
  const p = r.json;
  assert.deepEqual([p.code, p.version, p.tag, p.compatible], ['hello', '1.1.0', 'v1.1.0', true]);
  assert.deepEqual(p.versions.map(v => v.version), ['2.0.0', '1.1.0', '1.0.0']);
  assert.match(p.changelog, /## \[1\.1\.0\][\s\S]*## \[1\.0\.0\]/);
  assert.match(p.commit, /^[0-9a-f]{40}$/);
  assert.equal(fs.existsSync(path.join(srv.home, 'extensions', 'hello')), false);
  // una versione precisa, anche incompatibile, si può vedere ma è segnalata
  const v2 = (await call('POST', '/extensions-admin/preview', { source: repoA, tag: 'v2.0.0' })).json;
  assert.deepEqual([v2.version, v2.compatible, v2.devdock], ['2.0.0', false, '^9.0']);
  assert.equal((await call('POST', '/extensions-admin/preview', { source: '--upload-pack=touch /tmp/x' })).json.code, 'core.ext_source_invalid');
  assert.equal((await call('POST', '/extensions-admin/preview', { source: repoA, folder: '../x' })).json.code, 'core.ext_path_invalid');
});

test('installazione: caricata senza riavvio, lock file, elenco delle installate in config.json', async () => {
  const p = (await call('POST', '/extensions-admin/preview', { source: repoA })).json;
  assert.equal((await srv.request('GET', '/api/ext/hello/hi')).status, 404);
  const events = await install(p.id);
  assert.deepEqual(events.filter(e => e.type === 'step').map(e => e.data.key), ['copy', 'done', 'load']);
  assert.deepEqual([done(events).code, done(events).version, done(events).restartRequired, done(events).state], ['hello', '1.1.0', false, 'ok']);
  assert.deepEqual((await srv.request('GET', '/api/ext/hello/hi')).json, { code: 'hello', version: '1.1.0', data: { n: 0 } });
  const lock = JSON.parse(fs.readFileSync(path.join(srv.home, 'extensions.lock.json'), 'utf8')).extensions.hello;
  assert.deepEqual([lock.repo, lock.tag, lock.version], [repoA, 'v1.1.0', '1.1.0']);
  assert.equal(lock.commit, git(repoA, 'rev-parse', 'v1.1.0^{commit}').trim());
  assert.deepEqual(srv.readConfig().extensions.installed, [{ code: 'hello', repo: repoA, tag: 'v1.1.0' }]);
  assert.equal(fs.existsSync(path.join(srv.home, 'extensions', 'hello', '.git')), false);
  assert.equal(fs.existsSync(path.join(srv.home, 'extensions', '.staging', p.id)), false, 'staging dell\'installazione rimosso');
  const e = await ext('hello');
  assert.deepEqual([e.state, e.version, e.lock.tag], ['ok', '1.1.0', 'v1.1.0']);
  // anteprima già usata: scaduta
  assert.equal(done(await install(p.id)), undefined);
});

test('catalogo: voci valide, installate segnate; installazione da una cartella con tag con prefisso', async () => {
  const c = (await call('GET', '/extensions-admin/catalog?refresh=1')).json;
  assert.deepEqual(c.catalogs.map(x => [x.url, x.ok, x.count]), [[catalogUrl, true, 2]]);
  assert.equal(c.extensions.find(e => e.code === 'hello').installed.version, '1.1.0');
  assert.equal(c.extensions.find(e => e.code === 'greet').installed, null);
  // icona Lucide intera e tipi noti, senza ripetizioni
  assert.equal(c.extensions.find(e => e.code === 'greet').icon, 'notebook-pen');
  assert.deepEqual(c.extensions.find(e => e.code === 'greet').kinds, ['component', 'provider']);
  assert.deepEqual(c.extensions.find(e => e.code === 'hello').kinds, []);
  const p = (await call('POST', '/extensions-admin/preview', { code: 'greet' })).json;
  assert.deepEqual([p.version, p.tag, p.path], ['1.2.0', 'greet@1.2.0', 'tools/greet']);
  assert.deepEqual(p.versions.map(v => v.tag), ['greet@1.2.0', 'greet@1.0.0']);
  assert.equal(done(await install(p.id)).state, 'ok');
  assert.equal((await srv.request('GET', '/api/ext/greet/hi')).json.version, '1.2.0');
});

test('dipendenze: segnalate nell\'anteprima; spegnere un\'estensione spegne chi la richiede, riaccenderla le riavvia', async () => {
  let p = (await call('POST', '/extensions-admin/preview', { source: repoB, folder: 'tools/needs' })).json;
  assert.deepEqual(p.dependencies, [{ code: 'hello', required: true, installed: true, available: { repo: repoA, path: null } }]);
  assert.deepEqual(p.missing, []);
  assert.equal(done(await install(p.id)).state, 'ok');
  let r = await call('POST', '/extensions-admin/hello/enabled', { enabled: false });
  assert.equal(r.status, 200, r.text);
  let list = (await admin()).extensions;
  assert.equal(list.find(e => e.code === 'hello').state, 'off');
  assert.equal(list.find(e => e.code === 'needs').state, 'disabled');
  assert.equal((await srv.request('GET', '/api/ext/hello/hi')).status, 404);
  await call('POST', '/extensions-admin/hello/enabled', { enabled: true });
  list = (await admin()).extensions;
  assert.equal(list.find(e => e.code === 'hello').state, 'ok');
  assert.equal(list.find(e => e.code === 'needs').state, 'ok');
  // ricarica: anche le dipendenti ripartono (loadId nuovo)
  const before = list.find(e => e.code === 'needs').loadId;
  await call('POST', '/extensions-admin/hello/reload');
  assert.ok((await ext('needs')).loadId > before);
});

test('aggiornamento: nuova versione trovata, dati di config conservati, ritorno alla precedente, tag spostato', async () => {
  // dati salvati dall'estensione nella sua sezione
  const cfg = srv.readConfig();
  cfg.helloData = { n: 42 };
  fs.writeFileSync(srv.configPath, JSON.stringify(cfg));
  release(repoA, null, 'hello', '1.2.0', { changelog: '## [1.2.0]\n- terza\n\n## [1.1.0]\n- seconda\n' });
  let u = (await call('POST', '/extensions-admin/updates')).json.extensions.hello;
  assert.deepEqual([u.current, u.latest, u.available, u.moved], ['1.1.0', '2.0.0', true, false]);
  // la proposta è la più recente compatibile, con il changelog dalla versione installata
  const p = (await call('POST', '/extensions-admin/hello/update')).json;
  assert.deepEqual([p.version, p.installed.version], ['1.2.0', '1.1.0']);
  assert.match(p.changelog, /1\.2\.0/);
  assert.doesNotMatch(p.changelog, /seconda/);
  const d = done(await install(p.id));
  assert.deepEqual([d.version, d.previous], ['1.2.0', '1.1.0']);
  assert.deepEqual((await srv.request('GET', '/api/ext/hello/hi')).json, { code: 'hello', version: '1.2.0', data: { n: 42 } });
  let e = await ext('hello');
  assert.deepEqual([e.hasBackup, e.lock.previous], [true, '1.1.0']);
  // ritorno alla versione precedente con un clic
  await call('POST', '/extensions-admin/hello/restore');
  assert.equal((await srv.request('GET', '/api/ext/hello/hi')).json.version, '1.1.0');
  e = await ext('hello');
  assert.deepEqual([e.version, e.lock.tag, e.lock.previous], ['1.1.0', 'v1.1.0', '1.2.0']);
  // il tag installato ora punta a un altro commit: segnalato
  fs.writeFileSync(path.join(repoA, 'extra.txt'), 'x');
  git(repoA, 'add', '-A');
  git(repoA, 'commit', '-qm', 'ritocco');
  git(repoA, 'tag', '-f', 'v1.1.0');
  u = (await call('POST', '/extensions-admin/updates')).json.extensions.hello;
  assert.equal(u.moved, true);
});

test('installazione fallita (manifest non valido): nessuna traccia', async () => {
  const staging = () => fs.readdirSync(path.join(srv.home, 'extensions', '.staging')).sort();
  const before = staging();
  const r = await call('POST', '/extensions-admin/preview', { source: repoB, folder: 'tools/broken' });
  assert.equal(r.json.code, 'core.ext_manifest_invalid');
  assert.deepEqual(staging(), before);
  assert.equal(fs.existsSync(path.join(srv.home, 'extensions', 'broken')), false);
  assert.equal((await call('POST', '/extensions-admin/preview', { source: path.join(repoB, 'nope') })).json.code, 'core.ext_repo_unreachable');
});

test('rimozione: estensione scaricata, lock ed elenco aggiornati; le incluse non si rimuovono', async () => {
  let r = await call('DELETE', '/extensions-admin/greet');
  assert.equal(r.status, 200, r.text);
  assert.equal((await srv.request('GET', '/api/ext/greet/hi')).status, 404);
  assert.equal((await admin()).extensions.some(e => e.code === 'greet'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(srv.home, 'extensions.lock.json'), 'utf8')).extensions.greet, undefined);
  assert.deepEqual(srv.readConfig().extensions.installed.map(x => x.code).sort(), ['hello', 'needs']);
  assert.equal((await call('DELETE', '/extensions-admin/greet')).json.code, 'core.ext_not_installed');
});

test('elenco delle installate nell\'export; importato altrove compare come da installare', async () => {
  const exported = (await srv.request('GET', '/api/core/config/export?sections=extensions')).json;
  assert.deepEqual(exported.extensions.installed.map(x => x.code).sort(), ['hello', 'needs']);
  const other = await startServer({ projects: [] }, { extensions: null });
  try {
    const r = await other.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: exported } });
    assert.equal(r.status, 200, r.text);
    const pending = (await other.request('GET', '/api/core/extensions-admin')).json.pending;
    assert.deepEqual(pending.map(x => x.code).sort(), ['hello', 'needs']);
    assert.equal(pending.find(x => x.code === 'hello').repo, repoA);
  } finally { await other.stop(); }
});

test('estensione che non si ricarica a caldo: l\'aggiornamento chiede il riavvio', async () => {
  const repo = rootRepo(path.join(tmpDir('devdock-fixed-'), 'fixed'));
  release(repo, null, 'fixed', '1.0.0', { extra: { reloadable: false } });
  let p = (await call('POST', '/extensions-admin/preview', { source: repo })).json;
  assert.equal(p.reloadable, false);
  assert.equal(done(await install(p.id)).restartRequired, false, 'la prima installazione si carica');
  release(repo, null, 'fixed', '1.1.0', { extra: { reloadable: false } });
  p = (await call('POST', '/extensions-admin/fixed/update')).json;
  const d = done(await install(p.id));
  assert.deepEqual([d.version, d.restartRequired], ['1.1.0', true]);
  assert.equal((await srv.request('GET', '/api/ext/fixed/hi')).json.version, '1.0.0', 'resta in uso la versione caricata');
  assert.equal((await call('DELETE', '/extensions-admin/fixed')).json.code, 'core.ext_restart_required');
});

test('riga di comando senza Kelbo in esecuzione: installazione sui file, elenco, rimozione', async () => {
  const { execFileSync } = require('child_process');
  const { ROOT } = require('../lib/testkit');
  const home = tmpDir('devdock-cli-home-');
  const env = { ...process.env, DEVDOCK_HOME: home, DEVDOCK_PORT: '1', DEVDOCK_CONFIG: path.join(home, 'config.json') };
  fs.writeFileSync(env.DEVDOCK_CONFIG, '{"projects":[]}');
  const cli = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'bin/devdock.js'), 'ext', ...args], { env, encoding: 'utf8' });
  let out = cli('install', repoB, '--path', 'tools/greet', '--yes');
  assert.match(out, /greet 1\.2\.0 installata: vale dal prossimo avvio di Kelbo/);
  assert.ok(fs.existsSync(path.join(home, 'extensions', 'greet', 'setting.json')));
  assert.match(cli('list'), /greet\s+1\.2\.0\s+installed/);
  assert.match(cli('check'), /greet\s+1\.2\.0 aggiornata/);
  assert.match(cli('remove', 'greet', '--yes'), /greet rimossa/);
  assert.equal(fs.existsSync(path.join(home, 'extensions', 'greet')), false);
});

test('catalogo ufficiale di prima del passaggio a Kelbo: nella lista salvata diventa quello nuovo', async () => {
  const legacy = 'https://raw.githubusercontent.com/codo82/devdock-extensions/main/index.json';
  const r = await call('PUT', '/extensions-admin/catalogs', { catalogs: [legacy, catalogUrl] });
  assert.deepEqual(r.json.catalogs, ['https://raw.githubusercontent.com/kelbodev/kelbo-extensions/main/index.json', catalogUrl]);
  await call('PUT', '/extensions-admin/catalogs', { catalogs: [catalogUrl] });
});
