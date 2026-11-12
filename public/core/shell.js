// Shell delle estensioni: tab e pulsanti nell'header, pannelli, caricamento lazy di
// view.html / style.css / view.js e contesto (ctx) passato ai moduli frontend.
// Contratto in docs/EXTENSIONS.md. Navigazione, header e avvio dell'app.
window.Shell = (() => {
  const { esc, js, cssColor, ansiToHtml, ansiState, toast, openModal, closeModal, apiClient, formatUptime, toolNotice, contextMenu } = window.UI;
  const { t, fmt } = window.I18n;
  const pick = v => window.I18n.pick(v);

  const exts = new Map();   // code → { meta, panel, sidebar, tab, module, ctx, loading }
  const bus = new EventTarget();
  let active = null;        // code dell'estensione visibile
  let extList = [];         // dati di /api/core/extensions
  let notificationsEnabled = false;
  window.Ext = window.Ext || {}; // funzioni esposte per gli handler inline (ctx.expose)

  // ---- avvio: crea tab/pulsanti per le estensioni con frontend ----
  async function init() {
    window.Projects.setOnChange(() => bus.dispatchEvent(new CustomEvent('core:projects-changed')));
    let list = [];
    let failure = null;
    try { list = await apiClient('/api/core').get('/extensions'); }
    catch (e) { failure = e; }
    // cataloghi del core e delle estensioni attive, prima di creare qualsiasi testo
    await window.I18n.init(list.filter(e => e.state !== 'disabled'));
    window.I18n.apply(document);
    renderLanguageButton();
    await window.Theme.init(list);
    if (failure) { toast(t('core.extensions.unavailable', { error: failure.message }), 'error'); return; }
    extList = list;

    for (const meta of list) {
      if (meta.state === 'disabled') { console.warn(`[ext:${meta.code}] disattivata: ${meta.error}`); continue; }
      if (usable(meta) && meta.frontend?.js) addEntry(meta);
    }
    await setupTabOrder();
    window.Extensions?.init();

    // preload: modulo montato subito (nascosto), per pill, badge e notifiche in background
    await Promise.all([...exts.values()].filter(e => e.meta.frontend.preload).map(e => load(e).catch(() => {})));
  }

  const usable = meta => meta.state === 'ok' || meta.state === 'warning';

  function addEntry(meta) {
    const entry = { meta, panel: createPanel(meta), sidebar: createSidebar(meta), tab: null, module: null, ctx: null, loading: null, css: null };
    entry.tab = meta.position === 'header' ? createHeaderButton(meta)
      : meta.position === 'sidebar' ? createRailButton(meta)
      : createTab(meta, meta.position === 'tab-icon');
    exts.set(meta.code, entry);
    return entry;
  }

  // Toglie dalla pagina un'estensione scaricata o da ricaricare: modulo smontato, tab,
  // pannello, sidebar, stile, pill e funzioni esposte
  function removeEntry(code) {
    const entry = exts.get(code);
    if (!entry) return;
    if (active === code) { try { entry.module?.hide?.(entry.ctx); } catch (e) { console.error(e); } active = null; }
    try { entry.module?.unmount?.(entry.ctx); } catch (e) { console.error(e); }
    entry.tab?.remove();
    entry.panel.remove();
    entry.sidebar.remove();
    entry.css?.remove();
    document.querySelector(`#activePills [data-ext="${code}"]`)?.remove();
    delete window.Ext[code];
    exts.delete(code);
    updateRail();
  }

  // Allinea la pagina alle estensioni del server dopo un'installazione, un aggiornamento, una
  // rimozione o un cambio di stato, senza ricaricare la pagina né toccare le altre estensioni
  async function syncExtensions() {
    let list;
    try { list = await apiClient('/api/core').get('/extensions'); } catch (e) { toast(e.message, 'error'); return; }
    const wanted = new Map(list.filter(m => usable(m) && m.frontend?.js).map(m => [m.code, m]));
    const changed = [];
    const wasActive = active;
    for (const [code, entry] of [...exts]) {
      const meta = wanted.get(code);
      if (!meta || meta.loadId !== entry.meta.loadId || meta.dir !== entry.meta.dir) { removeEntry(code); changed.push(code); }
      else if (meta.position !== entry.meta.position) removeEntry(code); // spostata tra tab e header: stesso modulo, nuovo posto
    }
    extList = list;
    window.Theme.setExtensions(list);
    await window.I18n.setExtensions(list.filter(usable), [...changed, ...[...wanted.keys()].filter(c => !exts.has(c))]);
    for (const meta of wanted.values()) {
      if (exts.has(meta.code)) continue;
      const entry = addEntry(meta);
      if (entry.tab?.classList.contains('section-tab')) makeTabDraggable(entry.tab);
      if (entry.tab?.classList.contains('rail-btn')) makeRailDraggable(entry.tab);
      if (meta.frontend.preload) load(entry).catch(() => {});
    }
    applyTabOrder(savedTabOrder);
    applyRailOrder(savedRailOrder);
    const next = wasActive && exts.has(wasActive) ? wasActive : active || firstSection();
    active = null;
    if (next) activate(next);
    else document.querySelector('.app').classList.remove('no-sidebar');
  }

  // Prima estensione in ordine di tab (o della barra a destra): quella aperta all'avvio
  function firstSection() {
    const first = document.querySelector('.section-nav .section-tab') || document.querySelector('#rightRail .rail-btn');
    return first ? first.id.replace(/^ext-tab-/, '') : null;
  }

  function warningMark(meta) {
    return meta.warnings?.length
      ? `<span class="ext-warning" title="${esc((meta.warningInfo || meta.warnings).map(w => window.I18n.errorText(w)).join('\n'))}">${UI.icon('triangle-alert')}</span>` : '';
  }

  // iconOnly: posizione "tab-icon", solo l'icona (il nome nel tooltip) e il badge come un pallino
  // o un numero piccolo
  function createTab(meta, iconOnly = false) {
    const btn = document.createElement('button');
    btn.className = iconOnly ? 'section-tab section-tab-compact' : 'section-tab';
    btn.id = `ext-tab-${meta.code}`;
    btn.style.setProperty('--tab-color', UI.extColor(meta.code, meta.color));
    btn.innerHTML = `
      <span class="section-tab-icon">${UI.iconOrText(meta.icon || pick(meta.name).slice(0, 2))}</span>
      ${iconOnly ? '' : `<span class="section-tab-name">${esc(pick(meta.name))}</span>`}${warningMark(meta)}
      <span class="section-tab-badge" style="display:none"></span>`;
    btn.dataset.order = meta.order;
    btn.title = iconOnly ? `${pick(meta.name)}\n${t('core.tabs.moveHint')}` : t('core.tabs.moveHint');
    if (iconOnly) btn.setAttribute('aria-label', pick(meta.name));
    btn.addEventListener('click', () => open(meta.code));
    // posizione per "order", insieme ai tab delle sezioni del core (data-order)
    const nav = document.querySelector('.section-nav');
    const next = [...nav.children].find(el => Number(el.dataset.order ?? 100) > meta.order);
    nav.insertBefore(btn, next || null);
    return btn;
  }

  // ---- ordine delle tab: trascinamento (o Alt+←/→), salvato in config.json (layout.tabs) ----
  const coreApi = apiClient('/api/core');
  let customTabOrder = false;
  let savedTabOrder = [];
  const navEl = () => document.querySelector('.section-nav');
  const tabButtons = () => [...navEl().querySelectorAll('.section-tab')];
  const tabCode = el => el.id.replace(/^ext-tab-/, '');

  // Prima le tab nell'ordine salvato, poi le altre (estensioni nuove) nell'ordine dei manifest
  function applyTabOrder(saved) {
    const key = el => {
      const code = tabCode(el);
      const i = saved.indexOf(code);
      return [i < 0 ? Infinity : i, exts.get(code)?.meta.order ?? 100, code];
    };
    const cmp = (a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); };
    tabButtons().sort(cmp).forEach(el => navEl().appendChild(el));
  }

  async function saveTabOrder() {
    try {
      savedTabOrder = (await coreApi.put('/layout/tabs', { tabs: tabButtons().map(tabCode) })).tabs;
      customTabOrder = true;
    } catch (e) { toast(e.message, 'error'); }
  }

  async function restoreTabOrder() {
    try {
      await coreApi.del('/layout/tabs');
      customTabOrder = false;
      savedTabOrder = [];
      applyTabOrder([]);
    } catch (e) { toast(e.message, 'error'); }
  }

  let dragged = null, orderBefore = '';

  // Trascinamento e Alt+←/→ su una tab (anche aggiunta dopo l'avvio)
  function makeTabDraggable(tab) {
    tab.draggable = true;
    tab.addEventListener('dragstart', e => {
      dragged = tab;
      orderBefore = tabButtons().map(tabCode).join();
      tab.classList.add('tab-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabCode(tab));
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('tab-dragging');
      dragged = null;
      if (tabButtons().map(tabCode).join() !== orderBefore) saveTabOrder();
    });
    // Alt+←/→ sposta la tab che ha il focus (in una lingua da destra a sinistra le frecce si invertono)
    tab.addEventListener('keydown', e => {
      if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
      e.preventDefault();
      const forward = (e.key === 'ArrowRight') !== (document.documentElement.dir === 'rtl');
      const sibling = forward ? tab.nextElementSibling : tab.previousElementSibling;
      if (!sibling?.classList.contains('section-tab')) return;
      navEl().insertBefore(tab, forward ? sibling.nextElementSibling : sibling);
      tab.focus();
      saveTabOrder();
    });
  }

  async function setupTabOrder() {
    const nav = navEl();
    let saved = null;
    try { saved = await coreApi.get('/layout'); savedTabOrder = saved.tabs; } catch { /* ordine dei manifest */ }
    setupRail(saved?.rail);
    customTabOrder = savedTabOrder.length > 0;
    applyTabOrder(savedTabOrder);
    tabButtons().forEach(makeTabDraggable);
    nav.addEventListener('dragover', e => {
      if (!dragged) return;
      e.preventDefault();
      const target = e.target.closest('.section-tab');
      if (!target || target === dragged) return;
      const rect = target.getBoundingClientRect();
      const after = (e.clientX > rect.left + rect.width / 2) !== (document.documentElement.dir === 'rtl');
      nav.insertBefore(dragged, after ? target.nextElementSibling : target);
    });
    nav.addEventListener('drop', e => { if (dragged) e.preventDefault(); });
    nav.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: t('core.tabs.restore'), icon: 'rotate-ccw', disabled: !customTabOrder, action: restoreTabOrder },
      ]);
    });
  }

  // ---- barra a destra (posizione "sidebar"): icone nel colore dell'estensione, visibile solo
  // con almeno un'estensione; ordine per trascinamento (o Alt+↑/↓), salvato in layout.rail ----
  const railEl = () => document.getElementById('rightRail');
  const railButtons = () => [...railEl().querySelectorAll('.rail-btn')];
  let savedRailOrder = [];
  let railDragged = null, railBefore = '';

  function updateRail() {
    const has = railButtons().length > 0;
    railEl().hidden = !has;
    document.querySelector('.app').classList.toggle('has-rail', has);
  }

  function createRailButton(meta) {
    const btn = document.createElement('button');
    btn.className = 'rail-btn';
    btn.id = `ext-tab-${meta.code}`;
    btn.dataset.order = meta.order;
    btn.style.setProperty('--tab-color', UI.extColor(meta.code, meta.color));
    btn.title = `${pick(meta.name)}\n${t('core.rail.moveHint')}`;
    btn.setAttribute('aria-label', pick(meta.name));
    btn.innerHTML = `<span class="rail-icon">${UI.iconOrText(meta.icon || pick(meta.name).slice(0, 2))}</span>${warningMark(meta)}<span class="section-tab-badge" style="display:none"></span>`;
    btn.addEventListener('click', () => open(meta.code));
    railEl().appendChild(btn);
    applyRailOrder(savedRailOrder);
    updateRail();
    return btn;
  }

  function applyRailOrder(saved) {
    const key = el => { const code = tabCode(el); const i = saved.indexOf(code); return [i < 0 ? Infinity : i, exts.get(code)?.meta.order ?? Number(el.dataset.order ?? 100), code]; };
    railButtons().sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); })
      .forEach(el => railEl().appendChild(el));
  }

  async function saveRailOrder() {
    try { savedRailOrder = (await coreApi.put('/layout/rail', { rail: railButtons().map(tabCode) })).rail; }
    catch (e) { toast(e.message, 'error'); }
  }
  async function restoreRailOrder() {
    try { await coreApi.del('/layout/rail'); savedRailOrder = []; applyRailOrder([]); }
    catch (e) { toast(e.message, 'error'); }
  }

  function makeRailDraggable(btn) {
    btn.draggable = true;
    btn.addEventListener('dragstart', e => {
      railDragged = btn;
      railBefore = railButtons().map(tabCode).join();
      btn.classList.add('tab-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tabCode(btn));
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('tab-dragging');
      railDragged = null;
      if (railButtons().map(tabCode).join() !== railBefore) saveRailOrder();
    });
    btn.addEventListener('keydown', e => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const sibling = e.key === 'ArrowDown' ? btn.nextElementSibling : btn.previousElementSibling;
      if (!sibling?.classList.contains('rail-btn')) return;
      railEl().insertBefore(btn, e.key === 'ArrowDown' ? sibling.nextElementSibling : sibling);
      btn.focus();
      saveRailOrder();
    });
  }

  function setupRail(saved) {
    const rail = railEl();
    savedRailOrder = saved || [];
    applyRailOrder(savedRailOrder);
    railButtons().forEach(makeRailDraggable);
    rail.addEventListener('dragover', e => {
      if (!railDragged) return;
      e.preventDefault();
      const target = e.target.closest('.rail-btn');
      if (!target || target === railDragged) return;
      const rect = target.getBoundingClientRect();
      rail.insertBefore(railDragged, e.clientY > rect.top + rect.height / 2 ? target.nextElementSibling : target);
    });
    rail.addEventListener('drop', e => { if (railDragged) e.preventDefault(); });
    rail.addEventListener('contextmenu', e => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: t('core.rail.restore'), icon: 'rotate-ccw', disabled: !savedRailOrder.length, action: restoreRailOrder },
      ]);
    });
    updateRail();
  }

  function createHeaderButton(meta) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost ext-header-btn';
    btn.id = `ext-tab-${meta.code}`;
    btn.title = pick(meta.name);
    btn.style.setProperty('--tab-color', UI.extColor(meta.code, meta.color));
    btn.innerHTML = `${meta.icon ? UI.iconOrText(meta.icon) : esc(pick(meta.name))}${warningMark(meta)}<span class="section-tab-badge" style="display:none"></span>`;
    btn.addEventListener('click', () => open(meta.code));
    const actions = document.querySelector('.header-actions');
    actions.insertBefore(btn, actions.querySelector('#stopAllBtn'));
    return btn;
  }

  function createPanel(meta) {
    const panel = document.createElement('div');
    panel.className = 'main-panel ext-panel';
    panel.id = `ext-panel-${meta.code}`;
    panel.style.display = 'none';
    panel.style.setProperty('--ext-color', UI.extColor(meta.code, meta.color));
    panel.dataset.i18nNs = meta.code;
    panel.innerHTML = `
      <div class="ext-root"></div>
      <div class="sse-panel">
        <div class="sse-resizer" role="separator" aria-orientation="horizontal" tabindex="0" data-i18n-title="core.output.resize" data-i18n-aria-label="core.output.resize"></div>
        <div class="sse-panel-header">
          <span class="sse-title" data-i18n="core.output.title"></span>
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-ghost btn-sm" data-sse="clear" data-i18n-title="core.output.clear"><i data-icon="trash-2"></i></button>
            <button class="btn btn-ghost btn-sm" data-sse="close" data-i18n-aria-label="core.action.close"><i data-icon="x"></i></button>
          </div>
        </div>
        <div class="sse-body"></div>
      </div>`;
    window.I18n.apply(panel);
    document.querySelector('main.main').appendChild(panel);
    return panel;
  }

  function createSidebar(meta) {
    const sb = document.createElement('div');
    sb.className = 'ext-sidebar';
    sb.id = `ext-sidebar-${meta.code}`;
    sb.style.display = 'none';
    sb.style.setProperty('--ext-color', UI.extColor(meta.code, meta.color));
    sb.dataset.i18nNs = meta.code;
    document.getElementById('sidebar').appendChild(sb);
    return sb;
  }

  function pillsContainer(code) {
    let el = document.querySelector(`#activePills [data-ext="${code}"]`);
    if (!el) {
      el = document.createElement('span');
      el.className = 'ext-pills';
      el.dataset.ext = code;
      el.style.setProperty('--ext-color', UI.extColor(code, exts.get(code)?.meta.color));
      document.getElementById('activePills').prepend(el);
    }
    return el;
  }

  // ---- caricamento lazy ----
  function load(entry) {
    if (entry.loading) return entry.loading;
    const { meta } = entry;
    const base = `/ext/${meta.code}/`;
    const v = `?v=${encodeURIComponent(meta.loadId ?? 0)}`; // un'estensione ricaricata non riusa i file in cache
    entry.loading = (async () => {
      if (meta.frontend.css) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = base + meta.frontend.css + v;
        document.head.appendChild(link);
        entry.css = link;
      }
      const root = entry.panel.querySelector('.ext-root');
      const [html, sidebar] = await Promise.all([meta.frontend.html, meta.frontend.sidebar]
        .map(f => f ? fetch(base + f + v).then(r => r.ok ? r.text() : Promise.reject(new Error(`${f}: HTTP ${r.status}`))) : null));
      // markup statico tradotto con le chiavi dell'estensione (data-i18n…)
      if (html !== null) { root.innerHTML = html; window.I18n.apply(root, meta.code); }
      if (sidebar !== null) { entry.sidebar.innerHTML = sidebar; window.I18n.apply(entry.sidebar, meta.code); }
      const mod = await import(base + meta.frontend.js + v);
      entry.module = mod.default || mod;
      entry.ctx = makeContext(entry);
      await entry.module.mount?.(entry.ctx);
    })();
    entry.loading.catch(e => {
      entry.loading = null;
      entry.panel.querySelector('.ext-root').innerHTML =
        `<div class="empty-state"><div class="icon">${UI.icon('triangle-alert')}</div><p>${esc(t('core.extensions.loadError', { name: pick(meta.name), error: e.message }))}</p></div>`;
    });
    return entry.loading;
  }

  // Client API di un'estensione con le risposte SSE: stream (POST) ed events (GET)
  function withStreams(api) {
    // POST con risposta SSE (es. azioni git): onEvent({type, data}); restituisce l'exit code
    api.stream = async (p, body, onEvent) => {
      const res = await fetch(api.url(p), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        // stato e corpo restano sull'errore: la UI può reagire ai codici (es. 409 { code })
        throw Object.assign(new Error(window.I18n.errorText(d, `HTTP ${res.status}`)), { status: res.status, code: d.code, data: d });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', exit = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.replace(/^data: /, '').trim();
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'exit') exit = ev.data;
          onEvent?.(ev);
        }
      }
      return exit;
    };

    // GET con risposta SSE (EventSource): restituisce una funzione per chiudere
    api.events = (p, onEvent, onError) => {
      const es = new EventSource(api.url(p));
      es.onmessage = e => { try { onEvent(JSON.parse(e.data)); } catch {} };
      es.onerror = () => { es.close(); onError?.(); };
      return () => es.close();
    };
    return api;
  }

  // ---- contesto per i moduli frontend ----
  function makeContext(entry) {
    const { meta, panel, sidebar } = entry;
    const api = withStreams(apiClient(`/api/ext/${meta.code}`));

    const sse = {
      body: panel.querySelector('.sse-body'),
      title: panel.querySelector('.sse-title'),
      box: panel.querySelector('.sse-panel'),
    };
    // colori ANSI: uno stato per stdout e uno per stderr, che continua tra un pezzo e l'altro
    let ansi = { out: ansiState(), err: ansiState() };
    const output = {
      open(title) {
        delete sse.title.dataset.i18n; // titolo scelto dall'estensione: il cambio di lingua non lo sovrascrive
        sse.title.textContent = title; sse.body.innerHTML = ''; sse.box.classList.add('open'); panel.classList.add('output-open');
        ansi = { out: ansiState(), err: ansiState() };
      },
      append(text, cls = 'out') {
        const el = document.createElement('span');
        if (cls === 'sys') { el.className = 'ansi-sys'; el.textContent = text; }
        else { el.innerHTML = ansiToHtml(String(text), cls === 'err' ? ansi.err : ansi.out); if (cls === 'err') el.classList.add('ansi-stderr'); }
        sse.body.appendChild(el);
        sse.body.scrollTop = sse.body.scrollHeight;
      },
      clear() { sse.body.innerHTML = ''; ansi = { out: ansiState(), err: ansiState() }; },
      close() { sse.box.classList.remove('open'); panel.classList.remove('output-open'); },
    };
    panel.querySelector('[data-sse="clear"]').addEventListener('click', output.clear);
    panel.querySelector('[data-sse="close"]').addEventListener('click', output.close);
    initOutputResize(meta.code, sse.box);
    // con il pannello aperto la sezione si accorcia della sua altezza (anche quando lo si
    // ridimensiona), così non copre la parte bassa: risposte, risultati, editor
    new ResizeObserver(() => panel.style.setProperty('--output-h', `${sse.box.offsetHeight}px`)).observe(sse.box);

    return {
      code: meta.code,
      meta,
      root: panel.querySelector('.ext-root'),
      sidebar,
      api,
      core: apiClient('/api/core'),
      // traduzioni: chiavi relative all'estensione ("core." per quelle del core)
      t: window.I18n.scoped(meta.code),
      i18n: {
        get lang() { return window.I18n.lang; },
        pick,
        apply: (root) => window.I18n.apply(root, meta.code),
      },
      ui: { esc, js, cssColor, extColor: UI.extColor, ansiToHtml, ansiState, toast, openModal, closeModal, patch: UI.patch, output, formatUptime, toolNotice, notify, contextMenu, t, fmt, errorText: window.I18n.errorText, icon: UI.icon, iconOrText: UI.iconOrText, badgeHtml: UI.badgeHtml },
      bus: {
        on(name, fn) { const h = e => fn(e.detail); bus.addEventListener(name, h); return () => bus.removeEventListener(name, h); },
        emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); },
      },
      expose(obj) { window.Ext[meta.code] = obj; },
      // progetti e cartelle del core (public/core/projects.js)
      projects: scopedProjects(meta),
      vault: window.Vault,
      setBadge(value) {
        const badge = entry.tab?.querySelector('.section-tab-badge');
        if (!badge) return;
        const empty = value === null || value === undefined || value === '';
        badge.style.display = empty ? 'none' : '';
        // tab solo icona e barra a destra: un numero piccolo (99+) o un pallino
        if (!empty && entry.tab.matches('.section-tab-compact, .rail-btn')) {
          const text = String(typeof value === 'object' ? value.text ?? '' : value).trim();
          const n = /^\d+$/.test(text) ? Number(text) : null;
          badge.classList.toggle('badge-dot', n === null);
          badge.textContent = n === null ? '' : n > 99 ? '99+' : String(n);
          badge.title = typeof value === 'object' ? String(value.text ?? '') : String(value);
          return;
        }
        badge.innerHTML = empty ? '' : UI.badgeHtml(value); // testo o { icon, text }
      },
      // HTML delle pill nell'header per questa estensione ('' le rimuove)
      setPills(html) { UI.patch(pillsContainer(meta.code), html || ''); },
      open,
      isActive: () => active === meta.code,
      // Un'altra estensione è caricata e attiva? (per funzioni che si appoggiano a lei)
      hasExtension: code => extList.some(e => e.code === code && (e.state === 'ok' || e.state === 'warning')),
      // Client per le API di un'altra estensione (/api/ext/<code>)
      apiFor: code => withStreams(apiClient(`/api/ext/${code}`)),
      // widget delle estensioni attive, per chi li vuole mostrare (es. la dashboard)
      widgets: { list: listWidgets, mount: mountWidget },
    };
  }

  // ---- notifiche desktop (attivate dal pulsante 🔔, usate dalle estensioni con ctx.ui.notify) ----
  function notify(title, body, icon = '🔵') {
    if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(`${icon} ${title}`, { body, silent: false });
  }

  async function toggleNotifications() {
    const btn = document.getElementById('notifBtn');
    if (notificationsEnabled) {
      notificationsEnabled = false;
      toast(t('core.notifications.off'));
    } else {
      if (!('Notification' in window)) { toast(t('core.notifications.unsupported'), 'error'); return; }
      if (await Notification.requestPermission() !== 'granted') { toast(t('core.notifications.denied'), 'error'); return; }
      notificationsEnabled = true;
      toast(t('core.notifications.on'), 'success');
    }
    btn.classList.toggle('active', notificationsEnabled);
    btn.dataset.i18nTitle = notificationsEnabled ? 'core.notifications.activeTitle' : 'core.notifications.enable';
    window.I18n.apply(btn);
  }

  // ---- export / import: caselle dichiarate dalle estensioni (setting.json → export) ----

  // [{ ext, item }] nell'ordine delle estensioni; item = { id, label, description, sections }
  // Prima la casella del core: progetti e cartelle (condivisi dalle estensioni)
  const exportItems = () => [
    { ext: { icon: 'folder-git-2', name: t('core.projects.owner') },
      item: { id: 'projects', label: t('core.projects.exportLabel'), description: t('core.projects.exportDescription'), sections: ['projects', 'projectFolders'] } },
    { ext: { icon: 'puzzle', name: t('core.ext.owner') },
      item: { id: 'extensions', label: t('core.ext.exportLabel'), description: t('core.ext.exportDescription'), sections: ['extensions'] } },
    ...extList
      .filter(e => e.state !== 'disabled')
      .flatMap(e => (e.export || []).map(item => ({ ext: e, item }))),
  ];

  const checkboxList = (entries, detail) => entries.map(({ ext, item }) => `
    <label class="export-item">
      <input type="checkbox" value="${esc(item.sections.join(','))}" checked>
      <div>
        <div class="export-name">${esc(pick(item.label))} <span class="export-keys">· ${ext.icon ? `${UI.iconOrText(ext.icon)} ` : ''}${esc(pick(ext.name))}</span></div>
        <div class="export-keys">${esc(detail(item))}</div>
      </div>
    </label>`).join('');

  const checkedKeys = () => [...new Set([...document.querySelectorAll('.export-list input[type=checkbox]:checked')].flatMap(b => b.value.split(',')))];

  function exportConfig() {
    const entries = exportItems();
    if (!entries.length) { toast(t('core.export.nothing'), 'info'); return; }
    openModal(t('core.export.title'), `
      <div class="export-list">
        <p class="export-hint">${esc(t('core.export.hint'))}</p>
        ${checkboxList(entries, item => pick(item.description) || item.sections.join(', '))}
      </div>`,
      `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="Shell.doExport()">${UI.icon('download')} ${esc(t('core.export.submit'))}</button>`);
  }

  function doExport() {
    const keys = checkedKeys();
    if (!keys.length) { toast(t('core.export.selectOne'), 'error'); return; }
    const all = !document.querySelector('.export-list input[type=checkbox]:not(:checked)');
    closeModal();
    window.location.href = `/api/core/config/export?name=${all ? 'all' : 'partial'}&sections=${encodeURIComponent(keys.join(','))}`;
  }

  // Import: il file viene letto nel browser, poi si scelgono le estensioni da importare e la modalità
  let pendingImport = null;

  async function importConfig(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const cfg = JSON.parse(await file.text());
      // Caselle dichiarate dalle estensioni di cui il file contiene i dati
      const entries = exportItems().filter(({ item }) => item.sections.some(k => cfg[k] !== undefined));
      if (!entries.length) { toast(t('core.import.nothing'), 'error'); return; }
      pendingImport = cfg;
      const count = k => Array.isArray(cfg[k]) ? ` (${fmt.number(cfg[k].length)})` : '';
      openModal(t('core.import.title'), `
        <div class="export-list">
          <p class="export-hint">${esc(t('core.import.hint', { file: file.name }))}</p>
          ${checkboxList(entries, item => item.sections.filter(k => cfg[k] !== undefined).map(k => k + count(k)).join(', '))}
          <p class="export-hint">${esc(t('core.import.mode'))}</p>
          <label class="export-item"><input type="radio" name="importMode" value="merge" checked>
            <div><div class="export-name">${esc(t('core.import.merge'))}</div><div class="export-keys">${esc(t('core.import.mergeHint'))}</div></div></label>
          <label class="export-item"><input type="radio" name="importMode" value="replace">
            <div><div class="export-name">${esc(t('core.import.replace'))}</div><div class="export-keys">${esc(t('core.import.replaceHint'))}</div></div></label>
        </div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Shell.doImport()">${UI.icon('upload')} ${esc(t('core.import.submit'))}</button>`);
    } catch (e) { toast(t('core.import.error', { error: e.message }), 'error'); }
  }

  async function doImport() {
    const keys = checkedKeys();
    if (!keys.length) { toast(t('core.export.selectOne'), 'error'); return; }
    const mode = document.querySelector('input[name="importMode"]:checked')?.value || 'merge';
    const config = Object.fromEntries(keys.filter(k => pendingImport[k] !== undefined).map(k => [k, pendingImport[k]]));
    try {
      await apiClient('/api/core').post('/config/import', { config, mode });
      closeModal();
      pendingImport = null;
      toast(t(mode === 'replace' ? 'core.import.doneReplace' : 'core.import.doneMerge'), 'success');
      refresh();
    } catch (e) { toast(t('core.import.error', { error: e.message }), 'error'); }
  }

  // ---- server MCP: endpoint, token, configurazione dei client, strumenti ----
  let mcpData = null, mcpShowToken = false;

  async function openMcp() {
    try { mcpData = await apiClient('/api/core').get('/mcp'); }
    catch (e) { toast(e.message, 'error'); return; }
    mcpShowToken = false;
    renderMcp();
  }

  function mcpSnippets() {
    const auth = `Bearer ${mcpData.token}`;
    return {
      url: mcpData.url,
      token: mcpData.token,
      claudeCode: `claude mcp add --transport http kelbo ${mcpData.url} --header "Authorization: ${auth}"`,
      // ponte stdio di Kelbo: nessun token nella configurazione del client
      desktop: JSON.stringify({ mcpServers: { kelbo: { command: mcpData.bridge.command, args: mcpData.bridge.args, ...(Object.keys(mcpData.bridge.env).length ? { env: mcpData.bridge.env } : {}) } } }, null, 2),
    };
  }

  function renderMcp() {
    const sn = mcpSnippets();
    const masked = mcpShowToken ? mcpData.token : `${mcpData.token.slice(0, 6)}${'•'.repeat(20)}`;
    const hide = text => (mcpShowToken ? text : text.split(mcpData.token).join(masked));
    const block = (id, text) => `<div class="mcp-row"><pre class="mcp-code">${esc(hide(text))}</pre>
      <button class="btn btn-ghost btn-sm" onclick="Shell.mcpCopy(${js(id)})">${esc(t('core.mcp.copy'))}</button></div>`;
    const names = new Map(extList.map(e => [e.code, `${e.icon ? `${UI.iconOrText(e.icon)} ` : ''}${esc(pick(e.name))}`]));
    const byExt = new Map();
    for (const tool of mcpData.tools) byExt.set(tool.extension, [...(byExt.get(tool.extension) || []), tool]);
    openModal(t('core.mcp.title'), `
      <div class="mcp-body">
        <p class="mcp-muted">${esc(t('core.mcp.intro'))}</p>
        <div class="mcp-section">
          <h4>${esc(t('core.mcp.endpoint'))}</h4>
          ${block('url', sn.url)}
          <h4>${esc(t('core.mcp.token'))}</h4>
          <div class="mcp-row"><pre class="mcp-code">${esc(masked)}</pre>
            <button class="btn btn-ghost btn-sm" onclick="Shell.mcpToggle()">${esc(t(mcpShowToken ? 'core.mcp.hide' : 'core.mcp.show'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="Shell.mcpCopy('token')">${esc(t('core.mcp.copy'))}</button>
            <button class="btn btn-ghost btn-sm" onclick="Shell.mcpRegenerate()">${esc(t('core.mcp.regenerate'))}</button></div>
          <p class="mcp-muted">${esc(t('core.mcp.tokenHint'))}</p>
        </div>
        <div class="mcp-section">
          <h4>${esc(t('core.mcp.claudeCode'))}</h4>
          ${block('claudeCode', sn.claudeCode)}
          <h4>${esc(t('core.mcp.claudeDesktop'))}</h4>
          <p class="mcp-muted">${esc(t('core.mcp.claudeDesktopHint'))}</p>
          ${block('desktop', sn.desktop)}
          <p class="mcp-muted">${esc(t('core.mcp.otherClients'))}</p>
        </div>
        <div class="mcp-section">
          <h4>${esc(t('core.mcp.tools', { count: mcpData.tools.length }))}</h4>
          <p class="mcp-muted">${esc(t('core.mcp.toolsHint'))}</p>
          <div class="mcp-tools">${[...byExt].map(([ext, tools]) => `
            <div class="mcp-ext">${names.get(ext) || esc(ext)}</div>
            ${tools.map(tool => `<div class="mcp-tool-name">${esc(tool.name)}<span class="mcp-badge ${tool.readOnly ? '' : 'write'}">${esc(t(tool.readOnly ? 'core.mcp.read' : 'core.mcp.write'))}</span></div>
              <div class="mcp-muted">${esc(tool.description)}</div>`).join('')}`).join('')}
          </div>
        </div>
      </div>`,
      `<button class="btn btn-primary" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
    document.getElementById('modal').classList.add('modal-mcp');
  }

  async function mcpCopy(what) {
    try { await navigator.clipboard.writeText(mcpSnippets()[what]); toast(t('core.mcp.copied'), 'success'); }
    catch { toast(t('core.mcp.copyFailed'), 'error'); }
  }

  async function mcpRegenerate() {
    if (!confirm(t('core.mcp.confirmRegenerate'))) return;
    try {
      mcpData.token = (await apiClient('/api/core').post('/mcp/token')).token;
      toast(t('core.mcp.regenerated'), 'success');
      renderMcp();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---- lingua: pulsante nell'header (solo con più di una lingua) e cambio senza ricaricare ----
  function renderLanguageButton() {
    const btn = document.getElementById('langBtn');
    if (!btn) return;
    const langs = window.I18n.languages;
    btn.hidden = langs.length < 2;
    btn.querySelector('.lang-code').textContent = window.I18n.lang.toUpperCase();
  }

  function chooseLanguage(event) {
    const r = event.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, window.I18n.languages.map(l => ({
      icon: l.tag === window.I18n.lang ? 'check' : '',
      label: l.completeness < 100 ? `${l.nativeName} · ${fmt.number(l.completeness / 100, { style: 'percent' })}` : l.nativeName,
      action: () => window.I18n.setLanguage(l.tag),
    })));
  }

  // Testi creati dalla shell e moduli montati, di nuovo nella lingua attiva
  window.I18n.onChange(() => {
    renderLanguageButton();
    for (const e of exts.values()) {
      const name = pick(e.meta.name);
      const label = e.tab?.querySelector('.section-tab-name');
      if (label) { label.textContent = name; e.tab.title = t('core.tabs.moveHint'); }
      else if (e.tab) e.tab.title = name;
      if (!e.module || !e.ctx) continue;
      try { (e.module.languageChanged || e.module.refresh)?.call(e.module, e.ctx); } catch (err) { console.error(err); }
    }
  });

  // ---- larghezza della sidebar, una per sezione: trascinando la maniglia (o con ←/→),
  // salvata nel browser come { <codice estensione>: larghezza } ----
  const SIDEBAR_KEY = 'devdock.sidebarWidths';
  const SIDEBAR_DEFAULT = 220, SIDEBAR_MIN = 160;
  // al massimo il 60% della finestra (non si limita se la finestra è minuscola o non visibile)
  const sidebarMax = () => (window.innerWidth >= 400 ? Math.max(SIDEBAR_MIN, Math.min(640, Math.round(window.innerWidth * 0.6))) : 640);
  function savedWidths() {
    try { return JSON.parse(localStorage.getItem(SIDEBAR_KEY)) || {}; } catch { return {}; }
  }
  function storeWidth(code, width) {
    if (!code) return;
    const all = savedWidths();
    if (width == null) delete all[code]; else all[code] = width;
    try { localStorage.setItem(SIDEBAR_KEY, JSON.stringify(all)); } catch { /* storage non disponibile */ }
  }
  function setSidebarWidth(w, save = true) {
    const width = Math.round(Math.min(sidebarMax(), Math.max(SIDEBAR_MIN, w)));
    document.querySelector('.app').style.setProperty('--sidebar-w', `${width}px`);
    if (save) storeWidth(active, width);
    return width;
  }
  // Larghezza della sezione che si apre (quella salvata o l'iniziale)
  function applySidebarWidth(code) {
    setSidebarWidth(savedWidths()[code] || SIDEBAR_DEFAULT, false);
  }
  (function initSidebarResize() {
    const handle = document.getElementById('sidebarResizer');
    const sidebar = document.getElementById('sidebar');
    try { localStorage.removeItem('devdock.sidebarWidth'); } catch { /* chiave della 1.13.0, una sola larghezza */ }
    const current = () => sidebar.getBoundingClientRect().width;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing-sidebar');
      const r = sidebar.getBoundingClientRect();
      const rtl = document.documentElement.dir === 'rtl';
      const move = ev => setSidebarWidth(rtl ? r.right - ev.clientX : ev.clientX - r.left, false);
      const up = ev => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing-sidebar');
        setSidebarWidth(current());
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => {
      setSidebarWidth(SIDEBAR_DEFAULT, false);
      storeWidth(active, null);
    });
    handle.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const grow = (e.key === 'ArrowRight') !== (document.documentElement.dir === 'rtl');
      setSidebarWidth(current() + (grow ? 16 : -16));
    });
    // finestra rimpicciolita: la sidebar resta entro il massimo
    window.addEventListener('resize', () => { if (window.innerWidth >= 400 && current() > sidebarMax()) setSidebarWidth(sidebarMax(), false); });
  })();

  // ---- altezza del pannello di output, una per sezione: stessa logica della sidebar
  // (trascinando il bordo superiore, con ↑/↓, doppio clic per l'altezza iniziale) ----
  const OUTPUT_KEY = 'devdock.outputHeights';
  const OUTPUT_DEFAULT = 260, OUTPUT_MIN = 120;
  // al massimo l'85% del pannello dell'estensione (o della finestra, se non ancora visibile)
  const outputMax = box => {
    const h = box.parentElement?.getBoundingClientRect().height || window.innerHeight;
    return h >= 200 ? Math.max(OUTPUT_MIN, Math.round(h * 0.85)) : 2000;
  };
  function savedHeights() {
    try { return JSON.parse(localStorage.getItem(OUTPUT_KEY)) || {}; } catch { return {}; }
  }
  function storeHeight(code, height) {
    const all = savedHeights();
    if (height == null) delete all[code]; else all[code] = height;
    try { localStorage.setItem(OUTPUT_KEY, JSON.stringify(all)); } catch { /* storage non disponibile */ }
  }
  function initOutputResize(code, box) {
    const handle = box.querySelector('.sse-resizer');
    const setHeight = (h, save = true) => {
      const height = Math.round(Math.min(outputMax(box), Math.max(OUTPUT_MIN, h)));
      box.style.height = `${height}px`;
      if (save) storeHeight(code, height);
      return height;
    };
    const saved = savedHeights()[code];
    if (saved) box.style.height = `${Math.max(OUTPUT_MIN, saved)}px`;
    const current = () => box.getBoundingClientRect().height;
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing-output');
      const bottom = box.getBoundingClientRect().bottom;
      const move = ev => setHeight(bottom - ev.clientY, false);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing-output');
        setHeight(current());
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    handle.addEventListener('dblclick', () => { box.style.height = ''; storeHeight(code, null); });
    handle.addEventListener('keydown', e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      setHeight(current() + (e.key === 'ArrowUp' ? 16 : -16));
    });
  }

  // ---- aggiornamento manuale (pulsante ↻): estensioni montate + sezioni del core ----
  function refresh() {
    for (const e of exts.values()) {
      if (e.module && e.ctx) { try { e.module.refresh?.(e.ctx); } catch (err) { console.error(err); } }
    }
  }

  // ---- navigazione ----
  const has = code => exts.has(code);

  // Mostra l'estensione code (null = nessuna: torna a una sezione del core)
  async function activate(code) {
    if (active === code) return;
    const prev = active && exts.get(active);
    if (prev) {
      prev.panel.style.display = 'none';
      prev.sidebar.style.display = 'none';
      prev.tab?.classList.remove('active-ext');
      try { prev.module?.hide?.(prev.ctx); } catch (e) { console.error(e); }
    }
    active = code;
    // Estensione senza sidebar.html: il pannello occupa tutta la larghezza
    document.querySelector('.app').classList.toggle('no-sidebar', !!code && !exts.get(code).meta.frontend.sidebar);
    if (!code) return;
    applySidebarWidth(code);

    const entry = exts.get(code);
    entry.panel.style.display = 'flex';
    entry.sidebar.style.display = '';
    entry.tab?.classList.add('active-ext');
    try {
      await load(entry);
      if (active === code) entry.module?.show?.(entry.ctx);
    } catch { /* errore già mostrato nel pannello */ }
  }

  // Apertura da tab, pulsanti nell'header o altre estensioni; params (es. { project }) va a
  // focus(params, ctx) del modulo, se lo esporta, dopo il caricamento
  async function open(code, params) {
    if (!exts.has(code)) return;
    await activate(code);
    const entry = exts.get(code);
    if (params && active === code) { try { await entry.loading; entry.module?.focus?.(params, entry.ctx); } catch (e) { console.error(e); } }
  }

  // ---- progetti visti da un'estensione: solo quelli con i suoi tratti (manifest "projects") ----

  const withTraits = (meta, p) => !meta.projects?.traits?.length || (p.traitsActive || []).some(x => meta.projects.traits.includes(x));
  function scopedProjects(meta) {
    return {
      ...window.Projects,
      async load() {
        const data = await window.Projects.load();
        const projects = data.projects.filter(p => withTraits(meta, p));
        return { ...data, projects, hidden: data.projects.length - projects.length };
      },
    };
  }

  // ---- widget: mini viste delle estensioni per la dashboard di progetto ----

  const widgetCss = new Map(); // code → <link> dello stile dell'estensione, se il pannello non l'ha già
  function ensureExtensionCss(meta) {
    if (!meta.frontend?.css || exts.get(meta.code)?.css || widgetCss.has(meta.code)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/ext/${meta.code}/${meta.frontend.css}?v=${encodeURIComponent(meta.loadId ?? 0)}`;
    document.head.appendChild(link);
    widgetCss.set(meta.code, link);
  }

  // Widget disponibili (estensioni attive): chiave "codice/id"; con project, solo quelli delle
  // estensioni che lavorano con i suoi tratti
  function listWidgets(scope = 'project', project = null) {
    return extList.filter(usable).filter(meta => !project || withTraits(meta, project)).flatMap(meta => (meta.widgets || []).filter(w => w.scope === scope).map(w => ({
      key: `${meta.code}/${w.id}`, code: meta.code, id: w.id, title: pick(w.title), description: pick(w.description || ''),
      size: w.size, icon: meta.icon || 'box', color: meta.color, cssColor: UI.extColor(meta.code, meta.color), extension: pick(meta.name),
    })));
  }

  // Contesto di un widget: quello dell'estensione (API, traduzioni, ui, vault, bus) con el come
  // radice, più ctx.widget per il riquadro che lo ospita
  function widgetContext(meta, el, frame) {
    const extCtx = exts.get(meta.code)?.ctx;
    return {
      code: meta.code, meta, root: el,
      api: withStreams(apiClient(`/api/ext/${meta.code}`)),
      core: apiClient('/api/core'),
      t: window.I18n.scoped(meta.code),
      i18n: { get lang() { return window.I18n.lang; }, pick, apply: root => window.I18n.apply(root, meta.code) },
      ui: { esc, js, cssColor, extColor: UI.extColor, ansiToHtml, ansiState, toast, openModal, closeModal, patch: UI.patch, formatUptime, toolNotice, notify, contextMenu, t, fmt, errorText: window.I18n.errorText, icon: UI.icon, iconOrText: UI.iconOrText, badgeHtml: UI.badgeHtml },
      bus: {
        on(name, fn) { const h = e => fn(e.detail); bus.addEventListener(name, h); return () => bus.removeEventListener(name, h); },
        emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); },
      },
      projects: scopedProjects(meta),
      vault: window.Vault,
      open,
      hasExtension: code => extList.some(e => e.code === code && usable(e)),
      apiFor: code => withStreams(apiClient(`/api/ext/${code}`)),
      // il pannello dell'estensione, se è già stato aperto (per chi vuole riusarne lo stato)
      panelCtx: () => extCtx || exts.get(meta.code)?.ctx || null,
      widget: {
        setTitle: text => frame.onTitle?.(text),
        setBadge: value => frame.onBadge?.(value),
        openFull: params => open(meta.code, params),
      },
    };
  }

  // Monta il widget "codice/id" in el: → { refresh(), unmount() }. Un widget che fallisce
  // mostra l'errore nel suo riquadro e non tocca gli altri
  async function mountWidget(key, el, params = {}, frame = {}) {
    const [code, id] = String(key).split('/');
    const meta = extList.find(m => m.code === code && usable(m));
    const w = meta?.widgets?.find(x => x.id === id);
    const fail = e => {
      console.error(`[widget ${key}]`, e);
      el.innerHTML = `<div class="widget-error">${UI.icon('triangle-alert')} ${esc(t('core.widgets.failed', { error: e?.message || String(e) }))}</div>`;
    };
    if (!w) { el.innerHTML = `<div class="widget-error">${esc(t('core.widgets.unavailable', { widget: key }))}</div>`; return { refresh() {}, unmount() {} }; }
    let mod = null, ctx = null;
    try {
      ensureExtensionCss(meta);
      mod = await import(`/ext/${code}/${w.js}?v=${encodeURIComponent(meta.loadId ?? 0)}`);
      mod = mod.default || mod;
      ctx = widgetContext(meta, el, frame);
      await mod.mount(ctx, el, params);
    } catch (e) { fail(e); }
    return {
      async refresh() { try { await mod?.refresh?.(ctx, el, params); } catch (e) { fail(e); } },
      unmount() { try { mod?.unmount?.(ctx, el); } catch (e) { console.error(e); } el.innerHTML = ''; },
    };
  }

  // Avvio: estensioni, poi la prima sezione
  (async () => {
    await init();
    const first = firstSection();
    if (first) activate(first);
    else document.querySelector('main.main').innerHTML =
      `<div class="empty-state"><div class="icon">${UI.icon('puzzle')}</div><p>${esc(t('core.extensions.none'))}</p></div>`;
  })();

  return {
    has, activate, open, refresh, syncExtensions, toggleNotifications, exportConfig, doExport, importConfig, doImport, chooseLanguage,
    openMcp, mcpCopy, mcpRegenerate, mcpToggle() { mcpShowToken = !mcpShowToken; renderMcp(); },
  };
})();
