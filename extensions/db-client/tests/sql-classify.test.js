const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classify, schemaChange, describeParams, bindParams } = require('../sql');
const { escape } = require('mysql2');

const kind = sql => classify(sql).kind;

test('letture eseguibili senza conferma', () => {
  for (const sql of [
    'SELECT * FROM clienti',
    'select id, nome from clienti where nome = \'DELETE FROM x\' -- update y',
    'SELECT REPLACE(nome, "a", "b"), INSERT(nome, 1, 2, "x") FROM t',
    'SHOW TABLES', 'SHOW CREATE TABLE clienti', 'DESCRIBE clienti', 'DESC clienti',
    'EXPLAIN SELECT 1', 'EXPLAIN DELETE FROM clienti', 'EXPLAIN ANALYZE SELECT * FROM t',
    'WITH x AS (SELECT 1) SELECT * FROM x', 'TABLE clienti', 'VALUES ROW(1, 2)',
    '  /* commento */ SELECT 1 ;  ', 'SELECT `update`, `delete` FROM `insert`',
  ]) assert.equal(kind(sql), 'read', sql);
});

test('scritture e istruzioni sconosciute richiedono conferma', () => {
  for (const sql of [
    'INSERT INTO clienti (nome) VALUES ("x")', 'UPDATE clienti SET nome = "x"', 'DELETE FROM clienti',
    'REPLACE INTO t VALUES (1)', 'CREATE TABLE t (id INT)', 'ALTER TABLE t ADD c INT', 'DROP TABLE t',
    'TRUNCATE t', 'RENAME TABLE a TO b', 'GRANT ALL ON *.* TO x', 'CALL proc()', 'SET @a = 1',
    'LOCK TABLES t WRITE', 'BEGIN', 'COMMIT', 'START TRANSACTION', 'OPTIMIZE TABLE t', 'qualcosa di strano',
    'WITH x AS (SELECT 1) DELETE FROM t', 'SELECT * INTO OUTFILE "/tmp/x" FROM t', 'SELECT 1 INTO @v',
    'SELECT * FROM t FOR UPDATE', 'SELECT * FROM t LOCK IN SHARE MODE', 'EXPLAIN ANALYZE DELETE FROM t',
    '/*!40101 DELETE FROM t */', 'SELECT 1 /*! , (DELETE FROM t) */',
    '-- commento\nDELETE FROM t',
  ]) assert.equal(kind(sql), 'write', sql);
});

test('più istruzioni, USE e testo vuoto vengono rifiutati', () => {
  assert.equal(kind('SELECT 1; DELETE FROM t'), 'invalid');
  assert.equal(kind('SELECT 1;'), 'read');
  assert.equal(kind('SELECT ";"'), 'read');
  assert.equal(kind('USE altro_db'), 'invalid');
  assert.equal(kind('   -- solo commento'), 'empty');
  assert.equal(kind(null), 'invalid');
});

test('istruzioni di schema: tabella e operazione per il nome della migration', () => {
  const cases = [
    ['CREATE TABLE IF NOT EXISTS `app`.`ordini` (id INT, x DECIMAL(10,2))', 'ordini', 'create'],
    ["ALTER TABLE ordini ADD COLUMN stato VARCHAR(20) NOT NULL DEFAULT 'a,b'", 'ordini', 'add_stato'],
    ['ALTER TABLE ordini ADD stato INT, DROP note', 'ordini', 'alter'],
    ['alter table app.ordini drop column `note`;', 'ordini', 'drop_note'],
    ['ALTER TABLE t ADD UNIQUE INDEX ux_mail (mail)', 't', 'add_index_ux_mail'],
    ['ALTER TABLE t CHANGE a b INT', 't', 'rename_a'],
    ['ALTER TABLE t MODIFY a BIGINT', 't', 'modify_a'],
    ['CREATE INDEX ix_a ON t (a)', 't', 'add_index_ix_a'],
    ['DROP INDEX ix_a ON db.t', 't', 'drop_index_ix_a'],
    ['RENAME TABLE a TO b', 'a', 'rename'],
    ['DROP TABLE IF EXISTS vecchia', 'vecchia', 'drop'],
    ['-- commento\nALTER TABLE t RENAME TO t2', 't', 'rename'],
  ];
  for (const [sql, table, operation] of cases) assert.deepEqual(schemaChange(sql), { table, operation }, sql);
  assert.equal(schemaChange('SELECT 1'), null);
});

