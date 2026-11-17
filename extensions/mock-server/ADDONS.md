# Mock add-ons

The Mock section (`mock-server`) is a host for **add-ons** (Kelbo ≥ 2.45, `mock-server` ≥ 1.1): extensions that add buttons next to the response body of a route, in the route dialog. The general contract is in [docs/EXTENSIONS.md → Add-ons](../../docs/EXTENSIONS.md); this file is the API the Mock section offers.

```json
"addon": { "host": "mock-server", "version": ">=1.1", "js": "addon.js", "points": ["route-body"], "optional": true }
```

## Points

| Point | What |
|---|---|
| `route-body` | Buttons next to the body type (JSON / Text / None) in the dialog of a route, new or saved |

## Host API (`activate(ctx, host)`)

| Member | |
|---|---|
| `version` | Version of the Mock extension |
| `addBodyAction({ icon?, label, title?, run, when? })` | A button next to the response body. `label` and `title` are a text or a function `target → text`; `when(target)` hides the button where it returns false (e.g. only for a saved route); `run(target)` runs on click (it may return a promise). Errors are shown as a toast |
| `saveBody(mockId, routeId, text)` | Replaces the JSON body of a saved route and redraws the section; resolves to the saved route |

`target` describes the response in the dialog:

| Field | |
|---|---|
| `mock` | `{ id, label, port }` |
| `route` | `{ id, method, path, label }` of a saved route, `null` for a new one |
| `body`, `bodyType` | What is written in the dialog now (`json`, `text` or `none`) |
| `setBody(text, bodyType = 'json')` | Writes into the body field of the dialog while it is open (returns `false` once it is closed); the route is saved with the dialog's **Save** |
| `saveBody(text)` | Saves the JSON body into the route even after the dialog is closed (`null` for a new route) |

## Example

The Toolbox uses both: *Edit in the Toolbox* closes the dialog and opens the body in its JSON tab with `saveBody` to send it back, *Import from the Toolbox* writes its current JSON with `setBody`.
