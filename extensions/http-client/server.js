// Client HTTP: sezioni di richieste (sezione "httpSections"), ognuna con URL di base,
// variabili, tipologie di utenza e richieste salvate; invio dal backend, rotte Express
// trovate nel codice del progetto collegato, token per tipologia di utenza in memoria.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fill, buildUrl, execute, hasHeader, SendError, MAX_RESPONSE_BYTES, MAX_DOWNLOAD_BYTES } = require('./send');
const { typeOfFile } = require('./mime');
const { createAuth, AUTH_TYPES, OAUTH_FLOWS, MAX_AFTER_STEPS, browserInfo } = require('./auth');
const { discover } = require('./discover');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_TYPES = ['none', 'json', 'text', 'file', 'form'];
const STEP_BODY_TYPES = ['none', 'json', 'text']; // azioni dopo il token
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const LOGIN_CONTENT_TYPES = ['json', 'form', 'text'];
const VAR_NAME_RE = /^[A-Za-z_][\w.-]{0,63}$/;
const RESERVED_VARS = new Set(['baseUrl', 'username', 'password', 'token']);
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const HTTP_URL_RE = /^https?:\/\/[^\s]{1,500}$/i;
const REDIRECT_RE = /^http:\/\/(localhost|127\.0\.0\.1):(\d{1,5})(\/[^\s#?]*)$/;
const EXTRACT_FROM_RE = /^(header:[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}|(json:)?[\w$-]+(\.[\w$-]+)*)$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const LIMITS = { sections: 200, requests: 500, users: 30, pairs: 100, value: 8000, body: 100000, url: 4000 };

const newId = () => crypto.randomBytes(4).toString('hex');
const isStr = (v, max) => typeof v === 'string' && v.length <= max;

module.exports = function createHttpClient(ctx) {
  const { KEY_RE, isText } = ctx.lib.validate;
  const vault = ctx.vault; // vault della master password del core

  const sections = () => ctx.config.get('httpSections');
  const sectionOr404 = id => {
    const s = sections().find(x => x.id === id);
    if (!s) throw ctx.error(404, 'section_not_found', { id: String(id) });
    return s;
  };
  const userOr404 = (s, uid) => {
    const u = (s.userTypes || []).find(x => x.id === uid);
    if (!u) throw ctx.error(404, 'user_not_found', { id: String(uid) });
    return u;
  };
  const save = list => ctx.config.set('httpSections', list);
  const replaceSection = s => save(sections().map(x => (x.id === s.id ? s : x)));

  // Variabili della sezione: {{baseUrl}} e quelle definite dall'utente
  const varsOf = s => ({
    baseUrl: (s.baseUrl || '').replace(/\/+$/, ''),
    ...Object.fromEntries((s.variables || []).map(v => [v.name, v.value])),
  });

  // Testi della pagina mostrata nel browser al termine del login OAuth (lingua del browser)
  const catalogs = new Map();
  function pageText(acceptLanguage, key, params) {
    const tags = String(acceptLanguage || '').split(',').map(x => x.split(';')[0].trim()).filter(Boolean);
    for (const tag of [...tags, ...tags.map(x => x.split('-')[0]), 'it']) {
      if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) continue;
      if (!catalogs.has(tag)) {
        try { catalogs.set(tag, JSON.parse(fs.readFileSync(path.join(ctx.dir, 'i18n', `${tag}.json`), 'utf8'))); } catch { catalogs.set(tag, null); }
      }
      const text = catalogs.get(tag)?.[key];
      if (typeof text === 'string') return text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    }
    return key;
  }

  // Browser per i login OAuth: percorso scelto dall'utente su questo computer (sezione
  // "httpBrowser", non esportata: sul computer di destinazione il percorso sarebbe un altro)
  const browserPath = () => ctx.config.get('httpBrowser')?.path || null;
  const auth = createAuth({ ctx, vault, pageText, varsOf, browserPath });

  // ---- validazione ----

  function validatePairs(list, what, id) {
    if (list == null) return;
    if (!Array.isArray(list) || list.length > LIMITS.pairs) throw ctx.error.config(`${what}_invalid`, { id });
    for (const p of list) {
      if (!p || typeof p !== 'object' || !isStr(p.name, 200) || !isStr(p.value ?? '', LIMITS.value)
          || (p.enabled != null && typeof p.enabled !== 'boolean')) throw ctx.error.config(`${what}_invalid`, { id });
    }
  }

  function validateRequest(r, users) {
    const bad = field => ctx.error.config(`request_${field}`, { id: String(r?.id ?? '') });
    if (!r || typeof r !== 'object') throw ctx.error.config('request_invalid', { id: '' });
    if (!KEY_RE.test(r.id || '')) throw bad('id');
    if (!isText(r.label, 200)) throw bad('label');
    if (!METHODS.includes(r.method)) throw bad('method');
    if (!isStr(r.url, LIMITS.url)) throw bad('url');
    validatePairs(r.query, 'request_query', r.id);
    validatePairs(r.headers, 'request_headers', r.id);
    if (!BODY_TYPES.includes(r.bodyType ?? 'none')) throw bad('body_type');
    if (!isStr(r.body ?? '', LIMITS.body)) throw bad('body');
    if (r.file != null && !(isStr(r.file, 1000) && !CONTROL_RE.test(r.file))) throw bad('file');
    if (r.form != null && !(Array.isArray(r.form) && r.form.length <= LIMITS.pairs && r.form.every(f => f && isStr(f.name, 200)
      && isStr(f.value, LIMITS.value) && !CONTROL_RE.test(f.name) && ['text', 'file'].includes(f.type ?? 'text')))) throw bad('form');
    if (r.userType != null && !users.some(u => u.id === r.userType)) throw bad('user_type');
  }

  const isBox = v => vault.isBox(v);

  function validateUser(u) {
    const bad = field => ctx.error.config(`user_${field}`, { id: String(u?.id ?? '') });
    if (!u || typeof u !== 'object') throw ctx.error.config('user_invalid', { id: '' });
    if (!KEY_RE.test(u.id || '')) throw bad('id');
    if (!isText(u.label, 80)) throw bad('label');
    if (u.header != null && !HEADER_NAME_RE.test(u.header)) throw bad('header');
    if (u.format != null && !(isStr(u.format, 200) && u.format.includes('{token}') && !CONTROL_RE.test(u.format))) throw bad('format');
    const a = u.auth;
    if (!a || !AUTH_TYPES.includes(a.type)) throw bad('auth');
    const secretOk = v => v == null || isBox(v);
    if (a.type === 'basic') {
      if (!isStr(a.username ?? '', 200) || !secretOk(a.password)) throw bad('auth');
    } else if (a.type === 'login') {
      if (!['GET', 'POST', 'PUT', 'PATCH'].includes(a.method) || !isStr(a.url, LIMITS.url) || !a.url
          || !LOGIN_CONTENT_TYPES.includes(a.contentType) || !isStr(a.body ?? '', 20000)
          || !isStr(a.username ?? '', 200) || !secretOk(a.password)
          || !EXTRACT_FROM_RE.test(a.tokenPath || 'token') || (a.expiresPath && !EXTRACT_FROM_RE.test(a.expiresPath))) throw bad('login');
    } else if (a.type === 'oauth') {
      for (const k of ['issuer', 'authorizationEndpoint', 'tokenEndpoint']) if (a[k] && !HTTP_URL_RE.test(a[k])) throw bad('oauth_url');
      if (!a.issuer && !a.authorizationEndpoint) throw bad('oauth_url');
      if (!isText(a.clientId, 200) || CONTROL_RE.test(a.clientId)) throw bad('oauth_client');
      if (!OAUTH_FLOWS.includes(a.flow)) throw bad('oauth_flow');
      if (!isStr(a.scope ?? '', 500)) throw bad('oauth_scope');
      const m = REDIRECT_RE.exec(a.redirectUri || '');
      if (!m || !(Number(m[2]) >= 1 && Number(m[2]) <= 65535)) throw bad('oauth_redirect');
      if (!secretOk(a.clientSecret)) throw bad('oauth_client');
      if (a.container != null && a.container !== '' && !(isStr(a.container, 100) && !CONTROL_RE.test(a.container))) throw bad('oauth_container');
    }
    const steps = u.afterToken ?? [];
    if (!Array.isArray(steps) || steps.length > MAX_AFTER_STEPS) throw bad('after_token');
    for (const st of steps) {
      if (!st || !METHODS.includes(st.method) || !isStr(st.url, LIMITS.url) || !st.url
          || !STEP_BODY_TYPES.includes(st.bodyType ?? 'none') || !isStr(st.body ?? '', LIMITS.body)) throw bad('after_token');
      validatePairs(st.headers, 'user_after_token', u.id);
      if (!Array.isArray(st.extract ?? []) || (st.extract || []).length > 20
          || (st.extract || []).some(x => !x || !VAR_NAME_RE.test(x.name || '') || ['baseUrl', 'username', 'password'].includes(x.name) || !EXTRACT_FROM_RE.test(x.from || ''))) throw bad('after_token');
    }
  }

  const hasSecret = u => !!(u.auth?.password || u.auth?.clientSecret);

  function validateSection(s, cfg) {
    const bad = field => ctx.error.config(`section_${field}`, { id: String(s?.id ?? '') });
    if (!s || typeof s !== 'object') throw ctx.error.config('section_invalid', { id: '' });
    if (!KEY_RE.test(s.id || '')) throw bad('id');
    if (!isText(s.label, 100)) throw bad('label');
    if (s.projectId != null && !KEY_RE.test(s.projectId)) throw bad('project');
    if (!isStr(s.baseUrl ?? '', 500) || CONTROL_RE.test(s.baseUrl || '')) throw bad('base_url');
    const vars = s.variables ?? [];
    if (!Array.isArray(vars) || vars.length > LIMITS.pairs) throw bad('variables');
    const names = new Set();
    for (const v of vars) {
      if (!v || !VAR_NAME_RE.test(v.name || '') || RESERVED_VARS.has(v.name) || names.has(v.name) || !isStr(v.value ?? '', LIMITS.value)) {
        throw ctx.error.config('section_variable', { id: s.id, name: String(v?.name ?? '') });
      }
      names.add(v.name);
    }
    const users = s.userTypes ?? [];
    if (!Array.isArray(users) || users.length > LIMITS.users) throw bad('users');
    const userIds = new Set();
    for (const u of users) {
      validateUser(u);
      if (userIds.has(u.id)) throw ctx.error.config('user_duplicate', { id: u.id });
      userIds.add(u.id);
      if (hasSecret(u) && !cfg.vault) throw ctx.error.config('secret_without_vault', { id: u.id });
    }
    const requests = s.requests ?? [];
    if (!Array.isArray(requests) || requests.length > LIMITS.requests) throw bad('requests');
    const reqIds = new Set();
    for (const r of requests) {
      validateRequest(r, users);
      if (reqIds.has(r.id)) throw ctx.error.config('request_duplicate', { id: r.id });
      reqIds.add(r.id);
    }
  }

  const config = {
    httpSections: {
      empty: [], idField: 'id',
      validate(list, cfg) {
        if (!Array.isArray(list) || list.length > LIMITS.sections) throw ctx.error.config('not_a_list', { section: 'httpSections' });
        const seen = new Set();
        for (const s of list) {
          validateSection(s, cfg);
          if (seen.has(s.id)) throw ctx.error.config('section_duplicate', { id: s.id });
          seen.add(s.id);
        }
      },
    },
    httpBrowser: {
      empty: {}, local: true,
      normalize: v => (v && typeof v === 'object' && !Array.isArray(v) ? (v.path ? { path: v.path } : {}) : v),
      validate(v) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw ctx.error.config('browser_invalid');
        if (v.path !== undefined && !validBrowserPath(v.path)) throw ctx.error.config('browser_invalid');
      },
    },
  };

  // Eseguibile del browser: percorso assoluto (anche C:\… su Windows), nessun argomento
  function validBrowserPath(p) {
    return typeof p === 'string' && p.length <= 500 && !CONTROL_RE.test(p) && (path.isAbsolute(p) || /^[A-Za-z]:\\/.test(p));
  }

  // Cambio della master password: i segreti delle utenze vengono ri-cifrati (salvati insieme al
  // nuovo vault); reset: cancellati
  const mapSecrets = (list, fn) => list.map(s => ({
    ...s,
    userTypes: (s.userTypes || []).map(u => {
      const a = { ...u.auth };
      for (const k of ['password', 'clientSecret']) if (a[k]) a[k] = fn(a[k]);
      return { ...u, auth: a };
    }),
  }));
  vault.register({
    rekey(reencrypt, cfg) {
      let count = 0;
      const next = mapSecrets(cfg.httpSections || [], box => { count++; return reencrypt(box); });
      return { sections: { httpSections: next }, count };
    },
    reset: cfg => ({ httpSections: mapSecrets(cfg.httpSections || [], () => null) }),
    lock: () => auth.forgetAll(),
  });

  // Utenze, password e token solo con il vault sbloccato (423 del core: da sbloccare o da creare)
  const requireVault = () => { if (vault.state() !== 'unlocked') vault.encrypt(''); };

  // ---- dati per il frontend: mai i segreti, solo se ci sono ----

  const publicUser = u => {
    const { password, clientSecret, ...a } = u.auth || {};
    return { ...u, auth: { ...a, ...(password !== undefined ? { hasPassword: !!password } : {}), ...(clientSecret !== undefined ? { hasClientSecret: !!clientSecret } : {}) } };
  };
  const publicSection = s => ({ ...s, variables: s.variables || [], requests: s.requests || [], userTypes: (s.userTypes || []).map(publicUser) });

  // ---- dati dal form ----

  const pairs = list => (Array.isArray(list) ? list : []).filter(p => p && (p.name || p.value)).map(p => ({
    name: String(p.name ?? ''), value: String(p.value ?? ''), ...(p.enabled === false ? { enabled: false } : {}),
  }));

  function buildSection(body, existing = {}) {
    const s = { ...existing };
    if (body.label !== undefined) s.label = String(body.label).trim();
    if (body.projectId !== undefined) s.projectId = body.projectId || null;
    if (s.projectId && !ctx.projects.get(s.projectId)) throw ctx.error(400, 'project_unknown', { id: String(s.projectId) });
    if (body.baseUrl !== undefined) s.baseUrl = String(body.baseUrl).trim();
    if (body.variables !== undefined) s.variables = pairs(body.variables).map(({ name, value }) => ({ name: name.trim(), value }));
    if (!s.projectId) delete s.projectId;
    return s;
  }

  function buildRequest(body, existing = {}) {
    const r = {
      ...existing,
      label: String(body.label ?? existing.label ?? '').trim(),
      method: String(body.method ?? existing.method ?? 'GET').toUpperCase(),
      url: String(body.url ?? existing.url ?? ''),
      query: body.query !== undefined ? pairs(body.query) : existing.query || [],
      headers: body.headers !== undefined ? pairs(body.headers) : existing.headers || [],
      bodyType: body.bodyType ?? existing.bodyType ?? 'none',
      body: String(body.body ?? existing.body ?? ''),
      userType: body.userType !== undefined ? body.userType || null : existing.userType ?? null,
      // corpo "file": percorso del file; "form": campi multipart di testo o file (percorsi)
      file: String(body.file ?? existing.file ?? '').trim(),
      form: (Array.isArray(body.form) ? body.form : existing.form || []).filter(f => f && (f.name || f.value)).map(f => ({
        name: String(f.name ?? ''), value: String(f.value ?? ''), ...(f.type === 'file' ? { type: 'file' } : {}), ...(f.enabled === false ? { enabled: false } : {}),
      })),
    };
    if (!r.userType) delete r.userType;
    if (!r.file) delete r.file;
    if (!r.form.length) delete r.form;
    return r;
  }

  // password / clientSecret: stringa = nuovo valore (cifrato subito), null = rimosso, assente = invariato
  function secretField(input, current) {
    if (input === null) return null;
    if (typeof input === 'string' && input !== '') {
      return vault.encrypt(input);
    }
    return current ?? null;
  }

  function buildUser(body, existing = {}) {
    const a = body.auth || {};
    const type = a.type;
    const prev = existing.auth?.type === type ? existing.auth : {};
    let next;
    if (type === 'basic') next = { type, username: String(a.username ?? ''), password: secretField(a.password, prev.password) };
    else if (type === 'login') {
      next = {
        type, method: String(a.method || 'POST').toUpperCase(), url: String(a.url ?? ''), contentType: a.contentType || 'json',
        body: String(a.body ?? ''), username: String(a.username ?? ''), password: secretField(a.password, prev.password),
        tokenPath: String(a.tokenPath || 'token').trim(),
        ...(a.expiresPath ? { expiresPath: String(a.expiresPath).trim() } : {}),
      };
    } else if (type === 'oauth') {
      next = {
        type, flow: a.flow || 'pkce', clientId: String(a.clientId ?? '').trim(), scope: String(a.scope ?? '').trim(),
        redirectUri: String(a.redirectUri ?? '').trim(),
        ...Object.fromEntries(['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'container']
          .map(k => [k, String(a[k] ?? '').trim()]).filter(([, v]) => v)),
      };
      next.clientSecret = next.flow !== 'implicit' ? secretField(a.clientSecret, prev.clientSecret) : null;
    } else next = { type };
    for (const k of ['password', 'clientSecret']) if (next[k] === null) delete next[k];
    const u = { id: existing.id, label: String(body.label ?? existing.label ?? '').trim(), auth: next };
    const header = String(body.header ?? existing.header ?? '').trim();
    const format = String(body.format ?? existing.format ?? '').trim();
    if (header && header !== 'Authorization') u.header = header;
    if (format && format !== 'Bearer {token}') u.format = format;
    const steps = body.afterToken !== undefined ? body.afterToken : existing.afterToken;
    if (Array.isArray(steps) && steps.length && type !== 'none' && type !== 'basic') {
      u.afterToken = steps.map(st => ({
        method: String(st?.method || 'GET').toUpperCase(), url: String(st?.url ?? ''),
        headers: pairs(st?.headers), bodyType: st?.bodyType || 'none', body: String(st?.body ?? ''),
        extract: (Array.isArray(st?.extract) ? st.extract : []).filter(x => x && (x.name || x.from))
          .map(x => ({ name: String(x.name ?? '').trim(), from: String(x.from ?? '').trim() })),
      }));
    }
    return u;
  }

  const sendError = e => (e instanceof SendError ? ctx.error(e.status, e.key, e.params) : e);

  // File da inviare: percorso assoluto, o relativo alla cartella del progetto collegato
  function readUpload(section, p) {
    const raw = String(p || '').trim();
    if (!raw) throw new SendError('upload_missing', { path: '' }, 400);
    let full = raw;
    if (!path.isAbsolute(raw)) {
      const project = section.projectId ? ctx.projects.get(section.projectId) : null;
      if (!project) throw new SendError('upload_relative', { path: raw }, 400);
      full = path.resolve(project.path, raw);
    }
    let st = null;
    try { st = fs.statSync(full); } catch { /* inesistente */ }
    if (!st?.isFile()) throw new SendError('upload_missing', { path: full }, 400);
    if (st.size > MAX_UPLOAD_BYTES) throw new SendError('upload_too_large', { path: full, max: Math.round(MAX_UPLOAD_BYTES / 1048576) }, 413);
    return { name: path.basename(full), data: fs.readFileSync(full) };
  }

  // ---- invio ----

  async function sendRequest(section, r, { timeoutMs }) {
    const user = r.userType ? userOr404(section, r.userType) : null;
    const { headers: authHeaders, vars: userVars } = user ? await auth.headersFor(section, user) : { headers: {}, vars: {} };
    const vars = { ...varsOf(section), ...userVars };
    try {
      const url = buildUrl(r.url, r.query, vars);
      const headers = {};
      for (const h of r.headers || []) {
        if (h.enabled === false || !h.name) continue;
        const name = fill(h.name, vars).trim();
        if (!HEADER_NAME_RE.test(name)) throw new SendError('header_invalid', { name });
        const value = fill(h.value, vars);
        if (CONTROL_RE.test(value.replace(/\t/g, ''))) throw new SendError('header_invalid', { name });
        headers[name] = value;
      }
      for (const [k, v] of Object.entries(authHeaders)) if (!hasHeader(headers, k)) headers[k] = v; // un header scritto a mano vince
      let body = null;
      if (r.bodyType === 'json' || r.bodyType === 'text') {
        body = fill(r.body, vars);
        if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = r.bodyType === 'json' ? 'application/json' : 'text/plain; charset=utf-8';
      } else if (r.bodyType === 'file') {
        const file = readUpload(section, fill(r.file || '', vars));
        body = file.data;
        if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = typeOfFile(file.name);
      } else if (r.bodyType === 'form') {
        const boundary = `----KelboForm${crypto.randomBytes(12).toString('hex')}`;
        const q = v => String(v).replace(/"/g, '%22').replace(/[\r\n]/g, ' ');
        const parts = [];
        for (const f of r.form || []) {
          if (f.enabled === false || !f.name) continue;
          const name = fill(f.name, vars);
          if (f.type === 'file') {
            const file = readUpload(section, fill(f.value, vars));
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${q(name)}"; filename="${q(file.name)}"\r\nContent-Type: ${typeOfFile(file.name)}\r\n\r\n`), file.data, Buffer.from('\r\n'));
          } else {
            parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${q(name)}"\r\n\r\n${fill(f.value, vars)}\r\n`));
          }
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        body = Buffer.concat(parts);
        // il boundary deve essere quello del corpo: un Content-Type scritto a mano viene sostituito
        for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-type') delete headers[k];
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      }
      const res = await execute({ method: r.method, url, headers, body }, { timeoutMs, maxBinaryBytes: MAX_DOWNLOAD_BYTES });
      return { url: url.toString(), user: user ? user.id : null, ...res };
    } catch (e) { throw sendError(e); }
  }

  return {
    config,

    // Per le altre estensioni (es. toolbox): i token ottenuti dalle utenze, solo in memoria.
    // tokens() li elenca senza il valore; token() dà il valore, solo con il vault sbloccato
    services: {
      tokens: () => sections().flatMap(s => (s.userTypes || []).filter(u => !['none', 'basic'].includes(u.auth?.type)).map(u => {
        const st = auth.state(s, u);
        return { section: s.id, sectionLabel: s.label, user: u.id, userLabel: u.label, authType: u.auth.type, hasToken: st.hasToken, expired: st.expired, expiresAt: st.expiresAt, obtainedAt: st.obtainedAt };
      })),
      token(sectionId, userId) {
        requireVault();
        const s = sections().find(x => x.id === sectionId);
        const u = s?.userTypes?.find(x => x.id === userId);
        const entry = s && u ? auth.peek(s, u) : null;
        if (!entry) return null;
        return { token: entry.token, expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null, source: entry.source, section: s.label, user: u.label };
      },
    },

    // Dati collegati a un progetto (pannello 📁 del core, prima di rimuoverlo)
    projectLinks: project => sections().filter(s => s.projectId === project.id)
      .map(s => ({ key: 'links.section', params: { name: s.label } })),

    handlers: {
      browser(req, res) { res.json(browserInfo(browserPath())); },

      // { path } (vuoto: browser predefinito); il file deve esistere su questo computer
      setBrowser(req, res) {
        const p = typeof req.body?.path === 'string' ? req.body.path.trim() : '';
        if (p) {
          if (!validBrowserPath(p)) throw ctx.error(400, 'browser_invalid');
          let st = null;
          try { st = fs.statSync(p); } catch { /* inesistente */ }
          if (!st?.isFile()) throw ctx.error(400, 'browser_not_found', { path: p });
        }
        ctx.config.set('httpBrowser', p ? { path: p } : {});
        res.json(browserInfo(browserPath()));
      },

      info(req, res) {
        res.json({ vault: vault.state(), methods: METHODS, maxResponseBytes: MAX_RESPONSE_BYTES, maxAfterSteps: MAX_AFTER_STEPS });
      },

      listSections(req, res) { res.json(sections().map(publicSection)); },

      createSection(req, res) {
        const s = buildSection(req.body || {}, { id: newId(), variables: [], userTypes: [], requests: [], baseUrl: '' });
        save([...sections(), s]);
        res.json(publicSection(s));
      },

      updateSection(req, res) {
        const s = buildSection(req.body || {}, sectionOr404(req.params.id));
        replaceSection(s);
        res.json(publicSection(s));
      },

      deleteSection(req, res) {
        const s = sectionOr404(req.params.id);
        save(sections().filter(x => x.id !== s.id));
        auth.forgetSection(s.id);
        res.json({ ok: true });
      },

      // URL di base proposto dalla PORT nel .env del progetto
      suggestBaseUrl(req, res) {
        const p = req.query.project ? ctx.projects.get(String(req.query.project)) : null;
        if (!p) throw ctx.error(404, 'project_unknown', { id: String(req.query.project ?? '') });
        let port = null, source = null;
        for (const name of ['.env', '.env.local', '.env.development', '.env.example']) {
          let text;
          try { text = fs.readFileSync(path.join(p.path, name), 'utf8'); } catch { continue; }
          const m = text.match(/^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{1,5})["']?\s*(?:#.*)?$/m);
          if (m && Number(m[1]) >= 1 && Number(m[1]) <= 65535) { port = Number(m[1]); source = name; break; }
        }
        res.json({ port, source, baseUrl: `http://localhost:${port || 3000}` });
      },

      // ---- richieste ----

      createRequest(req, res) {
        const s = sectionOr404(req.params.id);
        const r = buildRequest(req.body || {}, { id: newId() });
        replaceSection({ ...s, requests: [...(s.requests || []), r] });
        res.json(r);
      },

      updateRequest(req, res) {
        const s = sectionOr404(req.params.id);
        const cur = (s.requests || []).find(x => x.id === req.params.rid);
        if (!cur) throw ctx.error(404, 'request_not_found', { id: String(req.params.rid) });
        const r = buildRequest(req.body || {}, cur);
        replaceSection({ ...s, requests: s.requests.map(x => (x.id === r.id ? r : x)) });
        res.json(r);
      },

      deleteRequest(req, res) {
        const s = sectionOr404(req.params.id);
        replaceSection({ ...s, requests: (s.requests || []).filter(x => x.id !== req.params.rid) });
        res.json({ ok: true });
      },

      // ---- tipologie di utenza ----

      createUserType(req, res) {
        requireVault();
        const s = sectionOr404(req.params.id);
        const u = buildUser(req.body || {}, { id: newId() });
        replaceSection({ ...s, userTypes: [...(s.userTypes || []), u] });
        res.json(publicUser(u));
      },

      updateUserType(req, res) {
        requireVault();
        const s = sectionOr404(req.params.id);
        const u = buildUser(req.body || {}, userOr404(s, req.params.uid));
        replaceSection({ ...s, userTypes: s.userTypes.map(x => (x.id === u.id ? u : x)) });
        auth.forgetSection(s.id, u.id); // configurazione cambiata: il token va riottenuto
        res.json(publicUser(u));
      },

      // Le richieste che la usavano restano senza autorizzazione
      deleteUserType(req, res) {
        const s = sectionOr404(req.params.id);
        const u = userOr404(s, req.params.uid);
        replaceSection({
          ...s,
          userTypes: s.userTypes.filter(x => x.id !== u.id),
          requests: (s.requests || []).map(r => (r.userType === u.id ? (({ userType, ...rest }) => rest)(r) : r)),
        });
        auth.forgetSection(s.id, u.id);
        res.json({ ok: true });
      },

      // ---- token (solo in memoria) ----

      authState(req, res) {
        const s = sectionOr404(req.params.id);
        res.json({ vault: vault.state(), users: (s.userTypes || []).map(u => auth.state(s, u)) });
      },

      // Token incollato a mano { token, expiresAt? (ISO) }
      async setToken(req, res) {
        requireVault();
        const s = sectionOr404(req.params.id);
        const u = userOr404(s, req.params.uid);
        if (u.auth.type === 'none' || u.auth.type === 'basic') throw ctx.error(400, 'token_not_used');
        const token = String(req.body.token ?? '').trim();
        if (!token || token.length > 16384 || CONTROL_RE.test(token)) throw ctx.error(400, 'token_invalid');
        let expiresAt = null;
        if (req.body.expiresAt) {
          expiresAt = Date.parse(req.body.expiresAt);
          if (!Number.isFinite(expiresAt)) throw ctx.error(400, 'expiry_invalid');
        }
        await auth.store(s, u, { token, expiresAt, source: 'manual' });
        res.json(auth.state(s, u));
      },

      forgetToken(req, res) {
        const s = sectionOr404(req.params.id);
        const u = userOr404(s, req.params.uid);
        auth.forget(s, u);
        res.json(auth.state(s, u));
      },

      async login(req, res) {
        requireVault();
        const s = sectionOr404(req.params.id);
        res.json(await auth.login(s, userOr404(s, req.params.uid)));
      },

      // ---- rotte Express del progetto collegato ----

      discoverRoutes(req, res) {
        const s = sectionOr404(req.params.id);
        const p = s.projectId ? ctx.projects.get(s.projectId) : null;
        if (!p) throw ctx.error(400, 'section_no_project');
        if (!fs.existsSync(p.path)) throw ctx.error(404, 'project_path_missing', { path: p.path });
        res.json(discover(p.path));
      },

      // Endpoint dal documento .well-known dell'issuer (per compilare il modulo)
      async oidcDiscovery(req, res) {
        const issuer = String(req.body.issuer ?? '').trim();
        if (!HTTP_URL_RE.test(issuer)) throw ctx.error(400, 'issuer_invalid');
        const doc = await auth.discover(issuer);
        res.json({
          authorizationEndpoint: doc.authorization_endpoint || null, tokenEndpoint: doc.token_endpoint || null,
          scopes: Array.isArray(doc.scopes_supported) ? doc.scopes_supported.slice(0, 50) : [],
          pkce: Array.isArray(doc.code_challenge_methods_supported) ? doc.code_challenge_methods_supported.includes('S256') : null,
        });
      },

      // { section, request: { method, url, query, headers, bodyType, body, userType }, timeoutMs? }
      async send(req, res) {
        const s = sectionOr404(req.body.section);
        const r = buildRequest(req.body.request || {}, { id: 'send', label: 'send' });
        try { validateRequest(r, s.userTypes || []); } catch (e) { throw ctx.error(400, 'request_invalid_send', { error: e.message }); }
        const t = Number(req.body.timeoutMs);
        const timeoutMs = Number.isInteger(t) && t >= 1000 && t <= 300000 ? t : undefined;
        res.json(await sendRequest(s, r, { timeoutMs }));
      },
    },

    shutdown() { auth.shutdown(); },
  };
};
