// Pipeline delle migration con MySQL: designer/operazioni → file NNN_ nel repository →
// DDL sul database. Saltato se mysqld non è installato.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, makeRepo, git } = require('../../../lib/testkit');
const { startMysql } = require('./mysql');

const col = (name, extra = {}) => ({ name, type: 'VARCHAR', length: 50, nullable: true, default: { kind: 'none' }, ...extra });

test('migration: file nel repository, DDL, errori e schema letto di nuovo', async t => {
  const mysqlDb = await startMysql();
  if (!mysqlDb) return t.skip('mysqld non installato');
  const repo = makeRepo(path.join(tmpDir(), 'repo'));
  const dir = path.join(repo, 'db/migrations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001_clienti_create.sql'), '-- già applicata\n');
  const s = await startServer({ groups: [], servers: [], projects: [{ id: 'app', label: 'App', path: repo }] });
  try {
    const api = (m, p, body) => s.request(m, `${p.startsWith('/vault') ? '/api/core' : '/api/ext/db-client'}${p}`, { body: body ?? (m === 'POST' ? {} : undefined) });
    await api('POST', '/vault/init', { password: 'master-password-db' });
    await api('POST', '/connections', { id: 'c', label: 'Locale', host: '127.0.0.1', port: mysqlDb.port, database: 'app', user: 'devdock', password: 'devdock-pass' });
    assert.equal((await api('PUT', '/connections/c/migrations', { repo: 'app', dir: 'db/migrations' })).status, 200);
    const migrate = body => api('POST', '/connections/c/databases/app/migrate', body);

    // 1. creazione di una tabella: anteprima, poi conferma
    const operations = [{
      op: 'create_table', table: 'ordini',
      definition: {
        engine: 'InnoDB', columns: [
          { name: 'id', type: 'INT', unsigned: true, nullable: false, autoIncrement: true, default: { kind: 'none' } },
          { name: 'cliente_id', type: 'INT', nullable: false, default: { kind: 'none' } },
          col('stato', { nullable: false, default: { kind: 'value', value: 'nuovo' } }),
          { name: 'tipo', type: 'ENUM', values: ['a', "b'c"], nullable: true, default: { kind: 'none' } },
          { name: 'totale', type: 'DECIMAL', length: 10, scale: 2, nullable: false, default: { kind: 'value', value: '0.00' } },
          { name: 'creato', type: 'DATETIME', nullable: false, default: { kind: 'current_timestamp' } },
        ],
        primaryKey: ['id'],
        indexes: [{ name: 'ix_stato', columns: ['stato'], unique: false }],
        foreignKeys: [{ name: 'fk_cliente', columns: ['cliente_id'], refTable: 'clienti', refColumns: ['id'], onDelete: 'CASCADE' }],
      },
    }];
    let r = await migrate({ operations });
    assert.equal(r.status, 428);
    assert.equal(r.json.migration.file, '002_ordini_create.sql');
    assert.match(r.json.migration.content, /^-- 002_ordini_create\.sql\n-- Kelbo · Locale · app · /);
    assert.ok(r.json.migration.content.includes(r.json.statements[0] + ';'));
    assert.equal(fs.existsSync(path.join(dir, '002_ordini_create.sql')), false, 'niente file prima della conferma');

    r = await migrate({ operations, confirm: r.json.token });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.file, '002_ordini_create.sql');
    assert.ok(fs.readFileSync(path.join(dir, '002_ordini_create.sql'), 'utf8').includes('CREATE TABLE `app`.`ordini`'));
    assert.ok(!fs.existsSync(path.join(dir, '.devdock-schema.json')), 'nessuno snapshot');
    assert.equal((await api('GET', '/connections/c/migrations')).json.nextPrefix, '003');

    // 2. lo schema letto dal DB rigenera la stessa tabella (andata e ritorno del modello)
    const def = (await api('GET', '/connections/c/databases/app/tables/ordini/definition')).json.definition;
    assert.deepEqual(def.columns.find(c => c.name === 'tipo').values, ['a', "b'c"]);
    assert.deepEqual(def.columns.find(c => c.name === 'creato').default, { kind: 'current_timestamp' });
    assert.deepEqual(def.columns.find(c => c.name === 'stato').default, { kind: 'value', value: 'nuovo' });
    assert.equal(def.foreignKeys[0].onDelete, 'CASCADE');

    // 3. modifica distruttiva: serve la conferma esplicita degli avvisi
    const alter = [
      { op: 'add_column', table: 'ordini', column: col('note', { type: 'TEXT', length: undefined }), after: 'stato' },
      { op: 'drop_column', table: 'ordini', name: 'tipo' },
    ];
    r = await migrate({ operations: alter, migration: { operation: 'note_e_tipo' } });
    assert.equal(r.json.migration.file, '003_ordini_note_e_tipo.sql');
    assert.deepEqual(r.json.warnings.map(w => w.key), ['drop_column']);
    assert.equal((await migrate({ operations: alter, migration: { operation: 'note_e_tipo' }, confirm: r.json.token })).json.code, 'db-client.warnings_not_acknowledged');
    r = await migrate({ operations: alter, migration: { operation: 'note_e_tipo' }, confirm: r.json.token, acknowledgeWarnings: true });
    assert.equal(r.status, 200, r.text);
    assert.ok(fs.existsSync(path.join(dir, '003_ordini_note_e_tipo.sql')));

    // 4. il numero è ricalcolato al momento di scrivere: un file comparso nel frattempo sposta il numero
    const one = [{ op: 'add_index', table: 'ordini', index: { name: 'ix_cli', columns: ['cliente_id'] } }];
    r = await migrate({ operations: one });
    assert.equal(r.json.migration.file, '004_ordini_add_index_ix_cli.sql');
    fs.writeFileSync(path.join(dir, '004_collega_altro.sql'), '-- di un collega\n');
    r = await migrate({ operations: one, confirm: r.json.token });
    assert.equal(r.json.file, '005_ordini_add_index_ix_cli.sql');
    assert.equal(fs.readFileSync(path.join(dir, '004_collega_altro.sql'), 'utf8'), '-- di un collega\n');

    // 5. DDL che fallisce: nessun file lasciato nel repository
    const bad = [{ op: 'drop_column', table: 'ordini', name: 'inesistente' }];
    r = await migrate({ operations: bad });
    r = await migrate({ operations: bad, confirm: r.json.token, acknowledgeWarnings: true });
    assert.equal(r.status, 400);
    assert.equal(r.json.params.dbCode, 'ER_CANT_DROP_FIELD_OR_KEY');
    assert.deepEqual(r.json.executed, []);
    assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('006_')), 'file tolto');

    // 6. istruzione scritta a mano salvata così com'è
    const raw = [{ op: 'raw', table: 'ordini', operation: 'add_flag', sql: 'ALTER TABLE ordini ADD COLUMN flag TINYINT NOT NULL DEFAULT 0' }];
    r = await migrate({ operations: raw });
    assert.equal(r.json.migration.file, '006_ordini_add_flag.sql');
    r = await migrate({ operations: raw, confirm: r.json.token });
    assert.equal(r.status, 200, r.text);
    assert.match(fs.readFileSync(path.join(dir, '006_ordini_add_flag.sql'), 'utf8'), /ALTER TABLE ordini ADD COLUMN flag TINYINT NOT NULL DEFAULT 0;\n$/);
    assert.equal((await migrate({ operations: [{ op: 'raw', sql: 'DELETE FROM ordini' }] })).json.code, 'db-client.raw_not_schema');

    // 6b. designer su una tabella esistente: struttura invariata = nessuna operazione;
    // rinomina e spostamento di una colonna calcolati dal server sulla struttura reale
    let current = (await api('GET', '/connections/c/databases/app/tables/ordini/definition')).json.definition;
    r = await migrate({ design: { table: 'ordini', definition: current } });
    assert.equal(r.json.code, 'db-client.ddl_no_operations');
    const edited = structuredClone(current);
    const note = edited.columns.find(c => c.name === 'note');
    note.name = 'annotazioni';
    edited.columns = [edited.columns[0], note, ...edited.columns.slice(1).filter(c => c !== note)];
    r = await migrate({ design: { table: 'ordini', definition: edited, renames: { annotazioni: 'note' } } });
    assert.equal(r.status, 428, r.text);
    assert.equal(r.json.migration.file, '007_ordini_alter.sql');
    assert.match(r.json.sql, /CHANGE COLUMN `note` `annotazioni`/);
    r = await migrate({ design: { table: 'ordini', definition: edited, renames: { annotazioni: 'note' } }, confirm: r.json.token });
    assert.equal(r.status, 200, r.text);
    current = (await api('GET', '/connections/c/databases/app/tables/ordini/definition')).json.definition;
    assert.deepEqual(current.columns.map(c => c.name).slice(0, 2), ['id', 'annotazioni']);

    // 6c. editor SQL: un'istruzione di schema su una connessione collegata propone la migration
    r = await api('POST', '/connections/c/query', { sql: 'ALTER TABLE ordini ADD COLUMN sconto INT', database: 'app' });
    assert.deepEqual(r.json.migration, { proposal: { table: 'ordini', operation: 'add_sconto' } });
    r = await api('POST', '/connections/c/query', { sql: 'DELETE FROM ordini', database: 'app' });
    assert.equal(r.json.migration, null);

    // 6d. solo il file: il DB non cambia (anche con avvisi non confermati), lo eseguirà il gestore delle migration
    const later = [{ op: 'drop_column', table: 'ordini', name: 'stato' }];
    r = await migrate({ operations: later });
    assert.equal(r.json.migration.file, '008_ordini_drop_stato.sql');
    assert.equal((await migrate({ operations: later, confirm: r.json.token, migration: { save: false, run: false } })).json.code, 'db-client.migration_nothing_to_do');
    r = await migrate({ operations: later, confirm: r.json.token, migration: { run: false } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.json.ran, r.json.executed, r.json.file], [false, [], '008_ordini_drop_stato.sql']);
    assert.match(fs.readFileSync(path.join(dir, '008_ordini_drop_stato.sql'), 'utf8'), /DROP COLUMN `stato`/);
    current = (await api('GET', '/connections/c/databases/app/tables/ordini/definition')).json.definition;
    assert.ok(current.columns.some(c => c.name === 'stato'), 'colonna ancora presente');

    // 7. senza repository collegato: solo DDL, nessun file
    await api('DELETE', '/connections/c/migrations');
    const plain = [{ op: 'drop_index', table: 'ordini', name: 'ix_stato' }];
    r = await migrate({ operations: plain });
    assert.equal(r.json.migration, null);
    r = await migrate({ operations: plain, confirm: r.json.token });
    assert.deepEqual([r.status, r.json.file], [200, null]);
    assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.sql')).length, 8);
  } finally {
    await s.stop();
    await mysqlDb.stop();
  }
});
