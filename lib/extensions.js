// Loader delle estensioni: legge extensions/*/setting.json, risolve le dipendenze,
// crea i backend in ordine topologico e monta le route dichiarate nel manifest
// su /api/ext/<code>. Contratto completo in docs/EXTENSIONS.md.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, registerSection, unregisterSection } = require('./config');
const { openSse } = require('./sse');
const { SOURCE_LANG, catalogTags, readCatalog, isLocalizedText } = require('./i18n');
const { errorFactory, coreError } = require('./errors');
const semver = require('./semver');
const vault = require('./vault');

// Versione del core contro cui si controlla il campo "kelbo" (o "devdock") dei manifest
const CORE_VERSION = require('../package.json').version;

const CODE_RE     = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COLOR_RE    = /^#[0-9a-f]{6}$/i;
const FILE_RE     = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/; // relativo, senza ".."
const CONFIG_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const METHODS     = new Set(['GET', 'POST', 'PUT', 'DELETE']);
// Sezioni del core che una casella di export può includere oltre alle proprie (i segreti
// delle estensioni sono cifrati con il vault: senza il suo blocco non sarebbero leggibili)
const CORE_EXPORTABLE = new Set(['vault']);
const POSITIONS   = new Set(['tab', 'header']);

class ManifestError extends Error {}

const WIDGET_SIZES = new Set(['s', 'm', 'l']);
const isFile = f => typeof f === 'string' && FILE_RE.test(f) && !f.split('/').includes('..');

