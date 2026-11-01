// Git: repository dei progetti, status con selezione dei file, commit,
// grafo dei commit con legenda dei branch e operazioni remote con output in streaming.

const AUTO_REFRESH_MS = 30000;

// Palette colori per le lane del grafo (ciclica)
const GRAPH_COLORS = ['#3fb950', '#388bfd', '#bc8cff', '#f0883e', '#58a6ff', '#56d364', '#d2a8ff', '#ffa657', '#79c0ff', '#f778ba'];

// Nome di branch più adatto tra i ref di un commit: niente tag né HEAD nudo,
// "HEAD -> x" diventa x, a parità preferisce il nome più corto (main su origin/main)
function bestBranchRef(refs) {
  const names = (refs || [])
    .filter(r => !r.startsWith('tag: ') && r !== 'HEAD' && !r.endsWith('/HEAD') && !r.startsWith('refs/')) // refs/stash non è un branch
    .map(r => r.replace(/^HEAD -> /, ''));
  return names.sort((a, b) => a.length - b.length)[0] || null;
}

// Branch unito da un merge commit, ricavato dal messaggio standard di git/GitHub/GitLab
function mergedBranchName(subject) {
  const patterns = [
    /^Merge (?:remote-tracking )?branch '([^']+)'/, // git merge
    /^Merge pull request #\d+ from [^/\s]+\/(\S+)/, // GitHub
    /^Merge branch "([^"]+)"/,
  ];
  for (const re of patterns) {
    const m = re.exec(subject || '');
    if (m) return m[1];
  }
  return null;
}

