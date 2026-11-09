const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, tmpDir, makeRepo, commitFile, git } = require('../../../lib/testkit');

let srv, base, repo, hist;
before(async () => {
  base = tmpDir();
  repo = makeRepo(path.join(base, 'repo'));
  // origin con due pushurl verso due repo bare distinti (caso del backlog #1)
  git(base, 'init', '-q', '--bare', 'A.git');
  git(repo, 'remote', 'add', 'origin', path.join(base, 'A.git'));
  git(repo, 'push', '-q', 'origin', 'main');
  git(base, 'clone', '-q', '--bare', 'A.git', 'B.git');
  git(repo, 'remote', 'set-url', '--add', '--push', 'origin', path.join(base, 'A.git'));
  git(repo, 'remote', 'set-url', '--add', '--push', 'origin', path.join(base, 'B.git'));
  git(repo, 'fetch', '-q', 'origin');
  // repository per il diff dei commit: primo commit, modifica, rinomina
  hist = path.join(base, 'hist');
  fs.mkdirSync(hist);
  git(hist, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(hist, 'a.txt'), 'uno\ndue\n');
  fs.writeFileSync(path.join(hist, 'b.txt'), 'bi\n'.repeat(20));
  git(hist, 'add', '.'); git(hist, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'primo');
  fs.writeFileSync(path.join(hist, 'a.txt'), 'uno\nDUE\ntre\n');
  git(hist, 'mv', 'b.txt', 'c.txt');
  fs.writeFileSync(path.join(hist, 'nuovo.txt'), 'n\n');
  git(hist, 'add', '.'); git(hist, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'secondo');
  srv = await startServer({ groups: [], servers: [], projects: [{ id: 'r', label: 'Repo', path: repo }, { id: 'h', label: 'Storia', path: hist }] });
});
after(() => srv.stop());

const action = body => srv.request('POST', '/api/ext/git/repos/r/action', { body });
const exitOf = r => r.events.find(e => e.type === 'exit')?.data;

test('repo ricavato dai progetti', async () => {
  const r = await srv.request('GET', '/api/ext/git/repos');
  assert.deepEqual(r.json.map(x => x.id), ['r', 'h']);
});

test('validazione di azione, branch, remote', async () => {
  const cases = [
    [{ action: 'rm' }, /Azione non supportata/],
    [{ action: 'checkout', branch: '--upload-pack=touch /tmp/pwn' }, /Nome branch non valido/],
    [{ action: 'merge', branch: 'a..b' }, /Nome branch non valido/],
    [{ action: 'push', remote: '--exec=x', branch: 'main' }, /Remote sconosciuto/],
    [{ action: 'push', remote: 'origin' }, /Branch obbligatorio/],
  ];
  for (const [body, re] of cases) {
    const r = await action(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.json.error, re);
  }
});

test('hash del commit validato', async () => {
  assert.equal((await srv.request('GET', '/api/ext/git/repos/r/commit/--output=x')).status, 400);
  const hash = git(repo, 'rev-parse', '--short', 'HEAD').trim();
  const r = await srv.request('GET', `/api/ext/git/repos/r/commit/${hash}`);
  assert.equal(r.json.body, 'init');
});

test('status con nomi file speciali e commit selettivo', async () => {
  fs.writeFileSync(path.join(repo, 'file con spazi.txt'), 'a');
  fs.writeFileSync(path.join(repo, "a');x=1;('.txt"), 'b');
  fs.writeFileSync(path.join(repo, 'resta.txt'), 'c');
  const status = await srv.request('GET', '/api/ext/git/repos/r/status');
  const names = status.json.files.map(f => f.name).sort();
  assert.deepEqual(names, ["a');x=1;('.txt", 'file con spazi.txt', 'resta.txt']);

  let r = await action({ action: 'commit', message: 'x', files: ['--exec=evil'] });
  assert.equal(r.events[0].type, 'error');
  r = await action({ action: 'commit', message: 'x', files: 'resta.txt' });
  assert.equal(r.events[0].type, 'error');

  r = await action({ action: 'commit', message: 'selettivo', files: ['file con spazi.txt', "a');x=1;('.txt"] });
  assert.equal(exitOf(r), 0);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '?? resta.txt');
  fs.unlinkSync(path.join(repo, 'resta.txt'));
});

