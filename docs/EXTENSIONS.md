# Kelbo extensions

This document is the **public API** of Kelbo for extensions: manifest, backend and frontend `ctx`, configuration sections, routes and the core API they may use. It follows the core version (SemVer): additions come with a minor version, and any change that can break an existing extension comes with a new major version and is marked **Breaking** in the [CHANGELOG](../CHANGELOG.md). Every extension declares in its manifest the core versions it works with (`kelbo`).

Every feature that can be added or removed is an **extension**: a folder under `extensions/` that describes itself in `setting.json` and brings its own backend routes, HTML, JavaScript and CSS. The core only provides security, configuration storage by section, the extension loader, the projects shared by the extensions, a few shared services and the UI shell (navigation, header, dialogs).

## Built-in extensions

| Code | Position | Order | Owns in `config.json` | Export/import checkboxes | Dependencies | Preload |
|---|---|---|---|---|---|---|
| `dashboard` | tab | 5 | `dashboards` | Dashboard | — | no |
| `tunnels` | tab | 10 | `groups`, `servers` | Tunnel SSH | — | yes |
| `npm` | tab | 20 | — | — | — | yes |
| `env` | tab | 22 | — | — | — | no |
| `db-client` | tab | 25 | `dbConnections`, `dbFolders` | Connessioni database | `tunnels`, `git` (optional) | no |
| `db-mysql` | — (provider) | 41 | — | — | `db-client` | — |
| `git` | tab | 30 | — | — | — | no |
| `http-client` | tab | 38 | `httpSections` | Richieste HTTP | — | no |
| `mock-server` | tab | 39 | `mockServers` | Mock server | — | yes |

