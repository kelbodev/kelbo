// Progetti del core: albero a un livello per le sidebar delle estensioni (cartelle con i loro
// progetti, poi i progetti senza cartella) e pannello 📁 Progetti dell'header, l'unico posto in
// cui si aggiungono, modificano e rimuovono progetti e cartelle (tratti, collegamenti, import).
// Le estensioni lo usano tramite ctx.projects; dopo ogni modifica parte l'evento
// "core:projects-changed" sul bus.
window.Projects = (() => {
  const { esc, js, toast, openModal, apiClient } = window.UI;
  const { t, fmt } = window.I18n;
  const api = apiClient('/api/core');
  const COLLAPSED_KEY = 'devdock.projectFolders.collapsed';
  let onChange = () => {};

  // Cartelle chiuse: comuni a tutte le sezioni (localStorage può mancare o fallire)
  function collapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { return new Set(); }
  }
  function storeCollapsed(set) {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])); } catch { /* solo per questa sessione */ }
  }

  async function load() {
    const data = await api.get('/projects');
    return data;
  }

  const changed = () => onChange();

  // HTML dell'albero. items: oggetti con un campo folder (progetti, repository…);
  // item(x) restituisce l'HTML della voce. Le cartelle senza voci (vuote, o con progetti di altre
  // sezioni) non si mostrano: si gestiscono nel pannello 📁.
  function tree(folderList, items, item) {
    const closed = collapsed();
    const known = new Set(folderList.map(f => f.id));
    const inFolder = id => items.filter(x => x.folder === id);
    const chevron = open => `<svg class="pf-chevron ${open ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg>`;
    return folderList.filter(f => inFolder(f.id).length).map(f => {
      const children = inFolder(f.id);
      const open = !closed.has(f.id);
      return `<div class="pf-folder ${open ? '' : 'collapsed'}" data-folder="${esc(f.id)}">
        <div class="pf-folder-head" role="button" tabindex="0" aria-expanded="${open}"
             onclick="Projects.toggle(this)" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();Projects.toggle(this)}">
          ${chevron(open)}<span class="pf-folder-icon">📁</span>
          <span class="pf-folder-label">${esc(f.label)}</span>
          <span class="sb-count">${esc(fmt.number(children.length))}</span>
        </div>
        <div class="pf-children">${children.map(item).join('')}</div>
      </div>`;
    }).join('') + items.filter(x => !x.folder || !known.has(x.folder)).map(item).join('');
  }

  // In fondo alle sidebar: quanti progetti non hanno i tratti della sezione (si vedono nel pannello)
  const hiddenNote = count => (count > 0 ? `<button class="pf-hidden-note" onclick="Projects.openPanel()" title="${esc(t('core.projects.hiddenTitle'))}">${esc(t('core.projects.hidden', { count }))}</button>` : '');

  function toggle(head) {
    const box = head.closest('.pf-folder');
    const closed = collapsed();
    const nowOpen = box.classList.contains('collapsed');
    box.classList.toggle('collapsed', !nowOpen);
    head.setAttribute('aria-expanded', String(nowOpen));
    head.querySelector('.pf-chevron')?.classList.toggle('open', nowOpen);
    if (nowOpen) closed.delete(box.dataset.folder); else closed.add(box.dataset.folder);
    storeCollapsed(closed);
  }

  // ---- pannello 📁 Progetti (header): elenco, modulo, rimozione con i collegamenti, import ----

  const PANEL_ID = 'projAdmin';
  let view = { name: 'list' };   // list | form | remove | folder | import
  let data = null;               // ultima risposta di /projects
  let query = '';
  let extNames = new Map();      // codice → nome dell'estensione (collegamenti)
  // il contenuto della modale resta nel DOM anche da chiusa: conta solo se è aperta
  const root = () => (document.getElementById('modalOverlay')?.classList.contains('open') ? document.getElementById(PANEL_ID) : null);
  const traitLabel = id => { const tr = data?.traits.find(x => x.id === id); return tr ? window.I18n.pick(tr.label) : id; };

  async function refreshData() {
    data = await load();
    return data;
  }

  async function openPanel(next = { name: 'list' }) {
    try { await Promise.all([refreshData(), loadExtNames()]); } catch (e) { toast(e.message, 'error'); return; }
    view = next;
    if (!root()) {
      openModal(t('core.projects.panelTitle'), `<div class="pj-admin" id="${PANEL_ID}"></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
      document.getElementById('modal').classList.add('modal-wide');
    }
    render();
  }

  function go(next) { view = next; render(); }

  function render() {
    const el = root();
    if (!el || !data) return;
    if (view.name === 'form') el.innerHTML = renderForm();
    else if (view.name === 'remove') el.innerHTML = renderRemove();
    else if (view.name === 'folder') el.innerHTML = renderFolder();
    else if (view.name === 'import') el.innerHTML = renderImport();
    else { el.innerHTML = renderListShell(); renderList(); }
    el.querySelector('[data-autofocus]')?.focus();
  }

  // dopo ogni modifica: dati di nuovo, sezioni avvisate, ritorno all'elenco
  async function afterChange(message) {
    if (message) toast(message, 'success');
    changed();
    try { await refreshData(); } catch (e) { toast(e.message, 'error'); }
    go({ name: 'list' });
  }

  // ---- elenco ----

  function renderListShell() {
    return `
      <div class="pj-toolbar">
        <input class="form-input pj-search" type="search" value="${esc(query)}" placeholder="${esc(t('core.projects.search'))}"
               oninput="Projects.search(this.value)" data-autofocus>
        <button class="btn btn-primary btn-sm" onclick="Projects.form()">＋ ${esc(t('core.projects.newProject'))}</button>
        <button class="btn btn-ghost btn-sm" onclick="Projects.go({ name: 'folder' })">📁 ${esc(t('core.projects.newFolder'))}</button>
        <button class="btn btn-ghost btn-sm" onclick="Projects.go({ name: 'import' })">⇣ ${esc(t('core.projects.importButton'))}</button>
      </div>
      <div class="pj-list" data-role="pj-list"></div>`;
  }

  function search(value) { query = value; renderList(); }

  function traitChips(p) {
    const add = new Set(p.traits?.add || []), removed = p.traits?.remove || [];
    return p.traitsActive.map(id => `<span class="pj-trait ${add.has(id) && !p.traitsFound.includes(id) ? 'pj-forced' : ''}"
        title="${esc(t(add.has(id) && !p.traitsFound.includes(id) ? 'core.projects.traitForced' : 'core.projects.traitDetected'))}">${esc(traitLabel(id))}</span>`).join('')
      + removed.filter(id => p.traitsFound.includes(id)).map(id => `<span class="pj-trait pj-removed" title="${esc(t('core.projects.traitRemoved'))}">${esc(traitLabel(id))}</span>`).join('');
  }

  function projectRow(p) {
    return `<div class="pj-row ${p.missing ? 'pj-missing' : ''}">
      <div class="pj-main">
        <div class="pj-name">${esc(p.label)} <span class="pj-id">${esc(p.id)}</span>
          ${p.missing ? `<span class="ext-pill ext-pill-err">${esc(t('core.projects.missing'))}</span>` : ''}</div>
        <div class="pj-path" title="${esc(p.path)}">${esc(p.path)}</div>
      </div>
      <div class="pj-traits">${traitChips(p) || `<span class="pj-muted">${esc(t('core.projects.noTraits'))}</span>`}</div>
      <div class="pj-actions">
        <button class="btn btn-ghost btn-sm" onclick="Projects.form(${js(p.id)})" title="${esc(t('core.projects.edit'))}">✎</button>
        <button class="btn btn-ghost btn-sm" onclick="Projects.askRemove(${js(p.id)})" title="${esc(t('core.projects.remove'))}">🗑</button>
      </div>
    </div>`;
  }

  function renderList() {
    const el = root()?.querySelector('[data-role="pj-list"]');
    if (!el) return;
    const q = query.trim().toLowerCase();
    const shown = data.projects.filter(p => !q || p.label.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    const known = new Set(data.folders.map(f => f.id));
    const groups = [
      ...data.folders.map(f => ({ folder: f, items: shown.filter(p => p.folder === f.id) })),
      { folder: null, items: shown.filter(p => !p.folder || !known.has(p.folder)) },
    ].filter(g => g.items.length || (!q && g.folder));
    if (!data.projects.length && !data.folders.length) { el.innerHTML = `<p class="pj-muted pj-empty">${esc(t('core.projects.none'))}</p>`; return; }
    if (!groups.length) { el.innerHTML = `<p class="pj-muted pj-empty">${esc(t('core.projects.noMatch'))}</p>`; return; }
    el.innerHTML = groups.map(g => `
      <div class="pj-group">
        <div class="pj-group-head">
          <span>${g.folder ? `📁 ${esc(g.folder.label)}` : esc(t('core.projects.rootGroup'))}</span>
          <span class="sb-count">${esc(fmt.number(g.items.length))}</span>
          ${g.folder ? `<span class="pj-group-actions">
            <button class="btn btn-ghost btn-sm" onclick="Projects.form(null, { folder: ${js(g.folder.id)} })" title="${esc(t('core.projects.newProject'))}">＋</button>
            <button class="btn btn-ghost btn-sm" onclick="Projects.go({ name: 'folder', id: ${js(g.folder.id)} })" title="${esc(t('core.projects.renameFolder'))}">✎</button>
            <button class="btn btn-ghost btn-sm" onclick="Projects.removeFolder(${js(g.folder.id)})" title="${esc(t('core.projects.deleteFolder'))}">🗑</button>
          </span>` : ''}
        </div>
        ${g.items.map(projectRow).join('') || `<p class="pj-muted pj-empty-folder">${esc(t('core.projects.emptyFolder'))}</p>`}
      </div>`).join('');
  }

  // ---- modulo del progetto: nome, percorso, cartella, tratti ----

  function form(id = null, { folder = '' } = {}) {
    if (!root()) return openPanel({ name: 'form', id, folder });
    go({ name: 'form', id, folder });
  }

  function renderForm() {
    const p = view.id ? data.projects.find(x => x.id === view.id) : null;
    if (view.id && !p) return renderListShell();
    const current = p ? p.folder || '' : view.folder || '';
    const options = [`<option value="">${esc(t('core.projects.noFolder'))}</option>`,
      ...data.folders.map(f => `<option value="${esc(f.id)}" ${f.id === current ? 'selected' : ''}>${esc(f.label)}</option>`)].join('');
    const add = new Set(p?.traits?.add || []), remove = new Set(p?.traits?.remove || []);
    const mode = id => (add.has(id) ? 'add' : remove.has(id) ? 'remove' : 'auto');
    const found = new Set(p?.traitsFound || []);
    const traitRows = data.traits.map(tr => `
      <div class="pj-trait-row">
        <span class="pj-trait">${esc(window.I18n.pick(tr.label))}</span>
        <span class="pj-muted">${esc(tr.source === 'core' ? t('core.projects.traitCore') : t('core.projects.traitFrom', { name: extName(tr.source) }))}</span>
        <span class="pj-muted">${p ? esc(t(found.has(tr.id) ? 'core.projects.detectedYes' : 'core.projects.detectedNo')) : ''}</span>
        <select class="form-input pj-trait-mode" data-trait="${esc(tr.id)}">
          ${['auto', 'add', 'remove'].map(m => `<option value="${m}" ${mode(tr.id) === m ? 'selected' : ''}>${esc(t(`core.projects.traitMode.${m}`))}</option>`).join('')}
        </select>
      </div>`).join('');
    return `
      <div class="pj-form">
        <h4>${esc(t(p ? 'core.projects.editTitle' : 'core.projects.newTitle'))}</h4>
        ${p ? '' : `<div class="form-row"><label>${esc(t('core.projects.id'))}</label><input class="form-input" id="f_proj_id" placeholder="${esc(t('core.projects.idPlaceholder'))}" data-autofocus></div>`}
        <div class="form-row"><label>${esc(t('core.projects.name'))}</label><input class="form-input" id="f_proj_label" value="${esc(p?.label || '')}" placeholder="${esc(t('core.projects.namePlaceholder'))}" ${p ? 'data-autofocus' : ''}></div>
        <div class="form-row"><label>${esc(t('core.projects.path'))}</label><input class="form-input" id="f_proj_path" value="${esc(p?.path || '')}" placeholder="/Users/me/projects/my-app"></div>
        <div class="form-row"><label>${esc(t('core.projects.folder'))}</label><select class="form-input" id="f_proj_folder">${options}</select></div>
        <div class="form-row"><label>${esc(t('core.projects.traits'))}</label>
          <p class="pj-muted pj-hint">${esc(t('core.projects.traitsHint'))}</p>
          <div class="pj-trait-table">${traitRows}</div></div>
        <div class="pj-buttons">
          <button class="btn btn-ghost" onclick="Projects.go({ name: 'list' })">${esc(t('core.action.cancel'))}</button>
          <button class="btn btn-primary" onclick="Projects.save(${js(view.id || '')})">${esc(t(p ? 'core.action.save' : 'core.action.add'))}</button>
        </div>
      </div>`;
  }

  async function save(id) {
    const val = el => (document.getElementById(el)?.value || '').trim();
    const body = { label: val('f_proj_label'), path: val('f_proj_path'), folder: val('f_proj_folder') };
    if (!id) body.id = val('f_proj_id');
    if ((!id && !body.id) || !body.label || !body.path) { toast(t('core.projects.allRequired'), 'error'); return; }
    const modes = [...(root()?.querySelectorAll('[data-trait]') || [])].map(s => [s.dataset.trait, s.value]);
    body.traits = { add: modes.filter(([, m]) => m === 'add').map(([x]) => x), remove: modes.filter(([, m]) => m === 'remove').map(([x]) => x) };
    try {
      if (id) await api.put(`/projects/${encodeURIComponent(id)}`, body);
      else await api.post('/projects', body);
      await afterChange(t(id ? 'core.projects.saved' : 'core.projects.added'));
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---- rimozione: prima cosa resta collegato al progetto nelle estensioni ----

  const extName = code => extNames.get(code) || code;
  async function loadExtNames() {
    if (extNames.size) return;
    try { extNames = new Map((await api.get('/extensions')).map(e => [e.code, window.I18n.pick(e.name)])); } catch { /* restano i codici */ }
  }

  async function askRemove(id) {
    go({ name: 'remove', id, links: null });
    await loadExtNames();
    let links = [];
    try { links = (await api.get(`/projects/${encodeURIComponent(id)}/links`)).links; } catch (e) { toast(e.message, 'error'); }
    if (view.name === 'remove' && view.id === id) go({ name: 'remove', id, links });
  }

  function linkList(links) {
    const byExt = new Map();
    for (const l of links) byExt.set(l.code, [...(byExt.get(l.code) || []), l]);
    return `<ul class="pj-links">${[...byExt].map(([code, items]) => `<li><strong>${esc(extName(code))}</strong>
      <ul>${items.map(l => `<li>${esc(t(`${code}.${l.key}`, l.params || {}))}</li>`).join('')}</ul></li>`).join('')}</ul>`;
  }

  function renderRemove() {
    const p = data.projects.find(x => x.id === view.id);
    if (!p) return renderListShell();
    return `
      <div class="pj-form">
        <h4>${esc(t('core.projects.removeTitle', { name: p.label }))}</h4>
        <p>${esc(t('core.projects.confirmRemove'))}</p>
        ${view.links === null ? `<p class="pj-muted">${esc(t('core.projects.linksLoading'))}</p>`
          : view.links.length ? `<p>${esc(t('core.projects.linksKept'))}</p>${linkList(view.links)}`
          : `<p class="pj-muted">${esc(t('core.projects.noLinks'))}</p>`}
        <div class="pj-buttons">
          <button class="btn btn-ghost" onclick="Projects.go({ name: 'list' })">${esc(t('core.action.cancel'))}</button>
          <button class="btn btn-danger" onclick="Projects.confirmRemove(${js(p.id)})" ${view.links === null ? 'disabled' : ''}>${esc(t('core.projects.remove'))}</button>
        </div>
      </div>`;
  }

  async function confirmRemove(id) {
    try {
      await api.del(`/projects/${encodeURIComponent(id)}`);
      await afterChange(t('core.projects.removed'));
    } catch (e) { toast(e.message, 'error'); }
  }

  // Dalle sidebar (compatibilità): conferma semplice; true se rimosso
  async function remove(id) {
    if (!confirm(t('core.projects.confirmRemove'))) return false;
    try {
      await api.del(`/projects/${encodeURIComponent(id)}`);
      toast(t('core.projects.removed'), 'success');
      changed();
      return true;
    } catch (e) { toast(e.message, 'error'); return false; }
  }

  // ---- cartelle nel pannello ----

  function renderFolder() {
    const f = view.id ? data.folders.find(x => x.id === view.id) : null;
    return `
      <div class="pj-form">
        <h4>${esc(t(f ? 'core.projects.renameFolder' : 'core.projects.newFolder'))}</h4>
        <div class="form-row"><label>${esc(t('core.projects.folderName'))}</label>
          <input class="form-input" id="f_folder_label" value="${esc(f?.label || '')}" placeholder="${esc(t('core.projects.folderPlaceholder'))}" data-autofocus
                 onkeydown="if(event.key==='Enter')Projects.savePanelFolder(${js(view.id || '')})"></div>
        <div class="pj-buttons">
          <button class="btn btn-ghost" onclick="Projects.go({ name: 'list' })">${esc(t('core.action.cancel'))}</button>
          <button class="btn btn-primary" onclick="Projects.savePanelFolder(${js(view.id || '')})">${esc(t(f ? 'core.action.save' : 'core.action.add'))}</button>
        </div>
      </div>`;
  }

  async function savePanelFolder(id) {
    const label = (document.getElementById('f_folder_label')?.value || '').trim();
    if (!label) { toast(t('core.projects.folderNameRequired'), 'error'); return; }
    try {
      if (id) await api.put(`/folders/${encodeURIComponent(id)}`, { label });
      else await api.post('/folders', { label });
      await afterChange();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function removeFolder(id) {
    const f = data.folders.find(x => x.id === id);
    if (!confirm(t('core.projects.confirmDeleteFolder', { name: f?.label || id }))) return;
    try {
      await api.del(`/folders/${encodeURIComponent(id)}`);
      await afterChange();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---- import da una cartella ----

  function renderImport() {
    const scan = view.scan;
    const options = [`<option value="">${esc(t('core.projects.noFolder'))}</option>`,
      ...data.folders.map(f => `<option value="${esc(f.id)}">${esc(f.label)}</option>`)].join('');
    const rows = scan ? scan.candidates.map((c, i) => `
      <label class="pj-row pj-candidate ${c.added ? 'pj-added' : ''}">
        <input type="checkbox" data-candidate="${i}" ${c.added ? 'disabled' : 'checked'}>
        <div class="pj-main">
          <div class="pj-name">${esc(c.label)} ${c.added ? `<span class="ext-pill">${esc(t('core.projects.alreadyAdded'))}</span>` : ''}</div>
          <div class="pj-path" title="${esc(c.path)}">${esc(c.path)}</div>
        </div>
        <div class="pj-traits">${c.traits.map(id => `<span class="pj-trait">${esc(traitLabel(id))}</span>`).join('')}</div>
      </label>`).join('') : '';
    return `
      <div class="pj-form">
        <h4>${esc(t('core.projects.importTitle'))}</h4>
        <p class="pj-muted pj-hint">${esc(t('core.projects.importHint'))}</p>
        <div class="pj-toolbar">
          <input class="form-input pj-search" id="f_import_path" value="${esc(view.path || '')}" placeholder="/Users/me/projects" data-autofocus
                 onkeydown="if(event.key==='Enter')Projects.scan()">
          <button class="btn btn-primary btn-sm" onclick="Projects.scan()">${esc(t('core.projects.scan'))}</button>
        </div>
        ${!scan ? '' : !scan.candidates.length ? `<p class="pj-muted pj-empty">${esc(t('core.projects.scanEmpty'))}</p>` : `
          <div class="pj-list">${rows}</div>
          <div class="form-row"><label>${esc(t('core.projects.importInto'))}</label><select class="form-input" id="f_import_folder">${options}</select></div>`}
        <div class="pj-buttons">
          <button class="btn btn-ghost" onclick="Projects.go({ name: 'list' })">${esc(t('core.action.cancel'))}</button>
          ${scan?.candidates.some(c => !c.added) ? `<button class="btn btn-primary" onclick="Projects.importChosen()">${esc(t('core.projects.importSubmit'))}</button>` : ''}
        </div>
      </div>`;
  }

  async function scan() {
    const dir = (document.getElementById('f_import_path')?.value || '').trim();
    if (!dir) return;
    try { go({ name: 'import', path: dir, scan: await api.post('/projects/scan', { path: dir }) }); } catch (e) { toast(e.message, 'error'); }
  }

  async function importChosen() {
    const chosen = [...(root()?.querySelectorAll('[data-candidate]:checked') || [])].map(b => view.scan.candidates[Number(b.dataset.candidate)].path);
    if (!chosen.length) { toast(t('core.projects.importNone'), 'error'); return; }
    try {
      const r = await api.post('/projects/import', { paths: chosen, folder: document.getElementById('f_import_folder')?.value || '' });
      await afterChange(t('core.projects.imported', { count: r.added.length }));
    } catch (e) { toast(e.message, 'error'); }
  }

  return {
    // usato dalla shell per collegare il bus
    setOnChange(fn) { onChange = fn; },
    load, tree, hiddenNote, toggle, form, save, remove,
    newFolder: () => (root() ? go({ name: 'folder' }) : openPanel({ name: 'folder' })),
    // pannello 📁
    openPanel, go, search, askRemove, confirmRemove, savePanelFolder, removeFolder, scan, importChosen,
  };
})();
