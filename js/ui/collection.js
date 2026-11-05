/* =========================================================================
   Steal a Dragon Egg — collection panels: 'index', 'dragons', 'eggs'
   (SE.CollectionUI) + the shared panel kit used by ui/misc.js (SE.PanelKit).

   Registers three panels with SE.UI.registerPanel (SPEC §7) as soon as
   SE.UI exists (at load, else on DOMContentLoaded / load — idempotent):
     'index'    Dragon Index: 6 species × 5 variants, progress X/30, milestone
                gem rewards, detail card (description, income per variant,
                hatch time, chance, sell value).
                open('index', { species:'amber', variant:2 })  preselects an entry.
     'dragons'  Collection grouped by species+variant: team (max
                SE.State.MAX_EQUIP), equip / unequip / "Equip best", sell a group /
                sell all unequipped (confirm), doubleSell offer.
                open('dragons', { key:'meadow:1' })  preselects a group.
     'eggs'     8 hatcheries: incubating (timer + bar + instantHatch ad), ready
                (Collect → SE.Game.collectHatchery), empty, locked (price → buy
                via SE.Game.buyHatchery), x2hatch offer, Collect all.
                open('eggs', { index:3 })  highlights a hatchery.

   Calls (each feature-detected, falls back to SE.State + SE.State.save()):
     SE.Game.sellDragons(uids), SE.Game.refreshFollowers(), SE.Game.collectHatchery(i),
     SE.Game.buyHatchery(i), SE.Ads.claim(id, ctx, onDone), SE.Ads.ready(id),
     SE.Ads.cooldownLeft(id), SE.DragonModels.thumbnail(kind, id, variant, size),
     SE.UI.toast / updateHUD, SE.Audio.play.

   State: one extra top-level key (kept by SE.State.migrate as a small JSON value)
     data.colUI = { seen:{ 'meadow:0':1 … }, claimed:[5, 10 …] }
       seen     Index entries the player has looked at (NEW badges, HUD badge)
       claimed  Index milestones already paid (MILESTONES below, gems)

   Public API (SE.CollectionUI)
     register() -> bool               registers the panels (auto)
     indexBadge() -> n                unseen Index entries + claimable milestones (HUD "new" badge)
     readyCount() -> n                hatcheries with a ready baby (HUD Eggs badge)
     discovered() -> n                Index entries found (0..30)
     MILESTONES                       [{ n, gems }]

   SE.PanelKit (shared with ui/misc.js; CSS primitives .pk-* live in css/collection.css)
     root, url(path), t(), el(), text(), clear(), fmt(n), money(n), rate(n), play(key),
     save(), toast(), hud(), btn(label, cls, onClick, opts), adBtn(opts), adsEnabled(),
     art(kind, species, variant, opts), img(urls, cls), icon(name, cls), cash(n), gem(n),
     variantTag(v), rarityTag(species), confirm(host, opts) -> Promise<bool>,
     countUp(el, to, ms, fmt), loop(id, root, fn, ms), stop(id), closePanel(id),
     offerIcon(id), offerDur(id), offerDef(id), updateAdButtons(root), isCurrent(id)
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var doc = global.document;

  /* ---------------------------------------------------------------------- */
  /* Asset root: this file lives in <root>/js/ui/collection.js                */
  /* ---------------------------------------------------------------------- */
  var ROOT = (function () {
    try {
      var s = doc && doc.currentScript && doc.currentScript.src;
      if (s) return new URL('../../', s).href;
    } catch (e) { /* ignore */ }
    return '';
  })();

  /* ====================================================================== */
  /* Panel kit (SE.PanelKit)                                                 */
  /* ====================================================================== */
  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function DD() { return SE.DragonData; }
  function ST() { return SE.State; }
  function data() { return SE.State && SE.State.data; }
  function url(path) { return ROOT + 'assets/ui/' + path; }

  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }
  function text(tag, cls, str) {
    var e = el(tag, cls);
    e.textContent = str === undefined || str === null ? '' : String(str);
    return e;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  /* 950 → "950", 7.5 → "7.5", 15000 → "15K", 1234567 → "1.23M" */
  var UNITS = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
  function fmt(n) {
    n = Number(n) || 0;
    var neg = n < 0;
    n = Math.abs(n);
    var s;
    if (n < 1000) {
      s = n < 10 && n % 1 ? String(Math.floor(n * 10) / 10) : String(Math.floor(n));
    } else {
      var i = -1;
      while (n >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
      var v = n >= 100 ? Math.floor(n) : n >= 10 ? Math.floor(n * 10) / 10 : Math.floor(n * 100) / 100;
      s = String(v) + UNITS[i];
    }
    return (neg ? '-' : '') + s;
  }
  function money(n) { return '$' + fmt(n); }
  function rate(n) { return '+' + fmt(n) + t('time.perSec'); }

  function play(key, opts) {
    try { if (SE.Audio && typeof SE.Audio.play === 'function') SE.Audio.play(key, opts); } catch (e) { /* ignore */ }
  }
  function save() {
    try { if (SE.State && typeof SE.State.save === 'function') SE.State.save(); } catch (e) { /* ignore */ }
  }
  function toast(str, type) {
    try { if (SE.UI && typeof SE.UI.toast === 'function') SE.UI.toast(str, type || 'info'); } catch (e) { /* ignore */ }
  }
  function hud() {
    try { if (SE.UI && typeof SE.UI.updateHUD === 'function') SE.UI.updateHUD(); } catch (e) { /* ignore */ }
  }
  function gameFn(name) { return SE.Game && typeof SE.Game[name] === 'function' ? SE.Game[name].bind(SE.Game) : null; }

  /* ---------------- images ---------------- */
  var MISSING = {};
  function img(urls, cls, alt) {
    var list = urls.filter(function (u) { return !MISSING[u]; });
    if (!list.length) list = urls.slice(-1);
    var im = el('img', cls);
    im.alt = alt || '';
    im.draggable = false;
    im.decoding = 'async';
    var i = 0;
    im.onerror = function () {
      MISSING[list[i]] = true;
      i++;
      if (i < list.length) im.src = list[i];
      else { im.onerror = null; im.classList.add('is-missing'); }
    };
    im.src = list[0];
    return im;
  }
  function icon(name, cls) { return img([url(name + '.png')], 'pk-ic ' + (cls || '')); }

  var ART = {
    baby: function (sp) { return [url('render/baby-' + sp + '.png'), url('concept/baby-' + sp + '.png')]; },
    egg: function (sp) { return [url('render/egg-' + sp + '.png'), url('concept/egg-' + sp + '.png')]; },
    adult: function (sp) { return [url('render/dragon-' + sp + '.png'), url('concept/dragon-' + sp + '.png')]; },
    concept: function (sp) { return [url('concept/dragon-' + sp + '.png'), url('render/dragon-' + sp + '.png')]; }
  };

  /* Model thumbnails (SE.DragonModels) replace the static art when available. */
  var THUMBS = {};
  function modelThumb(kind, sp, v, size) {
    var DM = SE.DragonModels;
    if (!DM || typeof DM.thumbnail !== 'function') return null;
    var key = kind === 'egg' ? 'egg.' + sp : 'dragon.' + sp + '.' + (kind === 'adult' ? 'adult' : 'baby');
    if (SE.Assets && typeof SE.Assets.has === 'function' && !SE.Assets.has(key)) return null;
    var k = kind + ':' + sp + ':' + v + ':' + size;
    if (!THUMBS[k]) {
      try {
        THUMBS[k] = Promise.resolve(DM.thumbnail(kind, sp, v, size)).then(function (u) {
          return typeof u === 'string' && u ? u : null;
        }, function () { return null; });
      } catch (e) { THUMBS[k] = Promise.resolve(null); }
    }
    return THUMBS[k];
  }

  /* kind: 'baby' | 'egg' | 'adult' | 'concept'; opts: { size, silhouette, cls, noModel } */
  function art(kind, sp, v, opts) {
    opts = opts || {};
    v = v | 0;
    var wrap = el('span', 'pk-art pk-art-' + kind + ' pk-v' + v + (opts.silhouette ? ' pk-sil' : '') + (opts.cls ? ' ' + opts.cls : ''));
    var list = (ART[kind] || ART.baby)(sp);
    var im = img(list, 'pk-img' + (v > 0 && !opts.silhouette ? ' pk-tint' : ''), '');
    wrap.appendChild(im);
    if (!opts.silhouette && !opts.noModel && (kind === 'baby' || kind === 'egg' || kind === 'adult')) {
      var p = modelThumb(kind, sp, v, opts.size || 128);
      if (p) {
        p.then(function (u) {
          if (!u) return;
          im.onerror = null;
          im.src = u;
          im.classList.remove('pk-tint', 'is-missing');
          wrap.classList.add('is-model');
        });
      }
    }
    return wrap;
  }

  /* ---------------- chips & tags ---------------- */
  function cash(n, cls) {
    var c = el('span', 'pk-chip pk-cash' + (cls ? ' ' + cls : ''));
    c.appendChild(text('b', 'pk-cur', '$'));
    c.appendChild(text('span', 'pk-num', fmt(n)));
    return c;
  }
  function gem(n, cls) {
    var c = el('span', 'pk-chip pk-gem' + (cls ? ' ' + cls : ''));
    c.appendChild(img([url('render/gem.png')], 'pk-gem-ic'));
    c.appendChild(text('span', 'pk-num', fmt(n)));
    return c;
  }
  function variantTag(v, cls) {
    var D = DD();
    var def = D && D.variant(v);
    var tag = text('span', 'pk-tag pk-tag-v' + (v | 0) + (cls ? ' ' + cls : ''), D ? D.variantName(v) : '');
    if (def) tag.style.setProperty('--vc', def.color);
    return tag;
  }
  function rarityTag(sp, cls) {
    var D = DD();
    var r = D && D.rarity(sp);
    var tag = text('span', 'pk-rar' + (cls ? ' ' + cls : ''), D ? D.rarityName(sp) : '');
    if (r) { tag.style.setProperty('--rc', r.color); tag.classList.add('pk-rar-' + r.id); }
    return tag;
  }
  function bar(frac, cls) {
    var b = el('span', 'pk-bar' + (cls ? ' ' + cls : ''));
    var f = el('span', 'pk-bar-fill');
    f.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 1000) / 10 + '%';
    b.appendChild(f);
    return b;
  }

  /* ---------------- buttons ---------------- */
  /* opts: { icon, sub, sound:false, title, html } — label may be '' (icon only) */
  function btn(label, cls, onClick, opts) {
    opts = opts || {};
    var b = el('button', 'pk-btn ' + (cls || ''));
    b.type = 'button';
    if (opts.icon) b.appendChild(typeof opts.icon === 'string' ? icon(opts.icon, 'pk-btn-ic') : opts.icon);
    var box = el('span', 'pk-btn-text');
    var l = text('span', 'pk-btn-label', label);
    box.appendChild(l);
    var sub = text('span', 'pk-btn-sub', opts.sub || '');
    if (!opts.sub) sub.hidden = true;
    box.appendChild(sub);
    b.appendChild(box);
    if (opts.title) b.title = opts.title;
    b.setLabel = function (s) { l.textContent = s; };
    b.setSub = function (s) { sub.textContent = s || ''; sub.hidden = !s; };
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (b.disabled || b.classList.contains('is-busy')) return;
      if (opts.sound !== false) play('click');
      if (onClick) onClick(e, b);
    });
    return b;
  }

  function adsEnabled() {
    if (SE.Config && SE.Config.ADS === false) return false;
    return !!(SE.Ads && typeof SE.Ads.claim === 'function');
  }
  function adReady(id) {
    try {
      if (SE.Ads && typeof SE.Ads.ready === 'function') return !!SE.Ads.ready(id);
      return !!(SE.Platform && SE.Platform.canRewarded && SE.Platform.canRewarded());
    } catch (e) { return false; }
  }
  function adCooldown(id) {
    try { return SE.Ads && typeof SE.Ads.cooldownLeft === 'function' ? Math.max(0, SE.Ads.cooldownLeft(id) || 0) : 0; } catch (e) { return 0; }
  }

  var DEFAULT_OFFERS = {
    x2income: { icon: 'money-bag', dur: 180 },
    x2hatch: { icon: 'fast-hatch', dur: 300 },
    instantHatch: { icon: 'hatching-chick' },
    speedBoost: { icon: 'lightning', dur: 60 },
    luckyEgg: { icon: 'clover', dur: 180 },
    revive: { icon: 'heart' },
    dragonSleep: { icon: 'moon', dur: 45 },
    magnet: { icon: 'magnet', dur: 60 },
    cashBonus: { icon: 'cash-bonus' },
    freeHatchery: { icon: 'pen-house' },
    offlineX2: { icon: 'banknotes' },
    doubleSell: { icon: 'banknotes' },
    speedUp: { icon: 'shoe' },
    upgradeEgg: { icon: 'sparkles' },
    lairDiscount: { icon: 'map' }
  };
  function offerDef(id) {
    var o = null;
    try { if (SE.Ads && Array.isArray(SE.Ads.OFFERS)) o = SE.Ads.OFFERS.filter(function (x) { return x && x.id === id; })[0] || null; } catch (e) { o = null; }
    return o;
  }
  function offerIcon(id) {
    var d = DEFAULT_OFFERS[id];
    if (d) return d.icon;
    var o = offerDef(id);
    return o && typeof o.icon === 'string' && /^(render\/)?[a-z0-9-]+$/.test(o.icon) ? o.icon : 'watch-video';
  }
  function offerDur(id) {
    var o = offerDef(id);
    if (o && o.dur > 0) return o.dur;
    var d = DEFAULT_OFFERS[id];
    return d && d.dur ? d.dur : 0;
  }

  /* Rewarded button. opts: { placement, label, sub, ctx, onGranted(), onDone(granted), cls, big }
     Returns null when ads are switched off for this build (SE.Config.ADS === false) or SE.Ads is missing. */
  function adBtn(o) {
    if (!adsEnabled() || !o || !o.placement) return null;
    var b = btn(o.label || t('btn.watchAd'), 'pk-rw ' + (o.cls || ''), function () {
      if (!adReady(o.placement)) { play('error'); toast(t('msg.adUnavailable'), 'error'); update(); return; }
      b.classList.add('is-busy');
      var done = false;
      try {
        SE.Ads.claim(o.placement, o.ctx || {}, function (granted) {
          if (done) return;
          done = true;
          b.classList.remove('is-busy');
          if (granted && o.onGranted) o.onGranted();
          if (o.onDone) o.onDone(!!granted);
          update();
        });
      } catch (e) {
        b.classList.remove('is-busy');
        if (global.console) console.error(e);
      }
    }, { icon: 'watch-video', sub: o.sub || t('btn.watchAd') });
    b.dataset.placement = o.placement;
    var baseSub = o.sub || t('btn.watchAd');
    function update() {
      if (b.classList.contains('is-busy')) return;
      var ready = adReady(o.placement);
      b.disabled = !ready;
      var cd = ready ? 0 : adCooldown(o.placement);
      b.setSub(ready ? baseSub : cd > 0 ? t('offer.cooldown', clock(cd)) : t('offer.unavailable'));
    }
    b._update = update;
    update();
    return b;
  }
  function updateAdButtons(root) {
    if (!root) return;
    var list = root.querySelectorAll('.pk-rw');
    for (var i = 0; i < list.length; i++) if (list[i]._update) list[i]._update();
  }

  function clock(sec) { return SE.I18N && SE.I18N.clock ? SE.I18N.clock(sec) : String(Math.ceil(sec)); }
  function duration(sec, opts) { return SE.I18N && SE.I18N.duration ? SE.I18N.duration(sec, opts) : Math.ceil(sec) + 's'; }

  /* ---------------- in-panel confirm ---------------- */
  /* opts: { title, text, ok, cancel, danger, icon, art (element), delay (ms before OK enables) } */
  function confirmBox(host, o) {
    o = o || {};
    return new Promise(function (resolve) {
      var prev = host.querySelector(':scope > .pk-confirm');
      if (prev) prev.remove();
      var wrap = el('div', 'pk-confirm');
      var card = el('div', 'pk-confirm-card' + (o.danger ? ' is-danger' : ''));
      if (o.art) card.appendChild(o.art);
      else if (o.icon) card.appendChild(icon(o.icon, 'pk-confirm-ic'));
      if (o.title) card.appendChild(text('div', 'pk-confirm-title', o.title));
      if (o.text) card.appendChild(text('div', 'pk-confirm-text', o.text));
      var row = el('div', 'pk-confirm-row');
      var finished = false;
      function done(v) {
        if (finished) return;
        finished = true;
        wrap.classList.add('is-out');
        setTimeout(function () { wrap.remove(); }, 160);
        resolve(v);
      }
      var cancel = btn(o.cancel || t('btn.cancel'), 'pk-ghost', function () { done(false); });
      var ok = btn(o.ok || t('btn.ok'), o.danger ? 'pk-red' : 'pk-green', function () { done(true); });
      row.appendChild(cancel);
      row.appendChild(ok);
      card.appendChild(row);
      wrap.appendChild(card);
      wrap.addEventListener('click', function (e) { if (e.target === wrap) done(false); });
      host.appendChild(wrap);
      if (o.delay > 0) {
        ok.disabled = true;
        var left = Math.ceil(o.delay / 1000);
        var base = o.ok || t('btn.ok');
        ok.setLabel(base + ' (' + left + ')');
        var timer = setInterval(function () {
          left--;
          if (left <= 0 || finished) { clearInterval(timer); ok.disabled = false; ok.setLabel(base); }
          else ok.setLabel(base + ' (' + left + ')');
        }, 1000);
      }
      setTimeout(function () { try { cancel.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 0);
    });
  }

  /* ---------------- count-up ---------------- */
  function countUp(node, to, ms, format, onDone) {
    format = format || fmt;
    var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !(to > 0) || !global.requestAnimationFrame) { node.textContent = format(to); if (onDone) onDone(); return; }
    var t0 = 0;
    function step(ts) {
      if (!t0) t0 = ts;
      var k = Math.min(1, (ts - t0) / ms);
      var e = 1 - Math.pow(1 - k, 3);
      node.textContent = format(k >= 1 ? to : to * e);
      if (k < 1 && node.isConnected) global.requestAnimationFrame(step);
      else if (onDone) onDone();
    }
    node.textContent = format(0);
    global.requestAnimationFrame(step);
  }

  /* ---------------- live loops (stop when the panel closes) ---------------- */
  var LOOPS = {};
  function isCurrent(id) {
    var U = SE.UI;
    if (!U) return true;
    var cur = U.current;
    if (cur === undefined) return true;
    if (cur === null || cur === false) return false;
    if (typeof cur === 'string') return cur === id;
    if (typeof cur === 'object') return cur.id === undefined || cur.id === id;
    return true;
  }
  function stop(id) {
    if (LOOPS[id]) { clearInterval(LOOPS[id]); delete LOOPS[id]; }
  }
  function loop(id, root, fn, ms) {
    stop(id);
    LOOPS[id] = setInterval(function () {
      if (!root.isConnected || !isCurrent(id)) { stop(id); return; }
      if (doc.hidden) return;
      try { fn(); } catch (e) { stop(id); if (global.console) console.error(e); }
    }, ms || 250);
  }
  function closePanel(id) {
    stop(id);
    try { if (SE.UI && typeof SE.UI.close === 'function') SE.UI.close(); } catch (e) { /* ignore */ }
  }
  function newRoot(body, cls) {
    clear(body);
    var root = el('div', 'pk-root ' + cls);
    body.appendChild(root);
    return root;
  }
  /* "+$450" flying label near an element (feedback for sells / collects) */
  function floatText(host, anchor, str, cls) {
    if (!host || !anchor) return;
    var hr = host.getBoundingClientRect(), ar = anchor.getBoundingClientRect();
    var f = text('div', 'pk-float ' + (cls || ''), str);
    f.style.left = Math.round(ar.left - hr.left + ar.width / 2) + 'px';
    f.style.top = Math.round(ar.top - hr.top) + 'px';
    host.appendChild(f);
    setTimeout(function () { f.remove(); }, 1300);
  }

  var Kit = {
    root: ROOT,
    url: url, t: t, el: el, text: text, clear: clear, fmt: fmt, money: money, rate: rate,
    clock: clock, duration: duration, play: play, save: save, toast: toast, hud: hud, gameFn: gameFn,
    img: img, icon: icon, art: art, cash: cash, gem: gem, variantTag: variantTag, rarityTag: rarityTag,
    bar: bar, btn: btn, adBtn: adBtn, adsEnabled: adsEnabled, adReady: adReady, adCooldown: adCooldown,
    updateAdButtons: updateAdButtons, offerDef: offerDef, offerIcon: offerIcon, offerDur: offerDur,
    confirm: confirmBox, countUp: countUp, loop: loop, stop: stop, isCurrent: isCurrent,
    closePanel: closePanel, newRoot: newRoot, floatText: floatText
  };
  SE.PanelKit = Kit;

  /* ====================================================================== */
  /* Collection helpers                                                      */
  /* ====================================================================== */
  var MILESTONES = [
    { n: 5, gems: 25 }, { n: 10, gems: 50 }, { n: 15, gems: 75 },
    { n: 20, gems: 100 }, { n: 25, gems: 150 }, { n: 30, gems: 300 }
  ];

  function colState() {
    var d = data();
    if (!d) return null;
    var c = d.colUI;
    if (!c || typeof c !== 'object' || Array.isArray(c)) c = d.colUI = {};
    if (!c.seen || typeof c.seen !== 'object' || Array.isArray(c.seen)) c.seen = {};
    if (!Array.isArray(c.claimed)) c.claimed = [];
    return c;
  }
  function indexCount(key) {
    var d = data();
    return d && d.index && d.index[key] > 0 ? d.index[key] : 0;
  }
  function discovered() {
    var D = DD();
    if (!D || !data()) return 0;
    return D.allIndexKeys().filter(function (k) { return indexCount(k) > 0; }).length;
  }
  function claimable() {
    var c = colState();
    if (!c) return [];
    var n = discovered();
    return MILESTONES.filter(function (m) { return n >= m.n && c.claimed.indexOf(m.n) < 0; });
  }
  function unseen() {
    var c = colState(), D = DD();
    if (!c || !D) return [];
    return D.allIndexKeys().filter(function (k) { return indexCount(k) > 0 && !c.seen[k]; });
  }
  function readyCount() {
    var d = data();
    if (!d) return 0;
    return d.hatcheries.filter(function (h) { return h && h.baby; }).length;
  }
  function refreshFollowers() {
    var f = gameFn('refreshFollowers');
    if (f) { try { f(); } catch (e) { if (global.console) console.error(e); } }
  }

  /* ====================================================================== */
  /* 'index' — Dragon Index                                                  */
  /* ====================================================================== */
  var ixSel = null;   /* { species, variant } kept between openings */

  function renderIndex(body, opts) {
    stop('index');
    var D = DD(), d = data();
    var root = newRoot(body, 'col-ix');
    if (!D || !d) { root.appendChild(text('div', 'pk-empty', t('col.noData'))); return; }
    var cs = colState();
    var fresh = unseen();
    var newMap = {};
    fresh.forEach(function (k) { newMap[k] = true; });

    if (opts && D.species(opts.species)) ixSel = { species: D.species(opts.species).id, variant: D.variant(opts.variant) ? opts.variant | 0 : 0 };
    if (!ixSel) {
      var first = fresh[0] || D.allIndexKeys().filter(function (k) { return indexCount(k) > 0; })[0] || 'meadow:0';
      ixSel = D.parseIndexKey(first);
    }

    /* ---- header: progress + milestones ---- */
    var head = el('div', 'col-ix-head');
    var n = discovered(), total = D.SPECIES.length * D.VARIANTS.length;
    var prog = el('div', 'col-ix-prog');
    prog.appendChild(text('span', 'col-ix-prog-label', t('col.index.found')));
    var big = el('span', 'col-ix-prog-num');
    big.appendChild(text('b', '', String(n)));
    big.appendChild(text('span', '', '/' + total));
    prog.appendChild(big);
    head.appendChild(prog);

    var track = el('div', 'col-ix-track');
    var tbar = bar(n / total, 'col-ix-bar');
    track.appendChild(tbar);
    MILESTONES.forEach(function (m) {
      var done = cs.claimed.indexOf(m.n) >= 0, ready = n >= m.n && !done;
      var mk = el('span', 'col-ix-mile' + (done ? ' is-done' : '') + (ready ? ' is-ready' : ''));
      mk.style.left = (m.n / total * 100) + '%';
      mk.appendChild(img([url('render/gem.png')], 'col-ix-mile-gem'));
      mk.appendChild(text('span', 'col-ix-mile-n', String(m.n)));
      mk.title = t('col.index.mileHint', m.n, m.gems);
      track.appendChild(mk);
    });
    head.appendChild(track);

    var rew = el('div', 'col-ix-reward');
    var can = claimable();
    if (can.length) {
      var sum = can.reduce(function (s, m) { return s + m.gems; }, 0);
      var claimBtn = btn(t('btn.claim'), 'pk-green pk-pulse', function () {
        var c = colState(), got = 0;
        claimable().forEach(function (m) { c.claimed.push(m.n); got += m.gems; });
        if (got > 0) { ST().addGems(got); play('reward'); toast(t('col.index.rewardGot', got), 'good'); save(); hud(); }
        renderIndex(body);
      }, { icon: gem(sum, 'pk-chip-in') });
      rew.appendChild(claimBtn);
    } else {
      var next = MILESTONES.filter(function (m) { return n < m.n; })[0];
      if (next) {
        rew.appendChild(text('span', 'col-ix-reward-text', t('col.index.nextReward', next.n - n)));
        rew.appendChild(gem(next.gems));
      } else {
        rew.appendChild(text('span', 'col-ix-reward-text is-complete', t('col.index.complete')));
      }
    }
    head.appendChild(rew);
    root.appendChild(head);

    /* ---- main: list + detail ---- */
    var main = el('div', 'col-ix-main');
    var list = el('div', 'col-ix-list pk-scroll');
    var detail = el('div', 'col-ix-detail');
    main.appendChild(list);
    main.appendChild(detail);
    root.appendChild(main);

    var tiles = {};
    D.SPECIES.forEach(function (sp) {
      var row = el('div', 'col-ix-row');
      row.style.setProperty('--sc', sp.color);
      row.style.setProperty('--sc2', sp.color2);
      row.style.setProperty('--rc', D.rarityColor(sp.id));
      var card = el('div', 'col-ix-sp');
      var lairOpen = ST().lairUnlocked(sp.idx);
      card.appendChild(art('concept', sp.id, 0, { cls: 'col-ix-sp-art', noModel: true }));
      var info = el('div', 'col-ix-sp-info');
      info.appendChild(text('div', 'col-ix-sp-name', D.name(sp.id)));
      info.appendChild(rarityTag(sp.id));
      var lair = el('div', 'col-ix-sp-lair' + (lairOpen ? '' : ' is-locked'));
      if (!lairOpen) lair.appendChild(img([url('render/lock.png')], 'col-ix-lock'));
      lair.appendChild(text('span', '', D.lairName(sp.id)));
      info.appendChild(lair);
      var have = 0;
      for (var vv = 0; vv < D.VARIANTS.length; vv++) if (indexCount(D.indexKey(sp.id, vv)) > 0) have++;
      info.appendChild(text('div', 'col-ix-sp-count' + (have === D.VARIANTS.length ? ' is-full' : ''), have + '/' + D.VARIANTS.length));
      card.appendChild(info);
      row.appendChild(card);

      var vars = el('div', 'col-ix-vars');
      D.VARIANTS.forEach(function (vd) {
        var key = D.indexKey(sp.id, vd.idx);
        var cnt = indexCount(key);
        var tile = el('button', 'col-ix-tile pk-v' + vd.idx + (cnt ? ' is-found' : ' is-unknown') + (newMap[key] ? ' is-new' : ''));
        tile.type = 'button';
        tile.style.setProperty('--vc', vd.color);
        tile.title = D.fullName(sp.id, vd.idx);
        tile.appendChild(art('baby', sp.id, vd.idx, { silhouette: !cnt, size: 128 }));
        if (cnt) tile.appendChild(text('span', 'col-ix-tile-count', '×' + fmt(cnt)));
        else tile.appendChild(text('span', 'col-ix-tile-q', '?'));
        if (newMap[key]) tile.appendChild(text('span', 'col-ix-new', t('col.new')));
        tile.appendChild(text('span', 'col-ix-tile-name', D.variantName(vd.idx)));
        tile.addEventListener('click', function () {
          play('tab');
          ixSel = { species: sp.id, variant: vd.idx };
          select(true);
        });
        tiles[key] = tile;
        vars.appendChild(tile);
      });
      row.appendChild(vars);
      list.appendChild(row);
    });

    function select(user) {
      Object.keys(tiles).forEach(function (k) { tiles[k].classList.toggle('is-sel', k === D.indexKey(ixSel.species, ixSel.variant)); });
      renderIndexDetail(detail, ixSel, root);
      if (user) root.classList.add('has-detail');
    }
    select(false);
    var selTile = tiles[D.indexKey(ixSel.species, ixSel.variant)];
    if (selTile && opts && opts.species) {
      root.classList.add('has-detail');
      setTimeout(function () { try { selTile.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }, 0);
    }

    /* everything discovered so far is now seen */
    fresh.forEach(function (k) { cs.seen[k] = 1; });
    if (fresh.length) { save(); hud(); }
  }

  function renderIndexDetail(box, sel, root) {
    var D = DD();
    clear(box);
    var sp = D.species(sel.species), v = sel.variant;
    var key = D.indexKey(sp.id, v), cnt = indexCount(key), found = cnt > 0;
    box.style.setProperty('--sc', sp.color);
    box.style.setProperty('--rc', D.rarityColor(sp.id));
    var vdef = D.variant(v);
    box.style.setProperty('--vc', vdef.color);

    var back = btn(t('btn.back'), 'pk-ghost pk-small col-ix-back', function () { root.classList.remove('has-detail'); });
    box.appendChild(back);

    var stage = el('div', 'col-ix-stage pk-v' + v + (found ? '' : ' is-unknown'));
    stage.appendChild(el('span', 'pk-rays'));
    stage.appendChild(art('baby', sp.id, v, { silhouette: !found, size: 256, cls: 'col-ix-stage-art' }));
    if (!found) stage.appendChild(text('span', 'col-ix-stage-q', '?'));
    box.appendChild(stage);

    var title = el('div', 'col-ix-d-title');
    title.appendChild(text('div', 'col-ix-d-name', D.fullName(sp.id, v)));
    var tags = el('div', 'col-ix-d-tags');
    tags.appendChild(rarityTag(sp.id));
    tags.appendChild(variantTag(v));
    tags.appendChild(text('span', 'pk-tag pk-tag-own' + (found ? '' : ' is-none'), found ? t('col.index.owned', fmt(cnt)) : t('col.index.notFound')));
    title.appendChild(tags);
    box.appendChild(title);

    box.appendChild(text('p', 'col-ix-d-desc', D.desc(sp.id)));

    var stats = el('div', 'col-ix-d-stats');
    function stat(label, value, cls) {
      var s = el('div', 'col-ix-d-stat ' + (cls || ''));
      s.appendChild(text('span', 'col-ix-d-stat-l', label));
      if (typeof value === 'string') s.appendChild(text('b', 'col-ix-d-stat-v', value));
      else s.appendChild(value);
      stats.appendChild(s);
    }
    stat(t('col.income'), rate(D.income(sp.id, v)), 'is-income');
    stat(t('col.hatchTime'), duration(D.hatchTime({ species: sp.id, variant: v })), 'is-time');
    stat(t('col.chance'), (vdef.chance < 1 ? vdef.chance.toFixed(1) : String(vdef.chance)) + '%', 'is-chance');
    stat(t('col.value'), cash(D.value(sp.id, v)), 'is-value');
    box.appendChild(stats);

    /* income per variant */
    var tbl = el('div', 'col-ix-d-vars');
    tbl.appendChild(text('div', 'col-ix-d-vars-title', t('col.index.perVariant')));
    D.VARIANTS.forEach(function (vd) {
      var k = D.indexKey(sp.id, vd.idx), has = indexCount(k) > 0;
      var r = el('button', 'col-ix-d-var' + (vd.idx === v ? ' is-sel' : '') + (has ? '' : ' is-unknown'));
      r.type = 'button';
      r.style.setProperty('--vc', vd.color);
      r.appendChild(el('span', 'col-ix-d-dot pk-v' + vd.idx));
      r.appendChild(text('span', 'col-ix-d-var-name', D.variantName(vd.idx)));
      r.appendChild(text('span', 'col-ix-d-var-mult', '×' + vd.mult));
      r.appendChild(text('span', 'col-ix-d-var-inc', rate(D.income(sp.id, vd.idx))));
      r.appendChild(text('span', 'col-ix-d-var-time', duration(D.hatchTime({ species: sp.id, variant: vd.idx }), { short: false })));
      r.addEventListener('click', function () {
        play('tab');
        ixSel = { species: sp.id, variant: vd.idx };
        var tile = root.querySelectorAll('.col-ix-tile');
        for (var i = 0; i < tile.length; i++) tile[i].classList.remove('is-sel');
        var all = root.querySelectorAll('.col-ix-row')[sp.idx];
        if (all) { var tt = all.querySelectorAll('.col-ix-tile')[vd.idx]; if (tt) tt.classList.add('is-sel'); }
        renderIndexDetail(box, ixSel, root);
      });
      tbl.appendChild(r);
    });
    box.appendChild(tbl);

    /* lair & guardian */
    var lair = el('div', 'col-ix-d-lair');
    lair.appendChild(art('concept', sp.id, 0, { cls: 'col-ix-d-lair-art', noModel: true }));
    var li = el('div', 'col-ix-d-lair-info');
    li.appendChild(text('div', 'col-ix-d-lair-name', D.lairName(sp.id)));
    var ab = sp.abilities.map(function (a) { return D.abilityName(a); }).join(' · ');
    li.appendChild(text('div', 'col-ix-d-lair-sub', ab ? t('col.index.abilities', ab) : t('col.index.noAbility')));
    if (!ST().lairUnlocked(sp.idx)) li.appendChild(text('div', 'col-ix-d-lair-lock', t('col.index.lairLocked', money(ST().lairPrice(sp.idx)))));
    lair.appendChild(li);
    box.appendChild(lair);
  }

  /* ====================================================================== */
  /* 'dragons' — collection                                                  */
  /* ====================================================================== */
  var drSel = null;   /* selected group key */

  function groups() {
    var D = DD(), d = data(), map = {}, list = [];
    d.dragons.forEach(function (dr) {
      var k = D.indexKey(dr.species, dr.variant);
      var g = map[k];
      if (!g) {
        g = map[k] = {
          key: k, species: dr.species, variant: dr.variant, uids: [], equipped: [], free: [],
          income: D.income(dr.species, dr.variant), value: D.value(dr.species, dr.variant),
          tier: D.speciesIndex(dr.species)
        };
        list.push(g);
      }
      g.uids.push(dr.uid);
      if (ST().isEquipped(dr.uid)) g.equipped.push(dr.uid); else g.free.push(dr.uid);
    });
    list.sort(function (a, b) { return b.income - a.income || b.tier - a.tier || b.variant - a.variant; });
    return list;
  }
  function sellMult() { return SE.Boosts && SE.Boosts.isActive && SE.Boosts.isActive('doubleSell') ? 2 : 1; }

  function sellUids(uids) {
    if (!uids.length) return 0;
    var before = data().money;
    var f = gameFn('sellDragons');
    if (f) {
      try { f(uids); } catch (e) { if (global.console) console.error(e); }
    } else {
      var r = ST().sellDragons(uids, sellMult());
      if (r.count) { play('sell'); toast(t('msg.sold', r.count, money(r.total)), 'good'); }
      save();
    }
    refreshFollowers();
    hud();
    return Math.max(0, data().money - before);
  }

  function teamChanged() {
    refreshFollowers();
    save();
    hud();
  }

  function renderDragons(body, opts) {
    stop('dragons');
    var D = DD(), d = data();
    var root = newRoot(body, 'col-dr');
    if (!D || !d) { root.appendChild(text('div', 'pk-empty', t('col.noData'))); return; }
    if (opts && typeof opts.key === 'string') drSel = opts.key;
    var gs = groups();
    var MAXE = ST().MAX_EQUIP || 6;
    var mult = sellMult();
    if (drSel && !gs.some(function (g) { return g.key === drSel; })) drSel = null;
    if (!drSel && gs.length) drSel = gs[0].key;
    function rerender() { renderDragons(body); }

    /* ---- top: team + totals ---- */
    var top = el('div', 'col-dr-top');
    var team = el('div', 'col-dr-team');
    var tl = el('div', 'col-dr-team-label');
    tl.appendChild(text('span', '', t('col.team')));
    tl.appendChild(text('b', '', d.equipped.length + '/' + MAXE));
    team.appendChild(tl);
    var slots = el('div', 'col-dr-slots');
    for (var i = 0; i < MAXE; i++) {
      var uid = d.equipped[i];
      var it = uid ? ST().getDragon(uid) : null;
      var slot = el('button', 'col-dr-slot' + (it ? ' is-full pk-v' + it.variant : ''));
      slot.type = 'button';
      if (it) {
        slot.style.setProperty('--rc', D.rarityColor(it.species));
        slot.appendChild(art('baby', it.species, it.variant, { size: 96 }));
        slot.title = D.fullName(it.species, it.variant);
        (function (item) {
          slot.addEventListener('click', function () { play('tab'); drSel = D.indexKey(item.species, item.variant); rerender(); });
        })(it);
      } else {
        slot.appendChild(text('span', 'col-dr-slot-plus', '+'));
        slot.disabled = true;
      }
      slots.appendChild(slot);
    }
    team.appendChild(slots);
    top.appendChild(team);

    var tot = el('div', 'col-dr-totals');
    var inc = el('div', 'col-dr-income');
    inc.appendChild(text('span', 'col-dr-income-l', t('col.incomeTotal')));
    inc.appendChild(text('b', 'col-dr-income-v', rate(ST().incomePerSec(SE.Boosts))));
    tot.appendChild(inc);
    tot.appendChild(text('div', 'col-dr-count', t('col.dragons.count', d.dragons.length, ST().MAX_DRAGONS || 250)));
    top.appendChild(tot);

    var acts = el('div', 'col-dr-acts');
    var best = btn(t('col.equipBest'), 'pk-blue', function () {
      ST().equipBest();
      play('equip');
      teamChanged();
      rerender();
    }, { icon: 'star' });
    best.disabled = !d.dragons.length;
    acts.appendChild(best);
    var freeAll = [];
    var freeVal = 0;
    gs.forEach(function (g) { freeAll = freeAll.concat(g.free); freeVal += g.free.length * g.value * mult; });
    var sellAll = btn(t('col.sellAll'), 'pk-red', function () {
      confirmBox(root, {
        title: t('col.sellAll.q'),
        text: t('col.sellAll.text', freeAll.length, money(freeVal)),
        ok: t('col.sell'), danger: true, icon: 'money-bag'
      }).then(function (ok) {
        if (!ok) return;
        var got = sellUids(freeAll.slice());
        rerender();
        if (got > 0) floatText(body.querySelector('.col-dr') || root, body.querySelector('.col-dr-acts') || root, '+' + money(got), 'is-cash');
      });
    }, { icon: 'money-bag', sub: freeAll.length ? freeAll.length + ' · ' + money(freeVal) : t('col.nothingToSell') });
    sellAll.disabled = !freeAll.length;
    acts.appendChild(sellAll);
    if (SE.Boosts && SE.Boosts.isActive && SE.Boosts.isActive('doubleSell')) {
      var ch = el('div', 'col-dr-x2 is-active');
      ch.appendChild(icon('banknotes', 'col-dr-x2-ic'));
      ch.appendChild(text('b', '', '×2'));
      var left = text('span', 'col-dr-x2-left', clock(SE.Boosts.remaining('doubleSell')));
      ch.appendChild(left);
      acts.appendChild(ch);
    } else {
      var ad = adBtn({ placement: 'doubleSell', label: t('col.x2sell'), cls: 'pk-small col-dr-x2btn', onGranted: rerender });
      if (ad) acts.appendChild(ad);
    }
    top.appendChild(acts);
    root.appendChild(top);

    /* ---- list ---- */
    var list = el('div', 'col-dr-list pk-scroll');
    if (!gs.length) {
      var empty = el('div', 'pk-empty col-dr-empty');
      empty.appendChild(art('egg', 'meadow', 0, { cls: 'pk-empty-art', noModel: true }));
      empty.appendChild(text('div', 'pk-empty-title', t('col.dragons.empty')));
      empty.appendChild(text('div', 'pk-empty-text', t('col.dragons.emptyHint')));
      list.appendChild(empty);
    }
    var rows = {};
    gs.forEach(function (g) {
      var row = el('button', 'col-dr-row pk-v' + g.variant + (g.key === drSel ? ' is-sel' : '') + (g.equipped.length ? ' is-team' : ''));
      row.type = 'button';
      row.style.setProperty('--rc', D.rarityColor(g.species));
      row.style.setProperty('--sc', D.species(g.species).color);
      var th = el('span', 'col-dr-thumb');
      th.appendChild(art('baby', g.species, g.variant, { size: 96 }));
      th.appendChild(text('span', 'col-dr-thumb-count', '×' + g.uids.length));
      row.appendChild(th);
      var info = el('span', 'col-dr-info');
      info.appendChild(text('span', 'col-dr-name', D.fullName(g.species, g.variant)));
      var tags = el('span', 'col-dr-tags');
      tags.appendChild(rarityTag(g.species, 'pk-small'));
      if (g.variant > 0) tags.appendChild(variantTag(g.variant, 'pk-small'));
      if (g.equipped.length) {
        var tm = el('span', 'pk-tag pk-tag-team pk-small');
        tm.appendChild(icon('star', 'pk-tag-ic'));
        tm.appendChild(text('span', '', t('col.inTeam', g.equipped.length)));
        tags.appendChild(tm);
      }
      info.appendChild(tags);
      row.appendChild(info);
      var nums = el('span', 'col-dr-nums');
      nums.appendChild(text('span', 'col-dr-inc', rate(g.income)));
      nums.appendChild(text('span', 'col-dr-each', t('col.each')));
      var val = cash(g.value * mult, 'pk-small col-dr-val');
      nums.appendChild(val);
      row.appendChild(nums);
      row.addEventListener('click', function () {
        if (drSel === g.key) return;
        play('tab');
        drSel = g.key;
        Object.keys(rows).forEach(function (k) { rows[k].classList.toggle('is-sel', k === drSel); });
        renderBar();
      });
      rows[g.key] = row;
      list.appendChild(row);
    });
    root.appendChild(list);

    /* ---- selected group bar ---- */
    var barBox = el('div', 'col-dr-bar');
    root.appendChild(barBox);
    function renderBar() {
      clear(barBox);
      var g = gs.filter(function (x) { return x.key === drSel; })[0];
      barBox.hidden = !g;
      if (!g) return;
      barBox.style.setProperty('--rc', D.rarityColor(g.species));
      var who = el('div', 'col-dr-bar-who');
      who.appendChild(art('baby', g.species, g.variant, { size: 96, cls: 'col-dr-bar-art' }));
      var wi = el('div', 'col-dr-bar-info');
      wi.appendChild(text('div', 'col-dr-bar-name', D.fullName(g.species, g.variant)));
      wi.appendChild(text('div', 'col-dr-bar-sub', t('col.groupSub', g.uids.length, g.equipped.length)));
      who.appendChild(wi);
      barBox.appendChild(who);
      var btns = el('div', 'col-dr-bar-btns');
      var full = d.equipped.length >= MAXE;
      var add = btn(full ? t('col.teamFull') : t('col.equip'), 'pk-green', function () {
        var uid = g.free[0];
        if (!uid) return;
        if (!ST().equip(uid)) { play('error'); toast(t('msg.teamFull', MAXE), 'error'); return; }
        play('equip');
        teamChanged();
        rerender();
      }, { icon: 'star', sound: false });
      add.disabled = !g.free.length || full;
      btns.appendChild(add);
      var rem = btn(t('col.unequip'), 'pk-ghost', function () {
        var uid = g.equipped[g.equipped.length - 1];
        if (!uid) return;
        ST().unequip(uid);
        play('equip', { rate: 0.85 });
        teamChanged();
        rerender();
      }, { sound: false });
      rem.disabled = !g.equipped.length;
      btns.appendChild(rem);
      var sellN = g.free.length;
      var sell = btn(t('col.sellN', sellN), 'pk-red', function () {
        confirmBox(root, {
          title: t('col.sellGroup.q', D.fullName(g.species, g.variant)),
          text: t('col.sellGroup.text', sellN, money(sellN * g.value * mult)),
          ok: t('col.sell'), danger: true,
          art: art('baby', g.species, g.variant, { size: 128, cls: 'pk-confirm-art' })
        }).then(function (ok) {
          if (!ok) return;
          var got = sellUids(g.free.slice());
          rerender();
          var r2 = body.querySelector('.col-dr');
          if (got > 0 && r2) floatText(r2, r2.querySelector('.col-dr-bar') || r2, '+' + money(got), 'is-cash');
        });
      }, { icon: 'money-bag', sub: sellN ? money(sellN * g.value * mult) : t('col.allInTeam') });
      sell.disabled = !sellN;
      btns.appendChild(sell);
      barBox.appendChild(btns);
    }
    renderBar();
    if (opts && opts.key && rows[opts.key]) {
      setTimeout(function () { try { rows[opts.key].scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }, 0);
    }

    loop('dragons', root, function () {
      updateAdButtons(root);
      var x2 = root.querySelector('.col-dr-x2-left');
      if (x2) {
        var r = SE.Boosts.remaining('doubleSell');
        if (r <= 0) rerender(); else x2.textContent = clock(r);
      }
      var iv = root.querySelector('.col-dr-income-v');
      if (iv) iv.textContent = rate(ST().incomePerSec(SE.Boosts));
    }, 500);
  }

  /* ====================================================================== */
  /* 'eggs' — hatcheries                                                     */
  /* ====================================================================== */
  function slotKind(h) {
    if (!h || !h.unlocked) return 'locked';
    if (h.baby) return 'ready';
    if (h.egg) return 'egg';
    return 'empty';
  }
  function slotSig(d) {
    return d.hatcheries.map(function (h) {
      var k = slotKind(h);
      return k + (k === 'egg' ? h.egg.species + h.egg.variant : k === 'ready' ? h.baby.species + h.baby.variant : '');
    }).join('|') + '|' + (SE.Boosts && SE.Boosts.isActive && SE.Boosts.isActive('x2hatch') ? 1 : 0);
  }

  function collect(i) {
    var d = data(), h = d.hatcheries[i];
    if (!h || !h.baby) return null;
    var baby = { species: h.baby.species, variant: h.baby.variant };
    var f = gameFn('collectHatchery');
    if (f) {
      try { f(i); } catch (e) { if (global.console) console.error(e); }
    } else {
      var r = ST().collectHatchery(i);
      if (!r) { play('error'); toast(t('msg.collectFailed'), 'error'); return null; }
      play('collect');
      toast(t(r.isNew ? 'msg.collectedNew' : 'msg.collected', DD().fullName(baby.species, baby.variant)), 'good');
      if (r.autoSold) toast(t('msg.autoSold', DD().fullName(r.autoSold.species, r.autoSold.variant), money(r.autoSold.value)), 'info');
      if (r.autoEquipped) refreshFollowers();
      save();
    }
    hud();
    return d.hatcheries[i] && !d.hatcheries[i].baby ? baby : null;
  }

  function buyHatch(i) {
    var d = data();
    var f = gameFn('buyHatchery');
    if (f) {
      try { f(i); } catch (e) { if (global.console) console.error(e); }
    } else if (ST().buyHatchery(i)) {
      play('unlock');
      toast(t('msg.hatcheryBought', i + 1), 'good');
      save();
    } else {
      play('error');
      toast(t('msg.noMoney'), 'error');
    }
    hud();
    return !!(d.hatcheries[i] && d.hatcheries[i].unlocked);
  }

  var egFocus = -1;

  function renderEggs(body, opts) {
    stop('eggs');
    var D = DD(), d = data();
    var root = newRoot(body, 'col-eg');
    if (!D || !d) { root.appendChild(text('div', 'pk-empty', t('col.noData'))); return; }
    if (opts && typeof opts.index === 'number') egFocus = opts.index;
    function rerender() { renderEggs(body); }
    var sig = slotSig(d);

    /* ---- top bar ---- */
    var top = el('div', 'col-eg-top');
    var unlocked = ST().unlockedHatcheries();
    var ready = readyCount();
    var incubating = d.hatcheries.filter(function (h) { return h.egg; }).length;
    var sum = el('div', 'col-eg-sum');
    sum.appendChild(img([url('render/hatchery.png')], 'col-eg-sum-ic'));
    var st = el('div', 'col-eg-sum-t');
    st.appendChild(text('b', '', t('col.eggs.slots', unlocked, d.hatcheries.length)));
    st.appendChild(text('span', '', t('col.eggs.status', incubating, ready)));
    sum.appendChild(st);
    top.appendChild(sum);

    var acts = el('div', 'col-eg-acts');
    if (ready > 1) {
      acts.appendChild(btn(t('col.collectAll', ready), 'pk-green pk-pulse', function () {
        for (var i = 0; i < d.hatcheries.length; i++) if (d.hatcheries[i].baby) collect(i);
        rerender();
      }, { icon: 'hatching-chick', sound: false }));
    }
    if (SE.Boosts && SE.Boosts.isActive && SE.Boosts.isActive('x2hatch')) {
      var ch = el('div', 'col-eg-x2 is-active');
      ch.appendChild(icon('fast-hatch', 'col-eg-x2-ic'));
      var ct = el('div', 'col-eg-x2-t');
      ct.appendChild(text('b', '', t('col.eggs.x2active')));
      ct.appendChild(text('span', 'col-eg-x2-left', clock(SE.Boosts.remaining('x2hatch'))));
      ch.appendChild(ct);
      acts.appendChild(ch);
    } else {
      var x2 = adBtn({ placement: 'x2hatch', label: t('col.eggs.x2'), sub: duration(offerDur('x2hatch')) + ' · ' + t('btn.watchAd'), cls: 'col-eg-x2btn', onGranted: rerender });
      if (x2) acts.appendChild(x2);
    }
    top.appendChild(acts);
    root.appendChild(top);

    /* ---- grid ---- */
    var grid = el('div', 'col-eg-grid pk-scroll');
    var nextLocked = ST().nextLockedHatchery();
    var live = [];
    d.hatcheries.forEach(function (h, i) {
      var kind = slotKind(h);
      var card = el('div', 'col-eg-slot is-' + kind + (i === egFocus ? ' is-focus' : ''));
      card.appendChild(text('span', 'col-eg-num', '#' + (i + 1)));
      var stage = el('div', 'col-eg-stage');
      card.appendChild(stage);
      var info = el('div', 'col-eg-info');
      card.appendChild(info);

      if (kind === 'egg') {
        var e = h.egg;
        card.classList.add('pk-v' + e.variant);
        card.style.setProperty('--rc', D.rarityColor(e.species));
        card.style.setProperty('--vc', D.variant(e.variant).color);
        stage.appendChild(img([url('render/hatchery.png')], 'col-eg-nest'));
        stage.appendChild(art('egg', e.species, e.variant, { size: 128, cls: 'col-eg-egg' }));
        if (e.variant > 0) stage.appendChild(variantTag(e.variant, 'pk-small col-eg-vtag'));
        info.appendChild(text('div', 'col-eg-name', D.fullEggName(e.species, e.variant)));
        var tm = el('div', 'col-eg-timer');
        tm.appendChild(icon('fast-hatch', 'col-eg-timer-ic'));
        var tt = text('b', 'col-eg-time', clock(ST().hatchRemaining(i)));
        tm.appendChild(tt);
        info.appendChild(tm);
        var pb = bar(ST().hatchProgress(i), 'col-eg-bar');
        info.appendChild(pb);
        live.push({ i: i, time: tt, fill: pb.firstChild });
        var inst = adBtn({ placement: 'instantHatch', label: t('col.eggs.instant'), ctx: { index: i, hatchery: i }, cls: 'pk-small col-eg-inst', onGranted: rerender });
        if (inst) info.appendChild(inst);
      } else if (kind === 'ready') {
        var b = h.baby;
        card.classList.add('pk-v' + b.variant);
        card.style.setProperty('--rc', D.rarityColor(b.species));
        card.style.setProperty('--vc', D.variant(b.variant).color);
        stage.appendChild(img([url('render/hatchery.png')], 'col-eg-nest'));
        stage.appendChild(el('span', 'pk-rays col-eg-rays'));
        stage.appendChild(art('baby', b.species, b.variant, { size: 128, cls: 'col-eg-baby' }));
        if (indexCount(D.indexKey(b.species, b.variant)) === 0) stage.appendChild(text('span', 'col-ix-new col-eg-new', t('col.new')));
        info.appendChild(text('div', 'col-eg-name', D.fullName(b.species, b.variant)));
        info.appendChild(text('div', 'col-eg-ready', t('time.ready')));
        info.appendChild(btn(t('btn.claim'), 'pk-green pk-pulse col-eg-claim', function (ev, bt) {
          bt.disabled = true;
          collect(i);
          rerender();
        }, { icon: 'hatching-chick', sound: false }));
      } else if (kind === 'empty') {
        stage.appendChild(img([url('render/hatchery.png')], 'col-eg-nest'));
        info.appendChild(text('div', 'col-eg-name', t('col.eggs.empty')));
        info.appendChild(text('div', 'col-eg-hint', t('col.eggs.emptyHint')));
      } else {
        var price = ST().hatcheryPrice(i);
        stage.appendChild(img([url('render/hatchery.png')], 'col-eg-nest is-dim'));
        stage.appendChild(img([url('render/lock.png')], 'col-eg-lock'));
        info.appendChild(text('div', 'col-eg-name', t('col.eggs.locked')));
        var afford = ST().canAfford(price);
        var buy = btn(money(price), (i === nextLocked ? 'pk-green' : 'pk-ghost') + ' col-eg-buy', function () {
          if (!ST().canAfford(price)) { play('error'); toast(t('msg.noMoneyNeed', money(price - d.money)), 'error'); return; }
          buyHatch(i);
          rerender();
        }, { sub: t('btn.buy'), sound: false });
        if (!afford) buy.classList.add('is-poor');
        info.appendChild(buy);
      }
      grid.appendChild(card);
    });
    root.appendChild(grid);

    if (egFocus >= 0) {
      var fc = grid.children[egFocus];
      egFocus = -1;
      if (fc) setTimeout(function () { try { fc.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }, 0);
    }

    loop('eggs', root, function () {
      if (slotSig(d) !== sig) { rerender(); return; }
      live.forEach(function (x) {
        x.time.textContent = clock(ST().hatchRemaining(x.i));
        x.fill.style.width = Math.round(ST().hatchProgress(x.i) * 1000) / 10 + '%';
      });
      var xl = root.querySelector('.col-eg-x2-left');
      if (xl) xl.textContent = clock(SE.Boosts.remaining('x2hatch'));
      updateAdButtons(root);
    }, 250);
  }

  /* ====================================================================== */
  /* Strings                                                                 */
  /* ====================================================================== */
  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: {
        'col.index.title': 'Драконий индекс',
        'col.dragons.title': 'Мои драконы',
        'col.eggs.title': 'Инкубаторы',
        'col.noData': 'Данные ещё загружаются…',
        'col.new': 'NEW',
        'col.index.found': 'Открыто',
        'col.index.mileHint': 'Открой {0} драконов — награда {1} самоцветов',
        'col.index.nextReward': 'Ещё {0} до награды',
        'col.index.complete': 'Индекс собран полностью!',
        'col.index.rewardGot': '+{0} самоцветов за индекс!',
        'col.index.owned': 'У тебя: {0}',
        'col.index.notFound': 'Ещё не найден',
        'col.index.perVariant': 'Доход и время вылупления',
        'col.index.abilities': 'Страж: {0}',
        'col.index.noAbility': 'Страж без особых умений',
        'col.index.lairLocked': 'Логово закрыто · {0}',
        'col.income': 'Доход',
        'col.incomeTotal': 'Доход',
        'col.hatchTime': 'Вылупление',
        'col.chance': 'Шанс',
        'col.value': 'Цена',
        'col.each': 'каждый',
        'col.team': 'Команда',
        'col.inTeam': 'в команде: {0}',
        'col.dragons.count': 'Драконов: {0}/{1}',
        'col.dragons.empty': 'Пока нет драконов',
        'col.dragons.emptyHint': 'Укради яйцо в логове, принеси его на базу и дождись вылупления!',
        'col.equipBest': 'Лучшие в команду',
        'col.equip': 'В команду',
        'col.unequip': 'Убрать',
        'col.teamFull': 'Команда полна',
        'col.sell': 'Продать',
        'col.sellN': 'Продать {0}',
        'col.sellAll': 'Продать всех',
        'col.sellAll.q': 'Продать всех вне команды?',
        'col.sellAll.text': 'Драконов: {0}. Ты получишь {1}. Команда останется.',
        'col.sellGroup.q': 'Продать: {0}?',
        'col.sellGroup.text': 'Драконов вне команды: {0}. Ты получишь {1}.',
        'col.nothingToSell': 'нечего продавать',
        'col.allInTeam': 'все в команде',
        'col.groupSub': 'Всего: {0} · в команде: {1}',
        'col.x2sell': 'Цена ×2',
        'col.eggs.slots': 'Инкубаторы {0}/{1}',
        'col.eggs.status': 'Греются: {0} · готовы: {1}',
        'col.eggs.x2': 'Вылупление ×2',
        'col.eggs.x2active': 'Вылупление ×2',
        'col.eggs.instant': 'Сразу',
        'col.eggs.empty': 'Свободно',
        'col.eggs.emptyHint': 'Укради яйцо и принеси на базу',
        'col.eggs.locked': 'Закрыто',
        'col.collectAll': 'Забрать всех ({0})',
        'msg.teamFull': 'В команде максимум {0} дракончиков',
        'msg.sold': 'Продано: {0} · +{1}',
        'msg.noMoney': 'Не хватает денег',
        'msg.noMoneyNeed': 'Не хватает {0}',
        'msg.hatcheryBought': 'Инкубатор №{0} открыт!',
        'msg.collected': '{0} теперь в коллекции!',
        'msg.collectedNew': 'Новый дракон в индексе: {0}!',
        'msg.collectFailed': 'Не получилось забрать дракончика',
        'msg.autoSold': 'Коллекция полна: продан {0} за {1}',
        'msg.adUnavailable': 'Реклама сейчас недоступна, попробуй позже',
        'offer.cooldown': 'через {0}',
        'offer.unavailable': 'Недоступно'
      },
      en: {
        'col.index.title': 'Dragon Index',
        'col.dragons.title': 'My Dragons',
        'col.eggs.title': 'Hatcheries',
        'col.noData': 'Still loading…',
        'col.new': 'NEW',
        'col.index.found': 'Found',
        'col.index.mileHint': 'Find {0} dragons — reward: {1} gems',
        'col.index.nextReward': '{0} more to the reward',
        'col.index.complete': 'Index complete!',
        'col.index.rewardGot': '+{0} gems for the Index!',
        'col.index.owned': 'Owned: {0}',
        'col.index.notFound': 'Not found yet',
        'col.index.perVariant': 'Income and hatch time',
        'col.index.abilities': 'Guardian: {0}',
        'col.index.noAbility': 'Guardian has no special skills',
        'col.index.lairLocked': 'Lair locked · {0}',
        'col.income': 'Income',
        'col.incomeTotal': 'Income',
        'col.hatchTime': 'Hatch time',
        'col.chance': 'Chance',
        'col.value': 'Value',
        'col.each': 'each',
        'col.team': 'Team',
        'col.inTeam': 'in team: {0}',
        'col.dragons.count': 'Dragons: {0}/{1}',
        'col.dragons.empty': 'No dragons yet',
        'col.dragons.emptyHint': 'Steal an egg in a lair, bring it to your base and let it hatch!',
        'col.equipBest': 'Equip best',
        'col.equip': 'Add to team',
        'col.unequip': 'Remove',
        'col.teamFull': 'Team is full',
        'col.sell': 'Sell',
        'col.sellN': 'Sell {0}',
        'col.sellAll': 'Sell all',
        'col.sellAll.q': 'Sell everyone outside the team?',
        'col.sellAll.text': 'Dragons: {0}. You get {1}. Your team stays.',
        'col.sellGroup.q': 'Sell: {0}?',
        'col.sellGroup.text': 'Dragons outside the team: {0}. You get {1}.',
        'col.nothingToSell': 'nothing to sell',
        'col.allInTeam': 'all in team',
        'col.groupSub': 'Total: {0} · in team: {1}',
        'col.x2sell': 'Price ×2',
        'col.eggs.slots': 'Hatcheries {0}/{1}',
        'col.eggs.status': 'Warming: {0} · ready: {1}',
        'col.eggs.x2': 'Hatch ×2',
        'col.eggs.x2active': 'Hatch ×2',
        'col.eggs.instant': 'Now',
        'col.eggs.empty': 'Free',
        'col.eggs.emptyHint': 'Steal an egg and bring it home',
        'col.eggs.locked': 'Locked',
        'col.collectAll': 'Collect all ({0})',
        'msg.teamFull': 'Your team holds up to {0} babies',
        'msg.sold': 'Sold: {0} · +{1}',
        'msg.noMoney': 'Not enough cash',
        'msg.noMoneyNeed': 'You need {0} more',
        'msg.hatcheryBought': 'Hatchery #{0} unlocked!',
        'msg.collected': '{0} joined your collection!',
        'msg.collectedNew': 'New Index entry: {0}!',
        'msg.collectFailed': 'Could not collect the baby',
        'msg.autoSold': 'Collection full: sold {0} for {1}',
        'msg.adUnavailable': 'No ad available right now, try again later',
        'offer.cooldown': 'in {0}',
        'offer.unavailable': 'Unavailable'
      },
      tr: {
        'col.index.title': 'Ejderha Dizini',
        'col.dragons.title': 'Ejderhalarım',
        'col.eggs.title': 'Kuluçkalıklar',
        'col.noData': 'Hâlâ yükleniyor…',
        'col.new': 'YENİ',
        'col.index.found': 'Bulunan',
        'col.index.mileHint': '{0} ejderha bul — ödül: {1} mücevher',
        'col.index.nextReward': 'Ödüle {0} kaldı',
        'col.index.complete': 'Dizin tamamlandı!',
        'col.index.rewardGot': 'Dizin için +{0} mücevher!',
        'col.index.owned': 'Sende: {0}',
        'col.index.notFound': 'Henüz bulunmadı',
        'col.index.perVariant': 'Gelir ve çatlama süresi',
        'col.index.abilities': 'Bekçi: {0}',
        'col.index.noAbility': 'Bekçinin özel yeteneği yok',
        'col.index.lairLocked': 'İn kilitli · {0}',
        'col.income': 'Gelir',
        'col.incomeTotal': 'Gelir',
        'col.hatchTime': 'Çatlama',
        'col.chance': 'Şans',
        'col.value': 'Değer',
        'col.each': 'tanesi',
        'col.team': 'Takım',
        'col.inTeam': 'takımda: {0}',
        'col.dragons.count': 'Ejderha: {0}/{1}',
        'col.dragons.empty': 'Henüz ejderha yok',
        'col.dragons.emptyHint': 'Bir inden yumurta çal, üssüne getir ve çatlamasını bekle!',
        'col.equipBest': 'En iyileri seç',
        'col.equip': 'Takıma al',
        'col.unequip': 'Çıkar',
        'col.teamFull': 'Takım dolu',
        'col.sell': 'Sat',
        'col.sellN': '{0} sat',
        'col.sellAll': 'Hepsini sat',
        'col.sellAll.q': 'Takım dışındakilerin hepsi satılsın mı?',
        'col.sellAll.text': 'Ejderha: {0}. Kazancın: {1}. Takımın kalır.',
        'col.sellGroup.q': 'Satılsın mı: {0}?',
        'col.sellGroup.text': 'Takım dışındaki ejderha: {0}. Kazancın: {1}.',
        'col.nothingToSell': 'satılacak yok',
        'col.allInTeam': 'hepsi takımda',
        'col.groupSub': 'Toplam: {0} · takımda: {1}',
        'col.x2sell': 'Fiyat ×2',
        'col.eggs.slots': 'Kuluçkalık {0}/{1}',
        'col.eggs.status': 'Isınan: {0} · hazır: {1}',
        'col.eggs.x2': 'Çatlama ×2',
        'col.eggs.x2active': 'Çatlama ×2',
        'col.eggs.instant': 'Hemen',
        'col.eggs.empty': 'Boş',
        'col.eggs.emptyHint': 'Bir yumurta çal ve üsse getir',
        'col.eggs.locked': 'Kilitli',
        'col.collectAll': 'Hepsini al ({0})',
        'msg.teamFull': 'Takımda en fazla {0} yavru olabilir',
        'msg.sold': 'Satıldı: {0} · +{1}',
        'msg.noMoney': 'Yeterli para yok',
        'msg.noMoneyNeed': '{0} daha gerekiyor',
        'msg.hatcheryBought': '{0}. kuluçkalık açıldı!',
        'msg.collected': '{0} koleksiyonuna katıldı!',
        'msg.collectedNew': 'Dizinde yeni ejderha: {0}!',
        'msg.collectFailed': 'Yavru alınamadı',
        'msg.autoSold': 'Koleksiyon dolu: {0} {1} karşılığında satıldı',
        'msg.adUnavailable': 'Şu anda reklam yok, sonra tekrar dene',
        'offer.cooldown': '{0} sonra',
        'offer.unavailable': 'Kullanılamaz'
      }
    });
  }

  /* ====================================================================== */
  /* Registration                                                            */
  /* ====================================================================== */
  var registered = false;
  function register() {
    if (registered) return true;
    if (!SE.UI || typeof SE.UI.registerPanel !== 'function') return false;
    registered = true;
    SE.UI.registerPanel('index', {
      titleKey: 'col.index.title', icon: 'book', size: 'l',
      render: function (body, d) { renderIndex(body, d); },
      onClose: function () { stop('index'); }
    });
    SE.UI.registerPanel('dragons', {
      titleKey: 'col.dragons.title', icon: 'paw', size: 'l',
      render: function (body, d) { renderDragons(body, d); },
      onClose: function () { stop('dragons'); }
    });
    SE.UI.registerPanel('eggs', {
      titleKey: 'col.eggs.title', icon: 'egg', size: 'l',
      render: function (body, d) { renderEggs(body, d); },
      onClose: function () { stop('eggs'); }
    });
    return true;
  }

  SE.CollectionUI = {
    MILESTONES: MILESTONES,
    register: register,
    discovered: discovered,
    readyCount: readyCount,
    indexBadge: function () { return data() ? unseen().length + claimable().length : 0; },
    /* for tests / other modules */
    groups: function () { return data() ? groups() : []; },
    render: { index: renderIndex, dragons: renderDragons, eggs: renderEggs }
  };

  if (!register() && doc) {
    doc.addEventListener('DOMContentLoaded', register);
    global.addEventListener('load', register);
  }
})(window);
