# NPM add-ons

The NPM section (`npm`) is a host for **add-ons** (Kelbo ≥ 2.39, `npm` ≥ 1.1): extensions that add buttons to the row of every script. The general contract is in [docs/EXTENSIONS.md → Add-ons](../../docs/EXTENSIONS.md); this file is the API the NPM section offers.

```json
"addon": { "host": "npm", "version": ">=1.1", "js": "addon.js", "points": ["script-actions"], "optional": true }
```

`optional: true` suits an extension that also works without the NPM section, like the official Terminal.

## Points

| Point | What |
|---|---|
| `script-actions` | Buttons on the row of a `package.json` script (and of `npm install`), after the section's own buttons |

## Host API (`activate(ctx, host)`)

| Member | |
|---|---|
| `version` | Version of the NPM extension |
| `addScriptAction({ icon?, label, title?, run, when? })` | A button on the row of every script. `label` and `title` are a text or a function `target → text`; `when(target)` hides the button where it returns false; `run(target)` runs on click (it may return a promise). Errors in `label`, `when` and `run` are shown as a toast and don't stop the section |

`target` describes the script:

| Field | |
|---|---|
| `projectId`, `project`, `path` | The project: id, label and folder |
| `script` | Name of the script (`install` for `npm install`) |
| `command` | The command that runs it: `npm run <script>`, `npm install` |
| `definition` | Its definition in `package.json` (`null` when unknown) |
| `running` | Whether the section is running it now |
| `prepare()` | Does what **Run** does before a script, for an add-on that runs it elsewhere: starts the tunnels linked to the project (Tunnels button of the section). Resolves to `{ log, failed }`: the lines **Run** would print before the command and the tunnels that did not start, with the reason (`npm` ≥ 1.2) |

## Example

```js
// addon.js of the Terminal: "Run in shell" opens a terminal in the project folder and runs the script there
export default {
  activate(ctx, npm) {
    npm.addScriptAction({
      icon: 'square-terminal',
      label: ctx.t('addon.runInShell'),
      title: target => ctx.t('addon.runInShellTitle', { command: target.command }),
      run: async target => {
        await target.prepare?.(); // the project's tunnels first, as Run does
        ctx.open('terminal', { project: target.projectId, command: target.command });
      },
    });
  },
};
```
