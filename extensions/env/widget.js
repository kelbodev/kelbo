// Widget Env per la dashboard di progetto: file .env con le chiavi mancanti o vuote rispetto
// al modello (.env.example); mai i valori. ＋ aggiunge le mancanti con i valori del modello.

const states = new WeakMap(); // el → { project, data }

async function load(ctx, el) {
  const st = states.get(el);
  st.data = await ctx.api.get(`/projects/${encodeURIComponent(st.project.id)}`);
  render(ctx, el);
}

function render(ctx, el) {
  const { esc, fmt } = ctx.ui;
  const { t } = ctx;
  const { files, template, issues } = states.get(el).data;
  ctx.widget.setBadge(issues ? `⚠ ${fmt.number(issues)}` : null);
  if (!files.length) { ctx.ui.patch(el, `<p class="env-muted">${esc(t('widget.noFiles'))}</p>`); return; }
  ctx.ui.patch(el, `<div class="envw-files">${files.map(f => {
    if (f.error) return `<div class="envw-file"><code>${esc(f.name)}</code><span class="envw-err">${esc(f.error)}</span></div>`;
    const isTpl = f.name === template;
    const problems = (f.missing?.length || 0) + (f.empty?.length || 0);
    return `<div class="envw-file">
      <div class="envw-row"><code>${esc(f.name)}</code>
        ${isTpl ? `<span class="env-muted">${esc(t('widget.template'))}</span>` : !template ? '' : problems ? '' : `<span class="envw-ok">${esc(t('widget.ok'))}</span>`}
        ${f.missing?.length ? `<button class="btn btn-ghost btn-sm" data-envw="add" data-file="${esc(f.name)}">${esc(t('addMissing', { count: f.missing.length }))}</button>` : ''}
      </div>
      ${f.missing?.length ? `<div class="envw-err">${esc(t('widget.missingKeys', { list: fmt.list(f.missing) }))}</div>` : ''}
      ${!isTpl && f.empty?.length ? `<div class="envw-warn">${esc(t('widget.emptyKeys', { list: fmt.list(f.empty) }))}</div>` : ''}
    </div>`;
  }).join('')}</div>
  ${template ? '' : `<p class="env-muted">${esc(t('widget.noTemplate'))}</p>`}`);
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, data: null });
    el.addEventListener('click', async e => {
      const b = e.target.closest('[data-envw="add"]');
      if (!b) return;
      const { data, project: p } = states.get(el);
      const f = data.files.find(x => x.name === b.dataset.file);
      if (!f || !confirm(ctx.t('confirmAddMissing', { count: f.missing.length, file: f.name, template: data.template }))) return;
      try {
        const r = await ctx.api.post(`/projects/${encodeURIComponent(p.id)}/files/${encodeURIComponent(f.name)}/add-missing`, { version: f.version });
        ctx.ui.toast(ctx.t('addedMissing', { count: r.added.length, file: f.name }), 'success');
        await load(ctx, el);
      } catch (err) { ctx.ui.toast(err.message, 'error'); load(ctx, el).catch(() => {}); }
    });
    await load(ctx, el);
  },
  refresh: (ctx, el) => load(ctx, el),
  unmount(ctx, el) { states.delete(el); },
};
