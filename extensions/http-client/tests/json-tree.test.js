// Albero della risposta JSON: lettura fedele del testo (numeri grandi compresi), copie
// formattata e minificata, HTML con i nodi richiudibili
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('kelbo/testkit');

// view.js è un modulo ES del browser: copiato come .mjs per importarne le funzioni pure
async function load() {
  const file = path.join(tmpDir(), 'view.mjs');
  fs.writeFileSync(file, fs.readFileSync(path.join(__dirname, '..', 'view.js')));
  return import(file);
}

test('JSON: albero, copie formattata e minificata, numeri grandi intatti', async () => {
  const { parseJsonTree, jsonTreeText, jsonTreeHtml } = await load();
  const src = '{ "id": 12345678901234567890, "list": [1, -2.5e3, {"ok": true}], "empty": {}, "s": "a\\"b", "none": null }';
  const node = parseJsonTree(src);
  assert.equal(jsonTreeText(node), '{"id":12345678901234567890,"list":[1,-2.5e3,{"ok":true}],"empty":{},"s":"a\\"b","none":null}');
  assert.equal(jsonTreeText(node, '  '), '{\n  "id": 12345678901234567890,\n  "list": [\n    1,\n    -2.5e3,\n    {\n      "ok": true\n    }\n  ],\n  "empty": {},\n  "s": "a\\"b",\n  "none": null\n}');
  // il minificato è JSON valido e uguale all'originale
  assert.deepEqual(JSON.parse(jsonTreeText(node)), JSON.parse(src));
  for (const bad of ['{', '{"a":1,}', '[1 2]', '"x', '01', '{"a" 1}', '[1] x']) assert.throws(() => parseJsonTree(bad), undefined, bad);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const html = jsonTreeHtml(parseJsonTree('{"a":{"b":[1,2]},"x":"<script>"}'), esc, (k, n) => `${n} ${k}`);
  assert.equal((html.match(/class="hc-jt-node"/g) || []).length, 3); // radice, a, b
  assert.match(html, /2 arr/);
  assert.doesNotMatch(html, /<script>/);
});
