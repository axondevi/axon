/**
 * Axon UI kit — toast helper.
 *
 * Usage from any page that loads /_ui-kit.js:
 *
 *   AxonUI.toast('Salvo com sucesso', { type: 'success' });
 *   AxonUI.toast('Limite atingido', { type: 'error', title: 'Ops!' });
 *   AxonUI.toast('Aguardando deploy...', { type: 'warn', durationMs: 8000 });
 *
 * Replaces the awful built-in `alert()` everywhere.
 */
(function () {
  function ensureContainer() {
    let c = document.getElementById('axon-toasts');
    if (!c) {
      c = document.createElement('div');
      c.id = 'axon-toasts';
      document.body.appendChild(c);
    }
    return c;
  }

  function toast(message, opts) {
    opts = opts || {};
    const container = ensureContainer();
    const el = document.createElement('div');
    el.className = 'axon-toast' + (opts.type ? ' ' + opts.type : '');
    if (opts.title) {
      const t = document.createElement('div');
      t.className = 'toast-title';
      t.textContent = opts.title;
      el.appendChild(t);
    }
    const m = document.createElement('div');
    m.className = 'toast-msg';
    m.textContent = message;
    el.appendChild(m);
    container.appendChild(el);

    const ttl = opts.durationMs ?? 5000;
    setTimeout(() => {
      el.classList.add('fading');
      setTimeout(() => el.remove(), 250);
    }, ttl);

    return el;
  }

  /**
   * Format a USDC cost for display. Handles small fractions cleanly.
   *  0.0001 → "$0.0001"
   *  0.012  → "$0.012"
   *  1.5    → "$1.50"
   */
  function formatCost(usdc) {
    const n = Number(usdc);
    if (!isFinite(n) || n === 0) return '$0';
    if (n < 0.01) return '$' + n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (n < 1) return '$' + n.toFixed(3);
    return '$' + n.toFixed(2);
  }

  window.AxonUI = { toast, formatCost };
})();
