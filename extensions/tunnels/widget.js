// Widget Tunnel per la dashboard di progetto: i tunnel usati dalle connessioni database del
// progetto (DB client e, se installato, MongoDB), con connetti e disconnetti.

const POLL_MS = 5000;
const states = new WeakMap(); // el → { project, timer, data }

// Connessioni del progetto che passano da un tunnel: { serverKey → [etichette] }
async function usedTunnels(ctx, project) {
  const used = new Map();
  for (const code of ['db-client', 'mongo-client']) {
    if (!ctx.hasExtension(code)) continue;
    const { connections } = await ctx.apiFor(code).get('/connections');
    for (const c of connections) {
      if (c.projectId !== project.id || !c.tunnel) continue;
      used.set(c.tunnel, [...(used.get(c.tunnel) || []), c.label]);
    }
  }
  return used;
}

async function load(ctx, el) {
  const st = states.get(el);
  let used;
  try { used = await usedTunnels(ctx, st.project); }
  catch (e) {
    if (!ctx.vault.isVaultError(e)) throw e;
    st.data = { locked: true };
    render(ctx, el);
    return;
  }
  const state = await ctx.api.get('/state');
  st.data = { used, servers: state.servers, tunnels: state.tunnels };
  render(ctx, el);
}

function render(ctx, el) {
  const { esc, fmt } = ctx.ui;
  const { t } = ctx;
  const d = states.get(el).data;
  if (d.locked) {
    ctx.widget.setBadge({ icon: 'lock' });
    ctx.ui.patch(el, `<p class="tw-muted">${esc(t('widget.locked'))}</p><button class="btn btn-primary btn-sm" data-tw="unlock">${ctx.ui.icon('lock-open')} ${esc(t('widget.unlock'))}</button>`);
    return;
  }
  if (!ctx.hasExtension('db-client') && !ctx.hasExtension('mongo-client')) { ctx.widget.setBadge(null); ctx.ui.patch(el, `<p class="tw-muted">${esc(t('widget.noDb'))}</p>`); return; }
  const keys = [...d.used.keys()];
  const open = keys.filter(k => d.tunnels.some(x => x.serverKey === k)).length;
  ctx.widget.setBadge(keys.length ? `${fmt.number(open)}/${fmt.number(keys.length)}` : null);
  if (!keys.length) { ctx.ui.patch(el, `<p class="tw-muted">${esc(t('widget.none'))}</p>`); return; }
  ctx.ui.patch(el, `<div class="tw-list">${keys.map(k => {
    const srv = d.servers.find(s => s.key === k);
    const tun = d.tunnels.find(x => x.serverKey === k);
    return `<div class="tw-item">
      <div class="tw-row">
        <span class="tw-dot ${tun ? (tun.reconnecting ? 'tw-wait' : 'tw-on') : ''}"></span>
        <strong>${esc(srv?.label || k)}</strong>
        ${tun ? `<span class="tw-muted">:${esc(tun.port)}${tun.reconnecting ? ` · ${esc(t('widget.reconnecting'))}` : ''}</span>` : ''}
        ${!srv ? `<span class="tw-err">${esc(t('widget.missing'))}</span>`
          : tun ? `<button class="btn btn-ghost btn-sm" data-tw="stop" data-id="${esc(tun.id)}">${esc(t('widget.disconnect'))}</button>`
          : `<button class="btn btn-ghost btn-sm" data-tw="start" data-key="${esc(k)}">${esc(t('widget.connect'))}</button>`}
      </div>
      <div class="tw-muted tw-used">${esc(t('widget.usedBy', { list: fmt.list(d.used.get(k)) }))}</div>
    </div>`;
  }).join('')}</div>`);
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, timer: null, data: { used: new Map(), servers: [], tunnels: [] } });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-tw]');
      if (!b) return;
      try {
        if (b.dataset.tw === 'unlock') { if (!(await ctx.vault.ensure())) return; }
        else if (b.dataset.tw === 'start') await ctx.api.post('/tunnels', { serverKey: b.dataset.key });
        else if (b.dataset.tw === 'stop') await ctx.api.del(`/tunnels/${encodeURIComponent(b.dataset.id)}`);
        await load(ctx, el);
      } catch (err) { ctx.ui.toast(err.message, 'error'); }
    });
    await load(ctx, el);
    states.get(el).timer = setInterval(() => load(ctx, el).catch(() => {}), POLL_MS);
  },
  refresh: (ctx, el) => load(ctx, el),
  unmount(ctx, el) { clearInterval(states.get(el)?.timer); states.delete(el); },
};
