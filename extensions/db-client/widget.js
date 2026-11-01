// Widget Database per la dashboard di progetto: connessioni collegate al progetto (campo
// Progetto), con la prova della connessione, le migration del repository collegato (quante,
// l'ultima, numeri ripetuti) e l'apertura nella sezione Database.

const states = new WeakMap(); // el → { project, list, tests: Map(id → { ok, text } | 'testing'), migs: Map }

async function load(ctx, el) {
  const st = states.get(el);
  try {
    const { connections } = await ctx.api.get('/connections');
    st.locked = false;
    st.list = connections.filter(c => c.projectId === st.project.id);
  } catch (e) {
    if (!ctx.vault.isVaultError(e)) throw e;
    st.locked = true;
    st.list = [];
  }
  render(ctx, el);
  await Promise.all(st.list.map(async c => {
    try { st.migs.set(c.id, await ctx.api.get(`/connections/${encodeURIComponent(c.id)}/migrations`)); } catch { st.migs.delete(c.id); }
    render(ctx, el);
  }));
  await Promise.all(st.list.map(c => test(ctx, el, c.id)));
}

async function test(ctx, el, id) {
  const st = states.get(el);
  st.tests.set(id, 'testing');
  render(ctx, el);
  try {
    const r = await ctx.api.post(`/connections/${encodeURIComponent(id)}/test`);
    st.tests.set(id, { ok: true, text: `${r.version} · ${ctx.ui.fmt.number(r.ms)} ms` });
  } catch (e) {
    if (ctx.vault.isVaultError(e)) st.locked = true; // password nel vault bloccato: si chiede di sbloccarlo
    st.tests.set(id, { ok: false, text: e.message });
  }
  if (states.has(el)) render(ctx, el);
}

const target = c => (c.tunnel ? `⇄ ${c.tunnel}` : `${c.host}:${c.port}`);

function render(ctx, el) {
  const { esc, fmt } = ctx.ui;
  const { t } = ctx;
  const st = states.get(el);
  if (st.locked) {
    ctx.widget.setBadge('🔒');
    ctx.ui.patch(el, `<p class="db-muted">${esc(t('widget.locked'))}</p><button class="btn btn-primary btn-sm" data-dbw="unlock">${esc(t('widget.unlock'))}</button>`);
    return;
  }
  const failed = st.list.filter(c => st.tests.get(c.id)?.ok === false).length;
  ctx.widget.setBadge(failed ? `✖ ${fmt.number(failed)}` : null);
  if (!st.list.length) { ctx.ui.patch(el, `<p class="db-muted">${esc(t('widget.none'))}</p>`); return; }
  ctx.ui.patch(el, `<div class="dbw-list">${st.list.map(c => {
    const tst = st.tests.get(c.id), mig = st.migs.get(c.id);
    const dot = tst === 'testing' || !tst ? 'dbw-wait' : tst.ok ? 'dbw-ok' : 'dbw-err';
    const last = mig?.files?.at(-1)?.name;
    return `<div class="dbw-conn">
      <div class="dbw-row">
        <span class="dbw-dot ${dot}" title="${esc(tst === 'testing' ? t('widget.testing') : tst?.text || '')}"></span>
        <strong class="dbw-label">${c.readOnly ? '🔒 ' : ''}${esc(c.label)}</strong>
        <span class="db-muted dbw-target">${esc(c.user)}@${esc(target(c))}${c.database ? ` / ${esc(c.database)}` : ''}</span>
        <span class="dbw-actions">
          <button class="btn btn-ghost btn-sm" data-dbw="test" data-id="${esc(c.id)}" title="${esc(t('widget.retest'))}">↻</button>
          <button class="btn btn-ghost btn-sm" data-dbw="open" data-id="${esc(c.id)}" title="${esc(t('widget.openTitle'))}">${esc(t('widget.open'))}</button>
        </span>
      </div>
      ${tst && tst !== 'testing' ? `<div class="${tst.ok ? 'db-muted' : 'dbw-error'} dbw-detail">${esc(tst.text)}</div>` : ''}
      ${mig?.linked ? `<div class="db-muted dbw-detail">📁 ${esc(mig.repo?.label || mig.repo?.id || '')}${mig.dir ? `/${esc(mig.dir)}` : ''} · ${mig.repo?.missing ? esc(t('widget.migrationsMissing'))
        : mig.files?.length ? esc(t('widget.migrations', { count: mig.files.length, last })) : esc(t('widget.noMigrations'))}
        ${mig.duplicates?.length ? `<span class="dbw-error"> · ${esc(t('widget.duplicates', { list: fmt.list(mig.duplicates.map(String)) }))}</span>` : ''}</div>` : ''}
    </div>`;
  }).join('')}</div>`);
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, list: [], tests: new Map(), migs: new Map(), locked: false });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-dbw]');
      if (!b) return;
      if (b.dataset.dbw === 'unlock') { if (await ctx.vault.ensure()) load(ctx, el); }
      else if (b.dataset.dbw === 'test') test(ctx, el, b.dataset.id);
      else if (b.dataset.dbw === 'open') ctx.widget.openFull({ connection: b.dataset.id });
    });
    await load(ctx, el);
  },
  refresh(ctx, el) { const st = states.get(el); st.tests.clear(); return load(ctx, el); },
  unmount(ctx, el) { states.delete(el); },
};
