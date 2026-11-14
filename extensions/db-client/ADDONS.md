# Database add-ons

The Database section (`db-client`) is a host for **add-ons** (Kelbo ≥ 2.38, `db-client` ≥ 1.1): extensions that add items to its menus and tabs of their own to its workspace. The general contract is in [docs/EXTENSIONS.md → Add-ons](../../docs/EXTENSIONS.md); this file is the API the Database section offers.

```json
"addon": { "host": "db-client", "version": ">=1.1", "js": "addon.js", "points": ["database-menu", "table-menu", "workspace-tab"] }
```

## Points

| Point | What |
|---|---|
| `database-menu` | Items in the right-click menu of a database (or schema) in the tree, after the section's own items |
| `table-menu` | Items in the right-click menu of a table or view in the tree |
| `workspace-tab` | Tabs of the add-on next to the query tabs: while one is visible, the connection header, the toolbar, the editor and the results make room for it |

## Host API (`activate(ctx, host)`)

| Member | |
|---|---|
| `host.version` | Version of the Database section (`1.1.0`) |
| `host.addMenuItem(point, item)` | `point`: `'database'` or `'table'` (or the point ids). `item`: `{ icon, label, run(target), when?(target), disabled? }` — `label` and `disabled` can be functions of the target. Target of a database: `{ connection, database, engine, readOnly }`; of a table: the same plus `table` and `view` |
| `host.addTabType(type)` | `type`: `{ id, icon, title(state), mount(el, state, tab), update?(el, state, tab), unmount?(el, state), languageChanged?(el, state) }`. `mount` draws into `el` (a flex column filling the workspace); `tab` is `{ state, setState(patch), visible, close() }` — `setState` saves the state with the tabs of the session and redraws the tab titles |
| `host.openTab(typeId, state)` | Opens a tab of the type, or brings forward the one with the same `connection`, `database` and `state.key` (then `update` is called with the merged state). `state.connection` and `state.database` tie the tab to a connection and database (shown in the tab) |
| `host.connections()` | The connections: `[{ id, label, engine, readOnly, folder, projectId }]` (no secrets) |
| `host.schema(connection, database)` | `GET /api/ext/db-client/connections/:id/databases/:db/schema` → `{ connection, database, engine, tables: [{ name, view, comment, rowsEstimate, columns: [{ name, type, nullable, autoIncrement, comment }], primaryKey, indexes: [{ name, unique, columns }], foreignKeys: [{ name, columns, refTable, refColumns, refDatabase, onDelete, onUpdate }] }] }` — from the engine's `introspect`, for every engine; like the other reads of the section it opens the connection with the password in the vault (a locked vault answers 423: `ctx.vault.ensure()` and retry) |
| `host.openTable(connection, database, table)` | Opens the data of a table in a tab of the section |
| `host.openQuery(connection, database, sql)` | Opens a query tab with the text in the editor (not run) |

Tabs of add-ons are kept with the tabs of the browser session (type and state, so the state must be plain JSON); a tab whose add-on is no longer installed is dropped at the next start. Errors thrown by add-on code (menu actions, `mount`) are reported with a toast and don't stop the section.