// Assegna ogni commit a una lane e disegna una riga SVG per commit.
// lanes[i] = hash del commit atteso in quella lane; laneNames[i] = branch che la percorre.
function buildGraph(entries, allRefs = {}) {
  const ROW_H = 26, COL_W = 16, R = 4, STROKE = 1.5;
  const laneColor = {}; // lane → indice nella palette
  let colorCounter = 0;
  const assignColor = lane => {
    if (laneColor[lane] === undefined) laneColor[lane] = colorCounter++ % GRAPH_COLORS.length;
  };
  const colorOf = lane => GRAPH_COLORS[laneColor[lane] ?? (lane % GRAPH_COLORS.length)];

  const lanes = [];
  const laneNames = [];

  const rows = entries.map(e => {
    const { hash, parents } = e;

    let myLane = lanes.indexOf(hash);
    if (myLane === -1) {
      // Nessuna lane lo aspettava: nuova lane (o slot libero riciclato)
      myLane = lanes.indexOf(null);
      if (myLane === -1) myLane = lanes.length;
      lanes[myLane] = hash;
      laneNames[myLane] = null; // il nome del branch precedente non vale più
    }

    // Un ref sul commit vince, altrimenti il nome si eredita dalla lane
    const name = bestBranchRef(e.refs) || laneNames[myLane] || null;
    assignColor(myLane);
    const myColor = colorOf(myLane);
    const lanesIn = [...lanes];

    // Il primo parent continua la lane (con il suo nome)
    lanes[myLane] = parents[0] || null;
    laneNames[myLane] = parents[0] ? name : null;

    // Parent aggiuntivi (merge): slot libero o nuova lane
    const mergedName = mergedBranchName(e.subject);
    for (let p = 1; p < parents.length; p++) {
      const parentHash = parents[p];
      if (!lanes.includes(parentHash)) {
        let free = lanes.indexOf(null);
        if (free !== -1) {
          lanes[free] = parentHash;
          laneColor[free] = colorCounter++ % GRAPH_COLORS.length; // slot riciclato: nuovo colore
        } else {
          free = lanes.length;
          assignColor(free);
          lanes.push(parentHash);
        }
        // Il ramo unito prende il nome dal messaggio di merge
        laneNames[free] = p === 1 ? mergedName : null;
      } else if (p === 1 && mergedName) {
        const idx = lanes.indexOf(parentHash);
        if (!laneNames[idx]) laneNames[idx] = mergedName;
      }
    }

    while (lanes.length && lanes[lanes.length - 1] === null) { lanes.pop(); laneNames.pop(); }

    const lanesOut = [...lanes];
    return { e, myLane, myColor, lanesIn, lanesOut, maxLanes: Math.max(lanesIn.length, lanesOut.length, myLane + 1), name };
  });

  // Stato delle lane dopo l'ultimo commit: hash dei parent attesi fuori dal range
  const finalLanes = [...lanes];
  const width = Math.min(rows.reduce((m, r) => Math.max(m, r.maxLanes), 1), 10) * COL_W + 8;
  const cx = lane => lane * COL_W + COL_W / 2 + 4;

  const svgs = rows.map(({ e, myLane, myColor, lanesIn, lanesOut }) => {
    const H = ROW_H, mid = H / 2, parts = [];

    // Lane che passano dritte
    for (const i of new Set([...lanesIn.keys(), ...lanesOut.keys()])) {
      if (i === myLane || !lanesIn[i] || lanesIn[i] !== lanesOut[i]) continue;
      parts.push(`<line x1="${cx(i)}" y1="0" x2="${cx(i)}" y2="${H}" stroke="${colorOf(i)}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
    }

    // Connettori verso i parent
    e.parents.forEach((ph, pi) => {
      const target = lanesOut.indexOf(ph);
      if (target === -1) return;
      const x1 = cx(myLane), y1 = mid + R + 1, x2 = cx(target), y2 = H;
      const color = pi === 0 ? myColor : colorOf(target);
      parts.push(x1 === x2
        ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`
        : `<path d="M${x1},${y1} C${x1},${y2} ${x2},${y1} ${x2},${y2}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
    });

    // Linea in entrata
    if (lanesIn[myLane] === e.hash) {
      parts.push(`<line x1="${cx(myLane)}" y1="0" x2="${cx(myLane)}" y2="${mid - R - 1}" stroke="${myColor}" stroke-width="${STROKE}" stroke-linecap="round"/>`);
    }

    // Nodo (HEAD con doppio cerchio)
    const nx = cx(myLane);
    if ((e.refs || []).some(r => r.startsWith('HEAD'))) {
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R + 1}" fill="${myColor}" stroke="${myColor}" stroke-width="${STROKE}"/>`);
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R - 1}" fill="var(--bg)"/>`);
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R - 3}" fill="${myColor}"/>`);
    } else {
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R}" fill="var(--bg)" stroke="${myColor}" stroke-width="${STROKE}"/>`);
      parts.push(`<circle cx="${nx}" cy="${mid}" r="${R - 2.5}" fill="${myColor}"/>`);
    }
    return `<svg width="${width}" height="${H}" viewBox="0 0 ${width} ${H}" class="git-graph-svg">${parts.join('')}</svg>`;
  });

  // Legenda: una voce per branch. Righe senza nome: hash atteso a fine range
  // (allRefs mappa i tip dei branch), poi "branch-N" come ultima risorsa.
  const legend = [];
  const seen = new Set();
  for (const { myLane, myColor, name } of rows) {
    let label = name;
    if (!label) {
      const names = finalLanes[myLane] && allRefs[finalLanes[myLane]];
      label = names ? bestBranchRef(names) : `branch-${myLane + 1}`;
    }
    if (seen.has(label)) continue;
    seen.add(label);
    legend.push({ color: myColor, label });
  }

  return { svgs, width, legend };
}

const XY_CLASS = { M: 'xy-M', A: 'xy-A', D: 'xy-D', R: 'xy-R', '?': 'xy-untracked' };