// Controlla un setting.json e restituisce il manifest normalizzato
function validateManifest(m, folder) {
  const fail = msg => { throw new ManifestError(`${folder}/setting.json: ${msg}`); };
  if (!m || typeof m !== 'object' || Array.isArray(m)) fail('deve essere un oggetto JSON');
  // name, description ed export[].label: testo o mappa per lingua ({ "it": "…", "en": "…" })
  if (!isLocalizedText(m.name)) fail('"name" obbligatorio (testo o mappa per lingua)');
  if (m.description != null && !isLocalizedText(m.description)) fail('"description" deve essere un testo o una mappa per lingua');
  if (!CODE_RE.test(m.code || '')) fail('"code" non valido (minuscole, numeri e -)');
  if (m.code === 'core') fail('"core" è riservato (namespace delle traduzioni del core)');
  if (m.code !== folder) fail(`"code" (${m.code}) deve coincidere con il nome della cartella`);
  if (!COLOR_RE.test(m.color || '')) fail('"color" deve essere #rrggbb');
  if (!POSITIONS.has(m.position)) fail('"position" deve essere "tab" o "header"');
  if (m.order != null && !Number.isFinite(m.order)) fail('"order" deve essere un numero');
  if (m.reloadable != null && typeof m.reloadable !== 'boolean') fail('"reloadable" deve essere true o false');
  // contratto versionato: versione dell'estensione e versioni del core con cui funziona
  if (!semver.valid(m.version)) fail('"version" obbligatoria, in formato SemVer (es. 1.0.0)');
  // "kelbo" dalla 2.13; "devdock" (nome di prima) vale ancora, e se ci sono tutti e due coincidono
  if (m.kelbo != null && m.devdock != null && m.kelbo !== m.devdock) fail('"kelbo" e "devdock" indicano versioni diverse: tieni solo "kelbo"');
  const range = m.kelbo ?? m.devdock;
  if (!semver.validRange(range)) fail('"kelbo" obbligatorio: le versioni di Kelbo compatibili, es. "^2.0"');

  const deps = m.dependencies ?? [];
  if (!Array.isArray(deps)) fail('"dependencies" deve essere una lista');
  for (const d of deps) {
    if (!d || !CODE_RE.test(d.code || '')) fail('dipendenza senza "code" valido');
    if (typeof d.required !== 'boolean') fail(`dipendenza "${d.code}": "required" deve essere true o false`);
    if (d.code === m.code) fail('un\'estensione non può dipendere da sé stessa');
  }

  const config = m.config ?? [];
  if (!Array.isArray(config) || !config.every(k => CONFIG_KEY_RE.test(k))) fail('"config" deve essere una lista di chiavi');

  if (m.backend != null) {
    const b = m.backend;
    if (!isFile(b.module)) fail('"backend.module" deve essere un file nella cartella');
    const routes = b.routes ?? [];
    if (!Array.isArray(routes)) fail('"backend.routes" deve essere una lista');
    const seen = new Set();
    for (const r of routes) {
      if (!METHODS.has(r?.method)) fail(`route con metodo non valido: ${r?.method}`);
      if (typeof r.path !== 'string' || !r.path.startsWith('/')) fail(`route ${r.method}: "path" deve iniziare con /`);
      if (typeof r.handler !== 'string' || !r.handler) fail(`route ${r.method} ${r.path}: "handler" obbligatorio`);
      const id = `${r.method} ${r.path}`;
      if (seen.has(id)) fail(`route duplicata: ${id}`);
      seen.add(id);
    }
  }

  if (m.frontend != null) {
    for (const k of ['html', 'sidebar', 'js', 'css']) {
      if (m.frontend[k] != null && !isFile(m.frontend[k])) fail(`"frontend.${k}" deve essere un file nella cartella`);
    }
  }

  // Widget: mini viste per la dashboard di progetto (modulo JS nella cartella dell'estensione)
  const widgets = m.widgets ?? [];
  if (!Array.isArray(widgets)) fail('"widgets" deve essere una lista');
  const widgetIds = new Set();
  for (const w of widgets) {
    if (!w || !CODE_RE.test(w.id || '')) fail('widget senza "id" valido (minuscole, numeri e -)');
    if (widgetIds.has(w.id)) fail(`widget "${w.id}" duplicato`);
    widgetIds.add(w.id);
    if (!isLocalizedText(w.title)) fail(`widget "${w.id}": "title" obbligatorio (testo o mappa per lingua)`);
    if (w.description != null && !isLocalizedText(w.description)) fail(`widget "${w.id}": "description" deve essere un testo o una mappa per lingua`);
    if ((w.scope ?? 'project') !== 'project') fail(`widget "${w.id}": "scope" può essere solo "project"`);
    if (w.size != null && !WIDGET_SIZES.has(w.size)) fail(`widget "${w.id}": "size" deve essere "s", "m" o "l"`);
    if (!isFile(w.js)) fail(`widget "${w.id}": "js" deve essere un file nella cartella`);
  }

  // Caselle del dialog di export/import: ognuna include alcune sezioni di config dell'estensione
  const exportsList = m.export ?? [];
  if (!Array.isArray(exportsList)) fail('"export" deve essere una lista');
  const exportIds = new Set();
  for (const x of exportsList) {
    if (!x || !CODE_RE.test(x.id || '')) fail('voce di "export" senza "id" valido (minuscole, numeri e -)');
    if (exportIds.has(x.id)) fail(`export "${x.id}" duplicato`);
    exportIds.add(x.id);
    if (!isLocalizedText(x.label)) fail(`export "${x.id}": "label" obbligatoria (testo o mappa per lingua)`);
    if (x.description != null && !isLocalizedText(x.description)) fail(`export "${x.id}": "description" deve essere un testo o una mappa per lingua`);
    if (!Array.isArray(x.sections) || !x.sections.length) fail(`export "${x.id}": "sections" deve essere una lista non vuota`);
    const foreign = x.sections.filter(k => !config.includes(k) && !CORE_EXPORTABLE.has(k));
    if (foreign.length) fail(`export "${x.id}": sezioni non dichiarate in "config": ${foreign.join(', ')}`);
  }

  // Strumenti MCP: ognuno ha un handler in instance.mcp del backend
  const mcp = m.mcp ?? {};
  if (typeof mcp !== 'object' || Array.isArray(mcp)) fail('"mcp" deve essere un oggetto');
  const tools = mcp.tools ?? [];
  if (!Array.isArray(tools)) fail('"mcp.tools" deve essere una lista');
  const toolNames = new Set();
  for (const tool of tools) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(tool?.name || '')) fail(`strumento MCP senza "name" valido (minuscole, numeri e _)`);
    if (toolNames.has(tool.name)) fail(`strumento MCP "${tool.name}" duplicato`);
    toolNames.add(tool.name);
    if (typeof tool.description !== 'string' || !tool.description.trim()) fail(`strumento MCP "${tool.name}": "description" obbligatoria`);
    if (typeof tool.handler !== 'string' || !tool.handler) fail(`strumento MCP "${tool.name}": "handler" obbligatorio`);
    const schema = tool.inputSchema ?? { type: 'object', properties: {} };
    if (!schema || schema.type !== 'object') fail(`strumento MCP "${tool.name}": "inputSchema" deve essere uno schema JSON di tipo object`);
    if (typeof (tool.readOnly ?? true) !== 'boolean') fail(`strumento MCP "${tool.name}": "readOnly" deve essere true o false`);
  }
  if (tools.length && !m.backend) fail('"mcp.tools" richiede un backend');

  return { order: 100, dependencies: deps, config, ...m, kelbo: range, devdock: range, export: exportsList, mcp: { tools },
    widgets: widgets.map(w => ({ ...w, scope: 'project', size: w.size || 'm' })) };
}

