// API del core: estensioni caricate e strumenti di sistema
const express = require('express');
const path = require('path');
const { ROOT } = require('../lib/env');
const { SOURCE_LANG, languages } = require('../lib/i18n');
const { getTools, refreshTools } = require('../lib/system');
const { ConfigError, listSections, exportConfig, importConfig } = require('../lib/config');
const { errorBody } = require('../lib/errors');
const projects = require('../lib/projects');
const layout = require('../lib/layout');
const vault = require('../lib/vault');
const installer = require('../lib/ext-install');
const semver = require('../lib/semver');
const { validateManifest, CORE_VERSION } = require('../lib/extensions');
const { loadConfig, saveConfig } = require('../lib/config');
const { openSse } = require('../lib/sse');
const { coreError } = require('../lib/errors');

const NAME_RE = /^[a-z0-9-]{1,40}$/;

module.exports = function coreRoutes(extensions) {
  const router = express.Router();

  router.get('/extensions', (req, res) => {
    res.json(extensions.list());
  });

  // Lingue dai cataloghi del core, con la completezza (core + estensioni attive)
  router.get('/i18n/languages', (req, res) => {
    const extCatalogs = extensions.extensions
      .filter(e => e.state !== 'disabled' && e.i18n.length)
      .map(e => ({ code: e.manifest.code, dir: path.join(e.dir, 'i18n') }));
    res.json({ source: SOURCE_LANG, languages: languages(path.join(ROOT, 'public/core/i18n'), extCatalogs) });
  });

  // Server MCP: endpoint, token e strumenti (per il pannello MCP)
  router.get('/mcp', (req, res) => {
    const { getToken } = require('../lib/mcp');
    const { PORT, CONFIG_PATH, ROOT: root } = require('../lib/env');
    res.json({
      url: `http://127.0.0.1:${PORT}/mcp`,
      token: getToken(),
      // ponte stdio per i client che avviano i server come processi: node con il percorso
      // assoluto (le app grafiche non vedono il PATH della shell) e l'ambiente dell'istanza
      // solo quando non è quello predefinito
      bridge: {
        command: process.execPath,
        args: [path.join(root, 'bin', 'kelbo-mcp.js')],
        env: {
          ...(PORT !== 3500 ? { KELBO_PORT: String(PORT) } : {}),
          ...(CONFIG_PATH !== path.join(root, 'config.json') ? { KELBO_CONFIG: CONFIG_PATH } : {}),
        },
      },
      tools: extensions.mcpTools().map(t => ({ name: t.name, extension: t.extension, description: t.description, readOnly: t.readOnly })),
    });
  });
  router.post('/mcp/token', (req, res) => {
    res.json({ token: require('../lib/mcp').regenerateToken() });
  });

  // Progetti e cartelle della sidebar (condivisi da npm, git, env…)
  router.get('/projects', (req, res) => {
    // traitsFound: rilevati nella cartella, traitsActive: con quelli forzati; traits: i tratti conosciuti
    res.json({ folders: projects.folders(), projects: projects.list().map(projects.describeProject), traits: projects.knownTraits().map(({ id, label, source }) => ({ id, label, source })) });
  });
  router.post('/projects', (req, res) => { res.json(projects.createProject(req.body)); });
  router.put('/projects/:id', (req, res) => { res.json(projects.updateProject(req.params.id, req.body)); });
  router.delete('/projects/:id', (req, res) => { projects.deleteProject(req.params.id); res.json({ ok: true }); });
  // Cosa le estensioni hanno collegato al progetto (connessioni, sezioni HTTP, bacheca…)
  const answer = fn => (req, res, next) => { Promise.resolve().then(() => fn(req)).then(r => res.json(r)).catch(next); };
  router.get('/projects/:id/links', answer(async req => {
    const p = projects.get(req.params.id);
    if (!p) throw coreError(404, 'project_not_found', { id: String(req.params.id) });
    return { links: await extensions.projectLinks(p) };
  }));
  // Import da una cartella: sottocartelle con almeno un tratto conosciuto, poi quelle scelte
  router.post('/projects/scan', answer(req => projects.scanFolder(req.body?.path)));
  router.post('/projects/import', answer(req => projects.importProjects(req.body || {})));
  router.post('/folders', (req, res) => { res.json(projects.createFolder(req.body)); });
  router.put('/folders/:id', (req, res) => { res.json(projects.updateFolder(req.params.id, req.body)); });
  router.delete('/folders/:id', (req, res) => { projects.deleteFolder(req.params.id); res.json({ ok: true }); });

  // Ordine delle tab scelto dall'utente (codici sconosciuti scartati); DELETE = ordine dei manifest
  const codesAt = (...positions) => extensions.list().filter(e => e.state !== 'disabled' && positions.includes(e.position) && e.frontend?.js).map(e => e.code);
  const tabCodes = () => codesAt('tab', 'tab-icon');
  router.get('/layout', (req, res) => { res.json(layout.get()); });
  router.put('/layout/tabs', (req, res) => { res.json(layout.setTabs(req.body?.tabs, tabCodes())); });
  router.delete('/layout/tabs', (req, res) => { res.json(layout.resetTabs()); });
  // Ordine della barra a destra (estensioni in posizione "sidebar"), come quello delle tab
  router.put('/layout/rail', (req, res) => { res.json(layout.setRail(req.body?.rail, codesAt('sidebar'))); });
  router.delete('/layout/rail', (req, res) => { res.json(layout.resetRail()); });
  // Posto dell'estensione, anche diverso dal manifest ({ position: 'tab'|'tab-icon'|'header'|'sidebar'|null })
  router.put('/layout/positions/:code', (req, res) => {
    const ext = extensions.list().find(e => e.code === req.params.code && !e.duplicate);
    res.json(layout.setPosition(req.params.code, req.body?.position ?? null, ext?.frontend?.js ? ext.manifestPosition : null));
  });

  // Tema dei colori ({ id, scheme, system }), salvato in layout.theme
  router.put('/layout/theme', (req, res) => { res.json(layout.setTheme(req.body)); });

  // Vault della master password (segreti di db-client, http-client e delle altre estensioni)
  router.get('/vault', (req, res) => { res.json(vault.status()); });
  // errori (anche asincroni) all'error handler del core; Retry-After dopo troppi tentativi
  const vaultCall = fn => (req, res, next) => {
    Promise.resolve().then(() => fn(req.body || {})).then(r => res.json(r)).catch(e => {
      if (e.extra?.retryAfter) res.setHeader('Retry-After', String(e.extra.retryAfter));
      next(e);
    });
  };
  router.post('/vault/init', vaultCall(b => vault.init(b.password)));
  router.post('/vault/unlock', vaultCall(b => vault.unlock(b.password)));
  router.post('/vault/lock', vaultCall(() => { vault.lock(); return { ok: true, state: vault.state() }; }));
  router.post('/vault/change', vaultCall(b => vault.change(b.oldPassword, b.newPassword)));
  router.post('/vault/reset', vaultCall(b => vault.reset(b.confirm)));
  router.post('/vault/settings', vaultCall(b => vault.settings(b.lockAfterMinutes)));

  // ---- estensioni: pannello, cataloghi, installazione, aggiornamenti ----

  const settings = () => loadConfig().extensions || {};
  const catalogUrls = () => installer.catalogUrls(settings().catalogs);
  // estensioni presenti (non i doppioni): codice → { version, source }
  const known = () => Object.fromEntries(extensions.list().filter(e => !e.duplicate)
    .map(e => [e.code, { version: e.version, source: e.source }]));
  // elenco delle installate (sorgente e tag, niente codice) in config.json, per l'export
  function syncInstalledList() {
    const lock = installer.readLock();
    const cfg = loadConfig();
    cfg.extensions = { ...(cfg.extensions || {}), installed: Object.entries(lock.extensions).map(([code, e]) => ({ code, repo: e.repo, ...(e.path ? { path: e.path } : {}), ...(e.tag ? { tag: e.tag } : {}) })) };
    saveConfig(cfg);
  }
  // Indirizzi del repository ufficiale di prima (codo82/devdock-extensions) riscritti una volta
  // all'avvio, nel lock file e nell'elenco delle installate di config.json
  try {
    installer.migrateLegacyRepos();
    const cfg = loadConfig();
    const list = cfg.extensions?.installed;
    if (Array.isArray(list) && list.some(x => installer.renamedRepo(x?.repo) !== x?.repo)) {
      cfg.extensions = { ...cfg.extensions, installed: list.map(x => ({ ...x, repo: installer.renamedRepo(x.repo) })) };
      saveConfig(cfg);
    }
  } catch (e) { console.error('[estensioni] indirizzi dei repository:', e.message); }

  let updates = { checkedAt: null, extensions: {} };
  async function checkUpdates() {
    try { updates = await installer.checkUpdates(); } catch (e) { console.error('[estensioni] controllo aggiornamenti:', e.message); }
    return updates;
  }
  // all'avvio (poco dopo) e una volta al giorno
  setTimeout(checkUpdates, 15000).unref();
  setInterval(checkUpdates, 24 * 3600 * 1000).unref();

  const extCall = fn => (req, res, next) => { Promise.resolve().then(() => fn(req, res)).then(r => r !== undefined && res.json(r)).catch(next); };
  const codeOf = req => { if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(req.params.code)) throw coreError(400, 'ext_code_invalid'); return req.params.code; };

  // Tutto quello che serve al pannello Estensioni
  router.get('/extensions-admin', extCall(() => {
    const lock = installer.readLock().extensions;
    const present = new Set(extensions.list().map(e => e.code));
    return {
      coreVersion: CORE_VERSION,
      extensions: extensions.list().map(e => ({
        ...e, dir: undefined,
        ...(e.source === 'installed' && lock[e.code] ? { lock: { repo: lock[e.code].repo, path: lock[e.code].path || null, tag: lock[e.code].tag, commit: lock[e.code].commit, installedAt: lock[e.code].installedAt, previous: lock[e.code].previous?.version || null } } : {}),
        hasBackup: e.source === 'installed' && installer.hasBackup(e.code),
        update: e.source === 'installed' ? updates.extensions[e.code] || null : null,
      })),
      // nell'elenco importato (export di un'altra macchina) ma non installate qui
      pending: (settings().installed || []).filter(x => !present.has(x.code)),
      catalogs: catalogUrls(),
      updatesCheckedAt: updates.checkedAt,
    };
  }));

  router.post('/extensions-admin/:code/enabled', extCall(req => {
    const code = codeOf(req);
    if (!extensions.get(code)) throw coreError(404, 'ext_not_found', { code });
    return extensions.setEnabled(code, req.body?.enabled !== false);
  }));

  router.post('/extensions-admin/:code/reload', extCall(req => extensions.reload(codeOf(req))));

  router.get('/extensions-admin/catalog', extCall(async req => {
    const data = await installer.catalogs(catalogUrls(), { refresh: !!req.query.refresh });
    const present = known();
    const newer = e => {
      const p = present[e.code];
      return p?.source === 'installed' && semver.valid(e.version) && semver.valid(p.version) && semver.compare(e.version, p.version) > 0;
    };
    // il catalogo ha una versione più nuova di quella installata ma il controllo dei tag (una
    // volta al giorno) non la conosce ancora: lo si rifà subito, al massimo una volta al minuto
    const stale = data.extensions.some(e => newer(e) && !updates.extensions[e.code]?.available);
    if (stale && Date.now() - Date.parse(updates.checkedAt || 0) > 60 * 1000) await checkUpdates();
    return {
      ...data,
      updatesCheckedAt: updates.checkedAt,
      extensions: data.extensions.map(e => ({ ...e, installed: present[e.code] || null, update: newer(e) ? updates.extensions[e.code] || null : null })),
    };
  }));

  router.put('/extensions-admin/catalogs', extCall(req => {
    const list = req.body?.catalogs;
    const cfg = loadConfig();
    cfg.extensions = { ...(cfg.extensions || {}), catalogs: Array.isArray(list) ? list.map(u => String(u).trim()).filter(Boolean) : list };
    saveConfig(cfg);
    return { catalogs: catalogUrls() };
  }));

  // { source, folder?, tag?, code? } oppure { code } di un catalogo → anteprima (staging)
  router.post('/extensions-admin/preview', extCall(async req => {
    const b = req.body || {};
    let source = b.source, folder = b.folder, code = b.code || undefined;
    if (!source && code) {
      const entry = (await installer.catalogs(catalogUrls())).extensions.find(e => e.code === code);
      if (!entry) throw coreError(404, 'ext_not_in_catalog', { code });
      source = entry.repo; folder = entry.path;
    }
    let catalog = [];
    try { catalog = (await installer.catalogs(catalogUrls())).extensions; } catch { /* dipendenze senza proposta */ }
    return installer.preview({ source, folder, tag: b.tag || undefined, code, validateManifest, coreVersion: CORE_VERSION, known: known(), catalog });
  }));

  // Aggiornamento: anteprima della versione più recente (o del tag indicato) dalla stessa sorgente
  router.post('/extensions-admin/:code/update', extCall(async req => {
    const code = codeOf(req);
    const lock = installer.readLock().extensions[code];
    if (!lock) throw coreError(404, 'ext_not_installed', { code });
    return installer.preview({ source: { repo: lock.repo, path: lock.path || null }, tag: req.body?.tag || undefined, code, validateManifest, coreVersion: CORE_VERSION, known: known() });
  }));

  // Installazione dell'anteprima { id }, con l'avanzamento in streaming; poi caricata a caldo
  router.post('/extensions-admin/install', (req, res) => {
    const send = openSse(res);
    (async () => {
      try {
        const id = String(req.body?.id || '');
        const result = await installer.install(id, {
          step: (key, params) => send('step', { key, params }),
          log: text => send('log', text),
          beforeMove: code => { if (known()[code]?.source === 'builtin') throw coreError(409, 'ext_builtin_exists', { code }); },
        });
        syncInstalledList();
        send('step', { key: 'load' });
        const loaded = extensions.reload(result.code);
        send('done', { ...result, ...loaded, state: extensions.get(result.code)?.state || null, error: extensions.get(result.code)?.error || null });
        checkUpdates();
      } catch (e) {
        send('error', e.code ? { error: e.message, code: e.code, params: e.params } : { error: e.message });
      } finally { send.end(); }
    })();
  });

  router.post('/extensions-admin/:code/restore', extCall(req => {
    const code = codeOf(req);
    installer.restore(code);
    syncInstalledList();
    const r = extensions.reload(code);
    checkUpdates();
    return r;
  }));

  router.delete('/extensions-admin/:code', extCall(req => {
    const code = codeOf(req);
    const ext = extensions.list().find(e => e.code === code && e.source === 'installed');
    if (!ext) throw coreError(extensions.get(code) ? 400 : 404, extensions.get(code) ? 'ext_builtin' : 'ext_not_installed', { code });
    if (!ext.reloadable) throw coreError(409, 'ext_restart_required', { code });
    installer.remove(code);
    syncInstalledList();
    return extensions.reload(code);
  }));

  router.post('/extensions-admin/updates', extCall(() => checkUpdates()));

  // ?refresh=1 ricontrolla gli strumenti (es. dopo un'installazione)
  router.get('/system', (req, res) => {
    if (req.query.refresh) refreshTools();
    res.json({ platform: process.platform, tools: getTools() });
  });

  // Sezioni di config.json con il loro proprietario (core o codice dell'estensione)
  router.get('/config/sections', (req, res) => {
    res.json(listSections());
  });

  // Export come download. ?sections=a,b limita alle sezioni indicate; ?name= per il nome file
  router.get('/config/export', (req, res) => {
    const keys = req.query.sections ? String(req.query.sections).split(',').filter(Boolean) : null;
    const name = NAME_RE.test(req.query.name || '') ? req.query.name : 'all';
    res.setHeader('Content-Disposition', `attachment; filename="kelbo-config-${name}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(exportConfig(keys), null, 2));
  });

  // Import: { config, mode: 'replace' | 'merge' } — solo le sezioni presenti nel file
  router.post('/config/import', (req, res) => {
    try {
      res.json({ ok: true, ...importConfig(req.body?.config, req.body?.mode) });
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      res.status(400).json(errorBody(e));
    }
  });

  return router;
};
