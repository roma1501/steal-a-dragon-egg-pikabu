/* =========================================================================
   Steal a Dragon Egg — Daily Gift: logic (SE.Daily) + UI panel 'daily'
   (docs/SPEC.md §7–§8, §10; skill «Магазин, Daily Gift и колесо фортуны»)

   Rules
   - 7-day track, ONE claim per device calendar day (SE.State.todayKey()).
     Missed days never reset the track: the next visit opens the next day.
     A device clock moved back by ≥ 2 days (clock corrected) re-opens the gift;
     moving it back by 1 day does not (no double claim around midnight/time zones).
   - State: SE.State.data.daily = { day: next index 0..6, cycle, lastDate }.
     Claiming day 7 (index 6) starts the next cycle (cycle + 1, day 0).
     stats.gifts counts claims. Every claim is saved immediately.
   - Rewards (TRACK below, index 0 = "Day 1"):
       D1 30 gems · D2 cash = State.cashBonusAmount(1) · D3 60 gems ·
       D4 a shop item (rare/common, tab rotates per cycle) + 20 gems ·
       D5 100 gems + cash ×1.5 · D6 a rare (else epic/legendary) Back or Hat item + 40 gems ·
       D7 the cycle's exclusive outfit (SE.CosmeticData.EXCLUSIVE_DAILY[cycle]).
     Items are chosen deterministically per cycle among the not-yet-owned shop
     items (never exclusives), so the card shows exactly what will be granted;
     with nothing left to give: D4 → 80 gems, D6 → 150 gems, D7 → 500 gems
     (all exclusives collected / already owned).
   - "x2 for ad" (rewarded placement 'daily-x2') doubles the gems/cash of days
     1–6 (items are never doubled; no x2 on day 7). The base reward is always
     claimable without an ad; x2 is applied only after the SDK confirmed it.
   - claim() is synchronous and guarded against double clicks and re-entry.

   API
     SE.Daily.canClaim() -> bool
     SE.Daily.dayIndex() -> 0..6                 next day to claim (Day 1 = 0)
     SE.Daily.cycle() -> n                       0-based week number
     SE.Daily.rewardFor(index, cycle) -> reward  { index, day, kind, gems, cash, item,
                                                   itemTab, rarity, exclusive, fallback, x2, big }
     SE.Daily.claim(mult = 1) -> result|null     mult 2 only when reward.x2
                                                 result { index, day, cycle, mult, gems, cash, item, reward }
     SE.Daily.claimX2(onDone(result|null)) -> bool   rewarded ad then claim(2) (once, on confirmation)
     SE.Daily.timeToNext() -> seconds            0 when claimable, else until local midnight
     SE.Daily.maybeAutoOpen(game) -> bool        SE.Game calls it every frame (cheap). Opens the
                                                 panel once per session when: tutorialDone already
                                                 at the start of this session ("later visit"),
                                                 gift claimable, tutorial inactive, no panel open,
                                                 not paused, not carrying, not chased, in the base
                                                 safe zone, all of it for 1.5 s in a row.
     SE.Daily.open(data) / SE.Daily.registerPanel()   (the panel registers itself when SE.UI exists)
     SE.Daily.onChange(fn)                       fn(result) after every claim (HUD badges etc.)
     SE.Daily.TRACK, SE.Daily.thumbnail(itemId, size) -> Promise<url|null>, SE.Daily.iconUrl(name)
   Panel 'daily' (SE.UI.registerPanel, size 'l'): 6 day cards + day-7 showcase, «Забрать» /
   «x2 За рекламу», countdown when claimed, celebration on claim. Styles: css/daily.css (.dg-*).

   SE.RewardFX.burst(host, opts) — tiny 2D confetti / sparkle burst (canvas overlay inside
   `host`, auto-removed, ≤ 140 particles). Shared with ui/wheel.js.
     opts { x, y (px in host, default centre), count = 70, colors:[…], spread = 1, power = 1 }
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  /* ---------------------------------------------------------------------- */
  /* Data                                                                    */
  /* ---------------------------------------------------------------------- */
  var TRACK = [
    { kind: 'gems', gems: 30 },
    { kind: 'cash', cashMult: 1 },
    { kind: 'gems', gems: 60 },
    { kind: 'item', bonusGems: 20, fallbackGems: 80, rarities: ['rare', 'common'],
      tabs: ['trail', 'hat', 'victory', 'back', 'outfit'], salt: 4 },
    { kind: 'combo', gems: 100, cashMult: 1.5 },
    { kind: 'item', bonusGems: 40, fallbackGems: 150, rarities: ['rare', 'epic', 'legendary'],
      tabs: ['back', 'hat'], salt: 6 },
    { kind: 'exclusive', fallbackGems: 500 }
  ];
  var AUTO_SETTLE_MS = 1500;
  var RARITY_COLORS = { common: '#4f9a2a', uncommon: '#2f8a4a', rare: '#d0781a', epic: '#7b3fd0', legendary: '#e0a400' };
  var TAB_ICONS = { outfit: 'star', hat: 'render/crown', back: 'bag', trail: 'trail-rainbow', victory: 'sparkles' };
  /* Day-7 showcase tint per exclusive (index = cycle) — matches the four exclusive outfits. */
  var SHOWCASE_TINTS = [
    ['#2f6b1e', '#86c93a'],   /* dragon knight — meadow green */
    ['#1d4f8f', '#7fd0ff'],   /* frost warden  — ice blue */
    ['#7a1f0e', '#ff8a2a'],   /* ember lord    — lava */
    ['#2a2f7a', '#ffd257']    /* aurora paladin — night blue & gold */
  ];

  /* Game root (folder containing js/ui/daily.js) for the UI images. */
  var BASE = '';
  try {
    var src = document.currentScript && document.currentScript.src;
    var m = src && /^(.*\/)js\/ui\/daily\.js(?:[?#].*)?$/.exec(src);
    if (m) BASE = m[1];
  } catch (e) { BASE = ''; }

  /* ---------------------------------------------------------------------- */
  /* Small helpers                                                           */
  /* ---------------------------------------------------------------------- */
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function st() { return SE.State && SE.State.data ? SE.State.data : null; }
  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function today() { return SE.State && SE.State.todayKey ? SE.State.todayKey() : ''; }
  function nowMs() { return SE.State && typeof SE.State.now === 'function' ? SE.State.now() : Date.now(); }
  function perfNow() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function play(key, opts) {
    try { if (SE.Audio && typeof SE.Audio.play === 'function') SE.Audio.play(key, opts || {}); } catch (e) { /* audio is optional */ }
  }
  function ui(fn) {
    var U = SE.UI;
    if (!U || typeof U[fn] !== 'function') return undefined;
    try { return U[fn].apply(U, Array.prototype.slice.call(arguments, 1)); } catch (e) { console.error(e); return undefined; }
  }
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
  function cashText(n) { return '$' + shortNum(n); }
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
  /* Cosmetic rarities first (common/rare/epic/legendary), dragon rarities as a fallback. */
  function rarityColor(r) {
    var mods = [SE.CosmeticData, SE.DragonData];
    for (var i = 0; i < mods.length; i++) {
      var M = mods[i];
      if (M && typeof M.rarityColor === 'function') {
        try { var c = M.rarityColor(r); if (c && c !== '#888888') return c; } catch (e) { /* next */ }
      }
    }
    return RARITY_COLORS[r] || RARITY_COLORS.common;
  }
  function rarityName(r) {
    var mods = [SE.CosmeticData, SE.DragonData];
    for (var i = 0; i < mods.length; i++) {
      var M = mods[i];
      if (M && typeof M.rarityName === 'function') {
        try { var n = M.rarityName(r); if (n) return n; } catch (e) { /* next */ }
      }
    }
    return r || '';
  }

  /* ---------------------------------------------------------------------- */
  /* Cosmetic data access (SE.CosmeticData may load later / be missing)      */
  /* ---------------------------------------------------------------------- */
  function cosData() { return SE.CosmeticData || null; }
  function exclusives() {
    var C = cosData();
    return C && Array.isArray(C.EXCLUSIVE_DAILY) ? C.EXCLUSIVE_DAILY : [];
  }
  function allItems() {
    var C = cosData();
    if (!C) return [];
    var list = null;
    try {
      if (Array.isArray(C.ITEMS)) list = C.ITEMS;
      else if (typeof C.items === 'function') list = C.items();
      else if (Array.isArray(C.items)) list = C.items;
    } catch (e) { list = null; }
    return Array.isArray(list) ? list : [];
  }
  /* Non-exclusive items sold in the shop (never the Daily exclusives, never the default outfit). */
  function shopItems() {
    var C = cosData(), list = null;
    if (C && typeof C.wheelPool === 'function') {
      try { list = C.wheelPool(); } catch (e) { list = null; }
    }
    if (!Array.isArray(list) && C && typeof C.shopItems === 'function' && Array.isArray(C.TABS)) {
      list = [];
      try { C.TABS.forEach(function (tb) { list = list.concat(C.shopItems(tb.id) || []); }); } catch (e) { list = null; }
    }
    if (!Array.isArray(list)) list = allItems();
    var ex = exclusives();
    return list.filter(function (it) {
      return it && typeof it.id === 'string' && !it.exclusive && !it.isDefault && ex.indexOf(it.id) < 0 && it.price;
    });
  }
  function itemDef(id) {
    var C = cosData();
    if (C && typeof C.item === 'function') {
      try { var it = C.item(id); if (it) return it; } catch (e) { /* fall through */ }
    }
    var all = allItems();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }
  function itemName(id) {
    var C = cosData();
    if (C && typeof C.name === 'function') {
      try { var n = C.name(id); if (n) return n; } catch (e) { /* fall through */ }
    }
    var it = itemDef(id);
    var lang = (SE.I18N && SE.I18N.lang) || 'en';
    if (it && it.names) return it.names[lang] || it.names.en || id;
    return id;
  }
  function owns(id) { return !!(SE.State && typeof SE.State.owns === 'function' && SE.State.owns(id)); }

  /* Deterministic pick for cycle `cycle`: first rarity with unowned candidates, tabs rotated per cycle. */
  function pickTrackItem(cfg, cycle) {
    var items = shopItems();
    if (!items.length) return null;
    var tabs = cfg.tabs || [];
    var start = tabs.length ? cycle % tabs.length : 0;
    for (var r = 0; r < cfg.rarities.length; r++) {
      for (var k = 0; k < Math.max(1, tabs.length); k++) {
        var tab = tabs.length ? tabs[(start + k) % tabs.length] : null;
        var cands = items.filter(function (it) {
          return it.rarity === cfg.rarities[r] && (!tab || it.tab === tab) && !owns(it.id);
        }).sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
        if (cands.length) return cands[hash('daily|' + cfg.salt + '|' + cycle) % cands.length];
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Thumbnails (SE.Cosmetics.thumbnail, cached; null when unavailable)      */
  /* ---------------------------------------------------------------------- */
  var thumbCache = {};
  function thumbnail(id, size) {
    size = size || 256;
    var key = id + '@' + size;
    if (hasOwn(thumbCache, key)) return thumbCache[key];
    var p;
    var Cos = SE.Cosmetics;
    if (!id || !Cos || typeof Cos.thumbnail !== 'function') {
      p = Promise.resolve(null);
      return p;                       /* not cached: the module may appear later */
    }
    try {
      p = Promise.resolve(Cos.thumbnail(id, size)).then(function (url) {
        return typeof url === 'string' && url ? url : null;
      }, function () { return null; });
    } catch (e) { p = Promise.resolve(null); }
    thumbCache[key] = p;
    return p;
  }
  function fallbackIcon(tab) { return iconUrl(TAB_ICONS[tab] || 'star'); }

  /* ---------------------------------------------------------------------- */
  /* Ads (SE.Ads.rewarded per SPEC; falls back to SE.Platform)               */
  /* ---------------------------------------------------------------------- */
  function adReady(placement) {
    if (SE.Config && SE.Config.ADS === false) return false;
    if (SE.Ads && typeof SE.Ads.ready === 'function') {
      try { return !!SE.Ads.ready(placement); } catch (e) { return false; }
    }
    try { return !!(SE.Platform && SE.Platform.canRewarded && SE.Platform.canRewarded()); } catch (e) { return false; }
  }
  /* onGranted runs at most once, only after the SDK confirmed the reward. */
  function showRewarded(placement, onGranted, onDone) {
    var granted = false, finished = false;
    function grant() { if (granted) return; granted = true; try { onGranted(); } catch (e) { console.error(e); } }
    function done(ok) {
      if (finished) return;
      finished = true;
      if (ok === true && !granted) grant();
      if (onDone) { try { onDone(granted); } catch (e) { console.error(e); } }
    }
    try {
      if (SE.Ads && typeof SE.Ads.rewarded === 'function') { SE.Ads.rewarded(placement, grant, done); return; }
      if (SE.Platform && typeof SE.Platform.showRewarded === 'function' && SE.Platform.canRewarded()) {
        SE.Platform.showRewarded(placement, grant, done);
        return;
      }
    } catch (e) { console.error(e); }
    setTimeout(function () { done(false); }, 0);
  }

  /* ---------------------------------------------------------------------- */
  /* SE.RewardFX — tiny canvas confetti/sparkle burst (shared with wheel.js)  */
  /* ---------------------------------------------------------------------- */
  var RewardFX = SE.RewardFX || {
    burst: function (host, opts) {
      if (!host || !host.getBoundingClientRect) return;
      opts = opts || {};
      var rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      var reduce = false;
      try { reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { reduce = false; }
      var mobile = !!(SE.Platform && SE.Platform.isMobile);
      var count = Math.min(140, Math.round((opts.count || 70) * (reduce ? 0.3 : 1) * (mobile ? 0.7 : 1)));
      var dpr = Math.min(2, global.devicePixelRatio || 1);
      var cv = document.createElement('canvas');
      cv.className = 'se-rfx';
      cv.width = Math.round(rect.width * dpr);
      cv.height = Math.round(rect.height * dpr);
      cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:30;';
      host.appendChild(cv);
      var g = cv.getContext('2d');
      if (!g) { host.removeChild(cv); return; }
      var cx = finite(opts.x) ? opts.x : rect.width / 2, cy = finite(opts.y) ? opts.y : rect.height / 2;
      var colors = opts.colors || ['#ffd257', '#ff6b6b', '#6fd0ff', '#8ee05a', '#c58bff', '#ffffff'];
      var power = (opts.power || 1) * Math.min(1.4, Math.max(0.7, rect.width / 600));
      var parts = [];
      for (var i = 0; i < count; i++) {
        var a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6 * (opts.spread || 1);
        var sp = (260 + Math.random() * 520) * power;
        parts.push({
          x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14,
          w: 6 + Math.random() * 7, h: 4 + Math.random() * 5,
          star: Math.random() < 0.28, life: 1.1 + Math.random() * 0.9, age: 0,
          c: colors[(Math.random() * colors.length) | 0]
        });
      }
      var last = perfNow(), alive = true;
      function star(x, y, r) {
        g.beginPath();
        for (var k = 0; k < 8; k++) {
          var rr = k % 2 ? r * 0.38 : r, aa = k * Math.PI / 4;
          g.lineTo(x + Math.cos(aa) * rr, y + Math.sin(aa) * rr);
        }
        g.closePath();
        g.fill();
      }
      function frame() {
        if (!alive) return;
        var now = perfNow(), dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, rect.width, rect.height);
        var any = false;
        for (var j = 0; j < parts.length; j++) {
          var p = parts[j];
          p.age += dt;
          if (p.age >= p.life) continue;
          any = true;
          p.vx *= Math.pow(0.18, dt);
          p.vy = p.vy * Math.pow(0.3, dt) + 900 * dt * 0.6;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.rot += p.vr * dt;
          var k2 = 1 - p.age / p.life;
          g.globalAlpha = Math.min(1, k2 * 2.2);
          g.fillStyle = p.c;
          if (p.star) {
            star(p.x, p.y, p.w * 0.9 * (0.6 + 0.4 * Math.sin(p.age * 18)));
          } else {
            g.save();
            g.translate(p.x, p.y);
            g.rotate(p.rot);
            g.scale(1, Math.abs(Math.cos(p.rot * 1.3)) * 0.8 + 0.2);
            g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            g.restore();
          }
        }
        if (any && cv.isConnected) requestAnimationFrame(frame);
        else { alive = false; if (cv.parentNode) cv.parentNode.removeChild(cv); }
      }
      requestAnimationFrame(frame);
      setTimeout(function () { alive = false; if (cv.parentNode) cv.parentNode.removeChild(cv); }, 2600);
    }
  };
  SE.RewardFX = RewardFX;

  /* ---------------------------------------------------------------------- */
  /* SE.Daily logic                                                          */
  /* ---------------------------------------------------------------------- */
  var claiming = false;        /* re-entry guard */
  var adBusy = false;          /* a 'daily-x2' ad is running */
  var listeners = [];
  var auto = { shown: false, startDone: null, calmSince: 0 };

  function playerPos(game) {
    var p = null;
    try {
      var pl = (game && game.player) || SE.Player;
      if (pl) p = pl.pos || (pl.group && pl.group.position) || pl.position || null;
    } catch (e) { p = null; }
    return p && finite(p.x) && finite(p.z) ? p : null;
  }
  function atBase(game) {
    if (game) {
      if (typeof game.atBase === 'function') { try { return !!game.atBase(); } catch (e) { return false; } }
      if (typeof game.atBase === 'boolean') return game.atBase;
      if (typeof game.inSafeZone === 'boolean') return game.inSafeZone;
    }
    var p = playerPos(game);
    if (p && SE.World && typeof SE.World.inSafeZone === 'function') {
      try { return !!SE.World.inSafeZone(p.x, p.z); } catch (e) { return false; }
    }
    return !p;   /* no world/player (menu, lab) → treat as safe */
  }

  var Daily = {
    TRACK: TRACK,
    iconUrl: iconUrl,
    thumbnail: thumbnail,

    canClaim: function () {
      var s = st();
      if (!s || !s.daily) return false;
      var last = s.daily.lastDate, now = today();
      if (!now) return false;
      if (!last) return true;
      if (last === now) return false;
      var diff = SE.State.dayDiff ? SE.State.dayDiff(last, now) : NaN;
      if (!finite(diff)) return true;
      return diff >= 1 || diff <= -2;
    },

    dayIndex: function () {
      var s = st();
      var d = s && s.daily ? s.daily.day : 0;
      return finite(d) && d >= 0 && d <= 6 ? Math.floor(d) : 0;
    },

    cycle: function () {
      var s = st();
      var c = s && s.daily ? s.daily.cycle : 0;
      return finite(c) && c >= 0 ? Math.floor(c) : 0;
    },

    /* index 0..6 (Day 1..7), cycle ≥ 0. Pure apart from reading owned cosmetics and cash scale. */
    rewardFor: function (index, cycle) {
      index = Math.max(0, Math.min(6, Math.floor(finite(index) ? index : this.dayIndex())));
      cycle = Math.max(0, Math.floor(finite(cycle) ? cycle : this.cycle()));
      var cfg = TRACK[index];
      var r = { index: index, day: index + 1, cycle: cycle, kind: cfg.kind, gems: 0, cash: 0, item: null,
        itemTab: null, rarity: null, exclusive: false, fallback: false, x2: index < 6, big: index === 6 };
      var cash = function (mult) {
        var v = SE.State && typeof SE.State.cashBonusAmount === 'function' ? SE.State.cashBonusAmount(mult) : 300 * mult;
        return finite(v) ? Math.max(0, Math.round(v)) : 0;
      };
      if (cfg.kind === 'gems') r.gems = cfg.gems;
      else if (cfg.kind === 'cash') r.cash = cash(cfg.cashMult);
      else if (cfg.kind === 'combo') { r.gems = cfg.gems; r.cash = cash(cfg.cashMult); }
      else if (cfg.kind === 'item') {
        var it = pickTrackItem(cfg, cycle);
        if (it) {
          r.item = it.id; r.itemTab = it.tab || null; r.rarity = it.rarity || 'common'; r.gems = cfg.bonusGems;
        } else {
          r.kind = 'gems'; r.gems = cfg.fallbackGems; r.fallback = true;
        }
      } else if (cfg.kind === 'exclusive') {
        var ex = exclusives();
        var id = cycle < ex.length ? ex[cycle] : null;
        if (id && !owns(id)) {
          var def = itemDef(id);
          r.item = id; r.exclusive = true; r.itemTab = (def && def.tab) || 'outfit';
          r.rarity = (def && def.rarity) || 'legendary';
        } else {
          r.kind = 'gems'; r.gems = cfg.fallbackGems; r.fallback = true;
        }
      }
      return r;
    },

    /* Grants today's reward once. mult 2 only for x2 days. Returns the result or null. */
    claim: function (mult) {
      if (claiming || !this.canClaim()) return null;
      var s = st();
      if (!s) return null;
      claiming = true;
      try {
        var index = this.dayIndex(), cycle = this.cycle();
        var r = this.rewardFor(index, cycle);
        var m = mult === 2 && r.x2 ? 2 : 1;
        var res = { index: index, day: index + 1, cycle: cycle, mult: m, gems: r.gems * m, cash: r.cash * m,
          item: null, exclusive: r.exclusive, reward: r };
        if (r.item) {
          if (SE.State.grantItem(r.item)) res.item = r.item;
          else res.gems += TRACK[index].fallbackGems * (r.exclusive ? 1 : m);  /* owned meanwhile → gems */
        }
        /* Mark the day first: even if a grant throws, the claim cannot repeat. */
        s.daily.lastDate = today();
        s.daily.day = (index + 1) % 7;
        if (index === 6) s.daily.cycle = cycle + 1;
        if (s.stats) s.stats.gifts = (s.stats.gifts || 0) + 1;
        if (res.gems > 0) SE.State.addGems(res.gems);
        if (res.cash > 0) SE.State.addMoney(res.cash);
        try { SE.State.save(); } catch (e) { console.error(e); }
        ui('updateHUD');
        var list = listeners.slice();
        for (var i = 0; i < list.length; i++) { try { list[i](res); } catch (e) { console.error(e); } }
        return res;
      } finally {
        claiming = false;
      }
    },

    /* Rewarded 'daily-x2' → claim(2) once on SDK confirmation. Returns false when not started. */
    claimX2: function (onDone) {
      var self = this;
      if (adBusy || claiming || !this.canClaim()) return false;
      if (!this.rewardFor(this.dayIndex(), this.cycle()).x2) return false;
      if (!adReady('daily-x2')) return false;
      adBusy = true;
      var result = null;
      showRewarded('daily-x2', function () {
        result = self.claim(2);
      }, function (granted) {
        adBusy = false;
        if (onDone) onDone(granted ? result : null);
      });
      return true;
    },

    adBusy: function () { return adBusy; },
    adReady: function () { return adReady('daily-x2'); },

    timeToNext: function () {
      if (this.canClaim()) return 0;
      var now = nowMs(), d = new Date(now);
      var next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
      return Math.max(0, (next - now) / 1000);
    },

    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },

    maybeAutoOpen: function (game) {
      if (auto.shown) return false;
      var s = st();
      if (!s) return false;
      if (auto.startDone === null) auto.startDone = s.tutorialDone === true;   /* first call = session start */
      var ok = auto.startDone && s.tutorialDone === true && this.canClaim() && !adBusy;
      if (ok && SE.Tutorial && typeof SE.Tutorial.isActive === 'function') { try { ok = !SE.Tutorial.isActive(); } catch (e) { ok = false; } }
      if (ok && SE.UI && typeof SE.UI.isOpen === 'function') { try { ok = !SE.UI.isOpen(); } catch (e) { ok = false; } }
      if (ok && game) ok = !game.carrying && !game.paused;
      if (ok && SE.DragonAI && typeof SE.DragonAI.anyChasing === 'function') { try { ok = !SE.DragonAI.anyChasing('player'); } catch (e) { ok = false; } }
      if (ok) ok = atBase(game);
      if (!ok) { auto.calmSince = 0; return false; }
      var now = perfNow();
      if (!auto.calmSince) { auto.calmSince = now; return false; }
      if (now - auto.calmSince < AUTO_SETTLE_MS) return false;
      auto.shown = true;
      this.open({ auto: true });
      return true;
    },

    open: function (data) {
      this.registerPanel();
      if (SE.UI && typeof SE.UI.open === 'function') SE.UI.open('daily', data || {});
    },

    registerPanel: function () {
      var U = SE.UI;
      if (!U || typeof U.registerPanel !== 'function' || panel.registeredWith === U) return false;
      panel.registeredWith = U;
      U.registerPanel('daily', {
        titleKey: 'daily.title', icon: 'gift', size: 'l',
        render: function (body, data, p) { panel.render(body, data, p); },
        onOpen: function (data) { auto.shown = true; panel.onOpen(data); },
        onClose: function () { panel.onClose(); }
      });
      return true;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Panel 'daily'                                                           */
  /* ---------------------------------------------------------------------- */
  var CHECK_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="#3fae2a" stroke="#1b3d0f" stroke-width="4"/>' +
    '<path d="M13.5 24.5l7 7 14-15" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CLOCK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#fff6e0" stroke="#2b1d0e" stroke-width="2.6"/>' +
    '<path d="M12 6.5V12l3.6 2.4" fill="none" stroke="#2b1d0e" stroke-width="2.6" stroke-linecap="round"/></svg>';

  var panel = {
    registeredWith: null,
    root: null,
    body: null,
    timer: 0,
    lastClaimable: null,
    justClaimed: -1,          /* index whose card plays the stamp animation */
    busyClick: false,

    render: function (body, data) {
      this.body = body;
      if (!this.root) {
        this.root = el('div', 'dg');
        this.root.setAttribute('data-panel', 'daily');
      }
      body.innerHTML = '';
      body.appendChild(this.root);
      this.build();
      this.observe();
      this.startTimer();
    },

    onOpen: function () {
      play('gift_open', { volume: 0.7 });
    },

    onClose: function () {
      this.stopTimer();
      var rv = this.root && this.root.querySelector('.dg-reveal');
      if (rv && rv.parentNode) rv.parentNode.removeChild(rv);
    },

    startTimer: function () {
      var self = this;
      this.stopTimer();
      this.lastClaimable = Daily.canClaim();
      this.timer = setInterval(function () { self.tick(); }, 1000);
    },
    stopTimer: function () { if (this.timer) { clearInterval(this.timer); this.timer = 0; } },

    tick: function () {
      if (!this.root || !this.root.isConnected) { this.stopTimer(); return; }
      var can = Daily.canClaim();
      if (can !== this.lastClaimable) { this.lastClaimable = can; this.build(); return; }
      var cd = this.root.querySelector('.dg-wait-time');
      if (cd) cd.textContent = SE.I18N ? SE.I18N.clock(Daily.timeToNext()) : String(Math.ceil(Daily.timeToNext()));
      var x2 = this.root.querySelector('.dg-x2');
      if (x2 && !Daily.adBusy()) this.syncAdButton(x2);
    },

    /* Layout classes from the panel BODY size (falls back to the viewport). */
    layout: function () {
      if (!this.root) return;
      var vw = global.innerWidth || 1024, vh = global.innerHeight || 800;
      var w = this.root.clientWidth || (this.body && this.body.clientWidth) || vw;
      var h = (this.body && this.body.clientHeight) || this.root.clientHeight || vh;
      this.root.classList.toggle('is-narrow', w < 560);
      this.root.classList.toggle('is-short', vh < 520 || (h > 0 && h < 380 && w >= 560));
      this.root.classList.toggle('is-tiny', w < 360);
    },
    observe: function () {
      var self = this;
      if (this.ro || typeof global.ResizeObserver !== 'function' || !this.root) return;
      this.ro = new global.ResizeObserver(function () { if (self.root && self.root.isConnected) self.layout(); });
      this.ro.observe(this.root);
    },

    build: function () {
      var root = this.root;
      if (!root) return;
      root.innerHTML = '';
      root.classList.toggle('is-busy', Daily.adBusy());
      this.busyClick = false;
      this.layout();
      var can = Daily.canClaim();
      var day = Daily.dayIndex(), cycle = Daily.cycle();

      /* header line */
      var head = el('div', 'dg-head');
      var sub = el('div', 'dg-sub');
      sub.textContent = t('daily.subtitle');
      var note = el('div', 'dg-note');
      note.textContent = t('daily.note');
      var txt = el('div', 'dg-head-text');
      txt.appendChild(sub);
      txt.appendChild(note);
      head.appendChild(txt);
      var chip = el('div', 'dg-week');
      chip.textContent = t('daily.week', cycle + 1);
      head.appendChild(chip);
      root.appendChild(head);

      var main = el('div', 'dg-main');
      var track = el('div', 'dg-track');
      for (var i = 0; i < 6; i++) track.appendChild(this.card(i, day, cycle, can));
      main.appendChild(track);
      main.appendChild(this.showcase(day, cycle, can));
      root.appendChild(main);
      root.appendChild(this.actions(day, cycle, can));
      if (SE.I18N && SE.I18N.apply) SE.I18N.apply(root);
      this.justClaimed = -1;
    },

    stateOf: function (i, day, can) {
      if (i < day) return 'claimed';
      if (i === day) return can ? 'today' : 'next';
      return 'future';
    },

    rewardArt: function (r, big) {
      var art = el('div', 'dg-art');
      if (r.item) {
        var color = r.exclusive ? '#e0a400' : rarityColor(r.rarity);
        art.classList.add('dg-art-item');
        art.style.setProperty('--rc', color);
        var frame = el('div', 'dg-thumb');
        var im = img(fallbackIcon(r.itemTab), 'dg-thumb-img is-fallback');
        frame.appendChild(im);
        art.appendChild(frame);
        thumbnail(r.item, 256).then(function (url) {
          if (url && im.isConnected) { im.src = url; im.classList.remove('is-fallback'); }
          else if (url) { im.src = url; im.classList.remove('is-fallback'); }
        });
        return art;
      }
      if (r.gems && r.cash) {
        art.classList.add('dg-art-combo');
        art.appendChild(img(iconUrl('render/gems-pile'), 'dg-ic dg-ic-a'));
        art.appendChild(img(iconUrl('cash-bonus'), 'dg-ic dg-ic-b'));
        return art;
      }
      if (r.cash) { art.appendChild(img(iconUrl(r.cash > 0 ? 'banknotes' : 'banknotes'), 'dg-ic')); return art; }
      art.appendChild(img(iconUrl(r.gems >= 100 || big ? 'render/gems-pile' : 'render/gem'), 'dg-ic' + (r.gems >= 100 || big ? ' dg-ic-pile' : '')));
      return art;
    },

    amountHtml: function (r) {
      var out = '';
      if (r.item && !r.exclusive) {
        out += '<span class="dg-amt-rar" style="color:' + rarityColor(r.rarity) + '">' + escapeHtml(rarityName(r.rarity)) + '</span>';
        if (r.gems) out += '<span class="dg-amt-sm"><i class="dg-gem-i"></i>+' + r.gems + '</span>';
        return out;
      }
      if (r.gems) out += '<span class="dg-amt-gem"><i class="dg-gem-i"></i>' + shortNum(r.gems) + '</span>';
      if (r.cash) out += '<span class="dg-amt-cash">' + cashText(r.cash) + '</span>';
      return out;
    },

    card: function (i, day, cycle, can) {
      var r = Daily.rewardFor(i, cycle);
      var state = this.stateOf(i, day, can);
      var c = el('div', 'dg-card is-' + state + (r.item ? ' has-item' : ''));
      c.setAttribute('data-day', String(i + 1));
      if (r.item) c.title = itemName(r.item);
      /* the ribbon says "Today"/"Tomorrow" on compact layouts (the corner tag is hidden there) */
      var label = el('div', 'dg-day');
      var dn = el('span', 'dg-day-n');
      dn.textContent = t('daily.day', i + 1);
      label.appendChild(dn);
      if (state === 'today' || state === 'next') {
        var dt = el('span', 'dg-day-t');
        dt.textContent = t(state === 'today' ? 'daily.today' : 'daily.tomorrow');
        label.appendChild(dt);
        label.classList.add('has-t');
      }
      c.appendChild(label);
      c.appendChild(this.rewardArt(r, false));
      c.appendChild(el('div', 'dg-amt', this.amountHtml(r)));
      if (state === 'claimed') {
        var chk = el('div', 'dg-check' + (this.justClaimed === i ? ' is-new' : ''), CHECK_SVG);
        c.appendChild(chk);
      } else if (state === 'today') {
        c.appendChild(el('div', 'dg-tag dg-tag-today', escapeHtml(t('daily.today'))));
      } else if (state === 'next') {
        c.appendChild(el('div', 'dg-tag dg-tag-next', escapeHtml(t('daily.tomorrow'))));
      }
      return c;
    },

    showcase: function (day, cycle, can) {
      var r = Daily.rewardFor(6, cycle);
      var state = this.stateOf(6, day, can);
      var box = el('div', 'dg-goal is-' + state + (r.item ? ' has-item' : ' is-gems'));
      box.setAttribute('data-day', '7');
      var tint = SHOWCASE_TINTS[cycle % SHOWCASE_TINTS.length];
      if (r.item) { box.style.setProperty('--g1', tint[0]); box.style.setProperty('--g2', tint[1]); }
      var rib = el('div', 'dg-goal-rib');
      rib.textContent = t('daily.day', 7);
      box.appendChild(rib);
      var tag = el('div', 'dg-goal-tag');
      tag.textContent = r.item ? t('daily.exclusive') : t('daily.bigPrize');
      box.appendChild(tag);
      var stage = el('div', 'dg-goal-stage');
      stage.appendChild(el('div', 'dg-rays'));
      if (r.item) {
        var im = img(fallbackIcon(r.itemTab), 'dg-goal-img is-fallback');
        stage.appendChild(im);
        thumbnail(r.item, 256).then(function (url) { if (url) { im.src = url; im.classList.remove('is-fallback'); } });
      } else {
        stage.appendChild(img(iconUrl('render/gems-pile'), 'dg-goal-img dg-goal-gems'));
      }
      box.appendChild(stage);
      var name = el('div', 'dg-goal-name');
      name.textContent = r.item ? itemName(r.item) : '+' + shortNum(r.gems);
      if (!r.item) name.insertAdjacentHTML('afterbegin', '<i class="dg-gem-i"></i>');
      box.appendChild(name);
      var info = el('div', 'dg-goal-info');
      info.textContent = r.item ? t('daily.notInShop') : (exclusives().length ? t('daily.allExclusives') : t('daily.bigPrizeInfo'));
      box.appendChild(info);
      if (state === 'claimed') box.appendChild(el('div', 'dg-check', CHECK_SVG));
      else if (state === 'today') box.appendChild(el('div', 'dg-tag dg-tag-today', escapeHtml(t('daily.today'))));
      else if (state === 'next') box.appendChild(el('div', 'dg-tag dg-tag-next', escapeHtml(t('daily.tomorrow'))));
      else {
        var left = 6 - day + (can ? 0 : 1);
        var steps = el('div', 'dg-goal-steps');
        steps.textContent = t('daily.inDays', left);
        box.appendChild(steps);
      }
      return box;
    },

    rewardChip: function (r, mult) {
      var h = '';
      if (r.item && !r.exclusive) h += '<span class="dg-chip-item">+1</span>';
      if (r.exclusive) h += '<span class="dg-chip-item">★</span>';
      if (r.gems) h += '<span class="dg-chip-gem"><i class="dg-gem-i"></i>' + shortNum(r.gems * mult) + '</span>';
      if (r.cash) h += '<span class="dg-chip-cash">' + cashText(r.cash * mult) + '</span>';
      return '<span class="dg-chips">' + h + '</span>';
    },

    actions: function (day, cycle, can) {
      var self = this;
      var bar = el('div', 'dg-actions');
      if (!can) {
        var wait = el('div', 'dg-wait');
        wait.innerHTML = '<span class="dg-wait-ic">' + CLOCK_SVG + '</span><span class="dg-wait-txt"><span class="dg-wait-lbl"></span>' +
          '<b class="dg-wait-time"></b></span>';
        wait.querySelector('.dg-wait-lbl').textContent = t('daily.nextIn');
        wait.querySelector('.dg-wait-time').textContent = SE.I18N ? SE.I18N.clock(Daily.timeToNext()) : '';
        bar.appendChild(wait);
        var ok = el('button', 'dg-btn dg-btn-ok');
        ok.type = 'button';
        ok.textContent = t('btn.ok');
        ok.addEventListener('click', function () { play('click'); if (SE.UI && SE.UI.close) SE.UI.close(); });
        bar.appendChild(ok);
        return bar;
      }
      var r = Daily.rewardFor(day, cycle);
      var claim = el('button', 'dg-btn dg-claim');
      claim.type = 'button';
      claim.innerHTML = '<span class="dg-btn-lbl"></span>' + this.rewardChip(r, 1);
      claim.querySelector('.dg-btn-lbl').textContent = t('daily.claim');
      claim.addEventListener('click', function () { self.doClaim(1); });
      bar.appendChild(claim);
      if (r.x2) {
        var x2 = el('button', 'dg-btn dg-x2');
        x2.type = 'button';
        x2.innerHTML = '<img class="dg-btn-ic" alt="" draggable="false" src="' + iconUrl('watch-video') + '">' +
          '<span class="dg-btn-lbl"></span>' + this.rewardChip(r, 2) + '<span class="dg-x2-why"></span>';
        x2.querySelector('.dg-btn-lbl').textContent = t('daily.x2');
        x2.addEventListener('click', function () { self.doX2(x2); });
        this.syncAdButton(x2);
        bar.appendChild(x2);
      } else {
        var no = el('div', 'dg-nox2');
        no.textContent = t('daily.noX2');
        bar.appendChild(no);
      }
      return bar;
    },

    syncAdButton: function (b) {
      var ready = Daily.adReady();
      b.disabled = !ready || Daily.adBusy();
      b.classList.toggle('is-off', !ready);
      var why = b.querySelector('.dg-x2-why');
      if (why) why.textContent = ready ? '' : t('daily.adUnavailable');
      b.title = ready ? '' : t('daily.adUnavailable');
    },

    setBusy: function (on) {
      if (!this.root) return;
      var btns = this.root.querySelectorAll('.dg-actions .dg-btn');
      for (var i = 0; i < btns.length; i++) btns[i].disabled = on || (btns[i].classList.contains('dg-x2') && !Daily.adReady());
      this.root.classList.toggle('is-busy', on);
    },

    doClaim: function (mult) {
      if (this.busyClick || Daily.adBusy()) return;
      this.busyClick = true;
      this.setBusy(true);
      var res = Daily.claim(mult);
      this.busyClick = false;
      if (!res) { play('error'); this.build(); return; }
      this.celebrate(res);
    },

    doX2: function (btn) {
      var self = this;
      if (this.busyClick || Daily.adBusy()) return;
      play('click');
      var started = Daily.claimX2(function (res) {
        if (!self.root) return;
        if (res) { self.celebrate(res); return; }
        self.setBusy(false);
        if (self.root.isConnected) self.build();
        /* SE.Ads already toasts "no reward"; only explain it ourselves without SE.Ads */
        if (!(SE.Ads && typeof SE.Ads.rewarded === 'function')) ui('toast', t('daily.adFailed'), 'info');
      });
      if (started) this.setBusy(true);
      else { play('error'); this.syncAdButton(btn); ui('toast', t('daily.adUnavailable'), 'error'); }
    },

    celebrate: function (res) {
      var self = this;
      play('reward');
      setTimeout(function () { play(res.item ? 'unlock' : (res.gems ? 'gem' : 'coin')); }, 160);
      if (res.cash && res.gems) setTimeout(function () { play('coin'); }, 330);
      this.justClaimed = res.index;
      if (!this.root || !this.root.isConnected) {
        ui('toast', t('daily.got') + ' ' + describe(res), 'good');
        return;
      }
      this.build();
      var root = this.root;
      var rv = el('div', 'dg-reveal');
      var card = el('div', 'dg-reveal-card' + (res.exclusive ? ' is-exclusive' : ''));
      card.appendChild(el('div', 'dg-reveal-rays'));
      var title = el('div', 'dg-reveal-title');
      title.textContent = t('daily.got');
      card.appendChild(title);
      var art = el('div', 'dg-reveal-art');
      if (res.item) {
        var im = img(fallbackIcon((itemDef(res.item) || {}).tab), 'dg-reveal-img is-fallback');
        art.appendChild(im);
        thumbnail(res.item, 256).then(function (url) { if (url) { im.src = url; im.classList.remove('is-fallback'); } });
      }
      if (res.gems) art.appendChild(img(iconUrl(res.gems >= 100 ? 'render/gems-pile' : 'render/gem'), 'dg-reveal-img' + (res.item ? ' is-small' : '')));
      if (res.cash) art.appendChild(img(iconUrl('cash-bonus'), 'dg-reveal-img' + (res.item || res.gems ? ' is-small' : '')));
      card.appendChild(art);
      var lines = el('div', 'dg-reveal-lines');
      if (res.item) {
        var n = el('div', 'dg-reveal-item');
        n.textContent = itemName(res.item);
        lines.appendChild(n);
      }
      if (res.gems || res.cash) {
        lines.appendChild(el('div', 'dg-reveal-amt', (res.gems ? '<span class="dg-amt-gem"><i class="dg-gem-i"></i>+' + shortNum(res.gems) + '</span>' : '') +
          (res.cash ? '<span class="dg-amt-cash">+' + cashText(res.cash) + '</span>' : '') +
          (res.mult === 2 ? '<span class="dg-reveal-x2">x2</span>' : '')));
      }
      card.appendChild(lines);
      if (res.item) {
        var eq = el('div', 'dg-reveal-hint');
        eq.textContent = t('daily.equipHint');
        card.appendChild(eq);
      }
      var ok = el('button', 'dg-btn dg-claim dg-reveal-ok');
      ok.type = 'button';
      ok.textContent = t('daily.great');
      card.appendChild(ok);
      rv.appendChild(card);
      root.appendChild(rv);
      function closeReveal() {
        if (!rv.parentNode) return;
        rv.classList.add('is-out');
        play('click');
        setTimeout(function () { if (rv.parentNode) rv.parentNode.removeChild(rv); }, 220);
      }
      ok.addEventListener('click', function (ev) { ev.stopPropagation(); closeReveal(); });
      rv.addEventListener('click', function (ev) { if (ev.target === rv) closeReveal(); });
      requestAnimationFrame(function () {
        rv.classList.add('is-in');
        var rr = root.getBoundingClientRect(), ar = art.getBoundingClientRect();
        RewardFX.burst(root, { x: ar.left - rr.left + ar.width / 2, y: ar.top - rr.top + ar.height / 2, count: res.exclusive ? 120 : 80,
          colors: res.exclusive ? ['#ffd257', '#fff1b8', '#e0a400', '#ffffff', '#c58bff'] : undefined });
      });
      setTimeout(function () { if (self.root) self.lastClaimable = Daily.canClaim(); }, 0);
    }
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function describe(res) {
    var parts = [];
    if (res.item) parts.push(itemName(res.item));
    if (res.gems) parts.push('+' + shortNum(res.gems) + ' ' + (SE.I18N ? SE.I18N.plural(res.gems, 'cur.gemsUnit').replace(/^\s*\d+\s*/, '') : 'gems'));
    if (res.cash) parts.push('+' + cashText(res.cash));
    return parts.join(', ');
  }
  Daily.describe = describe;
  Daily._panel = panel;

  /* language change → re-render an open panel */
  if (SE.I18N && typeof SE.I18N.onChange === 'function') {
    SE.I18N.onChange(function () { if (panel.root && panel.root.isConnected) panel.build(); });
  }
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('resize', function () {
      if (panel.root && panel.root.isConnected) panel.layout();
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Strings                                                                 */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) SE.I18N.add({
    ru: {
      'daily.title': 'Ежедневный подарок',
      'daily.subtitle': 'Заходи каждый день — подарки всё лучше!',
      'daily.note': 'Пропуск дня не сбрасывает прогресс',
      'daily.week': 'Неделя {0}',
      'daily.day': 'День {0}',
      'daily.today': 'Сегодня',
      'daily.tomorrow': 'Завтра',
      'daily.claim': 'Забрать',
      'daily.x2': 'x2 За рекламу',
      'daily.nextIn': 'Следующий подарок через',
      'daily.exclusive': 'Эксклюзив',
      'daily.notInShop': 'Нет в магазине и на колесе',
      'daily.bigPrize': 'Большой приз',
      'daily.bigPrizeInfo': 'Награда 7-го дня',
      'daily.allExclusives': 'Все эксклюзивы собраны!',
      'daily.inDays': 'Через {0} дн.',
      'daily.noX2': 'В 7-й день удвоения нет',
      'daily.got': 'Подарок получен!',
      'daily.great': 'Отлично!',
      'daily.equipHint': 'Надень в магазине',
      'daily.adUnavailable': 'Реклама сейчас недоступна',
      'daily.adFailed': 'Реклама не досмотрена — подарок можно забрать без удвоения',
      'daily.ready': 'Подарок готов!'
    },
    en: {
      'daily.title': 'Daily Gift',
      'daily.subtitle': 'Come back every day — the gifts get better!',
      'daily.note': 'Missing a day never resets your progress',
      'daily.week': 'Week {0}',
      'daily.day': 'Day {0}',
      'daily.today': 'Today',
      'daily.tomorrow': 'Tomorrow',
      'daily.claim': 'Claim',
      'daily.x2': 'x2 · Watch ad',
      'daily.nextIn': 'Next gift in',
      'daily.exclusive': 'Exclusive',
      'daily.notInShop': 'Not in the shop or on the wheel',
      'daily.bigPrize': 'Big prize',
      'daily.bigPrizeInfo': 'Day 7 reward',
      'daily.allExclusives': 'All exclusives collected!',
      'daily.inDays': 'In {0} d',
      'daily.noX2': 'No x2 on day 7',
      'daily.got': 'Gift claimed!',
      'daily.great': 'Awesome!',
      'daily.equipHint': 'Equip it in the shop',
      'daily.adUnavailable': 'Ads are not available right now',
      'daily.adFailed': 'The ad didn\'t finish — you can still claim the gift without x2',
      'daily.ready': 'Gift ready!'
    },
    tr: {
      'daily.title': 'Günlük Hediye',
      'daily.subtitle': 'Her gün gel — hediyeler gittikçe güzelleşir!',
      'daily.note': 'Bir gün kaçırmak ilerlemeni sıfırlamaz',
      'daily.week': '{0}. Hafta',
      'daily.day': '{0}. Gün',
      'daily.today': 'Bugün',
      'daily.tomorrow': 'Yarın',
      'daily.claim': 'Al',
      'daily.x2': 'x2 · Reklam izle',
      'daily.nextIn': 'Sonraki hediye',
      'daily.exclusive': 'Özel',
      'daily.notInShop': 'Mağazada ve çarkta yok',
      'daily.bigPrize': 'Büyük ödül',
      'daily.bigPrizeInfo': '7. gün ödülü',
      'daily.allExclusives': 'Tüm özel eşyalar toplandı!',
      'daily.inDays': '{0} gün sonra',
      'daily.noX2': '7. günde x2 yok',
      'daily.got': 'Hediye alındı!',
      'daily.great': 'Harika!',
      'daily.equipHint': 'Mağazadan kuşan',
      'daily.adUnavailable': 'Reklam şu anda kullanılamıyor',
      'daily.adFailed': 'Reklam tamamlanmadı — hediyeyi x2 olmadan alabilirsin',
      'daily.ready': 'Hediye hazır!'
    }
  });

  SE.Daily = Daily;

  /* Register the panel now (ui/core.js loads first) or as soon as SE.UI shows up. */
  if (!Daily.registerPanel()) {
    var tries = 0;
    var retry = function () {
      if (Daily.registerPanel() || ++tries > 40) return;
      setTimeout(retry, 250);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retry);
    else setTimeout(retry, 0);
  }
})(typeof window !== 'undefined' ? window : globalThis);
