// Parametri di push per progetto (es. git push -o promote origin main): profili salvati e
// validati, solo parametri ammessi (niente --receive-pack, remote o refspec), push con il profilo
// che arrivano al remote, sezione di config esportabile
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, makeRepo, commitFile, git, parseSse } = require('../../../lib/testkit');

let srv, base, repo;
const api = (m, p, body) => srv.request(m, `/api/ext/git${p}`, body !== undefined ? { body } : {});

before(async () => {
  base = tmpDir('kelbo-git-push-');
  git(base, 'init', '-q', '--bare', 'remote.git');
  const bare = path.join(base, 'remote.git');
  git(bare, 'config', 'receive.advertisePushOptions', 'true');
  // il remote scrive le opzioni ricevute: così si vede che il push le ha mandate
  const hook = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, `#!/bin/sh\ni=0\nwhile [ $i -lt "\${GIT_PUSH_OPTION_COUNT:-0}" ]; do eval echo \\"\\$GIT_PUSH_OPTION_$i\\" >> "${path.join(base, 'options.txt')}"; i=$((i+1)); done\ncat > /dev/null\n`);
  fs.chmodSync(hook, 0o755);
  repo = makeRepo(path.join(base, 'app'));
  git(repo, 'remote', 'add', 'origin', bare);
  srv = await startServer({ projects: [{ id: 'app', label: 'App', path: repo }] });
});
after(() => srv?.stop());

test('profili: salvati per progetto, parametri ammessi e normalizzati, gli altri rifiutati', async () => {
  assert.deepEqual((await api('GET', '/repos/app/push-presets')).json, { presets: [] });
  let r = await api('PUT', '/repos/app/push-presets', { presets: [
    { label: 'Promote', args: '-o promote' },
    { label: 'CI', args: '--push-option=ci.skip -omerge_request.create --tags -u' },
    { label: 'Messaggio', args: '-o "note=con spazi"' },
  ] });
  assert.equal(r.status, 200, r.text);
  const presets = r.json.presets;
  assert.deepEqual(presets.map(p => p.args), [['-o', 'promote'], ['-o', 'ci.skip', '-o', 'merge_request.create', '--tags', '-u'], ['-o', 'note=con spazi']]);
  assert.deepEqual(srv.readConfig().gitPushPresets.app.map(p => p.label), ['Promote', 'CI', 'Messaggio']);
  // rifiutati: opzioni che eseguono programmi, remote/refspec, valori mancanti, nomi vuoti
  for (const [args, code] of [['--receive-pack=/tmp/x', 'git.push_arg_invalid'], ['--exec=sh', 'git.push_arg_invalid'], ['origin main extra', 'git.push_arg_invalid'],
    ['-o', 'git.push_option_value'], ['-o --tags', 'git.push_option_value'], ['', 'git.push_args_empty'], ['--force', 'git.push_arg_invalid']]) {
    r = await api('PUT', '/repos/app/push-presets', { presets: [{ label: 'X', args }] });
    assert.equal(r.json.code, code, `${args}: ${r.text}`);
  }
  assert.equal((await api('PUT', '/repos/app/push-presets', { presets: [{ label: '', args: '-o a' }] })).json.code, 'git.push_preset_label');
  // remote e branch nel profilo, anche incollando la riga intera
  r = await api('PUT', '/repos/app/push-presets', { presets: [{ label: 'Dev', args: 'git push -o promote origin dev' }, { label: 'Solo remote', args: '--tags origin' }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.presets.map(p => [p.args, p.remote, p.branch]), [[['-o', 'promote'], 'origin', 'dev'], [['--tags'], 'origin', undefined]]);
  for (const [args, code] of [['-o a origin dev extra', 'git.push_arg_invalid'], ['-o a origin "bad name"', 'git.push_branch_invalid'], ['-o a or:igin', 'git.push_remote_invalid']]) {
    assert.equal((await api('PUT', '/repos/app/push-presets', { presets: [{ label: 'X', args }] })).json.code, code, args);
  }
  // l'id resta quello di prima quando si modifica un profilo
  r = await api('PUT', '/repos/app/push-presets', { presets: [{ ...presets[0], label: 'Promote!' }, presets[1], presets[2]] });
  assert.equal(r.json.presets[0].id, presets[0].id);
  // config importata: validata come quella salvata
  const bad = await srv.request('POST', '/api/core/config/import', { body: { mode: 'merge', config: { gitPushPresets: { other: [{ id: 'x1', label: 'X', args: ['--receive-pack=/bin/sh'] }] } } } });
  assert.equal(bad.status, 400);
  const ext = (await srv.request('GET', '/api/core/extensions')).json.find(e => e.code === 'git');
  assert.ok(ext.export.some(x => x.sections.includes('gitPushPresets')));
});

test('push con un profilo: le opzioni arrivano al remote; profilo solo per il push', { skip: process.platform === 'win32' && 'hook sh' }, async () => {
  const presets = (await api('PUT', '/repos/app/push-presets', { presets: [{ label: 'Promote', args: '-o promote' }] })).json.presets;
  commitFile(repo, 'a.txt');
  const r = await api('POST', '/repos/app/action', { action: 'push', remote: 'origin', branch: 'main', preset: presets[0].id });
  assert.equal(r.status, 200, r.text);
  const events = parseSse(r.text);
  assert.equal(events.find(e => e.type === 'exit')?.data, 0, r.text);
  assert.deepEqual(fs.readFileSync(path.join(base, 'options.txt'), 'utf8').trim().split('\n'), ['promote']);
  // profilo con remote e branch: quelli del profilo, non quelli della richiesta
  git(repo, 'checkout', '-q', '-b', 'dev');
  commitFile(repo, 'b.txt');
  const dev = (await api('PUT', '/repos/app/push-presets', { presets: [...presets, { label: 'Dev', args: '-o promote origin dev' }] })).json.presets.at(-1);
  const r2 = await api('POST', '/repos/app/action', { action: 'push', remote: 'origin', branch: 'main', preset: dev.id });
  assert.equal(parseSse(r2.text).find(e => e.type === 'exit')?.data, 0, r2.text);
  assert.equal(git(path.join(base, 'remote.git'), 'rev-parse', 'dev').trim(), git(repo, 'rev-parse', 'dev').trim());
  // un remote salvato che nel repository non c'è: rifiutato al push
  const ghost = (await api('PUT', '/repos/app/push-presets', { presets: [{ label: 'Ghost', args: '-o x upstream dev' }] })).json.presets[0];
  assert.equal((await api('POST', '/repos/app/action', { action: 'push', remote: 'origin', branch: 'dev', preset: ghost.id })).json.code, 'git.remote_unknown');
  assert.equal((await api('POST', '/repos/app/action', { action: 'pull', remote: 'origin', branch: 'main', preset: presets[0].id })).json.code, 'git.push_preset_action');
  assert.equal((await api('POST', '/repos/app/action', { action: 'push', remote: 'origin', branch: 'main', preset: 'nope' })).json.code, 'git.push_preset_not_found');
});
