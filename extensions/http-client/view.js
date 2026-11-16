// Client HTTP: sezioni di richieste nella sidebar (fisarmonica), editor della richiesta con
// query, header e body, risposta formattata, dialoghi per sezione, tipologie di utenza e
// rotte Express trovate nel progetto collegato.

// colori dei metodi: variabili del tema
const METHOD_COLORS = { GET: 'var(--http-get)', POST: 'var(--http-post)', PUT: 'var(--http-put)', PATCH: 'var(--http-patch)', DELETE: 'var(--http-delete)', HEAD: 'var(--http-other)', OPTIONS: 'var(--http-other)' };
const methodColor = m => Object.hasOwn(METHOD_COLORS, m) ? METHOD_COLORS[m] : 'var(--http-other)';
const COLLAPSED_KEY = 'devdock.httpSections.collapsed';
const NPM_OUTPUT_KEY = 'devdock.httpSections.npmOutput'; // { <sezione>: script seguito, '' = nessuno }
const AUTH_TYPES = ['none', 'basic', 'manual', 'login', 'oauth'];

// ---- editor del corpo (JSON e testo): textarea trasparente sopra il testo colorato, come
// l'editor SQL del DB client; Tab/Maiusc+Tab rientrano, Invio mantiene il rientro ----

const INDENT = '  ';

// ---- risposta JSON: lettura fedele, albero richiudibile e colori dal core (ctx.ui.json) ----
const JSON_TREE_MAX = 2 * 1024 * 1024; // oltre: testo colorato, senza albero

// Variabili fuori dalle stringhe JSON ({{nome}}, :nome come valore) → fn(testo, indice):
// per controllare o formattare un corpo che contiene "id": {{id}} senza che sia JSON valido
function replaceBareVars(text, fn) {
  let out = '', i = 0, n = 0, inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') { inString = true; out += c; i++; continue; }
    const m = /^\{\{\s*[A-Za-z_][\w.-]*\s*\}\}/.exec(text.slice(i)) || (/[\w:]/.test(text[i - 1] || '') ? null : /^:[A-Za-z_]\w*/.exec(text.slice(i)));
    if (m && !(m[0][0] === ':' && /^:(true|false|null)$/.test(m[0]))) { out += fn(m[0], n++); i += m[0].length; continue; }
    out += c;
    i++;
  }
  return out;
}

// Posizione del primo errore di sintassi JSON (indice nel testo), o -1 se è valido: i
// messaggi di JSON.parse non sempre dicono dove (V8 spesso no)
function jsonErrorAt(text) {
  let i = 0;
  const ws = () => { while (/[ \t\n\r]/.test(text[i] || '')) i++; };
  const fail = () => { throw i; };
  const lit = word => { if (text.startsWith(word, i)) i += word.length; else fail(); };
  const string = () => {
    i++;
    for (;;) {
      const c = text[i];
      if (c === undefined || c === '\n' || c < ' ') fail();
      if (c === '"') { i++; return; }
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { i++; fail(); } i += 6; continue; }
        if (!'"\\/bfnrt'.includes(n ?? 'x')) { i++; fail(); }
        i += 2;
        continue;
      }
      i++;
    }
  };
  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += m[0].length;
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        string(); ws();
        if (text[i] !== ':') fail();
        i++; value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return; }
        fail();
      }
    }
    if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) {
        value(); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return; }
        fail();
      }
    }
    if (c === '"') return string();
    if (c === 't') return lit('true');
    if (c === 'f') return lit('false');
    if (c === 'n') return lit('null');
    return number();
  };
  try { value(); ws(); if (i < text.length) fail(); return -1; } catch (at) { if (typeof at !== 'number') throw at; return at; }
}

// Errore di sintassi del JSON (variabili a parte): null se valido o vuoto, altrimenti { line, column }
function jsonProblem(text) {
  if (!text.trim()) return null;
  const masked = replaceBareVars(text, v => '0'.padEnd(v.length)); // stessa lunghezza: posizioni invariate
  const at = jsonErrorAt(masked);
  if (at < 0) return null;
  const before = masked.slice(0, at).split('\n');
  return { line: before.length, column: before.at(-1).length + 1 };
}

// JSON formattato con 2 spazi, variabili lasciate come sono; lancia l'errore del JSON
function formatJson(text) {
  const vars = [];
  const masked = replaceBareVars(text, (v, i) => { vars.push(v); return `"__kelbo_var_${i}__"`; });
  return JSON.stringify(JSON.parse(masked), null, 2).replace(/"__kelbo_var_(\d+)__"/g, (m, i) => vars[Number(i)]);
}