test('push di più commit su due pushurl', async () => {
  for (const f of ['p1', 'p2', 'p3']) commitFile(repo, f);
  const r = await action({ action: 'push', remote: 'origin', branch: 'main' });
  assert.equal(exitOf(r), 0);
  const head = git(repo, 'rev-parse', 'main').trim();
  assert.equal(git(base, '--git-dir=A.git', 'rev-parse', 'main').trim(), head);
  assert.equal(git(base, '--git-dir=B.git', 'rev-parse', 'main').trim(), head);
});

test('azioni concorrenti sullo stesso repo: una sola alla volta (backlog #1)', async () => {
  for (const f of ['c1', 'c2', 'c3']) commitFile(repo, f);
  const [a, b] = await Promise.all([
    action({ action: 'push', remote: 'origin', branch: 'main' }),
    action({ action: 'push', remote: 'origin', branch: 'main' }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const ok = a.status === 200 ? a : b;
  assert.equal(exitOf(ok), 0);
  assert.doesNotMatch(ok.text, /cannot lock ref/);
});

test('log con mappa dei ref e branch locali', async () => {
  git(repo, 'branch', 'feature/x');
  const r = await srv.request('GET', '/api/ext/git/repos/r/log?limit=50');
  assert.ok(r.json.entries.length >= 5);
  assert.ok(r.json.localBranches.includes('feature/x'));
  assert.ok(r.json.localBranches.includes('main'));
  const refNames = Object.values(r.json.refs).flat();
  assert.ok(refNames.includes('origin/main'));
  assert.ok(!refNames.includes('origin')); // origin/HEAD escluso
});

test('checkout di un branch esistente', async () => {
  let r = await action({ action: 'checkout', branch: 'feature/x' });
  assert.equal(exitOf(r), 0);
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'feature/x');
  r = await action({ action: 'checkout', branch: 'main' });
  assert.equal(exitOf(r), 0);
});

test('push: un fetch fallito non blocca il push (passo opzionale)', async () => {
  commitFile(repo, 'dopo-fetch');
  // l'URL di fetch punta a un repo inesistente; i due pushurl restano validi
  git(repo, 'remote', 'set-url', 'origin', path.join(base, 'non-esiste.git'));
  try {
    const r = await action({ action: 'push', remote: 'origin', branch: 'main' });
    assert.equal(exitOf(r), 0);
    assert.match(r.text, /fetch non riuscito, si prosegue/);
    assert.equal(git(base, '--git-dir=A.git', 'rev-parse', 'main').trim(), git(repo, 'rev-parse', 'main').trim());
  } finally {
    git(repo, 'remote', 'set-url', 'origin', path.join(base, 'A.git'));
  }
});

test('pull_push si ferma se il pull fallisce', async () => {
  const r = await action({ action: 'pull_push', remote: 'origin', branch: 'ramo-inesistente' });
  assert.notEqual(exitOf(r), 0);
  assert.doesNotMatch(r.text, /\$ git push/);
});

test('branch: locali con upstream e stato, remoti con copia locale', async () => {
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'branch', '-f', 'unito', 'main');                   // già unito in main
  git(repo, 'checkout', '-q', '-b', 'nuovo-lavoro');
  commitFile(repo, 'lavoro.txt');                                // non unito
  git(repo, 'checkout', '-q', 'main');
  const r = await srv.request('GET', '/api/ext/git/repos/r/branches');
  assert.equal(r.status, 200);
  assert.equal(r.json.current, 'main');
  const local = Object.fromEntries(r.json.local.map(b => [b.name, b]));
  assert.equal(local.main.upstream, null); // il test non imposta l'upstream
  assert.equal(local.unito.merged, true);
  assert.equal(local['nuovo-lavoro'].merged, false);
  assert.equal(local['nuovo-lavoro'].lastCommit.subject, 'add lavoro.txt');
  const remote = r.json.remote.find(b => b.name === 'origin/main');
  assert.deepEqual([remote.remote, remote.branch, remote.hasLocal], ['origin', 'main', true]);
  assert.ok(!r.json.remote.some(b => b.name.endsWith('/HEAD')));
});

test('cambio e creazione di branch con i controlli preliminari', async () => {
  git(repo, 'checkout', '-q', 'main');
  // branch remoto senza copia locale
  git(repo, 'push', '-q', 'origin', 'main:solo-remoto');
  git(repo, 'fetch', '-q', 'origin');

  // checkout di un branch remoto → copia locale che lo segue
  let r = await action({ action: 'checkout', branch: 'origin/solo-remoto' });
  assert.equal(exitOf(r), 0, r.text);
  assert.match(r.text, /checkout --track origin\/solo-remoto/);
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'solo-remoto');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'solo-remoto@{upstream}').trim(), 'origin/solo-remoto');

  // inesistente
  r = await action({ action: 'checkout', branch: 'non-esiste' });
  assert.equal(r.status, 404);

  // modifiche non committate: 409 con i file, poi stash e cambio
  fs.writeFileSync(path.join(repo, 'p1'), 'modificato');
  r = await action({ action: 'checkout', branch: 'main' });
  assert.equal(r.status, 409);
  assert.deepEqual([r.json.code, r.json.files], ['git.dirty', ['p1']]);
  r = await action({ action: 'checkout', branch: 'main', stash: true });
  assert.equal(exitOf(r), 0, r.text);
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'main');
  assert.match(git(repo, 'stash', 'list'), /devdock → main/);
  git(repo, 'stash', 'drop', '-q');

  // nuovo branch: esistente → 409; punto di partenza non valido → 400; ok
  assert.equal((await action({ action: 'checkout_new', branch: 'main' })).json.code, 'git.exists');
  assert.equal((await action({ action: 'checkout_new', branch: 'x1', startPoint: '--orphan' })).status, 400);
  assert.equal((await action({ action: 'checkout_new', branch: 'x1', startPoint: 'inesistente' })).status, 400);
  r = await action({ action: 'checkout_new', branch: 'feature/nuova', startPoint: 'origin/main' });
  assert.equal(exitOf(r), 0, r.text);
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'feature/nuova');
  // nuovo branch dal commit attuale: le modifiche non committate non bloccano
  fs.writeFileSync(path.join(repo, 'p1'), 'ancora');
  r = await action({ action: 'checkout_new', branch: 'con-modifiche' });
  assert.equal(exitOf(r), 0, r.text);
  git(repo, 'checkout', '-q', '--', 'p1');
  git(repo, 'checkout', '-q', 'main');
});

