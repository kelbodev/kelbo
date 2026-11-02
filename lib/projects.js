// Progetti (cartelle sul disco usate da npm, git, env…) e cartelle della sidebar che li
// raggruppano: sezioni "projects" e "projectFolders" di config.json. Sono del core perché
// le condividono più estensioni. Un solo livello: le cartelle contengono solo progetti,
// un progetto senza cartella sta nella radice.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { registerSection, loadConfig, saveConfig, pick } = require('./config');
const { coreError } = require('./errors');
const { KEY_RE, isText } = require('./validate');

const PROJECT_FIELDS = ['id', 'label', 'path', 'folder', 'traits'];
const FOLDER_FIELDS = ['id', 'label'];

const normalizeList = fields => v => (Array.isArray(v) ? v.map(x => pick(x || {}, fields)) : v);

function uniqueIds(list, error) {
  const seen = new Set();
  for (const x of list) {
    if (seen.has(x.id)) throw coreError.config(error, { id: x.id });
    seen.add(x.id);
  }
}

function validateFolders(list) {
  if (!Array.isArray(list)) throw coreError.config('not_a_list', { section: 'projectFolders' });
  for (const f of list) {
    if (!f || typeof f !== 'object' || !KEY_RE.test(f.id || '')) throw coreError.config('folder_id', { id: String(f?.id ?? '') });
    if (!isText(f.label, 100)) throw coreError.config('folder_label', { id: f.id });
  }
  uniqueIds(list, 'duplicate_folder');
}

// cfg: config intera, per controllare che la cartella di ogni progetto esista
function validateProjects(list, cfg) {
  if (!Array.isArray(list)) throw coreError.config('not_a_list', { section: 'projects' });
  const folders = new Set((Array.isArray(cfg?.projectFolders) ? cfg.projectFolders : []).map(f => f?.id));
  for (const p of list) {
    if (!p || typeof p !== 'object') throw coreError.config('project_invalid');
    const bad = name => coreError.config(name, { id: String(p.id ?? '') });
    if (!KEY_RE.test(p.id || '')) throw bad('project_id');
    if (!isText(p.label)) throw bad('project_label');
    if (!isText(p.path, 1024) || !path.isAbsolute(p.path)) throw bad('project_path');
    if (p.folder !== undefined && !folders.has(p.folder)) throw coreError.config('project_folder', { id: p.id, folder: String(p.folder) });
    if (p.traits !== undefined && !validOverrides(p.traits)) throw bad('project_traits');
  }
  uniqueIds(list, 'duplicate_project');
}

// ---- tratti: caratteristiche rilevate nella cartella del progetto ----
// Un progetto non è di un tipo solo (un'app Angular è anche Node e Git): i tratti si ricavano
// da cosa c'è nella cartella. Quelli del core hanno un rilevatore; quelli delle estensioni
// (manifest "projectTraits") sono dichiarativi: file presenti o dipendenze in package.json.
// L'utente può forzare un tratto per un progetto: traits: { add: [...], remove: [...] }.

