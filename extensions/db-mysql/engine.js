// Motore MySQL/MariaDB per la sezione Database (capacità "db-engine", vedi db-client/engine.md).
// Tutto ciò che dipende dal dialetto e dal driver mysql2: connessione e pool, esecuzione con
// limite di righe, classificazione delle istruzioni, quoting, metadati, DML e DDL generati.
const mysqlCb = require('mysql2');
const mysql = require('mysql2/promise');
const sql = require('./sql');
const ddl = require('./ddl');
const ops = require('./ops');
const { introspect } = require('./introspect');

const QUERY_TIMEOUT_MS = 30000;
const quoteId = ddl.quoteId;
// Nome del tipo MySQL dal codice numerico del protocollo
const TYPE_NAMES = Object.fromEntries(Object.entries(mysqlCb.Types).map(([name, code]) => [code, name]));

// Parole chiave per evidenziazione e completamento nell'editor
const KEYWORDS = `ADD ALL ALTER AND AS ASC AUTO_INCREMENT BETWEEN BIGINT BINARY BLOB BY CASCADE CASE CHAR CHARACTER CHARSET CHECK
COLLATE COLUMN COMMENT CONSTRAINT CREATE CROSS CURRENT_TIMESTAMP DATABASE DATE DATETIME DECIMAL DEFAULT DELETE DESC DESCRIBE DISTINCT DOUBLE DROP
ELSE END ENGINE ENUM EXISTS EXPLAIN FALSE FLOAT FOR FOREIGN FROM FULL GROUP HAVING IF IGNORE IN INDEX INNER INSERT INT INTEGER INTERVAL INTO
IS JOIN JSON KEY KEYS LEFT LIKE LIMIT LONGTEXT MEDIUMTEXT MODIFY NOT NULL OFFSET ON OR ORDER OUTER PRIMARY REFERENCES RENAME REPLACE RIGHT
SELECT SET SHOW SMALLINT TABLE TABLES TEXT THEN TIME TIMESTAMP TINYINT TRUE TRUNCATE UNION UNIQUE UNSIGNED UPDATE USING VALUES VARCHAR VIEW
WHEN WHERE WITH`.split(/\s+/).filter(Boolean);

// Valori pronti per il JSON: i binari diventano esadecimale (troncato), il JSON testo
const isJsonValue = v => v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date);
function cell(v) {
  if (Buffer.isBuffer(v)) return v.length <= 64 ? `0x${v.toString('hex')}` : `0x${v.subarray(0, 64).toString('hex')}… (${v.length} byte)`;
  if (isJsonValue(v)) return JSON.stringify(v);
  return v;
}

