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

// ---- diff: patch unificata di git → blocchi di righe ----
// [{ oldStart, newStart, header, lines: [{ t: ' ' | '-' | '+', s }] }]
function parsePatch(patch) {
  const hunks = [];
  let h = null;
  for (const line of String(patch || '').split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/.exec(line);
    if (m) { h = { oldStart: Number(m[1]), newStart: Number(m[2]), header: m[3], lines: [], raw: [] }; hunks.push(h); continue; }
    if (!h || line === '') continue;
    h.raw.push(line); // testo del blocco così com'è: il server lo confronta prima di toccare il file
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line[0] === ' ' || line[0] === '-' || line[0] === '+') h.lines.push({ t: line[0], s: line.slice(1) });
  }
  return hunks;
}

// Righe affiancate: le righe tolte e aggiunte consecutive vanno sulla stessa riga
// [{ kind: 'hunk', header } | { kind: 'same'|'change', o: { n, s }|null, n: { n, s }|null, start? }]
// start: { hunk, block } sulla prima riga di ogni modifica (righe cambiate fra due righe uguali)
function sideBySide(hunks) {
  const rows = [];
  hunks.forEach((h, hi) => {
    rows.push({ kind: 'hunk', header: h.header, oldStart: h.oldStart, newStart: h.newStart });
    let on = h.oldStart, nn = h.newStart, i = 0, block = -1, inBlock = false;
    while (i < h.lines.length) {
      const l = h.lines[i];
      if (l.t === ' ') { inBlock = false; rows.push({ kind: 'same', o: { n: on++, s: l.s }, n: { n: nn++, s: l.s } }); i++; continue; }
      const first = !inBlock;
      if (first) { block++; inBlock = true; }
      const del = [], add = [];
      while (i < h.lines.length && h.lines[i].t === '-') del.push(h.lines[i++].s);
      while (i < h.lines.length && h.lines[i].t === '+') add.push(h.lines[i++].s);
      for (let k = 0; k < Math.max(del.length, add.length); k++) {
        rows.push({ kind: 'change', o: k < del.length ? { n: on++, s: del[k] } : null, n: k < add.length ? { n: nn++, s: add[k] } : null,
          ...(first && k === 0 ? { start: { hunk: hi, block } } : {}) });
      }
    }
  });
  return rows;
}

// Parte cambiata di una riga rispetto all'altra (prefisso e suffisso comuni tolti)
function changedRange(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [p, a.length - s];
}

// ---- merge: testo con i marcatori di conflitto → parti comuni e conflitti ----
// [{ type: 'common', lines } | { type: 'conflict', ours, base, theirs, raw }]; eol: '\r\n' o '\n'
function parseConflicts(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const parts = [];
  let common = [], c = null, where = null;
  for (const line of lines) {
    if (!c && /^<{7}( |$)/.test(line)) { if (common.length) parts.push({ type: 'common', lines: common }); common = []; c = { type: 'conflict', ours: [], base: null, theirs: [], raw: [line] }; where = 'ours'; continue; }
    if (c) {
      c.raw.push(line);
      if (where === 'ours' && /^\|{7}( |$)/.test(line)) { c.base = []; where = 'base'; continue; }
      if ((where === 'ours' || where === 'base') && /^={7}$/.test(line)) { where = 'theirs'; continue; }
      if (where === 'theirs' && /^>{7}( |$)/.test(line)) { parts.push(c); c = null; where = null; continue; }
      c[where].push(line);
      continue;
    }
    common.push(line);
  }
  if (c) common = [...c.raw, ...common]; // conflitto non chiuso: resta com'è
  if (common.length) parts.push({ type: 'common', lines: common });
  return { parts, eol };
}

