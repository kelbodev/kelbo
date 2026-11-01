# Kelbo — Roadmap

Open work, numbered again from M1 after Kelbo 2.1.0. The milestones closed up to 2.1.0 (M0–M17, with their original numbers, the ones the CHANGELOG uses) are archived in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md).

Status legend: `[ ]` to do · `[~]` in progress · `[x]` done

**Rules for every milestone**
- A milestone is closed only when `CHANGELOG.md` (`[Unreleased]` → version) and, when something changes for the user, `README.md` and `docs/EXTENSIONS.md` are updated.
- Versioning is SemVer: a closed milestone that changes Kelbo is a new minor version (M1 → 2.2.0, M2 → 2.3.0 and its follow-ups, …); a major version only when the extension contract changes (it would make every extension declaring `"devdock": "^2.0"` incompatible).
- Work on an extension of the [kelbo-extensions](https://github.com/kelbodev/kelbo-extensions) repository is released there with its own version and tag (`<code>@<version>`); Kelbo gets a new version only if the core changes too.

---

## M1 — MCP: stdio bridge — core ✅ (2.2.0)

Goal: Claude Desktop and the other clients that start MCP servers as processes reach Kelbo without a token in their configuration and without third-party packages. *(Formerly part of M8.13.)*

- [x] **M1.1** `bin/devdock-mcp.js` (also `devdock mcp` and the `devdock-mcp` bin): stdio ↔ Streamable HTTP with the MCP SDK already used by the server; port and token file of the instance from `DEVDOCK_PORT` / `DEVDOCK_CONFIG` like the server; the token is read again at every request (a 401 is retried once), so the bridge survives a regeneration; Kelbo not running or a token of another instance → a JSON-RPC error with a clear message (core catalogs)
- [x] **M1.2** The server creates the token on the first access to `/mcp` even when the request has no `Authorization` header (first start of the bridge)
- [x] **M1.3** 🤖 dialog: the Claude Desktop entry uses the bridge (absolute paths of Node.js and of the bridge, `env` only when the instance is not the default one) instead of `npx mcp-remote` with the token in clear
- [x] **M1.4** Tests (SDK stdio client through the bridge: tools listed and called, token regenerated while connected, Kelbo not running, token of another instance), README

## M2 — Secrets behind the master password, lost clicks — core and extensions ✅ (2.3.0 – 2.5.0)

Goal: no secret is typed or kept without the master password, and a click on a button always lands — or visibly works.

- [x] **M2.1** HTTP client: the 👤 Users dialog asks for the master password (or creates it) before opening; creating or editing a user type, pasting a token and logging in are refused by the server with the vault locked (`423`); the tokens kept in memory are forgotten when the vault is locked
- [x] **M2.2** MongoDB (`mongo-client@1.2.0`): the whole section needs the master password, like the Database section; locked, the sidebar shows *Unlock* and every route answers `423`
- [x] **M2.3** Core `ctx.ui.patch(el, html)`: containers redrawn on their own are updated only when their HTML changes, and after the click when the mouse is pressed inside them (a button replaced between mousedown and click lost the click); used by the header pills, SSH tunnels and NPM (polling every 5 s), Git (automatic refresh, which no longer shows "loading" over the log), Database (data grid, results, table designer) and MongoDB
- [x] **M2.4** Master password dialog closed by clicking outside it or replaced by another dialog: the waiting action gives up instead of staying suspended (before, every later action needing the vault did nothing until the page was reloaded)
- [x] **M2.5** *(2.3.1)* Feedback after a click: a request to the server started by a click puts the button on hold (spinner, no further clicks) and the cursor in "busy" until the answer, so slow actions (reading an extension's repository, the master password, connecting to a database) no longer look like lost clicks
- [x] **M2.6** *(2.4.0)* HTTP client OAuth: browser executable for the logins (WSL recognised: Windows Firefox or the Windows default browser), error and login link when the browser cannot start; client secret available with PKCE too (confidential Keycloak clients)
- [x] **M2.7** *(2.4.1)* HTTP client sidebar: requests grouped by user type (section ▸ user ▸ requests), new request per user, move under another user
- [x] **M2.8** *(2.5.0)* HTTP client files: body *File* and *Multipart form* read from disk when sending (path absolute or relative to the project); binary answers saved to Downloads with the name from `Content-Disposition` or the Content-Type

## M3 — Widgets and project dashboard — core and built-in extensions ✅ (2.17.0)

Goal: every extension can share a **mini view** (widget) of what it knows about a project, and a new **Dashboard** section puts the widgets of one project together: the npm scripts used most, the Git state with pull/push, the project's database, its to-do list… Today extensions share data only through backend services (`ctx.require`) and frontend events (`ctx.bus`); a widget adds a shared piece of UI, with no extension needing to know the others.

- [x] **M3.1** Widget contract (`docs/EXTENSIONS.md`, additive: extensions without widgets don't change): manifest block `widgets: [{ id, title, scope: "project", size: "s" | "m" | "l", js }]`; the widget module exports `mount(ctx, el, { project })`, optional `refresh`, `unmount`, with the extension's own frontend `ctx` (its API, translations, `ctx.ui`, `ctx.vault`) plus `ctx.widget`: `setBadge`, `setTitle`, `openFull(params)` (opens the extension's section on that project). Widgets are listed by `/api/core/extensions`; a widget that fails shows its error in its own box and never breaks the others
- [x] **M3.2** Core widget host: `ctx.widgets.list(scope)` and `ctx.widgets.mount(id, el, params)` for any extension that wants to show widgets; modules loaded on demand with the extension's CSS and catalogs; the same click-feedback and redraw rules as the panels (M2)
- [x] **M3.3** Built-in extension `dashboard` (tab): project selector (the core projects, also from a link in NPM/Git/the sidebar), grid of the widgets for that project; per project the user chooses which widgets to show, their order (drag) and size, saved in its config section; *Add widget* lists the widgets of the loaded extensions; refresh on ↻ and when the tab is shown
- [x] **M3.4** Widgets of the built-in extensions:
  - **NPM** — scripts used most in the project (run counter kept by the extension in the Kelbo home, not in `config.json`), running processes with ports, run/stop/restart, a link to the logs
  - **Git** — branch, ahead/behind, changed files, last commits; fetch, pull and push (push after a confirmation showing the commits that will be sent)
  - **Database** — connections linked to the project (`projectId`, already there): status, pending migrations of the linked repository, a link that opens the connection
  - **Env** — `.env` files of the project with missing or empty keys compared with the template (never the values)
  - **HTTP** — sections linked to the project: their requests, with send from the widget and the status of the last answer
  - **SSH tunnels** — the tunnels used by the project's database connections, with connect/disconnect
- [x] **M3.5** Widgets of the installed extensions in kelbo-extensions, each released with its own version: `mongo-client` (connections linked to a project — needs a `projectId` field like the DB client), `ports` (ports in use by the project's processes); `notes` gets its widget in M4.6
- [x] **M3.6** Tests (contract and host with fixture extensions, a broken widget isolated, dashboard layout saved per project), README section "Dashboard", CHANGELOG

## M4 — Notes and to-do lists — new external extension `notes` (kelbo-extensions) — `notes@1.0.0` ✅ except M4.5 and M4.7

Goal: to-do lists and notes kept next to the code, one board per project. Small and self-contained, so it is born as an installable extension in `kelbo-extensions`; the core does not change. *Changed from the first plan: the content is encrypted with the master password (it may hold anything), boards are the projects themselves instead of free sections, and notes are sticky notes instead of Markdown documents.*

- [x] **M4.1** Data: one board per project of Kelbo plus *General*; each board holds to-do lists (name and items: text, done, done date) and notes (text, colour, last change). The content of a board is one box encrypted by the core vault, in the extension's section `notesBoards`; the vault locked → `423` on every route; master password changed → re-encrypted, reset → deleted. Export/Import checkbox "Note e to-do"
- [x] **M4.2** Sidebar: *General* and the projects (with their folders), the number of open items per board, boards of removed projects under *Removed projects*; the badge on the tab counts the open items
- [x] **M4.3** Notes: sticky notes in a grid, six colours, saved automatically a moment after the last keystroke with a "saved" indicator; a note changed elsewhere in the meantime is not overwritten (`409`)
- [x] **M4.4** To-do lists: several per board; add an item with Enter, edit in place, check/uncheck, reorder by dragging, delete; done items under the open ones with their date and *Clear done*; lists renamed in place, moved and deleted from their menu
- [ ] **M4.5** From the NPM and Git sections, a link *Notes of this project* opens the extension on that project (`ctx.open` and the event bus, only when `notes` is installed)
- [x] **M4.6** Widget for the project dashboard (M3): open items of the project's lists (check them from the widget, add one) and the last notes changed
- [ ] **M4.7** Search across list names, items and notes of every board, with the matches highlighted

## M5 — DB client: PostgreSQL and SQL Server — extension `db-client`

Goal: the Database section works with PostgreSQL and Microsoft SQL Server as well as MySQL/MariaDB, with the same features and the same safety rules (every change shown and confirmed before it runs, read-only connections, passwords in the core vault). *(Formerly M16; replaces the even older M5.7 and M7.15.)*

- [ ] **M5.1** Engine layer in `db-client`: one module per engine (`engines/mysql.js`, `engines/postgres.js`, `engines/mssql.js`) with pool and connection, query with timeout and row limit, read-only transaction, identifier quoting and value escaping, pagination, list of databases/schemas/tables, introspection and error mapping. MySQL moves onto it first with no change in behaviour (the existing tests stay green). Connection field `type`: `mysql` (default), `postgres`, `mssql`, with default ports 3306 / 5432 / 1433. Drivers as npm workspace dependencies of `db-client`: `pg` and `mssql` (tedious), both pure JavaScript, so they work the same on macOS and Windows; SQL Server uses SQL authentication only (Windows integrated authentication would need a native driver)
- [ ] **M5.2** Per-dialect statement classification (only recognised reads run without confirmation): PostgreSQL dollar quoting, `E''` strings, `::` casts, `RETURNING`, `COPY`, `DO`, `LISTEN`/`NOTIFY`; SQL Server `[brackets]`, `N''` strings, `EXEC`, `MERGE`, `SELECT … INTO` (a write), `GO` batch separator refused. Parametric queries keep `?` and `:name` in the editor and are bound with the engine's syntax
- [ ] **M5.3** Connection options per engine: PostgreSQL `sslmode`, SQL Server `encrypt` / `trustServerCertificate` (needed for local Docker and Azure), default database, through an SSH tunnel as today; connection test
- [ ] **M5.4** Sidebar tree with schemas for PostgreSQL and SQL Server: connection ▸ database ▸ schema ▸ tables/views ▸ columns (MySQL unchanged), context menu on tables as today; SQL editor highlighting with each dialect's keywords
- [ ] **M5.5** Data browser for the new engines: pagination (`LIMIT/OFFSET`, `OFFSET … FETCH`), search, filters, sorting, inline and dialog edit, multiple deletion, multi-cell edit in one transaction; types shown and edited correctly (PostgreSQL arrays, `json`/`jsonb`, `uuid`, `bytea`; SQL Server `uniqueidentifier`, `datetime2`, `varbinary`, identity columns); export as CSV, JSON and SQL
- [ ] **M5.6** Table designer and schema changes per dialect: list of types, identity/serial columns, defaults, indexes, foreign keys; generated `ALTER` statements (PostgreSQL `ALTER COLUMN … TYPE/SET DEFAULT/SET NOT NULL`; SQL Server `sp_rename`, named default constraints); DDL in a transaction where the engine allows it, so a failure leaves nothing half applied
- [ ] **M5.7** Migrations for the new engines in the same `NNN_<table>_<operation>.sql` files, with the dialect's SQL
- [ ] **M5.8** The existing MCP tools of the DB client (`db_client_*`) keep working with the new engines (with schemas; reads in a read-only transaction: `BEGIN READ ONLY` on PostgreSQL, a transaction always rolled back on SQL Server plus the classification of the statement); no new MCP features
- [ ] **M5.9** Tests (in `extensions/db-client/tests/`, with the core test kit): per-dialect unit tests that need no server (classification, quoting, pagination, DDL generation, introspection mapping), integration tests against disposable PostgreSQL and SQL Server servers when they are available (skipped otherwise, like the MySQL ones); README, CHANGELOG

## M6 — Installation script and Kelbo updates from the interface — core

Goal: Kelbo is installed with one command and kept up to date from the header, like the installed extensions; it runs under PM2, so a restart after an update is handled for you.

- [ ] **M6.1** Installation script (`install.sh` for macOS/Linux/WSL, `install.ps1` for Windows): checks Node.js (minimum version) and PM2 (offers `npm i -g pm2` when missing), clones Kelbo at the latest release tag into a chosen folder (default `~/kelbo`), runs `npm install --ignore-scripts`, starts it with `pm2 start` (process name `kelbo`, `KELBO_PORT` if given) and `pm2 save`; run again on an existing installation, it updates it. Idempotent, with a clear message at every step; never touches an existing `config.json`
- [ ] **M6.2** Update check of Kelbo itself: the latest `v<x.y.z>` tag of the repository compared with the running version (at start-up, once a day and on demand, like the extensions); a dot on the header (🧩 or a dedicated button) and *Kelbo x.y.z available* in the Extensions panel, with the CHANGELOG of the versions in between
- [ ] **M6.3** *Update Kelbo* from the interface, only for a git checkout with no local changes: `git fetch --tags`, checkout of the new tag (fast-forward only, refused with a clear message otherwise), `npm install --ignore-scripts`, progress shown live; the previous tag is kept for a *previous version*. Confirmation first: tunnels, npm processes and mock servers started by Kelbo stop at the restart
- [ ] **M6.4** Restart: under PM2 (`pm_id` in the environment) Kelbo asks PM2 to restart it (`pm2 restart kelbo` run detached) and the page shows *restarting…*, polls `/api/core/system` until the new version answers and reloads itself (with a timeout and the manual command if it does not come back); without PM2 the update is applied and the page says to restart by hand
- [ ] **M6.5** Tests (update check against a local repository with tags, refused update with local changes, restart request mocked), README (installation and updates), CHANGELOG

## M7 — New name: Kelbo — core and extensions ✅ (2.13.0) except the website (M7.6)

Goal: DevDock becomes **Kelbo** (the old name was taken by other developer tools and had no free domain). Repositories in the `kelbodev` organization, website on `kelbo.dev`; existing installations keep working without manual steps.

- [x] **M7.1** Name in the interface (page title, header logo), in the catalogs of every language, in MCP instructions and tool descriptions, in README and docs; repositories moved to `kelbodev/kelbo` and `kelbodev/kelbo-extensions` (GitHub redirects the old URLs); links and official catalog updated, the old catalog URL saved in `config.json` is read as the new one
- [x] **M7.2** Apache 2.0 license (`LICENSE`, `"license"` in `package.json`) in both repositories
- [x] **M7.3** Technical names: package and commands `kelbo` / `kelbo-mcp`; `~/.devdock` moved to `~/.kelbo` at the first start, **with everything in it**: the installed extensions (`extensions/`, each with its own `node_modules`), the lock file `extensions.lock.json` (versions, tags, commits: no absolute paths, so nothing to rewrite) and the `backups/` of the previous versions, so the downloaded extensions keep working and keep their *previous version* without reinstalling anything (one `rename` on the same disk, otherwise copy, check and only then delete the old folder; never half moved: on any error Kelbo goes on with `~/.devdock` and says why). Not moved when `DEVDOCK_HOME`/`KELBO_HOME` is set or when `~/.kelbo` already exists (both kept, a warning says which one is used); `KELBO_*` variables, with `DEVDOCK_*` still read; MCP token file and server name `kelbo` (setup snippets in the 🤖 dialog, old token file renamed); manifest field `"kelbo"`, with `"devdock"` still accepted; PM2 process name
- [x] **M7.4** Lock file and list of the installed extensions: repository URLs of `codo82/devdock-extensions` rewritten to `kelbodev/kelbo-extensions` at start-up (until then the GitHub redirect serves them)
- [x] **M7.5** `kelbo-extensions`: repository URLs in `index.json`, READMEs, manifests and package names of the extensions
- [ ] **M7.6** Website `kelbo.dev`: static page in Italian and English (what it does, extensions, screenshots, installation), GitHub Pages with the custom domain
- [x] **M7.7** Tests (migration of the home folder with installed extensions, lock file and backups — extensions loaded and updatable from the new folder, *previous version* still available; copy fallback; existing `~/.kelbo` left alone; of the token file and of the lock file; old variables and manifest field), README, CHANGELOG

## M8 — Angular CLI — new external extension `angular-cli` (kelbo-extensions)

Goal: run the Angular CLI generators of a project from Kelbo (component, service, directive, pipe, guard…) with a form built from the generator's own options, see the files before they are written, and keep `ng add` / `ng update` at hand. Angular-specific, so it is born as an installable extension in `kelbo-extensions` (`angular-cli@1.0.0`); the core does not change.

- [ ] **M8.1** Angular workspaces among the core projects: a project with `angular.json` is recognised, with its applications and libraries (`projects` of `angular.json`), the Angular CLI version installed in the project (`node_modules/@angular/cli`) and the defaults of `schematics` in `angular.json`; the CLI is always the project's own (`node_modules/.bin/ng`, run without a shell), never a global one; a project without `node_modules` shows *run npm install first* (with the NPM extension, a button that does it)
- [ ] **M8.2** Generators: the schematics of `@schematics/angular` (component, service, directive, pipe, guard, interceptor, resolver, class, interface, enum, module, environments, config…) plus those of the other collections installed in the project (packages with a `schematics` field, e.g. Angular Material, NgRx), read from their `collection.json`; hidden and private schematics left out
- [ ] **M8.3** Generate dialog: target project of the workspace, name with optional path (`features/orders/order-list`), and a form built from the schematic's `schema.json` (booleans, enums, strings, `x-prompt` texts as labels), with the `angular.json` defaults pre-filled and only the changed options passed to the CLI; every value validated before it reaches the command (`ctx.lib.validate`)
- [ ] **M8.4** Preview with `--dry-run` before writing: files that would be created or updated, with their path; *Generate* runs the same command for real, shows its output live and lists the files written; the preview is rebuilt when the form changes, and a file that would be overwritten is marked
- [ ] **M8.5** Recent generators per project (schematic and options, without the name) to repeat one with a click; the last options used become the defaults of the dialog for that project
- [ ] **M8.6** `ng add <package>` (with the package's own prompts answered from a form when it declares them, otherwise run with `--defaults`) and `ng update`: list of the packages that can be updated, update one or all, output live; refused when the Git working tree has uncommitted changes, unless confirmed (with the Git extension, the changed files are shown)
- [ ] **M8.7** Link with the other sections: from NPM and Git, *Angular CLI* on Angular projects (only when `angular-cli` is installed); widget for the project dashboard (M3) with the quick generators
- [ ] **M8.8** MCP tools: list of the Angular workspaces and of their generators with options (read-only); `angular_cli_generate` (state-changing, dry run unless `apply: true`)
- [ ] **M8.9** Tests with the Kelbo test kit (fixture workspace with a fake `ng` that records its arguments and answers like the dry run; real `collection.json` / `schema.json` of `@schematics/angular` as fixtures for the form), README, CHANGELOG, release `angular-cli@1.0.0`

## M9 — Kubernetes and port-forward tunnels — core contract, `tunnels`, new external extension `kubectl` (kelbo-extensions)

Goal: see the pods of a cluster from Kelbo (`kubectl get pods`, live), and open a `kubectl port-forward` from the **Tunnels** section like an SSH tunnel (status, auto start, reconnection, use from the DB client and the other extensions). Tunnels doesn't depend on `kubectl`: it finds whoever offers a tunnel *transport* through a new contract, the same way the dashboard finds the widgets of M3.

**Core contract: providers**
- [ ] **M9.1** Manifest block `provides: [{ capability, id, title, handler }]` (additive, `docs/EXTENSIONS.md`): an extension declares that it offers an implementation of a named capability (e.g. `tunnel-transport`); the loader checks that `handler` exists in the backend (`instance.providers`), like it does for routes and MCP tools. Core `ctx.providers(capability)` lists the implementations of the enabled extensions, with their `title` translated, and calls them; an extension disabled or removed disappears from the list without errors in the ones that use it. Each capability is described by the extension that consumes it (its methods, parameters and events), in its own section of `docs/EXTENSIONS.md`
- [ ] **M9.2** Capability `tunnel-transport`, described by `tunnels`: `fields(values)` → form fields of the transport (key, label, type, required, options; lists that depend on other fields, e.g. namespaces of a context, pods of a namespace, ports of a pod), `validate(params)`, `start(params, localPort)` → handle with `stop()`, events `ready`, `exit(code, output)`; parameters validated by the provider before anything reaches a command

**Tunnels**
- [ ] **M9.3** Type of tunnel in the editor: SSH (built-in, unchanged) or one of the transports found with `ctx.providers('tunnel-transport')`; the form of a transport is built from its `fields`, with the dependent lists refreshed when a field changes. Saved tunnels keep `transport` and its parameters in the tunnels config section (Export/Import as today); a tunnel whose transport is not installed is shown as *unavailable* with the name of the missing extension, not deleted
- [ ] **M9.4** Same behaviour for every transport: local port chosen or free, start/stop, status pill, auto start, reconnection with back-off when the process exits, last output on error, owner in **Ports in use**; `ensureTunnel(key)` works for any transport, so a DB client connection can go through a port-forward with no change in `db-client`

**Extension `kubectl`**
- [ ] **M9.5** Contexts from the user's kubeconfig (`kubectl config get-contexts`, the file is never copied), namespaces per context; the `kubectl` of the machine run without a shell, with `--context` and `-n` always explicit; a context can be marked **protected** (e.g. production): every change asks to type the context name
- [ ] **M9.6** Pods: list per context and namespace with status, ready containers, restarts, age, node, labels; filter by text and label; refresh and watch (`kubectl get pods -w -o json`), with the change of status shown live
- [ ] **M9.7** On a pod: describe (events included), logs (container chooser, tail, follow, previous), delete through confirmation; on deployments and stateful sets: rollout restart and scale, through confirmation
- [ ] **M9.8** Provider `tunnel-transport` "Kubernetes port-forward": fields context → namespace → resource (pod, service or deployment, chosen from the live lists) → remote port (from the container ports or the service ports); `start` runs `kubectl port-forward <resource> <local>:<remote>` and reports ready when kubectl prints *Forwarding from*; a pod replaced by the deployment is followed by forwarding to the service or deployment instead of the pod name. From the pods list, *Port-forward…* opens the Tunnels editor pre-filled (only when `tunnels` is enabled)
- [ ] **M9.9** MCP tools (read-only): contexts, namespaces, pods with status, logs tail with a line limit; secrets and env values never returned
- [ ] **M9.10** Tests: providers contract with fixture extensions (discovery, a provider disabled while a tunnel uses it, missing handler refused); tunnels with a fake transport (start, ready, exit and reconnection, unavailable transport); `kubectl` with a fake `kubectl` that records its arguments and answers with JSON fixtures (pods, watch, port-forward output); README, CHANGELOG, release `kubectl@1.0.0` and a minor version of Kelbo for the contract

---

## Parked

Not planned for now; to be taken back into the roadmap when needed (descriptions in [docs/ROADMAP-HISTORY.md](docs/ROADMAP-HISTORY.md), section M8):

- MCP server: activity log of the calls (ex M8.12), resources and `list_changed` notifications (rest of ex M8.13), state-changing tools enabled one by one (ex M8.11)
- Swagger: specs kept on the server and read-only MCP tools (ex M8.14), in the `swagger` extension of kelbo-extensions

---

## Suggested order and size

| Milestone | Size | Where | Notes |
|---|---|---|---|
| M1 MCP stdio bridge | S | core | done in 2.2.0 |
| M2 Secrets and lost clicks | S | core, `http-client`, `mongo-client` | done in 2.3.0 |
| M3 Widgets and project dashboard | M | core contract and host, built-in `dashboard`, widgets in every extension | done in 2.17.0 (with the `notes` widget of M4.6) |
| M4 Notes and to-do lists | S | `notes` (kelbo-extensions); link in NPM and Git | `notes@1.0.0` done (boards per project, encrypted); link, widget and search left |
| M5 PostgreSQL and SQL Server | L | `db-client` | engine layer first (MySQL moved onto it with no change), then one dialect at a time |
| M6 Install script and updates from the interface | M | core, `install.sh`/`install.ps1` | script first (PM2 is the base of the restart), then check, update and restart from the interface |
| M7 New name: Kelbo | M | core, extensions, `kelbo-extensions`, website | done in 2.13.0 except the website (M7.6) |
| M8 Angular CLI | M | `angular-cli` (kelbo-extensions) | workspaces and generators first, then the form from `schema.json` with dry-run preview, then `ng add` / `ng update` and MCP tools |
| M9 Kubernetes and port-forward tunnels | L | core (`provides` contract), `tunnels`, `kubectl` (kelbo-extensions) | providers contract and `tunnel-transport` first (tested with a fake transport), then pods, then the port-forward provider |