const TRAIT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_TRAITS = 30;
const validOverrides = t => t && typeof t === 'object' && !Array.isArray(t) && Object.keys(t).every(k => k === 'add' || k === 'remove')
  && ['add', 'remove'].every(k => t[k] === undefined || (Array.isArray(t[k]) && t[k].length <= MAX_TRAITS && t[k].every(x => TRAIT_RE.test(x))));

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const exists = p => { try { fs.accessSync(p); return true; } catch { return false; } };
// .git qui o in una cartella superiore (un progetto dentro un monorepo)
function insideGit(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (exists(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}
const CORE_TRAITS = [
  { id: 'git', label: 'Git', detect: dir => insideGit(dir) },
  { id: 'node', label: 'Node.js', detect: dir => exists(path.join(dir, 'package.json')) },
  { id: 'env', label: '.env', detect: dir => { try { return fs.readdirSync(dir).some(n => /^\.env(\..+)?$/.test(n)); } catch { return false; } } },
];

// Tratti delle estensioni attive: li fornisce il loader (manifest "projectTraits")
let extensionTraits = () => [];
function setTraitSource(fn) { extensionTraits = fn; }

// Tratti conosciuti: { id, label, source: 'core' | codice dell'estensione, files?, dependencies? }
function knownTraits() {
  const out = new Map(CORE_TRAITS.map(t => [t.id, { id: t.id, label: t.label, source: 'core' }]));
  for (const t of extensionTraits()) if (!out.has(t.id)) out.set(t.id, t); // a parità di id vince chi c'era prima
  return [...out.values()];
}

function readPackageDeps(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return new Set([pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].flatMap(d => (d && typeof d === 'object' ? Object.keys(d) : [])));
  } catch { return new Set(); }
}

// Tratti rilevati nella cartella (in cache qualche secondo: le liste si chiedono spesso)
const DETECT_TTL = 3000;
const detected = new Map(); // path → { at, traits }
function detectTraits(dir) {
  const hit = detected.get(dir);
  if (hit && Date.now() - hit.at < DETECT_TTL) return hit.traits;
  const traits = [];
  if (isDir(dir)) {
    for (const t of CORE_TRAITS) if (t.detect(dir)) traits.push(t.id);
    let deps = null;
    for (const t of knownTraits()) {
      if (t.source === 'core' || traits.includes(t.id)) continue;
      const hasHints = (t.files || []).length || (t.dependencies || []).length;
      const byFile = (t.files || []).some(f => exists(path.join(dir, f)));
      const byDep = !byFile && (t.dependencies || []).length && (deps ||= readPackageDeps(dir)) && t.dependencies.some(d => deps.has(d));
      // file e dipendenze, se dichiarati, sono il filtro veloce; detect (backend) conferma
      if (hasHints && !byFile && !byDep) continue;
      if (typeof t.detect === 'function') {
        let ok = false;
        try { ok = t.detect(dir); } catch { ok = false; }
        if (!ok) continue;
      } else if (!hasHints) continue;
      traits.push(t.id);
    }
  }
  detected.set(dir, { at: Date.now(), traits });
  return traits;
}

// Tratti effettivi: rilevati, più quelli forzati, meno quelli tolti
function traitsOf(p) {
  const found = detectTraits(p.path);
  const add = p.traits?.add || [], remove = new Set(p.traits?.remove || []);
  return [...new Set([...found, ...add])].filter(t => !remove.has(t));
}
const hasAnyTrait = (p, wanted) => !wanted?.length || traitsOf(p).some(t => wanted.includes(t));

// Progetto con i dati calcolati per l'interfaccia
const describeProject = p => ({ ...p, traitsFound: detectTraits(p.path), traitsActive: traitsOf(p), missing: !isDir(p.path) });

registerSection('projectFolders', { owner: 'core', empty: [], idField: 'id', normalize: normalizeList(FOLDER_FIELDS), validate: validateFolders });
registerSection('projects', { owner: 'core', empty: [], idField: 'id', normalize: normalizeList(PROJECT_FIELDS), validate: validateProjects });

// ---- lettura ----

// traits: solo i progetti con almeno uno di questi tratti (le estensioni passano i loro)
const list = ({ traits } = {}) => loadConfig().projects.filter(p => hasAnyTrait(p, traits));
const get = id => list().find(p => p.id === id) || null;
const folders = () => loadConfig().projectFolders;

// ---- modifica (errori come ApiError del core) ----

// folder: id di una cartella, oppure ''/null per la radice
function folderField(cfg, folder) {
  if (folder === undefined) return undefined;
  if (folder === null || folder === '') return null;
  if (!cfg.projectFolders.some(f => f.id === folder)) throw coreError(400, 'folder_unknown', { folder: String(folder) });
  return folder;
}

// Tratti forzati: { add, remove } senza doppioni né tratti in entrambe; vuoto → null
function traitsField(traits) {
  if (traits === undefined || traits === null) return null;
  if (!validOverrides(traits)) throw coreError(400, 'project_traits_invalid');
  const add = [...new Set(traits.add || [])], remove = [...new Set(traits.remove || [])].filter(t => !add.includes(t));
  return add.length || remove.length ? { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) } : null;
}

function checkPath(projectPath) {
  if (typeof projectPath !== 'string' || !path.isAbsolute(projectPath)) throw coreError(400, 'path_absolute');
  if (!fs.existsSync(projectPath)) throw coreError(400, 'path_not_found', { path: projectPath });
}

function createProject(body = {}) {
  const { id, label, path: projectPath } = body;
  if (!id || !label || !projectPath) throw coreError(400, 'project_fields');
  const cfg = loadConfig();
  if (cfg.projects.some(p => p.id === id)) throw coreError(409, 'project_exists', { id: String(id) });
  checkPath(projectPath);
  const folder = folderField(cfg, body.folder);
  const traits = traitsField(body.traits);
  const p = { id, label, path: projectPath, ...(folder ? { folder } : {}), ...(traits ? { traits } : {}) };
  cfg.projects = [...cfg.projects, p];
  saveConfig(cfg);
  return p;
}

