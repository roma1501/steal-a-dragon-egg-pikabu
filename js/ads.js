/* =========================================================================
   Steal a Dragon Egg — ads: rewarded offers + round-end interstitial (SE.Ads)

   SPEC §7 / §8. Every rewarded offer states its reward before the ad and is
   granted ONCE, only when the platform confirms the reward. The interstitial is
   shown only from the result panel's "Next" button, after ≥ 2 completed rounds
   since the last one, never after the first result of a session and never
   during the tutorial. While an ad runs the platform pauses the game (reason
   'ad'); SE.Ads also holds the 'ad' pause while it waits for the SDK.

   API
     OFFERS                               [{ id, icon, cd (s), dur (s|0), cat, boost, panel, persist? }]
     get(id) -> offer|null                CATS = ['boost','egg','money','run','speed']
     REWARD                               numbers shared by texts and game logic
     title(id) / desc(id, ctx)            localized; desc names the concrete reward
                                          (ctx: { amount, hatchery, lair, egg, cash, gems } where relevant)
     ready(id) -> bool                    platform can show rewarded && ADS on && not on
                                          cooldown && not busy (ids outside OFFERS: no cooldown)
     available(id, ctx) -> bool           the reward makes sense right now (an egg to hatch,
                                          a locked hatchery, offline money …) — independent of ads;
                                          always false while the tutorial runs
     canShow() -> bool                    the platform can show a rewarded ad at all (ADS on)
     store() -> State.data.rewards        { golden, cd:{ id: ms } } (persisted, created on demand)
     cooldownLeft(id) -> seconds          offers with persist:true also read store().cd (reloads)
     list(filter) -> [offer]              filter 'panel' → offers for the Boosts panel that are
                                          available now; a function → custom filter
     rewarded(placementId, onGranted, onDone(granted))
                                          generic rewarded ad (also 'shop-unlock', 'daily-x2',
                                          'wheel-spin'): busy guard, SE.UI.showAdWait, grants once
     claim(offerId, ctx, onDone(granted)) rewarded + SE.Game.applyReward(offerId, ctx)
     roundEnded(token)                    once per completed round (a repeated token is ignored);
                                          increments State.data.ads.rounds (persisted)
     next(go)                             result panel "Next": interstitial when rounds ≥ 2
                                          (then rounds = 0), otherwise go() immediately;
                                          double-click safe (go runs once per result)
     busy, interstitialBusy               read-only flags
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  var REWARD_TIMEOUT_MS = 120000;        // safety net: an SDK that never answers
  var INTERSTITIAL_TIMEOUT_MS = 45000;
  var ROUNDS_FOR_INTERSTITIAL = 2;

  /* id, icon (game/assets/ui/<icon>.png or an SE.Icons key), cd = cooldown after a granted view (s),
     dur = boost duration (s, 0 = instant reward), cat = category,
     panel = listed in the Boosts panel (context-free offers),
     persist = the cooldown survives reloads (State.data.rewards.cd[id]).
     Contextual offers (panel:false) are offered where they make sense:
       teleportHome  HUD button while carrying an egg outside the base (ui/offers.js)
       trialRaid     E at a locked lair gate without enough cash, offer bubble near it
       tripleReward  result panel after a delivery (SE.Game.resultOffers / ui/offers.js)
       freeChest     HUD chest button, every REWARD.chestEvery seconds */
  var OFFERS = [
    { id: 'x2income',     icon: 'money-bag',      cd: 90,  dur: 180, cat: 'boost', panel: true },
    { id: 'x2hatch',      icon: 'fast-hatch',     cd: 90,  dur: 300, cat: 'egg',   panel: true },
    { id: 'instantHatch', icon: 'hatching-chick', cd: 30,  dur: 0,   cat: 'egg',   panel: true },
    { id: 'speedBoost',   icon: 'lightning',      cd: 60,  dur: 60,  cat: 'boost', panel: true },
    { id: 'luckyEgg',     icon: 'clover',         cd: 90,  dur: 180, cat: 'egg',   panel: true },
    { id: 'revive',       icon: 'heart',          cd: 180,   dur: 20,  cat: 'run',   panel: false },
    { id: 'dragonSleep',  icon: 'moon',           cd: 90,  dur: 45,  cat: 'run',   panel: true },
    { id: 'magnet',       icon: 'magnet',         cd: 60,  dur: 60,  cat: 'boost', panel: true },
    { id: 'cashBonus',    icon: 'cash-bonus',     cd: 120, dur: 0,   cat: 'money', panel: true },
    { id: 'freeHatchery', icon: 'pen-house',      cd: 180, dur: 0,   cat: 'egg',   panel: true },
    { id: 'offlineX2',    icon: 'banknotes',      cd: 0,   dur: 0,   cat: 'money', panel: false },
    { id: 'doubleSell',   icon: 'banknotes',      cd: 60,  dur: 180, cat: 'money', panel: true },
    { id: 'speedUp',      icon: 'shoe',           cd: 90,  dur: 0,   cat: 'speed', panel: true },
    { id: 'upgradeEgg',   icon: 'sparkles',       cd: 60,  dur: 0,   cat: 'egg',   panel: true },
    { id: 'lairDiscount', icon: 'map',            cd: 180, dur: 300, cat: 'money', panel: true },
    { id: 'teleportHome', icon: 'pen-house',      cd: 150, dur: 0,   cat: 'run',   panel: false },
    { id: 'trialRaid',    icon: 'map',            cd: 300, dur: 180, cat: 'run',   panel: false },
    { id: 'dragonShield', icon: 'shield',         cd: 120, dur: 300, cat: 'run',   panel: true },
    { id: 'goldenEgg',    icon: 'star',           cd: 180, dur: 0,   cat: 'egg',   panel: true },
    { id: 'tripleReward', icon: 'trophy',         cd: 0,   dur: 0,   cat: 'money', panel: false },
    { id: 'turboTrain',   icon: 'shoe',           cd: 90,  dur: 180, cat: 'speed', panel: true },
    { id: 'gemsX2',       icon: 'render/gems-pile', cd: 120, dur: 600, cat: 'money', panel: true },
    { id: 'freeChest',    icon: 'gift',           cd: 360, dur: 0,   cat: 'money', panel: false, persist: true }
  ];
  /* boost = the reward is an SE.Boosts timer (HUD chip) */
  OFFERS.forEach(function (o) { o.boost = o.dur > 0 && o.id !== 'revive' && o.id !== 'trialRaid'; });

  var CATS = ['boost', 'egg', 'money', 'run', 'speed'];
  var BY_ID = {};
  OFFERS.forEach(function (o) { BY_ID[o.id] = o; });

  /* Constants the game uses when it applies rewards (kept here so texts and logic agree). */
  var REWARD = { speedUp: 15, discount: 0.3, reviveSecs: 20, sellMult: 2, luckMult: 2,
    shieldInvisSecs: 3, trialSecs: 180, turboMult: 3, gemsMult: 2, tripleMult: 3, chestEvery: 360 };

  /* ---------------------------------------------------------------------- */
  function t(key) { return SE.t ? SE.t.apply(null, arguments) : key; }
  function money(n) {
    if (SE.U && SE.U.money) return SE.U.money(n);
    return '$' + Math.floor(n || 0);
  }
  function now() { return Date.now(); }
  function cfg() { return SE.Config || {}; }
  function P() { return SE.Platform || null; }
  function S() { return SE.State && SE.State.data ? SE.State : null; }
  function ui(name) {
    var U = SE.UI;
    if (!U || typeof U[name] !== 'function') return;
    try { return U[name].apply(U, Array.prototype.slice.call(arguments, 1)); } catch (e) { console.error('[Ads] UI.' + name + ' failed', e); }
  }
  function setPause(on) {
    if (SE.Game && typeof SE.Game.setPaused === 'function') {
      try { SE.Game.setPaused(on, 'ad'); } catch (e) { console.error(e); }
    }
  }
  function safe(fn, arg) {
    if (typeof fn !== 'function') return;
    try { fn(arg); } catch (e) { console.error('[Ads] callback failed', e); }
  }
  function later(fn, arg) { Promise.resolve().then(function () { safe(fn, arg); }); }
  function tutorialActive() {
    try { return !!(SE.Tutorial && typeof SE.Tutorial.isActive === 'function' && SE.Tutorial.isActive()); } catch (e) { return false; }
  }

  var Ads = {
    OFFERS: OFFERS,
    CATS: CATS,
    REWARD: REWARD,
    cooldowns: {},            // id -> timestamp of the last granted view (session only)
    busy: false,
    interstitialBusy: false,
    sessionResults: 0,        // result panels completed (Next pressed) in this session
    _roundTokens: {},
    _nextToken: 0,
    _pendingGo: null,

    get: function (id) { return BY_ID[id] || null; },

    /* Persistent reward data, saved with the game (State.migrate keeps unknown top-level keys):
       State.data.rewards = { golden: bool (next stolen egg is at least Golden),
                              cd: { offerId: ms of the last granted view } (offers with persist:true) } */
    store: function () {
      var St = S();
      if (!St) return null;
      var r = St.data.rewards;
      if (!r || typeof r !== 'object' || Array.isArray(r)) r = St.data.rewards = {};
      if (typeof r.golden !== 'boolean') r.golden = r.golden === 1;
      if (!r.cd || typeof r.cd !== 'object' || Array.isArray(r.cd)) r.cd = {};
      return r;
    },

    title: function (id) { return t('offer.' + id + '.t'); },

    desc: function (id, ctx) {
      ctx = ctx || {};
      var St = S();
      switch (id) {
        case 'cashBonus':
          return t('offer.cashBonus.d', money(ctx.amount || (St ? St.cashBonusAmount() : 300)));
        case 'offlineX2': {
          var amount = ctx.amount || (SE.State && SE.State.pendingOffline ? SE.State.pendingOffline.amount : 0);
          return t('offer.offlineX2.d', money(amount));
        }
        case 'freeHatchery': {
          var i = St ? St.nextLockedHatchery() : -1;
          return t('offer.freeHatchery.d', money(i >= 0 ? St.hatcheryPrice(i) : 0));
        }
        case 'speedUp':
          return t('offer.speedUp.d', REWARD.speedUp);
        case 'upgradeEgg': {
          var egg = ctx.egg || this._upgradeTarget(ctx).egg;
          var D = SE.DragonData;
          if (egg && D && egg.variant < D.VARIANTS.length - 1) {
            return t('offer.upgradeEgg.d2', D.variantName(egg.variant, 'egg') || '', D.variantName(egg.variant + 1, 'egg') || '');
          }
          return t('offer.upgradeEgg.d');
        }
        case 'doubleSell':
          return ctx.amount ? t('offer.doubleSell.d2', money(ctx.amount)) : t('offer.doubleSell.d');
        case 'trialRaid': {
          var G = SE.Game, D2 = SE.DragonData;
          var li = typeof ctx.lair === 'number' ? ctx.lair : (G && G.trialTarget ? G.trialTarget() : -1);
          return li > 0 && D2 ? t('offer.trialRaid.d2', D2.lairName(li), Math.round(REWARD.trialSecs / 60)) : t('offer.trialRaid.d', Math.round(REWARD.trialSecs / 60));
        }
        case 'tripleReward': {
          var ld = typeof ctx.cash === 'number' ? ctx : (SE.Game && SE.Game.lastDelivery) || null;
          var k = REWARD.tripleMult - 1;
          return ld ? t('offer.tripleReward.d2', money((ld.cash || 0) * k), (ld.gems || 0) * k) : t('offer.tripleReward.d');
        }
        default:
          return t('offer.' + id + '.d');
      }
    },

    cooldownLeft: function (id) {
      var o = BY_ID[id];
      if (!o || !o.cd) return 0;
      var last = this.cooldowns[id] || 0;
      if (o.persist) {
        var r = this.store(), p = r ? r.cd[id] : 0;
        /* a clock moved back never locks the offer for longer than its cooldown */
        if (typeof p === 'number' && isFinite(p) && p > 0) last = Math.max(last, Math.min(p, now()));
      }
      return Math.max(0, o.cd - (now() - last) / 1000);
    },

    enabled: function () { return cfg().ADS !== false; },

    canShow: function () {
      var p = P();
      if (!this.enabled() || !p || typeof p.canRewarded !== 'function') return false;
      try { return !!p.canRewarded(); } catch (e) { return false; }
    },

    ready: function (id) {
      return !this.busy && !this.interstitialBusy && this.canShow() && this.cooldownLeft(id) <= 0;
    },

    /* Hatchery egg (or the carried egg) that upgradeEgg / instantHatch would affect. */
    _upgradeTarget: function (ctx) {
      var St = S();
      var D = SE.DragonData;
      ctx = ctx || {};
      if (!St || !D) return { egg: null };
      var hs = St.data.hatcheries;
      var max = D.VARIANTS.length - 1;
      var uid = ctx.egg && ctx.egg.uid;
      if (uid) {                                  // the egg named by the caller (e.g. the one just delivered)
        for (var h = 0; h < hs.length; h++) if (hs[h].egg && hs[h].egg.uid === uid) return hs[h].egg.variant < max ? { egg: hs[h].egg, hatchery: h } : { egg: null };
        var c = SE.Game && SE.Game.carrying;
        if (c && c.uid === uid) return c.variant < max ? { egg: c, carried: true } : { egg: null };
      }
      if (typeof ctx.hatchery === 'number' && hs[ctx.hatchery] && hs[ctx.hatchery].egg && hs[ctx.hatchery].egg.variant < max) {
        return { egg: hs[ctx.hatchery].egg, hatchery: ctx.hatchery };
      }
      var carried = SE.Game && SE.Game.carrying;
      if (ctx.carried && carried && carried.variant < max) return { egg: carried, carried: true };
      var best = -1;
      for (var i = 0; i < hs.length; i++) {
        if (hs[i].egg && hs[i].egg.variant < max && (best < 0 || D.income(hs[i].egg.species, hs[i].egg.variant) > D.income(hs[best].egg.species, hs[best].egg.variant))) best = i;
      }
      if (best >= 0) return { egg: hs[best].egg, hatchery: best };
      if (carried && carried.variant < max) return { egg: carried, carried: true };
      return { egg: null };
    },

    available: function (id, ctx) {
      var St = S();
      if (!BY_ID[id]) return true;
      if (!St) return false;
      if (tutorialActive()) return false;                  // no rewarded offers during the tutorial
      var d = St.data;
      var G = SE.Game, B = SE.Boosts;
      ctx = ctx || {};
      switch (id) {
        case 'teleportHome':
          return !!(G && G.carrying && !G.carryDelivered && !(typeof G.atBase === 'function' && G.atBase()));
        case 'trialRaid': {
          if (!G || typeof G.trialTarget !== 'function' || G.trial) return false;
          var target = G.trialTarget();
          return target > 0 && (typeof ctx.lair !== 'number' || ctx.lair === target);
        }
        case 'dragonShield':
          return !B.isActive('dragonShield');
        case 'goldenEgg': {
          var r = this.store();
          return !!r && !r.golden;
        }
        case 'tripleReward': {
          var ld = G && G.lastDelivery;
          return !!(ld && !ld.tripled && (ld.cash > 0 || ld.gems > 0) && (!ctx.token || ctx.token === ld.token));
        }
        case 'turboTrain': case 'gemsX2':
          return !B.isActive(id) || B.remaining(id) < 60;
        case 'instantHatch':
          if (typeof ctx.hatchery === 'number') return !!(d.hatcheries[ctx.hatchery] && d.hatcheries[ctx.hatchery].egg);
          return d.hatcheries.some(function (h) { return !!h.egg; });
        case 'x2hatch':
          return !SE.Boosts.isActive('x2hatch') || SE.Boosts.remaining('x2hatch') < 60;
        case 'freeHatchery':
          return St.nextLockedHatchery() >= 0;
        case 'upgradeEgg':
          return !!this._upgradeTarget(ctx).egg;
        case 'offlineX2':
          return !!(ctx.amount > 0 || (SE.State.pendingOffline && SE.State.pendingOffline.amount > 0));
        case 'revive':
          return !!(ctx && ctx.egg);
        case 'lairDiscount':
          return d.lairs.some(function (u) { return !u; });
        case 'speedUp':
          return d.speed < St.MAX_SPEED;
        case 'doubleSell':
          return !!(ctx.amount > 0) || d.dragons.length > 0;
        default:
          return true;
      }
    },

    list: function (filter) {
      var self = this;
      return OFFERS.filter(function (o) {
        if (typeof filter === 'function') return filter(o);
        if (filter === 'panel') return o.panel && self.available(o.id);
        if (typeof filter === 'string' && CATS.indexOf(filter) >= 0) return o.cat === filter;
        return true;
      });
    },

    /* ---------------- rewarded ---------------- */
    rewarded: function (placementId, onGranted, onDone) {
      var self = this;
      placementId = String(placementId || 'reward');
      if (this.busy || this.interstitialBusy) { later(onDone, false); return false; }
      if (!this.canShow()) {
        ui('toast', t('ads.unavailable'), 'error');
        later(onDone, false);
        return false;
      }
      var left = this.cooldownLeft(placementId);
      if (left > 0) {
        ui('toast', t('ads.cooldown', Math.ceil(left)), 'info');
        later(onDone, false);
        return false;
      }

      var granted = false, finished = false, watchdog = null;
      this.busy = true;
      ui('showAdWait', true);
      setPause(true);

      function grant() {
        if (granted || finished) return;
        granted = true;
        self.cooldowns[placementId] = now();
        if (BY_ID[placementId] && BY_ID[placementId].persist) {
          var r = self.store();
          if (r) r.cd[placementId] = now();                // saved together with the reward (applyReward saves)
        }
        if (SE.Audio && SE.Audio.play) { try { SE.Audio.play('ad_reward', { volume: 0.7 }); } catch (e) {} }
        safe(onGranted);
      }
      function finish(rewardedFlag) {
        if (finished) return;
        if (rewardedFlag === true) grant();      // some SDKs only report the reward through onClose
        finished = true;
        clearTimeout(watchdog);
        self.busy = false;
        ui('showAdWait', false);
        setPause(false);
        if (!granted) ui('toast', t('ads.noReward'), 'info');
        if (SE.UI && typeof SE.UI.updateHUD === 'function') ui('updateHUD');
        safe(onDone, granted);
      }
      watchdog = setTimeout(function () {
        console.warn('[Ads] rewarded "' + placementId + '" got no answer from the platform');
        finish(false);
      }, REWARD_TIMEOUT_MS);

      try {
        P().showRewarded(placementId, function () { grant(); }, function (ok) { finish(ok === true); });
      } catch (e) {
        console.error('[Ads] showRewarded failed', e);
        finish(false);
      }
      return true;
    },

    claim: function (offerId, ctx, onDone) {
      if (BY_ID[offerId] && tutorialActive()) {
        ui('toast', t('ads.tutorial'), 'info');
        later(onDone, false);
        return false;
      }
      if (BY_ID[offerId] && !this.available(offerId, ctx)) {
        ui('toast', t('ads.notNow'), 'info');
        later(onDone, false);
        return false;
      }
      return this.rewarded(offerId, function () {
        if (SE.Game && typeof SE.Game.applyReward === 'function') SE.Game.applyReward(offerId, ctx || {});
      }, onDone);
    },

    /* ---------------- interstitial cadence ---------------- */
    roundEnded: function (token) {
      if (tutorialActive()) return false;
      if (token === undefined || token === null) token = 'auto' + (++this._nextToken);
      if (this._roundTokens[token]) return false;
      this._roundTokens[token] = true;
      var St = S();
      if (!St) return false;
      if (!St.data.ads || typeof St.data.ads !== 'object') St.data.ads = { rounds: 0 };
      St.data.ads.rounds = Math.min(1000, (St.data.ads.rounds || 0) + 1);
      return true;
    },

    rounds: function () { var St = S(); return St && St.data.ads ? St.data.ads.rounds || 0 : 0; },

    shouldShowInterstitial: function () {
      if (!this.enabled() || tutorialActive()) return false;
      if (this.sessionResults < 1) return false;           // never after the first result
      if (this.rounds() < ROUNDS_FOR_INTERSTITIAL) return false;
      var p = P();
      try { return !!(p && typeof p.canInterstitial === 'function' && p.canInterstitial()); } catch (e) { return false; }
    },

    next: function (go) {
      var self = this;
      if (this._pendingGo) return false;                  // double click while the ad opens
      var once = false;
      function proceed() {
        if (once) return;
        once = true;
        self._pendingGo = null;
        self.sessionResults++;
        safe(go);
      }
      this._pendingGo = proceed;
      if (!this.shouldShowInterstitial() || this.busy || this.interstitialBusy) { proceed(); return true; }

      var finished = false, watchdog = null;
      this.interstitialBusy = true;
      ui('showAdWait', true);
      setPause(true);
      function done(shown) {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        self.interstitialBusy = false;
        if (shown) {
          var St = S();
          if (St && St.data.ads) { St.data.ads.rounds = 0; St.save(); }
        }
        ui('showAdWait', false);
        setPause(false);
        proceed();
      }
      watchdog = setTimeout(function () { done(false); }, INTERSTITIAL_TIMEOUT_MS);
      try {
        P().showInterstitial('round_end', function (shown) { done(shown === true); });
      } catch (e) {
        console.error('[Ads] showInterstitial failed', e);
        done(false);
      }
      return true;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Strings                                                                 */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: {
        'ads.unavailable': 'Реклама сейчас недоступна. Попробуй чуть позже.',
        'ads.cooldown': 'Снова доступно через {0} с',
        'ads.noReward': 'Награда не получена — реклама закрыта раньше времени.',
        'ads.notNow': 'Эта награда сейчас не пригодится.',
        'ads.loading': 'Реклама загружается…',
        'ads.watch': 'За рекламу',
        'offer.cat.boost': 'Бусты',
        'offer.cat.egg': 'Яйца',
        'offer.cat.money': 'Деньги',
        'offer.cat.run': 'Побег',
        'offer.cat.speed': 'Скорость',
        'offer.x2income.t': 'Доход ×2',
        'offer.x2income.d': 'Драконы приносят вдвое больше монет 3 минуты.',
        'offer.x2hatch.t': 'Быстрое высиживание',
        'offer.x2hatch.d': 'Яйца вылупляются в 2 раза быстрее 5 минут.',
        'offer.instantHatch.t': 'Вылупить сейчас',
        'offer.instantHatch.d': 'Яйцо в инкубаторе вылупится мгновенно.',
        'offer.speedBoost.t': 'Скорость ×2',
        'offer.speedBoost.d': 'Бегаешь в 2 раза быстрее 1 минуту.',
        'offer.luckyEgg.t': 'Счастливое яйцо',
        'offer.luckyEgg.d': 'Шанс золотых, кристальных, радужных и галактических яиц ×2 на 3 минуты.',
        'offer.revive.t': 'Второй шанс',
        'offer.revive.d': 'Оставь яйцо себе и убеги: 20 с невидимости и скорость ×2.',
        'offer.dragonSleep.t': 'Сонное зелье',
        'offer.dragonSleep.d': 'Драконы не просыпаются 45 с, даже если ты крадёшь яйцо.',
        'offer.magnet.t': 'Магнит для монет',
        'offer.magnet.d': 'Монеты сами летят к тебе 1 минуту.',
        'offer.cashBonus.t': 'Мешок денег',
        'offer.cashBonus.d': 'Получи {0} прямо сейчас.',
        'offer.freeHatchery.t': 'Бесплатный инкубатор',
        'offer.freeHatchery.d': 'Открой следующий инкубатор бесплатно (цена {0}).',
        'offer.offlineX2.t': 'Доход ×2',
        'offer.offlineX2.d': 'Удвой доход за время отсутствия: ещё +{0}.',
        'offer.doubleSell.t': 'Двойная продажа',
        'offer.doubleSell.d': 'Драконы продаются в 2 раза дороже 3 минуты.',
        'offer.doubleSell.d2': 'Получи ещё +{0} за эту продажу, и 3 минуты драконы продаются ×2.',
        'offer.speedUp.t': 'Тренировка',
        'offer.speedUp.d': '+{0} к скорости навсегда.',
        'offer.upgradeEgg.t': 'Улучшить яйцо',
        'offer.upgradeEgg.d': 'Яйцо станет редкого варианта получше (Обычное → Золотое → Кристальное…).',
        'offer.upgradeEgg.d2': 'Яйцо станет лучше: {0} → {1}.',
        'offer.lairDiscount.t': 'Скидка на логова',
        'offer.lairDiscount.d': 'Ворота логов дешевле на 30 % в течение 5 минут.',
        'ads.tutorial': 'Сначала закончи обучение — потом будут награды за рекламу.',
        'offer.teleportHome.t': 'Телепорт домой',
        'offer.teleportHome.d': 'Мгновенно перенесись на базу вместе с яйцом — доставка засчитается как обычно.',
        'offer.trialRaid.t': 'Пробный набег',
        'offer.trialRaid.d': 'Ворота закрытого логова откроются на один набег (до {0} мин).',
        'offer.trialRaid.d2': 'Пробный набег: ворота «{0}» откроются на один набег (до {1} мин).',
        'offer.dragonShield.t': 'Драконий щит',
        'offer.dragonShield.d': '5 минут: если дракон тебя поймает, яйцо останется у тебя — щит оттолкнёт тебя и даст 3 с невидимости. Срабатывает один раз.',
        'offer.goldenEgg.t': 'Золотое яйцо',
        'offer.goldenEgg.d': 'Следующее украденное яйцо будет минимум Золотым — или ещё реже!',
        'offer.tripleReward.t': '×3 награда',
        'offer.tripleReward.d': 'Утрой награду за эту доставку: деньги и самоцветы.',
        'offer.tripleReward.d2': 'Утрой награду за доставку: ещё +{0} и +{1} самоцветов.',
        'offer.turboTrain.t': 'Турбо-тренировка',
        'offer.turboTrain.d': 'Беговая дорожка тренирует скорость в 3 раза быстрее 3 минуты.',
        'offer.gemsX2.t': 'Самоцветы ×2',
        'offer.gemsX2.d': 'Вдвое больше самоцветов за каждую доставку яйца 10 минут.',
        'offer.freeChest.t': 'Сундук с наградой',
        'offer.freeChest.d': 'Открой сундук: самоцветы, деньги, буст, а иногда предмет из магазина! Новый сундук — каждые 6 минут.'
      },
      en: {
        'ads.unavailable': 'No ad available right now. Try again a bit later.',
        'ads.cooldown': 'Available again in {0} s',
        'ads.noReward': 'No reward — the ad was closed too early.',
        'ads.notNow': 'This reward is of no use right now.',
        'ads.loading': 'Loading the ad…',
        'ads.watch': 'Watch ad',
        'offer.cat.boost': 'Boosts',
        'offer.cat.egg': 'Eggs',
        'offer.cat.money': 'Money',
        'offer.cat.run': 'Escape',
        'offer.cat.speed': 'Speed',
        'offer.x2income.t': 'Income ×2',
        'offer.x2income.d': 'Your dragons earn twice as many coins for 3 minutes.',
        'offer.x2hatch.t': 'Fast hatching',
        'offer.x2hatch.d': 'Eggs hatch twice as fast for 5 minutes.',
        'offer.instantHatch.t': 'Hatch now',
        'offer.instantHatch.d': 'The egg in your hatchery hatches instantly.',
        'offer.speedBoost.t': 'Speed ×2',
        'offer.speedBoost.d': 'Run twice as fast for 1 minute.',
        'offer.luckyEgg.t': 'Lucky egg',
        'offer.luckyEgg.d': 'Double chance of Golden, Crystal, Rainbow and Galaxy eggs for 3 minutes.',
        'offer.revive.t': 'Second chance',
        'offer.revive.d': 'Keep the egg and escape: 20 s of invisibility and speed ×2.',
        'offer.dragonSleep.t': 'Sleep potion',
        'offer.dragonSleep.d': 'Dragons stay asleep for 45 s, even while you steal.',
        'offer.magnet.t': 'Coin magnet',
        'offer.magnet.d': 'Coins fly to you on their own for 1 minute.',
        'offer.cashBonus.t': 'Bag of cash',
        'offer.cashBonus.d': 'Get {0} right now.',
        'offer.freeHatchery.t': 'Free hatchery',
        'offer.freeHatchery.d': 'Unlock the next hatchery for free (worth {0}).',
        'offer.offlineX2.t': 'Income ×2',
        'offer.offlineX2.d': 'Double what you earned while away: +{0} more.',
        'offer.doubleSell.t': 'Double sale',
        'offer.doubleSell.d': 'Dragons sell for twice the price for 3 minutes.',
        'offer.doubleSell.d2': 'Get +{0} more for this sale, and dragons sell ×2 for 3 minutes.',
        'offer.speedUp.t': 'Training',
        'offer.speedUp.d': '+{0} speed forever.',
        'offer.upgradeEgg.t': 'Upgrade egg',
        'offer.upgradeEgg.d': 'Your egg becomes a rarer variant (Normal → Golden → Crystal…).',
        'offer.upgradeEgg.d2': 'Your egg gets better: {0} → {1}.',
        'offer.lairDiscount.t': 'Lair discount',
        'offer.lairDiscount.d': 'Lair gates cost 30% less for 5 minutes.',
        'ads.tutorial': 'Finish the tutorial first — ad rewards come after it.',
        'offer.teleportHome.t': 'Teleport home',
        'offer.teleportHome.d': 'Instantly warp to your base with the egg — it counts as a normal delivery.',
        'offer.trialRaid.t': 'Trial raid',
        'offer.trialRaid.d': 'The gate of a locked lair opens for one raid (up to {0} min).',
        'offer.trialRaid.d2': 'Trial raid: the {0} gate opens for one raid (up to {1} min).',
        'offer.dragonShield.t': 'Dragon shield',
        'offer.dragonShield.d': '5 minutes: if a dragon catches you, you keep the egg — the shield pushes you away and gives 3 s of invisibility. Works once.',
        'offer.goldenEgg.t': 'Golden egg',
        'offer.goldenEgg.d': 'Your next stolen egg is at least Golden — or even rarer!',
        'offer.tripleReward.t': '×3 reward',
        'offer.tripleReward.d': 'Triple this delivery’s cash and gems.',
        'offer.tripleReward.d2': 'Triple this delivery: +{0} and +{1} gems more.',
        'offer.turboTrain.t': 'Turbo training',
        'offer.turboTrain.d': 'The treadmill trains your speed 3× faster for 3 minutes.',
        'offer.gemsX2.t': 'Gems ×2',
        'offer.gemsX2.d': 'Double gems for every egg delivery for 10 minutes.',
        'offer.freeChest.t': 'Reward chest',
        'offer.freeChest.d': 'Open a chest: gems, cash, a boost and sometimes a shop item! A new chest every 6 minutes.'
      },
      tr: {
        'ads.unavailable': 'Şu anda reklam yok. Biraz sonra tekrar dene.',
        'ads.cooldown': '{0} sn sonra tekrar',
        'ads.noReward': 'Ödül yok — reklam erken kapatıldı.',
        'ads.notNow': 'Bu ödül şu an işe yaramaz.',
        'ads.loading': 'Reklam yükleniyor…',
        'ads.watch': 'Reklam izle',
        'offer.cat.boost': 'Güçlendirmeler',
        'offer.cat.egg': 'Yumurtalar',
        'offer.cat.money': 'Para',
        'offer.cat.run': 'Kaçış',
        'offer.cat.speed': 'Hız',
        'offer.x2income.t': 'Gelir ×2',
        'offer.x2income.d': 'Ejderhaların 3 dakika boyunca iki kat para kazanır.',
        'offer.x2hatch.t': 'Hızlı kuluçka',
        'offer.x2hatch.d': 'Yumurtalar 5 dakika boyunca iki kat hızlı çatlar.',
        'offer.instantHatch.t': 'Hemen çatlat',
        'offer.instantHatch.d': 'Kuluçkadaki yumurta anında çatlar.',
        'offer.speedBoost.t': 'Hız ×2',
        'offer.speedBoost.d': '1 dakika boyunca iki kat hızlı koş.',
        'offer.luckyEgg.t': 'Şanslı yumurta',
        'offer.luckyEgg.d': '3 dakika boyunca Altın, Kristal, Gökkuşağı ve Galaksi yumurta şansı ×2.',
        'offer.revive.t': 'İkinci şans',
        'offer.revive.d': 'Yumurtayı koru ve kaç: 20 sn görünmezlik ve hız ×2.',
        'offer.dragonSleep.t': 'Uyku iksiri',
        'offer.dragonSleep.d': 'Ejderhalar 45 sn uyanmaz, yumurta çalsan bile.',
        'offer.magnet.t': 'Para mıknatısı',
        'offer.magnet.d': 'Paralar 1 dakika boyunca kendiliğinden sana uçar.',
        'offer.cashBonus.t': 'Para çuvalı',
        'offer.cashBonus.d': 'Hemen {0} al.',
        'offer.freeHatchery.t': 'Bedava kuluçka',
        'offer.freeHatchery.d': 'Sıradaki kuluçkayı bedava aç (değeri {0}).',
        'offer.offlineX2.t': 'Gelir ×2',
        'offer.offlineX2.d': 'Yokken kazandığını ikiye katla: +{0} daha.',
        'offer.doubleSell.t': 'Çifte satış',
        'offer.doubleSell.d': 'Ejderhalar 3 dakika boyunca iki kat fiyata satılır.',
        'offer.doubleSell.d2': 'Bu satış için +{0} daha al; 3 dakika boyunca ejderhalar ×2 fiyata satılır.',
        'offer.speedUp.t': 'Antrenman',
        'offer.speedUp.d': 'Kalıcı +{0} hız.',
        'offer.upgradeEgg.t': 'Yumurtayı geliştir',
        'offer.upgradeEgg.d': 'Yumurtan daha nadir bir türe dönüşür (Normal → Altın → Kristal…).',
        'offer.upgradeEgg.d2': 'Yumurtan gelişir: {0} → {1}.',
        'offer.lairDiscount.t': 'İn indirimi',
        'offer.lairDiscount.d': 'İn kapıları 5 dakika boyunca %30 daha ucuz.',
        'ads.tutorial': 'Önce eğitimi bitir — reklam ödülleri ondan sonra.',
        'offer.teleportHome.t': 'Eve ışınlan',
        'offer.teleportHome.d': 'Yumurtayla birlikte anında üssüne ışınlan — normal teslimat sayılır.',
        'offer.trialRaid.t': 'Deneme baskını',
        'offer.trialRaid.d': 'Kilitli bir inin kapısı tek bir baskın için açılır (en fazla {0} dk).',
        'offer.trialRaid.d2': 'Deneme baskını: {0} kapısı tek bir baskın için açılır (en fazla {1} dk).',
        'offer.dragonShield.t': 'Ejderha kalkanı',
        'offer.dragonShield.d': '5 dakika: bir ejderha seni yakalarsa yumurta sende kalır — kalkan seni iter ve 3 sn görünmezlik verir. Bir kez çalışır.',
        'offer.goldenEgg.t': 'Altın yumurta',
        'offer.goldenEgg.d': 'Çaldığın bir sonraki yumurta en az Altın olur — ya da daha da nadir!',
        'offer.tripleReward.t': '×3 ödül',
        'offer.tripleReward.d': 'Bu teslimatın parasını ve mücevherlerini üçe katla.',
        'offer.tripleReward.d2': 'Teslimatı üçe katla: +{0} ve +{1} mücevher daha.',
        'offer.turboTrain.t': 'Turbo antrenman',
        'offer.turboTrain.d': 'Koşu bandı 3 dakika boyunca hızını 3 kat hızlı geliştirir.',
        'offer.gemsX2.t': 'Mücevher ×2',
        'offer.gemsX2.d': '10 dakika boyunca her yumurta teslimatında iki kat mücevher.',
        'offer.freeChest.t': 'Ödül sandığı',
        'offer.freeChest.d': 'Sandığı aç: mücevher, para, güçlendirme ve bazen mağaza eşyası! Her 6 dakikada yeni sandık.'
      }
    });
  }

  SE.Ads = Ads;
})(window);
