# Changelog

All notable changes to Kelbo (formerly DevDock) are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). Every closed milestone of the [roadmap](ROADMAP.md) is a minor version. Milestone numbers up to 2.1.0 refer to the archived [roadmap history](docs/ROADMAP-HISTORY.md); the current roadmap starts again from M1.

## [Unreleased]

## [2.22.0] - 2026-11-03

### Added
- **Git: diff of a changed file** against the last commit (± on the file in the changes list): side by side or unified (the choice is remembered), the changed part of a line highlighted, three lines of context or **Whole file**, previous/next changed file, added and removed lines counted. New files show all their lines as added; binary files are only reported. Backend `GET …/repos/:id/diff?file=&context=` (only files listed by `git status`, at most 2 MB of diff).
- **Git: merge editor** for the files in conflict (**Resolve** on the file or in the merge banner): every conflict with *ours* (current branch) and *theirs* (the branch being merged) side by side, plus the common ancestor when git wrote it; per conflict **Ours**, **Theirs**, **Both**, **Both (theirs first)** or **Neither**, or all at once; the result is shown and can be edited by hand. **Save and mark resolved** writes the file (refused while it still has conflict markers), runs `git add` and opens the next file in conflict. Files deleted on one side, binary or larger than 5 MB: keep ours, keep theirs or delete the file. Backend `GET`/`POST …/repos/:id/conflict` (base, ours and theirs from the index stages; only files in conflict).

## [2.21.0] - 2026-11-03

