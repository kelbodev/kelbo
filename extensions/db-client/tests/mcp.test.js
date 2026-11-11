// Strumenti MCP del DB client: solo con il vault sbloccato dall'interfaccia, solo letture
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, mcpClient } = require('../../../lib/testkit');
const { startMysql } = require('./mysql');

let srv, client;
before(async () => {
  srv = await startServer({ projects: [] });
  client = await mcpClient(srv);
});
after(async () => { await client?.close(); await srv?.stop(); });

const call = async (name, args = {}) => client.callTool({ name, arguments: args });

test('database: solo con il vault sbloccato dall\'interfaccia, solo letture, niente credenziali', async t => {
  let r = await call('db_client_connections');
  assert.equal(r.structuredContent.code, 'db-client.mcp_vault_locked');

  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  try {
    const api = (m, p, body) => srv.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    await api('POST', '/connections', { id: 'c', label: 'Locale', host: '127.0.0.1', port: mysqlDb.port, database: 'app', user: 'devdock', password: 'devdock-pass' });

    r = await call('db_client_connections');
    assert.deepEqual(r.structuredContent.connections[0], { id: 'c', label: 'Locale', type: 'mysql', host: '127.0.0.1', port: mysqlDb.port, tunnel: null, database: 'app', readOnly: false });
    assert.doesNotMatch(r.content[0].text, /devdock-pass|password|"user"/);
    r = await call('db_client_tables', { connection: 'c' });
    assert.deepEqual(r.structuredContent.tables.map(x => x.name), ['clienti']);
    r = await call('db_client_describe', { connection: 'c', table: 'clienti' });
    assert.deepEqual(r.structuredContent.primaryKey, ['id']);
    r = await call('db_client_query', { connection: 'c', sql: 'SELECT nome FROM clienti ORDER BY id', limit: 2 });
    assert.deepEqual(r.structuredContent.rows, [['Rossi'], ['Bianchi']]);
    assert.equal(r.structuredContent.truncated, true);
    r = await call('db_client_query', { connection: 'c', sql: 'DELETE FROM clienti' });
    assert.equal(r.structuredContent.code, 'db-client.mcp_read_only');
    // le letture girano in una transazione READ ONLY: una scrittura sfuggita al classificatore fallirebbe
    r = await call('db_client_query', { connection: 'c', sql: 'SELECT COUNT(*) FROM clienti' });
    assert.equal(r.structuredContent.rows[0][0], '3');

    assert.equal((await api('POST', '/vault/lock', {})).status, 200);
    r = await call('db_client_query', { connection: 'c', sql: 'SELECT 1' });
    assert.equal(r.structuredContent.code, 'db-client.mcp_vault_locked');
  } finally {
    await mysqlDb.stop();
  }
});
