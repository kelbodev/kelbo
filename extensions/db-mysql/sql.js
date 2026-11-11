// Classificazione delle istruzioni SQL (MySQL) prima di eseguirle.
// Solo le letture riconosciute possono partire senza conferma: tutto il resto,
// istruzioni sconosciute comprese, è trattato come scrittura.

const READ_START = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'TABLE', 'VALUES', 'HELP']);
const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'LOAD', 'CALL', 'DO', 'HANDLER', 'IMPORT', 'INSTALL', 'UNINSTALL',
  'LOCK', 'UNLOCK', 'SET', 'KILL', 'SHUTDOWN', 'FLUSH', 'RESET', 'PURGE', 'OPTIMIZE', 'REPAIR', 'ANALYZE',
]);

// Sostituisce stringhe, identificatori quotati e commenti con spazi (stessa lunghezza
// non serve): restano solo parole chiave, nomi e simboli. I commenti eseguibili
// /*! ... */ di MySQL vengono mantenuti, perché il server li esegue.
function mask(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\' && q !== '`') { i += 2; continue; }
        if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } break; }
        i++;
      }
      i++;
      out += q === '`' ? ' `ident` ' : " 'str' ";
    } else if (c === '-' && n === '-' && /\s/.test(sql[i + 2] ?? ' ') || c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && n === '*') {
      if (sql[i + 2] === '!') {          // /*!50000 ... */ → contenuto eseguito
        i += 3;
        while (/\d/.test(sql[i] ?? '')) i++;
        out += ' ';
        continue;
      }
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (c === '*' && n === '/') { // chiusura di un /*! ... */
      i += 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Istruzioni separate da ";" al primo livello (fuori da stringhe, identificatori quotati e
// commenti): [{ sql, start }] senza quelle vuote o di soli commenti. Le istruzioni composte
// (BEGIN … END di procedure e trigger, DELIMITER) non sono riconosciute.
function splitStatements(sql) {
  if (typeof sql !== 'string') return [];
  const out = [];
  let start = 0, i = 0;
  const push = end => {
    const text = sql.slice(start, end);
    if (mask(text).trim()) {
      const lead = text.length - text.trimStart().length;
      out.push({ sql: text.trim(), start: start + lead });
    }
  };
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\' && q !== '`') { i += 2; continue; }
        if (sql[i] === q) { if (sql[i + 1] === q) { i += 2; continue; } break; }
        i++;
      }
      i++;
    } else if ((c === '-' && n === '-' && /\s/.test(sql[i + 2] ?? ' ')) || c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === ';') {
      push(i);
      start = ++i;
    } else i++;
  }
  push(sql.length);
  return out;
}

// { kind: 'read' | 'write' | 'empty' | 'invalid', verb, reason?, word? }
// reason è un codice (tradotto dalla UI): missing, empty, single_statement, use_unsupported,
// explain_analyze_write, into, row_lock, write_word (con word = la parola trovata)
function classify(sql) {
  if (typeof sql !== 'string') return { kind: 'invalid', reason: 'missing' };
  const masked = mask(sql).trim().replace(/;\s*$/, '');
  if (!masked) return { kind: 'empty', reason: 'empty' };
  if (masked.includes(';')) return { kind: 'invalid', reason: 'single_statement' };

  const words = masked.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g) || [];
  const verb = words[0] || '';
  const has = w => words.includes(w);
  const write = (reason, word) => ({ kind: 'write', verb, ...(reason ? { reason } : {}), ...(word ? { word } : {}) });

  if (verb === 'USE') return { kind: 'invalid', verb, reason: 'use_unsupported' };
  if (!READ_START.has(verb)) return write();
  if (verb === 'SHOW' || verb === 'HELP') return { kind: 'read', verb }; // SHOW CREATE TABLE ecc. sono letture

  // EXPLAIN senza ANALYZE non esegue l'istruzione; con ANALYZE la esegue
  if (verb === 'EXPLAIN' || verb === 'DESCRIBE' || verb === 'DESC') {
    if (!has('ANALYZE')) return { kind: 'read', verb };
    return [...WRITE_WORDS].some(w => w !== 'ANALYZE' && has(w)) ? write('explain_analyze_write') : { kind: 'read', verb };
  }
  // SELECT ... INTO (variabili o file) e i lock in lettura non sono letture pure
  if (has('INTO')) return write('into');
  if (/\bFOR\s+(UPDATE|SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(masked)) return write('row_lock');
  // Una CTE può precedere UPDATE/DELETE; in generale nessuna parola di scrittura in una lettura
  // (REPLACE(...) e INSERT(...) seguiti da parentesi sono funzioni di stringa, non istruzioni)
  const writeWord = [...masked.toUpperCase().matchAll(/\b([A-Z_][A-Z0-9_$]*)\b(\s*\()?/g)]
    .filter(m => !m[2]).map(m => m[1])
    .find(w => WRITE_WORDS.has(w) && !['SET', 'DO', 'ANALYZE', 'LOCK', 'RESET', 'LOAD', 'CALL', 'HANDLER', 'KILL'].includes(w));
  if (writeWord) return write('write_word', writeWord);
  return { kind: 'read', verb };
}

// ---- istruzioni di schema: tabella e operazione per il nome della migration ----

// Testo senza commenti (le stringhe restano: servono i nomi tra backtick)
function stripComments(sql) {
  return sql.replace(/\/\*(?!!)[\s\S]*?\*\//g, ' ').replace(/(--\s|#)[^\n]*/g, ' ').trim().replace(/;\s*$/, '');
}

const IDENT = '(`(?:[^`]|``)+`|[A-Za-z0-9_$]+)';
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const unquote = id => (id && id.startsWith('`') ? id.slice(1, -1).replace(/``/g, '`') : id);
// db.tabella → tabella
const lastPart = (a, b) => unquote(b || a);
const slugOf = v => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// Virgole al primo livello (fuori da parentesi e stringhe): più clausole in un ALTER
function topLevelCommas(text) {
  let depth = 0, n = 0, q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; else if (c === '\\') i++; continue; }
    if (c === "'" || c === '"' || c === '`') q = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) n++;
  }
  return n;
}

// { table, operation } per CREATE/ALTER/RENAME/DROP TABLE e CREATE/DROP INDEX; null se non riconosciuta
function schemaChange(sql) {
  if (typeof sql !== 'string') return null;
  const text = stripComments(sql);
  const re = s => new RegExp(s, 'i');
  let m;
  if ((m = re(`^CREATE\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`).exec(text))) return { table: lastPart(m[1], m[2]), operation: 'create' };
  if ((m = re(`^DROP\\s+(?:TEMPORARY\\s+)?TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`).exec(text))) return { table: lastPart(m[1], m[2]), operation: 'drop' };
  if ((m = re(`^RENAME\\s+TABLE\\s+${QUALIFIED}`).exec(text))) return { table: lastPart(m[1], m[2]), operation: 'rename' };
  if ((m = re(`^CREATE\\s+(?:UNIQUE\\s+|FULLTEXT\\s+|SPATIAL\\s+)?INDEX\\s+${IDENT}\\s+ON\\s+${QUALIFIED}`).exec(text))) return { table: lastPart(m[2], m[3]), operation: `add_index_${slugOf(unquote(m[1]))}` };
  if ((m = re(`^DROP\\s+INDEX\\s+${IDENT}\\s+ON\\s+${QUALIFIED}`).exec(text))) return { table: lastPart(m[2], m[3]), operation: `drop_index_${slugOf(unquote(m[1]))}` };
  if (!(m = re(`^ALTER\\s+(?:ONLINE\\s+|IGNORE\\s+)?TABLE\\s+${QUALIFIED}\\s+([\\s\\S]*)$`).exec(text))) return null;
  const table = lastPart(m[1], m[2]);
  const clause = m[3].trim();
  if (topLevelCommas(clause)) return { table, operation: 'alter' };
  const rules = [
    [`^ADD\\s+(?:CONSTRAINT\\s+${IDENT}\\s+)?FOREIGN\\s+KEY`, x => `add_fk${x[1] ? `_${slugOf(unquote(x[1]))}` : ''}`],
    [`^ADD\\s+(?:CONSTRAINT\\s+${IDENT}\\s+)?PRIMARY\\s+KEY`, () => 'add_primary_key'],
    [`^ADD\\s+(?:CONSTRAINT\\s+${IDENT}\\s+)?(?:UNIQUE\\s+)?(?:INDEX|KEY)\\s+${IDENT}`, x => `add_index_${slugOf(unquote(x[2]))}`],
    [`^ADD\\s+(?:UNIQUE|INDEX|KEY|FULLTEXT|SPATIAL)\\b`, () => 'add_index'],
    [`^ADD\\s+(?:COLUMN\\s+)?${IDENT}`, x => `add_${slugOf(unquote(x[1]))}`],
    [`^DROP\\s+FOREIGN\\s+KEY\\s+${IDENT}`, x => `drop_fk_${slugOf(unquote(x[1]))}`],
    [`^DROP\\s+PRIMARY\\s+KEY`, () => 'drop_primary_key'],
    [`^DROP\\s+(?:INDEX|KEY)\\s+${IDENT}`, x => `drop_index_${slugOf(unquote(x[1]))}`],
    [`^DROP\\s+(?:COLUMN\\s+)?${IDENT}`, x => `drop_${slugOf(unquote(x[1]))}`],
    [`^MODIFY\\s+(?:COLUMN\\s+)?${IDENT}`, x => `modify_${slugOf(unquote(x[1]))}`],
    [`^CHANGE\\s+(?:COLUMN\\s+)?${IDENT}\\s+${IDENT}`, x => unquote(x[1]) === unquote(x[2]) ? `modify_${slugOf(unquote(x[1]))}` : `rename_${slugOf(unquote(x[1]))}`],
    [`^RENAME\\s+COLUMN\\s+${IDENT}`, x => `rename_${slugOf(unquote(x[1]))}`],
    [`^RENAME\\s+(?:TO|AS)?\\s*${QUALIFIED}`, () => 'rename'],
  ];
  for (const [pattern, op] of rules) {
    const x = re(pattern).exec(clause);
    if (x) return { table, operation: op(x) };
  }
  return { table, operation: 'alter' };
}

// ---- query parametriche: segnaposto ? e :nome ----

// Come mask, ma con la stessa lunghezza del testo (stringhe, identificatori quotati e
// commenti diventano spazi): le posizioni restano quelle della query originale
function blank(sql) {
  const out = sql.split('');
  const clear = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '\\' && c !== '`') { i += 2; continue; }
        if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } break; }
        i++;
      }
      i++;
      // un identificatore resta riconoscibile come nome (serve per dare il nome ai ?)
      if (c === '`') { const name = sql.slice(start + 1, i - 1).replace(/[^A-Za-z0-9_$]/g, '_'); clear(start, i); out.splice(start, name.length, ...name); }
      else clear(start, i);
    } else if ((c === '-' && n === '-' && /\s/.test(sql[i + 2] ?? ' ')) || c === '#') {
      const start = i;
      while (i < sql.length && sql[i] !== '\n') i++;
      clear(start, i);
    } else if (c === '/' && n === '*' && sql[i + 2] !== '!') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      clear(i, stop);
      i = stop;
    } else i++;
  }
  return out.join('');
}

