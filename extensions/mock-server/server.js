// Mock server: un listener HTTP su 127.0.0.1 per ogni mock (sezione "mockServers"),
// risposte predefinite per rotta (la prima che corrisponde, in ordine), CORS, registro
// delle chiamate in arrivo in memoria (ultime 500 per mock) con aggiornamenti in streaming.
const crypto = require('crypto');
const http = require('http');

const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_TYPES = ['none', 'json', 'text'];
const LOG_CAP = 500;
const LOG_BODY_BYTES = 64 * 1024;        // body registrato (oltre: troncato)
const MAX_BODY_BYTES = 10 * 1024 * 1024; // oltre si smette di leggere
const MAX_DELAY_MS = 60000;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const PATH_RE = /^\/[^\s?#]{0,499}$/;
const TEXT_TYPE_RE = /^(text\/|application\/([\w.+-]*\+)?(json|xml|javascript|x-www-form-urlencoded|graphql|yaml|x-ndjson))/i;
// header con credenziali: oscurati negli strumenti MCP
const SECRET_HEADER_RE = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|password|api[-_]?key|session/i;

const newId = () => crypto.randomBytes(4).toString('hex');

// Percorso con :parametri e * → espressione regolare (case sensitive come Express)
function pathRegex(p) {
  let re = '';
  for (const part of p.split(/(:[A-Za-z_]\w*|\*)/)) {
    if (!part) continue;
    if (part === '*') re += '(.*)';
    else if (part.startsWith(':')) re += '([^/]+)';
    else re += part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}/?$`);
}

function matchRoute(routes, method, pathname) {
  return routes.find(r => (r.method === 'ANY' || r.method === method || (r.method === 'GET' && method === 'HEAD'))
    && pathRegex(r.path).test(pathname)) || null;
}

const corsHeaders = req => {
  const origin = req.headers.origin;
  return {
    'Access-Control-Allow-Origin': origin || '*',
    ...(origin ? { 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '600',
  };
};

// Body ricevuto, come viene registrato: JSON (testo formattabile), testo, binario (solo dimensione)
function loggedBody(buf, size, contentType) {
  if (!size) return { kind: 'empty', size: 0 };
  const type = String(contentType || '').split(';')[0].trim();
  const truncated = size > buf.length;
  const textual = TEXT_TYPE_RE.test(type) || (!type && !buf.includes(0));
  if (!textual) return { kind: 'binary', size, type };
  const text = buf.toString('utf8');
  if (/json/i.test(type) && !truncated) { try { JSON.parse(text); return { kind: 'json', size, text }; } catch { /* JSON non valido: testo */ } }
  return { kind: 'text', size, text, truncated };
}

module.exports = function createMockServer(ctx) {
  const { KEY_RE, isText, isPort } = ctx.lib.validate;
  const mocks = () => ctx.config.get('mockServers');
  const running = new Map(); // id → { server, port, startedAt, log, seq, listeners: Set }
  const logs = new Map();    // id → { entries, seq } (resta dopo lo stop, fino a "svuota" o al riavvio)

  const mockOr404 = id => {
    const m = mocks().find(x => x.id === id);
    if (!m) throw ctx.error(404, 'mock_not_found', { id: String(id) });
    return m;
  };
  const save = list => ctx.config.set('mockServers', list);
  const replace = m => save(mocks().map(x => (x.id === m.id ? m : x)));
  const logOf = id => { if (!logs.has(id)) logs.set(id, { entries: [], seq: 0, listeners: new Set() }); return logs.get(id); };
  const emit = (id, type, data) => { for (const send of logOf(id).listeners) send(type, data); };

  // ---- validazione ----

  function validateRoute(r, mockId) {
    const bad = field => ctx.error.config(`route_${field}`, { id: mockId, route: String(r?.id ?? '') });
    if (!r || typeof r !== 'object' || !KEY_RE.test(r.id || '')) throw bad('id');
    if (!METHODS.includes(r.method)) throw bad('method');
    if (!PATH_RE.test(r.path || '')) throw bad('path');
    if (!(Number.isInteger(r.status) && r.status >= 100 && r.status <= 599)) throw bad('status');
    if (r.delayMs != null && !(Number.isInteger(r.delayMs) && r.delayMs >= 0 && r.delayMs <= MAX_DELAY_MS)) throw bad('delay');
    if (!BODY_TYPES.includes(r.bodyType ?? 'none') || !(typeof (r.body ?? '') === 'string' && (r.body ?? '').length <= 1024 * 1024)) throw bad('body');
    if (!Array.isArray(r.headers ?? []) || (r.headers || []).length > 50
        || (r.headers || []).some(h => !h || !HEADER_NAME_RE.test(h.name || '') || typeof h.value !== 'string' || /[\r\n\0]/.test(h.value) || h.value.length > 4000)) throw bad('headers');
    if (r.label != null && !(typeof r.label === 'string' && r.label.length <= 100)) throw bad('label');
  }

  function validateMock(m) {
    const bad = field => ctx.error.config(`mock_${field}`, { id: String(m?.id ?? '') });
    if (!m || typeof m !== 'object' || !KEY_RE.test(m.id || '')) throw bad('id');
    if (!isText(m.label, 100)) throw bad('label');
    if (!isPort(m.port)) throw bad('port');
    if (m.cors != null && typeof m.cors !== 'boolean') throw bad('cors');
    if (!Array.isArray(m.routes ?? []) || (m.routes || []).length > 500) throw bad('routes');
    const ids = new Set();
    for (const r of m.routes || []) {
      validateRoute(r, m.id);
      if (ids.has(r.id)) throw ctx.error.config('route_duplicate', { id: m.id, route: r.id });
      ids.add(r.id);
    }
  }

  const config = {
    mockServers: {
      empty: [], idField: 'id',
      validate(list) {
        if (!Array.isArray(list)) throw ctx.error.config('not_a_list', { section: 'mockServers' });
        const ids = new Set(), ports = new Set();
        for (const m of list) {
          validateMock(m);
          if (ids.has(m.id)) throw ctx.error.config('mock_duplicate', { id: m.id });
          if (ports.has(m.port)) throw ctx.error.config('port_duplicate', { port: m.port });
          ids.add(m.id); ports.add(m.port);
        }
      },
    },
  };

  // ---- server ----

  async function handle(id, req, res) {
    const started = Date.now();
    const chunks = [];
    let size = 0, kept = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (kept < LOG_BODY_BYTES) { const part = chunk.subarray(0, LOG_BODY_BYTES - kept); chunks.push(part); kept += part.length; }
      if (size > MAX_BODY_BYTES) break;
    }
    const m = mocks().find(x => x.id === id);
    const u = new URL(req.url, 'http://mock');
    const cors = m?.cors !== false;
    const entry = {
      id: 0, time: new Date(started).toISOString(), method: req.method, path: u.pathname,
      query: [...u.searchParams.entries()], headers: req.rawHeaders.reduce((l, v, i, a) => (i % 2 ? l : [...l, [a[i], a[i + 1]]]), []),
      body: loggedBody(Buffer.concat(chunks), size, req.headers['content-type']),
      route: null, routeLabel: null, status: 0, preflight: false, ms: 0,
    };
    let status, headers = {}, body = '';
    const route = m ? matchRoute(m.routes || [], req.method, u.pathname) : null;
    if (cors && req.method === 'OPTIONS' && req.headers['access-control-request-method'] && !(route && route.method === 'OPTIONS')) {
      status = 204; entry.preflight = true; // risposta automatica al preflight
    } else if (route) {
      status = route.status;
      for (const h of route.headers || []) headers[h.name] = h.value;
      if (route.bodyType !== 'none' && route.body) {
        body = route.body;
        if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = route.bodyType === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
        }
      }
      entry.route = route.id;
      entry.routeLabel = `${route.method} ${route.path}`;
      if (route.delayMs) await new Promise(r => setTimeout(r, route.delayMs));
    } else {
      status = 404;
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify({ error: 'no_mock_route', message: 'No route of this mock matches the request', method: req.method, path: u.pathname });
    }
    if (cors) headers = { ...corsHeaders(req), ...headers };
    entry.status = status;
    entry.ms = Date.now() - started;
    const log = logOf(id);
    entry.id = ++log.seq;
    log.entries.push(entry);
    if (log.entries.length > LOG_CAP) log.entries.splice(0, log.entries.length - LOG_CAP);
    emit(id, 'call', entry);
    if (res.destroyed) return;
    try {
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      // header non accettato da Node: risposta di errore senza gli header della rotta
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('invalid mock headers'); }
    }
  }

  // Avvia il listener; porta occupata → 409 con il processo che la tiene
  function startMock(m) {
    if (running.has(m.id)) return Promise.resolve(stateOf(m));
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        handle(m.id, req, res).catch(e => { ctx.log.error(e); if (!res.headersSent) { res.writeHead(500); res.end(); } });
      });
      const sockets = new Set();
      server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
      server.once('error', e => {
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') return reject(e);
        let owner = '';
        try {
          const p = ctx.lib.ports.listListeningPorts().find(x => x.port === m.port);
          if (p) owner = `${p.name || '?'}${p.pid ? ` (PID ${p.pid})` : ''}`;
        } catch { /* proprietario sconosciuto */ }
        reject(ctx.error(409, owner ? 'port_busy_owner' : 'port_busy', { port: m.port, owner }));
      });
      server.listen(m.port, '127.0.0.1', () => {
        running.set(m.id, { server, sockets, port: m.port, startedAt: new Date().toISOString() });
        emit(m.id, 'state', { running: true });
        resolve(stateOf(m));
      });
    });
  }

  function stopMock(id) {
    const r = running.get(id);
    if (!r) return;
    running.delete(id);
    r.server.close();
    for (const s of r.sockets) s.destroy(); // keep-alive dei browser: la porta si libera subito
    emit(id, 'state', { running: false });
  }

  const stateOf = m => {
    const r = running.get(m.id);
    return { running: !!r, startedAt: r?.startedAt || null, listeningPort: r?.port || null, calls: logs.get(m.id)?.entries.length || 0 };
  };
  const publicMock = m => ({ ...m, routes: m.routes || [], cors: m.cors !== false, ...stateOf(m) });

  // ---- dati dal form ----

  const parseHeaders = list => (Array.isArray(list) ? list : []).filter(h => h && (h.name || h.value))
    .map(h => ({ name: String(h.name ?? '').trim(), value: String(h.value ?? '') }));

  function buildRoute(body, existing = {}) {
    const r = {
      ...existing,
      method: String(body.method ?? existing.method ?? 'GET').toUpperCase(),
      path: String(body.path ?? existing.path ?? '/').trim(),
      status: Number(body.status ?? existing.status ?? 200),
      headers: body.headers !== undefined ? parseHeaders(body.headers) : existing.headers || [],
      bodyType: body.bodyType ?? existing.bodyType ?? 'json',
      body: String(body.body ?? existing.body ?? ''),
      delayMs: Number(body.delayMs ?? existing.delayMs ?? 0),
    };
    const label = String(body.label ?? existing.label ?? '').trim();
    if (label) r.label = label; else delete r.label;
    if (!r.delayMs) delete r.delayMs;
    if (r.path && !r.path.startsWith('/')) r.path = `/${r.path}`;
    return r;
  }

  const MCP_LIMIT = 50;
  const redact = headers => headers.map(([k, v]) => [k, SECRET_HEADER_RE.test(k) ? '[redacted]' : v]);

  return {
    config,
    // si fermano al riavvio di Kelbo (conferma dell'aggiornamento)
    running: () => (running.size ? [{ key: 'running.mocks', params: { count: running.size } }] : []),

    handlers: {
      list(req, res) { res.json(mocks().map(publicMock)); },

      create(req, res) {
        const b = req.body || {};
        const m = { id: newId(), label: String(b.label ?? '').trim(), port: Number(b.port), cors: b.cors !== false, routes: [] };
        save([...mocks(), m]);
        res.json(publicMock(m));
      },

      // Nome, porta, CORS; con il mock avviato e la porta cambiata si riavvia sulla nuova
      async update(req, res) {
        const cur = mockOr404(req.params.id);
        const b = req.body || {};
        const m = { ...cur, label: String(b.label ?? cur.label).trim(), port: b.port !== undefined ? Number(b.port) : cur.port, cors: b.cors !== undefined ? b.cors !== false : cur.cors !== false };
        replace(m);
        if (running.has(m.id) && running.get(m.id).port !== m.port) {
          stopMock(m.id);
          await startMock(m);
        }
        res.json(publicMock(m));
      },

      remove(req, res) {
        const m = mockOr404(req.params.id);
        stopMock(m.id);
        save(mocks().filter(x => x.id !== m.id));
        emit(m.id, 'removed', {});
        logs.delete(m.id);
        res.json({ ok: true });
      },

      async start(req, res) { res.json(await startMock(mockOr404(req.params.id))); },

      stop(req, res) {
        const m = mockOr404(req.params.id);
        stopMock(m.id);
        res.json(stateOf(m));
      },

      // ---- rotte (attive subito, anche a mock avviato) ----

      createRoute(req, res) {
        const m = mockOr404(req.params.id);
        const r = buildRoute(req.body || {}, { id: newId() });
        replace({ ...m, routes: [...(m.routes || []), r] });
        res.json(r);
      },

      updateRoute(req, res) {
        const m = mockOr404(req.params.id);
        const cur = (m.routes || []).find(x => x.id === req.params.rid);
        if (!cur) throw ctx.error(404, 'route_not_found', { id: String(req.params.rid) });
        const r = buildRoute(req.body || {}, cur);
        replace({ ...m, routes: m.routes.map(x => (x.id === r.id ? r : x)) });
        res.json(r);
      },

      deleteRoute(req, res) {
        const m = mockOr404(req.params.id);
        replace({ ...m, routes: (m.routes || []).filter(x => x.id !== req.params.rid) });
        res.json({ ok: true });
      },

      // { ids: [...] }: nuovo ordine delle rotte (la prima che corrisponde risponde)
      reorder(req, res) {
        const m = mockOr404(req.params.id);
        const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
        const routes = m.routes || [];
        if (ids.length !== routes.length || !routes.every(r => ids.includes(r.id))) throw ctx.error(400, 'order_invalid');
        replace({ ...m, routes: ids.map(id => routes.find(r => r.id === id)) });
        res.json({ ok: true });
      },

      // ---- registro delle chiamate ----

      calls(req, res) {
        const m = mockOr404(req.params.id);
        res.json({ calls: logOf(m.id).entries, cap: LOG_CAP });
      },

      clearCalls(req, res) {
        const m = mockOr404(req.params.id);
        logOf(m.id).entries = [];
        emit(m.id, 'clear', {});
        res.json({ ok: true });
      },

      // Streaming: stato e ogni nuova chiamata
      events(req, res) {
        const m = mockOr404(req.params.id);
        const send = ctx.sse(res);
        const log = logOf(m.id);
        log.listeners.add(send);
        send('state', { running: running.has(m.id) });
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); log.listeners.delete(send); });
      },
    },

    mcp: {
      list() {
        return { mocks: mocks().map(m => ({ id: m.id, label: m.label, port: m.port, running: running.has(m.id), routes: (m.routes || []).length, calls: logs.get(m.id)?.entries.length || 0 })) };
      },
      requests({ mock, method, path, unmatched, limit } = {}) {
        const m = mockOr404(mock);
        const n = Math.min(Math.max(parseInt(limit) || MCP_LIMIT, 1), LOG_CAP);
        let list = [...(logs.get(m.id)?.entries || [])].reverse();
        if (method) list = list.filter(e => e.method === String(method).toUpperCase());
        if (path) list = list.filter(e => e.path.includes(String(path)));
        if (unmatched) list = list.filter(e => !e.route && !e.preflight);
        return {
          mock: m.id, total: list.length, truncated: list.length > n,
          calls: list.slice(0, n).map(e => ({ ...e, headers: redact(e.headers) })),
        };
      },
    },

    shutdown() { for (const id of [...running.keys()]) stopMock(id); },
  };
};

module.exports.pathRegex = pathRegex;
module.exports.matchRoute = matchRoute;