// Solo nome, percorso e cartella: l'id non cambia
function updateProject(id, body = {}) {
  const cfg = loadConfig();
  const p = cfg.projects.find(x => x.id === id);
  if (!p) throw coreError(404, 'project_not_found', { id: String(id) });
  if (body.path !== undefined) checkPath(body.path);
  Object.assign(p, pick(body, ['label', 'path']));
  if (body.traits !== undefined) {
    const traits = traitsField(body.traits);
    if (traits) p.traits = traits; else delete p.traits;
  }
  const folder = folderField(cfg, body.folder);
  if (folder === null) delete p.folder;
  else if (folder) p.folder = folder;
  saveConfig(cfg);
  return p;
}

function deleteProject(id) {
  const cfg = loadConfig();
  cfg.projects = cfg.projects.filter(p => p.id !== id);
  saveConfig(cfg);
}

function createFolder(body = {}) {
  const cfg = loadConfig();
  const f = { id: `f${crypto.randomBytes(4).toString('hex')}`, label: typeof body.label === 'string' ? body.label.trim() : '' };
  if (!isText(f.label, 100)) throw coreError(400, 'folder_label_required');
  cfg.projectFolders = [...cfg.projectFolders, f];
  saveConfig(cfg);
  return f;
}

function updateFolder(id, body = {}) {
  const cfg = loadConfig();
  const f = cfg.projectFolders.find(x => x.id === id);
  if (!f) throw coreError(404, 'folder_unknown', { folder: String(id) });
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!isText(label, 100)) throw coreError(400, 'folder_label_required');
  f.label = label;
  saveConfig(cfg);
  return f;
}

// I progetti della cartella tornano nella radice (stessa scrittura)
function deleteFolder(id) {
  const cfg = loadConfig();
  cfg.projectFolders = cfg.projectFolders.filter(f => f.id !== id);
  for (const p of cfg.projects) if (p.folder === id) delete p.folder;
  saveConfig(cfg);
}

// ---- import da una cartella ----

const MAX_SCAN = 500;

// La cartella e le sue sottocartelle (un livello, non nascoste, senza node_modules) che hanno
// almeno un tratto conosciuto: { path, candidates: [{ path, name, label, traits, added }] }
function scanFolder(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw coreError(400, 'path_absolute');
  if (!isDir(dir)) throw coreError(400, 'path_not_found', { path: dir });
  let names;
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map(e => e.name); }
  catch (e) { throw coreError(400, 'path_unreadable', { path: dir, error: e.message }); }
  const existing = new Set(loadConfig().projects.map(p => path.resolve(p.path)));
  const candidates = [];
  for (const d of [dir, ...names.sort((a, b) => a.localeCompare(b)).slice(0, MAX_SCAN).map(n => path.join(dir, n))]) {
    detected.delete(d);
    const traits = detectTraits(d);
    // la cartella stessa solo se è un progetto di suo (non basta essere dentro un repository)
    if (!traits.length || (d === dir && traits.every(t => t === 'git') && !exists(path.join(d, '.git')))) continue;
    candidates.push({ path: d, name: path.basename(d), label: labelFor(d), traits, added: existing.has(path.resolve(d)) });
  }
  return { path: dir, candidates };
}

// Nome proposto: "name" di package.json, altrimenti il nome della cartella
function labelFor(dir) {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    if (typeof name === 'string' && name.trim() && name.length <= 100) return name.trim();
  } catch { /* nessun package.json */ }
  return path.basename(dir);
}

// Id libero ricavato dal nome della cartella
function freeId(base, taken) {
  const slug = base.normalize('NFKD').replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'project';
  let id = slug, n = 2;
  while (taken.has(id)) id = `${slug}-${n++}`;
  taken.add(id);
  return id;
}

// { paths: [...], folder? } → { added: [progetti], skipped: [{ path, reason }] }, in una scrittura
function importProjects({ paths, folder } = {}) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SCAN) throw coreError(400, 'import_paths');
  const cfg = loadConfig();
  const target = folderField(cfg, folder);
  const taken = new Set(cfg.projects.map(p => p.id));
  const existing = new Set(cfg.projects.map(p => path.resolve(p.path)));
  const added = [], skipped = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || !isDir(raw)) { skipped.push({ path: String(raw), reason: 'not_found' }); continue; }
    const dir = path.resolve(raw);
    if (existing.has(dir)) { skipped.push({ path: dir, reason: 'exists' }); continue; }
    existing.add(dir);
    const p = { id: freeId(path.basename(dir), taken), label: labelFor(dir), path: dir, ...(target ? { folder: target } : {}) };
    added.push(p);
  }
  if (added.length) {
    cfg.projects = [...cfg.projects, ...added];
    saveConfig(cfg);
  }
  return { added, skipped };
}

module.exports = {
  scanFolder, importProjects,
  list, get, folders,
  knownTraits, traitsOf, detectTraits, describeProject, setTraitSource, TRAIT_RE,
  createProject, updateProject, deleteProject,
  createFolder, updateFolder, deleteFolder,
};
