/**
 * Axon i18n — shared PT/EN engine for every public page.
 *
 * USAGE
 * In each HTML page:
 *   <link rel="stylesheet" href="/_i18n.css" />   (optional, but ships the toggle button styles)
 *   <script src="/_i18n.js" defer></script>
 *
 * In the page markup:
 *   - Mark translatable elements with data-pt and data-en, e.g.
 *     <h1 data-pt="Olá" data-en="Hello">Olá</h1>
 *   - Drop a toggle button anywhere (typically in the nav):
 *     <button id="lang-toggle" class="lang-toggle" type="button" aria-label="Trocar idioma">
 *       <span data-active="pt">🇧🇷 PT</span>
 *       <span data-active="en">🇺🇸 EN</span>
 *     </button>
 *
 * Why this exists
 * The browser's auto-translate kept turning native PT-BR copy into
 * scrambled non-words ("clínicas" → "r e os"). Dropping <html lang="en">
 * stopped the prompt, but the user actually wants both languages —
 * intentional, not auto. This module gives them that without pulling
 * in a framework.
 *
 * Strategy
 *   - First call sets <html lang>, walks every [data-pt][data-en] node,
 *     and swaps its text via data-{lang}.
 *   - Choice persists in localStorage('axon-lang').
 *   - Default falls back to navigator.language: starts in PT for
 *     pt-BR/pt-PT speakers, EN for everyone else.
 *   - For nodes with child elements (e.g. an H1 with a <span class="gradient">
 *     inside), we update only the first text node so children survive
 *     intact.
 *   - Pages that render content dynamically (build.html, dashboard.html,
 *     niche.html) can re-call window.AxonI18n.apply() after their own
 *     render so the new nodes get translated too.
 */
(function () {
  var STORAGE_KEY = 'axon-lang';

  function getLang() {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'pt' || saved === 'en') return saved;
    var nav = (navigator.language || '').toLowerCase();
    return nav.indexOf('pt') === 0 ? 'pt' : 'en';
  }

  function applyLang(lang) {
    if (lang !== 'pt' && lang !== 'en') lang = 'pt';

    document.documentElement.lang = lang === 'en' ? 'en' : 'pt-BR';

    var nodes = document.querySelectorAll('[data-pt][data-en]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var v = n.dataset[lang];
      if (typeof v !== 'string') continue;

      // Update placeholder/title/aria-label too if matching attrs exist
      if (n.hasAttribute('placeholder') && n.dataset['placeholder' + lang.toUpperCase()]) {
        n.setAttribute('placeholder', n.dataset['placeholder' + lang.toUpperCase()]);
      }
      if (n.dataset['title' + lang.toUpperCase()]) {
        n.setAttribute('title', n.dataset['title' + lang.toUpperCase()]);
      }

      if (n.children.length === 0) {
        n.textContent = v;
      } else {
        // Preserve embedded children (e.g. the .gradient span in H1).
        // Only update the first text node we find.
        var c = n.firstChild;
        while (c && c.nodeType !== 3) c = c.nextSibling;
        if (c) c.nodeValue = v;
        else n.insertBefore(document.createTextNode(v), n.firstChild);
      }
    }

    // Also handle elements that need attribute-only translation, like
    // <input data-placeholder-pt="..." data-placeholder-en="..." />.
    var attrNodes = document.querySelectorAll('[data-placeholder-pt][data-placeholder-en]');
    for (var k = 0; k < attrNodes.length; k++) {
      var an = attrNodes[k];
      var ph = an.dataset['placeholder' + lang.toUpperCase()];
      if (typeof ph === 'string') an.setAttribute('placeholder', ph);
    }

    // Toggle button highlight
    var spans = document.querySelectorAll('.lang-toggle [data-active]');
    for (var j = 0; j < spans.length; j++) {
      spans[j].classList.toggle('active', spans[j].dataset.active === lang);
    }
  }

  function setLang(lang) {
    localStorage.setItem(STORAGE_KEY, lang);
    applyLang(lang);
    // Notify any page that renders dynamic content so it can re-translate.
    document.dispatchEvent(new CustomEvent('axon:langchanged', { detail: { lang: lang } }));
  }

  function bindToggle() {
    var btn = document.getElementById('lang-toggle');
    if (!btn || btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      var current = getLang();
      setLang(current === 'en' ? 'pt' : 'en');
    });
  }

  function init() {
    bindToggle();
    applyLang(getLang());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API for pages that re-render content
  window.AxonI18n = {
    get: getLang,
    set: setLang,
    apply: function () { applyLang(getLang()); bindToggle(); },
  };
})();
