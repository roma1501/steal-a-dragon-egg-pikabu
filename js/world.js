/* =========================================================================
   Steal a Dragon Egg — the world: linear dragon valley (SE.World, SPEC §4)

   North = −Z. The player's base (safe zone) is at the south end; six lairs
   follow one another along a straight valley. Everything (visuals + logic) is
   built from the LAYOUT block below — no magic numbers elsewhere.

   API
     registerAssets()                      optional Kenney GLBs + prop.gift_chest → SE.Assets.add(key,url,{optional:true}); before loadAll
     build(scene, state[, { renderer, quality:'high'|'medium'|'low' }])   sync; assumes SE.Assets loaded
     update(dt, time, playerPos)           animations, section culling, sun follow, atmosphere, nest respawn,
                                           state sync (hatchery locks/banners, lair gates, upgrade sign, gift chest) every 0.5 s
     spawn (Vector3), spawnYaw, safeLineZ, inSafeZone(x, z)
     hatcheries[i] = { index, x, z, group, content, stateLabel, lockLabel, sign, banner, entry:{x,z}, locked }
         content: Group at the hatchery egg spot (the game adds egg / baby models there)
         stateLabel: Sprite, stateLabel.userData.setText(text[, color]) ('' hides it)
         lockLabel: { mesh, setText } price board shown while locked
     setHatcheryBanner(i, speciesId|null), setHatcheryLocked(i, locked), setHatcheryLabel(i, text[, color])
     lairs[i] = { index, species, x, z, zMin, zMax, halfWidth, gate:{x,z,collider,group,portcullis}, nests:[nest],
                  greatNest:{x,z,y,r}, guardianSpawn:{x,z,yaw,y}, drakeSpawns:[{x,z}], patrol:[{x,z}], unlocked, recommendedSpeed,
                  trial, gateOpen }
         greatNest: off the centre line (x = ±33 alternating, z = zMin + 24) so the guardian never hides the next gate;
         y = sleeping height on the nest floor (SE.DragonAI reads greatNest.y), r = rim radius; guardian faces the room
     nests[k]  = { index, lair (lair index), lairRef, x, z, taken, respawn, eggMesh, eggRig, species }
     setNestTaken(nest, taken[, respawnSecs])   taken → egg hidden; if respawnSecs > 0 (or nest.respawn set by the
                                           game later) the world counts it down and shows a new egg (onNestRespawn(nest))
     interactables = [{ type, x, z, r, hint, hintMobile, …payload }]   hint/hintMobile are localized getters
         types: nest{nest,lairIndex} hatchery{index} sell shop wheel gift index treadmill{passive:true,treadmill}
                upgrade lairGate{lairIndex} (lairGate entries exist only while the lair is locked)
     treadmills = [{ x, z, r, w, d }] (belt rectangle w × d, player runs north); upgradeSign = { x, z, setText(levelText, priceText) }
     botPlots[b] = { index, x, z, entry:{x,z}, content, label, group, hatcheries:[{x,z,content}], route:[{x,z}], setName(name, color) }
     lairAt(x, z) -> lair|null (includes its gate passage); zoneAt(x, z) -> { key, color, emoji, name, lair }
     atmosphereAt(z) -> { fog, sky, skyTop, sunColor, sunIntensity, hemiSky, hemiGround, exposure, fogNear, fogFar,
                          stars, particles }   (shared scratch object — copy if you keep it)
     updateAtmosphere(z)                   applies atmosphereAt(z) (called by update)
     setLairUnlocked(i, bool[, instant])   portcullis slides down 17 (animated), gate collider disabled
     setLairTrial(i, bool)                 trial raid: opens lair i's gate (portcullis slides open, collider off, no unlock prompt)
                                           regardless of SE.State; the 0.5 s state sync respects it; false closes the gate
                                           again unless the lair is really unlocked. lairs[i].trial / .gateOpen / .unlocked (real)
     gift = { chest:{group,model,lid,gem,glow}, marker, beam, sign, ready }   daily gift chest (prop.gift_chest): when
                                           SE.Daily.canClaim() the lid is ajar with light shafts + SE.FX glints/sparkles, the
                                           chest bobs and a red "!" badge floats above; claimed → closed, calm, the sign shows
                                           "next in h:mm:ss" (SE.Daily.timeToNext). syncGift() (0.5 s); giftForce = true|false
                                           overrides SE.Daily (labs / QA).
     setGuideTarget(x, z | null)           pulsing beacon + yellow arrows from the player along the valley
     refreshLabels()                       re-draw every localized sign (after a language change)
     addBox(cx, cz, w, d, topY, { solid, id, noCamera, walkable, platform }) -> collider; nearColliders(x, z); colliders; grid
     reserve(x0, z0, x1, z1, kind), reserveR(x, z, r, kind), isClear(x, z, r), keepOut   decor clearance: every fence, pen,
                                           sign, stall, lantern, path, wall, nest, gate … reserves its footprint; decor is only
                                           placed where its own radius (tree crown, bush, rock) is clear (other modules placing
                                           props in the world can use isClear / reserve too)
     navPoints = [{ x, z, section, lair }]  valley centre line, south → north
     sun (DirectionalLight, follows the player), hemi (HemisphereLight), envMap (PMREM texture from the sky or null)
     sectionAt(z) -> 0 (base) | 1+i (lair i incl. its passage); setCulling(bool); stats() -> per-section mesh/tris counts
     onNestRespawn (callback, optional)
   Ground: one continuous world-space stud grid (1 stud = 1.4, E.groundPlane / E.worldBox); base grounds never overlap,
   overlays use polygonOffset layers (pads 1, paths 2, decals 3) → no z-fighting. Signs: text is measured and fitted
   inside the board padding (E.outlinedText / E.iconText; icons beside the text), checked in ru / en / tr.
   Camera far plane: the sky dome writes depth at the far plane, any camera.far works (≥ 700 recommended for fog).
   ========================================================================= */
