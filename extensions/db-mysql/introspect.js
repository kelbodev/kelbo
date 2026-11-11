// Schema reale di un database letto da INFORMATION_SCHEMA (solo letture con parametri)
// nello stesso modello del designer e di ops.js: { tables: { <nome>: definizione } }.
const ddl = require('./ddl');

// "enum('a','b''c')" → ['a', "b'c"]
function enumValues(columnType) {
  const inner = /^\w+\((.*)\)$/s.exec(columnType)?.[1] || '';
  return [...inner.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
}

// MariaDB scrive i default tra apici e NULL come testo; MySQL no
function defaultOf(raw, extra, nullable, isMaria) {
  if (raw === null || raw === undefined || (isMaria && raw === 'NULL')) return { kind: 'none' };
  if (/^current_timestamp(\(\d*\))?$/i.test(raw)) return { kind: 'current_timestamp' };
  let value = String(raw);
  if (isMaria && /^'.*'$/s.test(value)) value = value.slice(1, -1).replace(/''/g, "'");
  return { kind: 'value', value };
}

function column(c, isMaria) {
  const type = String(c.DATA_TYPE).toUpperCase();
  const kind = ddl.TYPE_KINDS[type];
  const col = { name: c.COLUMN_NAME, type };
  if (kind === 'length') col.length = Number(c.CHARACTER_MAXIMUM_LENGTH);
  else if (kind === 'decimal') { col.length = Number(c.NUMERIC_PRECISION); col.scale = Number(c.NUMERIC_SCALE); }
  else if (kind === 'temporal' && Number(c.DATETIME_PRECISION)) col.length = Number(c.DATETIME_PRECISION);
  else if (kind === 'values') col.values = enumValues(c.COLUMN_TYPE);
  if (/unsigned/i.test(c.COLUMN_TYPE)) col.unsigned = true;
  col.nullable = c.IS_NULLABLE === 'YES';
  col.default = defaultOf(c.COLUMN_DEFAULT, c.EXTRA, col.nullable, isMaria);
  if (/auto_increment/i.test(c.EXTRA)) col.autoIncrement = true;
  if (/on update current_timestamp/i.test(c.EXTRA)) col.onUpdateCurrentTimestamp = true;
  if (c.COLUMN_COMMENT) col.comment = c.COLUMN_COMMENT;
  if (!kind) col.unsupported = c.COLUMN_TYPE; // tipo che il designer non gestisce (es. GEOMETRY)
  return col;
}

// q: connessione mysql2/promise. tables: limita a queste tabelle (default: tutte)
async function introspect(q, db, tables = null) {
  const [[{ version }]] = await q.query('SELECT VERSION() AS version');
  const isMaria = /mariadb/i.test(version);
  const only = tables ? ' AND TABLE_NAME IN (?)' : '';
  const params = tables ? [db, tables] : [db];
  if (tables && !tables.length) return { tables: {} };
  const [[tableRows], [colRows], [idxRows], [fkRows]] = await Promise.all([
    q.query(`SELECT TABLE_NAME, ENGINE, TABLE_COMMENT FROM information_schema.TABLES
              WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'${only} ORDER BY TABLE_NAME`, params),
    q.query(`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE,
                    DATETIME_PRECISION, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
               FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?${only} ORDER BY TABLE_NAME, ORDINAL_POSITION`, params),
    q.query(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = ?${only} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, params),
    q.query(`SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME,
                    k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
               FROM information_schema.KEY_COLUMN_USAGE k
               JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                 ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
              WHERE k.TABLE_SCHEMA = ?${only.replace('TABLE_NAME', 'k.TABLE_NAME')} AND k.REFERENCED_TABLE_NAME IS NOT NULL
              ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, params),
  ]);

  const result = {};
  for (const t of tableRows) {
    result[t.TABLE_NAME] = {
      engine: t.ENGINE || undefined, ...(t.TABLE_COMMENT ? { comment: t.TABLE_COMMENT } : {}),
      columns: [], primaryKey: [], indexes: [], foreignKeys: [],
    };
  }
  for (const c of colRows) result[c.TABLE_NAME]?.columns.push(column(c, isMaria));
  const indexes = new Map();
  for (const i of idxRows) {
    const t = result[i.TABLE_NAME];
    if (!t) continue;
    if (i.INDEX_NAME === 'PRIMARY') { t.primaryKey.push(i.COLUMN_NAME); continue; }
    const k = `${i.TABLE_NAME}\0${i.INDEX_NAME}`;
    if (!indexes.has(k)) { const ix = { name: i.INDEX_NAME, columns: [], unique: Number(i.NON_UNIQUE) === 0 }; indexes.set(k, ix); t.indexes.push(ix); }
    indexes.get(k).columns.push(i.COLUMN_NAME);
  }
  const fks = new Map();
  for (const f of fkRows) {
    const t = result[f.TABLE_NAME];
    if (!t) continue;
    const k = `${f.TABLE_NAME}\0${f.CONSTRAINT_NAME}`;
    if (!fks.has(k)) {
      const fk = {
        name: f.CONSTRAINT_NAME, columns: [], refTable: f.REFERENCED_TABLE_NAME, refColumns: [],
        ...(f.REFERENCED_TABLE_SCHEMA !== db ? { refDatabase: f.REFERENCED_TABLE_SCHEMA } : {}),
        onDelete: f.DELETE_RULE, onUpdate: f.UPDATE_RULE,
      };
      fks.set(k, fk);
      t.foreignKeys.push(fk);
    }
    fks.get(k).columns.push(f.COLUMN_NAME);
    fks.get(k).refColumns.push(f.REFERENCED_COLUMN_NAME);
  }
  return { tables: result };
}

module.exports = { introspect, enumValues, column };