test('merge: anteprima, opzioni, conflitti, annulla e concludi', async () => {
  git(repo, 'checkout', '-q', 'main');
  // due branch che toccano lo stesso file
  git(repo, 'checkout', '-q', '-b', 'm-a'); fs.writeFileSync(path.join(repo, 'conflitto.txt'), 'versione A\n'); git(repo, 'add', 'conflitto.txt'); git(repo, 'commit', '-qm', 'A');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'checkout', '-q', '-b', 'm-b'); fs.writeFileSync(path.join(repo, 'conflitto.txt'), 'versione B\n'); git(repo, 'add', 'conflitto.txt'); git(repo, 'commit', '-qm', 'B');
  git(repo, 'checkout', '-q', 'main');

  let p = (await srv.request('GET', '/api/ext/git/repos/r/merge-preview?branch=m-a')).json;
  assert.deepEqual(p.commits.map(c => c.subject), ['A']);
  assert.deepEqual(p.files, [{ status: 'A', name: 'conflitto.txt' }]);
  assert.equal(p.fastForward, true);
  assert.equal((await srv.request('GET', '/api/ext/git/repos/r/merge-preview?branch=--all')).status, 400);

  // merge senza fast-forward
  let r = await action({ action: 'merge', branch: 'm-a', mode: 'no-ff' });
  assert.equal(exitOf(r), 0, r.text);
  assert.match(git(repo, 'log', '-1', '--format=%s'), /^Merge branch 'm-a'/);
  assert.equal((await action({ action: 'merge', branch: 'm-a', mode: '--hack' })).status, 400);

  // conflitto
  r = await action({ action: 'merge', branch: 'm-b' });
  assert.notEqual(exitOf(r), 0);
  let st = (await srv.request('GET', '/api/ext/git/repos/r/status')).json;
  assert.equal(st.merging, true);
  assert.deepEqual(st.conflicts, ['conflitto.txt']);
  assert.equal((await action({ action: 'merge', branch: 'm-a' })).json.code, 'git.merging');
  r = await action({ action: 'merge_continue' });
  assert.equal(r.status, 409);
  assert.deepEqual(r.json.files, ['conflitto.txt']);

  // annulla, poi di nuovo e risolvi
  assert.equal(exitOf(await action({ action: 'merge_abort' })), 0);
  assert.equal((await srv.request('GET', '/api/ext/git/repos/r/status')).json.merging, false);
  await action({ action: 'merge', branch: 'm-b' });
  fs.writeFileSync(path.join(repo, 'conflitto.txt'), 'versione A e B\n');
  r = await action({ action: 'merge_continue' });
  assert.equal(exitOf(r), 0, r.text);
  st = (await srv.request('GET', '/api/ext/git/repos/r/status')).json;
  assert.equal(st.merging, false);
  assert.equal(fs.readFileSync(path.join(repo, 'conflitto.txt'), 'utf8'), 'versione A e B\n');
  assert.equal((await action({ action: 'merge_abort' })).status, 409);
});

