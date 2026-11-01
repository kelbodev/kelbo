// Widget della dashboard: avvii degli script contati per progetto, processi con il progetto
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, makeRepo } = require('../../../lib/testkit');

function shopRepo() {
  const project = makeRepo(path.join(tmpDir(), 'shop'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'shop', scripts: { build: 'node -e "1"', lint: 'node -e "1"' } }));
  return project;
}

const project = shopRepo();

test('NPM: avvii contati per progetto nella cartella dati (per il widget "più usati")', async () => {
  const s = await startServer({ projects: [{ id: 'shop', label: 'Shop', path: project }] });
  try {
    for (const script of ['build', 'build', 'lint']) assert.equal((await s.request('POST', '/api/ext/npm/projects/shop/run', { body: { script } })).status, 200);
    const { scripts } = (await s.request('GET', '/api/ext/npm/projects/shop/usage')).json;
    assert.deepEqual([scripts.build.count, scripts.lint.count], [2, 1]);
    assert.ok(scripts.build.last);
    assert.ok(fs.existsSync(path.join(s.home, 'data', 'npm', 'runs.json')));
    assert.doesNotMatch(fs.readFileSync(s.configPath, 'utf8'), /"count"/); // non in config.json
    const procs = (await s.request('GET', '/api/ext/npm/processes')).json;
    assert.ok(procs.every(p => p.projectId === 'shop'));
  } finally { await s.stop(); }
});

