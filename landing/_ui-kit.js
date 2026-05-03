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

  /**
   * If `err` looks like a stale/missing api_key, drop the cached key and
   * bounce through /login (which silently re-exchanges any active
   * Supabase session and redirects back via ?return=). Returns true
   * when it redirected — the caller should `return` immediately so it
   * doesn't try to render error UI right before the navigation.
   *
   * Works with both legacy storage keys (`axon.apiKey`, `axon_api_key`)
   * since different pages standardized on different names.
   */
  function handleAuthError(err) {
    const msg = (err && (err.message || err.error)) || String(err || '');
    if (!/api key|unauthorized|401/i.test(msg)) return false;
    try {
      localStorage.removeItem('axon.apiKey');
      localStorage.removeItem('axon_api_key');
    } catch (_) { /* private mode */ }
    const back = location.pathname + location.search;
    location.href = '/login?return=' + encodeURIComponent(back);
    return true;
  }

  window.AxonUI = { toast, formatCost, handleAuthError };
})();
