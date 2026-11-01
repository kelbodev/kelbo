// File .env dei progetti: tabella chiavi × file con le differenze rispetto al modello,
// valori nascosti (uno alla volta), modifica, chiavi mancanti aggiunte dal modello.

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    let projects = [];
    let folders = [];
    let active = null;   // id del progetto
    let data = null;     // panoramica del progetto (chiavi, mai valori)
    let revealed = null; // { file, key, value }: un solo valore visibile alla volta

    const url = (suffix = '') => `/projects/${encodeURIComponent(active)}${suffix}`;
    const fileUrl = (file, suffix = '') => url(`/files/${encodeURIComponent(file)}${suffix}`);

    async function loadProjects() {
      try { projects = await ctx.api.get('/projects'); } catch (e) { toast(e.message, 'error'); projects = []; }
      try { folders = (await ctx.projects.load()).folders; } catch { folders = []; }
      renderProjects();
    }

    function renderProjects() {
      const el = $(ctx.sidebar, 'projects');
      el.innerHTML = !projects.length ? `<p class="env-muted" style="padding:12px">${esc(t('sidebar.none'))}</p>`
        : ctx.projects.tree(folders, projects, p => `<button class="sb-item ${p.id === active ? 'active' : ''}" onclick="Ext.env.select(${js(p.id)})">
            <span class="sb-icon">${p.files.length ? '🔑' : '·'}</span><span>${esc(p.label)}</span>
            ${p.issues ? `<span class="sb-env-issues" title="${esc(t('issuesTitle', { count: p.issues }))}">${esc(t('issues', { count: p.issues }))}</span>`
              : `<span class="sb-count">${esc(ctx.ui.fmt.number(p.files.length))}</span>`}
          </button>`);
    }

    async function loadProject() {
      if (!active) return;
      try { data = await ctx.api.get(url()); } catch (e) { toast(e.message, 'error'); return; }
      render();
    }

    function render() {
      $(ctx.root, 'empty').hidden = !!active;
      $(ctx.root, 'project').hidden = !active;
      if (!active || !data) return;
      const p = projects.find(x => x.id === active);
      $(ctx.root, 'title').textContent = p?.label || active;
      $(ctx.root, 'summary').textContent = data.template ? t('templateIs', { file: data.template }) : t('noTemplate');
      const files = data.files.filter(f => f.keys);
      if (!data.files.length) { $(ctx.root, 'content').innerHTML = `<p class="env-muted">${esc(t('noFiles'))}</p>`; return; }
      // righe: prima le chiavi del modello, poi le altre in ordine di file
      const order = [];
      const tpl = files.find(f => f.name === data.template);
      for (const f of [tpl, ...files.filter(x => x !== tpl)].filter(Boolean)) for (const k of f.keys) if (!order.includes(k.key)) order.push(k.key);
      const has = (f, key) => f.keys.find(k => k.key === key);
      const tplKeys = new Set((tpl?.keys || []).map(k => k.key));
      $(ctx.root, 'content').innerHTML = `
        ${data.files.filter(f => f.error).map(f => `<p class="env-error">${esc(f.name)}: ${esc(f.error)}</p>`).join('')}
        <table class="data-table env-table">
          <thead><tr><th>${esc(t('key'))}</th>${files.map(f => `<th><div class="env-file-head">
            <span>${esc(f.name)}${f.name === data.template ? ` <span class="env-template">${esc(t('template'))}</span>` : ''}</span>
            ${f.missing?.length ? `<button class="btn btn-ghost btn-sm" onclick="Ext.env.addMissing(${js(f.name)})">${esc(t('addMissing', { count: f.missing.length }))}</button>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="Ext.env.addKey(${js(f.name)})">${esc(t('addKey'))}</button>
          </div></th>`).join('')}</tr></thead>
          <tbody>${order.map(key => `<tr>
            <td class="env-key">${esc(key)}${tpl && !tplKeys.has(key) ? `<span class="env-extra">${esc(t('notInTemplate'))}</span>` : ''}</td>
            ${files.map(f => {
              const k = has(f, key);
              if (!k) {
                return tpl && tplKeys.has(key) && f !== tpl
                  ? `<td><div class="env-cell"><span class="env-missing">${esc(t('missing'))}</span><button class="env-icon" title="${esc(t('add'))}" onclick="Ext.env.addFromTemplate(${js(f.name)}, ${js(key)})">＋</button></div></td>`
                  : '<td><span class="env-muted">—</span></td>';
              }
              const shown = revealed && revealed.file === f.name && revealed.key === key;
              return `<td><div class="env-cell">
                ${k.empty ? `<span class="env-empty">${esc(t('emptyValue'))}</span>`
                  : shown ? `<span class="env-value" title="${esc(revealed.value)}">${esc(revealed.value)}</span>` : '<span class="env-mask">••••••</span>'}
                ${k.empty ? '' : `<button class="env-icon" title="${esc(t(shown ? 'hide' : 'show'))}" onclick="Ext.env.toggle(${js(f.name)}, ${js(key)})">${shown ? '🙈' : '👁'}</button>`}
                <button class="env-icon" title="${esc(t('edit'))}" onclick="Ext.env.edit(${js(f.name)}, ${js(key)})">✎</button>
              </div></td>`;
            }).join('')}
          </tr>`).join('')}</tbody>
        </table>`;
    }

    const getValue = async (file, key) => (await ctx.api.get(`${fileUrl(file, '/value')}?key=${encodeURIComponent(key)}`)).value;
    const versionOf = file => data.files.find(f => f.name === file)?.version;

    async function change(file, changes, okKey, params = {}) {
      try {
        data = await ctx.api.put(fileUrl(file), { version: versionOf(file), changes });
        revealed = null;
        closeModal();
        toast(t(okKey, params), 'success');
        render();
        loadProjects();
      } catch (e) {
        toast(e.message, 'error');
        if (e.code === 'env.file_changed') loadProject();
      }
    }

    // Finestra di modifica: valore (letto ora dal file), rinomina, eliminazione
    function keyDialog(title, file, key, value, { isNew = false } = {}) {
      openModal(title, `
        <div class="form-row"><label>${esc(t('key'))}</label><input class="form-input" id="f_env_key" value="${esc(key)}"></div>
        <div class="form-row"><label>${esc(t('value'))}</label><textarea class="form-input" id="f_env_value" rows="3" spellcheck="false">${esc(value)}</textarea></div>
        <p class="env-muted">${esc(t('fileHint', { file }))}</p>`,
        `${isNew ? '' : `<button class="btn btn-ghost" style="margin-inline-end:auto" onclick="Ext.env.remove(${js(file)}, ${js(key)})">${esc(t('core.action.delete'))}</button>`}
         <button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext.env.save(${js(file)}, ${js(isNew ? '' : key)})">${esc(t('core.action.save'))}</button>`);
      setTimeout(() => document.getElementById(isNew && !key ? 'f_env_key' : 'f_env_value')?.focus(), 0);
    }

    const actions = {
      async select(id) { active = id; data = null; revealed = null; renderProjects(); render(); await loadProject(); },
      async toggle(file, key) {
        if (revealed && revealed.file === file && revealed.key === key) { revealed = null; render(); return; }
        try { revealed = { file, key, value: await getValue(file, key) }; render(); } catch (e) { toast(e.message, 'error'); }
      },
      async edit(file, key) {
        try { keyDialog(t('editTitle', { key, file }), file, key, await getValue(file, key)); } catch (e) { toast(e.message, 'error'); }
      },
      addKey(file) { keyDialog(t('addTitle', { file }), file, '', '', { isNew: true }); },
      async addFromTemplate(file, key) {
        let value = '';
        try { value = await getValue(data.template, key); } catch { /* modello senza valore */ }
        keyDialog(t('addTitle', { file }), file, key, value, { isNew: true });
      },
      save(file, oldKey) {
        const key = document.getElementById('f_env_key').value.trim();
        const value = document.getElementById('f_env_value').value;
        if (!key) { toast(t('keyRequired'), 'error'); return; }
        // rinomina + valore: entrambe le modifiche sulla chiave originale
        const changes = oldKey && oldKey !== key ? [{ op: 'set', key: oldKey, value }, { op: 'rename', key: oldKey, to: key }] : [{ op: 'set', key, value }];
        change(file, changes, 'saved', { key, file });
      },
      remove(file, key) {
        if (!confirm(t('confirmDelete', { key, file }))) return;
        change(file, [{ op: 'delete', key }], 'deleted', { key, file });
      },
      async addMissing(file) {
        const f = data.files.find(x => x.name === file);
        if (!confirm(t('confirmAddMissing', { count: f.missing.length, file, template: data.template }))) return;
        try {
          const r = await ctx.api.post(fileUrl(file, '/add-missing'), { version: f.version });
          data = r;
          toast(t('addedMissing', { count: r.added.length, file }), 'success');
          render();
          loadProjects();
        } catch (e) { toast(e.message, 'error'); if (e.code === 'env.file_changed') loadProject(); }
      },
      newFile() {
        openModal(t('newFileTitle'), `
          <div class="form-row"><label>${esc(t('fileName'))}</label><input class="form-input" id="f_env_file" value="${data.files.some(f => f.name === '.env') ? '.env.local' : '.env'}"></div>
          <p class="env-muted">${esc(data.template ? t('newFileFromTemplate', { template: data.template }) : t('newFileEmpty'))}</p>`,
          `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
           <button class="btn btn-primary" onclick="Ext.env.createFile()">${esc(t('create'))}</button>`);
      },
      async createFile() {
        const name = document.getElementById('f_env_file').value.trim();
        try {
          data = await ctx.api.post(url('/files'), { name });
          closeModal();
          toast(t('created', { file: name }), 'success');
          render();
          loadProjects();
        } catch (e) { toast(e.message, 'error'); }
      },
    };

    ctx.sidebar.addEventListener('click', e => { if (e.target.closest('[data-action="reload"]')) this.refresh(); });
    ctx.root.addEventListener('click', e => { if (e.target.closest('[data-action="new-file"]')) actions.newFile(); });
    ctx.bus.on('core:projects-changed', loadProjects);
    ctx.expose(actions);
    await loadProjects();
    render();

    this.refresh = async () => { revealed = null; await loadProjects(); await loadProject(); };
    // aperta da un widget o dalla dashboard: { project } sceglie il progetto
    this.focus = params => { if (params?.project && params.project !== active) actions.select(params.project); };
    this.languageChanged = () => { renderProjects(); render(); };
  },

  show() { this.refresh(); },
};
