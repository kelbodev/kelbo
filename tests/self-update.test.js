// Aggiornamento di Kelbo stesso (M6): repository di origine locale con i tag v1.0.0 e v1.1.0,
// checkout al tag (HEAD staccato) e su un ramo; controllo, CHANGELOG, aggiornamento rifiutato
// con modifiche locali o storia diversa, aggiornamento, ritorno indietro, riavvio con PM2 finto,
// route HTTP
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, tmpDir } = require('../lib/testkit');
const { createSelfUpdate, changelogBetween } = require('../lib/self-update');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const CHANGELOG = v => `# Changelog\n\n## [Unreleased]\n\n${v === '1.1.0' ? '## [1.1.0] - 2026-11-13\n\n### Added\n- Nuova cosa.\n\n' : ''}## [1.0.0] - 2026-11-01\n\n### Added\n- Prima versione.\n`;

let origin, work;
function release(dir, version) {
  write(dir, 'package.json', JSON.stringify({ name: 'kelbo-test', version, private: true }));
  write(dir, 'CHANGELOG.md', CHANGELOG(version));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', `v${version}`); git(dir, 'tag', '-a', `v${version}`, '-m', version);
}
// checkout di Kelbo alla versione 1.0.0: al tag (staccato) o sul ramo main
function cloneAt(branch = false) {
  const dir = path.join(tmpDir('kelbo-self-'), 'kelbo');
  git(path.dirname(dir), 'clone', '-q', origin, dir);
  if (branch) git(dir, 'reset', '-q', '--hard', 'v1.0.0'); else git(dir, 'checkout', '-q', '--detach', 'v1.0.0');
  write(dir, '.gitignore', 'node_modules\nconfig.json\n'); // come il vero (non tracciato: non è una modifica)
  return dir;
}
const make = (root, extra = {}) => createSelfUpdate({ root, version: '1.0.0', stateFile: path.join(tmpDir('kelbo-self-state-'), 'self-update.json'), log: { error() {} }, ...extra });

before(() => {
  work = tmpDir('kelbo-self-origin-');
  git(work, 'init', '-q', '-b', 'main'); git(work, 'config', 'user.email', 't@example.invalid'); git(work, 'config', 'user.name', 'T');
  release(work, '1.0.0');
  release(work, '1.1.0');
  origin = work;
});
after(() => {});

test('CHANGELOG: solo le versioni fra quella in uso e la nuova', () => {
  const text = '## [Unreleased]\n\n## [2.1.0]\n- c\n\n## [2.0.1]\n- b\n\n## [2.0.0]\n- a\n';
  assert.equal(changelogBetween(text, '2.0.0', '2.1.0'), '## [2.1.0]\n- c\n\n## [2.0.1]\n- b');
  assert.equal(changelogBetween(text, '2.0.1', '2.0.1'), null);
});

test('controllo: versione nuova dai tag, novità, informazioni sul checkout', async () => {
  const self = make(cloneAt());
  const s = await self.check();
  assert.deepEqual([s.available, s.latest, s.tag, s.error], [true, '1.1.0', 'v1.1.0', null]);
  const c = await self.changelog('v1.1.0');
  assert.match(c.changelog, /## \[1\.1\.0\]/);
  assert.doesNotMatch(c.changelog, /1\.0\.0/);
  const info = await self.info();
  assert.deepEqual([info.checkout.git, info.checkout.branch, info.checkout.clean, info.restart.managed], [true, null, true, false]);
  await assert.rejects(self.changelog('main; rm -rf /'), e => e.code === 'core.update_tag_invalid');
  // fuori da un checkout git: niente aggiornamenti
  const plain = make(tmpDir('kelbo-self-plain-'));
  assert.equal((await plain.check()).error, 'not_git');
  await assert.rejects(plain.update(), e => e.code === 'core.update_not_git');
});

test('aggiornamento: rifiutato con modifiche locali; poi al tag, npm install, versione di prima', async () => {
  const dir = cloneAt();
  const self = make(dir);
  write(dir, 'package.json', '{"name":"kelbo-test","version":"1.0.0","private":true,"x":1}');
  await assert.rejects(self.update(), e => e.code === 'core.update_local_changes' && e.extra.files.includes('package.json'));
  git(dir, 'checkout', '--', 'package.json');
  const steps = [];
  const r = await self.update({ step: k => steps.push(k) });
  assert.deepEqual([r.from, r.to, r.tag, r.restart.managed], ['1.0.0', '1.1.0', 'v1.1.0', false]);
  assert.deepEqual(steps, ['check', 'fetch', 'checkout', 'npm']);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'v1.1.0^{commit}'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.1.0');
  assert.equal((await self.info()).previous, '1.0.0');
  await assert.rejects(self.update({ tag: 'v1.0.0' }), e => e.code === 'core.update_not_newer');
  // ritorno alla versione di prima
  const back = await self.rollback();
  assert.equal(back.to, '1.0.0');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'v1.0.0^{commit}'));
  await assert.rejects(self.rollback(), e => e.code === 'core.update_no_previous');
});

