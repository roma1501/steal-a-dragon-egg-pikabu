/* =========================================================================
   Steal a Dragon Egg — boot, main loop and gameplay rules (SE.Game)

   Boot (under the loading screen, real stages + progress, SPEC §7):
     Platform.init → language → State.load (failure → localized error + retry,
     never overwrites a save) → audio + World.registerAssets?() + Assets.loadAll
     (parallel; failure → error + retry) → fonts / icons → renderer (SPEC §13
     colour management, ACES, sRGB, shadows by quality) → FX.init → World.build
     → DragonAI.init → Player.init → Bots.init → UI.init → Wheel.resolvePending
     → first full frame → hide loading → Platform.gameReady → tutorial or play
     (+ offline earnings, Daily auto-open through SE.Daily.maybeAutoOpen).

   Loading screen hooks (index.html owns the DOM; all optional):
     #loading (gets CSS vars --load-progress 0..1 and --load-pct 'NN%'),
     fill  #loadFill | #loadBar i | .load-fill | [data-load-fill]  (width %, or height %
           when the element has data-load-axis="y"),
     stage #loadStage | .load-stage | [data-load-stage], percent #loadPct | [data-load-pct],
     tip #loadTip | [data-load-tip], error #loadError | [data-load-error],
     retry #btnRetry | #loadRetry | [data-load-retry]. Also SE.UI.setLoading?(p, text),
     SE.UI.hideLoading?(), window event 'sade-loading' {progress, stage, text, error}.

   SE.Game (SPEC §7)
     carrying (egg|null), carryDelivered, slowMode, time, paused (any reason), statuses
     { chilled, stunned, invisible } (seconds left), tutorialSlow (0.6 | false), round,
     scene, camera, renderer, player (SE.Player), quality ('high'|'medium'|'low'), ready
     stealEgg(nest) -> bool            collectHatchery(i) -> addDragon result|null
     buyHatchery(i) -> bool            sellDragons(uids) -> {count,total}; sellAll()
     unlockLair(i) -> bool             upgradeTreadmill() -> bool
     applyReward(offerId, ctx) -> bool  every rewarded offer of SPEC §8 (+ ctx.amount …)
     applyStatus(name, secs)           'chilled' (speed ×0.6) | 'stunned' | 'invisible'
     knockback(dirX, dirZ, dist)       fireball push (SE.DragonAI)
     shake(amount 0..1.5)              camera shake (+ FOV kick on speed)
     setPaused(on, reason)             reasons: manual, ui, platform, ad, hidden, blur
     resetProgress()                   fresh state, saved, page reloaded
     onCaught(dragon); onDelivered()   (called by SE.DragonAI / the safe-line check)
   Rewarded extras (SPEC §8, ads.js OFFERS):
     trial (null | { lair, endAt, token, done, expired }) — trialRaid: the first locked lair's gate is
       open for ONE round (World.setLairTrial when present, else setLairUnlocked kept open by a
       wrapper) until that round ends (delivered / caught) or REWARD.trialSecs pass, then it closes
       once the player is back south of the gate. trialTarget() -> first locked lair | -1.
     lastDelivery { token, cash, gems, tripled } — tripleReward adds (×3 − 1) of it once.
     resultOffers(data) -> [{ id, placement, icon, ctx, title, text, extraCash, extraGems }]
       extra rewarded offers for the result panel (ui/offers.js renders them).
     contextOffer() -> { id, ctx, reason } | null — the most relevant offer right now (offer bubble).
     teleportHomeWithEgg(), shieldSave(dragon) (dragonShield: the catch keeps the egg, knockback +
       invisibility, the lair is alarmed again afterwards), goldenPending(), rollChest() (freeChest).
     gemsX2 doubles delivery gems, turboTrain multiplies treadmill training, goldenEgg floors the
     next stolen egg's variant at Golden (State.data.rewards.golden, persisted).
   Extras: offer(id, ctx) (opens the 'offer' panel when the ad is ready), atBase(),
     lairPrice(i), refreshFollowers(), refreshCosmetics(), setSlowMode(on), toggleSlow(),
     togglePause(), howToPlay(), applySettings(), saveNow(), takeNest(nest, by),
     restoreNest(nest), storeEgg(egg[, i]), hardPaused(), pauseReasons().
   QA: window.SE_TEST when SE.Config.DEBUG (SPEC §11 + extras: nests, nearNest, action,
     home, info, interact, caught, deliver, game).
   ========================================================================= */
