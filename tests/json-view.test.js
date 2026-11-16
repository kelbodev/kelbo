// JSON condiviso (ctx.ui.json, public/core/json-view.js): lettura fedele (numeri grandi intatti),
// copie formattata e minificata, albero richiudibile senza HTML del contenuto, colori anche su
// testo non valido, editor colorato
const { test } = require('node:test');
const assert = require('node:assert/strict');
const JV = require('../public/core/json-view.js');

test('JSON: albero, copie formattata e minificata, numeri grandi intatti', () => {
  const src = '{ "id": 12345678901234567890, "list": [1, -2.5e3, {"ok": true}], "empty": {}, "s": "a\\"b", "none": null }';
  const node = JV.parse(src);
  assert.equal(JV.text(node), '{"id":12345678901234567890,"list":[1,-2.5e3,{"ok":true}],"empty":{},"s":"a\\"b","none":null}');
  assert.equal(JV.text(node, '  '), '{\n  "id": 12345678901234567890,\n  "list": [\n    1,\n    -2.5e3,\n    {\n      "ok": true\n    }\n  ],\n  "empty": {},\n  "s": "a\\"b",\n  "none": null\n}');
  assert.deepEqual(JSON.parse(JV.text(node)), JSON.parse(src));
  for (const bad of ['{', '{"a":1,}', '[1 2]', '"x', '01', '{"a" 1}', '[1] x']) assert.throws(() => JV.parse(bad), undefined, bad);
  const html = JV.tree(JV.parse('{"a":{"b":[1,2]},"x":"<script>"}'), (k, n) => `${n} ${k}`);
  assert.equal((html.match(/class="jv-node"/g) || []).length, 3); // radice, a, b
  assert.match(html, /2 arr/);
  assert.doesNotMatch(html, /<script>/);
});

test('colori anche su testo non valido, a metà o su una riga; editor', () => {
  const h = JV.highlight('{"a":1,"b":[true,null,"x<y"],"c": "aperta');
  assert.match(h, /<span class="jv-key">&quot;a&quot;<\/span>:/);
  assert.match(h, /<span class="jv-num">1<\/span>/);
  assert.match(h, /<span class="jv-lit">true<\/span>/);
  assert.match(h, /<span class="jv-str">&quot;x&lt;y&quot;<\/span>/);
  assert.match(h, /<span class="jv-str">&quot;aperta<\/span>/);
  const ed = JV.editor('{"a":"</textarea>"}', 'data-field="x"', '300px');
  assert.match(ed, /class="jv-editor" style="height:300px"/);
  assert.match(ed, /<textarea class="jv-editor-input" data-field="x"/);
  assert.doesNotMatch(ed, /"<\/textarea>"/);
});
