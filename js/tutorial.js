/* =========================================================================
   Steal a Dragon Egg — first-run tutorial (SE.Tutorial)
   SPEC §7 "SE.Tutorial" + skill «Туториал для новичков».

   Five short steps, each completed by the player's ACTION (never a timer):
     1 move    walk ~6 units (WASD / arrows or the joystick)
     2 lair    follow the arrows into the Meadow lair (guide → nearest free nest of lair 0)
     3 steal   steal an egg at a nest (E / hand button; the hand button is ringed on touch)
     4 escape  run back across the white safe line (guide → base gate; Meadow guardian ×0.6)
     5 hatch   the tutorial egg hatches in 8 s → collect the baby at the hatchery (E / hand)
     final     card "Baby dragons earn coins! …" + OK
   A later event also completes the earlier steps (e.g. 'stole' during step 1 → step 4).
   'caught' during steps 3–4 → back to step 3 with an encouraging line.
   «Пропустить» / Skip is visible on every step (mouse, touch, Tab on desktop): one press,
   no confirmation; guide, highlights and the slow factor are removed at once and the
   game is in its normal state. Completion or skip → State.data.tutorialDone = true + save.
   The tutorial never pauses the game, never shows ads (SE.Ads checks isActive()), is not a
   round, and while it is active Daily/Wheel never auto-open (SE.Daily checks isActive()).
   The coach card hides while a UI panel / the pause menu is open or the game is paused.

   API
     start(force) -> bool        starts when !tutorialDone, or always with force (replay from
                                 settings / pause «Как играть»); restarts from step 1 when active
     skip()                      ends now (tutorialDone = true, saved)
     isActive() -> bool
     step                        getter: 1..5, 6 = final card, 0 = inactive
     stepId                      getter: 'move'|'lair'|'steal'|'escape'|'hatch'|'final'|null
     notify(event, data)         from the game:
                                   'moved'       { dist }   distance walked since the last call
                                                            (optional: positions are also polled
                                                            from SE.Player.pos)
                                   'jumped'
                                   'enteredLair' { lair }   lair index (0 = Meadow)
                                   'stole'       { nest, egg }
                                   'caught'
                                   'delivered'   { egg }
                                   'placed'      { index, egg }  egg put into hatchery `index`
                                   'hatched'     { index }
                                   'collected'   { index }
     hatchOverride(egg) -> 8|null  hatch seconds for the tutorial egg (first Meadow egg placed
                                 while the tutorial runs); null = normal time.
                                 Game: SE.State.placeEgg(i, egg, SE.Tutorial.hatchOverride(egg) || undefined)
     dragonSlow                  getter: 0.6 while steps 1–4 run, else 0 (falsy = no slow).
                                 The tutorial also writes it to SE.Game.tutorialSlow (and to the
                                 `game` passed to update) whenever it changes.
     update(dt, game)            optional per-frame call; otherwise an internal rAF loop runs while
                                 active. Uses game.camera (THREE) or SE.Tutorial.projector.
     projector                   optional fn(x, y, z) -> { x, y, behind } in CSS px (labs / custom cams)
     onChange(fn)                fn(event, step): 'start' | 'step' | 'caught' | 'done' | 'skip'
   DOM: #tutLayer (inside #ui when present): coach card, highlight ring, edge arrow, target
   marker, final card. Styles: css/tutorial.css (.tut-*). Strings: tut.* (ru/en/tr).
   Body class `tut-on` while active (lets the HUD make room if it wants to).
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var doc = global.document;

  var STEPS = [
    { id: 'move',   icon: 'shoe' },
    { id: 'lair',   icon: 'map' },
    { id: 'steal',  icon: 'interact-hand' },
    { id: 'escape', icon: 'finish-flag' },
    { id: 'hatch',  icon: 'hatching-chick' }
  ];
  var MOVE_DIST = 6;
  var HATCH_SECS = 8;
  var SLOW = 0.6;
  var CAUGHT_MS = 7000;
  var GUIDE_EVERY = 0.4;

  var BASE = '';
  try {
    var src = doc.currentScript && doc.currentScript.src;
    var m = src && /^(.*\/)js\/tutorial\.js(?:[?#].*)?$/.exec(src);
    if (m) BASE = m[1];
  } catch (e) { BASE = ''; }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function perfNow() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function play(key, opts) { try { if (SE.Audio && SE.Audio.play) SE.Audio.play(key, opts || {}); } catch (e) { /* optional */ } }
  function iconUrl(name) { return BASE + 'assets/ui/' + name + '.png'; }
  function el(tag, cls, html) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  /* **bold** markup in translated strings → <b> */
  function rich(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'); }
  function kbd(k) { return '<kbd class="tut-key' + (k.length > 2 ? ' is-wide' : '') + '">' + esc(k) + '</kbd>'; }
  function icon(name, cls) { return '<img class="tut-ic ' + (cls || '') + '" alt="" draggable="false" src="' + iconUrl(name) + '">'; }
  function state() { return SE.State && SE.State.data ? SE.State.data : null; }
  function world() { return SE.World || null; }
  function gameObj() { return T.game || SE.Game || null; }
  function playerPos() {
    var g = gameObj(), p = null;
    try { p = (g && g.player && g.player.pos) || (SE.Player && SE.Player.pos) || null; } catch (e) { p = null; }
    return p && finite(p.x) && finite(p.z) ? p : null;
  }
  function lairName() {
    try { if (SE.DragonData && SE.DragonData.lairName) return SE.DragonData.lairName('meadow'); } catch (e) { /* fall through */ }
    return t('tut.meadowLair');
  }
  function uiBlocked() {
    var g = gameObj();
    if (g && g.paused) return true;
    try { if (SE.UI && typeof SE.UI.isOpen === 'function' && SE.UI.isOpen()) return true; } catch (e) { /* ignore */ }
    if (doc.body && (doc.body.classList.contains('panel-open') || doc.body.classList.contains('is-loading'))) return true;
    var pz = doc.getElementById('pause');
    if (pz && (pz.classList.contains('show') || pz.classList.contains('on') || pz.classList.contains('open'))) return true;
    if (doc.querySelector('[data-mock-ad]')) return true;
    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */
  var S = {
    active: false,
    idx: -1,              /* 0..4 steps, 5 = final card */
    moved: 0,
    lastPos: null,
    lastMoveNotify: -1e9,
    hatchIndex: -1,
    hatchReady: false,
    eggUid: null,
    caughtAt: -1e9,
    guideKey: '',
    guideT: 0,
    mode: 'kbd',
    slowSent: null,
    raf: 0,
    lastFrame: 0,
    externalUpdate: 0
  };
  var listeners = [];
  var dom = null;

  function emit(ev) {
    var list = listeners.slice();
    for (var i = 0; i < list.length; i++) { try { list[i](ev, T.step); } catch (e) { console.error(e); } }
  }

  /* ---------------------------------------------------------------------- */
  /* Input mode                                                              */
  /* ---------------------------------------------------------------------- */
  function detectMode() {
    try { if (SE.UI && typeof SE.UI.inputMode === 'function') return SE.UI.inputMode(); } catch (e) { /* ignore */ }
    var a = doc.documentElement.getAttribute('data-input');
    if (a === 'touch' || a === 'kbd') return a;
    if (SE.Input && SE.Input.mode) return SE.Input.mode;
    if (doc.body && doc.body.classList.contains('touch')) return 'touch';
    return SE.Platform && SE.Platform.isMobile ? 'touch' : 'kbd';
  }
  function setMode(mo) {
    if (mo !== 'kbd' && mo !== 'touch') return;
    if (mo === S.mode) return;
    S.mode = mo;
    if (S.active) render();
  }
  global.addEventListener('sade-input-mode', function (e) { setMode(e.detail && e.detail.mode); });
  global.addEventListener('keydown', function (e) {
    var c = e.code || '';
    if (/^(Key[WASDE]|Arrow|Space)/.test(c)) setMode('kbd');
    if (!S.active || c !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
    var tg = e.target;
    if (tg && (tg.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName))) return;
    if (uiBlocked()) return;
    e.preventDefault();
    if (S.idx >= 5) T.finish(); else T.skip();
  }, true);
  doc.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') setMode('touch');
  }, { capture: true, passive: true });
  doc.addEventListener('touchstart', function () { setMode('touch'); }, { capture: true, passive: true });

  /* ---------------------------------------------------------------------- */
  /* Guide target / slow factor                                              */
  /* ---------------------------------------------------------------------- */
  function nearestNest() {
    var W = world(), p = playerPos();
    if (!W || !Array.isArray(W.nests)) return null;
    var best = null, bd = Infinity;
    for (var i = 0; i < W.nests.length; i++) {
      var n = W.nests[i];
      if (!n || n.taken || (n.lair !== 0 && n.lair !== undefined && (n.lair && n.lair.index) !== 0)) continue;
      var d = p ? (n.x - p.x) * (n.x - p.x) + (n.z - p.z) * (n.z - p.z) : n.z;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
  function gatePoint() {
    var W = world();
    if (!W) return null;
    var x = W.spawn && finite(W.spawn.x) ? W.spawn.x : 0;
    if (finite(W.safeLineZ)) return { x: x, z: W.safeLineZ };
    return W.spawn ? { x: W.spawn.x, z: W.spawn.z } : null;
  }
  function hatcheryPoint(i) {
    var W = world();
    var h = W && W.hatcheries && W.hatcheries[i];
    if (!h) return null;
    return { x: h.x, z: h.z };
  }
  function currentTarget() {
    if (!S.active) return null;
    switch (S.idx) {
      case 1: case 2: { var n = nearestNest(); return n ? { x: n.x, z: n.z, key: 'n' + (n.index !== undefined ? n.index : n.x + ',' + n.z) } : null; }
      case 3: { var g = gatePoint(); return g ? { x: g.x, z: g.z, key: 'gate' } : null; }
      case 4: { var h = hatcheryPoint(S.hatchIndex >= 0 ? S.hatchIndex : 0); return h ? { x: h.x, z: h.z, key: 'h' + S.hatchIndex } : null; }
      default: return null;
    }
  }
  function syncGuide(force) {
    var W = world();
    var tg = currentTarget();
    var key = tg ? tg.key + '|' + Math.round(tg.x) + ',' + Math.round(tg.z) : '';
    if (!force && key === S.guideKey) return tg;
    S.guideKey = key;
    if (W && typeof W.setGuideTarget === 'function') {
      try { if (tg) W.setGuideTarget(tg.x, tg.z); else W.setGuideTarget(null); } catch (e) { console.error(e); }
    }
    return tg;
  }
  function slowValue() { return S.active && S.idx >= 0 && S.idx <= 3 ? SLOW : 0; }
  function syncSlow(g) {
    var v = slowValue();
    var targets = [SE.Game, g, T.game];
    for (var i = 0; i < targets.length; i++) {
      var o = targets[i];
      if (o && typeof o === 'object' && o.tutorialSlow !== v) { try { o.tutorialSlow = v; } catch (e) { /* frozen */ } }
    }
    S.slowSent = v;
  }

  /* ---------------------------------------------------------------------- */
  /* Steps                                                                   */
  /* ---------------------------------------------------------------------- */
  function goTo(idx) {
    if (!S.active || idx === S.idx) return;
    var prev = S.idx;
    S.idx = idx;
    if (idx === 0) { S.moved = 0; S.lastPos = null; }
    if (idx === 4) S.hatchReady = S.hatchIndex >= 0 && !!(SE.State && SE.State.isReady && safeReady(S.hatchIndex));
    syncSlow();
    syncGuide(true);
    if (prev >= 0 && idx > prev) {
      play(idx >= 5 ? 'levelup' : 'pop', { volume: 0.7 });
      if (dom) {
        dom.card.classList.remove('is-done');
        void dom.card.offsetWidth;
        dom.card.classList.add('is-done');
      }
    }
    render();
    if (idx >= 5) showFinal();
    emit('step');
  }
  function safeReady(i) { try { return !!SE.State.isReady(i); } catch (e) { return false; } }

  /* ---------------------------------------------------------------------- */
  /* DOM                                                                     */
  /* ---------------------------------------------------------------------- */
  var ARROW_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 L58 34 H42 V60 H22 V34 H6 Z" fill="#ffd34d" stroke="#2a1407" stroke-width="5" stroke-linejoin="round"/>' +
    '<path d="M32 12 L49 31" stroke="#fff6c4" stroke-width="4" stroke-linecap="round" opacity=".8"/></svg>';
  var CHEVRON_SVG = '<svg viewBox="0 0 40 30" aria-hidden="true"><path d="M4 4 L20 24 L36 4" fill="none" stroke="#2a1407" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M4 4 L20 24 L36 4" fill="none" stroke="#ffd34d" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var JOY_SVG = '<svg class="tut-joy" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="rgba(255,255,255,.35)" stroke="#2a1407" stroke-width="3"/>' +
    '<circle cx="30" cy="18" r="10" fill="#fff" stroke="#2a1407" stroke-width="3"/><path d="M24 6v5M24 37v5M6 24h5M37 24h5" stroke="#2a1407" stroke-width="3" stroke-linecap="round"/></svg>';

  function buildDom() {
    if (dom) return dom;
    var host = doc.getElementById('ui') || doc.body;
    var layer = el('div', 'tut-layer');
    layer.id = 'tutLayer';
    var card = el('div', 'tut-card');
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    card.innerHTML =
      '<div class="tut-top"><div class="tut-pips"></div><span class="tut-count"></span>' +
      '<button type="button" class="tut-skip"><span class="tut-skip-lbl"></span><kbd class="tut-key is-wide tut-skip-key">Tab</kbd></button></div>' +
      '<div class="tut-main"><div class="tut-badge"></div><div class="tut-text"><div class="tut-title"></div><div class="tut-hint"></div></div></div>' +
      '<div class="tut-bar"><i></i></div>';
    var ring = el('div', 'tut-ring', '<i class="tut-ring-c"></i><i class="tut-ring-arrow">' + CHEVRON_SVG + '</i>');
    var arrow = el('div', 'tut-edge', '<i class="tut-edge-arrow">' + ARROW_SVG + '</i><b class="tut-edge-d"></b>');
    var mark = el('div', 'tut-mark', '<b class="tut-mark-d"></b><i class="tut-mark-c">' + CHEVRON_SVG + '</i>');
    layer.appendChild(mark);
    layer.appendChild(arrow);
    layer.appendChild(ring);
    layer.appendChild(card);
    host.appendChild(layer);
    var skip = card.querySelector('.tut-skip');
    /* pointerdown: one press, works while the other finger holds the joystick */
    skip.addEventListener('pointerdown', function (e) { e.preventDefault(); e.stopPropagation(); T.skip(); });
    skip.addEventListener('click', function (e) { e.preventDefault(); T.skip(); });
    skip.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); T.skip(); } });
    dom = { layer: layer, card: card, ring: ring, arrow: arrow, mark: mark, skip: skip,
      pips: card.querySelector('.tut-pips'), count: card.querySelector('.tut-count'),
      badge: card.querySelector('.tut-badge'), title: card.querySelector('.tut-title'),
      hint: card.querySelector('.tut-hint'), bar: card.querySelector('.tut-bar'), barFill: card.querySelector('.tut-bar i'),
      skipLbl: card.querySelector('.tut-skip-lbl'), final: null, ringTarget: null };
    return dom;
  }
  function removeDom() {
    if (!dom) return;
    var d = dom;
    dom = null;
    d.ring.classList.remove('is-on');
    d.arrow.classList.remove('is-on');
    d.mark.classList.remove('is-on');
    d.layer.classList.add('is-out');
    setTimeout(function () { if (d.layer.parentNode) d.layer.parentNode.removeChild(d.layer); }, 260);
  }

  /* ---------------- content per step ---------------- */
  function stepContent() {
    var touch = S.mode === 'touch';
    var c = { title: '', hint: '', icon: STEPS[Math.min(4, Math.max(0, S.idx))].icon, ring: null, bar: null, alert: false };
    var caught = perfNow() - S.caughtAt < CAUGHT_MS;
    switch (S.idx) {
      case 0:
        c.title = t('tut.move');
        c.hint = touch ? JOY_SVG + '<span>' + rich(t('tut.moveTouch')) + '</span>'
          : '<span class="tut-keys">' + kbd('W') + kbd('A') + kbd('S') + kbd('D') + '</span><span class="tut-or">' + esc(t('tut.or')) + '</span>' +
            '<span class="tut-keys">' + kbd('←') + kbd('↑') + kbd('↓') + kbd('→') + '</span>';
        c.ring = touch ? '#joystick, [data-input="joystick"]' : null;
        c.bar = Math.min(1, S.moved / MOVE_DIST);
        break;
      case 1:
        c.title = t('tut.lair', lairName());
        c.hint = touch ? icon('jump-arrow', 'is-btn is-jump') + '<span>' + rich(t('tut.jumpTouch')) + '</span>'
          : kbd(t('tut.space')) + '<span>' + rich(t('tut.jumpKbd')) + '</span>';
        break;
      case 2:
        c.title = caught ? t('tut.caught') : t('tut.steal');
        c.alert = caught;
        c.hint = (caught ? '<span class="tut-again">' + rich(t('tut.caughtHint')) + '</span>' : '') +
          (touch ? icon('interact-hand', 'is-btn is-act') + '<span>' + rich(t('tut.stealTouch')) + '</span>'
            : kbd('E') + '<span>' + rich(t('tut.stealKbd')) + '</span>');
        c.ring = touch ? '#btnAction, [data-input="action"]' : null;
        break;
      case 3:
        c.title = t('tut.escape');
        c.hint = '<span>' + rich(t('tut.escapeHint')) + '</span>';
        c.alert = true;
        break;
      case 4: {
        var ready = S.hatchReady;
        c.title = ready ? t('tut.collect') : t('tut.hatchWait');
        if (ready) {
          c.hint = touch ? icon('interact-hand', 'is-btn is-act') + '<span>' + rich(t('tut.collectTouch')) + '</span>'
            : kbd('E') + '<span>' + rich(t('tut.collectKbd')) + '</span>';
          c.ring = touch ? '#btnAction, [data-input="action"]' : null;
          c.icon = 'render/baby-meadow';
        } else {
          var left = hatchLeft();
          c.hint = '<span>' + rich(t('tut.hatchHint')) + '</span>' + (left !== null ? '<b class="tut-time">' + Math.ceil(left) + ' ' + esc(t('tut.sec')) + '</b>' : '');
          c.bar = hatchProgress();
          c.icon = 'render/egg-meadow';
        }
        break;
      }
      default: break;
    }
    return c;
  }
  function hatchLeft() {
    if (S.hatchIndex < 0 || !SE.State || typeof SE.State.hatchRemaining !== 'function') return null;
    try { var v = SE.State.hatchRemaining(S.hatchIndex); return finite(v) ? Math.max(0, v) : null; } catch (e) { return null; }
  }
  function hatchProgress() {
    if (S.hatchIndex < 0 || !SE.State || typeof SE.State.hatchProgress !== 'function') return null;
    try { var v = SE.State.hatchProgress(S.hatchIndex); return finite(v) ? Math.max(0, Math.min(1, v)) : null; } catch (e) { return null; }
  }

  var lastHtml = '';
  function render() {
    if (!S.active) return;
    var d = buildDom();
    var final = S.idx >= 5;
    d.card.classList.toggle('is-hidden', final);
    d.layer.classList.toggle('is-touch', S.mode === 'touch');
    d.layer.classList.toggle('is-kbd', S.mode !== 'touch');
    if (final) { setRing(null); return; }
    /* pips */
    var ph = '';
    for (var i = 0; i < STEPS.length; i++) {
      ph += '<i class="tut-pip' + (i < S.idx ? ' is-done' : (i === S.idx ? ' is-cur' : '')) + '">' + (i < S.idx ? CHECK_SVG : '') + '</i>';
    }
    if (d.pips.innerHTML !== ph) d.pips.innerHTML = ph;
    d.count.textContent = (S.idx + 1) + '/' + STEPS.length;
    d.skipLbl.textContent = t('tut.skip');
    d.skip.setAttribute('aria-label', t('tut.skip'));
    var c = stepContent();
    var bh = '<img alt="" draggable="false" src="' + iconUrl(c.icon) + '">';
    if (d.badge.getAttribute('data-ic') !== c.icon) { d.badge.innerHTML = bh; d.badge.setAttribute('data-ic', c.icon); }
    var html = c.title + '|' + c.hint;
    if (html !== lastHtml) {
      lastHtml = html;
      d.title.innerHTML = rich(c.title);
      d.hint.innerHTML = c.hint;
    }
    d.card.classList.toggle('is-alert', !!c.alert);
    d.card.setAttribute('data-step', STEPS[S.idx].id);
    if (c.bar === null || c.bar === undefined) d.bar.classList.add('is-off');
    else { d.bar.classList.remove('is-off'); d.barFill.style.transform = 'scaleX(' + c.bar.toFixed(3) + ')'; }
    setRing(c.ring);
  }

  function setRing(sel) {
    if (!dom) return;
    dom.ringTarget = sel || null;
    if (!sel) dom.ring.classList.remove('is-on');
  }
  function placeRing() {
    var d = dom;
    if (!d || !d.ringTarget) return;
    var tg = doc.querySelector(d.ringTarget);
    var r = tg && tg.getBoundingClientRect ? tg.getBoundingClientRect() : null;
    if (!r || r.width < 4 || r.height < 4 || (tg.offsetParent === null && getComputedStyle(tg).position !== 'fixed')) { d.ring.classList.remove('is-on'); return; }
    var size = Math.max(r.width, r.height) + 22;
    d.ring.style.width = size + 'px';
    d.ring.style.height = size + 'px';
    d.ring.style.transform = 'translate(' + Math.round(r.left + r.width / 2 - size / 2) + 'px,' + Math.round(r.top + r.height / 2 - size / 2) + 'px)';
    d.ring.classList.add('is-on');
  }

  /* ---------------- final card ---------------- */
  function showFinal() {
    var d = buildDom();
    if (d.final) return;
    setRing(null);
    hideMarkers();
    var f = el('div', 'tut-final');
    f.innerHTML = '<div class="tut-final-card" role="dialog" aria-modal="false">' +
      '<div class="tut-final-rays"></div>' +
      '<div class="tut-final-rib"></div>' +
      '<div class="tut-final-art"><img class="tut-final-baby" alt="" draggable="false" src="' + iconUrl('render/baby-meadow') + '">' +
      '<img class="tut-final-coin c1" alt="" draggable="false" src="' + iconUrl('cash-bonus') + '">' +
      '<img class="tut-final-coin c2" alt="" draggable="false" src="' + iconUrl('shoe') + '"></div>' +
      '<div class="tut-final-text"></div>' +
      '<button type="button" class="tut-final-ok"></button></div>';
    f.querySelector('.tut-final-rib').textContent = t('tut.finalTitle');
    f.querySelector('.tut-final-text').innerHTML = rich(t('tut.final'));
    var ok = f.querySelector('.tut-final-ok');
    ok.textContent = t('tut.ok');
    ok.addEventListener('click', function (e) { e.preventDefault(); play('click'); T.finish(); });
    d.layer.appendChild(f);
    d.final = f;
    requestAnimationFrame(function () {
      f.classList.add('is-in');
      if (SE.RewardFX && SE.RewardFX.burst) {
        var r = f.querySelector('.tut-final-art').getBoundingClientRect();
        var host = f.querySelector('.tut-final-card');
        var hr = host.getBoundingClientRect();
        SE.RewardFX.burst(host, { x: r.left - hr.left + r.width / 2, y: r.top - hr.top + r.height / 2, count: 90 });
      }
    });
    setTimeout(function () { try { if (S.mode === 'kbd') ok.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 60);
  }

  /* ---------------- markers (edge arrow / on-screen distance) ---------------- */
  function hideMarkers() {
    if (!dom) return;
    dom.arrow.classList.remove('is-on');
    dom.mark.classList.remove('is-on');
    dom.card.classList.remove('is-faded');
  }
  var HUD_SEL = ['hudLeft', 'hudRight', 'hudStats', 'hudTL', 'boostList'];
  function overHud(x0, y0, x1, y1) {
    for (var i = 0; i < HUD_SEL.length; i++) {
      var e = doc.getElementById(HUD_SEL[i]);
      if (!e || !e.offsetWidth) continue;
      var kids = e.children.length ? e.children : [e];
      for (var k = 0; k < kids.length; k++) {
        var r = kids[k].getBoundingClientRect();
        if (r.width && !(r.right < x0 || r.left > x1 || r.bottom < y0 || r.top > y1)) return true;
      }
    }
    return false;
  }
  var tmpV = null;
  function project(x, y, z) {
    if (typeof T.projector === 'function') { try { return T.projector(x, y, z); } catch (e) { return null; } }
    var g = gameObj();
    var cam = (g && g.camera) || null;
    if (!cam || !global.THREE || !cam.isCamera) return null;
    if (!tmpV) tmpV = new global.THREE.Vector3();
    tmpV.set(x, y, z).project(cam);
    var W = global.innerWidth, H = global.innerHeight;
    var behind = tmpV.z > 1;
    return { x: (tmpV.x + 1) / 2 * W, y: (1 - tmpV.y) / 2 * H, behind: behind };
  }
  function placeMarkers(tg) {
    var d = dom;
    if (!d) return;
    if (!tg || S.idx === 0 || S.idx >= 5) { hideMarkers(); return; }
    var p = playerPos();
    var dist = p ? Math.sqrt((tg.x - p.x) * (tg.x - p.x) + (tg.z - p.z) * (tg.z - p.z)) : null;
    var pr = project(tg.x, 3, tg.z);
    if (!pr) { hideMarkers(); return; }
    var W = global.innerWidth, H = global.innerHeight;
    /* insets that keep markers off the HUD clusters (left/right columns, top bar, controls) */
    var portrait = H > W && W < 700;
    var mL = portrait ? W * 0.24 : Math.min(210, W * 0.2), mR = portrait ? W * 0.2 : Math.min(100, W * 0.12);
    var mT = Math.min(portrait ? 120 : 90, H * 0.19), mB = Math.min(portrait ? 260 : 160, H * 0.3);
    var cr = d.card.offsetWidth && !d.card.classList.contains('is-hidden') ? d.card.getBoundingClientRect() : null;
    function underCard(x, y, pad) { return !!cr && x > cr.left - pad && x < cr.right + pad && y > cr.top - pad && y < cr.bottom + pad; }
    var inView = !pr.behind && pr.x > 0 && pr.x < W && pr.y > 0 && pr.y < H;
    /* the target itself is under the coach card → fade the card so the beacon shows through */
    d.card.classList.toggle('is-faded', inView && underCard(pr.x, pr.y, 6));
    var onScreen = inView && pr.x > mL * 0.5 && pr.x < W - mR * 0.5 && pr.y > mT * 0.5 && pr.y < H - mB * 0.5;
    var dTxt = dist !== null ? Math.max(0, Math.round(dist)) + ' ' + t('tut.m') : '';
    if (onScreen) {
      d.arrow.classList.remove('is-on');
      /* the label sits ~55 px above the point: only where it stays clear of the HUD top band and the card */
      if ((dist !== null && dist < 7) || pr.y - 60 < mT * 0.6 || underCard(pr.x, pr.y - 30, 30) || overHud(pr.x - 40, pr.y - 70, pr.x + 40, pr.y)) {
        d.mark.classList.remove('is-on');
        return;
      }
      d.mark.style.transform = 'translate(' + Math.round(pr.x) + 'px,' + Math.round(pr.y) + 'px)';
      d.mark.querySelector('.tut-mark-d').textContent = dTxt;
      d.mark.classList.add('is-on');
      return;
    }
    d.mark.classList.remove('is-on');
    var cx = W / 2, cy = H / 2;
    var dx = pr.x - cx, dy = pr.y - cy;
    if (pr.behind) { dx = -dx; dy = -dy; if (Math.abs(dy) < 1) dy = 1; dy = Math.abs(dy); }   /* behind the camera → point down/back */
    var ang = Math.atan2(dy, dx);
    /* intersect the ray from the screen centre with the inset rectangle */
    var c = Math.cos(ang), sn = Math.sin(ang);
    var kx = c > 0 ? (W - mR - cx) / c : (c < 0 ? (mL - cx) / c : Infinity);
    var ky = sn > 0 ? (H - mB - cy) / sn : (sn < 0 ? (mT - cy) / sn : Infinity);
    var k = Math.max(0, Math.min(kx, ky));
    var ax = cx + c * k, ay = cy + sn * k;
    if (underCard(ax, ay, 40)) {                       /* never under the coach card */
      if (cr.top > H / 2) ay = cr.top - 46; else ay = cr.bottom + 46;
    }
    d.arrow.style.transform = 'translate(' + Math.round(ax) + 'px,' + Math.round(ay) + 'px)';
    d.arrow.querySelector('.tut-edge-arrow').style.transform = 'rotate(' + (ang + Math.PI / 2).toFixed(3) + 'rad)';
    d.arrow.querySelector('.tut-edge-d').textContent = dTxt;
    d.arrow.classList.add('is-on');
  }

  /* ---------------------------------------------------------------------- */
  /* Per-frame                                                               */
  /* ---------------------------------------------------------------------- */
  function frame(dt, g) {
    if (!S.active) return;
    if (g) T.game = g;
    var blocked = uiBlocked();
    if (dom) dom.layer.classList.toggle('is-blocked', blocked);
    if (S.slowSent !== slowValue() || (SE.Game && SE.Game.tutorialSlow !== slowValue())) syncSlow(g);
    /* movement polling (when the game does not send 'moved' with a distance) */
    var p = playerPos();
    if (p) {
      if (S.idx === 0 && perfNow() - S.lastMoveNotify > 800 && S.lastPos && !blocked) {
        var dx = p.x - S.lastPos.x, dz = p.z - S.lastPos.z, dd = Math.sqrt(dx * dx + dz * dz);
        if (dd < 20) addMove(dd);       /* ignore teleports */
      }
      S.lastPos = { x: p.x, z: p.z };
      /* lair entry polling */
      if (S.idx <= 1 && world() && typeof world().lairAt === 'function') {
        var lr = null;
        try { lr = world().lairAt(p.x, p.z); } catch (e) { lr = null; }
        if (lr && (lr.index === 0 || lr === 0)) T.notify('enteredLair', { lair: 0 });
      }
    }
    if (S.idx === 4 && S.hatchIndex >= 0 && !S.hatchReady && safeReady(S.hatchIndex)) { S.hatchReady = true; play('crack', { volume: 0.6 }); render(); }
    if (S.idx === 2 && S.caughtAt > 0 && perfNow() - S.caughtAt > CAUGHT_MS && dom && dom.card.classList.contains('is-alert')) render();
    S.guideT -= dt;
    var tg;
    if (S.guideT <= 0) { S.guideT = GUIDE_EVERY; tg = syncGuide(false); } else tg = currentTarget();
    if (dom) {
      if (blocked) { hideMarkers(); dom.ring.classList.remove('is-on'); }
      else { placeMarkers(tg); placeRing(); }
      if (S.idx === 4 && !S.hatchReady) render();      /* countdown */
    }
  }
  function addMove(d) {
    if (S.idx !== 0 || !(d > 0)) return;
    S.moved += d;
    if (S.moved >= MOVE_DIST) goTo(1);
    else render();
  }
  function loop() {
    S.raf = 0;
    if (!S.active) return;
    var now = perfNow();
    var dt = Math.min(0.1, Math.max(0, (now - (S.lastFrame || now)) / 1000));
    S.lastFrame = now;
    if (now - S.externalUpdate > 250) frame(dt, null);
    S.raf = requestAnimationFrame(loop);
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                              */
  /* ---------------------------------------------------------------------- */
  var T = {
    STEPS: STEPS,
    HATCH_SECS: HATCH_SECS,
    SLOW: SLOW,
    game: null,
    projector: null,

    get step() { return S.active ? S.idx + 1 : 0; },
    get stepId() { return S.active ? (S.idx >= 5 ? 'final' : STEPS[S.idx].id) : null; },
    get dragonSlow() { return slowValue(); },

    isActive: function () { return S.active; },

    start: function (force) {
      var st = state();
      if (!force && (!st || st.tutorialDone === true)) return false;
      if (S.active && dom && dom.final) { dom.final.parentNode.removeChild(dom.final); dom.final = null; }
      var wasActive = S.active;
      S.active = true;
      S.idx = -1;
      S.moved = 0; S.lastPos = null; S.lastMoveNotify = -1e9;
      S.hatchIndex = -1; S.hatchReady = false; S.eggUid = null; S.caughtAt = -1e9;
      S.guideKey = ''; S.guideT = 0;
      S.mode = detectMode();
      lastHtml = '';
      buildDom();
      dom.layer.classList.remove('is-out');
      if (doc.body) doc.body.classList.add('tut-on');
      goTo(0);
      if (!S.raf) { S.lastFrame = perfNow(); S.raf = requestAnimationFrame(loop); }
      if (!wasActive) emit('start');
      return true;
    },

    skip: function () {
      if (!S.active) return;
      play('click', { volume: 0.6 });
      end(true);
    },

    finish: function () {
      if (!S.active) return;
      end(false);
    },

    notify: function (event, data) {
      if (!S.active) return;
      data = data || {};
      switch (event) {
        case 'moved':
          if (finite(data.dist)) { S.lastMoveNotify = perfNow(); addMove(Math.min(20, Math.abs(data.dist))); }
          else if (finite(data) ) { S.lastMoveNotify = perfNow(); addMove(Math.abs(data)); }
          break;
        case 'jumped':
          if (S.idx === 0) addMove(1);
          break;
        case 'enteredLair': {
          var li = finite(data) ? data : (finite(data.lair) ? data.lair : (finite(data.index) ? data.index : 0));
          if (li === 0 && S.idx <= 1) goTo(2);
          break;
        }
        case 'stole':
          if (S.idx <= 2) { S.caughtAt = -1e9; goTo(3); }
          break;
        case 'caught':
          if (S.idx === 3 || S.idx === 2) {
            S.caughtAt = perfNow();
            play('pop', { volume: 0.5 });
            if (S.idx === 3) goTo(2); else render();
            emit('caught');
          }
          break;
        case 'delivered':
          if (S.idx <= 3) goTo(4);
          break;
        case 'placed':
          if (finite(data.index)) S.hatchIndex = data.index;
          else if (finite(data)) S.hatchIndex = data;
          if (S.idx <= 3) goTo(4);
          else if (S.idx === 4) { S.hatchReady = safeReady(S.hatchIndex); syncGuide(true); render(); }
          break;
        case 'hatched':
          if (S.idx === 4 && (S.hatchIndex < 0 || !finite(data.index) || data.index === S.hatchIndex)) {
            if (finite(data.index)) S.hatchIndex = data.index;
            if (!S.hatchReady) { S.hatchReady = true; render(); }
          }
          break;
        case 'collected':
          if (S.idx === 4 || (S.idx >= 2 && S.idx < 5)) goTo(5);
          break;
        default: break;
      }
    },

    hatchOverride: function (egg) {
      if (!S.active || S.idx >= 5) return null;
      var sp = egg && egg.species;
      if (sp !== undefined && sp !== null && sp !== 'meadow' && sp !== 0) return null;
      var uid = egg && egg.uid !== undefined ? egg.uid : '*';
      if (S.eggUid === null) { S.eggUid = uid; return HATCH_SECS; }
      return S.eggUid === uid ? HATCH_SECS : null;
    },

    update: function (dt, game) {
      if (!S.active) return;
      S.externalUpdate = perfNow();
      frame(finite(dt) ? dt : 0.016, game || null);
    },

    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    inputMode: function () { return S.mode; },
    _state: S
  };

  function end(skipped) {
    S.active = false;
    var idx = S.idx;
    S.idx = -1;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
    var W = world();
    if (W && typeof W.setGuideTarget === 'function') { try { W.setGuideTarget(null); } catch (e) { console.error(e); } }
    S.guideKey = '';
    syncSlow();
    removeDom();
    if (doc.body) doc.body.classList.remove('tut-on');
    var st = state();
    if (st) {
      st.tutorialDone = true;
      try { if (SE.State.save) SE.State.save(); } catch (e) { console.error(e); }
    }
    try { if (SE.UI && typeof SE.UI.updateHUD === 'function') SE.UI.updateHUD(); } catch (e) { /* ignore */ }
    S.lastStep = idx;
    emit(skipped ? 'skip' : 'done');
  }

  if (SE.I18N && typeof SE.I18N.onChange === 'function') {
    SE.I18N.onChange(function () { if (S.active) { lastHtml = ''; render(); if (dom && dom.final) { dom.final.querySelector('.tut-final-rib').textContent = t('tut.finalTitle'); dom.final.querySelector('.tut-final-text').innerHTML = rich(t('tut.final')); dom.final.querySelector('.tut-final-ok').textContent = t('tut.ok'); } } });
  }
  global.addEventListener('keydown', function (e) {
    if (!S.active || S.idx < 5 || !dom || !dom.final) return;
    if (e.key === 'Enter' && !uiBlocked()) { e.preventDefault(); T.finish(); }
  });

  /* ---------------------------------------------------------------------- */
  /* Strings (**bold** marks the key words)                                  */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) SE.I18N.add({
    ru: {
      'tut.skip': 'Пропустить',
      'tut.or': 'или',
      'tut.space': 'Пробел',
      'tut.sec': 'с',
      'tut.m': 'м',
      'tut.meadowLair': 'Луговое логово',
      'tut.move': 'Пройдись немного!',
      'tut.moveTouch': '**Двигай джойстик**, чтобы ходить',
      'tut.lair': 'Беги по стрелкам в **{0}**',
      'tut.jumpKbd': '— прыжок',
      'tut.jumpTouch': '— прыжок',
      'tut.steal': 'Подойди к гнезду и **укради яйцо**!',
      'tut.stealKbd': '— украсть яйцо',
      'tut.stealTouch': 'Нажми **кнопку руки** у гнезда',
      'tut.caught': 'Поймали? Не беда!',
      'tut.caughtHint': 'Укради яйцо ещё раз и **сразу беги** к базе.',
      'tut.escape': 'Дракон проснулся! **Беги на базу!**',
      'tut.escapeHint': 'Пересеки **белую линию** у ворот — там ты в безопасности',
      'tut.hatchWait': 'Яйцо в инкубаторе!',
      'tut.hatchHint': 'Малыш скоро вылупится…',
      'tut.collect': 'Малыш вылупился! **Забери его**',
      'tut.collectKbd': 'у инкубатора — забрать',
      'tut.collectTouch': 'Нажми **кнопку руки** у инкубатора',
      'tut.finalTitle': 'Отлично!',
      'tut.final': '**Малыши-драконы приносят монеты!** Тренируйся на **беговой дорожке** и открывай **новые логова**.',
      'tut.ok': 'Играть!'
    },
    en: {
      'tut.skip': 'Skip',
      'tut.or': 'or',
      'tut.space': 'Space',
      'tut.sec': 's',
      'tut.m': 'm',
      'tut.meadowLair': 'Meadow Lair',
      'tut.move': 'Take a little walk!',
      'tut.moveTouch': '**Move the joystick** to walk',
      'tut.lair': 'Follow the arrows to the **{0}**',
      'tut.jumpKbd': '— jump',
      'tut.jumpTouch': '— jump',
      'tut.steal': 'Go to a nest and **steal an egg**!',
      'tut.stealKbd': '— steal the egg',
      'tut.stealTouch': 'Tap the **hand button** at a nest',
      'tut.caught': 'Caught? No problem!',
      'tut.caughtHint': 'Steal an egg again and **run home right away**.',
      'tut.escape': 'The dragon woke up! **Run home!**',
      'tut.escapeHint': 'Cross the **white line** at the gate — you are safe there',
      'tut.hatchWait': 'Your egg is in the hatchery!',
      'tut.hatchHint': 'The baby will hatch soon…',
      'tut.collect': 'It hatched! **Collect your baby**',
      'tut.collectKbd': 'at the hatchery — collect',
      'tut.collectTouch': 'Tap the **hand button** at the hatchery',
      'tut.finalTitle': 'Well done!',
      'tut.final': '**Baby dragons earn coins!** Train on the **treadmill** and unlock **new lairs**.',
      'tut.ok': 'Play!'
    },
    tr: {
      'tut.skip': 'Geç',
      'tut.or': 'veya',
      'tut.space': 'Boşluk',
      'tut.sec': 'sn',
      'tut.m': 'm',
      'tut.meadowLair': 'Çayır İni',
      'tut.move': 'Biraz yürü!',
      'tut.moveTouch': 'Yürümek için **joystick\'i kaydır**',
      'tut.lair': 'Okları takip et: **{0}**',
      'tut.jumpKbd': '— zıpla',
      'tut.jumpTouch': '— zıpla',
      'tut.steal': 'Bir yuvaya git ve **yumurta çal**!',
      'tut.stealKbd': '— yumurtayı çal',
      'tut.stealTouch': 'Yuvada **el düğmesine** dokun',
      'tut.caught': 'Yakalandın mı? Sorun değil!',
      'tut.caughtHint': 'Yine bir yumurta çal ve **hemen üsse koş**.',
      'tut.escape': 'Ejderha uyandı! **Üsse koş!**',
      'tut.escapeHint': 'Kapıdaki **beyaz çizgiyi** geç — orada güvendesin',
      'tut.hatchWait': 'Yumurtan kuluçkada!',
      'tut.hatchHint': 'Yavru birazdan çıkacak…',
      'tut.collect': 'Yumurta çatladı! **Yavrunu al**',
      'tut.collectKbd': 'kuluçkada — al',
      'tut.collectTouch': 'Kuluçkada **el düğmesine** dokun',
      'tut.finalTitle': 'Harika!',
      'tut.final': '**Yavru ejderhalar para kazandırır!** **Koşu bandında** antrenman yap ve **yeni inlerin** kilidini aç.',
      'tut.ok': 'Oyna!'
    }
  });

  SE.Tutorial = T;
})(typeof window !== 'undefined' ? window : globalThis);
