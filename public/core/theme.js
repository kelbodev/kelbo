// Tema dei colori: quello del core (scuro) o uno portato da un'estensione ("themes" nel manifest,
// un foglio di stile che ridefinisce le variabili di shell.css). La scelta è in config.json
// (layout.theme, viaggia con l'export); con "segui il sistema" il tema passa da chiaro a scuro
// insieme al sistema operativo. L'ultimo tema applicato resta anche nel browser, per mostrarlo
// subito al caricamento della pagina, prima che arrivi la configurazione.
window.Theme = (() => {
  const CACHE_KEY = 'kelbo.theme';
  const media = window.matchMedia?.('(prefers-color-scheme: light)');
  const BUILTIN = { key: '', scheme: 'dark', href: '' };
  let themes = [BUILTIN];   // { key, scheme, href, name }
  let choice = { id: '', system: false, light: '', dark: '' };
  let ready = false;

  const t = (k, p) => window.I18n.t(k, p);
  const pick = v => window.I18n.pick(v);

  function apply({ key, scheme, href }) {
    const root = document.documentElement;
    root.dataset.theme = key || 'kelbo-dark';
    root.style.colorScheme = scheme;
    let link = document.getElementById('themeCss');
    if (!href) { link?.remove(); return; }
    if (!link) {
      link = Object.assign(document.createElement('link'), { id: 'themeCss', rel: 'stylesheet' });
      document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  // tema da mostrare ora: quello scelto o, seguendo il sistema, l'ultimo chiaro/scuro scelto
  function resolve() {
    const find = k => themes.find(x => x.key === k);
    if (choice.system) {
      const light = media?.matches;
      return (light ? find(choice.light) || themes.find(x => x.scheme === 'light') : find(choice.dark)) || BUILTIN;
    }
    return find(choice.id) || BUILTIN;
  }

  function refresh() {
    const th = resolve();
    apply(th);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ key: th.key, scheme: th.scheme, href: th.href })); } catch { /* solo comodità */ }
    renderButton();
  }

  // temi delle estensioni attive (list: GET /api/core/extensions)
  function setExtensions(list) {
    themes = [BUILTIN, ...list.filter(m => m.state === 'ok' || m.state === 'warning').flatMap(m => (m.themes || []).map(th => ({
      key: `${m.code}/${th.id}`, scheme: th.scheme, name: th.name,
      href: `/ext/${m.code}/${th.css}?v=${encodeURIComponent(m.loadId ?? 0)}`,
    })))];
    if (ready) refresh();
  }

  async function init(list) {
    setExtensions(list);
    try { choice = (await window.UI.apiClient('/api/core').get('/layout')).theme || choice; } catch { /* tema del core */ }
    ready = true;
    refresh();
    media?.addEventListener?.('change', () => { if (choice.system) refresh(); });
  }

  async function save(body) {
    try {
      choice = (await window.UI.apiClient('/api/core').put('/layout/theme', body)).theme;
      refresh();
    } catch (e) { window.UI.toast(e.message, 'error'); }
  }

  const label = th => (th.key ? pick(th.name) : t('core.theme.builtin'));

  function renderButton() {
    const btn = document.getElementById('themeBtn');
    if (!btn) return;
    const th = resolve();
    btn.title = choice.system ? t('core.theme.buttonSystem', { name: label(th) }) : t('core.theme.button', { name: label(th) });
  }

  function choose(event) {
    const r = event.currentTarget.getBoundingClientRect();
    const current = resolve().key;
    const items = themes.map(th => ({
      icon: th.key === current ? 'check' : (th.scheme === 'light' ? 'sun' : 'moon'),
      label: label(th),
      action: () => save({ id: th.key, scheme: th.scheme, system: false }),
    }));
    items.push('separator', {
      icon: choice.system ? 'check' : 'sun-moon',
      label: t('core.theme.system'),
      action: () => save({ system: !choice.system }),
    });
    if (themes.length === 1) items.push({ icon: 'puzzle', label: t('core.theme.more'), action: () => window.Extensions?.open() });
    window.UI.contextMenu(r.left, r.bottom + 4, items);
  }

  // subito, prima della configurazione: l'ultimo tema applicato in questo browser
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (cached && typeof cached.href === 'string' && /^\/ext\/[a-z0-9-]+\/[A-Za-z0-9_./-]+\.css(\?v=[^"'<>\s]*)?$/.test(cached.href || '/ext/x/x.css')
        && ['dark', 'light'].includes(cached.scheme)) apply(cached);
  } catch { /* nessun tema salvato */ }

  window.I18n?.onChange?.(renderButton);
  return { init, setExtensions, choose, current: () => resolve().key };
})();
