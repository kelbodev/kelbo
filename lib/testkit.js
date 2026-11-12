// Kit di test del core (require('devdock/testkit') per le estensioni esterne, percorso
// relativo per quelle incluse): avvia Kelbo come processo separato su una porta libera,
// con una config e una cartella home temporanee, e parla con lui solo via HTTP.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILTIN_DIR = path.join(ROOT, 'extensions');

function tmpDir(prefix = 'devdock-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Avvia il server con la config indicata; restituisce { port, configPath, home, request, stop }
// opts.extensions: cartella delle estensioni incluse (default quelle del repo; null = nessuna)
// opts.install: cartelle di estensioni da mettere tra le installate (es. quella sotto test)
// opts.env: variabili aggiuntive
async function startServer(config = { projects: [] }, opts = {}) {
  const dir = tmpDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const port = await freePort();
  const home = path.join(dir, 'home'); // ~/.kelbo di prova: estensioni installate, lock, backup
  fs.mkdirSync(path.join(home, 'extensions'), { recursive: true });
  for (const src of opts.install || []) fs.symlinkSync(path.resolve(src), path.join(home, 'extensions', path.basename(src)), 'dir');
  let builtin = opts.extensions === undefined ? BUILTIN_DIR : opts.extensions;
  if (builtin === null) { builtin = path.join(dir, 'no-extensions'); fs.mkdirSync(builtin); }

  // opts.env: una variabile a null viene tolta (es. KELBO_HOME, per provare la home vera)
  const env = {
    ...process.env,
    KELBO_PORT: String(port),
    KELBO_CONFIG: configPath,
    KELBO_EXTENSIONS_DIR: builtin,
    KELBO_HOME: home,
    KELBO_NO_BROWSER: '1',
    // le variabili di prima (DEVDOCK_*) passate dai test delle estensioni valgono come KELBO_*
    ...Object.fromEntries(Object.entries(opts.env || {}).map(([k, v]) => [k.replace(/^DEVDOCK_/, 'KELBO_'), v])),
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === null) { delete env[k]; delete env[k.replace(/^KELBO_/, 'DEVDOCK_')]; }
  }
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server non avviato:\n${output}`)), 5000);
    const onData = d => {
      output += d.toString();
      if (output.includes('Estensioni:')) { clearTimeout(timer); resolve(); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', code => { clearTimeout(timer); reject(new Error(`Server uscito (${code}):\n${output}`)); });
  });

  const request = (method, urlPath, { body, headers = {}, raw } = {}) => new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: {
        Host: `127.0.0.1:${port}`,
        ...(data !== undefined && raw === undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
    }, res => {
      let text = '';
      res.on('data', d => text += d);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json, events: parseSse(text) });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });

  const stop = () => new Promise(resolve => {
    if (proc.exitCode !== null) return resolve();
    proc.removeAllListeners('exit');
    proc.on('exit', resolve);
    proc.kill('SIGTERM');
  });

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));

  return { port, configPath, home, request, stop, readConfig, output: () => output };
}

// Eventi SSE "data: {type, data}" di una risposta in streaming
function parseSse(text) {
  return text.split('\n\n')
    .map(part => part.replace(/^data: /, '').trim())
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

// ---- git ----

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=test@devdock', '-c', 'user.name=test', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Repo con un commit iniziale (package.json con gli script indicati)
function makeRepo(dir, { scripts = {}, dependencies = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts, dependencies }, null, 2));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function commitFile(dir, name, content = name) {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, 'add', '--', name);
  git(dir, 'commit', '-qm', `add ${name}`);
}

// ---- estensioni di prova ----

// Manifest minimo valido, con i campi in più indicati
// Manifest minimo di prova; un "devdock" passato in extra (nome di prima) vale come "kelbo"
const manifest = (code, { devdock, ...extra } = {}) =>
  ({ name: code, code, version: '1.0.0', kelbo: devdock ?? '^2.0', color: '#336699', position: 'tab', ...extra });

// Scrive un'estensione: files = { 'setting.json': {...}, 'server.js': '...' } (oggetti come JSON)
function writeExtension(root, code, files) {
  const dir = path.join(root, code);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

// ---- MCP ----

// Client MCP collegato all'istanza (token letto dal pannello)
async function mcpClient(srv) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const token = (await srv.request('GET', '/api/core/mcp')).json.token;
  const client = new Client({ name: 'devdock-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  client.token = token;
  return client;
}

// ---- traduzioni di un'estensione ----

// Problemi dei cataloghi i18n di un'estensione (cartella): catalogo sorgente mancante o non
// valido, chiavi obsolete, segnaposto diversi, chiavi usate nel codice e assenti dalla sorgente
function i18nProblems(extDir) {
  const check = require('./i18n-check');
  return check.extensionProblems(extDir);
}

// Validazione di un manifest come la fa il loader (per gli script dei repository di estensioni):
// restituisce il manifest normalizzato o lancia un errore con il motivo
function validateManifest(manifestJson, folder) {
  return require('./extensions').validateManifest(manifestJson, folder ?? manifestJson?.code);
}

// ---- temi ----

// Variabili che un tema deve definire: quelle dei colori nel :root di shell.css (non font e raggio)
function themeTokens() {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'core', 'shell.css'), 'utf8');
  const root = /:root\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))[1];
  return [...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]).filter(n => !['--radius', '--font', '--sans'].includes(n));
}

// Problemi del foglio di un tema (testo CSS): solo regole :root… con variabili (--nome: valore),
// nessun url() né @import, tutte le variabili di themeTokens() definite
function themeProblems(cssText) {
  const problems = [];
  const css = String(cssText).replace(/\/\*[\s\S]*?\*\//g, '');
  if (/url\s*\(|@import/i.test(css)) problems.push('url() e @import non sono ammessi');
  const defined = new Set();
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selector.split(',').every(s => s.trim().startsWith(':root'))) problems.push(`selettore non ammesso: ${selector.trim()}`);
    for (const decl of body.split(';').map(d => d.trim()).filter(Boolean)) {
      const m = /^(--[a-z0-9-]+)\s*:\s*\S/.exec(decl);
      if (!m) problems.push(`solo variabili (--nome: valore): ${decl}`);
      else defined.add(m[1]);
    }
  }
  if (/[{}]/.test(css.replace(/([^{}]+)\{([^{}]*)\}/g, ''))) problems.push('graffe non bilanciate o regole annidate');
  const missing = themeTokens().filter(n => !defined.has(n));
  if (missing.length) problems.push(`variabili mancanti: ${missing.join(', ')}`);
  return problems;
}

// Strumenti del db-client per i motori di database (testo SQL e confronto delle strutture), per
// provare un motore senza avviare Kelbo: in Kelbo gli stessi arrivano da ctx.require('db-client')
const dbClientTools = () => ({ sqlText: require('../extensions/db-client/sqltext'), schemaDiff: require('../extensions/db-client/schemadiff') });

// Tipi di un'estensione dal suo manifest (component, provider, theme), per i cataloghi
const extensionKinds = manifestJson => require('./extensions').extensionKinds(manifestJson);

// Versione di Kelbo in cui gira il kit (per controllare il campo "devdock" dei manifest)
const coreVersion = () => require('../package.json').version;

module.exports = {
  ROOT, BUILTIN_DIR, tmpDir, freePort, startServer, parseSse, git, makeRepo, commitFile,
  manifest, writeExtension, mcpClient, i18nProblems, validateManifest, coreVersion, themeTokens, themeProblems, extensionKinds, dbClientTools,
};
