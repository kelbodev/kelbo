// NPM: progetti nella sidebar, script con processi tracciati (log, porte, riavvio),
// dipendenze con versione installata e aggiornamenti, pill nell'header.
// Montato all'avvio (preload) per pill e badge dei processi in esecuzione.

const POLL_MS = 5000;

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, output, formatUptime, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let projects = [];
    let folders = [];
    let hidden = 0; // progetti senza Node.js, solo nel pannello 📁
    let processes = [];
    let activeProject = null;
    let tab = 'scripts';
    let closeStream = null;

    const project = () => projects.find(p => p.id === activeProject) || null;
    const running = id => processes.filter(pr => pr.projectId === id && pr.running).length;
    const scriptLabel = script => script === 'install' ? 'npm install' : script.startsWith('update ') ? `npm ${script}` : `npm run ${script}`;

    // ---- dati ----
    async function loadProjects() {
      try { ({ projects, folders, hidden } = await ctx.projects.load()); } catch { projects = []; folders = []; hidden = 0; }
    }

    async function loadProcesses() {
      try { processes = await ctx.api.get('/processes'); } catch { return; }
      renderPills();
      const n = processes.filter(p => p.running).length;
      ctx.setBadge(n ? { icon: 'play', text: `${projects.length} · ${n}` } : projects.length);
    }

    // ---- header ----
    function renderPills() {
      ctx.setPills(processes.filter(p => p.running).map(p => {
        const ports = (p.ports || []).map(x => `:${x}`).join(' ');
        return `<span class="pill pill-npm" onclick="Ext.npm.open(${js(p.projectId)})"
                      title="${esc(p.projectLabel)} — ${esc(scriptLabel(p.script))}${ports ? ` (${esc(ports)})` : ''}">
          <span class="pill-dot"></span>
          ${esc(p.projectLabel)}<span class="pill-sub"> ${esc(p.script)}</span>
          ${ports ? `<span class="pill-sub">${esc(ports)}</span>` : ''}
          <span class="pill-close" onclick="event.stopPropagation();Ext.npm.stop(${js(p.id)})"><i data-icon="x"></i></span>
        </span>`;
      }).join(''));
    }

    // ---- sidebar ----
    function renderProjects() {
      const el = $(ctx.sidebar, 'projects');
      if (!projects.length) {
        ctx.ui.patch(el, `<p class="npm-muted npm-pad">${esc(t('sidebar.none'))}<br><br><button class="btn btn-npm btn-sm" onclick="Projects.openPanel()">${ctx.ui.icon('folder-git-2')} ${esc(t('sidebar.add'))}</button></p>${ctx.projects.hiddenNote(hidden)}`);
        return;
      }
      ctx.ui.patch(el, ctx.projects.tree(folders, projects, p => {
        const n = running(p.id);
        return `<div class="sb-proj ${activeProject === p.id ? 'active' : ''}" onclick="Ext.npm.select(${js(p.id)})">
          <span class="sb-proj-icon ${n ? 'running' : ''}">${ctx.ui.icon(n ? 'circle-play' : 'package')}</span>
          <div class="sb-proj-info">
            <div class="sb-proj-label">${esc(p.label)}${n ? ` <span class="npm-run-count">${ctx.ui.icon('play')}${fmt.number(n)}</span>` : ''}</div>
            <div class="sb-proj-path">${esc(p.path)}</div>
          </div>
        </div>`;
      }) + ctx.projects.hiddenNote(hidden));
    }

    // ---- pannello ----
    function renderHeader() {
      const p = project();
      $(ctx.root, 'empty').hidden = !!p;
      $(ctx.root, 'project').hidden = !p;
      if (!p) return false;
      $(ctx.root, 'title').textContent = p.label;
      $(ctx.root, 'path').textContent = p.path;
      const n = running(p.id);
      $(ctx.root, 'running').innerHTML = n ? `${ctx.ui.icon('play')} ${esc(t('running', { count: n }))}` : '';
      for (const b of ctx.root.querySelectorAll('.npm-tab')) b.classList.toggle('active', b.dataset.tab === tab);
      return true;
    }

    async function renderTab() {
      if (!renderHeader()) return;
      if (tab === 'scripts') await renderScripts();
      else await renderPackages();
    }

    async function packageOf(p) {
      try { return await ctx.api.get(`/projects/${encodeURIComponent(p.id)}/package`); }
      catch { return { scripts: {}, dependencies: {}, devDependencies: {} }; }
    }

    async function renderScripts() {
      const p = project();
      const content = $(ctx.root, 'tab-content');
      const pkg = await packageOf(p);
      if (project() !== p || tab !== 'scripts') return; // selezione cambiata nel frattempo
      const procs = processes.filter(pr => pr.projectId === p.id);
      const pm2 = ctx.hasExtension('pm2');

      const row = (name, cmd) => {
        const proc = procs.find(pr => pr.script === name);
        const isRunning = proc?.running;
        return `<div class="script-row ${isRunning ? 'running' : ''}">
          ${isRunning ? `<span class="proc-dot" title="${esc(t('script.running', { pid: String(proc.pid) }))}"></span>`
            : proc ? `<span class="proc-dot dead" title="${esc(t('script.exited', { code: String(proc.exitCode) }))}"></span>` : ''}
          <span class="script-name">${esc(name)}</span>
          <span class="script-cmd">${esc(cmd || 'npm ' + name)}</span>
          ${isRunning ? `<span class="proc-uptime" data-uptime="${esc(proc.startedAt)}">${formatUptime(proc.startedAt)}</span>` : ''}
          ${(isRunning ? proc.ports || [] : []).map(port => `<span class="proc-port" title="${esc(t('script.portInUse'))}">:${esc(port)}</span>`).join('')}
          <div class="script-actions">
            ${proc ? `
              <button class="btn btn-ghost btn-sm" onclick="Ext.npm.logs(${js(proc.id)},${js(scriptLabel(name))})" title="${esc(t('script.logs'))}"><i data-icon="scroll-text"></i></button>
              ${isRunning ? `
                <button class="btn btn-ghost btn-sm" onclick="Ext.npm.restart(${js(proc.id)})" title="${esc(t('script.restart'))}"><i data-icon="rotate-ccw"></i></button>
                <button class="btn btn-disconnect btn-sm" onclick="Ext.npm.stop(${js(proc.id)})" title="${esc(t('script.stop'))}"><i data-icon="square"></i></button>
              ` : `
                <button class="btn btn-npm btn-sm" onclick="Ext.npm.run(${js(p.id)},${js(name)})">${ctx.ui.icon('play')} ${esc(t('script.rerun'))}</button>
                <button class="btn btn-ghost btn-sm" onclick="Ext.npm.dismiss(${js(proc.id)})" title="${esc(t('script.dismiss'))}"><i data-icon="x"></i></button>
              `}
            ` : `<button class="btn btn-npm btn-sm" onclick="Ext.npm.run(${js(p.id)},${js(name)})">${ctx.ui.icon('play')} ${esc(t('script.run'))}</button>`}
            ${pm2 && name !== 'install' ? `<button class="btn btn-ghost btn-sm" onclick="Ext.npm.pm2(${js(p.id)},${js(name)})" title="${esc(t('script.pm2'))}">PM2</button>` : ''}
          </div>
        </div>`;
      };

      const scripts = Object.entries(pkg.scripts || {});
      ctx.ui.patch(content, `<div class="scripts-grid">
        ${row('install', 'npm install')}
        ${scripts.map(([name, cmd]) => row(name, cmd)).join('')}
        ${scripts.length ? '' : `<p class="npm-muted">${esc(t('script.none'))}</p>`}
      </div>`);
    }

    async function renderPackages() {
      const p = project();
      const content = $(ctx.root, 'tab-content');
      content.innerHTML = `<div class="npm-muted">${esc(t('packages.loading'))}</div>`;
      const pkg = await packageOf(p);
      if (project() !== p || tab !== 'packages') return;
      const deps = Object.entries(pkg.dependencies || {});
      const devDeps = Object.entries(pkg.devDependencies || {});

      const table = (list, title) => !list.length ? '' : `
        <div class="pkg-section">
          <div class="pkg-section-title">${title} <span class="pkg-count">${fmt.number(list.length)}</span></div>
          <table class="data-table">
            <thead><tr><th>${esc(t('packages.package'))}</th><th>${esc(t('packages.configVersion'))}</th><th>${esc(t('packages.installed'))}</th><th></th></tr></thead>
            <tbody>${list.map(([name, ver]) => `<tr>
              <td class="pkg-name">${esc(name)}</td>
              <td class="pkg-dim">${esc(ver)}</td>
              <td class="pkg-installed" data-pkg="${esc(name)}"><span class="pkg-dim">—</span></td>
              <td><button class="btn btn-ghost btn-sm" onclick="Ext.npm.update(${js(p.id)},${js(name)})" title="${esc(t('packages.update'))}">${ctx.ui.icon('arrow-up')} update</button></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>`;

      ctx.ui.patch(content, `
        <div class="pkg-toolbar">
          <button class="btn btn-npm btn-sm" onclick="Ext.npm.run(${js(p.id)},'install')">${ctx.ui.icon('download')} npm install</button>
          <button class="btn btn-ghost btn-sm" onclick="Ext.npm.outdated(${js(p.id)})">${ctx.ui.icon('search-check')} ${esc(t('packages.checkUpdates'))}</button>
          <span class="pkg-dim" data-role="outdated-status"></span>
        </div>
        ${table(deps, 'dependencies')}
        ${table(devDeps, 'devDependencies')}
        ${deps.length || devDeps.length ? '' : `<p class="npm-muted">${esc(t('packages.none'))}</p>`}`);

      const names = [...deps, ...devDeps].map(([n]) => n);
      if (!names.length) return;
      try {
        const versions = await ctx.api.post(`/projects/${encodeURIComponent(p.id)}/installed-versions`, { packages: names });
        for (const [name, ver] of Object.entries(versions)) {
          const cell = installedCell(name);
          if (cell) cell.innerHTML = ver ? `<span class="pkg-ok">${esc(ver)}</span>` : `<span class="pkg-dim">${esc(t('packages.notInstalled'))}</span>`;
        }
      } catch {}
    }

    const installedCell = name => [...ctx.root.querySelectorAll('[data-pkg]')].find(el => el.dataset.pkg === name);

    // ---- log in streaming nel cassetto di output ----
    // following: processo mostrato nel cassetto; resta anche a sezione nascosta, così al
    // ritorno lo stream riparte (con lo storico) invece di restare fermo
    let following = null;
    function stream(procId, title) {
      closeStream?.();
      following = { procId, title };
      output.open(title);
      closeStream = ctx.api.events(`/processes/${encodeURIComponent(procId)}/stream`, ({ type, data }) => {
        if (type === 'exit') {
          const text = data?.removed ? t('stream.removed') : data?.ended ? t('stream.ended', { code: String(data.exitCode) }) : `[exit ${data?.exitCode}]`;
          output.append(`\n${text}`, 'sys');
          closeStream?.(); closeStream = null;
          following = null; // processo finito: l'output resta com'è
        }
        else output.append(data, type === 'stderr' ? 'err' : 'out');
      }, () => output.append('\n' + t('stream.lost'), 'err'));
    }

    async function refreshAll() {
      await loadProcesses();
      renderProjects();
      if (ctx.isActive() && tab === 'scripts' && project()) await renderTab();
      else if (ctx.isActive()) renderHeader();
    }

    // ---- azioni (handler inline) ----
    const actions = {
      open(projectId) {
        if (projectId) { activeProject = projectId; tab = 'scripts'; }
        ctx.open(ctx.code);
        renderProjects(); renderTab();
      },
      select(id) { activeProject = id; renderProjects(); renderTab(); },

      async run(projectId, script) {
        try {
          const r = await ctx.api.post(`/projects/${encodeURIComponent(projectId)}/run`, { script });
          toast(t('toast.started', { script: scriptLabel(script) }), 'success');
          await refreshAll();
          stream(r.id, scriptLabel(script));
        } catch (e) { toast(e.message, 'error'); }
      },
      async stop(procId) {
        try {
          await ctx.api.del(`/processes/${encodeURIComponent(procId)}`);
          toast(t('toast.stopped'), 'success');
          await refreshAll();
        } catch (e) { toast(e.message, 'error'); }
      },
      async restart(procId) {
        try {
          await ctx.api.post(`/processes/${encodeURIComponent(procId)}/restart`);
          toast(t('toast.restarted'), 'success');
          await refreshAll();
          const pd = processes.find(x => x.id === procId);
          if (pd) stream(procId, scriptLabel(pd.script));
        } catch (e) { toast(e.message, 'error'); }
      },
      async dismiss(procId) {
        try {
          await ctx.api.del(`/processes/${encodeURIComponent(procId)}/dismiss`);
          await refreshAll();
        } catch (e) { toast(e.message, 'error'); }
      },
      logs: (procId, title) => stream(procId, title),

      async update(projectId, name) {
        try {
          toast(t('toast.updating', { name }));
          const r = await ctx.api.post(`/projects/${encodeURIComponent(projectId)}/update`, { package: name });
          await loadProcesses();
          stream(r.id, `npm update ${name}`);
        } catch (e) { toast(e.message, 'error'); }
      },
      async outdated(projectId) {
        const status = $(ctx.root, 'outdated-status');
        if (status) status.textContent = t('packages.checking');
        try {
          const data = Object.entries(await ctx.api.get(`/projects/${encodeURIComponent(projectId)}/outdated`));
          if (status) status.textContent = data.length ? t('packages.available', { count: data.length }) : t('packages.upToDate');
          for (const [name, info] of data) {
            const cell = installedCell(name);
            if (cell) cell.innerHTML = `<span class="pkg-warn">${esc(info.current)}</span> → <span class="pkg-ok">${esc(info.latest)}</span>`;
          }
        } catch (e) { if (status) status.textContent = t('packages.error', { error: e.message }); }
      },

      // Avvio dello script sotto PM2 tramite l'estensione pm2
      async pm2(projectId, script) {
        try {
          await ctx.apiFor('pm2').post('/action', { action: 'start', projectId, script });
          toast(t('toast.pm2Started', { script }), 'success');
        } catch (e) { toast(t('toast.pm2Error', { error: e.message }), 'error'); }
      },

    };

    ctx.sidebar.addEventListener('click', e => {
      if (e.target.closest('[data-action="manage-projects"]')) ctx.projects.openPanel();
    });
    ctx.root.addEventListener('click', e => {
      const next = e.target.closest('.npm-tab')?.dataset.tab;
      if (next && next !== tab) { tab = next; renderTab(); }
    });

    ctx.bus.on('core:projects-changed', async () => { await loadProjects(); renderProjects(); });
    ctx.expose(actions);
    await loadProjects();
    await loadProcesses();
    setInterval(refreshAll, POLL_MS);

    this.show = async () => {
      if (following && !closeStream) stream(following.procId, following.title);
      await loadProjects(); renderProjects(); renderTab();
    };
    this.hide = () => { closeStream?.(); closeStream = null; }; // following resta: si riprende in show
    this.refresh = async () => { await loadProjects(); await refreshAll(); };
    // aperta da un widget o dalla dashboard: { project } sceglie il progetto, { process } ne mostra l'output
    this.focus = async params => {
      if (params?.project && projects.some(p => p.id === params.project)) { activeProject = params.project; tab = 'scripts'; renderProjects(); renderTab(); }
      if (params?.process) {
        await loadProcesses();
        const pd = processes.find(x => x.id === params.process);
        if (pd) stream(pd.id, scriptLabel(pd.script));
      }
    };
    this.languageChanged = () => { renderProjects(); if (ctx.isActive()) renderTab(); };
  },
};
