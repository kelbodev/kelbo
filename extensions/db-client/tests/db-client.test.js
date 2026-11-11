const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../../../lib/testkit');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv.stop());

test('estensione db-client caricata con mysql2 dalla workspace', async () => {
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'db-client');
  assert.equal(ext.state, 'ok');
  assert.deepEqual(ext.export.map(x => x.sections), [['dbConnections', 'dbFolders', 'vault']]);
  const info = (await srv.request('GET', '/api/ext/db-client/info')).json;
  assert.equal(info.driver, 'mysql2');
  assert.equal(info.ready, true);
});

const fs = require('fs');
const vaultLib = require('../../../lib/vault-crypto');
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('vault del core: le password delle connessioni già salvate restano leggibili, il cambio le ri-cifra, il reset le cancella', async () => {
  await srv.request('POST', '/api/core/vault/init', { body: { password: 'master-password-1' } });
  // una connessione con password cifrata con la chiave attuale, come la salvavano le versioni 1.x
  const cfg = srv.readConfig();
  const key = await vaultLib.openVault(cfg.vault, 'master-password-1');
  cfg.dbConnections = [
    { id: 'db1', label: 'DB 1', type: 'mysql', host: 'db.local', port: 3306, user: 'u', password: vaultLib.encrypt(key, 'segreto-db-1') },
    { id: 'db2', label: 'DB 2', type: 'mysql', host: 'db.local', port: 3306, user: 'u', password: null },
  ];
  fs.writeFileSync(srv.configPath, JSON.stringify(cfg));

  let r = await srv.request('POST', '/api/core/vault/change', { body: { oldPassword: 'master-password-1', newPassword: 'nuova-master-2' } });
  assert.deepEqual(r.json, { ok: true, reencrypted: 1 });

  const after = srv.readConfig();
  assert.equal(await vaultLib.openVault(after.vault, 'master-password-1'), null);
  const newKey = await vaultLib.openVault(after.vault, 'nuova-master-2');
  assert.equal(vaultLib.decrypt(newKey, after.dbConnections[0].password), 'segreto-db-1');
  assert.doesNotMatch(fs.readFileSync(srv.configPath, 'utf8'), /segreto-db-1|nuova-master-2/);

  assert.equal((await srv.request('POST', '/api/core/vault/reset', { body: {} })).status, 400);
  r = await srv.request('POST', '/api/core/vault/reset', { body: { confirm: 'RESET' } });
  assert.equal(r.json.state, 'uninitialized');
  const reset = srv.readConfig();
  assert.equal(reset.vault, null);
  assert.deepEqual(reset.dbConnections.map(c => c.password), [null, null]);
});

// ---- connessioni (con un MySQL usa e getta, se mysqld è installato) ----
const { startMysql, isMariaDb } = require('./mysql');
// tipi e valori come li restituisce MySQL (MariaDB: int(11), JSON come longtext, COUNT come numero)
const MYSQL_ONLY = { skip: isMariaDb() ? 'MariaDB: tipi e valori diversi da MySQL' : false };
const path = require('path');
const { tmpDir } = require('../../../lib/testkit');

