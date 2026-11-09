// Mock server: lista dei mock con avvio/arresto nella sidebar, rotte con risposta predefinita
// (ordinabili: risponde la prima che corrisponde), registro delle chiamate in tempo reale
// con il dettaglio del payload e "crea rotta da questa chiamata".

// colori dei metodi: variabili del tema
const METHOD_COLORS = { ANY: 'var(--http-other)', GET: 'var(--http-get)', POST: 'var(--http-post)', PUT: 'var(--http-put)', PATCH: 'var(--http-patch)', DELETE: 'var(--http-delete)', HEAD: 'var(--http-other)', OPTIONS: 'var(--http-other)' };
const methodColor = m => Object.hasOwn(METHOD_COLORS, m) ? METHOD_COLORS[m] : 'var(--http-other)';
const POLL_MS = 10000;
const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    const byId = id => document.getElementById(id);
    const val = id => byId(id)?.value ?? '';

    let mocks = [];
    let activeId = null;
    let tab = 'routes';
    let calls = [];
    let selectedCall = null;
    let closeStream = null;

    const active = () => mocks.find(m => m.id === activeId) || null;
    const badge = m => `<span class="ms-badge" style="--m:${methodColor(m)}">${esc(m === 'ANY' ? t('routes.any') : m)}</span>`;
    const base = (suffix = '') => `/mocks/${encodeURIComponent(activeId)}${suffix}`;

    async function load() {
      try { mocks = await ctx.api.get('/mocks'); } catch (e) { toast(e.message, 'error'); mocks = []; }
      if (activeId && !active()) select(null);
      renderSidebar();
      renderMain();
    }

    function renderSidebar() {
      const el = $(ctx.sidebar, 'mocks');
      el.innerHTML = !mocks.length ? `<p class="ms-muted ms-pad">${esc(t('sidebar.none'))}</p>`
        : mocks.map(m => `<div class="sb-item ms-item ${m.id === activeId ? 'active' : ''}" role="button" tabindex="0" onclick="Ext['mock-server'].select(${js(m.id)})">
            <span class="sb-dot" style="background:${m.running ? 'var(--success,#3fb950)' : 'var(--border)'}" title="${esc(t(m.running ? 'state.running' : 'state.stopped'))}"></span>
            <span class="ms-item-label">${esc(m.label)}</span>
            <span class="ms-port">:${esc(m.port)}</span>
            <button class="sb-item-act ms-visible" onclick="event.stopPropagation();Ext['mock-server'].toggle(${js(m.id)})" title="${esc(t(m.running ? 'header.stop' : 'header.start'))}">${ctx.ui.icon(m.running ? 'square' : 'play')}</button>
          </div>`).join('');
      ctx.setBadge(mocks.filter(m => m.running).length || null);
      renderPills();
    }

    // ---- header: una pill per mock avviato (clic: apre il mock, ✕: lo ferma) ----
    function renderPills() {
      ctx.setPills(mocks.filter(m => m.running).map(m => `
        <span class="pill pill-mock" onclick="Ext['mock-server'].openMock(${js(m.id)})" title="${esc(t('pill.title', { name: m.label, url: `http://127.0.0.1:${m.port}` }))}">
          <span class="pill-dot"></span>
          ${esc(m.label)}<span class="pill-port">:${esc(m.port)}</span>
          <span class="pill-close" onclick="event.stopPropagation();Ext['mock-server'].toggle(${js(m.id)})" title="${ctx.ui.icon('square')} ${esc(t('header.stop'))}"><i data-icon="x"></i></span>
        </span>`).join(''));
    }

    // Stato dei mock ogni tanto (pill e sidebar aggiornate anche con la sezione chiusa); il
    // pannello si ridisegna solo se cambia qualcosa
    const stateKey = list => list.map(m => `${m.id}:${m.running}:${m.port}`).join('|');
    async function poll() {
      let next;
      try { next = await ctx.api.get('/mocks'); } catch { return; }
      if (stateKey(next) === stateKey(mocks)) return;
      mocks = next;
      if (activeId && !active()) select(null);
      renderSidebar();
      renderMain();
    }

    function renderMain() {
      const m = active();
      $(ctx.root, 'empty').hidden = !!m;
      $(ctx.root, 'workspace').hidden = !m;
      if (!m) return;
      $(ctx.root, 'header').innerHTML = `
        <span class="sb-dot" style="background:${m.running ? 'var(--success,#3fb950)' : 'var(--border)'}"></span>
        <h3>${esc(m.label)}</h3>
        <span class="ms-muted">${m.running ? `<a href="http://127.0.0.1:${esc(m.port)}/" target="_blank" rel="noopener noreferrer">http://127.0.0.1:${esc(m.port)}</a>` : `127.0.0.1:${esc(m.port)}`}</span>
        <span class="ms-pill">${esc(t(m.cors ? 'header.corsOn' : 'header.corsOff'))}</span>
        ${m.running ? `<span class="ms-muted" data-uptime="${esc(m.startedAt)}"></span>` : ''}
        <div class="ms-header-actions">
          <button class="btn ${m.running ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="Ext['mock-server'].toggle(${js(m.id)})">${ctx.ui.icon(m.running ? 'square' : 'play')} ${esc(t(m.running ? 'header.stop' : 'header.start'))}</button>
          <button class="btn btn-ghost btn-sm" onclick="Ext['mock-server'].editMock(${js(m.id)})"><i data-icon="pencil"></i></button>
          <button class="btn btn-ghost btn-sm ms-danger" onclick="Ext['mock-server'].removeMock(${js(m.id)})" title="${esc(t('core.action.delete'))}"><i data-icon="trash-2"></i></button>
        </div>`;
      $(ctx.root, 'tab-routes').innerHTML = `${esc(t('tabs.routes'))} <span class="ms-count">${esc(fmt.number(m.routes.length))}</span>`;
      renderCallsTab();
      ctx.root.querySelectorAll('.ms-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      $(ctx.root, 'routes').hidden = tab !== 'routes';
      $(ctx.root, 'calls').hidden = tab !== 'calls';
      if (tab === 'routes') renderRoutes(); else renderCalls();
    }

    function renderCallsTab() {
      const unmatched = calls.filter(c => !c.route && !c.preflight).length;
      $(ctx.root, 'tab-calls').innerHTML = `${esc(t('tabs.calls'))} <span class="ms-count">${esc(fmt.number(calls.length))}</span>${unmatched ? ` <span class="ms-count ms-warn" title="${esc(t('calls.unmatchedTitle', { count: unmatched }))}">${esc(fmt.number(unmatched))}</span>` : ''}`;
    }

    function renderRoutes() {
      const m = active();
      $(ctx.root, 'routes').innerHTML = `
        <p class="ms-muted">${esc(t('routes.hint'))}</p>
        ${m.routes.length ? `<table class="data-table ms-routes"><thead><tr>
            <th></th><th>${esc(t('routes.method'))}</th><th>${esc(t('routes.path'))}</th><th>${esc(t('routes.status'))}</th><th>${esc(t('routes.response'))}</th><th>${esc(t('routes.delay'))}</th><th></th></tr></thead><tbody>
          ${m.routes.map((r, i) => `<tr ondblclick="Ext['mock-server'].editRoute(${js(r.id)})">
            <td class="ms-order">
              <button class="sb-item-act ms-visible" ${i === 0 ? 'disabled' : ''} onclick="Ext['mock-server'].move(${i}, -1)" title="${esc(t('routes.up'))}">${ctx.ui.icon('arrow-up')}</button>
              <button class="sb-item-act ms-visible" ${i === m.routes.length - 1 ? 'disabled' : ''} onclick="Ext['mock-server'].move(${i}, 1)" title="${esc(t('routes.down'))}">${ctx.ui.icon('arrow-down')}</button>
            </td>
            <td>${badge(r.method)}</td>
            <td><code>${esc(r.path)}</code>${r.label ? `<div class="ms-muted">${esc(r.label)}</div>` : ''}</td>
            <td><span class="ms-status ${statusClass(r.status)}">${esc(r.status)}</span></td>
            <td class="ms-muted ms-preview">${esc(r.bodyType === 'none' || !r.body ? t('routes.noBody') : r.body.slice(0, 80))}</td>
            <td class="ms-muted">${r.delayMs ? esc(t('routes.delayValue', { ms: fmt.number(r.delayMs) })) : ''}</td>
            <td class="ms-row-actions">
              <button class="btn btn-ghost btn-sm" onclick="Ext['mock-server'].editRoute(${js(r.id)})"><i data-icon="pencil"></i></button>
              <button class="btn btn-ghost btn-sm ms-danger" onclick="Ext['mock-server'].deleteRoute(${js(r.id)})"><i data-icon="trash-2"></i></button>
            </td></tr>`).join('')}
        </tbody></table>` : `<p class="ms-muted">${esc(t('routes.none'))}</p>`}
        <button class="btn btn-ghost btn-sm" onclick="Ext['mock-server'].newRoute()"><i data-icon="plus"></i> ${esc(t('routes.add'))}</button>`;
    }

    const statusClass = s => (s >= 500 ? 'ms-st-5' : s >= 400 ? 'ms-st-4' : s >= 300 ? 'ms-st-3' : 'ms-st-2');

    function renderCalls() {
      const only = $(ctx.root, 'only-unmatched').checked;
      const list = [...calls].reverse().filter(c => !only || (!c.route && !c.preflight));
      $(ctx.root, 'call-rows').innerHTML = list.length ? list.map(c => `<button class="ms-call ${c.id === selectedCall ? 'active' : ''}" onclick="Ext['mock-server'].showCall(${c.id})">
          <span class="ms-call-time">${esc(fmt.date(c.time, { timeStyle: 'medium' }))}</span>
          ${badge(c.method)}
          <span class="ms-call-path">${esc(c.path)}</span>
          <span class="ms-status ${statusClass(c.status)}">${esc(c.status)}</span>
          ${c.preflight ? `<span class="ms-tag">${esc(t('calls.preflight'))}</span>` : !c.route ? `<span class="ms-tag ms-warn">${esc(t('calls.noMatch'))}</span>` : ''}
        </button>`).join('')
        : `<p class="ms-muted ms-pad">${esc(t(active().running ? 'calls.none' : 'calls.noneStopped'))}</p>`;
      renderDetail();
    }

    function renderDetail() {
      const el = $(ctx.root, 'call-detail');
      const c = calls.find(x => x.id === selectedCall);
      if (!c) { el.innerHTML = `<p class="ms-muted ms-pad">${esc(t('calls.select'))}</p>`; return; }
      const route = c.route ? active().routes.find(r => r.id === c.route) : null;
      let body;
      if (c.body.kind === 'empty') body = `<p class="ms-muted">${esc(t('calls.noBody'))}</p>`;
      else if (c.body.kind === 'binary') body = `<p class="ms-muted">${esc(t('calls.binary', { size: fmt.bytes(c.body.size), type: c.body.type || '?' }))}</p>`;
      else {
        let text = c.body.text;
        if (c.body.kind === 'json') { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* testo com'è */ } }
        body = `<pre class="ms-pre">${esc(text)}</pre>${c.body.truncated ? `<p class="ms-warn">${esc(t('calls.truncated', { size: fmt.bytes(c.body.size) }))}</p>` : ''}`;
      }
      const table = rows => rows.length ? `<table class="data-table ms-kv"><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : `<p class="ms-muted">—</p>`;
      el.innerHTML = `
        <div class="ms-detail-head">${badge(c.method)} <code>${esc(c.path)}</code> <span class="ms-status ${statusClass(c.status)}">${esc(c.status)}</span>
          <span class="ms-muted">${esc(fmt.date(c.time, { dateStyle: 'short', timeStyle: 'medium' }))} · ${esc(t('calls.ms', { ms: fmt.number(c.ms) }))}</span></div>
        <p>${c.preflight ? esc(t('calls.preflightHint'))
          : route ? esc(t('calls.matched', { route: c.routeLabel }))
          : c.route ? esc(t('calls.matchedGone', { route: c.routeLabel }))
          : `<span class="ms-warn">${esc(t('calls.unmatched'))}</span> <button class="btn btn-primary btn-sm" onclick="Ext['mock-server'].routeFromCall(${c.id})">${esc(t('calls.createRoute'))}</button>`}</p>
        <h4>${esc(t('calls.query'))}</h4>${table(c.query)}
        <h4>${esc(t('calls.headers'))}</h4>${table(c.headers)}
        <h4>${esc(t('calls.body'))} <span class="ms-muted">${c.body.size ? esc(fmt.bytes(c.body.size)) : ''}</span></h4>${body}`;
    }

    // ---- streaming del registro ----

    async function openStream() {
      closeStream?.();
      closeStream = null;
      if (!activeId) return;
      const id = activeId;
      try { calls = (await ctx.api.get(base('/calls'))).calls; } catch { calls = []; }
      if (id !== activeId) return;
      closeStream = ctx.api.events(base('/events'), ({ type, data }) => {
        if (id !== activeId) return;
        if (type === 'call') {
          calls.push(data);
          if (calls.length > 500) calls.shift();
          renderCallsTab();
          if (tab === 'calls') renderCalls();
        } else if (type === 'clear') { calls = []; selectedCall = null; renderCallsTab(); if (tab === 'calls') renderCalls(); }
        else if (type === 'state') { const m = active(); if (m && m.running !== data.running) load(); }
        else if (type === 'removed') load();
      });
      renderMain();
    }

    function select(id) {
      activeId = id;
      selectedCall = null;
      calls = [];
      renderSidebar();
      renderMain();
      openStream();
    }

    // ---- dialoghi ----

    function mockDialog(id) {
      const m = id ? mocks.find(x => x.id === id) : { label: '', port: '', cors: true };
      const used = new Set(mocks.map(x => x.port));
      let port = m.port;
      if (!id) { port = 4100; while (used.has(port)) port++; }
      openModal(t(id ? 'mockDlg.editTitle' : 'mockDlg.newTitle'), `
        <div class="form-row"><label>${esc(t('mockDlg.name'))}</label><input class="form-input" id="f_ms_label" value="${esc(m.label)}" placeholder="${esc(t('mockDlg.namePlaceholder'))}"></div>
        <div class="form-row"><label>${esc(t('mockDlg.port'))}</label><input class="form-input" type="number" min="1" max="65535" id="f_ms_port" value="${esc(port)}">
          <p class="ms-muted">${esc(t('mockDlg.portHint'))}</p></div>
        <label class="ms-check"><input type="checkbox" id="f_ms_cors" ${m.cors ? 'checked' : ''}> ${esc(t('mockDlg.cors'))}</label>
        <p class="ms-muted">${esc(t('mockDlg.corsHint'))}</p>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['mock-server'].saveMock(${js(id || '')})">${esc(t(id ? 'core.action.save' : 'core.action.add'))}</button>`);
      setTimeout(() => byId('f_ms_label')?.focus(), 0);
    }

    const linesOf = list => (list || []).map(h => `${h.name}: ${h.value}`).join('\n');
    const headersOf = text => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf(':');
      return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    });

    function routeDialog(route, { fromCall = false } = {}) {
      const r = route || { method: 'GET', path: '/', status: 200, headers: [], bodyType: 'json', body: '{\n  "ok": true\n}', delayMs: 0 };
      openModal(t(r.id ? 'routeDlg.editTitle' : fromCall ? 'routeDlg.fromCallTitle' : 'routeDlg.newTitle'), `
        <div class="ms-inline">
          <select class="form-input ms-method" id="f_ms_method">${METHODS.map(m => `<option value="${m}" ${m === r.method ? 'selected' : ''}>${esc(m === 'ANY' ? t('routes.any') : m)}</option>`).join('')}</select>
          <input class="form-input" id="f_ms_path" value="${esc(r.path)}" spellcheck="false" placeholder="/users/:id">
        </div>
        <p class="ms-muted">${esc(t('routeDlg.pathHint'))}</p>
        <div class="ms-grid3">
          <div class="form-row"><label>${esc(t('routeDlg.status'))}</label><input class="form-input" type="number" min="100" max="599" id="f_ms_status" value="${esc(r.status)}"></div>
          <div class="form-row"><label>${esc(t('routeDlg.delay'))}</label><input class="form-input" type="number" min="0" max="60000" step="100" id="f_ms_delay" value="${esc(r.delayMs || 0)}"></div>
          <div class="form-row"><label>${esc(t('routeDlg.label'))}</label><input class="form-input" id="f_ms_rlabel" value="${esc(r.label || '')}"></div>
        </div>
        <div class="form-row"><label>${esc(t('routeDlg.headers'))}</label><textarea class="form-input ms-code" id="f_ms_headers" rows="2" spellcheck="false" placeholder="X-Request-Id: 42">${esc(linesOf(r.headers))}</textarea></div>
        <div class="form-row"><label>${esc(t('routeDlg.body'))}</label>
          <div class="ms-inline ms-body-types">${['json', 'text', 'none'].map(bt => `<label class="ms-check"><input type="radio" name="f_ms_btype" value="${bt}" ${bt === (r.bodyType || 'json') ? 'checked' : ''}> ${esc(t(`routeDlg.bodyTypes.${bt}`))}</label>`).join('')}</div>
          <textarea class="form-input ms-code" id="f_ms_body" rows="8" spellcheck="false">${esc(r.body || '')}</textarea></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['mock-server'].saveRoute(${js(r.id || '')})">${esc(t(r.id ? 'core.action.save' : 'core.action.add'))}</button>`);
      byId('modal').classList.add('modal-wide');
      setTimeout(() => byId(fromCall ? 'f_ms_body' : 'f_ms_path')?.focus(), 0);
    }

    async function saveRoute(rid) {
      const bodyType = document.querySelector('input[name="f_ms_btype"]:checked')?.value || 'json';
      const body = {
        method: val('f_ms_method'), path: val('f_ms_path').trim(), status: Number(val('f_ms_status')), delayMs: Number(val('f_ms_delay')) || 0,
        label: val('f_ms_rlabel').trim(), headers: headersOf(val('f_ms_headers')), bodyType, body: val('f_ms_body'),
      };
      if (bodyType === 'json' && body.body.trim()) {
        try { JSON.parse(body.body); } catch (e) { if (!confirm(t('routeDlg.invalidJson', { error: e.message }))) return; }
      }
      try {
        const r = rid ? await ctx.api.put(base(`/routes/${encodeURIComponent(rid)}`), body) : await ctx.api.post(base('/routes'), body);
        const m = active();
        m.routes = rid ? m.routes.map(x => (x.id === r.id ? r : x)) : [...m.routes, r];
        closeModal();
        toast(t(rid ? 'routeDlg.saved' : 'routeDlg.added', { route: `${r.method} ${r.path}` }), 'success');
        renderMain();
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---- eventi ----

    ctx.sidebar.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'reload') load();
      if (a === 'new-mock') mockDialog('');
    });
    ctx.root.addEventListener('click', async e => {
      const tb = e.target.closest('[data-tab]');
      if (tb) { tab = tb.dataset.tab; renderMain(); return; }
      if (e.target.closest('[data-action="clear-calls"]')) {
        try { await ctx.api.del(base('/calls')); } catch (err) { toast(err.message, 'error'); }
      }
    });
    $(ctx.root, 'only-unmatched').addEventListener('change', renderCalls);

    ctx.expose({
      select(id) { if (id !== activeId) select(id); },
      openMock(id) { ctx.open('mock-server'); if (id !== activeId) select(id); },
      async toggle(id) {
        const m = mocks.find(x => x.id === id);
        try {
          await ctx.api.post(`/mocks/${encodeURIComponent(id)}/${m.running ? 'stop' : 'start'}`);
          toast(t(m.running ? 'state.stoppedToast' : 'state.startedToast', { name: m.label, port: m.port }), 'success');
        } catch (e) { toast(e.message, 'error'); }
        load();
      },
      editMock: mockDialog,
      async saveMock(id) {
        const body = { label: val('f_ms_label').trim(), port: Number(val('f_ms_port')), cors: byId('f_ms_cors').checked };
        if (!body.label) { toast(t('mockDlg.nameRequired'), 'error'); return; }
        try {
          const m = id ? await ctx.api.put(`/mocks/${encodeURIComponent(id)}`, body) : await ctx.api.post('/mocks', body);
          closeModal();
          await load();
          if (!id) select(m.id);
        } catch (e) { toast(e.message, 'error'); }
      },
      async removeMock(id) {
        const m = mocks.find(x => x.id === id);
        if (!confirm(t('mockDlg.confirmDelete', { name: m.label, count: m.routes.length }))) return;
        try { await ctx.api.del(`/mocks/${encodeURIComponent(id)}`); select(null); load(); } catch (e) { toast(e.message, 'error'); }
      },
      newRoute() { routeDialog(null); },
      editRoute(rid) { routeDialog(active().routes.find(r => r.id === rid)); },
      saveRoute,
      async deleteRoute(rid) {
        const r = active().routes.find(x => x.id === rid);
        if (!confirm(t('routes.confirmDelete', { route: `${r.method} ${r.path}` }))) return;
        try { await ctx.api.del(base(`/routes/${encodeURIComponent(rid)}`)); active().routes = active().routes.filter(x => x.id !== rid); renderMain(); } catch (e) { toast(e.message, 'error'); }
      },
      async move(i, dir) {
        const m = active();
        const ids = m.routes.map(r => r.id);
        [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
        try { await ctx.api.put(base('/order'), { ids }); m.routes = ids.map(id => m.routes.find(r => r.id === id)); renderMain(); } catch (e) { toast(e.message, 'error'); }
      },
      showCall(id) { selectedCall = id; renderCalls(); },
      // Rotta dalla chiamata senza corrispondenza: metodo e percorso, la risposta da compilare
      routeFromCall(id) {
        const c = calls.find(x => x.id === id);
        routeDialog({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(c.method) ? c.method : 'ANY', path: c.path, status: 200, headers: [], bodyType: 'json', body: '{\n  \n}' }, { fromCall: true });
      },
    });

    await load();
    const pollTimer = setInterval(poll, POLL_MS);
    this.refresh = load;
    this.unmount = () => { clearInterval(pollTimer); closeStream?.(); closeStream = null; };
    this.show = () => { if (activeId && !closeStream) openStream(); };
    this.hide = () => { closeStream?.(); closeStream = null; };
    this.languageChanged = () => { renderSidebar(); renderMain(); };
  },
};
