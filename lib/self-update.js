// Aggiornamento di Kelbo stesso (non delle estensioni): versione più recente dai tag v<x.y.z>
// del repository di origine, CHANGELOG delle versioni nuove, aggiornamento di un checkout git
// pulito (solo avanti: fast-forward del ramo o checkout del tag), npm install, versione di prima
// conservata per tornare indietro, riavvio chiesto a PM2 quando Kelbo gira sotto PM2.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const semver = require('./semver');
const { coreError } = require('./errors');

const GIT_TIMEOUT_MS = 120000;
const NPM_TIMEOUT_MS = 600000;
const TAG_RE = /^v(\d+\.\d+\.\d+)$/;
const LOCKFILE = 'package-lock.json';

function run(cmd, args, { cwd, timeout = GIT_TIMEOUT_MS, onOutput, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      cwd, timeout, maxBuffer: 20 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', ...env },
      shell: process.platform === 'win32' && cmd === 'npm', // npm.cmd su Windows
    }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { output: `${stdout || ''}${stderr || ''}`.trim() }));
      resolve(String(stdout));
    });
    if (onOutput) { child.stdout?.on('data', d => onOutput(String(d))); child.stderr?.on('data', d => onOutput(String(d))); }
  });
}
const git = (root, args, opts = {}) => run('git', ['-c', 'protocol.ext.allow=never', ...args], { cwd: root, ...opts });
const failed = (name, e, params = {}) => coreError(502, name, { ...params, output: (e.output || e.message || '').slice(-2000) });

