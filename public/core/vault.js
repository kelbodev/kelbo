// Vault della master password del core, lato UI: stato e dialogo per sbloccarlo (o crearlo
// la prima volta) quando un'estensione deve leggere o salvare un segreto. Le estensioni lo
// usano tramite ctx.vault: if (await ctx.vault.ensure()) … riprova l'operazione.
window.Vault = (() => {
  const { esc, openModal, closeModal, apiClient } = window.UI;
  const { t } = window.I18n;
  const api = apiClient('/api/core');
  let pending = null;

  const status = () => api.get('/vault');

  // Campo password con l'occhio per vedere quello che si è scritto
  const passwordField = (id, placeholder) => `<div class="pw-field">
      <input class="form-input" type="password" id="${id}" autocomplete="off" spellcheck="false" placeholder="${esc(placeholder)}" onkeydown="if(event.key==='Enter')Vault.submit()">
      <button type="button" class="pw-eye" onclick="Vault.toggleShow(this)" aria-pressed="false" title="${esc(t('core.vault.show'))}" aria-label="${esc(t('core.vault.show'))}">${window.UI.icon('eye')}</button>
    </div>`;
  function toggleShow(btn) {
    const input = btn.previousElementSibling;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.setAttribute('aria-pressed', String(show));
    btn.title = t(show ? 'core.vault.hide' : 'core.vault.show');
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = window.UI.icon(show ? 'eye-off' : 'eye');
    input.focus();
  }

  // true quando il vault è sbloccato (subito o dopo il dialogo), false se l'utente rinuncia
  async function ensure() {
    const st = await status();
    if (st.state === 'unlocked') return true;
    if (pending) return pending;
    pending = new Promise(resolve => {
      const creating = st.state === 'uninitialized';
      const finish = ok => { pending = null; resolve(ok); };
      openModal(t(creating ? 'core.vault.createTitle' : 'core.vault.unlockTitle'), `
        <p class="vault-text">${esc(creating ? t('core.vault.createText', { min: st.minLength }) : t('core.vault.unlockText'))}</p>
        <div class="form-row">${passwordField('f_core_vault', t('core.vault.password'))}</div>
        ${creating ? `<div class="form-row">${passwordField('f_core_vault2', t('core.vault.repeat'))}</div>` : ''}
        <div class="vault-error" id="f_core_vault_err"></div>`,
        `<button class="btn btn-ghost" onclick="Vault.cancel()">${esc(t('core.action.cancel'))}</button>
         <button class="btn btn-primary" onclick="Vault.submit()">${esc(t(creating ? 'core.vault.create' : 'core.vault.unlock'))}</button>`);
      setTimeout(() => document.getElementById('f_core_vault')?.focus(), 0);
      current = {
        async submit() {
          const pwd = document.getElementById('f_core_vault').value;
          const err = document.getElementById('f_core_vault_err');
          if (creating) {
            if ([...pwd].length < st.minLength) { err.textContent = t('core.vault.tooShort', { min: st.minLength }); return; }
            if (pwd !== document.getElementById('f_core_vault2').value) { err.textContent = t('core.vault.mismatch'); return; }
          }
          try {
            await api.post(creating ? '/vault/init' : '/vault/unlock', { password: pwd });
            current = null;
            closeModal();
            finish(true);
          } catch (e) { err.textContent = e.message; }
        },
        cancel() { current = null; closeModal(); finish(false); },
        abandon() { finish(false); },
      };
    });
    return pending;
  }
  let current = null;
  // dialogo chiuso o sostituito da un altro (clic fuori, un altro openModal): rinuncia, così le
  // azioni che aspettano il vault non restano sospese
  document.addEventListener('ui:modal', () => {
    if (!current) return;
    const c = current;
    current = null;
    c.abandon();
  });

  // Errori del vault (423 bloccato o non creato): true se l'errore è del vault
  const isVaultError = e => e?.code === 'core.vault_locked' || e?.code === 'core.vault_missing';

  return { status, ensure, isVaultError, toggleShow, submit: () => current?.submit(), cancel: () => current?.cancel() };
})();