// Segnaposto fuori da stringhe e commenti: [{ start, end, key, kind: 'positional' | 'named', name? }].
// ? → key "#1", "#2"…; :nome → key "nome" (non :: né :=, non dopo una lettera, es. etichette)
function placeholders(sql) {
  if (typeof sql !== 'string') return [];
  const text = blank(sql);
  const list = [];
  let n = 0;
  const re = /\?|(?<![A-Za-z0-9_$:]):([A-Za-z_][A-Za-z0-9_]*)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0] === '?') list.push({ start: m.index, end: m.index + 1, key: `#${++n}`, kind: 'positional' });
    else list.push({ start: m.index, end: m.index + m[0].length, key: m[1], kind: 'named', name: m[1] });
  }
  return list;
}

// Nome di un ? ricavato dal testo intorno (colonna confrontata, colonne di un INSERT,
// LIMIT/OFFSET, estremi di un BETWEEN); null se non si capisce
const COL = '(?:[A-Za-z0-9_$]+\\s*\\.\\s*)?([A-Za-z_][A-Za-z0-9_$]*)';
function guessName(text, p) {
  const before = text.slice(0, p.start), after = text.slice(p.end);
  let m;
  if ((m = new RegExp(`${COL}\\s*(?:=|<=>|<>|!=|<=|>=|<|>|\\bNOT\\s+LIKE\\b|\\bLIKE\\b|\\bREGEXP\\b)\\s*$`, 'i').exec(before))) return m[1];
  if ((m = new RegExp(`${COL}\\s+(?:NOT\\s+)?IN\\s*\\((?:[^()]*,)?\\s*$`, 'i').exec(before))) return m[1];
  if ((m = new RegExp(`${COL}\\s+(?:NOT\\s+)?BETWEEN\\s*$`, 'i').exec(before))) return `${m[1]}_min`;
  if ((m = new RegExp(`${COL}\\s+(?:NOT\\s+)?BETWEEN\\s+\\S+\\s+AND\\s*$`, 'i').exec(before))) return `${m[1]}_max`;
  if (/\bOFFSET\s*$/i.test(before)) return 'offset';
  if (/\bLIMIT\s*$/i.test(before)) return /^\s*,/.test(after) ? 'offset' : 'limit';
  if (/\bLIMIT\s+\S+\s*,\s*$/i.test(before)) return 'limit';
  if ((m = new RegExp(`^\\s*(?:=|<>|!=|<=|>=|<|>)\\s*${COL}`, 'i').exec(after))) return m[1];
  // INSERT INTO t (a, b, c) VALUES (?, ?, ?): la colonna nella stessa posizione
  if ((m = /\bINSERT\s+(?:IGNORE\s+)?(?:INTO\s+)?\S+\s*\(([^()]*)\)\s*VALUES\s*(?:\([^()]*\)\s*,\s*)*\(([^()]*)$/i.exec(before))) {
    const cols = m[1].split(',').map(c => c.trim());
    return cols[(m[2].match(/,/g) || []).length] || null;
  }
  return null;
}

// Parametri da chiedere all'utente, uno per chiave: [{ key, name, kind, guessed }]
// (nomi dei ? ricavati dalla query; uguali → nome_2, nome_3…; altrimenti "param_N")
function describeParams(sql) {
  const list = placeholders(sql);
  const text = blank(sql);
  const out = [];
  const used = new Map();
  for (const p of list) {
    if (out.some(x => x.key === p.key)) continue; // :nome ripetuto: un solo valore
    let name = p.name, guessed = false;
    if (p.kind === 'positional') {
      const g = guessName(text, p);
      guessed = !!g;
      name = g || `param_${p.key.slice(1)}`;
      const seen = used.get(name) || 0;
      used.set(name, seen + 1);
      if (seen) name = `${name}_${seen + 1}`;
    }
    out.push({ key: p.key, name, kind: p.kind, guessed });
  }
  return out;
}

// Query con i valori al posto dei segnaposto. escape(v) dal driver (mysql2); values: { key: valore }
// (stringa, numero, booleano o null). Restituisce { sql } oppure { missing: [chiavi] }
function bindParams(sql, values, escape) {
  const list = placeholders(sql);
  const missing = [...new Set(list.filter(p => !Object.hasOwn(values || {}, p.key)).map(p => p.key))];
  if (missing.length) return { missing };
  let out = sql;
  for (const p of [...list].reverse()) out = out.slice(0, p.start) + escape(values[p.key]) + out.slice(p.end);
  return { sql: out };
}

// ---- righe totali di una lettura ----

// Conteggio di una SELECT (o WITH … SELECT): COUNT(*) sulla query senza il suo eventuale
// LIMIT finale (fuori da parentesi, stringhe e commenti), per sapere quante righe darebbe
// senza limiti. → { sql, limit: { count, offset } | null }, o null se non è una SELECT
function countQuery(sql) {
  if (typeof sql !== 'string') return null;
  let body = sql.trim();
  let text = blank(body);
  const semi = /;\s*$/.exec(text);
  if (semi) { body = body.slice(0, semi.index); text = text.slice(0, semi.index); }
  const first = /^\s*(\w+)/.exec(text)?.[1]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH') return null;
  let limit = null;
  const m = /\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?\s*$/i.exec(text);
  if (m) {
    const before = text.slice(0, m.index);
    const depth = (before.match(/\(/g) || []).length - (before.match(/\)/g) || []).length;
    if (depth === 0) {
      // LIMIT a, b → salta a, ne prende b · LIMIT n OFFSET o
      limit = m[2] !== undefined ? { count: Number(m[2]), offset: Number(m[1]) } : { count: Number(m[1]), offset: Number(m[3] || 0) };
      body = body.slice(0, m.index).trimEnd();
    }
  }
  return { sql: `SELECT COUNT(*) FROM (\n${body}\n) AS kelbo_count`, limit };
}

module.exports = { classify, splitStatements, mask, schemaChange, placeholders, describeParams, bindParams, countQuery };