// Ordine topologico (dipendenze prima). Le estensioni in un ciclo restano fuori.
function topoSort(exts) {
  const byCode = new Map(exts.map(e => [e.manifest.code, e]));
  const state = new Map(); // code → 'visiting' | 'done'
  const order = [];
  const cyclic = new Set();
  const visit = (e, stack) => {
    const code = e.manifest.code;
    if (state.get(code) === 'done') return;
    if (state.get(code) === 'visiting') {
      stack.slice(stack.indexOf(code)).forEach(c => cyclic.add(c));
      return;
    }
    state.set(code, 'visiting');
    for (const d of e.manifest.dependencies) {
      const dep = byCode.get(d.code);
      if (dep) visit(dep, [...stack, code]);
    }
    state.set(code, 'done');
    order.push(e);
  };
  [...exts].sort((a, b) => a.manifest.code.localeCompare(b.manifest.code)).forEach(e => visit(e, []));
  return { order: order.filter(e => !cyclic.has(e.manifest.code)), cyclic };
}

// Avvisi ed errori di stato delle estensioni: il testo nella lingua sorgente (log, CLI, test)
// e, per testo, codice e parametri con cui il browser lo traduce
const notes = new Map(); // testo → { code, params }
function note(name, params = {}) {
  const text = coreError.message(name, params);
  notes.set(text, { code: `core.${name}`, params });
  return text;
}
const noteInfo = text => (text ? { error: text, ...notes.get(text) } : null);

// Cataloghi validi in <estensione>/i18n; quelli non validi vengono ignorati con un avviso
function extensionLanguages(ext) {
  const dir = path.join(ext.dir, 'i18n');
  return catalogTags(dir).filter(tag => {
    try { readCatalog(path.join(dir, `${tag}.json`)); return true; }
    catch (e) { ext.warnings.push(note('ext_i18n_ignored', { file: `i18n/${tag}.json`, error: e.message })); return false; }
  });
}

// ---- sezione "extensions" del core: estensioni spente dall'utente, cataloghi, installate ----

const EXT_CODE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
registerSection('extensions', {
  owner: 'core', empty: {},
  validate(v) {
    const bad = () => coreError.config('extensions_invalid');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad();
    if (v.disabled !== undefined && (!Array.isArray(v.disabled) || !v.disabled.every(c => typeof c === 'string' && EXT_CODE_RE.test(c)))) throw bad();
    if (v.catalogs !== undefined && (!Array.isArray(v.catalogs) || v.catalogs.length > 20
        || !v.catalogs.every(u => typeof u === 'string' && /^https?:\/\/\S{1,500}$/.test(u)))) throw coreError.config('extensions_catalogs');
    if (v.installed !== undefined) {
      if (!Array.isArray(v.installed) || v.installed.length > 200) throw bad();
      for (const x of v.installed) {
        if (!x || !EXT_CODE_RE.test(x.code || '') || typeof x.repo !== 'string' || !x.repo || x.repo.length > 500
            || (x.path != null && typeof x.path !== 'string') || (x.tag != null && typeof x.tag !== 'string')) throw bad();
      }
    }
  },
  // import in unione: le liste si sommano senza doppioni
  merge(current = {}, incoming = {}) {
    const union = (a = [], b = [], key = x => x) => [...a, ...b.filter(x => !a.some(y => key(y) === key(x)))];
    return {
      ...incoming, ...current,
      ...(current.disabled || incoming.disabled ? { disabled: union(current.disabled, incoming.disabled) } : {}),
      ...(current.catalogs || incoming.catalogs ? { catalogs: union(current.catalogs, incoming.catalogs) } : {}),
      ...(current.installed || incoming.installed ? { installed: union(current.installed, incoming.installed, x => x.code) } : {}),
    };
  },
});
const extSettings = () => loadConfig().extensions || {};

