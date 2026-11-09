// Disposizione della shell scelta dall'utente: sezione "layout" di config.json, del core.
// layout.tabs: codici delle estensioni nell'ordine delle tab; quelle non in lista (nuove)
// vanno dopo, nell'ordine dei manifest; i codici di estensioni rimosse sono ignorati.
// layout.positions: { codice: 'tab' | 'header' } quando l'utente sposta un'estensione rispetto
// alla posizione del suo manifest.
// layout.theme: { id, system, light, dark } — tema scelto ("<codice>/<id>" di un tema di
// un'estensione, "" = quello del core); con system il tema segue il chiaro/scuro del sistema
// operativo (light e dark: l'ultimo tema scelto per ciascuno dei due).
const { registerSection, loadConfig, saveConfig } = require('./config');
const { coreError } = require('./errors');

const CODE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TABS = 100;
const POSITIONS = ['tab', 'header'];
const THEME_KEY_RE = /^([a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,39})?$/;
const THEME_EMPTY = { id: '', system: false, light: '', dark: '' };

function validTheme(t) {
  return t && typeof t === 'object' && !Array.isArray(t) && typeof (t.system ?? false) === 'boolean'
    && ['id', 'light', 'dark'].every(k => t[k] === undefined || (typeof t[k] === 'string' && THEME_KEY_RE.test(t[k])));
}
const normTheme = t => ({ id: t.id || '', system: t.system === true, light: t.light || '', dark: t.dark || '' });

function validateLayout(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw coreError.config('layout_invalid');
  if (v.tabs !== undefined) {
    if (!Array.isArray(v.tabs) || v.tabs.length > MAX_TABS || !v.tabs.every(c => typeof c === 'string' && CODE_RE.test(c))
        || new Set(v.tabs).size !== v.tabs.length) throw coreError.config('layout_tabs');
  }
  if (v.positions !== undefined) {
    if (!v.positions || typeof v.positions !== 'object' || Array.isArray(v.positions)
        || Object.entries(v.positions).some(([k, p]) => !CODE_RE.test(k) || !POSITIONS.includes(p))) throw coreError.config('layout_positions');
  }
  if (v.theme !== undefined && !validTheme(v.theme)) throw coreError.config('layout_theme');
}

// solo i campi noti
const normalize = v => (v && typeof v === 'object' && !Array.isArray(v)
  ? { ...(Array.isArray(v.tabs) ? { tabs: v.tabs } : {}), ...(v.positions && typeof v.positions === 'object' ? { positions: v.positions } : {}),
      ...(v.theme && typeof v.theme === 'object' ? { theme: normTheme(v.theme) } : {}) }
  : v);

registerSection('layout', { owner: 'core', empty: {}, validate: validateLayout, normalize });

const get = () => { const l = loadConfig().layout; return { tabs: l.tabs || [], positions: l.positions || {}, theme: normTheme(l.theme || THEME_EMPTY) }; };

// Tema: { id, system } e, facoltativi, light/dark; "id" diventa anche l'ultimo tema scelto per il
// suo schema (scheme: quello del tema scelto, "dark" per il tema del core)
function setTheme(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!validTheme(b) || (b.scheme !== undefined && !['dark', 'light'].includes(b.scheme))) throw coreError(400, 'layout_theme');
  const cfg = loadConfig();
  const theme = normTheme({ ...THEME_EMPTY, ...(cfg.layout.theme || {}), ...b });
  if (b.id !== undefined) theme[b.scheme || 'dark'] = theme.id;
  cfg.layout = { ...cfg.layout, theme };
  saveConfig(cfg);
  return get();
}

// Posizione scelta per un'estensione; null o quella del manifest tolgono l'override.
// manifestPosition: posizione del manifest (null se l'estensione non ha interfaccia)
function setPosition(code, position, manifestPosition) {
  if (!manifestPosition) throw coreError(404, 'layout_no_ui', { code: String(code) });
  if (position !== null && !POSITIONS.includes(position)) throw coreError(400, 'layout_positions');
  const cfg = loadConfig();
  const positions = { ...(cfg.layout.positions || {}) };
  if (!position || position === manifestPosition) delete positions[code]; else positions[code] = position;
  const { positions: _, ...rest } = cfg.layout;
  cfg.layout = Object.keys(positions).length ? { ...rest, positions } : rest;
  saveConfig(cfg);
  return get();
}

// tabs: ordine scelto; known: codici delle tab esistenti (gli altri vengono scartati)
function setTabs(tabs, known) {
  if (!Array.isArray(tabs) || !tabs.every(c => typeof c === 'string')) throw coreError(400, 'layout_tabs');
  const list = [...new Set(tabs)].filter(c => known.includes(c));
  const cfg = loadConfig();
  cfg.layout = { ...cfg.layout, tabs: list };
  saveConfig(cfg);
  return get();
}

// Ordine predefinito: quello dei manifest
function resetTabs() {
  const cfg = loadConfig();
  const { tabs, ...rest } = cfg.layout;
  cfg.layout = rest;
  saveConfig(cfg);
  return get();
}

module.exports = { get, setTabs, resetTabs, setPosition, setTheme };
