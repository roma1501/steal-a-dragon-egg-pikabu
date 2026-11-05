/* =========================================================================
   Steal a Dragon Egg — dragon content data (SE.DragonData)

   Pure data + pure helpers, no THREE, no DOM. Loaded after i18n.js (registers
   its strings with SE.I18N.add). Numbers are tuned and documented in
   docs/BALANCE.md (verified by `node tools/balance-sim.mjs`); SPEC §3 tables
   mirror them.

   SPECIES[i]  (index = lair index)
     { id, idx, rarity, emoji, color, color2, accent,
       hatch            seconds to hatch a Normal egg
       income           coins / second of a Normal baby (equipped)
       unlockPrice      lair gate price ($)
       dragonSpeed      guardian chase speed (u/s, before abilities)
       drakeSpeed       drake chase speed (u/s) — hint for SE.DragonAI
       recommendedSpeed speed stat shown on the lair sign (≈ 90 % escape rate)
       gems             gems per delivered egg
       drakes, nests, wakeDelay (s), abilities:[…],
       nestRespawn      seconds until a robbed nest shows a new egg — hint for SE.Game
       ambience:{ sky, skyTop, fog, fogNear, fogFar, sun, sunIntensity, hemiSky,
                  hemiGround, exposure, particles, ground, wall, wallCap, path } }
   VARIANTS[v] { id, idx, mult, chance (%), hatchMult, color, color2 }
   RARITIES    { common:{ id, color, key, order }, uncommon, rare, epic, legendary }
   ABILITIES   { dash:{ id, key, emoji }, frostBreath, fireball, fly }
   BASE_AMBIENCE  ambience of the base / passage (same shape as species ambience)

   species(id|idx) -> def|null ; variant(idx) -> def|null ; speciesIndex(id) -> i|-1
   isSpecies(id), isVariant(v)
   name(speciesId) / eggName(speciesId) / lairName(speciesId) / desc(speciesId)
   variantName(v[, 'egg']) / rarity(r) / rarityName(r) / rarityColor(r) / abilityName(a) / abilityDesc(a)
                                             (r = rarity id or species id/idx)
   fullName(speciesId, v) / fullEggName(speciesId, v)    ('Golden Meadow Dragon'; Normal omitted)
   rollVariant(luck = 1[, rng]) -> idx      luck multiplies the weights of variants ≥ 1
                                             (luckyEgg boost → luck 2)
   makeEgg(speciesId, luck[, rng]) -> { species, variant, uid }
   hatchTime(egg) -> seconds                 species.hatch × variant.hatchMult (rounded)
   income(species, variant) -> coins/s       species.income × variant.mult
   value(species, variant) -> sell price     income × 60
   deliveryCash(egg) -> number               round(income × 25 + 50)
   deliveryGems(egg) -> number               species.gems (+1 per variant step)
   indexKey(species, variant) -> 'meadow:0'; parseIndexKey(key) -> {species, variant}|null
   allIndexKeys() -> 30 keys
   newUid(prefix) -> unique string id
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};

  /* ---------------------------------------------------------------------- */
  /* Balance table (keep in sync with docs/SPEC.md §3.1 and docs/BALANCE.md) */
  /* ---------------------------------------------------------------------- */
  /*  id          rarity       hatch income  unlockPrice  dSpd drk  rec  gems drakes nests wake  respawn abilities */
  var TABLE = [
    ['meadow',   'common',     20,   3,      0,           18,  15,   0,   3,   0,     4,    2.2,  10,  []],
    ['mosswood', 'uncommon',   40,   18,     7000,        20,  17,   45,  3,   1,     4,    1.8,  12,  ['dash']],
    ['amber',    'rare',       75,   110,    300000,      28,  24,   100, 4,   2,     5,    1.5,  14,  ['dash']],
    ['frost',    'epic',       120,  650,    5000000,     50,  43,   170, 5,   2,     5,    1.2,  16,  ['frostBreath']],
    ['ember',    'epic',       160,  3800,   200000000,   72,  61,   260, 6,   3,     5,    1.0,  18,  ['fireball']],
    ['aurora',   'legendary',  220,  25000,  6000000000,  102, 87,   370, 7,   3,     6,    0.7,  20,  ['fly', 'dash']]
  ];

  var LOOK = {
    meadow:   { emoji: '🌿', color: '#7cc243', color2: '#f0e2b6', accent: '#3f8a25' },
    mosswood: { emoji: '🍄', color: '#2f7d4a', color2: '#7a5230', accent: '#3fd6d0' },
    amber:    { emoji: '🏜️', color: '#e8a52a', color2: '#5b3a22', accent: '#f07a1a' },
    frost:    { emoji: '❄️', color: '#bfe3ff', color2: '#2f6fd6', accent: '#ffffff' },
    ember:    { emoji: '🔥', color: '#2a2526', color2: '#ff6a1a', accent: '#c8261a' },
    aurora:   { emoji: '✨', color: '#f6f2ea', color2: '#1f3a9a', accent: '#e8b830' }
  };

  /* Atmosphere hints per biome (SE.World.atmosphereAt blends them by player z). */
  var AMBIENCE = {
    meadow: {
      skyTop: '#4aa6f0', sky: '#a6dcff', fog: '#cfeeff', fogNear: 140, fogFar: 640,
      sun: '#fff3d6', sunIntensity: 1.0, hemiSky: '#d6ecff', hemiGround: '#5f8f3a', exposure: 1.05,
      particles: 'amb_leaves', ground: '#7cc243', wall: '#c98a4b', wallCap: '#5cb83a', path: '#efe2b8'
    },
    mosswood: {
      skyTop: '#3f8f86', sky: '#b4e2cc', fog: '#a6d2b8', fogNear: 110, fogFar: 520,
      sun: '#ffe9b8', sunIntensity: 0.85, hemiSky: '#c4ead4', hemiGround: '#2f5a2a', exposure: 1.05,
      particles: 'amb_fireflies', ground: '#3f8a3a', wall: '#7d6b3c', wallCap: '#3f9a3a', path: '#cbbb8c'
    },
    amber: {
      skyTop: '#f0a24a', sky: '#ffe0a8', fog: '#f6d8a2', fogNear: 130, fogFar: 600,
      sun: '#ffd890', sunIntensity: 1.15, hemiSky: '#ffe8bc', hemiGround: '#b07a30', exposure: 1.0,
      particles: 'amb_sand', ground: '#e8b85a', wall: '#d4a050', wallCap: '#b9a648', path: '#f5e2b0'
    },
    frost: {
      skyTop: '#6fb0ee', sky: '#dcefff', fog: '#e2f1ff', fogNear: 120, fogFar: 560,
      sun: '#eaf4ff', sunIntensity: 0.95, hemiSky: '#eaf6ff', hemiGround: '#8fb0d0', exposure: 1.0,
      particles: 'amb_snow', ground: '#dff2ff', wall: '#a8cce8', wallCap: '#ffffff', path: '#f5fbff'
    },
    ember: {
      skyTop: '#4a2224', sky: '#ff9a6a', fog: '#8a4030', fogNear: 90, fogFar: 460,
      sun: '#ffb070', sunIntensity: 0.9, hemiSky: '#ff9a6a', hemiGround: '#2a1a1a', exposure: 1.1,
      particles: 'amb_embers', ground: '#3a3030', wall: '#2f2a2a', wallCap: '#c84a1a', path: '#5a4a40'
    },
    aurora: {
      skyTop: '#33358f', sky: '#dcd4ff', fog: '#e8e0ff', fogNear: 130, fogFar: 620,
      sun: '#fff2c0', sunIntensity: 1.1, hemiSky: '#f0eaff', hemiGround: '#8a7ab0', exposure: 1.1,
      particles: 'amb_stars', ground: '#f2eee6', wall: '#efe6d0', wallCap: '#e0b840', path: '#ffffff'
    }
  };

  var BASE_AMBIENCE = {
    skyTop: '#4aa6f0', sky: '#a6dcff', fog: '#cfeeff', fogNear: 160, fogFar: 700,
    sun: '#fff3d6', sunIntensity: 1.05, hemiSky: '#d6ecff', hemiGround: '#6a9a40', exposure: 1.05,
    particles: null, ground: '#6cc04a', wall: '#c98a4b', wallCap: '#5cb83a', path: '#efe2b8'
  };

  /* Variants (mutations). hatchMult: rarer shells take a little longer to hatch. */
  var VARIANTS = [
    { id: 'normal',  idx: 0, mult: 1,   chance: 72,  hatchMult: 1,    color: '#d9d9d9', color2: '#9a9a9a' },
    { id: 'golden',  idx: 1, mult: 2.5, chance: 18,  hatchMult: 1.1,  color: '#ffc928', color2: '#c98a00' },
    { id: 'crystal', idx: 2, mult: 6,   chance: 7,   hatchMult: 1.25, color: '#6fe8ff', color2: '#2aa8d8' },
    { id: 'rainbow', idx: 3, mult: 15,  chance: 2.6, hatchMult: 1.5,  color: '#ff6ad5', color2: '#6a8aff' },
    { id: 'galaxy',  idx: 4, mult: 40,  chance: 0.4, hatchMult: 2,    color: '#7a4dff', color2: '#1a1240' }
  ];

  var RARITIES = {
    common:    { id: 'common',    color: '#4f9a2a', key: 'rarity.common',    order: 0 },
    uncommon:  { id: 'uncommon',  color: '#2f8a4a', key: 'rarity.uncommon',  order: 1 },
    rare:      { id: 'rare',      color: '#d0781a', key: 'rarity.rare',      order: 2 },
    epic:      { id: 'epic',      color: '#7b3fd0', key: 'rarity.epic',      order: 3 },
    legendary: { id: 'legendary', color: '#e0a400', key: 'rarity.legendary', order: 4 }
  };

  var ABILITIES = {
    dash:        { id: 'dash',        key: 'ability.dash',        emoji: '💨' },
    frostBreath: { id: 'frostBreath', key: 'ability.frostBreath', emoji: '❄️' },
    fireball:    { id: 'fireball',    key: 'ability.fireball',    emoji: '☄️' },
    fly:         { id: 'fly',         key: 'ability.fly',         emoji: '☁️' }
  };

  var SPECIES = TABLE.map(function (row, i) {
    var look = LOOK[row[0]];
    return {
      id: row[0],
      idx: i,
      rarity: row[1],
      emoji: look.emoji,
      color: look.color,
      color2: look.color2,
      accent: look.accent,
      hatch: row[2],
      income: row[3],
      unlockPrice: row[4],
      dragonSpeed: row[5],
      drakeSpeed: row[6],
      recommendedSpeed: row[7],
      gems: row[8],
      drakes: row[9],
      nests: row[10],
      wakeDelay: row[11],
      nestRespawn: row[12],
      abilities: row[13].slice(),
      ambience: AMBIENCE[row[0]]
    };
  });

  var BY_ID = {};
  SPECIES.forEach(function (s) { BY_ID[s.id] = s; });

  var uidCounter = 0;

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function tr(key) { return SE.t ? SE.t(key) : key; }

  function speciesOf(x) {
    if (typeof x === 'number') return x % 1 === 0 && x >= 0 && x < SPECIES.length ? SPECIES[x] : null;
    if (typeof x === 'string' && hasOwn(BY_ID, x)) return BY_ID[x];
    if (x && typeof x === 'object' && typeof x.id === 'string' && hasOwn(BY_ID, x.id)) return BY_ID[x.id];
    return null;
  }

  function variantOf(v) {
    if (v && typeof v === 'object' && typeof v.idx === 'number') v = v.idx;
    return typeof v === 'number' && v % 1 === 0 && v >= 0 && v < VARIANTS.length ? VARIANTS[v] : null;
  }

  var DragonData = {
    SPECIES: SPECIES,
    VARIANTS: VARIANTS,
    RARITIES: RARITIES,
    ABILITIES: ABILITIES,
    BASE_AMBIENCE: BASE_AMBIENCE,
    SELL_SECONDS: 60,          /* value = income × 60 */
    DELIVERY_SECONDS: 25,      /* deliveryCash = income × 25 + 50 */
    DELIVERY_BASE: 50,

    species: function (x) { return speciesOf(x); },
    variant: function (v) { return variantOf(v); },
    speciesIndex: function (id) { var s = speciesOf(id); return s ? s.idx : -1; },
    isSpecies: function (id) { return typeof id === 'string' && hasOwn(BY_ID, id); },
    isVariant: function (v) { return !!variantOf(typeof v === 'number' ? v : NaN); },

    /* ---------------- localized names ---------------- */
    name: function (id) { var s = speciesOf(id); return s ? tr('dragon.' + s.id + '.name') : ''; },
    eggName: function (id) { var s = speciesOf(id); return s ? tr('dragon.' + s.id + '.egg') : ''; },
    lairName: function (id) { var s = speciesOf(id); return s ? tr('dragon.' + s.id + '.lair') : ''; },
    desc: function (id) { var s = speciesOf(id); return s ? tr('dragon.' + s.id + '.desc') : ''; },
    variantName: function (v, form) {
      var d = variantOf(v);
      if (!d) return '';
      return tr('variant.' + d.id + (form === 'egg' ? '.egg' : ''));
    },
    /* r = rarity id ('epic') or a species (id / idx / def) */
    rarity: function (r) {
      if (typeof r === 'string' && hasOwn(RARITIES, r)) return RARITIES[r];
      var s = speciesOf(r);
      return s ? RARITIES[s.rarity] : null;
    },
    rarityName: function (r) { var d = this.rarity(r); return d ? tr(d.key) : ''; },
    rarityColor: function (r) { var d = this.rarity(r); return d ? d.color : '#888888'; },
    abilityName: function (a) { return ABILITIES[a] ? tr(ABILITIES[a].key) : ''; },
    abilityDesc: function (a) { return ABILITIES[a] ? tr(ABILITIES[a].key + '.desc') : ''; },
    fullName: function (id, v) {
      var s = speciesOf(id), d = variantOf(v);
      if (!s) return '';
      if (!d || d.idx === 0) return this.name(s.id);
      return SE.t ? SE.t('dragon.fullName', this.variantName(d.idx), this.name(s.id)) : d.id + ' ' + s.id;
    },
    fullEggName: function (id, v) {
      var s = speciesOf(id), d = variantOf(v);
      if (!s) return '';
      if (!d || d.idx === 0) return this.eggName(s.id);
      return SE.t ? SE.t('dragon.fullEggName', this.variantName(d.idx, 'egg'), this.eggName(s.id)) : d.id + ' ' + s.id;
    },

    /* ---------------- rolls ---------------- */
    rollVariant: function (luck, rng) {
      luck = typeof luck === 'number' && isFinite(luck) && luck > 0 ? luck : 1;
      rng = typeof rng === 'function' ? rng : Math.random;
      var total = 0, w = [];
      for (var i = 0; i < VARIANTS.length; i++) {
        var weight = VARIANTS[i].chance * (i >= 1 ? luck : 1);
        w.push(weight);
        total += weight;
      }
      var r = rng() * total;
      for (var j = 0; j < w.length; j++) {
        if (r < w[j]) return j;
        r -= w[j];
      }
      return 0;
    },

    newUid: function (prefix) {
      uidCounter = (uidCounter + 1) % 1679616;
      return (prefix || 'u') + Date.now().toString(36) + uidCounter.toString(36) +
        Math.floor(Math.random() * 46656).toString(36);
    },

    makeEgg: function (speciesId, luck, rng) {
      var s = speciesOf(speciesId) || SPECIES[0];
      return { species: s.id, variant: this.rollVariant(luck, rng), uid: this.newUid('e') };
    },

    /* ---------------- numbers ---------------- */
    hatchTime: function (egg) {
      var s = egg && speciesOf(egg.species);
      if (!s) return SPECIES[0].hatch;
      var d = variantOf(egg.variant) || VARIANTS[0];
      return Math.round(s.hatch * d.hatchMult);
    },

    income: function (species, variant) {
      var s = speciesOf(species);
      if (!s) return 0;
      var d = variantOf(variant) || VARIANTS[0];
      return s.income * d.mult;
    },

    value: function (species, variant) {
      return Math.round(this.income(species, variant) * this.SELL_SECONDS);
    },

    deliveryCash: function (egg) {
      if (!egg || !speciesOf(egg.species)) return 0;
      return Math.round(this.income(egg.species, egg.variant) * this.DELIVERY_SECONDS + this.DELIVERY_BASE);
    },

    deliveryGems: function (egg) {
      var s = egg && speciesOf(egg.species);
      if (!s) return 0;
      var d = variantOf(egg.variant) || VARIANTS[0];
      return s.gems + d.idx;
    },

    /* ---------------- Dragon Index ---------------- */
    indexKey: function (species, variant) {
      var s = speciesOf(species), d = variantOf(variant);
      return s && d ? s.id + ':' + d.idx : '';
    },

    parseIndexKey: function (key) {
      if (typeof key !== 'string') return null;
      var m = /^([a-z]+):(\d)$/.exec(key);
      if (!m || !hasOwn(BY_ID, m[1]) || !variantOf(Number(m[2]))) return null;
      return { species: m[1], variant: Number(m[2]) };
    },

    allIndexKeys: function () {
      var out = [];
      for (var i = 0; i < SPECIES.length; i++) {
        for (var v = 0; v < VARIANTS.length; v++) out.push(SPECIES[i].id + ':' + v);
      }
      return out;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Strings                                                                 */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: {
        'dragon.meadow.name': 'Луговой дракон',
        'dragon.mosswood.name': 'Мшистый дракон',
        'dragon.amber.name': 'Янтарный дракон',
        'dragon.frost.name': 'Морозный дракон',
        'dragon.ember.name': 'Огненный дракон',
        'dragon.aurora.name': 'Дракон Авроры',
        'dragon.meadow.egg': 'Луговое яйцо',
        'dragon.mosswood.egg': 'Мшистое яйцо',
        'dragon.amber.egg': 'Янтарное яйцо',
        'dragon.frost.egg': 'Морозное яйцо',
        'dragon.ember.egg': 'Огненное яйцо',
        'dragon.aurora.egg': 'Яйцо Авроры',
        'dragon.meadow.lair': 'Луговое логово',
        'dragon.mosswood.lair': 'Мшистое логово',
        'dragon.amber.lair': 'Янтарное логово',
        'dragon.frost.lair': 'Морозное логово',
        'dragon.ember.lair': 'Огненное логово',
        'dragon.aurora.lair': 'Логово Авроры',
        'dragon.meadow.desc': 'Добродушный дракон цветущих лугов. Спит крепко и бегает не спеша — идеальная первая добыча.',
        'dragon.mosswood.desc': 'Хранитель древнего леса: рога-ветви, мох на спине и светящиеся грибы. Умеет делать рывки.',
        'dragon.amber.desc': 'Житель Янтарных дюн в золотых каменных пластинах. Быстрый, упрямый и тоже любит рывки.',
        'dragon.frost.desc': 'Ледяной клык с хрустальными шипами. Его дыхание замораживает — не подпускай его близко!',
        'dragon.ember.desc': 'Обсидиановый великан с лавой в трещинах. Мечет огненные шары — уходи из красного круга!',
        'dragon.aurora.desc': 'Легендарный небесный дракон с золотым нимбом. Перелетает любые преграды и спит очень чутко.',
        'dragon.fullName': '{0} {1}',
        'dragon.fullEggName': '{0} {1}',

        'rarity.common': 'Простой',
        'rarity.uncommon': 'Необычный',
        'rarity.rare': 'Редкий',
        'rarity.epic': 'Эпический',
        'rarity.legendary': 'Легендарный',

        'variant.normal': 'Обычный',
        'variant.golden': 'Золотой',
        'variant.crystal': 'Кристальный',
        'variant.rainbow': 'Радужный',
        'variant.galaxy': 'Галактический',
        'variant.normal.egg': 'Обычное',
        'variant.golden.egg': 'Золотое',
        'variant.crystal.egg': 'Кристальное',
        'variant.rainbow.egg': 'Радужное',
        'variant.galaxy.egg': 'Галактическое',

        'ability.dash': 'Рывок',
        'ability.frostBreath': 'Ледяное дыхание',
        'ability.fireball': 'Огненный шар',
        'ability.fly': 'Полёт',
        'ability.dash.desc': 'Время от времени резко ускоряется.',
        'ability.frostBreath.desc': 'Дыхание вблизи замедляет тебя.',
        'ability.fireball.desc': 'Бросает огненные шары туда, куда ты бежишь.',
        'ability.fly.desc': 'Летит над препятствиями.'
      },
      en: {
        'dragon.meadow.name': 'Meadow Dragon',
        'dragon.mosswood.name': 'Mosswood Dragon',
        'dragon.amber.name': 'Amber Dragon',
        'dragon.frost.name': 'Frostfang Dragon',
        'dragon.ember.name': 'Embermaw Dragon',
        'dragon.aurora.name': 'Aurora Dragon',
        'dragon.meadow.egg': 'Meadow Egg',
        'dragon.mosswood.egg': 'Mosswood Egg',
        'dragon.amber.egg': 'Amber Egg',
        'dragon.frost.egg': 'Frost Egg',
        'dragon.ember.egg': 'Ember Egg',
        'dragon.aurora.egg': 'Aurora Egg',
        'dragon.meadow.lair': 'Meadow Lair',
        'dragon.mosswood.lair': 'Mosswood Lair',
        'dragon.amber.lair': 'Amber Lair',
        'dragon.frost.lair': 'Frost Lair',
        'dragon.ember.lair': 'Ember Lair',
        'dragon.aurora.lair': 'Aurora Lair',
        'dragon.meadow.desc': 'A good-natured dragon of the blooming meadows. Sleeps soundly and runs slowly — the perfect first catch.',
        'dragon.mosswood.desc': 'Keeper of the ancient forest: branch antlers, a mossy back and glowing mushrooms. It can dash.',
        'dragon.amber.desc': 'A dweller of the Amber Dunes, armoured in golden rock plates. Fast, stubborn and fond of dashing.',
        'dragon.frost.desc': 'Frostfang, covered in crystal spikes. Its breath freezes — don\'t let it get close!',
        'dragon.ember.desc': 'An obsidian giant with lava in its cracks. It hurls fireballs — get out of the red circle!',
        'dragon.aurora.desc': 'The legendary sky dragon with a golden halo. It flies over any obstacle and sleeps very lightly.',
        'dragon.fullName': '{0} {1}',
        'dragon.fullEggName': '{0} {1}',

        'rarity.common': 'Common',
        'rarity.uncommon': 'Uncommon',
        'rarity.rare': 'Rare',
        'rarity.epic': 'Epic',
        'rarity.legendary': 'Legendary',

        'variant.normal': 'Normal',
        'variant.golden': 'Golden',
        'variant.crystal': 'Crystal',
        'variant.rainbow': 'Rainbow',
        'variant.galaxy': 'Galaxy',
        'variant.normal.egg': 'Normal',
        'variant.golden.egg': 'Golden',
        'variant.crystal.egg': 'Crystal',
        'variant.rainbow.egg': 'Rainbow',
        'variant.galaxy.egg': 'Galaxy',

        'ability.dash': 'Dash',
        'ability.frostBreath': 'Frost Breath',
        'ability.fireball': 'Fireball',
        'ability.fly': 'Flight',
        'ability.dash.desc': 'Bursts forward from time to time.',
        'ability.frostBreath.desc': 'Its breath slows you down up close.',
        'ability.fireball.desc': 'Throws fireballs where you are running.',
        'ability.fly.desc': 'Flies over obstacles.'
      },
      tr: {
        'dragon.meadow.name': 'Çayır Ejderhası',
        'dragon.mosswood.name': 'Yosun Ejderhası',
        'dragon.amber.name': 'Kehribar Ejderhası',
        'dragon.frost.name': 'Buz Ejderhası',
        'dragon.ember.name': 'Kor Ejderhası',
        'dragon.aurora.name': 'Aurora Ejderhası',
        'dragon.meadow.egg': 'Çayır Yumurtası',
        'dragon.mosswood.egg': 'Yosun Yumurtası',
        'dragon.amber.egg': 'Kehribar Yumurtası',
        'dragon.frost.egg': 'Buz Yumurtası',
        'dragon.ember.egg': 'Kor Yumurtası',
        'dragon.aurora.egg': 'Aurora Yumurtası',
        'dragon.meadow.lair': 'Çayır İni',
        'dragon.mosswood.lair': 'Yosun İni',
        'dragon.amber.lair': 'Kehribar İni',
        'dragon.frost.lair': 'Buz İni',
        'dragon.ember.lair': 'Kor İni',
        'dragon.aurora.lair': 'Aurora İni',
        'dragon.meadow.desc': 'Çiçekli çayırların iyi huylu ejderhası. Derin uyur, yavaş koşar — ilk av için ideal.',
        'dragon.mosswood.desc': 'Kadim ormanın bekçisi: dal boynuzlar, yosunlu sırt ve parlayan mantarlar. Atılma yapabilir.',
        'dragon.amber.desc': 'Kehribar Kumulları\'nın altın kaya plakalarla zırhlı sakini. Hızlı, inatçı ve atılmayı sever.',
        'dragon.frost.desc': 'Kristal dikenlerle kaplı buz dişli ejderha. Nefesi dondurur — yaklaşmasına izin verme!',
        'dragon.ember.desc': 'Çatlaklarında lav akan obsidyen dev. Ateş topları fırlatır — kırmızı daireden çık!',
        'dragon.aurora.desc': 'Altın haleli efsanevi gök ejderhası. Her engelin üzerinden uçar ve çok hafif uyur.',
        'dragon.fullName': '{0} {1}',
        'dragon.fullEggName': '{0} {1}',

        'rarity.common': 'Yaygın',
        'rarity.uncommon': 'Sıra Dışı',
        'rarity.rare': 'Nadir',
        'rarity.epic': 'Destansı',
        'rarity.legendary': 'Efsanevi',

        'variant.normal': 'Normal',
        'variant.golden': 'Altın',
        'variant.crystal': 'Kristal',
        'variant.rainbow': 'Gökkuşağı',
        'variant.galaxy': 'Galaksi',
        'variant.normal.egg': 'Normal',
        'variant.golden.egg': 'Altın',
        'variant.crystal.egg': 'Kristal',
        'variant.rainbow.egg': 'Gökkuşağı',
        'variant.galaxy.egg': 'Galaksi',

        'ability.dash': 'Atılma',
        'ability.frostBreath': 'Buz Nefesi',
        'ability.fireball': 'Ateş Topu',
        'ability.fly': 'Uçuş',
        'ability.dash.desc': 'Zaman zaman ileri atılır.',
        'ability.frostBreath.desc': 'Yakından nefesi seni yavaşlatır.',
        'ability.fireball.desc': 'Koştuğun yere ateş topları atar.',
        'ability.fly.desc': 'Engellerin üzerinden uçar.'
      }
    });
  }

  SE.DragonData = DragonData;
})(typeof window !== 'undefined' ? window : globalThis);
