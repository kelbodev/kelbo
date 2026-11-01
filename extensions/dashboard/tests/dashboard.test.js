// Dashboard: layout per progetto validato e salvato, widget delle estensioni integrate elencati
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

test('Dashboard: layout per progetto (validato), tutti i widget finché non si sceglie', async () => {
  const s = await startServer({ projects: [{ id: 'shop', label: 'Shop', path: project }] });
  const api = (m, p, body) => s.request(m, `/api/ext/dashboard${p}`, { body });
  try {
    assert.deepEqual((await api('GET', '/layouts/shop')).json, { widgets: null });
    const widgets = [{ key: 'git/status', size: 'l' }, { key: 'npm/scripts', size: 's' }];
    assert.deepEqual((await api('PUT', '/layouts/shop', { widgets })).json, { widgets });
    assert.deepEqual(s.readConfig().dashboards, { shop: { widgets } });
    for (const bad of [[{ key: 'git', size: 'm' }], [{ key: 'git/status', size: 'xl' }], [widgets[0], widgets[0]], 'no']) {
      assert.equal((await api('PUT', '/layouts/shop', { widgets: bad })).status, 400);
    }
    assert.equal((await api('GET', '/layouts/altro')).status, 404);
    assert.deepEqual((await api('DELETE', '/layouts/shop')).json, { widgets: null });
    assert.deepEqual(s.readConfig().dashboards, {});
    // widget delle estensioni integrate elencati dall'API
    const keys = (await s.request('GET', '/api/core/extensions')).json.flatMap(e => e.widgets.map(w => `${e.code}/${w.id}`));
    for (const k of ['npm/scripts', 'git/status', 'db-client/connections', 'env/files', 'http-client/requests', 'tunnels/project-tunnels']) assert.ok(keys.includes(k), k);
  } finally { await s.stop(); }
});