test('query parametriche: segnaposto fuori da stringhe e commenti, nomi ricavati dalla query', () => {
  const names = sql => describeParams(sql).map(p => p.name);
  assert.deepEqual(names('SELECT * FROM clienti c WHERE c.nome = ? AND note LIKE ? AND id IN (?, ?) AND creato BETWEEN ? AND ? LIMIT ?, ?'),
    ['nome', 'note', 'id', 'id_2', 'creato_min', 'creato_max', 'offset', 'limit']);
  assert.deepEqual(names('INSERT INTO clienti (nome, `note`) VALUES (?, ?)'), ['nome', 'note']);
  assert.deepEqual(names('UPDATE t SET `stato` = ? WHERE ? = id LIMIT ?'), ['stato', 'id', 'limit']);
  assert.deepEqual(names('SELECT COALESCE(?, 1)'), ['param_1']);
  // :nome ripetuto → un solo valore; niente ? o :x dentro stringhe, commenti e backtick; niente :: e :=
  const p = describeParams("SELECT * FROM t WHERE a = :nome OR b = :nome AND x = '? :no' -- ? :no\n AND `c?` = ? AND @v := 2 AND y = 'a'::text");
  assert.deepEqual(p.map(x => [x.key, x.name, x.kind]), [['nome', 'nome', 'named'], ['#1', 'c_', 'positional']]);
  assert.deepEqual(describeParams('SELECT 1'), []);
  assert.deepEqual(describeParams('lbl: BEGIN END'), []); // etichetta, non un parametro
});

test('query parametriche: valori escapati al posto dei segnaposto', () => {
  const sql = "SELECT * FROM t WHERE a = :nome AND b = ? AND c = :nome AND d = '?'";
  assert.deepEqual(bindParams(sql, { nome: "o'k" }, escape), { missing: ['#1'] });
  assert.equal(bindParams(sql, { nome: "o'k", '#1': null }, escape).sql, "SELECT * FROM t WHERE a = 'o\\'k' AND b = NULL AND c = 'o\\'k' AND d = '?'");
  assert.equal(bindParams('SELECT * FROM t LIMIT ?', { '#1': 10 }, escape).sql, 'SELECT * FROM t LIMIT 10');
});

test('conteggio delle righe totali: COUNT(*) della SELECT senza il suo LIMIT finale', () => {
  const { countQuery } = require('../sql');
  const wrap = body => `SELECT COUNT(*) FROM (\n${body}\n) AS kelbo_count`;
  assert.deepEqual(countQuery('SELECT * FROM t LIMIT 100;'), { sql: wrap('SELECT * FROM t'), limit: { count: 100, offset: 0 } });
  assert.deepEqual(countQuery("select a from t where x = 'LIMIT 5' limit 10, 20"), { sql: wrap("select a from t where x = 'LIMIT 5'"), limit: { count: 20, offset: 10 } });
  assert.deepEqual(countQuery('SELECT * FROM t LIMIT 5 OFFSET 10 -- fine'), { sql: wrap('SELECT * FROM t'), limit: { count: 5, offset: 10 } });
  // LIMIT di una sottoquery o di una CTE: resta (è parte della query)
  assert.deepEqual(countQuery('SELECT * FROM (SELECT * FROM t LIMIT 3) x'), { sql: wrap('SELECT * FROM (SELECT * FROM t LIMIT 3) x'), limit: null });
  assert.equal(countQuery('WITH c AS (SELECT 1) SELECT * FROM c').limit, null);
  // non SELECT: niente conteggio
  for (const q of ['SHOW TABLES', 'DESCRIBE t', 'EXPLAIN SELECT 1', '']) assert.equal(countQuery(q), null);
});

test('più istruzioni: separate da ; fuori da stringhe, identificatori e commenti', () => {
  const { splitStatements } = require('../sql');
  const parts = s => splitStatements(s).map(x => x.sql);
  assert.deepEqual(parts('SELECT 1'), ['SELECT 1']);
  assert.deepEqual(parts('SELECT 1;'), ['SELECT 1']);
  assert.deepEqual(parts("SELECT 'a;b'; SELECT \"c;d\"; SELECT `e;f` FROM t"), ["SELECT 'a;b'", 'SELECT "c;d"', 'SELECT `e;f` FROM t']);
  assert.deepEqual(parts("SELECT 'it''s; ok'; SELECT 'x\\';y'"), ["SELECT 'it''s; ok'", "SELECT 'x\\';y'"]);
  assert.deepEqual(parts('SELECT 1 -- a; b\n; /* c; d */ SELECT 2 # e; f\n'), ['SELECT 1 -- a; b', '/* c; d */ SELECT 2 # e; f']);
  assert.deepEqual(parts(' ;; -- solo commenti;\n /* x */ ;'), []);
  assert.deepEqual(splitStatements('SELECT 1;\n  SELECT 2').map(x => x.start), [0, 12]);
});
