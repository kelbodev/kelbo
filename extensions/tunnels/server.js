// Tunnel: port forwarding -L con ssh o autossh, oppure con un "trasporto" offerto da un'altra
// estensione (capacità tunnel-transport, es. kubectl port-forward); riconnessione con backoff
// uguale per tutti; gruppi e server salvati nelle sezioni "groups" e "servers" di config.json
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');

const RECONNECT_INITIAL_DELAY = 5000;   // 5s primo tentativo
const RECONNECT_MAX_DELAY     = 60000;  // max 60s tra un tentativo e l'altro
const RECONNECT_BACKOFF       = 1.5;    // moltiplicatore backoff

const SERVER_FIELDS = ['key', 'label', 'port', 'remote', 'alias', 'type', 'transport', 'transportFrom', 'params'];
const TRANSPORT_RE = /^[a-z][a-z0-9-]{0,39}$/;
const CODE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PARAM_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const GROUP_FIELDS  = ['key', 'label', 'color', 'servers'];

module.exports = function createTunnels(ctx) {
  const { pick } = ctx.lib.config;
  const { KEY_RE, COLOR_RE, REMOTE_RE, ALIAS_RE, isPort, isText } = ctx.lib.validate;
  const { hasCommand } = ctx.lib.system;

  const active = new Map(); // id → { serverKey, label, port, remote, alias, type, pid, process, logs, stopping, reconnectDelay, reconnectTimer }

  // ---- config ----

  const groups  = () => ctx.config.get('groups');
  const servers = () => ctx.config.get('servers');

  // Salva entrambe le sezioni insieme (i gruppi fanno riferimento ai server)
  // Gruppi e server insieme in un'unica scrittura (i gruppi citano i server: validati insieme)
  function save(nextGroups, nextServers) {
    ctx.config.update({ ...(nextGroups ? { groups: nextGroups } : {}), ...(nextServers ? { servers: nextServers } : {}) });
  }

  function normalizeServer(srv) {
    const out = pick(srv || {}, SERVER_FIELDS);
    if (out.port !== undefined) out.port = Number(out.port);
    return out;
  }

  // Parametri di un trasporto: un oggetto piatto di testi, numeri e booleani (il provider li
  // controlla nel dettaglio quando il tunnel si salva e quando parte)
  const isParams = v => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 30
    && Object.entries(v).every(([k, x]) => PARAM_KEY_RE.test(k) && (typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length <= 500 && !/[\0\r\n]/.test(x))));

  function validateServer(srv) {
    if (!srv || typeof srv !== 'object') throw ctx.error.config('server_invalid');
    const bad = name => ctx.error.config(name, { key: String(srv.key ?? '') });
    if (!KEY_RE.test(srv.key || '')) throw bad('server_key');
    if (!isText(srv.label)) throw bad('server_label');
    if (!isPort(srv.port)) throw bad('server_port');
    if (srv.type != null && !isText(srv.type, 40)) throw bad('server_type');
    // tunnel di un altro trasporto: niente alias né remote, i parametri del provider
    if (srv.transport != null) {
      if (!TRANSPORT_RE.test(srv.transport) || srv.transport === 'ssh') throw bad('server_transport');
      if (srv.transportFrom != null && !CODE_RE.test(srv.transportFrom)) throw bad('server_transport');
      if (!isParams(srv.params)) throw bad('server_params');
      return;
    }
    const m = REMOTE_RE.exec(srv.remote || '');
    if (!m || !isPort(Number(m[2]))) throw bad('server_remote');
    if (!ALIAS_RE.test(srv.alias || '')) throw bad('server_alias');
  }

  function validateGroup(g, serverKeys) {
    if (!g || typeof g !== 'object') throw ctx.error.config('group_invalid');
    const bad = (name, params = {}) => ctx.error.config(name, { key: String(g.key ?? ''), ...params });
    if (!KEY_RE.test(g.key || '')) throw bad('group_key');
    if (!isText(g.label)) throw bad('group_label');
    if (!COLOR_RE.test(g.color || '')) throw bad('group_color');
    if (!Array.isArray(g.servers)) throw bad('group_servers');
    const missing = g.servers.filter(k => !serverKeys.has(k));
    if (missing.length) throw bad('group_missing_servers', { servers: missing.join(', ') });
  }

  function assertList(value, key) {
    if (!Array.isArray(value)) throw ctx.error.config('not_a_list', { section: key });
  }

  function assertUnique(list, field, what) {
    const seen = new Set();
    for (const x of list) {
      if (seen.has(x[field])) throw ctx.error.config(`duplicate_${what}`, { key: String(x[field]) });
      seen.add(x[field]);
    }
  }

  const config = {
    servers: {
      empty: [], idField: 'key',
      normalize: v => (Array.isArray(v) ? v.map(normalizeServer) : v),
      validate(list) {
        assertList(list, 'servers');
        list.forEach(validateServer);
        assertUnique(list, 'key', 'server');
      },
    },
    groups: {
      empty: [], idField: 'key',
      normalize: v => (Array.isArray(v) ? v.map(g => pick(g || {}, GROUP_FIELDS)) : v),
      validate(list, cfg) {
        assertList(list, 'groups');
        const serverKeys = new Set((cfg.servers || []).map(s => s.key));
        list.forEach(g => validateGroup(g, serverKeys));
        assertUnique(list, 'key', 'group');
      },
      // Gruppi già esistenti: si uniscono le liste di server
      merge(current, incoming) {
        const out = current.map(g => ({ ...g, servers: [...g.servers] }));
        for (const g of incoming) {
          const cur = out.find(x => x.key === g.key);
          if (!cur) out.push(g);
          else if (Array.isArray(g.servers)) g.servers.forEach(sk => { if (!cur.servers.includes(sk)) cur.servers.push(sk); });
        }
        return out;
      },
    },
  };

  // ---- trasporti (capacità tunnel-transport delle altre estensioni) ----

  // [{ id, title, extension, impl }] dei provider caricati adesso (installazioni e spegnimenti seguiti)
  const transports = () => ctx.providers('tunnel-transport');
  // titolo del provider nella lingua sorgente (per i log; la UI usa quello tradotto)
  const titleOf = p => (typeof p.title === 'string' ? p.title : p.title?.it || p.title?.en || p.id);
  const lastErrors = new Map(); // serverKey → { code, params, at }: perché un tunnel si è fermato da solo
  const transportOf = id => transports().find(p => p.id === id) || null;
  const transportOr409 = srv => {
    const p = transportOf(srv.transport);
    if (!p) throw ctx.error(409, 'transport_missing', { transport: srv.transport, extension: srv.transportFrom || '?' });
    return p;
  };
  // Parametri controllati e normalizzati dal provider (errori del provider così come sono)
  async function checkParams(p, params) {
    if (!isParams(params)) throw ctx.error(400, 'params_invalid');
    const out = typeof p.impl.validate === 'function' ? await p.impl.validate({ ...params }) : params;
    if (!isParams(out)) throw ctx.error(400, 'params_invalid');
    return out;
  }
  // Testo breve dei parametri per le schede (es. "svc/api:80 · prod/backend")
  function describe(srv) {
    if (!srv.transport) return null;
    const p = transportOf(srv.transport);
    try { return p && typeof p.impl.describe === 'function' ? String(p.impl.describe(srv.params || {}) || '') : null; } catch { return null; }
  }

  // ---- tunnel ----

  function publicTunnel(id, t) {
    return {
      id, serverKey: t.serverKey, label: t.label, port: t.port,
      remote: t.remote, alias: t.alias, type: t.type, transport: t.transport || null,
      pid: t.pid, startedAt: t.startedAt,
      reconnecting: !!t.reconnectTimer,
    };
  }

  // Avvia (o riavvia) il processo del tunnel: ssh/autossh oppure start() del trasporto; output
  // nei log, uscita → nuovo tentativo con backoff, finché il tunnel non viene fermato
  function launch(id) {
    const td = active.get(id);
    if (!td || td.stopping) return;

    // Righe del processo così come arrivano; i messaggi di Kelbo hanno anche code/params
    // (il frontend li traduce, text resta nella lingua sorgente)
    const log = (text, sys) => {
      td.logs.push({ ts: Date.now(), text, ...(sys ? { code: `${ctx.code}.${sys.name}`, params: sys.params } : {}) });
      if (td.logs.length > 200) td.logs.splice(0, td.logs.length - 200);
    };
    const sysLog = (name, params) => log(ctx.error.message(name, params), { name, params });
    let current = true; // eventi di un processo sostituito da un riavvio: ignorati
    const onExit = code => {
      if (!current) return;
      current = false;
      const t = active.get(id);
      if (!t) return; // già rimosso manualmente
      if (t.stopping) { active.delete(id); return; }
      const delay = Math.min(t.reconnectDelay, RECONNECT_MAX_DELAY);
      sysLog('log_closed', { code: code ?? '?', seconds: Math.round(delay / 1000) });
      t.reconnectDelay = Math.round(delay * RECONNECT_BACKOFF);
      t.reconnectTimer = setTimeout(() => {
        const cur = active.get(id);
        if (!cur || cur.stopping) return;
        cur.reconnectTimer = null;
        launch(id);
      }, delay);
    };

    if (td.transport) {
      // il trasporto può sparire (estensione spenta o rimossa): il tunnel si ferma
      const p = transportOf(td.transport);
      if (!p) {
        const params = { transport: td.transport, extension: td.transportFrom || '?' };
        lastErrors.set(td.serverKey, { code: `${ctx.code}.transport_missing`, params, at: new Date().toISOString() });
        active.delete(id);
        return;
      }
      try {
        const handle = p.impl.start({ ...td.params }, td.port, {
          onOutput: text => { if (current) log(String(text)); },
          onReady: () => { if (current) sysLog('log_ready', { port: td.port }); },
          onExit: code => onExit(code),
        });
        td.handle = handle;
        td.pid = handle?.pid ?? null;
        sysLog('log_starting', { transport: titleOf(p), port: td.port, pid: td.pid ?? '—' });
      } catch (e) {
        sysLog('log_spawn_error', { error: e.message });
        onExit(null);
      }
      return;
    }

    const useAuto = hasCommand('autossh'); // ricontrollato a ogni avvio
    const proc = useAuto ? spawn('autossh', ['-M', '0', ...td.sshArgs]) : spawn('ssh', td.sshArgs);
    td.handle = { pid: proc.pid, stop: force => proc.kill(force ? 'SIGKILL' : 'SIGTERM') };
    td.pid = proc.pid;
    sysLog('log_connecting', { alias: td.alias, port: td.port, remote: td.remote, command: useAuto ? 'autossh' : 'ssh', pid: proc.pid });
    proc.stdout.on('data', d => log(d.toString()));
    proc.stderr.on('data', d => log(d.toString()));
    proc.on('error', err => sysLog('log_spawn_error', { error: err.message }));
    proc.on('close', onExit);
  }

  function stop(t, force = false) {
    t.stopping = true;
    if (t.reconnectTimer) clearTimeout(t.reconnectTimer);
    try { t.handle?.stop(force); } catch {}
  }

  function stopAllTunnels() {
    for (const [, t] of active) stop(t);
    active.clear();
  }

  // Avvia il tunnel di un server (porta locale del server o customPort)
  function openTunnel(serverKey, customPort) {
    const srv = servers().find(s => s.key === serverKey);
    if (!srv) throw ctx.error(400, 'server_not_found', { key: String(serverKey) });
    const localPort = customPort == null || customPort === '' ? srv.port : Number(customPort);
    if (!isPort(localPort)) throw ctx.error(400, 'port_invalid');
    for (const [, t] of active) {
      if (t.port === localPort && !t.stopping) throw ctx.error(409, 'port_in_use', { port: localPort, label: t.label });
    }
    if (srv.transport) transportOr409(srv);
    lastErrors.delete(serverKey);

    const id = crypto.randomUUID();
    const td = {
      serverKey, label: srv.label, port: localPort,
      remote: srv.remote, alias: srv.alias, type: srv.type,
      transport: srv.transport || null, transportFrom: srv.transportFrom || null, params: srv.params || null,
      sshArgs: srv.transport ? null : [
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'TCPKeepAlive=yes',
        '-L', `127.0.0.1:${localPort}:${srv.remote}`,
        '-N', srv.alias,
      ],
      pid: null, handle: null,
      startedAt: new Date().toISOString(),
      logs: [], stopping: false,
      reconnectDelay: RECONNECT_INITIAL_DELAY, reconnectTimer: null,
    };
    active.set(id, td);
    launch(id);
    return { id, ...td };
  }

  // La porta locale accetta connessioni? (tunnel pronto)
  function portOpen(port) {
    return new Promise(resolve => {
      const sock = net.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve(true); });
      sock.on('error', () => resolve(false));
      sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
    });
  }

  // Per le altre estensioni: porta locale di un tunnel attivo, avviandolo se serve
  // e aspettando che risponda (al massimo timeoutMs)
  async function ensureTunnel(serverKey, timeoutMs = 10000) {
    let entry = [...active].find(([, t]) => t.serverKey === serverKey && !t.stopping);
    if (!entry) {
      const t = openTunnel(serverKey);
      entry = [t.id, active.get(t.id)];
    }
    const [id, t] = entry;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portOpen(t.port)) return { id, port: t.port, label: t.label };
      if (!active.has(id) || t.reconnectTimer) break; // ssh già uscito: inutile aspettare
      await new Promise(r => setTimeout(r, 300));
    }
    const lastLog = t.logs.filter(l => !l.code).map(l => l.text.trim()).filter(Boolean).pop();
    throw lastLog ? ctx.error(502, 'not_ready_log', { label: t.label, log: lastLog }) : ctx.error(502, 'not_ready', { label: t.label });
  }

  const getServer = key => servers().find(s => s.key === key) || null;

  // Chiude i tunnel attivi di un server (prima di eliminarlo)
  function stopTunnelsOf(serverKey) {
    for (const [id, t] of active) if (t.serverKey === serverKey) { stop(t); active.delete(id); }
  }

  return {
    config,
    // si fermano al riavvio di Kelbo (conferma dell'aggiornamento)
    running: () => (active.size ? [{ key: 'running.tunnels', params: { count: active.size, names: [...active.values()].map(t => t.label).slice(0, 5).join(', ') } }] : []),

    handlers: {
      // Stato completo per la UI: gruppi (con i server risolti), server e tunnel attivi
      state(req, res) {
        const list = transports();
        // server con la descrizione del trasporto e, se manca l'estensione, unavailable
        const srvList = servers().map(s => (s.transport ? {
          ...s, description: describe(s), unavailable: !list.some(p => p.id === s.transport),
        } : s));
        const byKey = new Map(srvList.map(s => [s.key, s]));
        res.json({
          groups: groups().map(g => ({ ...g, servers: g.servers.map(k => byKey.get(k)).filter(Boolean) })),
          servers: srvList,
          tunnels: [...active].map(([id, t]) => publicTunnel(id, t)),
          transports: list.map(p => ({ id: p.id, title: p.title, extension: p.extension })),
          errors: Object.fromEntries(lastErrors),
        });
      },

      // Campi del form di un trasporto per i valori già scelti (liste che dipendono da altri campi)
      async transportFields(req, res) {
        const p = transportOf(req.params.id);
        if (!p) throw ctx.error(404, 'transport_missing', { transport: req.params.id, extension: '?' });
        const values = req.body?.values;
        if (values != null && !isParams(values)) throw ctx.error(400, 'params_invalid');
        const fields = typeof p.impl.fields === 'function' ? await p.impl.fields({ ...(values || {}) }) : [];
        res.json({ fields: Array.isArray(fields) ? fields : [] });
      },

      startTunnel(req, res) {
        const t = openTunnel(req.body.serverKey, req.body.port);
        res.json({ id: t.id, pid: t.pid, port: t.port, label: t.label });
      },

      stopTunnel(req, res) {
        const t = active.get(req.params.id);
        if (!t) throw ctx.error(404, 'tunnel_not_found');
        stop(t);
        active.delete(req.params.id);
        res.json({ ok: true });
      },

      stopAll(req, res) {
        stopAllTunnels();
        res.json({ ok: true });
      },

      tunnelLogs(req, res) {
        const t = active.get(req.params.id);
        if (!t) throw ctx.error(404, 'tunnel_not_found');
        res.json(t.logs.slice(-100));
      },

      createGroup(req, res) {
        const { key, label, color } = req.body;
        if (!key || !label) throw ctx.error(400, 'key_label_required');
        const list = groups();
        if (list.some(g => g.key === key)) throw ctx.error(409, 'key_exists', { key: String(key) });
        save([...list, { key, label, color: color || '#6b7280', servers: [] }]);
        res.json({ ok: true });
      },

      updateGroup(req, res) {
        const list = groups();
        const idx = list.findIndex(g => g.key === req.params.key);
        if (idx === -1) throw ctx.error(404, 'group_not_found', { key: req.params.key });
        list[idx] = { ...list[idx], ...pick(req.body, ['label', 'color', 'servers']) };
        save(list);
        res.json({ ok: true });
      },

      // Elimina il gruppo e i suoi server che non stanno in altri gruppi (con i loro tunnel)
      deleteGroup(req, res) {
        const list = groups();
        const g = list.find(x => x.key === req.params.key);
        if (!g) throw ctx.error(404, 'group_not_found', { key: req.params.key });
        const rest = list.filter(x => x.key !== g.key);
        const elsewhere = new Set(rest.flatMap(x => x.servers));
        const orphans = g.servers.filter(k => !elsewhere.has(k));
        orphans.forEach(stopTunnelsOf);
        save(rest, servers().filter(srv => !orphans.includes(srv.key)));
        res.json({ ok: true, deletedServers: orphans });
      },

      async createServer(req, res) {
        const { key, label, port, remote, alias, type, groupKey, transport, params } = req.body;
        const viaTransport = transport != null && transport !== '' && transport !== 'ssh';
        if (!key || !label || !port || (!viaTransport && (!remote || !alias))) throw ctx.error(400, 'fields_required');
        const srvList = servers();
        if (srvList.some(s => s.key === key)) throw ctx.error(409, 'key_exists', { key: String(key) });
        let srv = { key, label, port, remote, alias, type: type || 'TCP' };
        if (viaTransport) {
          const p = transportOf(transport);
          if (!p) throw ctx.error(400, 'transport_missing', { transport: String(transport), extension: '?' });
          srv = { key, label, port, type: type || 'TCP', transport: p.id, transportFrom: p.extension, params: await checkParams(p, params || {}) };
        }
        const grpList = groups();
        const g = groupKey && grpList.find(x => x.key === groupKey);
        if (g) g.servers.push(key);
        save(g ? grpList : null, [...srvList, normalizeServer(srv)]);
        res.json({ ok: true });
      },

      async updateServer(req, res) {
        const list = servers();
        const idx = list.findIndex(s => s.key === req.params.key);
        if (idx === -1) throw ctx.error(404, 'server_not_found', { key: req.params.key });
        const cur = list[idx];
        const b = req.body || {};
        const transport = b.transport !== undefined ? (b.transport || 'ssh') : (cur.transport || 'ssh');
        if (transport === 'ssh') {
          const { transport: _t, transportFrom: _f, params: _p, ...rest } = cur;
          list[idx] = { ...rest, ...normalizeServer(pick(b, ['label', 'port', 'remote', 'alias', 'type'])) };
        } else {
          const p = transportOf(transport);
          if (!p) throw ctx.error(400, 'transport_missing', { transport: String(transport), extension: cur.transportFrom || '?' });
          const { remote: _r, alias: _a, ...rest } = cur;
          list[idx] = { ...rest, ...normalizeServer(pick(b, ['label', 'port', 'type'])), transport: p.id, transportFrom: p.extension,
            params: await checkParams(p, b.params !== undefined ? b.params : cur.params || {}) };
        }
        save(null, list);
        res.json({ ok: true });
      },

      // Elimina il server e lo toglie dai gruppi (prima i gruppi, poi i server: i riferimenti restano validi)
      deleteServer(req, res) {
        const key = req.params.key;
        stopTunnelsOf(key);
        save(groups().map(g => ({ ...g, servers: g.servers.filter(k => k !== key) })), servers().filter(s => s.key !== key));
        res.json({ ok: true });
      },
    },

    services: {
      getServer, ensureTunnel,
      // per l'estensione ports: tunnel attivi (pid di ssh/autossh) e arresto
      activeTunnels: () => [...active].map(([id, t]) => ({ id, pid: t.pid, label: t.label, port: t.port })),
      stopTunnel(id, { force = false } = {}) {
        const t = active.get(id);
        if (!t) return false;
        stop(t, force);
        active.delete(id);
        return true;
      },
    },

    // Strumenti MCP (sola lettura)
    mcp: {
      list() {
        const tunnels = [...active].map(([id, t]) => publicTunnel(id, t));
        return {
          servers: servers().map(srv => {
            const tn = tunnels.find(x => x.serverKey === srv.key);
            return {
              key: srv.key, label: srv.label, type: srv.type || 'TCP', localPort: srv.port,
              ...(srv.transport ? { transport: srv.transport, target: describe(srv), available: !!transportOf(srv.transport) } : { transport: 'ssh', remote: srv.remote, sshAlias: srv.alias }),
              tunnel: tn ? { connected: !tn.reconnecting, reconnecting: tn.reconnecting, port: tn.port, pid: tn.pid, startedAt: tn.startedAt } : null,
            };
          }),
          groups: groups().map(g => ({ key: g.key, label: g.label, servers: g.servers })),
        };
      },
    },

    shutdown: stopAllTunnels,
  };
};
