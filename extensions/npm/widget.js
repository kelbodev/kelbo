// Widget NPM per la dashboard di progetto: processi in esecuzione (porte, stop, riavvio, log)
// e script più usati (contati da Kelbo a ogni avvio) con ▶. Aggiornato ogni 5 secondi.

const POLL_MS = 5000;
const MAX_SCRIPTS = 6;
const states = new WeakMap(); // el → { project, timer, data }

const scriptLabel = script => (script === 'install' ? 'npm install' : script.startsWith('update ') ? `npm ${script}` : `npm run ${script}`);

async function load(ctx, el) {
  const st = states.get(el);
  const id = encodeURIComponent(st.project.id);
  const [pkg, procs, usage] = await Promise.all([
    ctx.api.get(`/projects/${id}/package`),
    ctx.api.get('/processes'),
    ctx.api.get(`/projects/${id}/usage`).catch(() => ({ scripts: {} })),
  ]);
  st.data = { scripts: Object.keys(pkg.scripts || {}), procs: procs.filter(p => p.projectId === st.project.id), usage: usage.scripts || {} };
  render(ctx, el);
}

function render(ctx, el) {
  const { esc, fmt, formatUptime } = ctx.ui;
  const { t } = ctx;
  const { scripts, procs, usage } = states.get(el).data;
  const running = procs.filter(p => p.running);
  ctx.widget.setBadge(running.length ? { icon: 'play', text: fmt.number(running.length) } : null);
  if (!scripts.length && !procs.length) { ctx.ui.patch(el, `<p class="npw-muted">${esc(t('widget.noScripts'))}</p>`); return; }
  // più usati per numero di avvii, poi nell'ordine di package.json
  const ranked = [...scripts].sort((a, b) => (usage[b]?.count || 0) - (usage[a]?.count || 0)).slice(0, MAX_SCRIPTS);
  const isRunning = s => running.some(p => p.script === s);
  ctx.ui.patch(el, `
    ${procs.length ? `<div class="npw-procs">${procs.map(p => `
      <div class="npw-proc ${p.running ? '' : 'npw-dead'}">
        <span class="proc-dot ${p.running ? '' : 'dead'}"></span>
        <span class="npw-name">${esc(scriptLabel(p.script))}</span>
        ${(p.ports || []).map(port => `<span class="proc-port">:${esc(port)}</span>`).join('')}
        <span class="npw-muted">${p.running && p.startedAt ? esc(formatUptime(p.startedAt)) : p.running ? '' : esc(t('widget.exited', { code: String(p.exitCode) }))}</span>
        <span class="npw-actions">
          <button class="btn btn-ghost btn-sm" data-npw="logs" data-id="${esc(p.id)}" title="${esc(t('widget.logs'))}"><i data-icon="menu"></i></button>
          ${p.running ? `<button class="btn btn-ghost btn-sm" data-npw="restart" data-id="${esc(p.id)}" title="${esc(t('widget.restart'))}"><i data-icon="refresh-cw"></i></button>
            <button class="btn btn-ghost btn-sm" data-npw="stop" data-id="${esc(p.id)}" title="${esc(t('widget.stop'))}"><i data-icon="square"></i></button>` : ''}
        </span>
      </div>`).join('')}</div>` : ''}
    ${ranked.length ? `<div class="npw-head">${esc(t('widget.mostUsed'))}</div>
      <div class="npw-scripts">${ranked.map(s => `
        <div class="npw-script">
          <span class="npw-name">${esc(s)}</span>
          <span class="npw-muted">${usage[s]?.count ? esc(t('widget.runs', { count: usage[s].count })) : ''}</span>
          <button class="btn btn-ghost btn-sm" data-npw="run" data-script="${esc(s)}" ${isRunning(s) ? 'disabled' : ''} title="${esc(t('widget.run', { script: scriptLabel(s) }))}"><i data-icon="play"></i></button>
        </div>`).join('')}</div>` : ''}`);
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, timer: null, data: null });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-npw]');
      if (!b) return;
      const st = states.get(el);
      try {
        if (b.dataset.npw === 'run') {
          const r = await ctx.api.post(`/projects/${encodeURIComponent(st.project.id)}/run`, { script: b.dataset.script });
          ctx.ui.toast(ctx.t('toast.started', { script: scriptLabel(b.dataset.script) }), 'success');
          ctx.widget.openFull({ project: st.project.id, process: r.id });
        } else if (b.dataset.npw === 'stop') await ctx.api.del(`/processes/${encodeURIComponent(b.dataset.id)}`);
        else if (b.dataset.npw === 'restart') await ctx.api.post(`/processes/${encodeURIComponent(b.dataset.id)}/restart`);
        else if (b.dataset.npw === 'logs') { ctx.widget.openFull({ project: st.project.id, process: b.dataset.id }); return; }
        await load(ctx, el);
      } catch (err) { ctx.ui.toast(err.message, 'error'); }
    });
    await load(ctx, el);
    states.get(el).timer = setInterval(() => load(ctx, el).catch(() => {}), POLL_MS);
  },
  refresh: (ctx, el) => load(ctx, el),
  unmount(ctx, el) { clearInterval(states.get(el)?.timer); states.delete(el); },
};
