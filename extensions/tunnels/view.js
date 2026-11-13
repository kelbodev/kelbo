// Tunnel: gruppi e card dei server (SSH o un trasporto di un'altra estensione, es. kubectl
// port-forward), configurazione di gruppi e server con il form del trasporto,
// pill nell'header, notifiche desktop e log nel cassetto di output.
// Montato all'avvio (preload) perché pill e notifiche servono anche a tab chiuso.

const POLL_MS = 5000;
const LOG_POLL_MS = 2000;
const SERVICE_TYPES = ['MySQL', 'MongoDB', 'PostgreSQL', 'SQL Server', 'HTTP', 'HTTPS', 'FTP', 'LDAP', 'Elastic', 'Redis', 'TCP'];

export default {
  async mount(ctx) {
    const { esc, js, cssColor, toast, openModal, closeModal, output, formatUptime, toolNotice, notify, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);

    let state = { groups: [], servers: [], tunnels: [], transports: [], errors: {} };
    let form = null;               // form del server aperto: { transport, values, fields, seq }
    const pick = v => ctx.i18n.pick(v);
    const transportTitle = id => { const p = state.transports.find(x => x.id === id); return p ? pick(p.title) : id; };
    // riga di dettaglio di un server: SSH (alias, remoto) o trasporto (titolo, destinazione)
    const serverMeta = s => (s.transport
      ? `:${s.port} → ${s.description || transportTitle(s.transport)} · ${transportTitle(s.transport)}`
      : `:${s.port} → ${s.remote} · ${t('card.alias')} ${s.alias}`);
    let system = { platform: null, tools: {} };
    let mode = 'tunnels';          // 'tunnels' | 'settings'
    let activeGroup = null;
    let settingsGroup = null;
    let prevTunnels = null;        // per le notifiche (null = primo giro)
    const customPorts = new Map(); // porta digitata nelle card, conservata tra un refresh e l'altro
    let logTunnelId = null, logTimer = null;

    const tunnelsOf = g => state.tunnels.filter(tn => g.servers.some(s => s.key === tn.serverKey));

    // ---- dati ----
    async function load() {
      try {
        const next = await ctx.api.get('/state');
        notifyChanges(next.tunnels);
        state = next;
      } catch { return; }
      renderPills();
      ctx.setBadge(state.tunnels.length);
      if (ctx.isActive()) render();
    }

    function notifyChanges(next) {
      if (prevTunnels) {
        const prev = new Map(prevTunnels.map(tn => [tn.id, tn]));
        const ids = new Set(next.map(tn => tn.id));
        for (const tn of next) {
          const was = prev.get(tn.id);
          if (!was) notify(tn.label, t('notify.connected', { port: tn.port }), '🟢');
          else if (tn.reconnecting && !was.reconnecting) notify(tn.label, t('notify.lost'), '🟡');
          else if (!tn.reconnecting && was.reconnecting) notify(tn.label, t('notify.reconnected', { port: tn.port }), '🟢');
        }
        for (const tn of prevTunnels) if (!ids.has(tn.id)) notify(tn.label, t('notify.disconnected', { port: tn.port }), '🔴');
      }
      prevTunnels = next;
    }

    // ---- header ----
    function renderPills() {
      if (!state.tunnels.length) { ctx.setPills(''); return; }
      ctx.setPills(state.tunnels.map(tn => `
        <span class="pill pill-tunnel ${tn.reconnecting ? 'reconnecting' : ''}" onclick="Ext.tunnels.open()"
              title="${esc(tn.label)} :${esc(tn.port)}${tn.reconnecting ? ' ' + esc(t('pill.reconnecting')) : ''}">
          <span class="pill-dot"></span>
          ${esc(tn.label)}<span class="pill-port">:${esc(tn.port)}</span>
          <span class="pill-close" onclick="event.stopPropagation();Ext.tunnels.stop(${js(tn.id)})"><i data-icon="x"></i></span>
        </span>`).join('') + `<button class="btn btn-danger btn-sm" onclick="Ext.tunnels.stopAll()">${ctx.ui.icon('square')} ${esc(t('pill.stopAll'))}</button>`);
    }

    // ---- vista tunnel ----
    function render() {
      for (const el of ctx.root.querySelectorAll('[data-mode]')) el.hidden = el.dataset.mode !== mode;
      for (const el of ctx.sidebar.querySelectorAll('[data-mode]')) el.hidden = el.dataset.mode !== mode;
      if (mode === 'settings') { renderSettingsGroups(); renderSettingsDetail(); return; }
      renderGroups();
      renderMain();
    }

    function renderGroups() {
      const list = $(ctx.sidebar, 'groups');
      ctx.ui.patch(list, !state.groups.length
        ? `<p class="tn-muted tn-pad">${esc(t('groups.none'))}</p>`
        : state.groups.map(g => {
            const cnt = tunnelsOf(g).length, color = cssColor(g.color);
            return `<button class="sb-item ${activeGroup === g.key ? 'active' : ''}" onclick="Ext.tunnels.selectGroup(${js(g.key)})">
              <span class="sb-dot" style="background:${color}"></span>
              <span class="tn-grow">${esc(g.label)}</span>
              ${cnt ? `<span class="sb-count" style="color:${color};border-color:${color}">${fmt.number(cnt)}</span>`
                    : `<span class="sb-count">${fmt.number(g.servers.length)}</span>`}
            </button>`;
          }).join(''));
    }

    function renderMain() {
      const main = $(ctx.root, 'main');
      const g = state.groups.find(x => x.key === activeGroup);
      if (!g) {
        ctx.ui.patch(main, `<div class="empty-state"><div class="icon"><i data-icon="cable"></i></div><p>${esc(t('main.selectGroup'))}</p></div>`);
        return;
      }
      const color = cssColor(g.color), cnt = tunnelsOf(g).length;
      const autossh = system.platform && !system.tools.autossh
        ? toolNotice(t('main.autossh'),
            system.platform === 'darwin' ? 'brew install autossh' : system.platform === 'win32' ? '' : 'sudo apt install autossh',
            'Ext.tunnels.recheck()')
        : '';
      ctx.ui.patch(main, `
        <div class="section-banner" style="border-inline-start:3px solid ${color}">
          <span class="section-banner-dot" style="background:${color}"></span>
          <h2>${esc(g.label)}</h2>
          ${cnt ? `<span class="section-banner-sub">${esc(t('main.connected', { count: cnt }))}</span>` : ''}
          <div class="tn-banner-actions">
            ${cnt ? `<button class="btn btn-danger btn-sm" onclick="Ext.tunnels.stopGroup(${js(g.key)})">${ctx.ui.icon('square')} ${esc(t('main.disconnectAll'))}</button>` : ''}
          </div>
        </div>
        ${autossh}
        <div class="server-area">
          <div class="server-grid">${g.servers.map(serverCard).join('')}</div>
          ${g.servers.length ? '' : `<div class="empty-state tn-empty-inline"><div class="icon"><i data-icon="monitor"></i></div><p>${esc(t('main.noServers'))}</p></div>`}
        </div>`);
    }

    function serverCard(s) {
      const tn = state.tunnels.find(x => x.serverKey === s.key);
      const err = state.errors?.[s.key];
      return `<div class="server-card ${tn ? 'connected' : ''} ${s.unavailable ? 'tn-unavailable' : ''}">
        <div class="card-top">
          <span class="card-label">${esc(s.label)}</span>
          <span class="type-badge">${esc(s.type || 'TCP')}</span>
        </div>
        <div class="card-meta">
          ${s.transport ? `<div>${esc(t('card.transport'))} <span class="val">${esc(transportTitle(s.transport))}</span></div>
            <div>${esc(t('card.target'))} <span class="val">${esc(s.description || '—')}</span></div>`
          : `<div>${esc(t('card.alias'))} <span class="val">${esc(s.alias)}</span></div>
            <div>${esc(t('card.remote'))} <span class="val">${esc(s.remote)}</span></div>`}
        </div>
        ${s.unavailable ? `<div class="tn-card-warn">${ctx.ui.icon('plug-zap')} ${esc(t('card.unavailable', { extension: s.transportFrom || s.transport }))}</div>` : ''}
        ${!tn && err ? `<div class="tn-card-warn">${esc(ctx.ui.errorText(err))}</div>` : ''}
        ${tn ? `<div class="card-meta tn-card-runtime">
          <div>${esc(t('card.pid'))} <span class="val">${esc(tn.pid || '—')}</span></div>
          <div>${esc(t('card.uptime'))} <span class="val" data-uptime="${esc(tn.startedAt)}">${formatUptime(tn.startedAt)}</span></div>
        </div>` : ''}
        <div class="card-bottom">
          ${tn
            ? `<span class="connected-status ${tn.reconnecting ? 'reconnecting' : ''}">:${esc(tn.port)}${tn.reconnecting ? ` ${ctx.ui.icon('refresh-cw', { cls: 'tn-spin' })}` : ''}</span>
               <button class="btn btn-disconnect" onclick="Ext.tunnels.stop(${js(tn.id)})">${esc(t('card.disconnect'))}</button>
               <button class="btn btn-ghost btn-sm" onclick="Ext.tunnels.logs(${js(tn.id)},${js(s.label)})">${esc(t('card.logs'))}</button>`
            : `<input class="port-input" type="number" min="1" max="65535" value="${esc(customPorts.get(s.key) ?? s.port)}"
                      oninput="Ext.tunnels.setPort(${js(s.key)}, this.value)">
               <button class="btn btn-connect" onclick="Ext.tunnels.start(${js(s.key)})" ${s.unavailable ? 'disabled' : ''}>${esc(t('card.connect'))}</button>`}
        </div>
      </div>`;
    }

    // ---- vista configurazione ----
    // Server che non stanno in nessun gruppo (es. tolti da un gruppo): visibili solo qui
    const orphanServers = () => state.servers.filter(s => !state.groups.some(g => g.servers.some(x => x.key === s.key)));
    const ORPHANS = '\u0000orphans';

    function renderSettingsGroups() {
      const el = $(ctx.sidebar, 'settings-groups');
      const orphans = orphanServers();
      const orphanItem = orphans.length ? `
          <div class="gli ${settingsGroup === ORPHANS ? 'active' : ''}" onclick="Ext.tunnels.selectSettingsGroup(${js(ORPHANS)})">
            <span class="gli-dot" style="background:transparent;border:1px dashed var(--muted)"></span>
            <span class="gli-label">${esc(t('settings.orphans'))}</span>
            <span class="gli-cnt">${fmt.number(orphans.length)}</span>
          </div>` : '';
      ctx.ui.patch(el, (!state.groups.length
        ? `<p class="tn-muted tn-pad">${esc(t('settings.noGroups'))}<br><br><button class="btn btn-ghost btn-sm" onclick="Ext.tunnels.addGroup()">${esc(t('settings.add'))}</button></p>`
        : state.groups.map(g => `
          <div class="gli ${settingsGroup === g.key ? 'active' : ''}" onclick="Ext.tunnels.selectSettingsGroup(${js(g.key)})">
            <span class="gli-dot" style="background:${cssColor(g.color)}"></span>
            <span class="gli-label">${esc(g.label)}</span>
            <span class="gli-cnt">${fmt.number(g.servers.length)}</span>
            <button class="gli-edit" onclick="event.stopPropagation();Ext.tunnels.editGroup(${js(g.key)})" title="${esc(t('core.action.edit'))}"><i data-icon="pencil"></i></button>
            <button class="gli-del" onclick="event.stopPropagation();Ext.tunnels.deleteGroup(${js(g.key)})" title="${esc(t('core.action.delete'))}"><i data-icon="trash-2"></i></button>
          </div>`).join('')) + orphanItem);
    }

    function renderSettingsDetail() {
      const el = $(ctx.root, 'settings-detail');
      if (settingsGroup === ORPHANS) {
        const orphans = orphanServers();
        ctx.ui.patch(el, `
          <div class="settings-detail-header"><h3>${esc(t('settings.orphans'))}</h3></div>
          <div class="settings-detail-body">
            <p class="tn-muted tn-pad-v">${esc(t(orphans.length ? 'settings.orphansHint' : 'settings.noOrphans'))}</p>
            ${orphans.map(s => `
              <div class="sli">
                <div class="sli-info">
                  <div class="sli-label">${esc(s.label)}</div>
                  <div class="sli-meta">${esc(serverMeta(s))}${s.unavailable ? ` · ${esc(t('card.unavailableShort'))}` : ''}</div>
                </div>
                <span class="sli-type">${esc(s.type || 'TCP')}</span>
                <div class="sli-actions">
                  <button class="sli-btn" onclick="Ext.tunnels.editServer(${js(s.key)})" title="${esc(t('core.action.edit'))}"><i data-icon="pencil"></i></button>
                  <button class="sli-btn danger" onclick="Ext.tunnels.deleteServer(${js(s.key)})" title="${esc(t('settings.deleteForever'))}"><i data-icon="trash-2"></i></button>
                </div>
              </div>`).join('')}
          </div>`);
        return;
      }
      const g = state.groups.find(x => x.key === settingsGroup);
      if (!g) {
        ctx.ui.patch(el, `<div class="settings-detail-empty"><div class="icon">${ctx.ui.icon('arrow-left')}</div><p>${esc(t('main.selectGroup'))}</p></div>`);
        return;
      }
      const available = state.servers.filter(s => !g.servers.some(x => x.key === s.key));
      ctx.ui.patch(el, `
        <div class="settings-detail-header">
          <span class="settings-detail-dot" style="background:${cssColor(g.color)}"></span>
          <h3>${esc(g.label)}</h3>
          <button class="btn btn-primary btn-sm" onclick="Ext.tunnels.addServer(${js(g.key)})">${esc(t('settings.newServer'))}</button>
          ${available.length ? `<button class="btn btn-ghost btn-sm" onclick="Ext.tunnels.assignServer(${js(g.key)})">${esc(t('settings.addExisting'))}</button>` : ''}
        </div>
        <div class="settings-detail-body">
          ${!g.servers.length
            ? `<p class="tn-muted tn-pad-v">${esc(t('settings.noServers'))}</p>`
            : g.servers.map(s => `
              <div class="sli">
                <div class="sli-info">
                  <div class="sli-label">${esc(s.label)}</div>
                  <div class="sli-meta">${esc(serverMeta(s))}${s.unavailable ? ` · ${esc(t('card.unavailableShort'))}` : ''}</div>
                </div>
                <span class="sli-type">${esc(s.type || 'TCP')}</span>
                <div class="sli-actions">
                  <button class="sli-btn" onclick="Ext.tunnels.editServer(${js(s.key)})" title="${esc(t('core.action.edit'))}"><i data-icon="pencil"></i></button>
                  <button class="sli-btn danger" onclick="Ext.tunnels.removeFromGroup(${js(g.key)},${js(s.key)})" title="${esc(t('settings.removeFromGroup'))}"><i data-icon="x"></i></button>
                  <button class="sli-btn danger" onclick="Ext.tunnels.deleteServer(${js(s.key)})" title="${esc(t('settings.deleteForever'))}"><i data-icon="trash-2"></i></button>
                </div>
              </div>`).join('')}
        </div>`);
    }

    // ---- form ----
    const field = id => (document.getElementById(id)?.value || '').trim();

    function groupForm(g = {}) {
      const color = cssColor(g.color);
      return `
        <div class="form-row">
          <label>${esc(t('form.key'))}</label>
          <input class="form-input" id="f_key" value="${esc(g.key || '')}" placeholder="${esc(t('form.groupKeyPlaceholder'))}" ${g.key ? 'disabled' : ''}>
        </div>
        <div class="form-row">
          <label>${esc(t('form.name'))}</label>
          <input class="form-input" id="f_label" value="${esc(g.label || '')}" placeholder="${esc(t('form.groupNamePlaceholder'))}">
        </div>
        <div class="form-row">
          <label>${esc(t('form.color'))}</label>
          <div class="color-row">
            <div class="color-preview" id="colorPreview" style="background:${color}" onclick="document.getElementById('f_color').click()"></div>
            <span id="colorHex" class="tn-hex">${color}</span>
            <input type="color" id="f_color" value="${color}" oninput="document.getElementById('colorPreview').style.background=this.value;document.getElementById('colorHex').textContent=this.value">
          </div>
        </div>`;
    }

    function serverForm(s = {}, preGroupKey = '') {
      const types = SERVICE_TYPES.map(type => `<option ${(s.type || 'MySQL') === type ? 'selected' : ''}>${esc(type)}</option>`).join('');
      const groupOptions = state.groups.map(g => `<option value="${esc(g.key)}" ${g.key === preGroupKey ? 'selected' : ''}>${esc(g.label)}</option>`).join('');
      const transport = s.transport || 'ssh';
      // un trasporto salvato ma non installato resta scelto (si può tornare a SSH)
      const options = [{ id: 'ssh', title: t('form.transportSsh') }, ...state.transports.map(p => ({ id: p.id, title: pick(p.title) })),
        ...(transport !== 'ssh' && !state.transports.some(p => p.id === transport) ? [{ id: transport, title: t('form.transportMissing', { transport }) }] : [])];
      return `
        <div class="form-row">
          <label>${esc(t('form.key'))}</label>
          <input class="form-input" id="f_key" value="${esc(s.key || '')}" placeholder="${esc(t('form.serverKeyPlaceholder'))}" ${s.key ? 'disabled' : ''}>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.name'))}</label><input class="form-input" id="f_label" value="${esc(s.label || '')}" placeholder="${esc(t('form.serverNamePlaceholder'))}"></div>
          <div class="form-row"><label>${esc(t('form.type'))}</label><select class="form-input" id="f_type">${types}</select></div>
        </div>
        <div class="form-grid">
          <div class="form-row"><label>${esc(t('form.transport'))}</label>
            <select class="form-input" id="f_transport" onchange="Ext.tunnels.transportChanged()">${options.map(o => `<option value="${esc(o.id)}" ${o.id === transport ? 'selected' : ''}>${esc(o.title)}</option>`).join('')}</select></div>
          <div class="form-row"><label>${esc(t('form.localPort'))}</label><input class="form-input" id="f_port" type="number" value="${esc(s.port || 3306)}" min="1" max="65535"></div>
        </div>
        <div data-role="ssh-fields" ${transport === 'ssh' ? '' : 'hidden'}>
          <div class="form-row"><label>${esc(t('form.remote'))}</label><input class="form-input" id="f_remote" value="${esc(s.remote || '')}" placeholder="127.0.0.1:3306"></div>
          <div class="form-row"><label>${esc(t('form.alias'))}</label><input class="form-input" id="f_alias" value="${esc(s.alias || '')}" placeholder="${esc(t('form.aliasPlaceholder'))}"></div>
        </div>
        <div class="tn-transport-fields" data-role="transport-fields" ${transport === 'ssh' ? 'hidden' : ''}></div>
        ${!s.key ? `<div class="form-row">
          <label>${esc(t('form.group'))}</label>
          <select class="form-input" id="f_group"><option value="">${esc(t('form.noGroup'))}</option>${groupOptions}</select>
        </div>` : ''}`;
    }

    // ---- campi di un trasporto (dal provider, con le liste che dipendono dagli altri campi) ----
    function transportFieldHtml(f) {
      const id = `f_tp_${f.key}`;
      const v = form.values[f.key] ?? f.default ?? '';
      const label = `${esc(pick(f.label) || f.key)}${f.required ? ' *' : ''}`;
      const hint = f.hint ? `<div class="tn-hint">${esc(pick(f.hint))}</div>` : '';
      let input;
      if (f.type === 'select') {
        const opts = Array.isArray(f.options) ? f.options : [];
        input = `<select class="form-input" id="${id}" data-tp="${esc(f.key)}" ${f.disabled ? 'disabled' : ''}>
          <option value="">${esc(f.loading ? t('form.loading') : opts.length ? t('form.choose') : pick(f.empty) || t('form.none'))}</option>
          ${opts.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? 'selected' : ''}>${esc(pick(o.label) ?? o.value)}</option>`).join('')}</select>`;
      } else {
        input = `<input class="form-input" id="${id}" data-tp="${esc(f.key)}" type="${f.type === 'number' ? 'number' : 'text'}" value="${esc(v)}" placeholder="${esc(pick(f.placeholder) || '')}" spellcheck="false">`;
      }
      return `<div class="form-row"><label for="${id}">${label}</label>${input}${hint}</div>`;
    }
    async function loadTransportFields() {
      const el = document.querySelector('#modalBody [data-role="transport-fields"]');
      if (!el || !form || form.transport === 'ssh') return;
      const seq = ++form.seq;
      el.classList.add('tn-loading');
      try {
        const r = await ctx.api.post(`/transports/${encodeURIComponent(form.transport)}/fields`, { values: form.values });
        if (!form || seq !== form.seq) return;
        form.fields = r.fields;
        // valori non più tra le scelte (es. namespace di un altro context): tolti
        for (const f of form.fields) if (f.type === 'select' && form.values[f.key] != null && !(f.options || []).some(o => String(o.value) === String(form.values[f.key]))) delete form.values[f.key];
        el.innerHTML = form.fields.map(transportFieldHtml).join('') || `<p class="tn-muted">${esc(t('form.noFields'))}</p>`;
      } catch (e) {
        if (form && seq === form.seq) el.innerHTML = `<p class="tn-error">${esc(e.message)}</p>`;
      } finally { el.classList.remove('tn-loading'); }
    }
    function openServerForm(title, s, preGroupKey, saveCall) {
      form = { transport: s.transport || 'ssh', values: { ...(s.params || {}) }, fields: [], seq: 0 };
      openModal(title, serverForm(s, preGroupKey), modalButtons(t(s.key ? 'core.action.save' : 'form.create'), saveCall));
      const body = document.getElementById('modalBody');
      body.querySelector('[data-role="transport-fields"]')?.addEventListener('change', e => {
        const key = e.target.dataset.tp;
        if (!key || !form) return;
        if (e.target.value === '') delete form.values[key];
        else form.values[key] = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
        // i campi dopo questo dipendono da lui (namespace → risorsa → porta): si rileggono
        const i = form.fields.findIndex(f => f.key === key);
        for (const f of form.fields.slice(i + 1)) if ((f.dependsOn || []).includes(key)) delete form.values[f.key];
        loadTransportFields();
      });
      loadTransportFields();
    }

    const modalButtons = (label, call) =>
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button><button class="btn btn-primary" onclick="${esc(call)}">${esc(label)}</button>`;

    // Esegue una modifica e ricarica lo stato; gli errori del server diventano toast
    async function mutate(fn, okMsg) {
      try {
        await fn();
        if (okMsg) toast(okMsg, 'success');
        await load();
        return true;
      } catch (e) { toast(e.message, 'error'); return false; }
    }

    // ---- log del tunnel nel cassetto di output ----
    function stopLogs() { clearInterval(logTimer); logTimer = null; logTunnelId = null; }
    // sezione nascosta: il polling dei log si ferma ma il tunnel seguito resta, e riparte in show
    function pauseLogs() { clearInterval(logTimer); logTimer = null; }
    function resumeLogs() {
      if (!logTunnelId || logTimer) return;
      if (!state.tunnels.some(tn => tn.id === logTunnelId)) { logTunnelId = null; return; }
      pollLogs();
      logTimer = setInterval(pollLogs, LOG_POLL_MS);
    }

    async function pollLogs() {
      if (!logTunnelId) return;
      try {
        const logs = await ctx.api.get(`/tunnels/${encodeURIComponent(logTunnelId)}/logs`);
        output.clear();
        if (!logs.length) output.append(t('logs.empty'), 'sys');
        for (const l of logs) {
          output.append(`[${fmt.date(l.ts, { timeStyle: 'medium' })}] `, 'sys');
          const text = l.code ? ctx.ui.errorText({ code: l.code, params: l.params, error: l.text }) : l.text;
          output.append(text.endsWith('\n') ? text : text + '\n');
        }
      } catch { stopLogs(); }
    }

    // ---- azioni (handler inline) ----
    const actions = {
      open: () => ctx.open(ctx.code),
      selectGroup(key) { activeGroup = key; mode = 'tunnels'; ctx.open(ctx.code); render(); },
      setPort(key, value) { customPorts.set(key, value); },
      recheck: async () => { system = await ctx.core.get('/system?refresh=1').catch(() => system); render(); },

      start: key => mutate(async () => {
        const port = customPorts.get(key);
        const r = await ctx.api.post('/tunnels', { serverKey: key, port: port === undefined || port === '' ? undefined : Number(port) });
        toast(t('toast.started', { port: r.port }), 'success');
      }),
      stop: id => mutate(async () => {
        await ctx.api.del(`/tunnels/${encodeURIComponent(id)}`);
        if (logTunnelId === id) stopLogs();
      }, t('toast.stopped')),
      stopAll: () => mutate(async () => { await ctx.api.del('/tunnels'); stopLogs(); }, t('toast.stoppedAll')),
      stopGroup: key => mutate(async () => {
        const g = state.groups.find(x => x.key === key);
        for (const tn of g ? tunnelsOf(g) : []) await ctx.api.del(`/tunnels/${encodeURIComponent(tn.id)}`).catch(() => {});
      }, t('toast.stoppedGroup')),
      logs(id, label) {
        logTunnelId = id;
        output.open(t('logs.title', { name: label }));
        pollLogs();
        clearInterval(logTimer);
        logTimer = setInterval(pollLogs, LOG_POLL_MS);
      },

      // configurazione
      selectSettingsGroup(key) { settingsGroup = key; render(); },
      addGroup: () => openModal(t('modal.newGroup'), groupForm(), modalButtons(t('form.create'), 'Ext.tunnels.saveGroup()')),
      editGroup(key) {
        const g = state.groups.find(x => x.key === key);
        if (g) openModal(t('modal.editGroup'), groupForm(g), modalButtons(t('core.action.save'), `Ext.tunnels.saveGroup(${JSON.stringify(key)})`));
      },
      async saveGroup(existingKey) {
        const key = field('f_key'), label = field('f_label'), color = field('f_color') || '#6b7280';
        if (!key || !label) { toast(t('toast.keyNameRequired'), 'error'); return; }
        const ok = await mutate(() => existingKey
          ? ctx.api.put(`/groups/${encodeURIComponent(existingKey)}`, { label, color })
          : ctx.api.post('/groups', { key, label, color }), t('toast.groupSaved'));
        if (ok) closeModal();
      },
      async deleteGroup(key) {
        // i server del gruppo che non stanno in altri gruppi vengono eliminati con lui
        const g = state.groups.find(x => x.key === key);
        const others = new Set(state.groups.filter(x => x.key !== key).flatMap(x => x.servers.map(s => s.key)));
        const gone = (g?.servers || []).filter(s => !others.has(s.key));
        if (!confirm(gone.length ? t('confirm.deleteGroupServers', { name: g?.label || key, count: gone.length, servers: fmt.list(gone.map(s => s.label)) }) : t('confirm.deleteGroup', { name: g?.label || key }))) return;
        if (settingsGroup === key) settingsGroup = null;
        await mutate(() => ctx.api.del(`/groups/${encodeURIComponent(key)}`), t('toast.groupDeleted'));
      },
      addServer: (groupKey, prefill = {}) => openServerForm(t('modal.newServer'), prefill, groupKey, `Ext.tunnels.saveServer(null, ${JSON.stringify(groupKey || '')})`),
      editServer(key) {
        const s = state.servers.find(x => x.key === key);
        if (s) openServerForm(t('modal.editServer'), s, '', `Ext.tunnels.saveServer(${JSON.stringify(key)})`);
      },
      transportChanged() {
        if (!form) return;
        form.transport = field('f_transport') || 'ssh';
        form.values = {};
        form.fields = [];
        const body = document.getElementById('modalBody');
        body.querySelector('[data-role="ssh-fields"]').hidden = form.transport !== 'ssh';
        const tf = body.querySelector('[data-role="transport-fields"]');
        tf.hidden = form.transport === 'ssh';
        tf.innerHTML = '';
        loadTransportFields();
      },
      async saveServer(existingKey, forceGroupKey) {
        const transport = field('f_transport') || 'ssh';
        const base = { key: field('f_key'), label: field('f_label'), port: field('f_port'), type: field('f_type') || 'TCP' };
        let body;
        if (transport === 'ssh') {
          body = { ...base, transport: 'ssh', remote: field('f_remote'), alias: field('f_alias') };
          if (!body.remote || !body.alias) { toast(t('toast.fillRequired'), 'error'); return; }
        } else {
          const missing = (form?.fields || []).filter(f => f.required && (form.values[f.key] === undefined || form.values[f.key] === ''));
          if (missing.length) { toast(t('toast.fillTransport', { fields: missing.map(f => pick(f.label) || f.key).join(', ') }), 'error'); return; }
          body = { ...base, transport, params: { ...(form?.values || {}) } };
        }
        if (!body.key || !body.label || !body.port) { toast(t('toast.fillRequired'), 'error'); return; }
        const { key, ...update } = body;
        const ok = await mutate(() => existingKey
          ? ctx.api.put(`/servers/${encodeURIComponent(existingKey)}`, update)
          : ctx.api.post('/servers', { ...body, groupKey: forceGroupKey || field('f_group') }), t('toast.serverSaved'));
        if (ok) { form = null; closeModal(); }
      },
      async deleteServer(key) {
        if (!confirm(t('confirm.deleteServer', { name: key }))) return;
        await mutate(() => ctx.api.del(`/servers/${encodeURIComponent(key)}`), t('toast.serverDeleted'));
      },
      assignServer(groupKey) {
        const g = state.groups.find(x => x.key === groupKey);
        if (!g) return;
        const available = state.servers.filter(s => !g.servers.some(x => x.key === s.key));
        openModal(t('modal.assignServer'), `
          <div class="form-row">
            <label>${esc(t('form.availableServers'))}</label>
            <select class="form-input" id="f_assign_server" size="8" style="height:auto">${available.map(s =>
              `<option value="${esc(s.key)}">${esc(s.label)} (${esc(s.type || 'TCP')} :${esc(s.port)})</option>`).join('')}</select>
          </div>`, modalButtons(t('core.action.add'), `Ext.tunnels.doAssign(${JSON.stringify(groupKey)})`));
      },
      async doAssign(groupKey) {
        const serverKey = field('f_assign_server');
        if (!serverKey) { toast(t('toast.selectServer'), 'error'); return; }
        const g = state.groups.find(x => x.key === groupKey);
        const ok = await mutate(() => ctx.api.put(`/groups/${encodeURIComponent(groupKey)}`,
          { servers: [...g.servers.map(s => s.key), serverKey] }), t('toast.serverAssigned'));
        if (ok) closeModal();
      },
      removeFromGroup(groupKey, serverKey) {
        const g = state.groups.find(x => x.key === groupKey);
        if (!g) return;
        mutate(() => ctx.api.put(`/groups/${encodeURIComponent(groupKey)}`, { servers: g.servers.map(s => s.key).filter(k => k !== serverKey) }));
      },
    };

    // pulsanti statici di sidebar.html
    ctx.sidebar.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'settings' || a === 'tunnels') { mode = a; render(); }
      else if (a === 'add-group') actions.addGroup();
    });

    ctx.expose(actions);
    system = await ctx.core.get('/system').catch(() => system);
    await load();
    setInterval(load, POLL_MS);

    this.render = render;
    this.newServer = prefill => { mode = 'settings'; render(); actions.addServer(settingsGroup && settingsGroup !== ORPHANS ? settingsGroup : '', prefill); };
    this.renderPills = renderPills;
    this.load = load;
    this.stopLogs = stopLogs;
    this.pauseLogs = pauseLogs;
    this.resumeLogs = resumeLogs;
  },

  show() { this.render(); this.resumeLogs(); },
  // aperta da altre estensioni: { newServer: { label, port, transport, params } } apre il form di
  // un server nuovo già compilato (es. "Port-forward…" dai pod di kubectl)
  async focus(params) {
    if (params?.newServer) { await this.load(); this.newServer(params.newServer); }
  },
  hide() { this.pauseLogs(); },
  refresh() { this.load(); },
  languageChanged() { this.renderPills(); this.render(); },
};