test('eliminazione dei branch locali', async () => {
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'branch', '-f', 'da-eliminare', 'main');
  git(repo, 'checkout', '-q', '-b', 'non-unito'); commitFile(repo, 'solo-qui.txt'); git(repo, 'checkout', '-q', 'main');

  assert.equal((await action({ action: 'branch_delete', branch: 'main' })).json.code, 'git.current');
  assert.equal((await action({ action: 'branch_delete', branch: 'inesistente' })).status, 404);
  let r = await action({ action: 'branch_delete', branch: 'da-eliminare' });
  assert.equal(exitOf(r), 0, r.text);
  assert.match(r.text, /branch -d da-eliminare/);
  r = await action({ action: 'branch_delete', branch: 'non-unito' });
  assert.equal(r.json.code, 'git.unmerged');
  r = await action({ action: 'branch_delete', branch: 'non-unito', force: true });
  assert.equal(exitOf(r), 0, r.text);
  assert.match(r.text, /branch -D non-unito/);
  assert.doesNotMatch(git(repo, 'branch'), /non-unito|da-eliminare/);
});

test('diff di un file modificato o nuovo rispetto all\'ultimo commit', async () => {
  git(repo, 'checkout', '-q', 'main');
  const lines = Array.from({ length: 20 }, (_, i) => `riga ${i + 1}`);
  commitFile(repo, 'diff.txt', lines.join('\n') + '\n');
  fs.writeFileSync(path.join(repo, 'diff.txt'), lines.map((l, i) => (i === 9 ? 'riga 10 cambiata' : l)).join('\n') + '\nriga 21\n');
  fs.writeFileSync(path.join(repo, 'nuovo file.txt'), 'ciao\n');
  const diff = (file, extra = '') => srv.request('GET', `/api/ext/git/repos/r/diff?file=${encodeURIComponent(file)}${extra}`);
  let r = await diff('diff.txt');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.binary, false);
  assert.match(r.json.patch, /^-riga 10$/m);
  assert.match(r.json.patch, /^\+riga 10 cambiata$/m);
  assert.doesNotMatch(r.json.patch, /^ riga 2$/m);      // 3 righe di contesto
  r = await diff('diff.txt', '&context=all');
  assert.match(r.json.patch, /^ riga 2$/m);             // tutto il file
  r = await diff('nuovo file.txt');
  assert.equal(r.json.xy, '??');
  assert.match(r.json.patch, /^\+ciao$/m);
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]));
  assert.equal((await diff('bin.dat')).json.binary, true);
  // solo file modificati, mai percorsi arbitrari
  assert.equal((await diff('package.json')).json.code, 'git.file_not_changed');
  assert.equal((await diff('../../etc/passwd')).status, 404);
  assert.equal((await srv.request('GET', '/api/ext/git/repos/r/diff')).json.code, 'git.file_required');
  git(repo, 'checkout', '-q', '--', 'diff.txt');
  fs.rmSync(path.join(repo, 'nuovo file.txt'));
  fs.rmSync(path.join(repo, 'bin.dat'));
});

