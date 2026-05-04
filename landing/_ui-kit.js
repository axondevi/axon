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

  /**
   * Onboarding helpers — step indicator (1→2→3) and welcome banner.
   *
   * The three steps are fixed across the product:
   *   1. Criar agente            (lives on /build)
   *   2. Conectar WhatsApp       (lives on /whatsapp)
   *   3. Testar no zap           (back to /dashboard)
   *
   * `renderSteps(target, current)` injects a horizontal pill row.
   * `current` is 1|2|3 (the step the user is ON). Earlier steps render
   * as "done"; later steps as "todo". Same target can be re-rendered.
   *
   * `welcomeBanner(target, opts)` injects a dismissible headline.
   *  - opts.title, opts.message: strings (PT-BR)
   *  - opts.cta: { label, href } — optional inline action button
   *  - opts.dismissKey: localStorage key — once dismissed, never shown again
   */
  const STEP_DEFS = [
    { n: 1, label: 'Criar agente', href: '/build' },
    { n: 2, label: 'Conectar WhatsApp', href: '/whatsapp' },
    { n: 3, label: 'Testar no zap', href: '/dashboard' },
  ];

  function renderSteps(target, current) {
    const host = typeof target === 'string' ? document.getElementById(target) : target;
    if (!host) return;
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'axon-steps';
    wrap.setAttribute('data-step', String(current));
    STEP_DEFS.forEach((s, i) => {
      const status = s.n < current ? 'done' : s.n === current ? 'active' : 'todo';
      const node = document.createElement(s.n < current ? 'a' : 'div');
      node.className = 'axon-step ' + status;
      if (s.n < current) node.href = s.href;
      const num = document.createElement('span');
      num.className = 'axon-step-num';
      num.textContent = s.n < current ? '✓' : String(s.n);
      const lbl = document.createElement('span');
      lbl.className = 'axon-step-label';
      lbl.textContent = s.label;
      node.appendChild(num);
      node.appendChild(lbl);
      wrap.appendChild(node);
      if (i < STEP_DEFS.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'axon-step-sep';
        wrap.appendChild(sep);
      }
    });
    host.appendChild(wrap);
  }

  function welcomeBanner(target, opts) {
    opts = opts || {};
    const host = typeof target === 'string' ? document.getElementById(target) : target;
    if (!host) return;
    if (opts.dismissKey) {
      try {
        if (localStorage.getItem(opts.dismissKey) === '1') return;
      } catch (_) { /* private mode */ }
    }
    const el = document.createElement('div');
    el.className = 'axon-welcome-banner';
    const txt = document.createElement('div');
    txt.className = 'axon-welcome-text';
    if (opts.title) {
      const t = document.createElement('div');
      t.className = 'axon-welcome-title';
      t.textContent = opts.title;
      txt.appendChild(t);
    }
    if (opts.message) {
      const m = document.createElement('div');
      m.className = 'axon-welcome-msg';
      m.textContent = opts.message;
      txt.appendChild(m);
    }
    el.appendChild(txt);
    if (opts.cta && opts.cta.href && opts.cta.label) {
      const a = document.createElement('a');
      a.className = 'axon-welcome-cta';
      a.href = opts.cta.href;
      a.textContent = opts.cta.label;
      el.appendChild(a);
    }
    const close = document.createElement('button');
    close.className = 'axon-welcome-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Fechar');
    close.textContent = '×';
    close.addEventListener('click', () => {
      el.remove();
      if (opts.dismissKey) {
        try { localStorage.setItem(opts.dismissKey, '1'); } catch (_) { /* private mode */ }
      }
    });
    el.appendChild(close);
    host.prepend(el);
  }

  window.AxonUI = { toast, formatCost, handleAuthError, renderSteps, welcomeBanner };
})();
