// Installazione delle estensioni da repository git, senza il server (lo usa anche la riga di
// comando): versioni dai tag semver, anteprima da un clone superficiale e parziale in una
// cartella di staging, installazione atomica, lock file, versione precedente conservata,
// controllo degli aggiornamenti, cataloghi.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const semver = require('./semver');
const { HOME, INSTALLED_DIR } = require('./env');
const { coreError } = require('./errors');

const OFFICIAL_CATALOG = 'https://raw.githubusercontent.com/kelbodev/kelbo-extensions/main/index.json';
// Catalogo ufficiale prima del passaggio a Kelbo: nelle liste salvate diventa quello nuovo
const LEGACY_OFFICIAL_CATALOG = 'https://raw.githubusercontent.com/codo82/devdock-extensions/main/index.json';

// Repository ufficiale prima del passaggio a Kelbo (GitHub rimanda ancora al nuovo): negli
// indirizzi salvati (lock file, elenco delle installate) diventa kelbodev/kelbo-extensions
const LEGACY_REPO_RE = /^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)codo82\/devdock-extensions(\.git)?(\/?)$/i;
const renamedRepo = url => {
  const m = typeof url === 'string' ? LEGACY_REPO_RE.exec(url) : null;
  return m ? `${m[1]}kelbodev/kelbo-extensions${m[2] || ''}${m[3]}` : url;
};

// Cataloghi da usare: quelli salvati in config.json (extensions.catalogs) o quello ufficiale
const catalogUrls = saved => (saved ?? [OFFICIAL_CATALOG]).map(u => u === LEGACY_OFFICIAL_CATALOG ? OFFICIAL_CATALOG : u);
const STAGING_DIR = path.join(INSTALLED_DIR, '.staging');
const BACKUP_DIR = path.join(HOME, 'backups');
const LOCK_FILE = path.join(HOME, 'extensions.lock.json');
const CODE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KINDS = new Set(['component', 'provider', 'theme']);
const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const GIT_TIMEOUT_MS = 120000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_COMPAT_TRIES = 5;

// ---- comandi esterni ----

function run(cmd, args, { cwd, timeout = GIT_TIMEOUT_MS, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      cwd, timeout, maxBuffer: 20 * 1024 * 1024,
      // niente richieste di credenziali sul terminale: valgono chiavi SSH e credential helper
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', npm_config_yes: 'true' },
    }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { output: `${stdout || ''}${stderr || ''}`.trim() }));
      resolve(stdout);
    });
    if (onOutput) { child.stdout?.on('data', d => onOutput(String(d))); child.stderr?.on('data', d => onOutput(String(d))); }
  });
}

// git con i protocolli pericolosi spenti (ext::) e senza prompt
const git = (args, opts) => run('git', ['-c', 'protocol.ext.allow=never', ...args], opts);
const gitError = (e, name = 'git_failed') => coreError(502, name, { output: (e.output || e.message || '').slice(-2000) });

// ---- sorgenti ----

// "https://host/repo.git#path=tools/ext" (o ssh, git@host:repo, file://, percorso locale) →
// { repo, path }; il frammento #path= indica la cartella dell'estensione nel repository
function parseSource(input, folder) {
  let text = String(input ?? '').trim();
  let sub = folder ?? null;
  const hash = text.indexOf('#');
  if (hash >= 0) {
    const frag = new URLSearchParams(text.slice(hash + 1));
    if (frag.get('path')) sub = frag.get('path');
    text = text.slice(0, hash);
  }
  sub = sub ? String(sub).replace(/^\/+|\/+$/g, '') : null;
  const ok = text.length <= 500 && !/\s/.test(text) && !text.startsWith('-')
    && (/^(https?|ssh|git|file):\/\/\S+$/.test(text) || /^[\w.-]+@[\w.-]+:\S+$/.test(text) || path.isAbsolute(text));
  if (!ok) throw coreError(400, 'ext_source_invalid', { source: String(input ?? '') });
  if (sub && (!PATH_RE.test(sub) || sub.split('/').includes('..'))) throw coreError(400, 'ext_path_invalid', { path: sub });
  return { repo: text, path: sub || null };
}