function xyLabel(xy) {
  const t = xy.trim();
  if (t === '??') return '?';
  return t[0] || '?';
}

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, output, fmt } = ctx.ui;
    const { t } = ctx;
    // Data relativa nella lingua attiva, con data completa nel title
    const when = iso => `<span title="${esc(fmt.date(iso))}">${esc(fmt.relative(iso))}</span>`;
    const $ = role => ctx.root.querySelector(`[data-role="${role}"]`);

    let repos = [];
    let folders = [];
    let hidden = 0; // progetti fuori da un repository, solo nel pannello 📁
    let activeRepo = null;
    let status = null;
    let selected = new Set();
    let logEntries = [];
    let timer = null;

    const repo = () => repos.find(r => r.id === activeRepo) || null;
    const repoUrl = (suffix = '') => `/repos/${encodeURIComponent(activeRepo)}${suffix}`;
    const remote = () => $('remote').value.trim() || 'origin';

    // ---- repository ----
    async function loadRepos() {
      try { repos = await ctx.api.get('/repos'); } catch { repos = []; }
      try { ({ folders, hidden } = await ctx.projects.load()); } catch { folders = []; hidden = 0; }
      ctx.setBadge(repos.length);
      if (activeRepo && !repo()) activeRepo = null;
      renderRepos();
    }

    function renderRepos() {
      const el = ctx.sidebar.querySelector('[data-role="repos"]');
      el.innerHTML = (!repos.length
        ? `<p class="git-muted git-pad">${esc(t('sidebar.none'))}<br><br>${esc(t('sidebar.noneHint'))}</p>`
        : ctx.projects.tree(folders, repos, r => `
          <div class="sb-item ${activeRepo === r.id ? 'active' : ''}" role="button" tabindex="0" onclick="Ext.git.select(${js(r.id)})"
               onkeydown="if(event.key==='Enter')Ext.git.select(${js(r.id)})">
            <span class="sb-icon">🌿</span>
            <span class="git-repo-name">${esc(r.label)}</span>
          </div>`)) + ctx.projects.hiddenNote(hidden);
    }

    function renderRepo() {
      const r = repo();
      $('empty').hidden = !!r;
      $('repo').hidden = !r;
      if (!r) return;
      renderHeader();
    }

    // ---- status ----
    async function loadStatus() {
      if (!activeRepo) return;
      try { status = await ctx.api.get(repoUrl('/status')); } catch { status = null; }
      renderHeader();
      renderFiles();
    }

    function renderHeader() {
      const r = repo();
      if (!r) return;
      ctx.ui.patch($('header'), `
        <h3>🌿 ${esc(r.label)}</h3>
        ${status ? `<button class="git-branch-badge git-branch-btn" data-action="branches" title="${esc(t('header.branchTitle'))}">⎇ ${esc(status.branch)} ▾</button>
          ${status.merging ? `<span class="git-sync-badge git-sync-merge">${esc(t('header.merging'))}</span>` : ''}
          ${status.ahead ? `<span class="git-sync-badge git-sync-ahead">${esc(t('header.ahead', { count: status.ahead }))}</span>` : ''}
          ${status.behind ? `<span class="git-sync-badge git-sync-behind">${esc(t('header.behind', { count: status.behind }))}</span>` : ''}
          ${status.stashCount ? `<span class="git-sync-badge git-sync-stash">${esc(t('header.stash', { count: status.stashCount }))}</span>` : ''}` : ''}
        <span class="git-path">${esc(r.path)}</span>`);
    }

    function renderMergeBanner() {
      let banner = ctx.root.querySelector('.git-merge-banner');
      if (!status?.merging) { banner?.remove(); return; }
      if (!banner) {
        banner = document.createElement('div');
        banner.className = 'git-merge-banner';
        $('files').before(banner);
      }
      banner.innerHTML = `
        <div class="git-merge-title">${esc(t('merge.banner'))} — ${esc(status.conflicts.length ? t('merge.conflicts', { count: status.conflicts.length }) : t('merge.resolved'))}</div>
        ${status.conflicts.length ? `<ul>${status.conflicts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
          <p class="git-muted">${esc(t('merge.hint'))}</p>` : ''}
        <div class="git-merge-actions">
          <button class="btn btn-ghost btn-sm" data-action="merge-abort">${esc(t('merge.abort'))}</button>
          <button class="btn btn-git btn-sm" data-action="merge-continue">${esc(t('merge.continue'))}</button>
        </div>`;
    }

    function renderFiles() {
      const el = $('files');
      const toggle = $('toggle-all');
      renderMergeBanner();
      const allLabel = t('files.all');
      if (!status) { ctx.ui.patch(el, `<div class="git-muted git-pad">${esc(t('files.noData'))}</div>`); toggle.textContent = `☐ ${allLabel}`; return; }
      if (!status.files.length) {
        ctx.ui.patch(el, `<div class="git-clean"><div class="git-clean-icon">✓</div>${esc(t('files.clean'))}</div>`);
        toggle.textContent = `☐ ${allLabel}`;
        return;
      }
      ctx.ui.patch(el, status.files.map(f => {
        const sel = selected.has(f.name);
        const parts = f.name.split('/');
        const label = xyLabel(f.xy);
        return `<div class="git-file ${sel ? 'selected' : ''}" onclick="Ext.git.toggleFile(${js(f.name)})" title="${esc(f.name)}">
          <span class="git-file-check">${sel ? '☑' : '☐'}</span>
          <span class="git-file-xy ${XY_CLASS[label] || ''}">${esc(label)}</span>
          <span class="git-file-name">${esc(parts[parts.length - 1])}</span>
          ${parts.length > 1 ? `<span class="git-file-dir">${esc(parts.slice(0, -1).join('/'))}/</span>` : ''}
        </div>`;
      }).join(''));
      toggle.textContent = `${status.files.every(f => selected.has(f.name)) ? '☑' : '☐'} ${allLabel}`;
    }

    // ---- log e grafo ----
    const refClass = ref => ref.startsWith('HEAD') ? 'git-ref-head'
      : ref.startsWith('tag:') ? 'git-ref-tag'
      : ref.includes('/') ? 'git-ref-remote' : 'git-ref-local';
    const refBadges = refs => (refs || []).map(ref => `<span class="git-ref ${refClass(ref)}">${esc(ref.replace('tag: ', ''))}</span>`).join('');

    async function loadLog() {
      const wrap = $('log');
      if (!activeRepo) return;
      // "caricamento" solo per un repository nuovo: l'aggiornamento automatico lascia la tabella
      if (wrap.dataset.repo !== activeRepo) ctx.ui.patch(wrap, `<div class="git-muted git-pad">${esc(t('log.loading'))}</div>`);
      wrap.dataset.repo = activeRepo;
      try {
        const data = await ctx.api.get(repoUrl(`/log?limit=${encodeURIComponent($('limit').value)}`));
        const entries = data.entries || [];
        const allRefs = data.refs || {};
        logEntries = entries;
        if (!entries.length) { ctx.ui.patch(wrap, `<div class="git-muted git-pad">${esc(t('log.none'))}</div>`); $('legend').hidden = true; return; }

        const { svgs, width, legend } = buildGraph(entries, allRefs);
        const local = new Set(data.localBranches || []);
        // Remoti = ref esistenti non locali (un branch unito e cancellato non è né l'uno né l'altro)
        const remoteRefs = new Set(Object.values(allRefs).flat().filter(n => !local.has(n)));

        const legendEl = $('legend');
        legendEl.hidden = !legend.length;
        legendEl.innerHTML = legend.map(({ color, label }) => {
          const anon = /^branch-\d+$/.test(label);
          const icon = anon ? '●' : label === status?.branch ? '◉' : remoteRefs.has(label) ? '↗' : '⎇';
          return `<span class="git-legend-item ${anon ? 'anon' : ''}" style="--lane:${color}">${icon} ${esc(label)}</span>`;
        }).join('');

        ctx.ui.patch(wrap, `<table class="git-log-table" style="--graph-w:${width}px">
          <colgroup><col class="col-graph"><col class="col-hash"><col class="col-msg"><col class="col-author"><col class="col-date"></colgroup>
          <thead><tr><th></th><th>${esc(t('log.sha'))}</th><th>${esc(t('log.message'))}</th><th>${esc(t('log.author'))}</th><th>${esc(t('log.date'))}</th></tr></thead>
          <tbody>${entries.map((e, i) => `
            <tr class="git-log-row" onclick="Ext.git.showCommit(${i})">
              <td class="git-graph-cell">${svgs[i]}</td>
              <td><span class="git-hash" title="${esc(e.hash)}">${esc(e.short)}</span></td>
              <td class="git-msg-cell"><span class="git-subject">${refBadges(e.refs)}${esc(e.subject)}</span></td>
              <td class="git-author">${esc(e.author)}</td>
              <td class="git-date">${when(e.date)}</td>
            </tr>`).join('')}</tbody>
        </table>`);
      } catch (e) {
        wrap.innerHTML = `<div class="git-error git-pad">${esc(t('log.error', { error: e.message }))}</div>`;
      }
    }

    function showCommit(idx) {
      const e = logEntries[idx];
      if (!e) return;
      ctx.root.querySelectorAll('.git-log-row').forEach((r, i) => r.classList.toggle('git-row-active', i === idx));
      ctx.root.querySelector('.git-commit-drawer')?.remove();
      const drawer = document.createElement('div');
      drawer.className = 'git-commit-drawer';
      drawer.innerHTML = `
        <div class="git-drawer-main">
          <div class="git-drawer-subject">${refBadges(e.refs)}${esc(e.subject)}</div>
          <div class="git-drawer-body" data-role="commit-body"></div>
          <div class="git-drawer-meta">
            <span>👤 ${esc(e.author)}</span>
            <span>🕐 ${when(e.date)}</span>
            <span class="git-mono">${esc(t('drawer.sha'))} <span class="git-hash" onclick="navigator.clipboard&&navigator.clipboard.writeText(${js(e.hash)})" title="${esc(t('drawer.copy'))}">${esc(e.hash)}</span></span>
            ${e.parents?.length ? `<span class="git-mono">${esc(t('drawer.parent'))} ${e.parents.map(p => `<span class="git-hash">${esc(p.slice(0, 7))}</span>`).join(' ')}</span>` : ''}
          </div>
        </div>
        <button class="git-drawer-close" title="${esc(t('core.action.close'))}" onclick="this.closest('.git-commit-drawer').remove()">✕</button>`;
      ctx.root.querySelector('.git-log-col').appendChild(drawer);

      // Corpo completo del commit (git show restituisce subject + riga vuota + body)
      ctx.api.get(repoUrl(`/commit/${encodeURIComponent(e.hash)}`)).then(data => {
        const lines = (data.body || '').split('\n');
        let start = 1;
        while (start < lines.length && !lines[start].trim()) start++;
        const body = lines.slice(start).join('\n').trimEnd();
        const el = drawer.querySelector('[data-role="commit-body"]');
        if (el && body) el.textContent = body;
      }).catch(() => {});
    }

    // ---- azioni git con output in streaming ----
    // onRefused(err): il server ha rifiutato prima di eseguire (err.code, err.message tradotto, err.data)
    async function run(body, title, onRefused) {
      if (title) output.open(title);
      let exit = 1;
      try {
        exit = await ctx.api.stream(repoUrl('/action'), body, ({ type, data }) => {
          if (type === 'stdout') output.append(data, 'out');
          else if (type === 'stderr') output.append(data, 'err');
          else if (type === 'error') output.append(`\n${t('run.error', { error: ctx.ui.errorText(data) })}\n`, 'err');
          else if (type === 'notice') output.append(`${ctx.ui.errorText(data)}\n`, 'sys');
          else if (type === 'exit') output.append(`\n[exit ${data}]`, 'sys');
        });
      } catch (e) {
        if (onRefused && e.code) { output.close(); onRefused(e); return 'refused'; }
        output.append(`\n${t('run.error', { error: e.message })}\n`, 'err');
      }
      setTimeout(reload, 400); // status e log aggiornati dopo ogni operazione
      return exit ?? 1;
    }

    async function gitAction(action) {
      if (action === 'push' || action === 'pull_push') await loadStatus(); // branch aggiornato
      run({ action, remote: remote(), branch: status?.branch }, `git ${action} (${remote()})`);
    }

    async function commit(andPush) {
      const msgEl = $('message');
      const message = msgEl.value.trim();
      if (!message) { toast(t('commit.required'), 'error'); return; }
      const branch = status?.branch;
      output.open(andPush ? 'git commit & push' : 'git commit');
      const exit = await run({ action: 'commit', message, files: [...selected], remote: remote(), branch });
      if (andPush) {
        if (exit !== 0) output.append(`\n${t('commit.pushSkipped')}\n`, 'sys');
        else { output.append(`\n$ git push ${remote()} ${branch || ''}\n`, 'sys'); await run({ action: 'push', remote: remote(), branch }); }
      }
      msgEl.value = '';
      selected.clear();
    }

    // ---- branch: elenco, cambio, creazione, merge, eliminazione ----
    let branchData = null;
    const loadBranches = async () => (branchData = await ctx.api.get(repoUrl('/branches')));

    // Cambio di branch; con modifiche non committate propone lo stash
    async function switchTo(branch, stash = false) {
      closeBranchPop();
      await run({ action: 'checkout', branch, stash }, `git checkout ${branch}`, err => {
        if (err.code === 'git.dirty') dirtyDialog(err.data.files, t('dirty.switch', { branch }), () => switchTo(branch, true));
        else toast(err.message, 'error');
      });
    }

    function dirtyDialog(files, what, onStash) {
      openModal(t('dirty.title'), `
        <p>${esc(t('dirty.text', { count: files.length, what }))}</p>
        <ul class="git-file-ul">${files.slice(0, 30).map(f => `<li>${esc(f)}</li>`).join('')}${files.length > 30 ? `<li>${esc(t('dirty.more', { count: files.length - 30 }))}</li>` : ''}</ul>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-git" onclick="Ext.git.confirmStash()">${esc(t('dirty.stash'))}</button>`);
      pendingStash = onStash;
    }
    let pendingStash = null;

    async function newBranchDialog(startPoint = '') {
      closeBranchPop();
      const b = branchData || await loadBranches();
      const opt = (v, label) => `<option value="${esc(v)}" ${v === startPoint ? 'selected' : ''}>${esc(label)}</option>`;
      openModal(t('newBranch.title'), `
        <div class="form-row"><label>${esc(t('newBranch.name'))}</label><input class="form-input" id="f_new_branch" placeholder="${esc(t('newBranch.placeholder'))}"></div>
        <div class="form-row"><label>${esc(t('newBranch.from'))}</label><select class="form-input" id="f_new_start">
          ${opt('', t('newBranch.current', { branch: b.current || 'HEAD' }))}
          ${b.local.map(x => opt(x.name, x.name)).join('')}
          ${b.remote.map(x => opt(x.name, x.name)).join('')}
        </select></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button><button class="btn btn-git" onclick="Ext.git.createBranch()">${esc(t('newBranch.create'))}</button>`);
      setTimeout(() => document.getElementById('f_new_branch')?.focus(), 0);
    }

    async function createBranch(name, startPoint, stash = false) {
      await run({ action: 'checkout_new', branch: name, startPoint: startPoint || undefined, stash }, `git checkout -b ${name}`, err => {
        if (err.code === 'git.dirty') dirtyDialog(err.data.files, t('dirty.create', { branch: name, start: startPoint }), () => createBranch(name, startPoint, true));
        else toast(err.message, 'error');
      });
    }

    // Merge: scelta del branch, anteprima dei commit e dei file, modalità
    async function mergeDialog(preselect = '') {
      closeBranchPop();
      const b = await loadBranches();
      const choices = [...b.local.filter(x => x.name !== b.current).map(x => x.name), ...b.remote.map(x => x.name)];
      if (!choices.length) { toast(t('mergeDialog.nothing'), 'info'); return; }
      openModal(t('mergeDialog.title', { branch: b.current || 'HEAD' }), `
        <div class="form-row"><label>${esc(t('mergeDialog.branch'))}</label><select class="form-input" id="f_merge_branch" onchange="Ext.git.previewMerge(this.value)">
          ${choices.map(n => `<option ${n === preselect ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
        <div id="f_merge_preview" class="git-merge-preview"><span class="git-muted">${esc(t('mergeDialog.loading'))}</span></div>
        <div class="form-row"><label>${esc(t('mergeDialog.mode'))}</label>
          <label class="git-radio"><input type="radio" name="f_merge_mode" value="ff" checked> ${esc(t('mergeDialog.ff'))}</label>
          <label class="git-radio"><input type="radio" name="f_merge_mode" value="no-ff"> ${esc(t('mergeDialog.noff'))}</label>
          <label class="git-radio"><input type="radio" name="f_merge_mode" value="squash"> ${esc(t('mergeDialog.squash'))}</label>
        </div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button><button class="btn btn-git" onclick="Ext.git.doMerge()">${esc(t('mergeDialog.submit'))}</button>`);
      previewMerge(document.getElementById('f_merge_branch').value);
    }

    async function previewMerge(branch) {
      const el = document.getElementById('f_merge_preview');
      if (!el) return;
      el.innerHTML = `<span class="git-muted">${esc(t('mergeDialog.loading'))}</span>`;
      try {
        const p = await ctx.api.get(repoUrl(`/merge-preview?branch=${encodeURIComponent(branch)}`));
        if (document.getElementById('f_merge_branch')?.value !== branch) return;
        el.innerHTML = p.upToDate || !p.commits.length
          ? `<span class="git-muted">${esc(t('mergeDialog.upToDate'))}</span>`
          : `<div class="git-muted">${esc([t('mergeDialog.incoming', { count: p.commits.length }), ...(p.fastForward ? [t('mergeDialog.ffPossible')] : []), t('mergeDialog.files', { count: p.files.length })].join(' · '))}</div>
             <ul class="git-merge-commits">${p.commits.slice(0, 15).map(c => `<li><span class="git-hash">${esc(c.hash)}</span> ${esc(c.subject)} <span class="git-muted">— ${esc(c.author)}, ${when(c.date)}</span></li>`).join('')}
               ${p.commits.length > 15 ? `<li class="git-muted">${esc(t('dirty.more', { count: p.commits.length - 15 }))}</li>` : ''}</ul>
             <ul class="git-merge-files">${p.files.slice(0, 20).map(f => `<li><span class="git-file-xy xy-${esc(f.status[0])}">${esc(f.status[0])}</span> ${esc(f.name)}</li>`).join('')}
               ${p.files.length > 20 ? `<li class="git-muted">${esc(t('dirty.more', { count: p.files.length - 20 }))}</li>` : ''}</ul>`;
      } catch (e) { el.innerHTML = `<span class="git-error">${esc(e.message)}</span>`; }
    }

    async function deleteBranch(name, force = false) {
      closeBranchPop();
      if (!force && !confirm(t('delete.confirm', { name }))) return;
      await run({ action: 'branch_delete', branch: name, force }, `git branch -d ${name}`, err => {
        if (err.code === 'git.unmerged') {
          if (confirm(t('delete.unmerged', { error: err.message }))) deleteBranch(name, true);
        } else toast(err.message, 'error');
      });
    }

    // Pannello dei branch sotto il badge
    let branchPop = null;
    function closeBranchPop() { branchPop?.remove(); branchPop = null; }
    async function openBranchPop(anchor) {
      if (branchPop?.isConnected) { closeBranchPop(); return; }
      closeBranchPop();
      let b;
      try { b = await loadBranches(); } catch (e) { toast(e.message, 'error'); return; }
      branchPop = document.createElement('div');
      branchPop.className = 'git-branch-pop';
      const r = anchor.getBoundingClientRect();
      document.body.appendChild(branchPop);
      // sotto il badge, senza uscire dalla finestra
      branchPop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - branchPop.offsetWidth - 8))}px`;
      branchPop.style.top = `${r.bottom + 4}px`;
      const render = filter => {
        const f = filter.toLowerCase();
        const local = b.local.filter(x => x.name.toLowerCase().includes(f));
        const remote = b.remote.filter(x => x.name.toLowerCase().includes(f));
        branchPop.querySelector('.git-pop-list').innerHTML = `
          <div class="git-pop-section">${esc(t('pop.local'))}</div>
          ${local.map(x => `<div class="git-pop-item ${x.name === b.current ? 'current' : ''}" data-switch="${esc(x.name)}" title="${esc(x.lastCommit.subject)} — ${esc(fmt.relative(x.lastCommit.date))}">
            <span class="git-pop-name">${x.name === b.current ? '● ' : ''}${esc(x.name)}</span>
            <span class="git-pop-meta">${x.ahead ? `↑${fmt.number(x.ahead)} ` : ''}${x.behind ? `↓${fmt.number(x.behind)} ` : ''}${x.gone ? esc(t('pop.gone')) + ' ' : ''}${x.merged && x.name !== b.current ? esc(t('pop.merged')) : ''}</span>
            ${x.name !== b.current ? `<button data-merge="${esc(x.name)}" title="${esc(t('pop.mergeInto', { branch: b.current || 'HEAD' }))}">⑃</button><button data-delete="${esc(x.name)}" title="${esc(t('pop.delete'))}">🗑</button>` : ''}
          </div>`).join('') || `<div class="git-pop-empty">${esc(t('pop.none'))}</div>`}
          <div class="git-pop-section">${esc(t('pop.remote'))}</div>
          ${remote.map(x => `<div class="git-pop-item" data-switch="${esc(x.name)}" title="${esc(t(x.hasLocal ? 'pop.switchLocal' : 'pop.createLocal'))} — ${esc(x.lastCommit.subject)}">
            <span class="git-pop-name">${esc(x.name)}</span><span class="git-pop-meta">${x.hasLocal ? esc(t('pop.hasLocal')) : ''}</span>
            <button data-merge="${esc(x.name)}" title="${esc(t('pop.mergeInto', { branch: b.current || 'HEAD' }))}">⑃</button></div>`).join('') || `<div class="git-pop-empty">${esc(t('pop.none'))}</div>`}`;
      };
      branchPop.innerHTML = `<input class="form-input git-pop-search" placeholder="${esc(t('pop.search'))}">
        <div class="git-pop-list"></div>
        <button class="git-pop-new" data-new>${esc(t('pop.new'))}</button>`;
      render('');
      const search = branchPop.querySelector('input');
      search.addEventListener('input', () => render(search.value));
      search.focus();
      branchPop.addEventListener('click', e => {
        const el = e.target;
        if (el.closest('[data-new]')) return newBranchDialog();
        if (el.dataset.merge) return mergeDialog(el.dataset.merge);
        if (el.dataset.delete) return deleteBranch(el.dataset.delete);
        const item = el.closest('[data-switch]');
        if (item && item.dataset.switch !== b.current) switchTo(item.dataset.switch);
      });
    }
    document.addEventListener('mousedown', e => {
      if (branchPop && !branchPop.contains(e.target) && !e.target.closest('[data-action="branches"]')) closeBranchPop();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBranchPop(); });

    async function reload() {
      await loadStatus();
      await loadLog();
    }

    // ---- collegamenti ----
    const actions = {
      async select(id) {
        activeRepo = id;
        status = null;
        selected = new Set();
        ctx.root.querySelector('.git-commit-drawer')?.remove(); // dettaglio del repo precedente
        renderRepos();
        renderRepo();
        await reload();
      },
      toggleFile(name) {
        if (selected.has(name)) selected.delete(name); else selected.add(name);
        renderFiles();
      },
      showCommit,
      previewMerge,
      doMerge() {
        const branch = document.getElementById('f_merge_branch')?.value;
        const mode = document.querySelector('input[name="f_merge_mode"]:checked')?.value || 'ff';
        if (!branch) return;
        closeModal();
        run({ action: 'merge', branch, mode }, `git merge${mode === 'ff' ? '' : ` --${mode}`} ${branch}`, err => toast(err.message, 'error'));
      },
      createBranch() {
        const name = (document.getElementById('f_new_branch')?.value || '').trim();
        const start = document.getElementById('f_new_start')?.value || '';
        if (!name) { toast(t('newBranch.nameRequired'), 'error'); return; }
        closeModal();
        createBranch(name, start);
      },
      confirmStash() {
        const go = pendingStash;
        pendingStash = null;
        closeModal();
        go?.();
      },
    };

    ctx.root.addEventListener('click', e => {
      const git = e.target.closest('[data-git]')?.dataset.git;
      if (git) return gitAction(git);
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'reload') reload();
      else if (a === 'merge') mergeDialog();
      else if (a === 'branches') openBranchPop(e.target.closest('[data-action]'));
      else if (a === 'merge-abort') { if (confirm(t('merge.confirmAbort'))) run({ action: 'merge_abort' }, 'git merge --abort'); }
      else if (a === 'merge-continue') run({ action: 'merge_continue' }, 'git commit (merge)', err => {
        if (err.code === 'git.conflicts') toast(t('merge.stillConflicts', { files: fmt.list(err.data.files) }), 'error');
        else toast(err.message, 'error');
      });
      else if (a === 'commit') commit(false);
      else if (a === 'commit-push') commit(true);
      else if (a === 'toggle-all' && status) {
        if (status.files.every(f => selected.has(f.name))) selected.clear();
        else status.files.forEach(f => selected.add(f.name));
        renderFiles();
      }
    });
    $('limit').addEventListener('change', loadLog);
    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="reload-repos"]')) this.refresh();
      if (e.target.closest('[data-action="manage-projects"]')) ctx.projects.openPanel();
    });
    // progetti e cartelle cambiati (da qui o da un'altra sezione)
    ctx.bus.on('core:projects-changed', loadRepos);

    ctx.expose(actions);
    await loadRepos();
    renderRepo();

    this.show = async () => {
      await loadRepos();
      renderRepo();
      if (activeRepo) reload();
      clearInterval(timer);
      timer = setInterval(() => { if (activeRepo) reload(); }, AUTO_REFRESH_MS);
    };
    this.hide = () => { clearInterval(timer); timer = null; closeBranchPop(); };
    this.refresh = async () => { await loadRepos(); renderRepo(); if (activeRepo) await reload(); };
    // aperta da un widget o dalla dashboard: { project } sceglie il repository del progetto
    this.focus = async params => {
      if (!params?.project) return;
      await loadRepos();
      const p = ctx.projects && (await ctx.projects.load()).projects.find(x => x.id === params.project);
      const r = repos.find(x => x.id === params.project) || (p && repos.find(x => p.path === x.path || p.path.startsWith(x.path + '/')));
      if (r && r.id !== activeRepo) await actions.select(r.id);
    };
    this.languageChanged = () => { closeBranchPop(); renderRepos(); renderHeader(); renderFiles(); if (activeRepo) loadLog(); };
  },
};
