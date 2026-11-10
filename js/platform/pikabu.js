/* =====================================================================
   SE.Platform — PIKABU GAMES adapter (PkbSDK, https://games.pikabu.ru/sdk/docs).

   The build injects  <script src="https://games.pikabu.ru/sdk/sdk.js">  as the
   first script. Same public surface as js/platform/local.js. Pikabu specifics:
   - init(): await PkbSDK.init() with a 15 s timeout. When the SDK is missing or
     fails (an ad blocker, a local run) the game still starts: localStorage
     saves, no ads. Language: SE.Config.LANG (the build sets 'ru').
   - gameReady() → sdk.gameStarted() once.
   - Progress: sdk.storage, one key 'sade_save_v1' (JSON string). The SDK methods
     are synchronous and sync with the server themselves. A corrupt load()
     rejects and blocks save(); REVISION_CONFLICT (another tab or device) pauses
     the game and offers a reload.
   - Ads: fullscreen / rewarded — canShow() before every show(); single flight;
     the game is paused ('ad') for the whole request; the reward is granted ONLY
     when show() returns reward === true; refusal/timeout → onClose(false).
   - Pause on tab switch: SE.Game (pauseOnHidden). No leaderboards.
   ===================================================================== */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var SAVE_KEY = 'sade_save_v1';
  var LANGS = ['ru', 'en', 'tr'];
  var INIT_TIMEOUT = 15000, CAN_SHOW_TIMEOUT = 4000, AD_TIMEOUT = 180000;

  /* ---------------- shared helpers (identical in every adapter) ---------------- */
  function cfg() { return SE.Config || {}; }
  function noop() {}
  function safeCall(fn, arg) {
    try { return fn(arg); } catch (e) { console.error('SE.Platform callback failed:', e); }
  }
  function defer(fn, arg) { Promise.resolve().then(function () { if (fn) safeCall(fn, arg); }); }
  var warned = {};
  function warnOnce(key, message) { if (!warned[key]) { warned[key] = true; console.warn(message); } }
  function normLang(value) {
    var v = String(value || '').toLowerCase().split(/[-_]/)[0];
    return LANGS.indexOf(v) >= 0 ? v : null;
  }
  function rewardedArgs(a, b, c) {
    if (typeof a === 'function') {
      warnOnce('rewarded-args', 'SE.Platform.showRewarded(onReward, onClose, id) is deprecated; use showRewarded(placementId, onReward, onClose).');
      return { id: String(c || 'reward'), onReward: a, onClose: typeof b === 'function' ? b : null };
    }
    return { id: String(a || 'reward'), onReward: typeof b === 'function' ? b : null, onClose: typeof c === 'function' ? c : null };
  }
  function interstitialArgs(a, b) {
    if (typeof a === 'function') {
      warnOnce('interstitial-args', 'SE.Platform.showInterstitial(onClose) is deprecated; use showInterstitial(placementId, onClose).');
      return { id: 'round_end', onClose: a };
    }
    return { id: String(a || 'round_end'), onClose: typeof b === 'function' ? b : null };
  }
  function withTimeout(work, ms, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(label + ' timed out after ' + ms + ' ms'));
      }, ms);
      Promise.resolve().then(work).then(function (value) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      });
    });
  }
  function createTasks() {
    var queue = [], timers = [];
    function now() { return global.performance && performance.now ? performance.now() : Date.now(); }
    function call(fn) { try { fn(); } catch (e) { console.error('SE.Tasks callback failed:', e); } }
    function arm(t) {
      t.since = now();
      t.id = setTimeout(function () { Tasks.clear(t); Tasks.run(t.fn); }, t.left);
    }
    var Tasks = {
      paused: false,
      run: function (fn) { if (Tasks.paused) queue.push(fn); else call(fn); },
      active: function () { return new Promise(function (resolve) { Tasks.run(resolve); }); },
      timeout: function (fn, ms) {
        var t = { fn: fn, left: Math.max(0, Number(ms) || 0), since: 0, id: null };
        timers.push(t);
        if (!Tasks.paused) arm(t);
        return t;
      },
      clear: function (t) {
        if (!t) return;
        clearTimeout(t.id); t.id = null;
        var i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1);
      },
      pause: function () {
        if (Tasks.paused) return;
        Tasks.paused = true;
        timers.forEach(function (t) {
          clearTimeout(t.id); t.id = null;
          t.left = Math.max(0, t.left - (now() - t.since));
        });
      },
      resume: function () {
        if (!Tasks.paused) return;
        Tasks.paused = false;
        timers.slice().forEach(arm);
        queue.splice(0).forEach(function (fn) { Tasks.run(fn); });
      }
    };
    return Tasks;
  }
  function installHooks(P) {
    var reasons = {}, onPause = null, onResume = null;
    Object.defineProperty(P, 'onPause', {
      enumerable: true, configurable: true,
      get: function () { return onPause || noop; },
      set: function (fn) {
        onPause = typeof fn === 'function' ? fn : null;
        // A pause that arrived before SE.Game assigned its callback is replayed.
        if (onPause) Object.keys(reasons).forEach(function (r) { safeCall(onPause, r); });
      }
    });
    Object.defineProperty(P, 'onResume', {
      enumerable: true, configurable: true,
      get: function () { return onResume || noop; },
      set: function (fn) { onResume = typeof fn === 'function' ? fn : null; }
    });
    P._pause = function (reason) {
      if (reasons[reason]) return;
      reasons[reason] = true;
      if (onPause) safeCall(onPause, reason);
    };
    P._resume = function (reason) {
      if (!reasons[reason]) return;
      delete reasons[reason];
      if (onResume) safeCall(onResume, reason);
    };
    P.pauseReasons = function () { return Object.keys(reasons); };
    P._setAudio = function (enabled) {
      P.audioEnabled = enabled === true;
      if (SE.Audio && typeof SE.Audio.setPlatformAudio === 'function') safeCall(function (v) { SE.Audio.setPlatformAudio(v); }, P.audioEnabled);
      if (typeof P.onAudioChange === 'function') safeCall(P.onAudioChange, P.audioEnabled);
    };
  }
  function installPauseStyle() {
    // CSS animations freeze while the host pauses the game (html.platform-paused).
    try {
      var doc = global.document;
      if (!doc || !doc.createElement || doc.getElementById('se-platform-pause-style')) return;
      var style = doc.createElement('style');
      style.id = 'se-platform-pause-style';
      style.textContent = 'html.platform-paused *,html.platform-paused *::before,html.platform-paused *::after' +
        '{animation-play-state:paused!important}';
      (doc.head || doc.documentElement).appendChild(style);
    } catch (e) {}
  }
  function setPausedClass(on) {
    try {
      var root = global.document && global.document.documentElement;
      if (root && root.classList) root.classList[on ? 'add' : 'remove']('platform-paused');
    } catch (e) {}
  }
  function fallbackMobile() {
    try {
      var nav = global.navigator || {};
      if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle|Opera Mini|IEMobile/i.test(String(nav.userAgent || ''))) return true;
      var coarse = global.matchMedia && global.matchMedia('(pointer: coarse)').matches;
      var fine = global.matchMedia && global.matchMedia('(any-pointer: fine)').matches;
      return !!(coarse && !fine);
    } catch (e) { return false; }
  }
  function cleanScore(score) {
    var n = Math.floor(Number(score));
    if (!isFinite(n) || n < 0) return null;
    return Math.min(n, Number.MAX_SAFE_INTEGER);
  }
  function delay(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  /* ------------------------------------------------------------------------------ */

  function storage() {
    try { return global.localStorage || null; } catch (e) { return null; }
  }

  /* REVISION_CONFLICT: the save changed in another tab or on another device — pause and offer a reload. */
  var conflictShown = false;
  function conflictNotice(P) {
    if (conflictShown) return;
    conflictShown = true;
    P._pause('platform');
    try {
      var doc = global.document;
      var box = doc.createElement('div');
      box.id = 'pkb-conflict';
      box.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(8,10,18,.82);font:700 17px/1.35 Nunito,system-ui,sans-serif;color:#fff;text-align:center';
      var card = doc.createElement('div');
      card.style.cssText = 'box-sizing:border-box;width:calc(100% - 32px);max-width:420px;padding:22px 18px;border-radius:20px;' +
        'background:#f6e7c8;color:#2b1d0e;border:5px solid #7a4a1d;box-shadow:0 0 0 3px #e0a400,0 18px 40px rgba(0,0,0,.55)';
      var title = doc.createElement('div');
      title.style.cssText = 'font:900 24px/1.15 Nunito,system-ui,sans-serif;margin-bottom:10px';
      title.textContent = 'Игра открыта ещё где-то';
      var text = doc.createElement('div');
      text.style.cssText = 'font-weight:700;font-size:15px;opacity:.85;margin-bottom:16px';
      text.textContent = 'Прогресс изменился на другом устройстве или в другой вкладке. Перезагрузите игру, чтобы продолжить сохраняться.';
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.style.cssText = 'min-height:52px;padding:10px 26px;border-radius:14px;cursor:pointer;font:900 18px/1.1 Nunito,system-ui,sans-serif;' +
        'color:#fff;background:#3fae2a;border:3px solid #1b1206;border-bottom-width:6px';
      btn.textContent = 'Перезагрузить';
      btn.addEventListener('click', function () { global.location.reload(); });
      card.appendChild(title); card.appendChild(text); card.appendChild(btn); box.appendChild(card);
      (doc.body || doc.documentElement).appendChild(box);
    } catch (e) { console.warn('Pikabu: the save-conflict notice failed:', e); }
  }

  var Tasks = createTasks();

  var Platform = {
    id: 'pikabu',
    lang: 'ru',
    isMobile: fallbackMobile(),
    ready: false,                 // true once init() resolved
    audioEnabled: true,
    hasSDK: false,                // false: PkbSDK missing or failed (blocked script) → local saves, no ads
    pauseOnHidden: true,          // SE.Game pauses on visibilitychange/blur (Pikabu: pause on tab switch)
    onAudioChange: null,
    sdk: null,
    firstFrameSent: false,
    gameReadySent: false,
    gameplayRunning: false,
    saveAllowed: false,
    adRequest: null,
    _initPromise: null,

    /* ---------- init ---------- */
    init: function () {
      if (this._initPromise) return this._initPromise;
      var self = this;
      if (cfg().PLATFORM && cfg().PLATFORM !== 'pikabu') {
        warnOnce('platform-mismatch', 'SE.Config.PLATFORM is "' + cfg().PLATFORM + '" but js/platform/pikabu.js is loaded.');
      }
      this._initPromise = withTimeout(function () {
        var S = global.PkbSDK;
        if (!S || typeof S.init !== 'function') throw new Error('Pikabu SDK did not load');
        return S.init();
      }, INIT_TIMEOUT, 'Pikabu SDK initialization').then(function (sdk) {
        self._attach(sdk || global.PkbSDK);
        return true;
      }, function (error) {
        // An ad blocker or a local run: play without the SDK (localStorage saves, no ads).
        console.warn('Pikabu SDK unavailable, playing locally:', (error && error.message) || error);
        self.hasSDK = false;
        self.ready = true;
        self._setAudio(true);
        return true;
      });
      return this._initPromise;
    },

    _attach: function (sdk) {
      var self = this;
      this.sdk = sdk;
      this.hasSDK = true;
      var forced = cfg().LANG === 'auto' ? null : normLang(cfg().LANG);
      this.lang = forced || 'ru';
      try {
        sdk.on('storageSaveError', function (reason) {
          console.warn('Pikabu save failed:', reason);
          if (reason === 'REVISION_CONFLICT') conflictNotice(self);
        });
      } catch (e) { /* an SDK without events */ }
      this._setAudio(true);
      this.ready = true;
    },

    /* ---------- lifecycle ---------- */
    firstFrameReady: function () { this.firstFrameSent = true; },
    gameReady: function () {
      if (this.gameReadySent) return;
      this.firstFrameSent = true;
      this.gameReadySent = true;
      if (!this.hasSDK) return;
      try { this.sdk.gameStarted(); } catch (e) { console.warn('Pikabu gameStarted failed:', e); }
    },
    gameplayStart: function () { this.gameplayRunning = true; },
    gameplayStop: function () { this.gameplayRunning = false; },
    setLoadingProgress: function () {},

    /* ---------- saves: Pikabu cloud storage (one key), localStorage without the SDK ---------- */
    load: function () {
      var self = this;
      this.saveAllowed = false;
      return Promise.resolve().then(function () {
        var value;
        if (self.hasSDK) value = self.sdk.storage.get(SAVE_KEY);
        else {
          var ls = storage();
          try { value = ls ? ls.getItem(SAVE_KEY) : null; } catch (e) { value = null; }
        }
        if (value === undefined || value === null || value === '') value = null;
        else if (typeof value === 'string') value = JSON.parse(value);   // throws on corrupt data → reject
        if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid Pikabu save data');
        self.saveAllowed = true;
        return value;
      });
    },

    save: function (data) {
      if (!this.saveAllowed) return Promise.resolve(false);   // never before a successful load
      var json;
      try { json = JSON.stringify(data); } catch (e) {
        console.warn('Save skipped: the state cannot be serialised.', e);
        return Promise.resolve(false);
      }
      if (typeof json !== 'string') return Promise.resolve(false);
      try {
        if (this.hasSDK) this.sdk.storage.set(SAVE_KEY, json);   // the SDK syncs with the server itself
        else {
          var ls = storage();
          if (!ls) return Promise.resolve(false);
          ls.setItem(SAVE_KEY, json);
        }
        return Promise.resolve(true);
      } catch (e) {
        console.warn('Pikabu save failed:', e);
        return Promise.resolve(false);
      }
    },

    /* ---------- ads: canShow() before every show(); reward only on reward === true ---------- */
    _ad: function (kind) {
      var ads = this.sdk && this.sdk.ads;
      return ads ? ads[kind === 'rewarded' ? 'rewarded' : 'fullscreen'] : null;
    },
    canRewarded: function () {
      var ad = this._ad('rewarded');
      return !!(this.hasSDK && cfg().ADS !== false && ad && ad.isSupported && !this.adRequest);
    },
    canInterstitial: function () {
      var ad = this._ad('interstitial');
      return !!(this.hasSDK && cfg().ADS !== false && ad && ad.isSupported && !this.adRequest);
    },
    showRewarded: function (placementId, onReward, onClose) {
      var a = rewardedArgs(placementId, onReward, onClose);
      this._requestAd('rewarded', a.id, a.onReward, a.onClose);
    },
    showInterstitial: function (placementId, onClose) {
      var a = interstitialArgs(placementId, onClose);
      this._requestAd('interstitial', a.id, null, a.onClose);
    },
    _requestAd: function (kind, id, onReward, onClose) {
      var ok = kind === 'rewarded' ? this.canRewarded() : this.canInterstitial();
      if (!ok) { defer(onClose, false); return; }
      var self = this, ad = this._ad(kind);
      var request = { kind: kind, id: id, onReward: onReward, onClose: onClose };
      this.adRequest = request;
      this._pause('ad');
      Tasks.pause();
      setPausedClass(true);
      withTimeout(function () { return ad.canShow(); }, CAN_SHOW_TIMEOUT, 'Pikabu canShow').then(function (can) {
        if (can !== true) return null;
        return withTimeout(function () { return ad.show(); }, AD_TIMEOUT, 'Pikabu show');
      }).then(function (r) {
        if (r && r.rendered === false) console.warn('Pikabu ad was not shown:', r.reason);
        var granted = kind === 'rewarded' ? !!(r && r.rendered && r.reward === true) : !!(r && r.rendered);
        self._finishAd(request, granted);
      }, function (error) {
        console.warn('Pikabu ' + kind + ' failed:', error);
        self._finishAd(request, false);
      });
    },
    _finishAd: function (request, result) {
      if (this.adRequest !== request) return;
      this.adRequest = null;
      setPausedClass(false);
      Tasks.resume();
      this._resume('ad');
      var granted = result === true;
      defer(function () {
        if (request.kind === 'rewarded' && granted && request.onReward) safeCall(request.onReward);
        if (request.onClose) safeCall(request.onClose, granted);
      });
    },

    /* ---------- leaderboard: none on Pikabu ---------- */
    hasLeaderboard: function () { return false; },
    submitScore: function () { return Promise.resolve(false); },
    getLeaderboard: function () { return Promise.resolve(null); },

    /* ---------- player (extras) ---------- */
    auth: function () {
      var self = this;
      if (!this.hasSDK || !this.sdk.auth) return Promise.resolve(false);
      if (this.sdk.player && this.sdk.player.isAuthorized) return Promise.resolve(true);
      this._pause('platform');
      return Promise.resolve().then(function () { return self.sdk.auth.openAuthDialog(); }).then(noop, noop).then(function () {
        self._resume('platform');
        return !!(self.sdk.player && self.sdk.player.isAuthorized);
      });
    },
    getPlayerName: function () { return null; }
  };

  installHooks(Platform);
  installPauseStyle();
  (function () {
    var forced = cfg().LANG === 'auto' ? null : normLang(cfg().LANG);
    if (forced) Platform.lang = forced;
  })();
  SE.Tasks = Tasks;
  SE.Platform = Platform;
})(window);