The official installable extensions (`pm2`, `ports`, `mongo-client`, `swagger`) are in the [kelbo-extensions](https://github.com/kelbodev/kelbo-extensions) repository, which is also an example of a repository holding several extensions (one folder each, prefixed tags, catalog, release script, CI).

The core owns `projects` and `projectFolders` (see *Projects and folders*) and their **Progetti e cartelle** export checkbox, `layout` (the tab order chosen by the user, not exported) and `vault` (the master password, see *Secrets*).

Services offered by the built-in extensions to the others (`ctx.require(code)`): `npm` → `readPackage(project)`, `processes()` (with `projectId`), `stopProcess(id)`; `tunnels` → `getServer(key)`, `ensureTunnel(key)`, `activeTunnels()`, `stopTunnel(id)`; `git` → `repos()`; `db-client` → `decryptPassword(connection)`, `sqlText(options)`, `schemaDiff(options)` (tools for database engines). Providers (`ctx.providers(capability)`): `db-mysql` → `db-engine` `mysql`, and in the official catalog `db-postgres`, `db-mssql`, `db-sqlite`, `db-oracle`; the interface of a database engine is in [`extensions/db-client/engine.md`](../extensions/db-client/engine.md).


## Folder layout

```
extensions/
  git/
    setting.json     manifest (required)
    server.js        backend: route handlers, services for other extensions, config rules
    view.html        markup of the panel
    sidebar.html     markup of the sidebar (optional: without it the panel is full width)
    view.js          frontend logic (ES module)
    style.css        styles (optional)
    i18n/it.json     translations, one file per language (optional; see *Translations*)
    package.json     own npm dependencies (optional, npm workspace)
    tests/           the extension's tests (node:test, *.test.js), run by npm test
```

Only `setting.json` is mandatory: an extension can be frontend-only (`swagger`, in kelbo-extensions) or backend-only (a service used by other extensions).

## `setting.json`

```json
{
  "name": "Git",
  "code": "git",
  "version": "1.0.0",
  "kelbo": "^2.0",
  "description": "Status, commit, grafo dei commit e operazioni remote per i repository dei progetti",
  "color": "#3fb950",
  "icon": "🌿",
  "position": "tab",
  "order": 30,
  "dependencies": [
    { "code": "tunnels", "required": false }
  ],
  "backend": {
    "module": "server.js",
    "routes": [
      { "method": "GET",  "path": "/repos",            "handler": "listRepos" },
      { "method": "GET",  "path": "/repos/:id/status", "handler": "status" },
      { "method": "POST", "path": "/repos/:id/action", "handler": "action", "stream": true }
    ]
  },
  "frontend": {
    "html": "view.html",
    "sidebar": "sidebar.html",
    "js": "view.js",
    "css": "style.css"
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Label shown in the UI: a string or a map by language tag (`{ "it": "Database", "en": "Database" }`) |
| `code` | yes | Unique id, `[a-z0-9-]`, equal to the folder name (`core` is reserved); used in URLs (`/api/ext/<code>`, `/ext/<code>`), in `dependencies` and as `window.Ext.<code>` |
| `version` | yes | Extension version (SemVer, `1.2.0`) |
| `kelbo` | yes | Kelbo versions the extension works with, as an npm range (`^2.0`, `>=2.1 <3`, `^2.0 \|\| ^3.0`). Before 2.13 the field was called `devdock`, which is still accepted (if both are there they must be equal); an extension that must also load on Kelbo before 2.13 keeps `devdock` too, with the same range. The loader refuses an extension whose range does not include the running core version: it is listed as disabled with the reason (`richiede Kelbo ^3.0, questa è la 2.0.0`) |
| `description` | no | One line; a string or a map by language tag |
| `color` | yes | Accent colour (`#rrggbb`) for tab, badges, pills and `--ext-color`; a theme can replace it with `--ext-<code>` (see *Themes*) |
| `icon` | no | Icon of the tab / header button, the catalog and the widgets: a [Lucide](https://lucide.dev/icons) icon name (`"database"`, `"git-branch"`; Kelbo ≥ 2.25), drawn in the extension's colour; an emoji or short text still works |
| `position` | with `frontend.js` | `"tab"`: entry in the section bar with its own panel · `"tab-icon"`: the same with the icon only (name as tooltip, badge as a dot or a small number) · `"header"`: button in the header bar that opens its panel · `"sidebar"`: icon in the **right bar**, a narrow bar on the right edge of the window shown only when at least one extension is there (Kelbo ≥ 2.31 for the last two). It is the default: the user can move the extension from the Extensions panel (saved in `layout.positions`), so the UI must work in every place; `GET /api/core/extensions` reports the `position` in use and the `manifestPosition`. An extension without `frontend.js` (only themes, traits or a backend) can leave it out (Kelbo ≥ 2.26) |
| `order` | no | Sort order among tabs, among header buttons and in the right bar (default 100); it is the default order: the user can reorder the tabs and the right bar (saved in `layout.tabs` and `layout.rail`), and extensions not in those lists go after the others in `order`. The first tab opens at startup (the first icon of the right bar when there are no tabs) |
| `dependencies` | no | `required: true` → the extension is not loaded if the dependency is missing or disabled · `required: false` → it loads with a warning icon and must cope with the dependency being absent |
| `config` | no | Top-level keys of `config.json` owned by the extension (see *Configuration*) |
| `export` | no | Checkboxes the extension adds to the Export and Import dialogs, each with the sections it covers (see *Export and import*) |
| `backend.module` | no | Backend file, relative to the extension folder |
| `backend.routes` | no | Routes mounted under `/api/ext/<code>`; each one names a handler of the backend |
| `frontend.html` / `sidebar` / `js` / `css` | no | Files served under `/ext/<code>/…`; only the files listed here are served (never `server.js` or `setting.json`) |
| `mcp.tools` | no | Tools the extension exposes to AI agents through the MCP server (see *MCP tools*); requires a backend |
| `reloadable` | no | `false` for an extension that can't be stopped and started again while Kelbo runs: installing an update or removing it then asks for a restart (default `true`) |
| `widgets` | no | Mini views for the project dashboard (see *Widgets*): `[{ id, title, description?, scope: "project", size: "s" \| "m" \| "l", js }]`; `js` is a module in the extension folder, served like the `frontend` files |
| `projects` | no | `{ traits: ["node", …] }`: the extension works with the projects having at least one of these traits; `ctx.projects` (backend `list({ traits })`, frontend `load()`) and the dashboard widgets leave the others out (see *Projects and folders*). Without it the extension sees every project (Kelbo ≥ 2.18) |
| `projectTraits` | no | Traits the extension adds to the core's `git`, `node`, `env`: `[{ id, label, files?, dependencies?, detect? }]` — present when one of `files` (relative paths, folders too) exists in the project folder or one of the npm packages in `dependencies` is in its `package.json` (dependencies, devDependencies, peerDependencies); with `detect: true` the backend has the last word (see *Traits*, Kelbo ≥ 2.19). At least one of the three. A trait with the id of a core trait or of an extension loaded earlier is ignored (Kelbo ≥ 2.18) |
| `themes` | no | Color themes the extension brings: `[{ id, name, scheme: "dark" \| "light", css }]`; `css` is a stylesheet in the extension folder, served like the `frontend` files (see *Themes*, Kelbo ≥ 2.26) |
| `provides` | no | Implementations the extension offers to other extensions: `[{ capability, id, title, handler }]`; `handler` names an object in `instance.providers` of the backend (see *Providers*, Kelbo ≥ 2.29) |
| `frontend.preload` | no | `true`: the module is mounted at startup (hidden) instead of on first open — for extensions that keep header pills, badges or notifications up to date in the background |

### Loading and states

Extensions come from two folders: the **built-in** ones in `extensions/` of the Kelbo repository (updated with Kelbo itself) and the **installed** ones in `~/.kelbo/extensions` (the Kelbo home: `KELBO_HOME` changes it; before 2.13 it was `~/.devdock`, moved at the first start), outside the repository, where the Extensions panel installs them. Folders whose name starts with `.` are ignored (staging and backups). Two extensions with the same `code` are an error, never a silent choice: the built-in one is used and the other is listed as disabled with the folder of the one already loaded.

At startup the loader reads every `setting.json` of both folders and gives each extension a state, shown by `GET /api/core/extensions` (with `source`: `builtin` or `installed`):

- `ok` — loaded
- `warning` — loaded, but an optional dependency is missing (`warnings` lists it)
- `off` — switched off by the user from the Extensions panel (`extensions.disabled` in `config.json`)
- `disabled` — not loaded; `error` says why: invalid manifest, core version outside the `kelbo` range, missing required dependency, dependency cycle, config key already owned by another extension, backend that throws or lacks a handler named in the manifest

Backends are created in dependency order (topological sort) and shut down in reverse order when the server stops. A disabled extension never takes the others down; those that require it are disabled too.

### Routes

Routes are declared in the manifest, not registered by code, so the whole API surface of an extension is readable in one place and the loader can check it:

- `method`: `GET`, `POST`, `PUT`, `DELETE`
- `path`: Express path relative to `/api/ext/<code>`, e.g. `/repos/:id/action`
- `handler`: name of a function in the backend's `handlers`; the loader refuses an extension whose manifest names a handler that does not exist, and warns about handlers that no route uses
- `stream: true`: the handler answers with Server-Sent Events (documentation only; the handler opens the stream with `ctx.sse(res)`)

Every route goes through the core security middleware (Host and Origin checks, JSON content type) and the core error handler: errors thrown by handlers, also asynchronous ones, become a JSON response: 400 for a `ConfigError`, the error's `status` when it has one (e.g. `Object.assign(new Error('…'), { status: 409 })`), 500 otherwise.

## Backend module

`server.js` exports a function that receives `ctx` and returns the extension instance:

```js
// extensions/git/server.js
module.exports = function createGit(ctx) {
  const tunnels = ctx.require('tunnels');         // services of a dependency (null if missing)

  return {
    handlers: {                                    // named in setting.json → backend.routes
      listRepos(req, res) { res.json(repos()); },
      async action(req, res) {
        const send = ctx.sse(res);                 // opens the SSE stream
        send('stdout', '$ git fetch\n');
        send('exit', 0);
        send.end();
      },
    },
    services: { repos },                           // for extensions that depend on this one
    config: {},                                    // rules for the keys in setting.json → config
    mcp: {},                                       // MCP tool handlers, named in setting.json → mcp.tools
    shutdown() { /* stop timers and child processes */ },
  };

  function repos() { /* uses ctx.projects.list() */ }
};
```

Only `handlers` is needed when the manifest declares routes (and `mcp` when it declares MCP tools); everything else is optional.

`ctx` contains:

| Member | Purpose |
|---|---|
| `ctx.code`, `ctx.dir` | Extension code and folder |
| `ctx.config.get(key)` / `ctx.config.set(key, value)` | Read/write a key declared in `setting.json → config`; every write is validated and saved atomically. Other keys throw |
| `ctx.config.update({ key: value, … })` | Writes several of the extension's keys in a single atomic save (e.g. data that must change together) |
| `ctx.providers(capability)` | Implementations of a capability offered by the loaded extensions, read at the moment of the call (installs, switch-offs and hot reloads are followed): `[{ id, title, extension, impl }]`, `impl` being the provider's object; with the same `id` the first loaded wins (see *Providers*, Kelbo ≥ 2.29) |
| `ctx.require(code)` | `services` of a dependency declared in the manifest (`null` if an optional dependency is missing) |
| `ctx.sse(res)` | Opens an SSE response; returns `send(type, data)`, with `send.end()` to close it |
| `ctx.error(status, name, params, extra)` | Error with a translatable code (see *Errors*): `throw ctx.error(404, 'repo_not_found')`. `ctx.error.config(name, params)` for config validation (400), `ctx.error.send(res, status, name, params)` where throwing is not possible (callbacks), `ctx.error.message(name, params)` for the source-language text |
| `ctx.lib.validate` | `KEY_RE`, `COLOR_RE`, `REMOTE_RE`, `ALIAS_RE`, `NPM_NAME_RE`, `PM2_TARGET_RE`, `isPort`, `isText`, `isValidBranchName`, `isValidCommitHash` |
| `ctx.lib.config` | `ConfigError` (400 without a code; prefer `ctx.error.config`) and `pick(obj, fields)` |
| `ctx.lib.errors` | `ApiError` (the class of `ctx.error`) and `errorBody(err)`, for handlers that build the response themselves |
| `ctx.lib.system` | `hasCommand(cmd)`, `getTools()` (installed external tools) |
| `ctx.lib.ports` | `getPortsForPgid(pid)`: TCP ports listened on by a process group; `listListeningPorts()`: every listening TCP port of the machine with pid, process name, user and command line |
| `ctx.log.info/warn/error(...)` | Console log prefixed with `[ext:<code>]` |
| `ctx.dataDir()` | Folder of the extension's data on this computer (`~/.kelbo/data/<code>`, created on first call): for what doesn't belong in `config.json` — counters, caches — and isn't exported (Kelbo ≥ 2.17) |
| `ctx.projects` | Projects of the core, read-only: `list({ traits }?)` (`{ id, label, path, folder?, traits? }`; with `traits`, only the projects having one of them), `get(id)`, `folders()` (`{ id, label }`), `traitsOf(project)` (effective traits) |
| `ctx.vault` | Master password vault of the core, see *Secrets* |

### MCP tools

An extension exposes tools to AI agents through the core MCP server (`/mcp`) by declaring them in `setting.json` and implementing them in `instance.mcp` of the backend:

```json
"mcp": {
  "tools": [
    { "name": "status", "handler": "status", "readOnly": true,
      "description": "Status of a repository: branch, ahead/behind, changed files…",
      "inputSchema": { "type": "object", "properties": { "repo": { "type": "string" } }, "required": ["repo"] } }
  ]
}
```

```js
return {
  mcp: {
    async status({ repo }) {                       // arguments from the agent (validate them)
      const r = getGitRepos().find(x => x.id === repo);
      if (!r) throw ctx.error(404, 'repo_not_found'); // becomes an MCP tool error with the code
      return { repo: r.id, ...await statusOf(r) };   // an object: sent as structured JSON and text
    },
  },
};
```

| Field | Meaning |
|---|---|
| `name` | `[a-z][a-z0-9_]*`; the tool is published as `<code>_<name>` (`-` in the code becomes `_`: `db_client_query`) |
| `description` | What the tool does, in English, written for the agent |
| `inputSchema` | JSON Schema of the arguments (`type: "object"`) |
| `handler` | Function in `instance.mcp`; it receives the arguments, returns an object (or throws `ctx.error`) |
| `readOnly` | `true` (default) for tools that only read; `false` for tools that change state (published with `readOnlyHint: false`) |

Steps to enable MCP for an extension:

1. Add the `mcp.tools` block to `setting.json` (the extension needs a `backend`).
2. Implement each `handler` in `instance.mcp` of `server.js`, reusing the same services and validation as the HTTP routes; errors are thrown with `ctx.error`, so their messages go in `i18n/<lang>.json` under `errors.<name>`.
3. Restart Kelbo: the tools appear in the 🤖 *MCP server* dialog of the header and in `GET /api/core/mcp`. There is no switch per extension: every active extension with `mcp.tools` is exposed.
4. Try them from a client: copy the setup from the panel (for Claude Code `claude mcp add --transport http kelbo http://127.0.0.1:3500/mcp --header "Authorization: Bearer <token>"`), or in a test with the SDK client as in `tests/mcp.test.js`.

The built-in extensions expose: `tunnels_list`; `env_check`; `git_repos`, `git_status`, `git_log`; `npm_projects`, `npm_processes`, `npm_output`, `npm_run`, `npm_stop`; `db_client_connections`, `db_client_databases`, `db_client_tables`, `db_client_describe`, `db_client_query` (database tools only while the vault is unlocked from the UI); `mock_server_list`, `mock_server_requests` (credential headers redacted). The official installable ones add `pm2_list`, `pm2_logs`, `ports_list` and, among others, `angular_cli_workspaces`, `angular_cli_generators`, `angular_cli_generate` (a dry run unless `apply: true`).

Keep tools read-only unless the user asked otherwise, never return secrets (passwords, tokens, vault data), and limit long outputs with a parameter (`limit`, `lines`) and a `truncated` flag. A missing handler disables the extension like a missing route handler.

### Errors

Error responses have one shape for the core and every extension:

```json
{ "error": "Branch inesistente: feature/x", "code": "git.not_found", "params": { "branch": "feature/x" } }
```

- `code` is `<extension code>.<name>` (`core.<name>` for the core); extra fields can follow (e.g. `files` for `git.dirty`).
- `error` is the message in the source language, built by the server from the extension's `i18n/it.json`, key `errors.<name>` (with `{param}` placeholders and plurals on `params.count`). The server never picks a language and contains no message text: handlers only throw `ctx.error(status, name, params)`.
- The frontend translates `code` with the key `<code>.errors.<name>` of the active language and falls back to `error`; `ctx.api` errors carry `status`, `code`, `data` and the translated `message`. For bodies read by hand use `ctx.ui.errorText(data)`.
- Output of external commands (`git`, `npm`, `pm2`, `ssh`, MySQL errors) is not translated: it travels as a parameter (e.g. `git.command_failed` with `{ output }`) and is shown as is.
- SSE events that carry a Kelbo message use the same `{ error, code, params }` object (e.g. the Git `notice` event).

Errors and warnings of the extension state (`GET /api/core/extensions` → `error`, `warnings`) are in the source language; the state ones (dependencies, incompatible Kelbo version, duplicate code, config key already used, ignored catalogs) also come as `errorInfo` / `warningInfo` (`{ error, code, params }`), translated by the interface. Manifest validation errors are developer diagnostics and stay in the source language only.

## Projects and folders

Projects (folders on disk) are shared by several extensions (npm scripts, Git repositories, `.env` files, migrations…), so they belong to the core, not to an extension. They are added, edited, removed and imported only in the core's **📁 Projects** panel (header); the extensions' sidebars just choose one. They live in two sections of `config.json`:

```json
"projectFolders": [{ "id": "f1a2b3c4", "label": "Customers" }],
"projects": [
  { "id": "my_app", "label": "My App", "path": "/Users/me/www/my-app", "folder": "f1a2b3c4" },
  { "id": "tools", "label": "Tools", "path": "/Users/me/www/tools", "traits": { "add": ["node"], "remove": ["git"] } }
]
```

Folders group projects, one level only; a project without `folder` stays at the root. Deleting a folder moves its projects back to the root.

### Traits

A project is not of one kind only (an Angular app is also a Node.js project and a Git repository), so instead of a type it has **traits**, detected in its folder:

| Trait | Present when |
|---|---|
| `git` (core) | `.git` in the folder or in a parent folder |
| `node` (core) | `package.json` in the folder |
| `env` (core) | a `.env` or `.env.<something>` file in the folder |
| extension traits | manifest `projectTraits`: one of its `files` exists, or one of its `dependencies` is in `package.json`; with `detect: true`, and the backend's `detectTrait(id, dir)` returns `true` |

The user can force a trait on (`traits.add`) or off (`traits.remove`) per project; both are saved with the project and travel with its export. The effective traits are the detected ones plus `add` minus `remove`. An extension that declares `projects: { traits: [...] }` sees only the projects with at least one of them: the others are hidden from its sidebar (a note at the bottom counts them and opens the panel) and its dashboard widgets are not offered for them. Detection is cached for a few seconds.

When a file or a folder is not enough (a `scripts` folder with only a README is not a scripts project), a trait declares `detect: true` and the extension's backend instance decides with `detectTrait(id, dir)` → `true`/`false`. It is synchronous and called for every project on every detection (after the cache), so it should stop at the first evidence; `files` and `dependencies`, when declared, are checked first as a quick filter, and `detectTrait` is called only for the folders that pass it. A `detectTrait` that throws counts as `false`. Kelbo 2.18 ignores `detect` and uses `files`/`dependencies` alone (Kelbo ≥ 2.19).

```js
module.exports = ctx => ({
  detectTrait: (id, dir) => id === 'scripts' && hasRunnableScript(dir),
  handlers: { /* … */ },
});
```

### Core API

| Route | Purpose |
|---|---|
| `GET /api/core/projects` | `{ folders, projects, traits }`: each project with `traitsFound` (detected), `traitsActive` (effective) and `missing` (folder gone); `traits` are the known traits `{ id, label, source }` (`source`: `core` or the extension code) |
| `POST /api/core/projects`, `PUT`/`DELETE /api/core/projects/:id` | Create; edit label, path, folder, `traits` (`{ add, remove }`; empty lists remove the override); remove. The id never changes |
| `GET /api/core/projects/:id/links` | What the extensions link to the project: `{ links: [{ code, key, params }] }` (see below) |
| `POST /api/core/projects/scan` | `{ path }` → `{ path, candidates: [{ path, name, label, traits, added }] }`: the folder and its direct subfolders (not hidden, not `node_modules`) with at least one trait |
| `POST /api/core/projects/import` | `{ paths, folder? }` → `{ added, skipped: [{ path, reason: "exists" \| "not_found" }] }`: ids from the folder names, labels from `package.json` `name` |
| `POST /api/core/folders`, `PUT`/`DELETE /api/core/folders/:id` | Folders |

### Links to a project

When an extension keeps data that refers to a project (a connection, a section, a layout…), its backend instance can return `projectLinks(project)` → `[{ key, params? }]` (sync or async); `key` is translated with the extension's catalog. The panel lists them before a project is removed: removing a project leaves those data in place, unlinked; renaming or moving it keeps every link, because the id never changes.

```js
module.exports = ctx => ({
  projectLinks: project => connections().filter(c => c.projectId === project.id)
    .map(c => ({ key: 'links.connection', params: { name: c.label } })),
  handlers: { /* … */ },
});
```

### Frontend

In the backend extensions read projects with `ctx.projects`. In the frontend `ctx.projects` (`public/core/projects.js`) gives the shared pieces, so every sidebar looks and behaves the same:

| Member | Purpose |
|---|---|
| `load()` | `{ folders, projects, traits, hidden }` from the core; `projects` only those with the extension's traits (manifest `projects`), `hidden` how many were left out |
| `tree(folders, items, item)` | HTML of the sidebar tree: each folder (collapsible) with its items, then the items without a folder; folders with no items are not shown. `items` are objects with an optional `folder` field (projects, repositories…), `item(x)` returns the HTML of one entry |
| `hiddenNote(count)` | HTML of the note "+ N projects not for this section" (opens the panel); empty for 0 |
| `openPanel()` | Opens the 📁 Projects panel |
| `form(id?)` | Opens the panel on the form to add a project (no id) or edit one |
| `remove(id)` | Confirms and removes a project; resolves `true` when removed (prefer the panel, which shows the links) |
| `newFolder()` | Opens the panel on the new folder form |

After every change the core emits `core:projects-changed` on the bus; extensions that show projects reload them on it.

## Configuration

`config.json` keeps its top-level keys (`groups`, `servers`, `projects`, …). Each key is a **section** owned by the core (`projects`, `projectFolders`) or by exactly one extension, the one that lists it in `setting.json → config`; two extensions cannot claim the same key. The backend describes each of its sections in `instance.config[key]`:

| Field | Purpose |
|---|---|
| `empty` | Default value, written when the key is missing |
| `validate(value, cfg)` | Called before every save and import; throwing rejects the write with a 400 (`cfg` is the whole config, for references between sections) |
| `normalize(value)` | Applied to imported data (e.g. keep only known fields) |
| `idField` | For lists: field that identifies an item in a *merge* import |
| `local` | `true` for data that belongs to this computer (e.g. a browser path): never exported, not even by a full export |
| `merge(current, incoming)` | Custom *merge* import (default: lists add the items with a new `idField`, objects add the new keys) |

Writes are atomic (temporary file + rename).

## Secrets

Passwords, tokens and other secrets are never saved in clear: an extension encrypts them with the core **master password vault** (`ctx.vault`) and stores the encrypted box (`{ iv, tag, data }`, AES-256-GCM) in its own config section. The vault keeps only a verifier in `config.json` (section `vault`, owned by the core); the key lives in the server's memory while the vault is unlocked, until the user locks it, Kelbo restarts or the inactivity timeout expires.

| Member | Purpose |
|---|---|
| `state()` | `uninitialized`, `locked` or `unlocked` |
| `encrypt(text)` / `decrypt(box)` | Box to store / text back; both throw `423 core.vault_locked` (or `core.vault_missing`), which the frontend handles with `ctx.vault.ensure()` and a retry; `decrypt` throws `400 core.secret_unreadable` for a box encrypted with another password |
| `isBox(value)`, `isRecord(value)` | Validation of a stored box (in `instance.config[...].validate`) and of a `vault` block (e.g. of a file to import) |
| `openForeign(record, password)` | Secrets of a file encrypted with another master password: `{ decrypt(box) }`, or `null` for a wrong password (counts as a failed attempt) |
| `register({ rekey, reset, lock })` | `rekey(reencrypt, cfg)` returns `{ sections: { <own section>: newValue }, count }` with every box re-encrypted, saved in the same write as the new vault when the password changes; `reset(cfg)` returns `{ <own section>: valueWithoutSecrets }`, saved with the vault removed; `lock()` is called when the vault locks (e.g. close connections that use a decrypted password). An extension can only rewrite its own sections |

```js
module.exports = ctx => {
  ctx.vault.register({
    rekey: (reencrypt, cfg) => ({ sections: { mySecrets: cfg.mySecrets.map(s => ({ ...s, box: reencrypt(s.box) })) }, count: cfg.mySecrets.length }),
    reset: cfg => ({ mySecrets: [] }),
  });
  return {
    config: { mySecrets: { empty: [], validate(list, cfg) { if (list.length && !cfg.vault) throw ctx.error.config('secret_without_vault'); } } },
    handlers: {
      save(req, res) { ctx.config.set('mySecrets', [{ name: 'api', box: ctx.vault.encrypt(req.body.value) }]); res.json({ ok: true }); },
    },
  };
};
```

## Export and import

The header **Export** and **Import** dialogs are built from the checkboxes the extensions declare in `setting.json → export`. Each checkbox covers one or more of the extension's own `config` sections:

```json
"config": ["groups", "servers"],
"export": [
  { "id": "tunnels", "label": "Tunnel SSH", "description": "Gruppi e server", "sections": ["groups", "servers"] }
]
```

| Field | Meaning |
|---|---|
| `id` | Unique within the extension, `[a-z0-9-]` |
| `label` | Checkbox label; a string or a map by language tag |
| `description` | Optional hint under the label; a string or a map by language tag |
| `sections` | Sections included when the box is checked; they must be listed in the extension's `config` (otherwise the extension is disabled), except the core's `vault`, which a checkbox includes when its sections hold encrypted secrets (they are unreadable without it) |

Sections not covered by any checkbox are not exported. **Export** downloads a single `.json` file with the checked sections. **Import** reads the file in the browser, shows the checkboxes whose sections the file contains, and applies the checked ones in *merge* mode (new items added, existing ones unchanged, using `idField`/`merge`) or *replace* mode (the sections take the place of the current ones); everything else is left untouched.

## Frontend module

The shell loads an extension's panel the first time it is opened (or at startup with `preload`): it injects `view.html` into the panel and `sidebar.html` into the sidebar, adds `style.css`, then `import()`s `view.js` and calls `mount`. The panel keeps its DOM when the user switches to another section.

Static markup (titles, buttons, containers) lives in the HTML files; `view.js` only fills the dynamic parts, finding them by `data-role`, and wires static buttons through `data-action` attributes:

```html
<!-- extensions/git/sidebar.html -->
<div class="sidebar-head">
  <span class="sidebar-head-title">Repository</span>
  <button class="btn btn-ghost btn-sm" data-action="reload-repos">↻</button>
</div>
<div class="sidebar-body" data-role="repos"></div>
```

```js
// extensions/git/view.js
export default {
  async mount(ctx) {
    const list = ctx.sidebar.querySelector('[data-role="repos"]');
    const repos = await ctx.api.get('/repos');          // → GET /api/ext/git/repos
    list.innerHTML = repos.map(r =>
      `<button class="sb-item" onclick="Ext.git.select(${ctx.ui.js(r.id)})">${ctx.ui.esc(r.label)}</button>`).join('');
    ctx.expose({ select(id) { /* … */ } });             // window.Ext.git.select(...)
    ctx.setBadge(repos.length);
  },
  show(ctx) {},    // panel became visible
  hide(ctx) {},    // panel hidden (stop work that only matters while visible)
  refresh(ctx) {}, // the user pressed ↻ in the header
  languageChanged(ctx) {}, // the user picked another language (default: refresh)
  unmount(ctx) {},  // the extension is being switched off, updated or removed: stop timers and streams
};
```

`ctx` contains:

| Member | Purpose |
|---|---|
| `ctx.code`, `ctx.meta` | Extension code and its data from `/api/core/extensions` |
| `ctx.root` | Panel element (already contains `view.html`) |
| `ctx.sidebar` | Sidebar element, shown while the extension is active (already contains `sidebar.html`) |
| `ctx.api.get/post/put/del(path)` | JSON calls to `/api/ext/<code><path>`; errors become `Error` with the server message, plus `status` and `data` (the JSON body, e.g. `{ code }`) |
| `ctx.api.stream(path, body, onEvent)` | POST answered with SSE (e.g. git actions); resolves with the `exit` code; a non-2xx answer throws with `status` and `data` |
| `ctx.api.events(path, onEvent, onError)` | GET answered with SSE (`EventSource`); returns a function that closes it |
| `ctx.core` | Same client for `/api/core` (e.g. `ctx.core.get('/system')`) |
| `ctx.apiFor(code)` | Same client for another extension's API, `stream` and `events` included (Kelbo ≥ 2.6; e.g. `ctx.apiFor('npm').events('/processes/<id>/stream', …)`) |
| `ctx.hasExtension(code)` | Whether another extension is loaded (for features that rely on it) |
| `ctx.t(key, params)` | Translation of a key of the extension's catalogs (keys are relative: `t('branches.title')` reads `git.branches.title`; keys starting with `core.` are the core's). See *Translations* |
| `ctx.i18n` | `lang` (active tag), `pick(value)` (text of a string-or-map manifest field), `apply(element)` (translates `data-i18n…` attributes in markup the extension creates) |
| `ctx.ui` | `t` (global keys), `fmt` (locale-aware formatting, see *Translations*), `toast`, `openModal`, `closeModal`, `patch(el, html)` (updates a container that is redrawn on its own — polling, `change`, `blur` — only when the HTML changes, and after the click when the mouse is pressed inside it, so a click is never lost because its button was replaced; Kelbo ≥ 2.3), `esc`, `js`, `cssColor`, `extColor(code, color)` (the colour of an extension as CSS: `var(--ext-<code>, <color>)`, so the active theme can replace it; Kelbo ≥ 2.28.1), `ansiToHtml(text, state?)` and `ansiState()` (a state to pass to every chunk of the same stream, so colours and partial escape sequences carry over; `ansiState` Kelbo ≥ 2.28.1), `formatUptime`, `toolNotice(message, installCmd, recheckHandler)`, `contextMenu(x, y, items)` (items: `{ label, icon, action, danger, disabled }` or `'separator'`; `icon` a Lucide name or a short text), `icon(name, { cls, title })` (an inline SVG of the Lucide icon `name`, sized and coloured like the text around it; Kelbo ≥ 2.25), `iconOrText(value)` (Lucide name → icon, anything else escaped text), `badgeHtml(value)`, `notify(title, body, icon)` (desktop notification, if enabled with 🔔), `output` (the panel's output drawer: `open(title)`, `append(text, 'out'\|'err'\|'sys')`, `clear()`, `close()`; the user resizes it by dragging its top edge, and the height is remembered per section) |
| `ctx.bus.on(name, fn)` / `ctx.bus.emit(name, detail)` | Events between extensions; the core emits `core:projects-changed` after any change to projects or folders |
| `ctx.projects` | Projects and folders of the core, see *Projects and folders* |
| `ctx.vault` | `ensure()`: resolves `true` when the master password vault is unlocked, asking for the password (or to create it) first; `isVaultError(err)`: whether an API error is a locked or missing vault (`core.vault_locked`, `core.vault_missing`); `status()` |
| `ctx.expose(obj)` | Publishes functions as `window.Ext.<code>` for inline handlers |
| `ctx.setBadge(value)` | Number or text on the tab or header button, or `{ icon, text }` with a Lucide icon before the text (Kelbo ≥ 2.25); `null` hides it. On an icon-only tab and in the right bar a number is shown small (`99+` above 99) and anything else as a dot, with the full value as tooltip |
| `ctx.setPills(html)` | The extension's pills in the header bar (`''` removes them) |
| `ctx.open(code, params)`, `ctx.isActive()` | Open a section; with `params` (e.g. `{ project }`) the opened module's `focus(params, ctx)` is called after it loads (Kelbo ≥ 2.17); whether this panel is visible |
| `ctx.widgets` | `list(scope)`: widgets of the active extensions (`{ key: "<code>/<id>", code, id, title, description, size, icon, color, extension }`); `mount(key, el, params, { onTitle, onBadge })` → `{ refresh(), unmount() }` — for extensions that show widgets (the dashboard) (Kelbo ≥ 2.17) |

Inline handlers call the functions published with `ctx.expose`, always escaping arguments with `ctx.ui.js(value)` and text with `ctx.ui.esc(value)` — values coming from repositories, `package.json` files or processes may contain quotes and markup.

Requests to `/api/…` started by a click (within 400 ms) put the clicked button on hold automatically: class `ui-busy` (spinner, no further clicks) and a busy cursor until the answer arrives; extensions get it for free with `ctx.api` or `fetch`.

Inside the panel, the sidebar and the pills the CSS variable `--ext-color` holds the extension colour; the `hidden` attribute always hides an element; elements with `data-uptime="<ISO date>"` show an elapsed time that updates every second. Shared classes (`btn`, `sidebar-head`, `sb-item`, `empty-state`, `data-table`, `form-row`, `pill`, `tool-notice`, …) are defined in `public/core/shell.css`.

The header (language, notifications, Export/Import dialogs built from the extensions' checkboxes, 🤖 MCP server, ↻) belongs to the core.

## Widgets

A widget is a **mini view** of what an extension knows about a project, shown by the **Dashboard** section (the built-in `dashboard` extension) next to the widgets of the other extensions. No extension needs to know the others: each declares its widgets in the manifest and the core host mounts them.

```json
"widgets": [
  { "id": "scripts", "title": { "it": "Script npm", "en": "npm scripts" }, "description": { "it": "…", "en": "…" }, "size": "m", "js": "widget.js" }
]
```

`size` is the default width in the dashboard grid (`s` one column of four, `m` two, `l` the whole row); the user can change it, the order and which widgets are shown, per project. The widget module is loaded on demand with the extension's `style.css` and catalogs, without mounting its panel:

```js
export default {
  async mount(ctx, el, { project }) { /* draw into el; project = { id, label, path, folder? } */ },
  async refresh(ctx, el, params) { /* ↻ of the dashboard, the section shown again */ },
  unmount(ctx, el) { /* timers, streams */ },
};
```

The widget `ctx` is the extension's own frontend context — `api`, `apiFor`, `core`, `t` (its catalogs), `i18n`, `ui` (without `output`), `bus`, `projects`, `vault`, `open`, `hasExtension` — with `el` as `root`, plus `ctx.widget`:

| Member | Purpose |
|---|---|
| `setBadge(value)` | Badge next to the widget title: text or `{ icon, text }` (`null` hides it) |
| `setTitle(text)` | Replaces the title of the widget box |
| `openFull(params)` | Opens the extension's section with `params` (e.g. `{ project }`, `{ process }`): the panel module receives them in `focus(params, ctx)` |

Widgets handle their events with `addEventListener` on `el` (not `ctx.expose`, which belongs to the panel), redraw with `ctx.ui.patch` and get the same click feedback as the panels. A widget whose module fails to load or throws in `mount` shows the error in its own box; the other widgets are not touched. Keep widgets light: no long polling (5–15 s at most), no action that opens connections by itself (e.g. a database test through an SSH tunnel waits for a click), and never secret values.

## Icons

Kelbo ships the whole [Lucide](https://lucide.dev/icons) icon set (ISC license) as one SVG sprite in the core, `/core/vendor/lucide/sprite.svg`, so every extension uses the same icons without bundling its own, also offline. Use the icon names of lucide.dev:

- in HTML files and in generated HTML, `<i data-icon="trash-2"></i>`: the core fills it with the icon as soon as the element is in the page (also when added later by `innerHTML` or `ctx.ui.patch`);
- in code, `ctx.ui.icon('trash-2')` returns the `<svg>` string, for templates;
- for context menus and badges just the name: `{ icon: 'trash-2', label, action }`, `ctx.setBadge({ icon: 'play', text: '2' })`;
- the manifest `icon` is a name too.

Icons take the colour and size of the text around them (`currentColor`, about 1.15em): a button in the extension's colour gets an icon in that colour. They are icons, not text: for meaning use a `title` on the button, and keep symbols that belong to a sentence (✓, →) in the translated text. Before Kelbo 2.25 there is no sprite: an extension for older versions keeps emoji.

## Providers

An extension can **provide** the implementation of a named *capability* that another extension uses — a database engine for the Database section, a kind of tunnel for SSH Tunnels — without either depending on the other: the consumer asks the core which implementations are there.

```json
"provides": [{ "capability": "db-engine", "id": "postgres", "title": "PostgreSQL", "handler": "postgres" }]
```

```js
// provider: server.js
module.exports = ctx => ({
  providers: { postgres: { connect(options) { /* … */ }, classify(sql) { /* … */ } } },
});

// consumer: server.js
const engine = ctx.providers('db-engine').find(p => p.id === conn.type)?.impl;
```

- `capability`: lowercase letters, digits and `-`; the consumer documents what an implementation must do (its methods and data).
- `id`: unique for that capability; `title`: a string or a map by language tag, shown to the user.
- `handler`: the key of the object in `instance.providers`. An extension that declares a provider missing from its backend is not loaded (with the reason).
- `ctx.providers()` reads the list at every call: don't keep the implementations in a variable, so a provider switched off or reloaded is never used stale.

### Kinds

The Extensions panel and the catalog tag every extension with its kinds, derived from the manifest — an extension can be more than one:

| Kind | When |
|---|---|
| `component` | it has an interface (`frontend.js`) |
| `provider` | it declares `provides` |
| `theme` | it declares `themes` |

`GET /api/core/extensions` reports them in `kinds`; catalogs list them for each entry (`kinds`, written by the catalog script of kelbo-extensions with `extensionKinds(manifest)` of the test kit).

## Themes

Every colour of the interface is a CSS variable defined on `:root` in the core's `public/core/shell.css`; the values there are the built-in theme, *Kelbo Dark*. A **theme** is a stylesheet that gives those variables other values. Extensions bring themes through the manifest:

```json
"themes": [{ "id": "light", "name": "Kelbo Light", "scheme": "light", "css": "themes/light.css" }]
```

`name` is a string or a map by language tag; `scheme` says whether the theme is light or dark (it sets the browser's `color-scheme`, for scrollbars and native controls, and drives *follow the system*). A theme-only extension needs no `frontend` and no `position`.

The user picks the theme from the palette button in the header; the choice is saved in `config.json` as `layout.theme` — `{ id: "<code>/<theme id>", system, light, dark }`, `id` `""` for the built-in theme — so it travels with the export. With *follow the system* (`system: true`) Kelbo applies the last light or dark theme chosen, following the operating system's setting, and switches live when it changes. A theme whose extension is removed or turned off falls back to the built-in theme. Only the active theme's stylesheet is in the page, and `<html>` carries `data-theme="<code>/<id>"` (`kelbo-dark` for the built-in one).

**Writing a theme.** The stylesheet only sets variables, on `:root[data-theme]` (it then wins over the core's `:root` defaults whatever the loading order): no other selectors, no `url()` or `@import`. It must define all the colour variables of `shell.css` — `themeProblems(cssText)` in the test kit checks exactly that, and `themeTokens()` lists them:

| Variables | Used for |
|---|---|
| `--bg`, `--surface`, `--surface2`, `--border`, `--border-strong`, `--text`, `--muted` | Backgrounds (page, panels, inputs and rows), borders (normal and hovered), text |
| `--accent`, `--on-accent`, `--on-warning` | Default accent; text on coloured buttons and on yellow badges |
| `--danger`, `--success`, `--warning`, `--info`, `--purple`, `--orange`, `--cyan` | Status and secondary colours |
| `--overlay`, `--shadow`, `--hover` | Backdrop behind dialogs, shadows of menus and popovers, hovered rows |
| `--terminal-bg`, `--terminal-text`, `--ansi-<color>`, `--ansi-bright-<color>` | Output panel and logs; the 16 ANSI colours (`black red green yellow blue magenta cyan white`) |
| `--code-keyword`, `--code-string`, `--code-number`, `--code-function`, `--code-key`, `--code-literal`, `--code-comment`, `--code-variable` | Syntax highlighting (SQL, JSON, mongosh, `.env`) |
| `--diff-add`, `--diff-del` | Diffs and merge editor |
| `--http-get`, `--http-post`, `--http-put`, `--http-patch`, `--http-delete`, `--http-other` | HTTP method labels |
| `--graph-0` … `--graph-9` | Lanes of the commit graph |
| `--note-<color>-bg`, `--note-<color>-fg` | Sticky notes (`yellow green blue pink purple gray`) |

A theme can also change an extension's colour with `--ext-<code>` (e.g. `--ext-git: #1a7f37`, for manifest colours too light on a white background): the shell sets `--ext-color` to `var(--ext-<code>, <manifest color>)`.

**Extensions and themes.** Write colours with these variables, never as fixed values: `color: var(--code-string)`, `background: color-mix(in srgb, var(--diff-add) 13%, transparent)`, `box-shadow: 0 8px 24px var(--shadow)`, `color: var(--on-accent)` on a button in `--ext-color`. In JavaScript, put the variable in the style (`style="--m: var(--http-get)"`, SVG `stroke="var(--graph-3)"`), and use `ctx.ui.extColor(code, color)` for the colour of another extension. An extension can define variables of its own on `:root` for things the core has no variable for, with a dark default; themes may override them.

## Translations

The UI is translatable into any language; a language exists when its catalog exists, there is no list of languages in the code. **Italian is the source language**: its catalogs are complete and are the last fallback. English is the first additional language.

Catalogs are flat JSON files with dotted keys. The core's are in `public/core/i18n/<tag>.json` (`tag` is a BCP 47 tag: `it`, `en`, `pt-BR`, `zh-Hant`…) and carry a `_meta` block; an extension's are in `extensions/<code>/i18n/<tag>.json`, where `_meta` is optional and keys are automatically prefixed with the extension `code`:

```json
{
  "_meta": { "name": "Italian", "nativeName": "Italiano", "dir": "ltr" },
  "branches.title": "Branch",
  "branches.ahead": "{count} avanti",
  "commits": { "one": "{count} commit", "other": "{count} commit" }
}
```

- `{name}` is replaced with `params.name`. `{count}` is formatted for the active language (other numbers, such as ports or ids, are inserted as they are: format them with `fmt.number` when they are quantities).
- A value can be an object of plural forms by CLDR category (`zero`, `one`, `two`, `few`, `many`, `other`; only `other` is required), chosen with `Intl.PluralRules` on `params.count`.
- Lookup goes along the chain *active language → its base language (`pt-BR` → `pt`) → Italian → the key itself* (with a console warning), so a partially translated language works. An extension may support a different set of languages from the core, and may ship a language the core lacks (the core falls back to Italian for its own strings).
- Catalogs that fail validation are ignored and reported in the extension's warnings.

**Markup.** In `view.html` and `sidebar.html` use attributes instead of text; the shell translates them when the file is loaded and again when the language changes. Keys are relative to the extension:

```html
<span class="sidebar-head-title" data-i18n="sidebar.title"></span>
<button data-action="reload" data-i18n-title="sidebar.reload">↻</button>
<input data-i18n-placeholder="search.placeholder">
```

`data-i18n` (text), `data-i18n-title`, `data-i18n-placeholder` and `data-i18n-aria-label` are supported. For markup built in `view.js` call `ctx.t()` directly (or `ctx.i18n.apply(element)` on elements that use the attributes).

**Language change.** The user picks the language from the 🌐 button in the header (shown when there is more than one language); the choice is stored in the browser. Without a choice the language comes from `navigator.languages`. The change does not reload the page: the shell re-translates the static markup and calls `languageChanged(ctx)` (or `refresh(ctx)` when it is not defined) on every mounted module, which re-renders its dynamic parts.

**Formatting.** Dates, numbers and durations go through `ctx.ui.fmt`, never formatted by hand: `fmt.date(d, opts)`, `fmt.number(n, opts)`, `fmt.relative(d)` ("3 minutes ago"), `fmt.list(items)`, `fmt.bytes(n)`, `fmt.duration(seconds)`.

**Right-to-left languages.** A catalog with `"dir": "rtl"` sets `<html dir="rtl">`. Write CSS with logical properties (`margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `text-align: start`, `border-inline-start`) instead of left/right.

**Not translated:** the output of external commands (`git`, `npm`, `pm2`, `ssh`) is shown as is.

## Core API

| Route | Purpose |
|---|---|
| `GET /api/core/extensions` | Extensions with manifest data, state, warnings and error |
| `GET /api/core/mcp` · `POST /api/core/mcp/token` | MCP endpoint URL, token and tools of the extensions · regenerate the token |
| `/mcp` | MCP server (Streamable HTTP, bearer token, no browser requests) |
| `GET /api/core/i18n/languages` | Source language and available languages: `{ source, languages: [{ tag, name, nativeName, dir, core, completeness }] }` (`core: false` = only some extension ships it; `completeness` = % of the source keys translated, core and extensions together) |
| `GET /api/core/vault` · `POST /api/core/vault/init`, `/unlock`, `/lock`, `/change`, `/reset`, `/settings` | Master password vault: state (`uninitialized`, `locked`, `unlocked`), lock timeout, minimum length · create, unlock (increasing wait after repeated errors, `429` with `Retry-After`), lock, change the password (every extension's secrets re-encrypted in the same write), reset (`{ confirm: "RESET" }`: vault and secrets deleted), lock timeout in minutes |
| `GET /api/core/extensions-admin` | Extensions panel: every extension with source, lock data (repository, tag, commit), backup and update state; extensions of the imported list not installed (`pending`); catalogs; core version |
| `POST /api/core/extensions-admin/:code/enabled` · `/:code/reload` | Switch an extension off or on (`{ enabled }`) · reload it from disk; both restart the extensions that depend on it and answer `{ restartRequired }` |
| `GET /api/core/extensions-admin/catalog` · `PUT /api/core/extensions-admin/catalogs` | Extensions of the configured catalogs (`?refresh=1`), with the installed ones marked · catalog URLs |
| `POST /api/core/extensions-admin/preview` | `{ source, folder?, tag? }` or `{ code }` of a catalog: shallow, sparse clone in a staging folder; versions, chosen tag, manifest data, compatibility, dependencies, changelog; `id` for the install |
| `POST /api/core/extensions-admin/install` | `{ id }` of a preview; Server-Sent Events `step`, `log`, `done` (`{ code, version, previous, restartRequired, state }`) or `error` |
| `POST /api/core/extensions-admin/:code/update` · `/:code/restore` · `DELETE /api/core/extensions-admin/:code` · `POST /api/core/extensions-admin/updates` | Preview of the newest (or `{ tag }`) version · back to the previous version · remove an installed extension · check the updates now |
| `PUT /api/core/layout/positions/:code` | `{ position: "tab" \| "tab-icon" \| "header" \| "sidebar" \| null }`: where an extension with a UI opens; `null` or the manifest position remove the override |
| `GET /api/core/layout` · `PUT /api/core/layout/tabs` · `DELETE /api/core/layout/tabs` | Tab order chosen by the user (`{ tabs: [codes] }`; unknown codes and codes of header extensions are dropped, duplicates removed) · save it · back to the manifest order |
| `PUT /api/core/layout/rail` · `DELETE /api/core/layout/rail` | Order of the right bar (`{ rail: [codes] }`, only extensions in position `sidebar`), as for the tabs (Kelbo ≥ 2.31) |
| `GET /api/core/system` | Platform and external tools (`?refresh=1` checks again) |
| `GET /api/core/config/sections` | Config sections and their owner |
| `GET /api/core/config/export?sections=a,b&name=x` | Export (download), optionally limited to some sections |
| `POST /api/core/config/import` | Import `{ config, mode }`, per section (keys without an owner are ignored and reported) |

## Publishing an extension

An extension can live in its own git repository, or in a folder of a repository that holds several (like the official `kelbo-extensions`). Users install it from the Extensions panel (catalog or URL) or with `kelbo ext install`:

- **Versions are git tags** in SemVer: `v1.2.0` (or `1.2.0`) for an extension at the root of its repository, `<code>@1.2.0` for an extension in a folder, so every extension of a shared repository has its own versions. The `version` in `setting.json` should match the tag. Without tags the default branch is installed and updates follow its commits.
- **Compatibility**: `kelbo` in the manifest; the panel proposes the latest tag whose range includes the running core.
- **What's new**: a `CHANGELOG.md` in the extension folder with `## [x.y.z]` sections; the preview of an update shows the sections newer than the installed version.
- **Dependencies**: npm packages in the extension's own `package.json` (`dependencies` only; they are installed with `--omit=dev --ignore-scripts`); other extensions in `dependencies` of the manifest (missing required ones are offered for install when a catalog lists them).
- **Config sections** survive updates and removal: reinstalling an extension finds its data again.

A **catalog** is a JSON file served over http(s):

```json
{ "extensions": [
  { "code": "pm2", "name": { "it": "PM2", "en": "PM2" }, "description": "Processi PM2", "repo": "https://github.com/kelbodev/kelbo-extensions.git", "path": "pm2" },
  { "code": "hello", "name": "Hello", "repo": "git@github.com:someone/kelbo-hello.git" }
] }
```

`path` is the folder of the extension in the repository (the root when omitted), so a catalog can point to any repository. Installed extensions are recorded in `~/.kelbo/extensions.lock.json` (repository, folder, tag, version, commit, previous version) and, without the code, in the `extensions.installed` section of `config.json` for the export.

## Dependencies and npm workspaces

The root `package.json` declares `"workspaces": ["extensions/*"]`. An extension that needs npm packages adds its own `package.json`:

```json
{
  "name": "kelbo-ext-db-client",
  "private": true,
  "dependencies": { "mysql2": "^3.11.0" }
}
```

A single `npm install` at the root installs everything into the shared `node_modules` (deduplicating common packages), and the backend uses the packages with a plain `require()`. Extensions without dependencies need no `package.json`.

## Creating an extension

1. Create `extensions/<code>/setting.json` with at least `name`, `code`, `color` and `position`.
2. Backend (if needed): declare the routes in `backend.routes` and write `server.js` returning `handlers` with the same names; use `ctx.lib.validate` and `ConfigError` for input coming from the UI.
3. Configuration (if needed): list the keys in `config`, describe them in `instance.config` and add the `export` checkboxes that should appear in the Export/Import dialogs.
4. Frontend (if needed): `view.html`, optionally `sidebar.html` and `style.css`, and `view.js` with `mount(ctx)`.
5. Texts: write the UI strings in `i18n/it.json` (the source language) and use them with `data-i18n…` attributes and `ctx.t()`; add `i18n/en.json` and any other language.
6. MCP (optional): declare `mcp.tools` and implement them in `instance.mcp` (see *MCP tools*).
7. Restart the server: the log line `Estensioni: …` lists the loaded extensions, and `GET /api/core/extensions` explains why one is disabled.
8. Add tests in `extensions/<code>/tests/` (see *Testing an extension*).

## Testing an extension

Each extension keeps its tests in its own `tests/` folder (`*.test.js`, `node:test`), so it can be removed, moved or published on its own: the core suite (`tests/`) only uses fixture extensions and stays green without any of the built-in ones. The core exports a test kit: built-in extensions require `../../../lib/testkit`, external ones `require('kelbo/testkit')` with Kelbo as a dev dependency (`"kelbo": "github:kelbodev/kelbo#main"`).

| Member | Purpose |
|---|---|
| `startServer(config, opts)` | Starts Kelbo as a separate process on a free port with a temporary `config.json` and a temporary home (`KELBO_HOME`: installed extensions, lock file); resolves `{ port, configPath, home, request(method, path, { body, headers, raw }), readConfig(), stop(), output() }`. `opts.extensions`: folder of the built-in extensions (default the repository's, `null` for none); `opts.install`: extension folders to add to the installed ones (e.g. `[path.join(__dirname, '..')]` for the extension under test); `opts.env`: more environment variables (`DEVDOCK_*` names count as `KELBO_*`; `null` removes a variable) |
| `mcpClient(srv)` | MCP client (official SDK) connected to the instance with its token |
| `tmpDir()`, `freePort()` | Temporary folder, free TCP port |
| `git(cwd, ...args)`, `makeRepo(dir, { scripts })`, `commitFile(dir, name)` | Disposable git repositories with a `package.json` |
| `manifest(code, extra)`, `writeExtension(root, code, files)` | Minimal valid manifest and fixture extensions written to disk |
| `i18nProblems(extDir)` | The translation checks for one extension: catalogs valid and consistent with the source language, keys used in the code present in `i18n/it.json`, no UI text written in the code (exceptions in `tests/i18n-allowlist.txt`); `[]` when everything is fine |
| `parseSse(text)` | Events of a Server-Sent Events response |
| `dbClientTools()` | `{ sqlText, schemaDiff }` of `db-client`, to unit-test a database engine without starting Kelbo (Kelbo ≥ 2.30) |
| `extensionKinds(manifest)` | The kinds of an extension (`component`, `provider`, `theme`) from its manifest, for the scripts that build a catalog (Kelbo ≥ 2.29) |
| `themeTokens()`, `themeProblems(cssText)` | The colour variables a theme must define, and the checks on a theme stylesheet (only `:root…` rules with variables, no `url()`/`@import`, every variable defined); `[]` when it is fine (Kelbo ≥ 2.26) |
| `validateManifest(json)`, `coreVersion()` | The loader's manifest checks (throws with the reason) and the Kelbo version of the kit, for the scripts of an extensions repository (e.g. generating its catalog) |

```js
// extensions/hello/tests/hello.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, i18nProblems } = require('kelbo/testkit'); // built-in: '../../../lib/testkit'

let srv;
before(async () => { srv = await startServer({ projects: [] }, { install: [path.join(__dirname, '..')] }); });
after(() => srv.stop());

test('greets', async () => {
  assert.deepEqual((await srv.request('GET', '/api/ext/hello/greet')).json, { text: 'hello' });
});
test('translations', () => assert.deepEqual(i18nProblems(path.join(__dirname, '..')), []));
```