test('connessioni: CRUD, password mai esposte, prova di connessione', async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer({ groups: [], servers: [{ key: 'bastion', label: 'Bastion', port: 46010, remote: 'db:3306', alias: 'devdock-test.invalid' }], projects: [] });
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' || m === 'PUT' ? {} : undefined) });
    const conn = { id: 'locale', label: 'MySQL locale', host: '127.0.0.1', port: mysqlDb.port, database: 'app', user: 'devdock', password: 'devdock-pass' };

    // senza vault non si salvano password
    assert.equal((await api('POST', '/connections', conn)).status, 423);
    await api('POST', '/vault/init', { password: 'master-password-db' });

    for (const bad of [{ ...conn, id: 'x y' }, { ...conn, id: 'h', host: 'a b' }, { ...conn, id: 'p', port: 70000 }, { ...conn, id: 'd', database: 'a`b' }, { ...conn, id: 't', tunnel: 'inesistente' }]) {
      assert.equal((await api('POST', '/connections', bad)).status, 400, JSON.stringify(bad));
    }
    let r = await api('POST', '/connections', conn);
    assert.equal(r.status, 200);
    assert.equal(r.json.connection.hasPassword, true);
    assert.equal(r.json.connection.password, undefined);
    assert.equal((await api('POST', '/connections', conn)).status, 409);
    assert.doesNotMatch(fs.readFileSync(s.configPath, 'utf8'), /devdock-pass/);

    const list = (await api('GET', '/connections')).json;
    assert.equal(list.tunnelsAvailable, true);
    assert.deepEqual(Object.keys(list.connections[0]).sort(), ['database', 'hasPassword', 'host', 'id', 'label', 'port', 'readOnly', 'type', 'user']);

    r = await api('POST', '/connections/locale/test');
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.version, /^\d+\./);
    assert.equal(r.json.db, 'app');

    // modifica senza password: quella salvata resta
    r = await api('PUT', '/connections/locale', { label: 'Rinominata', password: '' });
    assert.equal(r.json.connection.label, 'Rinominata');
    assert.equal((await api('POST', '/connections/locale/test')).status, 200);

    // password sbagliata → errore del server MySQL
    await api('PUT', '/connections/locale', { password: 'sbagliata' });
    r = await api('POST', '/connections/locale/test');
    assert.equal(r.status, 502);
    assert.match(r.json.error, /Access denied/);

    // vault bloccato → 423
    await api('PUT', '/connections/locale', { password: 'devdock-pass' });
    await api('POST', '/vault/lock');
    assert.equal((await api('POST', '/connections/locale/test')).status, 423);
    await api('POST', '/vault/unlock', { password: 'master-password-db' });

    // via tunnel: il tunnel viene avviato, ssh fallisce subito sull'host .invalid
    r = await api('POST', '/connections', { id: 'via-tunnel', label: 'Via tunnel', tunnel: 'bastion', user: 'devdock' });
    assert.equal(r.status, 200);
    assert.equal(r.json.connection.host, undefined);
    r = await api('POST', '/connections/via-tunnel/test');
    assert.equal(r.status, 502);
    assert.match(r.json.error, /Tunnel "Bastion" non pronto/);

    assert.equal((await api('DELETE', '/connections/via-tunnel')).status, 200);
    assert.deepEqual((await api('GET', '/connections')).json.connections.map(c => c.id), ['locale']);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('connessioni via tunnel non disponibili se l\'estensione tunnels non è attiva', async () => {
  // cartella estensioni con il solo db-client e il suo motore MySQL
  const dir = tmpDir('devdock-ext-db-');
  fs.symlinkSync(path.join(__dirname, '..'), path.join(dir, 'db-client'));
  fs.symlinkSync(path.join(__dirname, '..', '..', 'db-mysql'), path.join(dir, 'db-mysql'));
  const s = await startServer(undefined, { env: { DEVDOCK_EXTENSIONS_DIR: dir } });
  try {
    const ext = (await s.request('GET', '/api/core/extensions')).json.find(e => e.code === 'db-client');
    assert.equal(ext.state, 'warning');
    await s.request('POST', '/api/core/vault/init', { body: { password: 'master-password-db' } });
    assert.equal((await s.request('GET', '/api/ext/db-client/connections')).json.tunnelsAvailable, false);
    const r = await s.request('POST', '/api/ext/db-client/connections', { body: { id: 'x', label: 'X', tunnel: 'qualsiasi', user: 'u' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Tunnels SSH non attiva/);
  } finally {
    await s.stop();
  }
});

test('query: letture subito, scritture solo con la conferma della stessa istruzione', async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer();
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' || m === 'PUT' ? {} : undefined) });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    const base = { label: 'L', host: '127.0.0.1', port: mysqlDb.port, user: 'devdock', password: 'devdock-pass', database: 'app' };
    await api('POST', '/connections', { ...base, id: 'rw' });
    await api('POST', '/connections', { ...base, id: 'ro', readOnly: true });
    const q = (id, body) => api('POST', `/connections/${id}/query`, body);

    // query parametriche: prima i parametri da chiedere, poi i valori escapati nel testo
    let p = await q('rw', { sql: 'SELECT nome FROM clienti WHERE id > :min AND nome <> ? ORDER BY id LIMIT ?' });
    assert.equal(p.status, 422);
    assert.deepEqual(p.json.params.map(x => [x.key, x.name]), [['min', 'min'], ['#1', 'nome'], ['#2', 'limit']]);
    p = await q('rw', { sql: 'SELECT nome FROM clienti WHERE id > :min AND nome <> ? ORDER BY id LIMIT ?', params: { min: 0, '#1': "Ros'si", '#2': 2 } });
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.rows, [['Rossi'], ['Bianchi']]);
    assert.equal(p.json.sql, "SELECT nome FROM clienti WHERE id > 0 AND nome <> 'Ros\\'si' ORDER BY id LIMIT 2");
    assert.equal((await q('rw', { sql: 'SELECT ?', params: {} })).json.code, 'db-client.params_missing');
    assert.equal((await q('rw', { sql: 'SELECT ?', params: { '#1': { x: 1 } } })).json.code, 'db-client.params_invalid');
    // scrittura parametrica: la conferma riguarda l'istruzione con i valori
    p = await q('rw', { sql: 'UPDATE clienti SET note = :nota WHERE id = :id', params: { nota: 'x', id: 99 } });
    assert.equal(p.status, 428);
    assert.equal(p.json.sql, "UPDATE clienti SET note = 'x' WHERE id = 99");

    // lettura: colonne, righe come array, NULL conservati
    let r = await q('rw', { sql: 'SELECT id, nome, note FROM clienti ORDER BY id' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.kind, 'rows');
    assert.deepEqual(r.json.columns.map(c => c.name), ['id', 'nome', 'note']);
    assert.deepEqual(r.json.rows, [[1, 'Rossi', null], [2, 'Bianchi', 'cliente storico'], [3, 'Verdi', '']]);
    assert.equal(r.json.truncated, false);

    // limite di righe
    r = await q('rw', { sql: 'SELECT * FROM clienti', limit: 2 });
    assert.equal(r.json.rowCount, 2);
    assert.equal(r.json.truncated, true);

    // scrittura: prima risposta 428 con il token, nessuna modifica eseguita
    const ins = "INSERT INTO clienti (nome) VALUES ('Neri')";
    r = await q('rw', { sql: ins });
    assert.equal(r.status, 428);
    assert.equal(r.json.verb, 'INSERT');
    const token = r.json.token;
    assert.equal((await q('rw', { sql: 'SELECT COUNT(*) FROM clienti' })).json.rows[0][0], '3'); // BIGINT come stringa: nessuna perdita di precisione

    // il token non vale per un testo diverso, né per un'altra connessione
    assert.equal((await q('rw', { sql: ins + ' ', confirm: token })).status, 428);
    assert.equal((await q('rw', { sql: "INSERT INTO clienti (nome) VALUES ('Altro')", confirm: token })).status, 428);
    assert.equal((await q('rw', { sql: ins, confirm: 'falso' })).status, 428);

    r = await q('rw', { sql: ins, confirm: token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.kind, 'result');
    assert.equal(r.json.affectedRows, 1);
    assert.equal(r.json.insertId, 4);
    assert.equal((await q('rw', { sql: 'SELECT COUNT(*) FROM clienti' })).json.rows[0][0], '4');

    // DDL: stessa regola
    r = await q('rw', { sql: 'CREATE TABLE prova (id INT)' });
    assert.equal(r.status, 428);
    assert.equal((await q('rw', { sql: 'CREATE TABLE prova (id INT)', confirm: r.json.token })).json.kind, 'result');
    assert.equal((await q('rw', { sql: "SHOW TABLES LIKE 'prova'" })).json.rowCount, 1);

    // sola lettura: scritture rifiutate anche con un token
    r = await q('ro', { sql: 'DELETE FROM clienti' });
    assert.equal(r.status, 403);
    assert.equal((await q('ro', { sql: 'SELECT COUNT(*) FROM clienti' })).json.rows[0][0], '4');

    // istruzioni non accettate ed errori del server
    // più istruzioni con una scrittura: conferma del gruppo intero, come per una sola
    r = await q('rw', { sql: 'SELECT 1; DELETE FROM clienti' });
    assert.deepEqual([r.status, r.json.verb, r.json.statements, r.json.writes, r.json.sql], [428, 'DELETE', 2, 1, 'SELECT 1; DELETE FROM clienti']);
    assert.equal((await q('ro', { sql: 'SELECT 1; DELETE FROM clienti' })).status, 403);
    r = await q('rw', { sql: 'SELECT 1; USE mysql' });
    assert.deepEqual([r.status, r.json.code, r.json.params.n], [400, 'db-client.batch_statement', 2]);
    assert.equal((await q('rw', { sql: 'USE mysql' })).status, 400);
    r = await q('rw', { sql: 'SELECT * FROM tabella_inesistente' });
    assert.equal(r.status, 400);
    assert.equal(r.json.params.dbCode, 'ER_NO_SUCH_TABLE');

    // database
    r = await api('GET', '/connections/rw/databases');
    assert.ok(r.json.databases.includes('app'));
    assert.equal(r.json.default, 'app');

    // più istruzioni: solo letture subito, ciascuna con il suo risultato, stessa sessione
    r = await q('rw', { sql: "SELECT id, nome FROM clienti ORDER BY id LIMIT 2;\n-- commento; con punto e virgola\nSELECT 'a;b' AS x;  SHOW TABLES LIKE 'clienti';", limit: 1 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.kind, r.json.statements, r.json.failed], ['batch', 3, null]);
    assert.deepEqual(r.json.results.map(x => [x.n, x.kind, x.rowCount]), [[1, 'rows', 1], [2, 'rows', 1], [3, 'rows', 1]]);
    assert.deepEqual([r.json.results[0].truncated, r.json.results[0].total, r.json.results[0].queryLimit.count, r.json.results[1].rows], [true, 4, 2, [['a;b']]]);
    assert.equal(r.json.results[1].sql, "-- commento; con punto e virgola\nSELECT 'a;b' AS x");

    // scritture e letture insieme dopo la conferma, sulla stessa connessione (@variabile e
    // tabella temporanea restano), fermandosi al primo errore
    const batch = "SET @n := 'Lotto'; CREATE TEMPORARY TABLE tmp_b (v INT); INSERT INTO tmp_b VALUES (1),(2); INSERT INTO clienti (nome) VALUES (@n); SELECT COUNT(*) FROM tmp_b; SELECT nome FROM clienti WHERE nome = @n; SELECT * FROM non_esiste; DELETE FROM clienti";
    r = await q('rw', { sql: batch });
    assert.equal(r.status, 428);
    assert.equal(r.json.verb, 'SET, CREATE, INSERT, DELETE');
    r = await q('rw', { sql: batch, confirm: r.json.token });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.statements, r.json.failed, r.json.skipped], [8, 7, 1]);
    assert.deepEqual(r.json.results.map(x => x.kind), ['result', 'result', 'result', 'result', 'rows', 'rows', 'error']);
    assert.equal(r.json.results[2].affectedRows, 2);
    assert.equal(String(r.json.results[4].rows[0][0]), '2');
    assert.deepEqual(r.json.results[5].rows, [['Lotto']]);
    assert.equal(r.json.results[6].dbCode, 'ER_NO_SUCH_TABLE');
    assert.ok((await q('rw', { sql: 'SELECT COUNT(*) FROM clienti' })).json.rows[0][0] > 0); // il DELETE dopo l'errore non è partito
    // il token vale per quel testo: un'istruzione in più chiede di nuovo la conferma
    assert.equal((await q('rw', { sql: `${batch}; DELETE FROM clienti`, confirm: 'x' })).status, 428);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('schema: tabelle e struttura di una tabella', MYSQL_ONLY, async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer();
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    await api('POST', '/connections', { id: 'c', label: 'C', host: '127.0.0.1', port: mysqlDb.port, user: 'devdock', password: 'devdock-pass' });
    // tabella con indice e chiave esterna (DDL confermato)
    const ddl = 'CREATE TABLE ordini (id INT PRIMARY KEY, cliente_id INT NOT NULL, totale DECIMAL(10,2) DEFAULT 0 COMMENT "euro", UNIQUE KEY u_cli (cliente_id, id), FOREIGN KEY (cliente_id) REFERENCES clienti(id))';
    const first = await api('POST', '/connections/c/query', { sql: ddl, database: 'app' });
    assert.equal((await api('POST', '/connections/c/query', { sql: ddl, database: 'app', confirm: first.json.token })).status, 200);

    const tables = (await api('GET', '/connections/c/databases/app/tables')).json.tables;
    assert.deepEqual(tables.map(t => t.name), ['clienti', 'ordini']);
    assert.equal(tables[0].view, false);

    const info = (await api('GET', '/connections/c/databases/app/tables/ordini')).json;
    assert.deepEqual(info.columns.map(c => [c.name, c.type, c.nullable, c.key]), [
      ['id', 'int', false, 'PRI'], ['cliente_id', 'int', false, 'MUL'], ['totale', 'decimal(10,2)', true, ''],
    ]);
    assert.equal(info.columns[2].comment, 'euro');
    assert.deepEqual(info.indexes.find(i => i.name === 'u_cli'), { name: 'u_cli', unique: true, columns: ['cliente_id', 'id'] });
    assert.deepEqual(info.foreignKeys.map(f => [f.columns, f.refTable, f.refColumns]), [[['cliente_id'], 'clienti', ['id']]]);

    assert.equal((await api('GET', '/connections/c/databases/app/tables/inesistente')).status, 404);
    assert.equal((await api('GET', '/connections/c/databases/a%60b/tables')).status, 400);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('anteprima dati: pagine, ricerca, filtri, ordinamento con parametri', async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer();
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    await api('POST', '/connections', { id: 'c', label: 'C', host: '127.0.0.1', port: mysqlDb.port, user: 'devdock', password: 'devdock-pass' });
    // 60 righe in più (INSERT confermato)
    const values = Array.from({ length: 60 }, (_, i) => `('Cliente ${String(i).padStart(2, '0')}', ${i % 2 ? 'NULL' : "'pari'"})`).join(',');
    const ins = `INSERT INTO clienti (nome, note) VALUES ${values}`;
    const first = await api('POST', '/connections/c/query', { sql: ins, database: 'app' });
    await api('POST', '/connections/c/query', { sql: ins, database: 'app', confirm: first.json.token });
    const rows = body => api('POST', '/connections/c/databases/app/tables/clienti/rows', body);

    let r = await rows({ pageSize: 25, page: 2 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 63);
    assert.equal(r.json.rows.length, 25);
    assert.equal(r.json.rows[0][0], 26);
    assert.deepEqual(r.json.primaryKey, ['id']);

    r = await rows({ search: 'storico' });
    assert.deepEqual(r.json.rows, [[2, 'Bianchi', 'cliente storico']]);
    // i caratteri jolly cercati sono letterali
    assert.equal((await rows({ search: '%' })).json.total, 0);

    r = await rows({ filters: [{ column: 'note', op: 'null' }, { column: 'nome', op: 'starts', value: 'Cliente 1' }], sort: { column: 'id', dir: 'desc' } });
    assert.deepEqual(r.json.rows.map(x => x[1]), ['Cliente 19', 'Cliente 17', 'Cliente 15', 'Cliente 13', 'Cliente 11']);

    // valori e nomi non entrano mai come SQL
    r = await rows({ filters: [{ column: 'nome', op: 'eq', value: "x' OR '1'='1" }] });
    assert.equal(r.json.total, 0);
    assert.equal((await rows({ filters: [{ column: 'nome; DROP TABLE clienti', op: 'eq', value: 1 }] })).status, 400);
    assert.equal((await rows({ filters: [{ column: 'nome', op: 'OR 1=1', value: 1 }] })).status, 400);
    assert.equal((await rows({ sort: { column: 'id`; DROP TABLE x; --' } })).status, 400);
    assert.equal((await rows({ pageSize: 999999 })).json.pageSize, 50);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('righe: insert, update e delete generati dal server e solo dopo conferma', async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer();
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    const base = { label: 'C', host: '127.0.0.1', port: mysqlDb.port, user: 'devdock', password: 'devdock-pass' };
    await api('POST', '/connections', { ...base, id: 'c' });
    await api('POST', '/connections', { ...base, id: 'ro', readOnly: true });
    const row = (body, id = 'c') => api('POST', `/connections/${id}/databases/app/tables/clienti/row`, body);
    const count = async () => (await api('POST', '/connections/c/query', { sql: 'SELECT COUNT(*) FROM app.clienti' })).json.rows[0][0];

    // update: prima il 428 con l'SQL generato (valori escapati), nessuna modifica
    const upd = { op: 'update', key: { id: 2 }, values: { note: "l'aggiornata", nome: 'Bianchi' } };
    let r = await row(upd);
    assert.equal(r.status, 428);
    assert.equal(r.json.sql, "UPDATE `app`.`clienti` SET `note` = 'l\\'aggiornata', `nome` = 'Bianchi' WHERE `id` = 2 LIMIT 1");
    r = await row({ ...upd, confirm: r.json.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.affectedRows, 1);
    // il token non vale per valori diversi
    const other = await row({ ...upd, values: { note: 'altro' } });
    assert.equal((await row({ op: 'update', key: { id: 2 }, values: { note: 'altro' }, confirm: r.json.token })).status, 428);
    assert.equal(other.status, 428);

    // insert con NULL
    const ins = { op: 'insert', values: { nome: 'Gialli', note: null } };
    r = await row(ins);
    assert.match(r.json.sql, /^INSERT INTO `app`.`clienti` \(`nome`, `note`\) VALUES \('Gialli', NULL\)$/);
    r = await row({ ...ins, confirm: r.json.token });
    assert.equal(r.json.insertId, 4);
    assert.equal(await count(), '4');

    // delete
    r = await row({ op: 'delete', key: { id: 4 } });
    assert.equal(r.json.sql, 'DELETE FROM `app`.`clienti` WHERE `id` = 4 LIMIT 1');
    await row({ op: 'delete', key: { id: 4 }, confirm: r.json.token });
    assert.equal(await count(), '3');

    // eliminazione multipla: una sola istruzione, sempre con conferma
    await api('POST', '/connections/c/query', { sql: "INSERT INTO app.clienti (nome) VALUES ('a'),('b'),('c')" }).then(r =>
      api('POST', '/connections/c/query', { sql: "INSERT INTO app.clienti (nome) VALUES ('a'),('b'),('c')", confirm: r.json.token }));
    const many = { op: 'delete-many', keys: [{ id: 5 }, { id: 6 }, { id: 7 }] };
    r = await row(many);
    assert.equal(r.status, 428);
    assert.equal(r.json.sql, 'DELETE FROM `app`.`clienti` WHERE `id` IN (5, 6, 7) LIMIT 3');
    r = await row({ ...many, confirm: r.json.token });
    assert.equal(r.json.affectedRows, 3);
    assert.equal(await count(), '3');
    assert.equal((await row({ op: 'delete-many', keys: [] })).status, 400);
    assert.equal((await row({ op: 'delete-many', keys: [{ nome: 'x' }] })).status, 400);

    // più righe modificate insieme: un UPDATE per riga, una conferma, un'unica transazione
    const sel = async () => (await api('POST', '/connections/c/query', { sql: 'SELECT id, nome, note FROM app.clienti ORDER BY id' })).json.rows;
    const multi = { op: 'update-many', changes: [{ key: { id: 1 }, values: { note: 'uno' } }, { key: { id: 3 }, values: { nome: 'Verdini', note: null } }] };
    r = await row(multi);
    assert.equal(r.status, 428);
    assert.equal(r.json.sql, "UPDATE `app`.`clienti` SET `note` = 'uno' WHERE `id` = 1 LIMIT 1;\nUPDATE `app`.`clienti` SET `nome` = 'Verdini', `note` = NULL WHERE `id` = 3 LIMIT 1");
    r = await row({ ...multi, confirm: r.json.token });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.affectedRows, r.json.statements], [2, 2]);
    assert.deepEqual((await sel()).map(x => [x[1], x[2]]), [['Rossi', 'uno'], ['Bianchi', "l'aggiornata"], ['Verdini', null]]);
    // se un'istruzione fallisce non resta nessuna modifica (rollback)
    const failing = { op: 'update-many', changes: [{ key: { id: 1 }, values: { note: 'mai' } }, { key: { id: 2 }, values: { nome: null } }] };
    r = await row(failing);
    r = await row({ ...failing, confirm: r.json.token });
    assert.equal(r.status, 400);
    assert.equal((await sel())[0][2], 'uno');
    assert.equal((await row({ op: 'update-many', changes: [] })).status, 400);
    assert.equal((await row({ op: 'update-many', changes: [{ key: { nome: 'x' }, values: { note: 'x' } }] })).status, 400);
    assert.equal((await row({ op: 'update-many', changes: [{ key: { id: 1 }, values: {} }] })).status, 400);

    // controlli
    assert.equal((await row({ op: 'update', values: { nome: 'x' } })).status, 400);                       // senza chiave
    assert.equal((await row({ op: 'update', key: { id: 1 }, values: { 'nome`=1;--': 'x' } })).status, 400); // colonna sconosciuta
    assert.equal((await row({ op: 'update', key: { id: 1 }, values: { nome: { toSqlString: () => 'x' } } })).status, 400);
    assert.equal((await row({ op: 'truncate' })).status, 400);
    assert.equal((await row(ins, 'ro')).status, 403);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('export CSV, JSON e SQL di tabelle (con filtri) e di SELECT', MYSQL_ONLY, async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer();
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    await api('POST', '/connections', { id: 'c', label: 'C', host: '127.0.0.1', port: mysqlDb.port, user: 'devdock', password: 'devdock-pass', database: 'app' });
    // un valore con virgolette, virgola e a capo
    let r = await api('POST', '/connections/c/query', { sql: `UPDATE clienti SET note = 'una "nota", su\ndue righe' WHERE id = 1` });
    await api('POST', '/connections/c/query', { sql: `UPDATE clienti SET note = 'una "nota", su\ndue righe' WHERE id = 1`, confirm: r.json.token });

    const download = async body => {
      const created = await api('POST', '/connections/c/exports', body);
      assert.equal(created.status, 200, created.text);
      const file = await api('GET', `/connections/c/exports/${created.json.id}`);
      assert.equal(file.status, 200);
      // usa e getta
      assert.equal((await api('GET', `/connections/c/exports/${created.json.id}`)).status, 404);
      return { ...file, filename: created.json.filename };
    };

    let f = await download({ format: 'csv', source: { type: 'table', db: 'app', table: 'clienti', sort: { column: 'id' } } });
    assert.match(f.headers['content-disposition'], /clienti-.*\.csv/);
    assert.equal(f.text, 'id,nome,note\r\n1,Rossi,"una ""nota"", su\ndue righe"\r\n2,Bianchi,cliente storico\r\n3,Verdi,""\r\n');

    f = await download({ format: 'json', source: { type: 'table', db: 'app', table: 'clienti', filters: [{ column: 'nome', op: 'starts', value: 'B' }] } });
    assert.deepEqual(JSON.parse(f.text), [{ id: 2, nome: 'Bianchi', note: 'cliente storico' }]);

    f = await download({ format: 'sql', source: { type: 'table', db: 'app', table: 'clienti', search: 'Verdi' } });
    assert.match(f.text, /CREATE TABLE `clienti`/);
    assert.match(f.text, /INSERT INTO `clienti` \(`id`, `nome`, `note`\) VALUES\n\(3, 'Verdi', ''\);/);

    // l'SQL esportato si reimporta: tabella ricreata con gli stessi dati
    const full = await download({ format: 'sql', source: { type: 'table', db: 'app', table: 'clienti' } });
    const mysql = require('mysql2/promise');
    const root = await mysql.createConnection({ host: '127.0.0.1', port: mysqlDb.port, user: 'root', multipleStatements: true });
    await root.query('CREATE DATABASE copia; USE copia;' + full.text);
    const [rows] = await root.query('SELECT note FROM copia.clienti WHERE id = 1');
    assert.equal(rows[0].note, 'una "nota", su\ndue righe');
    await root.end();

    f = await download({ format: 'json', source: { type: 'query', sql: 'SELECT nome, LENGTH(nome) AS l FROM clienti WHERE id < 3 ORDER BY id' } });
    assert.deepEqual(JSON.parse(f.text), [{ nome: 'Rossi', l: '5' }, { nome: 'Bianchi', l: '7' }]);

    // solo letture
    r = await api('POST', '/connections/c/exports', { format: 'csv', source: { type: 'query', sql: 'DELETE FROM clienti' } });
    assert.equal(r.status, 400);
    assert.equal((await api('POST', '/connections/c/exports', { format: 'xml', source: { type: 'table', db: 'app', table: 'clienti' } })).status, 400);
    assert.equal((await api('POST', '/connections/c/exports', { format: 'csv', source: { type: 'table', db: 'app', table: 'nope' } })).status, 404);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('creazione tabella da definizione strutturata, solo dopo conferma', async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer();
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    const base = { label: 'C', host: '127.0.0.1', port: mysqlDb.port, user: 'devdock', password: 'devdock-pass' };
    await api('POST', '/connections', { ...base, id: 'c' });
    await api('POST', '/connections', { ...base, id: 'ro', readOnly: true });
    const create = (body, id = 'c') => api('POST', `/connections/${id}/databases/app/create-table`, body);
    const definition = {
      name: 'ordini', engine: 'InnoDB', charset: 'utf8mb4', comment: "ordini d'acquisto",
      columns: [
        { name: 'id', type: 'INT', autoIncrement: true },
        { name: 'cliente_id', type: 'INT' },
        { name: 'stato', type: 'ENUM', values: ['nuovo', 'spedito'], default: { kind: 'value', value: 'nuovo' } },
        { name: 'totale', type: 'DECIMAL', length: 10, scale: 2, default: { kind: 'value', value: '0' } },
        { name: 'creato', type: 'DATETIME', default: { kind: 'current_timestamp' } },
        { name: 'note', type: 'TEXT', nullable: true },
      ],
      primaryKey: ['id'],
      indexes: [{ name: 'i_stato', columns: ['stato'] }],
      foreignKeys: [{ name: 'fk_cliente', columns: ['cliente_id'], refTable: 'clienti', refColumns: ['id'], onDelete: 'CASCADE' }],
    };

    let r = await create({ definition });
    assert.equal(r.status, 428);
    assert.match(r.json.sql, /^CREATE TABLE `app`.`ordini` \(/);
    assert.equal((await api('GET', '/connections/c/databases/app/tables')).json.tables.length, 1); // ancora nulla
    r = await create({ definition, confirm: r.json.token });
    assert.equal(r.status, 200, r.text);
    const info = (await api('GET', '/connections/c/databases/app/tables/ordini')).json;
    assert.deepEqual(info.columns.map(c => c.name), ['id', 'cliente_id', 'stato', 'totale', 'creato', 'note']);
    assert.deepEqual(info.foreignKeys.map(f => f.refTable), ['clienti']);

    // definizioni non valide: nessun SQL arbitrario passa
    for (const bad of [
      { ...definition, name: '' },
      { ...definition, columns: [{ name: 'a', type: 'INT); DROP TABLE clienti; --' }] },
      { ...definition, columns: [{ name: 'a', type: 'VARCHAR' }] },
      { ...definition, foreignKeys: [{ columns: ['cliente_id'], refTable: 'clienti', refColumns: ['id'], onDelete: 'DROP' }] },
      { ...definition, engine: 'InnoDB; DROP' },
      { ...definition, primaryKey: ['inesistente'] },
    ]) assert.equal((await create({ definition: bad })).status, 400, JSON.stringify(bad).slice(0, 80));

    assert.equal((await create({ definition: { ...definition, name: 'altro' } }, 'ro')).status, 403);
    // errore di MySQL (tabella già esistente) restituito con il testo
    r = await create({ definition });
    r = await create({ definition, confirm: r.json.token });
    assert.equal(r.status, 400);
    assert.equal(r.json.params.dbCode, 'ER_TABLE_EXISTS_ERROR');
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('import di connessioni cifrate con un\'altra master password', async () => {
  // installazione A: crea vault e una connessione con password, poi esporta
  const a = await startServer();
  const b = await startServer();
  try {
    const apiA = (m, p, body) => a.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    const apiB = (m, p, body) => b.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await apiA('POST', '/vault/init', { password: 'master-di-A-123' });
    await apiA('POST', '/connections', { id: 'prod', label: 'Prod', host: 'db.local', port: 3306, user: 'u', password: 'segreto-prod' });
    const exported = (await a.request('GET', '/api/core/config/export?name=x&sections=dbConnections,vault')).json;

    // installazione B con un vault diverso e una connessione propria
    await apiB('POST', '/vault/init', { password: 'master-di-B-456' });
    await apiB('POST', '/connections', { id: 'locale', label: 'Locale', host: '127.0.0.1', port: 3306, user: 'u', password: 'segreto-locale' });

    // l'import generale rifiuta il vault diverso (le password diventerebbero illeggibili)
    let r = await b.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: exported } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /un'altra master password/);
    r = await b.request('POST', '/api/core/config/import', { body: { mode: 'replace', config: exported } });
    assert.equal(r.status, 400);

    // import dedicato: password del file errata, poi giusta
    assert.equal((await apiB('POST', '/connections/import', { config: exported, password: 'sbagliata-xx', mode: 'merge' })).status, 401);
    await new Promise(res => setTimeout(res, 50));
    r = await apiB('POST', '/connections/import', { config: exported, password: 'master-di-A-123', mode: 'merge' });
    assert.deepEqual(r.json, { ok: true, imported: 1, skipped: 0 });

    // la password importata è ora cifrata con la chiave di B
    const cfg = b.readConfig();
    const keyB = await vaultLib.openVault(cfg.vault, 'master-di-B-456');
    const prod = cfg.dbConnections.find(c => c.id === 'prod');
    assert.equal(vaultLib.decrypt(keyB, prod.password), 'segreto-prod');
    assert.deepEqual(cfg.dbConnections.map(c => c.id), ['locale', 'prod']);
    assert.doesNotMatch(fs.readFileSync(b.configPath, 'utf8'), /segreto-prod/);

    // di nuovo in merge: già presente, saltata
    r = await apiB('POST', '/connections/import', { config: exported, password: 'master-di-A-123', mode: 'merge' });
    assert.deepEqual(r.json, { ok: true, imported: 0, skipped: 1 });

    // con il vault bloccato non si importa
    await apiB('POST', '/vault/lock');
    assert.equal((await apiB('POST', '/connections/import', { config: exported, password: 'master-di-A-123', mode: 'merge' })).status, 423);
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('cartelle delle connessioni: creazione, spostamento, eliminazione, import', async () => {
  const a = await startServer();
  const b = await startServer();
  try {
    const apiA = (m, p, body) => a.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    const apiB = (m, p, body) => b.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await apiA('POST', '/vault/init', { password: 'master-di-A-123' });
    assert.equal((await apiA('POST', '/folders', { label: ' ' })).json.code, 'db-client.folder_label_required');
    const f = (await apiA('POST', '/folders', { label: ' Produzione ' })).json;
    assert.equal(f.label, 'Produzione');
    const conn = { id: 'prod', label: 'Prod', host: 'db.local', port: 3306, user: 'u', password: 'segreto-prod' };
    assert.equal((await apiA('POST', '/connections', { ...conn, folder: 'nope' })).json.code, 'db-client.folder_unknown');
    assert.equal((await apiA('POST', '/connections', { ...conn, folder: f.id })).json.connection.folder, f.id);
    await apiA('POST', '/connections', { id: 'loc', label: 'Locale', host: '127.0.0.1', port: 3306, user: 'u' });
    await apiA('PUT', `/folders/${f.id}`, { label: 'Prod remoti' });
    let list = (await apiA('GET', '/connections')).json;
    assert.deepEqual(list.folders, [{ id: f.id, label: 'Prod remoti' }]);
    assert.deepEqual(list.connections.map(c => [c.id, c.folder]), [['prod', f.id], ['loc', undefined]]);

    // import in un'altra installazione: arrivano anche le cartelle
    const exported = (await a.request('GET', '/api/core/config/export?name=x&sections=dbConnections,dbFolders,vault')).json;
    await apiB('POST', '/vault/init', { password: 'master-di-B-456' });
    const r = await apiB('POST', '/connections/import', { config: exported, password: 'master-di-A-123', mode: 'merge' });
    assert.equal(r.json.imported, 2);
    const cfgB = b.readConfig();
    assert.deepEqual(cfgB.dbFolders, [{ id: f.id, label: 'Prod remoti' }]);
    assert.equal(cfgB.dbConnections.find(c => c.id === 'prod').folder, f.id);

    // spostamento nella radice ed eliminazione della cartella
    await apiA('PUT', '/connections/loc', { label: 'Locale', user: 'u', host: '127.0.0.1', port: 3306, folder: f.id });
    await apiA('PUT', '/connections/loc', { label: 'Locale', user: 'u', host: '127.0.0.1', port: 3306, folder: '' });
    assert.equal(a.readConfig().dbConnections.find(c => c.id === 'loc').folder, undefined);
    await apiA('DELETE', `/folders/${f.id}`);
    list = (await apiA('GET', '/connections')).json;
    assert.deepEqual(list.folders, []);
    assert.ok(list.connections.every(c => c.folder === undefined));
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('valori dei parametri delle query: solo in memoria, per query e per nome', async () => {
  const s = await startServer();
  try {
    const api = (m, body) => s.request(m, '/api/ext/db-client/param-values', { body });
    const sql = 'SELECT * FROM t WHERE id = :id LIMIT ?';
    let r = await api('POST', { connection: 'c', sql, names: ['id', 'limit'] });
    assert.deepEqual(r.json, { query: null, byName: {} });
    const values = { id: { value: '7', type: 'auto' }, '#1': { value: '10', type: 'number' } };
    r = await api('PUT', { connection: 'c', sql: ` ${sql} `, params: [{ key: 'id', name: 'id' }, { key: '#1', name: 'limit' }], values });
    assert.equal(r.status, 200, r.text);
    r = await api('POST', { connection: 'c', sql, names: ['id', 'limit', 'altro'] });
    assert.deepEqual(r.json.query, values);
    assert.deepEqual(r.json.byName, { id: values.id, limit: values['#1'] });
    // altra connessione: la query non ha valori, i nomi sì
    assert.equal((await api('POST', { connection: 'd', sql, names: ['id'] })).json.query, null);
    assert.equal((await api('PUT', { connection: 'c', sql, params: [{ key: 'id', name: 'id' }], values: { id: { value: 1, type: 'auto' } } })).status, 400);
    assert.equal((await api('PUT', { connection: 'c', sql, params: [{ key: 'id', name: 'id' }], values: { id: { value: '1', type: 'boh' } } })).status, 400);
    assert.doesNotMatch(require('fs').readFileSync(s.configPath, 'utf8'), /"10"/); // niente in config.json
  } finally { await s.stop(); }
});

test('connessione con un tunnel eliminato: segnalata, errore chiaro', async () => {
  const s = await startServer({
    groups: [], projects: [],
    servers: [{ key: 'due', label: 'Due', port: 46120, remote: 'db:3306', alias: 'devdock-test.invalid' }],
    dbConnections: [{ id: 'c', label: 'C', type: 'mysql', tunnel: 'uno', user: 'u', password: null }],
  });
  try {
    const list = (await s.request('GET', '/api/ext/db-client/connections')).json.connections;
    assert.equal(list[0].tunnelMissing, true);
    const r = await s.request('GET', '/api/ext/db-client/connections/c/databases');
    assert.equal(r.json.code, 'db-client.tunnel_deleted');
    assert.equal(r.json.params.tunnel, 'uno');
  } finally { await s.stop(); }
});

test('database predefinito inesistente: l\'elenco dei database arriva comunque', async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer();
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    await api('POST', '/connections', { id: 'c', label: 'C', host: '127.0.0.1', port: mysqlDb.port, database: 'nonesiste', user: 'devdock', password: 'devdock-pass' });
    let r = await api('GET', '/connections/c/databases');
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.databases.includes('app'));
    assert.equal(r.json.defaultMissing, true);
    await api('PUT', '/connections/c', { label: 'C', database: 'app' });
    r = await api('GET', '/connections/c/databases');
    assert.equal(r.json.defaultMissing, false);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});

test('colonne JSON: mostrate come testo JSON, modificabili, esportate correttamente', MYSQL_ONLY, async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const s = await startServer();
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    const confirmed = async (p, body) => {
      const first = await api('POST', p, body);
      return first.status === 428 ? api('POST', p, { ...body, confirm: first.json.token }) : first;
    };
    await api('POST', '/vault/init', { password: 'master-password-db' });
    await api('POST', '/connections', { id: 'c', label: 'C', host: '127.0.0.1', port: mysqlDb.port, database: 'app', user: 'devdock', password: 'devdock-pass' });
    await confirmed('/connections/c/query', { sql: 'CREATE TABLE doc (id INT PRIMARY KEY, dati JSON)', database: 'app' });
    await confirmed('/connections/c/query', { sql: `INSERT INTO doc VALUES (1, '{"a": 1, "b": [true, null], "c": {"d": "x"}}')`, database: 'app' });

    let r = await api('POST', '/connections/c/databases/app/tables/doc/rows', {});
    const cellValue = r.json.rows[0][1];
    assert.equal(typeof cellValue, 'string');
    assert.deepEqual(JSON.parse(cellValue), { a: 1, b: [true, null], c: { d: 'x' } });
    assert.equal(r.json.columns[1].dataType, 'json');
    r = await api('POST', '/connections/c/query', { sql: 'SELECT dati FROM doc', database: 'app' });
    assert.deepEqual(JSON.parse(r.json.rows[0][0]), { a: 1, b: [true, null], c: { d: 'x' } });

    // modifica con testo JSON (come dalla finestra di modifica)
    r = await confirmed('/connections/c/databases/app/tables/doc/row', { op: 'update', key: { id: 1 }, values: { dati: '{"a":2}' } });
    assert.equal(r.status, 200, r.text);
    r = await api('POST', '/connections/c/databases/app/tables/doc/rows', {});
    assert.deepEqual(JSON.parse(r.json.rows[0][1]), { a: 2 });

    // export: niente "[object Object]" né `a` = 2
    for (const format of ['csv', 'sql']) {
      const job = (await api('POST', '/connections/c/exports', { format, source: { type: 'table', db: 'app', table: 'doc' } })).json;
      const file = (await s.request('GET', `/api/ext/db-client/connections/c/exports/${job.id}`)).text;
      assert.doesNotMatch(file, /object Object|`a` = 2/, format);
      assert.match(file, format === 'csv' ? /"\{""a"":2\}"/ : /'\{\\"a\\":2\}'/, format);
    }
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});
