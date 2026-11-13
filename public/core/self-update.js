// Aggiornamento di Kelbo stesso, in cima al pannello Estensioni: versione in uso, versione nuova
// con le novità del CHANGELOG, conferma con quello che si ferma al riavvio, avanzamento in
// diretta, riavvio tramite PM2 (la pagina aspetta la nuova versione e si ricarica) o a mano.
window.SelfUpdate = (() => {
  const { esc, toast, openModal, closeModal, apiClient } = window.UI;
  const { t, fmt } = window.I18n;
  const api = apiClient('/api/core');
  const RESTART_TIMEOUT_MS = 120000;

  let info = null;     // GET /update
  let checking = false;

  async function load() {
    try { info = await api.get('/update'); } catch { info = null; }
    return info;
  }
  const available = () => !!info?.available;

  // Riga in cima alla scheda Installate
  function sectionHtml() {
    if (!info) return '';
    const co = info.checkout || {};
    let state;
    if (!co.git) state = `<span class="ext-muted">${esc(t('core.update.notGit'))}</span>`;
    else if (info.error === 'unreachable') state = `<span class="ext-warn">${esc(t('core.update.unreachable'))}</span>`;
    else if (info.error === 'no_origin') state = `<span class="ext-muted">${esc(t('core.update.noOrigin'))}</span>`;
    else if (info.available) state = `<span class="ext-pill ext-pill-upd">${esc(t('core.update.available', { version: info.latest }))}</span>`;
    else if (info.checkedAt) state = `<span class="ext-pill ext-pill-ok">${esc(t('core.update.upToDate'))}</span>`;
    else state = `<span class="ext-muted">${esc(t('core.update.notChecked'))}</span>`;
    const dirty = co.git && !co.clean;
    return `<div class="ext-section self-update">
      <div class="ext-row">
        <div class="ext-icon self-update-icon">${UI.icon('rocket')}</div>
        <div class="ext-info">
          <div class="ext-name">Kelbo <span class="ext-muted">${esc(info.current)}</span> ${state}</div>
          <div class="ext-muted ext-source">${esc(co.git ? `${co.origin || ''}${co.branch ? ` · ${co.branch}` : ''} · ${co.commit}` : '')}
            ${info.checkedAt ? ` · ${esc(t('core.ext.checkedAt', { when: fmt.relative(info.checkedAt) }))}` : ''}</div>
          ${dirty ? `<div class="ext-warn">${esc(t('core.update.dirty', { count: co.changes }))}</div>` : ''}
          ${info.restart?.managed ? '' : co.git ? `<div class="ext-muted">${esc(t('core.update.noPm2'))}</div>` : ''}
        </div>
        <div class="ext-actions">
          ${info.available ? `<button class="btn btn-ghost btn-sm" onclick="SelfUpdate.whatsNew()">${esc(t('core.update.whatsNew'))}</button>
            <button class="btn btn-primary btn-sm" onclick="SelfUpdate.start()" ${dirty ? 'disabled' : ''}>${esc(t('core.update.update'))}</button>` : ''}
          ${info.previous && co.git ? `<button class="btn btn-ghost btn-sm" onclick="SelfUpdate.rollback()" ${dirty ? 'disabled' : ''} title="${esc(t('core.update.rollbackTitle', { version: info.previous }))}">${esc(t('core.update.rollback'))}</button>` : ''}
          ${co.git && co.origin ? `<button class="btn btn-ghost btn-sm" onclick="SelfUpdate.check()" ${checking ? 'disabled' : ''}>${esc(t('core.update.check'))}</button>` : ''}
        </div>
      </div></div>`;
  }

  async function check() {
    checking = true; window.Extensions.refresh?.();
    try { info = await api.post('/update/check'); } catch (e) { toast(e.message, 'error'); }
    checking = false;
    await window.Extensions.refresh?.();
  }

  const changelogHtml = text => (text ? `<pre class="ext-changelog self-update-log">${esc(text)}</pre>` : `<p class="ext-muted">${esc(t('core.update.noChangelog'))}</p>`);

  async function whatsNew() {
    try {
      const c = await api.get(`/update/changelog?tag=${encodeURIComponent(info.tag)}`);
      openModal(t('core.update.whatsNewTitle', { version: c.version }), changelogHtml(c.changelog),
        `<button class="btn btn-ghost" onclick="Extensions.open()">${esc(t('core.update.back'))}</button>
         <button class="btn btn-primary" onclick="SelfUpdate.start()">${esc(t('core.update.update'))}</button>`);
      document.getElementById('modal').classList.add('modal-wide');
    } catch (e) { toast(e.message, 'error'); }
  }

  // Conferma: novità, quello che si ferma al riavvio, come avverrà il riavvio
  async function confirmDialog({ title, version, changelog, action }) {
    let running = [];
    try { running = (await api.get('/update/running')).running; } catch { /* niente elenco */ }
    const managed = info?.restart?.managed;
    openModal(title, `
      ${changelog !== undefined ? changelogHtml(changelog) : ''}
      <div class="self-update-stops">
        <strong>${esc(t('core.update.stopsTitle'))}</strong>
        ${running.length ? `<ul>${running.map(r => `<li>${esc(t(`${r.code}.${r.key}`, r.params))}</li>`).join('')}</ul>` : `<p class="ext-muted">${esc(t('core.update.stopsNone'))}</p>`}
      </div>
      <p class="ext-muted">${esc(t(managed ? 'core.update.restartPm2' : 'core.update.restartManual'))}</p>`,
      `<button class="btn btn-ghost" onclick="Extensions.open()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" id="selfUpdateGo">${esc(t(action === 'rollback' ? 'core.update.rollbackTo' : 'core.update.updateTo', { version }))}</button>`);
    document.getElementById('modal').classList.add('modal-wide');
    document.getElementById('selfUpdateGo').addEventListener('click', () => run(action, version));
  }

  async function start() {
    if (!info?.available) return;
    let changelog = null;
    try { changelog = (await api.get(`/update/changelog?tag=${encodeURIComponent(info.tag)}`)).changelog; } catch { /* senza novità */ }
    confirmDialog({ title: t('core.update.confirmTitle', { version: info.latest }), version: info.latest, changelog, action: 'update' });
  }
  function rollback() {
    if (!info?.previous) return;
    confirmDialog({ title: t('core.update.rollbackConfirm', { version: info.previous }), version: info.previous, action: 'rollback' });
  }

  // Avanzamento: passi, output di git e npm, poi riavvio
  async function run(action, version) {
    const state = { steps: [], log: '', error: null, result: null };
    const draw = () => {
      document.getElementById('modalBody').innerHTML = `<div class="ext-progress">
        <ul class="ext-steps">${state.steps.map(s => `<li>${UI.icon('check')} ${esc(t(`core.update.steps.${s.key}`, s.params || {}))}</li>`).join('')}${state.result || state.error ? '' : '<li class="ext-muted">…</li>'}</ul>
        ${state.log ? `<pre class="ext-changelog">${esc(state.log.slice(-8000))}</pre>` : ''}
        ${state.error ? `<p class="ext-error">${esc(state.error)}</p>${state.files?.length ? `<pre class="ext-changelog">${esc(state.files.join('\n'))}</pre>` : ''}` : ''}
      </div>`;
    };
    openModal(t(action === 'rollback' ? 'core.update.rollingBack' : 'core.update.updating', { version }), '', '');
    document.getElementById('modal').classList.add('modal-wide');
    draw();
    try {
      const res = await fetch(`/api/core/update${action === 'rollback' ? '/rollback' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'rollback' ? {} : { tag: info?.tag }) });
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
          if (ev.type === 'step') state.steps.push(ev.data);
          else if (ev.type === 'log') state.log += ev.data;
          else if (ev.type === 'error') { state.error = window.I18n.errorText(ev.data, ev.data.error); state.files = ev.data.files; }
          else if (ev.type === 'done') state.result = ev.data;
          draw();
        }
      }
    } catch (e) { state.error = e.message; draw(); }
    if (!state.result) {
      document.getElementById('modalFooter').innerHTML = `<button class="btn btn-ghost" onclick="Extensions.open()">${esc(t('core.update.back'))}</button>`;
      return;
    }
    const to = state.result.to;
    if (state.result.restart?.managed) { await restart(to); return; }
    document.getElementById('modalBody').insertAdjacentHTML('beforeend', `<p class="ext-ok">${esc(t('core.update.doneManual', { version: to }))}</p><pre class="ext-changelog">npm start</pre>`);
    document.getElementById('modalFooter').innerHTML = `<button class="btn btn-primary" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`;
  }

  // Riavvio con PM2: la pagina aspetta che risponda la nuova versione e si ricarica
  async function restart(version) {
    const body = document.getElementById('modalBody');
    document.getElementById('modalFooter').innerHTML = '';
    body.insertAdjacentHTML('beforeend', `<p class="ext-ok self-update-restarting">${UI.icon('refresh-cw')} ${esc(t('core.update.restarting', { version }))}</p>`);
    let name = 'kelbo';
    try { name = (await api.post('/update/restart')).name || name; } catch (e) { toast(e.message, 'error'); }
    const until = Date.now() + RESTART_TIMEOUT_MS;
    await new Promise(r => setTimeout(r, 2000));
    while (Date.now() < until) {
      try {
        const r = await fetch('/api/core/system', { cache: 'no-store' });
        if (r.ok && (await r.json()).version === version) { location.reload(); return; }
      } catch { /* riavvio in corso */ }
      await new Promise(r => setTimeout(r, 1500));
    }
    body.insertAdjacentHTML('beforeend', `<p class="ext-warn">${esc(t('core.update.restartTimeout'))}</p><pre class="ext-changelog">pm2 restart ${esc(name)}</pre>`);
    document.getElementById('modalFooter').innerHTML = `<button class="btn btn-ghost" onclick="location.reload()">${esc(t('core.update.reload'))}</button>`;
  }

  return { load, available, sectionHtml, check, whatsNew, start, rollback, close: closeModal };
})();
