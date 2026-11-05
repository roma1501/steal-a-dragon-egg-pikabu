/* =========================================================================
   Steal a Dragon Egg — Wheel of Fortune: logic (SE.Wheel) + UI panel 'wheel'
   (docs/SPEC.md §7–§8, §10; skill «Магазин, Daily Gift и колесо фортуны»)

   Rules
   - 8 sectors (SECTORS below): gem amounts 15/20/40/75/150, small and big cash
     (scaled by SE.State.cashBonusAmount at spin time) and one cosmetic sector.
     The cosmetic sector shows a concrete "featured" item BEFORE the spin: a
     random unowned non-exclusive shop item (SE.CosmeticData.wheelPool), weighted
     to cheaper / more common ones, chosen deterministically from
     (today, stats.spins, owned count) so it stays the same until something
     changes. No unowned items left → the sector pays FALLBACK_GEMS instead.
   - 1 free spin per device calendar day (wheel.freeDate) + 3 rewarded spins per
     day (wheel.adDate / wheel.adSpins, placement 'wheel-spin', counted only after
     the SDK confirmed the reward).
   - spin(): the result is chosen FIRST and stored with the spin counters in
     State.data.wheel.pending = { sector, prize, ts, kind } + save; then the
     wheel animates (ease-out, several turns, a small wind-up) and stops EXACTLY
     on the centre of the chosen sector; then the prize is granted once, pending
     is cleared and the state saved again. The grant is driven by time, not by
     frames: a hidden tab (visibilitychange/pagehide) or a closed panel grants
     immediately / on a timer, and resolvePending() on startup grants a prize
     left over from a closed tab. Granting checks pending.ts → never twice.
   - Geometry: sector i spans [i·s, (i+1)·s) clockwise from 12 o'clock at
     rotation 0 (s = 2π/8). The canvas rotates clockwise by `rotation`; the
     pointer at 12 o'clock shows sector floor(mod(−rotation, 2π) / s).

   API
     SE.Wheel.SECTORS, AD_SPINS (3), FALLBACK_GEMS
     freeAvailable() -> bool            adSpinsLeft() -> 0..3
     timeToNextFree() -> seconds        (0 when the free spin is available)
     nextKind() -> 'free'|'ad'|null     what the spin button does now
     adReady() -> bool                  a rewarded ad can be shown for 'wheel-spin'
     prizeFor(i) -> prize preview       { sector, type:'gems'|'cash'|'item', amount, item, fallback }
     featuredItem() -> itemId|null
     spin(kind, opts) -> bool           kind 'free'|'ad' (default nextKind()); opts.sector forces
                                        a sector (QA), opts.duration (ms). 'ad' returns true when
                                        the ad started; the spin begins after confirmation.
     isSpinning() -> bool               pending() -> stored pending|null
     rotationNow() -> radians           current wheel rotation (panel / QA)
     sectorAt(rotation) -> index        targetRotation(sector, from, turns) -> rotation
     finish() -> result|null            ends the running spin now (grants once)
     resolvePending(opts) -> result|null  call ONCE after SE.State.load(): grants a pending prize
                                        (opts.toast !== false → SE.UI.toast)
     onChange(fn)                       fn(event, data): 'start' {pending}, 'result' {result}, 'ad'
     open(data) / registerPanel()
     result = { sector, kind, type, gems, cash, item, fallback, prize }
   Panel 'wheel' (size 'l'): canvas wheel (crisp at devicePixelRatio, rotated with a
   CSS transform — the bitmap is rendered once), blinking rim lights, pointer that
   flaps on every sector boundary ('wheel_tick'), prize legend, spin button
   (free / «Крутить за рекламу (2/3)» / countdown), result card ('wheel_win').
   Styles: css/wheel.css (.wh-*). Strings: wheel.*.
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  /* ---------------------------------------------------------------------- */
  /* Data                                                                    */
  /* ---------------------------------------------------------------------- */
  var SECTORS = [
    { id: 'gems15',  type: 'gems', amount: 15,  weight: 24, color: '#8a5cff', icon: 'render/gem' },
    { id: 'cashS',   type: 'cash', mult: 0.5,   weight: 20, color: '#4cc42a', icon: 'banknotes' },
    { id: 'gems40',  type: 'gems', amount: 40,  weight: 14, color: '#22b5c9', icon: 'render/gem' },
    { id: 'item',    type: 'item', weight: 6,               color: '#ff8a2e', icon: 'star' },
    { id: 'gems20',  type: 'gems', amount: 20,  weight: 18, color: '#e8506a', icon: 'render/gem' },
    { id: 'cashL',   type: 'cash', mult: 2,     weight: 8,  color: '#33a852', icon: 'cash-bonus' },
    { id: 'gems75',  type: 'gems', amount: 75,  weight: 7,  color: '#3a7ff0', icon: 'render/gems-pile' },
    { id: 'gems150', type: 'gems', amount: 150, weight: 3,  color: '#ffc928', icon: 'render/gems-pile', jackpot: true }
  ];
  var N = SECTORS.length;
  var SEG = Math.PI * 2 / N;
  var TAU = Math.PI * 2;
  var AD_SPINS = 3;
  var FALLBACK_GEMS = 100;
  var SPIN_MS = 4800;
  var RARITY_W = { common: 6, rare: 3, epic: 1.4, legendary: 0.6 };
  var RARITY_COLORS = { common: '#4f9a2a', rare: '#d0781a', epic: '#7b3fd0', legendary: '#e0a400' };
  var TAB_ICONS = { outfit: 'star', hat: 'render/crown', back: 'bag', trail: 'trail-rainbow', victory: 'sparkles' };

  var BASE = '';
  try {
    var src = document.currentScript && document.currentScript.src;
    var m = src && /^(.*\/)js\/ui\/wheel\.js(?:[?#].*)?$/.exec(src);
    if (m) BASE = m[1];
  } catch (e) { BASE = ''; }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function st() { return SE.State && SE.State.data ? SE.State.data : null; }
  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function today() { return SE.State && SE.State.todayKey ? SE.State.todayKey() : ''; }
  function nowMs() { return SE.State && typeof SE.State.now === 'function' ? SE.State.now() : Date.now(); }
  function perfNow() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function play(key, opts) {
    try { if (SE.Audio && typeof SE.Audio.play === 'function') SE.Audio.play(key, opts || {}); } catch (e) { /* optional */ }
  }
  function ui(fn) {
    var U = SE.UI;
    if (!U || typeof U[fn] !== 'function') return undefined;
    try { return U[fn].apply(U, Array.prototype.slice.call(arguments, 1)); } catch (e) { console.error(e); return undefined; }
  }
  function save() { try { if (SE.State && SE.State.save) SE.State.save(); } catch (e) { console.error(e); } }
  function iconUrl(name) { return BASE + 'assets/ui/' + name + '.png'; }
  function hash(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function shortNum(n) {
    if (SE.U && typeof SE.U.shortNum === 'function') return SE.U.shortNum(n);
    n = Math.floor(n || 0);
    if (n < 1000) return String(n);
    var suf = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi'], i = 0, v = n;
    while (v >= 1000 && i < suf.length - 1) { v /= 1000; i++; }
    var s = v >= 100 ? v.toFixed(0) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
    return s.replace(/\.0+$/, '').replace(/(\.\d)0$/, '$1') + suf[i];
  }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function img(url, cls) {
    var i = document.createElement('img');
    i.className = cls || '';
    i.alt = '';
    i.draggable = false;
    i.decoding = 'async';
    i.src = url;
    return i;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function clock(sec) { return SE.I18N && SE.I18N.clock ? SE.I18N.clock(sec) : String(Math.ceil(sec)); }

  /* ---------------------------------------------------------------------- */
  /* Cosmetics                                                               */
  /* ---------------------------------------------------------------------- */
  function C() { return SE.CosmeticData || null; }
  function owns(id) { return !!(SE.State && typeof SE.State.owns === 'function' && SE.State.owns(id)); }
  function itemDef(id) {
    var c = C();
    try { return c && c.item ? c.item(id) : null; } catch (e) { return null; }
  }
  function itemName(id) {
    var c = C();
    try { if (c && c.name) return c.name(id); } catch (e) { /* fall through */ }
    return id || '';
  }
  function rarityColor(r) {
    var c = C();
    try { if (c && c.rarityColor) { var v = c.rarityColor(r); if (v && v !== '#888888') return v; } } catch (e) { /* fall through */ }
    return RARITY_COLORS[r] || RARITY_COLORS.common;
  }
  function wheelPool() {
    var c = C(), list = [];
    try {
      if (c && typeof c.wheelPool === 'function') list = c.wheelPool(owns) || [];
      else if (c && Array.isArray(c.ITEMS)) list = c.ITEMS.filter(function (it) { return !it.exclusive && !it.isDefault && !owns(it.id); });
    } catch (e) { list = []; }
    var ex = c && Array.isArray(c.EXCLUSIVE_DAILY) ? c.EXCLUSIVE_DAILY : [];
    return list.filter(function (it) { return it && it.id && !it.exclusive && ex.indexOf(it.id) < 0 && !owns(it.id); });
  }
  /* cheaper / more common items are more likely: rarity weight / sqrt(cost in gem-equivalents) */
  function itemWeight(it) {
    var cost = 120;
    if (it.price) cost = it.price.gems ? it.price.gems : (it.price.ads ? it.price.ads * 60 : 120);
    return (RARITY_W[it.rarity] || 2) / Math.sqrt(Math.max(20, cost));
  }
  var thumbCache = {};
  function thumbnail(id, size) {
    var key = id + '@' + size;
    if (thumbCache[key]) return thumbCache[key];
    var Cos = SE.Cosmetics;
    if (!id || !Cos || typeof Cos.thumbnail !== 'function') return Promise.resolve(null);
    var p;
    try {
      p = Promise.resolve(Cos.thumbnail(id, size)).then(function (u) { return typeof u === 'string' && u ? u : null; }, function () { return null; });
    } catch (e) { p = Promise.resolve(null); }
    thumbCache[key] = p;
    return p;
  }
  function fallbackIcon(id) {
    var it = itemDef(id);
    return iconUrl(TAB_ICONS[it && it.tab] || 'star');
  }

  /* ---------------------------------------------------------------------- */
  /* Ads                                                                     */
  /* ---------------------------------------------------------------------- */
  function adReady() {
    if (SE.Config && SE.Config.ADS === false) return false;
    if (SE.Ads && typeof SE.Ads.ready === 'function') { try { return !!SE.Ads.ready('wheel-spin'); } catch (e) { return false; } }
    try { return !!(SE.Platform && SE.Platform.canRewarded && SE.Platform.canRewarded()); } catch (e) { return false; }
  }
  function showRewarded(onGranted, onDone) {
    var granted = false, finished = false;
    function grant() { if (granted) return; granted = true; try { onGranted(); } catch (e) { console.error(e); } }
    function done(ok) {
      if (finished) return;
      finished = true;
      if (ok === true && !granted) grant();
      try { onDone(granted); } catch (e) { console.error(e); }
    }
    try {
      if (SE.Ads && typeof SE.Ads.rewarded === 'function') { SE.Ads.rewarded('wheel-spin', grant, done); return; }
      if (SE.Platform && typeof SE.Platform.showRewarded === 'function' && SE.Platform.canRewarded()) {
        SE.Platform.showRewarded('wheel-spin', grant, done);
        return;
      }
    } catch (e) { console.error(e); }
    setTimeout(function () { done(false); }, 0);
  }

  /* ---------------------------------------------------------------------- */
  /* SE.Wheel logic                                                          */
  /* ---------------------------------------------------------------------- */
  var rotation = 0;            /* current resting rotation (radians, clockwise) */
  var spinState = null;        /* { pending, from, to, start|null, duration, done } */
  var safety = 0, holdTimer = 0;
  var adBusy = false;
  var listeners = [];

  function emit(ev, data) {
    var list = listeners.slice();
    for (var i = 0; i < list.length; i++) { try { list[i](ev, data); } catch (e) { console.error(e); } }
  }
  function ease(p) {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return 1 - Math.pow(1 - p, 4);
  }
  /* rotation offset at progress p: small wind-up back, then ease-out to exactly Δ */
  function curve(p, delta) {
    var wind = p < 0.08 ? -0.16 * Math.sin(Math.PI * p / 0.08) : 0;
    var q = p < 0.08 ? 0 : (p - 0.08) / 0.92;
    return delta * ease(q) + wind;
  }

  var Wheel = {
    SECTORS: SECTORS,
    AD_SPINS: AD_SPINS,
    FALLBACK_GEMS: FALLBACK_GEMS,
    iconUrl: iconUrl,

    freeAvailable: function () {
      var s = st();
      if (!s || !s.wheel) return false;
      return s.wheel.freeDate !== today();
    },
    adSpinsLeft: function () {
      var s = st();
      if (!s || !s.wheel) return 0;
      if (s.wheel.adDate !== today()) return AD_SPINS;
      return Math.max(0, AD_SPINS - (s.wheel.adSpins || 0));
    },
    timeToNextFree: function () {
      if (this.freeAvailable()) return 0;
      var now = nowMs(), d = new Date(now);
      var next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
      return Math.max(0, (next - now) / 1000);
    },
    nextKind: function () {
      if (this.freeAvailable()) return 'free';
      if (this.adSpinsLeft() > 0) return 'ad';
      return null;
    },
    adReady: adReady,
    adBusy: function () { return adBusy; },
    isSpinning: function () { return !!spinState && !spinState.done; },
    pending: function () { var s = st(); return s && s.wheel ? s.wheel.pending : null; },

    featuredItem: function () {
      var s = st();
      var pool = wheelPool();
      if (!pool.length) return null;
      pool.sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
      var ownedCount = s && s.cosmetics ? Object.keys(s.cosmetics.owned || {}).length : 0;
      var seed = hash('wheel|' + today() + '|' + ((s && s.stats && s.stats.spins) || 0) + '|' + ownedCount);
      var total = 0, i;
      for (i = 0; i < pool.length; i++) total += itemWeight(pool[i]);
      var r = (seed / 4294967296) * total;
      for (i = 0; i < pool.length; i++) { r -= itemWeight(pool[i]); if (r < 0) return pool[i].id; }
      return pool[pool.length - 1].id;
    },

    /* Prize of sector i with the current values (what the wheel shows). */
    prizeFor: function (i) {
      var d = SECTORS[mod(Math.floor(i), N)];
      var p = { sector: SECTORS.indexOf(d), type: d.type, amount: 0, item: null, fallback: false, jackpot: !!d.jackpot };
      if (d.type === 'gems') p.amount = d.amount;
      else if (d.type === 'cash') {
        var v = SE.State && typeof SE.State.cashBonusAmount === 'function' ? SE.State.cashBonusAmount(d.mult) : 300 * d.mult;
        p.amount = finite(v) ? Math.max(1, Math.round(v)) : 100;
      } else {
        var id = this.featuredItem();
        if (id) { p.item = id; p.rarity = (itemDef(id) || {}).rarity || 'common'; }
        else { p.type = 'gems'; p.amount = FALLBACK_GEMS; p.fallback = true; }
      }
      return p;
    },

    sectorAt: function (rot) {
      return Math.floor(mod(-rot, TAU) / SEG + 1e-9) % N;
    },
    targetRotation: function (sector, from, turns) {
      from = finite(from) ? from : rotation;
      var target = mod(-(sector + 0.5) * SEG, TAU);
      var delta = mod(target - from, TAU);
      if (delta < SEG) delta += TAU;            /* at least one sector of travel before the turns */
      return from + (finite(turns) ? turns : 5) * TAU + delta;
    },
    rotationNow: function () {
      if (!spinState) return rotation;
      if (spinState.start === null) return spinState.from;
      var p = Math.min(1, (perfNow() - spinState.start) / spinState.duration);
      return spinState.from + curve(p, spinState.to - spinState.from);
    },
    progress: function () {
      if (!spinState || spinState.start === null) return 0;
      return Math.min(1, (perfNow() - spinState.start) / spinState.duration);
    },

    pickSector: function () {
      var total = 0, i;
      for (i = 0; i < N; i++) total += SECTORS[i].weight;
      var r = Math.random() * total;
      for (i = 0; i < N; i++) { r -= SECTORS[i].weight; if (r < 0) return i; }
      return N - 1;
    },

    /* kind 'free' | 'ad'. Returns true when a spin (or its ad) started. */
    spin: function (kind, opts) {
      opts = opts || {};
      kind = kind || this.nextKind();
      var s = st();
      if (!s || !s.wheel || this.isSpinning() || adBusy) return false;
      if (s.wheel.pending) this.resolvePending({ toast: true });
      if (kind === 'free') {
        if (!this.freeAvailable()) return false;
        return !!begin('free', opts);
      }
      if (kind !== 'ad' || this.adSpinsLeft() <= 0 || !adReady()) return false;
      adBusy = true;
      emit('ad', { busy: true });
      var started = null;
      showRewarded(function () {
        if (Wheel.adSpinsLeft() > 0 && !Wheel.isSpinning()) started = begin('ad', opts, true);
      }, function () {
        adBusy = false;
        if (started) release(started);
        emit('ad', { busy: false, granted: !!started });
      });
      return true;
    },

    finish: function () {
      if (!spinState || spinState.done) return null;
      var sp = spinState;
      sp.done = true;
      rotation = mod(sp.to, TAU);
      clearTimeout(safety); clearTimeout(holdTimer);
      var res = grant(sp.pending);
      spinState = null;
      emit('result', { result: res, pending: sp.pending });
      if (res && !panel.visible()) {
        ui('toast', t('wheel.wonToast', describe(res)), 'good');
      }
      return res;
    },

    resolvePending: function (opts) {
      opts = opts || {};
      if (this.isSpinning()) return null;
      var s = st();
      if (!s || !s.wheel || !s.wheel.pending) return null;
      var res = grant(s.wheel.pending);
      if (res && opts.toast !== false) ui('toast', t('wheel.wonToast', describe(res)), 'good');
      if (res) emit('result', { result: res, resolved: true });
      return res;
    },

    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    describe: function (res) { return describe(res); },
    thumbnail: thumbnail,

    open: function (data) {
      this.registerPanel();
      if (SE.UI && typeof SE.UI.open === 'function') SE.UI.open('wheel', data || {});
    },
    registerPanel: function () {
      var U = SE.UI;
      if (!U || typeof U.registerPanel !== 'function' || panel.registeredWith === U) return false;
      panel.registeredWith = U;
      U.registerPanel('wheel', {
        titleKey: 'wheel.title', icon: 'prize-wheel', size: 'l',
        render: function (body, data, p) { panel.render(body, data, p); },
        onOpen: function (data) { panel.onOpen(data); },
        onClose: function () { panel.onClose(); }
      });
      return true;
    }
  };

  /* Choose + store the result FIRST (one save with the spin counters), then animate. */
  function begin(kind, opts, hold) {
    var s = st();
    if (!s || !s.wheel) return null;
    var sector = finite(opts.sector) ? mod(Math.floor(opts.sector), N) : Wheel.pickSector();
    var prize = Wheel.prizeFor(sector);
    var pend = { sector: sector, prize: prize, ts: nowMs(), kind: kind, id: (Math.random() * 1e9) | 0 };
    s.wheel.pending = pend;
    var day = today();
    if (kind === 'free') s.wheel.freeDate = day;
    else {
      if (s.wheel.adDate !== day) { s.wheel.adDate = day; s.wheel.adSpins = 0; }
      s.wheel.adSpins = Math.min(AD_SPINS, (s.wheel.adSpins || 0) + 1);
    }
    if (s.stats) s.stats.spins = (s.stats.spins || 0) + 1;
    save();
    var from = mod(rotation, TAU);
    var turns = 5 + ((Math.random() * 2) | 0);
    spinState = {
      pending: pend, kind: kind, from: from, to: Wheel.targetRotation(sector, from, turns),
      start: null, duration: finite(opts.duration) ? Math.max(30, opts.duration) : SPIN_MS, done: false
    };
    emit('start', { pending: pend });
    if (!hold) release(spinState);
    else holdTimer = setTimeout(function () { release(spinState); }, 8000);   /* the SDK never closed */
    return spinState;
  }
  function release(sp) {
    if (!sp || sp !== spinState || sp.done || sp.start !== null) return;
    clearTimeout(holdTimer);
    sp.start = perfNow();
    clearTimeout(safety);
    safety = setTimeout(function () { if (spinState === sp) Wheel.finish(); }, sp.duration + 400);
    emit('spin', { pending: sp.pending });
  }

  /* Grants a stored pending prize exactly once (matched by ts+id). */
  function grant(pend) {
    var s = st();
    if (!s || !s.wheel || !pend) return null;
    var cur = s.wheel.pending;
    if (!cur || cur.ts !== pend.ts || cur.id !== pend.id) return null;
    s.wheel.pending = null;
    var prize = cur.prize || {};
    var res = { sector: cur.sector, kind: cur.kind, type: prize.type, gems: 0, cash: 0, item: null, fallback: !!prize.fallback, prize: prize };
    if (prize.type === 'item' && prize.item) {
      if (SE.State.grantItem(prize.item)) res.item = prize.item;
      else { res.type = 'gems'; res.gems = FALLBACK_GEMS; res.fallback = true; }
    } else if (prize.type === 'cash') {
      res.cash = finite(prize.amount) ? Math.max(0, prize.amount) : 0;
    } else {
      res.type = 'gems';
      res.gems = finite(prize.amount) ? Math.max(0, prize.amount) : 0;
    }
    if (res.gems > 0) SE.State.addGems(res.gems);
    if (res.cash > 0) SE.State.addMoney(res.cash);
    save();
    ui('updateHUD');
    return res;
  }

  function describe(res) {
    if (!res) return '';
    if (res.item) return itemName(res.item);
    if (res.cash) return '$' + shortNum(res.cash);
    return '+' + shortNum(res.gems) + ' ' + t('wheel.gems');
  }

  /* hidden tab / closing page: never leave a running spin ungranted */
  function flushHidden() { if (spinState && !spinState.done && spinState.start !== null) Wheel.finish(); }
  /* Playables (pauseOnHidden false) must not use the Page Visibility API: pagehide + the saved wheel.pending cover it */
  if (typeof document !== 'undefined' && document.addEventListener && !(SE.Platform && SE.Platform.pauseOnHidden === false)) {
    document.addEventListener('visibilitychange', function () { if (document.hidden) flushHidden(); });
  }
  if (typeof global.addEventListener === 'function') global.addEventListener('pagehide', flushHidden);

  /* ---------------------------------------------------------------------- */
  /* Panel 'wheel'                                                           */
  /* ---------------------------------------------------------------------- */
  var POINTER_SVG = '<svg viewBox="0 0 60 74" aria-hidden="true">' +
    '<defs><linearGradient id="whPg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a6a"/><stop offset=".55" stop-color="#e0412a"/><stop offset="1" stop-color="#a51e12"/></linearGradient></defs>' +
    '<path d="M30 71 L6 26 A26 26 0 1 1 54 26 Z" fill="url(#whPg)" stroke="#2b1d0e" stroke-width="5" stroke-linejoin="round"/>' +
    '<circle cx="30" cy="25" r="10" fill="#ffd257" stroke="#2b1d0e" stroke-width="4"/>' +
    '<path d="M16 16 Q22 8 32 8" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="4" stroke-linecap="round"/></svg>';
  var CLOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#fff6e0" stroke="#2b1d0e" stroke-width="2.6"/>' +
    '<path d="M12 6.5V12l3.6 2.4" fill="none" stroke="#2b1d0e" stroke-width="2.6" stroke-linecap="round"/></svg>';
  var BULBS = 16;

  var imgCache = {};
  function loadImage(url) {
    if (imgCache[url]) return imgCache[url];
    imgCache[url] = new Promise(function (resolve) {
      var im = new Image();
      im.decoding = 'async';
      im.onload = function () { resolve(im); };
      im.onerror = function () { resolve(null); };
      im.src = url;
    });
    return imgCache[url];
  }

  var panel = {
    registeredWith: null,
    root: null, body: null,
    els: null,
    raf: 0, timer: 0, ro: null,
    size: 0, dpr: 1, drawToken: 0,
    lastBoundary: null, lastTick: 0,
    revealFor: null,

    visible: function () { return !!(this.root && this.root.isConnected); },

    render: function (body) {
      this.body = body;
      if (!this.root) this.build();
      body.innerHTML = '';
      body.appendChild(this.root);
      this.layout();
      this.sync(true);
      this.startLoops();
    },
    onOpen: function () {
      if (!Wheel.isSpinning() && Wheel.pending()) Wheel.resolvePending({ toast: true });
    },
    onClose: function () {
      this.stopLoops();
      this.hideReveal(true);
    },

    build: function () {
      var self = this;
      var root = this.root = el('div', 'wh');
      root.setAttribute('data-panel', 'wheel');
      var stage = el('div', 'wh-stage');
      var wrap = el('div', 'wh-wrap');
      var glow = el('div', 'wh-glow');
      var rim = el('div', 'wh-rim');
      var canvas = el('canvas', 'wh-canvas');
      var bulbs = el('div', 'wh-bulbs');
      for (var i = 0; i < BULBS; i++) {
        var b = el('i', 'wh-bulb' + (i % 2 ? ' is-odd' : ''));
        b.style.setProperty('--a', (i * 360 / BULBS) + 'deg');
        bulbs.appendChild(b);
      }
      var hub = el('button', 'wh-hub');
      hub.type = 'button';
      hub.innerHTML = '<img alt="" draggable="false" src="' + iconUrl('render/gem') + '">';
      hub.addEventListener('click', function () { self.onSpin(); });
      var pointer = el('div', 'wh-pointer', POINTER_SVG);
      wrap.appendChild(glow);
      wrap.appendChild(rim);
      wrap.appendChild(canvas);
      wrap.appendChild(bulbs);
      wrap.appendChild(hub);
      wrap.appendChild(pointer);
      stage.appendChild(wrap);

      var side = el('div', 'wh-side');
      var head = el('div', 'wh-head');
      head.innerHTML = '<div class="wh-title"></div><div class="wh-sub"></div>';
      side.appendChild(head);
      var legend = el('div', 'wh-legend');
      side.appendChild(legend);
      var actions = el('div', 'wh-actions');
      var btn = el('button', 'wh-btn');
      btn.type = 'button';
      btn.innerHTML = '<img class="wh-btn-ic" alt="" draggable="false" src="' + iconUrl('watch-video') + '"><span class="wh-btn-lbl"></span>';
      btn.addEventListener('click', function () { self.onSpin(); });
      actions.appendChild(btn);
      var status = el('div', 'wh-status');
      actions.appendChild(status);
      side.appendChild(actions);

      root.appendChild(stage);
      root.appendChild(side);
      this.els = { stage: stage, wrap: wrap, canvas: canvas, hub: hub, pointer: pointer, side: side, head: head,
        legend: legend, btn: btn, status: status, bulbs: bulbs };

      if (typeof global.ResizeObserver === 'function') {
        this.ro = new global.ResizeObserver(function () { if (self.visible()) self.layout(); });
        this.ro.observe(root);
        this.ro.observe(stage);
      }
      Wheel.onChange(function (ev, data) { self.onWheelEvent(ev, data); });
    },

    layout: function () {
      var root = this.root;
      if (!root || !this.visible()) return;
      var vw = global.innerWidth || 1024, vh = global.innerHeight || 800;
      var w = root.clientWidth || vw;
      var h = root.clientHeight || (this.body && this.body.clientHeight) || vh;
      /* two candidates, the one with the bigger wheel wins:
         side-by-side — wheel left, the info column keeps a readable width (compact type on short screens);
         stacked      — info column under the wheel (portrait / square / narrow), measured in that layout */
      var compact = vh < 520 || h < 380;
      var gap = compact ? 10 : 14;
      var sideMin = compact ? 270 : (w < 900 ? 240 : 280);
      var sizeA = Math.min(h - 6, w - sideMin - gap, Math.round(w * 0.56));
      root.classList.add('is-narrow');
      root.classList.remove('is-short');
      root.style.gridTemplateColumns = '';
      this.els.stage.style.height = '';
      /* measure the info column at its natural height (a big wheel from the last layout would squeeze it) */
      this.els.wrap.style.width = this.els.wrap.style.height = '40px';
      var sideH = this.els.side.scrollHeight || this.els.side.offsetHeight || 0;
      var sizeB = Math.min(w, h - sideH - 10);
      var narrow = sizeB > sizeA * 1.06 || (sizeA < 150 && sizeB >= sizeA);
      root.classList.toggle('is-narrow', narrow);
      root.classList.toggle('is-short', !narrow && compact);
      root.classList.toggle('is-tiny', w < 360);
      if (narrow) {
        /* wheel as big as the width allows, the whole group centred vertically */
        this.els.stage.style.height = Math.max(120, Math.min(w, h - sideH - 10)) + 'px';
      } else {
        root.style.gridTemplateColumns = Math.max(120, sizeA) + 'px minmax(' + sideMin + 'px, 1fr)';
      }
      var st2 = this.els.stage, cs = global.getComputedStyle ? global.getComputedStyle(st2) : null;
      var padX = cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 0;
      var padY = cs ? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) : 0;
      var size = Math.floor(Math.min(st2.clientWidth - (padX || 0), st2.clientHeight - (padY || 0)));
      if (!(size > 40)) size = Math.floor(Math.min(w, h) * 0.8);
      this.els.wrap.style.width = size + 'px';
      this.els.wrap.style.height = size + 'px';
      this.els.wrap.style.setProperty('--ws', size + 'px');
      var dpr = Math.min(SE.Platform && SE.Platform.isMobile ? 2 : 2.5, global.devicePixelRatio || 1);
      if (size !== this.size || dpr !== this.dpr) {
        this.size = size;
        this.dpr = dpr;
        this.draw();
      }
    },

    /* ---------------- canvas (static bitmap, rotated with CSS) ---------------- */
    draw: function () {
      var self = this;
      var canvas = this.els.canvas, size = this.size, dpr = this.dpr;
      if (!(size > 0)) return;
      var px = Math.round(size * 0.86 * dpr);          /* the canvas covers the inner disc */
      canvas.width = px; canvas.height = px;
      var token = ++this.drawToken;
      var prizes = [];
      var urls = [];
      for (var i = 0; i < N; i++) {
        var p = Wheel.prizeFor(i);
        prizes.push(p);
        urls.push(p.item ? null : iconUrl(p.type === 'cash' ? SECTORS[i].icon : (p.amount >= 75 ? 'render/gems-pile' : 'render/gem')));
      }
      var loads = urls.map(function (u, k) {
        if (u) return loadImage(u);
        return thumbnail(prizes[k].item, 192).then(function (tu) { return loadImage(tu || fallbackIcon(prizes[k].item)); });
      });
      var fontReady = document.fonts && document.fonts.load ? document.fonts.load('900 40px "SE Nunito"').catch(function () {}) : Promise.resolve();
      /* draw immediately (shapes + text), again when images/fonts arrive */
      paint(null);
      Promise.all([Promise.all(loads), fontReady]).then(function (r) { if (token === self.drawToken) paint(r[0]); });

      function paint(images) {
        var g = canvas.getContext('2d');
        if (!g) return;
        var R = px / 2;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, px, px);
        g.translate(R, R);
        var lw = Math.max(2, R * 0.022);
        for (var i = 0; i < N; i++) {
          var a0 = -Math.PI / 2 + i * SEG, a1 = a0 + SEG;
          var col = SECTORS[i].color;
          var grd = g.createRadialGradient(0, 0, R * 0.12, 0, 0, R);
          grd.addColorStop(0, shade(col, 0.45));
          grd.addColorStop(0.55, col);
          grd.addColorStop(1, shade(col, -0.28));
          g.beginPath();
          g.moveTo(0, 0);
          g.arc(0, 0, R - lw * 0.5, a0, a1);
          g.closePath();
          g.fillStyle = grd;
          g.fill();
          /* inner highlight band */
          g.save();
          g.clip();
          g.beginPath();
          g.arc(0, 0, R * 0.97, a0, a1);
          g.arc(0, 0, R * 0.9, a1, a0, true);
          g.closePath();
          g.fillStyle = 'rgba(255,255,255,0.16)';
          g.fill();
          g.restore();
        }
        /* dividers */
        g.lineCap = 'round';
        for (var k = 0; k < N; k++) {
          var a = -Math.PI / 2 + k * SEG;
          g.beginPath();
          g.moveTo(Math.cos(a) * R * 0.16, Math.sin(a) * R * 0.16);
          g.lineTo(Math.cos(a) * (R - lw), Math.sin(a) * (R - lw));
          g.strokeStyle = '#2b1d0e';
          g.lineWidth = lw * 2.2;
          g.stroke();
          g.strokeStyle = '#ffd257';
          g.lineWidth = lw * 0.8;
          g.stroke();
          /* gold pin at the rim */
          g.beginPath();
          g.arc(Math.cos(a) * R * 0.93, Math.sin(a) * R * 0.93, R * 0.03, 0, TAU);
          g.fillStyle = '#ffe38a';
          g.fill();
          g.lineWidth = lw * 0.9;
          g.strokeStyle = '#2b1d0e';
          g.stroke();
        }
        g.beginPath();
        g.arc(0, 0, R - lw, 0, TAU);
        g.lineWidth = lw * 2;
        g.strokeStyle = '#2b1d0e';
        g.stroke();
        /* contents: rotate so local −y points outwards through the sector centre */
        for (var j = 0; j < N; j++) {
          var ac = -Math.PI / 2 + (j + 0.5) * SEG;
          var pr = prizes[j];
          g.save();
          g.rotate(ac + Math.PI / 2);
          var im = images && images[j];
          var isz = R * (pr.item ? 0.34 : (SECTORS[j].jackpot ? 0.36 : 0.3));
          var iy = -R * 0.66;
          if (pr.item) {
            var fr = isz * 1.08;
            roundRect(g, -fr / 2, iy - fr / 2, fr, fr, fr * 0.2);
            g.fillStyle = '#fff6dc';
            g.fill();
            g.lineWidth = lw * 1.6;
            g.strokeStyle = rarityColor(pr.rarity);
            g.stroke();
          }
          if (im) {
            var ratio = im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : 1;
            var w = ratio >= 1 ? isz : isz * ratio, h = ratio >= 1 ? isz / ratio : isz;
            g.shadowColor = 'rgba(0,0,0,0.35)';
            g.shadowOffsetY = R * 0.012;
            g.drawImage(im, -w / 2, iy - h / 2, w, h);
            g.shadowColor = 'transparent';
          }
          var label = pr.item ? t('wheel.item') : (pr.type === 'cash' ? '$' + shortNum(pr.amount) : shortNum(pr.amount));
          var fs = R * (pr.item ? 0.085 : (label.length > 4 ? 0.105 : 0.13));
          g.font = '900 ' + Math.round(fs) + 'px "SE Nunito", Nunito, "Segoe UI", Arial, sans-serif';
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          var ty = -R * 0.38;
          g.lineJoin = 'round';
          g.lineWidth = fs * 0.28;
          g.strokeStyle = '#2b1d0e';
          g.strokeText(label, 0, ty);
          g.fillStyle = pr.type === 'cash' ? '#eaffd8' : '#ffffff';
          g.fillText(label, 0, ty);
          g.restore();
        }
      }
    },

    /* ---------------- per-frame (only while open) ---------------- */
    startLoops: function () {
      var self = this;
      this.stopLoops();
      var frame = function () {
        self.raf = 0;
        if (!self.visible()) return;
        self.frame();
        self.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
      this.timer = setInterval(function () { if (self.visible()) self.sync(false); else self.stopLoops(); }, 500);
    },
    stopLoops: function () {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      if (this.timer) clearInterval(this.timer);
      this.timer = 0;
    },
    frame: function () {
      var rot = Wheel.rotationNow();
      this.els.canvas.style.transform = 'rotate(' + rot.toFixed(5) + 'rad)';
      var spinning = Wheel.isSpinning() && Wheel.progress() > 0;
      if (spinning) {
        var b = Math.floor(rot / SEG);
        if (this.lastBoundary !== null && b !== this.lastBoundary) this.tick();
        this.lastBoundary = b;
        if (Wheel.progress() >= 1) Wheel.finish();
      } else {
        this.lastBoundary = null;
      }
    },
    tick: function () {
      var now = perfNow();
      var pt = this.els.pointer;
      pt.classList.remove('is-tick');
      void pt.offsetWidth;
      pt.classList.add('is-tick');
      if (now - this.lastTick > 45) {
        this.lastTick = now;
        play('wheel_tick', { volume: 0.45, rate: 0.92 + Math.random() * 0.16 });
      }
    },

    /* ---------------- texts / button state ---------------- */
    sync: function (full) {
      var e = this.els;
      if (!e) return;
      var spinning = Wheel.isSpinning();
      var kind = Wheel.nextKind();
      var left = Wheel.adSpinsLeft();
      this.root.classList.toggle('is-spinning', spinning);
      this.root.classList.toggle('has-free', kind === 'free' && !spinning);
      if (full) {
        e.head.querySelector('.wh-title').textContent = t('wheel.headline');
        e.head.querySelector('.wh-sub').textContent = t('wheel.rules', AD_SPINS);
        this.buildLegend();
      }
      var btn = e.btn, lbl = btn.querySelector('.wh-btn-lbl');
      var statusTxt = '', statusHtml = '';
      btn.classList.remove('is-free', 'is-rw', 'is-wait');
      var ready = adReady();
      if (spinning || adBusy) {
        btn.disabled = true;
        btn.classList.add(spinning && Wheel.pending() && Wheel.pending().kind === 'ad' ? 'is-rw' : 'is-free');
        lbl.textContent = t(adBusy ? 'wheel.adWait' : 'wheel.spinning');
      } else if (kind === 'free') {
        btn.disabled = false;
        btn.classList.add('is-free');
        lbl.textContent = t('wheel.spinFree');
        statusTxt = t('wheel.adLeft', left, AD_SPINS);
      } else if (kind === 'ad') {
        btn.disabled = !ready;
        btn.classList.add('is-rw');
        lbl.textContent = t('wheel.spinAd', left, AD_SPINS);
        statusHtml = CLOCK_SVG + '<span>' + escapeHtml(t('wheel.freeIn')) + ' <b>' + clock(Wheel.timeToNextFree()) + '</b></span>';
        if (!ready) statusTxt = t('wheel.adUnavailable');
      } else {
        btn.disabled = true;
        btn.classList.add('is-wait');
        lbl.innerHTML = escapeHtml(t('wheel.freeIn')) + ' <b class="wh-btn-time">' + clock(Wheel.timeToNextFree()) + '</b>';
        statusTxt = t('wheel.noSpins');
      }
      var stEl = e.status;
      if (statusHtml) {
        stEl.innerHTML = statusHtml + (statusTxt ? '<em>' + escapeHtml(statusTxt) + '</em>' : '');
      } else stEl.textContent = statusTxt;
      e.hub.disabled = btn.disabled;
      /* the featured item / cash amounts can change (owned item, income growth, a spin bumps
         stats.spins): redraw — but never while the wheel turns or the result card is up */
      if (!spinning && !this.revealEl) {
        var sig = this.signature();
        if (sig !== this.sig) { this.sig = sig; if (!full) this.buildLegend(); if (this.size) this.draw(); }
      }
    },
    signature: function () {
      var a = [];
      for (var i = 0; i < N; i++) { var p = Wheel.prizeFor(i); a.push(p.type + ':' + p.amount + ':' + (p.item || '')); }
      return a.join('|') + '|' + (SE.I18N ? SE.I18N.lang : '');
    },
    buildLegend: function () {
      var lg = this.els.legend;
      lg.innerHTML = '';
      var order = [7, 3, 6, 5, 2, 4, 0, 1];   /* best first */
      for (var k = 0; k < order.length; k++) {
        var i = order[k], p = Wheel.prizeFor(i);
        var row = el('div', 'wh-li' + (SECTORS[i].jackpot ? ' is-jackpot' : '') + (p.item ? ' is-item' : ''));
        row.style.setProperty('--c', SECTORS[i].color);
        var ic = el('span', 'wh-li-ic');
        if (p.item) {
          ic.style.setProperty('--rc', rarityColor(p.rarity));
          var im = img(fallbackIcon(p.item), 'is-fallback');
          ic.appendChild(im);
          thumbnail(p.item, 128).then(function (im2) { return function (u) { if (u) { im2.src = u; im2.classList.remove('is-fallback'); } }; }(im));
        } else {
          ic.appendChild(img(iconUrl(p.type === 'cash' ? SECTORS[i].icon : (p.amount >= 75 ? 'render/gems-pile' : 'render/gem'))));
        }
        row.appendChild(ic);
        var tx = el('span', 'wh-li-tx');
        if (p.item) tx.textContent = itemName(p.item);
        else if (p.type === 'cash') tx.textContent = '$' + shortNum(p.amount);
        else tx.innerHTML = shortNum(p.amount) + ' <i class="wh-gem-i"></i>';
        row.appendChild(tx);
        lg.appendChild(row);
      }
    },

    onSpin: function () {
      if (Wheel.isSpinning() || adBusy) return;
      var kind = Wheel.nextKind();
      if (!kind) { play('error'); return; }
      play('click');
      this.hideReveal(true);
      var ok = Wheel.spin(kind);
      if (!ok) { play('error'); if (kind === 'ad') ui('toast', t('wheel.adUnavailable'), 'error'); }
      this.sync(false);
    },

    onWheelEvent: function (ev, data) {
      if (!this.visible()) return;
      if (ev === 'start' || ev === 'spin' || ev === 'ad') {
        if (ev === 'spin') play('whoosh', { volume: 0.5 });
        this.sync(false);
      } else if (ev === 'result') {
        this.els.canvas.style.transform = 'rotate(' + Wheel.rotationNow().toFixed(5) + 'rad)';
        if (data && data.result) this.reveal(data.result);     /* first: keeps the won item drawn under the card */
        this.sync(false);
      }
    },

    /* ---------------- result card ---------------- */
    reveal: function (res) {
      var self = this, root = this.root;
      this.hideReveal(true);
      var jackpot = !!(SECTORS[res.sector] && SECTORS[res.sector].jackpot);
      play('wheel_win', { volume: 0.85 });
      setTimeout(function () { play(res.item ? 'unlock' : (res.cash ? 'coin' : 'gem')); }, 220);
      var rv = el('div', 'wh-reveal');
      var card = el('div', 'wh-reveal-card' + (jackpot ? ' is-jackpot' : '') + (res.item ? ' is-item' : ''));
      card.appendChild(el('div', 'wh-reveal-rays'));
      var title = el('div', 'wh-reveal-title');
      title.textContent = t(jackpot ? 'wheel.jackpot' : 'wheel.won');
      card.appendChild(title);
      var art = el('div', 'wh-reveal-art');
      var im;
      if (res.item) {
        im = img(fallbackIcon(res.item), 'wh-reveal-img is-fallback');
        thumbnail(res.item, 256).then(function (u) { if (u) { im.src = u; im.classList.remove('is-fallback'); } });
      } else {
        im = img(iconUrl(res.cash ? SECTORS[res.sector].icon || 'banknotes' : (res.gems >= 75 ? 'render/gems-pile' : 'render/gem')), 'wh-reveal-img');
      }
      art.appendChild(im);
      card.appendChild(art);
      var amt = el('div', 'wh-reveal-amt');
      if (res.item) amt.textContent = itemName(res.item);
      else if (res.cash) amt.innerHTML = '<span class="wh-cash">+$' + shortNum(res.cash) + '</span>';
      else amt.innerHTML = '<span class="wh-gems">+' + shortNum(res.gems) + ' <i class="wh-gem-i"></i></span>';
      card.appendChild(amt);
      if (res.item) {
        var hint = el('div', 'wh-reveal-hint');
        hint.textContent = t('wheel.equipHint');
        card.appendChild(hint);
      } else if (res.fallback) {
        var fb = el('div', 'wh-reveal-hint');
        fb.textContent = t('wheel.ownedFallback');
        card.appendChild(fb);
      }
      var ok = el('button', 'wh-btn is-free wh-reveal-ok');
      ok.type = 'button';
      ok.innerHTML = '<span class="wh-btn-lbl"></span>';
      ok.querySelector('.wh-btn-lbl').textContent = t('wheel.great');
      card.appendChild(ok);
      rv.appendChild(card);
      root.appendChild(rv);
      this.revealEl = rv;
      ok.addEventListener('click', function (ev) { ev.stopPropagation(); play('click'); self.hideReveal(false); self.sync(false); });
      rv.addEventListener('click', function (ev) { if (ev.target === rv) { self.hideReveal(false); self.sync(false); } });
      requestAnimationFrame(function () {
        rv.classList.add('is-in');
        if (SE.RewardFX && SE.RewardFX.burst) {
          var rr = root.getBoundingClientRect(), ar = art.getBoundingClientRect();
          SE.RewardFX.burst(root, { x: ar.left - rr.left + ar.width / 2, y: ar.top - rr.top + ar.height / 2,
            count: jackpot || res.item ? 120 : 75,
            colors: jackpot ? ['#ffd257', '#fff1b8', '#e0a400', '#ffffff', '#8a5cff'] : undefined });
        }
      });
    },
    hideReveal: function (instant) {
      var rv = this.revealEl;
      this.revealEl = null;
      if (!rv || !rv.parentNode) return;
      if (instant) { rv.parentNode.removeChild(rv); return; }
      rv.classList.add('is-out');
      setTimeout(function () { if (rv.parentNode) rv.parentNode.removeChild(rv); }, 220);
    }
  };

  function shade(hex, k) {
    var c = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!c) return hex;
    var n = parseInt(c[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    function f(v) { return Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k)); }
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  Wheel._panel = panel;

  if (SE.I18N && typeof SE.I18N.onChange === 'function') {
    SE.I18N.onChange(function () { if (panel.visible()) { panel.sig = null; panel.sync(true); } });
  }
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('resize', function () { if (panel.visible()) panel.layout(); });
  }

  /* ---------------------------------------------------------------------- */
  /* Strings                                                                 */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) SE.I18N.add({
    ru: {
      'wheel.title': 'Колесо фортуны',
      'wheel.headline': 'Крути колесо — забирай призы!',
      'wheel.rules': '1 бесплатное вращение в день и ещё {0} за рекламу',
      'wheel.spinFree': 'Крутить бесплатно',
      'wheel.spinAd': 'Крутить за рекламу ({0}/{1})',
      'wheel.spinning': 'Крутится…',
      'wheel.adWait': 'Реклама…',
      'wheel.freeIn': 'Бесплатно через',
      'wheel.adLeft': 'За рекламу сегодня: {0}/{1}',
      'wheel.noSpins': 'Вращения на сегодня закончились — приходи завтра!',
      'wheel.adUnavailable': 'Реклама сейчас недоступна',
      'wheel.item': 'ПРЕДМЕТ',
      'wheel.gems': 'самоцв.',
      'wheel.won': 'Твой приз!',
      'wheel.jackpot': 'ДЖЕКПОТ!',
      'wheel.great': 'Отлично!',
      'wheel.equipHint': 'Новая вещь — надень её в магазине',
      'wheel.ownedFallback': 'Вещь уже есть — вместо неё самоцветы',
      'wheel.wonToast': 'Приз колеса: {0}',
      'wheel.ready': 'Бесплатное вращение!'
    },
    en: {
      'wheel.title': 'Wheel of Fortune',
      'wheel.headline': 'Spin the wheel, win prizes!',
      'wheel.rules': '1 free spin every day plus {0} more for watching ads',
      'wheel.spinFree': 'Spin for free',
      'wheel.spinAd': 'Spin · Watch ad ({0}/{1})',
      'wheel.spinning': 'Spinning…',
      'wheel.adWait': 'Ad…',
      'wheel.freeIn': 'Free spin in',
      'wheel.adLeft': 'Ad spins today: {0}/{1}',
      'wheel.noSpins': 'No spins left today — come back tomorrow!',
      'wheel.adUnavailable': 'Ads are not available right now',
      'wheel.item': 'ITEM',
      'wheel.gems': 'gems',
      'wheel.won': 'You won!',
      'wheel.jackpot': 'JACKPOT!',
      'wheel.great': 'Awesome!',
      'wheel.equipHint': 'New item — equip it in the shop',
      'wheel.ownedFallback': 'You already own it — gems instead',
      'wheel.wonToast': 'Wheel prize: {0}',
      'wheel.ready': 'Free spin!'
    },
    tr: {
      'wheel.title': 'Şans Çarkı',
      'wheel.headline': 'Çarkı çevir, ödülleri kap!',
      'wheel.rules': 'Her gün 1 ücretsiz çevirme ve reklamla {0} tane daha',
      'wheel.spinFree': 'Ücretsiz çevir',
      'wheel.spinAd': 'Reklamla çevir ({0}/{1})',
      'wheel.spinning': 'Dönüyor…',
      'wheel.adWait': 'Reklam…',
      'wheel.freeIn': 'Ücretsiz çevirme',
      'wheel.adLeft': 'Bugün reklamla: {0}/{1}',
      'wheel.noSpins': 'Bugünlük çevirme hakkın bitti — yarın gel!',
      'wheel.adUnavailable': 'Reklam şu anda kullanılamıyor',
      'wheel.item': 'EŞYA',
      'wheel.gems': 'mücevher',
      'wheel.won': 'Ödülün!',
      'wheel.jackpot': 'BÜYÜK İKRAMİYE!',
      'wheel.great': 'Harika!',
      'wheel.equipHint': 'Yeni eşya — mağazadan kuşan',
      'wheel.ownedFallback': 'Bu eşya zaten sende — yerine mücevher',
      'wheel.wonToast': 'Çark ödülü: {0}',
      'wheel.ready': 'Ücretsiz çevirme!'
    }
  });

  SE.Wheel = Wheel;

  if (!Wheel.registerPanel()) {
    var tries = 0;
    var retry = function () {
      if (Wheel.registerPanel() || ++tries > 40) return;
      setTimeout(retry, 250);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retry);
    else setTimeout(retry, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
