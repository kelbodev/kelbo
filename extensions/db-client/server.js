// Database: connessioni (sezione "dbConnections", raggruppate nelle cartelle della sidebar
// della sezione "dbFolders"), password cifrate con la master password (sezione "vault"),
// query con timeout e limite di righe. Il db-client è l'host: tutto ciò che dipende dal
// database (driver, dialetto, metadati, DDL) lo fa il motore della connessione, offerto da
// un'estensione con la capacità "db-engine" (MySQL: db-mysql, integrata). Vedi engine.md.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mig = require('./migrations');

const CONNECTION_FIELDS = ['id', 'label', 'type', 'host', 'port', 'database', 'user', 'password', 'projectId', 'tunnel', 'readOnly', 'migrations', 'folder', 'options', 'file'];
// opzioni del motore (connection.options): chiave → booleano, numero o testo breve
const OPTION_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;
const FOLDER_FIELDS = ['id', 'label'];
const HOST_RE = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]{1,253})$/i;  // nome host, IPv4 o [IPv6]
const DB_NAME_RE = /^[^`\\/\x00]{1,64}$/;                       // nome database MySQL (niente backtick, slash, NUL)
const CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_ROW_LIMIT = 1000;
const MAX_ROW_LIMIT = 10000;

const PAGE_SIZES = [25, 50, 100, 250, 500];
// Operatori dei filtri dell'anteprima: SQL con il valore come parametro
const FILTER_OPS = {
  eq:       { sql: '= ?' },
  ne:       { sql: '<> ?' },
  contains: { sql: 'LIKE ?', like: v => `%${v}%` },
  starts:   { sql: 'LIKE ?', like: v => `${v}%` },
  lt:       { sql: '< ?' },
  gt:       { sql: '> ?' },
  null:     { sql: 'IS NULL', noValue: true },
  notnull:  { sql: 'IS NOT NULL', noValue: true },
};
const DEFAULT_ENGINE = 'mysql'; // connessioni senza "type" (create prima dei motori)
// Formati di export
const EXPORT_FORMATS = {
  csv:  { type: 'text/csv; charset=utf-8' },
  json: { type: 'application/json; charset=utf-8' },
  sql:  { type: 'application/sql; charset=utf-8' },
};
// CSV RFC 4180: virgolette se servono; la stringa vuota è "" (il campo vuoto è NULL)
const csvField = v => {
  const str = String(v);
  return str === '' || /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};
// Binari in esadecimale nei file (senza troncamento), il resto invariato
// Le colonne JSON possono arrivare dal driver come oggetti: si passano come testo JSON
const isJsonValue = v => v !== null && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date);

const exportValue = v => Buffer.isBuffer(v) ? `0x${v.toString('hex')}` : isJsonValue(v) ? JSON.stringify(v) : v;
const escapeLike = v => String(v).replace(/[\\%_]/g, m => '\\' + m);

// Valori pronti per il JSON: i binari diventano esadecimale (troncato)
function cell(v) {
  if (Buffer.isBuffer(v)) return v.length <= 64 ? `0x${v.toString('hex')}` : `0x${v.subarray(0, 64).toString('hex')}… (${v.length} byte)`;
  if (isJsonValue(v)) return JSON.stringify(v);
  return v;
}

module.exports = function createDbClient(ctx) {
  const { pick } = ctx.lib.config;
  const { ApiError, errorBody } = ctx.lib.errors;
  const { KEY_RE, isPort, isText } = ctx.lib.validate;
  const tunnels = ctx.require('tunnels'); // opzionale: senza, niente connessioni via tunnel
  const git = ctx.require('git');         // opzionale: repository per le migration

  const vault = ctx.vault; // vault della master password del core

  // ---- motori (estensioni con la capacità "db-engine"), letti a ogni uso ----
  const engineType = c => c?.type || DEFAULT_ENGINE;
  const engineEntry = type => ctx.providers('db-engine').find(e => e.id === type) || null;
  const engineOf = c => engineEntry(engineType(c))?.impl || null;
  function engineFor(conn) {
    const e = engineOf(conn);
    if (!e) throw ctx.error(400, 'engine_missing', { type: engineType(conn) });
    return e;
  }
  const ENGINE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
  // Livello sotto la connessione ("db" nelle route, nell'albero e nelle tab): il database per i
  // motori senza schemi (MySQL), lo schema per quelli con schemi (PostgreSQL: il database è fisso,
  // quello della connessione). Predefinito: il database della connessione, o lo schema del motore
  const hasSchemas = engine => !!engine?.dialect?.schemas;
  const defaultScope = (conn, engine = engineOf(conn)) => (hasSchemas(engine)
    ? (typeof engine.defaultSchema === 'function' ? engine.defaultSchema(conn) : engine.defaultSchema) || null
    : conn.database || null);
  const connections = () => ctx.config.get('dbConnections');
  const folders = () => ctx.config.get('dbFolders');

  // Password in chiaro di una connessione (solo lato server, al momento di connettersi)
  function decryptPassword(conn) {
    if (!conn.password) return '';
    return vault.decrypt(conn.password);
  }

  // Cambio della master password: le password ri-cifrate si salvano insieme al nuovo vault;
  // reset: cancellate; blocco: niente connessioni aperte senza vault sbloccato
  vault.register({
    rekey(reencrypt, cfg) {
      const list = cfg.dbConnections || [];
      return { sections: { dbConnections: list.map(c => (c.password ? { ...c, password: reencrypt(c.password) } : c)) }, count: list.filter(c => c.password).length };
    },
    reset: cfg => ({ dbConnections: (cfg.dbConnections || []).map(c => ({ ...c, password: null })) }),
    lock: () => closePools(),
  });

  // ---- connessioni ----

  function validateConnection(c) {
    if (!c || typeof c !== 'object') throw ctx.error.config('connection_invalid');
    const bad = field => ctx.error.config(`connection_${field}`, { id: String(c.id ?? '') });
    if (!KEY_RE.test(c.id || '')) throw bad('id');
    if (!isText(c.label)) throw bad('label');
    // il motore può non essere installato (connessione importata o motore spento): resta valida
    if (c.type != null && !ENGINE_RE.test(c.type)) throw bad('type');
    // motori su file (SQLite): il file al posto di host, porta e utente
    if (c.file != null) {
      if (typeof c.file !== 'string' || !c.file.trim() || c.file.length > 1024 || c.file.includes('\0')) throw bad('file');
    } else if (c.tunnel != null) {
      if (!KEY_RE.test(c.tunnel)) throw bad('tunnel');
    } else {
      if (!HOST_RE.test(c.host || '')) throw bad('host');
      if (!isPort(c.port)) throw bad('port');
    }
    if (c.database != null && c.database !== '' && !DB_NAME_RE.test(c.database)) throw bad('database');
    if (c.file == null ? !isText(c.user, 80) : (c.user != null && c.user !== '' && !isText(c.user, 80))) throw bad('user');
    if (c.password != null && !vault.isBox(c.password)) throw bad('password');
    if (c.projectId != null && !KEY_RE.test(c.projectId)) throw bad('project');
    if (c.readOnly != null && typeof c.readOnly !== 'boolean') throw bad('read_only');
    if (c.folder != null && !KEY_RE.test(c.folder)) throw bad('folder');
    if (c.options != null && (typeof c.options !== 'object' || Array.isArray(c.options) || Object.keys(c.options).length > 20
        || Object.entries(c.options).some(([k, v]) => !OPTION_KEY_RE.test(k) || !(typeof v === 'boolean' || Number.isFinite(v) || (typeof v === 'string' && v.length <= 200))))) throw bad('options');
    if (c.migrations != null) {
      const m = c.migrations;
      // "applied" veniva scritto dalla 1.8.0: accettato e ignorato
      if (typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some(k => !['repo', 'dir', 'applied'].includes(k))
          || !KEY_RE.test(m.repo || '') || !mig.isValidDir(m.dir)) throw bad('migrations');
    }
  }

  // Ciò che vede il frontend: mai la password, solo se c'è
  // Ciò che vede il frontend; tunnelMissing: il server tunnel usato è stato eliminato (o l'estensione non c'è)
  const tunnelMissing = c => !!c.tunnel && (!tunnels || !tunnels.getServer(c.tunnel));
  const publicConnection = c => ({
    ...pick(c, CONNECTION_FIELDS.filter(f => f !== 'password')), type: engineType(c), hasPassword: !!c.password,
    ...(tunnelMissing(c) ? { tunnelMissing: true } : {}),
    ...(engineOf(c) ? { defaultDb: defaultScope(c) } : { engineMissing: true }),
  });

  // Risposta di errore: gli errori con codice (anche di altre estensioni, es. tunnel non
  // pronto) passano com'erano; quelli del database o di sistema diventano db-client.database
  // con il messaggio originale (non tradotto) e il codice del database in params.dbCode
  const dbError = (e, engine) => {
    const info = engine?.errorInfo ? engine.errorInfo(e) : { message: e?.message || String(e), ...(e?.code ? { code: e.code } : {}) };
    return { error: info.message, ...(info.code ? { dbCode: info.code } : {}) };
  };
  function sendFailure(res, e, status = 400, extra = {}, engine = null) {
    if (e instanceof ApiError) return res.status(e.status).json({ ...errorBody(e), ...extra });
    if (e?.key && !(e?.status)) e = ctx.error(400, e.key, e.params); // vault.js
    else e = ctx.error(e?.status || status, 'database', dbError(e, engine));
    return res.status(e.status).json({ ...errorBody(e), ...extra });
  }
  // ---- migration: repository, cartelle, numerazione ----

  // Repository selezionabili: quelli dell'estensione Git, altrimenti le cartelle dei progetti
  function migrationRepos() {
    if (git) return { source: 'git', repos: git.repos() };
    return { source: 'projects', repos: ctx.projects.list().map(p => ({ id: p.id, label: p.label, path: p.path })) };
  }
  const repoOr404 = id => {
    const repo = migrationRepos().repos.find(r => r.id === id);
    if (!repo) throw ctx.error(404, 'repo_not_found', { id: String(id) });
    return repo;
  };
  // Errori di migrations.js → errori con codice (dir_not_found è 404)
  const migCall = fn => {
    try { return fn(); } catch (e) {
      if (e instanceof mig.MigrationError) throw ctx.error(e.key === 'dir_not_found' ? 404 : 400, e.key, e.params);
      throw e;
    }
  };

  // Numerazione della cartella: il numero più alto tra i file presenti, poi il successivo
  function numbering(repo, dir) {
    const abs = mig.resolveInside(repo.path, dir);
    const local = migCall(() => mig.scan(mig.folderFiles(repo.path, dir)));
    return { exists: !!abs && fs.existsSync(abs), ...local, next: local.current + 1, nextPrefix: mig.pad(local.current + 1, local.width) };
  }


  // Repository e cartella collegati alla connessione (null se non collegata o repository sparito)
  function linkedFolder(conn) {
    if (!conn.migrations) return null;
    const repo = migrationRepos().repos.find(r => r.id === conn.migrations.repo);
    if (!repo) return null;
    const abs = mig.resolveInside(repo.path, conn.migrations.dir);
    return abs ? { repo, dir: conn.migrations.dir, abs } : null;
  }

  // Errori del modello di schema del motore (DdlError con key) → errori con codice
  const ddlCall = (engine, fn) => {
    try { return fn(); } catch (e) {
      if (engine.ddl?.DdlError && e instanceof engine.ddl.DdlError) throw ctx.error(400, `ddl_${e.key}`, e.params);
      throw e;
    }
  };

  // Le istruzioni scritte a mano (raw) devono essere una sola istruzione di schema
  const SCHEMA_VERBS = new Set(['CREATE', 'ALTER', 'RENAME', 'DROP']);
  function checkRaw(engine, operations) {
    for (const op of operations || []) {
      if (op?.op !== 'raw') continue;
      const c = engine.sql.classify(op.sql);
      if (c.kind !== 'write' || !SCHEMA_VERBS.has(c.verb)) throw ctx.error(400, 'raw_not_schema');
      if (op.table && !DB_NAME_RE.test(op.table)) throw ctx.error(400, 'name_invalid');
    }
  }

  // ---- MCP ----
  const mcpUnlocked = () => { if (vault.state() !== 'unlocked') throw ctx.error(423, 'mcp_vault_locked'); };
  function mcpConnection(id) {
    mcpUnlocked();
    const conn = findConnection(id);
    if (!conn) throw ctx.error(404, 'connection_not_found', { id: String(id) });
    return conn;
  }
  function mcpDatabase(conn, database) {
    const db = database || defaultScope(conn);
    if (!db) throw ctx.error(400, 'mcp_database_required');
    if (!DB_NAME_RE.test(db)) throw ctx.error(400, 'database_invalid');
    return db;
  }

  const connectionOr404 = id => {
    const conn = findConnection(id);
    if (!conn) throw ctx.error(404, 'connection_not_found', { id: String(id) });
    return conn;
  };

  // Dati dal form → connessione da salvare. password: stringa = nuova (cifrata subito),
  // '' o assente = invariata, null = rimossa
  function buildConnection(body, existing = {}) {
    const c = { ...existing, ...pick(body || {}, ['label', 'host', 'port', 'database', 'user', 'projectId', 'tunnel', 'readOnly', 'folder', 'file']) };
    if (!existing.id) c.id = body.id;
    // motore: quello scelto (deve essere installato), altrimenti quello che aveva, altrimenti MySQL
    const type = body?.type ?? existing.type ?? DEFAULT_ENGINE;
    if (typeof type !== 'string' || !engineEntry(type)) throw ctx.error(400, 'engine_missing', { type: String(type) });
    c.type = type;
    if (c.tunnel && engineEntry(type).impl.connection?.tunnel === false) throw ctx.error(400, 'engine_no_tunnel');
    // campi che il motore non usa: tolti (un motore su file non ha host, porta, utente né tunnel)
    const fields = new Set(engineEntry(type).impl.connection?.fields || ['host', 'port', 'user', 'password', 'database']);
    if (fields.has('file')) {
      if (typeof c.file !== 'string' || !c.file.trim()) throw ctx.error(400, 'file_required');
      c.file = c.file.trim();
      for (const k of ['host', 'port', 'tunnel', 'user', 'database']) delete c[k];
      connectionFile(c); // percorso relativo senza progetto, o fuori dal progetto: rifiutato subito
    } else delete c.file;
    // opzioni dichiarate dal motore, con il tipo giusto (le altre sono ignorate)
    const declared = engineEntry(type).impl.connection?.options || [];
    if (body?.options && typeof body.options === 'object') {
      const opts = {};
      for (const o of declared) {
        const v = body.options[o.key];
        if (v === undefined || v === '' || v === null) continue;
        if (o.type === 'boolean') opts[o.key] = v === true || v === 'true';
        else if (o.type === 'select') { if ((o.choices || []).some(ch => ch.value === v)) opts[o.key] = v; else throw ctx.error(400, 'option_invalid', { option: o.key }); }
        else opts[o.key] = String(v).slice(0, 200);
      }
      if (Object.keys(opts).length) c.options = opts; else delete c.options;
    }
    if (c.port !== undefined && c.port !== null && c.port !== '') c.port = Number(c.port);
    for (const k of ['database', 'projectId', 'tunnel']) if (c[k] === '') c[k] = null;
    if (!c.folder) delete c.folder; // nella radice della sidebar
    else if (!folders().some(f => f.id === c.folder)) throw ctx.error(400, 'folder_unknown', { folder: String(c.folder) });
    c.readOnly = !!c.readOnly;
    if (c.tunnel) {
      if (!tunnels) throw ctx.error(400, 'tunnels_unavailable');
      if (!tunnels.getServer(c.tunnel)) throw ctx.error(400, 'tunnel_unknown', { tunnel: String(c.tunnel) });
      delete c.host; delete c.port; // host e porta vengono dal tunnel
    }
    if (typeof body.password === 'string' && body.password !== '') {
      c.password = vault.encrypt(body.password);
    } else if (body.password === null) {
      c.password = null;
    } else if (c.password === undefined) {
      c.password = null;
    }
    return c;
  }

  // Parametri di connessione per il motore (avvia il tunnel se la connessione lo usa)
  // File di un motore su file: assoluto, o relativo alla cartella del progetto collegato (senza uscirne)
  function connectionFile(conn) {
    if (!conn.file) return undefined;
    if (path.isAbsolute(conn.file)) return path.normalize(conn.file);
    const project = conn.projectId && ctx.projects.get(conn.projectId);
    if (!project) throw ctx.error(400, 'file_relative_project', { file: conn.file });
    const abs = path.resolve(project.path, conn.file);
    if (abs !== project.path && !abs.startsWith(project.path + path.sep)) throw ctx.error(400, 'file_outside_project', { file: conn.file });
    return abs;
  }

  async function connectionTarget(conn) {
    let host = conn.host, port = conn.port, via = null;
    if (conn.tunnel) {
      if (!tunnels) throw ctx.error(400, 'tunnels_unavailable');
      if (!tunnels.getServer(conn.tunnel)) throw ctx.error(400, 'tunnel_deleted', { tunnel: conn.tunnel });
      const t = await tunnels.ensureTunnel(conn.tunnel);
      host = '127.0.0.1'; port = t.port; via = t.label;
    }
    return {
      options: { host, port, user: conn.user, password: decryptPassword(conn), database: conn.database || undefined, connectTimeout: CONNECT_TIMEOUT_MS, options: conn.options || {}, file: connectionFile(conn) },
      via,
    };
  }

  const findConnection = id => connections().find(c => c.id === id) || null;

  // ---- pool e query ----

  const pools = new Map(); // "id\0database" → { pool, signature, engine }
  const confirmSecret = crypto.randomBytes(32); // i token di conferma valgono solo fino al riavvio

  function closePools(id) {
    for (const [k, p] of pools) {
      if (id && !k.startsWith(id + '\0')) continue;
      try { p.engine.closePool(p.pool); } catch { /* già chiuso */ }
      pools.delete(k);
    }
  }

  // database: quello da usare; false = nessuno, nemmeno quello predefinito della connessione
  async function poolFor(conn, database) {
    const engine = engineFor(conn);
    const k = `${conn.id}\0${database === false ? '\0none' : database || ''}`;
    const signature = JSON.stringify(conn);
    const cached = pools.get(k);
    if (cached && cached.signature === signature && cached.engine === engine) return cached.pool;
    if (cached) { try { cached.engine.closePool(cached.pool); } catch { /* già chiuso */ } pools.delete(k); }
    const { options } = await connectionTarget(conn);
    // motori con schemi: il database resta quello della connessione, "database" è lo schema
    const target = hasSchemas(engine)
      ? { ...options, schema: database === false ? undefined : database || defaultScope(conn, engine) }
      : { ...options, database: database === false ? undefined : database || options.database };
    // readOnly: sola lettura anche lato server, una scrittura sfuggita al controllo fallisce comunque
    const pool = engine.createPool(target, { readOnly: !!conn.readOnly });
    pools.set(k, { pool, signature, engine });
    return pool;
  }

  // Parti comuni di anteprima ed export di una tabella: colonne verificate, WHERE con
  // parametri (ricerca su tutte le colonne + filtri), ORDER BY su una colonna esistente
  async function tableQuery(engine, pool, db, table, { search, filters, sort } = {}) {
    if (!DB_NAME_RE.test(db || '') || !DB_NAME_RE.test(table || '')) throw ctx.error(400, 'name_invalid');
    const columns = await engine.columns(pool, db, table);
    if (!columns.length) throw ctx.error(404, 'table_not_found', { table });
    const quoteId = engine.quoteId;
    const names = new Set(columns.map(c => c.name));
    const where = [], params = [];
    const text = typeof search === 'string' ? search.trim() : '';
    if (text) {
      // likeOperator: ILIKE dove LIKE distingue maiuscole e minuscole (PostgreSQL), come in MySQL
      // search(colonna): espressione del motore con un ? (es. Oracle: UPPER(…) LIKE UPPER(?))
      where.push('(' + columns.map(c => (engine.search ? engine.search(quoteId(c.name)) : `${engine.asText(quoteId(c.name))} ${engine.likeOperator || 'LIKE'} ?`)).join(' OR ') + ')');
      columns.forEach(() => params.push(`%${escapeLike(text)}%`));
    }
    for (const f of Array.isArray(filters) ? filters : []) {
      const op = FILTER_OPS[f?.op];
      if (!op || !names.has(f.column)) throw ctx.error(400, 'filter_invalid', { column: String(f?.column), op: String(f?.op) });
      where.push(`${quoteId(f.column)} ${op.like && engine.likeOperator ? op.sql.replace('LIKE', engine.likeOperator) : op.sql}`);
      if (!op.noValue) params.push(op.like ? op.like(escapeLike(f.value ?? '')) : f.value ?? '');
    }
    let orderSql = '';
    if (sort?.column) {
      if (!names.has(sort.column)) throw ctx.error(400, 'column_unknown', { columns: String(sort.column) });
      orderSql = ` ORDER BY ${quoteId(sort.column)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'}`;
    }
    return { columns, from: engine.qualify(db, table), whereSql: where.length ? ` WHERE ${where.join(' AND ')}` : '', params, orderSql };
  }

  // ---- export ----

  const pendingExports = new Map(); // id → { connId, format, spec, filename, expires }

  // Valori dei parametri delle query (? e :nome) usati dall'editor: solo in memoria,
  // persi al riavvio. Per query ("connessione\0testo") e per nome del parametro.
  const MAX_SAVED_QUERIES = 200, MAX_SAVED_NAMES = 500;
  const savedQueryParams = new Map(); // → { chiave: { value, type } }
  const savedParamNames = new Map();  // nome → { value, type }
  const PARAM_TYPES = new Set(['auto', 'text', 'number', 'null']);
  const isSavedValue = v => v && typeof v === 'object' && typeof v.value === 'string' && v.value.length <= 10000 && PARAM_TYPES.has(v.type);
  // Inserimento in fondo (più recente) e taglio dei più vecchi
  const remember = (map, key, value, max) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  };

  // Scrive su res rispettando il backpressure (attende 'drain' se il buffer è pieno)
  const writeOut = (res, text) => res.write(text) ? null : new Promise(r => res.once('drain', r));

  // Export riga per riga dal flusso del motore, rispettando il backpressure della risposta
  async function streamExport(engine, pool, job, res) {
    const { format, spec } = job;
    const quoteId = engine.quoteId;
    let header = '';
    if (spec.withCreate) header = `-- Structure\nDROP TABLE IF EXISTS ${quoteId(spec.table)};\n${await engine.createTableText(pool, spec.db, spec.table)};\n\n`;
    res.setHeader('Content-Type', EXPORT_FORMATS[format].type);
    res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
    res.write(format === 'sql' ? `-- Export Kelbo ${new Date().toISOString()}\n${header}` : '');
    let fields = null, count = 0, batch = [], aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; }); // download interrotto
    const flushSql = () => {
      if (!batch.length) return null;
      const text = `INSERT INTO ${quoteId(spec.table)} (${fields.map(quoteId).join(', ')}) VALUES\n${batch.join(',\n')};\n`;
      batch = [];
      return writeOut(res, text);
    };
    for await (const item of engine.stream(pool, spec.sql, spec.params)) {
      if (aborted) break; // chiude il flusso del motore
      if (!Array.isArray(item)) {
        fields = item.fields;
        if (format === 'csv') res.write(fields.map(csvField).join(',') + '\r\n');
        if (format === 'json') res.write('[');
        continue;
      }
      let wait = null;
      if (format === 'csv') wait = writeOut(res, item.map(exportValue).map(v => v === null ? '' : csvField(v)).join(',') + '\r\n');
      else if (format === 'json') { const values = item.map(exportValue); wait = writeOut(res, (count ? ',\n' : '\n') + JSON.stringify(Object.fromEntries(fields.map((f, i) => [f, values[i]])))); }
      // in SQL i binari diventano letterali del dialetto; il JSON resta testo JSON
      else { batch.push('(' + item.map(v => engine.literal(v)).join(', ') + ')'); if (batch.length >= 100) wait = flushSql(); }
      count++;
      if (wait) await wait;
    }
    if (aborted) return count;
    if (format === 'json') res.write(count ? '\n]\n' : ']\n');
    if (format === 'sql') { await flushSql(); res.write(`-- ${count} rows\n`); }
    res.end();
    return count;
  }

  // Token di conferma legato a connessione, database e testo esatto dell'istruzione
  const confirmToken = (conn, database, sql) =>
    crypto.createHmac('sha256', confirmSecret).update(`${conn.id}\0${database || ''}\0${sql}`).digest('hex');

  // Righe totali senza il limite di Kelbo né il LIMIT della query: quelle restituite se non
  // c'erano limiti, altrimenti un COUNT(*) della stessa SELECT (null se non riesce, es. colonne
  // con lo stesso nome in una JOIN)
  async function totalsOf(engine, pool, sql, result, session = null) {
    let total = null, queryLimit = null;
    const counting = result.kind === 'rows' ? engine.sql.countQuery(sql) : null;
    if (counting) {
      queryLimit = counting.limit;
      if (!result.truncated && !counting.limit) total = result.rowCount;
      else {
        try { total = Number((await engine.execute(pool, counting.sql, 1, { session })).rows[0]?.[0]); } catch { total = null; }
        if (!Number.isFinite(total)) total = null;
      }
    }
    return { total, queryLimit };
  }

  // Più istruzioni in un testo: una conferma per tutto il gruppo se almeno una modifica qualcosa
  // (firmata sull'intero testo), poi in ordine sulla stessa connessione (variabili di sessione,
  // tabelle temporanee, START TRANSACTION … COMMIT), fermandosi al primo errore. Ogni istruzione
  // va da sola in autocommit, come in un client SQL.
  const MAX_STATEMENTS = 100;
  async function runBatch(req, res, engine, conn, statements, { sql, database, limit, confirm, bound }) {
    if (statements.length > MAX_STATEMENTS) throw ctx.error(400, 'batch_too_many', { max: MAX_STATEMENTS });
    const kinds = statements.map(s => engine.sql.classify(s.sql));
    const bad = kinds.findIndex(k => k.kind === 'invalid' || k.kind === 'empty');
    if (bad !== -1) throw ctx.error(400, 'batch_statement', { n: bad + 1, error: ctx.error(400, `sql_${kinds[bad].reason}`).message });
    const writes = kinds.filter(k => k.kind === 'write');
    if (writes.length) {
      if (conn.readOnly) throw ctx.error(403, 'read_only_statement', { verb: writes[0].verb || '?' });
      const token = confirmToken(conn, database, sql);
      const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
      if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
        const verbs = [...new Set(writes.map(k => k.verb || '?'))].join(', ');
        return res.status(428).json({ needsConfirmation: true, token, verb: verbs, reason: null, word: null, database, sql, statements: statements.length, writes: writes.length, migration: null });
      }
    }
    const pool = await poolFor(conn, database);
    const session = await engine.acquire(pool);
    const started = Date.now();
    const results = [];
    let failed = null;
    try {
      for (const [i, s] of statements.entries()) {
        try {
          const result = await engine.execute(pool, s.sql, limit, { session });
          const totals = kinds[i].kind === 'read' ? await totalsOf(engine, pool, s.sql, result, session) : { total: null, queryLimit: null };
          results.push({ n: i + 1, sql: s.sql, start: s.start, statement: kinds[i].kind, verb: kinds[i].verb, ...result, ...totals, limit });
        } catch (e) {
          failed = i + 1;
          results.push({ n: i + 1, sql: s.sql, start: s.start, statement: kinds[i].kind, verb: kinds[i].verb, kind: 'error', ...dbError(e, engine) });
          break;
        }
      }
    } finally { engine.release(session); }
    res.json({
      kind: 'batch', ms: Date.now() - started, database, limit, statements: statements.length, failed,
      skipped: failed ? statements.length - failed : 0, results, ...(bound ? { sql } : {}),
    });
  }

  // ---- regole delle sezioni di config ----

  const config = {
    dbFolders: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(f => pick(f || {}, FOLDER_FIELDS)) : v),
      validate(list) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list', { section: 'dbFolders' });
        const seen = new Set();
        for (const f of list) {
          if (!f || typeof f !== 'object' || !KEY_RE.test(f.id || '')) throw ctx.error.config('folder_id', { id: String(f?.id ?? '') });
          if (!isText(f.label, 100)) throw ctx.error.config('folder_label', { id: f.id });
          if (seen.has(f.id)) throw ctx.error.config('duplicate_folder', { id: f.id });
          seen.add(f.id);
        }
      },
    },
    dbConnections: {
      empty: [], idField: 'id',
      normalize: v => (Array.isArray(v) ? v.map(c => pick(c || {}, CONNECTION_FIELDS)) : v),
      validate(list, cfg) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list', { section: 'dbConnections' });
        const seen = new Set();
        for (const c of list) {
          validateConnection(c);
          if (seen.has(c.id)) throw ctx.error.config('duplicate_connection', { id: c.id });
          seen.add(c.id);
          if (c.password != null && !cfg.vault) throw ctx.error.config('password_without_vault', { id: c.id });
          if (c.folder != null && !(cfg.dbFolders || []).some(f => f?.id === c.folder)) throw ctx.error.config('connection_folder_missing', { id: c.id, folder: c.folder });
        }
      },
    },
  };


  return {
    config,

    // Dati collegati a un progetto (pannello 📁 del core, prima di rimuoverlo)
    projectLinks: project => connections().filter(c => c.projectId === project.id)
      .map(c => ({ key: 'links.connection', params: { name: c.label } })),

    handlers: {
      // Motori installati con i dati che servono al frontend (campi, dialetto, driver)
      info(req, res) {
        const engines = ctx.providers('db-engine').map(e => ({
          id: e.id, title: e.title, extension: e.extension,
          connection: e.impl.connection, dialect: e.impl.dialect, driver: e.impl.driver?.() || null,
        }));
        const mysqlInfo = engines.find(e => e.id === DEFAULT_ENGINE);
        res.json({
          engines, defaultEngine: mysqlInfo ? DEFAULT_ENGINE : engines[0]?.id || null,
          // campi di prima (dalla 2.29 ogni motore ha i suoi in engines[].dialect.ddl)
          ...(mysqlInfo ? { driver: mysqlInfo.driver?.name, version: mysqlInfo.driver?.version, ready: true, ddl: mysqlInfo.dialect.ddl } : { ready: false }),
        });
      },

      // ---- valori dei parametri delle query (in memoria) ----

      // { connection, sql, names } → { query: valori salvati per quella query | null, byName }
      paramValues(req, res) {
        const { connection, sql, names } = req.body;
        if (typeof connection !== 'string' || typeof sql !== 'string') throw ctx.error(400, 'params_invalid');
        const byName = Object.fromEntries((Array.isArray(names) ? names : [])
          .filter(n => typeof n === 'string' && savedParamNames.has(n)).map(n => [n, savedParamNames.get(n)]));
        res.json({ query: savedQueryParams.get(`${connection}\0${sql.trim()}`) || null, byName });
      },

      // { connection, sql, params: [{ key, name }], values: { chiave: { value, type } } }
      saveParamValues(req, res) {
        const { connection, sql, params, values } = req.body;
        if (typeof connection !== 'string' || typeof sql !== 'string' || !Array.isArray(params) || !values || typeof values !== 'object'
            || !params.every(p => typeof p?.key === 'string' && typeof p?.name === 'string' && isSavedValue(values[p.key]))) {
          throw ctx.error(400, 'params_invalid');
        }
        const clean = Object.fromEntries(params.map(p => [p.key, { value: values[p.key].value, type: values[p.key].type }]));
        remember(savedQueryParams, `${connection}\0${sql.trim()}`, clean, MAX_SAVED_QUERIES);
        for (const p of params) remember(savedParamNames, p.name, clean[p.key], MAX_SAVED_NAMES);
        res.json({ ok: true });
      },

      // ---- connessioni ----

      listConnections(req, res) {
        res.json({ connections: connections().map(publicConnection), folders: folders(), tunnelsAvailable: !!tunnels,
          engines: ctx.providers('db-engine').map(e => ({ id: e.id, title: e.title })) });
      },

      // ---- cartelle della sidebar (un livello) ----

      createFolder(req, res) {
        const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
        if (!isText(label, 100)) throw ctx.error(400, 'folder_label_required');
        const f = { id: `f${crypto.randomBytes(4).toString('hex')}`, label };
        ctx.config.set('dbFolders', [...folders(), f]);
        res.json(f);
      },

      updateFolder(req, res) {
        const list = folders();
        const f = list.find(x => x.id === req.params.id);
        if (!f) throw ctx.error(404, 'folder_unknown', { folder: req.params.id });
        const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
        if (!isText(label, 100)) throw ctx.error(400, 'folder_label_required');
        f.label = label;
        ctx.config.set('dbFolders', list);
        res.json(f);
      },

      // Le connessioni della cartella tornano nella radice (stessa scrittura)
      deleteFolder(req, res) {
        const id = req.params.id;
        ctx.config.update({
          dbFolders: folders().filter(f => f.id !== id),
          dbConnections: connections().map(c => { if (c.folder !== id) return c; const { folder, ...rest } = c; return rest; }),
        });
        res.json({ ok: true });
      },

      createConnection(req, res) {
        if (findConnection(req.body.id)) throw ctx.error(409, 'id_exists', { id: String(req.body.id) });
        const c = buildConnection(req.body);
        ctx.config.set('dbConnections', [...connections(), c]);
        res.json({ ok: true, connection: publicConnection(c) });
      },

      updateConnection(req, res) {
        const list = connections();
        const idx = list.findIndex(c => c.id === req.params.id);
        if (idx === -1) throw ctx.error(404, 'connection_not_found', { id: req.params.id });
        list[idx] = buildConnection(req.body, list[idx]);
        ctx.config.set('dbConnections', list);
        closePools(req.params.id);
        res.json({ ok: true, connection: publicConnection(list[idx]) });
      },

      deleteConnection(req, res) {
        ctx.config.set('dbConnections', connections().filter(c => c.id !== req.params.id));
        closePools(req.params.id);
        res.json({ ok: true });
      },

      // Prova di connessione: versione del server e utente effettivo
      async testConnection(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        try {
          const { options, via } = await connectionTarget(conn);
          const started = Date.now();
          const row = await engine.test(options);
          res.json({ ok: true, ...row, via, ms: Date.now() - started });
        } catch (e) {
          sendFailure(res, e, 502, {}, engine);
        }
      },

      // Elenco dei database visibili dalla connessione (per il selettore)
      async databases(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        try {
          // senza database predefinito: l'elenco arriva anche se quello della connessione non esiste
          const databases = await engine.listDatabases(await poolFor(conn, false));
          const def = defaultScope(conn, engine);
          res.json({ databases, default: def, defaultMissing: !!def && !databases.includes(def), schemas: hasSchemas(engine) });
        } catch (e) {
          sendFailure(res, e, 502, {}, engine);
        }
      },

      // Tabelle e viste di un database (letture su information_schema, con parametri)
      async tables(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        if (!DB_NAME_RE.test(req.params.db)) throw ctx.error(400, 'database_invalid');
        try {
          res.json({ tables: await engine.listTables(await poolFor(conn), req.params.db) });
        } catch (e) {
          sendFailure(res, e, 502, {}, engine);
        }
      },

      // Struttura di una tabella: colonne, indici, chiavi esterne
      async tableInfo(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        const { db, table } = req.params;
        if (!DB_NAME_RE.test(db) || !DB_NAME_RE.test(table)) throw ctx.error(400, 'name_invalid');
        try {
          const info = await engine.tableInfo(await poolFor(conn), db, table);
          if (!info) throw ctx.error(404, 'table_not_found', { table });
          res.json(info);
        } catch (e) {
          sendFailure(res, e, 502, {}, engine);
        }
      },

      // Anteprima dei dati di una tabella: pagina, ricerca, filtri, ordinamento.
      // Colonne e operatori sono verificati, i valori passano come parametri.
      async rows(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        const { db, table } = req.params;
        const pageSize = PAGE_SIZES.includes(Number(req.body.pageSize)) ? Number(req.body.pageSize) : 50;
        const page = Math.max(1, parseInt(req.body.page) || 1);
        try {
          const pool = await poolFor(conn);
          const t = await tableQuery(engine, pool, db, table, req.body);
          const { rows: [counted] } = await engine.query(pool, `SELECT COUNT(*) AS total FROM ${t.from}${t.whereSql}`, t.params);
          const total = counted.total ?? Object.values(counted)[0];
          const paged = engine.page(`SELECT * FROM ${t.from}${t.whereSql}${t.orderSql}`, t.params, pageSize, (page - 1) * pageSize);
          const { rows } = await engine.query(pool, paged.sql, paged.params, { rowsAsArray: true });
          res.json({
            columns: t.columns,
            primaryKey: t.columns.filter(c => c.key === 'PRI').map(c => c.name),
            rows: rows.map(r => r.map(cell)),
            total: Number(total), page, pageSize, pageSizes: PAGE_SIZES,
          });
        } catch (e) {
          sendFailure(res, e, 400, {}, engine);
        }
      },

      // Export (passo 1): valida sorgente e formato e restituisce un id usa e getta
      async createExport(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        const { format, source } = req.body;
        if (!EXPORT_FORMATS[format]) throw ctx.error(400, 'format_invalid');
        try {
          let spec, name;
          if (source?.type === 'table') {
            const t = await tableQuery(engine, await poolFor(conn), source.db, source.table, source);
            spec = { sql: `SELECT * FROM ${t.from}${t.whereSql}${t.orderSql}`, params: t.params, database: null,
                     table: source.table, db: source.db, withCreate: format === 'sql' && source.withCreate !== false };
            name = source.table;
          } else if (source?.type === 'query') {
            const c = engine.sql.classify(source.sql);
            if (c.kind !== 'read') throw ctx.error(400, 'export_read_only');
            const database = source.database || defaultScope(conn, engine);
            if (database && !DB_NAME_RE.test(database)) throw ctx.error(400, 'database_invalid');
            spec = { sql: source.sql, params: [], database, table: 'result', db: null, withCreate: false };
            name = 'query';
          } else {
            throw ctx.error(400, 'source_invalid');
          }
          const id = crypto.randomUUID();
          const filename = `${String(name).replace(/[^A-Za-z0-9_.-]+/g, '_')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${format}`;
          pendingExports.set(id, { connId: conn.id, format, spec, filename, expires: Date.now() + 60000 });
          res.json({ id, filename });
        } catch (e) {
          sendFailure(res, e, 400, {}, engine);
        }
      },

      // Export (passo 2): il file viene generato riga per riga dal flusso di MySQL
      async downloadExport(req, res) {
        const job = pendingExports.get(req.params.exportId);
        pendingExports.delete(req.params.exportId);
        if (!job || job.expires < Date.now()) throw ctx.error(404, 'export_expired');
        const conn = connectionOr404(job.connId);
        const engine = engineFor(conn);
        try {
          const pool = await poolFor(conn, job.spec.database);
          await streamExport(engine, pool, job, res);
        } catch (e) {
          if (!res.headersSent) sendFailure(res, e, 400, {}, engine);
          else res.destroy(e);
        }
      },

      // Inserimento, modifica o eliminazione di una riga. L'istruzione è generata qui
      // (valori escapati da mysql2) e, come ogni modifica, eseguita solo dopo la conferma
      // del testo esatto: la prima risposta è 428 con l'SQL e il token.
      // update-many: più righe modificate insieme ({ changes: [{ key, values }] }), un UPDATE
      // per riga eseguiti in un'unica transazione (tutti o nessuno).
      async row(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        const { db, table } = req.params;
        if (!DB_NAME_RE.test(db) || !DB_NAME_RE.test(table)) throw ctx.error(400, 'name_invalid');
        const { op, key, keys, values, confirm, changes } = req.body;
        if (!['insert', 'update', 'update-many', 'delete', 'delete-many'].includes(op)) throw ctx.error(400, 'operation_invalid');
        if (conn.readOnly) throw ctx.error(403, 'read_only');
        try {
          const pool = await poolFor(conn, db);
          const columns = await engine.columns(pool, db, table);
          if (!columns.length) throw ctx.error(404, 'table_not_found', { table });
          const names = new Set(columns.map(c => c.name));
          const pk = columns.filter(c => c.key === 'PRI').map(c => c.name);
          const from = engine.qualify(db, table);
          const keyOf = k => Object.fromEntries(pk.map(c => [c, k[c]]));

          const scalar = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);
          const checkValues = v => {
            const vals = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
            const unknown = Object.keys(vals).filter(k => !names.has(k));
            if (unknown.length) throw ctx.error(400, 'column_unknown', { columns: unknown.join(', ') });
            if (!Object.values(vals).every(scalar)) throw ctx.error(400, 'values_invalid');
            return vals;
          };
          const checkKey = k => {
            if (!pk.length) throw ctx.error(400, 'no_primary_key');
            if (!k || typeof k !== 'object' || pk.some(c => !(c in k) || !scalar(k[c]) || k[c] === null)) {
              throw ctx.error(400, 'primary_key_missing', { columns: pk.join(', ') });
            }
          };
          const updateSql = (k, vals) => {
            if (!Object.keys(vals).length) throw ctx.error(400, 'nothing_to_update');
            return engine.dml.update(from, vals, keyOf(k));
          };
          const askOrCheck = (sql, verb) => {
            const token = confirmToken(conn, db, sql);
            const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
            if (given.length === token.length && crypto.timingSafeEqual(given, Buffer.from(token))) return true;
            res.status(428).json({ needsConfirmation: true, token, verb, database: db, sql });
            return false;
          };

          if (op === 'update-many') {
            if (!Array.isArray(changes) || !changes.length || changes.length > 1000) throw ctx.error(400, 'rows_range');
            const statements = changes.map(ch => { checkKey(ch?.key); return updateSql(ch.key, checkValues(ch.values)); });
            const sql = statements.join(';\n');
            if (!askOrCheck(sql, 'UPDATE')) return;
            const affectedRows = await engine.transaction(pool, statements);
            return res.json({ kind: 'write', affectedRows, statements: statements.length, sql });
          }

          const vals = checkValues(values);

          // WHERE sulla chiave primaria completa (niente modifiche senza)
          let sql;
          if (op === 'delete-many') {
            if (!pk.length) throw ctx.error(400, 'no_primary_key');
            if (!Array.isArray(keys) || !keys.length || keys.length > 1000) throw ctx.error(400, 'rows_range');
            const valid = k => k && typeof k === 'object' && pk.every(c => c in k && scalar(k[c]) && k[c] !== null);
            if (!keys.every(valid)) throw ctx.error(400, 'primary_key_missing', { columns: pk.join(', ') });
            sql = engine.dml.deleteMany(from, pk, keys);
          } else if (op === 'insert') {
            sql = engine.dml.insert(from, vals);
          } else {
            checkKey(key);
            if (op === 'update') {
              if (!Object.keys(vals).length) throw ctx.error(400, 'nothing_to_update');
              sql = engine.dml.update(from, vals, keyOf(key));
            } else sql = engine.dml.delete(from, keyOf(key));
          }

          const token = confirmToken(conn, db, sql);
          const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
          if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
            return res.status(428).json({ needsConfirmation: true, token, verb: op === 'delete-many' ? 'DELETE' : op.toUpperCase(), database: db, sql });
          }
          const result = await engine.execute(pool, sql, 1);
          res.json({ ...result, sql });
        } catch (e) {
          sendFailure(res, e, 400, {}, engine);
        }
      },

      // Creazione di una tabella da una definizione strutturata: il CREATE TABLE è
      // generato qui e, come ogni modifica, eseguito solo dopo la conferma del testo esatto
      // (la risposta 428 fa anche da anteprima per il designer)
      async createTable(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        const { db } = req.params;
        if (!DB_NAME_RE.test(db)) throw ctx.error(400, 'database_invalid');
        if (conn.readOnly) throw ctx.error(403, 'read_only');
        const sql = ddlCall(engine, () => engine.ddl.createTableSql(db, req.body.definition));
        const token = confirmToken(conn, db, sql);
        const given = typeof req.body.confirm === 'string' ? Buffer.from(req.body.confirm) : Buffer.alloc(0);
        if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
          return res.status(428).json({ needsConfirmation: true, token, verb: 'CREATE', database: db, sql });
        }
        try {
          const result = await engine.execute(await poolFor(conn, db), sql, 1);
          res.json({ ...result, sql });
        } catch (e) {
          sendFailure(res, e, 400, { sql }, engine);
        }
      },

      // Esegue una istruzione. Le letture partono subito; tutto ciò che può modificare
      // dati o schema richiede il token di conferma di quella esatta istruzione (428).
      // Query parametriche (? e :nome): senza params la risposta è 422 con i parametri da
      // chiedere; con params i valori vengono escapati nel testo, e da lì è una query normale
      // (la conferma mostra e firma l'istruzione con i valori).
      async query(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        const { confirm, params } = req.body;
        let { sql } = req.body;
        const wanted = typeof sql === 'string' ? engine.sql.describeParams(sql) : [];
        if (wanted.length) {
          if (!params || typeof params !== 'object' || Array.isArray(params)) return res.status(422).json({ needsParams: true, params: wanted });
          const scalar = v => v === null || ['string', 'number', 'boolean'].includes(typeof v);
          if (!Object.values(params).every(scalar)) throw ctx.error(400, 'params_invalid');
          const bound = engine.sql.bindParams(sql, params);
          if (bound.missing) throw ctx.error(400, 'params_missing', { params: bound.missing.map(k => wanted.find(w => w.key === k)?.name || k).join(', ') });
          sql = bound.sql;
        }
        const database = req.body.database || defaultScope(conn, engine);
        if (database && !DB_NAME_RE.test(database)) throw ctx.error(400, 'database_invalid');
        const limit = Math.min(Math.max(parseInt(req.body.limit) || DEFAULT_ROW_LIMIT, 1), MAX_ROW_LIMIT);

        const statements = engine.sql.splitStatements(sql);
        if (statements.length > 1) return runBatch(req, res, engine, conn, statements, { sql, database, limit, confirm, bound: wanted.length > 0 });

        const c = engine.sql.classify(sql);
        if (c.kind === 'invalid' || c.kind === 'empty') throw ctx.error(400, `sql_${c.reason}`);
        if (c.kind === 'write') {
          if (conn.readOnly) throw ctx.error(403, 'read_only_statement', { verb: c.verb || '?' });
          const token = confirmToken(conn, database, sql);
          const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
          if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
            // istruzione di schema su una connessione collegata: la UI propone di salvarla come migration
            const migration = SCHEMA_VERBS.has(c.verb) && linkedFolder(conn) && database
              ? { proposal: engine.sql.schemaChange(sql) || { table: '', operation: 'alter' } } : null;
            return res.status(428).json({ needsConfirmation: true, token, verb: c.verb, reason: c.reason || null, word: c.word || null, database, sql, migration });
          }
        }
        try {
          const pool = await poolFor(conn, database);
          const result = await engine.execute(pool, sql, limit);
          const totals = c.kind === 'read' ? await totalsOf(engine, pool, sql, result) : { total: null, queryLimit: null };
          res.json({ ...result, ...totals, statement: c.kind, database, limit, ...(wanted.length ? { sql } : {}) });
        } catch (e) {
          sendFailure(res, e, 400, {}, engine);
        }
      },

      // Definizione di una tabella nel modello del designer (per modificarla)
      async tableDefinition(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        const { db, table } = req.params;
        if (!DB_NAME_RE.test(db) || !DB_NAME_RE.test(table)) throw ctx.error(400, 'name_invalid');
        try {
          const schema = await engine.introspect(await poolFor(conn), db, [table]);
          if (!schema.tables[table]) throw ctx.error(404, 'table_not_found', { table });
          res.json({ table, definition: schema.tables[table] });
        } catch (e) { sendFailure(res, e, 502, {}, engine); }
      },

      // Modifica di schema da un elenco di operazioni (designer, istruzioni dell'editor, confronto).
      // Senza conferma: 428 con l'SQL, gli avvisi e l'anteprima del file di migration.
      // Con la conferma (token dello stesso SQL): file nel repository (se collegato e richiesto),
      // poi le istruzioni sul DB; se nessuna istruzione riesce il file viene tolto.
      // migration.run === false: solo il file, il DB non viene toccato (la eseguirà il
      // gestore delle migration del progetto).
      async migrate(req, res) {
        const conn = connectionOr404(req.params.id);
        const engine = engineFor(conn);
        const schemaOps = engine.schema;
        const { db } = req.params;
        if (!DB_NAME_RE.test(db)) throw ctx.error(400, 'database_invalid');
        if (conn.readOnly) throw ctx.error(403, 'read_only');
        const { migration = {}, confirm, acknowledgeWarnings, design } = req.body;
        const folder = linkedFolder(conn);
        const save = !!folder && migration.save !== false;
        const run = migration.run !== false;

        try {
          const pool = await poolFor(conn, db);
          // Designer di una tabella esistente: operazioni dal confronto tra la struttura
          // attuale (letta ora dal DB) e quella modificata; renames { nuovo: vecchio }
          let operations = req.body.operations;
          if (design) {
            const t = design.table;
            if (!DB_NAME_RE.test(t || '')) throw ctx.error(400, 'name_invalid');
            const current = (await engine.introspect(pool, db, [t])).tables[t];
            if (!current) throw ctx.error(404, 'table_not_found', { table: t });
            const renames = Object.fromEntries(Object.entries(design.renames || {}).map(([to, from]) => [`${t}.${to}`, String(from)]));
            operations = schemaOps.diff({ tables: { [t]: current } }, { tables: { [t]: design.definition || {} } }, renames).ops;
            if (design.newName && design.newName !== t) operations.push({ op: 'rename_table', table: t, to: String(design.newName) });
          }
          checkRaw(engine, operations);
          const statements = ddlCall(engine, () => schemaOps.statements(db, operations));
          const sql = statements.join(';\n\n');
          const tables = [...new Set(operations.map(o => o.table).filter(Boolean))];
          const before = await engine.introspect(pool, db, tables);
          const warnings = schemaOps.destructive(operations, before);
          const proposal = schemaOps.proposeName(operations);
          const table = migration.table || proposal.table;
          const operation = migration.operation || proposal.operation;
          const fileFor = async () => {
            const n = numbering(folder.repo, folder.dir);
            return { n, name: migCall(() => mig.fileName(n.next, n.width, table, operation)) };
          };
          const content = name => mig.migrationContent(name, { connection: conn.label, database: db }, statements);

          const token = confirmToken(conn, db, sql);
          const given = typeof confirm === 'string' ? Buffer.from(confirm) : Buffer.alloc(0);
          if (given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) {
            const preview = save ? await fileFor() : null;
            return res.status(428).json({
              needsConfirmation: true, token, verb: 'DDL', database: db, sql, statements, warnings, operations,
              linked: !!folder, proposal: { table, operation },
              migration: preview && {
                file: preview.name, dir: folder.dir, repo: folder.repo.label, content: content(preview.name),
              },
            });
          }
          if (!run && !save) throw ctx.error(400, 'migration_nothing_to_do');
          if (run && warnings.length && acknowledgeWarnings !== true) throw ctx.error(409, 'warnings_not_acknowledged', { count: warnings.length });

          // 1. file nel repository (numero ricalcolato ora, mai sovrascritto)
          let file = null, abs = null;
          if (save) {
            if (!fs.existsSync(folder.abs)) throw ctx.error(404, 'dir_not_found', { dir: folder.dir });
            file = (await fileFor()).name;
            abs = migCall(() => mig.writeExclusive(folder.abs, file, content(file)));
          }
          if (!run) return res.json({ ok: true, ran: false, executed: [], file, dir: folder.dir, sql });
          // 2. istruzioni sul DB, una alla volta
          const executed = [];
          for (const statement of statements) {
            try {
              await engine.execute(pool, statement, 1);
              executed.push(statement);
            } catch (e) {
              // repository coerente con il DB: niente file se non è cambiato nulla,
              // altrimenti solo le istruzioni eseguite davvero
              if (abs && !executed.length) fs.rmSync(abs, { force: true });
              else if (abs) mig.writeAtomic(abs, mig.migrationContent(file, { connection: conn.label, database: db }, executed));
              return sendFailure(res, e, 400, { executed, failed: statement, file: executed.length ? file : null }, engine);
            }
          }
          res.json({ ok: true, ran: true, executed, file, dir: save ? folder.dir : null, sql });
        } catch (e) { sendFailure(res, e, 400, {}, engine); }
      },

      // ---- migration ----

      migrationRepos(req, res) {
        const { source, repos } = migrationRepos();
        res.json({ source, repos: repos.map(r => ({ id: r.id, label: r.label })) });
      },

      // Sottocartelle di ?dir= nel repository (browser delle cartelle)
      migrationFolders(req, res) {
        const repo = repoOr404(req.params.repo);
        res.json(migCall(() => mig.listFolders(repo.path, String(req.query.dir ?? ''))));
      },

      // Nuova cartella { parent, name } (creata solo su richiesta dell'utente)
      createMigrationFolder(req, res) {
        const repo = repoOr404(req.params.repo);
        const dir = migCall(() => mig.createFolder(repo.path, String(req.body.parent ?? ''), req.body.name));
        res.json({ ok: true, dir });
      },

      // Anteprima della numerazione di una cartella (prima di collegarla)
      async migrationScan(req, res) {
        const repo = repoOr404(req.params.repo);
        res.json(numbering(repo, String(req.query.dir ?? '')));
      },

      // Stato delle migration di una connessione
      async migrationStatus(req, res) {
        const conn = connectionOr404(req.params.id);
        if (!conn.migrations) return res.json({ linked: false });
        const repo = migrationRepos().repos.find(r => r.id === conn.migrations.repo);
        if (!repo) return res.json({ linked: true, repo: { id: conn.migrations.repo, missing: true }, dir: conn.migrations.dir });
        res.json({
          linked: true, repo: { id: repo.id, label: repo.label }, dir: conn.migrations.dir,
          ...numbering(repo, conn.migrations.dir),
        });
      },

      // Collega repository e cartella (la cartella deve esistere)
      linkMigrations(req, res) {
        const conn = connectionOr404(req.params.id);
        const repo = repoOr404(req.body.repo);
        const dir = String(req.body.dir ?? '');
        migCall(() => mig.listFolders(repo.path, dir)); // valida ed esiste
        const migrations = { repo: repo.id, dir };
        const list = connections().map(c => c.id === conn.id ? { ...c, migrations } : c);
        ctx.config.set('dbConnections', list);
        res.json({ ok: true, migrations });
      },

      unlinkMigrations(req, res) {
        const conn = connectionOr404(req.params.id);
        const list = connections().map(c => c.id === conn.id ? { ...c, migrations: null } : c);
        ctx.config.set('dbConnections', list);
        res.json({ ok: true });
      },

      // Connessioni da un file esportato altrove: le password vengono decifrate con la
      // master password di quel file e ri-cifrate con la chiave attuale (vault sbloccato)
      async importConnections(req, res) {
        if (vault.state() !== 'unlocked') vault.encrypt(''); // 423 del core: vault bloccato o da creare
        const { config: file, password, mode } = req.body;
        if (mode !== 'merge' && mode !== 'replace') throw ctx.error(400, 'mode_invalid');
        const incoming = file?.dbConnections;
        if (!Array.isArray(incoming)) throw ctx.error(400, 'file_no_connections');
        const withPassword = incoming.filter(c => c?.password);
        let fileVault = null;
        if (withPassword.length) {
          if (!vault.isRecord(file.vault)) throw ctx.error(400, 'file_no_vault');
          fileVault = await vault.openForeign(file.vault, password);
          if (!fileVault) throw ctx.error(401, 'wrong_file_password');
        }
        let converted;
        try {
          converted = incoming.map(c => {
            const conn = pick(c || {}, CONNECTION_FIELDS);
            conn.password = c?.password ? vault.encrypt(fileVault.decrypt(c.password)) : null;
            return conn;
          });
        } catch { throw ctx.error(400, 'file_passwords_unreadable'); }
        const fileFolders = Array.isArray(file.dbFolders) ? file.dbFolders.map(f => pick(f || {}, FOLDER_FIELDS)) : [];
        const currentFolders = folders();
        const folderIds = new Set(currentFolders.map(f => f.id));
        const nextFolders = mode === 'replace' ? fileFolders : [...currentFolders, ...fileFolders.filter(f => !folderIds.has(f.id))];
        const known = new Set(nextFolders.map(f => f?.id));
        for (const c of converted) if (c.folder != null && !known.has(c.folder)) delete c.folder; // cartella non nel file
        const current = connections();
        const ids = new Set(current.map(c => c.id));
        let next = mode === 'replace' ? converted : [...current, ...converted.filter(c => !ids.has(c.id))];
        next = next.map(c => (c.folder != null && !known.has(c.folder) ? (({ folder, ...rest }) => rest)(c) : c));
        ctx.config.update({ dbFolders: nextFolders, dbConnections: next }); // valida tutte le connessioni
        closePools();
        res.json({ ok: true, imported: mode === 'replace' ? converted.length : next.length - current.length, skipped: mode === 'replace' ? 0 : converted.filter(c => ids.has(c.id)).length });
      },
    },

    // sqlText(opzioni): istruzioni, segnaposto e conteggio con le regole di un dialetto (per i motori)
    services: { decryptPassword, sqlText: require('./sqltext'), schemaDiff: require('./schemadiff') },

    // Strumenti MCP: solo letture e solo con il vault sbloccato dall'interfaccia
    // (l'agente non riceve né può inserire la master password)
    mcp: {
      async connections() {
        mcpUnlocked();
        return {
          connections: connections().map(c => ({
            id: c.id, label: c.label, type: engineType(c), host: c.tunnel ? null : c.host, port: c.tunnel ? null : c.port,
            tunnel: c.tunnel || null, database: c.database || null, readOnly: !!c.readOnly,
          })),
        };
      },
      async databases({ connection }) {
        const conn = mcpConnection(connection);
        return { databases: await engineFor(conn).listDatabases(await poolFor(conn), { readOnly: true }) };
      },
      async tables({ connection, database }) {
        const conn = mcpConnection(connection);
        const db = mcpDatabase(conn, database);
        const tables = await engineFor(conn).listTables(await poolFor(conn), db);
        return { database: db, tables: tables.map(t => ({ ...t, type: undefined })) };
      },
      async describe({ connection, database, table }) {
        const conn = mcpConnection(connection);
        const db = mcpDatabase(conn, database);
        if (!DB_NAME_RE.test(table || '')) throw ctx.error(400, 'name_invalid');
        const schema = await engineFor(conn).introspect(await poolFor(conn), db, [table]);
        if (!schema.tables[table]) throw ctx.error(404, 'table_not_found', { table });
        return { database: db, table, ...schema.tables[table] };
      },
      async query({ connection, database, sql, limit = 100 }) {
        const conn = mcpConnection(connection);
        const db = database ? mcpDatabase(conn, database) : defaultScope(conn);
        const engine = engineFor(conn);
        const c = engine.sql.classify(sql);
        if (c.kind !== 'read') throw ctx.error(400, 'mcp_read_only', { verb: c.verb || '?' });
        const n = Math.min(Math.max(parseInt(limit) || 100, 1), 1000);
        const r = await engine.execute(await poolFor(conn, db), sql, n, { readOnly: true });
        return { database: db, columns: r.columns.map(col => col.name), rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, ms: r.ms };
      },
    },

    shutdown() { closePools(); },
  };
};