test('merge editor: base, nostra e loro; risoluzione scritta e aggiunta', async () => {
  git(repo, 'checkout', '-q', 'main');
  commitFile(repo, 'me.txt', 'uno\ndue\ntre\n');
  git(repo, 'checkout', '-q', '-b', 'me-loro'); fs.writeFileSync(path.join(repo, 'me.txt'), 'uno\nDUE loro\ntre\n'); git(repo, 'commit', '-qam', 'loro');
  git(repo, 'checkout', '-q', 'main'); fs.writeFileSync(path.join(repo, 'me.txt'), 'uno\nDUE nostra\ntre\n'); git(repo, 'commit', '-qam', 'nostra');
  await action({ action: 'merge', branch: 'me-loro' });
  const get = file => srv.request('GET', `/api/ext/git/repos/r/conflict?file=${encodeURIComponent(file)}`);
  const put = body => srv.request('POST', '/api/ext/git/repos/r/conflict', { body });
  let r = await get('me.txt');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.base, r.json.ours, r.json.theirs], ['uno\ndue\ntre\n', 'uno\nDUE nostra\ntre\n', 'uno\nDUE loro\ntre\n']);
  assert.deepEqual([r.json.oursLabel, r.json.theirsLabel], ['main', 'me-loro']);
  assert.match(r.json.working, /^<{7} HEAD\nDUE nostra\n={7}\nDUE loro\n>{7} me-loro$/m);
  // marcatori rimasti: rifiutato; poi risolto e aggiunto, il merge si conclude
  assert.equal((await put({ file: 'me.txt', content: r.json.working })).json.code, 'git.markers_left');
  assert.equal((await put({ file: 'package.json', content: 'x' })).json.code, 'git.file_not_changed');
  r = await put({ file: 'me.txt', content: 'uno\nDUE nostra\nDUE loro\ntre\n' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.conflicts, []);
  assert.equal(fs.readFileSync(path.join(repo, 'me.txt'), 'utf8'), 'uno\nDUE nostra\nDUE loro\ntre\n');
  assert.equal((await get('me.txt')).json.code, 'git.not_conflicted');
  assert.equal(exitOf(await action({ action: 'merge_continue' })), 0);
});

