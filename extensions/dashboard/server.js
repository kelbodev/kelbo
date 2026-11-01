// Dashboard di progetto: per ogni progetto i widget scelti (chiave "estensione/widget"), in
// ordine, con la loro dimensione. Senza scelta salvata la dashboard mostra tutti i widget.
const WIDGET_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9-]{0,39}$/;
const SIZES = new Set(['s', 'm', 'l']);
const MAX_WIDGETS = 50;

module.exports = function createDashboard(ctx) {
  const { KEY_RE } = ctx.lib.validate;
  const layouts = () => ctx.config.get('dashboards');

  // [{ key, size }] validato; bad(name) crea l'errore giusto per chi chiama
  function checkWidgets(list, bad) {
    if (!Array.isArray(list) || list.length > MAX_WIDGETS) throw bad('widgets_invalid', { max: MAX_WIDGETS });
    const seen = new Set();
    for (const w of list) {
      if (!w || typeof w !== 'object' || !WIDGET_KEY_RE.test(w.key || '')) throw bad('widget_key', { key: String(w?.key ?? '') });
      if (!SIZES.has(w.size)) throw bad('widget_size', { key: w.key });
      if (seen.has(w.key)) throw bad('widget_duplicate', { key: w.key });
      seen.add(w.key);
    }
    return list.map(w => ({ key: w.key, size: w.size }));
  }

  const config = {
    dashboards: {
      empty: {},
      validate(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw ctx.error.config('not_an_object');
        for (const [project, layout] of Object.entries(value)) {
          if (!KEY_RE.test(project)) throw ctx.error.config('project_id', { id: project });
          checkWidgets(layout?.widgets, (name, params) => ctx.error.config(name, { ...params, project }));
        }
      },
      normalize: v => (v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).map(([k, l]) => [k, { widgets: Array.isArray(l?.widgets) ? l.widgets.map(w => ({ key: w?.key, size: w?.size })) : [] }]))
        : v),
    },
  };

  const projectOr404 = req => {
    const id = req.params.project;
    if (!KEY_RE.test(id || '') || !ctx.projects.get(id)) throw ctx.error(404, 'project_not_found', { id: String(id) });
    return id;
  };

  return {
    config,
    // Dati collegati a un progetto (pannello 📁 del core, prima di rimuoverlo)
    projectLinks: project => (layouts()[project.id] ? [{ key: 'links.layout' }] : []),
    handlers: {
      // { widgets: [...] } o { widgets: null } se il progetto non ha una scelta salvata
      getLayout(req, res) {
        const id = projectOr404(req);
        res.json({ widgets: layouts()[id]?.widgets ?? null });
      },
      saveLayout(req, res) {
        const id = projectOr404(req);
        const widgets = checkWidgets(req.body?.widgets, (name, params) => ctx.error(400, name, params));
        ctx.config.set('dashboards', { ...layouts(), [id]: { widgets } });
        res.json({ widgets });
      },
      // di nuovo tutti i widget disponibili
      resetLayout(req, res) {
        const id = projectOr404(req);
        const { [id]: _, ...rest } = layouts();
        ctx.config.set('dashboards', rest);
        res.json({ widgets: null });
      },
    },
  };
};
