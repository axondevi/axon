/**
 * Axon embed widget — paste-once floating chat bubble for any website.
 *
 * Usage:
 *   <script async src="https://axon-5zf.pages.dev/embed.js"
 *           data-agent="your-agent-slug"
 *           data-position="bottom-right"
 *           data-color="#7c5cff">
 *   </script>
 *
 * Behavior:
 *   - Injects a floating action button (FAB) in the configured corner
 *   - Click → opens an iframe pointing at /agent/<slug>?embed=1
 *   - Owner-paid agents work without prompting visitors for an API key
 *   - All styles scoped to .axon-embed-* to avoid collisions with the host site
 */
(function () {
  'use strict';

  // Find the script tag that loaded us — it has the data-* config we need
  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (/embed\.js(\?|$)/.test(scripts[i].src)) return scripts[i];
    }
    return null;
  })();
  if (!script) return;

  var slug = script.getAttribute('data-agent');
  if (!slug) {
    console.error('[axon-embed] missing data-agent attribute');
    return;
  }

  var position = (script.getAttribute('data-position') || 'bottom-right').toLowerCase();
  var color = script.getAttribute('data-color') || '#7c5cff';
  var origin = (function () {
    try {
      var u = new URL(script.src);
      return u.origin;
    } catch { return 'https://axon-5zf.pages.dev'; }
  })();

  // ── Styles (scoped) ────────────────────────────────────────────────
  var css = `
    .axon-embed-fab {
      position: fixed; z-index: 2147483645;
      width: 60px; height: 60px;
      border-radius: 50%;
      background: ${color};
      color: #fff;
      border: 0; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 8px 24px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.12);
      transition: transform 180ms cubic-bezier(.34,1.56,.64,1), box-shadow 180ms ease;
      font-family: system-ui, -apple-system, sans-serif;
    }
    .axon-embed-fab:hover { transform: scale(1.06); box-shadow: 0 12px 32px rgba(0,0,0,0.22), 0 4px 12px rgba(0,0,0,0.14); }
    .axon-embed-fab:active { transform: scale(0.98); }
    .axon-embed-fab svg { width: 28px; height: 28px; }
    .axon-embed-fab[aria-expanded="true"] .axon-embed-icon-chat { display: none; }
    .axon-embed-fab[aria-expanded="false"] .axon-embed-icon-close { display: none; }

    .axon-embed-pos-bottom-right { bottom: 24px; right: 24px; }
    .axon-embed-pos-bottom-left  { bottom: 24px; left: 24px; }
    .axon-embed-pos-top-right    { top: 24px; right: 24px; }
    .axon-embed-pos-top-left     { top: 24px; left: 24px; }

    .axon-embed-frame-wrap {
      position: fixed; z-index: 2147483644;
      width: 380px; height: 600px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 120px);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 24px 64px rgba(0,0,0,0.24), 0 4px 16px rgba(0,0,0,0.12);
      background: #0a0a0b;
      opacity: 0; transform: translateY(8px) scale(0.98);
      pointer-events: none;
      transition: opacity 200ms ease, transform 200ms ease;
    }
    .axon-embed-frame-wrap[data-open="1"] { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
    .axon-embed-frame-wrap iframe { width: 100%; height: 100%; border: 0; display: block; }

    .axon-embed-pos-bottom-right .axon-embed-frame-wrap,
    .axon-embed-frame-pos-bottom-right { bottom: 100px; right: 24px; }
    .axon-embed-frame-pos-bottom-left  { bottom: 100px; left: 24px; }
    .axon-embed-frame-pos-top-right    { top: 100px; right: 24px; }
    .axon-embed-frame-pos-top-left     { top: 100px; left: 24px; }

    @media (max-width: 480px) {
      .axon-embed-frame-wrap {
        width: calc(100vw - 16px) !important;
        height: calc(100vh - 100px) !important;
        bottom: 90px !important; right: 8px !important; left: auto !important;
      }
    }

    .axon-embed-badge {
      position: absolute; top: -4px; right: -4px;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: #f87171; border: 2px solid #fff;
      animation: axon-embed-pulse 2s infinite;
    }
    @keyframes axon-embed-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.15); opacity: 0.85; }
    }
  `;

  // ── DOM ────────────────────────────────────────────────────────────
  function init() {
    if (document.getElementById('axon-embed-style')) return;

    var style = document.createElement('style');
    style.id = 'axon-embed-style';
    style.textContent = css;
    document.head.appendChild(style);

    var validPos = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
    var pos = validPos.indexOf(position) !== -1 ? position : 'bottom-right';

    var fab = document.createElement('button');
    fab.id = 'axon-embed-fab';
    fab.className = 'axon-embed-fab axon-embed-pos-' + pos;
    fab.setAttribute('aria-label', 'Open chat');
    fab.setAttribute('aria-expanded', 'false');
    fab.innerHTML = `
      <svg class="axon-embed-icon-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <svg class="axon-embed-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
      <span class="axon-embed-badge" id="axon-embed-badge"></span>
    `;
    document.body.appendChild(fab);

    var frameWrap = document.createElement('div');
    frameWrap.id = 'axon-embed-frame-wrap';
    frameWrap.className = 'axon-embed-frame-wrap axon-embed-frame-pos-' + pos;
    frameWrap.dataset.open = '0';
    document.body.appendChild(frameWrap);

    var iframe = null;
    var opened = false;

    function open() {
      if (opened) return;
      if (!iframe) {
        iframe = document.createElement('iframe');
        iframe.src = origin + '/agent/' + encodeURIComponent(slug) + '?embed=1';
        iframe.allow = 'clipboard-write';
        iframe.title = 'Chat';
        frameWrap.appendChild(iframe);
      }
      frameWrap.dataset.open = '1';
      fab.setAttribute('aria-expanded', 'true');
      fab.setAttribute('aria-label', 'Close chat');
      var badge = document.getElementById('axon-embed-badge');
      if (badge) badge.style.display = 'none';
      opened = true;
    }

    function close() {
      frameWrap.dataset.open = '0';
      fab.setAttribute('aria-expanded', 'false');
      fab.setAttribute('aria-label', 'Open chat');
      opened = false;
    }

    fab.addEventListener('click', function () {
      opened ? close() : open();
    });

    // Allow the iframe to request a close from inside (e.g., user dismissed)
    window.addEventListener('message', function (e) {
      if (e.origin !== origin) return;
      if (e.data && e.data.type === 'axon:close') close();
      if (e.data && e.data.type === 'axon:open') open();
    });

    // Expose tiny global API for hosting page
    window.AxonEmbed = {
      open: open,
      close: close,
      slug: slug,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
