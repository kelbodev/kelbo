// Widget della dashboard: riepilogo con gli ultimi commit e quelli da inviare
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { startServer, tmpDir, makeRepo } = require('../../../lib/testkit');

function shopRepo() {
  const project = makeRepo(path.join(tmpDir(), 'shop'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'shop', scripts: { build: 'node -e "1"', lint: 'node -e "1"' } }));
  return project;
}

const project = shopRepo();

test('Git: riepilogo con gli ultimi commit e quelli non ancora su un remoto', async () => {
  const s = await startServer({ projects: [{ id: 'shop', label: 'Shop', path: project }] });
  try {
    const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: project });
    fs.writeFileSync(path.join(project, 'a.txt'), 'a');
    git('add', '-A'); git('commit', '-qm', 'secondo');
    const r = (await s.request('GET', '/api/ext/git/repos/shop/summary')).json;
    assert.deepEqual(r.recent.map(c => c.subject).slice(0, 2), ['secondo', 'init']);
    assert.equal(r.outgoing.length, r.recent.length); // nessun remoto: tutto da inviare
    assert.ok(r.recent[0].hash && r.recent[0].date);
  } finally { await s.stop(); }
});

