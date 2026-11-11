// Modello delle modifiche di schema: un elenco di operazioni su tabelle, da cui si
// generano sia l'SQL eseguito sul DB sia il contenuto del file di migration (stesso
// testo). Usato dal designer (anche per calcolare le modifiche di una tabella
// esistente) e dalle istruzioni scritte nell'editor.
//
// Operazioni (table = tabella su cui agiscono):
//   create_table { definition }          drop_table {}            rename_table { to }
//   add_column { column, after? }        modify_column { name, column, after? }
//   rename_column { from, to }           drop_column { name }
//   add_index { index }                  drop_index { name }
//   add_primary_key { columns }          drop_primary_key {}
//   add_fk { fk }                        drop_fk { name }
//   table_options { engine?, comment? }
//   raw { sql, operation? }              istruzione scritta a mano, salvata così com'è
// after: nome della colonna dopo cui spostarla, oppure '' per FIRST
// newStatement: true inizia un nuovo ALTER TABLE invece di unirsi al precedente
const ddl = require('./ddl');
// confronto e avvisi: comuni ai motori, con i tipi di MySQL
const common = require('../db-client/schemadiff')({ typeKinds: ddl.TYPE_KINDS });
const { destructive, narrows, proposeName, diff, orderByForeignKeys, normalizeColumn } = common;

const { quoteId, fail, NAME_RE } = ddl;
const OPS = new Set(['create_table', 'drop_table', 'rename_table', 'add_column', 'modify_column', 'rename_column', 'drop_column',
  'add_index', 'drop_index', 'add_primary_key', 'drop_primary_key', 'add_fk', 'drop_fk', 'table_options', 'raw']);
const anyColumn = () => true; // le colonne di indici e chiavi in ALTER le verifica MySQL

const name = n => { if (!NAME_RE.test(n || '')) fail('name', { name: String(n ?? '') }); return quoteId(n); };
const position = after => after === undefined || after === null ? '' : after === '' ? ' FIRST' : ` AFTER ${name(after)}`;

// Clausola di ALTER TABLE per un'operazione (null se l'operazione non è un ALTER)
function alterClause(op) {
  const colList = ddl.columnList(anyColumn);
  switch (op.op) {
    case 'add_column': return `ADD COLUMN ${ddl.columnSql(op.column)}${position(op.after)}`;
    case 'modify_column':
      return op.column?.name && op.column.name !== op.name
        ? `CHANGE COLUMN ${name(op.name)} ${ddl.columnSql(op.column)}${position(op.after)}`
        : `MODIFY COLUMN ${ddl.columnSql(op.column)}${position(op.after)}`;
    case 'rename_column': return `RENAME COLUMN ${name(op.from)} TO ${name(op.to)}`;
    case 'drop_column': return `DROP COLUMN ${name(op.name)}`;
    case 'add_index': return `ADD ${ddl.indexSql(op.index || {}, colList)}`;
    case 'drop_index': return `DROP INDEX ${name(op.name)}`;
    case 'add_primary_key': return `ADD PRIMARY KEY (${colList(op.columns, { what: 'primary_key' })})`;
    case 'drop_primary_key': return 'DROP PRIMARY KEY';
    case 'add_fk': return `ADD ${ddl.fkSql(op.fk || {}, colList)}`;
    case 'drop_fk': return `DROP FOREIGN KEY ${name(op.name)}`;
    case 'table_options': {
      const opts = ddl.tableOptionsSql({ engine: op.engine, comment: op.comment }).trim();
      if (!opts) fail('nothing');
      return opts;
    }
    default: return null;
  }
}

function validate(ops) {
  if (!Array.isArray(ops) || !ops.length) fail('no_operations');
  if (ops.length > 500) fail('too_many_operations');
  for (const op of ops) {
    if (!op || !OPS.has(op.op)) fail('operation', { op: String(op?.op) });
    if (op.op === 'raw') { if (typeof op.sql !== 'string' || !op.sql.trim()) fail('raw_sql'); continue; }
    name(op.table);
  }
}

// Istruzioni SQL dalle operazioni, nell'ordine. Le operazioni ALTER consecutive sulla
// stessa tabella diventano un solo ALTER TABLE (più clausole, applicate insieme).
function statements(db, ops) {
  validate(ops);
  const out = [];
  let alter = null; // { table, clauses }
  const flush = () => {
    if (alter) out.push(`ALTER TABLE ${quoteId(db)}.${quoteId(alter.table)}\n  ${alter.clauses.join(',\n  ')}`);
    alter = null;
  };
  for (const op of ops) {
    const clause = alterClause(op);
    if (clause) {
      if (alter && (alter.table !== op.table || op.newStatement)) flush();
      alter = alter || { table: op.table, clauses: [] };
      alter.clauses.push(clause);
      continue;
    }
    flush();
    if (op.op === 'create_table') out.push(ddl.createTableSql(db, { ...op.definition, name: op.table }));
    else if (op.op === 'drop_table') out.push(`DROP TABLE ${quoteId(db)}.${name(op.table)}`);
    else if (op.op === 'rename_table') out.push(`RENAME TABLE ${quoteId(db)}.${name(op.table)} TO ${quoteId(db)}.${name(op.to)}`);
    else if (op.op === 'raw') out.push(op.sql.trim().replace(/;\s*$/, ''));
  }
  flush();
  return out;
}

module.exports = { OPS, validate, statements, destructive, narrows, proposeName, diff, orderByForeignKeys, normalizeColumn };
