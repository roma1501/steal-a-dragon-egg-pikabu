/* =========================================================================
   Steal a Dragon Egg — neighbour bots (SE.Bots)

   Four NPC "players" live in the bot plots of the base (SE.World.botPlots).
   They walk up the valley along SE.World.navPoints, steal eggs from the first
   lairs (0–2, according to their level and to the gates the player has opened),
   get chased by the dragons (SE.DragonAI.alarm(lair, { kind:'bot', bot })) and
   sometimes caught (SE.Bots.onCaught), hatch babies at their plots (lite baby
   rigs), sell them at the Sell stall and train on the treadmill. Their state is
   private and never touches SE.State. Bots stay home while the tutorial runs.

   API
     init(scene, world)           creates the bots (needs World.botPlots + navPoints)
     update(dt, game)             AI, movement, hatching, animation
     onCaught(bot, dragon)        a dragon caught a bot: the egg returns to its nest
     applyStatus(bot, name, secs) 'chilled' (×0.6) | 'stunned' (stops) from dragon abilities
     getStealTargets() -> [bot]   bots that carry an egg outside the safe zone
     list                         [{ index, name, kind:'bot', isBot, pos (Vector3), x, z, yaw,
                                     group, model, carrying (egg|null), carry, safe, invisible:false,
                                     state, level, lair (target lair index), nest }]
     summary() -> plain object for QA; reset()
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var T = global.THREE;

  /* neighbour nicknames per UI language (Yandex: Russian) */
  var NAMES_BY_LANG = {
    ru: ['ДракоРекс', 'ЯйцеНиндзя', 'ЛунаКрыл', 'Нова_77'],
    en: ['RexRider', 'EggNinja', 'LunaWings', 'Nova_77'],
    tr: ['EjderBinici', 'YumurtaNinja', 'LunaKanat', 'Nova_77']
  };
  var NAMES = NAMES_BY_LANG.en;
  var LOOKS = [
    { shirt: '#e8743b', pants: '#243d60', hair: '#563422', skin: '#ffd6a8' },
    { shirt: '#ac57db', pants: '#28314f', hair: '#37272e', skin: '#f2c89d' },
    { shirt: '#2fa79a', pants: '#263345', hair: '#d8ad50', skin: '#ffe0bd' },
    { shirt: '#4272df', pants: '#333345', hair: '#d87832', skin: '#e9b98f' }
  ];
  var RADIUS = 1.2, ARRIVE = 1.6, SLOTS = 3;
  var FEELERS = [0.6, 1.1, 1.6, 2.1];          // deflection angles (rad) tried when blocked

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function angleDamp(from, to, l, dt) {
    var d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
    return from + d * (1 - Math.exp(-l * dt));
  }
  function pt(x, z) { return { x: x, z: z }; }
  function lairIdx(x) { return typeof x === 'number' ? x : (x && typeof x.index === 'number' ? x.index : 0); }
  var warned = {};
  function safe(where, fn) {
    try { return fn(); } catch (e) { if (!warned[where]) { warned[where] = true; console.error('[Bots] ' + where + ' failed', e); } }
    return undefined;
  }
  function audio(key, bot, vol) {
    if (SE.Audio && SE.Audio.play) safe('audio', function () { SE.Audio.play(key, { pos: { x: bot.x, z: bot.z }, volume: vol || 0.5, range: 90 }); });
  }
  function fx(name, x, y, z, opts) {
    if (SE.FX && SE.FX.emit) safe('fx', function () { SE.FX.emit(name, new T.Vector3(x, y, z), opts); });
  }
  function tutorialActive() {
    try { return !!(SE.Tutorial && SE.Tutorial.isActive && SE.Tutorial.isActive()); } catch (e) { return false; }
  }
  function disposeRig(rig) {
    if (!rig) return;
    if (rig.group && rig.group.parent) rig.group.parent.remove(rig.group);
    if (typeof rig.dispose === 'function') safe('dispose', function () { rig.dispose(); });
  }
  function makeEggRig(egg, scale) {
    var DM = SE.DragonModels;
    var rig = DM && DM.createEgg ? safe('createEgg', function () { return DM.createEgg(egg.species, egg.variant, scale); }) : null;
    if (rig && rig.group) return rig;
    var sp = SE.DragonData && SE.DragonData.species(egg.species);
    var mesh = new T.Mesh(new T.SphereGeometry(0.8 * scale, 12, 9), new T.MeshLambertMaterial({ color: (sp && sp.color) || '#f0e2b6' }));
    mesh.scale.set(0.85, 1.12, 0.85);
    mesh.position.y = 0.9 * scale;
    var g = new T.Group();
    g.add(mesh);
    return { group: g, update: function () {}, setWobble: function () {}, dispose: function () { mesh.geometry.dispose(); mesh.material.dispose(); } };
  }
  function makeBabyRig(species, variant) {
    var DM = SE.DragonModels;
    if (!DM || !DM.create) return null;
    var rig = safe('create baby', function () { return DM.create(species, { baby: true, variant: variant, lite: true }); });
    return rig && rig.group ? rig : null;
  }
  function setLabel(obj, text) {
    if (!obj) return;
    if (typeof obj.setText === 'function') obj.setText(text);
    else if (obj.userData && typeof obj.userData.setText === 'function') obj.userData.setText(text);
  }

  var Bots = {
    list: [],
    scene: null,
    world: null,
    root: null,
    time: 0,
    ready: false,

    init: function (scene, world) {
      if (this.ready) return;
      this.scene = scene;
      this.world = world || SE.World;
      var W = this.world;
      var plots = (W && W.botPlots) || [];
      if (!plots.length || !T) return;
      this.root = new T.Group();
      this.root.name = 'bots';
      scene.add(this.root);
      var n = Math.min(4, plots.length);
      for (var i = 0; i < n; i++) this.list.push(this.makeBot(i, plots[i]));
      this.ready = true;
      /* stagger: one bot already hatching, one starting a trip, one training */
      var b0 = this.list[0];
      if (b0) { this.plant(b0, { species: 'meadow', variant: 0, uid: 'bot0' }, 6); b0.timer = 4; }
      if (this.list[1]) this.list[1].timer = 1.5;
      if (this.list[3]) this.list[3].timer = 9;
    },

    makeBot: function (i, plot) {
      var look = LOOKS[i % LOOKS.length];
      var C = SE.Cosmetics, model = null;
      if (C && C.randomLook && C.makeCharacter) {
        /* a random but deterministic look (outfit, hat, back) from the cosmetics catalog */
        model = safe('cosmetic character', function () { return C.makeCharacter(C.randomLook(1000 + i * 7919)); });
      }
      if (!model || !model.group) {
        var make = SE.Player && SE.Player.makeCharacter ? SE.Player.makeCharacter
          : (SE.Models && SE.Models.makeCharacter ? SE.Models.makeCharacter : null);
        model = make ? safe('character', function () { return make(Object.assign({ bot: true, seed: i + 1 }, look)); }) : null;
      }
      if (!model || !model.group) {
        var g = new T.Group();
        var body = new T.Mesh(new T.BoxGeometry(2, 5.5, 1.2), new T.MeshLambertMaterial({ color: look.shirt }));
        body.position.y = 2.8; g.add(body);
        model = { group: g, update: function () {}, headTop: 6 };
      }
      var group = model.group;
      group.name = 'bot_' + i;
      var top = typeof model.carryHeight === 'number' ? model.carryHeight : (typeof model.headTop === 'number' ? model.headTop + 1 : 7.4);
      var anchor = new T.Group();
      anchor.position.set(0, top, 0.15);
      group.add(anchor);
      NAMES = NAMES_BY_LANG[(SE.I18N && SE.I18N.lang) || 'en'] || NAMES_BY_LANG.en;
      var name = NAMES[i % NAMES.length];
      var M = SE.Models;
      if (M && M.makeLabel) {
        var tag = safe('label', function () { return M.makeLabel(name, { w: 6.5, tw: 384, th: 112, fontSize: 52, outlineWidth: 8, outlineColor: '#152130' }); });
        if (tag) { tag.position.y = top + 3.4; group.add(tag); }
      }
      if (typeof plot.setName === 'function') safe('plot name', function () { plot.setName(name, look.shirt); });
      else if (plot.label) safe('plot label', function () { setLabel(plot.label, name); });
      var entry = plot.entry || pt(plot.x, plot.z - 6);
      var pos = new T.Vector3(plot.x + rnd(-2, 2), 0, plot.z + rnd(-1, 1));
      group.position.copy(pos);
      this.root.add(group);
      var bot = {
        index: i, id: 'bot-' + (i + 1), name: name, kind: 'bot', isBot: true,
        model: model, group: group, anchor: anchor, plot: plot, entry: entry,
        pos: pos, x: pos.x, z: pos.z, y: 0, yaw: Math.PI, vy: 0,
        level: 1 + i * 0.7, speedStat: 26 + i * 4,
        state: 'idle', timer: 2 + i * 2.5, path: [], pi: 0,
        carrying: null, carry: null, carryRig: null, nest: null, lair: -1,
        safe: true, invisible: false, moving: false, speed: 0, stumble: 1,
        slots: this.makeSlots(plot), wpTime: 0, side: 0, sideT: 0, trainLeft: 0,
        status: { chilled: 0, stunned: 0 },
        stats: { steals: 0, delivered: 0, caught: 0, hatched: 0, sold: 0, trains: 0 }
      };
      return bot;
    },

    /* 3 small nest spots in the plot (World may provide them, else around the plot centre) */
    makeSlots: function (plot) {
      var spots = plot.hatcheries || plot.slots || plot.spots || null;
      var out = [];
      if (spots && spots.length) {
        for (var s = 0; s < Math.min(SLOTS + 1, spots.length); s++) {
          out.push({ x: spots[s].x, z: spots[s].z, host: spots[s].content && spots[s].content.isObject3D ? spots[s].content : null, egg: null, rig: null, kind: '', hatchAt: 0 });
        }
        return out;
      }
      var e = plot.entry || pt(plot.x, plot.z - 6);
      var dx = plot.x - e.x, dz = plot.z - e.z, d = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= d; dz /= d;
      var px = -dz, pz = dx;
      for (var k = 0; k < SLOTS; k++) {
        var o = (k - 1) * 4.6;
        out.push({ x: plot.x + dx * 3 + px * o, z: plot.z + dz * 3 + pz * o, egg: null, rig: null, kind: '', hatchAt: 0 });
      }
      return out;
    },

    /* ------------------------------------------------------------------ */
    /* planning                                                            */
    /* ------------------------------------------------------------------ */
    reachableLair: function () {
      var W = this.world, L = (W && W.lairs) || [];
      var top = -1;
      for (var i = 0; i < Math.min(3, L.length); i++) {
        var unlocked = L[i].unlocked !== undefined ? !!L[i].unlocked : (SE.State && SE.State.lairUnlocked(i));
        if (!unlocked) break;
        top = i;
      }
      return top;
    },

    chooseNest: function (bot) {
      var W = this.world, nests = (W && W.nests) || [];
      var top = this.reachableLair();
      if (top < 0) return null;
      var maxByLevel = bot.level >= 6 ? 2 : (bot.level >= 3 ? 1 : 0);
      var hi = Math.min(top, maxByLevel);
      var li = Math.random() < 0.55 ? hi : Math.floor(Math.random() * (hi + 1));
      var self = this, pPos = SE.Player && SE.Player.pos;
      for (var pass = 0; pass < 2; pass++) {
        var cand = nests.filter(function (n) {
          if (n.taken || lairIdx(n.lair) !== li) return false;
          if (self.list.some(function (o) { return o !== bot && o.nest === n; })) return false;
          if (pPos && Math.abs(pPos.x - n.x) + Math.abs(pPos.z - n.z) < 14) return false;   // never under the player's nose
          return true;
        });
        if (cand.length) return cand[Math.floor(Math.random() * cand.length)];
        li = 0;
      }
      return null;
    },

    navList: function () {
      var W = this.world, nav = (W && W.navPoints) || [];
      return nav.map(function (p) { return pt(p.x, p.z); }).sort(function (a, b) { return b.z - a.z; });   // south → north
    },

    exitRoute: function (bot) {
      var r = bot.plot.route;
      if (r && r.length) return r.map(function (p) { return pt(p.x, p.z); });
      return [pt(bot.entry.x, bot.entry.z)];
    },

    /* route from the plot up to a nest */
    routeTo: function (bot, nest) {
      var path = this.exitRoute(bot);
      var nav = this.navList();
      var W = this.world;
      var exitZ = path[path.length - 1].z;
      for (var i = 0; i < nav.length; i++) {
        if (nav[i].z < exitZ - 1 && nav[i].z > nest.z + 6) path.push(nav[i]);
      }
      if (!nav.length && W && W.spawn) path.push(pt(W.spawn.x, W.spawn.z - 20));
      var lair = W.lairs && W.lairs[lairIdx(nest.lair)];
      var side = lair && typeof lair.zMax === 'number' && nest.z + 4 > lair.zMax ? -1 : 1;
      path.push(pt(nest.x + rnd(-1, 1), nest.z + side * 3.4));
      return path;
    },

    /* route back down to the plot */
    routeHome: function (bot) {
      var path = [];
      var exit = this.exitRoute(bot).reverse();     // gate → … → plot entry
      var nav = this.navList().reverse();          // north → south
      for (var i = 0; i < nav.length; i++) {
        if (nav[i].z > bot.z + 4 && nav[i].z < exit[0].z - 1) path.push(nav[i]);
      }
      path = path.concat(exit);
      path.push(pt(bot.plot.x + rnd(-1.5, 1.5), bot.plot.z + rnd(-1, 1)));
      return path;
    },

    /* inside the base: plot → north strip → central lawn → target (and back) */
    lawnRoute: function (bot) {
      var exit = this.exitRoute(bot);
      var out = exit.length >= 3 ? exit.slice(0, 3) : exit.slice();
      var last = out[out.length - 1];
      out.push(pt(0, Math.max(last.z, 0) + 2));
      return out;
    },
    routeToPoint: function (bot, x, z) {
      var path = this.lawnRoute(bot);
      path.push(pt(0, z - 18));
      path.push(pt(x, z));
      return path;
    },
    routeFromPoint: function (bot) {
      var back = this.lawnRoute(bot).reverse();
      back.unshift(pt(0, bot.z - 18));
      back.push(pt(bot.plot.x, bot.plot.z));
      return back;
    },

    go: function (bot, state, path) {
      bot.state = state;
      bot.path = path || [];
      bot.pi = 0;
      bot.wpTime = 0;
      bot.side = 0;
    },

    nextTask: function (bot) {
      var babies = bot.slots.filter(function (s) { return s.kind === 'b'; }).length;
      var free = bot.slots.some(function (s) { return !s.kind; });
      var W = this.world;
      var sell = W && W.interactables ? W.interactables.filter(function (it) { return it.type === 'sell'; })[0] : null;
      var tms = (W && W.treadmills) || [];
      var tm = tms[bot.index % Math.max(1, tms.length)];
      var r = Math.random();
      if (babies && (!free || r < 0.3) && sell) { this.go(bot, 'toSell', this.routeToPoint(bot, sell.x + rnd(-1.5, 1.5), sell.z)); return; }
      if (tm && r < 0.42 && bot.stats.trains < bot.stats.steals + 1 && !this.playerOn(tm)) { bot.tm = tm; this.go(bot, 'toTrain', this.routeToPoint(bot, tm.x, tm.z)); return; }
      if (tutorialActive()) { bot.timer = rnd(4, 7); return; }
      var nest = this.chooseNest(bot);
      if (!nest) { bot.timer = rnd(3, 6); return; }
      bot.nest = nest;
      bot.lair = lairIdx(nest.lair);
      bot.stumble = rnd(0.82, 1.04);
      this.go(bot, 'toLair', this.routeTo(bot, nest));
    },

    /* ------------------------------------------------------------------ */
    /* update                                                              */
    /* ------------------------------------------------------------------ */
    update: function (dt, game) {
      if (!this.ready || !this.list.length) return;
      this.time += dt;
      var W = this.world, pPos = SE.Player && SE.Player.pos;
      for (var i = 0; i < this.list.length; i++) {
        var bot = this.list[i];
        if (bot.status.chilled > 0) bot.status.chilled -= dt;
        if (bot.status.stunned > 0) bot.status.stunned -= dt;
        this.think(bot, dt, game);
        var moving = this.move(bot, dt);
        bot.safe = W && W.inSafeZone ? !!W.inSafeZone(bot.x, bot.z) : true;
        var far = pPos ? Math.abs(pPos.z - bot.z) + Math.abs(pPos.x - bot.x) : 0;
        bot.group.visible = far < 340;
        this.setShadows(bot, far < 110);          // shadow pass only for bots near the player (draw-call budget)
        if (bot.group.visible && bot.model.update) {
          var running = moving || bot.state === 'training';
          safe('model.update', function () { bot.model.update(dt, running, (bot.state === 'training' ? 1.4 : bot.speed / 17), true); });
        }
        if (bot.carryRig && bot.carryRig.update) bot.carryRig.update(dt);
        this.updateSlots(bot, dt, far < 200);
      }
    },

    think: function (bot, dt, game) {
      switch (bot.state) {
        case 'idle':
          bot.timer -= dt;
          if (bot.timer <= 0) this.nextTask(bot);
          break;
        case 'toLair':
          if (bot.nest && bot.nest.taken) {            // someone was faster
            var other = this.chooseNest(bot);
            if (other && lairIdx(other.lair) === bot.lair) { bot.nest = other; this.go(bot, 'toLair', this.routeTo(bot, other).slice(-2)); }
            else { bot.nest = null; this.go(bot, 'return', this.routeHome(bot)); }
          } else if (bot.pi >= bot.path.length) { bot.state = 'stealing'; bot.timer = rnd(0.4, 0.9); }
          break;
        case 'stealing':
          bot.timer -= dt;
          if (bot.timer <= 0) this.steal(bot, game);
          break;
        case 'flee':
          if (bot.pi >= bot.path.length) this.arriveHome(bot);
          break;
        case 'caught':
          bot.timer -= dt;
          if (bot.timer <= 0) this.respawn(bot);
          break;
        case 'return':
          if (bot.pi >= bot.path.length) { bot.state = 'idle'; bot.timer = rnd(2, 5); }
          break;
        case 'toSell':
          if (bot.pi >= bot.path.length) this.sellBaby(bot);
          break;
        case 'toTrain':
          if (bot.pi >= bot.path.length) { bot.state = 'training'; bot.trainLeft = rnd(5, 9); }
          break;
        case 'training':
          bot.trainLeft -= dt;
          bot.yaw = angleDamp(bot.yaw, Math.PI, 6, dt);
          bot.group.rotation.y = bot.yaw;
          if (bot.trainLeft <= 0) {
            bot.speedStat = Math.min(140, bot.speedStat + 3);
            bot.stats.trains++;
            this.go(bot, 'return', this.routeFromPoint(bot));
          }
          break;
        default:
          bot.state = 'idle'; bot.timer = 2;
      }
    },

    walkSpeed: function (bot) {
      var base = 12 + bot.speedStat * 0.28;
      if (bot.status.stunned > 0) return 0;
      if (bot.status.chilled > 0) base *= 0.6;
      if (bot.carrying) base *= bot.stumble;
      if (bot.state === 'return' || bot.state === 'toSell' || bot.state === 'toTrain') base *= 0.75;
      return base;
    },

    move: function (bot, dt) {
      if (bot.pi >= bot.path.length || bot.state === 'caught' || bot.state === 'stealing' || bot.state === 'training' || bot.state === 'idle') {
        bot.moving = false; bot.speed = 0;
        return false;
      }
      var tgt = bot.path[bot.pi];
      var dx = tgt.x - bot.x, dz = tgt.z - bot.z, d = Math.sqrt(dx * dx + dz * dz);
      if (d < ARRIVE) { this.nextWaypoint(bot); return true; }
      var sp = this.walkSpeed(bot), step = Math.min(d, sp * dt);
      var ux = dx / d, uz = dz / d, nx = bot.x + ux * step, nz = bot.z + uz * step;
      var resolve = SE.Player && SE.Player.resolve ? SE.Player.resolve.bind(SE.Player) : null;
      if (resolve) {
        /* feelers: when the straight step is blocked, try deflected directions (keeping the side
           chosen last time for a moment, so the bot walks around posts and pen corners) */
        var r = resolve(nx, nz, 0, RADIUS);
        if (Math.hypot(r.x - bot.x, r.z - bot.z) < step * 0.55) {
          var side = bot.side || (Math.random() < 0.5 ? 1 : -1), found = null;
          for (var k = 0; k < FEELERS.length && !found; k++) {
            var a = FEELERS[k] * side, ca = Math.cos(a), sa = Math.sin(a);
            var cx = ux * ca - uz * sa, cz = ux * sa + uz * ca;
            var rr = resolve(bot.x + cx * step, bot.z + cz * step, 0, RADIUS);
            if (Math.hypot(rr.x - bot.x, rr.z - bot.z) > step * 0.55) { found = rr; bot.side = side; bot.sideT = 1.2; }
            else if (k === FEELERS.length - 1) side = -side;
          }
          if (!found) {
            for (var k2 = 0; k2 < FEELERS.length && !found; k2++) {
              var a2 = -FEELERS[k2] * side, c2 = Math.cos(a2), s2 = Math.sin(a2);
              var r2 = resolve(bot.x + (ux * c2 - uz * s2) * step, bot.z + (ux * s2 + uz * c2) * step, 0, RADIUS);
              if (Math.hypot(r2.x - bot.x, r2.z - bot.z) > step * 0.55) { found = r2; bot.side = -side; bot.sideT = 1.2; }
            }
          }
          r = found || r;
        } else if (bot.sideT > 0) {
          bot.sideT -= dt;
          if (bot.sideT <= 0) bot.side = 0;
        }
        nx = r.x; nz = r.z;
      }
      var mx = nx - bot.x, mz = nz - bot.z, moved = Math.sqrt(mx * mx + mz * mz);
      bot.x = nx; bot.z = nz;
      bot.speed = dt > 0 ? moved / dt : 0;
      bot.moving = moved > 0.001;
      /* progress watchdog per waypoint: teleport when nobody sees it (or after a long time) */
      bot.wpTime = (bot.wpTime || 0) + dt;
      if (bot.wpTime > 7) this.unstick(bot);
      bot.pos.set(bot.x, 0, bot.z);
      bot.group.position.copy(bot.pos);
      if (moved > 0.001) bot.yaw = angleDamp(bot.yaw, Math.atan2(mx, mz), 12, dt);
      bot.group.rotation.y = bot.yaw;
      return bot.moving;
    },

    nextWaypoint: function (bot) {
      bot.pi++;
      bot.wpTime = 0;
      bot.side = 0;
      bot.sideT = 0;
    },

    /* jump to the current waypoint when nobody is looking (or after 15 s anyway) */
    unstick: function (bot) {
      var p = SE.Player && SE.Player.pos;
      var tgt = bot.path[Math.min(bot.pi, bot.path.length - 1)];
      if (!tgt) return;
      var seen = p && Math.abs(p.x - bot.x) + Math.abs(p.z - bot.z) < 60;
      if (seen && bot.wpTime < 15) return;
      if (seen) fx('dust', bot.x, 1, bot.z, { count: 0.5 });
      bot.x = tgt.x; bot.z = tgt.z;
      bot.pos.set(bot.x, 0, bot.z);
      bot.group.position.copy(bot.pos);
      this.nextWaypoint(bot);
    },

    /* ------------------------------------------------------------------ */
    /* actions                                                             */
    /* ------------------------------------------------------------------ */
    steal: function (bot, game) {
      var nest = bot.nest, D = SE.DragonData;
      if (!nest || nest.taken || !D) { bot.nest = null; this.go(bot, 'return', this.routeHome(bot)); return; }
      var sp = D.species(lairIdx(nest.lair));
      var egg = D.makeEgg(sp.id, 1);
      var G = game || SE.Game;
      if (G && G.takeNest) G.takeNest(nest, bot);
      else if (this.world.setNestTaken) { this.world.setNestTaken(nest, true); nest.taken = true; }
      bot.carrying = egg;
      bot.carry = egg;
      bot.model.carry = egg;
      bot.carryRig = makeEggRig(egg, 1.0);
      bot.anchor.add(bot.carryRig.group);
      bot.stats.steals++;
      fx('steal_burst', nest.x, 2, nest.z, { count: 0.6, scale: 0.8 });
      audio('egg_pickup', bot, 0.45);
      var lair = this.world.lairs && this.world.lairs[bot.lair];
      if (SE.DragonAI && SE.DragonAI.alarm) {
        var b = bot;
        safe('DragonAI.alarm', function () { SE.DragonAI.alarm(lair || b.lair, { kind: 'bot', bot: b }); });
      }
      this.go(bot, 'flee', this.routeHome(bot));
    },

    dropCarry: function (bot) {
      disposeRig(bot.carryRig);
      bot.carryRig = null;
      bot.carrying = null;
      bot.carry = null;
      bot.model.carry = null;
    },

    arriveHome: function (bot) {
      var egg = bot.carrying;
      this.dropCarry(bot);
      bot.nest = null;
      if (egg) {
        bot.stats.delivered++;
        bot.level = Math.min(8, bot.level + 0.5);
        if (!this.plant(bot, egg)) fx('coin_burst', bot.x, 3, bot.z, { count: 0.5 });
        audio('egg_place', bot, 0.4);
      }
      bot.state = 'idle';
      bot.timer = rnd(2.5, 6);
    },

    plant: function (bot, egg, secs) {
      var slot = null;
      for (var i = 0; i < bot.slots.length; i++) if (!bot.slots[i].kind) { slot = bot.slots[i]; break; }
      if (!slot) return false;
      var D = SE.DragonData;
      var hatch = secs || (D && D.hatchTime ? D.hatchTime(egg) * 0.6 : 20);
      slot.egg = egg;
      slot.kind = 'e';
      slot.hatchAt = this.time + hatch;
      slot.rig = makeEggRig(egg, 1.3);
      this.place(slot, slot.rig);
      return true;
    },

    setShadows: function (bot, on) {
      if (bot.shadowOn === on) return;
      bot.shadowOn = on;
      bot.group.traverse(function (o) {
        if (!o.isMesh) return;
        if (o.userData.cast0 === undefined) o.userData.cast0 = o.castShadow;
        o.castShadow = on && o.userData.cast0;
      });
    },

    updateSlots: function (bot, dt, near) {
      for (var i = 0; i < bot.slots.length; i++) {
        var s = bot.slots[i];
        if (!s.kind || !s.rig) continue;
        if (s.kind === 'e') {
          var left = s.hatchAt - this.time;
          if (s.rig.setWobble) s.rig.setWobble(left < 4 ? 1 - left / 4 : 0);
          if (left <= 0) {
            disposeRig(s.rig);
            s.rig = makeBabyRig(s.egg.species, s.egg.variant);
            s.kind = 'b';
            bot.stats.hatched++;
            if (s.rig) {
              this.place(s, s.rig);
              s.rig.group.rotation.y = Math.atan2(bot.entry.x - s.x, bot.entry.z - s.z);
              if (s.rig.setState) safe('baby.setState', function () { s.rig.setState('sit'); });
            }
            if (near) { fx('hatch_burst', s.x, 2, s.z, { count: 0.6, scale: 0.8 }); audio('hatch', bot, 0.35); }
            if (!s.rig) { s.kind = ''; s.egg = null; }
            continue;
          }
        }
        if (near && s.rig.update) safe('rig.update', function () { s.rig.update(dt, 0); });
      }
    },

    place: function (slot, rig) {
      if (slot.host) { rig.group.position.set(0, 0, 0); slot.host.add(rig.group); }
      else { rig.group.position.set(slot.x, 0.35, slot.z); this.root.add(rig.group); }
    },

    sellBaby: function (bot) {
      var s = null;
      for (var i = 0; i < bot.slots.length; i++) if (bot.slots[i].kind === 'b') { s = bot.slots[i]; break; }
      if (s) {
        disposeRig(s.rig);
        s.rig = null; s.kind = ''; s.egg = null;
        bot.stats.sold++;
        fx('coin_burst', bot.x, 3, bot.z, { count: 0.5 });
        audio('sell', bot, 0.4);
      }
      this.go(bot, 'return', this.routeFromPoint(bot));
    },

    playerOn: function (tm) {
      var p = SE.Player && SE.Player.pos;
      return !!(p && Math.abs(p.x - tm.x) < 4 && Math.abs(p.z - tm.z) < 6);
    },

    /* SE.DragonAI → a dragon reached a bot */
    onCaught: function (bot, dragon) {
      if (!bot || bot.state === 'caught') return;
      var nest = bot.nest;
      if (bot.carrying && nest && nest.taken && (nest.takenBy === bot || !(SE.Game && SE.Game.takeNest))) {
        var G = SE.Game;
        if (G && G.restoreNest) G.restoreNest(nest);
        else if (this.world.setNestTaken) { this.world.setNestTaken(nest, false); nest.taken = false; }
      }
      this.dropCarry(bot);
      bot.nest = null;
      bot.stats.caught++;
      bot.state = 'caught';
      bot.timer = 1.3;
      bot.path = [];
      fx(SE.FX && SE.FX.has && SE.FX.has('poof') ? 'poof' : 'dust', bot.x, 1, bot.z, { count: 0.8 });
      audio('caught', bot, 0.35);
    },

    respawn: function (bot) {
      fx('dust', bot.x, 1, bot.z, { count: 0.6 });
      bot.x = bot.plot.x + rnd(-2, 2);
      bot.z = bot.plot.z + rnd(-1, 1);
      bot.pos.set(bot.x, 0, bot.z);
      bot.group.position.copy(bot.pos);
      fx('sparkle', bot.x, 3, bot.z, { count: 0.6 });
      bot.state = 'idle';
      bot.timer = rnd(4, 8);
    },

    /* SE.DragonAI → frost breath / fireball hit a bot */
    applyStatus: function (bot, name, secs) {
      if (!bot || !bot.status || !(secs > 0)) return;
      bot.status[name] = Math.max(bot.status[name] || 0, secs);
    },

    getStealTargets: function () {
      return this.list.filter(function (b) { return !!b.carrying && !b.safe && b.state !== 'caught'; });
    },

    summary: function () {
      return this.list.map(function (b) {
        return { name: b.name, state: b.state, x: Math.round(b.x), z: Math.round(b.z), lair: b.lair, carrying: !!b.carrying, level: b.level, stats: b.stats };
      });
    },

    reset: function () {
      for (var i = 0; i < this.list.length; i++) {
        var b = this.list[i];
        this.dropCarry(b);
        b.slots.forEach(function (s) { disposeRig(s.rig); s.rig = null; s.kind = ''; });
        if (b.group.parent) b.group.parent.remove(b.group);
      }
      this.list = [];
      this.ready = false;
    }
  };

  SE.Bots = Bots;
})(window);
