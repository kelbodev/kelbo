# Kelbo

Local web dashboard for everyday development: SSH tunnels, npm scripts, Git, databases, `.env` files, an HTTP client and mock servers in a single interface, extended by installable extensions (MongoDB, Swagger preview, PM2, ports in use…).

It runs on your own machine and only answers on `http://127.0.0.1:3500`. The user interface is available in Italian and English, and new languages can be added with JSON files (see *Languages*).

## Requirements

| Tool | Required | Used for |
|---|---|---|
| Node.js ≥ 18 | yes | server |
| `ssh` | for tunnels | `-L` port forwarding (uses the aliases in `~/.ssh/config`) |
| `git` | for the Git section | |
| `autossh` | no | used for tunnels when available; otherwise `ssh` with reconnection handled by Kelbo |
| `pm2` | no | PM2 extension (installable) |
| `lsof` (macOS/Linux) or `ss` (Linux) | no | shows the listening ports of npm processes (and the Ports extension) |
| Firefox with the "Open external links in a container" add-on | no | OAuth logins of the HTTP client in a Firefox container (otherwise the default browser) |

The UI reports missing optional tools and shows how to install them.

## Getting started

```bash
npm install
npm start          # or: npm run dev  (restarts automatically on changes)
```

Then open <http://127.0.0.1:3500>.

