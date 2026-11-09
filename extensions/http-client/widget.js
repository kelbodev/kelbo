// Widget HTTP per la dashboard di progetto: richieste delle sezioni collegate al progetto,
// inviate dal widget (stesse regole dell'editor: variabili, utenza, token), con lo stato
// dell'ultima risposta di questa pagina. Il dettaglio si apre nella sezione HTTP.

// colori dei metodi: variabili del tema
const METHOD_COLORS = { GET: 'var(--http-get)', POST: 'var(--http-post)', PUT: 'var(--http-put)', PATCH: 'var(--http-patch)', DELETE: 'var(--http-delete)', HEAD: 'var(--http-other)', OPTIONS: 'var(--http-other)' };
const methodColor = m => Object.hasOwn(METHOD_COLORS, m) ? METHOD_COLORS[m] : 'var(--http-other)';
const states = new WeakMap(); // el → { project, sections, last: Map(requestId → { status, ms, at } | { error } | 'sending') }

async function load(ctx, el) {
  const st = states.get(el);
  st.sections = (await ctx.api.get('/sections')).filter(s => s.projectId === st.project.id);
  render(ctx, el);
}

const statusClass = s => (s >= 500 ? 'hcw-5' : s >= 400 ? 'hcw-4' : s >= 300 ? 'hcw-3' : 'hcw-2');

function render(ctx, el) {
  const { esc, fmt } = ctx.ui;
  const { t } = ctx;
  const st = states.get(el);
  const errors = [...st.last.values()].filter(x => x?.error || x?.status >= 400).length;
  ctx.widget.setBadge(errors ? { icon: 'circle-x', text: fmt.number(errors) } : null);
  if (!st.sections.length) { ctx.ui.patch(el, `<p class="hc-muted">${esc(t('widget.none'))}</p>`); return; }
  ctx.ui.patch(el, st.sections.map(s => `
    <div class="hcw-section">${esc(s.label)}</div>
    ${s.requests.length ? s.requests.map(r => {
      const last = st.last.get(r.id);
      const user = s.userTypes.find(u => u.id === r.userType);
      return `<div class="hcw-req">
        <span class="hc-badge" style="--m:${methodColor(r.method)}">${esc(r.method)}</span>
        <button class="hcw-label" data-hcw="open" data-section="${esc(s.id)}" data-request="${esc(r.id)}" title="${esc(t('widget.openTitle'))}">${esc(r.label)}</button>
        ${user ? `<span class="hc-muted hcw-user"><i data-icon="user"></i> ${esc(user.label)}</span>` : ''}
        <span class="hcw-last">${last === 'sending' ? `<span class="hc-muted">${esc(t('widget.sending'))}</span>`
          : last?.error ? `<span class="hcw-5" title="${esc(last.error)}"><i data-icon="circle-x"></i></span>`
          : last ? `<span class="hcw-status ${statusClass(last.status)}" title="${esc(t('widget.lastTitle', { status: last.status, ms: fmt.number(last.ms), when: fmt.relative(last.at) }))}">${esc(last.status)}</span>` : ''}</span>
        <button class="btn btn-ghost btn-sm" data-hcw="send" data-section="${esc(s.id)}" data-request="${esc(r.id)}" ${last === 'sending' ? 'disabled' : ''} title="${esc(t('widget.sendTitle'))}"><i data-icon="play"></i></button>
      </div>`;
    }).join('') : `<p class="hc-muted">${esc(t('widget.noRequests'))}</p>`}`).join(''));
}

// Invio come dall'editor: master password chiesta se serve, errori nel widget
async function send(ctx, el, sectionId, requestId) {
  const st = states.get(el);
  const r = st.sections.find(s => s.id === sectionId)?.requests.find(x => x.id === requestId);
  if (!r) return;
  st.last.set(requestId, 'sending');
  render(ctx, el);
  const call = () => ctx.api.post('/send', { section: sectionId, request: r });
  try {
    let res;
    try { res = await call(); } catch (e) { if (!ctx.vault.isVaultError(e) || !(await ctx.vault.ensure())) throw e; res = await call(); }
    st.last.set(requestId, res.error ? { error: res.error } : { status: res.status, ms: res.ms, at: Date.now() });
  } catch (e) { st.last.set(requestId, { error: e.message }); ctx.ui.toast(e.message, 'error'); }
  if (states.has(el)) render(ctx, el);
}

export default {
  async mount(ctx, el, { project }) {
    states.set(el, { project, sections: [], last: new Map() });
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-hcw]');
      if (!b) return;
      if (b.dataset.hcw === 'send') send(ctx, el, b.dataset.section, b.dataset.request);
      else ctx.widget.openFull({ section: b.dataset.section, request: b.dataset.request });
    });
    await load(ctx, el);
  },
  refresh: (ctx, el) => load(ctx, el),
  unmount(ctx, el) { states.delete(el); },
};
