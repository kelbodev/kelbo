// Classificazione delle istruzioni SQL (MySQL) prima di eseguirle.
// Solo le letture riconosciute possono partire senza conferma: tutto il resto,
// istruzioni sconosciute comprese, è trattato come scrittura.

const READ_START = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'TABLE', 'VALUES', 'HELP']);
const WRITE_WORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
  'GRANT', 'REVOKE', 'LOAD', 'CALL', 'DO', 'HANDLER', 'IMPORT', 'INSTALL', 'UNINSTALL',
  'LOCK', 'UNLOCK', 'SET', 'KILL', 'SHUTDOWN', 'FLUSH', 'RESET', 'PURGE', 'OPTIMIZE', 'REPAIR', 'ANALYZE',
]);

// Regole lessicali di MySQL: stringhe '…' e "…" con escape \, identificatori `…`, commenti
// # e -- , commenti eseguibili /*! … */. Gli strumenti comuni (istruzioni, segnaposto,
// conteggio) sono quelli del db-client, configurati con queste regole.
const sqlText = require('../db-client/sqltext')({
  strings: ["'", '"'], identifiers: { '`': '`' }, backslash: true, hashComments: true, execComments: true,
});
const { mask, splitStatements, blank, placeholders, describeParams, countQuery } = sqlText;
const bindParams = (sql, values, escape) => sqlText.bindParams(sql, values, escape);

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

module.exports = { classify, splitStatements, mask, schemaChange, placeholders, describeParams, bindParams, countQuery };
