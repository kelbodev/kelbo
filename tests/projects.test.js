// Progetti nel core (M10): tratti rilevati (core ed estensioni), tratti forzati, liste filtrate
// per estensione, collegamenti delle estensioni, import da una cartella
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, manifest, writeExtension, validateManifest } = require('../lib/testkit');

let srv, root, dirs;
const write = (dir, name, text = '') => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };

before(async () => {
  root = tmpDir('kelbo-projects-');
  dirs = {};
  for (const id of ['ng', 'ngfile', 'plain', 'node', 'mono']) dirs[id] = path.join(root, 'work', id);
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  write(dirs.ng, 'package.json', JSON.stringify({ name: 'shop-ui', dependencies: { '@angular/core': '^18.0.0' } }));
  write(dirs.ng, '.git/HEAD', 'ref: refs/heads/main\n');
  write(dirs.ngfile, 'angular.json', '{}');
  write(dirs.node, 'package.json', '{}');
  write(dirs.node, '.env.example', 'A=1\n');
  write(dirs.mono, '.git/HEAD', 'ref: refs/heads/main\n');
  write(dirs.mono, 'packages/api/package.json', '{}');
  dirs.api = path.join(dirs.mono, 'packages', 'api');
  // tratti con "detect": la cartella tools c'è in due progetti, ma solo in uno con dentro "ok"
  write(dirs.ngfile, 'tools/ok', '');
  fs.mkdirSync(path.join(dirs.mono, 'tools'));
  write(dirs.node, 'PURE', '');

  const ext = path.join(root, 'ext');
  writeExtension(ext, 'ng', {
    'setting.json': manifest('ng', {
      projects: { traits: ['angular'] },
      projectTraits: [
        { id: 'angular', label: { it: 'Angular', en: 'Angular' }, files: ['angular.json'], dependencies: ['@angular/core'] },
        { id: 'tool', label: 'Tool', files: ['tools'], detect: true },   // file come filtro, poi il backend
        { id: 'pure', label: 'Pure', detect: true },                     // solo il backend
        { id: 'broken', label: 'Broken', detect: true },                 // detectTrait che lancia: assente
      ],
      backend: { module: 'server.js', routes: [] },
    }),
    // collegamenti: l'estensione dice quali suoi dati riguardano il progetto
    'server.js': `const fs = require('fs'), path = require('path');
      module.exports = () => ({
        handlers: {},
        projectLinks: p => (p.id === 'ng' ? [{ key: 'links.workspace', params: { name: 'shop' } }] : []),
        detectTrait(id, dir) {
          if (id === 'broken') throw new Error('rotto');
          if (id === 'tool') return fs.existsSync(path.join(dir, 'tools', 'ok'));
          return id === 'pure' && fs.existsSync(path.join(dir, 'PURE'));
        },
      });`,
  });
  writeExtension(ext, 'all', { 'setting.json': manifest('all', {}) });
  srv = await startServer({
    projects: [
      { id: 'ng', label: 'Shop UI', path: dirs.ng },
      { id: 'ngfile', label: 'Angular file', path: dirs.ngfile },
      { id: 'plain', label: 'Vuota', path: dirs.plain, traits: { add: ['node', 'angular'] } },
      { id: 'node', label: 'Node', path: dirs.node, traits: { remove: ['node'] } },
      { id: 'api', label: 'API', path: dirs.api },
      { id: 'gone', label: 'Sparita', path: path.join(root, 'nope') },
    ],
  }, { extensions: null, install: [path.join(ext, 'ng'), path.join(ext, 'all')] });
});
after(() => srv?.stop());

const byId = list => Object.fromEntries(list.map(p => [p.id, p]));

test('tratti: rilevati dal core e dalle estensioni, forzati e tolti, cartelle mancanti', async () => {
  const { projects, traits } = (await srv.request('GET', '/api/core/projects')).json;
  assert.deepEqual(traits.map(t => [t.id, t.source]), [['git', 'core'], ['node', 'core'], ['env', 'core'], ['angular', 'ng'], ['tool', 'ng'], ['pure', 'ng'], ['broken', 'ng']]);
  assert.deepEqual(Object.keys(traits[3]).sort(), ['id', 'label', 'source']);
  const p = byId(projects);
  assert.deepEqual(p.ng.traitsActive.sort(), ['angular', 'git', 'node']);   // dipendenza in package.json
  assert.deepEqual(p.ngfile.traitsActive, ['angular', 'tool']);             // file angular.json; tools/ok confermato
  assert.ok(!p.mono || !p.mono.traitsActive.includes('tool'));              // tools/ senza "ok": detect dice no
  assert.deepEqual([p.plain.traitsFound, p.plain.traitsActive.sort()], [[], ['angular', 'node']]);
  assert.deepEqual([p.node.traitsFound.sort(), p.node.traitsActive.sort()], [['env', 'node', 'pure'], ['env', 'pure']]);
  assert.deepEqual(p.api.traitsActive.sort(), ['git', 'node']);             // git della cartella superiore
  assert.deepEqual([p.gone.missing, p.gone.traitsActive, p.ng.missing], [true, [], false]);
});

test('estensioni: progetti con i loro tratti; collegamenti dei dati al progetto', async () => {
  const list = (await srv.request('GET', '/api/core/extensions')).json;
  assert.deepEqual(list.find(e => e.code === 'ng').projects, { traits: ['angular'] });
  assert.deepEqual(list.find(e => e.code === 'all').projects, { traits: null });
  const r = await srv.request('GET', '/api/core/projects/ng/links');
  assert.deepEqual(r.json.links, [{ code: 'ng', key: 'links.workspace', params: { name: 'shop' } }]);
  assert.deepEqual((await srv.request('GET', '/api/core/projects/node/links')).json.links, []);
  assert.equal((await srv.request('GET', '/api/core/projects/nessuno/links')).status, 404);
});