test('package-lock.json riscritto da npm install non blocca: si rimette com\'era', async () => {
  const dir = cloneAt();
  write(dir, 'package-lock.json', '{}');
  git(dir, 'add', 'package-lock.json'); git(dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=T', 'commit', '-qm', 'lock');
  write(dir, 'package-lock.json', '{"riscritto":true}');
  const self = make(dir);
  assert.equal((await self.info()).checkout.clean, true);
  // il commit locale non è sulla storia di v1.1.0: rifiutato, ma per la storia, non per il lock
  await assert.rejects(self.update(), e => e.code === 'core.update_not_fast_forward');
});

test('aggiornamento su un ramo: fast-forward che resta sul ramo; storia diversa rifiutata', async () => {
  const dir = cloneAt(true);
  const self = make(dir);
  await self.update();
  assert.equal(git(dir, 'branch', '--show-current'), 'main');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'v1.1.0^{commit}'));
  // un tag su una storia che non contiene la versione in uso
  const other = cloneAt();
  git(origin, 'checkout', '-q', '-b', 'side', 'v1.0.0~0');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'altra storia');
  git(origin, 'tag', '-a', 'v1.2.0', '-m', '1.2.0');
  git(origin, 'checkout', '-q', 'main');
  const self2 = make(other);
  await self2.update({ tag: 'v1.1.0' }); // in avanti: va
  await assert.rejects(make(other, { version: '1.1.0' }).update({ tag: 'v1.2.0' }), e => e.code === 'core.update_not_fast_forward');
  git(origin, 'tag', '-d', 'v1.2.0'); // gli altri test vedono di nuovo 1.1.0 come ultima
});

test('riavvio: solo sotto PM2, con il comando di PM2 staccato', async () => {
  const self = make(cloneAt());
  assert.throws(() => self.restart(), e => e.code === 'core.restart_not_managed');
  const bin = tmpDir('kelbo-self-pm2-');
  const marker = path.join(bin, 'calls.txt');
  write(bin, 'pm2', `#!/bin/sh\necho "$@" >> "${marker}"\n`);
  fs.chmodSync(path.join(bin, 'pm2'), 0o755);
  const saved = { pm_id: process.env.pm_id, name: process.env.name };
  process.env.pm_id = '3'; process.env.name = 'kelbo-dev';
  try {
    const pm2Self = make(cloneAt(), { pm2: path.join(bin, 'pm2') });
    assert.deepEqual((await pm2Self.info()).restart, { managed: true, name: 'kelbo-dev' });
    assert.deepEqual(pm2Self.restart(), { restarting: true, name: 'kelbo-dev' });
    for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'restart kelbo-dev --update-env');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('route HTTP: controllo, novità, cosa si ferma, aggiornamento in streaming, versione', async () => {
  const dir = cloneAt();
  const srv = await startServer(undefined, { env: { KELBO_UPDATE_ROOT: dir } });
  try {
    let r = await srv.request('POST', '/api/core/update/check', { body: {} });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.current, r.json.latest, r.json.available], ['1.0.0', '1.1.0', true]);
    r = await srv.request('GET', '/api/core/update/changelog?tag=v1.1.0');
    assert.match(r.json.changelog, /Nuova cosa/);
    r = await srv.request('GET', '/api/core/update/running');
    assert.deepEqual(r.json.running, []);
    r = await srv.request('POST', '/api/core/update/restart', { body: {} });
    assert.equal(r.json.code, 'core.restart_not_managed');
    r = await srv.request('POST', '/api/core/update', { body: {} });
    const done = r.events.find(e => e.type === 'done');
    assert.ok(done, r.text);
    assert.deepEqual([done.data.to, done.data.restart.managed], ['1.1.0', false]);
    assert.deepEqual(r.events.filter(e => e.type === 'step').map(e => e.data.key), ['check', 'fetch', 'checkout', 'npm']);
    r = await srv.request('GET', '/api/core/system');
    assert.ok(r.json.version);
  } finally { await srv.stop(); }
});
