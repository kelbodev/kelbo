// Pannello Estensioni (pulsante 🧩 nell'header): estensioni incluse e installate con stato,
// accensione e spegnimento, aggiornamenti, ritorno alla versione precedente, rimozione;
// catalogo con ricerca, installazione da URL git con anteprima e avanzamento in diretta,
// estensioni da installare dall'elenco importato, cataloghi configurati.
window.Extensions = (() => {
  const { esc, js, toast, openModal, closeModal, apiClient, cssColor } = window.UI;
  const { t, fmt } = window.I18n;
  const pick = v => window.I18n.pick(v);
  const api = apiClient('/api/core');

  let data = null;        // /extensions-admin
  let catalog = null;     // /extensions-admin/catalog
  let tab = 'installed';
  let search = '';
  let kind = ''; // filtro per tipo: '' tutti, component, provider, theme
  const KINDS = ['component', 'provider', 'theme'];
  const kindTags = list => (list || []).map(k => `<span class="ext-pill ext-kind ext-kind-${esc(k)}" title="${esc(t(`core.ext.kindHint.${k}`))}">${esc(t(`core.ext.kind.${k}`))}</span>`).join('');
  const ofKind = e => !kind || (e.kinds || []).includes(kind);
  const kindFilter = () => `<div class="ext-kinds">${['', ...KINDS].map(k => `<button class="ext-kind-btn ${k === kind ? 'active' : ''}" onclick="Extensions.kind(${js(k)})">${esc(t(k ? `core.ext.kindPlural.${k}` : 'core.ext.kindAll'))}</button>`).join('')}</div>`;
  let preview = null;     // anteprima mostrata
  let busy = false;
  let progress = null;    // { steps: [], log: '' } durante l'installazione

  // ---- badge nell'header: aggiornamenti disponibili ed estensioni da installare ----

  function renderBadge() {
    const badge = document.getElementById('extAdminBadge');
    if (!badge || !data) return;
    const n = data.extensions.filter(e => e.update?.available || e.update?.moved).length + data.pending.length;
    badge.style.display = n ? '' : 'none';
    badge.textContent = n ? fmt.number(n) : '';
    document.getElementById('extAdminBtn').title = n ? t('core.ext.badgeTitle', { count: n }) : t('core.ext.buttonTitle');
  }

  async function load() {
    try { data = await api.get('/extensions-admin'); } catch (e) { toast(e.message, 'error'); return false; }
    renderBadge();
    return true;
  }

  async function init() {
    await load();
    setInterval(load, 3600 * 1000); // il server controlla una volta al giorno: il badge segue
  }

  // ---- pannello ----

  async function open() {
    preview = null; progress = null;
    if (!(await load())) return;
    openModal(t('core.ext.title'), '<div class="ext-admin" id="extAdmin"></div>',
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
    document.getElementById('modal').classList.add('modal-wide');
    render();
    if (!catalog) loadCatalog(); // versioni nuove nel catalogo → controllo degli aggiornamenti subito
  }

  const root = () => document.getElementById('extAdmin');

  function render() {
    const el = root();
    if (!el) return;
    if (progress) { el.innerHTML = renderProgress(); return; }
    if (preview) { el.innerHTML = renderPreview(); return; }
    const tabs = ['installed', 'catalog', 'url', 'settings'];
    el.innerHTML = `
      <div class="ext-admin-tabs">${tabs.map(x => `<button class="ext-admin-tab ${x === tab ? 'active' : ''}" onclick="Extensions.tab(${js(x)})">${esc(t(`core.ext.tabs.${x}`))}${x === 'installed' && data.pending.length ? ` <span class="ext-admin-count">${esc(fmt.number(data.pending.length))}</span>` : ''}</button>`).join('')}</div>
      <div class="ext-admin-body">${tab === 'installed' ? renderInstalled() : tab === 'catalog' ? renderCatalog() : tab === 'url' ? renderUrl() : renderSettings()}</div>`;
    if (tab === 'catalog' && !catalog) loadCatalog();
  }

  const stateLabel = e => {
    if (e.state === 'off') return `<span class="ext-pill ext-pill-off">${esc(t('core.ext.state.off'))}</span>`;
    if (e.state === 'disabled') return `<span class="ext-pill ext-pill-err">${esc(t('core.ext.state.disabled'))}</span>`;
    if (e.state === 'warning') return `<span class="ext-pill ext-pill-warn">${esc(t('core.ext.state.warning'))}</span>`;
    return `<span class="ext-pill ext-pill-ok">${esc(t('core.ext.state.ok'))}</span>`;
  };

  const sourceLabel = e => (e.source === 'builtin' ? t('core.ext.source.builtin')
    : e.lock ? `${e.lock.repo}${e.lock.path ? ` · ${e.lock.path}` : ''}${e.lock.tag ? ` @ ${e.lock.tag}` : ''}` : t('core.ext.source.local'));

  function renderInstalled() {
    const row = e => {
      const duplicate = e.duplicate;
      const upd = e.update;
      return `<div class="ext-row">
        <div class="ext-icon" style="--c:${UI.extColor(e.code, e.color)}">${UI.iconOrText(e.icon)}</div>
        <div class="ext-info">
          <div class="ext-name">${esc(pick(e.name))} <span class="ext-muted">${esc(e.code)} · ${esc(e.version || '?')}</span> ${stateLabel(e)} ${kindTags(e.kinds)}
            ${upd?.available ? `<span class="ext-pill ext-pill-upd">${esc(t('core.ext.updateAvailable', { version: upd.latest || '' }))}</span>` : ''}
            ${upd?.moved ? `<span class="ext-pill ext-pill-warn" title="${esc(t('core.ext.movedTitle'))}">${esc(t('core.ext.moved'))}</span>` : ''}</div>
          <div class="ext-muted ext-desc">${esc(pick(e.description))}</div>
          <div class="ext-muted ext-source" title="${esc(sourceLabel(e))}">${esc(sourceLabel(e))}</div>
          ${e.error ? `<div class="ext-error">${esc(window.I18n.errorText(e.errorInfo, e.error))}</div>` : ''}
          ${e.warnings?.length ? `<div class="ext-warn">${esc((e.warningInfo || e.warnings).map(w => window.I18n.errorText(w)).join(' · '))}</div>` : ''}
          ${duplicate ? '' : `<div class="ext-controls">
            <label class="ext-toggle" title="${esc(t(e.state === 'off' ? 'core.ext.enable' : 'core.ext.disable'))}">
              <span class="ext-switch"><input type="checkbox" ${e.state === 'off' ? '' : 'checked'} ${busy ? 'disabled' : ''} onchange="Extensions.toggle(${js(e.code)}, this.checked)"><span></span></span>
              ${esc(t('core.ext.enabledLabel'))}</label>
            ${e.frontend?.js && e.manifestPosition ? `<label class="ext-toggle">${esc(t('core.ext.positionLabel'))}
              <select class="form-input ext-position" title="${esc(t('core.ext.positionTitle'))}" ${busy ? 'disabled' : ''} onchange="Extensions.position(${js(e.code)}, this.value)">
              ${['tab', 'header'].map(p => `<option value="${p}" ${p === e.position ? 'selected' : ''}>${esc(t(`core.ext.position.${p}`))}${p === e.manifestPosition ? ` ${esc(t('core.ext.position.default'))}` : ''}</option>`).join('')}
              </select></label>` : ''}
          </div>`}
        </div>
        <div class="ext-actions">
          ${e.source === 'installed' && upd?.available ? `<button class="btn btn-primary btn-sm" onclick="Extensions.update(${js(e.code)})">${esc(t('core.ext.update'))}</button>` : ''}
          ${e.source === 'installed' && e.hasBackup ? `<button class="btn btn-ghost btn-sm" onclick="Extensions.restore(${js(e.code)})" title="${esc(t('core.ext.restoreTitle', { version: e.lock?.previous || '' }))}">${esc(t('core.ext.restore'))}</button>` : ''}
          ${e.source === 'installed' ? `<button class="btn btn-ghost btn-sm ext-danger" onclick="Extensions.remove(${js(e.code)})">${esc(t('core.ext.remove'))}</button>` : ''}
        </div>
      </div>`;
    };
    const builtin = data.extensions.filter(e => e.source === 'builtin' && ofKind(e));
    const installed = data.extensions.filter(e => e.source !== 'builtin' && ofKind(e));
    return `
      ${kindFilter()}
      ${data.pending.length ? `<div class="ext-section"><h4>${esc(t('core.ext.pendingTitle'))}</h4><p class="ext-muted">${esc(t('core.ext.pendingHint'))}</p>
        ${data.pending.map(p => `<div class="ext-row"><div class="ext-icon">${UI.icon('download')}</div><div class="ext-info"><div class="ext-name">${esc(p.code)}</div>
          <div class="ext-muted ext-source">${esc(p.repo)}${p.path ? ` · ${esc(p.path)}` : ''}${p.tag ? ` @ ${esc(p.tag)}` : ''}</div></div>
          <div class="ext-actions"><button class="btn btn-primary btn-sm" onclick="Extensions.previewPending(${js(p.code)})">${esc(t('core.ext.install'))}</button></div></div>`).join('')}</div>` : ''}
      <div class="ext-section"><h4>${esc(t('core.ext.installedTitle'))} <span class="ext-muted">(${esc(fmt.number(installed.length))})</span></h4>
        ${installed.length ? installed.map(row).join('') : `<p class="ext-muted">${esc(t('core.ext.noneInstalled'))}</p>`}</div>
      <div class="ext-section"><h4>${esc(t('core.ext.builtinTitle'))} <span class="ext-muted">(${esc(fmt.number(builtin.length))})</span></h4>
        <p class="ext-muted">${esc(t('core.ext.builtinHint', { version: data.coreVersion }))}</p>
        ${builtin.map(row).join('')}</div>
      <div class="ext-foot">
        <span class="ext-muted">${esc(data.updatesCheckedAt ? t('core.ext.checkedAt', { when: fmt.relative(data.updatesCheckedAt) }) : t('core.ext.neverChecked'))}</span>
        <button class="btn btn-ghost btn-sm" onclick="Extensions.checkUpdates()" ${busy ? 'disabled' : ''}>${esc(t('core.ext.checkUpdates'))}</button>
      </div>`;
  }

  let catalogLoading = null;
  function loadCatalog(refresh = false) {
    if (!refresh && catalogLoading) return catalogLoading;
    catalogLoading = fetchCatalog(refresh).finally(() => { catalogLoading = null; });
    return catalogLoading;
  }
  async function fetchCatalog(refresh) {
    try { catalog = await api.get(`/extensions-admin/catalog${refresh ? '?refresh=1' : ''}`); }
    catch (e) { catalog = { catalogs: [], extensions: [], error: e.message }; }
    // il server ha rifatto il controllo degli aggiornamenti (il catalogo ne mostrava di nuovi):
    // elenco delle installate e badge li seguono
    if (catalog.updatesCheckedAt && catalog.updatesCheckedAt !== data?.updatesCheckedAt) await load();
    if (root() && !preview && !progress) render();
  }

  function renderCatalog() {
    if (!catalog) return `<p class="ext-muted">${esc(t('core.ext.loading'))}</p>`;
    const q = search.trim().toLowerCase();
    const list = catalog.extensions.filter(e => ofKind(e) && (!q || [e.code, pick(e.name), pick(e.description)].some(x => String(x || '').toLowerCase().includes(q))));
    const failed = catalog.catalogs.filter(c => !c.ok);
    return `
      <div class="ext-search"><input class="form-input" type="search" value="${esc(search)}" placeholder="${esc(t('core.ext.search'))}" oninput="Extensions.search(this.value)">
        <button class="btn btn-ghost btn-sm" onclick="Extensions.reloadCatalog()" title="${esc(t('core.action.refresh'))}">${UI.icon('refresh-cw')}</button></div>
      ${kindFilter()}
      ${failed.map(c => `<p class="ext-warn">${esc(t('core.ext.catalogFailed', { url: c.url, error: c.error }))}</p>`).join('')}
      ${list.length ? list.map(e => `<div class="ext-row">
          <div class="ext-icon">${UI.iconOrText(e.icon)}</div>
          <div class="ext-info"><div class="ext-name">${esc(pick(e.name))} <span class="ext-muted">${esc(e.code)}${e.version ? ` · ${esc(e.version)}` : ''}</span>
            ${kindTags(e.kinds)}
            ${e.installed ? `<span class="ext-pill ext-pill-ok">${esc(t('core.ext.alreadyInstalled', { version: e.installed.version || '' }))}</span>` : ''}
            ${e.update?.available ? `<span class="ext-pill ext-pill-upd">${esc(t('core.ext.updateAvailable', { version: e.update.latest || '' }))}</span>` : ''}</div>
            <div class="ext-muted ext-desc">${esc(pick(e.description))}</div>
            <div class="ext-muted ext-source">${esc(e.repo)}${e.path ? ` · ${esc(e.path)}` : ''}</div></div>
          <div class="ext-actions">${!e.installed ? `<button class="btn btn-primary btn-sm" onclick="Extensions.previewCatalog(${js(e.code)})">${esc(t('core.ext.install'))}</button>`
            : e.update?.available ? `<button class="btn btn-primary btn-sm" onclick="Extensions.update(${js(e.code)})">${esc(t('core.ext.update'))}</button>` : ''}</div>
        </div>`).join('') : `<p class="ext-muted">${esc(t(catalog.extensions.length ? 'core.ext.noMatch' : 'core.ext.catalogEmpty'))}</p>`}`;
  }

  function renderUrl() {
    return `
      <p class="ext-muted">${esc(t('core.ext.urlHint'))}</p>
      <div class="form-row"><label>${esc(t('core.ext.repo'))}</label><input class="form-input" id="f_ext_repo" placeholder="https://github.com/user/repo.git" spellcheck="false"
        onkeydown="if(event.key==='Enter')Extensions.previewUrl()"></div>
      <div class="form-row"><label>${esc(t('core.ext.folder'))}</label><input class="form-input" id="f_ext_folder" placeholder="tools/my-extension" spellcheck="false"
        onkeydown="if(event.key==='Enter')Extensions.previewUrl()"><p class="ext-muted">${esc(t('core.ext.folderHint'))}</p></div>
      <button class="btn btn-primary" onclick="Extensions.previewUrl()" ${busy ? 'disabled' : ''}>${esc(t('core.ext.preview'))}</button>`;
  }

  function renderSettings() {
    return `
      <div class="form-row"><label>${esc(t('core.ext.catalogs'))}</label>
        <textarea class="form-input ext-code" id="f_ext_catalogs" rows="4" spellcheck="false">${esc(data.catalogs.join('\n'))}</textarea>
        <p class="ext-muted">${esc(t('core.ext.catalogsHint'))}</p></div>
      <button class="btn btn-primary" onclick="Extensions.saveCatalogs()">${esc(t('core.action.save'))}</button>`;
  }

  // ---- anteprima e installazione ----

  async function showPreview(request, back = tab) {
    if (busy) return;
    busy = true;
    const el = root();
    if (el) el.insertAdjacentHTML('afterbegin', `<p class="ext-muted ext-wait">${esc(t('core.ext.previewing'))}</p>`);
    try {
      preview = await api.post(request.update ? `/extensions-admin/${encodeURIComponent(request.update)}/update` : '/extensions-admin/preview', request.body);
      preview.back = back;
      preview.isUpdate = !!request.update;
    } catch (e) { toast(e.message, 'error'); }
    busy = false;
    render();
  }

  function renderPreview() {
    const p = preview;
    const deps = p.dependencies.map(d => `<li>${esc(d.code)} ${d.required ? '' : `<span class="ext-muted">(${esc(t('core.ext.optional'))})</span>`}
      ${d.installed ? `<span class="ext-pill ext-pill-ok">${esc(t('core.ext.present'))}</span>`
        : d.available ? `<button class="btn btn-ghost btn-sm" onclick="Extensions.previewCatalog(${js(d.code)})">${esc(t('core.ext.installFirst'))}</button>`
        : `<span class="ext-pill ext-pill-err">${esc(t('core.ext.notAvailable'))}</span>`}</li>`).join('');
    const blocked = !p.compatible || p.missing.length || p.builtin;
    return `
      <div class="ext-preview">
        <div class="ext-row ext-row-head">
          <div class="ext-icon" style="--c:${cssColor(p.color)}">${UI.iconOrText(p.icon)}</div>
          <div class="ext-info"><div class="ext-name">${esc(pick(p.name))} <span class="ext-muted">${esc(p.code)}</span></div>
            <div class="ext-muted ext-desc">${esc(pick(p.description))}</div>
            <div class="ext-muted ext-source">${esc(p.repo)}${p.path ? ` · ${esc(p.path)}` : ''} · ${esc(p.commit.slice(0, 10))}</div></div>
        </div>
        <div class="form-row"><label>${esc(t('core.ext.version'))}</label>
          ${p.versions.length ? `<select class="form-input ext-version" onchange="Extensions.pickVersion(this.value)">
            ${p.versions.map(v => `<option value="${esc(v.tag)}" ${v.tag === p.tag ? 'selected' : ''}>${esc(v.version)} (${esc(v.tag)})</option>`).join('')}</select>`
            : `<p class="ext-warn">${esc(t('core.ext.noTags', { version: p.version }))}</p>`}
          ${p.installed ? `<p class="ext-muted">${esc(t('core.ext.installedVersion', { version: p.installed.version || '?' }))}</p>` : ''}</div>
        ${p.compatible ? '' : `<p class="ext-error">${esc(t('core.ext.incompatible', { range: p.kelbo ?? p.devdock, version: p.coreVersion }))}</p>`}
        ${p.builtin ? `<p class="ext-error">${esc(t('core.ext.builtinConflict', { code: p.code }))}</p>` : ''}
        ${deps ? `<div class="form-row"><label>${esc(t('core.ext.dependencies'))}</label><ul class="ext-deps">${deps}</ul>
          ${p.missing.length ? `<p class="ext-error">${esc(t('core.ext.missingDeps', { list: fmt.list(p.missing) }))}</p>` : ''}</div>` : ''}
        ${p.hasNpmDependencies ? `<p class="ext-muted">${esc(t('core.ext.npmHint'))}</p>` : ''}
        ${p.reloadable ? '' : `<p class="ext-warn">${esc(t('core.ext.restartHint'))}</p>`}
        ${p.changelog ? `<div class="form-row"><label>${esc(t('core.ext.changelog'))}</label><pre class="ext-changelog">${esc(p.changelog)}</pre></div>` : ''}
        <p class="ext-warn ext-security">${UI.icon('triangle-alert')} ${esc(t('core.ext.security'))}</p>
        <div class="ext-preview-actions">
          <button class="btn btn-ghost" onclick="Extensions.back()">${esc(t('core.action.cancel'))}</button>
          <button class="btn btn-primary" onclick="Extensions.install()" ${blocked ? 'disabled' : ''}>${esc(t(p.isUpdate ? 'core.ext.updateTo' : 'core.ext.installVersion', { version: p.version }))}</button>
        </div>
      </div>`;
  }

  function renderProgress() {
    const done = progress.result;
    return `
      <div class="ext-progress">
        <h4>${esc(t('core.ext.installing', { name: pick(preview?.name || progress.code) }))}</h4>
        <ul class="ext-steps">${progress.steps.map(s => `<li>${UI.icon('check')} ${esc(t(`core.ext.steps.${s}`))}</li>`).join('')}${done || progress.error ? '' : '<li class="ext-muted">…</li>'}</ul>
        ${progress.log ? `<pre class="ext-changelog">${esc(progress.log.slice(-6000))}</pre>` : ''}
        ${progress.error ? `<p class="ext-error">${esc(progress.error)}</p>` : ''}
        ${done ? `<p class="${done.restartRequired ? 'ext-warn' : 'ext-ok'}">${esc(done.restartRequired ? t('core.ext.restartNeeded') : done.state === 'ok' || done.state === 'warning' ? t('core.ext.installed', { name: pick(preview?.name || done.code), version: done.version }) : t('core.ext.installedNotLoaded', { error: done.error || '' }))}</p>` : ''}
        ${done || progress.error ? `<button class="btn btn-primary" onclick="Extensions.finish()">${esc(t('core.action.close'))}</button>` : ''}
      </div>`;
  }

  async function install() {
    progress = { code: preview.code, steps: [], log: '', result: null, error: null };
    render();
    try {
      const res = await fetch('/api/core/extensions-admin/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: preview.id }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          let ev; try { ev = JSON.parse(part.replace(/^data: /, '')); } catch { continue; }
          if (ev.type === 'step' && ev.data.key !== 'done') progress.steps.push(ev.data.key);
          else if (ev.type === 'log') progress.log += ev.data;
          else if (ev.type === 'error') progress.error = window.I18n.errorText(ev.data, ev.data.error);
          else if (ev.type === 'done') progress.result = ev.data;
          render();
        }
      }
    } catch (e) { progress.error = e.message; }
    if (progress.result) await window.Shell.syncExtensions();
    catalog = null;
    await load();
    render();
  }

  async function act(fn) {
    if (busy) return;
    busy = true;
    render(); // comandi disattivati finché l'azione non finisce
    try {
      const r = await fn();
      if (r?.restartRequired) toast(t('core.ext.restartNeeded'), 'info');
      await window.Shell.syncExtensions();
    } catch (e) { toast(e.message, 'error'); }
    busy = false;
    catalog = null; // "già installata" nel catalogo segue installazioni e rimozioni
    await load();
    render();
  }

  return {
    init, open, load,
    tab(x) { tab = x; render(); },
    kind(k) { kind = KINDS.includes(k) ? k : ''; render(); },
    search(v) { search = v; const el = root(); const pos = el?.querySelector('input[type=search]')?.selectionStart; render(); const input = root()?.querySelector('input[type=search]'); input?.focus(); if (pos != null) input?.setSelectionRange(pos, pos); },
    reloadCatalog() { catalog = null; render(); loadCatalog(true); },
    position(code, position) { act(() => api.put(`/layout/positions/${encodeURIComponent(code)}`, { position })); },
    toggle(code, enabled) { act(() => api.post(`/extensions-admin/${encodeURIComponent(code)}/enabled`, { enabled })); },
    restore(code) {
      const e = data.extensions.find(x => x.code === code && x.source === 'installed');
      if (!confirm(t('core.ext.confirmRestore', { name: pick(e.name), version: e.lock?.previous || '?' }))) return;
      act(() => api.post(`/extensions-admin/${encodeURIComponent(code)}/restore`));
    },
    remove(code) {
      const e = data.extensions.find(x => x.code === code && x.source === 'installed');
      if (!confirm(t('core.ext.confirmRemove', { name: pick(e.name) }))) return;
      act(() => api.del(`/extensions-admin/${encodeURIComponent(code)}`));
    },
    async checkUpdates() {
      busy = true; render();
      try { await api.post('/extensions-admin/updates'); } catch (e) { toast(e.message, 'error'); }
      busy = false;
      await load(); render();
    },
    update(code) { showPreview({ update: code, body: {} }); },
    previewCatalog(code) { showPreview({ body: { code } }, 'catalog'); },
    previewPending(code) {
      const p = data.pending.find(x => x.code === code);
      showPreview({ body: { source: p.repo, folder: p.path || undefined, tag: p.tag || undefined, code: p.code } }, 'installed');
    },
    previewUrl() {
      const source = document.getElementById('f_ext_repo').value.trim();
      if (!source) { toast(t('core.ext.repoRequired'), 'error'); return; }
      showPreview({ body: { source, folder: document.getElementById('f_ext_folder').value.trim() || undefined } }, 'url');
    },
    pickVersion(tag) {
      const p = preview;
      preview = null;
      showPreview(p.isUpdate ? { update: p.code, body: { tag } } : { body: { source: p.repo, folder: p.path || undefined, tag, code: p.code } }, p.back);
    },
    install,
    back() { tab = preview?.back || tab; preview = null; render(); },
    finish() { tab = 'installed'; preview = null; progress = null; catalog = null; render(); },
    async saveCatalogs() {
      const catalogs = document.getElementById('f_ext_catalogs').value.split('\n').map(x => x.trim()).filter(Boolean);
      try { await api.put('/extensions-admin/catalogs', { catalogs }); catalog = null; toast(t('core.ext.catalogsSaved'), 'success'); await load(); render(); }
      catch (e) { toast(e.message, 'error'); }
    },
  };
})();