test('tratti forzati: salvati con il progetto, validati, tolti se vuoti', async () => {
  let r = await srv.request('PUT', '/api/core/projects/ngfile', { body: { traits: { add: ['git', 'git'], remove: ['angular'] } } });
  assert.deepEqual(r.json.traits, { add: ['git'], remove: ['angular'] });
  const p = byId((await srv.request('GET', '/api/core/projects')).json.projects).ngfile;
  assert.deepEqual(p.traitsActive.sort(), ['git', 'tool']);
  for (const traits of ['node', { add: 'node' }, { add: ['Node!'] }, { remove: [1] }, { other: [] }]) {
    r = await srv.request('PUT', '/api/core/projects/ngfile', { body: { traits } });
    assert.deepEqual([r.status, r.json.code], [400, 'core.project_traits_invalid'], JSON.stringify(traits));
  }
  r = await srv.request('PUT', '/api/core/projects/ngfile', { body: { traits: { add: [], remove: [] } } });
  assert.equal(r.json.traits, undefined);
  assert.equal(srv.readConfig().projects.find(x => x.id === 'ngfile').traits, undefined);
  // anche da config.json (import, modifica a mano)
  r = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { projects: [{ id: 'x', label: 'X', path: dirs.plain, traits: ['node'] }] } } });
  assert.equal(r.status, 400);
});

test('manifest: projects e projectTraits validati', () => {
  const ok = validateManifest(manifest('x', { projects: { traits: ['node'] }, projectTraits: [{ id: 'vue', label: 'Vue', dependencies: ['vue'] }] }), 'x');
  assert.deepEqual(ok.projects, { traits: ['node'] });
  assert.deepEqual(ok.projectTraits, [{ id: 'vue', label: 'Vue', files: [], dependencies: ['vue'], detect: false }]);
  const det = validateManifest(manifest('x', { backend: { module: 'server.js', routes: [] }, projectTraits: [{ id: 'cli', label: 'CLI', detect: true }] }), 'x');
  assert.equal(det.projectTraits[0].detect, true);
  assert.throws(() => validateManifest(manifest('x', { projectTraits: [{ id: 'cli', label: 'CLI', detect: true }] }), 'x')); // senza backend
  assert.throws(() => validateManifest(manifest('x', { backend: { module: 'server.js', routes: [] }, projectTraits: [{ id: 'cli', label: 'CLI', detect: 'yes' }] }), 'x'));
  const bad = extra => assert.throws(() => validateManifest(manifest('x', extra), 'x'), undefined, JSON.stringify(extra));
  bad({ projects: 'node' });
  bad({ projects: { traits: [] } });
  bad({ projects: { traits: ['Node'] } });
  bad({ projectTraits: [{ id: 'vue', label: 'Vue' }] });                       // né file né dipendenze
  bad({ projectTraits: [{ id: 'vue', label: 'Vue', files: ['../x'] }] });
  bad({ projectTraits: [{ id: 'vue', label: 'Vue', dependencies: ['no spazi'] }] });
  bad({ projectTraits: [{ id: 'vue', files: ['vue.config.js'] }] });          // etichetta
});

test('import da una cartella: candidati con i tratti, già presenti segnati, id liberi', async () => {
  const work = path.join(root, 'work');
  fs.mkdirSync(path.join(work, 'node_modules', 'dep'), { recursive: true });
  write(path.join(work, 'node_modules', 'dep'), 'package.json', '{}');
  write(work, '.hidden/package.json', '{}');
  let r = await srv.request('POST', '/api/core/projects/scan', { body: { path: work } });
  assert.equal(r.status, 200);
  const c = byId(r.json.candidates.map(x => ({ ...x, id: x.name })));
  assert.deepEqual(Object.keys(c).sort(), ['mono', 'ng', 'ngfile', 'node']); // plain: nessun tratto; work: non è un progetto
  assert.deepEqual([c.ng.label, c.ng.added, c.mono.added], ['shop-ui', true, false]);

  for (const body of [{ path: 'relativa' }, { path: path.join(root, 'nope') }]) assert.equal((await srv.request('POST', '/api/core/projects/scan', { body })).status, 400);

  r = await srv.request('POST', '/api/core/projects/import', { body: { paths: [dirs.mono, dirs.ng, path.join(root, 'nope'), dirs.mono] } });
  assert.deepEqual(r.json.added.map(p => [p.id, p.label, p.path]), [['mono', 'mono', dirs.mono]]);
  assert.deepEqual(r.json.skipped.map(s => s.reason), ['exists', 'not_found', 'exists']);
  // stesso nome di cartella: id con un numero
  const other = path.join(root, 'altro', 'ng');
  fs.mkdirSync(other, { recursive: true });
  r = await srv.request('POST', '/api/core/projects/import', { body: { paths: [other], folder: 'sconosciuta' } });
  assert.equal(r.json.code, 'core.folder_unknown');
  r = await srv.request('POST', '/api/core/projects/import', { body: { paths: [other] } });
  assert.equal(r.json.added[0].id, 'ng-2');
  assert.equal((await srv.request('POST', '/api/core/projects/import', { body: { paths: [] } })).json.code, 'core.import_paths');
});
