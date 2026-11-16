# HTTP add-ons

The HTTP section (`http-client`) is a host for **add-ons** (Kelbo ≥ 2.42, `http-client` ≥ 1.2): extensions that add buttons to the response of a request. The general contract is in [docs/EXTENSIONS.md → Add-ons](../../docs/EXTENSIONS.md); this file is the API the HTTP section offers.

```json
"addon": { "host": "http-client", "version": ">=1.2", "js": "addon.js", "points": ["response-actions"], "optional": true }
```

## Points

| Point | What |
|---|---|
| `response-actions` | Buttons on the response shown in the editor, after **Copy** (not on binary responses) |

## Host API (`activate(ctx, host)`)

| Member | |
|---|---|
| `version` | Version of the HTTP extension |
| `addResponseAction({ icon?, label, title?, run, when? })` | A button on the response. `label` and `title` are a text or a function `target → text`; `when(target)` hides the button where it returns false (e.g. `target => target.isJson`); `run(target)` runs on click (it may return a promise). Errors are shown as a toast and don't stop the section |

`target` describes the response:

| Field | |
|---|---|
| `status`, `statusText`, `url`, `ms`, `size` | Status, final URL, time and size |
| `headers` | `[{ name, value }]` |
| `contentType` | The `Content-Type` header (`''` when missing) |
| `body` | The body as text (`null` for binary responses); `truncated` when it was cut at the size limit |
| `isJson` | The body is valid JSON |
| `request` | `{ label, method, userType }` of the request in the editor |
| `section` | `{ id, label }` |
| `user` | Label of the user type it was sent with, or `null` |

## Example

```js
// addon.js of the Toolbox: the JSON of a response in the JSON tab
export default {
  activate(ctx, http) {
    http.addResponseAction({
      icon: 'wrench',
      label: ctx.t('addon.json'),
      when: target => target.isJson,
      run: target => ctx.open('toolbox', { json: target.body }),
    });
  },
};
```
