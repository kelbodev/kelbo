# The `db-engine` capability

The Database section (`db-client`) is the **host**: connections and folders, passwords in the core vault, SSH tunnels, confirmation tokens, multi-statement runs, `?`/`:name` parameters, CSV/JSON/SQL export, migration files, the designer's model, MCP tools and the whole interface. Everything that depends on the database is done by an **engine**: an extension that provides the capability `db-engine` (see *Providers* in `docs/EXTENSIONS.md`).

```json
"provides": [{ "capability": "db-engine", "id": "postgres", "title": "PostgreSQL", "handler": "postgres" }]
```

A connection names its engine in `type` (`mysql` when missing, for connections saved before engines existed). The host reads the engines with `ctx.providers('db-engine')` at every use: a connection whose engine is missing or off stays saved and is marked *engine not installed*; its operations answer `400 db-client.engine_missing`.

MySQL/MariaDB is the built-in `db-mysql` (`extensions/db-mysql/engine.js`): read it as the reference implementation.

## The engine object

`instance.providers[handler]` of the engine's backend is an object with these members. *pool* is whatever the engine's `createPool` returns; the host keeps one per connection and database and never looks inside it.

### Description

| Member | |
|---|---|
| `driver()` | `{ name, version }` of the driver, shown in the info |
| `connection` | `{ fields, defaultPort, tunnel }`: the connection fields the form shows, among `host`, `port`, `user`, `password`, `database` (others are added with the engines that need them); `tunnel: false` when the engine can't go through an SSH tunnel |
| `dialect` | Data for the frontend: `quote` (`` ` ``, `"` or `[`), `keywords` (array, for highlighting and completion), `schemas` (true if databases contain schemas), `ddl` (`{ types, fkActions, engines }` for the designer, or `null` without a designer), `snippets` (`firstRows`, `count`, `showCreate`, `showCreateView`, `distinct`, with `{table}`, `{column}`, `{alias}` already quoted by the host; a missing snippet hides its menu item) |

### Connection and execution

| Member | |
|---|---|
| `createPool(options, { readOnly })` | `options`: `{ host, port, user, password, database, connectTimeout }` (host and port of the tunnel when the connection uses one). With `readOnly` the server itself must refuse writes when the database can do it (MySQL: `SET SESSION TRANSACTION READ ONLY`) |
| `closePool(pool)` | |
| `test(options)` | Opens a connection and returns `{ version, user, db }` |
| `acquire(pool)` / `release(session)` | A session for several statements in a row (variables, temporary tables, transactions) |
| `query(pool, sql, params, { rowsAsArray })` | A read with `?` placeholders (the engine translates them to its own style) → `{ rows, fields }` |
| `execute(pool, sql, limit, { readOnly, session })` | Runs one statement written by the user. Rows stream and stop at `limit`. → `{ kind: 'rows', ms, truncated, rowCount, columns: [{ name, table, db, column, type }], rows }` or `{ kind: 'result', ms, affectedRows, changedRows, insertId, warningStatus, info }`. With `readOnly` it runs inside a read-only transaction rolled back at the end (MCP). Cell values ready for JSON: binary as `0x…` hex (shortened), JSON as text |
| `transaction(pool, statements)` | All or nothing → total affected rows |
| `stream(pool, sql, params)` | Async generator for the export: first `{ fields: [names] }`, then one array of raw values per row |

### SQL text

| Member | |
|---|---|
| `sql.classify(sql)` | `{ kind: 'read' \| 'write' \| 'empty' \| 'invalid', verb, reason?, word? }`. Only statements recognised as reads may be `read`: anything unknown is a `write`, so it asks for confirmation. Reasons are codes translated by the host (`missing`, `empty`, `single_statement`, `use_unsupported`, `explain_analyze_write`, `into`, `row_lock`, `write_word`) |
| `sql.splitStatements(sql)` | `[{ sql, start }]`, split at top-level `;` |
| `sql.schemaChange(sql)` | `{ table, operation }` of a schema statement (migration file name), or `null` |
| `sql.describeParams(sql)` / `sql.bindParams(sql, values)` | `?` and `:name` placeholders: the parameters to ask, and the text with the values escaped (`{ sql }` or `{ missing }`) |
| `sql.countQuery(sql)` | `{ sql, limit }`: a `COUNT(*)` of a read without its final limit, or `null` |
| `quoteId(name)`, `qualify(db, table)` | Quoted identifier, qualified table name |
| `escape(value)`, `literal(value)`, `format(template, params)` | A value as SQL; a cell value for an SQL export file; `?` replaced by escaped values |
| `asText(columnSql)` | Text expression of a column for the search with `LIKE` |
| `page(sql, params, limit, offset)` | `{ sql, params }` of one page of a `SELECT` |

### Metadata

| Member | |
|---|---|
| `listDatabases(pool, { readOnly })` | Names |
| `listTables(pool, db)` | `[{ name, type, engine, rowsEstimate, comment, view }]` |
| `columns(pool, db, table)` | `[{ name, type, dataType, nullable, key, default, extra }]`, `key: 'PRI'` for primary key columns |
| `tableInfo(pool, db, table)` | `{ columns, indexes: [{ name, unique, columns }], foreignKeys: [{ name, columns, refDatabase, refTable, refColumns }] }`, or `null` if the table doesn't exist |
| `createTableText(pool, db, table)` | SQL that recreates the table (SQL export with structure) |
| `introspect(pool, db, tables)` | The tables in the designer's model: `{ tables: { <name>: { columns, primaryKey, indexes, foreignKeys, engine?, comment? } } }` |

### Rows and schema

| Member | |
|---|---|
| `dml.insert(from, values)`, `dml.update(from, values, key)`, `dml.delete(from, key)`, `dml.deleteMany(from, pk, keys)` | Statements with the values escaped, at most one row per key; `from` comes from `qualify` |
| `ddl.createTableSql(db, definition)`, `ddl.DdlError` | `CREATE TABLE` from the designer's definition; errors are `DdlError` with `key` and `params`, translated by the host as `errors.ddl_<key>` |
| `schema.statements(db, operations)`, `schema.diff(from, to, renames)`, `schema.destructive(operations, before)`, `schema.proposeName(operations)` | The designer's operations (see `db-mysql/ops.js`) as statements, the operations between two structures, the warnings of operations that can lose data, the migration file name |
| `errorInfo(error)` | `{ message, code }` of a driver error: the host answers `db-client.database` with `params.dbCode` |
