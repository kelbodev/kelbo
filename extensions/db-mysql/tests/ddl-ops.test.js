// Modello delle operazioni di schema: SQL generato, avvisi, nomi proposti, confronto
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ops = require('../ops');
const { enumValues } = require('../introspect');

const col = (name, extra = {}) => ({ name, type: 'VARCHAR', length: 50, nullable: true, default: { kind: 'none' }, ...extra });

test('le operazioni ALTER consecutive sulla stessa tabella diventano un solo ALTER TABLE', () => {
  const sql = ops.statements('app', [
    { op: 'add_column', table: 'ordini', column: col('stato', { nullable: false, default: { kind: 'value', value: 'nuovo' } }), after: 'id' },
    { op: 'modify_column', table: 'ordini', name: 'note', column: col('note', { type: 'TEXT', length: undefined }) },
    { op: 'modify_column', table: 'ordini', name: 'cliente', column: col('cliente_nome') },
    { op: 'add_index', table: 'ordini', index: { name: 'ix_stato', columns: ['stato'] } },
    { op: 'rename_table', table: 'ordini', to: 'orders' },
    { op: 'drop_column', table: 'orders', name: 'vecchio' },
  ]);
  assert.equal(sql.length, 3);
  assert.equal(sql[0], [
    'ALTER TABLE `app`.`ordini`',
    "  ADD COLUMN `stato` VARCHAR(50) NOT NULL DEFAULT 'nuovo' AFTER `id`,",
    '  MODIFY COLUMN `note` TEXT NULL,',
    '  CHANGE COLUMN `cliente` `cliente_nome` VARCHAR(50) NULL,',
    '  ADD KEY `ix_stato` (`stato`)',
  ].join('\n'));
  assert.equal(sql[1], 'RENAME TABLE `app`.`ordini` TO `app`.`orders`');
  assert.equal(sql[2], 'ALTER TABLE `app`.`orders`\n  DROP COLUMN `vecchio`');
});

test('operazioni non valide rifiutate', () => {
  assert.throws(() => ops.statements('app', []), /no_operations/);
  assert.throws(() => ops.statements('app', [{ op: 'truncate', table: 't' }]), /operation/);
  assert.throws(() => ops.statements('app', [{ op: 'add_column', table: 't', column: col('x', { type: 'NOPE' }) }]), /type/);
  assert.throws(() => ops.statements('app', [{ op: 'add_fk', table: 't', fk: { columns: ['a'], refTable: 'u', refColumns: ['id'], onDelete: 'EXPLODE' } }]), /fk_action/);
  assert.throws(() => ops.statements('app', [{ op: 'raw', sql: '  ' }]), /raw_sql/);
});

test('avvisi sulle operazioni che possono perdere dati', () => {
  const before = { tables: { t: { columns: [col('a'), col('b', { length: 100 })] } } };
  const w = ops.destructive([
    { op: 'drop_column', table: 't', name: 'a' },
    { op: 'modify_column', table: 't', name: 'b', column: col('b', { length: 20 }) },   // accorciata
    { op: 'modify_column', table: 't', name: 'a', column: col('a', { length: 80 }) },   // allungata: ok
    { op: 'add_column', table: 't', column: col('c') },
    { op: 'drop_table', table: 't' },
  ], before);
  assert.deepEqual(w.map(x => [x.index, x.key]), [[0, 'drop_column'], [1, 'modify_column'], [4, 'drop_table']]);
});

test('nome proposto: tabella e operazione', () => {
  const name = list => ops.proposeName(list);
  assert.deepEqual(name([{ op: 'create_table', table: 'Ordini', definition: {} }]), { table: 'ordini', operation: 'create' });
  assert.deepEqual(name([{ op: 'add_column', table: 'orders', column: col('Status') }]), { table: 'orders', operation: 'add_status' });
  assert.deepEqual(name([{ op: 'drop_index', table: 'orders', name: 'ix_a' }]), { table: 'orders', operation: 'drop_index_ix_a' });
  assert.deepEqual(name([{ op: 'add_column', table: 'orders', column: col('a') }, { op: 'drop_column', table: 'orders', name: 'b' }]), { table: 'orders', operation: 'alter' });
  assert.deepEqual(name([{ op: 'raw', table: 'orders', sql: 'x', operation: 'add_status' }]), { table: 'orders', operation: 'add_status' });
});