// Legge i manifest di una cartella di estensioni: [{ dir, folder }]
function scanDir(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  // cartelle o link a cartelle (estensioni sviluppate altrove); le cartelle nascoste sono di servizio
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => !d.name.startsWith('.'))
    .filter(d => d.isDirectory() || (d.isSymbolicLink() && fs.statSync(path.join(dir, d.name), { throwIfNoEntry: false })?.isDirectory()))
    .map(d => d.name).sort()
    .filter(folder => fs.existsSync(path.join(dir, folder, 'setting.json')))
    .map(folder => ({ dir: path.join(dir, folder), folder }));
}

// Estensione letta dal disco (manifest validato, compatibilità, cataloghi), non ancora avviata
function readExtension({ dir, folder }, source) {
  const ext = { dir, source, i18n: [], manifest: null, state: 'ok', warnings: [], error: null, services: null, instance: null, router: null, mcpTools: [], loadId: 0 };
  try {
    ext.manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(dir, 'setting.json'), 'utf8')), folder);
    // incompatibile: resta in lista con i dati del manifest (versione richiesta), ma non si carica
    if (!semver.satisfies(CORE_VERSION, ext.manifest.kelbo)) {
      ext.state = 'disabled';
      ext.incompatible = true;
      ext.error = note('ext_requires_core', { file: `${folder}/setting.json`, range: ext.manifest.kelbo, version: CORE_VERSION });
    } else ext.i18n = extensionLanguages(ext);
  } catch (e) {
    ext.manifest = { code: folder, name: folder, dependencies: [], config: [], export: [], mcp: { tools: [] } };
    ext.state = 'disabled';
    ext.error = e instanceof ManifestError ? e.message : `${folder}/setting.json: ${e.message}`;
  }
  return ext;
}

