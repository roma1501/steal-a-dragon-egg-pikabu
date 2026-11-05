/* =========================================================================
   Steal a Dragon Egg — player state, economy and boosts (SE.State, SE.Boosts)

   Depends on SE.DragonData (data/dragons.js) and, optionally, SE.CosmeticData
   (data/cosmetics.js, used to validate cosmetic ids) and SE.Platform (load/save).
   Balance numbers are documented in docs/BALANCE.md (verified by
   `node tools/balance-sim.mjs`).

   State object (SE.State.data), schema v:1 — see docs/SPEC.md §7.

   Conventions
   - Mutators return booleans / result objects and never throw on bad input.
   - unlockHatchery / unlockLair / upgradeTreadmill only change the state (no
     payment) — used by rewards and QA. buyHatchery / buyLair /
     buyTreadmillUpgrade check the price, spend and unlock in one call.
   - Time comes from SE.State.now() (Date.now by default; replaceable in tests).

   API (SPEC §7 + documented extras)
     data, pendingOffline, now()
     create([now]) -> fresh state        migrate(raw[, now]) -> valid state (never throws)
     load() -> Promise<data>             (SE.Platform.load(); rejection propagates)
     save() -> Promise<bool>             (SE.Platform.save(data); stamps savedAt/lastSeen)
     reset()                             fresh state in memory (caller saves)
     addMoney(n), spend(n), canAfford(n), addGems(n), spendGems(n), canAffordGems(n)
     incomePerSec(boosts)                equipped ×1, others ×0.1, x2income boost ×2
     tick(dt, boosts) -> { earned, hatched:[i] }   passive income + hatchery timers
     addDragon(species, variant) -> { uid, isNew, item, autoEquipped, autoSold } | null
         (collection holds MAX_DRAGONS; when full the least valuable unequipped dragon
          is sold automatically and reported in autoSold { species, variant, value })
     removeDragon(uid) -> item|null, getDragon(uid), sellDragon(uid[, mult]) -> cash,
     sellDragons(uids[, mult]) -> { count, total }
     equip(uid), unequip(uid), isEquipped(uid), equipBest(), MAX_EQUIP = 6
     dragonValue(item)
     hatcheryPrice(i), freeHatchery() -> i|-1, nextLockedHatchery() -> i|-1,
     unlockHatchery(i), buyHatchery(i), unlockedHatcheries()
     placeEgg(i, egg[, seconds]) -> bool  (seconds overrides the hatch time, e.g. tutorial 8)
     updateHatcheries([now]) -> [i…]      eggs whose time is up become babies (stats.hatched++)
     hatchRemaining(i), hatchProgress(i) -> 0..1, isReady(i), finishHatch(i) (instant hatch)
     collectHatchery(i) -> addDragon result + { species, variant } | null
     lairPrice(i[, mult]), lairUnlocked(i), unlockLair(i), buyLair(i[, mult]), highestLair()
     treadmillLevel(), treadmillUpgradePrice() -> number|null, upgradeTreadmill(),
     buyTreadmillUpgrade(), trainRate(moving[, level]), train(dt, moving) -> gained,
     addSpeed(n), walkSpeed([stat]), MAX_SPEED
     owns(itemId), grantItem(itemId), equipItem(itemId), unequipSlot(slot),
     adViews(itemId), addAdView(itemId) -> views
     offlineEarnings([now]) -> { seconds, amount, capped }
     computeOffline([now]) -> pendingOffline|null   (load() calls it; also after a long hidden tab)
     claimOffline([mult]) -> amount        pays pendingOffline × mult once, stamps lastSeen
     computeScore()  max(previous, totalEarned/1000 + 1000 × index entries + 10 × deliveries)
     cashBonusAmount([mult])               reward cash scaled to the player's progress
     todayKey([date]) -> 'YYYY-MM-DD' (device local date), dayDiff(a, b)

   SE.Boosts: activate(id, secs), isActive(id), remaining(id), list() -> [{ id, left }],
              clear(id), clearAll(), now()
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  /* ---------------------------------------------------------------------- */
  /* Balance constants (docs/BALANCE.md, SPEC §3.3)                          */
  /* ---------------------------------------------------------------------- */
  var HATCHERY_COUNT = 8;
  var HATCHERY_PRICES = [0, 300, 2000, 20000, 120000, 800000, 8000000, 60000000];
  var TREADMILL_PRICES = [500, 3000, 25000, 150000, 1000000, 8000000, 60000000, 500000000, 4000000000];
  var MAX_TREADMILL = TREADMILL_PRICES.length + 1;
  var TRAIN_BASE = 0.1, TRAIN_EXP = 1.35, TRAIN_MOVING = 1.6;
  var WALK_BASE = 12, WALK_PER_STAT = 0.28;
  var START_MONEY = 150, START_SPEED = 20, MAX_SPEED = 500;
  var MAX_EQUIP = 6, MAX_DRAGONS = 250, UNEQUIPPED_RATE = 0.1;
  var OFFLINE_MAX_SEC = 8 * 3600, OFFLINE_RATE = 0.5, OFFLINE_MIN_SEC = 60;
  var LAIR_COUNT = 6;
  var SLOTS = ['outfit', 'hat', 'back', 'trail', 'victory'];
  var DEFAULT_OUTFIT = 'outfit_classic';
  var QUALITIES = ['auto', 'high', 'medium', 'low'];
  var STAT_KEYS = ['steals', 'delivered', 'caught', 'hatched', 'sold', 'spins', 'gifts'];
  var MAX_MONEY = 1e18, MAX_COUNT = 1e9, MAX_AD_SPINS = 3, MAX_SCORE = 2000000000;
  var MAX_EXTRA_KEYS = 16, MAX_EXTRA_BYTES = 8192;

  var KNOWN_KEYS = ['v', 'money', 'gems', 'speed', 'totalEarned', 'score', 'hatcheries', 'dragons',
    'equipped', 'lairs', 'treadmill', 'index', 'stats', 'cosmetics', 'daily', 'wheel', 'ads',
    'tutorialDone', 'settings', 'savedAt', 'lastSeen'];

  /* ---------------------------------------------------------------------- */
  /* Small pure helpers                                                      */
  /* ---------------------------------------------------------------------- */
  function DD() { return SE.DragonData; }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isRecord(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function finite(v) { return typeof v === 'number' && isFinite(v); }
  function num(v, def, min, max) {
    if (!finite(v)) return def;
    if (min !== undefined && v < min) return min;
    if (max !== undefined && v > max) return max;
    return v;
  }
  function nonNeg(v, def, max) { return finite(v) && v >= 0 ? Math.min(v, max === undefined ? MAX_MONEY : max) : def; }
  function int(v, def, min, max) { return finite(v) ? num(Math.floor(v), def, min, max) : def; }
  function bool(v, def) { return typeof v === 'boolean' ? v : def; }
  function dateKey(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return '';
    var p = v.split('-').map(Number);
    return p[1] >= 1 && p[1] <= 12 && p[2] >= 1 && p[2] <= 31 ? v : '';
  }
  function validUid(u) { return typeof u === 'string' && u.length > 0 && u.length <= 48 && /^[A-Za-z0-9_.-]+$/.test(u); }
  function validSpecies(id) { return !!DD() && DD().isSpecies(id); }
  function validVariant(v) { return typeof v === 'number' && v % 1 === 0 && v >= 0 && !!DD() && !!DD().variant(v); }
  function jsonClone(v, maxBytes) {
    try {
      var s = JSON.stringify(v);
      if (s === undefined || (maxBytes && s.length > maxBytes)) return undefined;
      return JSON.parse(s);
    } catch (e) { return undefined; }
  }
  function cosmeticItem(id) {
    var C = SE.CosmeticData;
    if (typeof id !== 'string' || !id || id.length > 64) return null;
    if (C && typeof C.item === 'function') {
      var it = null;
      try { it = C.item(id); } catch (e) { it = null; }
      return it && it.id === id ? it : null;
    }
    /* CosmeticData not loaded (tests / early boot): accept well-formed ids. */
    if (!/^[a-z0-9_]+$/.test(id)) return null;
    var tab = id.split('_')[0];
    return { id: id, tab: SLOTS.indexOf(tab) >= 0 ? tab : null };
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------------------------------------------------------------------- */
  /* Fresh state                                                             */
  /* ---------------------------------------------------------------------- */
  function createState(now) {
    now = finite(now) ? now : Date.now();
    var hatcheries = [];
    for (var i = 0; i < HATCHERY_COUNT; i++) {
      hatcheries.push({ unlocked: i === 0, egg: null, baby: null, hatchAt: 0, duration: 0 });
    }
    var lairs = [];
    for (var j = 0; j < LAIR_COUNT; j++) lairs.push(j === 0);
    var owned = {};
    owned[DEFAULT_OUTFIT] = true;
    return {
      v: 1,
      money: START_MONEY,
      gems: 0,
      speed: START_SPEED,
      totalEarned: 0,
      score: 0,
      hatcheries: hatcheries,
      dragons: [],
      equipped: [],
      lairs: lairs,
      treadmill: 1,
      index: {},
      stats: { steals: 0, delivered: 0, caught: 0, hatched: 0, sold: 0, spins: 0, gifts: 0 },
      cosmetics: {
        owned: owned,
        equipped: { outfit: DEFAULT_OUTFIT, hat: null, back: null, trail: null, victory: null },
        adViews: {}
      },
      daily: { day: 0, cycle: 0, lastDate: '' },
      wheel: { freeDate: '', adDate: '', adSpins: 0, pending: null },
      ads: { rounds: 0 },
      tutorialDone: false,
      settings: { sfx: true, music: true, quality: 'auto', shadows: true },
      savedAt: 0,
      lastSeen: now
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Migration / validation — pure: returns a NEW object, never throws       */
  /* ---------------------------------------------------------------------- */
  function migrateState(raw, now) {
    now = finite(now) ? now : Date.now();
    var base = createState(now);
    try {
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { return base; }
      }
      if (!isRecord(raw)) return base;
      var s = base;
      var D = DD();

      s.money = nonNeg(raw.money, base.money);
      s.gems = Math.floor(nonNeg(raw.gems, 0, MAX_COUNT * 1000));
      s.speed = num(raw.speed, START_SPEED, START_SPEED, MAX_SPEED);
      s.totalEarned = nonNeg(raw.totalEarned, 0);
      s.score = Math.floor(nonNeg(raw.score, 0, MAX_SCORE));
      s.treadmill = int(raw.treadmill, 1, 1, MAX_TREADMILL);
      s.tutorialDone = bool(raw.tutorialDone, false);

      /* lairs */
      var lairs = Array.isArray(raw.lairs) ? raw.lairs : [];
      for (var li = 1; li < LAIR_COUNT; li++) s.lairs[li] = lairs[li] === true;

      /* dragons (collection) */
      var seen = {};
      var dragons = Array.isArray(raw.dragons) ? raw.dragons : [];
      for (var di = 0; di < dragons.length && s.dragons.length < MAX_DRAGONS; di++) {
        var d = dragons[di];
        if (!isRecord(d) || !validSpecies(d.species) || !validVariant(d.variant)) continue;
        var uid = validUid(d.uid) && !seen[d.uid] ? d.uid : D.newUid('d');
        while (seen[uid]) uid = D.newUid('d');
        seen[uid] = true;
        s.dragons.push({ uid: uid, species: d.species, variant: d.variant });
      }

      /* equipped ⊆ dragons, unique, ≤ MAX_EQUIP */
      var eq = Array.isArray(raw.equipped) ? raw.equipped : [];
      for (var ei = 0; ei < eq.length && s.equipped.length < MAX_EQUIP; ei++) {
        if (typeof eq[ei] === 'string' && hasOwn(seen, eq[ei]) && s.equipped.indexOf(eq[ei]) < 0) s.equipped.push(eq[ei]);
      }

      /* hatcheries */
      var hs = Array.isArray(raw.hatcheries) ? raw.hatcheries : [];
      for (var hi = 0; hi < HATCHERY_COUNT; hi++) {
        var src = isRecord(hs[hi]) ? hs[hi] : {};
        var h = s.hatcheries[hi];
        h.unlocked = hi === 0 || src.unlocked === true;
        if (isRecord(src.baby) && validSpecies(src.baby.species) && validVariant(src.baby.variant)) {
          h.baby = { species: src.baby.species, variant: src.baby.variant };
        } else if (isRecord(src.egg) && validSpecies(src.egg.species) && validVariant(src.egg.variant)) {
          var egg = { species: src.egg.species, variant: src.egg.variant, uid: validUid(src.egg.uid) ? src.egg.uid : D.newUid('e') };
          var full = D.hatchTime(egg);
          var dur = num(src.duration, full, 1, full);
          var hatchAt = finite(src.hatchAt) && src.hatchAt > 0 ? src.hatchAt : now + dur * 1000;
          if (hatchAt > now + dur * 1000) hatchAt = now + dur * 1000;   /* clock moved back / tampering */
          h.egg = egg;
          h.duration = dur;
          h.hatchAt = hatchAt;
        }
        if (h.egg || h.baby) h.unlocked = true;
      }

      /* index: valid keys only, plus everything owned */
      if (isRecord(raw.index)) {
        for (var key in raw.index) {
          if (!hasOwn(raw.index, key) || !D.parseIndexKey(key)) continue;
          var c = Math.floor(nonNeg(raw.index[key], 0, MAX_COUNT));
          if (c > 0) s.index[key] = c;
        }
      }
      s.dragons.forEach(function (dr) {
        var k = D.indexKey(dr.species, dr.variant);
        if (!s.index[k]) s.index[k] = 1;
      });

      /* stats */
      var st = isRecord(raw.stats) ? raw.stats : {};
      STAT_KEYS.forEach(function (k) { s.stats[k] = Math.floor(nonNeg(st[k], 0, MAX_COUNT)); });

      /* cosmetics */
      var cos = isRecord(raw.cosmetics) ? raw.cosmetics : {};
      if (isRecord(cos.owned)) {
        var n = 0;
        for (var id in cos.owned) {
          if (n >= 1000) break;
          if (hasOwn(cos.owned, id) && cos.owned[id] === true && cosmeticItem(id)) { s.cosmetics.owned[id] = true; n++; }
        }
      }
      s.cosmetics.owned[DEFAULT_OUTFIT] = true;
      var ceq = isRecord(cos.equipped) ? cos.equipped : {};
      SLOTS.forEach(function (slot) {
        var cid = ceq[slot];
        var it = typeof cid === 'string' ? cosmeticItem(cid) : null;
        var ok = it && s.cosmetics.owned[cid] === true && (it.tab === slot || it.tab === null);
        s.cosmetics.equipped[slot] = ok ? cid : (slot === 'outfit' ? DEFAULT_OUTFIT : null);
      });
      if (isRecord(cos.adViews)) {
        var m = 0;
        for (var aid in cos.adViews) {
          if (m >= 1000) break;
          if (!hasOwn(cos.adViews, aid) || !cosmeticItem(aid)) continue;
          var views = Math.floor(nonNeg(cos.adViews[aid], 0, 99));
          if (views > 0) { s.cosmetics.adViews[aid] = views; m++; }
        }
      }

      /* daily / wheel / ads */
      var daily = isRecord(raw.daily) ? raw.daily : {};
      s.daily.day = finite(daily.day) && daily.day % 1 === 0 && daily.day >= 0 && daily.day <= 6 ? daily.day : 0;
      s.daily.cycle = int(daily.cycle, 0, 0, 100000);
      s.daily.lastDate = dateKey(daily.lastDate);
      var wheel = isRecord(raw.wheel) ? raw.wheel : {};
      s.wheel.freeDate = dateKey(wheel.freeDate);
      s.wheel.adDate = dateKey(wheel.adDate);
      s.wheel.adSpins = int(wheel.adSpins, 0, 0, MAX_AD_SPINS);
      var pending = isRecord(wheel.pending) ? jsonClone(wheel.pending, 2048) : undefined;
      s.wheel.pending = isRecord(pending) ? pending : null;
      var ads = isRecord(raw.ads) ? raw.ads : {};
      s.ads.rounds = int(ads.rounds, 0, 0, 1000);

      /* settings */
      var set = isRecord(raw.settings) ? raw.settings : {};
      s.settings.sfx = bool(set.sfx, true);
      s.settings.music = bool(set.music, true);
      s.settings.shadows = bool(set.shadows, true);
      s.settings.quality = QUALITIES.indexOf(set.quality) >= 0 ? set.quality : 'auto';

      /* timestamps (future values → now) */
      s.savedAt = nonNeg(raw.savedAt, 0, now);
      s.lastSeen = finite(raw.lastSeen) && raw.lastSeen > 0 ? Math.min(raw.lastSeen, now) : now;

      /* unknown top-level keys written by feature modules: keep small JSON values */
      var extra = 0;
      for (var xk in raw) {
        if (extra >= MAX_EXTRA_KEYS) break;
        if (!hasOwn(raw, xk) || KNOWN_KEYS.indexOf(xk) >= 0 || xk === '__proto__') continue;
        var cv = jsonClone(raw[xk], MAX_EXTRA_BYTES);
        if (cv !== undefined) { s[xk] = cv; extra++; }
      }
      s.v = 1;
      return s;
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[State] migrate failed, starting fresh', err);
      return createState(now);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* SE.Boosts                                                               */
  /* ---------------------------------------------------------------------- */
  var Boosts = {
    active: {},
    now: function () { return Date.now(); },

    activate: function (id, secs) {
      if (typeof id !== 'string' || !finite(secs) || secs <= 0) return false;
      var now = this.now();
      var cur = this.active[id] || 0;
      this.active[id] = Math.max(cur, now) + secs * 1000;
      return true;
    },
    isActive: function (id) { return (this.active[id] || 0) > this.now(); },
    remaining: function (id) { return Math.max(0, ((this.active[id] || 0) - this.now()) / 1000); },
    clear: function (id) { delete this.active[id]; },
    clearAll: function () { this.active = {}; },
    list: function () {
      var out = [];
      for (var k in this.active) {
        if (hasOwn(this.active, k) && this.isActive(k)) out.push({ id: k, left: this.remaining(k) });
        else if (hasOwn(this.active, k)) delete this.active[k];
      }
      out.sort(function (a, b) { return a.left - b.left; });
      return out;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* SE.State                                                                */
  /* ---------------------------------------------------------------------- */
  var State = {
    data: null,
    pendingOffline: null,

    MAX_EQUIP: MAX_EQUIP,
    MAX_DRAGONS: MAX_DRAGONS,
    MAX_SPEED: MAX_SPEED,
    START_SPEED: START_SPEED,
    MAX_TREADMILL: MAX_TREADMILL,
    HATCHERY_COUNT: HATCHERY_COUNT,
    HATCHERY_PRICES: HATCHERY_PRICES,
    TREADMILL_PRICES: TREADMILL_PRICES,
    UNEQUIPPED_RATE: UNEQUIPPED_RATE,
    OFFLINE_MAX_SEC: OFFLINE_MAX_SEC,
    OFFLINE_RATE: OFFLINE_RATE,
    OFFLINE_MIN_SEC: OFFLINE_MIN_SEC,
    TRAIN: { base: TRAIN_BASE, exp: TRAIN_EXP, moving: TRAIN_MOVING },
    WALK: { base: WALK_BASE, perStat: WALK_PER_STAT },
    SLOTS: SLOTS,
    DEFAULT_OUTFIT: DEFAULT_OUTFIT,

    now: function () { return Date.now(); },

    /* ---------------- lifecycle ---------------- */
    create: function (now) { return createState(finite(now) ? now : this.now()); },

    migrate: function (raw, now) { return migrateState(raw, finite(now) ? now : this.now()); },

    load: function () {
      var self = this;
      return Promise.resolve().then(function () {
        return SE.Platform.load();
      }).then(function (raw) {
        var now = self.now();
        self.data = raw === null || raw === undefined ? self.create(now) : self.migrate(raw, now);
        self.pendingOffline = null;
        self.computeOffline(now);
        return self.data;
      });
    },

    save: function () {
      if (!this.data || !SE.Platform || typeof SE.Platform.save !== 'function') return Promise.resolve(false);
      var now = this.now();
      this.data.savedAt = now;
      this.data.lastSeen = now;
      try {
        return Promise.resolve(SE.Platform.save(this.data));
      } catch (e) {
        return Promise.resolve(false);
      }
    },

    reset: function () {
      this.data = this.create();
      this.pendingOffline = null;
      Boosts.clearAll();
      return this.data;
    },

    /* ---------------- currencies ---------------- */
    addMoney: function (n) {
      if (!finite(n) || !this.data) return false;
      this.data.money = Math.min(MAX_MONEY, Math.max(0, this.data.money + n));
      if (n > 0) this.data.totalEarned = Math.min(MAX_MONEY, this.data.totalEarned + n);
      return true;
    },
    canAfford: function (n) { return finite(n) && n >= 0 && !!this.data && this.data.money >= n; },
    spend: function (n) {
      if (!this.canAfford(n)) return false;
      this.data.money -= n;
      return true;
    },
    addGems: function (n) {
      if (!finite(n) || !this.data) return false;
      this.data.gems = Math.max(0, Math.floor(this.data.gems + n));
      return true;
    },
    canAffordGems: function (n) { return finite(n) && n >= 0 && !!this.data && this.data.gems >= n; },
    spendGems: function (n) {
      if (!this.canAffordGems(n)) return false;
      this.data.gems -= Math.ceil(n);
      return true;
    },

    /* ---------------- income ---------------- */
    incomePerSec: function (boosts) {
      if (!this.data) return 0;
      var D = DD(), eq = this.data.equipped, sum = 0;
      for (var i = 0; i < this.data.dragons.length; i++) {
        var d = this.data.dragons[i];
        var inc = D.income(d.species, d.variant);
        sum += eq.indexOf(d.uid) >= 0 ? inc : inc * UNEQUIPPED_RATE;
      }
      if (boosts && typeof boosts.isActive === 'function' && boosts.isActive('x2income')) sum *= 2;
      return sum;
    },

    tick: function (dt, boosts) {
      var out = { earned: 0, hatched: [] };
      if (!this.data || !finite(dt) || dt < 0) return out;
      dt = Math.min(dt, 1);   /* a long frame never pays more than 1 s (offline is separate) */
      out.earned = this.incomePerSec(boosts) * dt;
      if (out.earned > 0) this.addMoney(out.earned);
      if (boosts && typeof boosts.isActive === 'function' && boosts.isActive('x2hatch')) {
        for (var i = 0; i < this.data.hatcheries.length; i++) {
          var h = this.data.hatcheries[i];
          if (h.egg) h.hatchAt -= dt * 1000;
        }
      }
      out.hatched = this.updateHatcheries();
      return out;
    },

    offlineEarnings: function (now) {
      now = finite(now) ? now : this.now();
      if (!this.data) return { seconds: 0, amount: 0, capped: false };
      var away = Math.max(0, (now - (this.data.lastSeen || now)) / 1000);
      var secs = Math.min(OFFLINE_MAX_SEC, away);
      return {
        seconds: Math.floor(secs),
        amount: Math.floor(this.incomePerSec(null) * secs * OFFLINE_RATE),
        capped: away > OFFLINE_MAX_SEC
      };
    },

    /* Sets pendingOffline from lastSeen (≥ OFFLINE_MIN_SEC away, amount > 0) and returns it.
       load() calls it; call it again when the tab becomes visible after a long hidden period
       (save() on hide stamps lastSeen). Never stacks: a newer result replaces an unclaimed one. */
    computeOffline: function (now) {
      var off = this.offlineEarnings(now);
      if (off.seconds >= OFFLINE_MIN_SEC && off.amount > 0) this.pendingOffline = off;
      return this.pendingOffline;
    },

    claimOffline: function (mult) {
      var off = this.pendingOffline;
      this.pendingOffline = null;
      if (!this.data) return 0;
      this.data.lastSeen = this.now();
      if (!off || !(off.amount > 0)) return 0;
      var amount = Math.floor(off.amount * (finite(mult) && mult > 0 ? mult : 1));
      this.addMoney(amount);
      return amount;
    },

    /* ---------------- dragons ---------------- */
    getDragon: function (uid) {
      if (!this.data) return null;
      for (var i = 0; i < this.data.dragons.length; i++) if (this.data.dragons[i].uid === uid) return this.data.dragons[i];
      return null;
    },

    dragonValue: function (item) { return item ? DD().value(item.species, item.variant) : 0; },

    addDragon: function (species, variant) {
      if (!this.data || !validSpecies(species) || !validVariant(variant)) return null;
      var D = DD();
      var autoSold = null;
      if (this.data.dragons.length >= MAX_DRAGONS) {
        var worst = null;
        for (var i = 0; i < this.data.dragons.length; i++) {
          var c = this.data.dragons[i];
          if (this.isEquipped(c.uid)) continue;
          if (!worst || this.dragonValue(c) < this.dragonValue(worst)) worst = c;
        }
        if (!worst) return null;
        var value = this.dragonValue(worst);
        this.removeDragon(worst.uid);
        this.addMoney(value);
        this.data.stats.sold++;
        autoSold = { species: worst.species, variant: worst.variant, value: value };
      }
      var uid = D.newUid('d');
      while (this.getDragon(uid)) uid = D.newUid('d');
      var item = { uid: uid, species: species, variant: variant };
      this.data.dragons.push(item);
      var key = D.indexKey(species, variant);
      var isNew = !this.data.index[key];
      this.data.index[key] = Math.min(MAX_COUNT, (this.data.index[key] || 0) + 1);
      var autoEquipped = false;
      if (this.data.equipped.length < MAX_EQUIP) { this.data.equipped.push(uid); autoEquipped = true; }
      return { uid: uid, isNew: isNew, item: item, autoEquipped: autoEquipped, autoSold: autoSold };
    },

    removeDragon: function (uid) {
      if (!this.data) return null;
      for (var i = 0; i < this.data.dragons.length; i++) {
        if (this.data.dragons[i].uid === uid) {
          var it = this.data.dragons.splice(i, 1)[0];
          this.unequip(uid);
          return it;
        }
      }
      return null;
    },

    sellDragon: function (uid, mult) {
      var it = this.removeDragon(uid);
      if (!it) return 0;
      var value = Math.round(this.dragonValue(it) * (finite(mult) && mult > 0 ? mult : 1));
      this.addMoney(value);
      this.data.stats.sold++;
      return value;
    },

    sellDragons: function (uids, mult) {
      var res = { count: 0, total: 0 };
      if (!Array.isArray(uids)) return res;
      for (var i = 0; i < uids.length; i++) {
        var v = this.sellDragon(uids[i], mult);
        if (v > 0) { res.count++; res.total += v; }
      }
      return res;
    },

    isEquipped: function (uid) { return !!this.data && this.data.equipped.indexOf(uid) >= 0; },

    equip: function (uid) {
      if (!this.getDragon(uid)) return false;
      if (this.isEquipped(uid)) return true;
      if (this.data.equipped.length >= MAX_EQUIP) return false;
      this.data.equipped.push(uid);
      return true;
    },

    unequip: function (uid) {
      if (!this.data) return false;
      var i = this.data.equipped.indexOf(uid);
      if (i < 0) return false;
      this.data.equipped.splice(i, 1);
      return true;
    },

    equipBest: function () {
      if (!this.data) return [];
      var D = DD();
      var sorted = this.data.dragons.slice().sort(function (a, b) {
        return D.income(b.species, b.variant) - D.income(a.species, a.variant);
      });
      this.data.equipped = sorted.slice(0, MAX_EQUIP).map(function (d) { return d.uid; });
      return this.data.equipped.slice();
    },

    /* ---------------- hatcheries ---------------- */
    hatcheryPrice: function (i) { return i >= 0 && i < HATCHERY_COUNT ? HATCHERY_PRICES[i] : null; },

    unlockedHatcheries: function () {
      if (!this.data) return 0;
      return this.data.hatcheries.filter(function (h) { return h.unlocked; }).length;
    },

    freeHatchery: function () {
      if (!this.data) return -1;
      for (var i = 0; i < this.data.hatcheries.length; i++) {
        var h = this.data.hatcheries[i];
        if (h.unlocked && !h.egg && !h.baby) return i;
      }
      return -1;
    },

    nextLockedHatchery: function () {
      if (!this.data) return -1;
      for (var i = 0; i < this.data.hatcheries.length; i++) if (!this.data.hatcheries[i].unlocked) return i;
      return -1;
    },

    unlockHatchery: function (i) {
      var h = this.data && this.data.hatcheries[i];
      if (!h || h.unlocked) return false;
      h.unlocked = true;
      return true;
    },

    buyHatchery: function (i) {
      var h = this.data && this.data.hatcheries[i];
      if (!h || h.unlocked || !this.spend(HATCHERY_PRICES[i])) return false;
      h.unlocked = true;
      return true;
    },

    placeEgg: function (i, egg, seconds) {
      var h = this.data && this.data.hatcheries[i];
      if (!h || !h.unlocked || h.egg || h.baby) return false;
      if (!isRecord(egg) || !validSpecies(egg.species) || !validVariant(egg.variant)) return false;
      var dur = finite(seconds) && seconds > 0 ? seconds : DD().hatchTime(egg);
      h.egg = { species: egg.species, variant: egg.variant, uid: validUid(egg.uid) ? egg.uid : DD().newUid('e') };
      h.duration = dur;
      h.hatchAt = this.now() + dur * 1000;
      return true;
    },

    updateHatcheries: function (now) {
      var out = [];
      if (!this.data) return out;
      now = finite(now) ? now : this.now();
      for (var i = 0; i < this.data.hatcheries.length; i++) {
        var h = this.data.hatcheries[i];
        if (h.egg && h.hatchAt <= now) {
          h.baby = { species: h.egg.species, variant: h.egg.variant };
          h.egg = null;
          h.hatchAt = 0;
          h.duration = 0;
          this.data.stats.hatched++;
          out.push(i);
        }
      }
      return out;
    },

    hatchRemaining: function (i) {
      var h = this.data && this.data.hatcheries[i];
      if (!h || !h.egg) return 0;
      return Math.max(0, (h.hatchAt - this.now()) / 1000);
    },

    hatchProgress: function (i) {
      var h = this.data && this.data.hatcheries[i];
      if (!h) return 0;
      if (h.baby) return 1;
      if (!h.egg || !(h.duration > 0)) return 0;
      return Math.max(0, Math.min(1, 1 - this.hatchRemaining(i) / h.duration));
    },

    isReady: function (i) { var h = this.data && this.data.hatcheries[i]; return !!(h && h.baby); },

    finishHatch: function (i) {
      var h = this.data && this.data.hatcheries[i];
      if (!h || !h.egg) return false;
      h.hatchAt = this.now();
      this.updateHatcheries();
      return true;
    },

    collectHatchery: function (i) {
      var h = this.data && this.data.hatcheries[i];
      if (!h || !h.baby) return null;
      var baby = h.baby;
      var res = this.addDragon(baby.species, baby.variant);
      if (!res) return null;
      h.baby = null;
      res.species = baby.species;
      res.variant = baby.variant;
      return res;
    },

    /* ---------------- lairs ---------------- */
    lairPrice: function (i, mult) {
      var s = DD().species(i);
      if (!s) return null;
      return Math.round(s.unlockPrice * (finite(mult) && mult > 0 ? mult : 1));
    },
    lairUnlocked: function (i) { return !!(this.data && this.data.lairs[i]); },
    unlockLair: function (i) {
      if (!this.data || i < 0 || i >= LAIR_COUNT || this.data.lairs[i]) return false;
      this.data.lairs[i] = true;
      return true;
    },
    buyLair: function (i, mult) {
      if (!this.data || i < 1 || i >= LAIR_COUNT || this.data.lairs[i]) return false;
      if (!this.spend(this.lairPrice(i, mult))) return false;
      this.data.lairs[i] = true;
      return true;
    },
    highestLair: function () {
      var h = 0;
      if (!this.data) return h;
      for (var i = 0; i < this.data.lairs.length; i++) if (this.data.lairs[i]) h = i;
      return h;
    },

    /* ---------------- treadmill & speed ---------------- */
    treadmillLevel: function () { return this.data ? this.data.treadmill : 1; },
    treadmillUpgradePrice: function () {
      var l = this.treadmillLevel();
      return l < MAX_TREADMILL ? TREADMILL_PRICES[l - 1] : null;
    },
    upgradeTreadmill: function () {
      if (!this.data || this.data.treadmill >= MAX_TREADMILL) return false;
      this.data.treadmill++;
      return true;
    },
    buyTreadmillUpgrade: function () {
      var price = this.treadmillUpgradePrice();
      if (price === null || !this.spend(price)) return false;
      this.data.treadmill++;
      return true;
    },
    trainRate: function (moving, level) {
      level = finite(level) ? level : this.treadmillLevel();
      return TRAIN_BASE * Math.pow(level, TRAIN_EXP) * (moving ? TRAIN_MOVING : 1);
    },
    train: function (dt, moving) {
      if (!this.data || !finite(dt) || dt <= 0) return 0;
      return this.addSpeed(this.trainRate(moving) * Math.min(dt, 1));
    },
    addSpeed: function (n) {
      if (!this.data || !finite(n)) return 0;
      var before = this.data.speed;
      this.data.speed = Math.max(START_SPEED, Math.min(MAX_SPEED, before + n));
      return this.data.speed - before;
    },
    walkSpeed: function (stat) {
      stat = finite(stat) ? stat : (this.data ? this.data.speed : START_SPEED);
      return WALK_BASE + stat * WALK_PER_STAT;
    },

    /* ---------------- cosmetics ---------------- */
    owns: function (id) { return !!(this.data && this.data.cosmetics.owned[id] === true); },
    grantItem: function (id) {
      if (!this.data || !cosmeticItem(id) || this.owns(id)) return false;
      this.data.cosmetics.owned[id] = true;
      return true;
    },
    equipItem: function (id) {
      var it = cosmeticItem(id);
      if (!it || !this.owns(id)) return false;
      var slot = it.tab;
      if (SLOTS.indexOf(slot) < 0) return false;
      this.data.cosmetics.equipped[slot] = id;
      return true;
    },
    unequipSlot: function (slot) {
      if (!this.data || SLOTS.indexOf(slot) < 0) return false;
      this.data.cosmetics.equipped[slot] = slot === 'outfit' ? DEFAULT_OUTFIT : null;
      return true;
    },
    adViews: function (id) { return (this.data && this.data.cosmetics.adViews[id]) || 0; },
    addAdView: function (id) {
      if (!this.data || !cosmeticItem(id)) return 0;
      var v = Math.min(99, this.adViews(id) + 1);
      this.data.cosmetics.adViews[id] = v;
      return v;
    },

    /* ---------------- misc ---------------- */
    computeScore: function () {
      if (!this.data) return 0;
      var d = this.data;
      var unique = 0;
      for (var k in d.index) if (hasOwn(d.index, k) && d.index[k] > 0) unique++;
      var s = Math.floor(d.totalEarned / 1000) + unique * 1000 + d.stats.delivered * 10;
      d.score = Math.min(MAX_SCORE, Math.max(d.score, s));
      return d.score;
    },

    /* Cash for rewarded "cash bonus" / wheel cash prizes: 2 min of income + 3 deliveries of a
       Normal egg from the highest lair, rounded to 2 significant digits (min 300). */
    cashBonusAmount: function (mult) {
      if (!this.data) return 0;
      var top = DD().species(this.highestLair());
      var v = this.incomePerSec(null) * 120 + DD().deliveryCash({ species: top.id, variant: 0 }) * 3;
      v = Math.max(300, v) * (finite(mult) && mult > 0 ? mult : 1);
      var p = Math.pow(10, Math.max(0, Math.floor(Math.log10(v)) - 1));
      return Math.round(v / p) * p;
    },

    todayKey: function (date) {
      var dt = date instanceof Date ? date : new Date(finite(date) ? date : this.now());
      return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
    },

    /* whole days from key a to key b ('2026-01-31', '2026-02-02' → 2); NaN if invalid */
    dayDiff: function (a, b) {
      if (!dateKey(a) || !dateKey(b)) return NaN;
      var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
      return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
    }
  };

  SE.State = State;
  SE.Boosts = Boosts;
})(typeof window !== 'undefined' ? window : globalThis);
