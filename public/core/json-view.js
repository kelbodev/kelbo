// JSON condiviso dalle estensioni (ctx.ui.json): lettura fedele del testo, albero richiudibile,
// colori anche su testo non valido o su una riga, editor con i colori sotto la textarea.
// Nel browser è window.JsonView; in Node (test) module.exports.
(function (global) {
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---- lettura: il testo così com'è (numeri compresi: niente cifre perse oltre 2^53) ----
  // Nodo: { t: 'obj', entries: [[chiave, nodo]] } | { t: 'arr', items } | { t: 'str'|'num'|'lit', raw }
  function parse(text) {
    let i = 0;
    const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
    const fail = () => { throw new Error(`JSON @${i}`); };
    const str = () => {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      if (text[i] !== '"') fail();
      i++;
      return text.slice(start, i);
    };
    const value = () => {
      ws();
      const c = text[i];
      if (c === '{') {
        i++; ws();
        const entries = [];
        if (text[i] === '}') { i++; return { t: 'obj', entries }; }
        for (;;) {
          ws(); if (text[i] !== '"') fail();
          const key = str(); ws();
          if (text[i++] !== ':') fail();
          entries.push([key, value()]); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; return { t: 'obj', entries }; }
          fail();
        }
      }
      if (c === '[') {
        i++; ws();
        const items = [];
        if (text[i] === ']') { i++; return { t: 'arr', items }; }
        for (;;) {
          items.push(value()); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return { t: 'arr', items }; }
          fail();
        }
      }
      if (c === '"') return { t: 'str', raw: str() };
      const m = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
      if (!m) fail();
      i += m[0].length;
      return { t: /^[-\d]/.test(m[0]) ? 'num' : 'lit', raw: m[0] };
    };
    const root = value(); ws();
    if (i !== text.length) fail();
    return root;
  }

  // Testo dall'albero: indent '' = su una riga, altrimenti formattato con quel rientro
  function text(node, indent = '') {
    const nl = indent ? '\n' : '', sep = indent ? ': ' : ':';
    const walk = (n, pad) => {
      if (n.t !== 'obj' && n.t !== 'arr') return n.raw;
      const kids = n.t === 'obj' ? n.entries.map(([k, v]) => `${k}${sep}${walk(v, pad + indent)}`) : n.items.map(v => walk(v, pad + indent));
      const [open, close] = n.t === 'obj' ? ['{', '}'] : ['[', ']'];
      if (!kids.length) return open + close;
      return `${open}${nl}${kids.map(k => pad + indent + k).join(`,${nl}`)}${nl}${pad}${close}`;
    };
    return walk(node, '');
  }

  const defaultLabel = (kind, n) => {
    const t = global.I18n?.t;
    return t ? t(kind === 'obj' ? 'core.json.keys' : 'core.json.items', { count: n }) : `${n}`;
  };

  // HTML dell'albero: ogni oggetto/array ha ▾ per chiuderlo (riassunto "{ 3 chiavi }")
  function tree(node, label = defaultLabel) {
    const scalar = n => `<span class="jv-${n.t === 'str' ? 'str' : n.t === 'num' ? 'num' : 'lit'}">${escHtml(n.raw)}</span>`;
    const walk = (n, key, last, depth) => {
      const k = key != null ? `<span class="jv-key">${escHtml(key)}</span>: ` : '';
      const comma = last ? '' : ',';
      if (n.t !== 'obj' && n.t !== 'arr') return `<div class="jv-line">${k}${scalar(n)}${comma}</div>`;
      const [open, close] = n.t === 'obj' ? ['{', '}'] : ['[', ']'];
      const kids = n.t === 'obj' ? n.entries : n.items.map(v => [null, v]);
      if (!kids.length) return `<div class="jv-line">${k}${open}${close}${comma}</div>`;
      return `<div class="jv-node" data-depth="${depth}">
      <div class="jv-line"><button class="jv-toggle" data-jv aria-expanded="true" tabindex="-1"></button>${k}${open}<span class="jv-more"> <button class="jv-count" data-jv>${escHtml(label(n.t, kids.length))}</button> ${close}${comma}</span></div>
      <div class="jv-body">${kids.map(([kk, v], idx) => walk(v, kk, idx === kids.length - 1, depth + 1)).join('')}</div>
      <div class="jv-line jv-close">${close}${comma}</div>
    </div>`;
    };
    return `<div class="jv-tree">${walk(node, null, true, 0)}</div>`;
  }

  // Colori su qualsiasi testo (anche non valido, a metà o su una riga): stringhe, chiavi, numeri,
  // true/false/null; il resto resta com'è
  function highlight(src) {
    const re = /("(?:[^"\\\n]|\\.)*"?)(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      out += escHtml(src.slice(last, m.index));
      const [, str, colon, lit, num] = m;
      out += str ? `<span class="${colon ? 'jv-key' : 'jv-str'}">${escHtml(str)}</span>${colon || ''}`
        : lit ? `<span class="jv-lit">${lit}</span>` : `<span class="jv-num">${num}</span>`;
      last = re.lastIndex;
    }
    return out + escHtml(src.slice(last));
  }

  // Pulsanti Espandi / Comprimi (tutto sotto il primo livello) e suggerimento
  function tools() {
    const t = global.I18n?.t || (k => k);
    return `<div class="jv-tools">
      <button class="btn btn-ghost btn-sm" data-jv-all="expand" title="${escHtml(t('core.json.expandAllTitle'))}">${global.UI?.icon ? global.UI.icon('chevrons-down-up') : ''} ${escHtml(t('core.json.expandAll'))}</button>
      <button class="btn btn-ghost btn-sm" data-jv-all="collapse" title="${escHtml(t('core.json.collapseAllTitle'))}">${global.UI?.icon ? global.UI.icon('chevrons-up-down') : ''} ${escHtml(t('core.json.collapseAll'))}</button>
      <span class="jv-hint">${escHtml(t('core.json.treeHint'))}</span></div>`;
  }

  // Editor colorato: textarea trasparente sopra il testo colorato. attrs: attributi della textarea
  // (già escapati), height: altezza iniziale (CSS); ridimensionabile in verticale
  function editor(value, attrs = '', height = '240px') {
    return `<div class="jv-editor" style="height:${escHtml(height)}"><pre class="jv-editor-hl" aria-hidden="true"><code>${highlight(value)}\n</code></pre><textarea class="jv-editor-input" ${attrs} spellcheck="false" autocapitalize="off" autocomplete="off">${escHtml(value)}</textarea></div>`;
  }

  const setNode = (n, collapsed) => {
    n.classList.toggle('collapsed', collapsed);
    n.querySelector(':scope > .jv-line > .jv-toggle')?.setAttribute('aria-expanded', String(!collapsed));
  };

  // Comportamento in root (una volta, delega): ▾ chiude/apre un nodo, Alt+clic anche quelli
  // dentro; Espandi/Comprimi sull'albero vicino; gli editor ricolorano mentre si scrive
  function bind(root) {
    const click = e => {
      const all = e.target.closest?.('[data-jv-all]');
      if (all) {
        const scope = all.closest('.jv-scope') || root;
        for (const n of scope.querySelectorAll('.jv-tree .jv-node')) setNode(n, all.dataset.jvAll === 'collapse' && n.dataset.depth !== '0');
        return;
      }
      if (!e.target.closest?.('[data-jv]')) return;
      const node = e.target.closest('.jv-node');
      if (!node) return;
      const collapse = !node.classList.contains('collapsed');
      setNode(node, collapse);
      if (e.altKey) for (const n of node.querySelectorAll('.jv-node')) setNode(n, collapse);
    };
    const sync = ta => {
      const pre = ta.previousElementSibling;
      if (!pre?.classList.contains('jv-editor-hl')) return;
      pre.firstElementChild.innerHTML = `${highlight(ta.value)}\n`;
      pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft;
    };
    const input = e => { if (e.target.classList?.contains('jv-editor-input')) sync(e.target); };
    const scroll = e => { if (e.target.classList?.contains('jv-editor-input')) { const pre = e.target.previousElementSibling; pre.scrollTop = e.target.scrollTop; pre.scrollLeft = e.target.scrollLeft; } };
    root.addEventListener('click', click);
    root.addEventListener('input', input);
    root.addEventListener('scroll', scroll, true); // scroll non risale: in cattura
    return () => { root.removeEventListener('click', click); root.removeEventListener('input', input); root.removeEventListener('scroll', scroll, true); };
  }

  const api = { parse, text, tree, highlight, tools, editor, bind, setNode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.JsonView = api;
})(typeof window !== 'undefined' ? window : globalThis);