(function (global) {
  'use strict';
  const SE = global.SE = global.SE || {};
  const T = global.THREE;
  const PI = Math.PI;

  /* ====================================================================== */
  /* LAYOUT — every logic point of the map                                   */
  /* ====================================================================== */
  const WALL_H = 26, WALL_T = 4;
  const PASS_W = 36, PASS_L = 40, LAIR_W = 120, LAIR_L = 150;
  const LAIR0_ZMAX = -70;
  const SUN_I = 1.2, HEMI_I = 0.55;
  const face = function (x, z, tx, tz) { return Math.atan2(tx - x, tz - z); };   // yaw so local +Z looks at (tx,tz)

  const LAYOUT = {
    wallH: WALL_H, wallT: WALL_T, passW: PASS_W, passL: PASS_L, lairW: LAIR_W, lairL: LAIR_L,
    base: { xMin: -166, xMax: 166, zMin: -30, zMax: 112, lawnHalf: 34 },
    spawn: { x: 0, z: 56, yaw: PI },
    safeLineZ: -27,
    baseGate: { x: 0, z: -31 },
    penSize: 22, penGap: 8,
    pens: [ // hatchery pens (index order = hatchery index); open: +1 opening faces +X (lawn side)
      { x: -46, z: -6, open: 1 }, { x: 46, z: -6, open: -1 },
      { x: -46, z: 18, open: 1 }, { x: 46, z: 18, open: -1 },
      { x: -46, z: 42, open: 1 }, { x: 46, z: 42, open: -1 },
      { x: -46, z: 66, open: 1 }, { x: 46, z: 66, open: -1 }
    ],
    path: { halfW: 4, zFrom: -31, zTo: 80 },
    plaza: { x: 0, z: 92, r: 15 },
    sell: { x: -24, z: 93, ry: face(-24, 93, 0, 74) },
    shop: { x: 24, z: 93, ry: face(24, 93, 0, 74) },
    wheel: { x: 0, z: 104, ry: PI },
    gift: { x: 19, z: 28, ry: -PI / 2 },
    index: { x: -19, z: 28, ry: PI / 2 },
    fountain: { x: -46, z: 96 },
    train: { treadmills: [{ x: 41, z: 98 }, { x: 53, z: 98 }], upgradeSign: { x: 47, z: 86, ry: 0 }, sign: { x: 47, z: 108.5 } },
    signs: { ahead: { x: 16, z: -17, ry: -0.4 }, motto: { x: -16, z: 77, ry: 0.5 } },   // clear of the path lanterns (x ±7)
    botPlots: [
      { x: -92, z: 34, color: '#e8463a' }, { x: -136, z: 34, color: '#3a8aff' },
      { x: 92, z: 34, color: '#ffc928' }, { x: 136, z: 34, color: '#9a4ae0' }
    ],
    botPlotSize: { w: 38, d: 56, gap: 10 },
    botStripZ: -21,
    lairs: [],
    // nest slots relative to the lair centre (x, z offset; +z = south = entrance side)
    nestSlots: {
      4: [[-30, 34], [30, 34], [-37, -6], [37, -6]],
      5: [[-30, 38], [30, 38], [-38, 4], [38, 4], [27, -30]],
      6: [[-30, 40], [30, 40], [-38, 6], [38, 6], [-28, -30], [28, -30]]
    },
    // great nest: off the centre line (alternating sides) so the guardian never hides the next gate and its signs;
    // x = ±greatNest.dx, z = zMin + greatNest.dz; scale = prop scale (floor radius ≈ 5.2·scale, rim ≈ 8.4·scale)
    greatNest: { dx: 33, dz: 24, scale: 1.75, scaleY: 1.3 },
    drakeSlots: [[-17, -20], [17, -20], [0, 14]],
    patrolSlots: [[-44, 52], [-10, 20], [44, 52], [46, -12], [16, -38], [-16, -38], [-46, -12]],
    outerX: 64,                // inner face of the lair side walls is at |x| = 60, outer at 64
    lairPathHalf: 4.2          // centre path half width = 3 studs (path edges sit on the stud grid)
  };
  (function buildLairLayout() {
    const DD = SE.DragonData;
    for (let i = 0; i < 6; i++) {
      const zMax = LAIR0_ZMAX - i * (PASS_L + LAIR_L), zMin = zMax - LAIR_L, zc = (zMin + zMax) / 2;
      const sp = DD ? DD.SPECIES[i] : null;
      const nN = sp ? sp.nests : 4 + (i > 1 ? 1 : 0) + (i > 4 ? 1 : 0);
      LAYOUT.lairs.push({
        index: i, zMax: zMax, zMin: zMin, zc: zc, passZ0: zMax + PASS_L, gateZ: zMax + 8,
        nests: (LAYOUT.nestSlots[nN] || LAYOUT.nestSlots[4]).map(function (s) { return { x: s[0], z: zc + s[1] }; }),
        greatNest: { x: (i % 2 ? -1 : 1) * LAYOUT.greatNest.dx, z: zMin + LAYOUT.greatNest.dz, r: 8.4 * LAYOUT.greatNest.scale },
        drakes: LAYOUT.drakeSlots.slice(0, Math.max(1, sp ? sp.drakes : 1)).map(function (s) { return { x: s[0], z: zc + s[1] }; }),
        patrol: LAYOUT.patrolSlots.map(function (s) { return { x: s[0], z: zc + s[1] }; }),
        recSign: { x: -12.5, z: zMax + 19, ry: 0.45 }
      });
    }
  })();

  const BIOMES = ['meadow', 'mosswood', 'amber', 'frost', 'ember', 'aurora'];
  const ZONE_META = { base: { color: '#5cb83a', emoji: '🏠' }, valley: { color: '#c98a4b', emoji: '🐉' } };

  /* ====================================================================== */
  /* i18n                                                                     */
  /* ====================================================================== */
  if (SE.I18N && SE.I18N.add) SE.I18N.add({
    ru: {
      'world.zone.base': 'Твоя база', 'world.zone.valley': 'Долина драконов',
      'world.sign.base': 'ТВОЯ БАЗА', 'world.sign.hatchery': 'ИНКУБАТОР', 'world.sign.sell': 'ПРОДАЖА',
      'world.sign.shop': 'МАГАЗИН', 'world.sign.wheel': 'КОЛЕСО УДАЧИ', 'world.sign.gift': 'ПОДАРОК ДНЯ',
      'world.sign.index': 'КНИГА ДРАКОНОВ', 'world.sign.train': 'ТРЕНИРОВКА', 'world.sign.ahead': 'Драконы — там! ➜',
      'world.sign.motto': 'Кради · Выводи · Тренируйся!', 'world.upgrade.title': 'Улучшение',
      'world.upgrade.level': 'Уровень {0} → Уровень {1}', 'world.upgrade.max': 'Макс. уровень', 'world.upgrade.maxPrice': 'МАКС',
      'world.recSpeed': 'рекомендуется', 'world.locked': 'Закрыто', 'world.ready': 'Готово!', 'world.botBase': 'База {0}',
      'world.hint.nest': 'E — украсть яйцо', 'world.hint.hatchery': 'E — инкубатор', 'world.hint.sell': 'E — продать драконов',
      'world.hint.shop': 'E — магазин', 'world.hint.wheel': 'E — колесо удачи', 'world.hint.gift': 'E — подарок дня',
      'world.hint.index': 'E — книга драконов', 'world.hint.treadmill': 'Бегай на дорожке — растёт скорость',
      'world.hint.upgrade': 'E — улучшить дорожку', 'world.hint.lairGate': 'E — открыть логово',
      'world.hintM.nest': 'Нажми ✋ — украсть яйцо', 'world.hintM.hatchery': 'Нажми ✋ — инкубатор', 'world.hintM.sell': 'Нажми ✋ — продать',
      'world.hintM.shop': 'Нажми ✋ — магазин', 'world.hintM.wheel': 'Нажми ✋ — колесо', 'world.hintM.gift': 'Нажми ✋ — подарок',
      'world.hintM.index': 'Нажми ✋ — книга', 'world.hintM.treadmill': 'Беги на дорожке — растёт скорость',
      'world.hintM.upgrade': 'Нажми ✋ — улучшить', 'world.hintM.lairGate': 'Нажми ✋ — открыть логово',
      'world.gift.ready': 'Забери!', 'world.gift.next': 'Через {0}'
    },
    en: {
      'world.zone.base': 'Your Base', 'world.zone.valley': 'Dragon Valley',
      'world.sign.base': 'YOUR BASE', 'world.sign.hatchery': 'HATCHERY', 'world.sign.sell': 'SELL',
      'world.sign.shop': 'SHOP', 'world.sign.wheel': 'WHEEL OF FORTUNE', 'world.sign.gift': 'DAILY GIFT',
      'world.sign.index': 'DRAGON INDEX', 'world.sign.train': 'TRAIN', 'world.sign.ahead': 'Dragons ahead! ➜',
      'world.sign.motto': 'Steal · Hatch · Train!', 'world.upgrade.title': 'Upgrade',
      'world.upgrade.level': 'Level {0} → Level {1}', 'world.upgrade.max': 'Max level', 'world.upgrade.maxPrice': 'MAX',
      'world.recSpeed': 'recommended', 'world.locked': 'Locked', 'world.ready': 'Ready!', 'world.botBase': "{0}'s base",
      'world.hint.nest': 'E — steal the egg', 'world.hint.hatchery': 'E — hatchery', 'world.hint.sell': 'E — sell dragons',
      'world.hint.shop': 'E — shop', 'world.hint.wheel': 'E — wheel of fortune', 'world.hint.gift': 'E — daily gift',
      'world.hint.index': 'E — dragon index', 'world.hint.treadmill': 'Run on the treadmill to gain speed',
      'world.hint.upgrade': 'E — upgrade the treadmill', 'world.hint.lairGate': 'E — unlock the lair',
      'world.hintM.nest': 'Tap ✋ to steal the egg', 'world.hintM.hatchery': 'Tap ✋ — hatchery', 'world.hintM.sell': 'Tap ✋ to sell',
      'world.hintM.shop': 'Tap ✋ — shop', 'world.hintM.wheel': 'Tap ✋ — wheel', 'world.hintM.gift': 'Tap ✋ — daily gift',
      'world.hintM.index': 'Tap ✋ — dragon index', 'world.hintM.treadmill': 'Run on the treadmill to gain speed',
      'world.hintM.upgrade': 'Tap ✋ to upgrade', 'world.hintM.lairGate': 'Tap ✋ to unlock the lair',
      'world.gift.ready': 'Claim it!', 'world.gift.next': 'Next in {0}'
    },
    tr: {
      'world.zone.base': 'Üssün', 'world.zone.valley': 'Ejderha Vadisi',
      'world.sign.base': 'ÜSSÜN', 'world.sign.hatchery': 'KULUÇKA', 'world.sign.sell': 'SAT',
      'world.sign.shop': 'MAĞAZA', 'world.sign.wheel': 'ŞANS ÇARKI', 'world.sign.gift': 'GÜNLÜK HEDİYE',
      'world.sign.index': 'EJDERHA DİZİNİ', 'world.sign.train': 'ANTRENMAN', 'world.sign.ahead': 'Ejderhalar ileride! ➜',
      'world.sign.motto': 'Çal · Kuluçka · Antrenman!', 'world.upgrade.title': 'Yükselt',
      'world.upgrade.level': 'Seviye {0} → Seviye {1}', 'world.upgrade.max': 'Maks. seviye', 'world.upgrade.maxPrice': 'MAKS',
      'world.recSpeed': 'önerilen', 'world.locked': 'Kilitli', 'world.ready': 'Hazır!', 'world.botBase': '{0} üssü',
      'world.hint.nest': 'E — yumurtayı çal', 'world.hint.hatchery': 'E — kuluçka', 'world.hint.sell': 'E — ejderha sat',
      'world.hint.shop': 'E — mağaza', 'world.hint.wheel': 'E — şans çarkı', 'world.hint.gift': 'E — günlük hediye',
      'world.hint.index': 'E — ejderha dizini', 'world.hint.treadmill': 'Hız kazanmak için koşu bandında koş',
      'world.hint.upgrade': 'E — koşu bandını yükselt', 'world.hint.lairGate': 'E — inin kilidini aç',
      'world.hintM.nest': 'Yumurtayı çalmak için ✋', 'world.hintM.hatchery': '✋ — kuluçka', 'world.hintM.sell': 'Satmak için ✋',
      'world.hintM.shop': '✋ — mağaza', 'world.hintM.wheel': '✋ — çark', 'world.hintM.gift': '✋ — günlük hediye',
      'world.hintM.index': '✋ — ejderha dizini', 'world.hintM.treadmill': 'Hız kazanmak için koşu bandında koş',
      'world.hintM.upgrade': 'Yükseltmek için ✋', 'world.hintM.lairGate': 'İnin kilidini açmak için ✋',
      'world.gift.ready': 'Al!', 'world.gift.next': '{0} sonra'
    }
  });
  const t = function (k) { return SE.t ? SE.t.apply(null, arguments) : k; };
  const money = function (n) { return SE.U && SE.U.money ? SE.U.money(n) : '$' + n; };

  /* ====================================================================== */
  /* Kenney assets                                                            */
  /* ====================================================================== */
  const KENNEY = {
    castle: ['tower-square-base', 'tower-square-mid-windows', 'tower-square-top-roof-high', 'tower-hexagon-base',
      'tower-hexagon-mid', 'tower-hexagon-roof', 'wall', 'wall-pillar', 'flag', 'gate'],
    town: ['lantern', 'banner-green', 'banner-red', 'windmill', 'cart', 'fountain-round-detail'],
    nature: ['flower_redA', 'flower_yellowA', 'flower_purpleA', 'mushroom_redGroup', 'log_large', 'stump_round',
      'rock_largeA', 'rock_tallA', 'cactus_tall', 'statue_column', 'statue_columnDamaged', 'statue_obelisk',
      'grass_large', 'lily_large', 'plant_bushLarge']
  };

  /* ====================================================================== */
  /* helpers                                                                  */
  /* ====================================================================== */
  function hintObj(o) {
    Object.defineProperty(o, 'hint', { enumerable: true, configurable: true, get: function () { return t('world.hint.' + o.type); } });
    Object.defineProperty(o, 'hintMobile', { enumerable: true, configurable: true, get: function () { return t('world.hintM.' + o.type); } });
    return o;
  }
  function species(i) { return SE.DragonData ? SE.DragonData.SPECIES[i] : null; }
  function ambience(i) {
    const DD = SE.DragonData;
    if (!DD) return null;
    return i < 0 ? DD.BASE_AMBIENCE : DD.SPECIES[i].ambience;
  }
  function Section(name) {
    this.name = name; this.group = new T.Group(); this.group.name = name;
    this.batch = new SE.Env.Batch(); this.anim = []; this.visible = true; this.stats = null;
  }
  Section.prototype.stat = function (obj, o) { this.batch.add(obj, o); return obj; };
  Section.prototype.dyn = function (obj) { this.group.add(obj); return obj; };
  Section.prototype.finish = function () {
    const merged = this.batch.build(this.name + ':static');
    this.stats = { meshes: this.batch.stats.meshes, tris: this.batch.stats.tris, sources: this.batch.stats.sources };
    this.group.add(merged);
    freeze(this.group);
  };
  function freeze(root) {
    root.traverse(function (o) { if (!o.userData.dynamic) { o.updateMatrix(); o.matrixAutoUpdate = false; } });
    root.updateMatrixWorld(true);
  }
  function markDynamic(o) { o.traverse(function (c) { c.userData.dynamic = true; }); return o; }

  /* ====================================================================== */
  /* World                                                                    */
  /* ====================================================================== */
  const World = {
    LAYOUT: LAYOUT,
    scene: null, root: null, state: null, quality: 'high',
    colliders: [], grid: {}, cell: 40,
    sections: [], rooms: [], passages: [],
    hatcheries: [], lairs: [], nests: [], interactables: [], botPlots: [], treadmills: [],
    upgradeSign: null, navPoints: [], labels: [],
    spawn: new T.Vector3(LAYOUT.spawn.x, 0, LAYOUT.spawn.z), spawnYaw: LAYOUT.spawn.yaw,
    safeLineZ: LAYOUT.safeLineZ,
    sun: null, hemi: null, envMap: null, sky: null, clouds: null,
    culling: true, curSection: -1, onNestRespawn: null,
    _syncT: 0, _guide: null, _amb: null, _ambKey: null, _ambHandle: null, _time: 0,

    /* ---------------- assets ---------------- */
    registerAssets: function () {
      const A = SE.Assets;
      if (!A || !A.add) return;
      Object.keys(KENNEY).forEach(function (kit) {
        KENNEY[kit].forEach(function (name) {
          A.add('kenney.' + kit + '.' + name, 'assets/models/kenney/' + kit + '/' + name + '.glb', { optional: true });
        });
      });
      // daily gift chest (tools/blender/chest.py): nodes gift_chest > lid (hinge pivot), gem, fx_inner
      A.add('prop.gift_chest', 'assets/models/props/gift_chest.glb', { optional: true });
    },

    /* ---------------- collisions ---------------- */
    addBox: function (cx, cz, w, d, topY, opts) {
      const c = {
        minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2,
        topY: topY === undefined ? 6 : topY,
        solid: !opts || opts.solid !== false, id: opts && opts.id, disabled: false
      };
      if (opts) { if (opts.noCamera) c.noCamera = true; if (opts.walkable) c.walkable = true; if (opts.platform) c.platform = true; }
      this.colliders.push(c);
      const x0 = Math.floor(c.minX / this.cell), x1 = Math.floor(c.maxX / this.cell);
      const z0 = Math.floor(c.minZ / this.cell), z1 = Math.floor(c.maxZ / this.cell);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = x + ',' + z;
        (this.grid[k] = this.grid[k] || []).push(c);
      }
      return c;
    },
    nearColliders: function (x, z) {
      const gx = Math.floor(x / this.cell), gz = Math.floor(z / this.cell);
      const out = [], seen = new Set();
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const arr = this.grid[(gx + i) + ',' + (gz + j)];
        if (arr) for (let k = 0; k < arr.length; k++) if (!seen.has(arr[k])) { seen.add(arr[k]); out.push(arr[k]); }
      }
      return out;
    },

    /* ---------------- decor clearance ---------------- */
    // footprints (AABB on the ground) of everything decor must not grow into: fences, pens, signs, stalls, lanterns,
    // paths, walls, nests, gates … Decor asks isClear(x, z, r) with its own radius (tree crown, bush …).
    reserve: function (x0, z0, x1, z1, kind) {
      this.keepOut.push({ minX: Math.min(x0, x1), maxX: Math.max(x0, x1), minZ: Math.min(z0, z1), maxZ: Math.max(z0, z1), kind: kind || '' });
    },
    reserveR: function (x, z, r, kind) { this.reserve(x - r, z - r, x + r, z + r, kind); },
    isClear: function (x, z, r) {
      const K = this.keepOut;
      for (let i = 0; i < K.length; i++) {
        const k = K[i];
        const dx = Math.max(k.minX - x, 0, x - k.maxX), dz = Math.max(k.minZ - z, 0, z - k.maxZ);
        if (dx * dx + dz * dz < r * r) return false;
      }
      return true;
    },

    /* ---------------- build ---------------- */
    build: function (scene, state, opts) {
      opts = opts || {};
      const E = SE.Env;
      this.scene = scene; this.state = state || (SE.State && SE.State.data) || null;
      let q = opts.quality || (this.state && this.state.settings && this.state.settings.quality) || 'auto';
      if (q === 'auto') q = SE.Platform && SE.Platform.isMobile ? 'low' : 'high';
      this.quality = q; this.density = q === 'low' ? 0.55 : q === 'medium' ? 0.8 : 1;
      this.renderer = opts.renderer || null;
      if (this.renderer && this.renderer.capabilities) E.setAnisotropy(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));
      this.colliders = []; this.grid = {}; this.sections = []; this.rooms = []; this.passages = [];
      this.hatcheries = []; this.lairs = []; this.nests = []; this.interactables = []; this.botPlots = [];
      this.treadmills = []; this.labels = []; this.navPoints = []; this._animLists = null; this.keepOut = [];
      this.root = new T.Group(); this.root.name = 'world'; scene.add(this.root);

      this.buildLights(scene);
      this.buildSky(scene);
      const global = new Section('global');
      this.global = global;
      this.buildDistant(global);
      const base = new Section('base'); base.index = 0;
      this.sections.push(base);
      this.buildBase(base);
      for (let i = 0; i < 6; i++) {
        const pass = new Section('pass' + i), room = new Section('lair' + i);
        pass.index = room.index = i + 1;
        this.passages.push(pass); this.rooms.push(room); this.sections.push(room);
        this.buildLair(i, pass, room);
      }
      this.buildGuide();
      this.buildNav();
      [global, base].concat(this.passages, this.rooms).forEach((s) => { s.finish(); this.root.add(s.group); });
      this.buildEnvMap();
      this.syncState(true);
      this.refreshLabels();
      if (SE.I18N && SE.I18N.onChange && !this._i18nHooked) { this._i18nHooked = true; SE.I18N.onChange(() => this.refreshLabels()); }
      if (document.fonts && document.fonts.load) {
        const self = this;
        document.fonts.load('900 40px Nunito').then(function () { self.refreshLabels(); }, function () {});
      }
      this.curSection = -1;
      this.update(0, 0, this.spawn);
      return this;
    },

    /* ---------------- lights & sky ---------------- */
    buildLights: function (scene) {
      const hemi = new T.HemisphereLight('#d6ecff', '#6a9a40', HEMI_I);
      scene.add(hemi); this.hemi = hemi;
      const sun = new T.DirectionalLight('#fff3d6', SUN_I);
      this.sunOffset = new T.Vector3(-55, 110, 70);
      sun.position.copy(this.sunOffset);
      const shadows = this.quality !== 'low';
      sun.castShadow = shadows;
      if (shadows) {
        const S = this.quality === 'high' ? 2048 : 1024;
        sun.shadow.mapSize.set(S, S);
        const c = sun.shadow.camera; c.left = -75; c.right = 75; c.top = 75; c.bottom = -75; c.near = 10; c.far = 320;
        sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
      }
      scene.add(sun); scene.add(sun.target); this.sun = sun;
    },
    buildSky: function (scene) {
      const E = SE.Env;
      scene.fog = new T.Fog('#cfeeff', 160, 700);
      scene.background = new T.Color('#a6dcff');
      this.sky = E.skyDome(900); this.sky.userData.dynamic = true; scene.add(this.sky);
      this.clouds = E.clouds(E.seeded(9), this.quality === 'low' ? 14 : 24); this.clouds.userData.dynamic = true; scene.add(this.clouds);
    },
    buildEnvMap: function () {
      if (!this.renderer || this.quality === 'low' || !T.PMREMGenerator) return;
      try {
        const pm = new T.PMREMGenerator(this.renderer);
        const sc = new T.Scene();
        const dome = SE.Env.skyDome(50); dome.material.uniforms.sunDir.value.copy(this.sunOffset).normalize();
        sc.add(dome);
        const ground = new T.Mesh(new T.CircleGeometry(60, 16), new T.MeshBasicMaterial({ color: '#5a9a3a' }));
        ground.rotation.x = -PI / 2; ground.position.y = -2; sc.add(ground);
        const rt = pm.fromScene(sc, 0, 0.1, 200);
        this.envMap = rt.texture; pm.dispose();
        const env = this.envMap;
        this.root.traverse(function (o) {
          const m = o.material;
          if (m && m.isMeshStandardMaterial && (m.metalness > 0.3 || m.roughness < 0.3) && !m.envMap) { m.envMap = env; m.envMapIntensity = 0.9; m.needsUpdate = true; }
        });
      } catch (e) { this.envMap = null; }
    },

    /* ---------------- distant scenery (always visible) ---------------- */
    buildDistant: function (S) {
      const E = SE.Env, rng = E.seeded(31);
      const far = E.plane(2600, 2600, E.mat('#6aae48')); far.position.set(0, -1.5, -500); S.stat(far, { cast: false });
      // castle on a hill behind the base (south-west), visible above the walls when running home
      const hill = new T.Group();
      const top = E.mat('#5cb83a'), side = E.mat('#9a6a3a');
      const steps = [[110, 26], [86, 40], [64, 50]];
      steps.forEach(function (s) { hill.add(E.at(E.box(s[0], s[1], s[0] * 0.8, side), 0, s[1] / 2 - 2, 0)); hill.add(E.at(E.box(s[0] + 1, 2, s[0] * 0.8 + 1, top), 0, s[1] - 2, 0)); });
      hill.position.set(-70, 0, 300); S.stat(hill, { cast: false });
      // castle base sits 1 below the top step's grass surface (y 49): never floats
      const castle = E.castle(rng); castle.position.set(-70, 48, 300); castle.rotation.y = PI;
      S.stat(castle, { cast: false });
      // trees on the hill steps: standing on the surface of the step they are on (y = that step's top)
      const stepTop = function (x, z) {
        let y = 0;
        steps.forEach(function (st) { if (Math.abs(x + 70) < st[0] / 2 && Math.abs(z - 300) < st[0] * 0.4) y = Math.max(y, st[1] - 1); });
        return y;
      };
      for (let k = 0; k < 14; k++) {
        const x = -70 + (rng() - 0.5) * 104, z = 300 + (rng() - 0.5) * 84, y = stepTop(x, z);
        if (y <= 0 || y >= 49 || Math.abs(x + 70) > 51 || Math.abs(z - 300) > 40) continue;   // only on the two lower steps
        let edge = false;   // keep the crown off the next step's face
        steps.forEach(function (st) { if (st[1] - 1 > y && Math.abs(x + 70) < st[0] / 2 + 6 && Math.abs(z - 300) < st[0] * 0.4 + 6) edge = true; });
        if (edge) continue;
        const tr = E.voxelTree(rng, { scale: 1.5 }); tr.position.set(x, y, z); S.stat(tr, { cast: false });
      }
      // windmill on the east hills near the base: a stone tower on the hill top, the Kenney rotor (spinning) on its west face
      const wm = E.kenney('kenney.town.windmill');
      if (wm) {
        const g = new T.Group(), stone = E.mat('#c8c0b4'), roofM = E.mat('#b0402a');
        g.add(E.at(E.box(40, 40, 40, side), 0, 18, 0)); g.add(E.at(E.box(41, 2, 41, top), 0, 38, 0));
        g.add(E.at(E.box(10, 22, 10, stone), 0, 49, 0));
        const roof = new T.Mesh(new T.ConeGeometry(8.4, 9, 4), roofM); roof.position.set(0, 64.5, 0); roof.rotation.y = PI / 4; g.add(roof);
        g.position.set(230, 0, 10); S.stat(g, { cast: false });
        const hub = new T.Group(); hub.position.set(230 - 5 - 0.235 * 9 - 0.2, 54, 10); wm.scale.setScalar(9); hub.add(wm);
        markDynamic(hub); S.dyn(hub); S.anim.push({ k: 'spinX', o: hub, v: 0.35 });
      }
    },

    /* ---------------- shared builders ---------------- */
    wall: function (S, x0, z0, x1, z1, look, opts) {
      // axis-aligned wall box between (x0,z0) and (x1,z1) (outer corners), height WALL_H, grass cap
      const E = SE.Env;
      const w = Math.abs(x1 - x0), d = Math.abs(z1 - z0), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const h = (opts && opts.h) || WALL_H;
      // world-space UVs: touching / overlapping wall pieces show the same texels (no seams, no flicker at corners)
      S.stat(E.worldBox(cx, h / 2, cz, w, h, d, E.wallMat(look.wall), 9));
      S.stat(E.worldBox(cx, h + 0.6, cz, w + 1.2, 1.6, d + 1.2, E.studMat(look.cap), 5.6));
      S.stat(E.at(E.box(w + 1.4, 0.7, d + 1.4, E.mat(look.capDark || shade(look.cap, -0.18))), cx, h - 0.35, cz), { cast: false });
      this.addBox(cx, cz, w, d, h + 1.4);
      this.reserve(cx - w / 2 - 0.7, cz - d / 2 - 0.7, cx + w / 2 + 0.7, cz + d / 2 + 0.7, 'wall');
    },
    /* Ground layers (one continuous world-space stud grid, 1 stud = 1.4): base ground pieces at y 0 never overlap
       each other; overlays (pads layer 1, paths layer 2) use E.studMat/cobbleMat(color, { layer }) = polygonOffset
       plus a tiny lift, so nothing z-fights even far away. */
    ground: function (S, x0, z0, x1, z1, color, y) {
      const E = SE.Env;
      S.stat(E.groundPlane(x0, z0, x1, z1, E.groundMat(color), 5.6, y || 0), { cast: false });
    },
    stripe: function (S, x0, z0, x1, z1, material, y, uvTile) {
      const E = SE.Env;
      S.stat(E.groundPlane(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), material, uvTile || 5.6, y || 0.03), { cast: false });
    },
    fence: function (S, x0, z0, x1, z1, o) {
      const f = SE.Env.fenceLine(x0, z0, x1, z1, o);
      S.stat(f.group);
      const thick = 1.2, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      this.reserve(x0 - 0.8, z0 - 0.8, x1 + 0.8, z1 + 0.8, 'fence');
      if (Math.abs(x1 - x0) > Math.abs(z1 - z0)) this.addBox(cx, cz, Math.abs(x1 - x0) + thick, thick, 4.4, { noCamera: true });
      else this.addBox(cx, cz, thick, Math.abs(z1 - z0) + thick, 4.4, { noCamera: true });
    },
    label: function (redrawable) { this.labels.push(redrawable); return redrawable; },
    clone: function (key, o) {
      const A = SE.Assets;
      if (!A || (A.has && !A.has(key))) return null;
      return A.get(key, o);
    },
    hills: function (S, side, z0, z1, look, rng, o) {
      // stepped voxel hills outside the side walls (x sign = side), tops peek above the walls
      const E = SE.Env; o = o || {};
      const xs = o.xs || [72, 86, 100, 116], cell = 14;
      const topM = E.mat(look.hillTop || look.cap), sideM = E.mat(look.hillSide || shade(look.wall, -0.1));
      for (let z = z0; z > z1; z -= cell) {
        xs.forEach(function (x, k) {
          const h = (o.hBase || 22) + k * (o.hStep || 6) + Math.round(rng() * 4) * 3;
          const w = cell + 0.5;
          S.stat(E.at(E.box(w, h, w, sideM), side * x, h / 2 - 1, z - cell / 2), { cast: false });
          S.stat(E.at(E.box(w + 0.6, 1.6, w + 0.6, topM), side * x, h - 0.2, z - cell / 2), { cast: false });
          if (o.tree && rng() < o.tree * World.density) {
            const tr = o.tree3 ? o.tree3(rng) : E.voxelTree(rng, { scale: 1.3 + rng() * 0.6, leaf: look.leaf, leaf2: look.leaf2, snow: look.snow });
            tr.position.set(side * x + (rng() - 0.5) * 6, h + 0.5, z - cell / 2 + (rng() - 0.5) * 6);
            S.stat(tr, { cast: false });
          }
        });
      }
    },

    /* ---------------- base ---------------- */
    buildBase: function (S) {
      const E = SE.Env, L = LAYOUT, B = L.base, rng = E.seeded(101), self = this;
      const amb = Object.assign({}, ambience(-1) || { wall: '#c98a4b', wallCap: '#5cb83a', path: '#efe2b8' }, { ground: '#5cbc38' });
      const look = { wall: amb.wall, cap: amb.wallCap, leaf: '#4fae3a', leaf2: '#3e9932' };
      this.baseLook = look;
      // ground + paths
      // ground ends at the north wall line: the gate passage has its own ground (no overlapping ground planes)
      this.ground(S, B.xMin, B.zMin, B.xMax, B.zMax, amb.ground);
      // every cobble path piece: same material, same height, world UVs → overlaps merge seamlessly
      const cob = E.cobbleMat('#f2e6cc', { layer: 2 }), PY = 0.04;
      this.stripe(S, -L.path.halfW, L.path.zFrom, L.path.halfW, L.path.zTo, cob, PY, 7);
      const plaza = new T.Mesh(new T.CircleGeometry(L.plaza.r, 28), cob);
      plaza.rotation.x = -PI / 2; plaza.position.set(L.plaza.x, PY, L.plaza.z);
      { const uv = plaza.geometry.attributes.uv, ps = plaza.geometry.attributes.position; for (let i = 0; i < uv.count; i++) uv.setXY(i, (L.plaza.x + ps.getX(i)) / 7, (L.plaza.z - ps.getY(i)) * -1 / 7); }
      S.stat(plaza, { cast: false });
      L.pens.forEach(function (p) {   // side paths to the pen openings
        const x0 = p.open > 0 ? p.x + L.penSize / 2 : L.path.halfW, x1 = p.open > 0 ? -L.path.halfW : p.x - L.penSize / 2;
        self.stripe(S, Math.min(x0, x1), p.z - 3, Math.max(x0, x1), p.z + 3, cob, PY, 7);
        self.reserve(Math.min(x0, x1), p.z - 3, Math.max(x0, x1), p.z + 3, 'path');
      });
      this.stripe(S, 30, 84, 58, 90, cob, PY, 7);                 // to the train area
      this.stripe(S, -58, 90, -30, 96, cob, PY, 7);               // to the fountain
      this.reserve(-L.path.halfW, L.path.zFrom, L.path.halfW, L.path.zTo, 'path');
      this.reserve(L.plaza.x - L.plaza.r, L.plaza.z - L.plaza.r, L.plaza.x + L.plaza.r, L.plaza.z + L.plaza.r, 'path');
      this.reserve(30, 84, 58, 90, 'path'); this.reserve(-58, 90, -30, 96, 'path');
      // walls: north (with the gate opening), south, west, east
      const T2 = WALL_T;
      this.wall(S, B.xMin - T2, B.zMin - T2, -PASS_W / 2, B.zMin, look);
      this.wall(S, PASS_W / 2, B.zMin - T2, B.xMax + T2, B.zMin, look);
      this.wall(S, B.xMin - T2, B.zMax, B.xMax + T2, B.zMax + T2, look);
      this.wall(S, B.xMin - T2, B.zMin - T2, B.xMin, B.zMax + T2, look);
      this.wall(S, B.xMax, B.zMin - T2, B.xMax + T2, B.zMax + T2, look);
      // hills outside
      const hl = Object.assign({ hillTop: '#5cb83a', hillSide: '#a8743e' }, look);
      for (const sd of [-1, 1]) this.hills(S, sd, B.zMax + 10, B.zMin - 60, hl, rng, { xs: [178, 192, 206], tree: 0.45 });
      for (let x = B.xMin - 10; x < B.xMax + 10; x += 14) {
        for (let r = 0; r < 2; r++) {
          const h = 24 + r * 8 + Math.round(rng() * 3) * 3, z = B.zMax + 12 + r * 14;
          S.stat(E.at(E.box(14.5, h, 14.5, E.mat('#a8743e')), x, h / 2 - 1, z), { cast: false });
          S.stat(E.at(E.box(15, 1.6, 15, E.mat('#5cb83a')), x, h - 0.2, z), { cast: false });
          if (rng() < 0.35 * this.density) { const tr = E.voxelTree(rng, { scale: 1.4 }); tr.position.set(x, h + 0.5, z); S.stat(tr, { cast: false }); }
        }
        if (Math.abs(x) > 30) {   // behind the north wall (seen from the spawn)
          const h = 30 + Math.round(rng() * 4) * 3, z = B.zMin - 14;
          S.stat(E.at(E.box(14.5, h, 14.5, E.mat('#a8743e')), x, h / 2 - 1, z), { cast: false });
          S.stat(E.at(E.box(15, 1.6, 15, E.mat('#5cb83a')), x, h - 0.2, z), { cast: false });
          if (rng() < 0.5 * this.density) { const tr = E.voxelTree(rng, { scale: 1.3 + rng() * 0.5 }); tr.position.set(x, h + 0.5, z); S.stat(tr, { cast: false }); }
        }
      }
      // base gate + safe line
      this.buildBaseGate(S);
      // hatchery pens
      L.pens.forEach(function (p, i) { self.buildPen(S, p, i); });
      // stalls, wheel, gift, index, train, fountain, signs
      this.buildStalls(S);
      this.buildTrain(S);
      this.buildBaseProps(S, rng);
      // bot plots
      L.botPlots.forEach(function (bp, i) { self.buildBotPlot(S, bp, i); });
      // lanterns along the main path
      for (let z = -14; z <= 70; z += 21) for (const sd of [-1, 1]) {
        const lp = E.lanternPost(); lp.position.set(sd * 7, 0, z); lp.rotation.y = sd > 0 ? PI : 0; S.stat(lp);
        this.addBox(sd * 7, z, 0.9, 0.9, 6.5, { noCamera: true });
        this.reserve(sd * 7 - 1.2, z - 1.2, sd * 7 + (sd > 0 ? -3 : 3), z + 1.2, 'lantern');
      }
      // banners on the inner face of the north wall
      for (let x = -150; x <= 150; x += 25) {
        if (Math.abs(x) < 30) continue;
        const b = E.bannerMesh(((x + 150) / 25 | 0) % 6); b.position.set(x, 17, B.zMin + 0.3); S.stat(b, { cast: false });
        S.stat(E.at(E.box(3.6, 0.4, 0.5, E.mat('#5b3d29')), x, 19.6, B.zMin + 0.4), { cast: false });
      }
      // decor: trees along the walls & corners, flowers, bushes, rocks. Every candidate keeps its own radius
      // (tree crown, bush …) clear of the reserved footprints (fences, pens, signs, stalls, lanterns, paths, walls).
      const keep = function (x, z) {
        if (Math.abs(x) < 36 && z > -28 && z < 112) {
          if (Math.abs(x) < 10) return false;
          if (Math.hypot(x - L.plaza.x, z - L.plaza.z) < L.plaza.r + 6) return false;
          if (Math.abs(x) > 14 && Math.abs(x) < 28 && Math.abs(z - 28) < 7) return false;   // gift / index
        }
        for (const p of L.pens) if (Math.abs(x - p.x) < 15 && Math.abs(z - p.z) < 15) return false;
        for (const bp of L.botPlots) if (Math.abs(x - bp.x) < 23 && Math.abs(z - bp.z) < 32) return false;
        if (x > 30 && x < 62 && z > 80) return false;                 // train
        if (x < -32 && x > -62 && z > 82) return false;               // fountain
        if (Math.abs(x) < 34 && z > 80) return false;                 // stalls & wheel
        if (z < -14 && Math.abs(x) < 24) return false;                // gate approach
        if (z < -12 && Math.abs(x) > 60) return false;                // bot route strip
        return true;
      };
      const scatter = function (n, fn, margin, radius) {
        let placed = 0, tries = 0;
        while (placed < n && tries++ < n * 30) {
          const r = typeof radius === 'function' ? radius() : (radius || 0.8);
          const x = E.rr(rng, B.xMin + margin, B.xMax - margin), z = E.rr(rng, B.zMin + margin, B.zMax - margin);
          if (!keep(x, z) || !self.isClear(x, z, r)) continue;
          if (fn(x, z, r) === false) continue;
          placed++;
        }
      };
      const nat = E.natureRemap();
      const treeR = function (sc) { return 5.9 * sc + 0.6; };
      // trees hugging the south wall: crown fully in front of the wall
      for (let x = B.xMin + 8; x < B.xMax - 8; x += 13 + rng() * 8) {
        const sc = 1 + rng() * 0.35, r = treeR(sc), z = B.zMax - 2.2 - r - rng() * 2;
        if (!keep(x, z) || !this.isClear(x, z, r)) continue;
        const tr = E.voxelTree(rng, { scale: sc }); tr.position.set(x, 0, z); S.stat(tr);
        this.addBox(x, z, 2, 2, 8); this.reserveR(x, z, 1.4, 'trunk');
      }
      let tsc = 1;
      scatter(Math.round(26 * this.density), function (x, z) {
        if (Math.abs(x) < 64 && z > -20 && z < 80 && Math.abs(x) < 36) return false;   // keep the lawn open
        const tr = E.voxelTree(rng, { scale: tsc }); tr.position.set(x, 0, z); S.stat(tr);
        self.addBox(x, z, 2, 2, 8); self.reserveR(x, z, 1.4, 'trunk');
      }, 8, function () { tsc = 0.85 + rng() * 0.4; return treeR(tsc); });
      // (no blocky cube bushes any more) a few rounded Kenney Nature bushes, plus more flowers / grass below
      let ksc = 10;
      if (E.kenney('kenney.nature.plant_bushLarge')) scatter(Math.round(14 * this.density), function (x, z) {
        const b = kenneyProp('kenney.nature.plant_bushLarge', ksc, rng); b.position.set(x, 0, z); S.stat(b, { remap: nat }); self.reserveR(x, z, 1.4, 'bush');
      }, 5, function () { ksc = 9 + rng() * 4; return 0.19 * ksc + 0.6; });
      scatter(Math.round(170 * this.density), function (x, z) { const f = E.flower(rng); f.position.set(x, 0, z); S.stat(f, { cast: false, remap: nat }); }, 3, 0.9);
      scatter(Math.round(60 * this.density), function (x, z) { const g = E.grassTuft(rng); g.position.set(x, 0, z); S.stat(g, { cast: false, remap: nat }); }, 3, 1.3);
      scatter(10, function (x, z) { const r = E.rock(rng, { scale: 0.8 }); r.position.set(x, 0, z); S.stat(r); self.reserveR(x, z, 2, 'rock'); }, 6, 3.6);
    },

    buildBaseGate: function (S) {
      const E = SE.Env, L = LAYOUT, g = L.baseGate;
      const gate = this.clone('prop.base_gate');
      const grp = new T.Group(); grp.position.set(g.x, 0, g.z); grp.rotation.y = PI;   // front (+Z) faces north: read when coming home
      if (gate) {
        grp.add(gate); grp.updateMatrixWorld(true);
        const board = SE.Assets.getPart(gate, 'sign_board');
        const fires = ['fire_L', 'fire_R'].map(function (n) { return SE.Assets.getPart(gate, n); }).filter(Boolean);
        fires.forEach(function (f) { f.parent.remove(f); });
        S.stat(grp);
        const self = this;
        const addText = function (back) {
          const sb = E.signBoard({ w: 13, h: 3.2, style: 'wood', noBoard: true, transparent: true, text: function () { return t('world.sign.base'); } });
          self.label(sb);
          const bb = board ? new T.Box3().setFromObject(board) : null;
          const y = bb ? (bb.min.y + bb.max.y) / 2 : 14.4;
          sb.mesh.position.set(g.x, y, back ? g.z + (bb ? bb.max.z - g.z : 0.95) + 0.05 : g.z + (bb ? bb.min.z - g.z : -0.95) - 0.05);
          sb.mesh.rotation.y = back ? 0 : PI;
          S.stat(sb.mesh, { cast: false });
        };
        addText(false); addText(true);
        fires.forEach(function (f) {
          const w = new T.Group(); w.position.set(g.x - f.position.x, f.position.y, g.z - f.position.z); w.rotation.y = PI;
          f.position.set(0, 0, 0); w.add(f); S.dyn(markDynamic(w));
          S.anim.push({ k: 'fire', o: w, ph: Math.random() * 6 });
        });
      }
      // pillar colliders + the white safe line
      this.addBox(g.x - 16.6, g.z, 4.5, 4.5, 18); this.addBox(g.x + 16.6, g.z, 4.5, 4.5, 18);
      this.reserve(g.x - 21, g.z - 5, g.x + 21, L.safeLineZ + 8, 'gate');
      const line = new T.Mesh(new T.PlaneGeometry(PASS_W, 1.4), new T.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95 }));
      line.rotation.x = -PI / 2; line.position.set(0, 0.08, L.safeLineZ);
      line.userData.dynamic = true; S.dyn(line); this.safeLine = line;
      S.anim.push({ k: 'safeline', o: line });
      const anchor = new T.Object3D(); anchor.position.set(0, 0.1, L.safeLineZ); anchor.userData.dynamic = true; S.dyn(anchor);
      this._safeAnchor = anchor; this._safeFx = null; this._fxTried = false;
    },

    buildPen: function (S, p, i) {
      const E = SE.Env, L = LAYOUT, h2 = L.penSize / 2, gap = L.penGap / 2, self = this;
      const o = p.open, back = p.x - o * h2, front = p.x + o * h2;
      this.fence(S, p.x - h2, p.z - h2, p.x + h2, p.z - h2);
      this.fence(S, p.x - h2, p.z + h2, p.x + h2, p.z + h2);
      this.fence(S, back, p.z - h2, back, p.z + h2);
      this.fence(S, front, p.z - h2, front, p.z - gap);
      this.fence(S, front, p.z + gap, front, p.z + h2);
      // hatchery prop
      const hx = p.x - o * 0.5, hz = p.z;
      const hp = this.clone('prop.hatchery');
      let spotY = 0.4;
      if (hp) {
        const lift = propLift('prop.hatchery', 1);
        hp.position.set(hx, lift, hz); S.stat(hp);
        const spot = SE.Assets.getPart(hp, 'egg_spot'); if (spot) spotY = spot.position.y + lift;
      } else {
        const r = new T.Mesh(new T.TorusGeometry(4, 0.9, 5, 12), E.mat('#a6a1a5')); r.rotation.x = -PI / 2; r.position.set(hx, 0.5, hz); S.stat(r);
      }
      const content = new T.Group(); content.position.set(hx, spotY, hz); content.name = 'hatchery' + i;
      markDynamic(content); S.dyn(content);
      // grass inside the pen is a bit lighter
      this.stripe(S, p.x - h2 + 0.6, p.z - h2 + 0.6, p.x + h2 - 0.6, p.z + h2 - 0.6, E.studMat('#7dcc55', { layer: 1 }), 0.02);
      // banner pole in the back corner + lanterns at the opening
      const pole = E.bannerPole(7.4); pole.position.set(back + o * 2.2, 0, p.z - h2 + 2.2); pole.rotation.y = o > 0 ? -PI / 4 : PI / 4; S.stat(pole);
      const banner = E.bannerMesh(-1); banner.position.set(0, 4.6, 0.32);
      const bannerHolder = new T.Group(); bannerHolder.position.copy(pole.position); bannerHolder.rotation.y = pole.rotation.y; bannerHolder.add(banner);
      markDynamic(bannerHolder); S.dyn(bannerHolder);
      for (const sz of [-1, 1]) {
        // outside the fence line (not through the rails), the arm hangs over the path in front of the opening
        const lp = E.lanternPost({ h: 6 }); lp.position.set(front + o * 1.4, 0, p.z + sz * (gap + 0.6)); lp.rotation.y = o > 0 ? 0 : PI; S.stat(lp);
      }
      // "HATCHERY" sign above the back fence (shared texture, merged)
      if (!this._hatchSign) {
        this._hatchSign = E.signBoard({ w: 9, h: 2.1, style: 'wood', text: function () { return t('world.sign.hatchery'); } });
        this.label(this._hatchSign);
      }
      const sign = this._hatchSign.mesh.clone();
      sign.position.set(back + o * 0.75, 6.3, p.z); sign.rotation.y = o > 0 ? PI / 2 : -PI / 2; S.stat(sign, { cast: false });
      const sb = E.box(9.4, 2.4, 0.4, E.mat('#4a2f1e')); sb.position.set(back + o * 0.5, 6.3, p.z); sb.rotation.y = sign.rotation.y; S.stat(sb);
      for (const sz of [-3.6, 3.6]) S.stat(E.at(E.box(0.6, 3, 0.6, E.mat('#4a2f1e')), back + o * 0.05, 5.2, p.z + sz));
      // locked: wooden bar across the opening + price board
      const bar = new T.Group();
      for (const y of [1.4, 2.8]) bar.add(E.at(E.box(0.45, 0.7, L.penGap, E.mat('#b07a48')), front, y, p.z));
      bar.add(E.at(E.box(0.5, 4.4, 0.25, E.mat('#7a5030')), front, 2.1, p.z));
      markDynamic(bar); S.dyn(bar);
      const priceN = SE.State && SE.State.hatcheryPrice ? SE.State.hatcheryPrice(i) : 0;
      const lock = E.signBoard({
        w: 6, h: 2.4, px: 80, style: 'wood',
        draw: function (ctx, w, h) {
          E.drawBoard(ctx, w, h, 'wood', true);
          const pad = E.boardPad(w, h);   // padlock icon BESIDE the price, the row is measured and centred
          E.iconText(ctx, { x0: pad.x, x1: w - pad.x, cy: h / 2, maxH: h - 2 * pad.y, size: h * 0.56, text: money(priceN),
            fill: '#ffe680', stroke: '#3a2416', iconW: LOCK_W, iconScale: 1.3, gap: 0.16, drawIcon: drawLock });
        }
      });
      const lockGrp = new T.Group();
      lock.mesh.position.set(0, 4.2, 0.26); lockGrp.add(lock.mesh);
      lockGrp.add(E.at(E.box(6.4, 2.8, 0.4, E.mat('#4a2f1e')), 0, 4.2, 0));
      lockGrp.add(E.at(E.box(0.6, 3.2, 0.6, E.mat('#4a2f1e')), 0, 1.6, 0));
      lockGrp.position.set(front + o * 3.4, 0, p.z - 8.6); lockGrp.rotation.y = o > 0 ? PI / 2 : -PI / 2;   // clear of the lanterns
      markDynamic(lockGrp); S.dyn(lockGrp);
      this.reserve(p.x - h2 - 1.2, p.z - h2 - 1.2, p.x + h2 + 1.2, p.z + h2 + 1.2, 'pen');
      this.reserve(front + o * 3.4 - 1, p.z - 12, front + o * 3.4 + 1, p.z - 5.2, 'sign');
      this.reserve(front, p.z - gap - 1.6, front + o * 4, p.z + gap + 1.6, 'lantern');
      this.label(lock);
      const stateLabel = E.textSprite('', { scale: 7, bg: 'rgba(20,24,40,0.55)' });
      stateLabel.position.set(hx, 9.6, hz); markDynamic(stateLabel); S.dyn(stateLabel);   // above the HATCHERY board (top 7.4) at eye level
      const entry = { x: front + o * 3, z: p.z };
      const hatch = {
        index: i, x: hx, z: hz, group: content, content: content, stateLabel: stateLabel,
        lockLabel: lock, lockGroup: lockGrp, bar: bar, sign: sign, banner: banner, entry: entry, locked: null, species: undefined
      };
      this.hatcheries.push(hatch);
      this.interactables.push(hintObj({ type: 'hatchery', x: hx, z: hz, r: 11.5, index: i, hatchery: hatch }));
    },

    buildStalls: function (S) {
      const E = SE.Env, L = LAYOUT, self = this;
      const mk = function (spec, type, stripeA, stripeB, key, goods) {
        const st = E.stall({ stripeA: stripeA, stripeB: stripeB, title: function () { return t(key); } });
        self.label(st.sign);
        st.group.position.set(spec.x, 0, spec.z); st.group.rotation.y = spec.ry;
        goods(st.group);
        S.stat(st.group);
        const dx = Math.sin(spec.ry), dz = Math.cos(spec.ry);
        self.addBox(spec.x, spec.z, 9, 9, 9, {});
        self.reserveR(spec.x, spec.z, 7.5, 'stall');
        // vendor behind the counter (optional, from SE.Models)
        if (SE.Models && SE.Models.makeCharacter) {
          try {
            const ch = SE.Models.makeCharacter(type === 'sell' ? { shirt: '#e8463a', pants: '#3a3a4a', skin: '#f2c79c', hair: '#5a3a20' } : { shirt: '#3a8aff', pants: '#2a2a3a', skin: '#e0a878', hair: '#2a1a10' });
            const model = ch && (ch.group || ch);
            if (model && model.isObject3D) {
              model.position.set(spec.x - dx * 0.6, 0, spec.z - dz * 0.6); model.rotation.y = spec.ry;
              model.traverse(function (o) { if (o.isMesh) o.castShadow = false; });
              markDynamic(model); S.dyn(model);
              if (ch.update) S.anim.push({ k: 'vendor', ch: ch });
            }
          } catch (e) { /* optional vendor */ }
        }
        self.interactables.push(hintObj({ type: type, x: spec.x + dx * 7, z: spec.z + dz * 7, r: 6.5 }));
      };
      mk(L.sell, 'sell', '#e8463a', '#ffffff', 'world.sign.sell', function (g) {
        for (let k = 0; k < 5; k++) { const c = E.coinStack(3 + (k * 7) % 5); c.position.set(-3.4 + k * 1.7, 2.95, 1.6 + (k % 2) * 0.6); g.add(c); }
        const bag = new T.Mesh(new T.SphereGeometry(1, 7, 5), E.mat('#c8a060')); bag.scale.set(1, 1.1, 1); bag.position.set(3.6, 3.9, 1.4); g.add(bag);
        g.add(E.at(E.box(0.8, 0.5, 0.8, E.mat('#8a6a3a')), 3.6, 5, 1.4));
      });
      mk(L.shop, 'shop', '#3a8aff', '#ffffff', 'world.sign.shop', function (g) {
        const hat = function (x, col) {
          const c = new T.Mesh(new T.ConeGeometry(0.9, 1.8, 6), E.mat(col)); c.position.set(x, 3.95, 1.6); g.add(c);
          g.add(E.at(E.box(2, 0.2, 2, E.mat(col)), x, 3.0, 1.6));
        };
        hat(-3, '#9a4ae0'); hat(0, '#e8463a'); hat(3, '#ffc928');
        const cape = E.box(2.4, 4, 0.3, E.mat('#e8463a')); cape.position.set(3.5, 4.6, -2.2); g.add(cape);
      });
      // wheel of fortune
      const wh = E.wheelStand(); wh.group.position.set(L.wheel.x, 0, L.wheel.z); wh.group.rotation.y = L.wheel.ry;
      const wheel = wh.wheel; wh.group.remove(wheel);
      S.stat(wh.group);
      const wheelHolder = new T.Group(); wheelHolder.position.copy(wh.group.position); wheelHolder.rotation.y = L.wheel.ry; wheelHolder.add(wheel);
      markDynamic(wheelHolder); S.dyn(wheelHolder);
      S.anim.push({ k: 'wheel', o: wheel });
      const ws = E.signBoard({ w: 11, h: 2, style: 'navy', text: function () { return t('world.sign.wheel'); } }); this.label(ws);
      ws.mesh.position.set(L.wheel.x, 1.6, L.wheel.z - 2.05); ws.mesh.rotation.y = PI; ws.mesh.scale.setScalar(0.9); S.stat(ws.mesh, { cast: false });
      this.addBox(L.wheel.x, L.wheel.z, 12, 4, 16);
      this.reserve(L.wheel.x - 7.5, L.wheel.z - 4, L.wheel.x + 7.5, L.wheel.z + 3, 'wheel');
      this.interactables.push(hintObj({ type: 'wheel', x: L.wheel.x, z: L.wheel.z - 6, r: 6.5 }));
    },

    buildTrain: function (S) {
      const E = SE.Env, L = LAYOUT.train, self = this;
      L.treadmills.forEach(function (tm) {
        const m = E.treadmill(); m.group.position.set(tm.x, 0, tm.z);
        const belt = m.belt; m.group.remove(belt);
        S.stat(m.group);
        belt.position.set(tm.x, 0.52, tm.z); markDynamic(belt); S.dyn(belt);
        S.anim.push({ k: 'belt', tex: m.beltTexture });
        self.addBox(tm.x, tm.z, 4.0, 9.4, 0.6, { solid: false, walkable: true, id: 'treadmill' });
        for (const sx of [-2.35, 2.35]) self.addBox(tm.x + sx, tm.z - 4.4, 0.6, 0.6, 5.5, { noCamera: true });
        const rec = { x: tm.x, z: tm.z, r: 3.2, w: 3.8, d: 9.2 };
        self.treadmills.push(rec);
        self.interactables.push(hintObj({ type: 'treadmill', x: tm.x, z: tm.z, r: 3.2, passive: true, treadmill: rec }));
      });
      const ub = E.upgradeBoard(); ub.group.position.set(L.upgradeSign.x, 0, L.upgradeSign.z); ub.group.rotation.y = L.upgradeSign.ry;
      S.dyn(ub.group);   // the canvas changes; the group itself stays put
      this.addBox(L.upgradeSign.x, L.upgradeSign.z, 6.4, 1.4, 8);
      const us = this.upgradeSign = {
        x: L.upgradeSign.x, z: L.upgradeSign.z, board: ub, level: null,
        setText: function (levelText, priceText) { ub.setText(levelText, priceText, t('world.upgrade.title')); }
      };
      this.label({ redraw: function () { us.level = null; self.syncTreadmill(); } });
      this.interactables.push(hintObj({ type: 'upgrade', x: L.upgradeSign.x, z: L.upgradeSign.z + 3.5, r: 5 }));
      // TRAIN sign on two posts at the back
      const ts = E.signBoard({ w: 10, h: 2.6, style: 'wood', text: function () { return t('world.sign.train'); } }); this.label(ts);
      const g = new T.Group();
      ts.mesh.position.set(0, 9, 0.26); g.add(ts.mesh);
      g.add(E.at(E.box(10.6, 3.2, 0.4, E.mat('#4a2f1e')), 0, 9, 0));
      for (const sx of [-4.6, 4.6]) g.add(E.at(E.box(0.8, 10.5, 0.8, E.mat('#4a2f1e')), sx, 5.2, 0));
      for (const sx of [-6.8, 6.8]) { const b = E.bannerMesh(sx > 0 ? 2 : 0); b.position.set(sx, 7, 0.2); g.add(b); g.add(E.at(E.box(0.4, 9, 0.4, E.mat('#5b3d29')), sx, 4.5, 0)); }
      g.position.set(L.sign.x, 0, L.sign.z); g.rotation.y = PI; S.stat(g);
      this.reserve(L.sign.x - 9, L.sign.z - 2, L.sign.x + 9, L.sign.z + 2, 'sign');
      L.treadmills.forEach(function (tm) { self.reserve(tm.x - 3.6, tm.z - 6, tm.x + 3.6, tm.z + 6, 'treadmill'); });
      this.reserve(L.upgradeSign.x - 4, L.upgradeSign.z - 2, L.upgradeSign.x + 4, L.upgradeSign.z + 2, 'sign');
    },

    buildBaseProps: function (S, rng) {
      const E = SE.Env, L = LAYOUT, self = this;
      // Daily gift chest (Blender prop.gift_chest): claimable → lid ajar with light + sparkles, slight bob, glow,
      // floating "!" badge; claimed → closed and calm, the sign shows the time to the next gift (syncGift).
      const ch = E.chest(); ch.group.position.set(L.gift.x, 0, L.gift.z); ch.group.rotation.y = L.gift.ry;
      markDynamic(ch.group); S.dyn(ch.group);
      const beam = giftBeam(); beam.position.set(0, (ch.inner ? ch.inner.position.y : 2.6), 0); ch.group.add(beam); markDynamic(beam);
      const fxAnchor = new T.Object3D(); fxAnchor.position.set(0, (ch.inner ? ch.inner.position.y : 2.6) + 0.6, 0); ch.group.add(fxAnchor); markDynamic(fxAnchor);
      const marker = badgeSprite(); marker.position.set(L.gift.x, GIFT_BADGE_Y, L.gift.z); markDynamic(marker); S.dyn(marker);
      const gs = E.signBoard({
        w: 7.4, h: 2.8, px: 72, style: 'orange',
        draw: function (ctx, w, h) {
          E.drawBoard(ctx, w, h, 'orange', false);
          const pad = E.boardPad(w, h), G = self.gift;
          const sub = G && G.sub !== null ? G.sub : t('world.gift.ready');
          if (!sub) { E.outlinedText(ctx, t('world.sign.gift'), w / 2, h / 2, Math.round(h * 0.42), '#ffffff', '#5a2a08', w - 2 * pad.x, 0, h - 2 * pad.y); return; }
          E.outlinedText(ctx, t('world.sign.gift'), w / 2, h * 0.36, Math.round(h * 0.34), '#ffffff', '#5a2a08', w - 2 * pad.x, 0, h * 0.4);
          E.outlinedText(ctx, sub, w / 2, h * 0.74, Math.round(h * 0.24), G && !G.ready ? '#ffe6c0' : '#fff27a', '#5a2a08', w - 2 * pad.x, 0, h * 0.28);
        }
      });
      this.label(gs);
      // board bottom (y 6.3) stays above the opened lid (top ≈ 6.1 incl. the bob): the open chest never hides the text
      const gsg = new T.Group(); gs.mesh.position.set(0, 7.75, 0.22); gsg.add(gs.mesh);
      gsg.add(E.at(E.box(7.7, 3.1, 0.3, E.mat('#7a3a10')), 0, 7.75, 0));
      for (const sx of [-3.1, 3.1]) gsg.add(E.at(E.box(0.5, 6.4, 0.5, E.mat('#4a2f1e')), sx, 3.2, -0.1));
      gsg.position.set(L.gift.x + 3.8, 0, L.gift.z); gsg.rotation.y = L.gift.ry; S.stat(gsg);
      this.gift = { chest: ch, beam: beam, marker: marker, sign: gs, anchor: fxAnchor, ready: null, sub: null, fx: null, sparkT: 0, open: 0 };
      S.anim.push({ k: 'chest', g: this.gift });
      this.addBox(L.gift.x, L.gift.z, 3.6, 5, 3.4);
      this.reserve(L.gift.x - 4, L.gift.z - 5, L.gift.x + 5, L.gift.z + 5, 'gift');
      this.interactables.push(hintObj({ type: 'gift', x: L.gift.x - 4, z: L.gift.z, r: 6 }));
      // Dragon Index: golden dragon statue on a plinth + board
      const ix = L.index, plinth = new T.Group(), stone = E.mat('#b4aea8'), dark = E.mat('#7c7570');
      plinth.add(E.at(E.box(9, 1.4, 9, dark), 0, 0.7, 0)); plinth.add(E.at(E.box(7, 2.6, 7, stone), 0, 2.7, 0)); plinth.add(E.at(E.box(7.6, 0.6, 7.6, dark), 0, 4.3, 0));
      plinth.position.set(ix.x, 0, ix.z); S.stat(plinth);
      const gold = E.mat('#e8b830', { metal: 0.65, rough: 0.32 });
      const statue = this.clone('dragon.meadow.adult');
      if (statue && !statue.userData.placeholder) {
        statue.scale.setScalar(0.3); statue.position.set(ix.x, 4.6, ix.z); statue.rotation.y = ix.ry;
        S.stat(statue, { override: function (m) { return m.name === 'eye' ? E.mat('#2a2018') : m.name === 'pupil' ? E.mat('#2a2018') : gold; } });
      } else {
        const egg = new T.Mesh(new T.SphereGeometry(1.6, 10, 8), gold); egg.scale.set(1, 1.35, 1); egg.position.set(ix.x, 6.8, ix.z); S.stat(egg);
      }
      const is = E.signBoard({ w: 8, h: 1.8, style: 'navy', text: function () { return t('world.sign.index'); } }); this.label(is);
      is.mesh.position.set(ix.x + Math.sin(ix.ry) * 3.53, 2.7, ix.z + Math.cos(ix.ry) * 3.53); is.mesh.rotation.y = ix.ry; is.mesh.scale.setScalar(0.8); S.stat(is.mesh, { cast: false });
      this.addBox(ix.x, ix.z, 9, 9, 4.6, {});
      this.reserveR(ix.x, ix.z, 6, 'index');
      this.interactables.push(hintObj({ type: 'index', x: ix.x + Math.sin(ix.ry) * 7, z: ix.z, r: 6 }));
      // fountain (Kenney) with water
      const fo = E.kenney('kenney.town.fountain-round-detail');
      if (fo) { fo.scale.setScalar(6.5); fo.position.set(L.fountain.x, 0, L.fountain.z); S.stat(fo); this.addBox(L.fountain.x, L.fountain.z, 11, 11, 2.6); this.reserveR(L.fountain.x, L.fountain.z, 7.5, 'fountain'); }
      // cart next to the sell stall, signs
      const cart = E.kenney('kenney.town.cart');
      if (cart) { cart.scale.setScalar(5); cart.position.set(L.sell.x - 10, 0, L.sell.z + 4); cart.rotation.y = 0.6; S.stat(cart); this.addBox(L.sell.x - 10, L.sell.z + 4, 5, 7, 3); this.reserveR(L.sell.x - 10, L.sell.z + 4, 4.5, 'cart'); }
      const signPost = function (spec, key, style, w) {
        const sb = E.signBoard({ w: w || 9, h: 2, style: style, text: function () { return t(key); } }); self.label(sb);
        const g = new T.Group(); sb.mesh.position.set(0, 4.4, 0.24); g.add(sb.mesh);
        g.add(E.at(E.box((w || 9) + 0.4, 2.3, 0.35, E.mat('#4a2f1e')), 0, 4.4, 0)); g.add(E.at(E.box(0.6, 4.4, 0.6, E.mat('#4a2f1e')), 0, 2.2, -0.1));
        g.position.set(spec.x, 0, spec.z); g.rotation.y = spec.ry; S.stat(g);
        self.addBox(spec.x, spec.z, 1, 1, 4);
        self.reserveR(spec.x, spec.z, ((w || 9) + 0.4) / 2 + 0.6, 'sign');
      };
      signPost(L.signs.ahead, 'world.sign.ahead', 'cream', 9);
      signPost(L.signs.motto, 'world.sign.motto', 'wood', 10);
    },

    buildBotPlot: function (S, bp, i) {
      const E = SE.Env, L = LAYOUT, P = L.botPlotSize, hw = P.w / 2, hd = P.d / 2, g2 = P.gap / 2;
      const z0 = bp.z - hd, z1 = bp.z + hd;
      this.fence(S, bp.x - hw, z1, bp.x + hw, z1);
      this.fence(S, bp.x - hw, z0, bp.x - hw, z1);
      this.fence(S, bp.x + hw, z0, bp.x + hw, z1);
      this.fence(S, bp.x - hw, z0, bp.x - g2, z0);
      this.fence(S, bp.x + g2, z0, bp.x + hw, z0);
      this.stripe(S, bp.x - hw + 0.6, z0 + 0.6, bp.x + hw - 0.6, z1 - 0.6, E.studMat('#86c860', { layer: 1 }), 0.02);
      this.stripe(S, bp.x - 3, z0 - 1, bp.x + 3, z1 - 10, E.cobbleMat('#e8dcc0', { layer: 2 }), 0.04, 7);
      const plot = { index: i, x: bp.x, z: bp.z, entry: { x: bp.x, z: z0 - 3 }, hatcheries: [], color: bp.color };
      const content = new T.Group(); content.name = 'botplot' + i; markDynamic(content); S.dyn(content);
      plot.content = content;
      [[-9, -6], [9, -6], [-9, 14], [9, 14]].slice(0, 3 + (i % 2)).forEach((o) => {
        const hp = this.clone('prop.hatchery'), x = bp.x + o[0], z = bp.z + o[1];
        const lift = propLift('prop.hatchery', 0.72);
        if (hp) { hp.scale.setScalar(0.72); hp.position.set(x, lift, z); S.stat(hp); }
        const c = new T.Group(); c.position.set(x, 0.3 + lift, z); markDynamic(c); content.add(c);
        plot.hatcheries.push({ x: x, z: z, content: c });
      });
      const ban = E.bannerPole(7); ban.position.set(bp.x - g2 - 1.5, 0, z0); S.stat(ban);
      this.reserve(bp.x - hw - 1.5, z0 - 4, bp.x + hw + 1.5, z1 + 1.5, 'plot');
      const flagM = E.mat(bp.color, { side: 'double' });
      S.stat(E.at(E.box(0.2, 3.4, 2.8, flagM), bp.x - g2 - 1.5, 5.2, z0 + 1.5));
      const label = E.textSprite('', { scale: 9, bg: 'rgba(20,24,40,0.55)', color: '#ffffff' });
      label.position.set(bp.x, 9.5, z0); markDynamic(label); S.dyn(label);
      plot.label = label; plot.group = content;
      plot.setName = function (name, color) { label.userData.setText(name ? t('world.botBase', name) : '', color || '#ffffff'); };
      plot.route = [{ x: plot.entry.x, z: plot.entry.z }, { x: bp.x, z: L.botStripZ }, { x: 0, z: L.botStripZ }, { x: 0, z: L.baseGate.z - 6 }];
      this.botPlots.push(plot);
    },

    /* ---------------- lairs ---------------- */
    buildLair: function (i, P, R) {
      const E = SE.Env, L = LAYOUT, Ld = L.lairs[i], sp = species(i), id = BIOMES[i];
      const amb = ambience(i) || {};
      const rng = E.seeded(1000 + i * 77), self = this;
      const look = LOOKS[id](amb);
      const hw = LAIR_W / 2, pw = PASS_W / 2;
      const lair = {
        index: i, species: id, x: 0, z: Ld.zc, zMin: Ld.zMin, zMax: Ld.zMax, halfWidth: hw,
        passZ: Ld.passZ0, nests: [], greatNest: { x: Ld.greatNest.x, z: Ld.greatNest.z, y: 0.45, r: Ld.greatNest.r },
        // the guardian sleeps facing the room (towards the nests and the entrance)
        guardianSpawn: { x: Ld.greatNest.x, z: Ld.greatNest.z, yaw: face(Ld.greatNest.x, Ld.greatNest.z, 0, Ld.zc + 20), y: 0.45 },
        drakeSpawns: Ld.drakes.map(function (d) { return { x: d.x, z: d.z }; }),
        patrol: Ld.patrol.map(function (d) { return { x: d.x, z: d.z }; }),
        unlocked: i === 0, recommendedSpeed: sp ? sp.recommendedSpeed : 0, look: look
      };
      this.lairs.push(lair);
      // --- passage (ground, walls, path, arrows, gate, recommended speed sign)
      this.ground(P, -pw - 2, Ld.zMax, pw + 2, Ld.passZ0, look.ground);
      const pathM = E.studMat(look.path, { layer: 1 }), PH = LAYOUT.lairPathHalf;
      this.stripe(P, -PH, Ld.zMax, PH, Ld.passZ0, pathM, 0.03);
      for (const sd of [-1, 1]) this.wall(P, sd * pw, Ld.zMax, sd * (pw + WALL_T), Ld.passZ0, look);
      const arrowM = E.mat('#ffd21a', { emissive: '#ffb800', emissiveIntensity: 0.35, layer: 3 });
      for (let z = Ld.passZ0 - 6; z > Ld.gateZ + 6; z -= 9) {
        const a = arrowMesh(arrowM); a.position.set(0, 0.07, z); P.stat(a, { cast: false });
      }
      this.buildGate(i, P, lair, look);
      // --- room ground, path, walls
      // room ground stops at zMin: the next passage's ground starts there (never two grounds on top of each other)
      this.ground(R, -hw - WALL_T, Ld.zMin, hw + WALL_T, Ld.zMax, look.ground);
      this.stripe(R, -PH, Ld.zMin, PH, Ld.zMax, pathM, 0.03);
      for (const sd of [-1, 1]) {
        this.wall(R, sd * hw, Ld.zMin - WALL_T, sd * (hw + WALL_T), Ld.zMax + WALL_T, look);
        this.wall(R, sd * pw, Ld.zMax, sd * hw, Ld.zMax + WALL_T, look);
        if (i < 5) this.wall(R, sd * pw, Ld.zMin - WALL_T, sd * hw, Ld.zMin, look);
      }
      if (i === 5) {
        this.wall(R, -pw, Ld.zMin - WALL_T, pw, Ld.zMin, look);
        for (const sd of [-1, 1]) this.wall(R, sd * pw, Ld.zMin - WALL_T, sd * hw, Ld.zMin, look);
      }
      // arrows on the room path toward the nests
      for (let z = Ld.zMax - 8; z > Ld.zMax - 40; z -= 10) { const a = arrowMesh(arrowM); a.position.set(0, 0.07, z); R.stat(a, { cast: false }); }
      // hills outside
      for (const sd of [-1, 1]) this.hills(R, sd, Ld.passZ0, Ld.zMin - 10, look, rng, look.hills || {});
      // nests + great nest
      this.buildNests(i, R, lair, look, rng);
      // biome dressing + wall decor (the banner / torch strips on the walls are reserved first: no decor in front of them)
      for (let z = Ld.zMax - 18; z > Ld.zMin + 10; z -= 30) for (const sd of [-1, 1]) this.reserve(sd * (hw - 3.2), z - 9, sd * hw, z + 9, 'wallDecor');
      for (const sd of [-1, 1]) this.reserve(sd * 26, Ld.zMax - 3.2, sd * hw, Ld.zMax, 'wallDecor');
      DECOR[id].call(this, R, lair, look, rng);
      this.wallDecor(R, lair, look, rng);
      // logic markers
      if (sp) lair.drakeSpawns.length = Math.max(0, sp.drakes);
    },

    buildGate: function (i, S, lair, look) {
      const E = SE.Env, Ld = LAYOUT.lairs[i], self = this;
      const gz = Ld.gateZ;
      const gate = this.clone('prop.lair_gate', { cloneMaterials: true });
      const grp = new T.Group(); grp.position.set(0, 0, gz);
      let portcullis = null;
      if (gate) {
        gate.traverse(function (o) {
          const m = o.material; if (!m || !m.color) return;
          if (m.name === 'stone') m.color.set(look.gateStone || look.wall);
          else if (m.name === 'stone_dark') m.color.set(look.gateStoneDark || shade(look.gateStone || look.wall, -0.25));
        });
        grp.add(gate);
        portcullis = SE.Assets.getPart(gate, 'portcullis');
        const fires = ['fire_L', 'fire_R'].map(function (n) { return SE.Assets.getPart(gate, n); }).filter(Boolean);
        const board = SE.Assets.getPart(gate, 'sign_board');
        if (portcullis && portcullis.parent) portcullis.parent.remove(portcullis);
        fires.forEach(function (f) { if (f.parent) f.parent.remove(f); });
        grp.updateMatrixWorld(true);
        S.stat(grp);
        const bb = board ? new T.Box3().setFromObject(board) : null;
        const sb = E.signBoard({
          w: 11.6, h: 2.4, style: 'wood', noBoard: true, transparent: true, px: 60,
          text: function () {
            const name = SE.DragonData ? SE.DragonData.lairName(lair.species) : lair.species;
            if (lair.unlocked) return name;
            const price = SE.State && SE.State.lairPrice ? SE.State.lairPrice(i) : (species(i) ? species(i).unlockPrice : 0);
            return name + ' · ' + money(price);
          }
        });
        this.label(sb); lair.gateSign = sb;
        sb.mesh.position.set(0, bb ? (bb.min.y + bb.max.y) / 2 : 18.5, bb ? bb.max.z + 0.04 : gz + 2.6);
        S.dyn(sb.mesh);
        fires.forEach(function (f) {
          const w = new T.Group(); w.position.set(f.position.x, f.position.y, gz + f.position.z); f.position.set(0, 0, 0); w.add(f);
          S.dyn(markDynamic(w)); S.anim.push({ k: 'fire', o: w, ph: Math.random() * 6 });
        });
        if (portcullis) {
          const ph = new T.Group(); ph.position.set(0, 0, gz); ph.add(portcullis); markDynamic(ph); S.dyn(ph);
          lair.portcullisY = 0;
        }
      }
      this.addBox(-16.4, gz, 4.6, 6, 21); this.addBox(16.4, gz, 4.6, 6, 21);
      const col = this.addBox(0, gz, 28.4, 3, 21, { id: 'gate' + i });
      this.reserve(-20, gz - 4, 20, gz + 4, 'gate');
      lair.gate = { x: 0, z: gz, collider: col, group: grp, portcullis: portcullis };
      // recommended speed sign (ref map-ref-3)
      if (lair.recommendedSpeed > 0) {
        const rs = Ld.recSign;
        const sb = E.signBoard({
          w: 5.4, h: 3, px: 80, style: 'orange',
          draw: function (ctx, w, h) {
            E.drawBoard(ctx, w, h, 'orange', false);
            const pad = E.boardPad(w, h);
            // row 1: bolt icon + speed number (measured, centred); row 2: "recommended" fitted to the inner width
            E.iconText(ctx, { x0: pad.x, x1: w - pad.x, cy: h * 0.39, maxH: h * 0.44, size: h * 0.44, text: String(lair.recommendedSpeed),
              fill: '#ffffff', stroke: '#5a2a08', iconW: 0.7, iconScale: 1.15, gap: 0.12, drawIcon: drawBolt });
            E.outlinedText(ctx, t('world.recSpeed'), w / 2, h * 0.77, Math.round(h * 0.2), '#fff2d0', '#5a2a08', w - 2 * pad.x, 0, h * 0.24);
          }
        });
        this.label(sb);
        const g = new T.Group(); sb.mesh.position.set(0, 3.6, 0.22); g.add(sb.mesh);
        g.add(E.at(E.box(5.8, 3.3, 0.35, E.mat('#7a3a10')), 0, 3.6, 0)); g.add(E.at(E.box(0.6, 3.6, 0.6, E.mat('#4a2f1e')), 0, 1.4, -0.1));
        g.position.set(rs.x, 0, rs.z); g.rotation.y = rs.ry; g.rotation.z = -0.06; S.stat(g);
        this.addBox(rs.x, rs.z, 1, 1, 4); this.reserveR(rs.x, rs.z, 3.6, 'sign');
      }
      const it = hintObj({ type: 'lairGate', x: 0, z: gz + 7, r: 9, lairIndex: i });
      lair.gateInteractable = it;
    },

    buildNests: function (i, R, lair, look, rng) {
      const E = SE.Env, Ld = LAYOUT.lairs[i], id = BIOMES[i], self = this, GN = LAYOUT.greatNest;
      const gn = this.clone('prop.great_nest');
      if (gn) {
        // lift so the lowest stones touch the ground (the GLB dips 0.13 below its origin)
        const lift = propLift('prop.great_nest', GN.scaleY);
        gn.scale.set(GN.scale, GN.scaleY, GN.scale); gn.position.set(Ld.greatNest.x, lift, Ld.greatNest.z); gn.rotation.y = i * 1.3; R.stat(gn);
        const ss = SE.Assets.getPart(gn, 'sleep_spot');
        const y = (ss ? ss.position.y * GN.scaleY : 0.45) + lift;
        lair.guardianSpawn.y = lair.greatNest.y = y;   // SE.DragonAI reads greatNest.y for the sleeping height
      }
      this.reserveR(Ld.greatNest.x, Ld.greatNest.z, Ld.greatNest.r + 1, 'nest');
      // a few decorative eggs just outside the rim, on the side facing the room
      const eggKey = 'egg.' + id, hasEgg = SE.Assets && SE.Assets.has && SE.Assets.has(eggKey);
      Ld.nests.forEach(function (n, k) {
        const nm = E.nest(rng, { scale: 0.36 }); nm.position.set(n.x, 0.05, n.z); R.stat(nm);
        self.reserveR(n.x, n.z, 4.5, 'nest');
        const rig = makeEggRig(id, 1.6);
        rig.group.position.set(n.x, 0.45, n.z); rig.group.rotation.y = rng() * 6.28;
        markDynamic(rig.group); R.dyn(rig.group);
        if (hasEgg) for (let e = 0; e < 2; e++) {
          const de = SE.Assets.get(eggKey); const a = rng() * 6.28;
          de.scale.setScalar(0.55 + rng() * 0.15); de.position.set(n.x + Math.cos(a) * 3.9, 0.02, n.z + Math.sin(a) * 3.9);
          de.rotation.set((rng() - 0.5) * 0.3, rng() * 6, (rng() - 0.5) * 0.3); R.stat(de, { cast: false });
        }
        const nest = {
          index: self.nests.length, lair: i, lairRef: lair, x: n.x, z: n.z, taken: false, respawn: 0,
          eggMesh: rig.group, eggRig: rig, species: id, baseY: 0.45, phase: rng() * 6, pop: 1, baseScale: rig.group.scale.x || 1
        };
        self.nests.push(nest); lair.nests.push(nest);
        self.interactables.push(hintObj({ type: 'nest', x: n.x, z: n.z, r: 5.5, nest: nest, lairIndex: i }));
        R.anim.push({ k: 'nest', nest: nest });
      });
      if (hasEgg) {
        const toC = Math.atan2(Ld.zc - Ld.greatNest.z, -Ld.greatNest.x), rr = Ld.greatNest.r + 1.6;
        for (let e = 0; e < 3; e++) {
          const de = SE.Assets.get(eggKey), a = toC + (e - 1) * 0.42;
          de.scale.setScalar(0.8); de.position.set(Ld.greatNest.x + Math.cos(a) * rr, 0.02, Ld.greatNest.z + Math.sin(a) * rr); de.rotation.y = rng() * 6;
          R.stat(de, { cast: false });
        }
      }
    },

    /* banners / torches / lights along the room walls */
    wallDecor: function (R, lair, look, rng) {
      const E = SE.Env, Ld = LAYOUT.lairs[lair.index], hw = LAIR_W / 2;
      for (let z = Ld.zMax - 18; z > Ld.zMin + 10; z -= 30) {
        for (const sd of [-1, 1]) {
          const b = E.bannerMesh(lair.index); b.position.set(sd * (hw - 0.3), 15, z); b.rotation.y = -sd * PI / 2; R.stat(b, { cast: false });
          R.stat(E.at(E.box(0.5, 0.4, 3.6, E.mat('#5b3d29')), sd * (hw - 0.4), 17.6, z), { cast: false });
          if (look.torches) {
            for (const dz of [-7, 7]) {
              const tq = E.torch(); tq.position.set(sd * (hw - 0.6), 8, z + dz); tq.rotation.z = sd * 0.35; R.stat(tq, { cast: false });
            }
          }
        }
      }
      // inner face of the south wall next to the entrance
      for (const sd of [-1, 1]) for (let x = 28; x < hw - 4; x += 16) {
        const b = E.bannerMesh(lair.index); b.position.set(sd * x, 15, Ld.zMax - 0.3); b.rotation.y = PI; R.stat(b, { cast: false });
      }
    },

    /* ---------------- guide (tutorial / navigation) ---------------- */
    buildGuide: function () {
      const E = SE.Env;
      const g = new T.Group(); g.visible = false; g.name = 'guide';
      const beamM = new T.MeshBasicMaterial({ color: '#ffe14a', transparent: true, opacity: 0.35, depthWrite: false, blending: T.AdditiveBlending, fog: false });
      const beam = new T.Mesh(new T.CylinderGeometry(1.6, 2.4, 40, 12, 1, true), beamM); beam.position.y = 20; g.add(beam);
      const ring = new T.Mesh(new T.RingGeometry(3.2, 4.2, 32), new T.MeshBasicMaterial({ color: '#ffe14a', transparent: true, opacity: 0.8, depthWrite: false, side: T.DoubleSide }));
      ring.rotation.x = -PI / 2; ring.position.y = 0.12; g.add(ring);
      const arrows = new T.InstancedMesh(arrowGeo(), new T.MeshBasicMaterial({ color: '#ffd21a', transparent: true, opacity: 0.95, depthWrite: false }), 14);
      arrows.count = 0; arrows.frustumCulled = false;
      this.root.add(g); this.root.add(arrows);
      g.userData.dynamic = true; arrows.userData.dynamic = true; beam.userData.dynamic = true; ring.userData.dynamic = true;
      this._guide = { group: g, beam: beam, ring: ring, arrows: arrows, target: null, t: 0 };
    },
    setGuideTarget: function (x, z) {
      const G = this._guide; if (!G) return;
      if (x === null || x === undefined || (typeof x === 'object' && x === null)) { G.target = null; G.group.visible = false; G.arrows.count = 0; return; }
      if (typeof x === 'object') { z = x.z; x = x.x; }
      G.target = { x: x, z: z }; G.group.position.set(x, 0, z); G.group.visible = true;
    },
    updateGuide: function (dt, time, p) {
      const G = this._guide; if (!G || !G.target || !p) return;
      G.ring.scale.setScalar(1 + 0.15 * Math.sin(time * 4));
      G.beam.material.opacity = 0.25 + 0.12 * Math.sin(time * 3);
      // polyline: player → valley centre at section boundaries → target
      const pts = [{ x: p.x, z: p.z }], tz = G.target.z;
      const bounds = [LAYOUT.base.zMin].concat(LAYOUT.lairs.map(function (l) { return l.zMin; }));
      const lo = Math.min(p.z, tz), hi = Math.max(p.z, tz), dir = tz < p.z ? -1 : 1;
      const cross = bounds.filter(function (b) { return b > lo && b < hi; }).sort(function (a, b) { return dir < 0 ? b - a : a - b; });
      cross.forEach(function (b) { pts.push({ x: 0, z: b - dir * 6 }); pts.push({ x: 0, z: b + dir * 6 }); });
      pts.push({ x: G.target.x, z: tz });
      const m = new T.Matrix4(), q = new T.Quaternion(), s = new T.Vector3(1, 1, 1), v = new T.Vector3(), up = new T.Vector3(0, 1, 0);
      let n = 0, dist = 5 + ((time * 6) % 7);
      for (let k = 0; k < pts.length - 1 && n < 14; k++) {
        const a = pts[k], b = pts[k + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
        if (L < 0.01) continue;
        const yaw = Math.atan2(b.x - a.x, b.z - a.z);
        while (dist < L && n < 14) {
          const f = dist / L; v.set(a.x + (b.x - a.x) * f, 0.15, a.z + (b.z - a.z) * f);
          if (Math.hypot(v.x - G.target.x, v.z - G.target.z) < 5) { dist = L; break; }
          q.setFromAxisAngle(up, yaw); m.compose(v, q, s); G.arrows.setMatrixAt(n++, m);
          dist += 7;
        }
        dist -= L;
      }
      G.arrows.count = n; G.arrows.instanceMatrix.needsUpdate = true;
    },

    /* ---------------- navigation ---------------- */
    buildNav: function () {
      const pts = this.navPoints, self = this;
      const push = function (z) { const lair = self.lairAt(0, z); pts.push({ x: 0, z: z, section: self.sectionAt(z), lair: lair ? lair.index : -1 }); };
      [LAYOUT.spawn.z, 36, 14, -8, LAYOUT.base.zMin + 2].forEach(push);
      for (let z = LAYOUT.base.zMin - 10; z >= LAYOUT.lairs[5].zMin + 20; z -= 20) push(z);
    },

    /* ---------------- queries ---------------- */
    sectionAt: function (z) {
      if (z > LAYOUT.base.zMin) return 0;
      for (let i = 0; i < 6; i++) if (z >= LAYOUT.lairs[i].zMin - WALL_T) return i + 1;
      return 6;
    },
    inSafeZone: function (x, z) {
      const B = LAYOUT.base;
      return z > LAYOUT.safeLineZ && z < B.zMax && x > B.xMin && x < B.xMax;
    },
    lairAt: function (x, z) {
      if (Math.abs(x) > LAIR_W / 2 + WALL_T) return null;
      for (let i = 0; i < this.lairs.length; i++) {
        const l = this.lairs[i];
        if (z >= l.zMin && z <= l.passZ) return l;
      }
      return null;
    },
    zoneAt: function (x, z) {
      if (!this._zones) {
        const mk = function (key, color, emoji, nameFn, lair) {
          const o = { key: key, color: color, emoji: emoji, lair: lair };
          Object.defineProperty(o, 'name', { enumerable: true, get: nameFn });
          return o;
        };
        this._zones = {
          base: mk('base', ZONE_META.base.color, ZONE_META.base.emoji, function () { return t('world.zone.base'); }, -1),
          valley: mk('valley', ZONE_META.valley.color, ZONE_META.valley.emoji, function () { return t('world.zone.valley'); }, -1),
          lairs: BIOMES.map(function (id, i) {
            const sp = species(i);
            return mk(id, sp ? sp.color : '#7cc243', sp ? sp.emoji : '🐉', function () { return SE.DragonData ? SE.DragonData.lairName(id) : id; }, i);
          })
        };
      }
      if (z > LAYOUT.base.zMin) return this._zones.base;
      for (let i = 5; i >= 0; i--) {
        const l = LAYOUT.lairs[i];
        if (z >= l.zMin - WALL_T && z < l.gateZ - 3) return this._zones.lairs[i];
      }
      for (let i = 1; i < 6; i++) if (z >= LAYOUT.lairs[i].gateZ - 3 && z <= LAYOUT.lairs[i].passZ0) return this._zones.lairs[i - 1];
      return this._zones.valley;
    },

    /* ---------------- atmosphere ---------------- */
    atmosphereAt: function (z) {
      const out = this._atm || (this._atm = {
        fog: new T.Color(), sky: new T.Color(), skyTop: new T.Color(), sunColor: new T.Color(), hemiSky: new T.Color(), hemiGround: new T.Color(),
        sunIntensity: 1, exposure: 1.05, fogNear: 160, fogFar: 700, stars: 0, particles: null
      });
      let a = -1, b = -1, f = 0;
      const Lz = LAYOUT.lairs;
      if (z > LAYOUT.base.zMin) { a = b = -1; }
      else {
        let found = false;
        for (let i = 0; i < 6 && !found; i++) {
          const l = Lz[i];
          if (z <= l.passZ0 && z > l.zMax) { a = i - 1; b = i; f = (l.passZ0 - z) / PASS_L; found = true; }
          else if (z <= l.zMax && z >= l.zMin - WALL_T) { a = b = i; found = true; }
        }
        if (!found) a = b = 5;
      }
      f = f * f * (3 - 2 * f);
      const A = ambience(a), B = ambience(b);
      if (!A || !B) return out;
      const c1 = this._c1 || (this._c1 = new T.Color()), c2 = this._c2 || (this._c2 = new T.Color());
      const mix = function (dst, ka, kb) { dst.copy(c1.set(A[ka] || A[kb] || '#ffffff')).lerp(c2.set(B[ka] || B[kb] || '#ffffff'), f); };
      mix(out.fog, 'fog'); mix(out.sky, 'sky'); mix(out.skyTop, 'skyTop', 'sky'); mix(out.sunColor, 'sun');
      mix(out.hemiSky, 'hemiSky'); mix(out.hemiGround, 'hemiGround');
      const lerp = function (k, d) { const va = A[k] !== undefined ? A[k] : d, vb = B[k] !== undefined ? B[k] : d; return va + (vb - va) * f; };
      out.sunIntensity = lerp('sunIntensity', 1); out.exposure = lerp('exposure', 1.05);
      out.fogNear = lerp('fogNear', 160); out.fogFar = lerp('fogFar', 700);
      out.stars = (a === 5 ? 1 - f : 0) + (b === 5 ? f : 0); if (a === 5 && b === 5) out.stars = 1;
      out.particles = (f < 0.5 ? A : B).particles || null;
      return out;
    },
    updateAtmosphere: function (z) {
      const a = this.atmosphereAt(z), sc = this.scene;
      if (sc && sc.fog) { sc.fog.color.copy(a.fog); sc.fog.near = a.fogNear; sc.fog.far = a.fogFar; }
      if (sc && sc.background && sc.background.isColor) sc.background.copy(a.sky);
      if (this.sky) {
        const u = this.sky.material.uniforms;
        u.top.value.copy(a.skyTop); u.horizon.value.copy(a.sky); u.bottom.value.copy(a.fog);
        u.sunColor.value.copy(a.sunColor); u.stars.value = a.stars; u.time.value = this._time;
        u.sunDir.value.copy(this.sunOffset).normalize();
      }
      if (this.sun) { this.sun.color.copy(a.sunColor); this.sun.intensity = SUN_I * a.sunIntensity; }
      if (this.hemi) { this.hemi.color.copy(a.hemiSky); this.hemi.groundColor.copy(a.hemiGround); }
      if (this.renderer && this.renderer.toneMappingExposure !== undefined && this.autoExposure !== false) this.renderer.toneMappingExposure = a.exposure;
      if (a.particles !== this._ambKey) this.setAmbientParticles(a.particles);
      return a;
    },
    setAmbientParticles: function (name) {
      this._ambKey = name;
      if (this._ambHandle && this._ambHandle.stop) { try { this._ambHandle.stop(); } catch (e) { /* ignore */ } }
      this._ambHandle = null;
      if (!name || !SE.FX || !SE.FX.attach) return;
      if (!fxHas(name)) return;
      if (!this._ambAnchor) { this._ambAnchor = new T.Object3D(); this._ambAnchor.userData.dynamic = true; this.scene.add(this._ambAnchor); }
      try { this._ambHandle = SE.FX.attach(name, this._ambAnchor, { ambient: true }); } catch (e) { this._ambHandle = null; }
    },

    /* ---------------- state-driven changes ---------------- */
    // lair.unlocked = the real (bought) state; lair.trial = temporary trial-raid opening; lair.gateOpen = physical gate
    setLairUnlocked: function (i, unlocked, instant) {
      const l = this.lairs[i]; if (!l) return;
      unlocked = !!unlocked || i === 0;
      const changed = l.unlocked !== unlocked || l._init !== true;
      l.unlocked = unlocked; l._init = true;
      this.applyGate(i, instant);
      if (changed && l.gateSign) l.gateSign.redraw();
    },
    /* Trial raid: opens lair i's gate (portcullis slides open, collider off) regardless of SE.State;
       the periodic state sync keeps it open. setLairTrial(i, false) closes it again unless the lair is really unlocked. */
    setLairTrial: function (i, on) {
      const l = this.lairs[i]; if (!l) return;
      const was = !!l.trial;
      l.trial = !!on;
      if (was !== l.trial) this.applyGate(i, false);
    },
    applyGate: function (i, instant) {
      const l = this.lairs[i]; if (!l) return;
      const open = !!(l.unlocked || l.trial);
      l.gateOpen = open;
      if (l.gate && l.gate.collider) { l.gate.collider.solid = !open; l.gate.collider.disabled = open; }
      // open (bought or trial): the portcullis slides 17 down into the ground. (Raising it would leave the 17-tall grid
      // sticking out above the 20-tall arch: floating geometry.)
      l.portTarget = open ? -17 : 0;
      const pc = l.gate && l.gate.portcullis;
      if (pc) {
        if (instant || l.portcullisY === undefined) { l.portcullisY = l.portTarget; pc.position.y = l.portTarget; }
        pc.visible = l.portTarget !== -17 || l.portcullisY !== -17;
      }
      const list = this.interactables, it = l.gateInteractable;
      const idx = it ? list.indexOf(it) : -1;
      if (it && !open && i > 0 && idx < 0) list.push(it);
      if (it && open && idx >= 0) list.splice(idx, 1);
    },
    setHatcheryLocked: function (i, locked) {
      const h = this.hatcheries[i]; if (!h) return;
      locked = !!locked;
      if (h.locked === locked) return;
      h.locked = locked;
      h.lockGroup.visible = locked; h.bar.visible = locked;
      if (locked) h.lockLabel.redraw();
    },
    setHatcheryBanner: function (i, speciesId) {
      const h = this.hatcheries[i]; if (!h) return;
      const idx = speciesId ? BIOMES.indexOf(speciesId) : -1;
      if (h.species === idx) return;
      h.species = idx;
      SE.Env.setBannerEmblem(h.banner, idx);
    },
    setHatcheryLabel: function (i, text, color) { const h = this.hatcheries[i]; if (h) h.stateLabel.userData.setText(text || '', color); },
    setNestTaken: function (nest, taken, respawnSecs) {
      if (!nest) return;
      nest.taken = !!taken;
      if (taken) { nest.respawn = respawnSecs > 0 ? respawnSecs : 0; nest.eggMesh.visible = false; }
      else { nest.respawn = 0; nest.eggMesh.visible = true; nest.pop = 0; }
    },
    syncTreadmill: function () {
      const st = (SE.State && SE.State.data) || this.state; if (!st || !this.upgradeSign) return;
      const lv = st.treadmill || 1;
      if (this.upgradeSign.level === lv) return;
      this.upgradeSign.level = lv;
      const price = SE.State && SE.State.treadmillUpgradePrice ? SE.State.treadmillUpgradePrice() : null;
      if (price === null || price === undefined) this.upgradeSign.setText(t('world.upgrade.max'), t('world.upgrade.maxPrice'));
      else this.upgradeSign.setText(t('world.upgrade.level', lv, lv + 1), money(price));
    },
    syncState: function (instant) {
      const st = (SE.State && SE.State.data) || this.state; if (!st) { this.lairs.forEach((l, i) => this.setLairUnlocked(i, i === 0, true)); return; }
      const hs = st.hatcheries || [];
      for (let i = 0; i < this.hatcheries.length; i++) {
        const h = hs[i];
        this.setHatcheryLocked(i, !(h && h.unlocked));
        const spId = h && h.baby ? h.baby.species : h && h.egg ? h.egg.species : null;
        this.setHatcheryBanner(i, spId);
      }
      for (let i = 0; i < this.lairs.length; i++) {   // real state only; a trial opening (lair.trial) stays untouched
        const un = !!(st.lairs && st.lairs[i]) || i === 0;
        if (instant || this.lairs[i].unlocked !== un) this.setLairUnlocked(i, un, instant);
      }
      this.syncTreadmill();
      this.syncGift();
    },
    /* daily gift chest state: SE.Daily.canClaim() (labs / QA: World.giftForce = true|false overrides it) */
    syncGift: function () {
      const G = this.gift; if (!G) return;
      const D = SE.Daily;
      const ready = this.giftForce !== undefined && this.giftForce !== null ? !!this.giftForce : (D && D.canClaim ? !!D.canClaim() : true);
      let sub = t('world.gift.ready');
      if (!ready) {
        const sec = D && D.timeToNext ? Math.max(0, Math.round(D.timeToNext())) : 0;
        sub = sec > 0 ? t('world.gift.next', fmtTime(sec)) : '';
      }
      if (G.ready !== ready) {
        G.ready = ready;
        G.marker.visible = ready; G.beam.visible = ready;
        if (G.fx && G.fx.stop) { try { G.fx.stop(); } catch (e) { /* ignore */ } }
        G.fx = null;
        if (ready && SE.FX && SE.FX.attach && fxHas('gold_glints')) { try { G.fx = SE.FX.attach('gold_glints', G.anchor, { scale: 1.5, rate: 1.6 }); } catch (e) { G.fx = null; } }
      }
      if (G.sub !== sub) { G.sub = sub; G.sign.redraw(); }
    },
    animateGift: function (G, dt, time) {
      const ch = G.chest, want = G.ready ? 1 : 0;
      G.open += (want - G.open) * Math.min(1, dt * 3);
      const o = G.open;
      if (ch.lid) ch.lid.rotation.x = -o * (0.5 + 0.07 * Math.sin(time * 2.4));
      if (ch.model) { ch.model.position.y = o * (0.18 + 0.14 * Math.sin(time * 2.2)); ch.model.rotation.z = o * 0.03 * Math.sin(time * 1.7); }
      ch.glow.visible = o > 0.02;
      ch.glow.material.opacity = o * (0.32 + 0.14 * Math.sin(time * 2.6)); ch.glow.scale.setScalar(1 + 0.06 * Math.sin(time * 2.6));
      if (ch.gem && ch.gem.material && ch.gem.material.emissive) ch.gem.material.emissiveIntensity = 0.25 + o * (0.9 + 0.5 * Math.sin(time * 3.1));
      if (G.beam.visible) { G.beam.rotation.y += dt * 0.5; G.beam.children.forEach(function (b) { b.material.opacity = o * (0.55 + 0.2 * Math.sin(time * 3 + b.userData.ph)); }); }
      if (G.marker.visible) {
        G.marker.position.y = GIFT_BADGE_Y + Math.sin(time * 2.4) * 0.35;
        const s = 2.3 * (1 + 0.08 * Math.sin(time * 4.8)); G.marker.scale.set(s, s, 1);
      }
      if (G.ready && SE.FX && SE.FX.emit && fxHas('sparkle')) {
        G.sparkT -= dt;
        if (G.sparkT <= 0) { G.sparkT = 1.4 + Math.random() * 0.8; try { SE.FX.emit('sparkle', G.anchor.getWorldPosition(this._gv || (this._gv = new T.Vector3())), { scale: 1.2 }); } catch (e) { G.sparkT = 1e9; } }
      }
    },
    refreshLabels: function () {
      for (let i = 0; i < this.labels.length; i++) { try { this.labels[i].redraw(); } catch (e) { /* ignore */ } }
      if (this.upgradeSign) { this.upgradeSign.level = null; this.syncTreadmill(); }
    },

    /* ---------------- per frame ---------------- */
    setCulling: function (on) { this.culling = on !== false; this.curSection = -1; },
    update: function (dt, time, playerPos) {
      if (!this.root) return;
      this._time = time || 0;
      const p = playerPos || this.spawn;
      // section culling (rooms: current ±1, passages: current ±2)
      const cs = this.sectionAt(p.z);
      if (cs !== this.curSection) {
        this.curSection = cs;
        this.sections[0].group.visible = !this.culling || cs <= 1;
        for (let i = 0; i < 6; i++) {
          const k = i + 1;
          this.rooms[i].group.visible = this.rooms[i].visible = !this.culling || Math.abs(k - cs) <= 1;
          this.passages[i].group.visible = this.passages[i].visible = !this.culling || Math.abs(k - cs) <= 2;
        }
        this.sections[0].visible = this.sections[0].group.visible;
      }
      // sun + sky follow the player
      if (this.sun) {
        const step = 150 / (this.sun.shadow.mapSize.x || 1024) * 4;
        const sx = Math.round(p.x / step) * step, sz = Math.round(p.z / step) * step;
        this.sun.target.position.set(sx, 0, sz); this.sun.position.set(sx + this.sunOffset.x, this.sunOffset.y, sz + this.sunOffset.z);
        this.sun.target.updateMatrixWorld();
      }
      if (this.sky) this.sky.position.set(p.x, 0, p.z);
      if (this.clouds) { this.clouds.position.set(p.x * 0.6, 0, p.z * 0.6); this.clouds.rotation.y += dt * 0.004; }
      if (this._ambAnchor) this._ambAnchor.position.set(p.x, p.y || 0, p.z);
      if (!this._fxTried && SE.FX && SE.FX.attach) {
        this._fxTried = true;
        if (this._safeAnchor && fxHas('safe_line_glow')) { try { this._safeFx = SE.FX.attach('safe_line_glow', this._safeAnchor, { width: PASS_W }); } catch (e) { this._safeFx = null; } }
        this._ambKey = undefined;
      }
      this.updateAtmosphere(p.z);
      // state sync (cheap, twice a second)
      this._syncT -= dt;
      if (this._syncT <= 0) { this._syncT = 0.5; this.syncState(false); }
      // animations of visible sections
      const lists = this._animLists || (this._animLists = [this.sections[0], this.global].concat(this.passages, this.rooms));
      for (let s = 0; s < lists.length; s++) {
        const S = lists[s];
        if (!S.visible && S !== this.sections[0]) continue;
        if (S === this.sections[0] && !S.group.visible) continue;
        for (let k = 0; k < S.anim.length; k++) this.animate(S.anim[k], dt, time);
      }
      // nests: respawn timers run everywhere
      for (let k = 0; k < this.nests.length; k++) {
        const n = this.nests[k];
        if (n.taken && n.respawn > 0) {
          n.respawn -= dt;
          if (n.respawn <= 0) { this.setNestTaken(n, false); if (this.onNestRespawn) this.onNestRespawn(n); }
        }
      }
      // portcullis animation
      for (let i = 0; i < this.lairs.length; i++) {
        const l = this.lairs[i], pc = l.gate && l.gate.portcullis;
        if (!pc || l.portTarget === undefined || l.portcullisY === l.portTarget) continue;
        const d = l.portTarget - l.portcullisY, st = Math.sign(d) * Math.min(Math.abs(d), dt * 12);
        l.portcullisY += st; pc.position.y = l.portcullisY + (Math.abs(d) > 0.5 ? Math.sin(time * 40) * 0.05 : 0);
        if (l.portcullisY === l.portTarget) pc.visible = l.portTarget !== -17;
      }
      this.updateGuide(dt, time, p);
    },
    animate: function (a, dt, time) {
      switch (a.k) {
        case 'nest': {
          const n = a.nest, g = n.eggMesh;
          if (n.taken || !g.visible) break;
          if (n.pop < 1) { n.pop = Math.min(1, n.pop + dt * 2.5); const s = easeBack(n.pop) * n.baseScale; g.scale.setScalar(s); }
          g.position.y = n.baseY + 0.3 + Math.sin(time * 2 + n.phase) * 0.28;
          g.rotation.y += dt * 0.7;
          if (n.eggRig.update) n.eggRig.update(dt);
          break;
        }
        case 'wheel': a.o.rotation.z -= dt * 0.35; break;
        case 'belt': a.tex.offset.y = (a.tex.offset.y + dt * 1.6) % 1; break;
        case 'fire': { const s = 1 + Math.sin(time * 11 + a.ph) * 0.08 + Math.sin(time * 23 + a.ph) * 0.05; a.o.scale.set(s, 1 + (s - 1) * 2.4, s); break; }
        case 'chest': this.animateGift(a.g, dt, time); break;
        case 'safeline': a.o.material.opacity = 0.82 + 0.18 * Math.sin(time * 3); break;
        case 'vendor': try { a.ch.update(dt, false, 0, true); } catch (e) { a.k = 'none'; } break;
        case 'lava': a.tex.offset.x = (a.tex.offset.x + dt * a.sx) % 1; a.tex.offset.y = (a.tex.offset.y + dt * a.sy) % 1; break;
        case 'floaters': {
          const m = this._m4 || (this._m4 = new T.Matrix4()), q = this._q || (this._q = new T.Quaternion()), v = this._v || (this._v = new T.Vector3()), sc = this._s || (this._s = new T.Vector3());
          const e = this._e || (this._e = new T.Euler());
          for (let k = 0; k < a.items.length; k++) {
            const it = a.items[k];
            v.set(it.x, it.y + Math.sin(time * 0.9 + it.ph) * 1.2, it.z); e.set(0.3, time * 0.4 + it.ph, 0.2); q.setFromEuler(e); sc.set(it.s, it.s * 1.8, it.s);
            m.compose(v, q, sc); a.mesh.setMatrixAt(k, m);
          }
          a.mesh.instanceMatrix.needsUpdate = true; break;
        }
        case 'spin': a.o.rotation.y += dt * a.v; break;
        case 'spinX': a.o.rotation.x += dt * a.v; break;
        default: break;
      }
    },
    stats: function () {
      const out = {};
      [this.global, this.sections[0]].concat(this.passages, this.rooms).forEach(function (s) { if (s && s.stats) out[s.name] = s.stats; });
      return out;
    }
  };

  /* ====================================================================== */
  /* biome looks + dressing                                                   */
  /* ====================================================================== */
  function shade(hex, k) { const c = new T.Color(hex); const h = {}; c.getHSL(h); c.setHSL(h.h, h.s, Math.max(0, Math.min(1, h.l + k))); return '#' + c.getHexString(); }
  const LOOKS = {
    meadow: function (a) { return { ground: '#66c03c', wall: a.wall || '#c98a4b', cap: a.wallCap || '#5cb83a', path: a.path || '#efe2b8', leaf: '#4fae3a', leaf2: '#3e9932', gateStone: '#b4aea8', hillTop: '#5cb83a', hillSide: '#a8743e', hills: { tree: 0.5 } }; },
    mosswood: function (a) { return { ground: '#367c34', wall: '#7a6a44', cap: a.wallCap || '#3f9a3a', path: a.path || '#cbbb8c', leaf: '#2f7a3a', leaf2: '#245f30', gateStone: '#8a9a7a', hillTop: '#2f7a3a', hillSide: '#5a4a30', torches: true, hills: { tree: 0.85, hBase: 24, tree3: function (r) { return SE.Env.voxelTree(r, { scale: 1.6 + r() * 0.6, leaf: '#2f6e3a', leaf2: '#245a30', tall: true }); } } }; },
    amber: function (a) { return { ground: a.ground || '#e8b85a', wall: a.wall || '#d4a050', cap: '#e8c070', capDark: '#b8862e', path: a.path || '#f5e2b0', leaf: '#8aa83a', leaf2: '#6a8a2a', gateStone: '#d8b070', hillTop: '#e8c070', hillSide: '#c88a40', hills: { tree: 0, hBase: 26, hStep: 9 } }; },
    frost: function (a) { return { ground: a.ground || '#dff2ff', wall: a.wall || '#a8cce8', cap: '#ffffff', capDark: '#cfe6f6', path: a.path || '#f5fbff', leaf: '#2f6a5a', leaf2: '#285a4e', snow: true, gateStone: '#c8dcec', hillTop: '#ffffff', hillSide: '#8fb4d4', hills: { tree: 0.6, hBase: 28, hStep: 8, tree3: function (r) { return SE.Env.pineTree(r, { scale: 1.5 + r() * 0.5, snow: true, leaf: '#2f6a5a' }); } } }; },
    ember: function (a) { return { ground: '#4a3b38', wall: '#3d3434', cap: a.wallCap || '#c84a1a', capDark: '#7a2a10', path: a.path || '#5a4a40', leaf: '#3a2a2a', leaf2: '#2a1a1a', gateStone: '#4a4044', gateStoneDark: '#2a2426', torches: true, hillTop: '#ff6a1a', hillSide: '#2a2426', hills: { tree: 0, hBase: 26, hStep: 10 } }; },
    aurora: function (a) { return { ground: '#ece6f2', wall: a.wall || '#efe6d0', cap: a.wallCap || '#e0b840', capDark: '#b88a20', path: '#f3dc8a', lanternPost: '#e8b830', leaf: '#f0e8ff', leaf2: '#d8c8ff', gateStone: '#f4efe4', gateStoneDark: '#d8c890', torches: true, hillTop: '#fff6e0', hillSide: '#c8bce8', hills: { tree: 0, hBase: 20, hStep: 12 } }; }
  };

  /* placement helper: keeps the centre path, nest approaches, drake spawns, entrance and exit clear; every candidate
     keeps its radius `r` (crown / footprint) inside the room walls and away from every reserved footprint
     (World.isClear); `keep` = radius reserved for the placed object so later decor does not grow into it. */
  function lairPlacer(lair, rng, margin) {
    const Ld = LAYOUT.lairs[lair.index], hw = LAIR_W / 2, W = World;
    return function (opts) {
      opts = opts || {};
      const pad = opts.pad || 0, r = opts.r || Math.max(0.8, 2.5 + pad);
      const xMax = hw - 0.9 - r;
      for (let tries = 0; tries < 80; tries++) {
        let x;
        if (opts.edge) { const sd = rng() < 0.5 ? -1 : 1; x = sd * E_rr(rng, Math.max(12, xMax - opts.edge), xMax); }
        else x = E_rr(rng, -xMax, xMax);
        const z = E_rr(rng, Ld.zMin + 0.9 + r, Ld.zMax - 0.9 - r);
        if (Math.abs(x) < Math.max(11 + pad + (margin || 0), LAYOUT.lairPathHalf + 0.8 + r)) continue;
        if (Ld.zMax - z < 24 && Math.abs(x) < 30) continue;                 // entrance
        if (lair.index < 5 && z - Ld.zMin < 10 + r && Math.abs(x) < 22 + r) continue;   // exit to the next passage
        let bad = false;
        for (const n of Ld.nests) {
          if (Math.hypot(x - n.x, z - n.z) < 10 + pad) { bad = true; break; }
          if (Math.abs(z - n.z) < 5 + pad + r * 0.5 && x * n.x > 0 && Math.abs(x) < Math.abs(n.x)) { bad = true; break; }
        }
        if (bad) continue;
        if (Math.hypot(x - Ld.greatNest.x, z - Ld.greatNest.z) < Ld.greatNest.r + 3 + Math.max(0, pad) + r) continue;
        for (const d of Ld.drakes) if (Math.hypot(x - d.x, z - d.z) < 6 + pad) { bad = true; break; }
        if (bad || !W.isClear(x, z, r)) continue;
        if (opts.keep) W.reserveR(x, z, opts.keep, 'decor');
        return { x: x, z: z };
      }
      return null;
    };
  }
  function E_rr(rng, a, b) { return a + rng() * (b - a); }
  function place(R, world, obj, pos, col, statOpts) {
    if (!pos) return;
    obj.position.x = pos.x; obj.position.z = pos.z;
    R.stat(obj, statOpts);
    if (col) world.addBox(pos.x, pos.z, col[0], col[1] || col[0], col[2] || 6, { noCamera: col[3] });
  }
  function cloudPuff(rng) {
    const E = SE.Env, g = new T.Group(), m = E.mat('#ffffff', { emissive: '#f0e8ff', emissiveIntensity: 0.25 });
    for (let k = 0; k < 3 + Math.floor(rng() * 3); k++) {
      const p = new T.Mesh(new T.DodecahedronGeometry(1, 0), m), s = 1.4 + rng() * 1.6;
      p.scale.set(s * 1.3, s * 0.8, s); p.position.set((rng() - 0.5) * 5, s * 0.5, (rng() - 0.5) * 3); p.rotation.y = rng() * 3; g.add(p);
    }
    return g;
  }
  function count(n) { return Math.max(1, Math.round(n * World.density)); }
  function kenneyProp(key, sc, rng) {   // Kenney Nature Kit model in a group (scale, random yaw), origin on the ground
    const g = new T.Group(), m = SE.Env.kenney(key);
    if (m) { m.scale.setScalar(sc); m.rotation.y = rng() * 6.28; g.add(m); }
    return g;
  }
  function treeR(s) { return 5.9 * s + 0.6; }

  const DECOR = {
    meadow: function (R, lair, look, rng) {
      const E = SE.Env, P = lairPlacer(lair, rng), nat = E.natureRemap();
      for (let k = 0; k < count(16); k++) { const s = 1 + rng() * 0.4; place(R, this, E.voxelTree(rng, { scale: s }), P({ edge: 14, r: treeR(s), keep: 1.6 }), [2.2, 2.2, 9]); }
      for (let k = 0; k < count(8); k++) place(R, this, E.rock(rng, { color: '#a8a29a', cap: '#5cb83a' }), P({ r: 4.4, keep: 3 }), [3, 3, 2.5]);
      const kb = E.kenney('kenney.nature.plant_bushLarge');
      for (let k = 0; kb && k < count(16); k++) { const b = E.kenney('kenney.nature.plant_bushLarge'); const sc = 10 + rng() * 4; b.scale.setScalar(sc); const g = new T.Group(); g.add(b); place(R, this, g, P({ r: 0.19 * sc + 0.3, keep: 1.2 }), null, { remap: nat }); }
      for (let k = 0; k < count(140); k++) place(R, this, E.flower(rng), P({ pad: -3, r: 0.9 }), null, { cast: false, remap: nat });
      for (let k = 0; k < count(50); k++) place(R, this, E.grassTuft(rng), P({ pad: -3, r: 1.3 }), null, { cast: false, remap: nat });
    },
    mosswood: function (R, lair, look, rng) {
      const E = SE.Env, P = lairPlacer(lair, rng), nat = E.natureRemap({ colorRed: '#2fc8c0', _defaultMat: '#e6fffb', colorTan: '#2fc8c0', woodBark: '#5a3a20', leafsGreen: '#3f9a3a' });
      // a small pond with lilies (first: the rest of the decor keeps out of the water)
      const pp = P({ pad: 6, r: 8, keep: 7.4 });
      if (pp) { const pond = new T.Mesh(new T.CircleGeometry(7, 14), E.mat('#3aa8a0', { rough: 0.15, metal: 0.1, layer: 2 })); pond.rotation.x = -PI / 2; pond.position.set(pp.x, 0.05, pp.z); R.stat(pond, { cast: false }); }
      for (let k = 0; k < count(28); k++) { const s = 1.2 + rng() * 0.6; place(R, this, E.voxelTree(rng, { scale: s, leaf: k % 3 ? '#2f7a3a' : '#3a8a2e', leaf2: '#245f30', trunk: '#5a3a22', tall: true }), P({ edge: 18, r: treeR(s) * 0.92, keep: 1.8 }), [2.4, 2.4, 12]); }
      for (let k = 0; k < count(12); k++) { const s = 1.1 + rng() * 0.5; place(R, this, E.giantMushroom(rng, { scale: s }), P({ pad: 4, r: 5.2 * s, keep: 2.2 }), [2.2, 2.2, 7]); }
      for (let k = 0; k < count(7); k++) place(R, this, E.mossLog(rng), P({ pad: 2, r: 6.2, keep: 5 }), [6, 3, 2.5, true]);
      const mossBush = E.natureRemap({ leafsGreen: '#2f7a3a', leafsDark: '#245f30', grass: '#3f8a3a' });
      for (let k = 0; E.kenney('kenney.nature.plant_bushLarge') && k < count(12); k++) { const sc = 10 + rng() * 4; place(R, this, kenneyProp('kenney.nature.plant_bushLarge', sc, rng), P({ r: 0.19 * sc + 0.6, keep: 1.4 }), null, { remap: mossBush }); }
      const km = E.kenney('kenney.nature.mushroom_redGroup');
      for (let k = 0; km && k < count(30); k++) { const m = E.kenney('kenney.nature.mushroom_redGroup'); const sc = 9 + rng() * 6; m.scale.setScalar(sc); m.rotation.y = rng() * 6; const g = new T.Group(); g.add(m); place(R, this, g, P({ pad: -3, r: 0.15 * sc + 0.3 }), null, { cast: false, remap: nat }); }
      for (let k = 0; k < count(40); k++) place(R, this, E.grassTuft(rng, '#3f9a3a'), P({ pad: -3, r: 1.3 }), null, { cast: false, remap: E.natureRemap({ grass: '#3f8a3a' }) });
      // vines on the walls
      const Ld = LAYOUT.lairs[lair.index];
      for (let z = Ld.zMax - 6; z > Ld.zMin; z -= 7 + rng() * 6) for (const sd of [-1, 1]) {
        const v = E.vine(6 + rng() * 10); v.position.set(sd * (LAIR_W / 2 - 0.4), WALL_H, z); R.stat(v, { cast: false });
      }
    },
    amber: function (R, lair, look, rng) {
      const E = SE.Env, P = lairPlacer(lair, rng);
      for (let k = 0; k < count(12); k++) { const s = 0.7 + rng() * 0.7; place(R, this, E.dune(rng, { color: '#f0c470', size: s }), P({ pad: 2, r: 9 * s + 0.5, keep: 6 * s }), null, { cast: false }); }
      for (let k = 0; k < count(9); k++) place(R, this, E.sandPillar(rng, {}), P({ edge: 18, pad: 1, r: 3.8, keep: 3 }), [4.4, 4.4, 14]);
      for (let k = 0; k < count(14); k++) place(R, this, E.amberCrystal(rng, { scale: 1 + rng() * 0.6 }), P({ r: 3.4, keep: 2 }), [2.6, 2.6, 4]);
      for (let k = 0; k < count(16); k++) place(R, this, E.cactus(rng), P({ r: 3.6, keep: 1.4 }), [1.8, 1.8, 7]);
      for (let k = 0; k < count(4); k++) place(R, this, E.bones(rng), P({ pad: 3, r: 9.5, keep: 7 }), null);
      for (let k = 0; k < count(10); k++) place(R, this, E.rock(rng, { color: '#c89a5a', scale: 1.2 }), P({ r: 5, keep: 3.4 }), [3.4, 3.4, 3]);
    },
    frost: function (R, lair, look, rng) {
      const E = SE.Env, P = lairPlacer(lair, rng);
      for (let k = 0; k < 2; k++) {
        const rad = 8 + rng() * 3, pp = P({ pad: 7, r: rad * 1.3 + 1, keep: rad * 1.3 + 0.5 }); if (!pp) continue;
        const pond = new T.Mesh(new T.CircleGeometry(rad, 9), E.mat('#bfe8ff', { rough: 0.06, metal: 0.25, layer: 2 }));
        pond.rotation.x = -PI / 2; pond.scale.set(1.3, 1, 1); pond.position.set(pp.x, 0.05, pp.z); R.stat(pond, { cast: false });
      }
      for (let k = 0; k < count(20); k++) { const s = 1.1 + rng() * 0.6; place(R, this, E.pineTree(rng, { snow: true, scale: s, leaf: '#2f6a5a' }), P({ edge: 18, r: 3.6 * s + 0.6, keep: 1.4 }), [2, 2, 12]); }
      for (let k = 0; k < count(16); k++) place(R, this, E.iceCrystal(rng, { scale: 1 + rng() * 0.6 }), P({ r: 4.2, keep: 2.4 }), [3, 3, 6]);
      for (let k = 0; k < count(10); k++) place(R, this, E.rock(rng, { color: '#9ab4c8', cap: '#ffffff', scale: 1.1 }), P({ r: 4.6, keep: 3 }), [3.2, 3.2, 3]);
      // snowy Kenney rocks (dirt → icy blue stone, grass → snow cap)
      const icy = E.natureRemap({ dirt: '#a9c8e0', grass: '#ffffff', _defaultMat: '#e6f4ff' });
      for (let k = 0; E.kenney('kenney.nature.rock_tallA') && k < count(8); k++) { const sc = 5 + rng() * 2.5; place(R, this, kenneyProp('kenney.nature.rock_tallA', sc, rng), P({ r: 0.5 * sc + 0.6, keep: 0.4 * sc }), [0.7 * sc, 0.7 * sc, 0.95 * sc], { remap: icy }); }
    },
    ember: function (R, lair, look, rng) {
      const E = SE.Env, P = lairPlacer(lair, rng), Ld = LAYOUT.lairs[lair.index];
      // lava rivers along both side walls (first, reserved: nothing stands in the lava)
      for (const sd of [-1, 1]) {
        const len = Ld.zMax - Ld.zMin - 30, cz = (Ld.zMin + Ld.zMax) / 2 + 6, cx = sd * (LAIR_W / 2 - 5);
        const river = E.lavaPool(7, len);
        river.position.set(cx, 0, cz); R.stat(river, { cast: false });
        this.reserve(cx - 5, cz - len / 2 - 1.5, cx + 5, cz + len / 2 + 1.5, 'lava');
      }
      R.anim.push({ k: 'lava', tex: E.lavaMaterial().map, sx: 0.02, sy: 0.05 });
      for (let k = 0; k < count(5); k++) {
        const w = 8 + rng() * 6, d = 6 + rng() * 5, pp = P({ pad: 6, r: Math.max(w, d) / 2 + 2, keep: Math.max(w, d) / 2 + 1.4 }); if (!pp) continue;
        const pool = E.lavaPool(w, d); pool.position.set(pp.x, 0, pp.z); pool.rotation.y = rng() * 0.5; R.stat(pool, { cast: false });
        this.addBox(pp.x, pp.z, w, d, 0.6, { solid: false });
      }
      for (let k = 0; k < count(16); k++) place(R, this, E.obsidianSpike(rng, { scale: 1 + rng() * 0.6 }), P({ r: 4.6, keep: 2.6 }), [3, 3, 8]);
      for (let k = 0; k < count(12); k++) place(R, this, E.rock(rng, { color: '#3a3236', scale: 1.3 }), P({ r: 5.2, keep: 3.4 }), [3.6, 3.6, 3]);
      // glowing lava cracks in the basalt floor
      const crack = E.mat('#ff7a1a', { emissive: '#ff5a00', emissiveIntensity: 1.4 });
      for (let k = 0; k < count(26); k++) {
        const pp = P({ pad: -2, r: 6 }); if (!pp) continue;
        const g = new T.Group(); let x = 0, z = 0, a = rng() * 6.28;
        for (let s = 0; s < 3 + Math.floor(rng() * 3); s++) {
          const L2 = 2 + rng() * 2, seg = E.box(L2, 0.08, 0.45, crack);
          seg.position.set(x + Math.cos(a) * L2 / 2, 0.05, z + Math.sin(a) * L2 / 2); seg.rotation.y = -a; g.add(seg);
          x += Math.cos(a) * L2; z += Math.sin(a) * L2; a += (rng() - 0.5) * 1.6;
        }
        place(R, this, g, pp, null, { cast: false });
      }
      // dead trees
      for (let k = 0; k < count(8); k++) {
        const g = new T.Group(), m = E.mat('#1e1a1c'); const h = 7 + rng() * 4;
        g.add(E.at(E.box(1.3, h, 1.3, m), 0, h / 2, 0)); g.add(E.at(E.box(4, 0.8, 0.8, m), 1.4, h * 0.7, 0)); g.add(E.at(E.box(0.8, 3, 0.8, m), 3, h * 0.7 + 1.2, 0));
        g.rotation.y = rng() * 6; place(R, this, g, P({ edge: 16, r: 4, keep: 1.6 }), [1.6, 1.6, 8]);
      }
    },
    aurora: function (R, lair, look, rng) {
      const E = SE.Env, P = lairPlacer(lair, rng), Ld = LAYOUT.lairs[lair.index];
      // the end of the valley: a golden shrine against the north wall with crystal clusters (first: reserved)
      const zEnd = Ld.zMin, gold = E.mat('#e8b830', { metal: 0.55, rough: 0.35 }), pearl = E.mat('#f4efe4');
      const shrine = new T.Group();
      shrine.add(E.at(E.box(30, 2, 8, pearl), 0, 1, 0)); shrine.add(E.at(E.box(30.6, 0.6, 8.6, gold), 0, 2.2, 0));
      for (const sx of [-12, 12]) { shrine.add(E.at(E.box(3.4, 22, 3.4, pearl), sx, 13, 0)); shrine.add(E.at(E.box(4, 1, 4, gold), sx, 24.5, 0)); }
      shrine.add(E.at(E.box(28, 2.4, 3.6, pearl), 0, 26, 0)); shrine.add(E.at(E.box(29, 0.8, 4.2, gold), 0, 27.6, 0));
      const star = new T.Mesh(new T.OctahedronGeometry(3.2, 0), E.mat('#ffe680', { emissive: '#ffc020', emissiveIntensity: 0.9, metal: 0.3, rough: 0.3 }));
      star.position.set(0, 31.5, 0); star.scale.set(1, 1.5, 1); shrine.add(star);
      shrine.position.set(0, 0, zEnd + 5); R.stat(shrine);
      this.addBox(0, zEnd + 5, 30, 8, 3); this.reserve(-16, zEnd, 16, zEnd + 10, 'shrine');
      for (const sx of [-40, -26, 26, 40]) {
        const cc = E.iceCrystal(rng, { scale: 1.6 }); cc.position.set(sx, 0, zEnd + 6);
        R.stat(cc, { override: E.mat('#d8c8ff', { emissive: '#9a7aff', emissiveIntensity: 0.5, rough: 0.2, metal: 0.2 }) });
        this.reserveR(sx, zEnd + 6, 4.5, 'crystal');
      }
      // golden lanterns on the path sides
      for (let z = Ld.zMax - 20; z > Ld.zMin + 20; z -= 26) for (const sd of [-1, 1]) {
        const lp = E.lanternPost({ h: 7, post: '#f4efe4' }); lp.position.set(sd * 8, 0, z); lp.rotation.y = sd > 0 ? PI : 0; R.stat(lp);
        this.addBox(sd * 8, z, 0.9, 0.9, 7, { noCamera: true });
        this.reserve(sd * 8 - 1.5, z - 1.5, sd * 8 + (sd > 0 ? -3.2 : 3.2), z + 1.5, 'lantern');
      }
      for (let k = 0; k < count(10); k++) place(R, this, E.goldPillar(rng, false), P({ edge: 14, r: 2.8, keep: 2.2 }), [3.6, 3.6, 16]);
      for (let k = 0; k < count(7); k++) place(R, this, E.goldPillar(rng, true), P({ r: 4.6, keep: 3 }), [3.6, 3.6, 8]);
      for (let k = 0; k < count(3); k++) place(R, this, E.ruinArch(rng), P({ edge: 20, pad: 4, r: 8.6, keep: 7.4 }), null);
      for (let k = 0; k < count(14); k++) place(R, this, cloudPuff(rng), P({ r: 4.4, keep: 2.5 }), null, { cast: false });
      const nat = E.natureRemap({ stone: '#f4efe4', stoneDark: '#e0b840', _defaultMat: '#e8b830' });
      ['statue_obelisk', 'statue_column', 'statue_columnDamaged'].forEach((nm) => {
        for (let k = 0; k < count(3); k++) { const s = E.kenney('kenney.nature.' + nm); if (!s) break; const sc = 10 + rng() * 3; s.scale.setScalar(sc); const g = new T.Group(); g.add(s); place(R, this, g, P({ edge: 18, r: 0.16 * sc + 0.6, keep: 1.8 }), [3, 3, 10], { remap: nat }); }
      });
      // floating crystals (instanced, animated)
      const items = [];
      for (let k = 0; k < count(14); k++) {
        const pp = P({ pad: -4, r: 1.5 }); if (!pp) continue;
        items.push({ x: pp.x, z: pp.z, y: 7 + rng() * 9, s: 0.9 + rng() * 0.9, ph: rng() * 6 });
      }
      const cm = E.mat('#c8b8ff', { emissive: '#8a6aff', emissiveIntensity: 0.6, rough: 0.2, metal: 0.2 });
      const mesh = new T.InstancedMesh(E.floatingCrystalGeo(), cm, Math.max(1, items.length));
      mesh.count = items.length; mesh.castShadow = false; mesh.userData.dynamic = true; mesh.frustumCulled = false;
      R.dyn(mesh); R.anim.push({ k: 'floaters', mesh: mesh, items: items });
      this.animate({ k: 'floaters', mesh: mesh, items: items }, 0, 0);
    }
  };

  /* ====================================================================== */
  /* small geometry / drawing helpers                                         */
  /* ====================================================================== */
  let _arrowGeo = null;
  function arrowGeo() {
    if (_arrowGeo) return _arrowGeo;
    const s = new T.Shape();
    s.moveTo(0, 2.2); s.lineTo(2.4, -0.2); s.lineTo(1.3, -0.2); s.lineTo(1.3, -2); s.lineTo(-1.3, -2); s.lineTo(-1.3, -0.2); s.lineTo(-2.4, -0.2); s.closePath();
    const g = new T.ShapeGeometry(s);
    g.rotateX(-PI / 2);       // shape +Y → world −Z … we want the arrow to point along +Z of the instance
    g.rotateY(PI);
    return (_arrowGeo = g);
  }
  function arrowMesh(m) {
    const a = new T.Mesh(arrowGeo(), m);
    a.rotation.y = PI;        // static arrows point north (−Z)
    return a;
  }
  function makeEggRig(id, scale) {
    const DM = SE.DragonModels;
    if (DM && DM.createEgg) {
      try { const r = DM.createEgg(id, 0, scale); if (r && r.group) return r; } catch (e) { /* fall back */ }
    }
    const g = new T.Group();
    const key = 'egg.' + id;
    const egg = SE.Assets && SE.Assets.has && SE.Assets.has(key) ? SE.Assets.get(key) : null;
    if (egg) { egg.scale.setScalar(scale); g.add(egg); }
    else { const m = new T.Mesh(new T.SphereGeometry(0.9, 10, 8), SE.Env.mat('#e8e0c8')); m.scale.set(scale, scale * 1.3, scale); m.position.y = scale * 1.1; g.add(m); }
    const halo = egg && SE.Assets.getPart(egg, 'halo');
    return { group: g, update: function (dt) { if (halo) halo.rotation.y += dt * 1.5; }, setWobble: function () {} };
  }
  /* Board icons, drawn INSIDE a box centred at (x, y): height s, width ICON_W·s (used by E.iconText rows). */
  const LOCK_W = 0.86;
  function drawLock(ctx, x, y, s) {
    ctx.save();
    const lw = Math.max(2, s * 0.06), bw = s * 0.78, bh = s * 0.56, by = y + s * 0.5 - bh - lw / 2;
    ctx.lineCap = 'round';
    ctx.lineWidth = s * 0.15; ctx.strokeStyle = '#3a2416';            // shackle (dark outline, then steel)
    ctx.beginPath(); ctx.moveTo(x - s * 0.22, by + 2); ctx.lineTo(x - s * 0.22, y - s * 0.2); ctx.arc(x, y - s * 0.2, s * 0.22, PI, 0); ctx.lineTo(x + s * 0.22, by + 2); ctx.stroke();
    ctx.lineWidth = s * 0.08; ctx.strokeStyle = '#dcdce6';
    ctx.beginPath(); ctx.moveTo(x - s * 0.22, by + 2); ctx.lineTo(x - s * 0.22, y - s * 0.2); ctx.arc(x, y - s * 0.2, s * 0.22, PI, 0); ctx.lineTo(x + s * 0.22, by + 2); ctx.stroke();
    ctx.fillStyle = '#ffc928'; SE.Env.roundRect(ctx, x - bw / 2, by, bw, bh, s * 0.1); ctx.fill();
    ctx.lineWidth = lw; ctx.strokeStyle = '#3a2416'; ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x - bw / 2 + lw, by + lw, bw - 2 * lw, bh * 0.18);
    ctx.fillStyle = '#7a5010'; ctx.beginPath(); ctx.arc(x, by + bh * 0.42, s * 0.08, 0, 7); ctx.fill();
    ctx.fillRect(x - s * 0.03, by + bh * 0.42, s * 0.06, bh * 0.32);
    ctx.restore();
  }
  function drawBolt(ctx, x, y, s) {
    const k = s * 0.5;   // bolt spans y ± k, x ± 0.34 s
    ctx.save(); ctx.fillStyle = '#ffe14a'; ctx.strokeStyle = '#5a2a08'; ctx.lineWidth = Math.max(3, s * 0.07); ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(x + k * 0.22, y - k * 0.92); ctx.lineTo(x - k * 0.6, y + k * 0.12); ctx.lineTo(x - k * 0.04, y + k * 0.12);
    ctx.lineTo(x - k * 0.26, y + k * 0.92); ctx.lineTo(x + k * 0.62, y - k * 0.2); ctx.lineTo(x + k * 0.06, y - k * 0.2); ctx.closePath();
    ctx.stroke(); ctx.fill(); ctx.restore();
  }
  function fxHas(name) {
    const F = SE.FX; if (!F) return false;
    if (F.has) return F.has(name);
    if (Array.isArray(F.recipes)) return F.recipes.indexOf(name) >= 0;
    return !!F.attach;
  }
  const GIFT_BADGE_Y = 11.2;   // "!" badge above the gift chest (over its sign board, top 9.3)
  function fmtTime(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s2 = sec % 60;
    const p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return h > 0 ? h + ':' + p2(m) + ':' + p2(s2) : m + ':' + p2(s2);
  }
  /* soft golden light shafts rising out of the open gift chest (2 crossed additive planes) */
  let _beamTex = null;
  function giftBeam() {
    if (!_beamTex) {
      const c = document.createElement('canvas'); c.width = 64; c.height = 128; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 128, 0, 0); gr.addColorStop(0, 'rgba(255,236,150,0.95)'); gr.addColorStop(0.45, 'rgba(255,214,90,0.4)'); gr.addColorStop(1, 'rgba(255,214,90,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 64, 128);
      const sg = g.createLinearGradient(0, 0, 64, 0); sg.addColorStop(0, 'rgba(0,0,0,1)'); sg.addColorStop(0.3, 'rgba(0,0,0,0)'); sg.addColorStop(0.7, 'rgba(0,0,0,0)'); sg.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = sg; g.fillRect(0, 0, 64, 128);
      _beamTex = new T.CanvasTexture(c); _beamTex.encoding = T.sRGBEncoding;
    }
    const grp = new T.Group(); grp.name = 'giftBeam';
    for (let k = 0; k < 2; k++) {
      const m = new T.Mesh(new T.PlaneGeometry(2.6, 3.6), new T.MeshBasicMaterial({ map: _beamTex, transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false }));
      m.position.y = 1.8; m.rotation.y = k * PI / 2; m.userData.ph = k * 1.7; m.renderOrder = 3; grp.add(m);
    }
    return grp;
  }
  /* round red "!" badge sprite (same language as the HUD notification badges) */
  function badgeSprite() {
    const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.arc(64, 70, 54, 0, 7); g.fill();
    g.fillStyle = '#3a1208'; g.beginPath(); g.arc(64, 64, 56, 0, 7); g.fill();
    g.fillStyle = '#ff4a3a'; g.beginPath(); g.arc(64, 64, 48, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.ellipse(58, 42, 30, 16, -0.3, 0, 7); g.fill();
    g.font = '900 76px ' + SE.Env.FONT; g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.lineWidth = 10; g.strokeStyle = '#3a1208'; g.strokeText('!', 64, 68); g.fillStyle = '#ffffff'; g.fillText('!', 64, 68);
    const tx = new T.CanvasTexture(c); tx.encoding = T.sRGBEncoding;
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tx, transparent: true, depthWrite: false, fog: false }));
    sp.scale.set(2.3, 2.3, 1); sp.renderOrder = 6; sp.name = 'giftBadge';
    return sp;
  }
  /* lift for a prop GLB whose geometry dips below its origin: bottom ends 0.02 below the ground (never floats) */
  const _lift = {};
  function propLift(key, scale) {
    if (_lift[key] === undefined) {
      const src = SE.Assets && SE.Assets.source ? SE.Assets.source(key) : null;
      let minY = 0;
      if (src) { src.updateMatrixWorld(true); minY = new T.Box3().setFromObject(src).min.y; }
      _lift[key] = isFinite(minY) ? minY : 0;
    }
    return _lift[key] < -0.02 ? -_lift[key] * (scale || 1) - 0.02 : 0;
  }
  function easeBack(x) { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }

  SE.World = World;
})(window);