// Gestore delle estensioni: incluse (cartella del repository) e installate (cartella fuori dal
// repository). Avvio, arresto e ricarica a runtime; le route passano da un router che cerca
// l'estensione a ogni richiesta, così montarne o toglierne una non richiede un riavvio.
// dirs: [{ dir, source: 'builtin' | 'installed' }] (o una sola cartella, come incluse)
function loadExtensions(dirs, { lib = {}, projects = null, log = console } = {}) {
  if (!Array.isArray(dirs)) dirs = [{ dir: dirs, source: 'builtin' }];
  let all = [];               // tutte le estensioni lette, comprese quelle con codice duplicato
  const byCode = new Map();   // codice → estensione in uso (la prima trovata)
  const configOwner = new Map();

  const router = express.Router();
  router.use('/:code', (req, res, next) => {
    const ext = byCode.get(req.params.code);
    if (!ext?.router || ext.state === 'disabled' || ext.state === 'off') return next();
    ext.router(req, res, next);
  });

  // ---- lettura dal disco ----

  function discover() {
    const found = [];
    for (const { dir, source } of dirs) for (const entry of scanDir(dir)) found.push(readExtension(entry, source));
    return found;
  }

  // Due estensioni con lo stesso codice: errore su quella che arriva dopo, mai una scelta silenziosa
  function index(list) {
    byCode.clear();
    for (const ext of list) {
      const code = ext.manifest.code;
      const first = byCode.get(code);
      if (first) {
        ext.state = 'disabled';
        ext.duplicate = true;
        ext.error = note('ext_duplicate_code', { code, dir: first.dir });
        continue;
      }
      byCode.set(code, ext);
    }
  }

  // ---- avvio e arresto di una singola estensione ----

  function start(ext) {
    const m = ext.manifest;
    ext.warnings = ext.warnings.filter(w => notes.get(w)?.code === 'core.ext_i18n_ignored');
    if ((extSettings().disabled || []).includes(m.code)) { ext.state = 'off'; ext.error = null; return; }
    if (ext.incompatible || ext.duplicate || !m.version) return;
    ext.state = 'ok';
    ext.error = null;
    for (const key of m.config) {
      const owner = configOwner.get(key);
      if (owner && owner !== m.code) { ext.state = 'disabled'; ext.error = note('ext_config_owned', { key, owner }); return; }
    }
    for (const d of m.dependencies) {
      const dep = byCode.get(d.code);
      const usable = dep && dep.started && dep.state !== 'disabled' && dep.state !== 'off';
      if (!usable && d.required) {
        ext.state = 'disabled';
        ext.error = note(dep ? 'ext_dep_unavailable' : 'ext_dep_missing', { code: d.code });
        return;
      }
      if (!usable) ext.warnings.push(note('ext_dep_optional', { code: d.code }));
    }
    if (ext.warnings.length) ext.state = 'warning';
    for (const key of m.config) configOwner.set(key, m.code);
    ext.loadId = (ext.loadId || 0) + 1;
    if (!m.backend) { claimConfig(ext, {}); ext.started = true; return; }
    try {
      const ctx = makeContext(ext, { byCode, lib, projects, log });
      ext.ctx = ctx;
      const factory = require(path.join(ext.dir, m.backend.module));
      if (typeof factory !== 'function') throw new Error(`${m.backend.module} deve esportare una funzione (ctx) => { handlers }`);
      const instance = factory(ctx) || {};
      const handlers = instance.handlers || {};
      const missing = (m.backend.routes || []).filter(r => typeof handlers[r.handler] !== 'function').map(r => r.handler);
      if (missing.length) throw new Error(`handler non trovati: ${missing.join(', ')}`);
      const used = new Set((m.backend.routes || []).map(r => r.handler));
      const unused = Object.keys(handlers).filter(h => !used.has(h));
      if (unused.length) log.warn(`[ext:${m.code}] handler senza route: ${unused.join(', ')}`);
      const mcpHandlers = instance.mcp || {};
      const missingMcp = m.mcp.tools.filter(t => typeof mcpHandlers[t.handler] !== 'function').map(t => t.handler);
      if (missingMcp.length) throw new Error(`handler MCP non trovati: ${missingMcp.join(', ')}`);

      const extRouter = express.Router();
      for (const r of m.backend.routes || []) {
        const fn = handlers[r.handler];
        // Gli errori (anche delle funzioni async) passano all'error handler del core
        extRouter[r.method.toLowerCase()](r.path, (req, res, next) => {
          try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); }
        });
      }
      ext.router = extRouter;
      ext.instance = instance;
      ext.services = instance.services || {};
      ext.mcpTools = m.mcp.tools.map(t => ({ ...t, readOnly: t.readOnly ?? true, run: mcpHandlers[t.handler] }));
      claimConfig(ext, instance.config || {});
      ext.started = true;
    } catch (e) {
      stop(ext);
      ext.state = 'disabled';
      ext.error = `backend: ${e.message}`;
    }
  }

  // Ferma un'estensione avviata: shutdown(), vault, route, strumenti MCP, sezioni di config;
  // i suoi moduli escono dalla cache di require, così una ricarica legge i file nuovi
  function stop(ext) {
    if (ext.instance) {
      try { ext.instance.shutdown?.(); } catch (err) { log.error(`[ext:${ext.manifest.code}] shutdown: ${err.message}`); }
    }
    ext.ctx?.vault?.unregister();
    for (const key of ext.manifest.config || []) {
      if (configOwner.get(key) === ext.manifest.code) { configOwner.delete(key); unregisterSection(key); }
    }
    ext.instance = null;
    ext.ctx = null;
    ext.router = null;
    ext.services = null;
    ext.mcpTools = [];
    ext.started = false;
    const prefix = path.resolve(ext.dir) + path.sep;
    let real = prefix;
    try { real = fs.realpathSync(ext.dir) + path.sep; } catch { /* cartella rimossa */ }
    for (const file of Object.keys(require.cache)) {
      if (file.startsWith(prefix) || file.startsWith(real)) delete require.cache[file];
    }
  }

  // Estensioni che dipendono (anche indirettamente) da code, in ordine di dipendenza
  function dependentsOf(code) {
    const out = new Set();
    const visit = c => {
      for (const e of byCode.values()) {
        if (!out.has(e) && e.manifest.dependencies.some(d => d.code === c)) { out.add(e); visit(e.manifest.code); }
      }
    };
    visit(code);
    return topoSort([...out]).order;
  }

  // ---- avvio iniziale ----

  all = discover();
  index(all);
  const { order, cyclic } = topoSort([...byCode.values()].filter(e => e.state !== 'disabled'));
  for (const code of cyclic) {
    const e = byCode.get(code);
    e.state = 'disabled';
    e.error = note('ext_dep_cycle');
  }
  for (const ext of order) start(ext);
  for (const e of all) {
    if (e.state === 'disabled') log.warn(`[ext:${e.manifest.code}] disattivata: ${e.error}`);
  }

  // ---- operazioni a runtime ----

  // (Ri)legge dal disco l'estensione code e la riavvia, con quelle che dipendono da lei.
  // Restituisce { restartRequired } se un'estensione coinvolta dichiara "reloadable": false
  function reload(code) {
    const current = byCode.get(code);
    const affected = current ? [current, ...dependentsOf(code)] : [];
    const blocked = affected.find(e => e.started && e.manifest.reloadable === false);
    if (blocked) return { restartRequired: true, extension: blocked.manifest.code };
    for (const e of [...affected].reverse()) stop(e);
    // rilettura: l'estensione stessa (anche nuova o rimossa) e le dipendenti dalle loro cartelle
    const fresh = discover();
    const keep = new Map(all.map(e => [e.dir, e]));
    all = fresh.map(f => {
      const old = keep.get(f.dir);
      const touched = f.manifest.code === code || affected.some(e => e.dir === f.dir);
      if (!old || touched) { if (old) f.loadId = old.loadId; return f; }
      return old;
    });
    // le estensioni non toccate restano com'erano (stato, istanza); l'indice si ricostruisce
    const running = new Map([...byCode.values()].filter(e => e.started).map(e => [e.manifest.code, e]));
    index(all);
    for (const [c, e] of running) if (byCode.get(c) !== e && e.started) stop(e);
    const toStart = [byCode.get(code), ...affected.map(e => byCode.get(e.manifest.code))].filter((e, i, a) => e && a.indexOf(e) === i);
    for (const e of topoSort(toStart).order) start(e);
    return { restartRequired: false };
  }

  // Spegne / riaccende un'estensione (elenco "disabled" della sezione extensions)
  function setEnabled(code, enabled) {
    const cfg = loadConfig();
    const settings = cfg.extensions || {};
    const disabled = new Set(settings.disabled || []);
    if (enabled) disabled.delete(code); else disabled.add(code);
    cfg.extensions = { ...settings, disabled: [...disabled] };
    saveConfig(cfg);
    return reload(code);
  }

  const list = (positions = loadConfig().layout?.positions || {}) => all.map(e => ({
    code: e.manifest.code,
    name: e.manifest.name,
    description: e.manifest.description || '',
    version: e.manifest.version || null,
    kelbo: e.manifest.kelbo || null,
    devdock: e.manifest.kelbo || null, // nome di prima, per chi legge ancora questo campo
    color: e.manifest.color || null,
    icon: e.manifest.icon || null,
    // posizione in uso: quella scelta dall'utente (layout.positions) o quella del manifest
    position: (e.manifest.frontend?.js && positions[e.manifest.code]) || e.manifest.position || null,
    manifestPosition: e.manifest.position || null,
    order: e.manifest.order ?? 100,
    dependencies: e.manifest.dependencies,
    frontend: e.manifest.frontend || null,
    widgets: e.state === 'disabled' || e.state === 'off' ? [] : (e.manifest.widgets || []).map(w => ({ id: w.id, title: w.title, description: w.description || '', scope: w.scope, size: w.size, js: w.js })),
    // lingue di cui l'estensione ha un catalogo (i18n/<tag>.json)
    i18n: e.state === 'disabled' ? [] : e.i18n,
    export: (e.manifest.export || []).map(x => ({ id: x.id, label: x.label, description: x.description || '', sections: x.sections })),
    source: e.source,
    dir: e.dir,
    reloadable: e.manifest.reloadable !== false,
    duplicate: !!e.duplicate,
    incompatible: !!e.incompatible,
    loadId: e.loadId,
    state: e.state,
    warnings: e.warnings,
    warningInfo: e.warnings.map(noteInfo),
    error: e.error,
    errorInfo: noteInfo(e.error),
  })).sort((a, b) => a.order - b.order || a.code.localeCompare(b.code));

  const usable = e => e.state !== 'disabled' && e.state !== 'off' && e.started;

  return {
    router,
    get extensions() { return all; },
    get: code => byCode.get(code),
    // Strumenti MCP delle estensioni attive: { name: <code>_<nome>, extension, description, inputSchema, readOnly, run }
    mcpTools: () => [...byCode.values()].filter(usable).flatMap(e => (e.mcpTools || []).map(t => ({
      name: `${e.manifest.code.replace(/-/g, '_')}_${t.name}`, extension: e.manifest.code,
      description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} }, readOnly: t.readOnly, run: t.run,
    }))),
    configOwner,
    // Dati pubblici per la UI (/api/core/extensions)
    list,
    reload,
    setEnabled,
    dirs,
    shutdown() {
      const active = topoSort([...byCode.values()].filter(e => e.started)).order;
      for (const e of active.reverse()) {
        try { e.instance?.shutdown?.(); } catch (err) { log.error(`[ext:${e.manifest.code}] shutdown: ${err.message}`); }
      }
    },
  };
}