(function (global) {
  'use strict';
  /* game width: never wider than 2:1 (Playgama checklist 27, matches the css/base.css media query) */
  function viewW() {
    var w = global.innerWidth, h = global.innerHeight, fine = false;
    try { fine = global.matchMedia('(pointer: fine)').matches; } catch (e) {}
    return (w > 1024 && fine) ? Math.min(w, Math.floor(h * 2)) : w;   // desktop only: phones stay full screen
  }

  var SE = global.SE = global.SE || {};
  var T = global.THREE;
  /* SPEC §13: before any material created by the game */
  if (T && T.ColorManagement) T.ColorManagement.enabled = true;

  var DT_MAX = 1 / 20;
  var BASE_FOV = 60;
  var SAVE_EVERY = 20, LB_EVERY = 60, HUD_EVERY = 0.2, BOOSTS_EVERY = 0.5;
  var MAX_COINS = 9;
  var ACTION_ICONS = { nest: 'interact-hand', hatchery: 'hatching-chick', sell: 'money-bag', shop: 'shop', wheel: 'prize-wheel',
    gift: 'gift', index: 'book', upgrade: 'shoe', lairGate: 'map' };

  /* ---------------------------------------------------------------------- */
  /* helpers                                                                 */
  /* ---------------------------------------------------------------------- */
  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function money(n) { return SE.U && SE.U.money ? SE.U.money(n) : '$' + Math.floor(n || 0); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function damp(a, b, l, dt) { return a + (b - a) * (1 - Math.exp(-l * dt)); }
  function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  var errSeen = {};
  function report(where, e) {
    var key = where + ':' + (e && e.message);
    if (errSeen[key]) return;
    errSeen[key] = true;
    console.error('[Game] ' + where + ' failed:', e);
  }
  /* call(obj, 'fn', args…) — safe optional call; errors are reported once */
  function call(obj, name) {
    if (!obj || typeof obj[name] !== 'function') return undefined;
    try { return obj[name].apply(obj, Array.prototype.slice.call(arguments, 2)); } catch (e) { report(name, e); }
    return undefined;
  }
  function ui(name) {
    if (!SE.UI || typeof SE.UI[name] !== 'function') return undefined;
    try { return SE.UI[name].apply(SE.UI, Array.prototype.slice.call(arguments, 1)); } catch (e) { report('UI.' + name, e); }
    return undefined;
  }
  function audio(key, opts) { return call(SE.Audio, 'play', key, opts); }
  function fx(name, pos, opts) {
    if (!SE.FX || typeof SE.FX.emit !== 'function' || !pos) return null;
    try { return SE.FX.emit(name, pos, opts); } catch (e) { report('FX.emit(' + name + ')', e); return null; }
  }
  function toast(text, type) { ui('toast', text, type || 'info'); }
  function floatText(text, pos, cls) { if (SE.UI && SE.UI.floatText) ui('floatText', text, pos, cls); }
  function tutActive() {
    try { return !!(SE.Tutorial && SE.Tutorial.isActive && SE.Tutorial.isActive()); } catch (e) { return false; }
  }
  function tutNotify(ev, data) { if (SE.Tutorial && SE.Tutorial.notify) call(SE.Tutorial, 'notify', ev, data || {}); }
  function D() { return SE.DragonData; }
  function St() { return SE.State; }
  function sd() { return SE.State && SE.State.data; }
  function W() { return SE.World || null; }
  function P() { return SE.Player; }
  function boost(id) { return !!(SE.Boosts && SE.Boosts.isActive(id)); }
  function V(x, y, z) { return new T.Vector3(x, y, z); }
  var _look = T ? new T.Vector3() : null;
  function lairIndexOf(x) { return typeof x === 'number' ? x : (x && typeof x.index === 'number' ? x.index : (x && typeof x.lair === 'number' ? x.lair : 0)); }
  function setLabel(obj, text) {
    if (!obj) return;
    if (typeof obj.setText === 'function') obj.setText(text);
    else if (obj.userData && typeof obj.userData.setText === 'function') obj.userData.setText(text);
  }
  function q(sel) { try { return document.querySelector(sel); } catch (e) { return null; } }
  function qa(sel) { try { return document.querySelectorAll(sel); } catch (e) { return []; } }
  function clock(sec) {
    if (SE.I18N && SE.I18N.clock) return SE.I18N.clock(Math.ceil(sec));
    sec = Math.ceil(sec); var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function eggRig(egg, scale) {
    var DM = SE.DragonModels;
    if (!egg || !DM || typeof DM.createEgg !== 'function') return null;
    try { return DM.createEgg(egg.species, egg.variant, scale); } catch (e) { report('DragonModels.createEgg', e); return null; }
  }
  function babyRig(species, variant) {
    var DM = SE.DragonModels;
    if (!DM || typeof DM.create !== 'function') return null;
    try { return DM.create(species, { baby: true, variant: variant, lite: true }); } catch (e) { report('DragonModels.create(baby)', e); return null; }
  }
  function disposeRig(rig) {
    if (!rig) return;
    if (rig.group && rig.group.parent) rig.group.parent.remove(rig.group);
    if (typeof rig.dispose === 'function') { try { rig.dispose(); } catch (e) { /* ignore */ } }
  }

  /* ---------------------------------------------------------------------- */
  /* loading screen                                                          */
  /* ---------------------------------------------------------------------- */
  function UL() { return SE.UI && SE.UI.loading && typeof SE.UI.loading.progress === 'function' ? SE.UI.loading : null; }
  var Loading = {
    frac: 0, stage: 'platform', tipTimer: null, tipN: 0, retryFn: null, errorKey: null,
    root: function () {
      var r = document.getElementById('loading');
      if (!r) {
        r = document.createElement('div');
        r.id = 'loading';
        r.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:#7cc6ff;color:#fff;font:900 20px Nunito,system-ui,sans-serif;text-shadow:0 2px 0 #000;';
        r.innerHTML = '<div data-load-stage></div><div style="width:260px;height:18px;border-radius:9px;background:rgba(0,0,0,.3);overflow:hidden"><i data-load-fill style="display:block;height:100%;width:0;background:#7ed321"></i></div><div data-load-error style="display:none;max-width:80%;text-align:center"></div><button data-load-retry style="display:none;font:900 20px Nunito,system-ui;padding:10px 26px;border-radius:12px;border:0;background:#7ed321;color:#fff">↻</button>';
        document.body.appendChild(r);
      }
      return r;
    },
    start: function () {
      var self = this;
      if (UL()) { this.set(0, 'platform'); return; }
      this.tipN = Math.floor(Math.random() * 10);
      this.showTip();
      this.tipTimer = setInterval(function () { self.showTip(); }, 3800);
      var retry = q('#btnRetry, #loadRetry, [data-load-retry]');
      if (retry && !retry._seBound) {
        retry._seBound = true;
        retry.addEventListener('click', function (e) {
          e.preventDefault();
          var fn = self.retryFn;
          self.retryFn = null;
          self.clearError();
          if (fn) fn(); else global.location.reload();
        });
      }
      this.set(0, 'platform');
    },
    showTip: function () {
      var el = q('#loadTip, [data-load-tip]');
      if (!el) return;
      this.tipN = (this.tipN % 10) + 1;
      el.textContent = t('loading.tip' + this.tipN);
    },
    text: function () { return t('loading.stage.' + this.stage); },
    set: function (frac, stage) {
      if (stage) this.stage = stage;
      this.frac = Math.max(this.frac, clamp(frac || 0, 0, 1));
      var f = this.frac, pct = Math.round(f * 100), text = this.text();
      if (SE.Platform && SE.Platform.setLoadingProgress) call(SE.Platform, 'setLoadingProgress', f);
      if (UL()) {
        try { UL().progress(f, 'loading.stage.' + this.stage); } catch (e) { report('UI.loading.progress', e); }
        this.emit(null);
        return;
      }
      var root = this.root();
      root.style.setProperty('--load-progress', f.toFixed(3));
      root.style.setProperty('--load-pct', pct + '%');
      var fills = qa('#loadFill, #loadBar i, #loadBar .fill, .load-fill, [data-load-fill]');
      for (var i = 0; i < fills.length; i++) {
        if (fills[i].getAttribute('data-load-axis') === 'y') fills[i].style.height = pct + '%';
        else fills[i].style.width = pct + '%';
      }
      var st = qa('#loadStage, .load-stage, [data-load-stage]');
      for (var j = 0; j < st.length; j++) st[j].textContent = text;
      var pc = qa('#loadPct, .load-pct, [data-load-pct]');
      for (var k = 0; k < pc.length; k++) pc[k].textContent = t('loading.percent', pct);
      this.emit(null);
    },
    emit: function (error) {
      try { global.dispatchEvent(new CustomEvent('sade-loading', { detail: { progress: this.frac, stage: this.stage, text: this.text(), error: error } })); } catch (e) { /* old browsers */ }
    },
    error: function (key, retryFn) {
      this.errorKey = key;
      this.retryFn = retryFn || null;
      if (UL() && typeof UL().error === 'function') {
        var self0 = this;
        try { UL().error(key, function () { self0.retryFn = null; self0.errorKey = null; if (retryFn) retryFn(); else global.location.reload(); }); }
        catch (e) { report('UI.loading.error', e); }
        this.emit(t(key));
        return;
      }
      var root = this.root();
      root.classList.add('error', 'has-error');
      var el = q('#loadError, [data-load-error]');
      if (el) { el.textContent = t(key); el.style.display = ''; el.hidden = false; }
      var st = qa('#loadStage, .load-stage, [data-load-stage]');
      if (!el) for (var j = 0; j < st.length; j++) st[j].textContent = t(key);
      var btn = q('#btnRetry, #loadRetry, [data-load-retry]');
      if (btn) { btn.style.display = ''; btn.hidden = false; if (!btn.textContent.trim()) btn.textContent = t('btn.retry'); }
      this.emit(t(key));
    },
    clearError: function () {
      this.errorKey = null;
      var root = this.root();
      root.classList.remove('error', 'has-error');
      var el = q('#loadError, [data-load-error]');
      if (el) { el.style.display = 'none'; el.textContent = ''; }
      var btn = q('#btnRetry, #loadRetry, [data-load-retry]');
      if (btn) btn.style.display = 'none';
      this.set(this.frac, this.stage);
    },
    hide: function () {
      clearInterval(this.tipTimer);
      if (UL() && typeof UL().hide === 'function') {
        try { return Promise.resolve(UL().hide()); } catch (e) { report('UI.loading.hide', e); }
      }
      try { document.body.classList.remove('is-loading'); } catch (e) { /* ignore */ }
      var root = document.getElementById('loading');
      if (!root) return Promise.resolve();
      root.classList.add('hide', 'done');
      root.style.transition = 'opacity .35s ease';
      root.style.opacity = '0';
      root.style.pointerEvents = 'none';
      return new Promise(function (resolve) {
        setTimeout(function () { root.style.display = 'none'; resolve(); }, 380);
      });
    }
  };

  /* Run a step; on failure show the localized error with a retry button that re-runs it. */
  function attempt(stage, fn, errKey) {
    return new Promise(function (resolve) {
      function go() {
        var p;
        try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
        p.then(resolve, function (err) {
          console.warn('[Game] boot stage "' + stage + '" failed:', err);
          Loading.error(errKey, go);
        });
      }
      go();
    });
  }
  function withTimeout(p, ms) {
    return Promise.race([Promise.resolve(p).catch(function () {}), new Promise(function (r) { setTimeout(r, ms); })]);
  }
  function nextFrame() { return new Promise(function (r) { requestAnimationFrame(function () { r(); }); }); }
  /* GLTFLoader.js throws when it runs before BufferGeometryUtils.js (wrong script order):
     load it once more so the models still load. */
  function ensureGLTF() {
    if (!T || T.GLTFLoader || !T.BufferGeometryUtils) return Promise.resolve();
    console.warn('[Game] THREE.GLTFLoader is missing (js/lib/BufferGeometryUtils.js must load before js/lib/GLTFLoader.js) — reloading it');
    return new Promise(function (resolve) {
      var old = q('script[src*="GLTFLoader"]');
      var s = document.createElement('script');
      s.src = old && old.src ? old.src : 'js/lib/GLTFLoader.js';
      s.onload = s.onerror = function () { resolve(); };
      document.head.appendChild(s);
    });
  }

  /* ---------------------------------------------------------------------- */
  /* coins (picked up by walking; the 'magnet' reward pulls them)            */
  /* ---------------------------------------------------------------------- */
  var Coins = {
    list: [], pool: [], timer: 3, geo: null, mat: null, scene: null,
    init: function (scene) { this.scene = scene; },
    make: function () {
      var obj = null;
      if (SE.Models && typeof SE.Models.makeCoin === 'function') {
        try { obj = SE.Models.makeCoin(); } catch (e) { obj = null; }
        if (obj && obj.group) obj = obj.group;
      }
      if (!obj || !obj.isObject3D) {
        if (!this.geo) {
          this.geo = new T.CylinderGeometry(0.95, 0.95, 0.24, 18);
          this.geo.rotateX(Math.PI / 2);
          this.mat = new T.MeshStandardMaterial({ color: '#ffc928', metalness: 0.45, roughness: 0.35, emissive: '#6a4200', emissiveIntensity: 0.35 });
        }
        obj = new T.Mesh(this.geo, this.mat);
        obj.castShadow = true;
      }
      return obj;
    },
    spawnPoint: function (game) {
      var Wd = W(), p = P().pos;
      if (!Wd) return null;
      for (var tries = 0; tries < 6; tries++) {
        var z = p.z - 18 - Math.random() * 70, x;
        if (Wd.inSafeZone && Wd.inSafeZone(p.x, z)) continue;
        var lair = Wd.lairAt ? Wd.lairAt(0, z) : null;
        if (!lair) continue;                       // coins only lie in the lairs
        var hw = lair && lair.halfWidth ? lair.halfWidth * 0.75 : 13;
        x = (lair ? lair.x || 0 : 0) + (Math.random() * 2 - 1) * hw;
        if (lair && !St().lairUnlocked(lair.index)) continue;
        if (lair && lair.zMin !== undefined && (z < lair.zMin + 6 || z > lair.zMax - 6)) continue;
        var r = P().resolve(x, z, 0, 1.4);
        if (Math.abs(r.x - x) > 0.01 || Math.abs(r.z - z) > 0.01) continue;
        return { x: x, z: z, lair: lair ? lair.index : -1 };
      }
      return null;
    },
    update: function (dt, game) {
      var p = P().pos;
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 3.5 + Math.random() * 3;
        if (this.list.length < MAX_COINS && !tutActive()) {
          var sp = this.spawnPoint(game);
          if (sp) {
            var obj = this.pool.pop() || this.make();
            obj.position.set(sp.x, 1.6, sp.z);
            obj.visible = true;
            this.scene.add(obj);
            var inc = St().incomePerSec(null);
            var lv = Math.max(0, sp.lair);
            var value = Math.max(5, Math.round(inc * 2 + 12 * Math.pow(3.2, lv)));
            this.list.push({ obj: obj, x: sp.x, z: sp.z, y: 1.6, value: value, ph: Math.random() * 6, fly: false });
          }
        }
      }
      var magnet = boost('magnet');
      for (var i = this.list.length - 1; i >= 0; i--) {
        var c = this.list[i];
        var dx = p.x - c.x, dz = p.z - c.z, d = Math.sqrt(dx * dx + dz * dz);
        if (magnet && d < 28) c.fly = true;
        if (c.fly) {
          var sp2 = Math.min(d, (34 + (28 - d) * 2) * dt);
          if (d > 0.01) { c.x += dx / d * sp2; c.z += dz / d * sp2; }
        }
        c.ph += dt * 3;
        c.obj.position.set(c.x, c.y + Math.sin(c.ph) * 0.35 + (c.fly ? 1.2 : 0), c.z);
        c.obj.rotation.y += dt * 3.2;
        if (d < 2.9) {
          St().addMoney(c.value);
          audio('coin', { volume: 0.55, vary: 1 });
          fx('coin_burst', V(c.x, 2, c.z), { count: 0.4, scale: 0.7 });
          floatText('+' + money(c.value), V(c.x, 4, c.z), 'cash');
          this.recycle(i);
        } else if (d > 220) {
          this.recycle(i);
        }
      }
    },
    recycle: function (i) {
      var c = this.list.splice(i, 1)[0];
      if (c.obj.parent) c.obj.parent.remove(c.obj);
      this.pool.push(c.obj);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* dragonShield bubble around the player (2 meshes, additive, no shadows)  */
  /* ---------------------------------------------------------------------- */
  var ShieldFx = {
    group: null, t: 0, on: false,
    build: function () {
      if (this.group || !T) return this.group;
      var g = new T.Group();
      var geo = new T.IcosahedronGeometry(4.3, 2);
      this.fill = new T.MeshBasicMaterial({ color: '#2f9fff', transparent: true, opacity: 0.12, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
      this.wire = new T.MeshBasicMaterial({ color: '#5fd0ff', transparent: true, opacity: 0.3, wireframe: true, depthWrite: false, blending: T.AdditiveBlending });
      var a = new T.Mesh(geo, this.fill), b = new T.Mesh(geo, this.wire);
      a.renderOrder = b.renderOrder = 6;
      g.add(a); g.add(b);
      g.position.y = 3.6;
      g.name = 'dragonShield';
      g.visible = false;
      this.group = g;
      return g;
    },
    update: function (dt, active, playerGroup) {
      if (!active && !this.group) return;
      var g = this.build();
      if (!g) return;
      if (playerGroup && g.parent !== playerGroup) playerGroup.add(g);
      this.on = !!active;
      g.visible = this.on;
      if (!this.on) return;
      this.t += dt;
      var p = 0.5 + 0.5 * Math.sin(this.t * 3.2);
      this.fill.opacity = 0.08 + 0.07 * p;
      this.wire.opacity = 0.18 + 0.16 * p;
      g.rotation.y += dt * 0.6;
      g.scale.setScalar(1 + 0.03 * Math.sin(this.t * 5.1));
    }
  };

  /* ---------------------------------------------------------------------- */
  /* SE.Game                                                                 */
  /* ---------------------------------------------------------------------- */
  var Game = {
    ready: false,
    booted: false,
    carrying: null,
    carryDelivered: false,
    slowMode: false,
    time: 0,
    statuses: { chilled: 0, stunned: 0, invisible: 0 },
    tutorialSlow: false,
    round: null,
    lastCaught: null,
    scene: null,
    camera: null,
    renderer: null,
    player: null,
    quality: 'high',
    near: null,
    zoneKey: null,
    musicTrack: null,
    alarmOn: false,
    offlineAmount: 0,
    shakeAmp: 0,
    fov: BASE_FOV,
    _reasons: {},
    _last: 0,
    _seq: 0,
    _hint: null,
    _timers: { hud: 0, boosts: 0, save: SAVE_EVERY, lb: 15, zone: 0, settings: 0, labels: 0, carry: 0, moved: 0, render: 0 },
    _hv: [],
    _settingsSig: '',
    _caughtAt: -10,
    _tmSound: null,
    _tutWas: false,
    trial: null,
    lastDelivery: null,
    _shieldRealarm: null,
    _lairEnterAt: -99,
    _idleFor: 0,
    _turboFx: 0,

    /* ================================================================== */
    /* boot                                                                */
    /* ================================================================== */
    boot: function () {
      var self = this;
      this.player = SE.Player;
      Loading.start();
      var Pf = SE.Platform;
      if (!Pf || !SE.State) {
        console.error('[Game] SE.Platform / SE.State missing — check the script list in index.html');
        Loading.error('loading.error.generic', function () { global.location.reload(); });
        return;
      }
      Pf.onPause = function (reason) { self.setPaused(true, reason || 'platform'); };
      Pf.onResume = function (reason) { self.setPaused(false, reason || 'platform'); };

      /* language guess for the loading screen until the SDK answers (Yandex: ru, Playables: en …) */
      if (SE.I18N) { call(SE.I18N, 'setLang', (SE.Config && SE.Config.LANG && SE.Config.LANG !== 'auto') ? SE.Config.LANG : (Pf.lang || 'ru')); call(SE.I18N, 'apply', document); }
      attempt('platform', function () { return Pf.init(); }, 'loading.error.generic')
        .then(function () {
          var lang = SE.Config && SE.Config.LANG && SE.Config.LANG !== 'auto' ? SE.Config.LANG : Pf.lang;
          if (SE.I18N) { call(SE.I18N, 'setLang', lang || 'ru'); call(SE.I18N, 'apply', document); }
          Loading.set(0.05, 'save');
          return attempt('save', function () { return SE.State.load(); }, 'loading.error.save');
        })
        .then(function () {
          Loading.set(0.1, 'assets');
          var aP = 0, mP = 0;
          function prog() { Loading.set(0.1 + 0.12 * aP + 0.6 * mP, 'assets'); }
          if (SE.Audio) {
            call(SE.Audio, 'init');
            self.applyAudioSettings();
          }
          var audioP = SE.Audio && SE.Audio.loadAll
            ? withTimeout(SE.Audio.loadAll(function (l, tot) { aP = tot ? l / tot : 1; prog(); }), 12000)
            : Promise.resolve();
          if (W() && typeof W().registerAssets === 'function') call(W(), 'registerAssets');
          var assetsP = attempt('assets', function () {
            if (!SE.Assets || !SE.Assets.loadAll) return Promise.resolve();
            return ensureGLTF().then(function () { return SE.Assets.loadAll(function (l, tot, f) { mP = fin(f) ? f : (tot ? l / tot : 1); prog(); }); });
          }, 'loading.error.assets');
          return Promise.all([audioP, assetsP]);
        })
        .then(function () {
          call(SE.Audio, 'prepareMusic');
          Loading.set(0.82, 'world');
          var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
          var icons = SE.Icons && typeof SE.Icons.preload === 'function' ? call(SE.Icons, 'preload') : null;
          return withTimeout(Promise.all([fonts, icons]), 2500);
        })
        .then(nextFrame)
        .then(function () {
          if (!self.createRenderer()) {
            Loading.error('loading.error.webgl', function () { global.location.reload(); });
            return new Promise(function () {});        // stays on the loading screen
          }
          Loading.set(0.86, 'world');
          return nextFrame();
        })
        .then(function () { return self.buildScene(); })
        .then(nextFrame)
        .then(function () { return self.start(); })
        .catch(function (err) {
          console.error('[Game] boot failed:', err);
          Loading.error('loading.error.generic', function () { global.location.reload(); });
        });
    },

    resolveQuality: function () {
      var s = sd() && sd().settings, qy = s ? s.quality : 'auto';
      if (qy === 'high' || qy === 'medium' || qy === 'low') return qy;
      var mobile = SE.Platform && SE.Platform.isMobile;
      if (mobile) return 'low';
      var cores = navigator.hardwareConcurrency || 4, mem = navigator.deviceMemory || 8;
      return cores <= 2 || mem <= 2 ? 'medium' : 'high';
    },
    pixelRatio: function (qy) {
      var dpr = global.devicePixelRatio || 1;
      return qy === 'high' ? Math.min(dpr, 2) : (qy === 'medium' ? Math.min(dpr, 1.5) : 1);
    },
    shadowsWanted: function () {
      var s = sd() && sd().settings;
      return this.quality !== 'low' && (!s || s.shadows !== false);
    },

    createRenderer: function () {
      var canvas = document.getElementById('scene');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'scene';
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;display:block;';
        document.body.insertBefore(canvas, document.body.firstChild);
      }
      this.canvas = canvas;
      this.quality = this.resolveQuality();
      var r;
      try {
        r = new T.WebGLRenderer({ canvas: canvas, antialias: this.quality !== 'low', powerPreference: 'high-performance', stencil: false });
      } catch (e) {
        console.warn('[Game] WebGL is unavailable:', e);
        return false;
      }
      if (T.ColorManagement) T.ColorManagement.enabled = true;
      r.outputEncoding = T.sRGBEncoding;
      r.toneMapping = T.ACESFilmicToneMapping;
      r.toneMappingExposure = 1.05;
      r.shadowMap.enabled = this.shadowsWanted();
      r.shadowMap.type = this.quality === 'high' ? T.PCFSoftShadowMap : T.PCFShadowMap;
      r.setPixelRatio(this.pixelRatio(this.quality));
      r.setSize(viewW(), global.innerHeight);
      this.renderer = r;
      this.scene = new T.Scene();
      this.camera = new T.PerspectiveCamera(BASE_FOV, viewW() / Math.max(1, global.innerHeight), 0.5, 2400);
      this.camera.position.set(0, 20, 40);
      canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); console.warn('[Game] WebGL context lost'); }, false);
      return true;
    },

    buildScene: function () {
      var scene = this.scene, state = sd();
      if (SE.FX && SE.FX.init) call(SE.FX, 'init', scene, this.quality);
      var Wd = W();
      if (!Wd || typeof Wd.build !== 'function') throw new Error('SE.World is missing (js/world.js)');
      Wd.build(scene, state, { renderer: this.renderer, quality: this.quality });
      Loading.set(0.92, 'world');
      if (SE.DragonAI && SE.DragonAI.init) call(SE.DragonAI, 'init', scene, Wd);
      SE.Input.init(this.canvas);
      SE.Player.init(scene);
      if (SE.Bots && SE.Bots.init) call(SE.Bots, 'init', scene, Wd);
      Coins.init(scene);
      if (SE.AdPads && SE.AdPads.init) call(SE.AdPads, 'init', scene, Wd, this);
      if (SE.UI && SE.UI.init) call(SE.UI, 'init', this);
      /* menu music while the shop / wheel / daily gift is open (SE.Audio never interrupts a chase) */
      if (SE.UI && typeof SE.UI.on === 'function') {
        SE.UI.on(function (type, id) {
          if ((id === 'shop' || id === 'wheel' || id === 'daily') && (type === 'open' || type === 'close') &&
              SE.Audio && typeof SE.Audio.setMenuMusic === 'function') call(SE.Audio, 'setMenuMusic', type === 'open');
        });
      }
      this.updateUpgradeSign();
      this.syncHatcheries(0);
      this.syncLairs();
      if (SE.Wheel && SE.Wheel.resolvePending) call(SE.Wheel, 'resolvePending', { toast: true });
      this.applySettings(true);
      this.installEvents();
      if (SE.Config && SE.Config.DEBUG) this.installTestHooks();
      Loading.set(0.97, 'world');
    },

    start: function () {
      var self = this;
      var Pl = P();
      /* first full frame */
      call(W(), 'update', 0, 0, Pl.pos);
      Pl.updateCamera(0, this.camera);
      this.onResize();
      try { this.renderer.compile(this.scene, this.camera); } catch (e) { /* optional */ }
      this.renderer.render(this.scene, this.camera);
      call(SE.Platform, 'firstFrameReady');
      Loading.set(1, 'ready');
      this.ready = true;
      this._last = now();
      this._frame = this.loop.bind(this);
      requestAnimationFrame(this._frame);
      return Loading.hide().then(function () {
        self.booted = true;
        call(SE.Platform, 'gameReady');
        if (!self.paused) call(SE.Platform, 'gameplayStart');
        self.musicTrack = null;
        var d = sd();
        if (!d.tutorialDone && SE.Tutorial && SE.Tutorial.start) {
          call(SE.Tutorial, 'start');
          if (St().pendingOffline) St().claimOffline(1);
        } else {
          self.checkOffline();
        }
        ui('updateHUD');
      });
    },

    installEvents: function () {
      var self = this;
      global.addEventListener('resize', function () { self.onResize(); });
      global.addEventListener('orientationchange', function () { setTimeout(function () { self.onResize(); }, 250); });
      if (global.visualViewport) global.visualViewport.addEventListener('resize', function () { self.onResize(); });
      var Pf = SE.Platform || {};
      if (Pf.pauseOnHidden !== false) {
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) { self.setPaused(true, 'hidden'); self.saveNow(); }
          else { self.setPaused(false, 'hidden'); self.afterHidden(); }
        });
        global.addEventListener('blur', function () { self.setPaused(true, 'blur'); });
        global.addEventListener('focus', function () { self.setPaused(false, 'blur'); });
        var unblur = function () { if (self._reasons.blur) self.setPaused(false, 'blur'); };
        document.addEventListener('pointerdown', unblur, true);
        document.addEventListener('keydown', unblur, true);
      }
      global.addEventListener('pagehide', function () { self.saveNow(); });
      /* capture phase: runs before the UI's own Esc handler closes its panel */
      global.addEventListener('keydown', function (e) {
        if (e.repeat || !self.booted) return;
        var tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        var uiPause = SE.UI && typeof SE.UI.showPause === 'function';
        if (e.code === 'KeyP' || (e.code === 'Escape' && !uiPause)) {
          if (self._reasons.ad || tutActive()) return;
          if (self._reasons.manual) { self.togglePause(); e.preventDefault(); }
          else if (!ui('isOpen')) { self.togglePause(); e.preventDefault(); }
        }
      }, true);
      document.addEventListener('contextmenu', function (e) { if (e.target === self.canvas) e.preventDefault(); });
      document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
      if (!(SE.UI && typeof SE.UI.showPause === 'function')) {
        var resume = q('#btnResume, [data-action="resume"]');
        if (resume) resume.addEventListener('click', function () { self.setPaused(false, 'manual'); });
      }
    },

    onResize: function () {
      if (!this.renderer) return;
      var w = viewW(), h = global.innerHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / Math.max(1, h);
      this.baseFov = this.camera.aspect < 0.8 ? 72 : (this.camera.aspect < 1.2 ? 66 : BASE_FOV);
      this.camera.updateProjectionMatrix();
    },

    /* ================================================================== */
    /* pause                                                               */
    /* ================================================================== */
    pauseReasons: function () { return Object.keys(this._reasons); },
    hardPaused: function () {
      for (var k in this._reasons) if (k !== 'ui') return true;
      return false;
    },
    setPaused: function (on, reason) {
      reason = reason || 'manual';
      var wasAny = this.paused, wasHard = this.hardPaused();
      if (on) this._reasons[reason] = true; else delete this._reasons[reason];
      var hard = this.hardPaused(), any = this.paused;
      if (hard !== wasHard) {
        if (hard) call(SE.Audio, 'pause');
        else { call(SE.Audio, 'resume'); this._last = now(); }
      }
      if (any !== wasAny && this.booted) {
        if (any) { call(SE.Input, 'reset'); call(SE.Platform, 'gameplayStop'); }
        else { call(SE.Platform, 'gameplayStart'); this._last = now(); }
      }
      if (reason === 'manual' && !(SE.UI && typeof SE.UI.showPause === 'function')) this.showPauseFallback(!!on);
      try { document.body.classList.toggle('is-paused', any); } catch (e) { /* ignore */ }
    },
    showPauseFallback: function (on) {
      var el = document.getElementById('pause');
      if (!el) return;
      el.classList.toggle('show', on);
      el.classList.toggle('open', on);
      el.style.display = on ? 'flex' : 'none';
    },
    togglePause: function () {
      if (SE.UI && typeof SE.UI.togglePause === 'function') { ui('togglePause'); return; }
      this.setPaused(!this._reasons.manual, 'manual');
    },
    setSlowMode: function (on) { this.slowMode = !!on; audio('toggle'); },
    toggleSlow: function () { this.setSlowMode(!this.slowMode); return this.slowMode; },
    howToPlay: function () {
      if (SE.UI && typeof SE.UI.showPause === 'function') ui('showPause', false);
      this.setPaused(false, 'manual');
      if (SE.UI && SE.UI.isOpen && SE.UI.isOpen()) ui('close');
      if (SE.Tutorial && SE.Tutorial.start) call(SE.Tutorial, 'start', true);
    },

    /* ================================================================== */
    /* main loop                                                           */
    /* ================================================================== */
    loop: function () {
      requestAnimationFrame(this._frame);
      var tn = now();
      var dt = Math.min(DT_MAX, Math.max(0, (tn - this._last) / 1000));
      this._last = tn;
      if (!this.ready || this.hardPaused()) return;
      try {
        if (this.paused) this.uiFrame(dt);
        else this.frame(dt);
      } catch (e) { report('frame', e); }
    },

    /* a panel is open: economy keeps running (income, hatching), the world is frozen */
    uiFrame: function (dt) {
      St().tick(dt, SE.Boosts);
      this.syncHatcheries(dt);
      this.timers(dt);
      if (SE.Cosmetics && SE.Cosmetics.update) call(SE.Cosmetics, 'update', dt);
      /* the result panel keeps the scene live: victory effect, celebrate pose, particles, followers */
      if (SE.UI && SE.UI.isOpen && SE.UI.isOpen('result')) {
        var Pl = P();
        if (Pl.model && Pl.model.update) call(Pl.model, 'update', dt, false, 0, true);
        if (Pl.updateFollowers) call(Pl, 'updateFollowers', dt, this);
        if (SE.FX && SE.FX.update) call(SE.FX, 'update', dt);
        this.renderer.render(this.scene, this.camera);
        return;
      }
      this._timers.render -= dt;
      if (this._timers.render <= 0) {
        this._timers.render = 1 / 15;
        this.renderer.render(this.scene, this.camera);
      }
    },

    frame: function (dt) {
      var Pl = P(), Wd = W();
      this.time += dt;
      St().tick(dt, SE.Boosts);
      this.updateTutorialFlags(dt);
      this.updateStatuses(dt);

      Pl.update(dt, this, this.camera);
      this.updateTreadmill(dt);
      this.updateRewards(dt);
      if (SE.DragonAI && SE.DragonAI.update) call(SE.DragonAI, 'update', dt, Pl, this);
      if (SE.Bots && SE.Bots.update) call(SE.Bots, 'update', dt, this);
      if (Wd && Wd.update) call(Wd, 'update', dt, this.time, Pl.pos);
      if (SE.FX && SE.FX.update) call(SE.FX, 'update', dt);
      if (SE.Cosmetics && SE.Cosmetics.update) call(SE.Cosmetics, 'update', dt);

      this.updateInteractions();
      var In = SE.Input;
      if (In.consumeAction()) this.doAction(this.near);
      if (In.consumeAction2()) this.sellAll();

      if (this.carrying && !this.carryDelivered && Wd && Wd.inSafeZone && Wd.inSafeZone(Pl.pos.x, Pl.pos.z)) this.onDelivered();
      this.updateNests();
      this.syncHatcheries(dt);
      Coins.update(dt, this);
      this.updateZoneAndMusic(dt);
      this.updateCamera(dt);
      this.timers(dt);
      if (SE.Daily && SE.Daily.maybeAutoOpen && this.booted) call(SE.Daily, 'maybeAutoOpen', this);
      this.renderer.render(this.scene, this.camera);
    },

    timers: function (dt) {
      var tm = this._timers;
      tm.hud -= dt; tm.boosts -= dt; tm.save -= dt; tm.lb -= dt; tm.settings -= dt; tm.carry -= dt;
      if (tm.hud <= 0) { tm.hud = HUD_EVERY; ui('updateHUD'); }
      if (tm.boosts <= 0) { tm.boosts = BOOSTS_EVERY; if (SE.UI && SE.UI.updateBoosts) ui('updateBoosts'); }
      if (tm.settings <= 0) { tm.settings = 0.5; this.applySettings(false); }
      if (tm.carry <= 0) {
        tm.carry = 0.5;
        if (this.carrying && this.carryDelivered && St().freeHatchery() >= 0 && this.atBase()) this.storeEgg(this.carrying);
      }
      if (tm.save <= 0) { tm.save = SAVE_EVERY; this.saveNow(); }
      if (tm.lb <= 0) { tm.lb = LB_EVERY; this.submitScore(); }
    },

    updateTutorialFlags: function (dt) {
      var active = tutActive();
      if (active) {
        var ds = SE.Tutorial.dragonSlow;
        if (typeof ds === 'function') { try { ds = ds.call(SE.Tutorial); } catch (e) { ds = null; } }
        this.tutorialSlow = ds === false || ds === 0 ? false : (fin(ds) ? ds : (ds ? 0.6 : false));
      } else this.tutorialSlow = false;
      if (this._tutWas && !active) { this.saveNow(); }
      if (active && !this._tutWas) this._movedSent = P().movedDist;
      this._tutWas = active;
      if (active && SE.Tutorial.update) call(SE.Tutorial, 'update', dt, this);
      /* 'moved' for the tutorial (distance walked since the last notify) */
      if (active && P().moving) {
        this._timers.moved -= dt;
        if (this._timers.moved <= 0) { this._timers.moved = 0.2; var md = P().movedDist; tutNotify('moved', { dist: md - (this._movedSent || 0), total: md }); this._movedSent = md; }
      }
    },

    /* ================================================================== */
    /* camera shake / FOV kick                                             */
    /* ================================================================== */
    shake: function (amount) {
      amount = fin(amount) ? amount : 0.5;
      this.shakeAmp = Math.min(1.5, Math.max(this.shakeAmp, amount));
    },
    updateCamera: function (dt) {
      var cam = this.camera, Pl = P();
      if (this.shakeAmp > 0.005) {
        var a = this.shakeAmp * 0.85, tt = this.time * 37;
        cam.position.x += Math.sin(tt * 1.3) * a;
        cam.position.y += Math.sin(tt * 1.7 + 1.1) * a * 0.7;
        cam.position.z += Math.cos(tt * 1.1 + 0.4) * a;
        this.shakeAmp *= Math.exp(-5.5 * dt);
      }
      var base = this.baseFov || BASE_FOV;
      var kick = clamp((Pl.speed - 26) * 0.09, 0, 7) + (boost('speedBoost') ? 2.5 : 0);
      var target = base + kick;
      var f = damp(this.fov, target, 4, dt);
      if (Math.abs(f - cam.fov) > 0.02) { cam.fov = f; cam.updateProjectionMatrix(); }
      this.fov = f;
      if (SE.Audio && SE.Audio.setListener) call(SE.Audio, 'setListener', Pl.pos.x, Pl.pos.z, Pl.camYaw);
    },

    /* ================================================================== */
    /* statuses                                                            */
    /* ================================================================== */
    applyStatus: function (name, secs) {
      if (!this.statuses.hasOwnProperty(name) || !fin(secs) || secs <= 0) return false;
      var was = this.statuses[name] > 0;
      this.statuses[name] = Math.max(this.statuses[name], secs);
      var Pl = P(), pos = V(Pl.pos.x, Pl.pos.y + 4, Pl.pos.z);
      if (name === 'invisible') Pl.setGhost(true);
      if (!was) {
        if (name === 'chilled') { fx('freeze_hit', pos); floatText(t('game.status.chilled'), V(pos.x, pos.y + 3, pos.z), 'bad'); }
        if (name === 'stunned') {
          this.shake(0.6);
          floatText(t('game.status.stunned'), V(pos.x, pos.y + 3, pos.z), 'bad');
          if (SE.FX && SE.FX.attach && SE.FX.has && SE.FX.has('stun_stars')) {
            try { this._stunFx = SE.FX.attach('stun_stars', Pl.group, { offset: [0, 7.4, 0], duration: secs }); } catch (e) { report('FX.attach', e); }
          }
        }
        if (name === 'invisible') floatText(t('game.status.invisible'), V(pos.x, pos.y + 3, pos.z), 'good');
      }
      if (SE.UI && SE.UI.setStatus) ui('setStatus', name, this.statuses[name]);
      try { document.body.classList.add('st-' + name); } catch (e) { /* ignore */ }
      return true;
    },
    updateStatuses: function (dt) {
      for (var k in this.statuses) {
        if (!this.statuses.hasOwnProperty(k) || this.statuses[k] <= 0) continue;
        this.statuses[k] -= dt;
        if (this.statuses[k] <= 0) {
          this.statuses[k] = 0;
          if (k === 'invisible') P().setGhost(false);
          if (k === 'stunned' && this._stunFx) { try { this._stunFx.stop(); } catch (e) { /* ignore */ } this._stunFx = null; }
          if (SE.UI && SE.UI.setStatus) ui('setStatus', k, 0);
          try { document.body.classList.remove('st-' + k); } catch (e) { /* ignore */ }
        }
      }
    },
    /* SE.DragonAI fireball hit: push the player `dist` units along (dirX, dirZ) */
    knockback: function (dirX, dirZ, dist) {
      var Pl = P();
      if (Pl && Pl.knockback) Pl.knockback(dirX, dirZ, (fin(dist) ? dist : 6) * 6);
    },
    clearStatuses: function () {
      for (var k in this.statuses) if (this.statuses.hasOwnProperty(k) && this.statuses[k] > 0) { this.statuses[k] = 0.0001; }
      this.updateStatuses(1);
    },

    /* ================================================================== */
    /* interactions                                                        */
    /* ================================================================== */
    updateInteractions: function () {
      var Wd = W(), list = Wd && Wd.interactables;
      var best = null, bestScore = 1e9;
      if (list) {
        var px = P().pos.x, pz = P().pos.z;
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          if (!it || it.disabled || it.hidden) continue;
          var r = it.r || 4, dx = it.x - px, dz = it.z - pz, d2 = dx * dx + dz * dz;
          if (d2 > r * r) continue;
          var score = Math.sqrt(d2) + (it.type === 'treadmill' ? 3 : 0);
          if (it.type === 'lairGate' && St().lairUnlocked(it.lairIndex)) continue;
          if (score < bestScore) { bestScore = score; best = it; }
        }
      }
      this.near = best;
      var h = best ? this.hintFor(best) : null;
      var text = '';
      if (h && h.text) text = h.act && SE.Input.mode !== 'touch' ? '[E] ' + h.text : h.text;
      else if (this.carrying && this.carryDelivered) text = t('game.toast.noHatchery');
      if (text !== this._hint) {
        this._hint = text;
        ui('setHint', text);
      }
      var can = !!(h && h.act);
      var icon = can ? (h.icon || ACTION_ICONS[best.type] || 'interact-hand') : null;
      if (can !== this._canAct || icon !== this._actIcon) {
        this._canAct = can;
        this._actIcon = icon;
        try { document.body.classList.toggle('can-act', can); } catch (e) { /* ignore */ }
        if (SE.UI && SE.UI.setAction) ui('setAction', can ? { icon: icon, label: h.text } : null);
      }
      var sellable = sd().dragons.length > sd().equipped.length;
      if (sellable !== this._sellable) {
        this._sellable = sellable;
        if (SE.UI && SE.UI.setAction2) ui('setAction2', sellable);
      }
    },

    hintFor: function (it) {
      var S = St(), d = sd(), Dd = D();
      switch (it.type) {
        case 'nest': {
          var n = it.nest;
          if (!n) return null;
          if (this.carrying) return { text: t('game.hint.carrying'), act: false };
          if (n.taken) {
            var left = n._respawnAt ? Math.max(0, n._respawnAt - this.time) : 0;
            return { text: left > 0 ? t('game.hint.nestEmpty', clock(left)) : t('game.hint.nestEmpty0'), act: false };
          }
          var li = lairIndexOf(n.lair);
          if (!S.lairUnlocked(li) && !this.trialAllows(li)) return { text: t('game.hint.trialUsed'), act: false };
          return { text: t('game.hint.steal', Dd.eggName(li)), act: true };
        }
        case 'hatchery': {
          var hi = fin(it.index) ? it.index : it.hatchery, h = d.hatcheries[hi];
          if (!h) return null;
          if (!h.unlocked) return { text: t('game.hint.buyHatch', money(S.hatcheryPrice(hi))), act: true, icon: 'pen-house' };
          if (h.baby) return { text: t('game.hint.collect', Dd.fullName(h.baby.species, h.baby.variant)), act: true };
          if (h.egg) {
            var rem = clock(S.hatchRemaining(hi));
            var adOk = SE.Ads && SE.Ads.ready('instantHatch') && !tutActive();
            return { text: adOk ? t('game.hint.hatchingAd', rem) : t('game.hint.hatching', rem), act: !!adOk };
          }
          if (this.carrying && this.carryDelivered) return { text: t('game.hint.placeEgg'), act: true };
          return { text: t('game.hint.emptyHatch'), act: false };
        }
        case 'sell': {
          var n2 = d.dragons.length - d.equipped.length;
          return { text: n2 > 0 ? t('game.hint.sell', n2) : t('game.hint.sellNone'), act: true };
        }
        case 'shop': return { text: t('game.hint.shop'), act: true };
        case 'wheel': return { text: t('game.hint.wheel'), act: true };
        case 'gift': return { text: t('game.hint.gift'), act: true };
        case 'index': return { text: t('game.hint.index'), act: true };
        case 'upgrade': {
          var pr = S.treadmillUpgradePrice();
          return { text: pr === null ? t('game.tm.maxed') : t('game.hint.upgrade', money(pr)), act: true };
        }
        case 'lairGate': {
          var gi = it.lairIndex;
          if (S.lairUnlocked(gi)) return null;
          var gp = this.lairPrice(gi);
          if (this.trial && this.trial.lair === gi) {
            var tl = Math.max(0, (this.trial.endAt - Date.now()) / 1000);
            return { text: t('game.hint.trialGate', clock(tl)), act: S.canAfford(gp) };
          }
          var trialAd = !S.canAfford(gp) && !tutActive() && SE.Ads && SE.Ads.ready('trialRaid') && SE.Ads.available('trialRaid', { lair: gi });
          return { text: t(trialAd ? 'game.hint.unlockLairTrial' : 'game.hint.unlockLair', Dd.lairName(gi), money(gp)), act: true };
        }
        case 'treadmill': {
          var tmK = this.turboMult();
          return { text: t(tmK > 1 ? 'game.hint.trainTurbo' : 'game.hint.train', (S.trainRate(true) * tmK).toFixed(2)), act: false };
        }
        default: {
          var key = SE.Input.mode === 'touch' && it.hintMobile ? it.hintMobile : it.hint;
          if (!key) return null;
          var txt = SE.I18N && SE.I18N.has && SE.I18N.has(key) ? t(key) : key;
          return { text: txt, act: typeof it.onAction === 'function' };
        }
      }
    },

    doAction: function (it) {
      if (!it) return;
      var S = St(), d = sd();
      switch (it.type) {
        case 'nest':
          if (this.carrying) { audio('error'); toast(t('game.hint.carrying'), 'info'); return; }
          if (it.nest && !it.nest.taken) this.stealEgg(it.nest);
          return;
        case 'hatchery': {
          var hi = fin(it.index) ? it.index : it.hatchery, h = d.hatcheries[hi];
          if (!h) return;
          if (!h.unlocked) { this.buyHatchery(hi); return; }
          if (h.baby) { this.collectHatchery(hi); return; }
          if (h.egg) { if (!tutActive()) this.offer('instantHatch', { hatchery: hi }); return; }
          if (this.carrying && this.carryDelivered) { this.storeEgg(this.carrying, hi); return; }
          if (!tutActive()) ui('open', 'eggs');
          return;
        }
        case 'sell':
          if (d.dragons.length > d.equipped.length) this.sellAll();
          else ui('open', 'dragons');
          return;
        case 'shop': ui('open', 'shop'); return;
        case 'wheel': ui('open', 'wheel'); return;
        case 'gift': ui('open', 'daily'); return;
        case 'index': ui('open', 'index'); return;
        case 'upgrade':
          if (SE.UI && SE.UI.open) ui('open', 'upgrade'); else this.upgradeTreadmill();
          return;
        case 'lairGate':
          if (!S.lairUnlocked(it.lairIndex)) this.unlockLair(it.lairIndex);
          return;
        case 'treadmill': return;
        default:
          if (typeof it.onAction === 'function') { try { it.onAction(this); } catch (e) { report('interactable.onAction', e); } }
      }
    },

    offer: function (id, ctx) {
      var A = SE.Ads;
      if (!A || tutActive() || !A.ready(id) || !A.available(id, ctx || {})) return false;
      var o = A.get(id), data = { id: id, offer: id, ctx: ctx || {} };
      if (o && o.icon && o.icon.indexOf('/') >= 0) data.icon = o.icon;   // e.g. 'render/gems-pile'
      ui('open', 'offer', data);
      return true;
    },

    atBase: function () {
      var Wd = W(), p = P().pos;
      return !!(Wd && Wd.inSafeZone && Wd.inSafeZone(p.x, p.z));
    },

    /* ================================================================== */
    /* treadmill                                                           */
    /* ================================================================== */
    updateTreadmill: function (dt) {
      var Wd = W(), list = Wd && Wd.treadmills, Pl = P(), tm = null;
      if (list) {
        for (var i = 0; i < list.length; i++) {
          var c = list[i], dx = c.x - Pl.pos.x, dz = c.z - Pl.pos.z, on;
          if (fin(c.w) && fin(c.d)) on = Math.abs(dx) < c.w / 2 + 0.4 && Math.abs(dz) < c.d / 2 + 0.4;
          else on = dx * dx + dz * dz < (c.r || 3) * (c.r || 3);
          if (on && Pl.grounded) { tm = c; break; }
        }
      }
      this.onTreadmill = !!tm;
      var training = !!tm && Pl.moving;
      if (tm) {
        var before = Math.floor(sd().speed);
        var tmK = this.turboMult();
        St().train(dt * tmK, Pl.moving);                // turboTrain: ×3 (dt stays ≪ 1 s, State.train clamps at 1 s)
        if (tmK > 1 && Pl.moving) {
          this._turboFx -= dt;
          if (this._turboFx <= 0) { this._turboFx = 0.4; fx('sparkle', V(Pl.pos.x, Pl.pos.y + 1.2, Pl.pos.z), { count: 0.35, scale: 0.6 }); }
        }
        var after = Math.floor(sd().speed);
        if (after > before) {
          floatText('+' + (after - before) + ' ⚡', V(Pl.pos.x, Pl.pos.y + 8, Pl.pos.z), 'speed');
          if (after % 5 === 0) fx('levelup', V(Pl.pos.x, Pl.pos.y + 1, Pl.pos.z), { count: 0.5, scale: 0.8 });
        }
        if (Pl.moving) {
          /* conveyor: the belt (runs south) cancels the runner's northward motion; sideways = step off */
          var back = Math.max(0, -Pl.vel.z);
          var lim = fin(tm.d) ? tm.z + tm.d / 2 - 0.6 : tm.z + (tm.r || 3) * 0.7;
          if (Pl.pos.z < lim) { Pl.pos.z = Math.min(lim, Pl.pos.z + back * dt); Pl.group.position.copy(Pl.pos); }
        }
      }
      if (training && !this._tmSound) this._tmSound = audio('treadmill', { loop: true, volume: 0.35 }) || null;
      else if (!training && this._tmSound) { try { this._tmSound.stop(0.25); } catch (e) { /* ignore */ } this._tmSound = null; }
    },

    /* ================================================================== */
    /* nests: steal / respawn                                              */
    /* ================================================================== */
    takeNest: function (nest, by) {
      if (!nest) return;
      var li = lairIndexOf(nest.lair), sp = D().species(li);
      var secs = sp && fin(sp.nestRespawn) ? sp.nestRespawn : 12;
      call(W(), 'setNestTaken', nest, true, secs);      // the world counts nest.respawn down and shows a new egg
      nest.taken = true;
      nest.respawn = secs;
      nest._respawnAt = this.time + secs;
      nest.takenBy = by || 'player';
    },
    restoreNest: function (nest) {
      if (!nest) return;
      call(W(), 'setNestTaken', nest, false);
      nest.taken = false;
      nest.respawn = 0;
      nest._respawnAt = 0;
      nest.takenBy = null;
    },
    updateNests: function () {
      var Wd = W(), list = Wd && Wd.nests;
      if (!list) return;
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        if (n.taken && n._respawnAt && this.time >= n._respawnAt) this.restoreNest(n);
      }
    },

    lairPrice: function (i) { return St().lairPrice(i, boost('lairDiscount') ? 0.7 : 1); },

    stealEgg: function (nest) {
      if (!this.ready || !nest || nest.taken || this.carrying) return false;
      var li = lairIndexOf(nest.lair);
      var onTrial = !St().lairUnlocked(li);
      if (onTrial && !this.trialAllows(li)) {
        if (this.trial && this.trial.lair === li) { audio('error'); toast(t('game.hint.trialUsed'), 'info'); }
        return false;
      }
      var sp = D().species(li);
      if (!sp) return false;
      var luck = boost('luckyEgg') ? 2 : 1;
      var egg = D().makeEgg(sp.id, luck);
      var golden = false;
      if (!tutActive() && this.goldenPending()) {          // goldenEgg reward: at least Golden
        golden = true;
        if (egg.variant < 1) egg.variant = this.rollFloor1(luck);
        SE.Ads.store().golden = false;
      }
      this.takeNest(nest, 'player');
      this.carrying = egg;
      this.carryDelivered = false;
      P().setCarry(egg, eggRig(egg, 1.15));
      sd().stats.steals++;
      this.round = { token: 'r' + Date.now().toString(36) + '_' + (++this._seq), egg: egg, nest: nest, lair: li, start: this.time };
      if (onTrial && this.trial) this.trial.token = this.round.token;   // the one trial round
      this.lastCaught = null;
      var pos = V(nest.x, 2.2, nest.z);
      audio('egg_pickup');
      fx('steal_burst', pos);
      if (egg.variant > 0) {
        var vd = D().variant(egg.variant);
        fx(['sparkle', 'gold_glints', 'crystal_glints', 'rainbow_motes', 'galaxy_stars'][egg.variant] || 'sparkle', pos);
        toast(t(golden ? 'game.toast.goldenUsed' : 'game.toast.rareEgg', D().fullEggName(sp.id, egg.variant)), 'good');
        if (vd) floatText(D().variantName(egg.variant, 'egg'), V(pos.x, pos.y + 5, pos.z), 'rare');
      }
      if (golden) this.saveNow();
      var lair = W().lairs ? W().lairs[li] : null;
      if (SE.DragonAI && SE.DragonAI.alarm) call(SE.DragonAI, 'alarm', lair || li, { kind: 'player' });
      tutNotify('stole', { egg: egg, nest: nest, lair: li });
      return true;
    },

    /* Put an egg into a hatchery (given or the first free one). -> index | -1 */
    storeEgg: function (egg, idx) {
      var S = St();
      if (!egg) return -1;
      var i = fin(idx) ? idx : S.freeHatchery();
      if (i < 0) return -1;
      var secs = null;
      if (SE.Tutorial && typeof SE.Tutorial.hatchOverride === 'function') {
        try { secs = SE.Tutorial.hatchOverride(egg); } catch (e) { secs = null; }
      }
      if (!S.placeEgg(i, egg, fin(secs) && secs > 0 ? secs : undefined)) return -1;
      if (this.carrying === egg) {
        this.carrying = null;
        this.carryDelivered = false;
        P().setCarry(null);
      }
      audio('egg_place');
      this.syncHatcheries(0);
      var Wh = W().hatcheries && W().hatcheries[i];
      if (Wh) fx('sparkle', V(Wh.x, 2, Wh.z));
      tutNotify('placed', { index: i, hatchery: i, egg: egg });
      this.saveNow();
      return i;
    },

    onDelivered: function () {
      var egg = this.carrying;
      if (!egg || this.carryDelivered) return;
      var S = St(), Dd = D(), Pl = P();
      var cash = Dd.deliveryCash(egg), gems = Dd.deliveryGems ? Dd.deliveryGems(egg) : (Dd.species(egg.species).gems + egg.variant);
      if (boost('gemsX2')) gems *= (SE.Ads && SE.Ads.REWARD ? SE.Ads.REWARD.gemsMult : 2);
      S.addMoney(cash);
      S.addGems(gems);
      sd().stats.delivered++;
      var round = this.round;
      this.round = null;
      this.lastCaught = null;
      if (this.trial && round && round.token === this.trial.token) this.trial.done = true;
      call(SE.DragonAI, 'calmPlayer');
      this.carryDelivered = true;                   // until it is stored in a hatchery
      tutNotify('delivered', { egg: egg });
      var placed = this.storeEgg(egg);
      if (placed < 0) toast(t('game.toast.noHatchery'), 'error');
      var pos = V(Pl.pos.x, Pl.pos.y + 2, Pl.pos.z);
      audio('win');
      audio('coin', { delay: 0.15 });
      fx('coin_burst', pos);
      fx('gem_burst', V(pos.x, pos.y + 2, pos.z));
      floatText('+' + money(cash), V(pos.x, pos.y + 6, pos.z), 'cash');
      floatText('+' + gems + ' 💎', V(pos.x + 1.5, pos.y + 4.5, pos.z), 'gem');
      var vic = sd().cosmetics && sd().cosmetics.equipped ? sd().cosmetics.equipped.victory : null;
      if (SE.Cosmetics && SE.Cosmetics.playVictory) call(SE.Cosmetics, 'playVictory', vic || null, Pl.pos.clone(), Pl.model);
      else if (Pl.model && Pl.model.celebrate) call(Pl.model, 'celebrate');
      Pl.celebrate(2.6);
      this.shake(0.25);
      S.computeScore();
      if (!tutActive()) {
        call(SE.Ads, 'roundEnded', round ? round.token : null);
        var token = round ? round.token : 'd' + (++this._seq);
        this.lastDelivery = { token: token, cash: cash, gems: gems, tripled: false };
        var data = { win: true, egg: egg, cash: cash, gems: gems, hatchery: placed, stored: placed >= 0, round: token };
        data.offers = this.resultOffers(data);
        setTimeout(function () { ui('open', 'result', data); }, 650);
      }
      if (sd().stats.delivered % 10 === 0) this.submitScore();
      this.saveNow();
    },

    onCaught: function (dragon) {
      if (!this.ready || !this.carrying || this.carryDelivered) return;
      if (this.statuses.invisible > 0) return;
      if (this.time - this._caughtAt < 1) return;
      if (boost('dragonShield') && !tutActive()) { this.shieldSave(dragon); return; }
      this._caughtAt = this.time;
      var Pl = P(), egg = this.carrying, round = this.round, Dd = D();
      if (this.trial && round && round.token === this.trial.token) this.trial.done = true;
      var dInfo = dragon || {};
      var li = round ? round.lair : lairIndexOf(dInfo.lair);
      var species = dInfo.species || (dInfo.rig && dInfo.rig.species) || (Dd.species(lairIndexOf(dInfo.lair)) || Dd.species(li) || {}).id;
      var pos = V(Pl.pos.x, Pl.pos.y + 3, Pl.pos.z);
      audio('caught');
      this.shake(0.9);
      fx('roar_wave', pos);
      if (round && round.nest) this.restoreNest(round.nest);
      this.lastCaught = { egg: egg, round: round, x: Pl.pos.x, z: Pl.pos.z, yaw: Pl.yaw, nest: round ? round.nest : null };
      this.carrying = null;
      this.carryDelivered = false;
      Pl.setCarry(null);
      sd().stats.caught++;
      call(SE.DragonAI, 'calmPlayer');
      this.clearStatuses();
      Pl.teleportHome();
      this.round = null;
      tutNotify('caught', { egg: egg, dragon: dragon });
      if (!tutActive()) {
        call(SE.Ads, 'roundEnded', round ? round.token : null);
        var data = { win: false, egg: egg, lostEgg: egg, dragon: { species: species, role: dInfo.role || 'guardian', lair: li } };
        setTimeout(function () { ui('open', 'result', data); }, 450);
      }
      this.saveNow();
    },

    revive: function () {
      var lc = this.lastCaught, Pl = P();
      if (!lc || this.carrying) return false;
      this.lastCaught = null;
      Pl.teleport(lc.x, lc.z, lc.yaw);
      if (lc.nest && !lc.nest.taken) this.takeNest(lc.nest, 'player');
      this.carrying = lc.egg;
      this.carryDelivered = false;
      Pl.setCarry(lc.egg, eggRig(lc.egg, 1.15));
      this.round = lc.round || { token: 'rv' + (++this._seq), egg: lc.egg, nest: lc.nest, lair: 0, start: this.time };
      /* a revived trial-raid round continues: its gate opens again until this round ends */
      var rl = this.round.lair;
      if (fin(rl) && rl > 0 && !St().lairUnlocked(rl)) {
        var tr = this.trial;
        if (!tr || tr.lair !== rl) this.trial = tr = { lair: rl, endAt: 0, secs: 0, token: null, done: false, expired: false, open: false };
        tr.token = this.round.token; tr.done = false; tr.expired = false;
        tr.endAt = Math.max(tr.endAt || 0, Date.now() + 60000);
        this.setTrialGate(rl, true);
      }
      this.applyStatus('invisible', SE.Ads && SE.Ads.REWARD ? SE.Ads.REWARD.reviveSecs : 20);
      if (SE.Boosts) SE.Boosts.activate('speedBoost', 20);
      fx('sparkle', V(lc.x, 3, lc.z));
      toast(t('game.toast.revive'), 'good');
      return true;
    },

    /* ================================================================== */
    /* hatcheries                                                          */
    /* ================================================================== */
    setHatcheryLocked: function (i, locked) {
      var Wd = W(), h = Wd && Wd.hatcheries && Wd.hatcheries[i];
      if (!h) return;
      if (typeof Wd.setHatcheryLocked === 'function') { call(Wd, 'setHatcheryLocked', i, locked); return; }
      if (typeof Wd.setHatcheryUnlocked === 'function') { call(Wd, 'setHatcheryUnlocked', i, !locked); return; }
      if (h.lockLabel) h.lockLabel.visible = locked;
      if (h.sign) h.sign.visible = locked;
      if (h.lock) h.lock.visible = locked;
    },

    syncHatcheries: function (dt) {
      var Wd = W(), d = sd();
      if (!Wd || !Wd.hatcheries || !d) return;
      var Pl = P();
      this._timers.labels -= dt;
      var doLabels = this._timers.labels <= 0;
      if (doLabels) this._timers.labels = 0.25;
      for (var i = 0; i < d.hatcheries.length; i++) {
        var h = d.hatcheries[i], wh = Wd.hatcheries[i];
        if (!wh) continue;
        var v = this._hv[i] || (this._hv[i] = { key: null, rig: null, unlocked: null, label: null, kind: '' });
        if (v.unlocked !== h.unlocked) { this.setHatcheryLocked(i, !h.unlocked); v.unlocked = h.unlocked; }
        var key = h.egg ? 'e:' + h.egg.species + ':' + h.egg.variant : (h.baby ? 'b:' + h.baby.species + ':' + h.baby.variant : '');
        if (key !== v.key) {
          var hatchedNow = v.key && v.key.charAt(0) === 'e' && key.charAt(0) === 'b';
          disposeRig(v.rig);
          v.rig = null;
          v.kind = key.charAt(0);
          if (h.egg) v.rig = eggRig(h.egg, 1.8);
          else if (h.baby) {
            v.rig = babyRig(h.baby.species, h.baby.variant);
            if (v.rig && v.rig.setState) call(v.rig, 'setState', 'sit');
          }
          if (v.rig && v.rig.group) {
            if (wh.content && wh.content.isObject3D) { v.rig.group.position.set(0, 0, 0); wh.content.add(v.rig.group); }
            else { v.rig.group.position.set(wh.x, 0.6, wh.z); this.scene.add(v.rig.group); }
          }
          call(Wd, 'setHatcheryBanner', i, h.egg ? h.egg.species : (h.baby ? h.baby.species : null));
          if (hatchedNow && this.booted) {
            var pos = V(wh.x, 2.5, wh.z);
            fx('hatch_burst', pos);
            audio('crack', { pos: { x: wh.x, z: wh.z } });
            audio('hatch', { pos: { x: wh.x, z: wh.z }, delay: 0.12 });
            audio('baby_chirp', { pos: { x: wh.x, z: wh.z }, delay: 0.5 });
            if (!tutActive()) toast(t('game.toast.hatched', D().fullName(h.baby.species, h.baby.variant)), 'good');
            tutNotify('hatched', { index: i, hatchery: i, species: h.baby.species, variant: h.baby.variant });
          }
          v.key = key;
          v.label = null;
          v.near = undefined;
        }
        if (v.rig) {
          if (v.kind === 'e') {
            var p = St().hatchProgress(i);
            if (v.rig.setWobble) v.rig.setWobble(p > 0.72 ? (p - 0.72) / 0.28 : 0);
            if (v.rig.update) v.rig.update(dt);
          } else if (v.kind === 'b') {
            var near = Pl && Math.abs(Pl.pos.x - wh.x) + Math.abs(Pl.pos.z - wh.z) < 16;
            if (v.rig.setState && near !== v.near) { call(v.rig, 'setState', near ? 'happy' : 'sit'); v.near = near; }
            if (near && v.rig.setLookTarget) call(v.rig, 'setLookTarget', _look.set(Pl.pos.x, Pl.pos.y + 5, Pl.pos.z));
            if (v.rig.update) v.rig.update(dt, 0);
          }
        }
        if (doLabels && wh.stateLabel) {
          var text = h.egg ? clock(St().hatchRemaining(i)) : (h.baby ? t('time.ready') : '');
          if (text !== v.label) {
            v.label = text;
            if (typeof Wd.setHatcheryLabel === 'function') call(Wd, 'setHatcheryLabel', i, text, h.baby ? '#7dff5a' : '#ffffff');
            else { setLabel(wh.stateLabel, text); wh.stateLabel.visible = !!text; }
          }
        }
      }
    },

    collectHatchery: function (i) {
      var S = St(), Dd = D();
      var res = S.collectHatchery(i);
      if (!res) return null;
      var wh = W().hatcheries && W().hatcheries[i];
      var pos = wh ? V(wh.x, 3, wh.z) : P().pos.clone();
      this.syncHatcheries(0);
      audio('collect');
      audio('baby_chirp', { delay: 0.2 });
      fx('sparkle', pos);
      fx('hatch_burst', pos, { count: 0.6 });
      var name = Dd.fullName(res.species, res.variant);
      toast(t(res.isNew ? 'game.toast.newDragon' : 'game.toast.collected', name), 'good');
      if (res.autoSold) toast(t('game.toast.autoSold', Dd.fullName(res.autoSold.species, res.autoSold.variant), money(res.autoSold.value)), 'info');
      P().refreshFollowers();
      P().celebrate(1.5);
      tutNotify('collected', { index: i, hatchery: i, species: res.species, variant: res.variant, uid: res.uid });
      S.computeScore();
      if (res.isNew) this.submitScore();
      this.saveNow();
      ui('updateHUD');
      return res;
    },

    buyHatchery: function (i) {
      var S = St();
      if (!fin(i)) i = S.nextLockedHatchery();
      if (i < 0) return false;
      var price = S.hatcheryPrice(i);
      if (!S.buyHatchery(i)) {
        if (sd().hatcheries[i] && !sd().hatcheries[i].unlocked) {
          audio('error');
          toast(t('game.toast.noMoney', money(price)), 'error');
          if (S.nextLockedHatchery() === i) this.offer('freeHatchery');
        }
        return false;
      }
      this.afterHatcheryUnlock(i);
      return true;
    },
    afterHatcheryUnlock: function (i) {
      var wh = W().hatcheries && W().hatcheries[i];
      audio('unlock');
      if (wh) fx('unlock_burst', V(wh.x, 1, wh.z));
      toast(t('game.toast.hatchBought'), 'good');
      this.syncHatcheries(0);
      if (this.carrying && this.carryDelivered) this.storeEgg(this.carrying, i);
      this.saveNow();
      ui('updateHUD');
    },

    /* ================================================================== */
    /* dragons: sell / followers / cosmetics                               */
    /* ================================================================== */
    sellDragons: function (uids) {
      var S = St();
      var res = S.sellDragons(uids || [], boost('doubleSell') ? 2 : 1);
      if (!res.count) return res;
      var Pl = P(), pos = V(Pl.pos.x, Pl.pos.y + 3, Pl.pos.z);
      audio('sell');
      fx('coin_burst', pos);
      floatText('+' + money(res.total), V(pos.x, pos.y + 4, pos.z), 'cash');
      toast(t('game.toast.sold', res.count, money(res.total)), 'good');
      Pl.refreshFollowers();
      this.saveNow();
      ui('updateHUD');
      return res;
    },
    sellAll: function () {
      var S = St(), d = sd();
      var uids = d.dragons.filter(function (x) { return !S.isEquipped(x.uid); }).map(function (x) { return x.uid; });
      if (!uids.length) { audio('error'); toast(t('game.toast.nothingToSell'), 'info'); return { count: 0, total: 0 }; }
      return this.sellDragons(uids);
    },
    refreshFollowers: function () { P().refreshFollowers(); },
    refreshCosmetics: function () { P().refreshCosmetics(); },

    /* ================================================================== */
    /* lairs / treadmill purchases                                         */
    /* ================================================================== */
    syncLairs: function () {
      var Wd = W(), d = sd();
      if (!Wd || !Wd.lairs) return;
      for (var i = 0; i < Wd.lairs.length; i++) {
        var want = !!d.lairs[i];
        if (Wd.lairs[i] && Wd.lairs[i].unlocked !== want && Wd.setLairUnlocked) call(Wd, 'setLairUnlocked', i, want);
      }
    },
    unlockLair: function (i) {
      var S = St();
      if (S.lairUnlocked(i)) return true;
      var discount = boost('lairDiscount');
      var price = S.lairPrice(i, discount ? 0.7 : 1);
      if (!S.buyLair(i, discount ? 0.7 : 1)) {
        audio('error');
        toast(t('game.toast.noMoney', money(price)), 'error');
        this.offerForGate(i);
        return false;
      }
      if (this.trial && this.trial.lair === i) {                      // bought during a trial raid: stays open
        if (W() && typeof W().setLairTrial === 'function') call(W(), 'setLairTrial', i, false);
        this.trial = null;
      }
      this.afterLairUnlock(i);
      return true;
    },
    /* Not enough cash at a locked gate: the discount when it makes the lair affordable,
       otherwise a trial raid (one round), otherwise the discount anyway. */
    offerForGate: function (i) {
      var S = St(), disc = boost('lairDiscount');
      if (!disc && S.canAfford(S.lairPrice(i, 0.7)) && this.offer('lairDiscount', { lair: i })) return 'lairDiscount';
      if (this.offer('trialRaid', { lair: i })) return 'trialRaid';
      if (!disc && this.offer('lairDiscount', { lair: i })) return 'lairDiscount';
      return null;
    },
    afterLairUnlock: function (i) {
      call(W(), 'setLairUnlocked', i, true);
      var lair = W().lairs && W().lairs[i];
      var g = lair && lair.gate ? lair.gate : null;
      audio('unlock');
      if (g) fx('unlock_burst', V(g.x, 3, g.z));
      this.shake(0.3);
      toast(t('game.toast.lairUnlocked', D().lairName(i)), 'good');
      this.saveNow();
      this.submitScore();
      ui('updateHUD');
    },
    upgradeTreadmill: function () {
      var S = St(), price = S.treadmillUpgradePrice();
      if (price === null) { toast(t('game.tm.maxed'), 'info'); return false; }
      if (!S.buyTreadmillUpgrade()) {
        audio('error');
        toast(t('game.toast.noMoney', money(price)), 'error');
        return false;
      }
      var Pl = P();
      audio('levelup');
      fx('levelup', V(Pl.pos.x, Pl.pos.y + 1, Pl.pos.z));
      toast(t('game.toast.tmUpgraded', S.treadmillLevel()), 'good');
      this.updateUpgradeSign();
      this.saveNow();
      ui('updateHUD');
      return true;
    },
    updateUpgradeSign: function () {
      var Wd = W(), sign = Wd && Wd.upgradeSign, S = St();
      if (!sign || typeof sign.setText !== 'function') return;
      if (typeof Wd.syncTreadmill === 'function') { sign.level = null; call(Wd, 'syncTreadmill'); return; }   // the world draws it
      var lvl = S.treadmillLevel(), price = S.treadmillUpgradePrice();
      try {
        if (price === null) sign.setText(t('game.tm.max', lvl), '');
        else sign.setText(t('game.tm.level', lvl, lvl + 1), money(price));
      } catch (e) { report('upgradeSign.setText', e); }
    },

    /* ================================================================== */
    /* rewards (SPEC §7/§8)                                                */
    /* ================================================================== */
    applyReward: function (id, ctx) {
      ctx = ctx || {};
      var S = St(), B = SE.Boosts, Dd = D(), Pl = P();
      var offer = SE.Ads && SE.Ads.get ? SE.Ads.get(id) : null;
      var dur = offer && offer.dur ? offer.dur : 0;
      var pos = V(Pl.pos.x, Pl.pos.y + 4, Pl.pos.z);
      var ok = true;
      switch (id) {
        case 'x2income': case 'x2hatch': case 'speedBoost': case 'luckyEgg':
        case 'magnet': case 'doubleSell': case 'lairDiscount': case 'dragonSleep':
        case 'dragonShield': case 'turboTrain': case 'gemsX2':
          B.activate(id, dur || ({ x2income: 180, x2hatch: 300, speedBoost: 60, luckyEgg: 180, magnet: 60, doubleSell: 180, lairDiscount: 300, dragonSleep: 45,
            dragonShield: 300, turboTrain: 180, gemsX2: 600 })[id]);
          if (id === 'dragonSleep') { if (SE.DragonAI && SE.DragonAI.sleepAll) call(SE.DragonAI, 'sleepAll'); else call(SE.DragonAI, 'calmPlayer'); }
          if (id === 'doubleSell' && fin(ctx.amount) && ctx.amount > 0) { S.addMoney(ctx.amount); floatText('+' + money(ctx.amount), pos, 'cash'); }
          if (id === 'dragonShield') { audio('freeze', { volume: 0.6 }); if (SE.FX && SE.FX.flash) { try { SE.FX.flash(pos, '#bff1ff', { size: 9, life: 0.3 }); } catch (e) { /* optional */ } } }
          break;
        case 'teleportHome':
          ok = this.teleportHomeWithEgg();
          break;
        case 'trialRaid':
          ok = this.startTrial(fin(ctx.lair) ? ctx.lair : this.trialTarget());
          break;
        case 'goldenEgg': {
          var rs = SE.Ads && SE.Ads.store ? SE.Ads.store() : null;
          ok = !!rs && !rs.golden;
          if (ok) { rs.golden = true; fx('gold_glints', pos); floatText('★', pos, 'good'); }
          break;
        }
        case 'tripleReward': {
          var ld = this.lastDelivery;
          ok = !!ld && !ld.tripled && (!ctx.token || ctx.token === ld.token);
          if (!ok) break;
          var k3 = (SE.Ads && SE.Ads.REWARD ? SE.Ads.REWARD.tripleMult : 3) - 1;
          ld.tripled = true;
          S.addMoney(ld.cash * k3);
          S.addGems(ld.gems * k3);
          S.computeScore();
          fx('coin_burst', pos);
          fx('gem_burst', V(pos.x, pos.y + 2, pos.z));
          floatText('+' + money(ld.cash * k3), pos, 'cash');
          if (ld.gems > 0) floatText('+' + ld.gems * k3 + ' 💎', V(pos.x + 1.5, pos.y - 1.5, pos.z), 'gem');
          audio('coin', { delay: 0.1 });
          audio('gem', { delay: 0.25 });
          break;
        }
        case 'freeChest': {
          var res = this.rollChest();
          ok = !!res;
          if (ok) {
            this.lastChest = res;
            audio('gift_open');
            if (SE.OffersUI && typeof SE.OffersUI.chestReveal === 'function') {
              setTimeout(function () { try { SE.OffersUI.chestReveal(res); } catch (e) { report('OffersUI.chestReveal', e); } }, 260);
            } else toast(t('game.toast.reward', SE.Ads ? SE.Ads.title(id) : id), 'good');
          }
          break;
        }
        case 'instantHatch': {
          var hs = sd().hatcheries, idx = fin(ctx.hatchery) && hs[ctx.hatchery] && hs[ctx.hatchery].egg ? ctx.hatchery : -1;
          if (idx < 0) {
            var most = -1;
            for (var i = 0; i < hs.length; i++) if (hs[i].egg && S.hatchRemaining(i) > most) { most = S.hatchRemaining(i); idx = i; }
          }
          ok = idx >= 0 && S.finishHatch(idx);
          this.syncHatcheries(0);
          break;
        }
        case 'revive':
          ok = this.revive();
          break;
        case 'cashBonus': {
          var amount = fin(ctx.amount) && ctx.amount > 0 ? ctx.amount : S.cashBonusAmount(1);
          S.addMoney(amount);
          fx('coin_burst', pos);
          floatText('+' + money(amount), pos, 'cash');
          break;
        }
        case 'freeHatchery': {
          var hi = S.nextLockedHatchery();
          ok = hi >= 0 && S.unlockHatchery(hi);
          if (ok) this.afterHatcheryUnlock(hi);
          break;
        }
        case 'offlineX2': {
          var am = 0;
          if (S.pendingOffline && S.pendingOffline.amount > 0) am = S.claimOffline(2);   // never claimed yet: pay ×2 at once
          else {
            am = fin(ctx.amount) && ctx.amount > 0 ? ctx.amount : this.offlineAmount;
            if (am > 0) S.addMoney(am);                                                  // the ×1 part was paid on arrival
          }
          ok = am > 0;
          if (ok) { floatText('+' + money(am), pos, 'cash'); fx('coin_burst', pos); }
          this.offlineAmount = 0;
          break;
        }
        case 'speedUp':
          S.addSpeed(SE.Ads && SE.Ads.REWARD ? SE.Ads.REWARD.speedUp : 15);
          fx('levelup', V(Pl.pos.x, Pl.pos.y + 1, Pl.pos.z));
          break;
        case 'upgradeEgg':
          ok = this.upgradeEgg(ctx);
          break;
        default:
          ok = false;
      }
      if (ok) {
        audio('reward');
        fx('sparkle', pos);
        /* these show their own feedback (toast / reveal) */
        if (['revive', 'teleportHome', 'trialRaid', 'freeChest'].indexOf(id) < 0) toast(t('game.toast.reward', SE.Ads ? SE.Ads.title(id) : id), 'good');
      }
      this.saveNow();
      ui('updateHUD');
      if (SE.UI && SE.UI.updateBoosts) ui('updateBoosts');
      return ok;
    },

    upgradeEgg: function (ctx) {
      var S = St(), Dd = D(), max = Dd.VARIANTS.length - 1, hs = sd().hatcheries;
      var target = null, hatch = -1;
      var uid = ctx && ctx.egg && ctx.egg.uid;
      if (uid) {
        for (var i = 0; i < hs.length; i++) if (hs[i].egg && hs[i].egg.uid === uid) { hatch = i; target = hs[i].egg; }
        if (!target && this.carrying && this.carrying.uid === uid) target = this.carrying;
      }
      if (!target && SE.Ads && SE.Ads._upgradeTarget) {
        var tg = SE.Ads._upgradeTarget(ctx || {});
        target = tg.egg;
        hatch = fin(tg.hatchery) ? tg.hatchery : -1;
      }
      if (!target || target.variant >= max) return false;
      target.variant++;
      if (ctx && ctx.egg && ctx.egg !== target && ctx.egg.uid === target.uid) ctx.egg.variant = target.variant;
      if (target === this.carrying) P().setCarry(target, eggRig(target, 1.15));
      this.syncHatcheries(0);
      var wh = hatch >= 0 && W().hatcheries ? W().hatcheries[hatch] : null;
      fx(['sparkle', 'gold_glints', 'crystal_glints', 'rainbow_motes', 'galaxy_stars'][target.variant] || 'sparkle', wh ? V(wh.x, 3, wh.z) : V(P().pos.x, 8, P().pos.z));
      toast(Dd.fullEggName(target.species, target.variant), 'good');
      return true;
    },

    /* ================================================================== */
    /* rewarded extras: trial raid, shield, golden egg, chest, teleport    */
    /* ================================================================== */
    turboMult: function () { return boost('turboTrain') ? (SE.Ads && SE.Ads.REWARD ? SE.Ads.REWARD.turboMult : 3) : 1; },
    goldenPending: function () {
      var r = SE.Ads && typeof SE.Ads.store === 'function' ? SE.Ads.store() : null;
      return !!(r && r.golden);
    },
    /* variant roll among Golden and rarer only (weights as in DragonData.rollVariant) */
    rollFloor1: function (luck) {
      var VS = D().VARIANTS, total = 0, i;
      luck = fin(luck) && luck > 0 ? luck : 1;
      for (i = 1; i < VS.length; i++) total += VS[i].chance * luck;
      var r = Math.random() * total;
      for (i = 1; i < VS.length; i++) {
        var w = VS[i].chance * luck;
        if (r < w) return i;
        r -= w;
      }
      return 1;
    },

    /* the first locked lair: the only gate the player can reach (gates follow one another) */
    trialTarget: function () {
      var d = sd();
      if (!d || !d.lairs) return -1;
      for (var i = 1; i < d.lairs.length; i++) if (!d.lairs[i]) return i;
      return -1;
    },
    trialAllows: function (li) {
      var tr = this.trial;
      return !!(tr && tr.lair === li && !tr.done && !tr.expired && (!tr.token || (this.round && this.round.token === tr.token)));
    },
    startTrial: function (i) {
      var S = St(), Wd = W();
      if (!fin(i) || i < 1 || S.lairUnlocked(i) || this.trial || !Wd || !Wd.lairs || !Wd.lairs[i]) return false;
      var secs = SE.Ads && SE.Ads.REWARD ? SE.Ads.REWARD.trialSecs : 180;
      this.trial = { lair: i, endAt: Date.now() + secs * 1000, secs: secs, token: null, done: false, expired: false, open: false };
      this.setTrialGate(i, true);
      var g = Wd.lairs[i].gate;
      if (g) fx('unlock_burst', V(g.x, 3, g.z));
      audio('unlock');
      this.shake(0.25);
      toast(t('game.toast.trialOpen', D().lairName(i), clock(secs)), 'good');
      return true;
    },
    /* open / close a gate for the trial without touching SE.State.data.lairs */
    setTrialGate: function (i, open) {
      var Wd = W();
      if (!Wd) return;
      if (this.trial && this.trial.lair === i) this.trial.open = !!open;
      if (typeof Wd.setLairTrial === 'function') { call(Wd, 'setLairTrial', i, !!open); return; }
      /* fallback: World.syncState mirrors SE.State every 0.5 s and would shut the gate again —
         keep it open while this trial says so (runtime wrapper, world.js itself is unchanged) */
      if (!Wd._seTrialWrap && typeof Wd.setLairUnlocked === 'function') {
        var orig = Wd.setLairUnlocked, game = this;
        Wd.setLairUnlocked = function (li, un, instant) {
          if (!un && game.trial && game.trial.open && game.trial.lair === li) un = true;
          return orig.call(this, li, un, instant);
        };
        Wd._seTrialWrap = true;
      }
      call(Wd, 'setLairUnlocked', i, !!open || St().lairUnlocked(i));
    },
    updateTrial: function () {
      var tr = this.trial;
      if (!tr) return;
      var Wd = W();
      if (St().lairUnlocked(tr.lair)) {
        if (Wd && typeof Wd.setLairTrial === 'function') call(Wd, 'setLairTrial', tr.lair, false);
        this.trial = null;
        return;
      }
      var inRound = !!(tr.token && this.round && this.round.token === tr.token && this.carrying && !this.carryDelivered);
      if (!tr.done && !tr.expired && !inRound && Date.now() >= tr.endAt) {
        tr.expired = true;
        if (!tr.token) toast(t('game.toast.trialOver'), 'info');
      }
      if ((tr.done || tr.expired) && !inRound) {
        /* close once the player is back south of the gate (never shut anyone inside) */
        var lair = Wd && Wd.lairs ? Wd.lairs[tr.lair] : null;
        var gz = lair && lair.gate ? lair.gate.z : (lair ? lair.zMax + 8 : 0);
        if (!lair || P().pos.z > gz + 6) {
          this.setTrialGate(tr.lair, false);
          this.trial = null;
        }
      }
    },

    /* per frame (gameplay only) */
    updateRewards: function (dt) {
      var Pl = P();
      this._idleFor = Pl.moving ? 0 : this._idleFor + dt;
      this.updateTrial();
      ShieldFx.update(dt, boost('dragonShield') && !tutActive(), Pl.group);
      var ra = this._shieldRealarm;
      if (ra && this.time >= ra.at) {
        this._shieldRealarm = null;
        /* the shield saved the egg; once the invisibility ends the lair hunts again */
        if (this.carrying && !this.carryDelivered && !this.atBase() && fin(ra.lair) && W() && W().lairs && W().lairs[ra.lair]) {
          call(SE.DragonAI, 'alarm', W().lairs[ra.lair], { kind: 'player' });
        }
      }
      if (SE.AdPads && SE.AdPads.update) call(SE.AdPads, 'update', dt, this);
    },

    teleportHomeWithEgg: function () {
      var Pl = P(), Wd = W();
      if (!this.carrying || this.carryDelivered || this.atBase() || !Wd) return false;
      var from = V(Pl.pos.x, Pl.pos.y + 3, Pl.pos.z);
      if (SE.FX && SE.FX.flash) { try { SE.FX.flash(from, '#d7b8ff', { size: 12, life: 0.35 }); } catch (e) { /* optional */ } }
      if (SE.FX && SE.FX.ring) { try { SE.FX.ring(V(from.x, 0.1, from.z), { radius: 9, color: '#b98aff', life: 0.6 }); } catch (e) { /* optional */ } }
      call(SE.DragonAI, 'calmPlayer');
      this.clearStatuses();
      Pl.teleportHome();
      var to = V(Pl.pos.x, 3, Pl.pos.z);
      if (SE.FX && SE.FX.ring) { try { SE.FX.ring(V(to.x, 0.1, to.z), { radius: 8, color: '#ffd34d', life: 0.7 }); } catch (e) { /* optional */ } }
      fx('sparkle', to);
      audio('whoosh', { volume: 0.9 });
      toast(t('game.toast.teleported'), 'good');
      this.onDelivered();                              // a normal delivered round (cash, gems, hatchery, result)
      return true;
    },

    /* dragonShield: this catch keeps the egg — knockback + short invisibility, shield consumed */
    shieldSave: function (dragon) {
      var Pl = P(), d = dragon || {};
      var R = SE.Ads && SE.Ads.REWARD ? SE.Ads.REWARD : {};
      var secs = R.shieldInvisSecs || 3;
      this._caughtAt = this.time;
      if (SE.Boosts) SE.Boosts.clear('dragonShield');
      var dx = fin(d.x) ? Pl.pos.x - d.x : 0, dz = fin(d.z) ? Pl.pos.z - d.z : 1;
      var l = Math.sqrt(dx * dx + dz * dz);
      if (l < 0.3) { dx = 0; dz = 1; l = 1; }
      dx /= l; dz /= l;
      dz += 0.6;                                       // lean towards home (south, +Z)
      this.applyStatus('invisible', secs);
      this.knockback(dx, dz, 4);
      this.shake(0.7);
      var pos = V(Pl.pos.x, Pl.pos.y + 3.6, Pl.pos.z);
      if (SE.FX && SE.FX.ring) { try { SE.FX.ring(V(pos.x, 0.12, pos.z), { radius: 11, color: '#8fe3ff', life: 0.7 }); } catch (e) { /* optional */ } }
      if (SE.FX && SE.FX.flash) { try { SE.FX.flash(pos, '#c8f4ff', { size: 13, life: 0.35 }); } catch (e) { /* optional */ } }
      fx('sparkle', pos);
      audio('freeze', { volume: 0.85 });
      audio('whoosh', { delay: 0.05 });
      floatText(t('game.status.shield'), V(pos.x, pos.y + 4, pos.z), 'good');
      toast(t('game.toast.shieldSaved'), 'good');
      this._shieldRealarm = { at: this.time + secs + 0.25, lair: this.round ? this.round.lair : null };
      ui('updateHUD');
      return true;
    },

    /* freeChest: the prize is decided and granted here (once, after the confirmed ad) */
    rollChest: function (rng) {
      rng = typeof rng === 'function' ? rng : Math.random;
      var S = St(), r = rng();
      var kind = r < 0.08 ? 'item' : (r < 0.26 ? 'boost' : (r < 0.46 ? 'cash' : 'gems'));
      if (kind === 'item') {
        var item = this.chestItem(rng);
        var C = SE.CosmeticData;
        if (item && S.grantItem(item)) return { kind: 'item', id: item, name: C && C.name ? C.name(item) : item };
        S.addGems(60);                                 // nothing left to win: a big gem prize instead
        return { kind: 'gems', amount: 60 };
      }
      if (kind === 'boost') {
        var pool = ['x2income', 'luckyEgg', 'speedBoost', 'magnet', 'gemsX2', 'turboTrain'];
        var bid = pool[Math.floor(rng() * pool.length) % pool.length];
        var o = SE.Ads && SE.Ads.get ? SE.Ads.get(bid) : null;
        var bs = o && o.dur ? o.dur : 60;
        SE.Boosts.activate(bid, bs);
        return { kind: 'boost', id: bid, secs: bs };
      }
      if (kind === 'cash') {
        var cash = S.cashBonusAmount(1);
        S.addMoney(cash);
        return { kind: 'cash', amount: cash };
      }
      var G = [10, 15, 15, 20, 20, 25, 30, 40];
      var gems = G[Math.floor(rng() * G.length) % G.length];
      S.addGems(gems);
      return { kind: 'gems', amount: gems };
    },
    chestItem: function (rng) {
      var C = SE.CosmeticData, S = St();
      if (!C) return null;
      var owns = function (id) { return S.owns(id); };
      var list = [];
      try { list = typeof C.wheelPool === 'function' ? C.wheelPool(owns) || [] : (C.ITEMS || []); } catch (e) { list = []; }
      var ex = Array.isArray(C.EXCLUSIVE_DAILY) ? C.EXCLUSIVE_DAILY : [];
      list = list.filter(function (it) { return it && it.id && !it.exclusive && !it.isDefault && ex.indexOf(it.id) < 0 && !S.owns(it.id); });
      if (!list.length) return null;
      var W8 = { common: 4, rare: 2, epic: 1, legendary: 0.5 }, total = 0;
      list.forEach(function (it) { total += W8[it.rarity] || 2; });
      var r = (rng || Math.random)() * total;
      for (var i = 0; i < list.length; i++) {
        r -= W8[list[i].rarity] || 2;
        if (r <= 0) return list[i].id;
      }
      return list[list.length - 1].id;
    },

    /* Extra rewarded offers for the result panel (rendered by ui/offers.js). */
    resultOffers: function (data) {
      var A = SE.Ads, ld = this.lastDelivery, out = [];
      if (!A || !data || !data.win || !ld || (data.round && data.round !== ld.token)) return out;
      if (typeof A.enabled === 'function' && !A.enabled()) return out;
      if (!A.available('tripleReward', { token: ld.token })) return out;
      var k = (A.REWARD ? A.REWARD.tripleMult : 3) - 1;
      out.push({
        id: 'tripleReward', placement: 'tripleReward', icon: 'trophy',
        ctx: { token: ld.token, cash: ld.cash, gems: ld.gems },
        title: A.title('tripleReward'), text: A.desc('tripleReward', { cash: ld.cash, gems: ld.gems }),
        extraCash: ld.cash * k, extraGems: ld.gems * k
      });
      return out;
    },

    /* The most relevant rewarded offer for the current situation (offer bubble, ui/offers.js). */
    contextOffer: function () {
      var A = SE.Ads, Wd = W(), Pl = P(), S = St();
      if (!A || !Wd || !this.booted || tutActive() || this.paused || !A.canShow()) return null;
      if (SE.DragonAI && SE.DragonAI.anyChasing && call(SE.DragonAI, 'anyChasing', 'player')) return null;
      function ok(id, ctx) { return A.ready(id) && A.available(id, ctx || {}); }
      var x = Pl.pos.x, z = Pl.pos.z, base = this.atBase();
      if (this.carrying && !this.carryDelivered) {
        if (!base && Wd.safeLineZ - z > 120 && ok('teleportHome')) return { id: 'teleportHome', ctx: {}, reason: 'far' };
        return null;
      }
      var lair = Wd.lairAt ? Wd.lairAt(x, z) : null;
      if (lair && !base && this.time - this._lairEnterAt < 8 && (S.lairUnlocked(lair.index) || this.trialAllows(lair.index))) {
        if (!boost('dragonSleep') && ok('dragonSleep')) return { id: 'dragonSleep', ctx: { lair: lair.index }, reason: 'lair' };
        if (!boost('dragonShield') && ok('dragonShield')) return { id: 'dragonShield', ctx: { lair: lair.index }, reason: 'lair' };
      }
      var gi = this.trialTarget();
      var gl = gi > 0 && Wd.lairs ? Wd.lairs[gi] : null;
      if (gl && gl.gate && !this.trial) {
        var gdx = x - gl.gate.x, gdz = z - (gl.gate.z + 7);
        if (gdx * gdx + gdz * gdz < 28 * 28 && !S.canAfford(this.lairPrice(gi))) {
          if (!boost('lairDiscount') && S.canAfford(S.lairPrice(gi, 0.7)) && ok('lairDiscount', { lair: gi })) return { id: 'lairDiscount', ctx: { lair: gi }, reason: 'gate' };
          if (ok('trialRaid', { lair: gi })) return { id: 'trialRaid', ctx: { lair: gi }, reason: 'gate' };
          if (!boost('lairDiscount') && ok('lairDiscount', { lair: gi })) return { id: 'lairDiscount', ctx: { lair: gi }, reason: 'gate' };
        }
      }
      if (this.onTreadmill && ok('turboTrain')) return { id: 'turboTrain', ctx: {}, reason: 'treadmill' };
      if (base) {
        var hs = sd().hatcheries, busy = 0;
        for (var i = 0; i < hs.length; i++) if (hs[i].egg) busy++;
        if (busy > 0 && S.freeHatchery() < 0) {
          if (ok('freeHatchery')) return { id: 'freeHatchery', ctx: {}, reason: 'hatcheries' };
          if (ok('instantHatch')) return { id: 'instantHatch', ctx: {}, reason: 'hatcheries' };
        }
        if (this._idleFor > 3) {
          var idle = ['x2income', 'luckyEgg', 'goldenEgg'];
          var start = Math.floor(this.time / 40) % idle.length;      // rotate between visits
          for (var k = 0; k < idle.length; k++) {
            var id = idle[(start + k) % idle.length];
            if (!boost(id) && ok(id)) return { id: id, ctx: {}, reason: 'idle' };
          }
        }
      }
      return null;
    },

    /* ================================================================== */
    /* zone banner, music, alarm                                           */
    /* ================================================================== */
    updateZoneAndMusic: function (dt) {
      var Wd = W(), Pl = P();
      if (!Wd) return;
      this._timers.zone -= dt;
      var chased = !!(SE.DragonAI && SE.DragonAI.anyChasing && call(SE.DragonAI, 'anyChasing', 'player'));
      if (chased) {
        var th = SE.DragonAI.threatLevel ? call(SE.DragonAI, 'threatLevel') : 0.5;
        th = fin(th) ? th : 0.5;
        call(SE.Audio, 'setMusicIntensity', th);
        if (SE.UI && SE.UI.setThreat) ui('setThreat', th);
      }
      if (chased !== this.alarmOn) {
        this.alarmOn = chased;
        ui('showAlarm', chased);
        if (chased) audio('alarm', { volume: 0.7 });
      }
      if (this._timers.zone > 0) return;
      this._timers.zone = 0.15;
      var x = Pl.pos.x, z = Pl.pos.z;
      var zone = Wd.zoneAt ? call(Wd, 'zoneAt', x, z) : null;
      var key = zone ? zone.key : null;
      var lair = Wd.lairAt ? call(Wd, 'lairAt', x, z) : null;
      if (key !== this.zoneKey) {
        this.zoneKey = key;
        if (zone) ui('setZoneBanner', zone);
        if (lair) { tutNotify('enteredLair', { lair: lair.index }); this._lairEnterAt = this.time; }
      }
      var safe = Wd.inSafeZone ? Wd.inSafeZone(x, z) : true;
      var track = chased ? 'chase' : (lair && !safe ? 'lair' : 'base');
      if (track !== this.musicTrack) {
        this.musicTrack = track;
        call(SE.Audio, 'playMusic', track, track === 'chase' ? { fade: 0.6 } : { fade: 1.6 });
      }
      /* exposure follows the zone atmosphere */
      if (Wd.atmosphereAt) {
        var atm = call(Wd, 'atmosphereAt', z);
        if (atm && fin(atm.exposure)) this.renderer.toneMappingExposure = damp(this.renderer.toneMappingExposure, atm.exposure, 3, 0.15);
      }
    },

    /* ================================================================== */
    /* settings, saving, leaderboard, offline                              */
    /* ================================================================== */
    applyAudioSettings: function () {
      var s = sd() && sd().settings;
      if (!s || !SE.Audio) return;
      call(SE.Audio, 'setSfx', s.sfx !== false);
      call(SE.Audio, 'setMusic', s.music !== false);
    },
    applySettings: function (arg) {
      var force = arg === true || (!!arg && typeof arg === 'object');      // ui/misc.js passes the settings object
      var s = sd() && sd().settings;
      if (!s) return;
      var sig = [s.quality, s.shadows, s.sfx, s.music].join('|');
      if (!force && sig === this._settingsSig) return;
      this._settingsSig = sig;
      this.applyAudioSettings();
      if (!this.renderer) return;
      var qy = this.resolveQuality();
      var shadows = qy !== 'low' && s.shadows !== false;
      var changed = qy !== this.quality || shadows !== this.renderer.shadowMap.enabled;
      this.quality = qy;
      this.renderer.setPixelRatio(this.pixelRatio(qy));
      this.renderer.setSize(viewW(), global.innerHeight);
      this.renderer.shadowMap.type = qy === 'high' ? T.PCFSoftShadowMap : T.PCFShadowMap;
      if (shadows !== this.renderer.shadowMap.enabled) {
        this.renderer.shadowMap.enabled = shadows;
        this.scene.traverse(function (o) {
          if (!o.material) return;
          var m = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < m.length; i++) m[i].needsUpdate = true;
        });
      }
      if (changed || force) {
        call(SE.FX, 'setQuality', qy);
        if (W() && W().setQuality) call(W(), 'setQuality', qy);
        if (SE.Cosmetics && SE.Cosmetics.setQuality) call(SE.Cosmetics, 'setQuality', qy);
      }
    },
    saveNow: function () {
      if (!sd() || this._resetting) return Promise.resolve(false);
      try { return St().save(); } catch (e) { report('State.save', e); return Promise.resolve(false); }
    },
    submitScore: function () {
      var Pf = SE.Platform;
      if (!Pf || !Pf.hasLeaderboard || !sd()) return;
      try {
        if (!Pf.hasLeaderboard()) return;
        var p = Pf.submitScore(St().computeScore());
        if (p && p.catch) p.catch(function () {});
      } catch (e) { /* never fatal */ }
    },
    checkOffline: function () {
      var S = St(), off = S.pendingOffline;
      if (!off || !(off.amount > 0)) return;
      if (tutActive() || !sd().tutorialDone) { S.claimOffline(1); return; }
      var amount = S.claimOffline(1);
      this.offlineAmount = amount;
      var dur = SE.I18N && SE.I18N.duration ? SE.I18N.duration(off.seconds, { short: true }) : Math.round(off.seconds / 60) + ' min';
      toast(t('game.toast.offline', money(amount), dur), 'good');
      ui('updateHUD');
      var self = this;
      setTimeout(function () { if (self.offlineAmount > 0) self.offer('offlineX2', { amount: amount }); }, 900);
      this.saveNow();
    },
    afterHidden: function () {
      if (!sd()) return;
      St().computeOffline();
      this.checkOffline();
    },
    resetProgress: function () {
      var self = this;
      this._resetting = true;
      St().reset();
      if (SE.Boosts) SE.Boosts.clearAll();
      this._resetting = false;
      return this.saveNow().then(function () {
        self._resetting = true;
        global.location.reload();
      });
    },

    /* ================================================================== */
    /* QA hooks (SPEC §11)                                                 */
    /* ================================================================== */
    installTestHooks: function () {
      var self = this;
      function nestInfo(n) { return n ? { index: n.index, lair: lairIndexOf(n.lair), x: n.x, z: n.z, taken: !!n.taken } : null; }
      global.SE_TEST = {
        game: self,
        teleport: function (x, z, yaw) { P().teleport(x, z, yaw); return { x: P().pos.x, z: P().pos.z }; },
        give: function (m, g) { St().addMoney(m || 0); St().addGems(g || 0); ui('updateHUD'); return { money: sd().money, gems: sd().gems }; },
        speed: function (n) { sd().speed = clamp(n, 20, St().MAX_SPEED || 500); ui('updateHUD'); return sd().speed; },
        unlockAll: function () {
          var S = St();
          for (var i = 0; i < sd().lairs.length; i++) if (S.unlockLair(i)) call(W(), 'setLairUnlocked', i, true);
          for (var j = 0; j < sd().hatcheries.length; j++) S.unlockHatchery(j);
          self.syncHatcheries(0);
          self.saveNow();
          return true;
        },
        hatchNow: function () {
          var n = 0;
          for (var i = 0; i < sd().hatcheries.length; i++) if (St().finishHatch(i)) n++;
          self.syncHatcheries(0);
          return n;
        },
        state: function () { return JSON.parse(JSON.stringify(sd())); },
        skipTutorial: function () {
          if (tutActive()) call(SE.Tutorial, 'skip');
          sd().tutorialDone = true;
          self.saveNow();
          return true;
        },
        forceInterstitialCount: function (n) { sd().ads.rounds = n | 0; return sd().ads.rounds; },
        dragons: function () {
          var L = (SE.DragonAI && SE.DragonAI.list) || [];
          return L.map(function (d) { return { role: d.role, lair: lairIndexOf(d.lair), state: d.state, x: d.x, z: d.z }; });
        },
        nests: function (lair) {
          return ((W() && W().nests) || []).filter(function (n) { return lair === undefined || lairIndexOf(n.lair) === lair; }).map(nestInfo);
        },
        nearNest: function (lair) {
          var list = ((W() && W().nests) || []).filter(function (n) { return lairIndexOf(n.lair) === (lair || 0) && !n.taken; });
          var n = list[0];
          if (!n) return null;
          var Wl = W().lairs && W().lairs[lairIndexOf(n.lair)];
          var dz = Wl && fin(Wl.zMax) && n.z + 2.5 > Wl.zMax ? -2.5 : 2.5;
          P().teleport(n.x, n.z + dz, Math.PI);
          return nestInfo(n);
        },
        interact: function (type, k) {
          var list = ((W() && W().interactables) || []).filter(function (it) { return it.type === type; });
          var it = list[k || 0];
          if (!it) return null;
          var wh = type === 'hatchery' && W().hatcheries ? W().hatcheries[it.index] : null;
          if (wh && wh.entry) {
            /* stand in the pen opening, inside the interaction radius, facing the hatchery */
            var ex = wh.entry.x - it.x, ez = wh.entry.z - it.z, el = Math.sqrt(ex * ex + ez * ez) || 1;
            var dd = Math.min(el, (it.r || 6) * 0.6);
            P().teleport(it.x + ex / el * dd, it.z + ez / el * dd, Math.atan2(-ex, -ez));
          }
          else P().teleport(it.x, it.z + Math.min(1.5, (it.r || 3) * 0.4));
          return { type: it.type, x: it.x, z: it.z, r: it.r };
        },
        action: function () { SE.Input.press('action'); return true; },
        home: function () { P().teleportHome(); return { x: P().pos.x, z: P().pos.z }; },
        deliver: function () { if (!self.carrying) return false; self.onDelivered(); return true; },
        caught: function () { self.onCaught({ lair: self.round ? self.round.lair : 0, role: 'guardian' }); return true; },
        /* rewarded extras (qa/rewards-check.cjs) */
        rewards: {
          trial: function () { var tr = self.trial; return tr ? { lair: tr.lair, left: Math.round((tr.endAt - Date.now()) / 1000), token: tr.token, done: tr.done, expired: tr.expired, open: tr.open, gateOpen: SE_TEST.rewards.gateOpen(tr.lair) } : null; },
          /* physical gate state: World.lairs[i].gateOpen (setLairTrial era) or unlocked, and the collider off */
          gateOpen: function (i) { var l = W().lairs[i]; if (!l || !l.gate || !l.gate.collider) return false; var open = l.gateOpen !== undefined ? l.gateOpen : l.unlocked; return !!open && !l.gate.collider.solid; },
          expireTrial: function () { if (self.trial) self.trial.endAt = Date.now() - 1; return !!self.trial; },
          lastDelivery: function () { return self.lastDelivery ? JSON.parse(JSON.stringify(self.lastDelivery)) : null; },
          golden: function () { return self.goldenPending(); },
          context: function () { return self.contextOffer(); },
          resetCooldowns: function () { if (SE.Ads) { SE.Ads.cooldowns = {}; var r = SE.Ads.store(); if (r) r.cd = {}; } return true; },
          setCooldown: function (id, secsAgo) { if (!SE.Ads) return false; SE.Ads.cooldowns[id] = Date.now() - (secsAgo || 0) * 1000; return SE.Ads.cooldownLeft(id); },
          boosts: function () { return SE.Boosts ? SE.Boosts.list() : []; },
          shield: function () { return { active: boost('dragonShield'), visible: !!(ShieldFx.group && ShieldFx.group.visible) }; },
          enterLair: function () { self._lairEnterAt = self.time; return true; },
          idle: function (s) { self._idleFor = s || 10; return true; },
          rollChest: function () { return self.rollChest(); }
        },
        info: function () {
          var p = P().pos;
          return {
            carrying: self.carrying ? { species: self.carrying.species, variant: self.carrying.variant } : null,
            carryDelivered: self.carryDelivered, paused: self.paused, reasons: self.pauseReasons(),
            zone: self.zoneKey, near: self.near ? self.near.type : null, x: p.x, z: p.z,
            rounds: sd().ads.rounds, sessionResults: SE.Ads ? SE.Ads.sessionResults : 0,
            statuses: JSON.parse(JSON.stringify(self.statuses)), tutorial: tutActive(),
            uiOpen: SE.UI && SE.UI.isOpen ? !!SE.UI.isOpen() : false, music: self.musicTrack,
            followers: P().followers.length, money: sd().money, gems: sd().gems, speed: sd().speed
          };
        }
      };
    }
  };

  Object.defineProperty(Game, 'paused', {
    enumerable: true,
    get: function () { for (var k in this._reasons) if (this._reasons.hasOwnProperty(k)) return true; return false; }
  });

  /* ---------------------------------------------------------------------- */
  /* strings                                                                 */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: {
        'game.hint.steal': 'Украсть: {0}',
        'game.hint.carrying': 'Ты уже несёшь яйцо — беги на базу!',
        'game.hint.nestEmpty': 'Гнездо пустое — новое яйцо через {0}',
        'game.hint.nestEmpty0': 'Гнездо пустое',
        'game.hint.buyHatch': 'Купить инкубатор за {0}',
        'game.hint.placeEgg': 'Положить яйцо в инкубатор',
        'game.hint.hatching': 'Яйцо вылупится через {0}',
        'game.hint.hatchingAd': 'Вылупится через {0} · вылупить сейчас за рекламу',
        'game.hint.collect': 'Забрать: {0}',
        'game.hint.emptyHatch': 'Пустой инкубатор — укради яйцо в логове!',
        'game.hint.sell': 'Продать драконов не из команды ({0})',
        'game.hint.sellNone': 'Продажа драконов',
        'game.hint.shop': 'Магазин',
        'game.hint.wheel': 'Колесо фортуны',
        'game.hint.gift': 'Ежедневный подарок',
        'game.hint.index': 'Драконий атлас',
        'game.hint.upgrade': 'Улучшить дорожку за {0}',
        'game.hint.unlockLair': 'Открыть: {0} за {1}',
        'game.hint.train': 'Тренировка! +{0} скорости в секунду на бегу',
        'game.tm.level': 'Уровень {0} → Уровень {1}',
        'game.tm.max': 'Уровень {0} · МАКС',
        'game.tm.maxed': 'Дорожка уже максимального уровня!',
        'game.toast.noMoney': 'Не хватает денег: нужно {0}',
        'game.toast.hatchBought': 'Новый инкубатор открыт!',
        'game.toast.lairUnlocked': '{0} открыто!',
        'game.toast.tmUpgraded': 'Беговая дорожка — уровень {0}!',
        'game.toast.sold': 'Продано драконов: {0} за {1}',
        'game.toast.nothingToSell': 'Нечего продавать: драконы из команды не продаются',
        'game.toast.noHatchery': 'Нет свободного инкубатора! Купи новый или забери дракончика.',
        'game.toast.hatched': '{0} вылупился! Забери его',
        'game.toast.newDragon': 'Новый дракон в атласе: {0}!',
        'game.toast.collected': '{0} теперь в коллекции!',
        'game.toast.autoSold': 'Коллекция полна: {0} продан за {1}',
        'game.toast.rareEgg': 'Редкая находка: {0}!',
        'game.toast.reward': 'Награда получена: {0}',
        'game.toast.offline': 'Пока тебя не было ({1}), драконы заработали {0}',
        'game.toast.revive': 'Второй шанс! Ты невидим — беги на базу!',
        'game.status.chilled': 'Заморожен!',
        'game.status.stunned': 'Оглушён!',
        'game.status.invisible': 'Невидимка!',
        'game.status.shield': 'Щит!',
        'game.hint.trialUsed': 'Пробный набег окончен — открой логово, чтобы красть здесь',
        'game.hint.trialGate': 'Пробный набег: ворота открыты ещё {0}',
        'game.hint.unlockLairTrial': 'Открыть: {0} за {1} · пробный набег за рекламу',
        'game.hint.trainTurbo': 'Турбо-тренировка! +{0} скорости в секунду на бегу',
        'game.toast.teleported': 'Телепорт! Яйцо доставлено на базу.',
        'game.toast.shieldSaved': 'Драконий щит спас яйцо! Беги на базу!',
        'game.toast.trialOpen': '{0}: ворота открыты на один набег ({1})!',
        'game.toast.trialOver': 'Пробный набег окончен — ворота закрываются.',
        'game.toast.goldenUsed': 'Золотое яйцо сработало: {0}!'
      },
      en: {
        'game.hint.steal': 'Steal: {0}',
        'game.hint.carrying': 'You already carry an egg — run to your base!',
        'game.hint.nestEmpty': 'Empty nest — a new egg in {0}',
        'game.hint.nestEmpty0': 'Empty nest',
        'game.hint.buyHatch': 'Buy hatchery for {0}',
        'game.hint.placeEgg': 'Put the egg into the hatchery',
        'game.hint.hatching': 'Hatches in {0}',
        'game.hint.hatchingAd': 'Hatches in {0} · watch an ad to hatch now',
        'game.hint.collect': 'Collect: {0}',
        'game.hint.emptyHatch': 'Empty hatchery — steal an egg in a lair!',
        'game.hint.sell': 'Sell dragons outside your team ({0})',
        'game.hint.sellNone': 'Sell dragons',
        'game.hint.shop': 'Shop',
        'game.hint.wheel': 'Wheel of Fortune',
        'game.hint.gift': 'Daily Gift',
        'game.hint.index': 'Dragon Index',
        'game.hint.upgrade': 'Upgrade the treadmill for {0}',
        'game.hint.unlockLair': 'Unlock {0} for {1}',
        'game.hint.train': 'Training! +{0} speed per second while running',
        'game.tm.level': 'Level {0} → Level {1}',
        'game.tm.max': 'Level {0} · MAX',
        'game.tm.maxed': 'The treadmill is already at max level!',
        'game.toast.noMoney': 'Not enough cash: you need {0}',
        'game.toast.hatchBought': 'New hatchery unlocked!',
        'game.toast.lairUnlocked': '{0} unlocked!',
        'game.toast.tmUpgraded': 'Treadmill level {0}!',
        'game.toast.sold': 'Sold {0} dragons for {1}',
        'game.toast.nothingToSell': 'Nothing to sell: team dragons are never sold',
        'game.toast.noHatchery': 'No free hatchery! Buy a new one or collect a baby dragon.',
        'game.toast.hatched': '{0} hatched! Go collect it',
        'game.toast.newDragon': 'New dragon in your Index: {0}!',
        'game.toast.collected': '{0} joined your collection!',
        'game.toast.autoSold': 'Collection full: {0} sold for {1}',
        'game.toast.rareEgg': 'Rare find: {0}!',
        'game.toast.reward': 'Reward received: {0}',
        'game.toast.offline': 'While you were away ({1}) your dragons earned {0}',
        'game.toast.revive': 'Second chance! You are invisible — run home!',
        'game.status.chilled': 'Frozen!',
        'game.status.stunned': 'Stunned!',
        'game.status.invisible': 'Invisible!',
        'game.status.shield': 'Shield!',
        'game.hint.trialUsed': 'The trial raid is over — unlock the lair to steal here',
        'game.hint.trialGate': 'Trial raid: the gate stays open for {0}',
        'game.hint.unlockLairTrial': 'Unlock {0} for {1} · trial raid for an ad',
        'game.hint.trainTurbo': 'Turbo training! +{0} speed per second while running',
        'game.toast.teleported': 'Teleported! The egg is delivered to your base.',
        'game.toast.shieldSaved': 'The dragon shield saved your egg! Run home!',
        'game.toast.trialOpen': '{0}: the gate is open for one raid ({1})!',
        'game.toast.trialOver': 'The trial raid is over — the gate is closing.',
        'game.toast.goldenUsed': 'Golden egg bonus: {0}!'
      },
      tr: {
        'game.hint.steal': 'Çal: {0}',
        'game.hint.carrying': 'Zaten bir yumurta taşıyorsun — üssüne koş!',
        'game.hint.nestEmpty': 'Yuva boş — yeni yumurta {0} sonra',
        'game.hint.nestEmpty0': 'Yuva boş',
        'game.hint.buyHatch': 'Kuluçkayı {0} karşılığında al',
        'game.hint.placeEgg': 'Yumurtayı kuluçkaya koy',
        'game.hint.hatching': '{0} sonra çatlayacak',
        'game.hint.hatchingAd': '{0} sonra çatlayacak · reklamla hemen çatlat',
        'game.hint.collect': 'Al: {0}',
        'game.hint.emptyHatch': 'Boş kuluçka — bir inden yumurta çal!',
        'game.hint.sell': 'Takım dışındaki ejderhaları sat ({0})',
        'game.hint.sellNone': 'Ejderha sat',
        'game.hint.shop': 'Mağaza',
        'game.hint.wheel': 'Şans Çarkı',
        'game.hint.gift': 'Günlük Hediye',
        'game.hint.index': 'Ejderha Atlası',
        'game.hint.upgrade': 'Koşu bandını {0} karşılığında geliştir',
        'game.hint.unlockLair': '{0} kilidini {1} karşılığında aç',
        'game.hint.train': 'Antrenman! Koşarken saniyede +{0} hız',
        'game.tm.level': 'Seviye {0} → Seviye {1}',
        'game.tm.max': 'Seviye {0} · MAKS',
        'game.tm.maxed': 'Koşu bandı zaten en üst seviyede!',
        'game.toast.noMoney': 'Yeterli para yok: {0} gerekli',
        'game.toast.hatchBought': 'Yeni kuluçka açıldı!',
        'game.toast.lairUnlocked': '{0} açıldı!',
        'game.toast.tmUpgraded': 'Koşu bandı seviye {0}!',
        'game.toast.sold': '{0} ejderha {1} karşılığında satıldı',
        'game.toast.nothingToSell': 'Satılacak bir şey yok: takımdaki ejderhalar satılmaz',
        'game.toast.noHatchery': 'Boş kuluçka yok! Yenisini al ya da yavru ejderhayı topla.',
        'game.toast.hatched': '{0} yumurtadan çıktı! Gidip al',
        'game.toast.newDragon': 'Atlasta yeni ejderha: {0}!',
        'game.toast.collected': '{0} koleksiyonuna katıldı!',
        'game.toast.autoSold': 'Koleksiyon dolu: {0} {1} karşılığında satıldı',
        'game.toast.rareEgg': 'Nadir bulgu: {0}!',
        'game.toast.reward': 'Ödül alındı: {0}',
        'game.toast.offline': 'Sen yokken ({1}) ejderhaların {0} kazandı',
        'game.toast.revive': 'İkinci şans! Görünmezsin — üssüne koş!',
        'game.status.chilled': 'Dondun!',
        'game.status.stunned': 'Sersemledin!',
        'game.status.invisible': 'Görünmez!',
        'game.status.shield': 'Kalkan!',
        'game.hint.trialUsed': 'Deneme baskını bitti — burada çalmak için inin kilidini aç',
        'game.hint.trialGate': 'Deneme baskını: kapı {0} daha açık',
        'game.hint.unlockLairTrial': '{0} kilidini {1} karşılığında aç · reklamla deneme baskını',
        'game.hint.trainTurbo': 'Turbo antrenman! Koşarken saniyede +{0} hız',
        'game.toast.teleported': 'Işınlandın! Yumurta üssüne teslim edildi.',
        'game.toast.shieldSaved': 'Ejderha kalkanı yumurtanı kurtardı! Üsse koş!',
        'game.toast.trialOpen': '{0}: kapı tek bir baskın için açık ({1})!',
        'game.toast.trialOver': 'Deneme baskını bitti — kapı kapanıyor.',
        'game.toast.goldenUsed': 'Altın yumurta bonusu: {0}!'
      }
    });
  }

  SE.Game = Game;

  function bootWhenReady() {
    if (global.__SE_NO_BOOT) return;               // dev labs boot manually
    Game.boot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootWhenReady);
  else setTimeout(bootWhenReady, 0);
})(window);
