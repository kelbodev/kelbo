// Motori (M5.2): il db-client li trova tra i provider "db-engine"; MySQL è db-mysql, integrata.
// Una connessione con un motore non installato resta salvata, segnalata, e le operazioni lo dicono.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startServer } = require('../../../lib/testkit');

let srv;
before(async () => { srv = await startServer({ projects: [] }); });
after(() => srv?.stop());
const api = (m, p, body) => srv.request(m, `/api/ext/db-client${p}`, body !== undefined ? { body } : {});

test('motori disponibili: MySQL da db-mysql, con campi e dialetto', async () => {
  const info = (await api('GET', '/info')).json;
  assert.equal(info.defaultEngine, 'mysql');
  const mysql = info.engines.find(e => e.id === 'mysql');
  assert.equal(mysql.extension, 'db-mysql');
  assert.deepEqual(mysql.connection.fields, ['host', 'port', 'user', 'password', 'database']);
  assert.equal(mysql.connection.defaultPort, 3306);
  assert.equal(mysql.dialect.quote, '`');
  assert.ok(mysql.dialect.keywords.includes('SELECT'));
  assert.ok(mysql.dialect.ddl.types.includes('VARCHAR'));
  // campi di prima, per chi li legge ancora
  assert.equal(info.driver, 'mysql2');
  assert.deepEqual(info.ddl, mysql.dialect.ddl);
  const exts = (await srv.request('GET', '/api/core/extensions')).json;
  assert.deepEqual(exts.find(e => e.code === 'db-mysql').kinds, ['provider']);
});

test('connessione con un motore non installato: salvata, segnalata, operazioni rifiutate', async () => {
  const cfg = srv.readConfig();
  cfg.dbConnections = [
    { id: 'pg', label: 'PG', type: 'postgres', host: 'db.local', port: 5432, user: 'u', password: null },
    { id: 'old', label: 'Vecchia', host: 'db.local', port: 3306, user: 'u', password: null }, // senza type: MySQL
  ];
  fs.writeFileSync(srv.configPath, JSON.stringify(cfg));
  const list = (await api('GET', '/connections')).json;
  const by = Object.fromEntries(list.connections.map(c => [c.id, c]));
  assert.equal(by.pg.engineMissing, true);
  assert.equal(by.pg.type, 'postgres');
  assert.equal(by.old.engineMissing, undefined);
  assert.equal(by.old.type, 'mysql');
  assert.deepEqual(list.engines.map(e => e.id), ['mysql']);
  const r = await api('GET', '/connections/pg/databases');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'db-client.engine_missing');
  // nuova connessione con un motore che non c'è, o con un tipo non valido
  await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-db' } });
  let w = await api('POST', '/connections', { id: 'n', label: 'N', type: 'oracle', host: 'h', port: 1521, user: 'u' });
  assert.equal(w.json.code, 'db-client.engine_missing');
  w = await api('POST', '/connections', { id: 'n', label: 'N', type: 'mysql', host: 'h', port: 3306, user: 'u' });
  assert.equal(w.status, 200, w.text);
  assert.equal(srv.readConfig().dbConnections.find(c => c.id === 'n').type, 'mysql');
  // import: un tipo non valido è rifiutato, uno sconosciuto ma valido accettato
  let imp = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { dbFolders: [], dbConnections: [{ id: 'z', label: 'Z', type: 'Not Valid', host: 'h', port: 1, user: 'u' }] } } });
  assert.equal(imp.status, 400);
  imp = await srv.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: { dbFolders: [], dbConnections: [{ id: 'z', label: 'Z', type: 'db2', host: 'h', port: 1, user: 'u' }] } } });
  assert.equal(imp.status, 200, imp.text);
});
