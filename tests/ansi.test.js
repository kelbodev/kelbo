// Conversione dei colori ANSI dell'output (public/core/ui.js), senza browser
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

global.window = { addEventListener() {} };
global.I18n = {};
global.document = { getElementById: () => ({ addEventListener() {} }), addEventListener() {}, querySelectorAll: () => [] };
global.setInterval = () => {};
require(path.join(__dirname, '../public/core/ui.js'));
const { ansiToHtml, ansiState } = global.window.UI;
const E = '\x1b';

test('i codici di chiusura parziali (39, 22, 49…) chiudono il colore', () => {
  assert.equal(ansiToHtml(`a ${E}[31mrosso${E}[39m normale`), 'a <span class="ansi-red">rosso</span> normale');
  assert.equal(ansiToHtml(`${E}[1;31mx${E}[22my${E}[m z`), '<span class="ansi-bold ansi-red">x</span><span class="ansi-red">y</span> z');
  assert.equal(ansiToHtml(`${E}[44mfondo${E}[49m no`), '<span class="ansi-bg-blue">fondo</span> no');
});

test('il colore continua tra un pezzo e l\'altro, anche con una sequenza spezzata', () => {
  const st = ansiState();
  assert.equal(ansiToHtml(`${E}[32mriga1\nriga2${E}[3`, st), '<span class="ansi-green">riga1\nriga2</span>');
  assert.equal(ansiToHtml(`3mgiallo${E}[0m ok`, st), '<span class="ansi-yellow">giallo</span> ok');
  assert.equal(ansiToHtml('dopo', st), 'dopo');
});

test('sequenze non di colore tolte senza perdere testo; colori estesi; HTML escapato', () => {
  assert.equal(ansiToHtml(`${E}[2K${E}[1Gprogress 50% complete`), 'progress 50% complete');
  assert.equal(ansiToHtml(`${E}]0;titolo\x07testo <b>`), 'testo &lt;b&gt;');
  assert.equal(ansiToHtml(`${E}[38;2;31;32;33mtrue${E}[0m`), '<span style="color:rgb(31,32,33)">true</span>');
  assert.equal(ansiToHtml(`${E}[38;5;9mx`), '<span class="ansi-bright-red">x</span>');
});

test('indirizzi http/https cliccabili (nuova tab), anche colorati a pezzi; nient\'altro diventa link', () => {
  const a = url => `<a class="ansi-link" href="${url}" target="_blank" rel="noopener noreferrer">`;
  assert.equal(ansiToHtml('Server su http://localhost:5001/ pronto.'), `Server su ${a('http://localhost:5001/')}http://localhost:5001/</a> pronto.`);
  // Vite: "http://localhost:" in ciano, la porta in grassetto
  assert.equal(ansiToHtml(`${E}[36mhttp://localhost:${E}[1m5173${E}[22m/${E}[39m`),
    `<span class="ansi-cyan">${a('http://localhost:5173/')}http://localhost:</a></span><span class="ansi-bold ansi-cyan">${a('http://localhost:5173/')}5173</a></span><span class="ansi-cyan">${a('http://localhost:5173/')}/</a></span>`);
  // punteggiatura finale fuori, parentesi bilanciate dentro, & e " escapati
  assert.equal(ansiToHtml('(vedi https://x.test/a_(b)?q=1&r=2).'), `(vedi ${a('https://x.test/a_(b)?q=1&amp;r=2')}https://x.test/a_(b)?q=1&amp;r=2</a>).`);
  assert.equal(ansiToHtml('ftp://x.test javascript:alert(1) http:// "q"'), 'ftp://x.test javascript:alert(1) http:// &quot;q&quot;');
});
