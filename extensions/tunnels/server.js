// Tunnel SSH: port forwarding -L con ssh o autossh, riconnessione con backoff,
// gruppi e server salvati nelle sezioni "groups" e "servers" di config.json
const { spawn } = require('child_process');
const crypto = require('crypto');
const net = require('net');

const RECONNECT_INITIAL_DELAY = 5000;   // 5s primo tentativo
const RECONNECT_MAX_DELAY     = 60000;  // max 60s tra un tentativo e l'altro
const RECONNECT_BACKOFF       = 1.5;    // moltiplicatore backoff

const SERVER_FIELDS = ['key', 'label', 'port', 'remote', 'alias', 'type'];
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

  function validateServer(srv) {
    if (!srv || typeof srv !== 'object') throw ctx.error.config('server_invalid');
    const bad = name => ctx.error.config(name, { key: String(srv.key ?? '') });
    if (!KEY_RE.test(srv.key || '')) throw bad('server_key');
    if (!isText(srv.label)) throw bad('server_label');
    if (!isPort(srv.port)) throw bad('server_port');
    const m = REMOTE_RE.exec(srv.remote || '');
    if (!m || !isPort(Number(m[2]))) throw bad('server_remote');
    if (!ALIAS_RE.test(srv.alias || '')) throw bad('server_alias');
    if (srv.type != null && !isText(srv.type, 40)) throw bad('server_type');
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

  // ---- tunnel ----

  function publicTunnel(id, t) {
    return {
      id, serverKey: t.serverKey, label: t.label, port: t.port,
      remote: t.remote, alias: t.alias, type: t.type,
      pid: t.pid, startedAt: t.startedAt,
      reconnecting: !!t.reconnectTimer,
    };
  }

  function spawnTunnel(id, sshArgs, useAuto) {
    const td = active.get(id);
    if (!td || td.stopping) return;

    const proc = useAuto ? spawn('autossh', ['-M', '0', ...sshArgs]) : spawn('ssh', sshArgs);
    td.process = proc;
    td.pid = proc.pid;

    // Righe di ssh così come arrivano; i messaggi di Kelbo hanno anche code/params
    // (il frontend li traduce, text resta nella lingua sorgente)
    const log = (text, sys) => {
      td.logs.push({ ts: Date.now(), text, ...(sys ? { code: `${ctx.code}.${sys.name}`, params: sys.params } : {}) });
      if (td.logs.length > 200) td.logs.splice(0, td.logs.length - 200);
    };
    const sysLog = (name, params) => log(ctx.error.message(name, params), { name, params });

    sysLog('log_connecting', { alias: td.alias, port: td.port, remote: td.remote, command: useAuto ? 'autossh' : 'ssh', pid: proc.pid });
    proc.stdout.on('data', d => log(d.toString()));
    proc.stderr.on('data', d => log(d.toString()));
    proc.on('error', err => sysLog('log_spawn_error', { error: err.message }));

    proc.on('close', code => {
      const t = active.get(id);
      if (!t) return; // già rimosso manualmente
      if (t.stopping) { active.delete(id); return; }
      const delay = Math.min(t.reconnectDelay, RECONNECT_MAX_DELAY);
      sysLog('log_closed', { code, seconds: Math.round(delay / 1000) });
      t.reconnectDelay = Math.round(delay * RECONNECT_BACKOFF);
      t.reconnectTimer = setTimeout(() => {
        const cur = active.get(id);
        if (!cur || cur.stopping) return;
        cur.reconnectTimer = null;
        spawnTunnel(id, sshArgs, useAuto);
      }, delay);
    });
  }

  function stop(t, force = false) {
    t.stopping = true;
    if (t.reconnectTimer) clearTimeout(t.reconnectTimer);
    try { t.process && t.process.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
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
      if (t.port === localPort) throw ctx.error(409, 'port_in_use', { port: localPort, label: t.label });
    }

    const id = crypto.randomUUID();
    const sshArgs = [
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'TCPKeepAlive=yes',
      '-L', `127.0.0.1:${localPort}:${srv.remote}`,
      '-N', srv.alias,
    ];
    const td = {
      serverKey, label: srv.label, port: localPort,
      remote: srv.remote, alias: srv.alias, type: srv.type,
      pid: null, process: null,
      startedAt: new Date().toISOString(),
      logs: [], stopping: false,
      reconnectDelay: RECONNECT_INITIAL_DELAY, reconnectTimer: null,
    };
    active.set(id, td);
    spawnTunnel(id, sshArgs, hasCommand('autossh')); // ricontrollato a ogni avvio
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
        const srvList = servers();
        const byKey = new Map(srvList.map(s => [s.key, s]));
        res.json({
          groups: groups().map(g => ({ ...g, servers: g.servers.map(k => byKey.get(k)).filter(Boolean) })),
          servers: srvList,
          tunnels: [...active].map(([id, t]) => publicTunnel(id, t)),
        });
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

      createServer(req, res) {
        const { key, label, port, remote, alias, type, groupKey } = req.body;
        if (!key || !label || !port || !remote || !alias) throw ctx.error(400, 'fields_required');
        const srvList = servers();
        if (srvList.some(s => s.key === key)) throw ctx.error(409, 'key_exists', { key: String(key) });
        const grpList = groups();
        const g = groupKey && grpList.find(x => x.key === groupKey);
        if (g) g.servers.push(key);
        save(g ? grpList : null, [...srvList, normalizeServer({ key, label, port, remote, alias, type: type || 'TCP' })]);
        res.json({ ok: true });
      },

      updateServer(req, res) {
        const list = servers();
        const idx = list.findIndex(s => s.key === req.params.key);
        if (idx === -1) throw ctx.error(404, 'server_not_found', { key: req.params.key });
        list[idx] = { ...list[idx], ...normalizeServer(pick(req.body, ['label', 'port', 'remote', 'alias', 'type'])) };
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
              key: srv.key, label: srv.label, type: srv.type || 'TCP', localPort: srv.port, remote: srv.remote, sshAlias: srv.alias,
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