test('confronto tra schemi: ordine delle operazioni e rinomine ambigue', () => {
  const clienti = { columns: [col('id', { type: 'INT', length: undefined, nullable: false })], primaryKey: ['id'], indexes: [], foreignKeys: [] };
  const from = {
    tables: {
      clienti,
      ordini: {
        columns: [col('id', { type: 'INT', length: undefined, nullable: false }), col('vecchio'), col('note')],
        primaryKey: ['id'], indexes: [{ name: 'ix_note', columns: ['note'], unique: false }],
        foreignKeys: [{ name: 'fk_c', columns: ['note'], refTable: 'clienti', refColumns: ['id'] }],
      },
      obsoleta: { columns: [col('x')], primaryKey: [], indexes: [], foreignKeys: [] },
    },
  };
  const to = {
    tables: {
      clienti,
      ordini: {
        columns: [col('id', { type: 'INT', length: undefined, nullable: false }), col('nuovo'), col('note', { length: 200 })],
        primaryKey: ['id'], indexes: [], foreignKeys: [],
      },
      righe: {
        columns: [col('id', { type: 'INT', length: undefined, nullable: false }), col('ordine_id', { type: 'INT', length: undefined })],
        primaryKey: ['id'], indexes: [],
        foreignKeys: [{ name: 'fk_o', columns: ['ordine_id'], refTable: 'ordini', refColumns: ['id'] }],
      },
    },
  };
  const { ops: list, ambiguous } = ops.diff(from, to);
  assert.deepEqual(ambiguous, [{ table: 'ordini', column: 'nuovo', candidates: ['vecchio'] }]);
  assert.deepEqual(list.map(o => `${o.op}:${o.table}`), [
    'drop_fk:ordini', 'drop_index:ordini', 'drop_column:ordini', 'add_column:ordini', 'modify_column:ordini',
    'drop_table:obsoleta', 'create_table:righe', 'add_fk:righe',
  ]);
  // con la rinomina scelta dall'utente
  const renamed = ops.diff(from, to, { 'ordini.nuovo': 'vecchio' });
  assert.deepEqual(renamed.ambiguous, []);
  assert.ok(renamed.ops.some(o => o.op === 'modify_column' && o.name === 'vecchio' && o.column.name === 'nuovo'));
  assert.ok(!renamed.ops.some(o => o.op === 'drop_column'));
  // spostamento di una colonna: MODIFY … AFTER, in un ALTER separato dalle aggiunte
  const moved = ops.diff({ tables: { t: { columns: [col('a'), col('b'), col('c')] } } }, { tables: { t: { columns: [col('a'), col('c'), col('b')] } } });
  assert.deepEqual(moved.ops.map(o => [o.op, o.name, o.after]), [['modify_column', 'b', 'c']]);
  const sql = ops.statements('app', ops.diff(
    { tables: { t: { columns: [col('a'), col('b')] } } },
    { tables: { t: { columns: [col('z'), col('a'), col('nuova')] } } }, { 't.z': 'b' }).ops);
  assert.equal(sql.length, 3, sql.join('\n'));
  assert.match(sql[0], /CHANGE COLUMN `b` `z`/);
  // stesso schema: nessuna operazione
  assert.deepEqual(ops.diff(to, to).ops, []);
  // tabelle nuove con chiavi esterne tra loro: prima quella riferita
  assert.deepEqual(ops.orderByForeignKeys(['b', 'a'], { a: { foreignKeys: [{ refTable: 'b' }] }, b: {} }), ['b', 'a']);
});

test('valori di ENUM letti dal tipo della colonna', () => {
  assert.deepEqual(enumValues("enum('a','b''c','d,e')"), ['a', "b'c", 'd,e']);
});
