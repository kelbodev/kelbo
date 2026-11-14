// Kelbo installabile come applicazione: manifest con icone (anche maskable), service worker alla
// radice con la pagina "Kelbo non risponde" dai cataloghi, collegamenti nella pagina
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('../lib/testkit');

const PUB = path.join(__dirname, '..', 'public');
let srv;
before(async () => { srv = await startServer(undefined, { extensions: null }); });
after(() => srv.stop());

test('manifest: nome, avvio, finestra propria, icone servite', async () => {
  const r = await srv.request('GET', '/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/manifest\+json/);
  const m = JSON.parse(r.text);
  assert.deepEqual([m.name, m.start_url, m.scope, m.display], ['Kelbo', '/', '/', 'standalone']);
  const sizes = m.icons.map(i => `${i.sizes}${i.purpose ? `:${i.purpose}` : ''}`);
  for (const s of ['192x192', '512x512', '512x512:maskable']) assert.ok(sizes.includes(s), s);
  for (const icon of m.icons) {
    const i = await srv.request('GET', `/${icon.src}`);
    assert.equal(i.status, 200, icon.src);
    assert.equal(i.headers['content-type'].split(';')[0], icon.type, icon.src);
  }
  // dimensioni dichiarate = dimensioni vere dei PNG (intestazione IHDR)
  for (const icon of m.icons.filter(i => i.type === 'image/png')) {
    const buf = fs.readFileSync(path.join(PUB, icon.src));
    assert.equal(`${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`, icon.sizes, icon.src);
  }
});

test('pagina: manifest, icone, colore del tema; service worker alla radice', async () => {
  const html = (await srv.request('GET', '/')).text;
  for (const re of [/<link rel="manifest" href="manifest\.webmanifest">/, /<link rel="icon" type="image\/svg\+xml" href="icons\/kelbo\.svg">/, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/, /<meta name="theme-color"/]) assert.match(html, re);
  const sw = await srv.request('GET', '/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers['content-type'], /javascript/);
  // la pagina offline usa le chiavi dei cataloghi, presenti in tutte le lingue
  const keys = [...new Set([...sw.text.matchAll(/t\('([\w.]+)'\)/g)].map(m => m[1]))];
  assert.deepEqual(keys.sort(), ['core.offline.retry', 'core.offline.text', 'core.offline.title']);
  for (const lang of ['it', 'en']) {
    const cat = JSON.parse(fs.readFileSync(path.join(PUB, 'core', 'i18n', `${lang}.json`), 'utf8'));
    for (const k of keys) assert.ok(cat[k], `${lang} ${k}`);
  }
  assert.match((await srv.request('GET', '/core/shell.js')).text, /serviceWorker\.register\('sw\.js'\)/);
});
