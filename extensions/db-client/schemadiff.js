// Confronto tra due strutture di tabelle (quella attuale e quella modificata nel designer) e
// analisi delle operazioni di schema, comuni a tutti i motori. Le istruzioni SQL le scrive il
// motore (statements); qui solo il modello: operazioni, avvisi, nome della migration.
// Usato da db-mysql direttamente e dagli altri motori con ctx.require('db-client').schemaDiff.
//
// options:
//   typeKinds   { TIPO: 'int'|'decimal'|'float'|'length'|'temporal'|'values'|'plain' } del dialetto
//   fkAction    forma canonica di un'azione ON DELETE/UPDATE (default: '' e NO ACTION = RESTRICT)
//   positions   false se il motore non sposta le colonne (niente modify_column solo per la posizione)
//   typeAliases { ALIAS: TIPO } nomi equivalenti dello stesso tipo (es. INT4 → INTEGER)

module.exports = function createSchemaDiff(options = {}) {
  const typeKinds = options.typeKinds || {};
  const positions = options.positions !== false;
  const aliases = options.typeAliases || {};
  const canonicalType = t => { const u = String(t || '').toUpperCase(); return aliases[u] || u; };

  // Operazioni che possono perdere dati: { index, key, params } per ogni avviso
  function destructive(ops, before = null) {
    const warnings = [];
    const renamed = new Map(); // "<tabella>.<nome attuale>" → nome originale (rinomine precedenti nello stesso elenco)
    const original = (t, n) => renamed.get(`${t}.${n}`) || n;
    ops.forEach((op, index) => {
      const w = (key, params = {}) => warnings.push({ index, key, params: { table: op.table, ...params } });
      if (op.op === 'drop_table') w('drop_table');
      else if (op.op === 'drop_column') w('drop_column', { column: op.name });
      else if (op.op === 'modify_column') {
        const from = original(op.table, op.name);
        const old = before?.tables?.[op.table]?.columns?.find(c => c.name === from);
        if (!old || narrows(old, op.column)) w('modify_column', { column: op.name });
        if (op.column?.name && op.column.name !== op.name) renamed.set(`${op.table}.${op.column.name}`, from);
      } else if (op.op === 'drop_primary_key') w('drop_primary_key');
      else if (op.op === 'raw' && /\bDROP\b|\bMODIFY\b|\bCHANGE\b|\bTRUNCATE\b/i.test(op.sql)) w('raw');
    });
    return warnings;
  }

  // Una modifica di colonna che può troncare o rifiutare dati esistenti
  function narrows(old, next) {
    if (!next) return true;
    if (canonicalType(old.type) !== canonicalType(next.type)) return true;
    const num = v => (v === '' || v == null ? null : Number(v));
    if (num(next.length) != null && num(old.length) != null && num(next.length) < num(old.length)) return true;
    if (num(next.scale) != null && num(old.scale) != null && num(next.scale) < num(old.scale)) return true;
    if (old.nullable && !next.nullable) return true;
    if (!old.unsigned !== !next.unsigned) return true;
    if (Array.isArray(old.values) && old.values.some(v => !(next.values || []).includes(v))) return true;
    return false;
  }

  // ---- nome del file: tabella e operazione ----

  const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

  // { table, operation } per NNN_<table>_<operation>.sql
  function proposeName(ops) {
    const tables = [...new Set(ops.map(o => o.table).filter(Boolean))];
    const table = tables[0] || 'schema';
    if (ops.length === 1) {
      const o = ops[0];
      const op = {
        create_table: () => 'create', drop_table: () => 'drop', rename_table: () => 'rename',
        add_column: () => `add_${slug(o.column?.name)}`, drop_column: () => `drop_${slug(o.name)}`,
        modify_column: () => (o.column?.name && o.column.name !== o.name ? `rename_${slug(o.name)}` : `modify_${slug(o.name)}`),
        rename_column: () => `rename_${slug(o.from)}`,
        add_index: () => `add_index${o.index?.name ? `_${slug(o.index.name)}` : `_${slug((o.index?.columns || []).join('_'))}`}`,
        drop_index: () => `drop_index_${slug(o.name)}`,
        add_primary_key: () => 'add_primary_key', drop_primary_key: () => 'drop_primary_key',
        add_fk: () => `add_fk${o.fk?.name ? `_${slug(o.fk.name)}` : ''}`, drop_fk: () => `drop_fk_${slug(o.name)}`,
        table_options: () => 'options', raw: () => o.operation || 'alter',
      }[o.op]?.() || 'alter';
      return { table: slug(table) || 'schema', operation: slug(op) || 'alter' };
    }
    if (tables.length > 1) return { table: 'schema', operation: 'alter' };
    if (ops.every(o => o.op === 'create_table')) return { table: slug(table), operation: 'create' };
    return { table: slug(table), operation: 'alter' };
  }

  // ---- confronto tra due schemi (struttura attuale → struttura modificata nel designer) ----
  // Schema: { tables: { <nome>: definizione come in ddl.createTableSql (senza name) } }

  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Forma canonica di una colonna: stessi campi e tipi qualunque sia la provenienza
  // (designer o INFORMATION_SCHEMA), così il confronto vede solo modifiche vere
  function normalizeColumn(c) {
    const type = canonicalType(c.type);
    const kind = typeKinds[type];
    const num = v => (v === '' || v == null || isNaN(Number(v)) ? undefined : Number(v));
    const out = { name: c.name, type };
    if (kind === 'length') out.length = num(c.length);
    else if (kind === 'decimal') { out.length = num(c.length) ?? 10; out.scale = num(c.scale) ?? 0; }
    else if (kind === 'temporal' && num(c.length)) out.length = num(c.length);
    else if (kind === 'values') out.values = (c.values || []).map(String);
    if (c.unsigned && ['int', 'decimal', 'float'].includes(kind)) out.unsigned = true;
    out.nullable = !!c.nullable;
    const d = c.default || { kind: 'none' };
    out.default = d.kind === 'value' || d.kind === 'expression' ? { kind: d.kind, value: String(d.value ?? '') }
      : d.kind === 'null' ? (out.nullable ? { kind: 'none' } : { kind: 'null' }) // NULL su una colonna nullable = nessun default
      : { kind: d.kind || 'none' };
    if (c.autoIncrement) out.autoIncrement = true;
    if (c.onUpdateCurrentTimestamp) out.onUpdateCurrentTimestamp = true;
    if (c.comment) out.comment = String(c.comment);
    if (c.unsupported) out.unsupported = c.unsupported;
    return out;
  }
  const normalizeIndex = i => ({ name: i.name, columns: [...(i.columns || [])], unique: !!i.unique });
  const fkAction = options.fkAction || (a => { const v = String(a || '').toUpperCase(); return !v || v === 'NO ACTION' ? 'RESTRICT' : v; }); // equivalenti in InnoDB
  const normalizeFk = f => ({
    name: f.name, columns: [...(f.columns || [])], refDatabase: f.refDatabase || undefined, refTable: f.refTable,
    refColumns: [...(f.refColumns || [])], onDelete: fkAction(f.onDelete), onUpdate: fkAction(f.onUpdate),
  });
  const columnKey = c => JSON.stringify({ ...normalizeColumn(c), name: undefined });

  // Operazioni che portano `from` a `to`. Colonne tolte e aggiunte nella stessa tabella
  // con la stessa definizione potrebbero essere una rinomina: non si indovina, si
  // restituiscono in `ambiguous` e la scelta arriva in renames { "<tabella>.<nuova>": "<vecchia>" }.
  function diff(from, to, renames = {}) {
    const a = from?.tables || {}, b = to?.tables || {};
    const phase = { dropFk: [], dropIndex: [], dropPk: [], renames: [], drops: [], adds: [], modifies: [], dropTable: [], create: [], addPk: [], addIndex: [], addFk: [], options: [] };
    const ambiguous = [];

    for (const t of Object.keys(a).sort()) if (!b[t]) phase.dropTable.push({ op: 'drop_table', table: t });
    for (const t of orderByForeignKeys(Object.keys(b).filter(t => !a[t]), b)) {
      const { foreignKeys = [], ...definition } = b[t];
      phase.create.push({ op: 'create_table', table: t, definition });
      for (const fk of foreignKeys) phase.addFk.push({ op: 'add_fk', table: t, fk }); // dopo tutte le tabelle
    }

    for (const t of Object.keys(b).sort().filter(t => a[t])) {
      const x = a[t], y = b[t];
      const xCols = new Map((x.columns || []).map(c => [c.name, c]));
      const yCols = new Map((y.columns || []).map(c => [c.name, c]));
      let dropped = [...xCols.keys()].filter(n => !yCols.has(n));
      let added = [...yCols.keys()].filter(n => !xCols.has(n));

      // rinomine scelte dall'utente: CHANGE COLUMN vecchio → nuova definizione
      const renamedFrom = new Map(); // nuovo nome → vecchio
      for (const n of [...added]) {
        const old = renames[`${t}.${n}`];
        if (old && dropped.includes(old)) {
          phase.renames.push({ op: 'modify_column', table: t, name: old, column: yCols.get(n) });
          renamedFrom.set(n, old);
          dropped = dropped.filter(d => d !== old);
          added = added.filter(m => m !== n);
        }
      }
      // possibili rinomine: stessa definizione da una parte e dall'altra
      for (const n of added) {
        const candidates = dropped.filter(d => columnKey(xCols.get(d)) === columnKey(yCols.get(n)));
        if (candidates.length) ambiguous.push({ table: t, column: n, candidates });
      }

      const yNames = (y.columns || []).map(c => c.name);
      const after = n => { const i = yNames.indexOf(n); return i <= 0 ? '' : yNames[i - 1]; };
      for (const n of dropped) phase.drops.push({ op: 'drop_column', table: t, name: n });
      for (const n of added) phase.adds.push({ op: 'add_column', table: t, column: yCols.get(n), after: after(n) });
      // colonne rimaste: definizione cambiata o posizione cambiata rispetto alle altre rimaste
      const kept = yNames.filter(n => xCols.has(n) || renamedFrom.has(n));
      const oldName = n => renamedFrom.get(n) || n;
      const xOrder = (x.columns || []).map(c => c.name);
      const keptOld = new Set(kept.map(oldName));
      const xKept = xOrder.filter(n => keptOld.has(n));
      // si spostano solo le colonne fuori dalla sottosequenza crescente più lunga
      const stay = longestIncreasing(kept.map(n => xKept.indexOf(oldName(n))));
      kept.forEach((n, i) => {
        const moved = positions && !stay.has(i);
        const changed = xCols.has(n) && columnKey(xCols.get(n)) !== columnKey(yCols.get(n));
        if (moved || changed) phase.modifies.push({ op: 'modify_column', table: t, name: n, column: yCols.get(n), ...(moved ? { after: after(n) } : {}) });
      });

      if (!sameJson(x.primaryKey || [], y.primaryKey || [])) {
        if ((x.primaryKey || []).length) phase.dropPk.push({ op: 'drop_primary_key', table: t });
        if ((y.primaryKey || []).length) phase.addPk.push({ op: 'add_primary_key', table: t, columns: y.primaryKey });
      }
      const byName = list => new Map((list || []).map(i => [i.name, i]));
      const xi = byName(x.indexes), yi = byName(y.indexes);
      const sameIx = (p, q) => sameJson(normalizeIndex(p), normalizeIndex(q));
      for (const [n, ix] of xi) if (!yi.has(n) || !sameIx(ix, yi.get(n))) phase.dropIndex.push({ op: 'drop_index', table: t, name: n });
      for (const [n, ix] of yi) if (!xi.has(n) || !sameIx(ix, xi.get(n))) phase.addIndex.push({ op: 'add_index', table: t, index: ix });
      const xf = byName(x.foreignKeys), yf = byName(y.foreignKeys);
      const sameFk = (p, q) => sameJson(normalizeFk(p), normalizeFk(q));
      for (const [n, fk] of xf) if (!yf.has(n) || !sameFk(fk, yf.get(n))) phase.dropFk.push({ op: 'drop_fk', table: t, name: n });
      for (const [n, fk] of yf) if (!xf.has(n) || !sameFk(fk, xf.get(n))) phase.addFk.push({ op: 'add_fk', table: t, fk });
      if ((x.engine || null) !== (y.engine || null) || (x.comment || '') !== (y.comment || '')) {
        phase.options.push({ op: 'table_options', table: t, engine: y.engine || undefined, comment: y.comment || undefined });
      }
    }

    // ordine: chiavi esterne tolte prima di tutto, aggiunte alla fine. Ogni fase è un
    // ALTER TABLE a sé: rinomine e posizioni non dipendono da clausole dello stesso ALTER
    const ops = [];
    for (const list of [phase.dropFk, phase.dropIndex, phase.dropPk, phase.renames, phase.drops, phase.adds, phase.modifies,
      phase.dropTable, phase.create, phase.addPk, phase.addIndex, phase.options, phase.addFk]) {
      list.forEach((op, i) => ops.push(i === 0 ? { ...op, newStatement: true } : op));
    }
    return { ops, ambiguous };
  }

  // Indici (posizioni in seq) della sottosequenza strettamente crescente più lunga
  function longestIncreasing(seq) {
    const len = seq.map(() => 1), prev = seq.map(() => -1);
    let best = -1;
    for (let i = 0; i < seq.length; i++) {
      for (let j = 0; j < i; j++) if (seq[j] < seq[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
      if (best === -1 || len[i] > len[best]) best = i;
    }
    const out = new Set();
    for (let i = best; i !== -1; i = prev[i]) out.add(i);
    return out;
  }

  // Tabelle nuove in ordine: prima quelle riferite dalle chiavi esterne delle altre
  function orderByForeignKeys(names, tables) {
    const set = new Set(names), done = new Set(), out = [];
    const visit = (n, stack = new Set()) => {
      if (done.has(n) || stack.has(n)) return;
      stack.add(n);
      for (const fk of tables[n].foreignKeys || []) if (set.has(fk.refTable) && fk.refTable !== n) visit(fk.refTable, stack);
      done.add(n);
      out.push(n);
    };
    names.sort().forEach(n => visit(n));
    return out;
  }

  return { destructive, narrows, proposeName, diff, orderByForeignKeys, normalizeColumn, longestIncreasing };
};