### Added
- **Database: npm script after *Save migration only*.** Once the migration file is written, a dialog offers to run an npm script of the project the migrations folder belongs to (or the connection's project) — e.g. `npm run migrate`, chosen from its `package.json` and remembered per connection — and shows its output live (colours included), with **Stop** while it runs. When it ends: **Close**, **Run again** or, when the change came from the table designer, **Back to editing the table**, which reopens the designer with the structure read again from the database, for the next change → migration → run cycle. Shown only when the NPM extension is active and the project has scripts; the process is a normal NPM process (header pill, NPM section).

## [2.20.0] - 2026-11-03

### Added
- **Database: several statements at once.** The editor runs the selection, if there is one, otherwise the whole text, now also with several statements separated by `;` (outside strings, quoted names and comments). They run in order on the same connection — session variables, temporary tables and `START TRANSACTION … COMMIT` carry over — each in autocommit, stopping at the first error. When any of them changes data or schema the whole text is shown and confirmed once (the confirmation lists the verbs and how many statements change something); read-only connections refuse it. Each SELECT gets its own result tab under the query tab (rows, total without limits, sort and inline edit as for a single query); the **Execution** tab lists every statement with its outcome — rows, rows affected, error — and how many were not run after an error. At most 100 statements per run; compound statements (`BEGIN … END` of procedures and triggers, `DELIMITER`) are not split correctly. The MCP `query` tool still takes one statement.
- Session history: a run of several statements is shown with how many there were.

### Changed
- db-client tests run on MariaDB too (datadir created with `mariadb-install-db`); the three tests that check MySQL-specific types and values are skipped there.

## [2.19.0] - 2026-11-02

### Added
- **Traits confirmed by the extension**: a manifest trait can declare `detect: true`; the extension's backend then decides with `detectTrait(id, dir)` whether the project really has it, after the quick check on `files`/`dependencies` (e.g. the Scripts extension counts a `scripts` folder only when it holds a script that can run on this computer). Contract in `docs/EXTENSIONS.md` (additive; Kelbo 2.18 ignores the field).

### Changed
- `GET /api/core/projects`: the known `traits` carry only `id`, `label` and `source`.

## [2.18.0] - 2026-11-01

Milestone M10 (project management and project traits in the core).

### Added
- **📁 Projects** panel in the header, the one place where projects are managed: projects grouped by folder with search by name, id or path, traits as labels, projects whose folder is gone marked; add and edit (name, path, folder, traits), remove, create/rename/delete folders.
- **Project traits**: what a project is, detected in its folder — `git` (inside a repository), `node` (`package.json`), `env` (`.env*` files) — plus the traits declared by the extensions (manifest `projectTraits`: a file in the folder or an npm dependency). Each trait can be left automatic or forced on/off per project (`traits: { add, remove }` in `projects`, exported with the project).
- **Sections see only their projects**: an extension declares the traits it works with (manifest `projects: { traits }`); NPM shows the Node.js projects, Git those in a repository, Env those with `.env` files, and the dashboard offers a widget only on the projects of its extension. The others are counted at the bottom of the sidebar, a click opens the panel.
- **What is linked to a project** before removing it: database connections, HTTP sections, the dashboard layout (and the notes boards and MongoDB connections of the installed extensions) are listed and stay, unlinked. Backend contract `projectLinks(project)` → `[{ key, params }]`.
- **Import from a folder**: the folder and its direct subfolders with at least one trait, with their traits and the ones already added marked, chosen with checkboxes and added in one go, optionally into a folder (`POST /api/core/projects/scan`, `/import`).
- Backend `ctx.projects.list({ traits })` and `traitsOf(project)`; frontend `ctx.projects.load()` with `hidden`, `hiddenNote(count)`, `openPanel()`; `GET /api/core/projects` with `traitsFound`, `traitsActive`, `missing` and the known `traits`; `GET /api/core/projects/:id/links`.

### Changed
- The NPM, Git and Env sidebars only choose a project: adding, editing and removing projects and folders moved to the 📁 Projects panel (📁 in their header opens it). `ctx.projects.form()` and `newFolder()` open the panel; empty folders are no longer shown in the sidebars.
- The npm MCP tool lists only the Node.js projects.

## [2.17.0] - 2026-11-01

Milestone M3 (widgets and project dashboard).

### Added
- **Dashboard** (new built-in extension `dashboard`, first tab): the widgets of the extensions for the project chosen in its sidebar, in a grid. Per project: which widgets (**＋ Widget**, ⋯ → remove), their order (drag the header) and size (small, medium, whole row), saved in the `dashboards` section (*Dashboard* export checkbox); without a choice all the widgets are shown, **All widgets** goes back to that. ↗ opens the extension's section on the project; ↻ and showing the tab again refresh the widgets.
- **Widgets of the built-in extensions**: *npm scripts* (running processes with ports and uptime, stop/restart/output; the most run scripts with ▶), *Git* (branch, ahead/behind, changed files, last commits; fetch, pull, push after a confirmation listing the commits to send), *Database* (the project's connections with the connection test — not those through a tunnel, which the test would open — and the linked migrations folder: how many, the last, repeated numbers), *.env files* (missing and empty keys, add the missing ones), *HTTP requests* (requests of the sections linked to the project, sent from the widget, status of the last answer), *SSH tunnels* (the tunnels of the project's database connections, connect/disconnect). The installed `mongo-client`, `ports` and `notes` add theirs.
- **Widget contract** (`docs/EXTENSIONS.md`, additive): manifest block `widgets: [{ id, title, description?, scope: "project", size, js }]`, widget modules served like the frontend files and listed by `/api/core/extensions`; module `mount(ctx, el, { project })`, `refresh`, `unmount`, with the extension's frontend `ctx` plus `ctx.widget` (`setBadge`, `setTitle`, `openFull(params)`). Core host `ctx.widgets.list(scope)` / `ctx.widgets.mount(key, el, params, frame)`: module loaded on demand with the extension's style and catalogs; a widget that fails shows its error in its own box.
- `ctx.open(code, params)`: the opened panel module receives `params` in `focus(params, ctx)` (NPM, Git, Env, Database, HTTP, Dashboard implement it: project, process, connection, request).
- Backend `ctx.dataDir()`: the extension's data folder on this computer (`~/.kelbo/data/<code>`), for what doesn't belong in `config.json`.
- NPM: runs of each script counted per project (`GET …/projects/:id/usage`); `processes()` service with `projectId`. Git: `GET …/repos/:id/summary` (last commits and those not on any remote).


## [2.16.1] - 2026-10-30

### Fixed
- **Output panel covering the section**: with the bottom output panel open (e.g. the npm output in the HTTP client, a git action, an npm script) the lower part of the section — HTTP response, query results, editors — stayed underneath it. The section now gets shorter by the panel's height while it is open, also when the panel is resized, so everything above it stays visible and scrollable.


## [2.16.0] - 2026-10-30

### Added
- **HTTP client — body editor**: the JSON and text bodies are written in an editor like the SQL one of the Database section (transparent text area over the highlighted text, no external library): keys, strings, numbers, `true`/`false`/`null` and the `{{name}}`/`:name` variables (also inside strings) in colour. **Tab** inserts two spaces or indents all the selected lines, **Shift+Tab** outdents them, **Enter** keeps the indentation (one level more after `{` or `[`; between `{}` or `[]` the closing bracket goes on its own line), `}` or `]` typed at the start of an indented line goes back one level; every change stays in the browser's undo (Ctrl+Z).
- JSON body: under the editor *Valid JSON* or *Invalid JSON at line N, column M* while typing (own checker, since the browser's messages don't always say where); unquoted variables (`"id": {{id}}`, `"id": :id`) count as values. **Format** now works with them too, and stays undoable.


## [2.15.0] - 2026-10-29

### Added
- **Database — table in the sidebar**: an open table shows three folders, **Fields** (open by default), **Indexes** and **Foreign keys** (closed until opened), each with its count and opened or closed with a click. Indexes show their columns and UQ for unique ones (PRIMARY first), foreign keys their columns → referenced table and columns (database too when it's another one); full text in the tooltip. Read with the columns, so nothing more is requested.

### Changed
- In the tree, the name of a field, index or key always stays visible: the type or detail on the right is the one cut with "…" when the sidebar is narrow.


## [2.14.0] - 2026-10-29

### Added
- **HTTP client — `:name` variables**: besides `{{name}}`, a variable can be written `:name`, as in Express routes (`{{baseUrl}}/users/:id`; imported routes work as they are), in URL, query, headers, body, file paths and login requests. `:name` is replaced only when the variable exists and is not right after a letter, a digit or `:` (`http://`, `localhost:3000`, `user:pass`, `"key":value`, `10:30`, `::` stay as they are; `true`, `false` and `null` never count as names). An unknown `:name` stays as text, except in the URL path, where it stops the request with a clear error (*the path has :id but the section has no variable "id"*). The variable chips in the editor show both forms.


## [2.13.0] - 2026-10-28

Milestone M7 (new name: Kelbo), except the website.

### Added
- **Apache 2.0 license** (`LICENSE`, `"license"` in `package.json`), also in `kelbo-extensions`.
- Manifest field **`"kelbo"`** for the compatible core versions; `"devdock"` is still accepted (both must be equal when present). Extensions that must also load on Kelbo before 2.13 keep `"devdock"` too.

### Changed
- **Technical names**: package `kelbo`, commands `kelbo` and `kelbo-mcp` (`bin/kelbo.js`, `bin/kelbo-mcp.js`), environment variables `KELBO_PORT`, `KELBO_CONFIG`, `KELBO_HOME`, `KELBO_EXTENSIONS_DIR`, `KELBO_NO_BROWSER`, MCP server name `kelbo` (setup snippets of the 🤖 dialog), MCP token file `.kelbo-mcp-token`, exported configuration `kelbo-config-….json`, Kelbo home `~/.kelbo`. The old names keep working: `DEVDOCK_*` variables (the `KELBO_*` ones win), the `devdock`/`devdock-mcp` commands and `bin/devdock-mcp.js` (Claude Desktop entries copied before keep running).
- **Kelbo home moved**: at the first start `~/.devdock` becomes `~/.kelbo` with everything in it — installed extensions with their `node_modules`, `extensions.lock.json`, `backups/` — so the downloaded extensions stay installed, updatable and with their *previous version*. One rename, or (another disk) a copy checked file by file before the old folder is deleted; on any error Kelbo goes on with `~/.devdock` and logs why. Nothing moves with `KELBO_HOME`/`DEVDOCK_HOME` set or when `~/.kelbo` exists (a log line says both are there). The old MCP token file is renamed on first use, same token.
- Addresses of the official extensions repository (`codo82/devdock-extensions`, https or ssh) are rewritten to `kelbodev/kelbo-extensions` at start-up in the lock file (previous versions included) and in the list of installed extensions; the catalog lists the new address.
- Test kit: `opts.env` takes the `DEVDOCK_*` names as `KELBO_*`, and `null` removes a variable; `require('kelbo/testkit')` for external extensions (Kelbo as dev dependency `github:kelbodev/kelbo#main`).

### Unchanged on purpose
- The key derivation labels of the master password vault, the `config.json` sections and the browser storage keys keep their old names: renaming them would make the stored secrets unreadable or drop the user's preferences.

## [2.12.1] - 2026-10-28

### Changed
- **HTTP client — OAuth login pages in the browser**: the pages shown at the end of a login (completed, failed, completing) are a centred card with the Kelbo name, a green ✓, a red ! or a spinner, a title and the message, the error detail in its own box and the reminder to go back to Kelbo; light or dark following the system, in the browser's language, with no external resources.

## [2.12.0] - 2026-10-28

### Added
- **Database — total rows of a query**: when a SELECT is cut by Kelbo's row limit or by a `LIMIT` written at its end, the summary above the results also shows how many rows it gives without limits (*100 rows (limited to 100) · 300 in total without limits*, *20 rows · 300 in total without limits (LIMIT 20)*), counted with a `COUNT(*)` of the same query without its final `LIMIT` (a `LIMIT` inside a subquery or CTE stays). Without limits the rows returned are the total and nothing more runs; when the count fails (e.g. a JOIN with two columns of the same name) it is just not shown. The API answer of a query has `total` and `queryLimit`.
- **Database — tab menu**: right click on a tab for *Close*, *Close the others*, *Close those to the right*, *Close those to the left* (one question for all the unsaved edits of the tabs being closed); middle click closes a tab.

## [2.11.1] - 2026-10-28

### Changed
- **Database**: the column headers of query results, table data and structure stay at the top while the rows are scrolled; only the table scrolls, the bar with search, filters and pages (or the result summary) stays in view.

## [2.11.0] - 2026-10-28

### Added
- **Database — double click on a table** in the sidebar opens its data (*Open data*: in a new tab, or in the one already showing it). A single click still opens the table menu, a moment later so that a double click doesn't open it too.

## [2.10.0] - 2026-10-28

### Added
- **Database — column menu**: right click on a column in the sidebar tree opens a menu with **Copy the name** and **Distinct values (DISTINCT)**, which runs `SELECT DISTINCT` of that column (ordered) in a new tab, or in the tab that already shows it.

## [2.9.0] - 2026-10-28

### Added
- **Database — query tabs**: the editor has tabs, each with its own connection and database, SQL text and results (data grid, designer, structure, query result with its sorting, unsaved cell edits and parameters used), kept while working in another tab. **＋** opens a new tab on the same connection and database; ✕ closes one (asking first when it has unsaved edits). The selector in the toolbar chooses the connection and database of the tab among those open in the sidebar; clicking a connection or a database in the sidebar sets them for the current tab. The tabs (connection, database, text) last for the browser session.
- The actions on a table in the sidebar (first 100 rows, count, open data, structure, alter, SHOW CREATE, truncate, drop) open in a **new tab**, or in the tab that already shows the same query (or the same table's data, structure or designer) on the same connection and database.
- A query that takes time keeps running in its tab (spinner on the tab) while another tab is used; its result lands in its own tab.
- **Database — parameters from an object**: in the parameters dialog the values can be pasted as an object written as in JavaScript (`{ site_id: 15, year: 2024, level: 'site', energy_vector_id: null }`, quoted or unquoted keys, `'…'` or `"…"` strings, numbers, `null`, `true`/`false`, trailing commas, comments; JSON too). The fields are filled by parameter name (also ignoring case) with the right type (`null` → NULL, numbers → Number, strings → Text); the dialog says how many were filled, which keys were not used and which parameters are still without a value. The text is only read, never run.

### Changed
- **NPM**: the script rows are highlighted on hover.

## [2.8.1] - 2026-10-27

### Fixed
- **Extensions panel — updates not offered**: the catalog could show a newer version of an installed extension (e.g. *notes 1.2.0, installed 1.0.0*) while the panel offered no update, because the update check on the repository tags runs at start-up and once a day and had run before the new tag was published. When the catalog lists a newer version than the one installed and the last check doesn't know it, the check is run again at once (at most once a minute); the catalog is read in the background when the panel opens, so the *Installed* tab and the badge on 🧩 follow, and the catalog row of an installed extension shows *x.y.z available* with **Update**.

### Changed
- **New name: Kelbo.** DevDock is now called Kelbo: page title, header, interface texts in every language, MCP instructions, README and docs. The repositories moved to [kelbodev/kelbo](https://github.com/kelbodev/kelbo) and [kelbodev/kelbo-extensions](https://github.com/kelbodev/kelbo-extensions); GitHub redirects the old addresses. Commands, environment variables and folders keep their current names for now.
- **Official extensions catalog** at its new address; a list of catalogs saved with the old address uses the new one.

## [2.7.0] - 2026-10-26

### Added
- **HTTP client — filter in the Express routes dialog**: text (path, file, method; several words all match), method and *Not imported only*, with the count of the routes shown; the filter stays when coming back from importing a route.

### Changed
- **Extensions panel**: the switch and the Tab/Header selector are on a second line of each extension, under its description, with their labels; no more horizontal scrolling or controls cut off on the right.

### Fixed
- **Extensions panel**: after installing, removing, switching an extension or going back to a previous version, the catalog showed the old state (e.g. *installed* for an extension just removed) until DevDock was reloaded; while an action runs the other controls are disabled.
- Warnings and errors of the extension state (optional dependency not available, missing dependency, incompatible DevDock version, …) were always in Italian: they are now in the core catalogs and shown in the interface language (`warningInfo` / `errorInfo` in `/api/core/extensions`, with the source text still in `warnings` / `error`).

## [2.6.1] - 2026-10-26

### Added
- **HTTP client — Forget token** next to the user type in the request editor: shown when the chosen user type has a token in memory, it forgets it so the next send obtains a new one (before, only from the 👤 Users dialog).

## [2.6.0] - 2026-10-26

### Added
- **HTTP client — npm output**: in a section linked to a project, the 📟 menu of the editor shows the live output of one of the project's npm scripts (started from the NPM section) in the bottom panel, next to the requests. `npm start` is followed by default when running; the choice is remembered per section. Needs the NPM extension.
- **Resizable output panel**: the bottom output panel of every section is resized by dragging its top edge (↑/↓ when focused, double click for the initial height); each section keeps its own height, remembered by the browser, like the sidebar width.

### Fixed
- `ctx.apiFor(code)` now has `stream` and `events` like `ctx.api`, so an extension can follow another one's SSE streams.

## [2.5.0] - 2026-10-26

### Added
- **HTTP client — files**: two new body types, *File* (a file sent as it is, Content-Type from its extension unless set in the headers) and *Multipart form* (text and file fields, `multipart/form-data` with its boundary). Files are given by path, absolute or relative to the folder of the project linked to the section (variables allowed), and read when sending (max 50 MB); saved requests keep the path, never the content.
- **HTTP client — binary answers**: saved at once to the browser's Downloads, named after `Content-Disposition` (`filename` or `filename*`) or, without it, after the Content-Type (`application/pdf` → `response.pdf`), with *Download again*; up to 50 MB (text answers are shown up to 5 MB as before).

## [2.4.1] - 2026-10-26

### Changed
- **HTTP client sidebar**: requests grouped by user type under each section (section ▸ user ▸ requests, plus *No authorization*), each group collapsible with its count and a ＋ that creates a request for that user; *Move under…* in the request's context menu. Sections without user types keep the plain list.

## [2.4.0] - 2026-10-26

### Added
- **HTTP client — browser for OAuth logins**: *Browser for logins* in the 👤 Users dialog sets the executable to open the logins with (e.g. `/mnt/c/Program Files/Mozilla Firefox/firefox.exe` from WSL), for every user type, on this computer only (not exported). DevDock in WSL is recognised: without a path it uses Windows Firefox when installed in the standard folder (needed for containers), otherwise the Windows default browser.
- When the browser cannot be started, the Users dialog says so and shows the login link to open by hand (before, nothing happened).
- Config sections can be marked `local: true` (data of this computer): never exported, not even by a full export (`docs/EXTENSIONS.md`).

### Fixed
- **HTTP client — client secret with PKCE**: the *Client secret* field was shown only for the "authorization code" flow; confidential clients (Keycloak with *Client authentication* on) need it with PKCE too. It is now available for both flows and sent to the token endpoint whenever it is set.

## [2.3.1] - 2026-10-24

### Fixed
- Clicks that seemed lost all over the interface (e.g. *Install…* in the Extensions panel needing two or three clicks): the click arrived, but slow actions (reading a git repository, creating or unlocking the master password, connecting to a database) showed no sign of work and ignored the following clicks. Now every request to the server started by a click puts that button on hold (spinner, no further clicks) and the cursor in "busy" until the answer arrives; quick answers show nothing.

## [2.3.0] - 2026-10-24

### Added
- `ctx.ui.patch(el, html)` for extensions: updates a container that is redrawn on its own only when its HTML changes, and after the click when the mouse is pressed inside it (see `docs/EXTENSIONS.md`).

### Changed
- **HTTP client**: the 👤 Users dialog asks for the master password before opening; user types, pasted tokens and logins need the vault unlocked, and the tokens in memory are forgotten when it is locked.

### Fixed
- Buttons that sometimes needed a second click: the header pills, SSH tunnels, NPM and Git were redrawn by their periodic refresh even when nothing had changed, replacing the button between mousedown and click; the same happened in the Database grid when a cell being edited lost the focus. They are now redrawn only when something changes, and never under a pressed mouse button.
- Closing the master password dialog by clicking outside it left every later action that needed the vault doing nothing until the page was reloaded.
- Git: the automatic refresh no longer replaces the log with "loading" every 30 seconds.

## [2.2.0] - 2026-10-24

### Added
- **MCP stdio bridge** (`bin/devdock-mcp.js`, also `devdock mcp`): Claude Desktop and the other clients that start MCP servers as processes connect to DevDock without the token in their configuration and without `npx mcp-remote`. The bridge reads port and token of the instance by itself, keeps working after the token is regenerated and reports clearly when DevDock is not running. The 🤖 dialog proposes the new `claude_desktop_config.json` entry (M1).

### Fixed
- The MCP token is created on the first access to `/mcp` also for requests without an `Authorization` header.

## [2.1.0] - 2026-10-24

### Changed
- **Swagger** is no longer built in: it moved, with its history, to the official [devdock-extensions](https://github.com/codo82/devdock-extensions) repository (`swagger@1.0.0`). After updating, install it from 🧩 → Catalog or with `npm run ext -- install swagger`; it needs no configuration. The extension contract does not change, so DevDock stays at 2.x and installed extensions keep working.

### Added
- **Mock** shows a pill in the header for every running mock server, like NPM and SSH Tunnels: name and port, a click opens the mock, ✕ stops it; the module is loaded at startup (`preload`) and refreshes the state every 10 seconds.
- MongoDB client (M13), born as an installable extension in [devdock-extensions](https://github.com/codo82/devdock-extensions) (`mongo-client@1.1.0`) with the features of the Database section: folders, mongosh editor with history, documents as JSON or table with inline edit, every change confirmed, collections and indexes, structure, JSON/CSV/script export, read-only MCP tools. Install it from 🧩 → Catalog or with `npm run ext -- install mongo-client`. Nothing changes in the core.

## [2.0.0] - 2026-10-24

### Breaking
- **PM2** and **Ports** are no longer built in: they moved, with their history, to the official [devdock-extensions](https://github.com/codo82/devdock-extensions) repository (`pm2@1.0.0`, `ports@1.0.0`), whose catalog is the default one of the Extensions panel. After updating, install them from 🧩 → Catalog or with `npm run ext -- install pm2` / `npm run ext -- install ports`; they need no configuration, and their MCP tools (`pm2_list`, `pm2_logs`, `ports_list`) come back with them. `lib/ports.js` stays in the core (`ctx.lib.ports`).
- Vault API moved to the core: `/api/ext/db-client/vault/*` → `/api/core/vault/*`, error codes `db-client.vault_locked` / `db-client.vault_missing` → `core.vault_locked` / `core.vault_missing`, and the `db-client.vault` service is replaced by `ctx.vault`.
- Extension manifests must declare `version` (SemVer) and `devdock`, the DevDock versions they work with as an npm range (`"devdock": "^2.0"`); the loader disables an extension without them or whose range does not include the running core, and says why. `docs/EXTENSIONS.md` is now the public, versioned API for extensions: breaking changes come with a new major version and are marked here.

### Added
- **Installable extensions**: 🧩 Extensions panel in the header with the built-in and installed extensions (version, source, state, warnings), switch on/off for all of them, update, back to the previous version and removal for the installed ones; catalogs (JSON files listing extensions in any repository, the official `devdock-extensions` one by default) with a search; install from any git URL (also private repositories through the user's git credentials, and folders of multi-extension repositories). Versions are semver tags (`v1.2.0`, or `<code>@1.2.0` in a folder) and the latest compatible one is proposed; a preview from a shallow, sparse clone shows manifest, compatibility, dependencies (missing ones offered for install), what's new and a security warning before anything is written. The install puts npm dependencies in place without scripts, moves the folder atomically, records repository, tag and commit in `~/.devdock/extensions.lock.json`, and loads the extension at runtime: the shell adds its tab without reloading the page and the other extensions keep running. Updates are checked at start-up, daily and on demand (badge on 🧩), with the changelog of the new version; the previous version is kept for one-click restore and a tag moved to another commit is reported. Extensions that can't be reloaded declare `"reloadable": false` and ask for a restart. The **Installed extensions** export checkbox carries the list (no code), shown on another machine as *To install*.
- Test kit: `validateManifest(json)` and `coreVersion()` for the scripts of extension repositories (e.g. generating a catalog).
- Command line `devdock ext list|install|update|remove|check` (`npm run ext -- …`), through the running DevDock or directly on the files when it is not running.
- Frontend lifecycle `unmount(ctx)`, called when an extension is switched off, updated or removed.
- Position override: the Extensions panel moves any extension with a UI between the section bar (tab) and a header button, starting from the manifest's `position`; saved in `layout.positions`, applied without reloading the page.

### Changed
- Every extension keeps its tests in `extensions/<code>/tests/`; the core suite in `tests/` uses only fixture extensions, so it stays green without any built-in extension. The test helpers became the core **test kit** (`lib/testkit.js`, `require('devdock/testkit')` for external extensions) with `startServer`, `mcpClient`, fixture helpers and `i18nProblems(extDir)` for the translation checks of a single extension. `tests/helpers.js` was removed.
- The master password vault moved from the `db-client` extension to the core: same `vault` section of `config.json` and same encryption, so the passwords saved by earlier versions keep working. Extensions use it through `ctx.vault` (backend: `encrypt`, `decrypt`, `register` for re-encryption and reset; frontend: `ensure()` asks for the password, or to create it, when needed); changing the master password re-encrypts the secrets of every extension in a single write of `config.json`. `http-client` no longer depends on `db-client`.
- Extensions are read from two folders: the built-in ones in `extensions/` and the installed ones in `~/.devdock/extensions` (`DEVDOCK_HOME`); `GET /api/core/extensions` reports the `source` of each one, and two extensions with the same code are an error shown on the second one. The loader became an extension manager that starts, stops and reloads an extension at runtime.

## [1.23.0] - 2026-10-23

### Added
- **Tab order**: the section tabs can be reordered by drag and drop or from the keyboard (Alt+←/→ on a focused tab, reversed in right-to-left languages). The order is saved in the new core section `layout` of `config.json` (`layout.tabs`, not exported) and restored at startup, so the first tab opened is the first of the chosen order; extensions not in the list (newly added) go after the others in manifest order, removed ones are ignored. Right click on the tab bar → **Restore the default order**. Core API: `GET /api/core/layout`, `PUT`/`DELETE /api/core/layout/tabs`.

## [1.22.0] - 2026-10-23

### Added
- **Mock server** (new extension `mock-server`, 🎭 Mock tab, config section `mockServers` with the **Mock server** export checkbox): mock servers with name and port, listening on `127.0.0.1` only, started and stopped from the UI (status in the sidebar, running count on the tab) and stopped when DevDock stops; a port in use is reported with the process that holds it. Routes with method (or any), path with `:parameters` and `*`, status, headers, JSON or text body and optional delay; the first matching route in list order answers (reorderable), unmatched calls get a JSON `404`; routes change while the mock runs. CORS on by default, with automatic answers to preflight requests. API under `/api/ext/mock-server`.
- Mock server, **call log**: every incoming call with time, method, path, query, headers, body (JSON, text, or size only for binary content; truncated over 64 KB), matched route and status, live in the UI through a stream; the latest 500 calls per mock in memory, with **Clear** and **Create route from this call** for calls without a route.
- MCP tools `mock_server_list` and `mock_server_requests` (read-only): calls of a mock with filters by method, path and "unmatched only", a limit, and credential headers (`Authorization`, `Cookie`, API keys, tokens) redacted.

## [1.21.0] - 2026-10-23

### Added
- **HTTP client** (new extension `http-client`, 📮 HTTP tab, config section `httpSections` with the **Richieste HTTP** export checkbox): sections of requests in a sidebar accordion, each with a base URL (`{{baseUrl}}`, proposed from `PORT` in the linked project's `.env`), variables (`{{name}}` in URL, query, headers and body) and an optional linked project. Requests (method, URL, query, headers, JSON or text body) are sent by the DevDock backend with a 30 s timeout and a 5 MB response limit; the response shows status, time, size, headers and the body (JSON formatted). API under `/api/ext/http-client`.
- HTTP client, **Express route discovery** by static analysis of the linked project: from `main` or the start script it follows relative `require`/`import` (JS and TS) and composes the prefixes of `app.use`/`router.use` across files, with constants, template strings and router factories; prefixes that can't be resolved (env/config values, `readdirSync` auto-loaders) are shown as `«expression»` and completed when the route is imported. Routes are imported one at a time.
- HTTP client, **user types** per section with an authorization method each: none, basic auth, pasted token (optional expiry), token from a login request (credentials with `{{username}}`/`{{password}}`, token path in the JSON response or a header), OAuth / OpenID Connect (issuer discovery, authorization code with PKCE, code with client secret, implicit). Configurable header name and format. Tokens are reused while valid (JWT `exp`, response lifetime, manual expiry) and obtained again otherwise, also in the middle of a send; the OAuth login opens in the browser — in the user type's Firefox container through the "Open external links in a container" add-on — while DevDock listens on the redirect URI port only for the duration of the login; refresh tokens renew the token without the browser. Tokens are kept only in memory.
- HTTP client, **actions after the token**: up to 5 requests run right after a token is obtained, with variables extracted from their responses (JSON path or header) for the requests of that user type; a variable called `token` replaces the token.
- Database: the master password vault is offered to other extensions (`db-client.vault` service: `encrypt`, `decrypt`, `state`, `register`). The HTTP client keeps its secrets (passwords, client secrets) encrypted with it; changing the master password re-encrypts them and resetting it deletes them.

### Fixed
- Tests: the DB migrations test no longer depends on git's default branch name.

## [1.20.1] - 2026-10-23

### Changed
- Database, parametric queries: the saved values are kept in DevDock's memory (lost when it restarts) instead of the browser's `localStorage`; values left there by 1.20.0 are removed when the Database section opens. API: `POST`/`PUT /api/ext/db-client/param-values`.

## [1.20.0] - 2026-10-23

### Changed
- Database, parametric queries: the values are saved in the browser (`localStorage`, per connection and query text, last 200 queries; also by parameter name). A query already run runs again at once with its saved values, without the dialog; the values used are shown above the results (also after an error) with **✎ Change**, which reopens the dialog prefilled. A new query asks for the values, prefilled with the last ones used for the same names. Changes still ask for confirmation of the statement with the values.

## [1.19.0] - 2026-10-23

### Added
- Database: parametric queries in the SQL editor with `?` and `:name` placeholders (outside strings, comments and quoted names; `::` and `:=` are not placeholders). Running such a query opens a dialog with one field per parameter: `:name` shows the variable name (a repeated name is asked once), each `?` gets a name guessed from the query when possible (compared column, `IN (…)`, `BETWEEN` min/max, `LIMIT`/`OFFSET`, `INSERT … (columns) VALUES (…)`), otherwise `param_N`. Each value has a type (Auto, Text, Number, NULL; Auto sends a number when the text looks like one) and is remembered by name for the session; Enter runs. The server escapes the values into the statement (`params` in `POST …/query`, 422 `needsParams` with the list when they are missing), so reads run at once and changes are confirmed with the actual values.

## [1.18.0] - 2026-10-22

### Added
- Database: editing of several cells, also of different rows, before saving, in the table data view and in the editable results of a SELECT. Changed cells stay highlighted (the tooltip shows the previous value) and a bar shows how many there are, with **Save** and **Discard changes**; Tab / Shift+Tab move to the next / previous cell, Esc cancels the cell being edited, Enter saves everything. The server generates one `UPDATE` per row (`op: "update-many"`), shown in a single confirmation and run in one transaction: if one fails, nothing is changed. Changing page, filter or sort with unsaved changes asks first.

### Changed
- Database: leaving a cell (click elsewhere) keeps the change pending instead of discarding it; the NULL button and the JSON dialog (**Apply**) add the value to the pending changes.

## [1.17.0] - 2026-10-22

### Added
- Database migrations: **💾 Save migration only** in the schema change dialog writes the migration file in the linked folder without running the statements, so the project's migration tool applies it. Warnings about destructive changes do not need to be acknowledged in that case, since the database is not touched (API: `migration.run: false`).

### Fixed
- Migrations: the "no repository" hint now points to the NPM or Git section.

## [1.16.1] - 2026-10-22

### Fixed
- Database: the New folder / Rename folder dialog raised a JavaScript error (`Unexpected token '&'`) and could not be saved, because its handler was escaped twice.

## [1.16.0] - 2026-10-22

### Added
- Database: connections can be grouped in sidebar folders of their own (one level, section `dbFolders`), independent of the project folders. Create a folder with 📁+, move a connection with the **Folder** field of its form, rename or delete a folder from its ⋯ menu or with a right click (its connections go back to the root). Folders are included in the *Connessioni database* export and in the import of connections; the open/closed state is remembered by the browser.

### Changed
- Database: the sidebar no longer groups connections by linked project (the project link stays in the connection form).
- Sidebar titles are shortened with an ellipsis when the sidebar is narrow, so the header buttons always fit.

## [1.15.0] - 2026-10-22

### Added
- Project folders: projects can be grouped in sidebar folders (one level), shown in the NPM, Git and Env sidebars. Create a folder with 📁+, move a project from its edit form (✎), rename or delete a folder from its ⋯ menu (its projects go back to the root). The open/closed state of the folders is remembered by the browser.
- Projects can be added, edited and removed from the Git section too.

### Changed
- Projects belong to the core instead of the NPM extension (`projects` and the new `projectFolders` sections, API under `/api/core/projects` and `/api/core/folders`, `ctx.projects` for the extensions). Git and Env no longer require NPM; the Export/Import checkbox is now **Progetti e cartelle**. Existing `config.json` files and exports work unchanged.

## [1.14.0] - 2026-10-21

### Added
- Ports: **Force stop** button next to **Stop** in the confirmation, for every process of the user, including the ones started by DevDock (npm process group, SSH tunnel and PM2 process stopped through their section with SIGKILL; PM2 is stopped first so it does not restart it). After a stop DevDock checks that the port is free and, if it is still in use, offers to force it.

## [1.13.1] - 2026-10-21

### Changed
- The sidebar width is remembered per section (`localStorage` key `devdock.sidebarWidths`); a section never resized opens with the initial width. A very narrow or hidden window no longer shrinks the saved widths.

## [1.13.0] - 2026-10-21

### Added
- Resizable sidebar: drag its edge, or use ←/→ on the focused edge; double click restores the initial width. The width is saved in the browser (`localStorage`).

### Fixed
- Output drawer: ANSI colours were not closed by the partial reset codes (`39`, `22`, `49`…), so a colour could run over the following lines; colours now continue correctly across chunks (also when an escape sequence is split between two chunks), non-colour sequences such as `ESC[2K` (npm progress) no longer swallow text, and 256-colour and true-colour codes are supported.

## [1.12.0] - 2026-10-21

### Added
- Database: filter of the tables above the tree.
- Database: results of a custom `SELECT` (also with aliases, `WHERE`, `ORDER BY`, `LIMIT`) can be edited with a double click when the columns come from a single table and include its primary key; computed columns stay read-only. Every change goes through the confirmation of the generated `UPDATE`.
- Database: autocomplete in the SQL editor — SQL keywords and functions, tables of the active database, columns of the tables used in the statement, and columns of an alias after `alias.` (`FROM orders o` → `o.`). Opens while typing or with Ctrl+Space; ↑/↓, Enter or Tab, Esc.

### Fixed
- Database: the tree did not update after a schema change (table designer, statements run from the SQL editor, saved migrations): tables and open column lists are reloaded; `CREATE`/`DROP DATABASE` reload the list of databases.
- Database: double click on a JSON value opened nothing outside the data browser; it now opens the JSON dialog in query results too (read-only when the row cannot be edited, and in tables without a primary key).
- npm, PM2, SSH tunnels: after switching section and coming back, the output drawer stayed frozen until the page was reloaded; the stream of the followed process now resumes, with its history.

## [1.11.3] - 2026-10-21

### Fixed
- Database: in the SQL editor the cursor did not match the text being typed. The coloured text and the input field went to a new line at different points, because only the input field had a scrollbar; both now reserve the same scrollbar space, and they use the same weight, style and no ligatures.

## [1.11.2] - 2026-10-21

### Fixed
- Database: JSON columns were shown as `[object Object]` in the data browser, in query results and in the MCP tools, and editing such a cell inline saved that text. They are now shown as JSON text; CSV, JSON and SQL exports write them as JSON (SQL exports produced `` `key` = value `` pairs).

### Changed
- Database: double click on a JSON cell opens a dialog with the formatted JSON (Format, Set NULL), validated before saving; the row dialog shows JSON columns formatted too. Saving still goes through the confirmation of the generated SQL, and an unchanged JSON (only spacing or key order) is not saved.

## [1.11.1] - 2026-10-20

### Fixed
- SSH tunnels: deleting a group left its servers in the configuration, invisible in the Tunnels section but still offered by the Database connection form. Deleting a group now deletes its servers that are in no other group (the confirmation lists them) and closes their tunnels; deleting a server closes its tunnel; groups and servers are saved together.
- SSH tunnels: servers without a group (left by earlier deletions or removed from every group) are listed under "Servers without a group" in the settings, where they can be edited or deleted.
- Database: a connection whose SSH tunnel was deleted is flagged (badge, ⚠ in the tree, "deleted" entry in the form) and gives a clear error instead of looking valid.
- Database: after editing a connection, errors and data of the old settings are no longer shown in the tree (connection refused, wrong database…): its nodes are reloaded.
- Database: when the default database of a connection does not exist, the list of databases is still shown, with a warning.

### Changed
- Database tree: arrows that point right when a node is closed and down when it is open, instead of the small triangles.

## [1.11.0] - 2026-10-20 — M10 Environment files

### Added
- `env` extension (🔑 Env): the `.env*` files of each npm project compared with the template (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`) — missing, extra and empty keys, count of missing keys in the sidebar.
- Values hidden and shown one at a time on request; edit, add, rename and delete keys, add the missing keys with the template values, create a new `.env` file from the template.
- Files rewritten keeping comments (also inline), blank lines, `export` and order, with atomic writes; a file changed outside DevDock since it was read is not overwritten.
- MCP tool `env_check` (keys and differences, never values).

## [1.10.0] - 2026-10-20 — M9 Ports in use

### Added
- `ports` extension (🔌 Ports): listening TCP ports of the machine with process, PID, user and command line (`lsof`/`ss` on macOS and Linux, `netstat` on Windows), linked to the npm scripts, PM2 processes and SSH tunnels started by DevDock; search and "only my processes" filter.
- Stop the process that holds a port after a confirmation showing PID and command: processes started by DevDock are stopped through their extension, the others with SIGTERM (optionally forced); only processes of the current user, never DevDock itself.
- MCP tool `ports_list`.
- Core `lib/ports.js`: `listListeningPorts()`; services `processes`/`stopProcess` (npm), `processes`/`stop` (PM2), `activeTunnels`/`stopTunnel` (tunnels).

## [1.9.1] - 2026-10-20

### Changed
- The MCP server panel is part of the core: 🤖 button in the header opening a dialog with endpoint, token, client setup and tools. The `mcp` extension is removed (extensions are only features that can be added or removed).

## [1.9.0] - 2026-10-20 — M8 MCP server (first version)

### Added
- MCP server at `/mcp` (Streamable HTTP, official `@modelcontextprotocol/sdk`): AI agents such as Claude Code and Claude Desktop can read the state of DevDock.
- Bearer token generated on first start in `.devdock-mcp-token` next to `config.json` (not exported, regenerable); browser requests rejected.
- `mcp.tools` block in the extension manifest, with handlers in the backend (`instance.mcp`); tools named `<extension>_<tool>`, results as structured JSON, errors with the API error codes.
- Tools: SSH tunnels (servers and status), PM2 (processes, logs), Git (repositories, status, log), npm (projects and scripts, processes and their output, **start and stop scripts**), database (connections without credentials, databases, tables, table structure, read-only queries in a `READ ONLY` transaction) — database tools only while the vault is unlocked from the UI.
- 🤖 "MCP server" panel (extension `mcp`, moved to the core in 1.9.1): endpoint, token, setup for Claude Code and Claude Desktop, list of the tools.

## [1.8.1] - 2026-10-20

### Removed
- Migrations status panel, schema snapshot (`.devdock-schema.json`), baseline and generation of migrations for changes made outside DevDock: migrations are only the files DevDock writes when it applies a change.
- Check of the remote branch when numbering migrations: the next number follows the files in the folder.
- Git extension services `upstreamOf`, `filesAt`, `fetch`.

## [1.8.0] - 2026-10-20 — M7 DB migrations

### Added
- Database connections can be linked to a migrations folder in a repository (Git extension repositories, or npm projects when Git is not active), chosen with a folder browser that can also create folders; paths are validated to stay inside the repository.
- Migration files `NNN_<table>_<operation>.sql` with an incremental number (at least 3 digits) computed from the files that actually exist, in the folder and on the tracked remote branch (optional fetch); unpulled remote migrations are reported. The number is recomputed right before writing and files are created exclusively, never overwritten.
- Table designer for existing tables (*Edit structure*): add, change, rename, reorder and drop columns, primary key, indexes, foreign keys, engine and comment. The server computes the operations from the current structure read from the database.
- Preview of every schema change with the SQL and the migration file side by side, editable table/operation in the file name, and an explicit confirmation for changes that may lose data.
- Pipeline: migration file → DDL; when a statement fails the file is removed or reduced to the statements that ran.
- `CREATE` / `ALTER` / `RENAME` / `DROP` statements typed in the SQL editor can be saved as migrations; table and operation are recognised for the file name.
- Schema snapshot `.devdock-schema.json` next to the migrations, *Migrations status* (in sync / changes not in a migration / snapshot ahead of the database), migrations generated for changes made outside DevDock (with rename-or-drop choice), and baseline with an optional initial migration.
- Git extension services `repos`, `upstreamOf`, `filesAt`, `fetch` for other extensions.

### Changed
- The new-table designer goes through the same preview and migration pipeline; it also supports `ON UPDATE CURRENT_TIMESTAMP`.
- Dialogs can be wider (`modal-wide`) for side-by-side previews.

## [1.7.0] - 2026-10-20 — M6 Internationalization

### Added
- Translatable UI with no list of languages in the code: a language exists when its catalog exists (`public/core/i18n/<tag>.json`, `extensions/<code>/i18n/<tag>.json`, BCP 47 tags, `_meta` with name, native name and direction). Italian is the source language; English is complete.
- `GET /api/core/i18n/languages`: available languages with completeness, including languages shipped only by an extension.
- 🌐 language selector in the header; the language is resolved from the user's choice, then `navigator.languages` (with `pt-BR` → `pt` fallback), then Italian. Switching re-renders the shell and the mounted extensions without reloading the page and sets `<html lang dir>`.
- `public/core/i18n.js`: `t(key, params)` with `{param}` interpolation and CLDR plurals (`Intl.PluralRules`), per-key fallback chain, `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria-label` markup, locale-aware formatting (`fmt.date`, `relative`, `number`, `bytes`, `duration`, `list` with `Intl`).
- Extension contract: `i18n/` catalogs namespaced by extension code, `ctx.t`, `ctx.i18n`, `languageChanged(ctx)` hook, manifest `name` / `description` / export `label` as a string or a map by language.
- Structured API errors for the core and every extension: `{ error, code, params }`, with the source-language message built from the catalogs (`ctx.error(status, name, params)`); the frontend translates the code and falls back to `error`.
- Catalog tests (validity, stale keys, placeholders, keys used in the code present in the source language, hard-coded text check) and `npm run i18n:report` for completeness and missing keys.
- README section "Languages" with the steps to add a language.

### Changed
- All UI texts of the core and of the Swagger, PM2, SSH Tunnels, NPM, Git and Database extensions moved to catalogs (Italian and English).
- Dates of the Git log, branches and merge preview are sent as ISO 8601 and formatted in the active language; PM2 memory, CPU and uptime, tunnel uptime and other numbers use `Intl`.
- CSS uses logical properties (`margin-inline-start`, `inset-inline-end`, …) so right-to-left languages work without dedicated stylesheets.
- Error codes of earlier responses are now namespaced (`dirty` → `git.dirty`, MySQL codes in `params.mysqlCode`); SQL classification reasons and table-designer errors are codes.
- Process and tunnel status messages written by DevDock in logs and streams are translated in the UI; the output of external commands (`git`, `npm`, `pm2`, `ssh`, MySQL) is shown as it is.

## [1.6.0] - 2026-10-20 — M4 Branches

### Added
- Git: `GET /repos/:id/branches` with local branches (upstream, ahead/behind, gone, merged, last commit) and remote branches.
- Git: branch panel opened from the branch badge, with search, local/remote sections and "New branch…".
- Git: branch switch with pre-checks — uncommitted changes return a structured `dirty` response and the UI offers "stash and switch"; remote branches without a local copy are checked out with `--track`; existing or missing branches give clear errors.
- Git: `checkout_new` action (new branch from an optional start point).
- Git: merge of a chosen branch with a preview (`GET /repos/:id/merge-preview`: incoming commits, changed files, fast-forward/up to date), modes fast-forward, `--no-ff` and `--squash`; on conflicts a banner lists the files and offers "Annulla merge" (`merge --abort`) and "Concludi merge" (refused while conflict markers remain).
- Git: deletion of local branches (not the current one); unmerged branches only after an explicit confirmation (`-D`).
- Core: API errors in the browser carry `status` and the response `data`.

### Fixed
- Git graph legend no longer shows internal refs such as `refs/stash`.

## [1.5.0] - 2026-10-20 — M5 Database client

### Added
- `db-client` extension (🗄️ Database): MySQL/MariaDB client based on `mysql2` (npm workspace dependency).
- Master password vault: scrypt + HKDF + AES-256-GCM, only salt and a hashed verifier in `config.json`, key in memory only, lock button and inactivity timeout, increasing delay after wrong attempts, password change with atomic re-encryption, reset when forgotten.
- Connections direct or through a tunnel of the Tunnels extension (started on demand, only when that extension is active), grouped by npm project, read-only option, connection test.
- Confirmation of every statement that changes data or schema: the server classifies the SQL and returns a token bound to the exact text; only reads run directly; read-only connections refuse writes and run with a READ ONLY session.
- SQL editor with highlighting, Ctrl/Cmd+Enter, row limit, sortable results, session history.
- Sidebar tree connection ▸ database ▸ tables ▸ columns, context menu on tables (open data, count, structure, SHOW CREATE, export, truncate/drop through confirmation) and on databases (new table).
- Data browser with pagination, search, per-column filters and sorting; inline and dialog row insert/edit, row deletion and multiple deletion with checkboxes — all generated by the server and confirmed.
- Table designer generating `CREATE TABLE` from a structured definition.
- Export of tables (whole or filtered) and of SELECT results as CSV, JSON or SQL, streamed by the server.
- Import of connections encrypted with a different master password.
- Core: `ctx.config.update()` for multi-section atomic writes, `UI.contextMenu`, error responses honouring `err.status`, extension folders may be symlinks.

### Changed
- The roadmap order: the database client (M5) before the branch switch (M4); PostgreSQL moved to future developments.

## [1.4.0] - 2026-10-20 — M3 Extension architecture

### Added
- Extension system: every feature lives in `extensions/<code>/` with a `setting.json` manifest, backend routes declared in the manifest (served under `/api/ext/<code>`), `view.html`, `sidebar.html`, `view.js` and `style.css`. Contract in `docs/EXTENSIONS.md`.
- Loader with manifest validation, required/optional dependencies, topological order, cycle detection and per-extension states (`ok`, `warning`, `disabled`), visible in `GET /api/core/extensions`.
- Configuration by section: each key of `config.json` is owned and validated by one extension; writes are atomic.
- Export/Import dialogs built from the checkboxes declared by the extensions (Tunnel SSH, Progetti NPM); Import lets you choose what to apply and whether to merge or replace.
- UI shell: tabs and header buttons ordered by the manifests, lazy loading or preload of the extension modules, header pills, badges, desktop notifications, output drawer per panel.
- npm workspaces (`extensions/*`) for extension dependencies.
- Integration test suite (`npm test`, 50 tests) and `CLAUDE.md`.
- `DEVDOCK_EXTENSIONS_DIR` environment variable.

### Changed
- SSH tunnels, NPM, Git, PM2 and Swagger are now extensions; the core keeps only security, configuration, loader, shared services and the shell.
- APIs moved under `/api/ext/<code>/…` (extensions) and `/api/core/…` (core).
- Git actions run as sequences of steps (`fetch` before `push` is optional), and the per-repository lock lasts as long as the commands even if the browser disconnects.
- A port typed in a tunnel card is no longer reset by the 5-second refresh.

### Fixed
- PM2 status badges had an unterminated `class` attribute and showed no colours.
- The custom port of a tunnel is validated (1–65535).

### Removed
- `public/core/app.js` (the monolithic frontend), `routes/*` except `routes/core.js`, `lib/tunnels.js`, `lib/process.js`, `lib/projects.js`, `lib/git.js`.

## [1.3.0] - 2026-10-19 — M2 Known bugs

### Fixed
- Git push failing with `cannot lock ref: is at X but expected Y` (backlog #1). The UI sent every git action twice (pull, push, fetch, merge, stash…), so two concurrent `git push` processes raced to update the same ref; more commits widened the race window. The UI now sends a single request, and the server runs only one git action at a time per repository (concurrent requests get 409).
- Commit graph lanes named `branch-2`, `branch-3`… instead of the real branch (backlog #2). Lanes now inherit the branch name from the first commit with a ref, and merged branches that were later deleted take their name from the merge message (`Merge branch 'x'`, `Merge pull request #n from user/x`).
- In the graph legend the ↗ icon now marks remote branches only (it used to mark any name containing `/`, such as a local `feature/x`); ◉ marks the current branch; `origin/HEAD` is no longer shown as a ref.
- Importing a "Git / NPM only" export was rejected, *replace* with a partial export wiped the sections missing from the file, and *merge* ignored projects. The import now applies only the sections present in the file, projects included.
- Comments out of sync with the code.

### Changed
- `.claude/launch.json` (local preview configuration) is ignored by git.
- The git log endpoint also returns the list of local branches.

## [1.2.0] - 2026-10-19 — M1 Security

### Security
- Requests whose `Origin` (or `Referer`) is not the UI itself get 403: a web page open in the browser can no longer make DevDock run commands (CSRF).
- Only the `Host` headers `127.0.0.1:<port>` and `localhost:<port>` are accepted (DNS rebinding defence).
- POST/PUT/PATCH on `/api` require `Content-Type: application/json`.
- Security headers: Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`.
- Git: whitelisted actions; branches validated with `git check-ref-format`, remotes must be configured ones, hexadecimal hashes; values starting with `-` can no longer become git options.
- Git commit: only files listed by `git status` can be passed, after `--`.
- npm: only `install` and the scripts defined in `package.json` run; package names are validated (no path traversal).
- PM2: whitelisted actions and validated process names; starting from a project no longer accepts an arbitrary folder.
- `config.json`: every write (UI, import, API) is validated (keys, ports, `remote` host:port, SSH alias, colours, absolute paths, references between groups and servers) and PUT requests only accept known fields.
- Frontend: correct escaping of values in `onclick` handlers (file names, scripts or processes containing quotes could inject JavaScript) and of colours in styles.
- Swagger UI and js-yaml are loaded with Subresource Integrity.

### Added
- `POST /api/projects/:id/npm/update` endpoint to update a dependency.
- `DEVDOCK_PORT` and `DEVDOCK_CONFIG` environment variables.

### Changed
- Git status uses `--porcelain -z`: exact file names even with spaces or special characters.
- Validation errors of git actions are shown in the output panel.

### Fixed
- "Update" on a dependency ran `npm run "update <pkg>"` and always failed.
- Without `pm2` installed, any PM2 action crashed the server.
- "Start with PM2" launched `npm` with no arguments instead of `npm run <script>`.
- After a restart, the exit of the previous npm process marked the new one as stopped.

### Removed
- `/api/git/repos/:id/debug-push` endpoint: it exposed the environment and `git config`, which can contain tokens.

## [1.1.0] - 2026-10-18 — M0 Cleanup and macOS portability

### Added
- `README.md`, `CHANGELOG.md` and `ROADMAP.md`.
- `GET /api/system` endpoint reporting which external tools are installed (`ssh`, `autossh`, `git`, `npm`, `pm2`, `lsof`, `ss`).
- UI notices when `pm2` or `autossh` are missing, with the install command and a "Ricontrolla" (recheck) button.

### Changed
- The package is named `devdock` (previously `port-forward-manager`); added `package-lock.json`.
- Port detection for npm processes uses `lsof` (macOS and Linux), falling back to `ss` on Linux, and no longer goes through the shell.
- The "PM2" button on scripts only appears when `pm2` is installed.

### Fixed
- npm process ports were always empty on macOS (`ss` does not exist there).
- Tunnels and npm processes stayed alive when the server was stopped with `kill` (SIGTERM) or by closing the terminal (SIGHUP): they are now terminated as with Ctrl+C.
- A new configuration, or one created by an older version, had no `projects` key.

### Removed
- Root `index.html`, an unused copy of `public/index.html`.
- `Zone.Identifier` file left by Windows.

## [1.0.0] - 2026-10-18

First version under version control.

### Added
- SSH tunnels organised in groups, with automatic reconnection, logs and desktop notifications.
- npm projects: script execution with streaming logs, listening ports, dependencies and `npm outdated`.
- PM2 process management.
- Git client: status, commit, commit graph, pull/push/merge/checkout/stash.
- Swagger/OpenAPI preview.
- Configuration in `config.json` with export and import.