// Prefisso dei tag: "v1.2.0" per un'estensione nella radice, "<codice>@1.2.0" in una cartella
const tagPrefix = (src, code) => (src.path ? `${code || path.posix.basename(src.path)}@` : '');

// Tag di versione del repository, dal più recente: [{ tag, version, object }]
async function listVersions(src, code) {
  let out;
  try { out = await git(['ls-remote', '--tags', '--refs', '--', src.repo], { timeout: 60000 }); }
  catch (e) { throw gitError(e, 'ext_repo_unreachable'); }
  const prefix = tagPrefix(src, code);
  const list = [];
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40,64})\s+refs\/tags\/(.+)$/.exec(line.trim());
    if (!m) continue;
    const tag = m[2];
    let version = null;
    if (prefix) { if (tag.startsWith(prefix)) version = tag.slice(prefix.length); }
    else if (!tag.includes('@')) version = tag.replace(/^v/, '');
    if (version && semver.valid(version)) list.push({ tag, version: semver.parse(version) && version, object: m[1] });
  }
  return list.sort((a, b) => semver.compare(b.version, a.version));
}

async function headCommit(src) {
  try {
    const out = await git(['ls-remote', '--', src.repo, 'HEAD'], { timeout: 60000 });
    return out.split(/\s/)[0] || null;
  } catch (e) { throw gitError(e, 'ext_repo_unreachable'); }
}

