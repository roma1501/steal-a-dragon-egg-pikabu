/* =========================================================================
   Steal a Dragon Egg — UI icon registry (SE.Icons)

   Three kinds of keys:
     'shop', 'gift', 'egg' …          ImageGen icons            assets/ui/<key>.png
     'render/gem', 'render/egg-frost' renders of the game GLBs  assets/ui/render/<name>.png
     'concept/egg-meadow' …           crops of the concept art  assets/ui/concept/<name>.png
     'svg/close', 'svg/menu' …        inline SVG glyphs (currentColor, crisp at any size)
   A key may carry its own extension ('concept/base-hatching-bg-blur.jpg').

   API
     SE.Icons.url(key) -> 'assets/ui/…'           (svg/* → '')
     SE.Icons.html(key[, opts]) -> html string     <span class="ic …"><img|svg></span>
         opts: { cls, label (accessible name; default aria-hidden), alt: fallbackKey,
                 lazy:true (loading=lazy for long grids) }
         A missing image swaps to opts.alt once, then shows a short text fallback.
     SE.Icons.el(key[, opts]) -> HTMLElement
     SE.Icons.glyph(name) -> raw '<svg …>' string (svg/<name> without the wrapper)
     SE.Icons.has(key) -> bool                     known shipped icon / glyph / render|concept path
     SE.Icons.keys() -> [ … ]                      every known ImageGen + glyph key
     SE.Icons.egg(speciesId) -> 'render/egg-<id>'  (alt: concept crop)   — helpers return
     SE.Icons.baby(speciesId) / adult(speciesId)                           { key, alt }
     SE.Icons.mount(root)                           fills empty [data-ui-icon="key"] slots
     SE.Icons.refreshLabels(root)                   [data-i18n-title] → title + aria-label
     SE.Icons.preload(keys?, timeoutMs) -> Promise  resolves when loaded/failed or on timeout

   Paths are written as 'assets/ui/' + key literals so tools/build.mjs copies assets/ui/**.
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var doc = global.document;

  /* ImageGen icons that ship in assets/ui/ (SPEC §5.4). */
  var PNG = ['bag', 'banknotes', 'book', 'cash-bonus', 'close', 'clover', 'egg', 'egg-candy', 'egg-desert',
    'egg-forest', 'egg-ice', 'egg-sky', 'egg-volcano', 'fast-hatch', 'finish-flag', 'gear', 'ghost', 'gift',
    'hatching-chick', 'heart', 'interact-hand', 'jump-arrow', 'lightning', 'magnet', 'map', 'money-bag',
    'moon', 'paw', 'pen-house', 'prize-wheel', 'question', 'rainbow', 'shield', 'shoe', 'shop', 'smoke-puff',
    'sparkles', 'star', 'trail-blue', 'trail-gold', 'trail-green', 'trail-purple', 'trail-rainbow', 'trophy',
    'watch-video'];

  /* Short text shown when an image is missing (never empty boxes). */
  var FALLBACK = {
    bag: 'BAG', book: 'IDX', gear: '⚙', egg: 'EGG', paw: 'PAW', shoe: 'SPD', trophy: 'TOP', rainbow: 'TRL',
    banknotes: '$', 'money-bag': '$', 'cash-bonus': '$', 'interact-hand': 'E', 'jump-arrow': '↑', star: '★',
    shop: 'SHOP', close: '✕', 'finish-flag': 'FIN', gift: 'GIFT', 'prize-wheel': 'SPIN', question: '?',
    'watch-video': '▶', 'fast-hatch': '2×', 'hatching-chick': 'HATCH', lightning: '⚡', shield: 'SAFE',
    sparkles: '✦', 'pen-house': 'PEN', moon: 'ZZ', map: 'MAP', magnet: 'MAG', ghost: 'HIDE', clover: 'LUCK',
    heart: '♥', 'smoke-puff': '…', gem: '◆', 'gems-pile': '◆', lock: 'LOCK', crown: '♛', hatchery: 'NEST'
  };

  /* Inline glyphs: 24×24 viewBox, currentColor, thick rounded strokes that survive small sizes. */
  var S = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" ';
  var STROKE = 'fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">';
  var GLYPH = {
    close: S + STROKE + '<path d="M6 6l12 12M18 6L6 18"/></svg>',
    menu: S + STROKE + '<path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h15"/></svg>',
    check: S + STROKE + '<path d="M4.5 12.5l4.8 4.8L19.5 7"/></svg>',
    plus: S + STROKE + '<path d="M12 5v14M5 12h14"/></svg>',
    minus: S + STROKE + '<path d="M5 12h14"/></svg>',
    'arrow-right': S + STROKE + '<path d="M5 12h13M13 6l6 6-6 6"/></svg>',
    'arrow-left': S + STROKE + '<path d="M19 12H6M11 6l-6 6 6 6"/></svg>',
    'arrow-up': S + STROKE + '<path d="M12 19V6M6 11l6-6 6 6"/></svg>',
    refresh: S + STROKE + '<path d="M19 12a7 7 0 1 1-2.1-5"/><path d="M19.5 4.5v4h-4"/></svg>',
    clock: S + 'fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    info: S + 'fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.3" r=".6" fill="currentColor"/></svg>',
    play: S + 'fill="currentColor"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10-6.8c.6-.4.6-1.2 0-1.6l-10-6.8C8.9 3.9 8 4.4 8 5.2z"/></svg>',
    pause: S + 'fill="currentColor"><rect x="6" y="5" width="4.2" height="14" rx="1.4"/><rect x="13.8" y="5" width="4.2" height="14" rx="1.4"/></svg>',
    lock: S + 'fill="currentColor"><path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10H7zm2.6 0h4.8V8a2.4 2.4 0 0 0-4.8 0v2z"/></svg>',
    star: S + 'fill="currentColor"><path d="M12 2.8l2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z"/></svg>',
    home: S + 'fill="currentColor"><path d="M12 3.2l9 7.6c.5.4.2 1.2-.4 1.2H19v7.5c0 .8-.7 1.5-1.5 1.5H15v-5.5H9V21H6.5c-.8 0-1.5-.7-1.5-1.5V12H3.4c-.6 0-.9-.8-.4-1.2z"/></svg>',
    sound: S + 'fill="currentColor"><path d="M4 9.5h3.5L12 5.3c.6-.5 1.5-.1 1.5.7v12c0 .8-.9 1.2-1.5.7l-4.5-4.2H4c-.6 0-1-.4-1-1v-3c0-.6.4-1 1-1z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    mute: S + 'fill="currentColor"><path d="M4 9.5h3.5L12 5.3c.6-.5 1.5-.1 1.5.7v12c0 .8-.9 1.2-1.5.7l-4.5-4.2H4c-.6 0-1-.4-1-1v-3c0-.6.4-1 1-1z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
    music: S + 'fill="currentColor"><path d="M8.2 6.4l11.3-2.7v3.3L8.2 9.7z"/><rect x="8.2" y="6.8" width="2.2" height="10.8" rx=".4"/><rect x="17.3" y="4.4" width="2.2" height="10.8" rx=".4"/><ellipse cx="6.7" cy="17.7" rx="3.4" ry="2.5" transform="rotate(-20 6.7 17.7)"/><ellipse cx="15.8" cy="15.3" rx="3.4" ry="2.5" transform="rotate(-20 15.8 15.3)"/></svg>',
    film: S + 'fill="currentColor"><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M10 9v6l5-3z" fill="#fff"/></svg>',
    cash: S + '><circle cx="12" cy="12" r="10" fill="#3cae22" stroke="#173f08" stroke-width="2"/><circle cx="12" cy="12" r="7.2" fill="none" stroke="#9cf06b" stroke-width="1.4" opacity=".9"/><path d="M14.6 9.2c-.5-.9-1.5-1.4-2.7-1.4-1.6 0-2.7.8-2.7 2 0 2.8 5.6 1.5 5.6 4.3 0 1.2-1.2 2.1-2.9 2.1-1.3 0-2.4-.6-2.9-1.6M12 6.2v1.6M12 16.2v1.6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
    gem: S + '><path d="M7 3.5h10l4.5 5.5L12 21 2.5 9z" fill="#8a63ff" stroke="#2c1468" stroke-width="1.8" stroke-linejoin="round"/><path d="M2.8 9h18.4M7 3.5L9.5 9 12 21l2.5-12L17 3.5" fill="none" stroke="#c9b6ff" stroke-width="1.2" stroke-linejoin="round"/><path d="M7 3.5h10L14.5 9h-5z" fill="#b9a2ff"/></svg>'
  };

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function escape(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isGlyph(key) { return typeof key === 'string' && key.indexOf('svg/') === 0; }
  function baseName(key) { var s = String(key || ''); return s.slice(s.lastIndexOf('/') + 1).replace(/\.(png|jpe?g|webp)$/i, ''); }
  function fallbackText(key) {
    var b = baseName(key);
    if (hasOwn(FALLBACK, b)) return FALLBACK[b];
    if (/^egg-/.test(b)) return 'EGG';
    if (/^(baby|dragon)-/.test(b)) return '🐉';
    return '?';
  }

  function url(key) {
    if (!key || isGlyph(key)) return '';
    key = String(key);
    if (key.indexOf('render/') === 0 || key.indexOf('concept/') === 0) {
      return 'assets/ui/' + key + (/\.(png|jpe?g|webp)$/i.test(key) ? '' : '.png');
    }
    return 'assets/ui/' + (PNG.indexOf(key) >= 0 ? key : 'question') + '.png';
  }

  var state = {};      // url → 'ready' | 'missing'

  function html(key, opts) {
    opts = opts || {};
    var cls = 'ic' + (opts.cls ? ' ' + opts.cls : '');
    var a11y = opts.label ? ' role="img" aria-label="' + escape(opts.label) + '"' : ' aria-hidden="true"';
    if (isGlyph(key)) {
      var g = GLYPH[key.slice(4)] || GLYPH.info;
      return '<span class="' + cls + ' ic-svg" data-icon="' + escape(key) + '"' + a11y + '>' + g + '</span>';
    }
    var src = url(key);
    var st = state[src];
    var alt = opts.alt ? ' data-alt="' + escape(url(opts.alt)) + '"' : '';
    return '<span class="' + cls + ' ic-img' + (st === 'missing' && !opts.alt ? ' is-missing' : '') +
      '" data-icon="' + escape(key) + '" data-fb="' + escape(fallbackText(key)) + '"' + a11y + '>' +
      '<img src="' + src + '"' + alt + ' alt="" draggable="false" decoding="async"' +
      (opts.lazy ? ' loading="lazy"' : '') + '></span>';
  }

  function el(key, opts) {
    var wrap = doc.createElement('span');
    wrap.innerHTML = html(key, opts);
    return wrap.firstChild;
  }

  /* One capture listener handles every icon image: alt swap, then text fallback. */
  function onImage(ev) {
    var img = ev.target;
    if (!img || img.tagName !== 'IMG') return;
    var wrap = img.parentNode;
    if (!wrap || !wrap.classList || !wrap.classList.contains('ic')) return;
    var ok = ev.type === 'load' && img.naturalWidth > 0;
    var src = img.getAttribute('src');
    state[src] = ok ? 'ready' : 'missing';
    if (!ok) {
      var alt = img.getAttribute('data-alt');
      if (alt && alt !== src) { img.removeAttribute('data-alt'); img.setAttribute('src', alt); return; }
    }
    wrap.classList.toggle('is-missing', !ok);
  }
  if (doc) {
    doc.addEventListener('load', onImage, true);
    doc.addEventListener('error', onImage, true);
  }

  function refreshLabels(root) {
    root = root || doc;
    if (!root || !root.querySelectorAll || !SE.t) return;
    var nodes = root.querySelectorAll('[data-i18n-title]');
    for (var i = 0; i < nodes.length; i++) {
      var label = SE.t(nodes[i].getAttribute('data-i18n-title'));
      nodes[i].setAttribute('title', label);
      nodes[i].setAttribute('aria-label', label);
    }
  }

  function mount(root) {
    root = root || doc;
    if (!root || !root.querySelectorAll) return;
    var slots = root.querySelectorAll('[data-ui-icon]');
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      if (s.firstElementChild) continue;
      s.innerHTML = html(s.getAttribute('data-ui-icon'), { alt: s.getAttribute('data-ui-icon-alt') || null });
    }
    refreshLabels(root);
  }

  var pending = {};
  function loadOne(key) {
    var src = url(key);
    if (!src) return Promise.resolve();
    if (pending[src]) return pending[src];
    pending[src] = new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () {
        state[src] = 'ready';
        if (image.decode) image.decode().then(resolve, resolve); else resolve();
      };
      image.onerror = function () { state[src] = 'missing'; resolve(); };
      image.src = src;
    });
    return pending[src];
  }

  function speciesKeys(prefix, id) {
    return { key: 'render/' + prefix + '-' + id, alt: 'concept/' + prefix + '-' + id };
  }

  SE.Icons = {
    url: url,
    html: html,
    el: el,
    glyph: function (name) { return GLYPH[name] || ''; },
    has: function (key) {
      if (typeof key !== 'string') return false;
      if (isGlyph(key)) return hasOwn(GLYPH, key.slice(4));
      if (key.indexOf('render/') === 0 || key.indexOf('concept/') === 0) return true;
      return PNG.indexOf(key) >= 0;
    },
    keys: function () {
      return PNG.concat(Object.keys(GLYPH).map(function (k) { return 'svg/' + k; }));
    },
    egg: function (id) { return speciesKeys('egg', id); },
    baby: function (id) { return speciesKeys('baby', id); },
    adult: function (id) { return speciesKeys('dragon', id); },
    mount: mount,
    refreshLabels: refreshLabels,
    preload: function (keys, timeout) {
      if (typeof keys === 'number') { timeout = keys; keys = null; }
      keys = keys || PNG;
      return new Promise(function (resolve) {
        var timer = setTimeout(resolve, timeout || 2500);
        Promise.all(keys.map(loadOne)).then(function () { clearTimeout(timer); resolve(); });
      });
    }
  };
})(window);
