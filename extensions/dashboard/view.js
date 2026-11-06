// Dashboard di progetto: nella sidebar i progetti, nel pannello i widget delle estensioni per
// il progetto scelto (ctx.widgets del core) in una griglia: aggiungi, togli, trascina per
// riordinare, dimensione S/M/L. La scelta è salvata per progetto; senza scelta, tutti.

const ACTIVE_KEY = 'kelbo.dashboard.project';
const SIZES = ['s', 'm', 'l'];

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let projects = [], folders = [];
    let active = (() => { try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; } })();
    let layout = [];          // [{ key, size }] mostrati
    let custom = false;       // scelta salvata (altrimenti tutti i widget, dimensione predefinita)
    const handles = new Map(); // key → { refresh, unmount }
    let dragging = null;
    let generation = 0;       // ogni disegno della griglia: i widget di un disegno vecchio si smontano
    let loading = null;       // caricamento della griglia in corso

    const project = () => projects.find(p => p.id === active) || null;
    const available = () => ctx.widgets.list('project', project());

    // ---- caricamento ----

    async function load() {
      try { ({ projects, folders } = await ctx.projects.load()); } catch { projects = []; folders = []; }
      if (!project()) active = projects[0]?.id || null;
      renderSidebar();
      await loadBoard();
    }

    function loadBoard() {
      loading = doLoadBoard().finally(() => { loading = null; });
      return loading;
    }
    async function doLoadBoard() {
      generation++;
      unmountAll();
      const p = project();
      $(ctx.root, 'empty').hidden = !!p;
      $(ctx.root, 'board').hidden = !p;
      $(ctx.root, 'empty-text').textContent = t(projects.length ? 'empty.choose' : 'empty.noProjects');
      if (!p) return;
      $(ctx.root, 'title').textContent = p.label;
      $(ctx.root, 'path').textContent = p.path;
      let saved = null;
      try { saved = (await ctx.api.get(`/layouts/${encodeURIComponent(p.id)}`)).widgets; } catch (e) { toast(e.message, 'error'); }
      if (project() !== p) return; // cambiato progetto nel frattempo
      const known = new Set(available().map(w => w.key));
      custom = Array.isArray(saved);
      layout = custom ? saved.filter(w => known.has(w.key)) : available().map(w => ({ key: w.key, size: w.size }));
      renderBoard();
    }

    function unmountAll() {
      for (const h of handles.values()) h.unmount();
      handles.clear();
    }

    async function save() {
      const p = project();
      if (!p) return;
      try {
        await ctx.api.put(`/layouts/${encodeURIComponent(p.id)}`, { widgets: layout });
        custom = true;
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---- sidebar ----

    function renderSidebar() {
      const el = $(ctx.sidebar, 'projects');
      el.innerHTML = projects.length
        ? ctx.projects.tree(folders, projects, p => `<button class="sb-item ${p.id === active ? 'active' : ''}" onclick="Ext.dashboard.select(${js(p.id)})">
            <span class="sb-icon"><i data-icon="folder"></i></span><span>${esc(p.label)}</span></button>`)
        : `<p class="dash-muted" style="padding:12px">${esc(t('empty.noProjects'))}</p>`;
    }

    // ---- griglia ----

    function renderBoard() {
      const gen = ++generation;
      unmountAll();
      const grid = $(ctx.root, 'grid');
      const info = new Map(available().map(w => [w.key, w]));
      grid.innerHTML = layout.length ? layout.map(item => {
        const w = info.get(item.key);
        return `<section class="dash-w dash-${item.size}" data-key="${esc(item.key)}" style="--w-color:${ctx.ui.cssColor(w.color)}">
          <header class="dash-w-head" draggable="true" title="${esc(t('widget.drag'))}">
            <span class="dash-w-icon">${ctx.ui.iconOrText(w.icon)}</span>
            <span class="dash-w-title" data-title>${esc(w.title)}</span>
            <span class="dash-w-badge" data-badge hidden></span>
            <button class="dash-w-btn" data-act="open" title="${esc(t('widget.open', { name: w.extension }))}"><i data-icon="arrow-up-right"></i></button>
            <button class="dash-w-btn" data-act="menu" title="${esc(t('widget.actions'))}"><i data-icon="ellipsis"></i></button>
          </header>
          <div class="dash-w-body" data-body></div>
        </section>`;
      }).join('') : `<p class="dash-muted dash-none">${esc(t('board.none'))}</p>`;
      const p = project();
      for (const item of layout) {
        const box = grid.querySelector(`[data-key="${CSS.escape(item.key)}"]`);
        const body = box.querySelector('[data-body]');
        ctx.widgets.mount(item.key, body, { project: p }, {
          onTitle: text => { box.querySelector('[data-title]').textContent = text; },
          onBadge: value => {
            const b = box.querySelector('[data-badge]');
            const empty = value === null || value === undefined || value === '';
            b.hidden = empty;
            b.innerHTML = empty ? '' : ctx.ui.badgeHtml(value); // testo o { icon, text }
          },
        }).then(h => { if (gen !== generation || !grid.contains(box)) h.unmount(); else handles.set(item.key, h); });
      }
    }

    function refreshAll() { for (const h of handles.values()) h.refresh(); }

    function setSize(key, size) {
      const item = layout.find(w => w.key === key);
      if (!item || item.size === size) return;
      item.size = size;
      const box = $(ctx.root, 'grid').querySelector(`[data-key="${CSS.escape(key)}"]`);
      box.classList.remove(...SIZES.map(s => `dash-${s}`));
      box.classList.add(`dash-${size}`);
      save();
    }

    function removeWidget(key) {
      layout = layout.filter(w => w.key !== key);
      handles.get(key)?.unmount();
      handles.delete(key);
      $(ctx.root, 'grid').querySelector(`[data-key="${CSS.escape(key)}"]`)?.remove();
      if (!layout.length) renderBoard();
      save();
    }

    function widgetMenu(ev, key) {
      const item = layout.find(w => w.key === key);
      const r = ev.target.getBoundingClientRect();
      ctx.ui.contextMenu(r.left, r.bottom, [
        ...SIZES.map(s => ({ label: t(`widget.size.${s}`), icon: item.size === s ? 'circle-dot' : 'circle', action: () => setSize(key, s) })),
        'separator',
        { label: t('widget.refresh'), icon: 'refresh-cw', action: () => handles.get(key)?.refresh() },
        { label: t('widget.remove'), icon: 'x', danger: true, action: () => removeWidget(key) },
      ]);
    }

    function addDialog() {
      const shown = new Set(layout.map(w => w.key));
      const list = available().filter(w => !shown.has(w.key));
      openModal(t('add.title'), list.length ? `<div class="dash-add">${list.map(w => `
          <button class="dash-add-item" onclick="Ext.dashboard.addWidget(${js(w.key)})" style="--w-color:${ctx.ui.cssColor(w.color)}">
            <span class="dash-w-icon">${ctx.ui.iconOrText(w.icon)}</span>
            <span class="dash-add-text"><strong>${esc(w.title)}</strong><span class="dash-muted">${esc(w.extension)}${w.description ? ` · ${esc(w.description)}` : ''}</span></span>
          </button>`).join('')}</div>` : `<p class="dash-muted">${esc(t('add.none'))}</p>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
    }

    // ---- azioni ----

    async function select(id) {
      if (id === active || !projects.some(p => p.id === id)) return;
      active = id;
      try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* solo in questa sessione */ }
      renderSidebar();
      await loadBoard();
    }

    ctx.expose({
      select,
      addWidget(key) {
        const w = available().find(x => x.key === key);
        if (!w || layout.some(x => x.key === key)) return;
        closeModal();
        layout.push({ key, size: w.size });
        renderBoard();
        save();
      },
    });

    ctx.sidebar.addEventListener('click', e => { if (e.target.closest('[data-action="reload"]')) { refreshAll(); load(); } });

    ctx.root.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'add') return addDialog();
      if (a === 'reset') {
        const p = project();
        if (!p || !custom || !confirm(t('board.confirmReset'))) return;
        ctx.api.del(`/layouts/${encodeURIComponent(p.id)}`).then(loadBoard, err => toast(err.message, 'error'));
        return;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      const key = e.target.closest('[data-key]')?.dataset.key;
      if (!act || !key) return;
      if (act === 'menu') widgetMenu(e, key);
      else if (act === 'open') ctx.open(key.split('/')[0], { project: active });
    });

    // trascinamento dall'intestazione: il widget prende il posto di quello su cui passa
    ctx.root.addEventListener('dragstart', e => {
      const box = e.target.closest?.('.dash-w');
      if (!box || !e.target.closest('.dash-w-head')) return;
      dragging = box;
      box.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', box.dataset.key);
    });
    ctx.root.addEventListener('dragover', e => {
      const over = e.target.closest?.('.dash-w');
      if (!dragging || !over || over === dragging) return;
      e.preventDefault();
      const r = over.getBoundingClientRect();
      const after = e.clientY > r.bottom - r.height / 3 || (e.clientX > r.left + r.width / 2 && e.clientY > r.top + r.height / 3);
      over.parentElement.insertBefore(dragging, after ? over.nextSibling : over);
    });
    ctx.root.addEventListener('dragend', () => {
      if (!dragging) return;
      dragging.classList.remove('dragging');
      dragging = null;
      const order = [...$(ctx.root, 'grid').querySelectorAll('.dash-w')].map(b => b.dataset.key);
      if (order.join() === layout.map(w => w.key).join()) return;
      layout = order.map(k => layout.find(w => w.key === k));
      save();
    });

    ctx.bus.on('core:projects-changed', load);
    await load();

    // tornando sulla sezione: i widget già mostrati si aggiornano (niente secondo caricamento)
    this.show = () => { if (!loading) refreshAll(); };
    this.refresh = load;
    // apertura da un'altra sezione: { project } sceglie il progetto
    this.focus = params => { if (params?.project) select(params.project); };
    this.languageChanged = () => { renderSidebar(); loadBoard(); };
  },
};
