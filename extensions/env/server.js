// File .env dei progetti: confronto con il modello (.env.example), lettura dei
// valori uno alla volta e modifica che conserva commenti e ordine. I valori non
// passano mai dalla configurazione di Kelbo né dagli strumenti MCP.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('./dotenv');

const FILE_RE = /^\.env(\.[A-Za-z0-9_-]+)*$/;
const TEMPLATES = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const MAX_SIZE = 256 * 1024;

module.exports = function createEnv(ctx) {

  const projectOr404 = id => {
    const p = ctx.projects.get(id);
    if (!p) throw ctx.error(404, 'project_not_found', { id: String(id) });
    return p;
  };

  // Nomi dei file .env* nella cartella del progetto (solo file, niente sottocartelle)
  function envFiles(p) {
    try {
      return fs.readdirSync(p.path, { withFileTypes: true })
        .filter(e => e.isFile() && FILE_RE.test(e.name)).map(e => e.name)
        .sort((a, b) => (a === '.env' ? -1 : b === '.env' ? 1 : a.localeCompare(b)));
    } catch { return []; }
  }

  function fileOf(p, name) {
    if (!FILE_RE.test(name || '')) throw ctx.error(400, 'file_invalid', { name: String(name ?? '') });
    return path.join(p.path, name);
  }

  function read(p, name) {
    const file = fileOf(p, name);
    let stat;
    try { stat = fs.statSync(file); } catch { throw ctx.error(404, 'file_not_found', { name }); }
    if (!stat.isFile()) throw ctx.error(404, 'file_not_found', { name });
    if (stat.size > MAX_SIZE) throw ctx.error(413, 'file_too_large', { name });
    const text = fs.readFileSync(file, 'utf8');
    return { file, text, version: crypto.createHash('sha1').update(text).digest('hex'), mode: stat.mode };
  }

  const templateOf = names => TEMPLATES.find(t => names.includes(t)) || null;

  // Chiavi di ogni file (mai i valori) e differenze con il modello
  function overview(p) {
    const names = envFiles(p);
    const template = templateOf(names);
    const files = names.map(name => {
      try {
        const { text, version } = read(p, name);
        const { entries } = dotenv.parse(text);
        const keys = [...new Map(entries.map(e => [e.key, e])).values()]; // l'ultima voce con una chiave vince
        return { name, version, keys: keys.map(e => ({ key: e.key, empty: e.value === '' })) };
      } catch (e) { return { name, error: e.message }; }
    });
    const tpl = files.find(f => f.name === template);
    const tplKeys = new Set((tpl?.keys || []).map(k => k.key));
    for (const f of files) {
      if (!f.keys || f.name === template || !tpl) continue;
      const own = new Set(f.keys.map(k => k.key));
      f.missing = [...tplKeys].filter(k => !own.has(k));
      f.extra = [...own].filter(k => !tplKeys.has(k));
    }
    for (const f of files) if (f.keys) f.empty = f.keys.filter(k => k.empty).map(k => k.key);
    const issues = files.reduce((n, f) => n + (f.missing?.length || 0), 0);
    return { project: p.id, template, files, issues };
  }

  // Modifica di un file con il controllo di versione (contenuto letto dall'editor)
  function write(p, name, version, changes) {
    const cur = read(p, name);
    if (version !== cur.version) throw ctx.error(409, 'file_changed', { name });
    let text;
    try { text = dotenv.apply(cur.text, changes); }
    catch (e) { if (e instanceof dotenv.EnvError) throw ctx.error(400, e.key, e.params); throw e; }
    const tmp = `${cur.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text, { mode: cur.mode & 0o777 });
    fs.renameSync(tmp, cur.file);
  }

  return {
    handlers: {
      projects(req, res) {
        res.json(ctx.projects.list({ traits: ['env'] }).map(p => {
          const o = overview(p);
          return { id: p.id, label: p.label, ...(p.folder ? { folder: p.folder } : {}), files: o.files.map(f => f.name), template: o.template, issues: o.issues };
        }));
      },

      project(req, res) {
        res.json(overview(projectOr404(req.params.id)));
      },

      // Un valore alla volta, solo su richiesta
      value(req, res) {
        const p = projectOr404(req.params.id);
        const { text, version } = read(p, req.params.file);
        const entry = dotenv.parse(text).entries.filter(e => e.key === req.query.key).pop();
        if (!entry) throw ctx.error(404, 'key_missing', { key: String(req.query.key ?? '') });
        res.json({ key: entry.key, value: entry.value, version });
      },

      // { version, changes: [{ op: 'set'|'rename'|'delete', key, value?, to? }] }
      update(req, res) {
        const p = projectOr404(req.params.id);
        write(p, req.params.file, req.body.version, Array.isArray(req.body.changes) ? req.body.changes : []);
        res.json(overview(p));
      },

      // Aggiunge in fondo le chiavi del modello che mancano, con i valori del modello
      addMissing(req, res) {
        const p = projectOr404(req.params.id);
        const template = templateOf(envFiles(p));
        if (!template) throw ctx.error(400, 'no_template');
        if (req.params.file === template) throw ctx.error(400, 'is_template');
        const tpl = dotenv.parse(read(p, template).text).entries;
        const have = new Set(dotenv.parse(read(p, req.params.file).text).entries.map(e => e.key));
        const changes = [...new Map(tpl.map(e => [e.key, e])).values()].filter(e => !have.has(e.key)).map(e => ({ op: 'set', key: e.key, value: e.value }));
        if (changes.length) write(p, req.params.file, req.body.version, changes);
        res.json({ added: changes.map(c => c.key), ...overview(p) });
      },

      // Nuovo file { name } copiato dal modello (o vuoto se non c'è); mai sovrascritto
      create(req, res) {
        const p = projectOr404(req.params.id);
        const file = fileOf(p, req.body.name);
        const template = templateOf(envFiles(p));
        const content = template ? read(p, template).text : '';
        try { fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); }
        catch (e) { if (e.code === 'EEXIST') throw ctx.error(409, 'file_exists', { name: req.body.name }); throw e; }
        res.json(overview(p));
      },
    },

    mcp: {
      // Chiavi e differenze, mai i valori
      check({ project } = {}) {
        const list = project ? [projectOr404(project)] : ctx.projects.list();
        return { projects: list.map(p => ({ id: p.id, label: p.label, ...overview(p) })) };
      },
    },
  };
};