test('diff: una modifica alla volta o tutte riportate all\'ultimo commit', async () => {
  git(repo, 'checkout', '-q', 'main');
  const lines = Array.from({ length: 30 }, (_, i) => `riga ${i + 1}`);
  commitFile(repo, 'rv.txt', lines.join('\n') + '\n');
  const edited = [...lines];
  edited[1] = 'riga 2 cambiata';                 // modifica 1 (hunk 1)
  edited.splice(14, 1, 'riga 15 A', 'riga 15 B'); // modifica 2 (hunk 2)
  edited.push('riga 31');                       // modifica 3 (hunk 3)
  fs.writeFileSync(path.join(repo, 'rv.txt'), edited.join('\n') + '\n');
  git(repo, 'add', 'rv.txt');                   // in stage: anche l'indice va riportato
  const read = () => fs.readFileSync(path.join(repo, 'rv.txt'), 'utf8').split('\n');
  const diff = async (ctxp = '3') => (await srv.request('GET', `/api/ext/git/repos/r/diff?file=rv.txt&context=${ctxp}`)).json;
  const hunks = patch => { const out = []; for (const l of patch.split('\n')) { if (l.startsWith('@@ ')) out.push([]); else if (out.length && l) out[out.length - 1].push(l); } return out; };
  const block = body => srv.request('POST', '/api/ext/git/repos/r/revert-block', { body });

  let d = await diff();
  assert.equal(d.blocks, true);
  let h = hunks(d.patch);
  assert.equal(h.length, 3);
  // testo cambiato nel frattempo: rifiutato
  assert.equal((await block({ file: 'rv.txt', context: '3', hunk: 1, block: 0, expect: 'altro' })).json.code, 'git.diff_changed');
  // la seconda modifica torna com'era, le altre restano
  let r = await block({ file: 'rv.txt', context: '3', hunk: 1, block: 0, expect: h[1].join('\n') });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([read()[1], read()[14], read()[15], read()[30]], ['riga 2 cambiata', 'riga 15', 'riga 16', 'riga 31']);
  assert.doesNotMatch(git(repo, 'diff', '--cached'), /riga 15 A/); // tolta anche dall'indice

  // con tutto il file un solo blocco @@ e due modifiche: si sceglie la seconda (in fondo)
  d = await diff('all');
  h = hunks(d.patch);
  assert.equal(h.length, 1);
  r = await block({ file: 'rv.txt', context: 'all', hunk: 0, block: 1, expect: h[0].join('\n') });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([read()[1], read().length], ['riga 2 cambiata', 31]); // riga 31 tolta, resta la prima modifica

  // tutte le modifiche: il file torna come in HEAD e non è più tra i modificati
  r = await srv.request('POST', '/api/ext/git/repos/r/revert', { body: { file: 'rv.txt' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(fs.readFileSync(path.join(repo, 'rv.txt'), 'utf8'), lines.join('\n') + '\n');
  assert.ok(!r.json.files.some(f => f.name === 'rv.txt'));

  // file nuovo: niente modifiche singole, "annulla tutto" lo elimina; mai file non modificati
  fs.writeFileSync(path.join(repo, 'nuovo.txt'), 'x\n');
  assert.equal((await srv.request('GET', '/api/ext/git/repos/r/diff?file=nuovo.txt')).json.blocks, false);
  assert.equal((await block({ file: 'nuovo.txt', hunk: 0, block: 0, expect: '' })).json.code, 'git.revert_block_unsupported');
  assert.equal((await srv.request('POST', '/api/ext/git/repos/r/revert', { body: { file: 'nuovo.txt' } })).status, 200);
  assert.equal(fs.existsSync(path.join(repo, 'nuovo.txt')), false);
  assert.equal((await srv.request('POST', '/api/ext/git/repos/r/revert', { body: { file: 'package.json' } })).json.code, 'git.file_not_changed');
  // file nuovo aggiunto all'indice: tolto dall'indice e dal disco
  fs.writeFileSync(path.join(repo, 'staged-new.txt'), 'y\n'); git(repo, 'add', 'staged-new.txt');
  assert.equal((await srv.request('POST', '/api/ext/git/repos/r/revert', { body: { file: 'staged-new.txt' } })).status, 200);
  assert.equal(fs.existsSync(path.join(repo, 'staged-new.txt')), false);
  assert.equal(git(repo, 'status', '--porcelain').trim(), '');
});

test('modifiche di un commit rispetto al precedente', async () => {
  const head = git(hist, 'rev-parse', 'HEAD').trim(), first = git(hist, 'rev-parse', 'HEAD~1').trim();
  let r = await srv.request('GET', `/api/ext/git/repos/h/commit/${head}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.body, 'secondo');
  assert.equal(r.json.parent, first);
  const byName = Object.fromEntries(r.json.files.map(f => [f.name, f]));
  assert.equal(byName['a.txt'].status, 'M');
  assert.equal(byName['nuovo.txt'].status, 'A');
  assert.deepEqual([byName['c.txt'].status, byName['c.txt'].orig], ['R', 'b.txt']);
  const diff = (hash, file, extra = '') => srv.request('GET', `/api/ext/git/repos/h/commit/${hash}/diff?file=${encodeURIComponent(file)}${extra}`);
  r = await diff(head, 'a.txt');
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.patch, /^-due$/m);
  assert.match(r.json.patch, /^\+DUE$/m);
  assert.match(r.json.patch, /^\+tre$/m);
  r = await diff(head, 'c.txt');
  assert.match(r.json.patch, /rename from b\.txt/);
  // primo commit: niente parent, tutto aggiunto
  r = await srv.request('GET', `/api/ext/git/repos/h/commit/${first}`);
  assert.equal(r.json.parent, null);
  assert.deepEqual(r.json.files.map(f => [f.status, f.name]).sort(), [['A', 'a.txt'], ['A', 'b.txt']]);
  r = await diff(first, 'b.txt', '&context=all');
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.patch, /^\+bi$/m);
  // solo i file del commit, hash validato
  assert.equal((await diff(head, 'b.txt')).json.code, 'git.file_not_in_commit');
  assert.equal((await diff(head, '../../etc/passwd')).status, 404);
  assert.equal((await diff('--output=x', 'a.txt')).status, 400);
  assert.equal((await srv.request('GET', '/api/ext/git/repos/h/commit/deadbeef')).json.code, 'git.commit_not_found');
});