// ---- lock file: cosa è installato, da dove, a quale tag e commit ----

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); } catch { return { extensions: {} }; }
}
function writeLock(lock) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = `${LOCK_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2));
  fs.renameSync(tmp, LOCK_FILE);
}

// All'avvio: indirizzi del repository ufficiale di prima riscritti nel lock file (anche quelli
// della versione precedente, per il ritorno indietro). → numero di indirizzi cambiati
function migrateLegacyRepos() {
  const lock = readLock();
  let changed = 0;
  for (const e of Object.values(lock.extensions || {})) {
    for (const entry of [e, e.previous].filter(Boolean)) {
      const next = renamedRepo(entry.repo);
      if (next !== entry.repo) { entry.repo = next; changed++; }
    }
  }
  if (changed) writeLock(lock);
  return changed;
}

// ---- anteprima (staging) ----

const previews = new Map(); // id → { dir, extDir, src, tag, manifest, … }

function cleanupPreviews() {
  for (const [id, p] of previews) {
    if (Date.now() - p.createdAt > PREVIEW_TTL_MS) { fs.rmSync(p.dir, { recursive: true, force: true }); previews.delete(id); }
  }
}

// Changelog della versione: le sezioni "## [x.y.z]" più recenti di quella installata
function changelogExcerpt(extDir, fromVersion) {
  let text;
  try { text = fs.readFileSync(path.join(extDir, 'CHANGELOG.md'), 'utf8'); } catch { return null; }
  const parts = text.split(/^(?=## )/m).filter(p => p.startsWith('## '));
  const picked = [];
  for (const p of parts) {
    const v = /^## \[?v?(\d+\.\d+\.\d+[^\]\s]*)/.exec(p)?.[1];
    if (!v) continue;
    if (fromVersion && semver.valid(fromVersion) && semver.compare(v, fromVersion) <= 0) break;
    picked.push(p.trim());
    if (picked.length >= 10) break;
  }
  return picked.length ? picked.join('\n\n').slice(0, 20000) : null;
}

// Clone superficiale e parziale della sola cartella dell'estensione, al tag (o al ramo
// predefinito), in una cartella di staging; legge e controlla il manifest
async function stage(src, ref, validateManifest) {
  cleanupPreviews();
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(STAGING_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const repoDir = path.join(dir, 'repo');
  try {
    const args = ['clone', '--quiet', '--depth', '1', '--filter=blob:none', ...(src.path ? ['--sparse'] : []), ...(ref ? ['--branch', ref] : []), '--', src.repo, repoDir];
    try { await git(args); } catch (e) { throw gitError(e, 'ext_clone_failed'); }
    if (src.path) {
      try { await git(['-C', repoDir, 'sparse-checkout', 'set', '--', src.path]); } catch (e) { throw gitError(e, 'ext_clone_failed'); }
    }
    const commit = (await git(['-C', repoDir, 'rev-parse', 'HEAD'])).trim();
    const extDir = src.path ? path.join(repoDir, src.path) : repoDir;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(extDir, 'setting.json'), 'utf8')); }
    catch { throw coreError(400, 'ext_no_manifest', { path: src.path || '/' }); }
    if (!CODE_RE.test(raw?.code || '')) throw coreError(400, 'ext_manifest_invalid', { error: 'code' });
    let manifest;
    try { manifest = validateManifest(raw, raw.code); } catch (e) { throw coreError(400, 'ext_manifest_invalid', { error: e.message }); }
    return { id, dir, repoDir, extDir, src, ref, commit, manifest, createdAt: Date.now() };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

// Anteprima di un'estensione: versioni (tag), la più recente compatibile (o quella chiesta),
// manifest, dipendenze, changelog. known: estensioni presenti ({ code → { version, source } })
async function preview({ source, folder, tag, code, validateManifest, coreVersion, known = {}, catalog = [] }) {
  const src = typeof source === 'object' ? source : parseSource(source, folder);
  const versions = await listVersions(src, code);
  let staged = null;
  let chosen = null;
  if (tag) {
    chosen = versions.find(v => v.tag === tag);
    if (!chosen) throw coreError(404, 'ext_tag_not_found', { tag });
    staged = await stage(src, chosen.tag, validateManifest);
  } else if (versions.length) {
    // la più recente compatibile con questa versione di Kelbo (al massimo qualche tentativo)
    for (const v of versions.slice(0, MAX_COMPAT_TRIES)) {
      const s = await stage(src, v.tag, validateManifest);
      if (semver.satisfies(coreVersion, s.manifest.kelbo) || v === versions[Math.min(versions.length, MAX_COMPAT_TRIES) - 1]) { staged = s; chosen = v; break; }
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  } else {
    staged = await stage(src, null, validateManifest); // nessun tag: ramo predefinito
  }
  const m = staged.manifest;
  if (code && m.code !== code) {
    fs.rmSync(staged.dir, { recursive: true, force: true });
    throw coreError(400, 'ext_code_mismatch', { expected: code, found: m.code });
  }
  staged.tag = chosen?.tag || null;
  staged.tagObject = chosen?.object || null;
  previews.set(staged.id, staged);
  const installed = known[m.code];
  const deps = m.dependencies.map(d => {
    const have = known[d.code];
    const inCatalog = catalog.find(c => c.code === d.code) || null;
    return { code: d.code, required: d.required, installed: !!have, available: inCatalog ? { repo: inCatalog.repo, path: inCatalog.path || null } : null };
  });
  return {
    id: staged.id, repo: src.repo, path: src.path, tag: staged.tag, commit: staged.commit,
    code: m.code, name: m.name, description: m.description || '', version: m.version, kelbo: m.kelbo, devdock: m.kelbo,
    icon: m.icon || null, color: m.color,
    compatible: semver.satisfies(coreVersion, m.kelbo), coreVersion,
    versions: versions.map(v => ({ tag: v.tag, version: v.version })),
    dependencies: deps,
    missing: deps.filter(d => d.required && !d.installed).map(d => d.code),
    installed: installed ? { version: installed.version, source: installed.source } : null,
    builtin: installed?.source === 'builtin',
    changelog: changelogExcerpt(staged.extDir, installed?.version),
    hasNpmDependencies: hasNpmDependencies(staged.extDir),
    reloadable: m.reloadable !== false,
  };
}

function hasNpmDependencies(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies || {}).length > 0;
  } catch { return false; }
}

// ---- installazione ----

// Dall'anteprima alla cartella delle installate: dipendenze npm (senza script), copia senza
// .git, spostamento atomico; la versione presente va nei backup (una sola per estensione).
// step(key, params) e log(text) riportano l'avanzamento. Nessuna traccia se qualcosa fallisce.
async function install(id, { step = () => {}, log = () => {}, beforeMove = () => {} } = {}) {
  const p = previews.get(id);
  if (!p) throw coreError(404, 'ext_preview_expired');
  previews.delete(id);
  const code = p.manifest.code;
  try { beforeMove(code); } catch (e) { fs.rmSync(p.dir, { recursive: true, force: true }); throw e; }
  const target = path.join(INSTALLED_DIR, code);
  const tmp = path.join(INSTALLED_DIR, `.tmp-${code}-${p.id}`);
  try {
    if (hasNpmDependencies(p.extDir)) {
      step('npm');
      try {
        await run(process.platform === 'win32' ? 'npm.cmd' : 'npm',
          ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--workspaces=false'],
          { cwd: p.extDir, timeout: 600000, onOutput: log });
      } catch (e) { throw coreError(502, 'ext_npm_failed', { output: (e.output || e.message).slice(-2000) }); }
    }
    step('copy');
    fs.mkdirSync(INSTALLED_DIR, { recursive: true });
    fs.cpSync(p.extDir, tmp, { recursive: true, filter: src => path.basename(src) !== '.git' });
    const lock = readLock();
    const prev = lock.extensions[code];
    if (fs.existsSync(target) || isLink(target)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const backup = path.join(BACKUP_DIR, code);
      fs.rmSync(backup, { recursive: true, force: true });
      fs.renameSync(target, backup);
    }
    fs.renameSync(tmp, target);
    lock.extensions[code] = {
      repo: p.src.repo, ...(p.src.path ? { path: p.src.path } : {}), tag: p.tag, version: p.manifest.version,
      commit: p.commit, tagObject: p.tagObject, installedAt: new Date().toISOString(),
      ...(prev ? { previous: { repo: prev.repo, path: prev.path, tag: prev.tag, version: prev.version, commit: prev.commit, tagObject: prev.tagObject } } : {}),
    };
    writeLock(lock);
    step('done');
    return { code, version: p.manifest.version, tag: p.tag, previous: prev?.version || null };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(p.dir, { recursive: true, force: true });
  }
}

const isLink = f => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };

// Rimuove un'estensione installata (cartella, backup, voce del lock)
function remove(code) {
  if (!CODE_RE.test(code || '')) throw coreError(400, 'ext_code_invalid');
  const target = path.join(INSTALLED_DIR, code);
  if (!fs.existsSync(target) && !isLink(target)) throw coreError(404, 'ext_not_installed', { code });
  fs.rmSync(target, { recursive: true, force: true });
  fs.rmSync(path.join(BACKUP_DIR, code), { recursive: true, force: true });
  const lock = readLock();
  delete lock.extensions[code];
  writeLock(lock);
}

// Torna alla versione precedente (scambio con il backup)
function restore(code) {
  if (!CODE_RE.test(code || '')) throw coreError(400, 'ext_code_invalid');
  const backup = path.join(BACKUP_DIR, code);
  const target = path.join(INSTALLED_DIR, code);
  if (!fs.existsSync(backup)) throw coreError(404, 'ext_no_backup', { code });
  const swap = path.join(BACKUP_DIR, `.swap-${code}`);
  fs.rmSync(swap, { recursive: true, force: true });
  if (fs.existsSync(target)) fs.renameSync(target, swap);
  fs.renameSync(backup, target);
  if (fs.existsSync(swap)) fs.renameSync(swap, backup);
  const lock = readLock();
  const cur = lock.extensions[code];
  if (cur?.previous) {
    const { previous, ...current } = cur;
    lock.extensions[code] = { ...previous, installedAt: new Date().toISOString(), previous: { repo: current.repo, path: current.path, tag: current.tag, version: current.version, commit: current.commit, tagObject: current.tagObject } };
    writeLock(lock);
  }
  return lock.extensions[code] || null;
}

const hasBackup = code => fs.existsSync(path.join(BACKUP_DIR, code));

// ---- aggiornamenti ----

// Per ogni estensione installata da git: versione più recente dei tag, tag spostato
// (stesso nome, altro commit) o, senza tag, un commit nuovo sul ramo predefinito
async function checkUpdates() {
  const lock = readLock();
  const out = {};
  for (const [code, e] of Object.entries(lock.extensions || {})) {
    try {
      const src = { repo: e.repo, path: e.path || null };
      if (!e.tag) {
        const head = await headCommit(src);
        out[code] = { current: e.version, latest: null, available: !!head && head !== e.commit, untagged: true };
        continue;
      }
      const versions = await listVersions(src, code);
      const latest = versions[0] || null;
      const same = versions.find(v => v.tag === e.tag);
      out[code] = {
        current: e.version, latest: latest?.version || null, tag: latest?.tag || null,
        available: !!latest && semver.compare(latest.version, e.version) > 0,
        moved: !!same && !!e.tagObject && same.object !== e.tagObject,
        missing: !same,
      };
    } catch (err) { out[code] = { current: e.version, error: err.message }; }
  }
  return { checkedAt: new Date().toISOString(), extensions: out };
}

// ---- cataloghi ----

const catalogCache = new Map(); // url → { at, data }

async function fetchCatalog(url) {
  const cached = catalogCache.get(url);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const list = Array.isArray(json) ? json : json?.extensions;
    if (!Array.isArray(list)) throw new Error('extensions mancante');
    const data = list.filter(e => e && CODE_RE.test(e.code || '') && typeof e.repo === 'string' && (e.path == null || PATH_RE.test(e.path)))
      .slice(0, 500).map(e => ({
        code: e.code, name: e.name || e.code, description: e.description || '', repo: e.repo, path: e.path || null,
        // nome Lucide (dalla 2.25) o emoji
        icon: typeof e.icon === 'string' ? e.icon.slice(0, 40) : null, version: typeof e.version === 'string' ? e.version : null,
        kinds: Array.isArray(e.kinds) ? [...new Set(e.kinds.filter(k => KINDS.has(k)))] : [],
      }));
    catalogCache.set(url, { at: Date.now(), data });
    return data;
  } finally { clearTimeout(timer); }
}

// Tutti i cataloghi configurati: { catalogs: [{ url, ok, error, count }], extensions: [... , catalog] }
async function catalogs(urls, { refresh = false } = {}) {
  if (refresh) catalogCache.clear();
  const results = await Promise.all(urls.map(async url => {
    try { return { url, ok: true, list: await fetchCatalog(url) }; } catch (e) { return { url, ok: false, error: e.message, list: [] }; }
  }));
  const seen = new Set();
  const extensions = [];
  for (const r of results) for (const e of r.list) if (!seen.has(e.code)) { seen.add(e.code); extensions.push({ ...e, catalog: r.url }); }
  return { catalogs: results.map(r => ({ url: r.url, ok: r.ok, error: r.error || null, count: r.list.length })), extensions };
}

module.exports = {
  OFFICIAL_CATALOG, LOCK_FILE, BACKUP_DIR, STAGING_DIR,
  catalogUrls, renamedRepo, migrateLegacyRepos, parseSource, listVersions, preview, install, remove, restore, hasBackup, readLock, checkUpdates, catalogs,
};
