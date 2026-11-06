// Helper condivisi della UI (core e estensioni): escape, colori, ANSI, toast, modal, API.
// Le traduzioni sono in i18n.js (UI.t e UI.fmt rimandano lì).
window.UI = (() => {
  // ---- UTILS ----
  function esc(t) {
    return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  // Argomento stringa per un handler inline (onclick="Ext.code.fn(${js(x)})"): esc() da solo
  // non basta, il browser decodifica &#39; in ' prima di eseguire il JS
  function js(v) {
    return esc(JSON.stringify(String(v ?? '')));
  }

  // Colore sicuro da usare in style="" (i valori arrivano da config importabili)
  function cssColor(c) {
    return /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#6b7280';
  }

  // ---- ANSI → HTML ----
  // Stato dei colori che continua tra un pezzo di output e il successivo (state.pending:
  // sequenza di escape spezzata a fine pezzo). Solo le sequenze SGR (…m) cambiano lo stile;
  // le altre (cursore, cancella riga, titoli OSC) vengono tolte senza toccare il testo.
  const ANSI_COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  const ansiState = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, pending: '' });

  // colore della palette a 256 (38;5;n): 0-15 come classi, il resto come rgb
  function color256(n) {
    if (n < 8) return { cls: ANSI_COLORS[n] };
    if (n < 16) return { cls: 'bright-' + ANSI_COLORS[n - 8] };
    if (n >= 232) { const v = 8 + (n - 232) * 10; return { rgb: `rgb(${v},${v},${v})` }; }
    const k = n - 16, f = x => (x ? 55 + x * 40 : 0);
    return { rgb: `rgb(${f(Math.floor(k / 36))},${f(Math.floor(k / 6) % 6)},${f(k % 6)})` };
  }

  function applySgr(st, params) {
    const codes = params === '' ? [0] : params.split(';').map(x => (x === '' ? 0 : Number(x)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false });
      else if (c === 1) st.bold = true;
      else if (c === 2) st.dim = true;
      else if (c === 3) st.italic = true;
      else if (c === 4) st.underline = true;
      else if (c === 22) st.bold = st.dim = false;
      else if (c === 23) st.italic = false;
      else if (c === 24) st.underline = false;
      else if (c >= 30 && c <= 37) st.fg = { cls: ANSI_COLORS[c - 30] };
      else if (c >= 90 && c <= 97) st.fg = { cls: 'bright-' + ANSI_COLORS[c - 90] };
      else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = { cls: ANSI_COLORS[c - 40] };
      else if (c >= 100 && c <= 107) st.bg = { cls: ANSI_COLORS[c - 100] };
      else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) { // colori estesi: 5;n oppure 2;r;g;b
        let col = null;
        if (codes[i + 1] === 5) { col = color256(codes[i + 2] ?? 0); i += 2; }
        else if (codes[i + 1] === 2) { col = { rgb: `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})` }; i += 4; }
        if (c === 38) st.fg = col; else st.bg = col;
      }
    }
  }

  function styled(st, text) {
    if (!text) return '';
    const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cls = [], css = [];
    if (st.bold) cls.push('ansi-bold');
    if (st.dim) cls.push('ansi-dim');
    if (st.italic) cls.push('ansi-italic');
    if (st.underline) cls.push('ansi-underline');
    if (st.fg?.cls) cls.push('ansi-' + st.fg.cls); else if (st.fg?.rgb) css.push(`color:${st.fg.rgb}`);
    if (st.bg?.cls) cls.push('ansi-bg-' + st.bg.cls); else if (st.bg?.rgb) css.push(`background:${st.bg.rgb}`);
    if (!cls.length && !css.length) return safe;
    return `<span${cls.length ? ` class="${cls.join(' ')}"` : ''}${css.length ? ` style="${css.join(';')}"` : ''}>${safe}</span>`;
  }

  // ansiToHtml(text) per un testo isolato; ansiToHtml(text, state) per un flusso a pezzi
  function ansiToHtml(input, state = ansiState()) {
    const text = state.pending + String(input ?? '');
    state.pending = '';
    // CSI (ESC [ … lettera), OSC (ESC ] … BEL/ST), altri ESC di due caratteri
    const re = /\x1b(?:\[([0-9;?]*)([ -\/]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
    let out = '', last = 0, m;
    while ((m = re.exec(text))) {
      out += styled(state, text.slice(last, m.index));
      if (m[3] === 'm' && !m[2]) applySgr(state, (m[1] || '').replace(/^\?/, ''));
      last = re.lastIndex;
    }
    let rest = text.slice(last);
    // sequenza incompleta alla fine: si completa con il prossimo pezzo
    const cut = rest.lastIndexOf('\x1b');
    if (cut !== -1 && /^\x1b(\[[0-9;?]*[ -\/]*|\][^\x07]*)?$/.test(rest.slice(cut))) { state.pending = rest.slice(cut); rest = rest.slice(0, cut); }
    return out + styled(state, rest.replace(/\x1b/g, ''));
  }

  // ---- TOAST ----
  function toast(msg, type='info') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3000);
  }

  // ---- MODAL ----
  function openModal(title, bodyHtml, footerHtml) {
    document.getElementById('modal').className = 'modal'; // classi extra (es. modal-wide) solo per il dialog che le aggiunge
    document.getElementById('modalTitle').textContent = title;
    document.getElementById('modalBody').innerHTML = bodyHtml;
    document.getElementById('modalFooter').innerHTML = footerHtml;
    document.getElementById('modalOverlay').classList.add('open');
    document.dispatchEvent(new CustomEvent('ui:modal', { detail: { open: true } }));
  }
  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
    document.dispatchEvent(new CustomEvent('ui:modal', { detail: { open: false } }));
  }

  // Aggiornamento di un contenitore che si ridisegna da solo (polling, blur, change): niente se
  // l'HTML è lo stesso dell'ultima volta; rimandato a dopo il clic se il mouse è premuto dentro il
  // contenitore, perché sostituire il pulsante fra mousedown e click farebbe perdere il clic
  let pressed = null;
  const deferred = new Map();
  document.addEventListener('pointerdown', e => { pressed = e.target; }, true);
  const release = () => {
    pressed = null;
    // dopo i gestori del click (stesso task di pointerup)
    setTimeout(() => { for (const [el, html] of [...deferred]) { deferred.delete(el); patch(el, html); } }, 0);
  };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  // Attesa dopo un clic: le richieste al server (/api/…) partite entro poco da un clic su un
  // pulsante lo mettono in attesa (spinner, niente altri clic) e il cursore in "occupato" fino
  // alla risposta. Senza questo un'azione lenta (clone git, master password, connessione a un
  // database) sembra un clic andato a vuoto, e i clic ripetuti vengono ignorati dall'azione in corso.
  const CLICK_WINDOW_MS = 400;  // richieste considerate partite dal clic
  const BUSY_DELAY_MS = 150;    // le risposte rapide non fanno lampeggiare nulla
  let lastClick = null;
  const busyCount = new Map();  // elemento → richieste in corso
  let pendingTotal = 0;
  document.addEventListener('click', e => {
    const el = e.target?.closest?.('button, .btn, .pill, .sb-item, .ctx-item, [role="button"], a[onclick]');
    lastClick = el ? { el, at: Date.now() } : null;
  }, true);
  function busyStart(el) {
    busyCount.set(el, (busyCount.get(el) || 0) + 1);
    pendingTotal++;
    setTimeout(() => {
      if (busyCount.get(el)) el.classList.add('ui-busy');
      if (pendingTotal) document.body.classList.add('ui-loading');
    }, BUSY_DELAY_MS);
  }
  function busyEnd(el) {
    const n = (busyCount.get(el) || 1) - 1;
    if (n) busyCount.set(el, n); else { busyCount.delete(el); el.classList.remove('ui-busy'); }
    if (--pendingTotal <= 0) { pendingTotal = 0; document.body.classList.remove('ui-loading'); }
  }
  if (typeof window.fetch === 'function') {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input?.url || '';
      const api = /^\/api\//.test(url) || url.startsWith(`${location.origin}/api/`);
      const el = api && lastClick && Date.now() - lastClick.at < CLICK_WINDOW_MS ? lastClick.el : null;
      if (!el) return nativeFetch(input, init);
      busyStart(el);
      const p = nativeFetch(input, init);
      // fine dell'attesa all'arrivo della risposta (le risposte in streaming hanno la loro UI)
      p.then(() => busyEnd(el), () => busyEnd(el));
      return p;
    };
  }

  let normalizer = null; // <template>: HTML serializzato come lo fa il browser (creato al primo uso)
  function patch(el, html) {
    if (!el) return;
    html = html ?? '';
    if (pressed && el.contains(pressed)) { deferred.set(el, html); return; }
    deferred.delete(el);
    normalizer ??= document.createElement('template');
    normalizer.innerHTML = html;
    if (normalizer.innerHTML === el.innerHTML) return;
    el.innerHTML = html;
  }

  // Client JSON per un prefisso di API (es. '/api/ext/git'); gli errori diventano Error con il messaggio del server
  function apiClient(base = '') {
    const parse = async r => {
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      // messaggio tradotto dal codice dell'errore; status, code e corpo restano sull'Error
      if (!r.ok) throw Object.assign(new Error(I18n.errorText(data, text || `HTTP ${r.status}`)), { status: r.status, code: data?.code, data });
      return data;
    };
    const send = (method, p, body) => fetch(base + p, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(parse);
    return {
      get: p => send('GET', p),
      post: (p, b = {}) => send('POST', p, b),
      put: (p, b = {}) => send('PUT', p, b),
      del: p => send('DELETE', p),
      url: p => base + p,
    };
  }

  // Tempo trascorso da una data ISO, nella lingua attiva ("42 s", "5 min 3 s", "2 h 10 min")
  function formatUptime(startedAt) {
    if (!startedAt) return '—';
    return I18n.fmt.duration((Date.now() - new Date(startedAt)) / 1000);
  }

  // Gli elementi con data-uptime="<ISO>" si aggiornano da soli ogni secondo
  setInterval(() => {
    document.querySelectorAll('[data-uptime]').forEach(el => { el.textContent = formatUptime(el.dataset.uptime); });
  }, 1000);

  // Avviso per uno strumento esterno mancante; recheck è l'handler inline del pulsante (es. "Ext.pm2.recheck()")
  function toolNotice(message, installCmd, recheck) {
    return `<div class="tool-notice">
      <span>${icon('triangle-alert')} ${esc(message)}</span>
      ${installCmd ? `<code>${esc(installCmd)}</code>` : ''}
      ${recheck ? `<button class="btn btn-ghost btn-sm" onclick="${esc(recheck)}">${esc(I18n.t('core.tools.recheck'))}</button>` : ''}
    </div>`;
  }

  // Menu contestuale alle coordinate x,y. items: [{ label, icon?, action, danger?, disabled? } | 'separator']
  let menuEl = null;
  function closeContextMenu() { menuEl?.remove(); menuEl = null; }
  function contextMenu(x, y, items) {
    closeContextMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'ctx-menu';
    menuEl.setAttribute('role', 'menu');
    for (const it of items) {
      if (it === 'separator') { menuEl.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); continue; }
      const b = document.createElement('button');
      b.className = 'ctx-item' + (it.danger ? ' danger' : '');
      b.disabled = !!it.disabled;
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span class="ctx-icon">${it.icon ? iconOrText(it.icon) : ''}</span>${esc(it.label)}`;
      b.addEventListener('click', () => { closeContextMenu(); it.action(); });
      menuEl.appendChild(b);
    }
    document.body.appendChild(menuEl);
    // dentro la finestra
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    menuEl.querySelector('.ctx-item:not(:disabled)')?.focus();
  }
  document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target)) closeContextMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeContextMenu(); });
  window.addEventListener('blur', closeContextMenu);

  // ---- icone (Lucide, https://lucide.dev, ISC): sprite del core in /core/vendor/lucide ----
  // icon('database') → <svg> che prende il colore e la dimensione del testo intorno.
  // Nell'HTML statico (o generato) basta <i data-icon="database"></i>: viene riempito da solo.
  // Le icone delle estensioni nel manifest possono essere un nome Lucide o, come prima, un'emoji.
  const ICON_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const SPRITE = '/core/vendor/lucide/sprite.svg';
  const isIconName = v => typeof v === 'string' && ICON_RE.test(v);
  function icon(name, { cls = '', title = '' } = {}) {
    if (!isIconName(name)) return '';
    return `<svg class="i${cls ? ` ${esc(cls)}` : ''}" aria-hidden="${title ? 'false' : 'true'}"${title ? ` role="img" aria-label="${esc(title)}"` : ''} focusable="false"><use href="${SPRITE}#${name}"/></svg>`;
  }
  // Contenuto di un badge: testo, oppure { icon, text } (icona Lucide prima del testo)
  function badgeHtml(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'object') return `${value.icon ? icon(value.icon) : ''}${value.text != null && value.text !== '' ? `<span>${esc(String(value.text))}</span>` : ''}`;
    return esc(String(value));
  }
  // Icona del manifest: nome Lucide → svg, altrimenti il testo (emoji) escapato
  const iconOrText = (v, fallback = 'box') => (isIconName(v) ? icon(v) : v ? esc(v) : icon(fallback));
  function hydrateIcons(root) {
    const list = root.matches?.('i[data-icon]') ? [root] : root.querySelectorAll ? root.querySelectorAll('i[data-icon]') : [];
    for (const el of list) {
      const name = el.dataset.icon;
      if (el.dataset.iconDone === name) continue;
      el.dataset.iconDone = name;
      el.innerHTML = icon(name);
      el.classList.add('i-wrap');
    }
  }
  hydrateIcons(document);
  if (typeof MutationObserver === 'function' && document.documentElement) new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'attributes') { hydrateIcons(r.target); continue; }
      for (const n of r.addedNodes) if (n.nodeType === 1) hydrateIcons(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-icon'] });

  // click fuori dal modal lo chiude
  document.getElementById('modalOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });

  return { t: I18n.t, fmt: I18n.fmt, errorText: I18n.errorText, esc, js, cssColor, ansiToHtml, ansiState, toast, openModal, closeModal, patch, apiClient, formatUptime, toolNotice, contextMenu, closeContextMenu, icon, iconOrText, isIconName, badgeHtml };
})();