// Colori: chiavi, stringhe, numeri, true/false/null e variabili ({{nome}}, :nome)
function highlightBody(text, esc, json) {
  const re = json
    ? /("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(\{\{\s*[A-Za-z_][\w.-]*\s*\}\})|((?:^|(?<=[^\w:])):[A-Za-z_]\w*)|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g
    : /()()(\{\{\s*[A-Za-z_][\w.-]*\s*\}\})|((?:^|(?<=[^\w:])):[A-Za-z_]\w*)()()/g;
  let out = '', last = 0, m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += esc(text.slice(last, m.index));
    const [tok, str, colon, braces, colonVar, lit, num] = m;
    if (str) {
      // variabili dentro una stringa: colorate anche lì
      const inner = esc(str).replace(/\{\{\s*[A-Za-z_][\w.-]*\s*\}\}|(?<=[^\w:]):[A-Za-z_]\w*/g, v => `<span class="hc-j-var">${v}</span>`);
      out += `<span class="${colon ? 'hc-j-key' : 'hc-j-str'}">${inner}</span>${colon || ''}`;
    } else if (braces || colonVar) out += `<span class="hc-j-var">${esc(tok)}</span>`;
    else if (lit) out += `<span class="hc-j-lit">${lit}</span>`;
    else if (num) out += `<span class="hc-j-num">${num}</span>`;
    else out += esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(text.slice(last)) + '\n'; // la riga finale vuota tiene allineata la textarea
}

// Inserisce testo come se lo si scrivesse: resta nell'annulla (Ctrl+Z) del browser
function typeText(ta, text) {
  if (!document.execCommand('insertText', false, text)) {
    ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Tasti dell'editor: Tab / Maiusc+Tab (anche su più righe), Invio con rientro, } e ] che
// tornano al livello giusto. → true se il tasto è stato gestito
function editorKey(ta, e) {
  const v = ta.value, start = ta.selectionStart, end = ta.selectionEnd;
  const lineStart = v.lastIndexOf('\n', start - 1) + 1;
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    const multi = v.slice(start, end).includes('\n');
    if (!multi && !e.shiftKey) { typeText(ta, INDENT); return true; }
    // righe intere della selezione: rientro aggiunto o tolto a ognuna
    const blockEnd = end > start && v[end - 1] === '\n' ? end - 1 : end;
    const lineEnd = v.indexOf('\n', blockEnd) === -1 ? v.length : v.indexOf('\n', blockEnd);
    const lines = v.slice(lineStart, lineEnd).split('\n');
    const next = lines.map(l => (e.shiftKey ? l.replace(/^ {1,2}|^\t/, '') : INDENT + l));
    ta.setSelectionRange(lineStart, lineEnd);
    typeText(ta, next.join('\n'));
    const firstDelta = next[0].length - lines[0].length;
    ta.setSelectionRange(multi ? lineStart : Math.max(lineStart, start + firstDelta), multi ? lineStart + next.join('\n').length : Math.max(lineStart, start + firstDelta));
    return true;
  }
  if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    const indent = /^[ \t]*/.exec(v.slice(lineStart, start))[0];
    const prev = v.slice(lineStart, start).trimEnd().at(-1);
    const nextCh = v.slice(end).trimStart()[0];
    if ((prev === '{' && nextCh === '}') || (prev === '[' && nextCh === ']')) {
      // tra due parentesi: riga rientrata in mezzo, parentesi di chiusura sotto
      typeText(ta, `\n${indent}${INDENT}\n${indent}`);
      const caret = ta.selectionStart - indent.length - 1;
      ta.setSelectionRange(caret, caret);
    } else typeText(ta, `\n${indent}${prev === '{' || prev === '[' ? INDENT : ''}`);
    return true;
  }
  if ((e.key === '}' || e.key === ']') && start === end && /^[ \t]+$/.test(v.slice(lineStart, start))) {
    // parentesi di chiusura all'inizio di una riga rientrata: un livello in meno
    e.preventDefault();
    const indent = v.slice(lineStart, start);
    ta.setSelectionRange(lineStart, start);
    typeText(ta, indent.slice(0, Math.max(0, indent.length - INDENT.length)) + e.key);
    return true;
  }
  return false;
}

export default {
  async mount(ctx) {
    const { esc, js, toast, openModal, closeModal, fmt } = ctx.ui;
    const { t } = ctx;
    const $ = (root, role) => root.querySelector(`[data-role="${role}"]`);
    const byId = id => document.getElementById(id);
    const val = id => byId(id)?.value ?? '';

    let info = { vault: 'locked', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'], maxAfterSteps: 5 };
    let sections = [];
    let projects = [];
    let active = null;      // { section, request } (id)
    let draft = null;       // copia della richiesta in modifica
    let dirty = false;
    let tab = 'query';
    let response = null;    // ultima risposta della richiesta attiva
    let respTab = 'body';
    let sending = false;
    let pendingLogin = null; // URL di autorizzazione mentre si attende il login nel browser

    const section = id => sections.find(s => s.id === id);
    const activeSection = () => (active ? section(active.section) : null);
    const methodBadge = m => `<span class="hc-badge" style="--m:${methodColor(m)}">${esc(m)}</span>`;

    // ---- caricamento ----

    async function load() {
      try {
        [info, sections] = await Promise.all([ctx.api.get('/info'), ctx.api.get('/sections')]);
      } catch (e) { toast(e.message, 'error'); sections = []; }
      try { projects = (await ctx.projects.load()).projects; } catch { projects = []; }
      if (active && !section(active.section)?.requests.some(r => r.id === active.request)) { active = null; draft = null; dirty = false; }
      renderSidebar();
      renderEditor();
    }

    // ---- sidebar ----

    function collapsed() { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]')); } catch { return new Set(); } }
    function storeCollapsed(set) { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set])); } catch { /* solo in questa sessione */ } }

    function renderSidebar() {
      const el = $(ctx.sidebar, 'sections');
      if (!sections.length) { el.innerHTML = `<p class="hc-muted hc-pad">${esc(t('sidebar.none'))}</p>`; ctx.setBadge(null); return; }
      const closed = collapsed();
      el.innerHTML = sections.map(s => {
        const open = !closed.has(s.id);
        const project = s.projectId ? projects.find(p => p.id === s.projectId) : null;
        return `<div class="hc-group ${open ? '' : 'collapsed'}">
          <div class="sb-item hc-group-head" role="button" tabindex="0" aria-expanded="${open}"
               onclick="Ext['http-client'].toggle(${js(s.id)})" oncontextmenu="event.preventDefault();Ext['http-client'].sectionMenu(event,${js(s.id)})">
            <svg class="pf-chevron ${open ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg>
            <span class="hc-group-label" title="${esc(project ? t('sidebar.linked', { project: project.label }) : s.label)}">${esc(s.label)}</span>
            <span class="sb-count">${esc(fmt.number(s.requests.length))}</span>
            <button class="sb-item-act" onclick="event.stopPropagation();Ext['http-client'].sectionMenu(event,${js(s.id)})" title="${esc(t('sidebar.sectionActions'))}"><i data-icon="ellipsis"></i></button>
          </div>
          <div class="hc-children">${sectionTree(s, closed)}</div>
        </div>`;
      }).join('');
      ctx.setBadge(null);
    }

    // Richieste di una sezione: raggruppate per tipologia di utenza (utenza ▸ cartelle ▸ richieste),
    // più "senza autorizzazione"; una sezione senza utenze ha cartelle e richieste direttamente.
    // --lvl è il livello di rientro; data-drag / data-drop servono a trascinare richieste e cartelle
    function sectionTree(s, closed) {
      const known = new Set(s.userTypes.map(u => u.id));
      const userOf = x => (x.userType && known.has(x.userType) ? x.userType : '');
      const folders = s.folders || [];
      const kids = (uid, parent) => folders.filter(f => userOf(f) === uid && (f.parent || null) === parent);
      const reqsIn = (uid, fid) => s.requests.filter(r => userOf(r) === uid && (r.folder || null) === fid);
      const countIn = (uid, fid) => reqsIn(uid, fid).length + kids(uid, fid).reduce((n, f) => n + countIn(uid, f.id), 0);
      const sid = js(s.id);
      const reqButton = (r, lvl) => `<button class="sb-item hc-req ${active?.request === r.id && active?.section === s.id ? 'active' : ''}" style="--lvl:${lvl}"
          draggable="true" data-section="${esc(s.id)}" data-drag="r:${esc(r.id)}"
          onclick="Ext['http-client'].open(${sid},${js(r.id)})" oncontextmenu="event.preventDefault();Ext['http-client'].requestMenu(event,${sid},${js(r.id)})">
          ${methodBadge(r.method)}<span class="hc-req-label">${esc(r.label)}</span></button>`;
      const addButton = (uid, fid, lvl) => `<button class="sb-item hc-add" style="--lvl:${lvl}" onclick="Ext['http-client'].newRequest(${sid},${js(uid || '')},${js(fid || '')})"><i data-icon="plus"></i> ${esc(t('sidebar.newRequest'))}</button>`;
      const folderHtml = (f, uid, lvl) => {
        const key = `${s.id}|f|${f.id}`;
        const open = !closed.has(key);
        const inner = tree(uid, f.id, lvl + 1);
        return `<div class="sb-item hc-folder-head" role="button" tabindex="0" aria-expanded="${open}" style="--lvl:${lvl}"
            draggable="true" data-section="${esc(s.id)}" data-drag="f:${esc(f.id)}" data-drop="f:${esc(f.id)}"
            onclick="Ext['http-client'].toggle(${js(key)})" oncontextmenu="event.preventDefault();Ext['http-client'].folderMenu(event,${sid},${js(f.id)})">
            <svg class="pf-chevron ${open ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg>
            <span class="hc-folder-icon">${ctx.ui.icon(open ? 'folder-open' : 'folder')}</span><span class="hc-group-label">${esc(f.label)}</span>
            <span class="sb-count">${esc(fmt.number(countIn(uid, f.id)))}</span>
            <button class="sb-item-act" onclick="event.stopPropagation();Ext['http-client'].folderMenu(event,${sid},${js(f.id)})" title="${esc(t('folder.actions'))}"><i data-icon="ellipsis"></i></button>
          </div>
          ${open ? inner || addButton(uid, f.id, lvl + 1) : ''}`;
      };
      const tree = (uid, fid, lvl) => kids(uid, fid).map(f => folderHtml(f, uid, lvl)).join('') + reqsIn(uid, fid).map(r => reqButton(r, lvl)).join('');
      if (!s.userTypes.length) return tree('', null, 1) + addButton(null, null, 1);
      const groups = [
        ...s.userTypes.map(u => ({ id: u.id, label: u.label, icon: 'user' })),
        { id: '', label: t('sidebar.noUser'), icon: 'user-x' },
      ].filter(g => g.id || countIn('', null) || kids('', null).length);
      return groups.map(g => {
        const key = `${s.id}|${g.id || '-'}`;
        const open = !closed.has(key);
        const inner = tree(g.id, null, 2);
        return `<div class="sb-item hc-user-head" role="button" tabindex="0" aria-expanded="${open}" data-section="${esc(s.id)}" data-drop="u:${esc(g.id)}"
            onclick="Ext['http-client'].toggle(${js(key)})" oncontextmenu="event.preventDefault();Ext['http-client'].userMenu(event,${sid},${js(g.id)})">
            <svg class="pf-chevron ${open ? 'open' : ''}" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5 7 5 3.5 8.5" /></svg>
            <span class="hc-user-icon">${ctx.ui.icon(g.icon)}</span><span class="hc-group-label">${esc(g.label)}</span>
            <span class="sb-count">${esc(fmt.number(countIn(g.id, null)))}</span>
            <button class="sb-item-act" onclick="event.stopPropagation();Ext['http-client'].newFolder(${sid},${js(g.id)},'')" title="${esc(t('folder.newIn', { name: g.label }))}"><i data-icon="folder-plus"></i></button>
            <button class="sb-item-act" onclick="event.stopPropagation();Ext['http-client'].newRequest(${sid},${js(g.id)},'')" title="${esc(t('sidebar.newRequestFor', { user: g.label }))}"><i data-icon="plus"></i></button>
          </div>
          ${open ? inner || addButton(g.id, null, 2) : ''}`;
      }).join('');
    }

    // Richiesta spostata (sotto un'altra utenza, in una cartella): { userType, folder }
    async function moveRequest(sectionId, requestId, { userType = null, folder = null }) {
      const s = section(sectionId);
      if (active?.section === sectionId && active?.request === requestId && draft) {
        if (userType) draft.userType = userType; else delete draft.userType;
        if (folder) draft.folder = folder; else delete draft.folder;
        renderEditor();
        return saveRequest();
      }
      const r = s.requests.find(x => x.id === requestId);
      try {
        const saved = await ctx.api.put(`/sections/${encodeURIComponent(sectionId)}/requests/${encodeURIComponent(requestId)}`, { ...r, userType, folder });
        s.requests = s.requests.map(x => (x.id === saved.id ? saved : x));
        renderSidebar();
      } catch (e) { toast(e.message, 'error'); }
    }
    const moveToUser = (sectionId, requestId, uid) => moveRequest(sectionId, requestId, { userType: uid || null });

    // ---- cartelle ----

    // Ricarica le sezioni dopo una modifica che tocca più richieste; la richiesta aperta prende
    // utenza e cartella aggiornate e tiene le modifiche non salvate
    async function reloadSections() {
      try { sections = await ctx.api.get('/sections'); } catch (e) { toast(e.message, 'error'); return; }
      const r = active && section(active.section)?.requests.find(x => x.id === active.request);
      if (r && draft) {
        for (const k of ['userType', 'folder']) { if (r[k]) draft[k] = r[k]; else delete draft[k]; }
        renderEditor();
      }
      renderSidebar();
    }

    function folderDialog(sectionId, { folderId = null, userType = '', parent = '' } = {}) {
      const f = folderId ? section(sectionId).folders.find(x => x.id === folderId) : null;
      openModal(t(f ? 'folder.renameTitle' : 'folder.newTitle'), `
        <div class="form-row"><label for="f_hc_folder">${esc(t('folder.name'))}</label>
          <input class="form-input" id="f_hc_folder" value="${esc(f?.label || '')}" maxlength="100"
            onkeydown="if(event.key==='Enter')Ext['http-client'].saveFolder(${js(sectionId)},${js(folderId || '')},${js(userType || '')},${js(parent || '')})"></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['http-client'].saveFolder(${js(sectionId)},${js(folderId || '')},${js(userType || '')},${js(parent || '')})">${esc(t(f ? 'core.action.save' : 'core.action.add'))}</button>`);
      setTimeout(() => { byId('f_hc_folder')?.focus(); byId('f_hc_folder')?.select(); }, 0);
    }

    async function saveFolder(sectionId, folderId, userType, parent) {
      const label = val('f_hc_folder').trim();
      if (!label) { byId('f_hc_folder')?.focus(); return; }
      const base = `/sections/${encodeURIComponent(sectionId)}/folders`;
      try {
        if (folderId) await ctx.api.put(`${base}/${encodeURIComponent(folderId)}`, { label });
        else {
          const fo = await ctx.api.post(base, { label, userType: userType || null, parent: parent || null });
          // la cartella nuova si vede: aperti la sezione, l'utenza e le cartelle che la contengono
          const closed = collapsed();
          closed.delete(sectionId); closed.delete(`${sectionId}|${fo.userType || '-'}`);
          for (let p = parent; p; p = section(sectionId).folders.find(x => x.id === p)?.parent) closed.delete(`${sectionId}|f|${p}`);
          storeCollapsed(closed);
        }
        closeModal();
        await reloadSections();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function deleteFolder(sectionId, folderId) {
      const f = section(sectionId).folders.find(x => x.id === folderId);
      if (!f || !confirm(t('folder.confirmDelete', { name: f.label }))) return;
      try {
        await ctx.api.del(`/sections/${encodeURIComponent(sectionId)}/folders/${encodeURIComponent(folderId)}`);
        await reloadSections();
      } catch (e) { toast(e.message, 'error'); }
    }

    // Dove si può spostare qualcosa: la radice di ogni utenza (o della sezione) e le sue cartelle,
    // in ordine di albero; without = una cartella da escludere con tutto quello che contiene
    function destinations(s, without = null) {
      const known = new Set(s.userTypes.map(u => u.id));
      const userOf = x => (x.userType && known.has(x.userType) ? x.userType : '');
      const out = [];
      const walk = (uid, parent, depth) => {
        for (const f of (s.folders || []).filter(x => userOf(x) === uid && (x.parent || null) === parent)) {
          if (f.id === without) continue;
          out.push({ userType: uid, folder: f.id, label: `${'\u00a0'.repeat(depth * 4)}› ${f.label}` });
          walk(uid, f.id, depth + 1);
        }
      };
      const roots = s.userTypes.length ? [...s.userTypes.map(u => [u.id, u.label]), ['', t('sidebar.noUser')]] : [['', t('folder.root')]];
      for (const [uid, label] of roots) {
        out.push({ userType: uid, folder: '', label, root: true });
        walk(uid, null, 1);
      }
      return out;
    }

    // what: { request } o { folder }
    function moveDialog(sectionId, what) {
      const s = section(sectionId);
      const item = what.request ? s.requests.find(x => x.id === what.request) : s.folders.find(x => x.id === what.folder);
      if (!item) return;
      const here = `${item.userType || ''}|${(what.request ? item.folder : item.parent) || ''}`;
      const options = destinations(s, what.folder).map(d => `<option class="${d.root ? 'hc-dest-root' : ''}" value="${esc(`${d.userType}|${d.folder}`)}" ${`${d.userType}|${d.folder}` === here ? 'selected' : ''}>${esc(d.label)}</option>`).join('');
      openModal(t('folder.moveTitle', { name: item.label }), `
        <div class="form-row"><label for="f_hc_dest">${esc(t('folder.destination'))}</label>
          <select class="form-input hc-dest" id="f_hc_dest" size="${Math.min(12, Math.max(4, destinations(s, what.folder).length))}">${options}</select>
          <p class="hc-muted">${esc(t(what.folder ? 'folder.moveFolderHint' : 'folder.moveRequestHint'))}</p></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['http-client'].confirmMove(${js(sectionId)},${js(what.request || '')},${js(what.folder || '')})">${esc(t('folder.move'))}</button>`);
      setTimeout(() => byId('f_hc_dest')?.focus(), 0);
    }

    // Sposta una richiesta o una cartella in dest ("utenza|cartella")
    async function moveTo(sectionId, what, dest) {
      const [userType, folder] = dest.split('|');
      if (what.request) return moveRequest(sectionId, what.request, { userType: userType || null, folder: folder || null });
      if (folder === what.folder) return;
      try {
        await ctx.api.put(`/sections/${encodeURIComponent(sectionId)}/folders/${encodeURIComponent(what.folder)}`, { parent: folder || null, userType: userType || null });
        await reloadSections();
      } catch (e) { toast(e.message, 'error'); }
    }

    function menuAt(event, items) {
      const rect = event.currentTarget?.getBoundingClientRect?.();
      ctx.ui.contextMenu(event.clientX || rect?.left || 0, event.clientY || rect?.bottom || 0, items);
    }

    // ---- editor ----

    function openRequest(sectionId, requestId) {
      const s = section(sectionId);
      const r = s?.requests.find(x => x.id === requestId);
      if (!r) return;
      active = { section: sectionId, request: requestId };
      draft = JSON.parse(JSON.stringify(r));
      dirty = false;
      response = null;
      pendingLogin = null;
      renderSidebar();
      renderEditor();
    }

    function markDirty() {
      dirty = true;
      $(ctx.root, 'dirty').hidden = false;
    }

    // Percorso della richiesta aperta: sezione › utenza (se la sezione ne ha) › cartelle
    function renderCrumbs() {
      const s = activeSection();
      if (!s || !draft) return;
      const project = s.projectId ? projects.find(p => p.id === s.projectId) : null;
      const sep = '<span class="hc-sep">›</span>';
      const crumb = (icon, label) => `<span class="hc-crumb" title="${esc(label)}">${ctx.ui.icon(icon)}<span>${esc(label)}</span></span>`;
      const parts = [`<span class="hc-section-name" title="${esc(project ? t('sidebar.linked', { project: project.label }) : s.label)}">${esc(s.label)}</span>`];
      if (s.userTypes.length) {
        const u = s.userTypes.find(x => x.id === draft.userType);
        parts.push(crumb(u ? 'user' : 'user-x', u ? u.label : t('sidebar.noUser')));
      }
      const chain = [];
      // la cartella vale solo con la sua utenza (cambiata nell'editor e non ancora salvata: ne esce)
      const folder = (s.folders || []).find(x => x.id === draft.folder && (x.userType || null) === (draft.userType || null));
      for (let f = folder; f && chain.length <= 10; f = s.folders.find(x => x.id === f.parent)) chain.unshift(f);
      for (const f of chain) parts.push(crumb('folder', f.label));
      $(ctx.root, 'crumbs').innerHTML = parts.join(sep);
    }

    function renderEditor() {
      const has = !!(active && draft);
      $(ctx.root, 'empty').hidden = has;
      $(ctx.root, 'workspace').hidden = !has;
      if (!has) return;
      const s = activeSection();
      renderCrumbs();
      $(ctx.root, 'label').value = draft.label;
      $(ctx.root, 'dirty').hidden = !dirty;
      $(ctx.root, 'method').innerHTML = info.methods.map(m => `<option ${m === draft.method ? 'selected' : ''}>${esc(m)}</option>`).join('');
      $(ctx.root, 'method').style.color = methodColor(draft.method);
      $(ctx.root, 'url').value = draft.url;
      $(ctx.root, 'user').innerHTML = `<option value="">${esc(t('editor.noUser'))}</option>` +
        s.userTypes.map(u => `<option value="${esc(u.id)}" ${u.id === draft.userType ? 'selected' : ''}>${esc(u.label)}</option>`).join('');
      renderVars();
      renderTabs();
      renderResponse();
      refreshNpmOutput();
      refreshTokenButton();
    }

    // "Dimentica il token" accanto all'utenza scelta, solo se ne ha uno in memoria
    async function refreshTokenButton() {
      const btn = $(ctx.root, 'forget-token');
      const s = activeSection();
      const uid = draft?.userType;
      if (!s || !uid) { btn.hidden = true; return; }
      let users = [];
      try { users = (await ctx.api.get(`/sections/${encodeURIComponent(s.id)}/auth`)).users; } catch { users = []; }
      if (activeSection() !== s || draft?.userType !== uid) return; // nel frattempo è cambiata
      btn.hidden = !users.find(u => u.id === uid)?.hasToken;
    }

    async function forgetActiveToken() {
      const s = activeSection();
      const u = s?.userTypes.find(x => x.id === draft?.userType);
      if (!u) return;
      try {
        await ctx.api.del(`/sections/${encodeURIComponent(s.id)}/users/${encodeURIComponent(u.id)}/token`);
        toast(t('editor.tokenForgotten', { name: u.label }), 'success');
      } catch (e) { toast(e.message, 'error'); }
      refreshTokenButton();
    }

    // ---- output dei processi npm del progetto collegato (se c'è l'estensione npm) ----
    // Si segue lo script scelto per la sezione (npm start se non si è scelto nulla), nel
    // pannello di output in fondo; la scelta resta nel browser
    let npmProcs = [];      // processi del progetto della sezione attiva, uno per script
    let following = null;   // { procId, script }
    let closeStream = null;
    const npmChoices = () => { try { return JSON.parse(localStorage.getItem(NPM_OUTPUT_KEY)) || {}; } catch { return {}; } };
    function npmChoice(sectionId) {
      const c = npmChoices();
      return Object.hasOwn(c, sectionId) ? c[sectionId] : 'start';
    }
    function storeNpmChoice(sectionId, script) {
      const all = npmChoices();
      all[sectionId] = script;
      try { localStorage.setItem(NPM_OUTPUT_KEY, JSON.stringify(all)); } catch { /* solo in questa sessione */ }
    }

    async function refreshNpmOutput() {
      const sel = $(ctx.root, 'npm-output');
      const s = activeSection();
      if (!s?.projectId || !ctx.hasExtension('npm')) { sel.hidden = true; if (following) unfollowNpm(); return; }
      let list = [];
      try { list = await ctx.apiFor('npm').get('/processes'); } catch { list = []; }
      if (activeSection() !== s) return; // nel frattempo si è aperta un'altra sezione
      // uno per script: quello in esecuzione, altrimenti il più recente; start per primo
      const byScript = new Map();
      for (const p of list.filter(p => p.projectId === s.projectId)) {
        const cur = byScript.get(p.script);
        if (!cur || (p.running && !cur.running) || (p.running === cur.running && (p.startedAt || 0) > (cur.startedAt || 0))) byScript.set(p.script, p);
      }
      npmProcs = [...byScript.values()].sort((a, b) => (b.script === 'start') - (a.script === 'start') || a.script.localeCompare(b.script));
      // l'output seguito era di un altro progetto: si chiude
      if (following && following.projectId !== s.projectId) unfollowNpm();
      const choice = npmChoice(s.id);
      const shown = following && npmProcs.some(p => p.id === following.procId) ? following.script : '';
      sel.hidden = !npmProcs.length;
      const html = `<option value="">${esc(t('npmOutput.none'))}</option>` + npmProcs.map(p =>
        `<option value="${esc(p.script)}" ${p.script === (shown || choice) ? 'selected' : ''}>${esc(t(p.running ? 'npmOutput.running' : 'npmOutput.ended', { script: p.script }))}</option>`).join('');
      // il menu si riscrive solo se cambia: aperto mentre si aggiorna, si richiuderebbe
      if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
      // la scelta della sezione è in esecuzione e non la si sta già seguendo: si apre
      const want = npmProcs.find(p => p.script === choice && p.running);
      if (want && following?.procId !== want.id) followNpm(want);
    }

    function followNpm(proc) {
      closeStream?.(); closeStream = null;
      following = { procId: proc.id, script: proc.script, projectId: proc.projectId };
      const output = ctx.ui.output;
      output.open(t('npmOutput.panel', { script: proc.script }));
      closeStream = ctx.apiFor('npm').events(`/processes/${encodeURIComponent(proc.id)}/stream`, ({ type, data }) => {
        if (type === 'exit') {
          output.append(`\n${data?.removed ? t('npmOutput.removed') : t('npmOutput.exit', { code: String(data?.exitCode) })}`, 'sys');
          closeStream?.(); closeStream = null;
        } else output.append(data, type === 'stderr' ? 'err' : 'out');
      }, () => output.append(`\n${t('npmOutput.lost')}`, 'err'));
    }

    function unfollowNpm() {
      closeStream?.(); closeStream = null;
      following = null;
      ctx.ui.output.close();
    }

    function renderVars() {
      const s = activeSection();
      const names = ['baseUrl', ...s.variables.map(v => v.name)];
      $(ctx.root, 'vars').innerHTML = `<span class="hc-muted">${esc(t('editor.variables'))}</span> ` +
        names.map(n => `<code class="hc-var" title="${esc(n === 'baseUrl' ? s.baseUrl || t('editor.baseUrlMissing') : s.variables.find(v => v.name === n)?.value ?? '')} · ${esc(t('editor.variableForms', { name: n }))}">{{${esc(n)}}}</code>`).join(' ') +
        ` <button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].editSection(${js(s.id)})"><i data-icon="pencil"></i></button>`;
    }

    const count = list => (list || []).filter(p => p.name && p.enabled !== false).length;

    function renderTabs() {
      const label = (key, n) => `${esc(t(key))}${n ? ` <span class="hc-tab-count">${esc(fmt.number(n))}</span>` : ''}`;
      $(ctx.root, 'tab-query').innerHTML = label('tabs.query', count(draft.query));
      $(ctx.root, 'tab-headers').innerHTML = label('tabs.headers', count(draft.headers));
      $(ctx.root, 'tab-body').innerHTML = label('tabs.body', draft.bodyType !== 'none' ? 1 : 0).replace(/<span class="hc-tab-count">1<\/span>/, '<span class="hc-tab-count">●</span>');
      ctx.root.querySelectorAll('.hc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
      const pane = $(ctx.root, 'req-pane');
      if (tab === 'body') {
        pane.innerHTML = `<div class="hc-body-types">
            ${['none', 'json', 'text', 'file', 'form'].map(bt => `<label class="hc-radio"><input type="radio" name="hc_body_type" value="${bt}" ${draft.bodyType === bt ? 'checked' : ''}> ${esc(t(`body.${bt}`))}</label>`).join('')}
            ${draft.bodyType === 'json' ? `<button class="btn btn-ghost btn-sm" data-action="format-json">${esc(t('body.format'))}</button>` : ''}
          </div>
          ${draft.bodyType === 'none' ? `<p class="hc-muted">${esc(t('body.noneHint'))}</p>`
            : draft.bodyType === 'file' ? `<input class="form-input hc-code" data-role="file" value="${esc(draft.file || '')}" spellcheck="false" placeholder="${esc(t('body.filePlaceholder'))}">
                <p class="hc-muted">${esc(t('body.fileHint'))}</p>`
            : draft.bodyType === 'form' ? formTable(draft.form || [])
            : `<div class="hc-editor">
                <pre class="hc-editor-hl" aria-hidden="true"><code data-role="body-hl">${highlightBody(draft.body || '', esc, draft.bodyType === 'json')}</code></pre>
                <textarea class="hc-editor-input" data-role="body" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="${esc(t('tabs.body'))}">${esc(draft.body)}</textarea>
              </div>
              ${draft.bodyType === 'json' ? `<div class="hc-json-status" data-role="json-status" aria-live="polite">${jsonStatus(draft.body || '')}</div>` : ''}`}`;
      } else {
        pane.innerHTML = pairsTable(tab, draft[tab] || []);
      }
    }

    // Campi del form multipart: testo o file (percorso, come per il corpo "file")
    function formTable(items) {
      return `<table class="hc-pairs"><tbody>
        ${items.map((p, i) => `<tr>
          <td class="hc-pair-check"><input type="checkbox" data-list="form" data-index="${i}" data-field="enabled" ${p.enabled === false ? '' : 'checked'} title="${esc(t('pairs.enabled'))}"></td>
          <td><input class="form-input" data-list="form" data-index="${i}" data-field="name" value="${esc(p.name)}" placeholder="${esc(t('pairs.name'))}" spellcheck="false"></td>
          <td class="hc-form-type"><select class="form-input" data-list="form" data-index="${i}" data-field="type">
            <option value="text" ${p.type !== 'file' ? 'selected' : ''}>${esc(t('body.formText'))}</option>
            <option value="file" ${p.type === 'file' ? 'selected' : ''}>${esc(t('body.formFile'))}</option></select></td>
          <td><input class="form-input ${p.type === 'file' ? 'hc-code' : ''}" data-list="form" data-index="${i}" data-field="value" value="${esc(p.value)}" placeholder="${esc(t(p.type === 'file' ? 'body.filePlaceholder' : 'pairs.value'))}" spellcheck="false"></td>
          <td class="hc-pair-check"><button class="sb-item-act hc-visible" data-action="remove-pair" data-list="form" data-index="${i}" title="${esc(t('core.action.delete'))}"><i data-icon="x"></i></button></td>
        </tr>`).join('')}
      </tbody></table>
      <button class="btn btn-ghost btn-sm" data-action="add-pair" data-list="form"><i data-icon="plus"></i> ${esc(t('body.formAdd'))}</button>
      <p class="hc-muted">${esc(t('body.formHint'))}</p>`;
    }

    // Tabella nome/valore modificabile (query e header dell'editor)
    function pairsTable(list, items) {
      return `<table class="hc-pairs"><tbody>
        ${items.map((p, i) => `<tr>
          <td class="hc-pair-check"><input type="checkbox" data-list="${list}" data-index="${i}" data-field="enabled" ${p.enabled === false ? '' : 'checked'} title="${esc(t('pairs.enabled'))}"></td>
          <td><input class="form-input" data-list="${list}" data-index="${i}" data-field="name" value="${esc(p.name)}" placeholder="${esc(t('pairs.name'))}" spellcheck="false"></td>
          <td><input class="form-input" data-list="${list}" data-index="${i}" data-field="value" value="${esc(p.value)}" placeholder="${esc(t('pairs.value'))}" spellcheck="false"></td>
          <td class="hc-pair-check"><button class="sb-item-act hc-visible" data-action="remove-pair" data-list="${list}" data-index="${i}" title="${esc(t('core.action.delete'))}"><i data-icon="x"></i></button></td>
        </tr>`).join('')}
      </tbody></table>
      <button class="btn btn-ghost btn-sm" data-action="add-pair" data-list="${list}"><i data-icon="plus"></i> ${esc(t(list === 'query' ? 'pairs.addQuery' : 'pairs.addHeader'))}</button>`;
    }

    function statusClass(status) {
      if (status >= 500) return 'hc-st-5';
      if (status >= 400) return 'hc-st-4';
      if (status >= 300) return 'hc-st-3';
      return 'hc-st-2';
    }

    // Risposta binaria → file nei Download del browser, con il nome dato dal server
    // (Content-Disposition, altrimenti dal Content-Type)
    function downloadResponse() {
      const r = response;
      if (!r?.base64) return;
      const bytes = Uint8Array.from(atob(r.base64), c => c.charCodeAt(0));
      const type = r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] || 'application/octet-stream';
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([bytes], { type })), download: r.fileName });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    function renderResponse() {
      const el = $(ctx.root, 'response');
      if (sending) {
        el.innerHTML = `<div class="hc-resp-wait"><span class="hc-spinner"></span> ${esc(t(pendingLogin ? 'response.waitingLogin' : 'response.sending'))}
          ${pendingLogin ? ` <a href="${esc(pendingLogin)}" target="_blank" rel="noopener noreferrer">${esc(t('response.openLogin'))}</a>` : ''}</div>`;
        return;
      }
      if (!response) { el.innerHTML = `<p class="hc-muted hc-pad">${esc(t('response.none'))}</p>`; return; }
      if (response.error) { el.innerHTML = `<div class="hc-resp-error">${esc(response.error)}</div>`; return; }
      const r = response;
      // JSON letto una volta per risposta (albero e copie formattata/minificata)
      if (r.json && !r.binary && r.body && r.jsonNode === undefined) { try { r.jsonNode = ctx.ui.json.parse(r.body.trim()); } catch { r.jsonNode = null; } }
      const jsonNode = r.jsonNode || null;
      let body;
      if (r.binary) body = r.base64
        ? `<p class="hc-pad">${esc(t('response.downloaded', { name: r.fileName, size: fmt.bytes(r.size) }))}
            <button class="btn btn-ghost btn-sm" data-action="download-body">${ctx.ui.icon('download')} ${esc(t('response.downloadAgain'))}</button></p>`
        : `<p class="hc-muted hc-pad">${esc(t(r.truncated ? 'response.binaryTooLarge' : 'response.binary', { size: fmt.bytes(r.size) }))}</p>`;
      else if (!r.body) body = `<p class="hc-muted hc-pad">${esc(t('response.empty'))}</p>`;
      else {
        let text = r.body, tree = null;
        if (jsonNode && r.body.length <= JSON_TREE_MAX) {
          tree = ctx.ui.json.tree(jsonNode);
        }
        if (r.json && !tree) { try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch { /* lascia il testo */ } }
        body = tree ? `<div class="jv-scope hc-resp-scope">${ctx.ui.json.tools()}<div class="hc-resp-body hc-json">${tree}</div></div>`
          : `<pre class="hc-resp-body ${r.json ? 'hc-json' : ''}">${r.json ? ctx.ui.json.highlight(text) : esc(text)}</pre>`;
      }
      el.innerHTML = `<div class="hc-resp-meta">
          <span class="hc-status ${statusClass(r.status)}">${esc(r.status)} ${esc(r.statusText)}</span>
          <span>${esc(t('response.time', { ms: fmt.number(Math.round(r.ms)) }))}</span>
          <span>${esc(fmt.bytes(r.size))}</span>
          ${r.truncated ? `<span class="hc-warn">${esc(t('response.truncated'))}</span>` : ''}
          ${r.user ? `<span class="hc-muted"><i data-icon="user"></i> ${esc(activeSection()?.userTypes.find(u => u.id === r.user)?.label || r.user)}</span>` : ''}
          <span class="hc-resp-url" title="${esc(r.url)}">${esc(r.url)}</span>
          <div class="hc-tabs hc-resp-tabs">
            <button class="hc-tab ${respTab === 'body' ? 'active' : ''}" data-resp-tab="body">${esc(t('response.body'))}</button>
            <button class="hc-tab ${respTab === 'headers' ? 'active' : ''}" data-resp-tab="headers">${esc(t('response.headers'))} <span class="hc-tab-count">${esc(fmt.number(r.headers.length))}</span></button>
            ${r.body && jsonNode ? `<button class="btn btn-ghost btn-sm" data-action="copy-body" data-format="pretty" title="${esc(t('response.copyPrettyTitle'))}">${esc(t('response.copyPretty'))}</button>
              <button class="btn btn-ghost btn-sm" data-action="copy-body" data-format="min" title="${esc(t('response.copyMinTitle'))}">${esc(t('response.copyMin'))}</button>`
              : r.body ? `<button class="btn btn-ghost btn-sm" data-action="copy-body">${esc(t('response.copy'))}</button>` : ''}
            ${responseButtons(r)}
          </div>
        </div>
        ${respTab === 'body' ? body : `<table class="data-table hc-resp-headers"><tbody>${r.headers.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`}`;
    }

    // JSON già formattato → HTML colorato (chiavi, stringhe, numeri, letterali)
    // Stato del JSON sotto l'editor: valido, o errore con riga e colonna
    function jsonStatus(text) {
      const p = jsonProblem(text);
      if (!text.trim()) return '';
      if (!p) return `<span class="hc-json-ok"><i data-icon="check"></i> ${esc(t('body.jsonValid'))}</span>`;
      return `<span class="hc-json-err"><i data-icon="circle-x"></i> ${esc(p.line ? t('body.jsonErrorAt', { line: p.line, column: p.column }) : t('body.invalidJson', { error: p.message }))}</span>`;
    }
    let jsonTimer = null;
    function syncBody(ta) {
      const hl = $(ctx.root, 'body-hl');
      if (!hl) return;
      hl.innerHTML = highlightBody(ta.value, esc, draft.bodyType === 'json');
      syncBodyScroll(ta);
      clearTimeout(jsonTimer);
      jsonTimer = setTimeout(() => { const st = $(ctx.root, 'json-status'); if (st) st.innerHTML = jsonStatus(ta.value); }, 250);
    }
    function syncBodyScroll(ta) {
      const pre = $(ctx.root, 'body-hl')?.parentElement;
      if (pre) { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; }
    }

    // ---- invio e salvataggio ----

    // Esegue fn; se il vault della master password è bloccato (o da creare) lo chiede e riprova
    async function withVault(fn) {
      try { return await fn(); } catch (e) {
        if (!ctx.vault.isVaultError(e)) throw e;
        if (await ctx.vault.ensure()) return fn();
        throw Object.assign(new Error(t('vault.stillLocked')), { handled: true });
      }
    }

    async function send() {
      if (!draft || sending) return;
      readEditor();
      sending = true;
      pendingLogin = null;
      $(ctx.root, 'send-btn').disabled = true;
      renderResponse();
      const s = activeSection();
      const user = s.userTypes.find(u => u.id === draft.userType);
      // durante un login OAuth nel browser l'invio resta in attesa: si mostra il link di riserva
      const poll = user?.auth.type === 'oauth' ? setInterval(async () => {
        try {
          const st = (await ctx.api.get(`/sections/${encodeURIComponent(s.id)}/auth`)).users.find(u => u.id === user.id);
          if (sending && st?.pendingLogin !== pendingLogin) { pendingLogin = st?.pendingLogin || null; renderResponse(); }
        } catch { /* riprova al giro dopo */ }
      }, 1200) : null;
      try {
        response = await withVault(() => ctx.api.post('/send', { section: s.id, request: draft }));
        respTab = 'body';
        if (response.base64) downloadResponse(); // contenuto binario: salvato subito nei Download
      } catch (e) {
        response = { error: e.message };
        if (e.code === 'http-client.token_missing' || e.code === 'http-client.token_expired') pasteToken(s.id, user.id);
      } finally {
        clearInterval(poll);
        sending = false;
        pendingLogin = null;
        $(ctx.root, 'send-btn').disabled = false;
        renderResponse();
        refreshTokenButton(); // l'invio può aver ottenuto un token
      }
    }

    function readEditor() {
      draft.label = $(ctx.root, 'label').value.trim() || draft.label;
      draft.url = $(ctx.root, 'url').value;
      const body = $(ctx.root, 'body');
      if (body) draft.body = body.value;
      const file = $(ctx.root, 'file');
      if (file) draft.file = file.value.trim();
    }

    async function saveRequest() {
      if (!draft) return;
      readEditor();
      try {
        const r = await ctx.api.put(`/sections/${encodeURIComponent(active.section)}/requests/${encodeURIComponent(active.request)}`, draft);
        const s = activeSection();
        s.requests = s.requests.map(x => (x.id === r.id ? r : x));
        if (r.folder) draft.folder = r.folder; else delete draft.folder;
        renderCrumbs();
        dirty = false;
        $(ctx.root, 'dirty').hidden = true;
        renderSidebar();
        toast(t('editor.saved', { name: r.label }), 'success');
      } catch (e) { toast(e.message, 'error'); }
    }

    // Lasciare una richiesta con modifiche non salvate chiede prima
    const canLeave = () => !dirty || confirm(t('editor.confirmLeave'));

    async function createRequest(sectionId, data = {}) {
      try {
        const r = await ctx.api.post(`/sections/${encodeURIComponent(sectionId)}/requests`, {
          label: t('editor.newLabel'), method: 'GET', url: '{{baseUrl}}/', ...data,
        });
        section(sectionId).requests.push(r);
        // visibile nella sidebar: aperti la sezione, l'utenza e le cartelle che la contengono
        const closed = collapsed(); closed.delete(sectionId); closed.delete(`${sectionId}|${r.userType || '-'}`);
        for (let f = r.folder; f; f = section(sectionId).folders?.find(x => x.id === f)?.parent) closed.delete(`${sectionId}|f|${f}`);
        storeCollapsed(closed);
        openRequest(sectionId, r.id);
        setTimeout(() => $(ctx.root, data.url ? 'url' : 'label')?.focus(), 0);
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---- sezione: nome, progetto, URL di base, variabili ----

    function variablesRows(list) {
      return list.map((v, i) => `<tr>
        <td><input class="form-input" data-var="name" value="${esc(v.name)}" placeholder="${esc(t('pairs.name'))}" spellcheck="false"></td>
        <td><input class="form-input" data-var="value" value="${esc(v.value)}" placeholder="${esc(t('pairs.value'))}" spellcheck="false"></td>
        <td class="hc-pair-check"><button class="sb-item-act hc-visible" onclick="this.closest('tr').remove()" title="${esc(t('core.action.delete'))}"><i data-icon="x"></i></button></td>
      </tr>`).join('');
    }

    function sectionDialog(id) {
      const s = id ? section(id) : { label: '', projectId: '', baseUrl: 'http://localhost:3000', variables: [] };
      openModal(t(id ? 'sectionDlg.editTitle' : 'sectionDlg.newTitle'), `
        <div class="form-row"><label>${esc(t('sectionDlg.name'))}</label><input class="form-input" id="f_hc_label" value="${esc(s.label)}"></div>
        <div class="form-row"><label>${esc(t('sectionDlg.project'))}</label>
          <select class="form-input" id="f_hc_project" onchange="Ext['http-client'].proposeBase(false)">
            <option value="">${esc(t('sectionDlg.noProject'))}</option>
            ${projects.map(p => `<option value="${esc(p.id)}" ${p.id === s.projectId ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
          </select>
          <p class="hc-muted">${esc(t('sectionDlg.projectHint'))}</p></div>
        <div class="form-row"><label>${esc(t('sectionDlg.baseUrl'))} <code>{{baseUrl}}</code></label>
          <div class="hc-inline"><input class="form-input" id="f_hc_base" value="${esc(s.baseUrl || '')}" spellcheck="false">
          <button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].proposeBase(true)" title="${esc(t('sectionDlg.proposeTitle'))}">${esc(t('sectionDlg.propose'))}</button></div>
          <p class="hc-muted" id="f_hc_base_hint"></p></div>
        <div class="form-row"><label>${esc(t('sectionDlg.variables'))}</label>
          <table class="hc-pairs"><tbody id="f_hc_vars">${variablesRows(s.variables)}</tbody></table>
          <button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].addVariable()"><i data-icon="plus"></i> ${esc(t('sectionDlg.addVariable'))}</button>
          <p class="hc-muted">${esc(t('sectionDlg.variablesHint'))}</p></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['http-client'].saveSection(${js(id || '')})">${esc(t(id ? 'core.action.save' : 'core.action.add'))}</button>`);
      setTimeout(() => byId('f_hc_label')?.focus(), 0);
    }

    async function proposeBase(force) {
      const project = val('f_hc_project');
      const hint = byId('f_hc_base_hint');
      if (!project) { if (hint) hint.textContent = ''; return; }
      try {
        const r = await ctx.api.get(`/base-url?project=${encodeURIComponent(project)}`);
        const input = byId('f_hc_base');
        if (force || !input.value || /^http:\/\/localhost:\d+\/?$/.test(input.value)) input.value = r.baseUrl;
        hint.textContent = r.port ? t('sectionDlg.portFrom', { port: r.port, file: r.source }) : t('sectionDlg.portDefault');
      } catch (e) { toast(e.message, 'error'); }
    }

    async function saveSection(id) {
      const body = {
        label: val('f_hc_label').trim(), projectId: val('f_hc_project'), baseUrl: val('f_hc_base').trim(),
        variables: [...byId('f_hc_vars').querySelectorAll('tr')].map(tr => ({
          name: tr.querySelector('[data-var="name"]').value.trim(), value: tr.querySelector('[data-var="value"]').value,
        })).filter(v => v.name || v.value),
      };
      if (!body.label) { toast(t('sectionDlg.nameRequired'), 'error'); return; }
      try {
        const s = id ? await ctx.api.put(`/sections/${encodeURIComponent(id)}`, body) : await ctx.api.post('/sections', body);
        if (id) sections = sections.map(x => (x.id === s.id ? s : x)); else sections.push(s);
        closeModal();
        renderSidebar();
        if (active?.section === s.id) renderEditor();
      } catch (e) { toast(e.message, 'error'); }
    }

    async function deleteSection(id) {
      const s = section(id);
      if (!confirm(t('sectionDlg.confirmDelete', { name: s.label, count: s.requests.length }))) return;
      try {
        await ctx.api.del(`/sections/${encodeURIComponent(id)}`);
        sections = sections.filter(x => x.id !== id);
        if (active?.section === id) { active = null; draft = null; dirty = false; }
        renderSidebar();
        renderEditor();
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---- tipologie di utenza ----

    let usersSection = null;
    let authStates = [];

    async function usersDialog(sectionId) {
      // utenze, password e token solo con la master password: chiesta prima di aprire il dialog
      if (!(await ctx.vault.ensure())) return;
      usersSection = sectionId;
      try { authStates = (await ctx.api.get(`/sections/${encodeURIComponent(sectionId)}/auth`)).users; } catch (e) { toast(e.message, 'error'); authStates = []; }
      refreshTokenButton(); // login, token incollato o dimenticato dal dialogo
      let browser = null;
      try { browser = await ctx.api.get('/browser'); } catch { /* riga del browser non mostrata */ }
      const s = section(sectionId);
      const tokenState = u => {
        const st = authStates.find(x => x.id === u.id);
        if (u.auth.type === 'none') return `<span class="hc-muted">${esc(t('users.noAuth'))}</span>`;
        if (u.auth.type === 'basic') return `<span class="hc-muted">${esc(t(u.auth.hasPassword ? 'users.basicReady' : 'users.basicNoPassword'))}</span>`;
        // login nel browser in corso: link per aprirlo a mano (sempre, e con l'errore se il browser non è partito)
        if (st?.pendingLogin) return `<span class="hc-warn">${esc(t(st.browserError ? 'users.browserFailed' : 'users.loginPending', { error: st.browserError || '' }))}</span>
          <a href="${esc(st.pendingLogin)}" target="_blank" rel="noopener noreferrer">${esc(t('users.openLink'))}</a>`;
        if (!st?.hasToken) return `<span class="hc-muted">${esc(t('users.noToken'))}</span>`;
        if (st.expired) return `<span class="hc-warn">${esc(t('users.expired'))}</span>`;
        return `<span class="hc-ok">${esc(st.expiresAt ? t('users.validUntil', { date: fmt.date(st.expiresAt, { dateStyle: 'short', timeStyle: 'short' }) }) : t('users.valid'))}</span>
          ${st.vars.length ? `<span class="hc-muted"> · ${esc(t('users.vars', { list: fmt.list(st.vars) }))}</span>` : ''}`;
      };
      openModal(t('users.title', { section: s.label }), `
        <p class="hc-muted">${esc(t('users.hint'))}</p>
        ${s.userTypes.length ? `<table class="data-table hc-users"><tbody>${s.userTypes.map(u => `<tr>
          <td><strong><i data-icon="user"></i> ${esc(u.label)}</strong><div class="hc-muted">${esc(t(`auth.${u.auth.type}`))}</div></td>
          <td>${tokenState(u)}</td>
          <td class="hc-users-actions">
            ${['login', 'oauth'].includes(u.auth.type) ? `<button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].login(${js(u.id)})">${esc(t('users.login'))}</button>` : ''}
            ${!['none', 'basic'].includes(u.auth.type) ? `<button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].pasteToken(${js(sectionId)},${js(u.id)})">${esc(t('users.paste'))}</button>` : ''}
            ${authStates.find(x => x.id === u.id)?.hasToken ? `<button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].forgetToken(${js(u.id)})">${esc(t('users.forget'))}</button>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].editUser(${js(u.id)})"><i data-icon="pencil"></i></button>
            <button class="btn btn-ghost btn-sm hc-danger" onclick="Ext['http-client'].deleteUser(${js(u.id)})"><i data-icon="trash-2"></i></button>
          </td></tr>`).join('')}</tbody></table>` : `<p class="hc-muted">${esc(t('users.none'))}</p>`}
        ${browser ? `<div class="hc-browser"><span class="hc-muted">${esc(t('browser.label'))}</span>
          <code>${esc(browser.path || (browser.wsl ? (browser.firefox ? t('browser.wslFirefox', { path: browser.firefox }) : t('browser.wslDefault')) : t('browser.default')))}</code>
          <button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].browserDialog(${js(sectionId)})">${esc(t('browser.change'))}</button></div>` : ''}`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>
         <button class="btn btn-primary" onclick="Ext['http-client'].editUser('')"><i data-icon="plus"></i> ${esc(t('users.add'))}</button>`);
      byId('modal').classList.add('modal-wide');
    }

    // Righe "Nome: valore" ↔ lista di coppie (header delle azioni dopo il token)
    const linesOf = list => (list || []).map(p => `${p.name}: ${p.value}`).join('\n');
    const pairsOf = text => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf(':');
      return i < 0 ? { name: l, value: '' } : { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    });
    const extractLines = list => (list || []).map(x => `${x.name} = ${x.from}`).join('\n');
    const extractOf = text => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      const i = l.indexOf('=');
      return i < 0 ? { name: l, from: '' } : { name: l.slice(0, i).trim(), from: l.slice(i + 1).trim() };
    });

    let userDraft = null; // tipologia in modifica (con le azioni dopo il token)

    function editUser(uid) {
      const s = section(usersSection);
      const u = uid ? s.userTypes.find(x => x.id === uid) : { label: '', auth: { type: 'none' }, afterToken: [] };
      userDraft = JSON.parse(JSON.stringify({ ...u, afterToken: u.afterToken || [] }));
      renderUserForm(uid);
    }

    function renderUserForm(uid) {
      const u = userDraft;
      const a = u.auth;
      const secretInput = (id, has) => `<input class="form-input" type="password" id="${id}" autocomplete="new-password" placeholder="${esc(t(has ? 'userDlg.secretKeep' : 'userDlg.secretNew'))}">
        ${has ? `<label class="hc-check"><input type="checkbox" id="${id}_clear"> ${esc(t('userDlg.secretRemove'))}</label>` : ''}`;
      const field = (label, html, hint) => `<div class="form-row"><label>${esc(label)}</label>${html}${hint ? `<p class="hc-muted">${esc(hint)}</p>` : ''}</div>`;
      const input = (id, value, extra = '') => `<input class="form-input" id="${id}" value="${esc(value ?? '')}" spellcheck="false" ${extra}>`;
      let fields = '';
      if (a.type === 'basic') {
        fields = field(t('userDlg.username'), input('f_u_username', a.username))
          + field(t('userDlg.password'), secretInput('f_u_password', a.hasPassword), t('userDlg.secretHint'));
      } else if (a.type === 'manual') {
        fields = `<p class="hc-muted">${esc(t('userDlg.manualHint'))}</p>`;
      } else if (a.type === 'login') {
        fields = `<div class="hc-inline">
            <select class="form-input hc-method" id="f_u_method">${['POST', 'GET', 'PUT', 'PATCH'].map(m => `<option ${m === (a.method || 'POST') ? 'selected' : ''}>${m}</option>`).join('')}</select>
            ${input('f_u_url', a.url || '{{baseUrl}}/auth/login', 'placeholder="{{baseUrl}}/auth/login"')}</div>`
          + field(t('userDlg.contentType'), `<select class="form-input" id="f_u_ctype">${['json', 'form', 'text'].map(c => `<option value="${c}" ${c === (a.contentType || 'json') ? 'selected' : ''}>${esc(t(`userDlg.ctype.${c}`))}</option>`).join('')}</select>`)
          + field(t('userDlg.loginBody'), `<textarea class="form-input hc-code" id="f_u_body" rows="4" spellcheck="false">${esc(a.body ?? '{\n  "username": "{{username}}",\n  "password": "{{password}}"\n}')}</textarea>`, t('userDlg.loginBodyHint'))
          + `<div class="hc-grid2">${field(t('userDlg.username'), input('f_u_username', a.username))}${field(t('userDlg.password'), secretInput('f_u_password', a.hasPassword))}</div>`
          + `<div class="hc-grid2">${field(t('userDlg.tokenPath'), input('f_u_tpath', a.tokenPath || 'token'), t('userDlg.tokenPathHint'))}${field(t('userDlg.expiresPath'), input('f_u_epath', a.expiresPath || '', 'placeholder="expires_in"'), t('userDlg.expiresPathHint'))}</div>`;
      } else if (a.type === 'oauth') {
        fields = `<div class="form-row"><label>${esc(t('userDlg.issuer'))}</label><div class="hc-inline">${input('f_u_issuer', a.issuer, 'placeholder="https://keycloak.local/realms/dev"')}
            <button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].readIssuer()">${esc(t('userDlg.readIssuer'))}</button></div>
            <p class="hc-muted">${esc(t('userDlg.issuerHint'))}</p></div>`
          + `<div class="hc-grid2">${field(t('userDlg.authEndpoint'), input('f_u_authep', a.authorizationEndpoint))}${field(t('userDlg.tokenEndpoint'), input('f_u_tokenep', a.tokenEndpoint))}</div>`
          + `<div class="hc-grid2">${field(t('userDlg.clientId'), input('f_u_client', a.clientId))}${field(t('userDlg.scope'), input('f_u_scope', a.scope ?? 'openid'))}</div>`
          + field(t('userDlg.flow'), `<select class="form-input" id="f_u_flow" onchange="Ext['http-client'].userTypeChanged()">${['pkce', 'code', 'implicit'].map(f => `<option value="${f}" ${f === (a.flow || 'pkce') ? 'selected' : ''}>${esc(t(`userDlg.flows.${f}`))}</option>`).join('')}</select>`)
          + ((a.flow || 'pkce') !== 'implicit' ? field(t('userDlg.clientSecret'), secretInput('f_u_secret', a.hasClientSecret), t('userDlg.clientSecretHint')) : '')
          + `<div class="hc-grid2">${field(t('userDlg.redirectUri'), input('f_u_redirect', a.redirectUri || 'http://localhost:8765/callback'), t('userDlg.redirectHint'))}
             ${field(t('userDlg.container'), input('f_u_container', a.container, `placeholder="${esc(t('userDlg.containerPlaceholder'))}"`), t('userDlg.containerHint'))}</div>`;
      }
      const tokenTypes = !['none', 'basic'].includes(a.type);
      const header = tokenTypes || a.type === 'basic'
        ? `<div class="hc-grid2">${field(t('userDlg.header'), input('f_u_header', u.header || 'Authorization'))}
           ${tokenTypes ? field(t('userDlg.format'), input('f_u_format', u.format || 'Bearer {token}'), t('userDlg.formatHint')) : ''}</div>` : '';
      const steps = tokenTypes ? `<fieldset class="hc-fieldset"><legend>${esc(t('after.title'))}</legend>
          <p class="hc-muted">${esc(t('after.hint'))}</p>
          ${u.afterToken.map((st, i) => `<div class="hc-step" data-step="${i}">
            <div class="hc-inline"><span class="hc-step-n">${i + 1}</span>
              <select class="form-input hc-method" data-sf="method">${info.methods.map(m => `<option ${m === st.method ? 'selected' : ''}>${m}</option>`).join('')}</select>
              <input class="form-input" data-sf="url" value="${esc(st.url)}" placeholder="{{baseUrl}}/me" spellcheck="false">
              <button class="sb-item-act hc-visible" onclick="Ext['http-client'].removeStep(${i})" title="${esc(t('core.action.delete'))}"><i data-icon="x"></i></button></div>
            <div class="hc-grid2">
              <div class="form-row"><label>${esc(t('after.headers'))}</label><textarea class="form-input hc-code" data-sf="headers" rows="2" spellcheck="false" placeholder="X-Tenant: {{tenant}}">${esc(linesOf(st.headers))}</textarea></div>
              <div class="form-row"><label>${esc(t('after.extract'))}</label><textarea class="form-input hc-code" data-sf="extract" rows="2" spellcheck="false" placeholder="tenant = data.tenantId&#10;csrf = header:X-CSRF-Token">${esc(extractLines(st.extract))}</textarea></div>
            </div>
            <div class="form-row"><label>${esc(t('after.body'))}</label>
              <div class="hc-inline"><select class="form-input hc-method" data-sf="bodyType">${['none', 'json', 'text'].map(bt => `<option value="${bt}" ${bt === (st.bodyType || 'none') ? 'selected' : ''}>${esc(t(`body.${bt}`))}</option>`).join('')}</select>
              <textarea class="form-input hc-code" data-sf="body" rows="2" spellcheck="false">${esc(st.body || '')}</textarea></div></div>
          </div>`).join('')}
          ${u.afterToken.length < info.maxAfterSteps ? `<button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].addStep()"><i data-icon="plus"></i> ${esc(t('after.add'))}</button>` : ''}
          <p class="hc-muted">${esc(t('after.extractHint'))}</p>
        </fieldset>` : '';
      openModal(t(uid ? 'userDlg.editTitle' : 'userDlg.newTitle'), `<div class="hc-scroll">
        <div class="hc-grid2">${field(t('userDlg.name'), input('f_u_label', u.label, `placeholder="${esc(t('userDlg.namePlaceholder'))}"`))}
          ${field(t('userDlg.type'), `<select class="form-input" id="f_u_type" onchange="Ext['http-client'].userTypeChanged()">${AUTH_TYPES.map(x => `<option value="${x}" ${x === a.type ? 'selected' : ''}>${esc(t(`auth.${x}`))}</option>`).join('')}</select>`)}</div>
        ${fields}${header}${steps}</div>`,
        `<button class="btn btn-ghost" onclick="Ext['http-client'].users(${js(usersSection)})">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['http-client'].saveUser(${js(uid || '')})">${esc(t('core.action.save'))}</button>`);
      byId('modal').classList.add('modal-wide');
      userForm.uid = uid;
    }
    const userForm = { uid: '' };

    // Legge il modulo nella bozza (prima di ridisegnarlo o di salvarlo)
    function readUserForm() {
      const u = userDraft;
      const a = u.auth;
      if (byId('f_u_label')) u.label = val('f_u_label').trim();
      const get = (id, key) => { if (byId(id)) a[key] = val(id).trim(); };
      get('f_u_username', 'username'); get('f_u_url', 'url'); get('f_u_method', 'method'); get('f_u_ctype', 'contentType');
      get('f_u_tpath', 'tokenPath'); get('f_u_epath', 'expiresPath'); get('f_u_issuer', 'issuer'); get('f_u_authep', 'authorizationEndpoint');
      get('f_u_tokenep', 'tokenEndpoint'); get('f_u_client', 'clientId'); get('f_u_scope', 'scope'); get('f_u_flow', 'flow');
      get('f_u_redirect', 'redirectUri'); get('f_u_container', 'container');
      if (byId('f_u_body')) a.body = val('f_u_body');
      for (const [id, key] of [['f_u_password', 'password'], ['f_u_secret', 'clientSecret']]) {
        if (!byId(id)) continue;
        if (byId(`${id}_clear`)?.checked) a[key] = null;
        else if (val(id)) a[key] = val(id);
      }
      if (byId('f_u_header')) u.header = val('f_u_header').trim();
      if (byId('f_u_format')) u.format = val('f_u_format').trim();
      document.querySelectorAll('.hc-step').forEach(el => {
        const st = u.afterToken[Number(el.dataset.step)];
        const f = name => el.querySelector(`[data-sf="${name}"]`).value;
        Object.assign(st, { method: f('method'), url: f('url').trim(), bodyType: f('bodyType'), body: f('body'), headers: pairsOf(f('headers')), extract: extractOf(f('extract')) });
      });
    }

    async function saveUser(uid) {
      readUserForm();
      const u = userDraft;
      if (!u.label) { toast(t('userDlg.nameRequired'), 'error'); return; }
      const body = { label: u.label, header: u.header, format: u.format, auth: { ...u.auth }, afterToken: u.afterToken };
      for (const k of ['password', 'clientSecret']) if (body.auth[k] === undefined) delete body.auth[k];
      const base = `/sections/${encodeURIComponent(usersSection)}/users`;
      try {
        const saved = await withVault(() => (uid ? ctx.api.put(`${base}/${encodeURIComponent(uid)}`, body) : ctx.api.post(base, body)));
        const s = section(usersSection);
        s.userTypes = uid ? s.userTypes.map(x => (x.id === saved.id ? saved : x)) : [...s.userTypes, saved];
        toast(t('userDlg.saved', { name: saved.label }), 'success');
        if (active?.section === usersSection) renderEditor();
        usersDialog(usersSection);
      } catch (e) { toast(e.message, 'error'); }
    }

    async function deleteUser(uid) {
      const s = section(usersSection);
      const u = s.userTypes.find(x => x.id === uid);
      const used = s.requests.filter(r => r.userType === uid).length;
      if (!confirm(t('users.confirmDelete', { name: u.label, count: used }))) return;
      try {
        await ctx.api.del(`/sections/${encodeURIComponent(s.id)}/users/${encodeURIComponent(uid)}`);
        s.userTypes = s.userTypes.filter(x => x.id !== uid);
        s.requests.forEach(r => { if (r.userType === uid) delete r.userType; });
        if (draft && active.section === s.id && draft.userType === uid) delete draft.userType;
        if (active?.section === s.id) renderEditor();
        usersDialog(s.id);
      } catch (e) { toast(e.message, 'error'); }
    }

    async function login(uid) {
      const base = `/sections/${encodeURIComponent(usersSection)}/users/${encodeURIComponent(uid)}`;
      try {
        const st = await withVault(() => ctx.api.post(`${base}/login`, {}));
        if (st.pendingLogin) {
          if (st.browserError) toast(t('users.browserFailed', { error: st.browserError }), 'error');
          else toast(t('users.loginOpened'), 'info');
          waitLogin(usersSection, uid, st.pendingLogin);
        } else toast(t('users.loggedIn'), 'success');
        usersDialog(usersSection);
      } catch (e) { if (!e.handled) toast(e.message, 'error'); }
    }

    // Browser per i login OAuth (su questo computer): percorso dell'eseguibile, vuoto = predefinito
    async function browserDialog(sectionId) {
      let b;
      try { b = await ctx.api.get('/browser'); } catch (e) { return toast(e.message, 'error'); }
      openModal(t('browser.title'), `
        <p class="hc-muted">${esc(t(b.wsl ? 'browser.hintWsl' : 'browser.hint'))}</p>
        <div class="form-row"><label>${esc(t('browser.path'))}</label>
          <input class="form-input hc-code" id="f_hc_browser" value="${esc(b.path || '')}" spellcheck="false"
            placeholder="${esc(b.wsl ? '/mnt/c/Program Files/Mozilla Firefox/firefox.exe' : t('browser.default'))}"></div>
        ${b.wsl ? `<p class="hc-muted">${esc(b.firefox ? t('browser.wslFound', { path: b.firefox }) : t('browser.wslNotFound'))}</p>` : ''}`,
      `<button class="btn btn-ghost" onclick="Ext['http-client'].users(${js(sectionId)})">${esc(t('core.action.cancel'))}</button>
       <button class="btn btn-primary" onclick="Ext['http-client'].saveBrowser(${js(sectionId)})">${esc(t('core.action.save'))}</button>`);
      byId('f_hc_browser').focus();
    }
    async function saveBrowser(sectionId) {
      try {
        await ctx.api.put('/browser', { path: byId('f_hc_browser').value });
        toast(t('browser.saved'), 'success');
        usersDialog(sectionId);
      } catch (e) { toast(e.message, 'error'); }
    }

    // Login OAuth avviato dal dialog: si aggiorna lo stato quando il token arriva
    function waitLogin(sectionId, uid, authUrl) {
      const started = Date.now();
      const timer = setInterval(async () => {
        try {
          const st = (await ctx.api.get(`/sections/${encodeURIComponent(sectionId)}/auth`)).users.find(x => x.id === uid);
          if (st?.pendingLogin && Date.now() - started < 5 * 60000) return;
          clearInterval(timer);
          if (st?.hasToken) toast(t('users.loggedIn'), 'success');
          if (byId('modal')?.classList.contains('modal-wide') && usersSection === sectionId && byId('modalTitle')?.textContent === t('users.title', { section: section(sectionId)?.label })) usersDialog(sectionId);
        } catch { clearInterval(timer); }
      }, 1500);
      return authUrl;
    }

    function pasteToken(sectionId, uid) {
      usersSection = sectionId;
      const u = section(sectionId).userTypes.find(x => x.id === uid);
      openModal(t('token.title', { name: u.label }), `
        <div class="form-row"><label>${esc(t('token.token'))}</label><textarea class="form-input hc-code" id="f_hc_token" rows="4" spellcheck="false"></textarea>
          <p class="hc-muted">${esc(t('token.hint'))}</p></div>
        <div class="form-row"><label>${esc(t('token.expires'))}</label><input class="form-input" type="datetime-local" id="f_hc_expires">
          <p class="hc-muted">${esc(t('token.expiresHint'))}</p></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['http-client'].saveToken(${js(uid)})">${esc(t('core.action.save'))}</button>`);
      setTimeout(() => byId('f_hc_token')?.focus(), 0);
    }

    async function saveToken(uid) {
      const token = val('f_hc_token').trim();
      if (!token) { toast(t('token.required'), 'error'); return; }
      const expires = val('f_hc_expires');
      try {
        await ctx.api.post(`/sections/${encodeURIComponent(usersSection)}/users/${encodeURIComponent(uid)}/token`, {
          token, ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
        });
        toast(t('token.saved'), 'success');
        usersDialog(usersSection);
      } catch (e) { toast(e.message, 'error'); }
    }

    // ---- rotte Express del progetto ----

    let routesData = null;

    // filtro delle rotte: testo (percorso, file, metodo), metodo e "solo da importare";
    // resta impostato tornando dall'import di una rotta
    let routesFilter = { text: '', method: '', pending: false };
    // target: dove finiscono le richieste importate, { userType, folder } (dal menu di un'utenza
    // o di una cartella); senza, alla radice della sezione
    async function routesDialog(sectionId, target = {}) {
      const s = section(sectionId);
      try { routesData = await ctx.api.get(`/sections/${encodeURIComponent(sectionId)}/routes`); } catch (e) { toast(e.message, 'error'); return; }
      routesData.section = sectionId;
      routesData.target = { userType: target.userType || null, folder: target.folder || null };
      routesFilter = { text: '', method: '', pending: false };
      renderRoutes();
    }

    function renderRoutes() {
      const s = section(routesData.section);
      const d = routesData;
      // già importata: una richiesta con lo stesso metodo e percorso per la stessa utenza (la
      // stessa rotta può servire con utenze diverse)
      const sameUser = r => !d.target.userType || (r.userType || null) === d.target.userType;
      const existing = new Set(s.requests.filter(sameUser).map(r => `${r.method} ${r.url.replace(/^\{\{\s*baseUrl\s*\}\}/, '')}`));
      const where = routesWhere(s, d.target);
      openModal(t('routes.title', { section: s.label }), `<div class="hc-scroll">
        ${where ? `<p class="hc-routes-dest">${ctx.ui.icon('folder-input')} ${esc(t('routes.into', { where }))}</p>` : ''}
        <p class="hc-muted">${esc(d.entry ? t('routes.entry', { file: d.entry.file, from: d.entry.from, count: d.files }) : t('routes.noEntry', { count: d.files }))}</p>
        ${d.autoloaders.length ? `<p class="hc-warn">${esc(t('routes.autoloaders', { list: fmt.list(d.autoloaders) }))}</p>` : ''}
        ${d.routes.length ? `<div class="hc-routes-filter">
          <input class="form-input" id="f_hc_rfilter" type="search" value="${esc(routesFilter.text)}" placeholder="${esc(t('routes.filter'))}" aria-label="${esc(t('routes.filter'))}" oninput="Ext['http-client'].filterRoutes()" spellcheck="false" autocomplete="off">
          <select class="form-input hc-method" id="f_hc_rfmethod" onchange="Ext['http-client'].filterRoutes()" aria-label="${esc(t('routes.method'))}">
            <option value="">${esc(t('routes.allMethods'))}</option>
            ${[...new Set(d.routes.map(r => r.method))].sort().map(m => `<option ${m === routesFilter.method ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          </select>
          <label class="hc-check"><input type="checkbox" id="f_hc_rfpending" ${routesFilter.pending ? 'checked' : ''} onchange="Ext['http-client'].filterRoutes()"> ${esc(t('routes.onlyPending'))}</label>
          <span class="hc-muted" id="f_hc_rcount"></span>
        </div>
        <table class="data-table hc-routes"><thead><tr><th>${esc(t('routes.method'))}</th><th>${esc(t('routes.path'))}</th><th>${esc(t('routes.file'))}</th><th></th></tr></thead><tbody>
          ${d.routes.map((r, i) => `<tr data-route="${i}" data-imported="${existing.has(`${r.method} ${r.path}`) ? 1 : ''}" data-search="${esc(`${r.method} ${r.path} ${r.file}`.toLowerCase())}">
            <td>${methodBadge(r.method)}</td>
            <td><code>${esc(r.path)}</code>${r.complete ? '' : ` <span class="hc-warn">${esc(t('routes.incomplete'))}</span>`}</td>
            <td class="hc-muted">${esc(r.file)}:${esc(r.line)}</td>
            <td>${existing.has(`${r.method} ${r.path}`) ? `<span class="hc-muted">${esc(t('routes.imported'))}</span>`
              : `<button class="btn btn-ghost btn-sm" onclick="Ext['http-client'].importRoute(${i})">${esc(t('routes.import'))}</button>`}</td>
          </tr>`).join('')}</tbody></table>
        <p class="hc-muted" id="f_hc_rnomatch" hidden>${esc(t('routes.noMatch'))}</p>` : `<p class="hc-muted">${esc(t('routes.none'))}</p>`}
        <p class="hc-muted">${esc(t('routes.hint'))}</p></div>`,
        `<button class="btn btn-ghost" onclick="UI.closeModal()">${esc(t('core.action.close'))}</button>`);
      byId('modal').classList.add('modal-wide');
      if (d.routes.length) { filterRoutes(); setTimeout(() => byId('f_hc_rfilter')?.focus(), 0); }
    }

    // "Admin › Ordini › Rimborsi": dove finiscono le richieste importate
    function routesWhere(s, target) {
      const parts = [];
      if (target.userType) parts.push(s.userTypes.find(u => u.id === target.userType)?.label || '');
      const chain = [];
      for (let f = (s.folders || []).find(x => x.id === target.folder); f && chain.length <= 10; f = s.folders.find(x => x.id === f.parent)) chain.unshift(f.label);
      return [...parts, ...chain].filter(Boolean).join(' › ');
    }

    function filterRoutes() {
      if (!byId('f_hc_rfilter')) return;
      routesFilter = { text: val('f_hc_rfilter'), method: val('f_hc_rfmethod'), pending: byId('f_hc_rfpending').checked };
      const words = routesFilter.text.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const row of document.querySelectorAll('.hc-routes tr[data-route]')) {
        const r = routesData.routes[Number(row.dataset.route)];
        const ok = (!routesFilter.method || r.method === routesFilter.method)
          && (!routesFilter.pending || !row.dataset.imported)
          && words.every(w => row.dataset.search.includes(w));
        row.hidden = !ok;
        if (ok) shown++;
      }
      byId('f_hc_rcount').textContent = t('routes.shown', { shown: fmt.number(shown), total: fmt.number(routesData.routes.length) });
      byId('f_hc_rnomatch').hidden = shown > 0;
    }

    // Import di una rotta: percorso modificabile (le parti «…» vanno completate), poi la richiesta
    function importRoute(i) {
      const r = routesData.routes[i];
      routesData.importing = i;
      const method = r.method === 'ALL' ? 'GET' : r.method;
      openModal(t('routes.importTitle'), `
        <div class="form-row"><label>${esc(t('editor.label'))}</label><input class="form-input" id="f_hc_rlabel" value="${esc(`${r.method} ${r.path}`)}"></div>
        <div class="hc-inline"><select class="form-input hc-method" id="f_hc_rmethod">${info.methods.map(m => `<option ${m === method ? 'selected' : ''}>${m}</option>`).join('')}</select>
          <input class="form-input" id="f_hc_rpath" value="${esc(r.path)}" spellcheck="false"></div>
        <p class="hc-muted">${esc(r.complete ? t('routes.importHint') : t('routes.completeHint', { list: fmt.list(r.unresolved) }))}</p>`,
        `<button class="btn btn-ghost" onclick="Ext['http-client'].backToRoutes()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Ext['http-client'].confirmImport()">${esc(t('routes.import'))}</button>`);
      setTimeout(() => byId('f_hc_rpath')?.focus(), 0);
    }

    async function confirmImport() {
      const path = val('f_hc_rpath').trim();
      if (/[«»]/.test(path)) { toast(t('routes.stillIncomplete'), 'error'); return; }
      const r = routesData.routes[routesData.importing];
      const label = val('f_hc_rlabel').trim();
      closeModal();
      await createRequest(routesData.section, {
        // nome proposto non toccato: segue il percorso completato
        label: !label || label === `${r.method} ${r.path}` ? `${val('f_hc_rmethod')} ${path}` : label, method: val('f_hc_rmethod'),
        url: `{{baseUrl}}${path.startsWith('/') ? '' : '/'}${path}`,
        ...(['POST', 'PUT', 'PATCH'].includes(val('f_hc_rmethod')) ? { bodyType: 'json', body: '{\n  \n}' } : {}),
        ...(routesData.target?.userType ? { userType: routesData.target.userType } : {}),
        ...(routesData.target?.folder ? { folder: routesData.target.folder } : {}),
      });
    }

    // ---- eventi ----

    ctx.sidebar.addEventListener('click', e => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'reload') this.refresh();
      if (a === 'new-section') sectionDialog('');
    });

    ctx.root.addEventListener('click', e => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) { readEditor(); tab = tabBtn.dataset.tab; renderTabs(); return; }
      const respBtn = e.target.closest('[data-resp-tab]');
      if (respBtn) { respTab = respBtn.dataset.respTab; renderResponse(); return; }
      const el = e.target.closest('[data-action]');
      if (!el) return;
      const a = el.dataset.action;
      if (a === 'send') send();
      else if (a === 'save') saveRequest();
      else if (a === 'users') usersDialog(active.section);
      else if (a === 'forget-token') forgetActiveToken();
      else if (a === 'add-pair') { (draft[el.dataset.list] ||= []).push({ name: '', value: '' }); markDirty(); renderTabs(); ctx.root.querySelector(`[data-list="${el.dataset.list}"][data-index="${draft[el.dataset.list].length - 1}"][data-field="name"]`)?.focus(); }
      else if (a === 'remove-pair') { draft[el.dataset.list].splice(Number(el.dataset.index), 1); markDirty(); renderTabs(); }
      else if (a === 'format-json') {
        const ta = $(ctx.root, 'body');
        try {
          const next = formatJson(ta.value);
          ta.focus();
          ta.setSelectionRange(0, ta.value.length);
          typeText(ta, next); // annullabile con Ctrl+Z
          draft.body = ta.value; markDirty(); syncBody(ta);
        } catch (err) { toast(t('body.invalidJson', { error: err.message }), 'error'); }
      } else if (a === 'download-body') {
        downloadResponse();
      } else if (a === 'copy-body') {
        const node = response?.jsonNode;
        const text = node && el.dataset.format ? ctx.ui.json.text(node, el.dataset.format === 'pretty' ? INDENT : '') : response?.body || '';
        navigator.clipboard?.writeText(text).then(() => toast(t(el.dataset.format === 'min' ? 'response.copiedMin' : el.dataset.format ? 'response.copiedPretty' : 'response.copied'), 'success'), () => toast(t('response.copyFailed'), 'error'));
      }
    });

    // Albero JSON della risposta: ▾, Alt+clic, Espandi/Comprimi (core)
    ctx.ui.json.bind(ctx.root);

    ctx.root.addEventListener('input', e => {
      const el = e.target;
      if (!draft) return;
      if (el.dataset.list) {
        const item = draft[el.dataset.list][Number(el.dataset.index)];
        if (el.dataset.field === 'enabled') { if (el.checked) delete item.enabled; else item.enabled = false; } else item[el.dataset.field] = el.value;
        markDirty();
        if (el.dataset.field === 'type') { renderTabs(); return; } // testo ↔ file: cambia il segnaposto
        if (el.dataset.field !== 'value') renderTabsCounts();
        return;
      }
      if (el.name === 'hc_body_type') { readEditor(); draft.bodyType = el.value; markDirty(); renderTabs(); return; }
      if (['label', 'url', 'body', 'file'].includes(el.dataset.role)) markDirty();
      if (el.dataset.role === 'body') syncBody(el);
    });
    // scroll della textarea → testo colorato (l'evento scroll non risale: in cattura)
    ctx.root.addEventListener('scroll', e => { if (e.target.dataset?.role === 'body') syncBodyScroll(e.target); }, true);

    ctx.root.addEventListener('change', e => {
      const role = e.target.dataset.role;
      if (!draft) return;
      if (role === 'method') { draft.method = e.target.value; e.target.style.color = methodColor(draft.method); markDirty(); }
      if (role === 'npm-output') {
        const script = e.target.value;
        storeNpmChoice(active.section, script);
        const proc = npmProcs.find(p => p.script === script);
        if (proc) followNpm(proc); else unfollowNpm();
        return;
      }
      if (role === 'user') { draft.userType = e.target.value || null; if (!draft.userType) delete draft.userType; markDirty(); refreshTokenButton(); renderCrumbs(); }
    });

    // la lista dei processi si aggiorna quando si apre il menu (uno script avviato dopo)
    ctx.root.addEventListener('focusin', e => { if (e.target.dataset.role === 'npm-output') refreshNpmOutput(); });

    ctx.root.addEventListener('keydown', e => {
      if (e.target.dataset.role === 'body' && editorKey(e.target, e)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveRequest(); }
      else if (e.key === 'Enter' && e.target.dataset.role === 'url') { e.preventDefault(); send(); }
    });

    function renderTabsCounts() {
      $(ctx.root, 'tab-query').querySelector('.hc-tab-count')?.remove();
      $(ctx.root, 'tab-headers').querySelector('.hc-tab-count')?.remove();
      for (const k of ['query', 'headers']) {
        const n = count(draft[k]);
        if (n) $(ctx.root, `tab-${k}`).insertAdjacentHTML('beforeend', ` <span class="hc-tab-count">${esc(fmt.number(n))}</span>`);
      }
    }

    ctx.expose({
      browserDialog, saveBrowser,
      toggle(id) {
        const closed = collapsed();
        if (closed.has(id)) closed.delete(id); else closed.add(id);
        storeCollapsed(closed);
        renderSidebar();
      },
      open(sectionId, requestId) { if (active?.request === requestId && active?.section === sectionId) return; if (canLeave()) openRequest(sectionId, requestId); },
      newRequest(sectionId, uid, folder) {
        if (!canLeave()) return;
        const data = { ...(uid ? { userType: uid } : {}), ...(folder ? { folder } : {}) };
        if (folder) { const closed = collapsed(); closed.delete(`${sectionId}|f|${folder}`); storeCollapsed(closed); }
        createRequest(sectionId, data);
      },
      newFolder(sectionId, uid, parent) { folderDialog(sectionId, { userType: uid, parent }); },
      saveFolder,
      confirmMove(sectionId, requestId, folderId) {
        const dest = val('f_hc_dest');
        closeModal();
        moveTo(sectionId, requestId ? { request: requestId } : { folder: folderId }, dest);
      },
      userMenu(event, sectionId, uid) {
        menuAt(event, [
          { label: t('sidebar.newRequest'), icon: 'plus', action: () => { if (canLeave()) createRequest(sectionId, uid ? { userType: uid } : {}); } },
          { label: t('folder.new'), icon: 'folder-plus', action: () => folderDialog(sectionId, { userType: uid }) },
          { label: t('sidebar.discover'), icon: 'scan-search', disabled: !section(sectionId).projectId, action: () => routesDialog(sectionId, { userType: uid }) },
        ]);
      },
      folderMenu(event, sectionId, folderId) {
        const f = section(sectionId).folders.find(x => x.id === folderId);
        if (!f) return;
        menuAt(event, [
          { label: t('sidebar.newRequest'), icon: 'plus', action: () => Ext['http-client'].newRequest(sectionId, f.userType || '', f.id) },
          { label: t('folder.newSub'), icon: 'folder-plus', action: () => folderDialog(sectionId, { userType: f.userType || '', parent: f.id }) },
          { label: t('sidebar.discover'), icon: 'scan-search', disabled: !section(sectionId).projectId, action: () => routesDialog(sectionId, { userType: f.userType || '', folder: f.id }) },
          { label: t('folder.rename'), icon: 'pencil', action: () => folderDialog(sectionId, { folderId: f.id }) },
          { label: t('folder.moveTo'), icon: 'folder-input', action: () => moveDialog(sectionId, { folder: f.id }) },
          'separator',
          { label: t('folder.delete'), icon: 'trash-2', danger: true, action: () => deleteFolder(sectionId, f.id) },
        ]);
      },
      sectionMenu(event, id) {
        const s = section(id);
        menuAt(event, [
          { label: t('sidebar.newRequest'), icon: 'plus', action: () => { if (canLeave()) createRequest(id); } },
          ...(s.userTypes.length ? [] : [{ label: t('folder.new'), icon: 'folder-plus', action: () => folderDialog(id) }]),
          { label: t('sidebar.discover'), icon: 'scan-search', disabled: !s.projectId, action: () => routesDialog(id) },
          { label: t('editor.users'), icon: 'user', action: () => usersDialog(id) },
          { label: t('sidebar.editSection'), icon: 'pencil', action: () => sectionDialog(id) },
          'separator',
          { label: t('sidebar.deleteSection'), icon: 'trash-2', danger: true, action: () => deleteSection(id) },
        ]);
      },
      requestMenu(event, sectionId, requestId) {
        const r = section(sectionId).requests.find(x => x.id === requestId);
        menuAt(event, [
          { label: t('sidebar.openRequest'), icon: 'arrow-up-right', action: () => { if (canLeave()) openRequest(sectionId, requestId); } },
          { label: t('sidebar.duplicate'), icon: 'copy', action: () => { if (canLeave()) createRequest(sectionId, { ...r, id: undefined, label: t('sidebar.copyOf', { name: r.label }) }); } },
          ...(section(sectionId).userTypes.length ? ['separator',
            ...section(sectionId).userTypes.filter(u => u.id !== r.userType).map(u => ({ label: t('sidebar.moveTo', { user: u.label }), icon: 'user', action: () => moveToUser(sectionId, requestId, u.id) })),
            ...(r.userType ? [{ label: t('sidebar.moveTo', { user: t('sidebar.noUser') }), icon: 'user-x', action: () => moveToUser(sectionId, requestId, null) }] : [])] : []),
          { label: t('folder.moveTo'), icon: 'folder-input', action: () => moveDialog(sectionId, { request: requestId }) },
          'separator',
          { label: t('core.action.delete'), icon: 'trash-2', danger: true, action: async () => {
            if (!confirm(t('sidebar.confirmDeleteRequest', { name: r.label }))) return;
            try {
              await ctx.api.del(`/sections/${encodeURIComponent(sectionId)}/requests/${encodeURIComponent(requestId)}`);
              section(sectionId).requests = section(sectionId).requests.filter(x => x.id !== requestId);
              if (active?.request === requestId) { active = null; draft = null; dirty = false; }
              renderSidebar(); renderEditor();
            } catch (e) { toast(e.message, 'error'); }
          } },
        ]);
      },
      editSection: sectionDialog,
      proposeBase,
      addVariable() { byId('f_hc_vars').insertAdjacentHTML('beforeend', variablesRows([{ name: '', value: '' }])); byId('f_hc_vars').lastElementChild.querySelector('input').focus(); },
      saveSection,
      users: usersDialog,
      editUser,
      userTypeChanged() {
        readUserForm();
        const type = val('f_u_type');
        if (type !== userDraft.auth.type) userDraft.auth = { type };
        if (byId('f_u_flow')) userDraft.auth.flow = val('f_u_flow');
        renderUserForm(userForm.uid);
      },
      async readIssuer() {
        readUserForm();
        try {
          const r = await ctx.api.post('/oidc-discovery', { issuer: userDraft.auth.issuer });
          Object.assign(userDraft.auth, { authorizationEndpoint: r.authorizationEndpoint || '', tokenEndpoint: r.tokenEndpoint || '' });
          renderUserForm(userForm.uid);
          toast(t('userDlg.issuerRead'), 'success');
        } catch (e) { toast(e.message, 'error'); }
      },
      addStep() { readUserForm(); userDraft.afterToken.push({ method: 'GET', url: '{{baseUrl}}/', headers: [], bodyType: 'none', body: '', extract: [] }); renderUserForm(userForm.uid); },
      removeStep(i) { readUserForm(); userDraft.afterToken.splice(i, 1); renderUserForm(userForm.uid); },
      saveUser,
      deleteUser,
      login,
      pasteToken,
      saveToken,
      async forgetToken(uid) {
        try { await ctx.api.del(`/sections/${encodeURIComponent(usersSection)}/users/${encodeURIComponent(uid)}/token`); usersDialog(usersSection); } catch (e) { toast(e.message, 'error'); }
      },
      routes: routesDialog,
      backToRoutes: renderRoutes,
      filterRoutes,
      importRoute,
      confirmImport,
    });

    // ---- trascinare richieste e cartelle su una cartella o su un'utenza (stessa sezione) ----
    let dragging = null; // { section, kind: 'r' | 'f', id }
    const dropTarget = e => {
      const el = e.target.closest?.('[data-drop]');
      if (!el || !dragging || el.dataset.section !== dragging.section) return null;
      if (dragging.kind === 'f' && el.dataset.drop.startsWith('f:')) {
        // non dentro se stessa o una sua sottocartella
        const s = section(dragging.section);
        for (let p = el.dataset.drop.slice(2); p; p = s.folders.find(x => x.id === p)?.parent) if (p === dragging.id) return null;
      }
      return el;
    };
    ctx.sidebar.addEventListener('dragstart', e => {
      const el = e.target.closest?.('[data-drag]');
      if (!el) return;
      const [kind, id] = el.dataset.drag.split(':');
      dragging = { section: el.dataset.section, kind, id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.textContent.trim());
    });
    ctx.sidebar.addEventListener('dragend', () => { dragging = null; ctx.sidebar.querySelectorAll('.hc-drop').forEach(x => x.classList.remove('hc-drop')); });
    ctx.sidebar.addEventListener('dragover', e => {
      const el = dropTarget(e);
      ctx.sidebar.querySelectorAll('.hc-drop').forEach(x => { if (x !== el) x.classList.remove('hc-drop'); });
      if (!el) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('hc-drop');
    });
    ctx.sidebar.addEventListener('drop', e => {
      const el = dropTarget(e);
      if (!el) return;
      e.preventDefault();
      const s = section(dragging.section);
      const [kind, id] = el.dataset.drop.split(':');
      const dest = kind === 'u' ? `${id}|` : `${s.folders.find(x => x.id === id)?.userType || ''}|${id}`;
      const what = dragging.kind === 'r' ? { request: dragging.id } : { folder: dragging.id };
      dragging = null;
      el.classList.remove('hc-drop');
      moveTo(s.id, what, dest);
    });

    ctx.bus.on('core:projects-changed', load);
    window.addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });
    // ---- add-on (docs: ADDONS.md): pulsanti sulla risposta (punto response-actions) ----
    const responseActions = [];
    const safeAddon = (fn, fallback) => { try { return fn(); } catch (e) { console.error('[http-client add-on]', e); toast(t('addons.failed', { error: e.message }), 'error'); return fallback; } };
    // quello che un add-on sa della risposta mostrata e della richiesta che l'ha prodotta
    function responseTarget(r) {
      const s = activeSection();
      return {
        status: r.status, statusText: r.statusText, url: r.url, ms: r.ms, size: r.size,
        headers: r.headers.map(([name, value]) => ({ name, value })),
        contentType: r.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '',
        body: r.binary ? null : r.body || '',
        isJson: !!r.jsonNode,
        truncated: !!r.truncated,
        request: draft ? { label: draft.label, method: draft.method, userType: draft.userType || null } : null,
        section: s ? { id: s.id, label: s.label } : null,
        user: r.user ? s?.userTypes.find(u => u.id === r.user)?.label || null : null,
      };
    }
    function responseButtons(r) {
      if (!responseActions.length || r.binary) return '';
      const target = responseTarget(r);
      return responseActions.map((a, i) => {
        if (a.when && !safeAddon(() => a.when(target), false)) return '';
        const label = typeof a.label === 'function' ? safeAddon(() => a.label(target), '') : a.label;
        const title = typeof a.title === 'function' ? safeAddon(() => a.title(target), '') : a.title;
        return `<button class="btn btn-ghost btn-sm hc-addon-btn" data-addon-action="${i}" title="${esc(title || label || '')}">${ctx.ui.icon(a.icon || 'puzzle')}${label ? ` ${esc(label)}` : ''}</button>`;
      }).join('');
    }
    ctx.root.addEventListener('click', e => {
      const i = e.target.closest('[data-addon-action]')?.dataset.addonAction;
      if (i === undefined || !response || response.error) return;
      const a = responseActions[Number(i)];
      const target = responseTarget(response);
      if (a) safeAddon(() => Promise.resolve(a.run(target)).catch(err => { console.error('[http-client add-on]', err); toast(t('addons.failed', { error: err.message }), 'error'); }));
    });
    await ctx.addons?.activate({
      version: ctx.meta.version,
      // action: { icon?, label (testo o target → testo), title?, run(target), when?(target) }
      addResponseAction(action) {
        if (typeof action?.run !== 'function') throw new Error('http-client: addResponseAction needs run(target)');
        responseActions.push(action);
        if (response) renderResponse();
      },
    });

    await load();

    this.refresh = load;
    // aperta da un widget o dalla dashboard: { section, request } apre la richiesta
    this.focus = async params => {
      if (!params?.section || !params.request) return;
      if (!section(params.section)) await load();
      if (section(params.section)?.requests.some(r => r.id === params.request) && canLeave()) openRequest(params.section, params.request);
    };
    this.languageChanged = () => { renderSidebar(); renderEditor(); };
  },
};