Optional environment variables: `KELBO_PORT` (port, default 3500), `KELBO_CONFIG` (configuration path, default `config.json` in the project folder) and `KELBO_HOME` (Kelbo's own folder outside the repository, default `~/.kelbo`: installed extensions, their lock file and backups). The `DEVDOCK_*` names used before 2.13 still work (`KELBO_*` wins when both are set).

**Coming from DevDock (before 2.13)**: nothing to do. At the first start `~/.devdock` is moved to `~/.kelbo` with everything in it — installed extensions (with their npm dependencies), lock file and backups of the previous versions — so the downloaded extensions keep working and keep *previous version*; the move is a single rename, or a copy that is checked before the old folder is deleted, and on any error Kelbo goes on with `~/.devdock` and says why in its log. Nothing moves when `KELBO_HOME`/`DEVDOCK_HOME` is set or when `~/.kelbo` already exists. The MCP token file is renamed too (same token), the addresses of the official extensions repository (`codo82/devdock-extensions` → `kelbodev/kelbo-extensions`) are rewritten in the lock file and in the list of installed extensions, and the `devdock`/`devdock-mcp` commands and `bin/devdock-mcp.js` still work (the Claude Desktop entries already copied keep running).

When the server stops (Ctrl+C, `kill` or closing the terminal), the tunnels and npm processes started by Kelbo are terminated.

## Sections

Each section is an extension (see [Writing an extension](#writing-an-extension)):

- **📊 Dashboard** (`dashboard`) — the widgets of the extensions for one project together. See *Dashboard*.
- **🔗 SSH tunnels** (`tunnels`) — servers grouped by colour; one click opens `ssh -N -L 127.0.0.1:<port>:<remote> <alias>`. Automatic reconnection with backoff (5s → 60s), per-tunnel logs, header pills with "Stop all", desktop notifications. Groups and servers are managed from the ≡ button in the sidebar.
- **📦 NPM** (`npm`) — the projects' `package.json` scripts: run the `package.json` scripts with live logs, restart/stop (the whole process group), listening ports, dependencies with installed version, `npm outdated` and updates. **Tunnels** on a project links it to SSH tunnels: they are started (unless already up) before each of its scripts, the result shown at the top of the script's output; a tunnel that cannot start does not stop the script. The sidebar shows the projects with a `package.json` (see *Projects*).
- **🌿 Git** (`git`) — repositories derived from the projects (walking up to the `.git` folder). Status, file selection and commit, **diff** of each changed file against the last commit (± on the file: side by side or unified, changed words highlighted, three lines of context or the whole file, previous/next file; ↺ next to each change brings just that change back to the last commit, **Discard all changes** the whole file after a confirmation — a new untracked file is deleted), **merge editor** for the files in conflict (each conflict with *ours* and *theirs* side by side and the common ancestor when available, choose ours / theirs / both / neither, or edit the result by hand; saved and added with `git add`, then the next file in conflict; files deleted on one side or binary: keep one version or delete), commit graph with branch legend; a click on a commit shows its message and the files it changed against the previous commit, each opening the same diff read-only (previous/next file of the commit), pull/push/merge/checkout/stash/fetch. Branch panel on the branch badge: search, local and remote branches, switch (with "stash and switch" when there are uncommitted changes, `--track` for remote branches), new branch from any start point, merge with a preview of incoming commits and files (fast-forward, `--no-ff`, `--squash`) and conflict handling (abort / conclude), deletion of local branches (unmerged ones only after confirmation). Only one git operation at a time runs on each repository.
- **🗄️ Database** (`db-client`) — database client; every database is an **engine** extension: MySQL/MariaDB is built in (`db-mysql`), the others are installed from the catalog. Connections (direct or through an SSH tunnel of the Tunnels section) with passwords encrypted by a **master password** asked once per session; sidebar tree connection ▸ database ▸ tables ▸ fields, indexes and foreign keys (fields open, the other two folders closed until opened) with a context menu on tables and on columns (copy the name, distinct values) and a double click on a table to open its data, with connections grouped in **folders** of their own (one level; 📁+ to create one, the Folder field of the connection to move it, ⋯ or right click on a folder to rename or delete it); **query tabs**, each with its own connection and database (chosen from those open in the sidebar), editor and results: ＋ opens a new one, right click closes it, the others or those to its right/left, and the actions on a table in the tree (first rows, count, data, structure, alter…) open in a new tab, or in the one that already shows the same query; SQL editor with highlighting that runs the selection, if there is one, or the whole text, also **several statements** separated by `;` (run in order on the same session, stopping at the first error, with one confirmation for the whole group when any of them changes data or schema; every SELECT gets its own result tab, and an *Execution* tab lists the outcome of each statement — rows, rows affected, error) and **parametric queries** (`?` and `:name` placeholders: a dialog asks for the values, with the names of the `?` guessed from the query where possible, e.g. `nome = ?`, `id IN (?, ?)`, `BETWEEN ? AND ?`, `LIMIT ?`, `INSERT … VALUES (?, ?)`; values are escaped into the statement and kept in Kelbo's memory until it restarts (never on disk or in the browser): a query already run runs again at once with its values, shown above the results with **✎ Change** to edit them; a new query asks, prefilled with the last values of the same names; the values can also be pasted as an object, `{ site_id: 15, level: 'site', vector_id: null }`, and fill the fields by name); data browser with pagination, search, filters and sorting; row insert/edit/delete inline or through a dialog, multiple deletion; several cells, also of different rows, can be edited before saving (changed cells are highlighted, Tab moves to the next cell, Enter or **Save** writes them all with one confirmation and in a single transaction), in the table data view and in the editable results of a SELECT; table designer; the total rows of a SELECT without limits next to the rows shown; export of tables and queries as CSV, JSON or SQL; session query history. **Every statement that changes data or schema is shown and must be confirmed before it runs**; read-only connections refuse them.
- **🔑 Env** (`env`) — the `.env*` files of each project compared with the template (`.env.example`, `.env.sample`…): keys missing, extra or empty. Values are hidden and shown one at a time; edit, add, rename or delete keys, add the missing keys from the template, create a `.env` from the template. Files are rewritten keeping comments, blank lines and order; a file changed outside Kelbo in the meantime is not overwritten. Values never go into the Kelbo configuration, its exports or the MCP tools.
- **📮 HTTP** (`http-client`) — HTTP client for the projects' local APIs: sections of requests with a base URL and variables, requests sent by the Kelbo backend (no CORS limits), Express routes found in the code of the linked project, an authorization per user type with the token obtained automatically. See *HTTP client*.
- **🎭 Mock** (`mock-server`) — local mock servers that answer with predefined responses and log every incoming call with its payload; a pill in the header for every running mock (click to open it, ✕ to stop it). See *Mock server*.

The section tabs can be put in any order by dragging them (or with Alt+←/→ on a focused tab); the order is saved in `config.json` and the first tab is the one opened at startup. Right click on the tab bar → *Restore the default order*. New extensions go after the others.

The header also holds the **📁 Projects** panel (see *Projects*), the language (🌐), desktop notifications (🔔), **Export**/**Import** of the configuration, the MCP server (🤖) and ↻ to refresh. The sidebar can be resized by dragging its edge (or with ←/→ when the edge is focused; double click restores the initial width); each section has its own width, remembered by the browser. The output panel at the bottom (npm scripts, git actions…) is resized the same way, from its top edge (↑/↓ when focused, double click for the initial height), with its own height per section.

## Projects

Projects are folders on disk shared by every section (NPM, Git, Env, Dashboard, the database connections and HTTP sections linked to a project…). They are managed in one place, the **📁 Projects** panel in the header; the sidebars of the sections only choose one, and each section keeps its own choice.

- **List**: projects grouped by **folder** (one level), with search by name, id or path; a project whose folder no longer exists on disk is marked.
- **Traits**: what each project is, detected in its folder — *Git* (inside a repository), *Node.js* (`package.json`), *.env* (`.env*` files), plus the traits of the installed extensions (e.g. a framework detected from a file or a dependency in `package.json`). Each section shows only the projects it makes sense for: NPM those with Node.js, Git those in a repository, Env those with `.env` files (the others are counted at the bottom of the sidebar). In the project form each trait can be left *Automatic* or forced to *Always* / *Never*; the choice is saved with the project.
- **Add, edit, remove**: name, absolute path, folder and traits; the id never changes. Before a project is removed the panel lists what the extensions link to it (database connections, HTTP sections, the dashboard layout, notes…): those stay, unlinked.
- **Import from a folder**: give a folder (e.g. `~/www`) and the panel lists it and its direct subfolders that have at least one trait, with their traits; those already added are marked. Choose them with the checkboxes and add them in one go, optionally into a folder.

## Dashboard

The **📊 Dashboard** section (the first tab of a new installation) puts together, for the project chosen in its sidebar, the **widgets** of the extensions — small views of what each one knows about that project:

| Widget | Shows | Actions |
|---|---|---|
| **npm scripts** | running processes with their ports and uptime; the scripts run most (Kelbo counts the runs on this computer, in `~/.kelbo/data/npm`, not in `config.json`) | ▶ run, ■ stop, ↻ restart, ≡ the output in the NPM section |
| **Git** | branch, ahead/behind, changed files, last commits | fetch, pull, push — the push first lists the commits it will send and asks to confirm |
| **Database** | connections linked to the project (their *Project* field): the connection test, the migrations folder (how many, the last one, repeated numbers) | ↻ test, open in the Database section; connections through an SSH tunnel are tested only on ↻ (the test opens the tunnel) |
| **.env files** | missing and empty keys compared with the template, never the values | ＋ add the missing keys |
| **HTTP requests** | requests of the sections linked to the project, with the status of the last answer | ▶ send (user type, token and variables as in the editor), open the request |
| **SSH tunnels** | tunnels used by the project's database connections | connect, disconnect |
| **MongoDB**, **Ports in use**, **To-dos and notes** | from the installed extensions `mongo-client`, `ports` and `notes` (open items to check or add, last notes) | |

Each widget has a header with its badge, ↗ to open the extension's section on the project and ⋯ for its size (small, medium, whole row), refresh and remove. **＋ Widget** adds one of those not shown, the widgets are reordered by dragging their header, and the choice is saved per project in `config.json` (section `dashboards`, *Dashboard* export checkbox); until something is changed a project shows all the widgets, and **All widgets** goes back to that. A widget that fails shows its error in its own box without affecting the others. Extensions add widgets with a `widgets` block in their manifest (see [docs/EXTENSIONS.md](docs/EXTENSIONS.md#widgets)).

## Database client

- **Master password**: the first time you open the Database section (or another section that saves secrets, such as the HTTP client) you create it (at least 10 characters). It belongs to Kelbo itself, not to one section: it encrypts the stored database passwords and the secrets of the other extensions (scrypt + AES-256-GCM) and is never saved: only a verifier is kept in `config.json`. The key stays in the server's memory until you lock it (🔒), restart Kelbo or after the inactivity timeout (30 minutes by default). Changing it re-encrypts every secret; if you forget it, the stored secrets are deleted and must be entered again, while connections and the rest of the configuration remain.
- **Connections** can point to a host and port, or to a server of the Tunnels section (only if that extension is active): the tunnel is started when needed.
- **Confirmations**: reads (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`) run immediately; anything else — `INSERT`, `UPDATE`, `DELETE`, DDL, unknown statements — is shown in a confirmation dialog with the exact SQL and runs only after you confirm it. The same applies to rows edited in the data browser and to tables created with the designer.
- **Table designer**: create a table (database context menu or ＋ Tabella) or change an existing one (table context menu → *Edit structure*): columns with type, length, default, NULL, auto increment, position (↑ ↓), renames, primary key, indexes, foreign keys, engine and comment. The changes are applied together after a preview of the SQL; changes that may lose data (dropped columns or tables, narrower types) need an explicit confirmation.
- **Moving connections**: export them with the "Connessioni database" checkbox (passwords travel encrypted together with the vault). On a machine with a different master password, import them from the Database section (⤒) entering the file's master password: they are re-encrypted with yours.

## DB migrations

A connection can be linked to a **migrations folder in a repository** (📁 Migrations in the connection header): choose the repository (the Git extension's repositories, or the projects when Git is not active) and browse to the folder, or create it. From then on every structural change made through Kelbo is written as a migration in that folder before it is applied to the database. With **💾 Save migration only** in the confirmation dialog the file is written but nothing runs on the database, so the project's own migration tool can apply it: right after, Kelbo offers to run an npm script of the project (e.g. `npm run migrate`, remembered per connection; the NPM extension must be active) and shows its output; when it ends you can close, run it again or, coming from the table designer, go back to editing the table with its structure read again from the database — and so on: change → migration → run → change.

- **File format**: one SQL file per migration, `NNN_<table>_<operation>.sql` — for example `003_orders_add_status.sql` or `004_orders_alter.sql`. `NNN` is an incremental number with at least 3 digits (more when the folder already uses more); an empty folder starts at `001`. The file contains a short header comment (file, connection, database, date) and the statements, exactly as they run on the database.
- **Numbering**: the next number follows the highest one among the files in the folder. It is computed again right before writing and a file is never overwritten.
- **Where changes come from**: the table designer (new tables and *Edit structure* on existing ones) and `CREATE` / `ALTER` / `RENAME` / `DROP` statements typed in the SQL editor (*Save as migration…* in the confirmation dialog). Before applying, a dialog shows the SQL and the migration file; table and operation in the file name are proposed and can be changed. If a statement fails, the file is removed (or reduced to the statements that did run). Data changes (`INSERT` / `UPDATE` / `DELETE`) never produce migrations.
- Nothing is committed automatically: review and commit the files from the Git section.

## HTTP client

- **Sections**: a section groups the requests of one API (sidebar accordion; ⋯ or right click for its menu). It has a **base URL** used as `{{baseUrl}}` (proposed from `PORT` in the `.env` of the linked project), **variables** used as `{{name}}` or `:name` (as in Express routes, e.g. `/users/:id`) in URL, query, headers and body — `:name` only for a defined variable and not right after a letter, digit or `:`, so `http://`, `localhost:3000`, `user:pass` or `10:30` stay as they are, while a `:name` left in the URL path stops the request with a clear error — and it can be linked to a project. Requests are saved explicitly (**Save** or Ctrl+S; Enter in the URL or Ctrl+Enter sends).
- **Sending**: requests go through the Kelbo backend, with a 30 s timeout and a 5 MB response limit (larger responses are truncated); redirects are not followed. The response shows status, time, size, headers and body (JSON formatted and highlighted; binary content only by size).
- **Express routes** (*Express routes of the project…* in the section menu): static analysis of the linked project, starting from `main` of `package.json` or the start script. Relative `require`/`import` (JS and TS) are followed and the prefixes of `app.use`/`router.use` are composed across files, constants, template strings, factories (`require('./routes')(app)`, functions that return a router) included. Prefixes that can't be resolved (environment or config values, routers loaded with `readdirSync`) are shown as `«expression»` and marked *to complete*: they are edited when the route is imported. Routes are imported one at a time as requests on `{{baseUrl}}`; the list can be filtered by text (path, file, method), by method and to the routes not imported yet. NestJS, Fastify and Koa are not supported.
- **User types** (👤 Users): every request is sent with a user type (e.g. admin, customer) or without authorization. Methods: **none**; **basic auth**; **pasted token** (with an optional expiry); **token from a login request** (method, URL, body with `{{username}}`/`{{password}}`, path of the token in the JSON response or `header:<name>`, optional lifetime path); **OAuth / OpenID Connect** (issuer with endpoints read from `/.well-known/openid-configuration`, or endpoints by hand; client id, scope, flow: authorization code with PKCE, code with client secret, or implicit; redirect URI registered in the client). Header name and format are configurable (default `Authorization: Bearer {token}`).
- **Sidebar**: each section shows its user types and, under each one, the requests sent with it (section ▸ user ▸ requests), plus *No authorization* for the others; ＋ on a user creates a request for it, and a request moves under another user from its context menu or by changing the user in the editor.
- **Body editor** (JSON and text): highlighting of keys, strings, numbers, literals and `{{name}}`/`:name` variables, like the SQL editor of the Database section; **Tab** indents (also several selected lines), **Shift+Tab** outdents, **Enter** keeps the indentation (one more level after `{` or `[`, the closing bracket on its own line between `{}`), `}`/`]` at the start of a line go back one level, Ctrl+Z undoes; for JSON, *valid* or the line and column of the first syntax error as you type, and **Format** that keeps unquoted variables (`"id": {{id}}`).
- **Files**: the body can be a **file** sent as it is (Content-Type from its extension) or a **multipart form** with text and file fields; files are given by path, absolute or relative to the project linked to the section, and read when the request is sent (up to 50 MB), so a saved request keeps working. JSON answers are shown as a **collapsible tree** (▾ per object/array, Alt+click for everything inside, Expand/Collapse all), with **Copy formatted** and **Copy minified**; large numbers keep all their digits. **Binary answers** (PDF, images, archives…) are saved at once to the browser's Downloads, named after `Content-Disposition` or, without it, after the Content-Type (`response.pdf`), with *Download again* (up to 50 MB; text answers are still shown up to 5 MB).
- **npm output**: when the section is linked to a project and the NPM extension is installed, the 📟 menu in the editor shows the output of that project's npm scripts (`npm start`, `dev`, …) in the bottom panel, live, while you send requests. `start` is followed by default when it is running; the choice (another script or none) is remembered per section, and the menu refreshes its list when opened.
- **Tokens**: on send the token of the user type is used while it is valid (JWT `exp`, the lifetime of the response or the manual expiry; 30 s margin), otherwise it is obtained again and the request continues: the login request is repeated, the OAuth refresh token is used, or the OAuth login opens in the browser and the request waits for it (up to 5 minutes; a link to the login page is shown in case the browser does not open). Kelbo listens on the redirect URI port only during the login. With a **Firefox container** set on the user type, the login opens in that container (`ext+container:` URL of the "Open external links in a container" add-on), so different users stay logged in side by side. Tokens and refresh tokens are kept only in memory: they are lost when Kelbo restarts. **Forget token**, next to the user type in the request editor (or in the 👤 Users dialog), drops the token of that user type so the next send obtains a new one.
- **Actions after the token**: up to 5 requests run right after a token is obtained, with the new token in the header (e.g. choose the tenant, get a CSRF token). Values are extracted from their responses (JSON path or `header:<name>`) into variables of the user type, used as `{{name}}` in its requests; a variable called `token` replaces the token (e.g. a second token obtained through an exchange). If an action fails the token is not kept.
- **Secrets** (basic auth and login passwords, OAuth client secret) are encrypted with Kelbo's master password and never saved in clear. The 👤 Users dialog opens only with the master password (asked, or created the first time): user types, passwords, pasted tokens and logins all need it, and the tokens kept in memory are forgotten when the vault is locked; changing the master password re-encrypts them and resetting it deletes them. The **HTTP requests** checkbox exports sections, requests, variables and user types, with the secrets still encrypted.

## Mock server

- **Mock servers**: each one has a name and a port and listens on `127.0.0.1` only; start/stop from the sidebar (▶ ■) or the panel, with the status shown in the sidebar and the number of running mocks on the tab. A port already in use is reported with the process that holds it. Running mocks stop when Kelbo stops; changing the port of a running mock restarts it on the new one.
- **Routes**: method (or *Any*), path with parameters (`/users/:id`) and the `*` wildcard (`/api/*`), status, response headers, body (JSON, text or none) and an optional delay. The first matching route in list order answers (↑ ↓ to reorder; `GET` routes also answer `HEAD`); a call without a match gets a `404` with a JSON body that says so. Routes are edited while the mock is running, without restarting it.
- **CORS** (on by default): `Access-Control-Allow-*` headers on every response and an automatic `204` answer to preflight `OPTIONS` requests, so a frontend on another local port can call the mock.
- **Calls**: every incoming call is logged live — time, method, path, query, headers, body (JSON formatted, text, or only the size for binary content; bodies over 64 KB are truncated), the route that answered (or *no route*) and the status. The latest 500 calls per mock are kept in memory (also after the mock stops, until **Clear** or a restart of Kelbo). **Create route from this call** on a call without a route opens the route editor with its method and path, ready for the response.
- The **Mock servers** export checkbox exports mocks and routes (not the call log).

## MCP server

Kelbo is also an **MCP server**, so AI agents (Claude Code, Claude Desktop, any MCP client) can look at your development environment: tunnels, PM2 processes, Git repositories, npm projects and databases. Click 🤖 in the header for the endpoint, the token and ready-to-copy setup:

```bash
claude mcp add --transport http kelbo http://127.0.0.1:3500/mcp --header "Authorization: Bearer <token>"
```

Clients that start MCP servers as processes (Claude Desktop and similar) use Kelbo's **stdio bridge**, `bin/kelbo-mcp.js` (also `kelbo mcp`, or `kelbo-mcp` after `npm link`). The 🤖 dialog gives the ready-to-copy `claude_desktop_config.json` entry, with the absolute paths of Node.js and of the bridge:

```json
{ "mcpServers": { "kelbo": { "command": "/usr/local/bin/node", "args": ["/path/to/kelbo/bin/kelbo-mcp.js"] } } }
```

The bridge reads the port and the token of the instance by itself (the same `KELBO_PORT` and `KELBO_CONFIG` as the server, added to the entry as `env` only when they are not the default ones), so the client configuration holds no secret and keeps working after the token is regenerated; when Kelbo is not running the client gets a clear error. Copy the entry again if you update Node.js or move the Kelbo folder.

- **What an agent can do**: read tunnels and their status, which `.env` keys are missing (never the values), Git repositories (branch, ahead/behind, status, log), npm projects and scripts, the output of npm processes; **start and stop npm scripts**; on databases list connections (without credentials), databases, tables and table structures, and run read-only queries (row limit, run in a `READ ONLY` transaction); list the mock servers and read the calls they received (credential headers such as `Authorization`, `Cookie` and API keys are redacted). Installed extensions add their own tools (PM2 processes and logs, listening ports…). Nothing else changes state.
- **Databases need the vault unlocked from the Kelbo UI**: the master password never goes through the agent. When the vault is locked the tools answer with a clear error asking you to unlock it.
- **Access**: only on `127.0.0.1`, with a bearer token generated on first start and stored in `.kelbo-mcp-token` next to `config.json` (not exported, regenerable from the 🤖 dialog). Requests coming from a browser are rejected.
- Tool names are prefixed with the extension (`git_status`, `npm_run`, `db_client_query`); errors carry the same codes as the API.

## Extensions

Every section of Kelbo is an extension. Some are **built in** (they come with Kelbo and are updated with it); others are **installed** from git repositories into `~/.kelbo/extensions`.

The official extensions live in [kelbo-extensions](https://github.com/kelbodev/kelbo-extensions), whose catalog is the default one of the panel:

- **⚙️ PM2** (`pm2`) — process list, start/stop/restart/delete, streaming logs; npm scripts can be started under PM2 from the NPM section. Opened from a header button.
- **🔌 Ports** (`ports`) — listening TCP ports of the machine with process, PID, user and command line, linked to what Kelbo started (npm script, PM2 process, SSH tunnel); search, "only my processes" filter, and stop of the process that holds a port after a confirmation (**Stop** or **Force stop**). macOS/Linux (`lsof` or `ss`) and Windows (`netstat`).
- **🍃 MongoDB** (`mongo-client`) — the Database section for MongoDB: connections by host, `mongodb://`/`mongodb+srv://` URI or SSH tunnel, grouped in folders, with passwords in the master password vault (import from a file with another master password); tree connection ▸ databases ▸ collections with a filter; editor in mongosh syntax with suggestions and session history; documents as JSON or table with filter, sort, projection, pages and inline edit of several documents; every insert, update, delete, index or collection change is shown and confirmed, and refused on read-only connections; new collections with JSON Schema validation, indexes, structure (statistics and inferred schema); export as JSON, CSV or mongosh script; read-only MCP tools.
- **📝 Notes** (`notes`) — to-do lists and sticky notes per project (plus *General*), encrypted with the master password, on one board where they are dragged and resized freely: several lists per project with items to check, reorder and clear when done, the open items on the tab; coloured notes saved automatically.
- **📄 Swagger** (`swagger`) — preview of an OpenAPI `.yaml`/`.json` file loaded from disk (Swagger UI from CDN).

PM2 and Ports were built in up to Kelbo 1.23, Swagger up to 2.0: after updating, install them from the 🧩 panel (catalog) or with `npm run ext -- install <code>` (`pm2`, `ports`, `swagger`, `mongo-client`, `notes`). The 🧩 button in the header opens the Extensions panel:

- **Installed**: every extension with version, source and state; the **Tab / Header** selector moves an extension between the section bar and a button in the header (the manifest gives the default); the switch turns one off or on (also the built-in ones; those that require it are switched off too), and installed ones can be **updated**, taken back to the **previous version** (kept after every update) or **removed**. The badge on 🧩 counts the available updates and the extensions to install.
- **Catalog**: the extensions listed by the configured catalogs (the official `kelbo-extensions` catalog by default), with a search.
- **From URL**: any git repository (GitHub, GitLab, a company server, a local folder), with an optional folder for repositories that hold several extensions (`…/tools.git#path=my-extension`). Private repositories work with your own git credentials (SSH keys, credential helper).
- **Catalogs**: the list of catalog URLs.

Versions are the semver tags of the repository (`v1.2.0` for an extension at the root, `<code>@1.2.0` for one in a folder); the latest one compatible with this Kelbo is proposed. Before anything is installed a **preview** shows name, version, compatible Kelbo versions, dependencies (missing ones can be installed first), what's new (the repository's CHANGELOG) and a reminder that an extension runs with all your rights. The install downloads only the extension's folder, installs its npm dependencies without running scripts, and loads it **without restarting Kelbo** (the other sections, tunnels and npm processes keep running); progress is shown live and a failure leaves nothing behind. Updates are checked at start-up, once a day and on demand; a tag that now points to another commit is reported. The configuration of an extension stays in `config.json` across updates and removals.

The **Installed extensions** export checkbox exports the list (source and tag, no code): on another machine the imported list appears in the panel as *To install*, each with its preview.

From the command line (`npm run ext -- <command>` or `kelbo ext <command>` when Kelbo is installed globally): `list`, `install <url|code> [--path folder] [--tag tag] [--yes]`, `update <code>`, `remove <code>`, `check`. With Kelbo running the change is loaded at once; otherwise it applies at the next start.

## Configuration

Everything is stored in `config.json` in the project folder. The file is created empty on first start and is excluded from git because it contains personal hosts and paths.

```json
{
  "groups": [
    { "key": "staging", "label": "Staging", "color": "#3b82f6", "servers": ["staging_db"] }
  ],
  "servers": [
    { "key": "staging_db", "label": "Staging DB", "port": 33060, "remote": "10.0.0.5:3306", "alias": "bastion-staging", "type": "MySQL" }
  ],
  "projectFolders": [
    { "id": "f1a2b3c4", "label": "Customers" }
  ],
  "projects": [
    { "id": "my_app", "label": "My App", "path": "/Users/me/www/my-app", "folder": "f1a2b3c4" }
  ]
}
```

- `servers[].port` — local port on `127.0.0.1`
- `servers[].remote` — `host:port` reached from the SSH server
- `servers[].alias` — host or alias from `~/.ssh/config` (authentication is ssh's own: keys, agent)
- `projects[].path` — absolute path of the project folder
- `projects[].folder` — optional sidebar folder (`projectFolders[].id`); without it the project is at the root of the sidebars

Each key belongs to the core (`projects` and `projectFolders`, shared by NPM, Git and Env; `layout`, the order and place of the tabs and the color theme; `vault`, the master password; `extensions`, switched-off extensions, catalogs and the list of installed ones) or to an extension (`dashboards` to dashboard, `npmTunnels` to npm, `groups` and `servers` to tunnels, `dbConnections` and `dbFolders` to db-client, `httpSections` to http-client, `mockServers` to mock-server), which validates it on every save. **Export** offers the checkboxes of the core (Progetti e cartelle, Estensioni installate) and of the extensions (Dashboard, Tunnel dei progetti npm, Tunnel SSH, Connessioni database, Richieste HTTP, Mock server) and downloads one `.json` file; **Import** shows the checkboxes found in the file and lets you *merge* (add new items) or *replace* (overwrite those sections). Anything not selected is left untouched.

## Themes

Kelbo comes with one color theme, *Kelbo Dark*. Other themes are extensions: from the Extensions panel install **Light theme** (*Kelbo Light*) or **Dim theme** (*Kelbo Dim*, a softer dark) from the official catalog, then pick one from the palette button in the header. *Follow the system* switches between the last light and the last dark theme chosen together with the operating system. The choice is saved in `config.json` (`layout.theme`), so it travels with the export. Every color of the interface — extensions, command output, syntax highlighting, diffs, the commit graph, the notes — comes from the theme; how to write one is in [docs/EXTENSIONS.md](docs/EXTENSIONS.md#themes).

## Languages

Kelbo starts in the browser's language when it has a catalog for it (a regional variant such as `pt-BR` falls back to `pt`), otherwise in Italian. The 🌐 button in the header switches language without reloading the page; the choice is remembered by the browser. Dates, numbers, sizes and durations follow the selected language. Output of external commands (`git`, `npm`, `pm2`, `ssh`, MySQL) is shown as it is.

Languages are not listed anywhere in the code: a language exists when its catalog exists. Italian is the source language (always complete, and the fallback for any missing text). To add a language, for example German (`de`):

1. Copy `public/core/i18n/it.json` to `public/core/i18n/de.json` and translate the values (keep the keys and the `{placeholders}`); set `_meta`: `{ "name": "German", "nativeName": "Deutsch", "dir": "ltr" }` (`"rtl"` for right-to-left languages).
2. For each extension, copy `extensions/<code>/i18n/it.json` to `de.json` and translate it.
3. Plurals are objects with the forms the language needs (`zero`, `one`, `two`, `few`, `many`, `other`; `other` is required): `{ "one": "{count} Datei", "other": "{count} Dateien" }`.
4. Run `npm run i18n:report -- de` to see the completeness and the missing keys, and `npm test` to check the catalogs (stale keys, placeholders, plural forms). Missing keys are allowed: they fall back to Italian.
5. Restart Kelbo: the language appears in the 🌐 menu with its completeness.

## Security

Kelbo is meant **for local use only**: it listens on `127.0.0.1` and has no authentication. It can run `ssh`, `npm`, `git` and `pm2` on your machine, so it must not be exposed on a network.

Active protections:
- the API only accepts requests from its own UI (`Origin`/`Referer` and `Host` checks), so other pages open in the browser cannot use it;
- every parameter that ends up in a command (branch, remote, file, script, package, SSH alias) is validated;
- `config.json` is validated on every save and import;
- external libraries (e.g. Swagger UI in the Swagger extension) are loaded with Subresource Integrity;
- installed extensions run with your rights: the panel shows a preview of what is installed and warns about it, git runs without terminal prompts and with the `ext::` protocol off, npm dependencies are installed with `--ignore-scripts`.

Local command-line clients (curl, scripts) that send no `Origin` header are allowed, like any other local program.

The HTTP client sends requests from the Kelbo backend to the URLs you enter (http and https only); during an OAuth login it listens for the redirect on `127.0.0.1` (and `::1`), only on the port of the redirect URI and only until the login ends. Mock servers listen on `127.0.0.1` only, on the ports you choose, and answer any local caller (that is their purpose, CORS included); their calls are kept in memory only.

## Project structure

```
server.js            entry point: security middleware, extension loader, core API, startup
lib/                 core services: config by section, extension loader, security, test kit,
                     validators, external tools, port detection, SSE, MCP server
routes/core.js       core API (/api/core): extensions, system, config export/import
public/              UI shell: index.html, core/shell.js (navigation, header, dialogs),
                     core/ui.js (shared helpers), core/i18n.js (translations and
                     formatting), core/i18n/<lang>.json (core catalogs), core/shell.css
extensions/<code>/   one folder per feature: setting.json, server.js, view.html,
                     sidebar.html, view.js, style.css, i18n/<lang>.json, tests/
scripts/             i18n-report.js (translation completeness)
tests/               core tests (node:test, fixture extensions only)
docs/EXTENSIONS.md   extension contract
```

## Writing an extension

1. Create `extensions/<code>/setting.json` with name, code, colour and position (tab or header button).
2. Declare the API in `backend.routes` and implement the handlers in `server.js`; they are served under `/api/ext/<code>`.
3. Declare the `config.json` keys the extension owns (`config`) and the checkboxes it adds to the Export/Import dialogs (`export`).
4. Add `view.html`, `sidebar.html`, `view.js` and `style.css` for the UI, with the texts in `i18n/it.json` (and `i18n/en.json`), used through `data-i18n` attributes and `ctx.t()`.
5. Restart Kelbo: the startup log lists the loaded extensions, and `GET /api/core/extensions` explains why one was disabled.

The full contract — manifest fields, the `ctx` objects given to backend and frontend, configuration sections, dependencies between extensions, npm workspaces — is in [docs/EXTENSIONS.md](docs/EXTENSIONS.md).

## Development

```bash
npm test           # core tests (tests/) and each extension's (extensions/<code>/tests/): every file starts Kelbo with a temporary config
npm run dev        # restarts on backend changes
npm run i18n:report  # translation completeness per language and extension
```

Roadmap and progress: [ROADMAP.md](ROADMAP.md) · Changes: [CHANGELOG.md](CHANGELOG.md)

## Credits

Icons: [Lucide](https://lucide.dev) (ISC license), bundled in `public/core/vendor/lucide/`.

## License

Copyright 2026 The Kelbo authors. Licensed under the [Apache License, Version 2.0](LICENSE).