// Testo risultante: per ogni conflitto la scelta (ours, theirs, ours-theirs, theirs-ours, none),
// o i marcatori originali se non è ancora scelto
function mergeResult({ parts, eol }, choices) {
  const out = [];
  let k = 0;
  for (const p of parts) {
    if (p.type === 'common') { out.push(...p.lines); continue; }
    const ch = choices[k++];
    if (ch === 'ours') out.push(...p.ours);
    else if (ch === 'theirs') out.push(...p.theirs);
    else if (ch === 'ours-theirs') out.push(...p.ours, ...p.theirs);
    else if (ch === 'theirs-ours') out.push(...p.theirs, ...p.ours);
    else if (ch === 'none') { /* nessuna delle due */ }
    else out.push(...p.raw);
  }
  return out.join(eol);
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
            <span class="sb-icon"><i data-icon="git-branch"></i></span>
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
        <h3><i data-icon="git-branch"></i> ${esc(r.label)}</h3>
        ${status ? `<button class="git-branch-badge git-branch-btn" data-action="branches" title="${esc(t('header.branchTitle'))}"><i data-icon="git-branch"></i> ${esc(status.branch)} ${ctx.ui.icon('chevron-down')}</button>
          ${status.merging ? `<span class="git-sync-badge git-sync-merge">${esc(t('header.merging'))}</span>` : ''}
          ${status.ahead ? `<span class="git-sync-badge git-sync-ahead">${ctx.ui.icon('arrow-up')} ${esc(t('header.ahead', { count: status.ahead }))}</span>` : ''}
          ${status.behind ? `<span class="git-sync-badge git-sync-behind">${ctx.ui.icon('arrow-down')} ${esc(t('header.behind', { count: status.behind }))}</span>` : ''}
          ${status.stashCount ? `<span class="git-sync-badge git-sync-stash">${ctx.ui.icon('archive')} ${esc(t('header.stash', { count: status.stashCount }))}</span>` : ''}` : ''}
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
        ${status.conflicts.length ? `<ul>${status.conflicts.map(f => `<li>${esc(f)} <button class="btn btn-ghost btn-sm" onclick="Ext.git.resolve(${js(f)})">${ctx.ui.icon('git-merge')} ${esc(t('mergeEditor.open'))}</button></li>`).join('')}</ul>
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
      if (!status) { ctx.ui.patch(el, `<div class="git-muted git-pad">${esc(t('files.noData'))}</div>`); toggle.innerHTML = `${ctx.ui.icon('square')} ${esc(allLabel)}`; return; }
      if (!status.files.length) {
        ctx.ui.patch(el, `<div class="git-clean"><div class="git-clean-icon"><i data-icon="check"></i></div>${esc(t('files.clean'))}</div>`);
        toggle.innerHTML = `${ctx.ui.icon('square')} ${esc(allLabel)}`;
        return;
      }
      ctx.ui.patch(el, status.files.map(f => {
        const sel = selected.has(f.name);
        // cartella non tracciata intera (git status la mostra come "dir/"): niente diff
        const isDir = f.name.endsWith('/');
        const parts = (isDir ? f.name.slice(0, -1) : f.name).split('/');
        const label = xyLabel(f.xy);
        return `<div class="git-file ${sel ? 'selected' : ''}" onclick="Ext.git.toggleFile(${js(f.name)})" title="${esc(f.name)}">
          <span class="git-file-check">${ctx.ui.icon(sel ? 'square-check' : 'square')}</span>
          <span class="git-file-xy ${XY_CLASS[label] || ''}">${esc(label)}</span>
          <span class="git-file-name">${isDir ? `${ctx.ui.icon('folder')} ` : ''}${esc(parts[parts.length - 1])}${isDir ? '/' : ''}</span>
          ${parts.length > 1 ? `<span class="git-file-dir">${esc(parts.slice(0, -1).join('/'))}/</span>` : ''}
          ${status.conflicts.includes(f.name)
            ? `<button class="git-file-act git-file-resolve" onclick="event.stopPropagation();Ext.git.resolve(${js(f.name)})" title="${esc(t('mergeEditor.open'))}">${ctx.ui.icon('git-merge')} ${esc(t('mergeEditor.short'))}</button>`
            : isDir ? '' : `<button class="git-file-act" onclick="event.stopPropagation();Ext.git.diff(${js(f.name)})" title="${esc(t('diff.open'))}">±</button>`}
        </div>`;
      }).join(''));
      toggle.innerHTML = `${ctx.ui.icon(status.files.every(f => selected.has(f.name)) ? 'square-check' : 'square')} ${esc(allLabel)}`;
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
          const icon = ctx.ui.icon(anon ? 'circle-small' : label === status?.branch ? 'circle-dot' : remoteRefs.has(label) ? 'cloud' : 'git-branch');
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
            <span><i data-icon="user"></i> ${esc(e.author)}</span>
            <span>${ctx.ui.icon('clock')} ${when(e.date)}</span>
            <span class="git-mono">${esc(t('drawer.sha'))} <span class="git-hash" onclick="navigator.clipboard&&navigator.clipboard.writeText(${js(e.hash)})" title="${esc(t('drawer.copy'))}">${esc(e.hash)}</span></span>
            ${e.parents?.length ? `<span class="git-mono">${esc(t('drawer.parent'))} ${e.parents.map(p => `<span class="git-hash">${esc(p.slice(0, 7))}</span>`).join(' ')}</span>` : ''}
          </div>
        </div>
        <button class="git-drawer-close" title="${esc(t('core.action.close'))}" onclick="this.closest('.git-commit-drawer').remove()"><i data-icon="x"></i></button>`;
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
            <span class="git-pop-name">${x.name === b.current ? `${ctx.ui.icon('circle-dot')} ` : ''}${esc(x.name)}</span>
            <span class="git-pop-meta">${x.ahead ? `${ctx.ui.icon('arrow-up')}${fmt.number(x.ahead)} ` : ''}${x.behind ? `${ctx.ui.icon('arrow-down')}${fmt.number(x.behind)} ` : ''}${x.gone ? esc(t('pop.gone')) + ' ' : ''}${x.merged && x.name !== b.current ? esc(t('pop.merged')) : ''}</span>
            ${x.name !== b.current ? `<button data-merge="${esc(x.name)}" title="${esc(t('pop.mergeInto', { branch: b.current || 'HEAD' }))}"><i data-icon="git-merge"></i></button><button data-delete="${esc(x.name)}" title="${esc(t('pop.delete'))}"><i data-icon="trash-2"></i></button>` : ''}
          </div>`).join('') || `<div class="git-pop-empty">${esc(t('pop.none'))}</div>`}
          <div class="git-pop-section">${esc(t('pop.remote'))}</div>
          ${remote.map(x => `<div class="git-pop-item" data-switch="${esc(x.name)}" title="${esc(t(x.hasLocal ? 'pop.switchLocal' : 'pop.createLocal'))} — ${esc(x.lastCommit.subject)}">
            <span class="git-pop-name">${esc(x.name)}</span><span class="git-pop-meta">${x.hasLocal ? esc(t('pop.hasLocal')) : ''}</span>
            <button data-merge="${esc(x.name)}" title="${esc(t('pop.mergeInto', { branch: b.current || 'HEAD' }))}"><i data-icon="git-merge"></i></button></div>`).join('') || `<div class="git-pop-empty">${esc(t('pop.none'))}</div>`}`;
      };
      branchPop.innerHTML = `<input class="form-input git-pop-search" placeholder="${esc(t('pop.search'))}">
        <div class="git-pop-list"></div>
        <button class="git-pop-new" data-new>${ctx.ui.icon('plus')} ${esc(t('pop.new'))}</button>`;
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

    // ---- diff di un file rispetto all'ultimo commit ----
    let diffView = null; // { file, mode: 'split'|'unified', all, data }
    const DIFF_MODE_KEY = 'kelbo.git.diffMode';
    async function openDiff(file) {
      let mode = 'split';
      try { mode = localStorage.getItem(DIFF_MODE_KEY) === 'unified' ? 'unified' : 'split'; } catch { /* predefinito */ }
      diffView = { file, mode, all: diffView?.all || false, data: null };
      await loadDiff();
    }
    // Dopo un ripristino: status di nuovo; il file ha ancora modifiche → diff aggiornato, altrimenti
    // il file modificato successivo (o la finestra si chiude)
    async function afterRevert(scroll) {
      const v = diffView;
      const before = (status?.files || []).filter(f => !status.conflicts.includes(f.name) && !f.name.endsWith('/')).map(f => f.name);
      await loadStatus();
      const files = (status?.files || []).filter(f => !status.conflicts.includes(f.name) && !f.name.endsWith('/')).map(f => f.name);
      if (files.includes(v.file)) {
        await loadDiff();
        const wrap = document.querySelector('.git-diff-wrap');
        if (wrap && scroll != null) wrap.scrollTop = scroll;
        return;
      }
      const next = before.slice(before.indexOf(v.file) + 1).find(f => files.includes(f)) || files[0];
      if (next) openDiff(next);
      else { diffView = null; closeModal(); }
    }

    async function loadDiff() {
      const v = diffView;
      if (!v) return;
      try { v.data = await ctx.api.get(repoUrl(`/diff?file=${encodeURIComponent(v.file)}${v.all ? '&context=all' : ''}`)); }
      catch (e) { toast(e.message, 'error'); return; }
      if (diffView === v) renderDiff();
    }
    function renderDiff() {
      const v = diffView;
      const d = v.data;
      const files = (status?.files || []).filter(f => !status.conflicts.includes(f.name) && !f.name.endsWith('/')).map(f => f.name);
      const at = files.indexOf(v.file);
      const hunks = parsePatch(d.patch);
      const plus = hunks.reduce((n, h) => n + h.lines.filter(l => l.t === '+').length, 0);
      const minus = hunks.reduce((n, h) => n + h.lines.filter(l => l.t === '-').length, 0);
      // testo della riga, con la parte cambiata evidenziata se c'è la riga corrispondente dall'altra parte
      const code = (text, other) => {
        if (other == null) return esc(text);
        const [a, b] = changedRange(text, other);
        return a >= b ? esc(text) : `${esc(text.slice(0, a))}<mark>${esc(text.slice(a, b))}</mark>${esc(text.slice(b))}`;
      };
      // ↺ su ogni modifica: riportata a HEAD (solo file tracciati, non rinominati, di testo)
      const blocks = !!d.blocks;
      const revertBtn = s => `<button class="git-d-revert" onclick="Ext.git.revertBlock(${s.hunk},${s.block})" title="${esc(t('diff.revertBlock'))}"><i data-icon="rotate-ccw"></i></button>`;
      let body;
      if (d.binary) body = `<p class="git-muted git-pad">${esc(t('diff.binary'))}</p>`;
      else if (!hunks.length) body = `<p class="git-muted git-pad">${esc(t('diff.none'))}</p>`;
      else if (v.mode === 'split') {
        body = `<table class="git-diff git-diff-split"><colgroup><col class="git-d-numcol"><col><col class="git-d-numcol"><col>${blocks ? '<col class="git-d-actcol">' : ''}</colgroup><tbody>${sideBySide(hunks).map(r => {
          if (r.kind === 'hunk') return `<tr class="git-d-hunk"><td colspan="${blocks ? 5 : 4}">@@ −${r.oldStart} +${r.newStart} @@ ${esc(r.header)}</td></tr>`;
          if (r.kind === 'same') return `<tr><td class="git-d-no">${r.o.n}</td><td class="git-d-code">${esc(r.o.s)}</td><td class="git-d-no">${r.n.n}</td><td class="git-d-code">${esc(r.n.s)}</td>${blocks ? '<td></td>' : ''}</tr>`;
          const side = (x, other, cls) => (x ? `<td class="git-d-no">${x.n}</td><td class="git-d-code ${cls}">${code(x.s, other?.s)}</td>` : '<td class="git-d-no"></td><td class="git-d-empty"></td>');
          return `<tr>${side(r.o, r.n, 'git-d-del')}${side(r.n, r.o, 'git-d-add')}${blocks ? `<td class="git-d-act">${r.start ? revertBtn(r.start) : ''}</td>` : ''}</tr>`;
        }).join('')}</tbody></table>`;
      } else {
        body = `<table class="git-diff git-diff-unified"><colgroup><col class="git-d-numcol"><col class="git-d-numcol"><col>${blocks ? '<col class="git-d-actcol">' : ''}</colgroup><tbody>${hunks.map((h, hi) => {
          let on = h.oldStart, nn = h.newStart, block = -1, inBlock = false;
          return `<tr class="git-d-hunk"><td colspan="${blocks ? 4 : 3}">@@ −${h.oldStart} +${h.newStart} @@ ${esc(h.header)}</td></tr>` + h.lines.map(l => {
            const o = l.t !== '+' ? on++ : '', n = l.t !== '-' ? nn++ : '';
            let start = null;
            if (l.t === ' ') inBlock = false;
            else if (!inBlock) { inBlock = true; block++; start = { hunk: hi, block }; }
            return `<tr class="${l.t === '+' ? 'git-d-add' : l.t === '-' ? 'git-d-del' : ''}"><td class="git-d-no">${o}</td><td class="git-d-no">${n}</td><td class="git-d-code"><span class="git-d-sign">${l.t === ' ' ? ' ' : l.t === '-' ? '−' : '+'}</span>${esc(l.s)}</td>${blocks ? `<td class="git-d-act">${start ? revertBtn(start) : ''}</td>` : ''}</tr>`;
          }).join('');
        }).join('')}</tbody></table>`;
      }
      openModal(t('diff.title', { file: d.file }), `
        <div class="git-diff-bar">
          <span class="git-mono">${d.orig ? `${esc(d.orig)} → ` : ''}${esc(d.file)}</span>
          <span class="git-d-stat"><span class="git-d-plus">+${fmt.number(plus)}</span> <span class="git-d-minus">−${fmt.number(minus)}</span></span>
          <span class="git-diff-tools">
            <label class="git-d-check"><input type="checkbox" ${v.all ? 'checked' : ''} onchange="Ext.git.diffAll(this.checked)"> ${esc(t('diff.wholeFile'))}</label>
            <span class="git-seg">
              <button class="${v.mode === 'split' ? 'active' : ''}" onclick="Ext.git.diffMode('split')">${esc(t('diff.split'))}</button>
              <button class="${v.mode === 'unified' ? 'active' : ''}" onclick="Ext.git.diffMode('unified')">${esc(t('diff.unified'))}</button>
            </span>
            <button class="btn btn-ghost btn-sm git-d-revert-all" onclick="Ext.git.revertFile()" title="${esc(t(d.xy === '??' ? 'diff.deleteFileTitle' : 'diff.revertAllTitle'))}">${ctx.ui.icon(d.xy === '??' ? 'trash-2' : 'undo-2')} ${esc(t(d.xy === '??' ? 'diff.deleteFile' : 'diff.revertAll'))}</button>
            <button class="btn btn-ghost btn-sm" ${at > 0 ? '' : 'disabled'} onclick="Ext.git.diff(${js(files[at - 1] || '')})" title="${esc(t('diff.prev'))}">‹</button>
            <span class="git-muted">${at >= 0 ? `${fmt.number(at + 1)}/${fmt.number(files.length)}` : ''}</span>
            <button class="btn btn-ghost btn-sm" ${at >= 0 && at < files.length - 1 ? '' : 'disabled'} onclick="Ext.git.diff(${js(files[at + 1] || '')})" title="${esc(t('diff.next'))}">›</button>
          </span>
        </div>
        <p class="git-muted git-d-legend">${esc(t(d.xy === '??' ? 'diff.untracked' : 'diff.legend'))}${d.truncated ? ` ${esc(t('diff.truncated'))}` : ''}</p>
        <div class="git-diff-wrap">${body}</div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
      document.getElementById('modal')?.classList.add('modal-wide', 'git-diff-modal');
    }

    // ---- merge editor: un conflitto alla volta, nostra | loro, risultato modificabile ----
    let mergeView = null; // { file, data, parsed, choices, manual }
    async function openMerge(file) {
      let data;
      try { data = await ctx.api.get(repoUrl(`/conflict?file=${encodeURIComponent(file)}`)); }
      catch (e) { toast(e.message, 'error'); return; }
      const parsed = data.working != null && !data.binary && !data.tooLarge ? parseConflicts(data.working) : null;
      const count = parsed ? parsed.parts.filter(p => p.type === 'conflict').length : 0;
      mergeView = { file, data, parsed, choices: Array(count).fill(null), manual: false };
      renderMerge();
    }
    const mergeConflicts = () => mergeView.parsed.parts.filter(p => p.type === 'conflict');
    function renderMerge() {
      const v = mergeView;
      const d = v.data;
      const title = t('mergeEditor.title', { file: d.file });
      const close = `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>`;
      // binario, troppo grande, cancellato da un lato o senza marcatori: si sceglie il file intero
      if (!v.parsed || !mergeConflicts().length) {
        const why = d.binary ? t('mergeEditor.binary') : d.tooLarge ? t('mergeEditor.tooLarge') : t('mergeEditor.whole', { ours: d.oursLabel, theirs: d.theirsLabel });
        const textual = !d.binary && !d.tooLarge;
        openModal(title, `<p>${esc(why)}</p>
          <div class="git-me-whole">
            ${['ours', 'theirs'].map(side => `<div><h4>${esc(t(`mergeEditor.${side}`, { name: side === 'ours' ? d.oursLabel : d.theirsLabel }))}</h4>
              ${d[side] == null ? `<p class="git-muted">${esc(t('mergeEditor.deleted'))}</p>` : `<pre class="git-me-pre">${esc(d[side])}</pre>`}</div>`).join('')}
          </div>`,
          `${close}
           ${textual && d.ours != null ? `<button class="btn btn-ghost" onclick="Ext.git.mergeWhole('ours')">${esc(t('mergeEditor.keepOurs'))}</button>` : ''}
           ${textual && d.theirs != null ? `<button class="btn btn-ghost" onclick="Ext.git.mergeWhole('theirs')">${esc(t('mergeEditor.keepTheirs'))}</button>` : ''}
           ${textual && (d.ours == null || d.theirs == null) ? `<button class="btn btn-danger" onclick="Ext.git.mergeWhole('delete')">${esc(t('mergeEditor.delete'))}</button>` : ''}`);
        document.getElementById('modal')?.classList.add('modal-wide');
        return;
      }
      const conflicts = mergeConflicts();
      const done = v.choices.filter(Boolean).length;
      const lines = arr => arr.length ? arr.map(l => esc(l)).join('\n') : `<span class="git-muted">${esc(t('mergeEditor.empty'))}</span>`;
      const opts = [['ours', t('mergeEditor.useOurs')], ['theirs', t('mergeEditor.useTheirs')], ['ours-theirs', t('mergeEditor.both')], ['theirs-ours', t('mergeEditor.bothReverse')], ['none', t('mergeEditor.none')]];
      const blocks = conflicts.map((c, i) => `
        <div class="git-me-conflict ${v.choices[i] ? 'resolved' : ''}" id="git_me_${i}">
          <div class="git-me-head"><strong>${esc(t('mergeEditor.conflict', { n: i + 1, total: conflicts.length }))}</strong>
            ${v.choices[i] ? `<span class="git-me-chosen"><i data-icon="check"></i> ${esc(opts.find(o => o[0] === v.choices[i])[1])}</span>` : ''}
            <span class="git-me-opts">${opts.map(([k, label]) => `<button class="btn btn-sm ${v.choices[i] === k ? 'btn-git' : 'btn-ghost'}" onclick="Ext.git.mergeChoose(${i},${js(k)})">${esc(label)}</button>`).join('')}</span></div>
          <div class="git-me-sides">
            <div class="git-me-side git-me-ours"><div class="git-me-label">${esc(t('mergeEditor.ours', { name: d.oursLabel }))}</div><pre>${lines(c.ours)}</pre></div>
            <div class="git-me-side git-me-theirs"><div class="git-me-label">${esc(t('mergeEditor.theirs', { name: d.theirsLabel }))}</div><pre>${lines(c.theirs)}</pre></div>
          </div>
          ${c.base ? `<details class="git-me-base"><summary>${esc(t('mergeEditor.base'))}</summary><pre>${lines(c.base)}</pre></details>` : ''}
        </div>`).join('');
      const result = mergeResult(v.parsed, v.choices);
      openModal(title, `
        <div class="git-me-bar">
          <span class="git-mono">${esc(d.file)}</span>
          <span class="${done === conflicts.length ? 'git-d-plus' : 'git-muted'}">${esc(t('mergeEditor.progress', { done, total: conflicts.length }))}</span>
          <span class="git-me-all">
            <button class="btn btn-ghost btn-sm" onclick="Ext.git.mergeAll('ours')">${esc(t('mergeEditor.allOurs'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="Ext.git.mergeAll('theirs')">${esc(t('mergeEditor.allTheirs'))}</button>
          </span>
        </div>
        <div class="git-me-conflicts">${blocks}</div>
        <div class="git-me-result-head"><h4>${esc(t('mergeEditor.result'))}</h4><span class="git-muted">${esc(t(v.manual ? 'mergeEditor.manual' : 'mergeEditor.resultHint'))}</span></div>
        <textarea class="git-me-result" id="git_me_result" spellcheck="false" oninput="Ext.git.mergeEdited()">${esc(v.manual ? v.text : result)}</textarea>`,
        `${close}<button class="btn btn-git" onclick="Ext.git.mergeSave()"><i data-icon="check"></i> ${esc(t('mergeEditor.save'))}</button>`);
      document.getElementById('modal')?.classList.add('modal-wide', 'git-me-modal');
    }
    async function mergeSave(body) {
      const v = mergeView;
      if (!v) return;
      const payload = body || { content: document.getElementById('git_me_result')?.value ?? '' };
      try {
        await ctx.api.post(repoUrl('/conflict'), { file: v.file, ...payload });
        mergeView = null;
        closeModal();
        toast(t('mergeEditor.saved', { file: v.file }), 'success');
        await loadStatus();
        const next = status?.conflicts?.[0];
        if (next) openMerge(next); // il prossimo file in conflitto
        else if (status?.merging) toast(t('mergeEditor.allDone'), 'success');
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---- collegamenti ----
    const actions = {
      diff: file => file && openDiff(file),
      diffMode(mode) { diffView.mode = mode; try { localStorage.setItem(DIFF_MODE_KEY, mode); } catch { /* niente */ } renderDiff(); },
      diffAll(all) { diffView.all = all; loadDiff(); },
      async revertFile() {
        const v = diffView;
        if (!v?.data) return;
        const untracked = v.data.xy === '??';
        if (!confirm(t(untracked ? 'diff.confirmDelete' : 'diff.confirmRevertAll', { file: v.file }))) return;
        try { await ctx.api.post(repoUrl('/revert'), { file: v.file }); }
        catch (e) { toast(e.message, 'error'); return; }
        toast(t(untracked ? 'diff.deleted' : 'diff.reverted', { file: v.file }), 'success');
        await afterRevert();
      },
      async revertBlock(hunk, block) {
        const v = diffView;
        const h = v?.data && parsePatch(v.data.patch)[hunk];
        if (!h) return;
        const scroll = document.querySelector('.git-diff-wrap')?.scrollTop;
        try { await ctx.api.post(repoUrl('/revert-block'), { file: v.file, context: v.all ? 'all' : '3', hunk, block, expect: h.raw.join('\n') }); }
        catch (e) { toast(e.message, 'error'); if (e.code === 'git.diff_changed') loadDiff(); return; }
        await afterRevert(scroll);
      },
      resolve: file => openMerge(file),
      mergeChoose(i, choice) {
        const v = mergeView;
        if (v.manual && !confirm(t('mergeEditor.dropManual'))) return;
        v.manual = false;
        v.choices[i] = v.choices[i] === choice ? null : choice;
        const scroll = document.querySelector('.git-me-conflicts')?.scrollTop;
        renderMerge();
        const box = document.querySelector('.git-me-conflicts');
        if (box && scroll != null) box.scrollTop = scroll;
      },
      mergeAll(side) {
        const v = mergeView;
        if (v.manual && !confirm(t('mergeEditor.dropManual'))) return;
        v.manual = false;
        v.choices = v.choices.map(() => side);
        renderMerge();
      },
      mergeEdited() { const v = mergeView; v.manual = true; v.text = document.getElementById('git_me_result').value; },
      mergeSave: () => mergeSave(),
      mergeWhole(side) {
        const d = mergeView.data;
        if (side === 'delete') { if (confirm(t('mergeEditor.confirmDelete', { file: d.file }))) mergeSave({ delete: true }); return; }
        mergeSave({ content: d[side] });
      },
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