// Le chiavi di config dichiarate passano all'estensione, con le regole che il
// backend fornisce in instance.config[key] (empty, idField, validate, normalize, merge)
function claimConfig(ext, specs) {
  for (const key of ext.manifest.config) {
    registerSection(key, { ...(specs[key] || {}), owner: ext.manifest.code });
  }
}

function makeContext(ext, { byCode, lib, projects, log }) {
  const m = ext.manifest;
  const owned = new Set(m.config);
  const checkKey = key => {
    if (!owned.has(key)) throw new Error(`[ext:${m.code}] chiave di config "${key}" non dichiarata in setting.json`);
  };
  return {
    code: m.code,
    dir: ext.dir,
    lib,
    config: {
      get(key) { checkKey(key); return loadConfig()[key]; },
      set(key, value) { checkKey(key); const cfg = loadConfig(); cfg[key] = value; saveConfig(cfg); },
      // Più sezioni in un'unica scrittura atomica (tutte validate insieme)
      update(values) {
        Object.keys(values).forEach(checkKey);
        saveConfig({ ...loadConfig(), ...values });
      },
    },
    require(code) {
      const dep = m.dependencies.find(d => d.code === code);
      if (!dep) throw new Error(`[ext:${m.code}] "${code}" non è tra le dipendenze in setting.json`);
      const target = byCode.get(code);
      return target && target.started && target.state !== 'disabled' && target.state !== 'off' ? target.services : null;
    },
    // Vault della master password del core (segreti cifrati nelle sezioni dell'estensione)
    vault: vault.forExtension(m.code, m.config),
    // Progetti del core (sola lettura): list(), get(id), folders()
    projects: projects && { list: projects.list, get: projects.get, folders: projects.folders },
    sse: openSse,
    // Errori con codice traducibile: throw ctx.error(404, 'not_found', { id }) → { error, code: '<code>.not_found', params }
    // (messaggio da i18n/<lingua sorgente>.json, chiave "errors.not_found"); ctx.error.config(...) per le validazioni
    error: errorFactory(m.code, path.join(ext.dir, 'i18n', `${SOURCE_LANG}.json`)),
    log: {
      info: (...a) => log.log(`[ext:${m.code}]`, ...a),
      warn: (...a) => log.warn(`[ext:${m.code}]`, ...a),
      error: (...a) => log.error(`[ext:${m.code}]`, ...a),
    },
  };
}

// Serve solo i file frontend dichiarati nel manifest (mai server.js o altro)
function frontendRouter(loaded) {
  const router = express.Router();
  router.get('/:code/:file(*)', (req, res, next) => {
    const ext = loaded.get(req.params.code);
    const usable = ext && ext.started && ext.state !== 'disabled' && ext.state !== 'off';
    const fe = usable ? ext.manifest.frontend || {} : null;
    // file serviti: quelli di "frontend", i moduli dei widget e i cataloghi validi
    const catalog = /^i18n\/(.+)\.json$/.exec(req.params.file);
    const allowed = catalog ? ext?.i18n?.includes(catalog[1])
      : fe && (Object.values(fe).includes(req.params.file) || ext.manifest.widgets.some(w => w.js === req.params.file));
    if (!fe || !allowed) return next();
    res.sendFile(path.join(ext.dir, req.params.file));
  });
  return router;
}

module.exports = { loadExtensions, frontendRouter, validateManifest, topoSort, ManifestError, CORE_VERSION };
