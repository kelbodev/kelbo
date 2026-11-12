// Strumenti sul testo SQL comuni a tutti i motori, configurati con le regole lessicali del
// dialetto: istruzioni separate da ";", segnaposto ? e :nome, conteggio delle righe di una
// lettura. Li usano i motori (db-mysql direttamente, gli altri con ctx.require('db-client').sqlText).
//
// options:
//   strings        caratteri che aprono una stringa (default ["'"]; MySQL anche '"')
//   identifiers    { apertura: chiusura } degli identificatori quotati (default { '"': '"' };
//                  MySQL { '`': '`' }, SQL Server { '"': '"', '[': ']' })
//   backslash      true: \ fa da escape nelle stringhe (MySQL)
//   eStrings       true: E'…' con escape \ (PostgreSQL)
//   dollarQuotes   true: $tag$ … $tag$ (PostgreSQL)
//   qQuotes        true: q'[…]' e simili (Oracle)
//   hashComments   true: # inizia un commento di riga (MySQL)
//   execComments   true: /*! … */ è eseguito, non un commento (MySQL)
//   countAlias     alias della sottoquery del conteggio: ' AS kelbo_count' (default) o ' kelbo_count' (Oracle)

const CLOSE_OF = { '(': ')', '[': ']', '{': '}', '<': '>' };

