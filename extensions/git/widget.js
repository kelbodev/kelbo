// Widget Git per la dashboard di progetto: branch, avanti/indietro, file modificati, ultimi
// commit; fetch, pull e push (il push mostra prima i commit che invierà e chiede conferma).

const POLL_MS = 15000;
const states = new WeakMap(); // el → { project, repo, timer, data, busy }

// Repository del progetto: quello con il suo id, o quello che contiene la sua cartella
async function findRepo(ctx, project) {
  const repos = await ctx.api.get('/repos');
  return repos.find(r => r.id === project.id) || repos.find(r => project.path === r.path || project.path.startsWith(r.path + '/')) || null;
}

async function load(ctx, el) {
  const st = states.get(el);
  st.repo ||= await findRepo(ctx, st.project);
  if (!st.repo) { st.data = null; render(ctx, el); return; }
  const base = `/repos/${encodeURIComponent(st.repo.id)}`;
  const [status, summary] = await Promise.all([ctx.api.get(`${base}/status`), ctx.api.get(`${base}/summary`)]);
  st.data = { status, summary };
  render(ctx, el);
}

function render(ctx, el) {
  const { esc, fmt } = ctx.ui;
  const { t } = ctx;
  const st = states.get(el);
  if (!st.repo) { ctx.widget.setBadge(null); ctx.ui.patch(el, `<p class="gw-muted">${esc(t('widget.noRepo'))}</p>`); return; }
  const { status: s, summary } = st.data;
  const changed = s.files.length;
  ctx.widget.setBadge(changed ? { icon: 'file-diff', text: fmt.number(changed) } : null);
  const busy = st.busy;
  ctx.ui.patch(el, `
    <div class="gw-top">
      <span class="gw-branch"><i data-icon="git-branch"></i> ${esc(s.branch || '?')}</span>
      ${s.ahead ? `<span class="gw-ab" title="${esc(t('widget.aheadTitle'))}">${ctx.ui.icon('arrow-up')}${esc(fmt.number(s.ahead))}</span>` : ''}
      ${s.behind ? `<span class="gw-ab" title="${esc(t('widget.behindTitle'))}">${ctx.ui.icon('arrow-down')}${esc(fmt.number(s.behind))}</span>` : ''}
      ${s.merging ? `<span class="gw-warn">${esc(t('widget.merging'))}</span>` : ''}
      <span class="gw-actions">
        <button class="btn btn-ghost btn-sm" data-gw="fetch" ${busy ? 'disabled' : ''}>${esc(t('widget.fetch'))}</button>
        <button class="btn btn-ghost btn-sm" data-gw="pull" ${busy ? 'disabled' : ''}>${esc(t('widget.pull'))}</button>
        <button class="btn btn-ghost btn-sm" data-gw="push" ${busy || !summary.outgoing.length ? 'disabled' : ''} title="${esc(t('widget.pushTitle', { count: summary.outgoing.length }))}">${esc(t('widget.push'))}${summary.outgoing.length ? ` ${esc(fmt.number(summary.outgoing.length))}` : ''}</button>
      </span>
    </div>
    <div class="gw-head">${esc(changed ? t('widget.changed', { count: changed }) : t('widget.clean'))}</div>
    ${changed ? `<div class="gw-files">${s.files.slice(0, 8).map(f => `<div class="gw-file"><code class="gw-xy">${esc(f.xy)}</code><span>${esc(f.name)}</span></div>`).join('')}
      ${changed > 8 ? `<div class="gw-muted">${esc(t('widget.more', { count: changed - 8 }))}</div>` : ''}</div>` : ''}
    ${summary.recent.length ? `<div class="gw-head">${esc(t('widget.recent'))}</div>
      <div class="gw-commits">${summary.recent.map(c => `<div class="gw-commit" title="${esc(`${c.author} · ${fmt.date(c.date, { dateStyle: 'medium', timeStyle: 'short' })}`)}">
        <code>${esc(c.hash)}</code><span class="gw-subject">${esc(c.subject)}</span><span class="gw-muted">${esc(fmt.relative(c.date))}</span></div>`).join('')}</div>` : ''}`);
}

// fetch/pull/push con l'output della sezione Git non visibile: esito in un messaggio
async function action(ctx, el, name) {
  const st = states.get(el);
  const { t } = ctx;
  if (name === 'push') {
    const list = st.data.summary.outgoing;
    const text = `${t('widget.confirmPush', { count: list.length, branch: st.data.status.branch })}\n\n${list.map(c => `${c.hash}  ${c.subject}`).join('\n')}`;
    if (!confirm(text)) return;
  }
  st.busy = true;
  render(ctx, el);
  let errors = '';
  try {
    const exit = await ctx.api.stream(`/repos/${encodeURIComponent(st.repo.id)}/action`, { action: name, remote: 'origin', branch: st.data.status.branch }, ({ type, data }) => {
      if (type === 'stderr' || type === 'error') errors += typeof data === 'string' ? data : ctx.ui.errorText(data);
    });
    if (exit === 0) ctx.ui.toast(t('widget.done', { action: `git ${name}` }), 'success');
    else ctx.ui.toast(t('widget.failed', { action: `git ${name}`, error: errors.trim().split('\n').slice(-3).join(' ') || `exit ${exit}` }), 'error');
  } catch (e) { ctx.ui.toast(e.message, 'error'); }
  st.busy = false;
  await load(ctx, el).catch(() => render(ctx, el));
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, repo: null, timer: null, data: null, busy: false });
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-gw]');
      if (b && !b.disabled) action(ctx, el, b.dataset.gw);
    });
    await load(ctx, el);
    states.get(el).timer = setInterval(() => { if (!states.get(el)?.busy) load(ctx, el).catch(() => {}); }, POLL_MS);
  },
  refresh(ctx, el) { const st = states.get(el); if (st) st.repo = null; return load(ctx, el); },
  unmount(ctx, el) { clearInterval(states.get(el)?.timer); states.delete(el); },
};
