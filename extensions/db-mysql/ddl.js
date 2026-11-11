// CREATE TABLE da una definizione strutturata. Nessun SQL arriva dal client:
// tipi, azioni ed engine da elenchi ammessi, identificatori tra backtick, valori
// (default, ENUM, commenti) escapati da mysql2.
const mysql = require('mysql2');

const quoteId = name => '`' + String(name).replace(/`/g, '``') + '`';
const NAME_RE = /^[^\x00]{1,64}$/;
const CHARSET_RE = /^[a-z0-9_]{1,64}$/i;

// tipo → quali parametri accetta
const TYPES = {
  TINYINT: 'int', SMALLINT: 'int', MEDIUMINT: 'int', INT: 'int', BIGINT: 'int',
  DECIMAL: 'decimal', FLOAT: 'float', DOUBLE: 'float',
  CHAR: 'length', VARCHAR: 'length', BINARY: 'length', VARBINARY: 'length',
  TEXT: 'plain', MEDIUMTEXT: 'plain', LONGTEXT: 'plain', TINYTEXT: 'plain',
  BLOB: 'plain', MEDIUMBLOB: 'plain', LONGBLOB: 'plain',
  DATE: 'plain', TIME: 'plain', YEAR: 'plain', DATETIME: 'temporal', TIMESTAMP: 'temporal',
  BOOLEAN: 'plain', JSON: 'plain', ENUM: 'values', SET: 'values',
};
const FK_ACTIONS = new Set(['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION']);
const ENGINES = new Set(['InnoDB', 'MyISAM', 'MEMORY', 'ARCHIVE']);
const NO_DEFAULT = new Set(['TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'TINYTEXT', 'BLOB', 'MEDIUMBLOB', 'LONGBLOB', 'JSON']);

// Errore di definizione: key = nome del messaggio (catalogo "errors.ddl_<key>"), params per il testo
class DdlError extends Error {
  constructor(key, params = {}) { super(key); this.key = key; this.params = params; }
}
const fail = (key, params) => { throw new DdlError(key, params); };
const int = (v, min, max) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;

function columnSql(c) {
  if (!c || !NAME_RE.test(c.name || '')) fail('column_name');
  const col = { column: c.name };
  const type = String(c.type || '').toUpperCase();
  const kind = TYPES[type];
  if (!kind) fail('type', { ...col, type: String(c.type) });

  let t = type;
  if (kind === 'length') {
    if (!int(c.length, 1, type.startsWith('VAR') ? 65535 : 255)) fail('length', col);
    t += `(${Number(c.length)})`;
  } else if (kind === 'decimal') {
    const p = c.length ?? 10, s = c.scale ?? 0;
    if (!int(p, 1, 65) || !int(s, 0, 30) || Number(s) > Number(p)) fail('precision', col);
    t += `(${Number(p)},${Number(s)})`;
  } else if (kind === 'temporal' && c.length != null && c.length !== '') {
    if (!int(c.length, 0, 6)) fail('fraction', col);
    t += `(${Number(c.length)})`;
  } else if (kind === 'values') {
    if (!Array.isArray(c.values) || !c.values.length) fail('values', col);
    t += `(${c.values.map(v => mysql.escape(String(v))).join(', ')})`;
  }
  if (c.unsigned) {
    if (!['int', 'decimal', 'float'].includes(kind)) fail('unsigned', col);
    t += ' UNSIGNED';
  }

  let sql = `${quoteId(c.name)} ${t}${c.nullable ? ' NULL' : ' NOT NULL'}`;
  if (c.autoIncrement) {
    if (kind !== 'int') fail('auto_increment_type', col);
    sql += ' AUTO_INCREMENT';
  }
  // default: nessuno | NULL | valore | CURRENT_TIMESTAMP (date/ora)
  const d = c.default;
  if (d && d.kind && d.kind !== 'none') {
    if (NO_DEFAULT.has(type)) fail('no_default', { ...col, type });
    if (d.kind === 'null') { if (!c.nullable) fail('default_null', col); sql += ' DEFAULT NULL'; }
    else if (d.kind === 'current_timestamp') { if (kind !== 'temporal') fail('current_timestamp', col); sql += ' DEFAULT CURRENT_TIMESTAMP'; }
    else if (d.kind === 'value') sql += ` DEFAULT ${mysql.escape(String(d.value ?? ''))}`;
    else fail('default', col);
  }
  if (c.onUpdateCurrentTimestamp) {
    if (kind !== 'temporal') fail('on_update', col);
    sql += ' ON UPDATE CURRENT_TIMESTAMP';
  }
  if (c.comment) sql += ` COMMENT ${mysql.escape(String(c.comment))}`;
  return sql;
}

// Elenco di colonne esistenti (has) per un indice o una chiave: `a`, `b`
const columnList = has => (list, where) => {
  if (!Array.isArray(list) || !list.length || !list.every(has)) fail(`columns_${where.what}`, { name: where.name || '' });
  return list.map(quoteId).join(', ');
};

// [UNIQUE] KEY `nome` (`a`, `b`) — colList valida le colonne
function indexSql(ix, colList) {
  if (ix.name != null && ix.name !== '' && !NAME_RE.test(ix.name)) fail('index_name');
  return `${ix.unique ? 'UNIQUE ' : ''}KEY ${ix.name ? quoteId(ix.name) + ' ' : ''}(${colList(ix.columns, { what: 'index', name: ix.name })})`;
}

// CONSTRAINT `nome` FOREIGN KEY (…) REFERENCES `t` (…) ON DELETE … ON UPDATE …
function fkSql(fk, colList) {
  if (fk.name != null && fk.name !== '' && !NAME_RE.test(fk.name)) fail('fk_name');
  if (!NAME_RE.test(fk.refTable || '') || !Array.isArray(fk.refColumns) || !fk.refColumns.every(n => NAME_RE.test(n || ''))) fail('fk_reference');
  if ((fk.refColumns || []).length !== (fk.columns || []).length) fail('fk_count');
  const refDb = fk.refDatabase ? `${quoteId(fk.refDatabase)}.` : '';
  let sql = `${fk.name ? `CONSTRAINT ${quoteId(fk.name)} ` : ''}FOREIGN KEY (${colList(fk.columns, { what: 'foreign_key', name: fk.name })}) REFERENCES ${refDb}${quoteId(fk.refTable)} (${fk.refColumns.map(quoteId).join(', ')})`;
  for (const [k, label] of [['onDelete', 'ON DELETE'], ['onUpdate', 'ON UPDATE']]) {
    if (!fk[k]) continue;
    const action = String(fk[k]).toUpperCase();
    if (!FK_ACTIONS.has(action)) fail('fk_action', { action: String(fk[k]) });
    sql += ` ${label} ${action}`;
  }
  return sql;
}

// Opzioni di tabella: ENGINE, charset, collation, commento
function tableOptionsSql(def) {
  let options = '';
  if (def.engine) { if (!ENGINES.has(def.engine)) fail('engine'); options += ` ENGINE=${def.engine}`; }
  if (def.charset) { if (!CHARSET_RE.test(def.charset)) fail('charset'); options += ` DEFAULT CHARSET=${def.charset}`; }
  if (def.collation) { if (!CHARSET_RE.test(def.collation)) fail('collation'); options += ` COLLATE=${def.collation}`; }
  if (def.comment) options += ` COMMENT=${mysql.escape(String(def.comment))}`;
  return options;
}

function createTableSql(db, def) {
  if (!def || !NAME_RE.test(def.name || '')) fail('table_name');
  const cols = Array.isArray(def.columns) ? def.columns : [];
  if (!cols.length) fail('no_columns');
  const names = cols.map(c => c?.name);
  if (new Set(names).size !== names.length) fail('duplicate_columns');
  const has = n => names.includes(n);
  // where: { what: 'primary_key' | 'index' | 'foreign_key', name }
  const colList = columnList(has);

  const lines = cols.map(columnSql);
  const pk = Array.isArray(def.primaryKey) ? def.primaryKey : [];
  if (pk.length) lines.push(`PRIMARY KEY (${colList(pk, { what: 'primary_key' })})`);
  const ai = cols.filter(c => c.autoIncrement);
  if (ai.length > 1) fail('auto_increment_many');
  if (ai.length && !pk.includes(ai[0].name) && !(def.indexes || []).some(i => i.columns?.[0] === ai[0].name)) {
    fail('auto_increment_key');
  }
  for (const ix of def.indexes || []) lines.push(indexSql(ix, colList));
  for (const fk of def.foreignKeys || []) lines.push(fkSql(fk, colList));

  return `CREATE TABLE ${quoteId(db)}.${quoteId(def.name)} (\n  ${lines.join(',\n  ')}\n)${tableOptionsSql(def)}`;
}

module.exports = {
  createTableSql, columnSql, indexSql, fkSql, columnList, tableOptionsSql, quoteId, fail,
  DdlError, NAME_RE, TYPE_KINDS: TYPES, TYPES: Object.keys(TYPES), FK_ACTIONS: [...FK_ACTIONS], ENGINES: [...ENGINES],
};
