// Service worker di Kelbo: rende la pagina installabile come applicazione (con il manifest) e,
// quando il server non risponde, mostra una pagina che lo dice invece dell'errore del browser.
// Non mette in cache l'interfaccia: Kelbo funziona solo con il server acceso, ogni richiesta va a lui.
const CACHE = 'kelbo-offline-v1';
const CATALOGS = ['core/i18n/it.json', 'core/i18n/en.json'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll([...CATALOGS, 'icons/kelbo.svg'])).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// testi dai cataloghi salvati all'installazione, nella lingua del browser
async function offlinePage() {
  const lang = /^it\b/i.test(self.navigator.language || '') ? 'it' : 'en';
  let cat = {};
  try { cat = await (await caches.match(`core/i18n/${lang}.json`)).json(); } catch { /* catalogo assente */ }
  const t = k => cat[k] || k;
  const html = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kelbo</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#e6edf3;font:14px system-ui,sans-serif}
main{max-width:440px;text-align:center;padding:24px}img{width:64px;height:64px}h1{font-size:20px;margin:16px 0 8px}p{color:#8b949e;line-height:1.5}
code{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:2px 6px}a{display:inline-block;margin-top:12px;padding:6px 14px;border-radius:6px;background:#388bfd;color:#fff;text-decoration:none}</style></head>
<body><main><img src="icons/kelbo.svg" alt=""><h1>${esc(t('core.offline.title'))}</h1><p>${esc(t('core.offline.text'))}</p><p><code>kelbo start</code></p>
<a href="">${esc(t('core.offline.retry'))}</a></main></body></html>`;
  return new Response(html, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // pagina: dal server; se non risponde, la pagina che lo dice
  if (req.mode === 'navigate') { event.respondWith(fetch(req).catch(() => offlinePage())); return; }
  // il logo della pagina offline, quando il server è spento
  if (url.pathname === '/icons/kelbo.svg') event.respondWith(fetch(req).catch(() => caches.match('icons/kelbo.svg')));
});