module.exports = function createMysqlEngine() {
  return {
    driver: () => ({ name: 'mysql2', version: require('mysql2/package.json').version }),

    // Campi del form della connessione (il db-client li mostra e li valida) e porta predefinita
    connection: { fields: ['host', 'port', 'user', 'password', 'database'], defaultPort: 3306, tunnel: true },

    // Dati del dialetto per il frontend
    dialect: {
      quote: '`',
      keywords: KEYWORDS,
      schemas: false,
      ddl: { types: ddl.TYPES, fkActions: ddl.FK_ACTIONS, engines: ddl.ENGINES },
      // {table} = tabella qualificata e quotata, {column} colonna quotata, {alias} alias quotato
      snippets: {
        firstRows: 'SELECT * FROM {table} LIMIT 100;',
        count: 'SELECT COUNT(*) AS {alias} FROM {table};',
        showCreate: 'SHOW CREATE TABLE {table};',
        showCreateView: 'SHOW CREATE VIEW {table};',
        distinct: 'SELECT DISTINCT {column} FROM {table} ORDER BY {column};',
      },
    },

    // ---- connessione ----
    // options: { host, port, user, password, database, connectTimeout }
    driverOptions: o => ({
      host: o.host, port: o.port, user: o.user, password: o.password, database: o.database || undefined,
      connectTimeout: o.connectTimeout, multipleStatements: false, // una sola istruzione per richiesta
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    }),
    createPool(o, { readOnly = false } = {}) {
      const pool = mysqlCb.createPool({ ...this.driverOptions(o), connectionLimit: 3, waitForConnections: true });
      // Sola lettura anche lato server: una scrittura sfuggita al controllo fallisce comunque
      if (readOnly) pool.on('connection', c => c.query('SET SESSION TRANSACTION READ ONLY'));
      return pool;
    },
    closePool(pool) { pool.end(() => {}); },
    async test(o) {
      const db = await mysql.createConnection(this.driverOptions(o));
      try {
        const [[row]] = await db.query('SELECT VERSION() AS version, CURRENT_USER() AS user, DATABASE() AS db');
        return row;
      } finally { db.end().catch(() => {}); }
    },
    acquire: pool => new Promise((resolve, reject) => pool.getConnection((e, c) => (e ? reject(e) : resolve(c)))),
    release: session => session.release(),

    // Lettura con parametri ? → { rows, fields } (rowsAsArray: righe come array)
    async query(pool, text, params = [], { rowsAsArray = false } = {}) {
      const [rows, fields] = await pool.promise().query({ sql: text, rowsAsArray }, params);
      return { rows, fields };
    },

    // Esegue l'istruzione: le righe arrivano in streaming e oltre il limite si interrompe.
    // readOnly: dentro una transazione READ ONLY (annullata alla fine), per gli agenti MCP
    // session: connessione già presa (più istruzioni sulla stessa sessione), non viene rilasciata;
    // oltre il limite le righe si leggono e si scartano invece di chiudere la connessione
    execute(pool, text, limit, { readOnly = false, session = null } = {}) {
      return new Promise((resolve, reject) => {
        const take = session ? cb => cb(null, session) : cb => pool.getConnection(cb);
        take((err, connection) => {
          if (err) return reject(err);
          if (!readOnly) return run(connection);
          connection.query('START TRANSACTION READ ONLY', e => (e ? (connection.release(), reject(e)) : run(connection)));
        });
        function run(connection) {
          const started = Date.now();
          let fields = null, header = null, truncated = false, settled = false;
          const rows = [];
          const finish = (error, destroy) => {
            if (settled) return;
            settled = true;
            if (session) { /* la rilascia chi l'ha presa */ }
            else if (destroy) connection.destroy();
            else if (readOnly) connection.query('ROLLBACK', () => connection.release());
            else connection.release();
            if (error) return reject(error);
            const ms = Date.now() - started;
            if (fields) {
              resolve({
                kind: 'rows', ms, truncated, rowCount: rows.length,
                // origine di ogni colonna (anche con alias): database, tabella e colonna reali, o null se calcolata
                columns: fields.map(f => ({
                  name: f.name, table: f.orgTable || null, db: f.orgTable ? f.schema || null : null, column: f.orgTable ? f.orgName || null : null,
                  type: TYPE_NAMES[f.columnType] || String(f.columnType),
                })),
                rows,
              });
            } else {
              resolve({
                kind: 'result', ms,
                affectedRows: header?.affectedRows ?? 0, changedRows: header?.changedRows ?? null,
                insertId: header?.insertId ?? null, warningStatus: header?.warningStatus ?? 0, info: header?.info || '',
              });
            }
          };
          const q = connection.query({ sql: text, timeout: QUERY_TIMEOUT_MS, rowsAsArray: true });
          q.on('error', e => finish(e, true));
          q.on('fields', f => { fields = f; });
          q.on('result', r => {
            if (!fields) { header = r; return; }
            if (rows.length >= limit) {
              truncated = true;
              if (!session) finish(null, true); // il resto non serve: si chiude la connessione
              return;
            }
            rows.push(r.map(cell));
          });
          q.on('end', () => finish(null, false));
        }
      });
    },

    // Più istruzioni in un'unica transazione (tutte o nessuna) → righe toccate in totale
    async transaction(pool, statements) {
      const cx = await pool.promise().getConnection();
      let affectedRows = 0;
      try {
        await cx.beginTransaction();
        for (const statement of statements) affectedRows += (await cx.query({ sql: statement, timeout: QUERY_TIMEOUT_MS }))[0].affectedRows;
        await cx.commit();
      } catch (e) {
        await cx.rollback().catch(() => {});
        throw e;
      } finally { cx.release(); }
      return affectedRows;
    },

    // Righe in streaming per l'export: prima { fields: [nomi] }, poi un array di valori per riga
    // (valori grezzi del driver: Buffer, oggetti JSON, stringhe). Il backpressure lo dà for await.
    async *stream(pool, text, params = []) {
      const connection = await this.acquire(pool);
      let ok = false;
      try {
        const s = connection.query({ sql: text, values: params, rowsAsArray: true }).stream({ highWaterMark: 100 });
        let fields = null;
        s.once('fields', f => { fields = f.map(x => x.name); });
        let announced = false;
        for await (const row of s) {
          if (!announced) { yield { fields }; announced = true; }
          yield row;
        }
        if (!announced) yield { fields: fields || [] };
        ok = true;
      } finally {
        if (ok) connection.release(); else connection.destroy();
      }
    },

    // ---- testo SQL ----
    sql: {
      classify: sql.classify,
      splitStatements: sql.splitStatements,
      schemaChange: sql.schemaChange,
      describeParams: sql.describeParams,
      bindParams: (text, values) => sql.bindParams(text, values, mysqlCb.escape),
      countQuery: sql.countQuery,
    },
    quoteId,
    qualify: (db, table) => `${quoteId(db)}.${quoteId(table)}`,
    escape: v => mysqlCb.escape(v),
    // Valore di una cella in un file SQL (i JSON restano testo JSON)
    literal: v => mysqlCb.escape(isJsonValue(v) ? JSON.stringify(v) : v),
    format: (template, params) => mysqlCb.format(template, params),
    // Espressione testuale di una colonna per la ricerca con LIKE
    asText: column => `CAST(${column} AS CHAR)`,
    // Pagina di una SELECT: parametri dopo quelli della query
    page: (text, params, limit, offset) => ({ sql: `${text} LIMIT ? OFFSET ?`, params: [...params, limit, offset] }),

    // ---- metadati ----
    async listDatabases(pool, { readOnly = false } = {}) {
      return (await this.execute(pool, 'SHOW DATABASES', 10000, { readOnly })).rows.map(r => r[0]);
    },
    async listTables(pool, db) {
      const { rows } = await this.query(pool,
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rowsEstimate, TABLE_COMMENT AS comment
           FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]);
      return rows.map(t => ({ ...t, view: t.type === 'VIEW' }));
    },
    // Colonne per anteprima, ricerca e modifica delle righe: { name, type, dataType, nullable, key: 'PRI'|…, default, extra }
    async columns(pool, db, table) {
      const { rows } = await this.query(pool,
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS dataType, IS_NULLABLE = 'YES' AS nullable,
                COLUMN_KEY AS \`key\`, COLUMN_DEFAULT AS \`default\`, EXTRA AS extra
           FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
      return rows.map(c => ({ ...c, nullable: !!Number(c.nullable) }));
    },
    // Struttura per il pannello della tabella: colonne, indici, chiavi esterne
    async tableInfo(pool, db, table) {
      const [{ rows: columns }, { rows: indexes }, { rows: foreignKeys }] = await Promise.all([
        this.query(pool, `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY AS \`key\`,
                                 COLUMN_DEFAULT AS \`default\`, EXTRA AS extra, COLUMN_COMMENT AS comment
                            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]),
        this.query(pool, `SELECT INDEX_NAME AS name, NON_UNIQUE = 0 AS \`unique\`, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
                            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME, NON_UNIQUE`, [db, table]),
        this.query(pool, `SELECT CONSTRAINT_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) AS columns,
                                 REFERENCED_TABLE_SCHEMA AS refDatabase, REFERENCED_TABLE_NAME AS refTable,
                                 GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION) AS refColumns
                            FROM information_schema.KEY_COLUMN_USAGE
                           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
                           GROUP BY CONSTRAINT_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME`, [db, table]),
      ]);
      if (!columns.length) return null;
      const split = list => list.map(x => ({ ...x, columns: String(x.columns).split(','), ...(x.refColumns ? { refColumns: String(x.refColumns).split(',') } : {}) }));
      return {
        columns: columns.map(c => ({ ...c, nullable: !!Number(c.nullable) })),
        indexes: split(indexes).map(i => ({ ...i, unique: !!Number(i.unique) })),
        foreignKeys: split(foreignKeys),
      };
    },
    // Testo SQL che ricrea la tabella (export SQL con la struttura)
    async createTableText(pool, db, table) {
      const { rows: [row] } = await this.query(pool, `SHOW CREATE TABLE ${quoteId(db)}.${quoteId(table)}`);
      return row['Create Table'];
    },
    introspect: (pool, db, tables) => introspect(pool.promise(), db, tables),

    // ---- righe: istruzioni generate (valori escapati) ----
    dml: {
      insert(from, values) {
        const cols = Object.keys(values);
        return cols.length
          ? mysqlCb.format(`INSERT INTO ${from} (${cols.map(quoteId).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => values[c]))
          : `INSERT INTO ${from} () VALUES ()`;
      },
      update(from, values, key) {
        const cols = Object.keys(values), pk = Object.keys(key);
        return mysqlCb.format(`UPDATE ${from} SET ${cols.map(c => `${quoteId(c)} = ?`).join(', ')} WHERE ${pk.map(c => `${quoteId(c)} = ?`).join(' AND ')} LIMIT 1`,
          [...cols.map(c => values[c]), ...pk.map(c => key[c])]);
      },
      delete(from, key) {
        const pk = Object.keys(key);
        return mysqlCb.format(`DELETE FROM ${from} WHERE ${pk.map(c => `${quoteId(c)} = ?`).join(' AND ')} LIMIT 1`, pk.map(c => key[c]));
      },
      // più righe per chiave primaria (pk: colonne, keys: [{ colonna: valore }])
      deleteMany(from, pk, keys) {
        const tuple = pk.length > 1 ? `(${pk.map(quoteId).join(', ')})` : quoteId(pk[0]);
        const one = pk.length > 1 ? `(${pk.map(() => '?').join(', ')})` : '?';
        return mysqlCb.format(`DELETE FROM ${from} WHERE ${tuple} IN (${keys.map(() => one).join(', ')}) LIMIT ${keys.length}`, keys.flatMap(k => pk.map(c => k[c])));
      },
    },

    // ---- schema: definizione strutturata → DDL, confronto, avvisi ----
    ddl: { createTableSql: ddl.createTableSql, DdlError: ddl.DdlError },
    schema: { statements: ops.statements, destructive: ops.destructive, diff: ops.diff, proposeName: ops.proposeName },

    // Errore del driver → { message, code }
    errorInfo: e => ({ message: e?.message || String(e), ...(e?.code ? { code: e.code } : {}) }),
  };
};
