// Database come host di add-on (db-client 1.1): punti dichiarati, add-on accettato con la versione
// giusta e rifiutato con una che non c'è, schema di un database per gli add-on (route schema) con
// un motore finto: tabelle dall'introspect, viste con le colonne, chiavi esterne
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, tmpDir, manifest, writeExtension } = require('../../../lib/testkit');

let srv;
const api = (m, p, body) => srv.request(m, `/api/ext/db-client${p}`, body !== undefined ? { body } : {});

const FAKE_ENGINE = `
module.exports = () => ({
  providers: {
    fake: {
      driver: () => ({ name: 'fake', version: '1' }),
      connection: { fields: ['host', 'port', 'user', 'password', 'database'], defaultPort: 1 },
      dialect: { quote: '"', keywords: ['SELECT'], ddl: null, snippets: {} },
      createPool: () => ({}), closePool() {},
      async listTables(pool, db) {
        if (db !== 'shop') throw Object.assign(new Error('database sconosciuto'), { code: 'X' });
        return [{ name: 'customers', view: false, rowsEstimate: 3, comment: 'clienti' }, { name: 'orders', view: false, rowsEstimate: 10 }, { name: 'v_totals', view: true }];
      },
      async introspect(pool, db, tables) {
        return { tables: {
          customers: { comment: 'clienti', columns: [{ name: 'id', type: 'INT', nullable: false, autoIncrement: true }, { name: 'email', type: 'VARCHAR', length: 255, nullable: false }], primaryKey: ['id'], indexes: [{ name: 'email_u', unique: true, columns: ['email'] }], foreignKeys: [] },
          orders: { columns: [{ name: 'id', type: 'INT', nullable: false }, { name: 'customer_id', type: 'INT', nullable: true }, { name: 'total', type: 'DECIMAL', length: 10, scale: 2, nullable: true }],
            primaryKey: ['id'], indexes: [], foreignKeys: [{ name: 'fk_cust', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE' }] },
        } };
      },
      async columns(pool, db, table) { return table === 'v_totals' ? [{ name: 'email', type: 'varchar(255)', nullable: true }, { name: 'total', type: 'decimal(10,2)', nullable: true }] : []; },
    },
  },
});`;

before(async () => {
  const root = tmpDir('kelbo-dbaddons-');
  writeExtension(root, 'fakedb', {
    'setting.json': manifest('fakedb', { position: undefined, backend: { module: 'server.js', routes: [] }, provides: [{ capability: 'db-engine', id: 'fake', title: 'Fake', handler: 'fake' }] }),
    'server.js': FAKE_ENGINE,
  });
  const addon = (code, version) => writeExtension(root, code, {
    'setting.json': manifest(code, { position: undefined, addon: { host: 'db-client', version, js: 'addon.js', points: ['database-menu', 'table-menu', 'workspace-tab'] } }),
    'addon.js': 'export default { activate() {} };',
  });
  addon('erd', '>=1.1');
  addon('future', '>=2');
  srv = await startServer({ projects: [] }, { install: [path.join(root, 'fakedb'), path.join(root, 'erd'), path.join(root, 'future')] });
  await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-db' } });
  const r = await api('POST', '/connections', { id: 'f', label: 'F', type: 'fake', host: 'h', port: 1, user: 'u', database: 'shop' });
  assert.equal(r.status, 200, r.text);
});
after(() => srv?.stop());

test('db-client accoglie add-on: punti, versione, add-on compatibile e no', async () => {
  const list = (await srv.request('GET', '/api/core/extensions')).json;
  const host = list.find(e => e.code === 'db-client');
  assert.equal(host.version, '1.1.0');
  assert.deepEqual(host.addonPoints.map(p => p.id), ['database-menu', 'table-menu', 'workspace-tab']);
  assert.equal(list.find(e => e.code === 'erd').state, 'ok');
  const future = list.find(e => e.code === 'future');
  assert.deepEqual([future.state, future.errorInfo.code], ['disabled', 'core.ext_addon_host_version']);
});

test('schema di un database: tabelle con colonne, chiavi e relazioni, viste con le colonne', async () => {
  const r = await api('GET', '/connections/f/databases/shop/schema');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.connection, r.json.database, r.json.engine], ['f', 'shop', 'fake']);
  const by = Object.fromEntries(r.json.tables.map(t => [t.name, t]));
  assert.deepEqual(r.json.tables.map(t => [t.name, t.view]), [['customers', false], ['orders', false], ['v_totals', true]]);
  assert.deepEqual(by.customers.columns.map(c => [c.name, c.type, c.nullable, c.autoIncrement]), [['id', 'INT', false, true], ['email', 'VARCHAR(255)', false, false]]);
  assert.deepEqual([by.customers.comment, by.customers.rowsEstimate, by.customers.indexes[0].unique], ['clienti', 3, true]);
  assert.equal(by.orders.columns[2].type, 'DECIMAL(10,2)');
  assert.deepEqual(by.orders.foreignKeys, [{ name: 'fk_cust', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], refDatabase: null, onDelete: 'CASCADE', onUpdate: null }]);
  assert.deepEqual(by.v_totals.columns.map(c => c.name), ['email', 'total']);
  assert.equal((await api('GET', '/connections/f/databases/nope/schema')).status, 502);
  assert.equal((await api('GET', '/connections/zz/databases/shop/schema')).status, 404);
  assert.equal((await api('GET', '/connections/f/databases/..%2Fx/schema')).status, 400);
});
