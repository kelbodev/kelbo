// Git: status, commit, grafo dei commit e operazioni remote per i repository
// dei progetti (risalendo dalla cartella del progetto fino a .git)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

module.exports = function createGit(ctx) {
  const { isValidBranchName, isValidCommitHash } = ctx.lib.validate;

  function gitExec(cwd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });
      let out = '', err = '';
      proc.stdout && proc.stdout.on('data', d => out += d.toString());
      proc.stderr && proc.stderr.on('data', d => err += d.toString());
      proc.on('close', code => {
        if (code === 0 || opts.allowFail) resolve({ out, err, code });
        else reject(new Error(err.trim() || out.trim() || `git exit ${code}`));
      });
      proc.on('error', reject);
    });
  }

  // ---- Validazione delle azioni git ----

  const GIT_ACTIONS = new Set(['commit', 'pull', 'push', 'push_force', 'pull_push', 'merge', 'merge_abort', 'merge_continue', 'fetch', 'checkout', 'checkout_new', 'branch_delete', 'stash', 'stash_pop']);
  const BRANCH_ACTIONS = new Set(['push', 'push_force', 'pull_push', 'merge', 'checkout', 'checkout_new', 'branch_delete']); // branch obbligatorio
  const REMOTE_ACTIONS = new Set(['pull', 'push', 'push_force', 'pull_push']);              // remote usato

  async function getGitRemotes(cwd) {
    const r = await gitExec(cwd, ['remote'], { allowFail: true });
    return r.out.split('\n').map(x => x.trim()).filter(Boolean);
  }

  // Restituisce l'errore (400) o null se i parametri sono validi
  async function validateGitAction(repoPath, { action, branch, remote, message }) {
    if (!GIT_ACTIONS.has(action)) return ctx.error(400, 'action_unsupported', { action: String(action) });
    if (BRANCH_ACTIONS.has(action) && !branch) return ctx.error(400, 'branch_required');
    if (branch != null && branch !== '' && !isValidBranchName(branch)) return ctx.error(400, 'branch_invalid', { branch: String(branch) });
    if (REMOTE_ACTIONS.has(action) && !(await getGitRemotes(repoPath)).includes(remote)) return ctx.error(400, 'remote_unknown', { remote: String(remote) });
    if (message != null && typeof message !== 'string') return ctx.error(400, 'message_invalid');
    return null;
  }

  // git status --porcelain -z: nomi file esatti (niente quoting), rinomine con path originale
  async function getGitStatus(cwd) {
    const r = await gitExec(cwd, ['status', '--porcelain', '-b', '-z'], { allowFail: true });
    const fields = r.out.split('\0');
    const header = fields[0].startsWith('## ') ? fields.shift() : '';
    const files = [];
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f) continue;
      const entry = { xy: f.slice(0, 2), name: f.slice(3) };
      if (/[RC]/.test(entry.xy)) entry.orig = fields[++i]; // rinomina/copia: segue il path originale
      files.push(entry);
    }
    return { header, files };
  }

  function findGitRoot(startPath) {
    let dir = startPath;
    while (true) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null; // filesystem root, non trovato
      dir = parent;
    }
  }

  function getGitRepos() {
    const seen = new Set();
    const repos = [];
    for (const p of ctx.projects.list()) {
      const gitRoot = findGitRoot(p.path);
      if (!gitRoot || seen.has(gitRoot)) continue; // più progetti nella stessa repo: una sola voce
      seen.add(gitRoot);
      repos.push({ id: p.id, label: p.label, path: gitRoot, ...(p.folder ? { folder: p.folder } : {}) });
    }
    return repos;
  }

  // Comandi di ogni azione (commit a parte: dipende dai file selezionati).
  // optional: un errore non interrompe la sequenza (es. il fetch prima del push,
  // che aggiorna solo i remote-tracking ref).
  const ACTION_STEPS = {
    pull:       ({ remote, branch }) => [{ args: ['pull', remote, ...(branch ? [branch] : ['--rebase=false'])] }],
    push:       ({ remote, branch }) => [{ args: ['fetch', remote], optional: true }, { args: ['push', remote, branch] }],
    push_force: ({ remote, branch }) => [{ args: ['push', '--force-with-lease', remote, branch] }],
    pull_push:  ({ remote, branch }) => [{ args: ['pull', remote, branch] }, { args: ['push', remote, branch] }],
    merge:      ({ branch, mode }) => [{ args: ['merge', ...(mode === 'no-ff' ? ['--no-ff'] : mode === 'squash' ? ['--squash'] : []), branch] }],
    merge_abort: () => [{ args: ['merge', '--abort'] }],
    fetch:      () => [{ args: ['fetch', '--all', '--prune'] }],
    checkout:   ({ branch }) => [{ args: ['checkout', branch, '--'] }],
    stash:      () => [{ args: ['stash'] }],
    stash_pop:  () => [{ args: ['stash', 'pop'] }],
  };

  // ---- merge ----

  const CONFLICT_XY = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  const mergeInProgress = async cwd =>
    (await gitExec(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true })).code === 0;

  // File in conflitto che contengono ancora i marcatori <<<<<<< / >>>>>>>
  async function unresolvedConflicts(cwd) {
    const names = (await getGitStatus(cwd)).files.filter(f => CONFLICT_XY.has(f.xy)).map(f => f.name);
    return names.filter(name => {
      try { return /^(<{7}|>{7})( |$)/m.test(fs.readFileSync(path.join(cwd, name), 'utf8')); }
      catch { return false; } // cancellato: si risolve con l'add
    });
  }

  // ---- cambio e creazione di branch: controlli prima di eseguire ----

  const refExists = async (cwd, ref) => (await gitExec(cwd, ['show-ref', '--verify', '--quiet', ref], { allowFail: true })).code === 0;

  // Modifiche ai file tracciati (i file non tracciati seguono il cambio di branch)
  const trackedChanges = async cwd => (await getGitStatus(cwd)).files.filter(f => f.xy !== '??').map(f => f.name);

  // Passi per checkout / checkout_new ({ steps }), oppure { error } da restituire subito
  async function prepareSwitch(cwd, { action, branch, startPoint, stash }) {
    let steps, target = branch, needsCleanTree = true;
    if (action === 'checkout_new') {
      if (await refExists(cwd, `refs/heads/${branch}`)) {
        return { error: ctx.error(409, 'exists', { branch }) };
      }
      if (startPoint != null && startPoint !== '') {
        if (typeof startPoint !== 'string' || startPoint.startsWith('-')
            || (await gitExec(cwd, ['rev-parse', '--verify', '--quiet', `${startPoint}^{commit}`], { allowFail: true })).code !== 0) {
          return { error: ctx.error(400, 'start_point_invalid', { startPoint: String(startPoint) }) };
        }
        steps = [{ args: ['checkout', '-b', branch, startPoint] }];
      } else {
        steps = [{ args: ['checkout', '-b', branch] }];
        needsCleanTree = false; // dal commit attuale: le modifiche restano dove sono
      }
    } else if (await refExists(cwd, `refs/heads/${branch}`)) {
      steps = [{ args: ['checkout', branch, '--'] }];
    } else if (await refExists(cwd, `refs/remotes/${branch}`)) {
      // branch remoto (es. origin/feature): copia locale che lo segue, se non c'è già
      target = branch.slice(branch.indexOf('/') + 1);
      steps = await refExists(cwd, `refs/heads/${target}`)
        ? [{ args: ['checkout', target, '--'] }]
        : [{ args: ['checkout', '--track', branch] }];
    } else {
      return { error: ctx.error(404, 'not_found', { branch }) };
    }

    if (needsCleanTree) {
      const dirty = await trackedChanges(cwd);
      if (dirty.length && !stash) {
        return { error: ctx.error(409, 'dirty', { count: dirty.length }, { files: dirty }) };
      }
      if (dirty.length) steps.unshift({ args: ['stash', 'push', '-m', `devdock → ${target}`] });
    }
    return { steps };
  }

  // Esegue un comando git mostrando "$ git …" e l'output; risolve con l'exit code
  function runStep(cwd, args, send) {
    return new Promise(resolve => {
      send('stdout', `$ git ${args.join(' ')}\n`);
      const proc = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      proc.stdout.on('data', d => send('stdout', d.toString()));
      proc.stderr.on('data', d => send('stderr', d.toString()));
      proc.on('error', e => { send('error', { error: e.message }); resolve(1); });
      proc.on('close', code => resolve(code ?? 1));
    });
  }

  // Esegue i passi in sequenza; si ferma al primo errore di un passo non opzionale
  async function runSteps(cwd, steps, send) {
    for (const step of steps) {
      const code = await runStep(cwd, step.args, send);
      if (code !== 0 && !step.optional) return code;
      // messaggio di Kelbo: { error, code, params } tradotto dal frontend
      if (code !== 0) send('notice', notice('step_failed', { command: step.args[0] }));
    }
    return 0;
  }

  const busyRepos = new Set(); // path dei repo con un'azione git in corso

  // Evento SSE con codice traducibile (stesso formato delle risposte di errore)
  const notice = (name, params = {}) => ({ error: ctx.error.message(name, params), code: `${ctx.code}.${name}`, params });
  const repoOr404 = req => {
    const repo = getGitRepos().find(r => r.id === req.params.id);
    if (!repo) throw ctx.error(404, 'repo_not_found');
    return repo;
  };

  // Branch, ahead/behind, modifiche, stash e merge in corso di un repository
  async function statusOf(repo) {
    const [branchR, { header, files }, stashR] = await Promise.all([
      gitExec(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }),
      getGitStatus(repo.path),
      gitExec(repo.path, ['stash', 'list'], { allowFail: true }),
    ]);

    const branch = branchR.out.trim();

    // Parse ahead/behind dal ## branch
    const aheadM   = header.match(/\[ahead (\d+)/);
    const behindM  = header.match(/behind (\d+)/);
    const ahead    = aheadM  ? parseInt(aheadM[1])  : 0;
    const behind   = behindM ? parseInt(behindM[1]) : 0;

    const stashCount = stashR.out.trim().split('\n').filter(Boolean).length;

    // Merge in corso e file in conflitto (entrambi modificati, aggiunti o cancellati da un lato)
    const merging = await mergeInProgress(repo.path);
    const conflicts = files.filter(f => CONFLICT_XY.has(f.xy)).map(f => f.name);

    return { branch, ahead, behind, files, stashCount, merging, conflicts };
  }

  return {
    // Per le altre estensioni (es. db-client per le migration)
    services: { repos: getGitRepos },

    // Strumenti MCP (sola lettura)
    mcp: {
      async repos() {
        const list = [];
        for (const repo of getGitRepos()) {
          try {
            const st = await statusOf(repo);
            list.push({ id: repo.id, label: repo.label, path: repo.path, branch: st.branch, ahead: st.ahead, behind: st.behind, changedFiles: st.files.length, merging: st.merging });
          } catch (e) { list.push({ id: repo.id, label: repo.label, path: repo.path, error: e.message }); }
        }
        return { repos: list };
      },
      async status({ repo }) {
        const r = getGitRepos().find(x => x.id === repo);
        if (!r) throw ctx.error(404, 'repo_not_found');
        return { repo: r.id, ...await statusOf(r) };
      },
      async log({ repo, limit = 30 }) {
        const r = getGitRepos().find(x => x.id === repo);
        if (!r) throw ctx.error(404, 'repo_not_found');
        const n = Math.min(Math.max(parseInt(limit) || 30, 1), 500);
        const SEP = '\x1f';
        const out = await gitExec(r.path, ['log', `--format=%h${SEP}%an${SEP}%aI${SEP}%D${SEP}%s`, `-${n + 1}`], { allowFail: true });
        const lines = out.out.split('\n').filter(Boolean);
        return {
          repo: r.id,
          commits: lines.slice(0, n).map(l => { const [hash, author, date, refs, subject] = l.split(SEP); return { hash, author, date, refs: refs ? refs.split(', ') : [], subject }; }),
          truncated: lines.length > n,
        };
      },
    },

    handlers: {
      // Lista repos (da progetti NPM che hanno .git)
      listRepos(req, res) {
        res.json(getGitRepos());
      },

      // Status: branch, ahead/behind, modifiche
      async status(req, res) {
        const repo = repoOr404(req);
        try { res.json(await statusOf(repo)); }
        catch (e) { throw ctx.error(500, 'command_failed', { output: e.message }); }
      },

      // Log per il grafo: commit di tutti i branch (--all) con parent e ref, più la mappa hash → branch
      async log(req, res) {
        const repo = repoOr404(req);
        const limit = Math.min(parseInt(req.query.limit) || 40, 2000);
        try {
          // Mappa hash-completo → [branch names] da tutti i ref (locali + remoti)
          const refMap = {}; // hash → [refname, ...]
          const localBranches = []; // per distinguere "feature/x" locale da "origin/x" remoto
          try {
            const refOut = await gitExec(repo.path, [
              'for-each-ref',
              '--format=%(objectname) %(refname) %(refname:short)',
              'refs/heads/', 'refs/remotes/',
            ], { allowFail: true });
            refOut.out.split('\n').filter(Boolean).forEach(line => {
              const [hash, full, name] = line.split(' ');
              if (!hash || !name || full.endsWith('/HEAD')) return; // origin/HEAD è solo un alias
              if (!refMap[hash]) refMap[hash] = [];
              refMap[hash].push(name);
              if (full.startsWith('refs/heads/')) localBranches.push(name);
            });
          } catch (_) {}

          const r = await gitExec(repo.path, [
            'log', '--all',
            `--pretty=format:%H%x01%h%x01%P%x01%s%x01%an%x01%aI%x01%d`,
            `-${limit}`,
          ], { allowFail: true });

          const rawLines = r.out.split('\n').filter(Boolean);
          const entries = rawLines.map(line => {
            const parts = line.split('\x01');
            const [hash, short, parents, subject, author, date, refs] = parts;
            // refs dal %d (branch tip nel range) + refs da for-each-ref (branch tip fuori range)
            const refsFromLog = refs ? refs.trim().replace(/[()]/g, '').split(', ').filter(Boolean) : [];
            const refsFromMap = (refMap[hash] || []).filter(n => !refsFromLog.some(r => r === n || r.endsWith(n)));
            return {
              hash,
              short,
              parents: parents ? parents.trim().split(' ').filter(Boolean) : [],
              subject,
              author,
              date, // ISO 8601: il frontend lo formatta nella lingua attiva
              refs: [...refsFromLog, ...refsFromMap],
            };
          });
          // Passa anche la mappa completa refs: il frontend la usa per nominare le lane
          // anche quando il tip del branch non è nei commit visualizzati
          res.json({ entries, refs: refMap, localBranches });
        } catch (e) {
          throw ctx.error(500, 'command_failed', { output: e.message });
        }
      },

      // Branch locali (upstream, ahead/behind, ultimo commit, già uniti in HEAD) e remoti
      async branches(req, res) {
        const repo = repoOr404(req);
        const SEP = '\x1f';
        const fmt = ['%(refname)', '%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)', '%(committerdate:iso-strict)', '%(subject)'].join(SEP);
        const [refs, current, merged] = await Promise.all([
          gitExec(repo.path, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads/', 'refs/remotes/'], { allowFail: true }),
          gitExec(repo.path, ['branch', '--show-current'], { allowFail: true }),
          gitExec(repo.path, ['branch', '--merged', 'HEAD', '--format=%(refname:short)'], { allowFail: true }),
        ]);
        const mergedSet = new Set(merged.out.split('\n').map(x => x.trim()).filter(Boolean));
        const local = [], remote = [];
        for (const line of refs.out.split('\n').filter(Boolean)) {
          const [full, name, upstream, track, hash, date, subject] = line.split(SEP);
          if (full.endsWith('/HEAD')) continue; // origin/HEAD è solo un alias
          const lastCommit = { hash, date, subject };
          if (full.startsWith('refs/heads/')) {
            const ahead = Number(/ahead (\d+)/.exec(track)?.[1] || 0);
            const behind = Number(/behind (\d+)/.exec(track)?.[1] || 0);
            local.push({ name, upstream: upstream || null, gone: track === '[gone]', ahead, behind, merged: mergedSet.has(name), lastCommit });
          } else {
            const slash = name.indexOf('/');
            remote.push({ name, remote: name.slice(0, slash), branch: name.slice(slash + 1), lastCommit });
          }
        }
        const localNames = new Set(local.map(b => b.name));
        for (const r of remote) r.hasLocal = localNames.has(r.branch);
        res.json({ current: current.out.trim() || null, detached: !current.out.trim(), local, remote });
      },

      // Anteprima del merge di un branch nel corrente: commit in arrivo, file, fast-forward
      async mergePreview(req, res) {
        const repo = repoOr404(req);
        const branch = String(req.query.branch || '');
        if (!isValidBranchName(branch) || (await gitExec(repo.path, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], { allowFail: true })).code !== 0) {
          throw ctx.error(400, 'branch_invalid', { branch });
        }
        const SEP = '\x1f';
        const [log, diff, ff, upToDate] = await Promise.all([
          gitExec(repo.path, ['log', `--format=%h${SEP}%s${SEP}%an${SEP}%aI`, '-200', `HEAD..${branch}`, '--'], { allowFail: true }),
          gitExec(repo.path, ['diff', '--name-status', `HEAD...${branch}`, '--'], { allowFail: true }),
          gitExec(repo.path, ['merge-base', '--is-ancestor', 'HEAD', branch], { allowFail: true }),
          gitExec(repo.path, ['merge-base', '--is-ancestor', branch, 'HEAD'], { allowFail: true }),
        ]);
        res.json({
          branch,
          commits: log.out.split('\n').filter(Boolean).map(l => { const [hash, subject, author, date] = l.split(SEP); return { hash, subject, author, date }; }),
          files: diff.out.split('\n').filter(Boolean).map(l => { const [status, ...rest] = l.split('\t'); return { status, name: rest.join(' → ') }; }),
          fastForward: ff.code === 0,
          upToDate: upToDate.code === 0,
          merging: await mergeInProgress(repo.path),
        });
      },

      // Messaggio completo di un commit (subject + body)
      async commitMessage(req, res) {
        const repo = repoOr404(req);
        if (!isValidCommitHash(req.params.hash)) throw ctx.error(400, 'hash_invalid');
        try {
          const r = await gitExec(repo.path, [
            'show', '--no-patch', '--format=%B', req.params.hash, '--',
          ], { allowFail: true });
          res.json({ body: r.out.trim() });
        } catch (e) {
          throw ctx.error(500, 'command_failed', { output: e.message });
        }
      },

      // Per il widget: ultimi commit del branch e commit non ancora su nessun remoto (quelli
      // che un push invierebbe), al massimo 50
      async summary(req, res) {
        const repo = repoOr404(req);
        const SEP = '\x1f';
        const fmtArgs = [`--format=%h${SEP}%an${SEP}%aI${SEP}%s`];
        const parse = out => out.split('\n').filter(Boolean).map(l => { const [hash, author, date, subject] = l.split(SEP); return { hash, author, date, subject }; });
        try {
          const [recent, outgoing] = await Promise.all([
            gitExec(repo.path, ['log', ...fmtArgs, '-5'], { allowFail: true }),
            gitExec(repo.path, ['log', ...fmtArgs, '-50', 'HEAD', '--not', '--remotes'], { allowFail: true }),
          ]);
          res.json({ recent: parse(recent.out), outgoing: parse(outgoing.out) });
        } catch (e) { throw ctx.error(500, 'command_failed', { output: e.message }); }
      },

      // Azione git (commit, pull, push, merge, fetch, checkout, stash) — output in streaming SSE.
      // Ogni azione è una sequenza di comandi git eseguiti uno dopo l'altro (runSteps).
      async action(req, res) {
        const repo = repoOr404(req);

        const { action, message, branch, remote = 'origin', files = [], startPoint, stash, mode } = req.body;
        if (action === 'merge' && mode != null && !['ff', 'no-ff', 'squash'].includes(mode)) throw ctx.error(400, 'merge_mode_invalid');

        // Validazione prima di aprire lo stream SSE, così l'errore arriva come JSON 400
        const invalid = await validateGitAction(repo.path, { action, branch, remote, message });
        if (invalid) throw invalid;

        // Merge: niente merge sopra un altro in corso; per concluderlo i conflitti vanno risolti
        let switchSteps = null;
        if (action === 'merge' && await mergeInProgress(repo.path)) {
          throw ctx.error(409, 'merging');
        }
        if (action === 'merge_abort' && !await mergeInProgress(repo.path)) throw ctx.error(409, 'no_merge');
        if (action === 'merge_continue') {
          if (!await mergeInProgress(repo.path)) throw ctx.error(409, 'no_merge');
          const left = await unresolvedConflicts(repo.path);
          if (left.length) throw ctx.error(409, 'conflicts', { count: left.length }, { files: left });
          const toAdd = (await getGitStatus(repo.path)).files.filter(f => CONFLICT_XY.has(f.xy)).map(f => f.name);
          switchSteps = [...(toAdd.length ? [{ args: ['add', '-A', '--', ...toAdd] }] : []), { args: ['commit', '--no-edit'] }];
        }

        // Eliminazione di un branch locale: mai quello corrente; se non è unito serve force
        if (action === 'branch_delete') {
          if (!await refExists(repo.path, `refs/heads/${branch}`)) throw ctx.error(404, 'local_not_found', { branch });
          const current = (await gitExec(repo.path, ['branch', '--show-current'], { allowFail: true })).out.trim();
          if (branch === current) throw ctx.error(409, 'current');
          const merged = (await gitExec(repo.path, ['merge-base', '--is-ancestor', branch, 'HEAD'], { allowFail: true })).code === 0;
          if (!merged && req.body.force !== true) {
            throw ctx.error(409, 'unmerged', { branch, current: current || 'HEAD' });
          }
          switchSteps = [{ args: ['branch', merged ? '-d' : '-D', branch] }];
        }

        // Cambio/creazione di branch: modifiche non committate, branch esistente o mancante
        if (action === 'checkout' || action === 'checkout_new') {
          const prepared = await prepareSwitch(repo.path, { action, branch, startPoint, stash: stash === true });
          if (prepared.error) throw prepared.error;
          switchSteps = prepared.steps;
        }

        // Una sola operazione git alla volta per repo: due push concorrenti si
        // contendono l'aggiornamento dei ref ("cannot lock ref ... but expected ...").
        // Il lock dura quanto i comandi, anche se il client si disconnette prima.
        if (busyRepos.has(repo.path)) throw ctx.error(409, 'busy');
        busyRepos.add(repo.path);

        const send = ctx.sse(res);
        try {
          let steps;
          if (action === 'commit') {
            // Solo file presenti in git status: un nome arbitrario potrebbe essere
            // un'opzione di git add o un path fuori dalle modifiche mostrate
            if (!Array.isArray(files)) { send('error', notice('files_invalid')); return; }
            const known = new Set((await getGitStatus(repo.path)).files.map(f => f.name));
            const unknown = files.filter(f => !known.has(f));
            if (unknown.length) { send('error', notice('files_unknown', { files: unknown.join(', ') })); return; }
            steps = [
              { args: files.length ? ['add', '-A', '--', ...files] : ['add', '-A'] },
              { args: ['commit', '-m', message || 'Update'] },
            ];
          } else {
            steps = switchSteps || ACTION_STEPS[action]({ remote, branch, mode });
          }
          send('exit', await runSteps(repo.path, steps, send));
        } finally {
          busyRepos.delete(repo.path);
          send.end();
        }
      },
    },
  };
};
