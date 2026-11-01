// NPM: script di package.json dei progetti (del core, ctx.projects) eseguiti come
// processi tracciati in un process group dedicato, dipendenze.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_LOG_LINES = 500;

module.exports = function createNpm(ctx) {
  const { NPM_NAME_RE } = ctx.lib.validate;
  const { getPortsForPgid } = ctx.lib.ports;

  const processes = new Map(); // id → { id, projectId, projectLabel, script, args, pid, process, startedAt, logs[], running, exitCode }

  // ---- progetti ----

  const getProject = id => ctx.projects.get(id);

  // package.json del progetto (null se assente o non valido)
  function readPackage(p) {
    try { return JSON.parse(fs.readFileSync(path.join(p.path, 'package.json'), 'utf8')); } catch { return null; }
  }

  // ---- processi tracciati ----

  function log(pd, text) {
    pd.logs.push({ ts: Date.now(), text });
    if (pd.logs.length > MAX_LOG_LINES) pd.logs.splice(0, pd.logs.length - MAX_LOG_LINES);
  }

  // Avvia (o riavvia) npm con pd.args in un process group dedicato. Gli eventi di un
  // processo sostituito da un riavvio vengono ignorati: altrimenti la sua chiusura
  // segnerebbe come terminato il processo nuovo.
  function spawnNpm(pd, cwd, header = '') {
    const proc = spawn('npm', pd.args, { cwd, env: { ...process.env }, detached: true });
    pd.process = proc; pd.pid = proc.pid;
    pd.startedAt = new Date().toISOString();
    pd.running = true; pd.exitCode = null;
    log(pd, `${header}$ npm ${pd.args.join(' ')} (pid ${proc.pid})\n`);
    const current = () => pd.process === proc;
    proc.stdout.on('data', d => log(pd, d.toString()));
    proc.stderr.on('data', d => log(pd, d.toString()));
    proc.on('close', code => {
      if (!current()) return;
      pd.running = false; pd.exitCode = code;
      log(pd, `\n[exit ${code}]`);
    });
    proc.on('error', err => { if (current()) { pd.running = false; log(pd, `\n[error: ${err.message}]`); } });
  }

  function startNpm(p, script, args) {
    const pd = {
      id: crypto.randomUUID(), projectId: p.id, projectLabel: p.label,
      script, args, pid: null, process: null,
      startedAt: null, logs: [], running: false, exitCode: null,
    };
    processes.set(pd.id, pd);
    spawnNpm(pd, p.path);
    return pd;
  }

  // Ferma l'intero process group (anche i figli che tengono occupata la porta)
  // force: SIGKILL invece di SIGTERM (processi che non rispondono)
  function killGroup(pd, force = false) {
    const signal = force ? 'SIGKILL' : 'SIGTERM';
    try {
      if (pd.process && pd.pid) process.kill(-pd.pid, signal);
    } catch {
      try { pd.process && pd.process.kill(signal); } catch {}
    }
  }

  const publicProcess = pd => ({
    id: pd.id, projectId: pd.projectId, projectLabel: pd.projectLabel,
    script: pd.script, pid: pd.pid, ports: pd.running ? getPortsForPgid(pd.pid) : [],
    startedAt: pd.startedAt, running: pd.running, exitCode: pd.exitCode,
  });

  // Avvii degli script per progetto (per il widget "più usati"): nella cartella dati di Kelbo
  // su questo computer, non in config.json → { <progetto>: { <script>: { count, last } } }
  const usageFile = () => path.join(ctx.dataDir(), 'runs.json');
  const readUsage = () => { try { return JSON.parse(fs.readFileSync(usageFile(), 'utf8')) || {}; } catch { return {}; } };
  function countRun(projectId, script) {
    const all = readUsage();
    const entry = ((all[projectId] ||= {})[script] ||= { count: 0, last: null });
    entry.count++;
    entry.last = new Date().toISOString();
    try { fs.writeFileSync(usageFile(), JSON.stringify(all)); } catch (e) { ctx.log.warn('contatore degli script non salvato:', e.message); }
  }

  const projectOr404 = req => {
    const p = getProject(req.params.id);
    if (!p) throw ctx.error(404, 'project_not_found', { id: req.params.id });
    return p;
  };
  const processOr404 = req => {
    const pd = processes.get(req.params.id);
    if (!pd) throw ctx.error(404, 'process_not_found');
    return pd;
  };

  return {
    services: {
      readPackage,
      // per l'estensione ports: processi avviati da Kelbo (pid = process group) e arresto
      processes: () => [...processes.values()].filter(pd => pd.running).map(pd => ({ id: pd.id, pid: pd.pid, project: pd.projectLabel, script: pd.script })),
      stopProcess(id, { force = false } = {}) {
        const pd = processes.get(id);
        if (!pd) return false;
        killGroup(pd, force);
        pd.running = false;
        processes.delete(pd.id);
        return true;
      },
    },

    // Strumenti MCP: lettura, più avvio e arresto degli script (come dall'interfaccia)
    mcp: {
      projects() {
        return {
          projects: ctx.projects.list().map(p => {
            const pkg = readPackage(p);
            return { id: p.id, label: p.label, path: p.path, name: pkg?.name || null, scripts: pkg?.scripts || {} };
          }),
        };
      },
      processes() {
        return { processes: [...processes.values()].map(publicProcess) };
      },
      run({ project, script }) {
        const p = getProject(project);
        if (!p) throw ctx.error(404, 'project_not_found', { id: String(project) });
        if (typeof script !== 'string' || !script) throw ctx.error(400, 'script_required');
        let args;
        if (script === 'install') args = ['install'];
        else {
          if (!Object.hasOwn(readPackage(p)?.scripts || {}, script)) throw ctx.error(400, 'script_not_defined', { script });
          args = ['run', script];
        }
        const pd = startNpm(p, script, args);
        return { started: true, process: publicProcess(pd) };
      },
      stop({ process: id }) {
        const pd = processes.get(id);
        if (!pd) throw ctx.error(404, 'process_not_found');
        killGroup(pd);
        pd.running = false;
        processes.delete(pd.id);
        return { stopped: true, id };
      },
      output({ process: id, lines = 100 }) {
        const pd = processes.get(id);
        if (!pd) throw ctx.error(404, 'process_not_found');
        const n = Math.min(Math.max(parseInt(lines) || 100, 1), 2000);
        const text = pd.logs.map(l => l.text).join('').split('\n');
        return { ...publicProcess(pd), output: text.slice(-n).join('\n'), truncated: text.length > n };
      },
    },

    handlers: {
      packageInfo(req, res) {
        const p = projectOr404(req);
        if (!fs.existsSync(path.join(p.path, 'package.json'))) {
          return res.json({ name: null, scripts: {}, dependencies: {}, devDependencies: {} });
        }
        const pkg = readPackage(p);
        if (!pkg) throw ctx.error(500, 'package_invalid');
        res.json({
          name: pkg.name || null,
          version: pkg.version || null,
          scripts: pkg.scripts || {},
          dependencies: pkg.dependencies || {},
          devDependencies: pkg.devDependencies || {},
        });
      },

      // Versioni installate (da node_modules/<pkg>/package.json); nomi non validi ignorati
      installedVersions(req, res) {
        const p = projectOr404(req);
        const names = Array.isArray(req.body.packages) ? req.body.packages : [];
        const result = {};
        for (const name of names) {
          if (typeof name !== 'string' || !NPM_NAME_RE.test(name)) continue;
          try {
            result[name] = JSON.parse(fs.readFileSync(path.join(p.path, 'node_modules', name, 'package.json'), 'utf8')).version || null;
          } catch {
            result[name] = null;
          }
        }
        res.json(result);
      },

      // npm outdated --json esce con codice 1 se ci sono aggiornamenti: l'output resta valido
      outdated(req, res) {
        const p = projectOr404(req);
        let out;
        try {
          out = execFileSync('npm', ['outdated', '--json'], { cwd: p.path, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
          out = e.stdout || '{}';
        }
        try { res.json(JSON.parse(out || '{}')); }
        catch { ctx.error.send(res, 500, 'outdated_invalid'); }
      },

      // Solo "install" o script definiti in package.json
      runScript(req, res) {
        const p = projectOr404(req);
        const { script } = req.body;
        if (typeof script !== 'string' || !script) throw ctx.error(400, 'script_required');
        let args;
        if (script === 'install') {
          args = ['install'];
        } else {
          const scripts = readPackage(p)?.scripts || {};
          if (!Object.hasOwn(scripts, script)) throw ctx.error(400, 'script_not_defined', { script });
          args = ['run', script];
        }
        const pd = startNpm(p, script, args);
        countRun(p.id, script);
        res.json({ id: pd.id, pid: pd.pid });
      },

      // Avvii degli script del progetto: { <script>: { count, last } }
      usage(req, res) {
        const p = projectOr404(req);
        res.json({ scripts: readUsage()[p.id] || {} });
      },

      // npm update <pkg>: solo pacchetti dichiarati in package.json
      updatePackage(req, res) {
        const p = projectOr404(req);
        const name = req.body.package;
        const pkg = readPackage(p) || {};
        const declared = { ...pkg.dependencies, ...pkg.devDependencies };
        if (typeof name !== 'string' || !NPM_NAME_RE.test(name) || !Object.hasOwn(declared, name)) {
          throw ctx.error(400, 'package_not_declared', { name: String(name) });
        }
        const pd = startNpm(p, `update ${name}`, ['update', name]);
        res.json({ id: pd.id, pid: pd.pid });
      },

      listProcesses(req, res) {
        res.json([...processes.values()].map(publicProcess));
      },

      stopProcess(req, res) {
        const pd = processOr404(req);
        killGroup(pd);
        pd.running = false;
        processes.delete(pd.id);
        res.json({ ok: true });
      },

      restartProcess(req, res) {
        const pd = processOr404(req);
        const p = getProject(pd.projectId);
        if (!p) throw ctx.error(400, 'project_gone');
        killGroup(pd);
        spawnNpm(pd, p.path, '\n--- ↻ ---\n');
        res.json({ ok: true, pid: pd.pid });
      },

      // Toglie dalla lista un processo già terminato
      dismissProcess(req, res) {
        const pd = processOr404(req);
        if (pd.running) throw ctx.error(409, 'process_running');
        processes.delete(pd.id);
        res.json({ ok: true });
      },

      processLogs(req, res) {
        const pd = processOr404(req);
        res.json({ running: pd.running, exitCode: pd.exitCode, logs: pd.logs.slice(-200) });
      },

      // Log in streaming: prima lo storico, poi le righe nuove ogni 100ms
      processStream(req, res) {
        const pd = processOr404(req);
        const send = ctx.sse(res);
        if (pd.logs.length) send('history', pd.logs.map(l => l.text).join(''));
        // exit: { exitCode } oppure { removed: true }; il testo lo compone il frontend
        if (!pd.running) { send('exit', { exitCode: pd.exitCode, ended: true }); send.end(); return; }

        let lastTs = pd.logs.length ? pd.logs[pd.logs.length - 1].ts : Date.now();
        const timer = setInterval(() => {
          const cur = processes.get(pd.id);
          if (!cur) { clearInterval(timer); send('exit', { removed: true }); send.end(); return; }
          const fresh = cur.logs.filter(l => l.ts > lastTs);
          if (fresh.length) { send('stdout', fresh.map(l => l.text).join('')); lastTs = fresh[fresh.length - 1].ts; }
          if (!cur.running) { clearInterval(timer); send('exit', { exitCode: cur.exitCode }); send.end(); }
        }, 100);
        req.on('close', () => clearInterval(timer));
      },
    },

    shutdown() {
      for (const pd of processes.values()) killGroup(pd);
    },
  };
};