// Sezioni "## [x.y.z]" di un CHANGELOG più recenti di fromVersion (al massimo fino a toVersion)
function changelogBetween(text, fromVersion, toVersion = null) {
  const parts = String(text || '').split(/^(?=## )/m).filter(p => p.startsWith('## '));
  const picked = [];
  for (const p of parts) {
    const v = /^## \[?v?(\d+\.\d+\.\d+)/.exec(p)?.[1];
    if (!v) continue;
    if (toVersion && semver.compare(v, toVersion) > 0) continue;
    if (fromVersion && semver.compare(v, fromVersion) <= 0) break;
    picked.push(p.trim());
    if (picked.length >= 30) break;
  }
  return picked.length ? picked.join('\n\n').slice(0, 60000) : null;
}

// root: cartella di Kelbo; version: quella in esecuzione; stateFile: dove ricordare la versione
// di prima; pm2: comando per il riavvio (sostituibile nei test)
function createSelfUpdate({ root, version, stateFile, pm2 = 'pm2', log = console }) {
  let status = { checkedAt: null, current: version, latest: null, tag: null, available: false, error: null };

  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } };
  const writeState = s => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2)); };

  // Kelbo è un checkout git con origin? { git, branch, commit, origin, clean, changes } o { git: false, reason }
  async function checkout() {
    try {
      const top = (await git(root, ['rev-parse', '--show-toplevel'], { timeout: 15000 })).trim();
      if (path.resolve(top) !== path.resolve(root)) return { git: false, reason: 'not_root' };
    } catch { return { git: false, reason: 'not_git' }; }
    let origin = null;
    try { origin = (await git(root, ['remote', 'get-url', 'origin'], { timeout: 15000 })).trim() || null; } catch { /* senza origin */ }
    const branch = (await git(root, ['branch', '--show-current'], { timeout: 15000 }).catch(() => '')).trim() || null;
    const commit = (await git(root, ['rev-parse', 'HEAD'], { timeout: 15000 })).trim();
    // solo i file tracciati: config.json e node_modules sono ignorati, i file nuovi non bloccano;
    // package-lock.json riscritto da un npm install non conta (si rimette com'era prima di aggiornare)
    const all = (await git(root, ['status', '--porcelain', '--untracked-files=no'], { timeout: 30000 })).split('\n').filter(Boolean).map(l => l.slice(3).trim());
    const changes = all.filter(f => f !== LOCKFILE);
    return { git: true, branch, commit, origin, clean: !changes.length, changes: changes.slice(0, 100), lockChanged: all.includes(LOCKFILE) };
  }

  // Tag v<x.y.z> di origin, dal più recente: [{ tag, version }]
  async function remoteVersions() {
    const out = await git(root, ['ls-remote', '--tags', '--refs', 'origin', 'v*'], { timeout: 60000 });
    const list = [];
    for (const line of out.split('\n')) {
      const m = /^[0-9a-f]{40,64}\s+refs\/tags\/(v\d+\.\d+\.\d+)$/.exec(line.trim());
      if (m) list.push({ tag: m[1], version: TAG_RE.exec(m[1])[1] });
    }
    return list.sort((a, b) => semver.compare(b.version, a.version));
  }

  async function check() {
    const co = await checkout();
    if (!co.git || !co.origin) {
      status = { ...status, checkedAt: new Date().toISOString(), latest: null, tag: null, available: false, error: co.git ? 'no_origin' : co.reason };
      return status;
    }
    try {
      const latest = (await remoteVersions())[0] || null;
      status = {
        checkedAt: new Date().toISOString(), current: version, latest: latest?.version || null, tag: latest?.tag || null,
        available: !!latest && semver.compare(latest.version, version) > 0, error: null,
      };
    } catch (e) {
      status = { ...status, checkedAt: new Date().toISOString(), error: 'unreachable', detail: (e.output || e.message || '').slice(-500) };
    }
    return status;
  }

  // Scarica il tag (solo quello) e legge il suo CHANGELOG: le versioni fra quella in uso e il tag
  async function changelog(tag = status.tag) {
    if (!TAG_RE.test(tag || '')) throw coreError(400, 'update_tag_invalid', { tag: String(tag ?? '') });
    try { await git(root, ['fetch', '--no-tags', 'origin', `refs/tags/${tag}:refs/tags/${tag}`]); }
    catch (e) { throw failed('update_fetch_failed', e, { tag }); }
    let text = '';
    try { text = await git(root, ['show', `${tag}:CHANGELOG.md`], { timeout: 30000 }); } catch { /* senza CHANGELOG */ }
    return { tag, version: TAG_RE.exec(tag)[1], changelog: changelogBetween(text, version, TAG_RE.exec(tag)[1]) };
  }

  // Controlli prima di aggiornare (o tornare indietro): checkout git pulito
  async function ensureUpdatable() {
    const co = await checkout();
    if (!co.git) throw coreError(409, 'update_not_git');
    if (!co.origin) throw coreError(409, 'update_no_origin');
    if (!co.clean) throw coreError(409, 'update_local_changes', { count: co.changes.length }, { files: co.changes });
    return co;
  }

  // Porta il checkout al commit voluto: ramo → fast-forward (o, tornando indietro, reset --keep);
  // HEAD staccato → checkout del commit
  async function moveTo(co, ref, { back = false } = {}) {
    if (co.lockChanged) await git(root, ['checkout', '--', LOCKFILE]);
    if (co.branch) {
      if (back) await git(root, ['reset', '--keep', ref]);
      else await git(root, ['merge', '--ff-only', ref]);
    } else await git(root, ['checkout', '--detach', ref]);
  }

  // npm ci (non tocca package-lock.json); se non va, npm install e il lock rimesso com'era
  async function npmInstall(step, out) {
    step('npm');
    const flags = ['--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'];
    try { await run('npm', ['ci', ...flags], { cwd: root, timeout: NPM_TIMEOUT_MS, onOutput: out }); return; } catch { out('\nnpm ci → npm install\n'); }
    try { await run('npm', ['install', ...flags], { cwd: root, timeout: NPM_TIMEOUT_MS, onOutput: out }); }
    catch (e) { throw failed('update_npm_failed', e); }
    await git(root, ['checkout', '--', LOCKFILE]).catch(() => {});
  }

  // Aggiornamento al tag (predefinito: il più recente). step(key, params) e out(text) per l'avanzamento
  async function update({ tag = null, step = () => {}, out = () => {} } = {}) {
    const co = await ensureUpdatable();
    step('check');
    let target = tag;
    if (!target) {
      const latest = (await remoteVersions().catch(e => { throw failed('update_unreachable', e); }))[0];
      if (!latest) throw coreError(404, 'update_none');
      target = latest.tag;
    }
    const m = TAG_RE.exec(target || '');
    if (!m) throw coreError(400, 'update_tag_invalid', { tag: String(target) });
    if (semver.compare(m[1], version) <= 0) throw coreError(409, 'update_not_newer', { version: m[1], current: version });
    step('fetch', { tag: target });
    try { await git(root, ['fetch', '--no-tags', 'origin', `refs/tags/${target}:refs/tags/${target}`], { onOutput: out }); }
    catch (e) { throw failed('update_fetch_failed', e, { tag: target }); }
    const commit = (await git(root, ['rev-parse', `${target}^{commit}`])).trim();
    // solo avanti: il commit attuale deve essere un antenato del tag
    try { await git(root, ['merge-base', '--is-ancestor', co.commit, commit]); }
    catch { throw coreError(409, 'update_not_fast_forward', { tag: target }); }
    step('checkout', { tag: target });
    try { await moveTo(co, commit); } catch (e) { throw failed('update_checkout_failed', e, { tag: target }); }
    writeState({ ...readState(), previous: { version, commit: co.commit, branch: co.branch, at: new Date().toISOString() } });
    await npmInstall(step, out);
    status = { ...status, current: m[1], available: false };
    return { from: version, to: m[1], tag: target, restart: restartInfo() };
  }

  // Ritorno alla versione di prima dell'ultimo aggiornamento
  async function rollback({ step = () => {}, out = () => {} } = {}) {
    const prev = readState().previous;
    if (!prev?.commit) throw coreError(404, 'update_no_previous');
    const co = await ensureUpdatable();
    step('checkout', { tag: `v${prev.version}` });
    try { await moveTo(co, prev.commit, { back: true }); } catch (e) { throw failed('update_checkout_failed', e, { tag: `v${prev.version}` }); }
    writeState({ ...readState(), previous: null });
    await npmInstall(step, out);
    return { from: version, to: prev.version, restart: restartInfo() };
  }

  // Sotto PM2 (pm_id nell'ambiente) il riavvio lo fa PM2; altrimenti va fatto a mano
  function restartInfo() {
    const managed = process.env.pm_id !== undefined;
    return { managed, name: managed ? process.env.name || 'kelbo' : null };
  }
  // Chiede a PM2 di riavviare questo processo: comando staccato, così sopravvive al riavvio
  function restart() {
    const info = restartInfo();
    if (!info.managed) throw coreError(409, 'restart_not_managed');
    const child = spawn(pm2, ['restart', info.name, '--update-env'], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' });
    child.on('error', e => log.error(`[aggiornamento] pm2 restart: ${e.message}`));
    child.unref();
    return { restarting: true, name: info.name };
  }

  async function info() {
    const co = await checkout();
    const prev = readState().previous;
    return {
      ...status, current: version,
      checkout: co.git ? { git: true, branch: co.branch, commit: co.commit.slice(0, 12), origin: co.origin, clean: co.clean, changes: co.changes.length } : co,
      previous: prev?.version || null, restart: restartInfo(),
    };
  }

  return { check, info, changelog, update, rollback, restart, status: () => status };
}

module.exports = { createSelfUpdate, changelogBetween };