module.exports = function createSqlText(options = {}) {
  const strings = new Set(options.strings || ["'"]);
  const idents = options.identifiers || { '"': '"' };
  const o = { backslash: false, eStrings: false, dollarQuotes: false, qQuotes: false, hashComments: false, execComments: false, ...options };
  const countAlias = options.countAlias ?? ' AS kelbo_count';

  // Token alla posizione i: { type: 'string'|'ident'|'line'|'block'|'exec'|'execEnd', end, name? } o null
  function tokenAt(sql, i) {
    const c = sql[i], n = sql[i + 1];
    if (o.dollarQuotes && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
        const close = sql.indexOf(m[0], i + m[0].length);
        return { type: 'string', end: close === -1 ? sql.length : close + m[0].length };
      }
    }
    if (o.qQuotes && (c === 'q' || c === 'Q') && n === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) {
      const open = sql[i + 2];
      const close = CLOSE_OF[open] || open;
      const end = sql.indexOf(close + "'", i + 3);
      return { type: 'string', end: end === -1 ? sql.length : end + 2 };
    }
    let start = i, quote = null, escapes = o.backslash;
    if (o.eStrings && (c === 'E' || c === 'e') && n === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) { quote = "'"; start = i + 1; escapes = true; }
    else if ((c === 'N' || c === 'n') && n === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? '')) { quote = "'"; start = i + 1; }
    else if (strings.has(c)) quote = c;
    if (quote) {
      let j = start + 1;
      while (j < sql.length) {
        if (sql[j] === '\\' && escapes) { j += 2; continue; }
        if (sql[j] === quote) { if (sql[j + 1] === quote) { j += 2; continue; } break; }
        j++;
      }
      return { type: 'string', end: Math.min(j + 1, sql.length) };
    }
    if (Object.hasOwn(idents, c)) {
      const close = idents[c];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === close) { if (sql[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      return { type: 'ident', end: Math.min(j + 1, sql.length), name: sql.slice(i + 1, j).split(close + close).join(close) };
    }
    if ((c === '-' && n === '-' && /\s/.test(sql[i + 2] ?? ' ')) || (o.hashComments && c === '#')) {
      const nl = sql.indexOf('\n', i);
      return { type: 'line', end: nl === -1 ? sql.length : nl };
    }
    if (c === '/' && n === '*') {
      if (o.execComments && sql[i + 2] === '!') {          // /*!50000 ... */ → contenuto eseguito
        let j = i + 3;
        while (/\d/.test(sql[j] ?? '')) j++;
        return { type: 'exec', end: j };
      }
      const end = sql.indexOf('*/', i + 2);
      return { type: 'block', end: end === -1 ? sql.length : end + 2 };
    }
    if (o.execComments && c === '*' && n === '/') return { type: 'execEnd', end: i + 2 }; // chiusura di un /*! … */
    return null;
  }

  // Testo con stringhe, identificatori quotati e commenti sostituiti: restano parole chiave,
  // nomi e simboli (per classificare). I commenti eseguibili di MySQL restano.
  function mask(sql) {
    let out = '', i = 0;
    while (i < sql.length) {
      const tk = tokenAt(sql, i);
      if (!tk) { out += sql[i]; i++; continue; }
      out += tk.type === 'string' ? " 'str' " : tk.type === 'ident' ? ' "ident" ' : ' ';
      i = tk.end;
    }
    return out;
  }

  // Istruzioni separate da ";" al primo livello: [{ sql, start }] senza quelle vuote o di soli
  // commenti. Le istruzioni composte (BEGIN … END, DELIMITER, GO) non sono riconosciute.
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
      const tk = tokenAt(sql, i);
      if (tk && tk.type !== 'exec' && tk.type !== 'execEnd') { i = tk.end; continue; }
      if (sql[i] === ';') { push(i); start = ++i; continue; }
      i++;
    }
    push(sql.length);
    return out;
  }

  // Come mask, ma della stessa lunghezza (le posizioni restano quelle della query): stringhe e
  // commenti diventano spazi, un identificatore quotato resta riconoscibile come nome
  function blank(sql) {
    const out = sql.split('');
    const clear = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
    let i = 0;
    while (i < sql.length) {
      const tk = tokenAt(sql, i);
      if (!tk || tk.type === 'exec' || tk.type === 'execEnd') { i++; continue; }
      if (tk.type === 'ident') {
        const name = (tk.name || '').replace(/[^A-Za-z0-9_$]/g, '_').slice(0, Math.max(0, tk.end - i));
        clear(i, tk.end);
        out.splice(i, name.length, ...name);
      } else clear(i, tk.end);
      i = tk.end;
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
    if ((m = new RegExp(`${COL}\\s*(?:=|<=>|<>|!=|<=|>=|<|>|\\bNOT\\s+LIKE\\b|\\bLIKE\\b|\\bI?LIKE\\b|\\bREGEXP\\b)\\s*$`, 'i').exec(before))) return m[1];
    if ((m = new RegExp(`${COL}\\s+(?:NOT\\s+)?IN\\s*\\((?:[^()]*,)?\\s*$`, 'i').exec(before))) return m[1];
    if ((m = new RegExp(`${COL}\\s+(?:NOT\\s+)?BETWEEN\\s*$`, 'i').exec(before))) return `${m[1]}_min`;
    if ((m = new RegExp(`${COL}\\s+(?:NOT\\s+)?BETWEEN\\s+\\S+\\s+AND\\s*$`, 'i').exec(before))) return `${m[1]}_max`;
    if (/\bOFFSET\s*$/i.test(before)) return 'offset';
    if (/\bLIMIT\s*$/i.test(before)) return /^\s*,/.test(after) ? 'offset' : 'limit';
    if (/\bLIMIT\s+\S+\s*,\s*$/i.test(before)) return 'limit';
    if (/\bFETCH\s+(?:NEXT|FIRST)\s*$/i.test(before) || /\bTOP\s*\(?\s*$/i.test(before)) return 'limit';
    if ((m = new RegExp(`^\\s*(?:=|<>|!=|<=|>=|<|>)\\s*${COL}`, 'i').exec(after))) return m[1];
    // INSERT INTO t (a, b, c) VALUES (?, ?, ?): la colonna nella stessa posizione
    if ((m = /\bINSERT\s+(?:IGNORE\s+)?(?:INTO\s+)?\S+\s*\(([^()]*)\)\s*VALUES\s*(?:\([^()]*\)\s*,\s*)*\(([^()]*)$/i.exec(before))) {
      const cols = m[1].split(',').map(c => c.trim());
      return cols[(m[2].match(/,/g) || []).length] || null;
    }
    return null;
  }

  // Parametri da chiedere all'utente, uno per chiave: [{ key, name, kind, guessed }]
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

  // Query con i valori al posto dei segnaposto (escape del motore). values: { key: valore }.
  // Restituisce { sql } oppure { missing: [chiavi] }
  function bindParams(sql, values, escape) {
    const list = placeholders(sql);
    const missing = [...new Set(list.filter(p => !Object.hasOwn(values || {}, p.key)).map(p => p.key))];
    if (missing.length) return { missing };
    let out = sql;
    for (const p of [...list].reverse()) out = out.slice(0, p.start) + escape(values[p.key]) + out.slice(p.end);
    return { sql: out };
  }

  // Conteggio di una SELECT (o WITH … SELECT): COUNT(*) sulla query senza il suo limite finale
  // (LIMIT n [OFFSET o], LIMIT o, n, OFFSET o ROWS FETCH … n ROWS ONLY, FETCH FIRST n ROWS ONLY,
  // fuori da parentesi, stringhe e commenti) → { sql, limit: { count, offset } | null }, o null
  function countQuery(sql) {
    if (typeof sql !== 'string') return null;
    let body = sql.trim();
    let text = blank(body);
    const semi = /;\s*$/.exec(text);
    if (semi) { body = body.slice(0, semi.index); text = text.slice(0, semi.index); }
    const first = /^\s*(\w+)/.exec(text)?.[1]?.toUpperCase();
    if (first !== 'SELECT' && first !== 'WITH') return null;
    let limit = null;
    const topLevel = idx => { const before = text.slice(0, idx); return (before.match(/\(/g) || []).length === (before.match(/\)/g) || []).length; };
    const patterns = [
      // LIMIT a, b → salta a, ne prende b · LIMIT n OFFSET o
      [/\bLIMIT\s+(\d+)(?:\s*,\s*(\d+)|\s+OFFSET\s+(\d+))?\s*$/i, m => (m[2] !== undefined ? { count: Number(m[2]), offset: Number(m[1]) } : { count: Number(m[1]), offset: Number(m[3] || 0) })],
      [/\bOFFSET\s+(\d+)\s+ROWS?\s+FETCH\s+(?:NEXT|FIRST)\s+(\d+)\s+ROWS?\s+ONLY\s*$/i, m => ({ count: Number(m[2]), offset: Number(m[1]) })],
      [/\bFETCH\s+(?:NEXT|FIRST)\s+(\d+)\s+ROWS?\s+ONLY\s*$/i, m => ({ count: Number(m[1]), offset: 0 })],
    ];
    for (const [re, read] of patterns) {
      const m = re.exec(text);
      if (m && topLevel(m.index)) {
        limit = read(m);
        body = body.slice(0, m.index).trimEnd();
        break;
      }
    }
    return { sql: `SELECT COUNT(*) FROM (\n${body}\n)${countAlias}`, limit };
  }

  return { mask, blank, splitStatements, placeholders, describeParams, bindParams, countQuery, tokenAt };
};
