/* =========================================================================
   Steal a Dragon Egg — cosmetic builders (SE.Cosmetics)

   Turns the catalog (SE.CosmeticData, js/data/cosmetics.js) into visuals on the
   blocky character from SE.Models.makeCharacter (js/models.js):
     outfits  canvas-painted shirt / sleeve / trouser textures (CHAR_UV layout) +
              attached 3D pieces (pauldrons, belts, collars, robes, tabards, tails…)
     hats     3D builders on the head anchor (hair is flattened / hidden per hat)
     back     wings, capes, packs… on the back anchor, animated (flap / sway / spin)
     trails   own pooled particle system (one THREE.Points per blend mode, canvas
              sprite atlas) + ribbon mesh (rainbow) + ground decal batch (tracks);
              a recipe registered in SE.FX as 'trail_<fx>' is used instead when present
     victory  timed effects (particles + temporary meshes) + model.celebrate()

   API
     apply(model, equipped)                 outfit / hat / back on a character (re-entrant,
                                            only changed slots are rebuilt); remembers
                                            equipped.trail / .victory on model._cos
     updateTrail(dt, player)                emits the equipped trail while moving; player =
                                            SE.Player-like { pos|group, moving, grounded, speed,
                                            model, scene, invisible }. Also steps the in-game
                                            effects unless the game calls update(dt) itself.
     update(dt)                             optional per-frame step of in-game trails/victories
     playVictory(itemId|null, position, model?) -> { stop() }   null → the equipped one
                                            (SE.State), none equipped → small default burst
     previewObject(itemId, equipped?) -> THREE.Group  character wearing `equipped` + the item;
                                            trails run in place with a showcase emitter,
                                            victory effects loop. userData: { update(dt, time),
                                            height, kind, itemId, dispose() }
     disposePreview(obj)
     thumbnail(itemId, size=128) -> Promise<dataURL|null>   one lazy offscreen renderer,
                                            serial queue, cached per id+size
     randomLook(seed) -> { skin, hair, hairStyle, face, equipped }   (bots; deterministic)
     makeCharacter(look) -> model           SE.Models.makeCharacter(look) + apply(look.equipped)
     hatInfo(id) -> { hair, lift }          clearEffects(), setQuality('low'|'medium'|'high')
     Mythic skins (items with skin:true, slot 'outfit'): full-body GLBs 'skin.<id>' loaded lazily
       with SE.Assets.add(key, url, {optional}) + SE.Assets.load(key) on preview / equip / thumbnail.
       The blocky body is hidden, the skin's body/head/arm_L/arm_R/leg_L/leg_R nodes follow the
       character's pivots (walk / idle / jump / carry / celebrate), 'tail' sways, 'spin' rotates
       around its local Z, hats/back items attach to the skin's 'hat'/'back' empties (hidden when
       absent), the carried egg moves to the 'carry' empty. Until the GLB is ready the character
       keeps its previous outfit and re-applies itself when the model arrives.
     skinStatus(id) -> 'ready'|'loading'|'missing'|'idle'|'none'   ensureSkin(id) -> Promise<bool>
     isPlaceholderThumb(url) -> bool        ("soon" card returned while a skin model/icon is missing)
     FX_NAMES, VICTORY_NAMES                (QA)

   Colour management follows SPEC §13 (sRGB hex in code, ColorManagement on).
   Depends on THREE, SE.Models; optional SE.CosmeticData, SE.State, SE.FX, SE.Audio,
   SE.DragonModels (flyby / hatching), SE.Game.shake, THREE.BufferGeometryUtils (merging).
   i18n prefix: cos.* (strings live in data/cosmetics.js).
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var T = global.THREE;
  var PI = Math.PI, TAU = PI * 2;

  function Mo() { return SE.Models; }
  function CD() { return SE.CosmeticData || null; }
  function itemOf(id) { var C = CD(); return C && typeof C.item === 'function' ? C.item(id) : null; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(t) { t = clamp(t, 0, 1); return 1 - Math.pow(1 - t, 3); }
  function easeBack(t) { t = clamp(t, 0, 1); var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); }
  function rng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) { var h = 2166136261; s = String(s); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  var R = Math.random;
  function rr(a, b) { return a + (b - a) * R(); }
  function pick(arr) { return arr[(R() * arr.length) | 0]; }
  function sfx(key, opts) { try { if (SE.Audio && SE.Audio.play) SE.Audio.play(key, opts || {}); } catch (e) { /* optional */ } }
  function cvs(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function tex(c) {
    var t = new T.CanvasTexture(c);
    if (T.sRGBEncoding !== undefined) t.encoding = T.sRGBEncoding;
    t.anisotropy = 4;
    return t;
  }
  function shade(hex, f) {
    var c = new T.Color(hex), hsl = {};
    c.getHSL(hsl);
    return '#' + new T.Color().setHSL(hsl.h, hsl.s, clamp(hsl.l + f, 0, 1)).getHexString();
  }
  function isMobile() { return !!(SE.Platform && SE.Platform.isMobile); }
  var ROOT = (function () {
    try { var m = /^(.*\/)js\/cosmetics\.js(?:[?#].*)?$/.exec(document.currentScript.src); return m ? m[1] : ''; } catch (e) { return ''; }
  })();
  function tt(key, fb) { if (SE.t) { var v = SE.t(key); if (v && v !== key) return v; } return fb; }
  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: { 'cos.skinSoon': 'Скоро!', 'cos.skinLoading': 'Загрузка…', 'cos.mythicBadge': 'МИФИЧЕСКИЙ' },
      en: { 'cos.skinSoon': 'Coming soon!', 'cos.skinLoading': 'Loading…', 'cos.mythicBadge': 'MYTHIC' },
      tr: { 'cos.skinSoon': 'Yakında!', 'cos.skinLoading': 'Yükleniyor…', 'cos.mythicBadge': 'MİTİK' }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Materials & mesh helpers                                                */
  /* ---------------------------------------------------------------------- */
  var MATS = {};
  /* o: { metal, rough, emissive, ei, opacity, flat, side, std, add } — cached (shared, never disposed) */
  function mat(color, o) {
    o = o || {};
    var key = color + '|' + (o.metal || 0) + '|' + (o.rough === undefined ? '' : o.rough) + '|' + (o.emissive || '') + '|' + (o.ei || 1) +
      '|' + (o.opacity === undefined ? 1 : o.opacity) + '|' + (o.flat ? 1 : 0) + '|' + (o.side || 0) + '|' + (o.std ? 1 : 0) + '|' + (o.add ? 1 : 0) + (o.basic ? 'b' : '');
    if (MATS[key]) return MATS[key];
    var p = {
      color: new T.Color(color),
      transparent: (o.opacity !== undefined && o.opacity < 1) || !!o.add,
      opacity: o.opacity === undefined ? 1 : o.opacity,
      flatShading: !!o.flat,
      side: o.side === 2 ? T.DoubleSide : T.FrontSide
    };
    if (o.emissive) { p.emissive = new T.Color(o.emissive); p.emissiveIntensity = o.ei || 1; }
    var m;
    if (o.add) {
      m = new T.MeshBasicMaterial({ color: p.color, transparent: true, opacity: p.opacity, blending: T.AdditiveBlending, depthWrite: false, side: p.side });
    } else if (o.basic) {
      m = new T.MeshBasicMaterial({ color: p.color, transparent: p.transparent, opacity: p.opacity, side: p.side });
    } else if (o.metal || o.std || o.rough !== undefined) {
      p.metalness = o.metal || 0; p.roughness = o.rough === undefined ? 0.55 : o.rough;
      m = new T.MeshStandardMaterial(p);
    } else {
      m = new T.MeshLambertMaterial(p);
    }
    if (p.transparent) m.depthWrite = !!o.depthWrite;
    m.userData.shared = true;
    return MATS[key] = m;
  }
  var GOLD = { metal: 0.45, rough: 0.35 }, STEEL = { metal: 0.45, rough: 0.4 };
  function glow(c, ei) { return { emissive: c, ei: ei || 0.9 }; }
  function crystal(c, op) { return { std: true, rough: 0.12, metal: 0.1, emissive: c, ei: 0.35, opacity: op || 0.82, flat: true }; }

  function mesh(geo, color, o) { var m = new T.Mesh(geo, color && color.isMaterial ? color : mat(color, o)); m.castShadow = true; m.receiveShadow = true; return m; }
  function bx(w, h, d, c, o) { return mesh(new T.BoxGeometry(w, h, d), c, o); }
  function cy(rt, rb, h, c, seg, o) { return mesh(new T.CylinderGeometry(rt, rb, h, seg || 12), c, o); }
  function sp(r, c, o, ws, hs) { return mesh(new T.SphereGeometry(r, ws || 12, hs || 9), c, o); }
  function hemi(r, c, o, ws) { return mesh(new T.SphereGeometry(r, ws || 12, 6, 0, TAU, 0, PI / 2), c, o); }
  function co(r, h, c, seg, o) { return mesh(new T.ConeGeometry(r, h, seg || 8), c, o); }
  function tor(R0, r, c, rs, ts, arc, o) { return mesh(new T.TorusGeometry(R0, r, rs || 6, ts || 16, arc || TAU), c, o); }
  function oct(r, c, o) { return mesh(new T.OctahedronGeometry(r, 0), c, o); }
  function ico(r, c, o) { return mesh(new T.IcosahedronGeometry(r, 0), c, o); }
  function dod(r, c, o) { return mesh(new T.DodecahedronGeometry(r, 0), c, o); }
  /* flat extruded 2D outline: pts [[x,y],…] */
  function shp(pts, depth, c, o, bevel) {
    var s = new T.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    s.closePath();
    var g = new T.ExtrudeGeometry(s, { depth: depth, bevelEnabled: !!bevel, bevelThickness: bevel || 0, bevelSize: bevel || 0, bevelSegments: 1, curveSegments: 4 });
    g.translate(0, 0, -depth / 2);
    return mesh(g, c, o);
  }
  /* P(obj, x,y,z, rx,ry,rz, s) — place helper (s: number or [sx,sy,sz]) */
  function P(o, x, y, z, rx, ry, rz, s) {
    o.position.set(x || 0, y || 0, z || 0);
    if (rx || ry || rz) o.rotation.set(rx || 0, ry || 0, rz || 0);
    if (s !== undefined) { if (typeof s === 'number') o.scale.setScalar(s); else o.scale.set(s[0], s[1], s[2]); }
    return o;
  }
  function grp() { var g = new T.Group(); for (var i = 0; i < arguments.length; i++) if (arguments[i]) g.add(arguments[i]); return g; }
  /* animated node: fn(node, dt, model, time) */
  function live(node, fn) { node.userData.anim = fn; node.userData.live = true; return node; }

  /* Merge the static meshes of a cosmetic group per material (fewer draw calls).
     Live (animated) subtrees are kept as they are. */
  function bake(root) {
    var BGU = T.BufferGeometryUtils;
    if (!BGU || !BGU.mergeBufferGeometries) return root;
    root.updateMatrixWorld(true);
    var inv = new T.Matrix4().copy(root.matrixWorld).invert();
    var buckets = {}, order = [], victims = [];
    (function walk(o) {
      for (var i = 0; i < o.children.length; i++) {
        var c = o.children[i];
        if (c.userData.live || c.userData.keep) continue;
        if (c.isMesh && !Array.isArray(c.material) && c.geometry && c.geometry.attributes.uv && !c.isInstancedMesh) {
          var k = c.material.uuid;
          if (!buckets[k]) { buckets[k] = { mat: c.material, geos: [] }; order.push(k); }
          var g = c.geometry.index ? c.geometry.toNonIndexed() : c.geometry.clone();
          var keep = {};
          ['position', 'normal', 'uv'].forEach(function (n) { if (g.attributes[n]) keep[n] = g.attributes[n]; });
          var clean = new T.BufferGeometry();
          for (var n in keep) clean.setAttribute(n, keep[n]);
          clean.applyMatrix4(new T.Matrix4().multiplyMatrices(inv, c.matrixWorld));
          buckets[k].geos.push(clean);
          g.dispose();
          victims.push(c);
        }
        walk(c);
      }
    })(root);
    victims.forEach(function (v) {
      /* keep live children of baked meshes (rare): re-parent them to the root */
      while (v.children.length) {
        var ch = v.children[0];
        v.updateMatrixWorld(true);
        var mw = ch.matrixWorld.clone();
        v.remove(ch);
        root.add(ch);
        ch.matrix.multiplyMatrices(inv, mw);
        ch.matrix.decompose(ch.position, ch.quaternion, ch.scale);
      }
      if (v.parent) v.parent.remove(v);
      v.geometry.dispose();
    });
    order.forEach(function (k) {
      var b = buckets[k], merged = null;
      try { merged = BGU.mergeBufferGeometries(b.geos, false); } catch (e) { merged = null; }
      b.geos.forEach(function (g) { g.dispose(); });
      if (!merged) return;
      var m = new T.Mesh(merged, b.mat);
      m.castShadow = true; m.receiveShadow = true;
      root.add(m);
    });
    return root;
  }
  function disposeTree(o) {
    o.traverse(function (n) {
      if (n.geometry && !n.geometry.userData.shared) n.geometry.dispose();
      if (n.material) {
        (Array.isArray(n.material) ? n.material : [n.material]).forEach(function (m) {
          if (m.userData && m.userData.shared) return;
          if (m.map && !(m.map.userData && m.map.userData.shared)) m.map.dispose();
          m.dispose();
        });
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Outfit painter (CHAR_UV layout from SE.Models)                          */
  /* ---------------------------------------------------------------------- */
  function Painter(skin) {
    var UV = Mo().CHAR_UV;
    this.S = UV.shirt;
    this.skin = skin || '#ffd9b0';
    this.tc = cvs(this.S.W, this.S.H); this.g = this.tc.getContext('2d');
    this.ac = cvs(64, 128); this.ga = this.ac.getContext('2d');
    this.lc = cvs(64, 128); this.gl = this.lc.getContext('2d');
    this.e = null;           // emissive canvases (lazy)
    this.shoe = '#30343a'; this.sole = '#f4f1e8';
    this.sleeveEnd = 96; this.handStart = 100;
  }
  var PP = Painter.prototype;
  PP.F = function () { return this.S.pz; };
  PP.around = function (fn) {       // front, right side, back, left side (+ kind)
    var S = this.S;
    fn(S.pz, 'front'); fn(S.px, 'side'); fn(S.nz, 'back'); fn(S.nx, 'side');
  };
  PP.glowCtx = function () {
    if (!this.e) {
      this.e = { t: cvs(this.S.W, this.S.H), a: cvs(64, 128), l: cvs(64, 128) };
      ['t', 'a', 'l'].forEach(function (k) { var g = this.e[k].getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 999, 999); }, this);
      this.eg = this.e.t.getContext('2d'); this.ega = this.e.a.getContext('2d'); this.egl = this.e.l.getContext('2d');
    }
    return this.eg;
  };
  /* base(shirt, pants, o{ sleeve:'long'|'mid'|'short'|'none', sleeveColor, glove, shorts, sock, shoe, sole, boots }) */
  PP.base = function (shirt, pants, o) {
    o = o || {};
    var g = this.g, ga = this.ga, gl = this.gl;
    g.fillStyle = shirt; g.fillRect(0, 0, this.S.W, this.S.H);
    var end = { long: 96, mid: 70, short: 44, none: 10 }[o.sleeve || 'long'];
    this.sleeveEnd = end;
    ga.fillStyle = this.skin; ga.fillRect(0, 0, 64, 128);
    ga.fillStyle = o.sleeveColor || shirt; ga.fillRect(0, 0, 64, end);
    if (o.sleeve !== 'none') { ga.fillStyle = 'rgba(0,0,0,0.16)'; ga.fillRect(0, end - 5, 64, 5); }
    if (o.glove) { ga.fillStyle = o.glove; ga.fillRect(0, Math.max(end, 96), 64, 128); ga.fillStyle = 'rgba(255,255,255,0.18)'; ga.fillRect(0, Math.max(end, 96), 64, 4); }
    gl.fillStyle = pants; gl.fillRect(0, 0, 64, 128);
    if (o.shorts) {
      gl.fillStyle = this.skin; gl.fillRect(0, 58, 64, 70);
      gl.fillStyle = 'rgba(0,0,0,0.15)'; gl.fillRect(0, 54, 64, 4);
      if (o.sock) { gl.fillStyle = o.sock; gl.fillRect(0, 96, 64, 32); gl.fillStyle = 'rgba(0,0,0,0.12)'; gl.fillRect(0, 96, 64, 4); }
    }
    if (o.boots) { gl.fillStyle = o.boots; gl.fillRect(0, 128 - (o.bootH || 34), 64, 128); gl.fillStyle = 'rgba(255,255,255,0.15)'; gl.fillRect(0, 128 - (o.bootH || 34), 64, 4); }
    this.shoe = o.shoe || this.shoe; this.sole = o.sole || this.sole;
    return this;
  };
  /* horizontal band around the torso: y0..y1 in fractions of the torso height */
  PP.band = function (y0, y1, color, arms) {
    var g = this.g;
    g.fillStyle = color;
    this.around(function (r) { g.fillRect(r[0], r[1] + r[3] * y0, r[2], r[3] * (y1 - y0)); });
    if (arms) { this.ga.fillStyle = color; this.ga.fillRect(0, 128 * y0 * 0.85, 64, 128 * (y1 - y0) * 0.85); }
    return this;
  };
  PP.belt = function (color, buckle, y) {
    y = y === undefined ? 0.84 : y;
    this.band(y, y + 0.1, color);
    var g = this.g, F = this.F();
    g.fillStyle = 'rgba(0,0,0,0.25)'; this.around(function (r) { g.fillRect(r[0], r[1] + r[3] * (y + 0.1) - 2, r[2], 2); });
    if (buckle) {
      g.fillStyle = buckle; g.fillRect(F[0] + 52, F[1] + F[3] * y - 2, 24, F[3] * 0.1 + 4);
      g.fillStyle = color; g.fillRect(F[0] + 58, F[1] + F[3] * y + 3, 12, F[3] * 0.1 - 6);
    }
    return this;
  };
  PP.vest = function (color, open, trim) {
    var g = this.g, F = this.F(), gap = (open === undefined ? 0.3 : open) * F[2];
    g.fillStyle = color;
    g.fillRect(F[0], F[1], (F[2] - gap) / 2, F[3]);
    g.fillRect(F[0] + (F[2] + gap) / 2, F[1], (F[2] - gap) / 2, F[3]);
    var S = this.S;
    [S.nz, S.px, S.nx].forEach(function (r) { g.fillRect(r[0], r[1], r[2], r[3]); });
    if (trim) {
      g.fillStyle = trim;
      g.fillRect(F[0] + (F[2] - gap) / 2 - 5, F[1], 5, F[3]);
      g.fillRect(F[0] + (F[2] + gap) / 2, F[1], 5, F[3]);
    }
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.setLineDash([4, 4]); g.lineWidth = 2;
    g.beginPath(); g.moveTo(F[0] + (F[2] - gap) / 2 - 9, F[1] + 4); g.lineTo(F[0] + (F[2] - gap) / 2 - 9, F[1] + F[3] - 4);
    g.moveTo(F[0] + (F[2] + gap) / 2 + 9, F[1] + 4); g.lineTo(F[0] + (F[2] + gap) / 2 + 9, F[1] + F[3] - 4); g.stroke();
    g.setLineDash([]);
    return this;
  };
  PP.stripes = function (colors, n, where) {
    var g = this.g, i, h;
    where = where || 'ta';
    if (where.indexOf('t') >= 0) {
      this.around(function (r) {
        h = r[3] / n;
        for (i = 0; i < n; i++) { g.fillStyle = colors[i % colors.length]; g.fillRect(r[0], r[1] + i * h, r[2], h + 0.5); }
      });
    }
    if (where.indexOf('a') >= 0) {
      h = 128 / (n * 0.9);
      for (i = 0; i * h < this.sleeveEnd; i++) { this.ga.fillStyle = colors[i % colors.length]; this.ga.fillRect(0, i * h, 64, Math.min(h, this.sleeveEnd - i * h)); }
    }
    if (where.indexOf('l') >= 0) {
      h = 128 / n;
      for (i = 0; i < n; i++) { this.gl.fillStyle = colors[i % colors.length]; this.gl.fillRect(0, i * h, 64, h); }
    }
    return this;
  };
  PP.plaid = function (a, b, line) {
    var g = this.g, ga = this.ga, end = this.sleeveEnd;
    function grid(ctx, x, y, w, h, step) {
      ctx.fillStyle = a; ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 0.55; ctx.fillStyle = b;
      for (var i = 0; i < w; i += step) ctx.fillRect(x + i, y, step / 2, h);
      for (var j = 0; j < h; j += step) ctx.fillRect(x, y + j, w, step / 2);
      ctx.globalAlpha = 0.8; ctx.fillStyle = line;
      for (i = step / 4; i < w; i += step) ctx.fillRect(x + i, y, 2, h);
      for (j = step / 4; j < h; j += step) ctx.fillRect(x, y + j, w, 2);
      ctx.globalAlpha = 1;
    }
    this.around(function (r) { grid(g, r[0], r[1], r[2], r[3], 22); });
    grid(ga, 0, 0, 64, end, 22);
    return this;
  };
  PP.overalls = function (color, button) {
    var g = this.g, F = this.F(), S = this.S;
    g.fillStyle = color;
    g.fillRect(F[0] + 26, F[1] + 50, 76, F[3] - 50);
    g.fillRect(F[0] + 26, F[1], 14, 52); g.fillRect(F[0] + 88, F[1], 14, 52);
    g.fillRect(S.nz[0], S.nz[1] + 74, S.nz[2], S.nz[3] - 74);
    g.save(); g.beginPath(); g.rect(S.nz[0], S.nz[1], S.nz[2], 80); g.clip();
    g.lineWidth = 14; g.strokeStyle = color;
    g.beginPath(); g.moveTo(S.nz[0] + 30, S.nz[1]); g.lineTo(S.nz[0] + 98, S.nz[1] + 80); g.moveTo(S.nz[0] + 98, S.nz[1]); g.lineTo(S.nz[0] + 30, S.nz[1] + 80); g.stroke();
    g.restore();
    [S.px, S.nx].forEach(function (r) { g.fillRect(r[0], r[1] + 96, r[2], r[3] - 96); });
    g.fillStyle = shade(color, 0.12); g.fillRect(F[0] + 44, F[1] + 64, 40, 28);
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.setLineDash([3, 3]); g.lineWidth = 2; g.strokeRect(F[0] + 46, F[1] + 66, 36, 24); g.setLineDash([]);
    g.fillStyle = button || '#ffd24a';
    g.beginPath(); g.arc(F[0] + 33, F[1] + 56, 5, 0, TAU); g.arc(F[0] + 95, F[1] + 56, 5, 0, TAU); g.fill();
    this.gl.fillStyle = color; this.gl.fillRect(0, 0, 64, 128);
    return this;
  };
  /* scales: semicircles in rows */
  PP.scales = function (color, dark, size, where) {
    size = size || 14; where = where || 'ta';
    function rows(ctx, x, y, w, h) {
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      for (var j = 0, row = 0; j < h + size; j += size * 0.62, row++) {
        for (var i = (row % 2) * size / 2 - size; i < w + size; i += size) {
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + i + size / 2, y + j, size / 2, 0, PI); ctx.fill();
          ctx.strokeStyle = dark; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x + i + size / 2, y + j, size / 2 - 1, 0.15, PI - 0.15); ctx.stroke();
        }
      }
      ctx.restore();
    }
    var g = this.g;
    if (where.indexOf('t') >= 0) this.around(function (r) { rows(g, r[0], r[1], r[2], r[3]); });
    if (where.indexOf('a') >= 0) rows(this.ga, 0, 0, 64, this.sleeveEnd);
    if (where.indexOf('l') >= 0) rows(this.gl, 0, 0, 64, 100);
    return this;
  };
  /* armour plates: horizontal rows with rivets */
  PP.plates = function (color, edge, n, where, rivet) {
    where = where || 'ta'; n = n || 4;
    function rows(ctx, x, y, w, h, k) {
      var ph = h / k;
      for (var i = 0; i < k; i++) {
        ctx.fillStyle = color; ctx.fillRect(x, y + i * ph, w, ph);
        ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(x, y + i * ph, w, 3);
        ctx.fillStyle = edge; ctx.fillRect(x, y + (i + 1) * ph - 4, w, 4);
        if (rivet) { ctx.fillStyle = rivet; for (var r = x + 8; r < x + w; r += 20) { ctx.beginPath(); ctx.arc(r, y + i * ph + ph / 2, 2.2, 0, TAU); ctx.fill(); } }
      }
    }
    var g = this.g;
    if (where.indexOf('t') >= 0) this.around(function (r) { rows(g, r[0], r[1], r[2], r[3], n); });
    if (where.indexOf('a') >= 0) rows(this.ga, 0, 0, 64, this.sleeveEnd, Math.max(2, n - 1));
    if (where.indexOf('l') >= 0) rows(this.gl, 0, 0, 64, 96, Math.max(2, n - 1));
    return this;
  };
  PP.chainmail = function (color, where) {
    function rings(ctx, x, y, w, h) {
      ctx.fillStyle = shade(color, -0.25); ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      for (var j = 0, row = 0; j < h; j += 6, row++) for (var i = (row % 2) * 3; i < w; i += 6) { ctx.beginPath(); ctx.arc(x + i, y + j, 2.6, 0, TAU); ctx.stroke(); }
    }
    var g = this.g;
    where = where || 'ta';
    if (where.indexOf('t') >= 0) this.around(function (r) { rings(g, r[0], r[1], r[2], r[3]); });
    if (where.indexOf('a') >= 0) rings(this.ga, 0, 0, 64, this.sleeveEnd);
    if (where.indexOf('l') >= 0) rings(this.gl, 0, 0, 64, 100);
    return this;
  };
  PP.tabard = function (color, trim, emblem, emblemColor) {
    var g = this.g, S = this.S;
    [S.pz, S.nz].forEach(function (r, i) {
      g.fillStyle = color; g.fillRect(r[0] + 26, r[1], r[2] - 52, r[3]);
      g.fillStyle = trim; g.fillRect(r[0] + 26, r[1], 5, r[3]); g.fillRect(r[0] + r[2] - 31, r[1], 5, r[3]);
    });
    if (emblem) this.emblem(emblem, emblemColor || trim, 64, 58, 30);
    return this;
  };
  PP.sash = function (color, trim, back) {
    var g = this.g, S = this.S;
    [S.pz].concat(back === false ? [] : [S.nz]).forEach(function (r, i) {
      g.save(); g.beginPath(); g.rect(r[0], r[1], r[2], r[3]); g.clip();
      g.strokeStyle = color; g.lineWidth = 22; g.beginPath();
      if (i === 0) { g.moveTo(r[0] + 6, r[1] - 6); g.lineTo(r[0] + r[2] + 6, r[1] + r[3] + 6); } else { g.moveTo(r[0] + r[2] - 6, r[1] - 6); g.lineTo(r[0] - 6, r[1] + r[3] + 6); }
      g.stroke();
      if (trim) { g.strokeStyle = trim; g.lineWidth = 3; g.stroke(); }
      g.restore();
    });
    return this;
  };
  PP.pockets = function (color) {
    var g = this.g, F = this.F();
    [[18, 30], [78, 30]].forEach(function (p) {
      g.fillStyle = shade(color, -0.06); g.fillRect(F[0] + p[0], F[1] + p[1], 32, 30);
      g.fillStyle = shade(color, -0.16); g.fillRect(F[0] + p[0] - 2, F[1] + p[1] - 2, 36, 10);
      g.fillStyle = 'rgba(255,255,255,0.4)'; g.beginPath(); g.arc(F[0] + p[0] + 16, F[1] + p[1] + 4, 2.5, 0, TAU); g.fill();
    });
    return this;
  };
  PP.zip = function (color, pocket) {
    var g = this.g, F = this.F();
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(F[0] + 62, F[1], 4, F[3]);
    g.fillStyle = color || '#dddddd'; g.fillRect(F[0] + 60, F[1] + 4, 8, 12);
    g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(F[0] + 52, F[1] + 4); g.lineTo(F[0] + 50, F[1] + 34); g.moveTo(F[0] + 76, F[1] + 4); g.lineTo(F[0] + 78, F[1] + 34); g.stroke();
    if (pocket) {
      g.fillStyle = pocket; g.beginPath(); g.moveTo(F[0] + 28, F[1] + 84); g.lineTo(F[0] + 100, F[1] + 84); g.lineTo(F[0] + 108, F[1] + 120); g.lineTo(F[0] + 20, F[1] + 120); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(F[0] + 62, F[1] + 84, 4, 36);
    }
    return this;
  };
  PP.buttons = function (color, n, x) {
    var g = this.g, F = this.F();
    g.fillStyle = color;
    for (var i = 0; i < (n || 4); i++) { g.beginPath(); g.arc(F[0] + (x || 64), F[1] + 22 + i * 26, 4.5, 0, TAU); g.fill(); }
    return this;
  };
  PP.collarV = function (color, depth) {
    var g = this.g, F = this.F(); depth = depth || 30;
    g.fillStyle = color; g.beginPath(); g.moveTo(F[0] + 44, F[1]); g.lineTo(F[0] + 64, F[1] + depth); g.lineTo(F[0] + 84, F[1]); g.fill();
    return this;
  };
  PP.trim = function (color, w) {
    var g = this.g; w = w || 7;
    this.around(function (r) { g.fillStyle = color; g.fillRect(r[0], r[1] + r[3] - w, r[2], w); g.fillRect(r[0], r[1], r[2], w * 0.7); });
    this.ga.fillStyle = color; if (this.sleeveEnd > 12) this.ga.fillRect(0, this.sleeveEnd - w, 64, w);
    return this;
  };
  PP.cuffs = function (color, h) { this.ga.fillStyle = color; this.ga.fillRect(0, this.sleeveEnd - (h || 12), 64, h || 12); return this; };
  PP.legStripe = function (color, w) { this.gl.fillStyle = color; this.gl.fillRect(32 - (w || 6) / 2, 0, w || 6, 128); return this; };
  PP.legWraps = function (color, from) {
    var gl = this.gl; gl.strokeStyle = color; gl.lineWidth = 5;
    for (var y = from || 60; y < 128; y += 14) { gl.beginPath(); gl.moveTo(0, y); gl.lineTo(64, y + 10); gl.stroke(); }
    return this;
  };
  PP.armWraps = function (color, from) {
    var ga = this.ga; ga.strokeStyle = color; ga.lineWidth = 5;
    for (var y = from || 60; y < 116; y += 12) { ga.beginPath(); ga.moveTo(0, y); ga.lineTo(64, y + 8); ga.stroke(); }
    return this;
  };
  PP.kneePads = function (color) { this.gl.fillStyle = color; this.gl.fillRect(6, 50, 52, 22); this.gl.fillStyle = 'rgba(255,255,255,0.25)'; this.gl.fillRect(6, 50, 52, 4); return this; };
  PP.legs = function (color) { this.gl.fillStyle = color; this.gl.fillRect(0, 0, 64, 128); return this; };
  PP.emblem = function (kind, color, x, y, s, outline, ctx, region) {
    var g = ctx || this.g, F = region || this.F();
    var cx = F[0] + x, cyy = F[1] + y;
    s = s || 26;
    g.save(); g.translate(cx, cyy);
    g.lineJoin = 'round';
    function done() {
      if (outline !== false) { g.lineWidth = 3; g.strokeStyle = outline || 'rgba(0,0,0,0.45)'; g.stroke(); }
      g.fillStyle = color; g.fill();
    }
    g.beginPath();
    switch (kind) {
      case 'egg': g.ellipse(0, 2, s * 0.6, s * 0.8, 0, 0, TAU); done(); g.fillStyle = 'rgba(255,255,255,0.4)'; g.beginPath(); g.ellipse(-s * 0.2, -s * 0.25, s * 0.15, s * 0.25, -0.4, 0, TAU); g.fill(); break;
      case 'flame': g.moveTo(0, -s); g.quadraticCurveTo(s * 0.9, -s * 0.1, s * 0.5, s * 0.7); g.quadraticCurveTo(0, s * 1.05, -s * 0.5, s * 0.7); g.quadraticCurveTo(-s * 0.9, -s * 0.1, 0, -s); done(); break;
      case 'leaf': g.moveTo(0, -s); g.quadraticCurveTo(s * 0.9, 0, 0, s); g.quadraticCurveTo(-s * 0.9, 0, 0, -s); done(); g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -s * 0.8); g.lineTo(0, s * 0.8); g.stroke(); break;
      case 'star': for (var i = 0; i < 10; i++) { var a = -PI / 2 + i * PI / 5, rad = i % 2 ? s * 0.45 : s; g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); } g.closePath(); done(); break;
      case 'gem': g.moveTo(0, -s); g.lineTo(s * 0.8, -s * 0.2); g.lineTo(0, s); g.lineTo(-s * 0.8, -s * 0.2); g.closePath(); done(); g.fillStyle = 'rgba(255,255,255,0.45)'; g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.3, -s * 0.2); g.lineTo(-s * 0.3, -s * 0.2); g.fill(); break;
      case 'bolt': g.moveTo(s * 0.2, -s); g.lineTo(-s * 0.55, s * 0.1); g.lineTo(-s * 0.05, s * 0.1); g.lineTo(-s * 0.25, s); g.lineTo(s * 0.55, -s * 0.15); g.lineTo(s * 0.05, -s * 0.15); g.closePath(); done(); break;
      case 'snow':
        g.strokeStyle = color; g.lineWidth = s * 0.16; g.lineCap = 'round';
        for (var k = 0; k < 6; k++) { var b = k * PI / 3; g.moveTo(0, 0); g.lineTo(Math.cos(b) * s, Math.sin(b) * s); g.moveTo(Math.cos(b) * s * 0.55, Math.sin(b) * s * 0.55); g.lineTo(Math.cos(b + 0.5) * s * 0.8, Math.sin(b + 0.5) * s * 0.8); g.moveTo(Math.cos(b) * s * 0.55, Math.sin(b) * s * 0.55); g.lineTo(Math.cos(b - 0.5) * s * 0.8, Math.sin(b - 0.5) * s * 0.8); }
        g.stroke(); break;
      case 'claw': for (var c = -1; c <= 1; c++) { g.moveTo(c * s * 0.45, s * 0.6); g.quadraticCurveTo(c * s * 0.55 + s * 0.15, -s * 0.2, c * s * 0.3 + s * 0.25, -s); g.quadraticCurveTo(c * s * 0.45 - s * 0.05, -s * 0.1, c * s * 0.45 - s * 0.18, s * 0.6); } done(); break;
      case 'skull': g.arc(0, -s * 0.15, s * 0.7, PI * 0.85, PI * 2.15); g.lineTo(s * 0.4, s * 0.75); g.lineTo(-s * 0.4, s * 0.75); g.closePath(); done(); g.fillStyle = '#1b1b1f'; g.beginPath(); g.arc(-s * 0.28, -s * 0.12, s * 0.2, 0, TAU); g.arc(s * 0.28, -s * 0.12, s * 0.2, 0, TAU); g.fill(); break;
      case 'crown': g.moveTo(-s, s * 0.6); g.lineTo(-s, -s * 0.4); g.lineTo(-s * 0.5, s * 0.05); g.lineTo(0, -s * 0.8); g.lineTo(s * 0.5, s * 0.05); g.lineTo(s, -s * 0.4); g.lineTo(s, s * 0.6); g.closePath(); done(); break;
      case 'heart': g.moveTo(0, s * 0.85); g.bezierCurveTo(-s * 1.3, -s * 0.1, -s * 0.5, -s * 1.1, 0, -s * 0.35); g.bezierCurveTo(s * 0.5, -s * 1.1, s * 1.3, -s * 0.1, 0, s * 0.85); done(); break;
      case 'gear':
        for (var t2 = 0; t2 < 16; t2++) { var a2 = t2 * PI / 8, r2 = t2 % 2 ? s * 0.78 : s; g.lineTo(Math.cos(a2 - 0.12) * r2, Math.sin(a2 - 0.12) * r2); g.lineTo(Math.cos(a2 + 0.12) * r2, Math.sin(a2 + 0.12) * r2); }
        g.closePath(); done(); g.fillStyle = 'rgba(0,0,0,0.45)'; g.beginPath(); g.arc(0, 0, s * 0.3, 0, TAU); g.fill(); break;
      case 'moon': g.arc(0, 0, s, PI * 0.3, PI * 1.7); g.arc(s * 0.45, 0, s * 0.75, PI * 1.55, PI * 0.45, true); g.closePath(); done(); break;
      case 'dragon':
        /* stylised dragon head in profile facing right */
        g.moveTo(-s, s * 0.5); g.lineTo(-s * 0.7, -s * 0.3); g.lineTo(-s * 0.9, -s); g.lineTo(-s * 0.3, -s * 0.45); g.lineTo(s * 0.2, -s * 0.5);
        g.lineTo(s, -s * 0.1); g.lineTo(s * 0.95, s * 0.15); g.lineTo(s * 0.25, s * 0.15); g.lineTo(s * 0.8, s * 0.45); g.lineTo(s * 0.1, s * 0.6); g.lineTo(-s * 0.3, s); g.closePath(); done();
        g.fillStyle = '#fff3a0'; g.beginPath(); g.arc(s * 0.1, -s * 0.22, s * 0.11, 0, TAU); g.fill(); break;
      default: g.arc(0, 0, s * 0.7, 0, TAU); done();
    }
    g.restore();
    return this;
  };
  PP.scatter = function (kind, colors, n, s, where, seed, glowToo) {
    var r = rng(seed || 7), g = this.g, self = this;
    where = where || 't';
    if (where.indexOf('t') >= 0) this.around(function (reg) {
      for (var i = 0; i < n; i++) {
        var x = 6 + r() * (reg[2] - 12), y = 6 + r() * (reg[3] - 12), c = colors[(r() * colors.length) | 0];
        self.emblem(kind, c, x, y, s * (0.6 + r() * 0.6), false, g, reg);
        if (glowToo) self.emblem(kind, c, x, y, s * (0.6 + r() * 0.6), false, self.glowCtx(), reg);
      }
    });
    if (where.indexOf('a') >= 0) for (var j = 0; j < n * 0.7; j++) { var c2 = colors[(r() * colors.length) | 0], ax = 6 + r() * 52, ay = 6 + r() * (this.sleeveEnd - 10); self.emblem(kind, c2, ax, ay, s * 0.7, false, this.ga, [0, 0, 64, 128]); if (glowToo) { this.glowCtx(); self.emblem(kind, c2, ax, ay, s * 0.7, false, this.ega, [0, 0, 64, 128]); } }
    if (where.indexOf('l') >= 0) for (var k = 0; k < n * 0.7; k++) { var c3 = colors[(r() * colors.length) | 0], lx = 6 + r() * 52, ly = 6 + r() * 90; self.emblem(kind, c3, lx, ly, s * 0.7, false, this.gl, [0, 0, 64, 128]); if (glowToo) { this.glowCtx(); self.emblem(kind, c3, lx, ly, s * 0.7, false, this.egl, [0, 0, 64, 128]); } }
    return this;
  };
  /* glowing cracks (lava / storm): drawn on the colour map and on the emissive map */
  PP.cracks = function (color, n, seed, where, width) {
    var r = rng(seed || 3), self = this;
    this.glowCtx();
    function net(ctx, ectx, x, y, w, h, k) {
      for (var i = 0; i < k; i++) {
        var px = x + r() * w, py = y + r() * h, steps = 3 + ((r() * 4) | 0);
        [ctx, ectx].forEach(function (c) { c.strokeStyle = color; c.lineWidth = width || 3; c.lineCap = 'round'; c.beginPath(); c.moveTo(px, py); });
        var cx = px, cyy = py;
        for (var s2 = 0; s2 < steps; s2++) {
          cx += (r() - 0.5) * 34; cyy += (r() - 0.3) * 30;
          ctx.lineTo(cx, cyy); ectx.lineTo(cx, cyy);
        }
        ctx.stroke(); ectx.stroke();
      }
    }
    where = where || 'tal';
    var g = this.g, eg = this.eg;
    if (where.indexOf('t') >= 0) this.around(function (reg) { g.save(); eg.save(); [g, eg].forEach(function (c) { c.beginPath(); c.rect(reg[0], reg[1], reg[2], reg[3]); c.clip(); }); net(g, eg, reg[0], reg[1], reg[2], reg[3], n); g.restore(); eg.restore(); });
    if (where.indexOf('a') >= 0) net(this.ga, this.ega, 0, 0, 64, 118, Math.ceil(n * 0.5));
    if (where.indexOf('l') >= 0) net(this.gl, this.egl, 0, 0, 64, 110, Math.ceil(n * 0.5));
    return this;
  };
  PP.fur = function (color, where, seed) {
    var r = rng(seed || 11), self = this;
    function strokes(ctx, x, y, w, h, n) {
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (var i = 0; i < n; i++) {
        var px = x + r() * w, py = y + r() * h;
        ctx.strokeStyle = r() < 0.5 ? shade(color, 0.12) : shade(color, -0.12);
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + (r() - 0.5) * 6, py + 6 + r() * 5); ctx.stroke();
      }
    }
    var g = this.g;
    where = where || 't';
    if (where.indexOf('t') >= 0) this.around(function (reg) { strokes(g, reg[0], reg[1], reg[2], reg[3], reg[2] * reg[3] / 60); });
    if (where.indexOf('a') >= 0) strokes(this.ga, 0, 0, 64, this.sleeveEnd, 70);
    if (where.indexOf('l') >= 0) strokes(this.gl, 0, 0, 64, 100, 90);
    return this;
  };
  PP.facets = function (c1, c2, where, seed) {
    var r = rng(seed || 5);
    function tri(ctx, x, y, w, h) {
      var step = 22;
      for (var j = 0; j < h; j += step) for (var i = 0; i < w; i += step) {
        ctx.fillStyle = r() < 0.5 ? c1 : c2; ctx.globalAlpha = 0.5 + r() * 0.5;
        ctx.beginPath(); ctx.moveTo(x + i, y + j); ctx.lineTo(x + i + step, y + j); ctx.lineTo(x + i + (r() < 0.5 ? 0 : step), y + j + step); ctx.fill();
        ctx.fillStyle = r() < 0.5 ? c2 : c1;
        ctx.beginPath(); ctx.moveTo(x + i, y + j + step); ctx.lineTo(x + i + step, y + j + step); ctx.lineTo(x + i + step * r(), y + j); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.5;
      for (var k = 0; k < 10; k++) { ctx.beginPath(); ctx.moveTo(x + r() * w, y + r() * h); ctx.lineTo(x + r() * w, y + r() * h); ctx.stroke(); }
    }
    var g = this.g;
    where = where || 'ta';
    if (where.indexOf('t') >= 0) this.around(function (reg) { g.save(); g.beginPath(); g.rect(reg[0], reg[1], reg[2], reg[3]); g.clip(); tri(g, reg[0], reg[1], reg[2], reg[3]); g.restore(); });
    if (where.indexOf('a') >= 0) tri(this.ga, 0, 0, 64, this.sleeveEnd);
    if (where.indexOf('l') >= 0) tri(this.gl, 0, 0, 64, 100);
    return this;
  };
  PP.ribs = function (color) {
    var g = this.g, F = this.F(), B = this.S.nz;
    g.fillStyle = color; g.strokeStyle = color; g.lineCap = 'round';
    g.fillRect(F[0] + 58, F[1] + 8, 12, 96);
    for (var i = 0; i < 5; i++) {
      g.lineWidth = 8; var y = F[1] + 20 + i * 17;
      g.beginPath(); g.moveTo(F[0] + 62, y); g.quadraticCurveTo(F[0] + 30, y - 4, F[0] + 22 + i * 2, y + 12); g.stroke();
      g.beginPath(); g.moveTo(F[0] + 66, y); g.quadraticCurveTo(F[0] + 98, y - 4, F[0] + 106 - i * 2, y + 12); g.stroke();
    }
    g.fillRect(F[0] + 30, F[1] + 108, 68, 10);
    for (var j = 0; j < 8; j++) { g.fillRect(B[0] + 56, B[1] + 6 + j * 15, 16, 10); }
    this.ga.fillStyle = color; this.ga.fillRect(26, 6, 12, this.sleeveEnd - 12);
    this.ga.beginPath(); this.ga.arc(32, 8, 9, 0, TAU); this.ga.fill();
    this.gl.fillStyle = color; this.gl.fillRect(26, 6, 12, 94); this.gl.beginPath(); this.gl.arc(32, 56, 9, 0, TAU); this.gl.fill();
    return this;
  };
  PP.rainbow = function (where) {
    var cols = ['#ff4d4d', '#ff9f2e', '#ffe14a', '#5ad65a', '#3fa8ff', '#9b5cff'];
    function diag(ctx, x, y, w, h) {
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      for (var i = -10; i < 20; i++) { ctx.fillStyle = cols[(i + 60) % 6]; ctx.beginPath(); ctx.moveTo(x + i * 18, y); ctx.lineTo(x + i * 18 + 18, y); ctx.lineTo(x + i * 18 + 18 - h * 0.6, y + h); ctx.lineTo(x + i * 18 - h * 0.6, y + h); ctx.fill(); }
      ctx.restore();
    }
    var g = this.g;
    where = where || 'ta';
    if (where.indexOf('t') >= 0) this.around(function (reg) { diag(g, reg[0], reg[1], reg[2], reg[3]); });
    if (where.indexOf('a') >= 0) diag(this.ga, 0, 0, 64, this.sleeveEnd);
    if (where.indexOf('l') >= 0) diag(this.gl, 0, 0, 64, 100);
    return this;
  };
  PP.galaxy = function (c1, c2, where) {
    var self = this, r = rng(42);
    function sky(ctx, ectx, x, y, w, h, n) {
      var gr = ctx.createLinearGradient(x, y, x + w, y + h);
      gr.addColorStop(0, c1); gr.addColorStop(1, c2);
      ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
      for (var i = 0; i < 3; i++) {
        var rg = ctx.createRadialGradient(x + r() * w, y + r() * h, 0, x + r() * w, y + r() * h, 30);
        rg.addColorStop(0, 'rgba(255,120,220,0.35)'); rg.addColorStop(1, 'rgba(255,120,220,0)');
        ctx.fillStyle = rg; ctx.fillRect(x, y, w, h);
      }
      for (var k = 0; k < n; k++) {
        var sx = x + r() * w, sy = y + r() * h, rad = r() < 0.15 ? 2.4 : 1.2;
        [ctx, ectx].forEach(function (c) { c.fillStyle = '#ffffff'; c.beginPath(); c.arc(sx, sy, rad, 0, TAU); c.fill(); });
      }
    }
    this.glowCtx();
    var g = this.g, eg = this.eg;
    where = where || 'tal';
    if (where.indexOf('t') >= 0) this.around(function (reg) { g.save(); g.beginPath(); g.rect(reg[0], reg[1], reg[2], reg[3]); g.clip(); sky(g, eg, reg[0], reg[1], reg[2], reg[3], 26); g.restore(); });
    if (where.indexOf('a') >= 0) sky(this.ga, this.ega, 0, 0, 64, this.sleeveEnd, 12);
    if (where.indexOf('l') >= 0) sky(this.gl, this.egl, 0, 0, 64, 100, 14);
    return this;
  };
  PP.glowLine = function (color, pts, width, ctxName) {
    this.glowCtx();
    var ctxs = ctxName === 'a' ? [this.ga, this.ega] : ctxName === 'l' ? [this.gl, this.egl] : [this.g, this.eg];
    var F = ctxName ? [0, 0] : this.F();
    ctxs.forEach(function (c) {
      c.strokeStyle = color; c.lineWidth = width || 4; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); c.moveTo(F[0] + pts[0][0], F[1] + pts[0][1]);
      for (var i = 1; i < pts.length; i++) c.lineTo(F[0] + pts[i][0], F[1] + pts[i][1]);
      c.stroke();
    });
    return this;
  };
  PP.glowEmblem = function (kind, color, x, y, s) {
    this.emblem(kind, color, x, y, s, false);
    this.emblem(kind, color, x, y, s, false, this.glowCtx());
    return this;
  };
  PP.text = function (txt, color, x, y, size) {
    var g = this.g, F = this.F();
    g.font = '900 ' + (size || 40) + 'px Nunito, Arial Black, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.strokeText(txt, F[0] + x, F[1] + y);
    g.fillStyle = color; g.fillText(txt, F[0] + x, F[1] + y);
    return this;
  };
  PP.finish = function () {
    var S = this.S, g = this.g, Mm = Mo();
    ['pz', 'nz', 'px', 'nx', 'py', 'ny'].forEach(function (k) { var r = S[k]; Mm.toyShade(g, r[0], r[1], r[2], r[3], k === 'py' || k === 'ny' ? 0.4 : 1); });
    Mm.toyShade(this.ga, 0, 0, 64, 128, 0.8);
    Mm.toyShade(this.gl, 0, 0, 64, 128, 0.8);
    /* hand: a slightly darker palm line so the fist reads */
    this.ga.fillStyle = 'rgba(0,0,0,0.08)'; this.ga.fillRect(0, 118, 64, 10);
    return this;
  };
  PP.materials = function () {
    var e = this.e, out = {};
    function lam(map, emap) {
      var p = { map: tex(map) };
      if (emap) { p.emissive = new T.Color('#ffffff'); p.emissiveMap = tex(emap); p.emissiveIntensity = 1; }
      var m = new T.MeshLambertMaterial(p);
      m.userData.shared = true;
      return m;
    }
    out.torso = lam(this.tc, e && e.t);
    out.arm = lam(this.ac, e && e.a);
    out.leg = lam(this.lc, e && e.l);
    return out;
  };

  /* ---------------------------------------------------------------------- */
  /* 3D outfit pieces. Each returns [{ a: anchorName, o: Object3D }]         */
  /* Anchors (SE.Models.makeCharacter): shoulderL/R = arm pivots (arm box   */
  /* spans y 0..-2.3, x ±0.475); kneeL/R & footL/R in the leg pivots;       */
  /* waist / chest / back / neck / tail on the torso (torso 2.1×2.3×1.05).  */
  /* ---------------------------------------------------------------------- */
  function sides(anchorL, anchorR, fn) { return [{ a: anchorL, o: fn(-1) }, { a: anchorR, o: fn(1) }]; }
  function swingFront(node, k) {
    return live(node, function (n, dt, m) {
      var a = Math.min(m.legL.rotation.x, m.legR.rotation.x);
      n.rotation.x += ((a < 0 ? a * k : 0) - n.rotation.x) * Math.min(1, dt * 14);
    });
  }
  function swingBack(node, k) {
    return live(node, function (n, dt, m) {
      var a = Math.max(m.legL.rotation.x, m.legR.rotation.x);
      n.rotation.x += ((a > 0 ? a * k : 0) - n.rotation.x) * Math.min(1, dt * 14);
    });
  }
  var PART = {
    pads: function (style, c, acc, mo) {
      mo = mo || {};
      return sides('shoulderL', 'shoulderR', function (sd) {
        var g = new T.Group(), x = sd * 0.1, i;
        switch (style) {
          case 'plate':
            for (i = 0; i < 3; i++) g.add(P(bx(1.2 - i * 0.07, 0.15, 1.18 - i * 0.05, i ? shade(c, -0.05 * i) : c, mo), sd * (0.12 + i * 0.17), 0.12 - i * 0.2, 0, 0, 0, -sd * (0.38 + i * 0.12)));
            g.add(P(bx(0.1, 0.17, 1.2, acc, GOLD), sd * 0.62, -0.36, 0, 0, 0, -sd * 0.62));
            break;
          case 'spiky':
            g.add(P(hemi(0.62, c, mo), x, -0.1, 0, 0, 0, 0, [1.12, 0.8, 1.08]));
            for (i = 0; i < 3; i++) g.add(P(co(0.13, 0.62, acc, 6), x + sd * (0.1 + i * 0.12), 0.3 - i * 0.08, (i - 1) * 0.35, (i - 1) * 0.35, 0, -sd * (0.35 + i * 0.15)));
            break;
          case 'fur':
            [[0, 0.12, 0, 0.42], [sd * 0.3, -0.05, 0.3, 0.34], [sd * 0.3, -0.05, -0.3, 0.34], [sd * 0.45, -0.2, 0, 0.3]].forEach(function (s) { g.add(P(sp(s[3], c, { flat: true }, 7, 5), s[0], s[1], s[2], 0.3, s[0], 0, [1.2, 0.85, 1.1])); });
            break;
          case 'leaf':
            for (i = 0; i < 3; i++) g.add(P(sp(0.42, ['#4f9a2a', '#7cc84a', '#3d7f22'][i], { flat: true }, 6, 4), sd * (0.15 + i * 0.12), 0.12 - i * 0.1, (i - 1) * 0.38, (i - 1) * 0.2, 0, -sd * (0.4 + i * 0.12), [0.62, 0.13, 1.05]));
            break;
          case 'crystal':
            for (i = 0; i < 4; i++) g.add(P(oct(0.24 - i * 0.02, c, crystal(acc, 0.85)), x + sd * (i * 0.12), 0.3 + (i % 2) * 0.12, (i - 1.5) * 0.28, (i - 1.5) * 0.3, 0, -sd * (0.25 + i * 0.15), [1, 2.4, 1]));
            g.add(P(bx(1.05, 0.2, 1.05, shade(c, -0.25), crystal(acc, 0.95)), x, 0.02, 0));
            break;
          case 'rock':
            g.add(P(dod(0.6, c, { flat: true }), x, 0.02, 0, 0.4, 0.3, 0, [1.05, 0.68, 1]));
            for (i = 0; i < 3; i++) g.add(P(bx(0.42, 0.06, 0.1, acc, glow(acc, 1.6)), x + sd * 0.2, 0.08 + i * 0.1, -0.3 + i * 0.3, 0, i, -sd * 0.4));
            break;
          case 'layered':
            for (i = 0; i < 3; i++) {
              g.add(P(bx(0.09, 0.42, 1.05, c, { std: true, rough: 0.35 }), sd * (0.56 + i * 0.03), -0.12 - i * 0.4, 0, 0, 0, -sd * 0.1));
              g.add(P(bx(0.1, 0.05, 1.06, acc, GOLD), sd * (0.57 + i * 0.03), -0.32 - i * 0.4, 0, 0, 0, -sd * 0.1));
            }
            g.add(P(bx(1.0, 0.12, 1.0, c, { std: true, rough: 0.35 }), x * 0.5, 0.06, 0));
            break;
          case 'bolt':
            g.add(P(bx(1.15, 0.2, 1.12, c, STEEL), x, 0.04, 0, 0, 0, -sd * 0.2));
            g.add(P(shp([[0.05, 0], [0.45, 0], [0.2, 0.35], [0.5, 0.35], [-0.05, 1.05], [0.12, 0.5], [-0.15, 0.5]], 0.08, acc, glow(acc, 1.4)), x + sd * 0.15, 0.1, 0, 0, sd > 0 ? 0 : PI, -sd * 0.15));
            break;
          case 'dragon':
            g.add(P(hemi(0.64, c, mo), x, -0.08, 0, 0, 0, 0, [1.15, 0.85, 1.1]));
            g.add(P(bx(0.12, 0.22, 1.12, acc, GOLD), x + sd * 0.55, -0.15, 0, 0, 0, -sd * 0.5));
            g.add(P(co(0.13, 0.85, acc, 6, mo.emissive ? glow(acc, 1.3) : GOLD), x + sd * 0.2, 0.42, -0.2, -0.65, 0, -sd * 0.35));
            g.add(P(co(0.1, 0.55, acc, 6, mo.emissive ? glow(acc, 1.3) : GOLD), x + sd * 0.38, 0.28, 0.2, -0.45, 0, -sd * 0.6));
            break;
          case 'ice':
            g.add(P(bx(1.12, 0.18, 1.12, c, { std: true, rough: 0.3 }), x, 0.04, 0, 0, 0, -sd * 0.22));
            for (i = 0; i < 4; i++) g.add(P(co(0.13, 0.5 + (i % 2) * 0.35, acc, 5, crystal(acc, 0.8)), x + sd * (-0.15 + i * 0.16), 0.35, (i - 1.5) * 0.25, (i - 1.5) * 0.15, 0, -sd * (0.15 + i * 0.12)));
            break;
          case 'gold':
            g.add(P(hemi(0.64, c, GOLD), x, -0.08, 0, 0, 0, 0, [1.14, 0.8, 1.1]));
            g.add(P(oct(0.16, acc, { std: true, rough: 0.15, emissive: acc, ei: 0.4 }), x + sd * 0.3, 0.33, 0, 0, 0, 0, [1, 1.3, 1]));
            g.add(P(tor(0.62, 0.06, shade(c, -0.15), 5, 18, TAU, GOLD), x, -0.08, 0, PI / 2, 0, 0, [1.14, 1.1, 1]));
            break;
          case 'wing':
            g.add(P(hemi(0.62, c, GOLD), x, -0.08, 0, 0, 0, 0, [1.12, 0.8, 1.08]));
            for (i = 0; i < 3; i++) g.add(P(co(0.16, 1.15 - i * 0.2, i === 1 ? acc : c, 4, GOLD), x + sd * (0.25 + i * 0.08), 0.5, -0.2 + i * 0.05, -0.5 - i * 0.12, 0, -sd * (0.55 + i * 0.22), [1, 1, 0.35]));
            break;
          case 'mush':
            [[0, 0.1, 0, 0.4], [sd * 0.3, -0.05, 0.25, 0.32], [sd * 0.3, -0.05, -0.28, 0.32]].forEach(function (s) { g.add(P(sp(s[3], c, { flat: true }, 7, 5), s[0], s[1], s[2], 0, 0, 0, [1.2, 0.8, 1.1])); });
            [[0.05, -0.15, 0.55], [sd * 0.3, 0.2, 0.38]].forEach(function (s, j) {
              g.add(P(cy(0.06, 0.08, s[2], '#f0ead8', 6), s[0], 0.25 + s[2] / 2, s[1]));
              g.add(P(hemi(0.24 - j * 0.04, acc, { emissive: acc, ei: 0.25 }), s[0], 0.25 + s[2], s[1], 0, 0, 0, [1, 0.7, 1]));
            });
            break;
          case 'gear':
            if (sd < 0) {
              var gear = new T.Group();
              gear.add(cy(0.5, 0.5, 0.14, c, 14, GOLD));
              gear.add(cy(0.18, 0.18, 0.2, acc, 8, GOLD));
              for (i = 0; i < 10; i++) { var a = i * TAU / 10; gear.add(P(bx(0.18, 0.14, 0.16, c, GOLD), Math.cos(a) * 0.55, 0, Math.sin(a) * 0.55, 0, -a, 0)); }
              gear.rotation.z = PI / 2;
              var pv = P(new T.Group(), -0.42, 0.5, 0);
              pv.add(gear);
              g.add(live(pv, function (n, dt) { n.rotation.x += dt * 1.6; }));
            }
            g.add(P(bx(1.05, 0.16, 1.05, '#6b4a2b'), x, 0.04, 0, 0, 0, -sd * 0.2));
            break;
          case 'epaulette':
            g.add(P(bx(1.1, 0.12, 1.05, c, GOLD), x, 0.06, 0, 0, 0, -sd * 0.15));
            for (i = 0; i < 6; i++) g.add(P(cy(0.04, 0.04, 0.32, acc, 4, GOLD), sd * 0.6, -0.12, -0.42 + i * 0.17));
            break;
          case 'astro':
            g.add(P(hemi(0.62, c, { std: true, rough: 0.6 }), x, -0.1, 0, 0, 0, 0, [1.1, 0.75, 1.05]));
            g.add(P(tor(0.6, 0.06, acc, 5, 18), x, -0.12, 0, PI / 2, 0, 0, [1.1, 1.05, 1]));
            break;
          default: /* round */
            g.add(P(hemi(0.64, c, mo), x, -0.08, 0, 0, 0, 0, [1.12, 0.78, 1.08]));
            g.add(P(tor(0.62, 0.07, acc, 5, 18, TAU, GOLD), x, -0.08, 0, PI / 2, 0, 0, [1.12, 1.08, 1]));
        }
        return g;
      });
    },
    belt: function (c, buckle, o) {
      o = o || {};
      var g = new T.Group(), w = 2.18, d = 1.13, h = 0.3;
      g.add(P(bx(w, h, 0.08, c), 0, 0, d / 2), P(bx(w, h, 0.08, c), 0, 0, -d / 2), P(bx(0.08, h, d, c), w / 2, 0, 0), P(bx(0.08, h, d, c), -w / 2, 0, 0));
      if (buckle) g.add(P(bx(0.44, 0.38, 0.08, buckle, GOLD), 0, 0, d / 2 + 0.05), P(bx(0.24, 0.18, 0.06, c), 0, 0, d / 2 + 0.08));
      if (o.pouch) g.add(P(bx(0.46, 0.46, 0.3, o.pouch), -0.68, -0.15, d / 2 + 0.12), P(bx(0.48, 0.14, 0.32, shade(o.pouch, -0.1)), -0.68, 0.06, d / 2 + 0.12));
      if (o.pouch2) g.add(P(bx(0.4, 0.42, 0.28, o.pouch2), 0.72, -0.14, d / 2 + 0.11));
      if (o.coins) for (var i = 0; i < 7; i++) g.add(P(cy(0.13, 0.13, 0.04, '#ffd24a', 10, GOLD), -0.9 + i * 0.3, -0.24, d / 2 + 0.07, PI / 2, 0, 0));
      if (o.tool) g.add(P(bx(0.12, 0.7, 0.08, '#b8bec8', STEEL), 1.02, -0.3, 0.3, 0, 0, 0.2), P(tor(0.13, 0.05, '#b8bec8', 4, 8, TAU * 0.75, STEEL), 1.08, -0.68, 0.3));
      return [{ a: 'waist', o: g }];
    },
    collar: function (style, c, acc) {
      var g = new T.Group(), i;
      if (style === 'fur' || style === 'ermine') {
        for (i = 0; i < 12; i++) { var a = i * TAU / 12; g.add(P(sp(0.3, c, { flat: true }, 7, 5), Math.cos(a) * 0.98, 0.02, Math.sin(a) * 0.52, 0, a, 0, [1.2, 0.8, 1])); }
        if (style === 'ermine') for (i = 0; i < 8; i++) { var b = i * TAU / 8 + 0.2; g.add(P(bx(0.07, 0.16, 0.07, '#1b1b1f'), Math.cos(b) * 1.0, 0.25, Math.sin(b) * 0.55)); }
      } else if (style === 'high') {
        g.add(P(bx(1.7, 0.62, 0.12, c), 0, 0.26, -0.45, -0.3, 0, 0), P(bx(0.12, 0.5, 0.75, c), -0.82, 0.2, -0.1, 0, 0, 0.2), P(bx(0.12, 0.5, 0.75, c), 0.82, 0.2, -0.1, 0, 0, -0.2));
        if (acc) g.add(P(bx(1.72, 0.07, 0.13, acc, GOLD), 0, 0.56, -0.54, -0.3, 0, 0));
      } else if (style === 'scarf') {
        g.add(P(bx(1.62, 0.36, 0.22, c), 0, 0.08, 0.42), P(bx(1.62, 0.36, 0.22, c), 0, 0.08, -0.42), P(bx(0.22, 0.36, 1.0, c), 0.72, 0.08, 0), P(bx(0.22, 0.36, 1.0, c), -0.72, 0.08, 0));
        var tail = P(new T.Group(), -0.45, 0.0, 0.56);
        tail.add(P(bx(0.4, 1.0, 0.1, c), 0, -0.5, 0), P(bx(0.42, 0.12, 0.11, acc || shade(c, -0.15)), 0, -0.95, 0));
        g.add(live(tail, function (n, dt, m) { n.rotation.x = -0.15 - (m.moving ? 0.5 + Math.sin(m.time * 9) * 0.15 : Math.sin(m.time * 1.5) * 0.05); }));
      } else if (style === 'hood') {
        g.add(P(bx(1.5, 0.5, 0.6, c), 0, 0.12, -0.38, -0.25, 0, 0), P(hemi(0.74, c, null, 10), 0, 0.3, -0.52, -1.2, 0, 0, [1, 0.6, 0.6]));
        if (acc) g.add(P(bx(1.52, 0.08, 0.06, acc), 0, 0.36, -0.08, -0.25, 0, 0));
      } else if (style === 'ice') {
        for (i = 0; i < 7; i++) { var e = PI + (i - 3) * 0.42; g.add(P(co(0.12, 0.55 + (i % 2) * 0.3, c, 5, crystal(acc || c, 0.8)), Math.cos(e) * 0.85, 0.32, -Math.abs(Math.sin(e)) * 0.48 - 0.05, -0.3, 0, -Math.cos(e) * 0.4)); }
      }
      return [{ a: 'neck', o: g }];
    },
    skirt: function (style, c, acc) {
      var out = [], g, i;
      if (style === 'robe') {
        g = new T.Group();
        var cone = new T.CylinderGeometry(1.56, 1.98, 1.9, 4, 1, true);
        cone.rotateY(PI / 4); cone.scale(1, 1, 0.52);
        g.add(P(mesh(cone, c, { side: 2 }), 0, -0.82, 0));
        var hem = new T.CylinderGeometry(1.99, 2.02, 0.16, 4, 1, true);
        hem.rotateY(PI / 4); hem.scale(1, 1, 0.53);
        g.add(P(mesh(hem, acc || shade(c, -0.15), { side: 2 }), 0, -1.7, 0));
        out.push({ a: 'waist', o: g });
      } else if (style === 'tabard' || style === 'kilt' || style === 'coat') {
        var flaps = style === 'tabard' ? [[0, 0.6, 1.0, 1.25, 1], [0, -0.6, 1.0, 1.25, -1]]
          : style === 'kilt' ? [[0, 0.6, 1.0, 0.95, 1], [0, -0.6, 1.0, 0.95, -1], [1.1, 0, 0.5, 0.9, 0], [-1.1, 0, 0.5, 0.9, 0]]
            : [[-0.5, -0.6, 0.95, 1.35, -1], [0.5, -0.6, 0.95, 1.35, -1], [-0.78, 0.6, 0.5, 1.3, 1], [0.78, 0.6, 0.5, 1.3, 1]];
        flaps.forEach(function (f) {
          var pv = P(new T.Group(), f[0], 0.05, f[1]), side = f[4] === 0;
          var plate = side ? bx(0.07, f[3], f[2], c) : bx(f[2], f[3], 0.07, c);
          pv.add(P(plate, 0, -f[3] / 2, 0));
          if (acc) {
            if (side) pv.add(P(bx(0.08, 0.08, f[2] + 0.02, acc, GOLD), 0, -f[3] + 0.04, 0));
            else pv.add(P(bx(f[2] + 0.02, 0.09, 0.08, acc, GOLD), 0, -f[3] + 0.05, 0), P(bx(0.07, f[3], 0.08, acc, GOLD), -f[2] / 2 + 0.04, -f[3] / 2, 0), P(bx(0.07, f[3], 0.08, acc, GOLD), f[2] / 2 - 0.04, -f[3] / 2, 0));
          }
          if (style === 'kilt' && !side) for (i = 1; i < 3; i++) pv.add(P(bx(f[2], 0.04, 0.08, acc || shade(c, -0.2), GOLD), 0, -i * f[3] / 3, 0));
          if (side) pv.rotation.z = f[0] > 0 ? -0.12 : 0.12;
          else if (f[4] > 0) swingFront(pv, 0.75); else swingBack(pv, 0.75);
          out.push({ a: 'waist', o: pv });
        });
      } else if (style === 'leaf') {
        g = new T.Group();
        for (i = 0; i < 12; i++) {
          var a = i * TAU / 12, x = Math.cos(a) * 1.05, z = Math.sin(a) * 0.58;
          g.add(P(sp(0.36, ['#4f9a2a', '#7cc84a', '#3d7f22'][i % 3], { flat: true }, 6, 4), x, -0.45, z, Math.sin(a) * 0.25, -a + PI / 2, -Math.cos(a) * 0.25, [0.6, 1.25, 0.12]));
        }
        out.push({ a: 'waist', o: g });
      } else if (style === 'apron') {
        var bib = P(bx(1.3, 1.05, 0.06, c), 0, -0.2, 0.04);
        var pv2 = P(new T.Group(), 0, 0.02, 0.6);
        pv2.add(P(bx(1.7, 1.45, 0.06, c), 0, -0.72, 0), P(bx(1.0, 0.5, 0.08, acc || shade(c, -0.1)), 0, -0.5, 0.03));
        pv2.add(P(sp(0.24, '#7cc84a', null, 10, 8), 0.22, -0.28, 0.12, 0, 0, 0.2, [0.85, 1.15, 0.85]));
        pv2.add(P(sp(0.07, '#f6efc8', null, 6, 4), 0.14, -0.14, 0.32));
        swingFront(pv2, 0.6);
        out.push({ a: 'chest', o: bib }, { a: 'waist', o: pv2 });
        out.push({ a: 'neck', o: P(bx(1.32, 0.08, 0.1, c), 0, 0.02, 0.38) });
      }
      return out;
    },
    bracers: function (style, c, acc, mo) {
      mo = mo || {};
      return sides('shoulderL', 'shoulderR', function () {
        var g = new T.Group();
        if (style === 'gauntlet') {
          g.add(P(bx(1.08, 0.72, 1.08, c, mo), 0, -1.6, 0));
          var flare = new T.CylinderGeometry(0.88, 0.7, 0.32, 4, 1, true); flare.rotateY(PI / 4);
          g.add(P(mesh(flare, acc, { side: 2, metal: 0.5, rough: 0.35 }), 0, -1.12, 0));
        } else if (style === 'cuff') {
          var cf = new T.CylinderGeometry(0.62, 0.98, 0.55, 4, 1, true); cf.rotateY(PI / 4);
          g.add(P(mesh(cf, c, { side: 2 }), 0, -1.78, 0));
          g.add(P(bx(1.42, 0.08, 1.42, acc, GOLD), 0, -2.04, 0));
        } else if (style === 'big') {
          g.add(P(bx(1.15, 0.62, 1.15, c, { std: true, rough: 0.6 }), 0, -1.78, 0), P(bx(1.17, 0.12, 1.17, acc), 0, -1.48, 0));
        } else if (style === 'wrist') {
          g.add(P(bx(1.02, 0.28, 1.02, c), 0, -1.82, 0));
        } else {
          g.add(P(bx(1.05, 0.56, 1.05, c, mo), 0, -1.62, 0), P(bx(1.07, 0.08, 1.07, acc, GOLD), 0, -1.38, 0), P(bx(1.07, 0.08, 1.07, acc, GOLD), 0, -1.86, 0));
        }
        return g;
      });
    },
    greaves: function (style, c, acc, mo) {
      mo = mo || {};
      return sides('kneeL', 'kneeR', function () {
        var g = new T.Group();
        if (style === 'shin') {
          g.add(P(bx(1.08, 0.82, 1.08, c, mo), 0, -0.5, 0), P(bx(0.62, 0.42, 0.16, acc || c, mo.metal ? GOLD : mo), 0, 0.12, 0.55));
        } else if (style === 'cuff') {
          var cf = new T.CylinderGeometry(0.86, 0.72, 0.36, 4, 1, true); cf.rotateY(PI / 4);
          g.add(P(mesh(cf, c, { side: 2 }), 0, -0.36, 0));
        } else if (style === 'knee') {
          g.add(P(bx(0.82, 0.5, 0.14, c), 0, 0.02, 0.54));
        }
        return g;
      });
    },
    chest: function (kind, c, acc) {
      var g = new T.Group();
      if (kind === 'panel') {
        g.add(P(bx(1.1, 0.72, 0.16, c, { std: true, rough: 0.5 }), 0, -0.2, 0.06));
        ['#ff4a4a', '#4aff7a', '#4ab0ff'].forEach(function (col, i) { g.add(P(bx(0.18, 0.18, 0.06, col, glow(col, 1.2)), -0.3 + i * 0.3, -0.1, 0.16)); });
        g.add(P(bx(0.8, 0.12, 0.06, '#222222'), 0, -0.4, 0.16));
      } else if (kind === 'gem') {
        g.add(P(oct(0.3, c, { std: true, rough: 0.1, metal: 0.2, emissive: c, ei: 0.6 }), 0, -0.15, 0.12, 0, 0, 0, [1, 1.25, 0.6]));
        g.add(P(tor(0.34, 0.06, acc || '#ffd24a', 5, 16, TAU, GOLD), 0, -0.15, 0.06));
      } else if (kind === 'plate') {
        g.add(P(bx(1.75, 1.3, 0.14, c, STEEL), 0, -0.1, 0.07), P(bx(1.77, 0.1, 0.16, acc, GOLD), 0, 0.52, 0.07));
      }
      return [{ a: 'chest', o: g }];
    },
    medallion: function (chain, disc) {
      var g = new T.Group();
      g.add(P(bx(0.07, 1.0, 0.05, chain, GOLD), -0.32, 0.12, 0.03, 0, 0, -0.55), P(bx(0.07, 1.0, 0.05, chain, GOLD), 0.32, 0.12, 0.03, 0, 0, 0.55));
      g.add(P(cy(0.3, 0.3, 0.08, disc, 14, GOLD), 0, -0.3, 0.08, PI / 2, 0, 0), P(oct(0.12, '#e0303a', { std: true, rough: 0.15, emissive: '#e0303a', ei: 0.4 }), 0, -0.3, 0.14));
      return [{ a: 'chest', o: g }];
    },
    bandolier: function (c, pouch) {
      function strap(front) {
        var g = new T.Group();
        g.add(P(bx(0.3, 3.0, 0.08, c), 0, -0.35, front ? 0.03 : -0.03, 0, 0, front ? 0.72 : -0.72));
        if (front) for (var i = 0; i < 3; i++) g.add(P(bx(0.3, 0.32, 0.18, pouch), -0.55 + i * 0.5, 0.2 - i * 0.5, 0.1, 0, 0, 0.72));
        return g;
      }
      return [{ a: 'chest', o: strap(true) }, { a: 'back', o: strap(false) }];
    },
    spikes: function (c, n, size, mo) {
      var g = new T.Group();
      for (var i = 0; i < n; i++) g.add(P(co(0.16 * size, 0.55 * size, c, 4, mo), 0, 0.55 - i * (1.8 / Math.max(1, n - 1)), -0.12 * size, -PI / 2 + 0.35, 0, 0));
      return [{ a: 'back', o: g }];
    },
    tail: function (c, tip) {
      var root = new T.Group(), parent = root, segs = [];
      for (var i = 0; i < 4; i++) {
        var pv = P(new T.Group(), 0, 0, i ? -0.68 : 0);
        pv.rotation.x = i ? -0.18 : 0.55;
        pv.add(P(bx(0.56 - i * 0.1, 0.48 - i * 0.08, 0.78, c), 0, 0, -0.36));
        pv.add(P(co(0.1, 0.32, tip || '#ffd24a', 4), 0, 0.26 - i * 0.04, -0.36));
        parent.add(pv); parent = pv; segs.push(pv);
      }
      parent.add(P(co(0.22, 0.5, tip || '#ffd24a', 4), 0, 0, -0.95, -PI / 2, 0, 0));
      live(root, function (n, dt, m) {
        var amp = m.moving ? 0.32 : 0.14, sp2 = m.moving ? 9 : 2.2;
        for (var k = 0; k < segs.length; k++) segs[k].rotation.y = Math.sin(m.time * sp2 - k * 0.7) * amp;
      });
      return [{ a: 'tail', o: root }];
    },
    orbit: function (kind, c, acc) {
      var g = P(new T.Group(), 0, -0.35, -0.525), spin = new T.Group(), i;
      g.add(spin);
      if (kind === 'planet') {
        var pl = P(new T.Group(), 1.9, 0.9, 0);
        pl.add(sp(0.34, c, { emissive: c, ei: 0.25 }, 14, 10), P(tor(0.55, 0.05, acc || '#ffe9a8', 4, 24), 0, 0, 0, 1.2, 0, 0.3, [1, 1, 0.3]));
        spin.add(pl);
        spin.add(P(sp(0.12, '#dfe6ff', { emissive: '#9fb0ff', ei: 0.4 }, 8, 6), -1.7, 1.6, 0.6));
        spin.rotation.z = 0.25;
      } else {
        for (i = 0; i < 3; i++) {
          var o = kind === 'sparks' ? oct(0.14, c, glow(c, 1.6)) : oct(0.2, c, crystal(acc || c, 0.85));
          o.scale.set(1, kind === 'sparks' ? 1 : 2, 1);
          spin.add(P(o, Math.cos(i * TAU / 3) * 1.75, 0.3 + i * 0.45, Math.sin(i * TAU / 3) * 1.75));
        }
      }
      live(g, function (n, dt) { spin.rotation.y += dt * (kind === 'planet' ? 0.9 : 1.6); for (var k = 0; k < spin.children.length; k++) spin.children[k].rotation.y += dt * 2; });
      return [{ a: 'chest', o: g }];
    },
    goggles: function (c, lens) {
      var g = new T.Group();
      g.add(P(tor(0.98, 0.06, c, 4, 20), 0, 0.12, 0, PI / 2, 0, 0, [1, 0.58, 1]));
      [-0.3, 0.3].forEach(function (x) { g.add(P(cy(0.22, 0.22, 0.16, '#b8862f', 12, GOLD), x, 0.06, 0.58, PI / 2 - 0.3, 0, 0), P(cy(0.16, 0.16, 0.18, lens, 12, { std: true, rough: 0.1, emissive: lens, ei: 0.3 }), x, 0.06, 0.6, PI / 2 - 0.3, 0, 0)); });
      return [{ a: 'neck', o: g }];
    },
    clawToes: function (c) {
      return sides('footL', 'footR', function () {
        var g = new T.Group();
        for (var i = -1; i <= 1; i++) g.add(P(co(0.1, 0.32, c, 4), i * 0.32, 0.18, 0.78, PI / 2, 0, 0));
        return g;
      });
    },
    sashKnot: function (c) {
      var g = new T.Group();
      g.add(P(bx(0.4, 0.34, 0.2, c), -0.55, 0, 0.62));
      var tails = P(new T.Group(), -0.55, -0.12, 0.66);
      tails.add(P(bx(0.2, 0.8, 0.06, c), -0.12, -0.4, 0, 0, 0, 0.12), P(bx(0.2, 0.7, 0.06, c), 0.12, -0.35, 0, 0, 0, -0.12));
      g.add(live(tails, function (n, dt, m) { n.rotation.x = m.moving ? -0.55 - Math.sin(m.time * 10) * 0.12 : -0.05; }));
      return [{ a: 'waist', o: g }];
    },
    flames: function (c) {
      return sides('shoulderL', 'shoulderR', function (sd) {
        var g = new T.Group();
        for (var i = 0; i < 3; i++) {
          var f = P(co(0.16 - i * 0.03, 0.75 - i * 0.15, i ? '#ffd24a' : c, 5, { basic: true, opacity: 0.92 }), sd * (0.05 + i * 0.18), 0.6, (i - 1) * 0.3, 0, 0, -sd * 0.2);
          f.castShadow = false;
          g.add(live(f, (function (ph) { return function (n, dt, m) { var s = 0.8 + Math.sin(m.time * 13 + ph) * 0.2 + Math.sin(m.time * 7.3 + ph * 2) * 0.1; n.scale.set(1, s, 1); }; })(i * 1.7)));
        }
        return g;
      });
    }
  };
  function cat() { var out = []; for (var i = 0; i < arguments.length; i++) if (arguments[i]) out = out.concat(arguments[i]); return out; }

  /* ---------------------------------------------------------------------- */
  /* Outfits: style -> function(painter) -> parts                            */
  /* ---------------------------------------------------------------------- */
  function belly(Pn, c, line) {
    var g = Pn.g, F = Pn.F();
    g.fillStyle = c; g.beginPath(); g.moveTo(F[0] + 34, F[1] + 18); g.lineTo(F[0] + 94, F[1] + 18); g.lineTo(F[0] + 100, F[1] + 128); g.lineTo(F[0] + 28, F[1] + 128); g.fill();
    g.fillStyle = line; for (var y = 34; y < 128; y += 17) g.fillRect(F[0] + 32, F[1] + y, 64, 3);
  }
  function sideStripes(Pn, c) {
    var g = Pn.g, S = Pn.S;
    [S.px, S.nx].forEach(function (r) { g.fillStyle = c; g.fillRect(r[0] + 22, r[1], 8, r[3]); g.fillRect(r[0] + 34, r[1], 8, r[3]); });
  }
  var OUTFITS = {
    classic: function (p) {
      p.base('#ff8a1f', '#1d1d22', { sleeve: 'short', shoe: '#f4f4f4', sole: '#e04848' }).collarV('#d9650c', 14);
      p.emblem('egg', '#fff3d6', 64, 60, 22).emblem('leaf', '#5fd35a', 66, 38, 9, false);
      p.gl.fillStyle = 'rgba(255,255,255,0.18)'; p.gl.fillRect(0, 112, 64, 4);
      return [];
    },
    tamer: function (p) {
      p.base('#f1e3c2', '#5b3d24', { sleeve: 'long', boots: '#4a2f1a', bootH: 38, shoe: '#3d2615', sole: '#2a1a0e' }).vest('#8a5530', 0.32, '#c7924f').belt('#3e2716', '#e3b448', 0.82);
      p.emblem('claw', '#e3b448', 26, 34, 12);
      return cat(PART.belt('#3e2716', '#e3b448', { pouch: '#7a5232', pouch2: '#6a4628' }), PART.bracers('band', '#7a4f2c', '#c89b5c'), PART.greaves('cuff', '#4a2f1a'));
    },
    scale_hoodie: function (p) {
      p.base('#4fb84a', '#5d6470', { sleeve: 'long', shoe: '#2b2f35', sole: '#dfe4e8' }).scales('#4fb84a', '#2f8a34', 14, 'ta');
      belly(p, '#f0dc7a', '#c9b04e'); p.zip('#ffffff');
      p.cuffs('#2f8a34', 10);
      return cat(PART.collar('hood', '#45a842', '#2f8a34'), PART.spikes('#f0dc7a', 4, 0.9));
    },
    burglar: function (p) {
      p.base('#f4f4f4', '#26272e', { sleeve: 'long', glove: '#24252b', shoe: '#1e1f24', sole: '#3a3b44' }).stripes(['#f4f4f4', '#26272e'], 8, 'ta');
      return cat(PART.belt('#3a2a1e', '#bfbfbf', { pouch: '#4a3a2a' }), PART.collar('scarf', '#2b2c33', '#c8302f'));
    },
    farmhand: function (p) {
      p.base('#d83b3b', '#3f6fb8', { sleeve: 'mid', shoe: '#6b4423', sole: '#3d2615', boots: '#6b4423', bootH: 26 }).plaid('#d83b3b', '#8f1e22', '#f5d0a0').overalls('#3f6fb8', '#ffd24a');
      p.kneePads('#33589a');
      return cat(PART.greaves('knee', '#2f5596'));
    },
    explorer: function (p) {
      p.base('#c9a86a', '#b08a52', { sleeve: 'short', shorts: true, sock: '#f0ead8', shoe: '#5a3a22', sole: '#2a1a0e' }).pockets('#c9a86a').belt('#5a3a22', '#d8b25a', 0.86);
      return cat(PART.bandolier('#6b4a2b', '#8a6a3a'));
    },
    sprinter: function (p) {
      p.base('#e8443a', '#24324f', { sleeve: 'none', shorts: true, sock: '#ffffff', shoe: '#39e07a', sole: '#ffffff' });
      sideStripes(p, '#ffffff'); p.text('7', '#ffffff', 64, 64, 58).trim('#ffffff', 5).legStripe('#ffffff', 5);
      return cat(PART.bracers('wrist', '#ffffff', '#e8443a'));
    },
    leaf_tunic: function (p) {
      p.base('#5fae3b', '#6b4a2b', { sleeve: 'short', shoe: '#5a3a22', sole: '#3d2615' }).scatter('leaf', ['#4f9a2a', '#7cc84a', '#3d7f22'], 10, 16, 'ta', 5).belt('#6b4a2b', null, 0.8).legWraps('#8a6a3a', 70);
      return cat(PART.skirt('leaf'), PART.pads('leaf', '#5fae3b'));
    },
    keeper: function (p) {
      p.base('#ff9a3d', '#5a6270', { sleeve: 'mid', glove: '#ffd84a', shoe: '#3a3f47', sole: '#f0f0f0' });
      return cat(PART.skirt('apron', '#f6f1e3', '#e2d6b8'));
    },
    firefighter: function (p) {
      p.base('#d9b04a', '#3a3a3a', { sleeve: 'long', glove: '#2b2b2b', boots: '#1f1f1f', bootH: 50, shoe: '#1a1a1a', sole: '#444444' }).band(0.6, 0.68, '#d7e0e0', true).band(0.86, 0.94, '#d7e0e0').buttons('#333333', 4);
      p.gl.fillStyle = '#d7e0e0'; p.gl.fillRect(0, 60, 64, 8);
      return cat(PART.collar('high', '#c49a34'), PART.skirt('coat', '#d9b04a', null));
    },
    pirate: function (p) {
      p.base('#f4efe2', '#2d2a35', { sleeve: 'long', boots: '#3a2416', bootH: 46, shoe: '#2a190f', sole: '#1a0e08' }).vest('#2d2a35', 0.38, '#d9a93a').band(0.76, 0.88, '#c8302f');
      return cat(PART.belt('#3a2416', '#e3b448', {}), PART.pads('epaulette', '#d9a93a', '#d9a93a'), PART.greaves('cuff', '#3a2416'));
    },
    ninja: function (p) {
      p.base('#2b2f4a', '#2b2f4a', { sleeve: 'long', glove: '#1c1f33', shoe: '#1c1f33', sole: '#555b7a' }).armWraps('#41466b', 50).legWraps('#41466b', 64);
      var g = p.g, F = p.F(); g.strokeStyle = '#41466b'; g.lineWidth = 12; g.beginPath(); g.moveTo(F[0] + 20, F[1]); g.lineTo(F[0] + 84, F[1] + 100); g.moveTo(F[0] + 108, F[1]); g.lineTo(F[0] + 44, F[1] + 100); g.stroke();
      p.belt('#c8302f', null, 0.8);
      return cat(PART.sashKnot('#c8302f'), [PART.pads('plate', '#41466b', '#8a8fb0')[0]]);
    },
    mage: function (p) {
      p.base('#5b3aa8', '#3b2670', { sleeve: 'long', shoe: '#2a1a50', sole: '#d9a93a' }).scatter('star', ['#ffd84a', '#fff3b0'], 5, 9, 'ta', 9).trim('#ffd84a', 6).emblem('moon', '#ffd84a', 64, 52, 16);
      p.g.fillStyle = '#ffd84a'; p.g.fillRect(p.F()[0] + 61, p.F()[1] + 70, 6, 58);
      return cat(PART.skirt('robe', '#5b3aa8', '#ffd84a'), PART.collar('high', '#3b2670', '#ffd84a'), PART.bracers('cuff', '#5b3aa8', '#ffd84a'));
    },
    viking: function (p) {
      p.base('#8a8f99', '#6b5a48', { sleeve: 'mid', boots: '#5a3a22', bootH: 40, shoe: '#4a2f1a', sole: '#2a1a0e' }).vest('#8a5530', 0.3).fur('#8a5530', 't').belt('#4a2f1a', '#c0c6cf', 0.84).legWraps('#3d2a18', 64);
      return cat(PART.pads('fur', '#a0784a'), PART.belt('#4a2f1a', '#c0c6cf', {}), PART.bracers('band', '#9aa1ab', '#5a3a22', STEEL));
    },
    knight: function (p) {
      p.base('#9aa3ad', '#7d8590', { sleeve: 'long', glove: '#8a929c', shoe: '#6b737c', sole: '#3a3f45' }).chainmail('#b8c0c8', 'tal').tabard('#2f5fb8', '#ffd84a', 'dragon', '#ffd84a').belt('#4a2f1a', '#ffd84a', 0.84);
      return cat(PART.pads('round', '#c8d0d8', '#ffd84a', STEEL), PART.bracers('gauntlet', '#c8d0d8', '#ffd84a', STEEL), PART.greaves('shin', '#c8d0d8', '#ffd84a', STEEL), PART.skirt('tabard', '#2f5fb8', '#ffd84a'));
    },
    druid: function (p) {
      p.base('#5e7a3a', '#4a3a28', { sleeve: 'long', shoe: '#3d2a18', sole: '#2a1a0e' }).fur('#4f6b30', 'ta').scatter('leaf', ['#7cc84a', '#3d7f22'], 5, 12, 'ta', 3).belt('#6b4a2b', null, 0.8);
      return cat(PART.pads('mush', '#4f8a3a', '#3fd0c0'), PART.skirt('robe', '#4a6b2e', '#7cc84a'), PART.collar('fur', '#5a7a35'));
    },
    nomad: function (p) {
      p.base('#e3c48e', '#c9a46a', { sleeve: 'long', shoe: '#8a5a2b', sole: '#5a3a1a' }).sash('#2f8f9a', '#e3c48e').band(0.78, 0.88, '#b5532f').legWraps('#b08850', 88);
      return cat(PART.collar('scarf', '#2f8f9a', '#e3c48e'), PART.belt('#8a5a2b', '#e3b448', { pouch: '#a0703a' }));
    },
    astronaut: function (p) {
      p.base('#f2f4f7', '#f2f4f7', { sleeve: 'long', glove: '#ffffff', shoe: '#d0d4da', sole: '#8a9099' }).band(0.0, 0.07, '#ff8a2e');
      p.ga.fillStyle = '#ff8a2e'; p.ga.fillRect(0, 20, 64, 8); p.gl.fillStyle = '#ff8a2e'; p.gl.fillRect(0, 30, 64, 8);
      p.emblem('star', '#3f6fd8', 30, 30, 10, false);
      return cat(PART.chest('panel', '#c8ced8'), PART.bracers('big', '#ffffff', '#ff8a2e'), PART.greaves('cuff', '#e8ecf0'), PART.pads('astro', '#ffffff', '#ff8a2e'));
    },
    rainbow: function (p) {
      p.base('#ffffff', '#f4f4f4', { sleeve: 'long', shoe: '#ffffff', sole: '#ff5aa0' }).rainbow('ta').zip('#ffffff', 'rgba(255,255,255,0.4)');
      ['#ff4d4d', '#ffe14a', '#3fa8ff'].forEach(function (c, i) { p.gl.fillStyle = c; p.gl.fillRect(0, 88 + i * 8, 64, 8); });
      return cat(PART.collar('hood', '#ff6ab0', '#ffffff'));
    },
    samurai: function (p) {
      p.base('#2a2a33', '#2a2a33', { sleeve: 'long', glove: '#1c1c22', shoe: '#1c1c22', sole: '#c8302f' }).plates('#c8302f', '#7a1414', 5, 'ta', '#ffd84a').emblem('dragon', '#ffd84a', 64, 60, 26).legWraps('#7a1414', 60);
      return cat(PART.pads('layered', '#c8302f', '#ffd84a'), PART.skirt('kilt', '#c8302f', '#ffd84a'), PART.greaves('shin', '#c8302f', '#ffd84a', { std: true, rough: 0.35 }));
    },
    onesie: function (p) {
      p.base('#4fbf5a', '#4fbf5a', { sleeve: 'long', glove: '#4fbf5a', shoe: '#3f9f48', sole: '#2d7a35' }).scales('#4fbf5a', '#3a9a44', 16, 'tal');
      belly(p, '#f6e08a', '#d8c060');
      return cat(PART.spikes('#ffd24a', 5, 1.1), PART.tail('#4fbf5a', '#ffd24a'), PART.clawToes('#ffffff'), PART.collar('hood', '#4fbf5a', '#ffd24a'));
    },
    frost_robe: function (p) {
      p.base('#7ec8ef', '#4a86c8', { sleeve: 'long', shoe: '#e8f4ff', sole: '#7ec8ef' }).scatter('snow', ['#ffffff', '#d8f0ff'], 5, 10, 'ta', 4).trim('#ffffff', 7);
      return cat(PART.skirt('robe', '#5fa8e0', '#ffffff'), PART.collar('fur', '#ffffff'), PART.pads('ice', '#bfe6ff', '#8fd8ff'));
    },
    lava: function (p) {
      p.base('#2a2224', '#2a2224', { sleeve: 'long', glove: '#1e1819', shoe: '#1e1819', sole: '#ff6a1f' }).plates('#332a2c', '#1a1415', 4, 'tal').cracks('#ff7a1f', 7, 3, 'tal', 3);
      return cat(PART.pads('rock', '#3a2e2f', '#ff6a1f'), PART.belt('#1e1819', '#ff8a2e', {}), PART.greaves('shin', '#3a2e2f', '#ff6a1f'));
    },
    tinker: function (p) {
      p.base('#f0e6d0', '#5a4636', { sleeve: 'mid', glove: '#6b4a2b', shoe: '#3d2a18', sole: '#2a1a0e' }).vest('#8a5a2b', 0.34, '#d8a948').scatter('gear', ['#d8a948', '#b8862f'], 2, 12, 't', 8).legStripe('#3d2e22', 4);
      return cat(PART.pads('gear', '#b8862f', '#d8a948'), PART.goggles('#6b4a2b', '#8fd8ff'), PART.belt('#4a2f1a', '#d8a948', { tool: true }));
    },
    bone: function (p) {
      p.base('#232329', '#232329', { sleeve: 'long', glove: '#efe9da', shoe: '#1b1b20', sole: '#efe9da' }).ribs('#efe9da');
      return cat(PART.spikes('#efe9da', 5, 0.85), PART.pads('spiky', '#2b2b31', '#efe9da'));
    },
    royal: function (p) {
      p.base('#b0242f', '#3a1f5a', { sleeve: 'long', shoe: '#2a1530', sole: '#d9a93a' }).trim('#ffd84a', 7).buttons('#ffd84a', 4);
      return cat(PART.skirt('robe', '#b0242f', '#ffd84a'), PART.collar('ermine', '#ffffff'), PART.medallion('#ffd84a', '#ffd84a'), PART.pads('epaulette', '#ffd84a', '#ffd84a'));
    },
    storm: function (p) {
      p.base('#33405a', '#26314a', { sleeve: 'long', glove: '#26314a', shoe: '#1e2638', sole: '#7fe0ff' }).plates('#3a4a68', '#1c2436', 4, 'tal');
      p.glowEmblem('bolt', '#9ff0ff', 64, 60, 26).glowLine('#7fe0ff', [[8, 20], [24, 40], [14, 52], [30, 74]], 3).glowLine('#7fe0ff', [[120, 90], [104, 104], [114, 112], [98, 126]], 3);
      p.glowLine('#7fe0ff', [[20, 10], [40, 40], [26, 50], [44, 80]], 3, 'a');
      return cat(PART.pads('bolt', '#3a4a68', '#7fe0ff'), PART.orbit('sparks', '#9ff0ff'), PART.bracers('gauntlet', '#3a4a68', '#7fe0ff', STEEL));
    },
    crystal: function (p) {
      p.base('#7a5cd0', '#4a3a8a', { sleeve: 'long', glove: '#9f8af0', shoe: '#5a48a8', sole: '#bfe9ff' }).facets('#9f8af0', '#6fd0f0', 'tal');
      return cat(PART.pads('crystal', '#a8e8ff', '#c49aff'), PART.chest('gem', '#c49aff', '#bfe9ff'), PART.orbit('crystals', '#8fe8ff', '#c49aff'), PART.greaves('shin', '#8f7ae0', '#bfe9ff', { std: true, rough: 0.2 }));
    },
    hoard: function (p) {
      p.base('#e0a400', '#8a5a00', { sleeve: 'long', glove: '#ffd24a', shoe: '#a87400', sole: '#5a3a00' }).plates('#f0b929', '#b07a00', 4, 'tal', '#fff1a0').scatter('gem', ['#e0303a', '#2f7fe0', '#2fbf5a'], 3, 10, 't', 6);
      return cat(PART.pads('gold', '#ffd24a', '#e0303a'), PART.belt('#7a4a00', '#ffd24a', { coins: true }), PART.chest('gem', '#e0303a'), PART.bracers('band', '#ffd24a', '#e0303a', GOLD));
    },
    galaxy: function (p) {
      p.base('#1c1440', '#140e30', { sleeve: 'long', glove: '#2a1f5a', shoe: '#140e30', sole: '#b48cff' }).galaxy('#2a1a6a', '#0d0a26', 'tal');
      return cat(PART.orbit('planet', '#ffb35a', '#ffe9a8'), PART.pads('round', '#2a1f5a', '#b48cff', { std: true, rough: 0.3, emissive: '#3a2a8a', ei: 0.4 }));
    },
    /* Daily Gift exclusives */
    dragon_knight: function (p) {
      p.base('#2f5a3a', '#26402c', { sleeve: 'long', glove: '#2a3f2e', shoe: '#1e2e22', sole: '#d9a93a' }).scales('#3f7a4a', '#24452c', 12, 'tal').tabard('#1f3a28', '#e3b448', 'dragon', '#e3b448');
      return cat(PART.pads('dragon', '#3f7a4a', '#e3b448', { std: true, metal: 0.4, rough: 0.4 }), PART.skirt('tabard', '#1f3a28', '#e3b448'), PART.bracers('gauntlet', '#3f7a4a', '#e3b448', { std: true, metal: 0.4, rough: 0.4 }), PART.greaves('shin', '#3f7a4a', '#e3b448', { std: true, metal: 0.4, rough: 0.4 }));
    },
    frost_warden: function (p) {
      p.base('#e8f4ff', '#9ec8e8', { sleeve: 'long', glove: '#cfe8ff', shoe: '#8fb8d8', sole: '#ffffff' }).plates('#d8ecff', '#8fb8e0', 4, 'tal', '#ffffff').glowEmblem('snow', '#46c8ff', 64, 56, 24);
      p.glowLine('#46c8ff', [[32, 10], [32, 90]], 4, 'a');
      return cat(PART.pads('ice', '#d8ecff', '#8fd8ff'), PART.collar('fur', '#ffffff'), PART.skirt('kilt', '#bcdcf5', '#6fd8ff'), PART.bracers('gauntlet', '#d8ecff', '#6fd8ff', { std: true, rough: 0.3 }), PART.collar('ice', '#bfe6ff', '#8fd8ff'));
    },
    ember_lord: function (p) {
      p.base('#1a1416', '#1a1416', { sleeve: 'long', glove: '#2a1e1f', shoe: '#140f10', sole: '#ff5a1a' }).plates('#2a2022', '#120c0d', 5, 'tal', '#ff8a2e').cracks('#ff6a1f', 6, 9, 'tal', 3.5).glowEmblem('flame', '#ffb02e', 64, 58, 24);
      return cat(PART.pads('dragon', '#2a2022', '#ff6a1f', { emissive: '#000000' }), PART.flames('#ff6a1f'), PART.collar('high', '#2a2022', '#ff8a2e'), PART.skirt('coat', '#2a2022', '#ff6a1f'));
    },
    aurora_paladin: function (p) {
      p.base('#f6f3ea', '#e8e2d0', { sleeve: 'long', glove: '#ffd24a', shoe: '#d9a93a', sole: '#2a3f9a' }).plates('#fbf8f0', '#d9c27a', 4, 'ta', '#e3b448').tabard('#2a3f9a', '#ffd24a', 'star', '#ffd24a');
      p.scatter('star', ['#ffd84a'], 2, 6, 't', 12, true);
      return cat(PART.pads('wing', '#ffd24a', '#ffffff'), PART.skirt('tabard', '#2a3f9a', '#ffd24a'), PART.chest('gem', '#6fb0ff', '#ffd24a'), PART.greaves('shin', '#f6f3ea', '#ffd24a', GOLD));
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Hats: style -> () => [object, hairMode, lift]                           */
  /* Hat space: y = 0 is the top face of the 1.5³ head (head centre y=-0.75)  */
  /* x/z ±0.75 are the head sides, +z is the face.                           */
  /* ---------------------------------------------------------------------- */
  function lathe(pts, c, o, seg) {
    var v = pts.map(function (p) { return new T.Vector2(p[0], p[1]); });
    return mesh(new T.LatheGeometry(v, seg || 16), c, o);
  }
  function star3d(r, depth, c, o) {
    var pts = [];
    for (var i = 0; i < 10; i++) { var a = PI / 2 + i * PI / 5, rad = i % 2 ? r * 0.45 : r; pts.push([Math.cos(a) * rad, Math.sin(a) * rad]); }
    return shp(pts, depth, c, o);
  }
  function bolt3d(s, c, o) { return shp([[0.1 * s, 0.5 * s], [-0.22 * s, -0.02 * s], [0.02 * s, -0.02 * s], [-0.12 * s, -0.5 * s], [0.25 * s, 0.08 * s], [0.0, 0.08 * s]], 0.06 * s, c, o); }
  var HATS = {
    beanie: function () {
      var g = grp(P(bx(1.64, 0.46, 1.64, '#c0392b'), 0, 0.02, 0), P(hemi(0.84, '#e04848', null, 14), 0, 0.24, 0, 0, 0, 0, [1, 0.6, 1]), P(sp(0.3, '#ffffff', { flat: true }, 8, 6), 0, 0.8, 0));
      for (var i = 0; i < 8; i++) g.add(P(bx(0.06, 0.44, 0.04, '#a32e23'), -0.7 + i * 0.2, 0.02, 0.83));
      return [g, 'flat', 0.7];
    },
    party: function () {
      var g = new T.Group(), cols = ['#ff5aa0', '#ffd84a', '#3fc8ff'], radii = [0.58, 0.4, 0.22, 0.001];
      for (var i = 0; i < 3; i++) g.add(P(cy(radii[i + 1], radii[i], 0.5, cols[i], 14), 0, 0.25 + i * 0.5, 0));
      g.add(P(sp(0.18, '#ffffff', { flat: true }, 8, 6), 0, 1.55, 0));
      g.rotation.z = -0.18; g.position.x = 0.12;
      return [grp(g), 'keep', 1.6];
    },
    chef: function () {
      var g = grp(P(cy(0.8, 0.78, 0.5, '#f4f4f4', 16), 0, 0.24, 0));
      [[0.32, 0.3], [-0.32, 0.3], [0.32, -0.3], [-0.32, -0.3]].forEach(function (p) { g.add(P(sp(0.5, '#ffffff', null, 12, 9), p[0], 0.85, p[1])); });
      g.add(P(sp(0.62, '#fbfbfb', null, 12, 9), 0, 1.05, 0));
      return [g, 'flat', 1.5];
    },
    bandana: function () {
      var c = '#c8302f', g = grp(P(bx(1.62, 0.34, 0.08, c), 0, -0.36, 0.79), P(bx(1.62, 0.34, 0.08, c), 0, -0.36, -0.79), P(bx(0.08, 0.34, 1.62, c), 0.79, -0.36, 0), P(bx(0.08, 0.34, 1.62, c), -0.79, -0.36, 0));
      g.add(P(bx(0.62, 0.26, 0.05, '#c8ced8', STEEL), 0, -0.36, 0.84), P(bx(0.3, 0.3, 0.2, c), 0.25, -0.36, -0.86));
      var tails = P(new T.Group(), 0.25, -0.4, -0.9);
      tails.add(P(bx(0.18, 0.75, 0.05, c), -0.08, -0.36, 0, 0, 0, 0.25), P(bx(0.18, 0.65, 0.05, c), 0.1, -0.32, 0, 0, 0, -0.2));
      g.add(live(tails, function (n, dt, m) { n.rotation.x = m.moving ? 0.9 + Math.sin(m.time * 11) * 0.15 : 0.15 + Math.sin(m.time * 1.4) * 0.05; }));
      return [g, 'keep', 0];
    },
    cowboy: function () {
      var c = '#b07a3a';
      var brim = lathe([[0.001, 0], [0.75, 0], [1.1, 0.04], [1.32, 0.16], [1.36, 0.22], [1.3, 0.2], [1.06, 0.1], [0.75, 0.06], [0.001, 0.06]], c, { side: 2 }, 20);
      brim.scale.set(1, 1, 0.82);
      var g = grp(P(brim, 0, 0.0, 0), P(cy(0.6, 0.72, 0.78, c, 14), 0, 0.42, 0), P(cy(0.73, 0.73, 0.16, '#4a2f1a', 14), 0, 0.15, 0), P(bx(0.18, 0.12, 0.9, shade(c, -0.12)), 0, 0.8, 0));
      g.add(P(star3d(0.12, 0.04, '#ffd24a', GOLD), 0, 0.15, 0.74));
      return [g, 'flat', 0.9];
    },
    propeller: function () {
      var g = new T.Group(), cols = ['#e0303a', '#ffd84a', '#2f7fe0', '#2fbf5a'];
      for (var i = 0; i < 4; i++) g.add(P(mesh(new T.SphereGeometry(0.84, 8, 6, i * PI / 2, PI / 2, 0, PI / 2), cols[i]), 0, -0.05, 0, 0, 0, 0, [1, 0.62, 1]));
      g.add(P(bx(0.95, 0.06, 0.5, '#2f7fe0'), 0, -0.02, 0.86), P(cy(0.05, 0.05, 0.42, '#c8ced8', 6), 0, 0.68, 0), P(sp(0.09, '#e0303a', null, 8, 6), 0, 0.9, 0));
      var prop = P(new T.Group(), 0, 0.92, 0);
      prop.add(P(bx(1.5, 0.04, 0.22, '#ffd84a'), 0, 0, 0, 0.25, 0, 0), P(bx(0.22, 0.04, 1.5, '#e0303a'), 0, 0.01, 0, 0, 0, 0.25));
      g.add(live(prop, function (n, dt, m) { n.rotation.y += dt * (m.moving ? 22 : 8); }));
      return [g, 'flat', 1.0];
    },
    mushroom: function () {
      var g = grp(P(hemi(1.06, '#e0303a', null, 16), 0, 0.08, 0, 0, 0, 0, [1, 0.66, 1]), P(cy(1.0, 0.7, 0.12, '#f4e7c8', 16), 0, 0.04, 0));
      [[0.3, 0], [0.75, 0.6], [0.8, 2.2], [0.7, 3.6], [0.6, 5.0], [1.0, 1.4], [0.95, 4.3]].forEach(function (d) {
        var th = d[0], ph = d[1];
        g.add(P(sp(0.15 + (th < 0.5 ? 0.06 : 0), '#ffffff', null, 8, 6), Math.sin(th) * Math.cos(ph) * 1.02, 0.08 + Math.cos(th) * 0.68, Math.sin(th) * Math.sin(ph) * 1.02, 0, 0, 0, [1, 0.45, 1]));
      });
      return [g, 'flat', 0.85];
    },
    eggshell: function () {
      var g = grp(P(hemi(1.1, '#f6efdc', null, 14), 0, -0.34, 0, 0, 0, 0, [1, 1.08, 1]));
      for (var i = 0; i < 12; i++) { var a = i * TAU / 12; g.add(P(co(0.16, 0.36, '#f6efdc', 4), Math.cos(a) * 1.04, -0.42, Math.sin(a) * 1.04, PI, 0, 0)); }
      [[0.5, 0.6], [1.0, 2.0], [0.8, 3.3], [0.4, 4.4], [0.9, 5.4], [0.2, 1.0]].forEach(function (d) {
        g.add(P(sp(0.1, '#b9a07a', null, 6, 4), Math.sin(d[0]) * Math.cos(d[1]) * 1.1, -0.34 + Math.cos(d[0]) * 1.18, Math.sin(d[0]) * Math.sin(d[1]) * 1.1, 0, 0, 0, [1, 0.5, 1]));
      });
      return [g, 'hide', 0.95];
    },
    tamer_helm: function () {
      var c = '#7a4f2c', g = grp(P(bx(1.66, 0.5, 1.66, c), 0, -0.08, 0), P(hemi(0.82, c, null, 12), 0, 0.16, 0, 0, 0, 0, [1, 0.45, 1]));
      g.add(P(bx(0.1, 0.85, 0.6, shade(c, -0.08)), 0.84, -0.6, 0.05), P(bx(0.1, 0.85, 0.6, shade(c, -0.08)), -0.84, -0.6, 0.05));
      g.add(P(bx(1.68, 0.16, 0.1, '#3d2615'), 0, -0.02, 0.84));
      [-0.33, 0.33].forEach(function (x) { g.add(P(cy(0.25, 0.25, 0.16, '#b8862f', 12, GOLD), x, 0.06, 0.88, PI / 2, 0, 0), P(cy(0.19, 0.19, 0.18, '#ffb347', 12, { std: true, rough: 0.12, emissive: '#ff9a2e', ei: 0.25 }), x, 0.06, 0.9, PI / 2, 0, 0)); });
      return [g, 'hide', 0.4];
    },
    viking: function () {
      var g = grp(P(hemi(1.0, '#a8b0ba', STEEL, 14), 0, -0.26, 0, 0, 0, 0, [1, 0.78, 1]), P(tor(0.98, 0.08, '#b8862f', 5, 20, TAU, GOLD), 0, -0.26, 0, PI / 2, 0, 0), P(bx(0.16, 0.62, 0.1, '#a8b0ba', STEEL), 0, -0.52, 0.98));
      g.add(P(bx(0.12, 0.75, 1.9, '#b8862f', GOLD), 0, 0.12, 0, 0, 0, 0, [1, 1, 1]));
      [-1, 1].forEach(function (sd) {
        var h = P(new T.Group(), sd * 0.82, 0.0, 0);
        h.add(P(cy(0.14, 0.2, 0.55, '#f0e6c8', 8), sd * 0.18, 0.18, 0, 0, 0, -sd * 1.05));
        var h2 = P(new T.Group(), sd * 0.42, 0.34, 0, 0, 0, -sd * 0.55);
        h2.add(P(cy(0.09, 0.14, 0.5, '#f0e6c8', 8), 0, 0.22, 0), P(co(0.09, 0.42, '#fff8e8', 8), 0, 0.66, 0, 0, 0, sd * 0.3));
        h.add(h2); g.add(h);
      });
      return [g, 'flat', 0.8];
    },
    wizard: function () {
      var c = '#5b3aa8', g = grp(P(cy(1.25, 1.25, 0.07, c, 22), 0, 0.04, 0), P(cy(0.73, 0.73, 0.18, '#ffd24a', 16, GOLD), 0, 0.16, 0));
      var s1 = P(new T.Group(), 0, 0.06, 0), s2 = P(new T.Group(), 0, 0.92, 0, -0.3, 0, 0), s3 = P(new T.Group(), 0, 0.68, 0, -0.5, 0, 0);
      s1.add(P(cy(0.46, 0.72, 0.92, c, 16), 0, 0.46, 0)); s2.add(P(cy(0.26, 0.46, 0.7, c, 14), 0, 0.35, 0)); s3.add(P(cy(0.001, 0.26, 0.62, c, 12), 0, 0.31, 0));
      s3.add(P(star3d(0.13, 0.04, '#ffd84a', glow('#ffd84a', 0.6)), 0, 0.68, 0));
      s2.add(s3); s1.add(s2); g.add(s1);
      g.add(P(star3d(0.16, 0.04, '#ffd84a', glow('#ffd84a', 0.5)), 0.25, 0.6, 0.62, -0.2, 0.3, 0), P(star3d(0.1, 0.04, '#fff3b0', glow('#fff3b0', 0.5)), -0.3, 0.95, 0.5, -0.3, -0.3, 0));
      return [g, 'flat', 1.8];
    },
    pirate: function () {
      var c = '#24242c', g = grp(P(cy(0.72, 0.8, 0.52, c, 12), 0, 0.26, 0));
      var corners = [PI / 2, PI / 2 + TAU / 3, PI / 2 + 2 * TAU / 3].map(function (a) { return [Math.cos(a) * 1.25, Math.sin(a) * 1.25]; });
      g.add(P(shp(corners, 0.08, c), 0, 0.04, 0, -PI / 2, 0, 0));
      for (var i = 0; i < 3; i++) {
        var a = corners[i], b = corners[(i + 1) % 3], mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2, len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        var dx = b[0] - a[0], dz = b[1] - a[1];
        var wall = P(new T.Group(), mx, 0.06, mz, 0, -Math.atan2(dz, dx), 0);
        var tilt = new T.Group();
        tilt.rotation.x = 0.4 * (mx * -dz + mz * dx > 0 ? 1 : -1);
        wall.add(tilt);
        tilt.add(P(bx(len * 0.92, 0.5, 0.08, c), 0, 0.24, 0), P(bx(len * 0.92, 0.06, 0.1, '#d9a93a', GOLD), 0, 0.5, 0));
        g.add(wall);
      }
      g.add(P(sp(0.17, '#f4f0e6', null, 8, 6), 0, 0.32, 0.8), P(bx(0.24, 0.06, 0.04, '#f4f0e6'), 0, 0.14, 0.82, 0, 0, 0.6), P(bx(0.24, 0.06, 0.04, '#f4f0e6'), 0, 0.14, 0.82, 0, 0, -0.6));
      return [g, 'flat', 0.6];
    },
    top_hat: function () {
      var g = grp(P(cy(1.0, 1.0, 0.07, '#1d1d24', 22), 0, 0.04, 0), P(cy(0.66, 0.68, 1.28, '#22222a', 18), 0, 0.68, 0), P(cy(0.69, 0.69, 0.24, '#c8302f', 18), 0, 0.2, 0));
      g.add(P(bx(0.22, 0.16, 0.06, '#ffd24a', GOLD), 0, 0.2, 0.69));
      return [g, 'flat', 1.35];
    },
    horns: function () {
      var g = new T.Group();
      [-1, 1].forEach(function (sd) {
        var h = P(new T.Group(), sd * 0.5, 0.0, 0.05, -0.35, 0, -sd * 0.42, 1.35);
        h.add(P(cy(0.15, 0.22, 0.5, '#3a2a22', 8), 0, 0.25, 0));
        var h2 = P(new T.Group(), 0, 0.48, 0, -0.45, 0, 0);
        h2.add(P(cy(0.1, 0.15, 0.45, '#5a4434', 8), 0, 0.22, 0), P(co(0.1, 0.4, '#f0e6c8', 8), 0, 0.62, 0, -0.3, 0, 0));
        h.add(h2); g.add(h);
      });
      for (var i = 0; i < 3; i++) g.add(P(co(0.1, 0.28, '#3a2a22', 4), 0, 0.12, 0.35 - i * 0.38, -0.4, 0, 0));
      return [g, 'keep', 0.8];
    },
    antlers: function () {
      var c = '#8a5a2b', g = new T.Group();
      [-1, 1].forEach(function (sd) {
        var a = P(new T.Group(), sd * 0.45, 0.0, -0.05, 0, 0, -sd * 0.55);
        a.add(P(cy(0.07, 0.11, 1.0, c, 6), 0, 0.5, 0));
        [[0.3, 0.6, 0.6], [0.55, -0.7, 0.5], [0.8, 0.5, 0.42]].forEach(function (t, k) {
          var tine = P(new T.Group(), 0, t[0] + 0.2, 0, 0, 0, sd * t[1] * (k === 1 ? -1 : 1));
          tine.add(P(cy(0.04, 0.06, t[2], c, 5), 0, t[2] / 2, 0)); a.add(tine);
        });
        a.add(P(sp(0.22, '#7cc84a', { flat: true }, 6, 4), sd * 0.15, 0.85, 0.12, 0.3, 0, sd * 0.6, [0.5, 1.2, 0.12]));
        a.add(P(sp(0.18, '#4f9a2a', { flat: true }, 6, 4), -sd * 0.12, 0.6, 0.1, -0.2, 0, -sd * 0.5, [0.5, 1.2, 0.12]));
        g.add(a);
      });
      g.add(P(cy(0.05, 0.06, 0.14, '#f0ead8', 6), 0.38, 0.07, 0.3), P(hemi(0.14, '#3fd0c0', { emissive: '#3fd0c0', ei: 0.3 }), 0.38, 0.14, 0.3));
      return [g, 'keep', 1.0];
    },
    headphones: function () {
      var g = grp(P(tor(0.9, 0.09, '#2b2f3a', 6, 20, PI), 0, -0.36, 0));
      [-1, 1].forEach(function (sd) {
        g.add(P(cy(0.42, 0.42, 0.3, '#2b2f3a', 16), sd * 0.92, -0.42, 0, 0, 0, PI / 2), P(cy(0.36, 0.36, 0.08, '#e04a8a', 16), sd * 0.78, -0.42, 0, 0, 0, PI / 2));
        g.add(P(tor(0.3, 0.05, '#3fd0ff', 5, 18, TAU, glow('#3fd0ff', 1.2)), sd * 1.08, -0.42, 0, 0, PI / 2, 0));
      });
      return [g, 'keep', 0.6];
    },
    feather_cap: function () {
      var c = '#3f8a3a', g = grp(P(hemi(0.86, c, null, 12), 0, -0.06, 0, 0, 0, 0, [1, 0.58, 1.05]), P(co(0.52, 1.25, c, 6), 0, 0.32, -0.55, -1.2, 0, 0), P(bx(1.25, 0.06, 0.42, shade(c, -0.1)), 0, 0.02, 0.78, -0.3, 0, 0));
      g.add(P(sp(0.62, '#e0303a', null, 8, 6), 0.55, 0.65, -0.15, 0.3, 0, -0.55, [0.14, 1, 0.32]));
      g.add(P(cy(0.012, 0.012, 1.1, '#f4f0e6', 4), 0.55, 0.62, -0.15, 0.3, 0, -0.55));
      return [g, 'flat', 0.9];
    },
    nest: function () {
      var g = grp(P(tor(0.62, 0.24, '#8a5a2b', 5, 12, TAU, { flat: true }), 0, 0.16, 0, PI / 2, 0, 0), P(cy(0.62, 0.6, 0.1, '#6b4423', 12), 0, 0.06, 0));
      for (var i = 0; i < 9; i++) { var a = i * TAU / 9; g.add(P(bx(0.9, 0.06, 0.08, i % 2 ? '#a8804a' : '#7a5232'), Math.cos(a) * 0.62, 0.22 + (i % 3) * 0.05, Math.sin(a) * 0.62, 0, -a + 0.4, 0.2)); }
      [['#7cc84a', -0.2, 0.1], ['#8fd8ff', 0.22, 0.08], ['#f6efc8', 0.0, -0.25]].forEach(function (e) { g.add(P(sp(0.2, e[0], null, 10, 8), e[1], 0.3, e[2], 0, 0, 0, [1, 1.3, 1])); });
      return [g, 'flat', 0.6];
    },
    astronaut: function () {
      var glass = P(sp(1.28, '#a8dcff', { std: true, rough: 0.05, metal: 0.1, opacity: 0.36, emissive: '#3a8adf', ei: 0.15 }, 20, 14), 0, -0.72, 0);
      glass.castShadow = false; glass.renderOrder = 3;
      var g = grp(glass, P(tor(1.0, 0.18, '#f2f4f7', 8, 22), 0, -1.62, 0, PI / 2, 0, 0), P(cy(0.04, 0.04, 0.6, '#c8ced8', 6), 0.55, 0.65, 0), P(sp(0.1, '#ff3a3a', glow('#ff3a3a', 1.3), 8, 6), 0.55, 0.98, 0));
      return [g, 'keep', 0.8];
    },
    dragon_hood: function () {
      var c = '#45a842', d = '#2f8a34', g = grp(P(bx(1.7, 0.2, 1.72, c), 0, 0.08, 0), P(bx(1.7, 1.45, 0.16, c), 0, -0.6, -0.86), P(bx(0.16, 1.25, 1.72, c), 0.86, -0.5, 0), P(bx(0.16, 1.25, 1.72, c), -0.86, -0.5, 0));
      g.add(P(bx(1.12, 0.5, 0.8, c), 0, 0.24, 0.72), P(bx(1.0, 0.16, 0.72, d), 0, 0.02, 0.76));
      g.add(P(bx(0.16, 0.1, 0.05, '#1b1b1f'), -0.25, 0.32, 1.13), P(bx(0.16, 0.1, 0.05, '#1b1b1f'), 0.25, 0.32, 1.13));
      for (var i = 0; i < 5; i++) g.add(P(co(0.07, 0.2, '#ffffff', 4), -0.4 + i * 0.2, -0.08, 1.06, PI, 0, 0));
      [-1, 1].forEach(function (sd) {
        g.add(P(bx(0.3, 0.24, 0.06, '#ffd84a', glow('#ffd84a', 0.25)), sd * 0.42, 0.5, 0.45), P(bx(0.1, 0.2, 0.07, '#1b1b1f'), sd * 0.42, 0.5, 0.47));
        g.add(P(co(0.13, 0.6, '#f0e6c8', 6), sd * 0.52, 0.48, -0.45, -0.85, 0, -sd * 0.25));
      });
      for (var k = 0; k < 3; k++) g.add(P(co(0.12, 0.3, '#ffd84a', 4), 0, 0.12 - k * 0.42, -0.95, -PI / 2 + 0.4, 0, 0));
      return [g, 'hide', 0.8];
    },
    knight: function () {
      var s = '#8f99a5', g = grp(P(bx(1.68, 1.68, 1.68, s, STEEL), 0, -0.72, 0), P(bx(1.22, 0.14, 0.06, '#15171c'), 0, -0.55, 0.85), P(bx(0.14, 1.3, 0.06, '#d9a93a', GOLD), 0, -0.7, 0.86));
      for (var i = 0; i < 6; i++) g.add(P(bx(0.07, 0.07, 0.05, '#15171c'), 0.3 + (i % 3) * 0.14, -0.95 - ((i / 3) | 0) * 0.14, 0.85));
      for (var k = 0; k < 5; k++) g.add(P(sp(0.32, k % 2 ? '#e0303a' : '#c8302f', { flat: true }, 7, 5), 0, 0.28 + Math.sin(k / 4 * PI) * 0.2, 0.6 - k * 0.32, 0, 0, 0, [0.35, 1, 0.9]));
      return [g, 'hide', 1.0];
    },
    samurai: function () {
      var g = grp(P(hemi(0.95, '#2a2a33', { std: true, rough: 0.35 }, 14), 0, -0.22, 0, 0, 0, 0, [1, 0.72, 1]));
      var guard = new T.CylinderGeometry(0.98, 1.38, 0.6, 14, 1, true, PI * 0.18, PI * 1.64);
      g.add(P(mesh(guard, '#c8302f', { side: 2, std: true, rough: 0.35 }), 0, -0.5, 0));
      var rim = new T.CylinderGeometry(1.39, 1.41, 0.08, 14, 1, true, PI * 0.18, PI * 1.64);
      g.add(P(mesh(rim, '#ffd24a', { side: 2, metal: 0.45, rough: 0.35 }), 0, -0.8, 0));
      [-1, 1].forEach(function (sd) { g.add(P(co(0.12, 1.2, '#ffd24a', 4, GOLD), sd * 0.38, 0.38, 0.9, 0, 0, -sd * 0.55, [1, 1, 0.3])); });
      g.add(P(cy(0.18, 0.18, 0.06, '#ffd24a', 12, GOLD), 0, -0.05, 0.95, PI / 2, 0, 0));
      return [g, 'hide', 1.0];
    },
    crown: function () {
      var g = grp(P(cy(0.82, 0.78, 0.4, '#ffd24a', 10, GOLD), 0, 0.2, 0), P(hemi(0.72, '#b0242f', null, 10), 0, 0.22, 0, 0, 0, 0, [1, 0.55, 1]));
      for (var i = 0; i < 5; i++) {
        var a = i * TAU / 5 + PI / 2;
        g.add(P(co(0.18, 0.5, '#ffd24a', 4, GOLD), Math.cos(a) * 0.78, 0.62, Math.sin(a) * 0.78), P(sp(0.07, '#fff3b0', GOLD, 6, 4), Math.cos(a) * 0.78, 0.9, Math.sin(a) * 0.78));
        g.add(P(oct(0.1, i % 2 ? '#2f7fe0' : '#e0303a', { std: true, rough: 0.15, emissive: i % 2 ? '#2f7fe0' : '#e0303a', ei: 0.35 }), Math.cos(a) * 0.82, 0.2, Math.sin(a) * 0.82));
      }
      return [g, 'flat', 0.95];
    },
    ice_crown: function () {
      var g = grp(P(tor(0.72, 0.09, '#bfe9ff', 5, 18, TAU, crystal('#8fd8ff', 0.85)), 0, 0.05, 0, PI / 2, 0, 0));
      for (var i = 0; i < 9; i++) {
        var a = i * TAU / 9, h = 0.55 + ((i * 7) % 4) * 0.18 + (i === 2 ? 0.35 : 0);
        g.add(P(co(0.15, h, i % 2 ? '#9fe0ff' : '#5fc0ff', 5, crystal('#3fa8ff', 0.92)), Math.cos(a) * 0.68, h / 2, Math.sin(a) * 0.68, Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12));
      }
      return [g, 'keep', 1.2];
    },
    dragon_skull: function () {
      var b = '#efe9da', g = grp(P(bx(1.72, 0.6, 1.76, b), 0, 0.08, -0.02), P(bx(1.76, 0.26, 0.3, b), 0, -0.14, 0.85), P(bx(1.1, 0.38, 0.72, b), 0, 0.16, 1.12));
      [-1, 1].forEach(function (sd) {
        g.add(P(bx(0.36, 0.22, 0.06, '#1b1b1f'), sd * 0.45, 0.12, 0.88), P(sp(0.07, '#ff4a2a', glow('#ff4a2a', 1.2), 6, 4), sd * 0.45, 0.12, 0.9));
        var horn = P(new T.Group(), sd * 0.6, 0.25, -0.5, -1.05, 0, -sd * 0.35);
        horn.add(P(cy(0.12, 0.2, 0.7, b, 7), 0, 0.35, 0), P(co(0.12, 0.6, '#d8cfb8', 7), 0, 0.98, 0, -0.35, 0, 0));
        g.add(horn);
      });
      for (var i = 0; i < 5; i++) g.add(P(co(0.06, 0.2, '#ffffff', 4), -0.4 + i * 0.2, -0.08, 1.4, PI, 0, 0));
      g.add(P(bx(0.12, 0.08, 0.05, '#1b1b1f'), -0.22, 0.28, 1.49), P(bx(0.12, 0.08, 0.05, '#1b1b1f'), 0.22, 0.28, 1.49));
      return [g, 'hide', 0.9];
    },
    jester: function () {
      var g = grp(P(hemi(0.86, '#7b3fd0', null, 12), 0, -0.04, 0, 0, 0, 0, [1, 0.5, 1]), P(cy(0.86, 0.86, 0.2, '#ffd24a', 14), 0, 0.02, 0));
      [[-1, '#e0303a'], [0, '#7b3fd0'], [1, '#2f7fe0']].forEach(function (p, k) {
        var pr = P(new T.Group(), p[0] * 0.42, 0.3, p[0] === 0 ? -0.2 : 0.05, p[0] === 0 ? -0.55 : 0, 0, -p[0] * 0.75);
        pr.add(P(cy(0.12, 0.3, 0.75, p[1], 8), 0, 0.37, 0));
        var tip = P(new T.Group(), 0, 0.72, 0, 0, 0, -(p[0] || 0.6) * 0.9);
        tip.add(P(cy(0.01, 0.12, 0.6, p[1], 8), 0, 0.3, 0), P(sp(0.12, '#ffd24a', GOLD, 8, 6), 0, 0.62, 0));
        pr.add(live(tip, function (n, dt, m) { n.rotation.x = Math.sin(m.time * (m.moving ? 12 : 3) + k) * (m.moving ? 0.35 : 0.1); }));
        g.add(pr);
      });
      return [g, 'flat', 1.1];
    },
    flame_crown: function () {
      var g = grp(P(cy(0.8, 0.76, 0.36, '#c88a1a', 10, GOLD), 0, 0.18, 0), P(tor(0.8, 0.05, '#7a3a0a', 4, 10), 0, 0.36, 0, PI / 2, 0, 0));
      for (var i = 0; i < 7; i++) {
        var a = i * TAU / 7, h = 0.7 + (i % 2) * 0.35;
        var f = P(new T.Group(), Math.cos(a) * 0.66, 0.34, Math.sin(a) * 0.66);
        var o1 = P(co(0.2, h, '#ff6a1f', 6, { basic: true, opacity: 0.92 }), 0, h / 2, 0), o2 = P(co(0.11, h * 0.65, '#ffe14a', 6, { basic: true }), 0, h * 0.33, 0);
        o1.castShadow = o2.castShadow = false; f.add(o1, o2);
        g.add(live(f, (function (ph) { return function (n, dt, m) { var s = 0.75 + Math.sin(m.time * 14 + ph) * 0.18 + Math.sin(m.time * 9.1 + ph * 3) * 0.12; n.scale.set(1, s, 1); }; })(i * 1.3)));
        g.add(P(oct(0.09, '#ff3a1a', glow('#ff3a1a', 1)), Math.cos(a + 0.45) * 0.8, 0.18, Math.sin(a + 0.45) * 0.8));
      }
      return [g, 'keep', 1.3];
    },
    halo: function () {
      var ring = P(tor(0.68, 0.09, '#ffd84a', 8, 32, TAU, { emissive: '#ffcc33', ei: 1.1 }), 0, 0, 0, PI / 2, 0, 0);
      ring.castShadow = false;
      var g = new T.Group(), hold = P(new T.Group(), 0, 0.95, 0);
      hold.add(ring);
      for (var i = 0; i < 3; i++) hold.add(P(oct(0.07, '#fffbe0', glow('#fff3b0', 1.4)), Math.cos(i * TAU / 3) * 0.95, 0.1, Math.sin(i * TAU / 3) * 0.95));
      g.add(live(hold, function (n, dt, m) { n.position.y = 0.95 + Math.sin(m.time * 2) * 0.08; n.rotation.y += dt * 0.8; }));
      return [g, 'keep', 1.3];
    },
    baby_dragon: function () {
      var c = '#5fd35a', d = '#3fa83a', cream = '#f6e7a8';
      var dr = P(new T.Group(), 0, 0.02, -0.05);
      dr.add(P(bx(0.72, 0.55, 0.95, c), 0, 0.3, 0), P(bx(0.5, 0.36, 0.7, cream), 0, 0.2, 0.12));
      [[-0.28, 0.32], [0.28, 0.32], [-0.28, -0.3], [0.28, -0.3]].forEach(function (l) { dr.add(P(bx(0.2, 0.3, 0.24, d), l[0], 0.08, l[1])); });
      var head = P(new T.Group(), 0, 0.72, 0.42);
      head.add(P(bx(0.66, 0.56, 0.6, c), 0, 0, 0), P(bx(0.46, 0.26, 0.3, d), 0, -0.1, 0.38));
      [-1, 1].forEach(function (sd) {
        head.add(P(bx(0.18, 0.2, 0.05, '#ffffff'), sd * 0.18, 0.08, 0.3), P(bx(0.09, 0.12, 0.06, '#1b1b1f'), sd * 0.18, 0.06, 0.32), P(co(0.07, 0.28, cream, 5), sd * 0.18, 0.38, -0.12, -0.5, 0, 0));
      });
      dr.add(live(head, function (n, dt, m) { n.rotation.y = Math.sin(m.time * 1.3) * 0.4; n.rotation.x = Math.sin(m.time * 2.1) * 0.08; }));
      [-1, 1].forEach(function (sd) {
        var w = P(new T.Group(), sd * 0.34, 0.5, -0.05);
        var mem = shp([[0, 0], [0.75, 0.45], [0.62, 0.05], [0.8, -0.2], [0.3, -0.18]], 0.03, '#ffd84a', { side: 2 });
        if (sd < 0) mem.scale.x = -1;
        w.add(mem);
        dr.add(live(w, function (n, dt, m) { n.rotation.y = sd * (-0.35 + Math.sin(m.time * 9) * 0.45); }));
      });
      var tail = P(new T.Group(), 0, 0.25, -0.45);
      tail.add(P(bx(0.22, 0.2, 0.55, c), 0, -0.05, -0.25, 0.6, 0, 0), P(co(0.12, 0.24, '#ffd84a', 4), 0, -0.3, -0.55, -2.2, 0, 0));
      dr.add(live(tail, function (n, dt, m) { n.rotation.y = Math.sin(m.time * 3) * 0.4; }));
      return [grp(dr), 'flat', 1.35];
    },
    storm_cloud: function () {
      var cloud = P(new T.Group(), 0, 1.35, 0);
      [[0, 0, 0, 0.55], [0.55, -0.08, 0.1, 0.42], [-0.55, -0.06, -0.05, 0.45], [0.2, 0.25, -0.15, 0.4], [-0.25, 0.2, 0.2, 0.38]].forEach(function (s) { cloud.add(P(sp(s[3], '#e8eef5', { flat: true }, 9, 7), s[0], s[1], s[2])); });
      cloud.add(P(sp(0.6, '#8a96a8', { flat: true }, 9, 7), 0, -0.22, 0, 0, 0, 0, [1.6, 0.4, 1.0]));
      var bolt = P(bolt3d(1, '#ffe14a', glow('#ffe14a', 1.8)), 0.15, -0.65, 0.1);
      bolt.castShadow = false;
      cloud.add(bolt);
      var drops = [];
      for (var i = 0; i < 6; i++) { var dd = P(bx(0.04, 0.2, 0.04, '#6fb8ff', { emissive: '#3a7fd0', ei: 0.4 }), -0.5 + i * 0.2, -0.5, (i % 2) * 0.25 - 0.1); dd.castShadow = false; drops.push(dd); cloud.add(dd); }
      live(cloud, function (n, dt, m) {
        n.position.y = 1.35 + Math.sin(m.time * 1.6) * 0.08;
        bolt.visible = Math.sin(m.time * 7.3) > 0.55 || Math.sin(m.time * 3.1) > 0.9;
        for (var k = 0; k < drops.length; k++) { var y = -0.45 - ((m.time * 2.2 + k * 0.37) % 1) * 0.9; drops[k].position.y = y; }
      });
      return [grp(cloud), 'keep', 2.0];
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Back items: style -> (build params) => [{ a, o }]                        */
  /* Back space: y = 0 upper back (torso top at +0.8, bottom at -1.5),       */
  /* x ±1.05, −z points away from the body.                                  */
  /* ---------------------------------------------------------------------- */
  var CAPE_TEX = {};
  function capeTexture(color, trim, emblem) {
    var key = color + trim + emblem;
    if (CAPE_TEX[key]) return CAPE_TEX[key];
    var c = cvs(128, 160), g = c.getContext('2d');
    g.fillStyle = color; g.fillRect(0, 0, 128, 160);
    var gr = g.createLinearGradient(0, 0, 128, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.18)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(0,0,0,0.18)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 160);
    g.fillStyle = trim; g.fillRect(0, 148, 128, 12); g.fillRect(0, 0, 6, 160); g.fillRect(122, 0, 6, 160);
    if (emblem) Painter.prototype.emblem.call({ g: g, F: function () { return [0, 0]; } }, emblem, trim, 64, 70, 30, 'rgba(0,0,0,0.35)', g, [0, 0, 128, 160]);
    var t = tex(c); t.userData.shared = true;
    return CAPE_TEX[key] = t;
  }
  function wingPair(build, opts) {
    opts = opts || {};
    var out = new T.Group(), wings = [];
    [-1, 1].forEach(function (sd) {
      var pv = P(new T.Group(), sd * (opts.x || 0.35), opts.y === undefined ? 0.2 : opts.y, opts.z || -0.12);
      var w = build(sd);
      if (sd < 0) w.scale.x = -1;
      pv.add(w);
      wings.push({ pv: pv, sd: sd });
      out.add(pv);
    });
    var base = opts.base === undefined ? 0.45 : opts.base, amp = opts.amp || 0.22, freq = opts.freq || 2.4;
    live(out, function (n, dt, m) {
      var run = m.moving ? 1 : 0, air = m.grounded === false ? 1 : 0;
      var f = freq * (1 + run * 1.2 + air * 1.6), a = amp * (1 + run * 0.6 + air * 1.2);
      var s = Math.sin(m.time * f * TAU * 0.5);
      for (var k = 0; k < wings.length; k++) {
        var wg = wings[k];
        wg.pv.rotation.y = wg.sd * (base - run * 0.15 + s * a);
        wg.pv.rotation.z = wg.sd * (opts.tilt || 0.18) * (1 + s * 0.5);
      }
    });
    return out;
  }
  function dragonWing(kind) {
    var pal = {
      meadow: { bone: '#5fae3b', mem: '#d6e86a', spike: '#4f9a2a', mo: null },
      ember: { bone: '#1e1819', mem: '#ff5a1f', spike: '#ff8a2e', mo: { emissive: '#ff3a00', ei: 0.45 } },
      frost: { bone: '#dff3ff', mem: '#2a5fb8', spike: '#bfe9ff', mo: { std: true, rough: 0.2, opacity: 0.88, emissive: '#1a3f8a', ei: 0.3 } },
      aurora: { bone: '#ffd24a', mem: '#24307a', spike: '#fff3b0', mo: { emissive: '#1a2470', ei: 0.35 } }
    }[kind] || {};
    return function () {
      var g = new T.Group();
      var memMat = mat(pal.mem, Object.assign({ side: 2 }, pal.mo || {}));
      if (kind === 'aurora') {
        var c = cvs(64, 64), x = c.getContext('2d'); x.fillStyle = '#24307a'; x.fillRect(0, 0, 64, 64);
        for (var i = 0; i < 6; i++) Painter.prototype.emblem.call(null, 'star', '#ffd84a', 8 + (i * 23) % 52, 8 + (i * 37) % 52, 5, false, x, [0, 0, 64, 64]);
        var t = tex(c); t.wrapS = t.wrapT = T.RepeatWrapping;
        memMat = new T.MeshLambertMaterial({ map: t, side: T.DoubleSide, emissive: new T.Color('#1a2470'), emissiveIntensity: 0.5 });
      }
      var pts = [[0, 0], [1.2, 1.2], [2.45, 1.65], [1.95, 0.95], [2.65, 0.42], [2.02, 0.02], [1.95, -0.62], [1.12, -0.46], [0.3, -0.72], [0, -0.3]];
      g.add(shp(pts, 0.04, memMat));
      var bone = pal.bone, bo = kind === 'aurora' ? GOLD : null;
      function seg(a, b, r) {
        var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        g.add(P(cy(r * 0.75, r, len, bone, 6, bo), (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0.03, 0, 0, Math.atan2(dy, dx) - PI / 2));
      }
      seg([0, 0], [1.2, 1.2], 0.11); seg([1.2, 1.2], [2.45, 1.65], 0.07); seg([1.2, 1.2], [2.65, 0.42], 0.06); seg([1.2, 1.2], [1.95, -0.62], 0.06);
      g.add(P(co(0.1, 0.35, pal.spike, 5, kind === 'frost' ? crystal('#bfe9ff') : bo), 1.25, 1.42, 0.03, 0, 0, -0.5));
      if (kind === 'frost') g.add(P(co(0.08, 0.4, '#bfe9ff', 5, crystal('#8fd8ff')), 2.55, 1.8, 0, 0, 0, -1.1));
      return g;
    };
  }
  var BACKS = {
    cape: function (b) {
      var t = capeTexture(b.color || '#d8322a', b.trim || '#ffd24a', b.ermine ? 'crown' : 'dragon');
      var m1 = new T.MeshLambertMaterial({ map: t, side: T.DoubleSide });
      var top = P(new T.Group(), 0, 0.72, -0.08);
      var geo1 = new T.BoxGeometry(2.0, 1.45, 0.06); geo1.translate(0, -0.72, 0);
      var uv = geo1.attributes.uv; for (var i = 0; i < uv.count; i++) uv.setY(i, 0.55 + uv.getY(i) * 0.45);
      top.add(mesh(geo1, m1));
      var low = P(new T.Group(), 0, -1.45, 0);
      var geo2 = new T.BoxGeometry(2.25, 1.75, 0.06); geo2.translate(0, -0.87, 0);
      var uv2 = geo2.attributes.uv; for (var k = 0; k < uv2.count; k++) uv2.setY(k, uv2.getY(k) * 0.55);
      low.add(mesh(geo2, m1));
      top.add(low);
      var out = [top];
      if (b.ermine) {
        var er = new T.Group();
        er.add(P(bx(2.2, 0.36, 0.3, '#ffffff'), 0, 0.72, -0.12));
        for (var e = 0; e < 6; e++) er.add(P(bx(0.07, 0.15, 0.07, '#1b1b1f'), -0.9 + e * 0.36, 0.76, -0.28));
        out.push(er);
      } else {
        out.push(P(cy(0.16, 0.16, 0.08, b.trim || '#ffd24a', 10, GOLD), -0.85, 0.7, 0.02, PI / 2, 0, 0), P(cy(0.16, 0.16, 0.08, b.trim || '#ffd24a', 10, GOLD), 0.85, 0.7, 0.02, PI / 2, 0, 0));
      }
      live(top, function (n, dt, m) {
        var tgt = m.moving ? 0.5 + 0.22 * Math.min(1.6, m.speedFactor || 1) + Math.sin(m.time * 11) * 0.05 : 0.06 + Math.sin(m.time * 1.4) * 0.025;
        if (m.grounded === false) tgt = 0.9;
        n.rotation.x += (tgt - n.rotation.x) * Math.min(1, dt * 6);
        low.rotation.x += ((m.moving ? 0.28 + Math.sin(m.time * 11 - 1.2) * 0.12 : 0.03) - low.rotation.x) * Math.min(1, dt * 6);
      });
      return out.map(function (o) { return { a: 'back', o: o }; });
    },
    quiver: function () {
      var g = P(new T.Group(), 0.25, -0.15, -0.38, 0, 0, 0.45);
      g.add(cy(0.33, 0.28, 1.6, '#7a4f2c', 10), P(tor(0.33, 0.05, '#c89b5c', 4, 12), 0, 0.8, 0, PI / 2, 0, 0), P(bx(0.5, 0.22, 0.06, '#c89b5c'), 0, 0.2, -0.32));
      for (var i = 0; i < 5; i++) {
        var x = (i % 3 - 1) * 0.14, z = (i < 3 ? 0.08 : -0.1);
        g.add(P(cy(0.025, 0.025, 0.9, '#d8b27a', 4), x, 1.15, z), P(co(0.09, 0.3, i % 2 ? '#e0303a' : '#f4f0e6', 3), x, 1.62, z, 0, i, 0, [1, 1, 0.3]));
      }
      return [{ a: 'back', o: g }, { a: 'chest', o: P(bx(0.22, 3.0, 0.06, '#5a3a22'), 0, -0.35, 0.02, 0, 0, -0.72) }];
    },
    egg_basket: function () {
      var c = cvs(64, 64), x = c.getContext('2d');
      x.fillStyle = '#b07a3a'; x.fillRect(0, 0, 64, 64);
      for (var j = 0; j < 8; j++) for (var i = 0; i < 8; i++) { x.fillStyle = (i + j) % 2 ? '#8a5a2b' : '#c8924a'; x.fillRect(i * 8, j * 8 + ((i % 2) ? 0 : 4), 8, 4); }
      var t = tex(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(2, 1.5);
      var m = new T.MeshLambertMaterial({ map: t });
      var g = P(new T.Group(), 0, -0.25, -0.58);
      g.add(mesh(new T.BoxGeometry(1.55, 1.1, 0.95), m), P(bx(1.65, 0.14, 1.05, '#6b4423'), 0, 0.55, 0));
      [['#8fd35a', -0.4, 0.05], ['#8fd8ff', 0.05, -0.1], ['#3a2a28', 0.45, 0.1]].forEach(function (e, k) {
        g.add(P(sp(0.3, e[0], k === 2 ? { emissive: '#ff5a1a', ei: 0.18 } : null, 12, 9), e[1], 0.62, e[2], 0, 0, (k - 1) * 0.2, [1, 1.3, 1]));
      });
      return [{ a: 'back', o: g }, { a: 'chest', o: grp(P(bx(0.18, 1.5, 0.06, '#6b4423'), -0.55, 0.15, 0.02), P(bx(0.18, 1.5, 0.06, '#6b4423'), 0.55, 0.15, 0.02)) }];
    },
    shield: function () {
      var c = cvs(128, 128), x = c.getContext('2d');
      x.fillStyle = '#8a5a2b'; x.fillRect(0, 0, 128, 128);
      for (var i = 0; i < 6; i++) { x.fillStyle = i % 2 ? '#7a4f2c' : '#9a6a34'; x.fillRect(i * 22, 0, 21, 128); }
      x.fillStyle = '#c8302f'; x.beginPath(); x.arc(64, 64, 40, 0, TAU); x.fill();
      Painter.prototype.emblem.call(null, 'dragon', '#ffd24a', 64, 64, 26, 'rgba(0,0,0,0.4)', x, [0, 0, 128, 128]);
      var t = tex(c);
      var face = new T.MeshLambertMaterial({ map: t });
      var disc = new T.Mesh(new T.CylinderGeometry(1.0, 1.0, 0.16, 22), [mat('#7a4f2c'), face, mat('#7a4f2c')]);
      disc.castShadow = true;
      var g = P(new T.Group(), 0, -0.3, -0.2, 0, 0, 0.15);
      g.add(P(disc, 0, 0, -0.08, -PI / 2, 0, 0), P(tor(1.0, 0.07, '#a8b0ba', 5, 24, TAU, STEEL), 0, 0, -0.08), P(hemi(0.2, '#c8d0d8', STEEL), 0, 0, -0.17, -PI / 2, 0, 0));
      return [{ a: 'back', o: g }];
    },
    bat_wings: function () {
      var w = wingPair(function () {
        var g = new T.Group();
        var pts = [[0, 0], [1.0, 0.7], [1.9, 0.95], [2.2, -0.3], [1.75, -0.45], [1.5, -0.15], [1.15, -0.8], [0.85, -0.4], [0.4, -0.85], [0, -0.4]];
        g.add(shp(pts, 0.03, '#3a2a4a', { side: 2 }));
        [[1.9, 0.95], [2.2, -0.3], [1.15, -0.8], [0.4, -0.85]].forEach(function (p) {
          var len = Math.hypot(p[0] - 1.0, p[1] - 0.7);
          g.add(P(cy(0.03, 0.05, len, '#22182c', 5), (p[0] + 1.0) / 2, (p[1] + 0.7) / 2, 0.03, 0, 0, Math.atan2(p[1] - 0.7, p[0] - 1.0) - PI / 2));
        });
        g.add(P(cy(0.06, 0.08, 1.25, '#22182c', 5), 0.5, 0.35, 0.03, 0, 0, Math.atan2(0.7, 1.0) - PI / 2), P(co(0.06, 0.2, '#e8e0d8', 4), 1.02, 0.86, 0.03));
        return g;
      }, { base: 0.5, amp: 0.25, freq: 2.8 });
      return [{ a: 'back', o: w }];
    },
    banner: function () {
      var c = cvs(96, 72), x = c.getContext('2d');
      x.fillStyle = '#c8302f'; x.fillRect(0, 0, 96, 72); x.fillStyle = '#ffd24a'; x.fillRect(0, 0, 96, 8); x.fillRect(0, 64, 96, 8);
      Painter.prototype.emblem.call(null, 'egg', '#ffd24a', 48, 38, 20, 'rgba(0,0,0,0.35)', x, [0, 0, 96, 72]);
      var t = tex(c), m = new T.MeshLambertMaterial({ map: t, side: T.DoubleSide });
      var g = P(new T.Group(), -0.6, 0, -0.25);
      g.add(P(cy(0.07, 0.07, 3.6, '#6b4423', 6), 0, 1.1, 0), P(co(0.14, 0.35, '#ffd24a', 6, GOLD), 0, 3.05, 0));
      var flag = P(new T.Group(), 0, 2.75, 0);
      var a = P(new T.Group(), 0, 0, 0), b2 = P(new T.Group(), 0.6, 0, 0);
      var ga = new T.PlaneGeometry(0.6, 0.85); ga.translate(0.3, -0.42, 0);
      var gb = new T.PlaneGeometry(0.6, 0.85); gb.translate(0.3, -0.42, 0);
      var uva = ga.attributes.uv, uvb = gb.attributes.uv;
      for (var i = 0; i < uva.count; i++) { uva.setX(i, uva.getX(i) * 0.5); uvb.setX(i, 0.5 + uvb.getX(i) * 0.5); }
      a.add(mesh(ga, m)); b2.add(mesh(gb, m)); a.add(b2); flag.add(a);
      g.add(live(flag, function (n, dt, mm) { var sp2 = mm.moving ? 9 : 2.5, am = mm.moving ? 0.5 : 0.18; a.rotation.y = 0.3 + Math.sin(mm.time * sp2) * am + (mm.moving ? 0.8 : 0); b2.rotation.y = Math.sin(mm.time * sp2 - 1.3) * am * 1.2; }));
      return [{ a: 'back', o: g }];
    },
    dragon_wings: function (b) {
      return [{ a: 'back', o: wingPair(dragonWing(b.kind || 'meadow'), { base: 0.45, amp: 0.2, freq: 2.0, tilt: 0.12 }) }];
    },
    fairy_wings: function () {
      var w = wingPair(function () {
        var g = new T.Group(), m1 = mat('#ff7ac8', { side: 2, opacity: 0.78, emissive: '#ff4aa0', ei: 0.35 }), m2 = mat('#5fd8ff', { side: 2, opacity: 0.78, emissive: '#2fb0ff', ei: 0.35 });
        g.add(P(mesh(new T.SphereGeometry(0.85, 12, 8), m2), 0.75, 0.55, 0, 0, 0, 0.5, [1, 0.5, 0.04]));
        g.add(P(mesh(new T.SphereGeometry(0.6, 12, 8), m1), 0.55, -0.45, 0, 0, 0, -0.6, [1, 0.5, 0.04]));
        g.children.forEach(function (c) { c.castShadow = false; });
        return g;
      }, { base: 0.4, amp: 0.4, freq: 9, tilt: 0.1 });
      return [{ a: 'back', o: w }];
    },
    treasure_sack: function () {
      var g = P(new T.Group(), 0.1, -0.45, -0.62);
      g.add(P(sp(0.78, '#a8804a', { flat: true }, 9, 7), 0, 0, 0, 0, 0, 0, [1, 1.1, 0.8]), P(tor(0.25, 0.08, '#6b4423', 4, 10), 0, 0.82, 0, PI / 2, 0, 0), P(cy(0.22, 0.32, 0.3, '#a8804a', 8), 0, 0.95, 0));
      for (var i = 0; i < 5; i++) g.add(P(cy(0.16, 0.16, 0.05, '#ffd24a', 12, GOLD), -0.2 + i * 0.1, 1.12 + (i % 2) * 0.08, (i % 3 - 1) * 0.08, 0.3 * i, 0, 0.6 - i * 0.3));
      g.add(P(oct(0.14, '#2fbf5a', { std: true, rough: 0.15, emissive: '#2fbf5a', ei: 0.4 }), 0.15, 1.22, 0.05), P(bx(0.4, 0.4, 0.05, '#8a6a3a'), -0.3, -0.1, -0.62, 0, 0.3, 0.2));
      return [{ a: 'back', o: g }];
    },
    guitar: function () {
      var g = P(new T.Group(), 0.05, -0.3, -0.25, 0, 0, -0.5);
      g.add(P(cy(0.58, 0.58, 0.24, '#d9822b', 18), 0, -0.45, 0, PI / 2, 0, 0), P(cy(0.44, 0.44, 0.24, '#d9822b', 18), 0, 0.15, 0, PI / 2, 0, 0));
      g.add(P(cy(0.17, 0.17, 0.26, '#2a1a10', 12), 0, -0.2, 0, PI / 2, 0, 0), P(tor(0.58, 0.04, '#8a4a1a', 4, 18), 0, -0.45, -0.12));
      g.add(P(bx(0.2, 1.5, 0.1, '#6b4423'), 0, 1.25, -0.04), P(bx(0.32, 0.4, 0.12, '#3a2416'), 0, 2.15, -0.04), P(bx(0.26, 0.08, 0.06, '#1b1b1f'), 0, -0.75, -0.13));
      for (var i = 0; i < 3; i++) g.add(P(cy(0.04, 0.04, 0.1, '#e8e0d8', 6), (i - 1) * 0.12, 2.15, -0.12, PI / 2, 0, 0));
      return [{ a: 'back', o: g }, { a: 'chest', o: P(bx(0.2, 3.0, 0.06, '#3a2416'), 0, -0.35, 0.02, 0, 0, 0.72) }];
    },
    dragon_tail: function () {
      var c = '#c8302f', root = new T.Group(), parent = root, segs = [];
      for (var i = 0; i < 5; i++) {
        var pv = P(new T.Group(), 0, 0, i ? -0.8 : 0);
        pv.rotation.x = i ? -0.12 : 0.85;
        pv.add(P(bx(0.75 - i * 0.12, 0.62 - i * 0.1, 0.9, i % 2 ? c : shade(c, -0.06)), 0, 0, -0.42), P(bx(0.5 - i * 0.08, 0.1, 0.8, '#ffd24a'), 0, -0.3 + i * 0.05, -0.42));
        pv.add(P(co(0.13, 0.42, '#3a1414', 4), 0, 0.36 - i * 0.05, -0.42, -0.3, 0, 0));
        parent.add(pv); parent = pv; segs.push(pv);
      }
      parent.add(P(shp([[0, 0.1], [0.45, -0.3], [0, -0.85], [-0.45, -0.3]], 0.08, '#3a1414'), 0, 0, -1.0, PI / 2, 0, 0));
      live(root, function (n, dt, m) {
        var amp = m.moving ? 0.3 : 0.12, sp2 = m.moving ? 8 : 1.8;
        for (var k = 0; k < segs.length; k++) { segs[k].rotation.y = Math.sin(m.time * sp2 - k * 0.6) * amp; }
      });
      return [{ a: 'tail', o: root }];
    },
    plush_dragon: function () {
      var c = '#a77bf0', g = P(new T.Group(), 0, -0.3, -0.5);
      g.add(P(sp(0.68, c, null, 12, 9), 0, 0, 0, 0, 0, 0, [1, 1.15, 0.75]), P(sp(0.45, '#f4e2ff', null, 10, 8), 0, -0.1, 0.12, 0, 0, 0, [1, 1.2, 0.7]));
      var head = P(new T.Group(), 0.42, 0.82, 0.1);
      head.add(P(bx(0.78, 0.66, 0.62, c), 0, 0, 0), P(bx(0.5, 0.3, 0.3, shade(c, 0.08)), 0, -0.1, 0.4));
      [-1, 1].forEach(function (sd) { head.add(P(sp(0.12, '#ffffff', null, 8, 6), sd * 0.2, 0.1, 0.32), P(sp(0.07, '#1b1b1f', null, 6, 4), sd * 0.2, 0.1, 0.4), P(co(0.08, 0.3, '#ffd84a', 5), sd * 0.24, 0.42, -0.1)); });
      g.add(live(head, function (n, dt, m) { n.rotation.z = Math.sin(m.time * 2) * 0.12; }));
      [-1, 1].forEach(function (sd) { g.add(P(bx(0.24, 0.24, 0.9, c), sd * 0.95, 0.15, 0.55, 0, 0, 0)); });
      g.add(P(shp([[0, 0], [0.5, 0.35], [0.45, -0.1]], 0.04, '#ffd84a', { side: 2 }), 0.4, 0.3, -0.45, 0, 0.5, 0), P(shp([[0, 0], [-0.5, 0.35], [-0.45, -0.1]], 0.04, '#ffd84a', { side: 2 }), -0.4, 0.3, -0.45, 0, -0.5, 0));
      return [{ a: 'back', o: g }];
    },
    lantern: function () {
      var g = P(new T.Group(), 0.55, 0, -0.25);
      g.add(P(cy(0.07, 0.07, 3.0, '#4a3a2a', 6), 0, 0.85, 0), P(cy(0.05, 0.05, 1.0, '#4a3a2a', 6), 0.48, 2.3, 0, 0, 0, PI / 2 + 0.35));
      var hang = P(new T.Group(), 0.95, 2.45, 0);
      hang.add(P(cy(0.015, 0.015, 0.4, '#222222', 4), 0, -0.2, 0));
      var lamp = P(new T.Group(), 0, -0.6, 0);
      lamp.add(P(bx(0.5, 0.06, 0.5, '#2a2a2a'), 0, 0.3, 0), P(bx(0.5, 0.06, 0.5, '#2a2a2a'), 0, -0.3, 0), P(co(0.32, 0.22, '#2a2a2a', 4), 0, 0.42, 0, 0, PI / 4, 0));
      var core = P(bx(0.38, 0.52, 0.38, '#ffd27a', { emissive: '#ffb02e', ei: 1.4, opacity: 0.92 }), 0, 0, 0); core.castShadow = false;
      lamp.add(core);
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (q) { lamp.add(P(bx(0.05, 0.6, 0.05, '#2a2a2a'), q[0] * 0.23, 0, q[1] * 0.23)); });
      hang.add(lamp);
      g.add(live(hang, function (n, dt, m) { n.rotation.z = Math.sin(m.time * (m.moving ? 7 : 1.8)) * (m.moving ? 0.35 : 0.08); n.rotation.x = m.moving ? 0.25 : 0; }));
      return [{ a: 'back', o: g }];
    },
    sword: function () {
      var g = P(new T.Group(), 0, -0.2, -0.18, 0, 0, 0.62);
      g.add(P(shp([[-0.2, 0], [0.2, 0], [0.24, 1.4], [0.12, 1.55], [0.22, 1.9], [0, 2.5], [-0.22, 1.9], [-0.12, 1.55], [-0.24, 1.4]], 0.1, '#efe9da'), 0, -0.2, 0));
      g.add(P(bx(0.9, 0.16, 0.16, '#d9a93a', GOLD), 0, -0.22, 0), P(cy(0.08, 0.08, 0.7, '#3a2416', 8), 0, -0.62, 0), P(oct(0.13, '#e0303a', { std: true, rough: 0.15, emissive: '#e0303a', ei: 0.4 }), 0, -1.02, 0));
      g.add(P(co(0.07, 0.25, '#d9a93a', 4, GOLD), 0.47, -0.22, 0, 0, 0, -PI / 2), P(co(0.07, 0.25, '#d9a93a', 4, GOLD), -0.47, -0.22, 0, 0, 0, PI / 2));
      return [{ a: 'back', o: g }];
    },
    leaf_wings: function () {
      return [{ a: 'back', o: wingPair(function () {
        var g = new T.Group();
        g.add(P(cy(0.05, 0.07, 1.9, '#6b4423', 5), 0.85, 0.35, 0.03, 0, 0, -1.2));
        [['#4f9a2a', 1.1, 0.8, 0.5], ['#7cc84a', 1.55, 0.2, -0.1], ['#3d7f22', 1.1, -0.4, -0.6], ['#5fae3b', 0.55, -0.55, -1.1]].forEach(function (l) {
          g.add(P(sp(0.62, l[0], { flat: true, side: 2 }, 7, 5), l[1], l[2], 0, 0, 0, l[3], [1.25, 0.5, 0.06]));
        });
        return g;
      }, { base: 0.45, amp: 0.18, freq: 2.2 }) }];
    },
    angel_wings: function () {
      return [{ a: 'back', o: wingPair(function () {
        var g = new T.Group();
        for (var r = 0; r < 3; r++) for (var i = 0; i < 6 - r; i++) {
          var len = 1.5 - r * 0.35 - i * 0.08, a = 1.1 - i * 0.28;
          g.add(P(bx(len, 0.24, 0.06, r === 0 ? '#ffffff' : r === 1 ? '#f4f6ff' : '#e8ecff'), 0.2 + i * 0.32 + Math.cos(a) * len / 2, 0.6 - r * 0.22 + Math.sin(a) * len / 2 - i * 0.12, -r * 0.03, 0, 0, a));
        }
        g.add(P(bx(1.6, 0.3, 0.1, '#ffffff'), 0.85, 0.85, 0.02, 0, 0, 0.35));
        return g;
      }, { base: 0.5, amp: 0.15, freq: 1.6 }) }];
    },
    jetpack: function () {
      var g = P(new T.Group(), 0, -0.3, -0.45), flames = [];
      g.add(P(bx(0.55, 1.1, 0.4, '#3a3f47'), 0, 0, 0.1), P(bx(0.57, 0.12, 0.42, '#e0303a'), 0, 0.2, 0.1));
      [-1, 1].forEach(function (sd) {
        g.add(P(cy(0.34, 0.34, 1.4, '#c8ced8', 12, STEEL), sd * 0.42, 0, 0), P(hemi(0.34, '#e0303a', null, 12), sd * 0.42, 0.7, 0), P(co(0.24, 0.35, '#2a2d33', 10), sd * 0.42, -0.86, 0, PI, 0, 0));
        var f = P(new T.Group(), sd * 0.42, -1.05, 0);
        var o1 = P(co(0.2, 0.8, '#ff8a2e', 8, { basic: true, opacity: 0.92 }), 0, -0.4, 0, PI, 0, 0), o2 = P(co(0.11, 0.5, '#fff3b0', 8, { basic: true }), 0, -0.25, 0, PI, 0, 0);
        o1.castShadow = o2.castShadow = false;
        f.add(o1, o2); g.add(f); flames.push(f);
      });
      live(g, function (n, dt, m) {
        var k = m.grounded === false ? 1.5 : m.moving ? 1.0 : 0.45;
        for (var i = 0; i < flames.length; i++) { var s = k * (0.8 + Math.sin(m.time * 23 + i * 2) * 0.2); flames[i].scale.set(1, s, 1); }
      });
      return [{ a: 'back', o: g }, { a: 'chest', o: grp(P(bx(0.18, 1.4, 0.06, '#2a2d33'), -0.55, 0.2, 0.02), P(bx(0.18, 1.4, 0.06, '#2a2d33'), 0.55, 0.2, 0.02), P(bx(1.3, 0.16, 0.06, '#2a2d33'), 0, -0.2, 0.03)) }];
    },
    clockwork_wings: function () {
      return [{ a: 'back', o: wingPair(function () {
        var g = new T.Group();
        g.add(P(cy(0.06, 0.08, 2.1, '#b8862f', 6, GOLD), 1.0, 0.55, 0.04, 0, 0, -1.0));
        for (var i = 0; i < 5; i++) {
          var a = 0.7 - i * 0.38, len = 1.8 - i * 0.18;
          g.add(P(shp([[0, -0.13], [len, -0.06], [len + 0.18, 0.06], [0, 0.13]], 0.04, i % 2 ? '#c8ced8' : '#d9a93a', i % 2 ? STEEL : GOLD), 0.25 + i * 0.25, 0.75 - i * 0.12, -0.01 * i, 0, 0, a));
        }
        var gear = new T.Group();
        gear.add(cy(0.3, 0.3, 0.1, '#d9a93a', 12, GOLD));
        for (var k = 0; k < 8; k++) { var b = k * TAU / 8; gear.add(P(bx(0.12, 0.1, 0.12, '#d9a93a', GOLD), Math.cos(b) * 0.33, 0, Math.sin(b) * 0.33, 0, -b, 0)); }
        var gp = P(new T.Group(), 0.25, 0.2, 0.08, PI / 2, 0, 0);
        gp.add(gear);
        g.add(live(gp, function (n, dt) { n.rotation.y += dt * 2.5; }));
        return g;
      }, { base: 0.45, amp: 0.14, freq: 1.8 }) }];
    },
    flame_wings: function () {
      return [{ a: 'back', o: wingPair(function () {
        var g = new T.Group();
        var outer = shp([[0, 0], [0.9, 1.0], [1.4, 2.0], [1.6, 1.0], [2.3, 1.5], [2.1, 0.5], [2.7, 0.3], [1.9, -0.2], [2.1, -0.8], [1.2, -0.45], [0.9, -1.0], [0.3, -0.5]], 0.04, '#ff6a1f', { basic: true, opacity: 0.9, side: 2 });
        var inner = shp([[0.2, 0], [0.9, 0.6], [1.3, 1.2], [1.5, 0.6], [1.9, 0.6], [1.6, 0], [1.7, -0.4], [1.0, -0.2], [0.6, -0.5]], 0.04, '#ffe14a', { basic: true, opacity: 0.95, side: 2 });
        inner.position.z = 0.04; outer.castShadow = inner.castShadow = false;
        g.add(outer, inner);
        live(g, function (n, dt, m) { var s = 1 + Math.sin(m.time * 12) * 0.04 + Math.sin(m.time * 7.7) * 0.03; inner.scale.set(s, 2 - s, 1); outer.scale.y = 1 + Math.sin(m.time * 9 + 1) * 0.05; });
        return g;
      }, { base: 0.42, amp: 0.2, freq: 2.2 }) }];
    },
    crystal_wings: function () {
      return [{ a: 'back', o: wingPair(function () {
        var g = new T.Group();
        for (var i = 0; i < 5; i++) {
          var a = 1.05 - i * 0.42, len = 1.7 - Math.abs(i - 1.5) * 0.25;
          var o = oct(0.5, i % 2 ? '#b07aff' : '#5fd8ff', crystal(i % 2 ? '#8a50ff' : '#2fb8ff', 0.92));
          o.scale.set(0.35, len, 0.12);
          g.add(P(o, 0.3 + Math.cos(a) * len * 0.62, 0.15 + Math.sin(a) * len * 0.62, 0, 0, 0, a - PI / 2));
        }
        return g;
      }, { base: 0.45, amp: 0.12, freq: 1.5 }) }];
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Particle engine (trails, victories, previews)                           */
  /* One THREE.Points per blend mode, canvas sprite atlas 8×4 cells of 64 px  */
  /* ---------------------------------------------------------------------- */
  var FR = { soft: 0, sparkle: 1, star: 2, heart: 3, leaf: 4, snow: 5, note: 6, coin: 7, gem: 8, petal: 9, bubble: 10, smoke: 11, flame: 12, confetti: 13, ring: 14, bolt: 15,
    rune: 16, butterfly: 17, pixel: 18, drop: 19, ember: 20, note2: 21, claw: 22, rune2: 23, butterfly2: 24, spark: 25, cloud: 26, feather: 27 };
  var ATLAS = null;
  function atlas() {
    if (ATLAS) return ATLAS;
    var c = cvs(512, 256), g = c.getContext('2d');
    function cell(i, fn) { g.save(); g.translate((i % 8) * 64 + 32, ((i / 8) | 0) * 64 + 32); fn(); g.restore(); }
    function softDisc(r, a) { var gr = g.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, 'rgba(255,255,255,' + a + ')'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill(); }
    function poly(pts) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); }
    g.lineCap = 'round'; g.lineJoin = 'round';
    cell(FR.soft, function () { softDisc(30, 1); });
    var RIM = 'rgba(40,24,70,0.55)';
    cell(FR.sparkle, function () { softDisc(16, 0.9); poly([[0, -28], [4, -4], [28, 0], [4, 4], [0, 28], [-4, 4], [-28, 0], [-4, -4]]); g.strokeStyle = RIM; g.lineWidth = 3; g.stroke(); g.fillStyle = '#fff'; g.fill(); });
    cell(FR.star, function () { softDisc(26, 0.35); var p = []; for (var i = 0; i < 10; i++) { var a = -PI / 2 + i * PI / 5, r = i % 2 ? 10 : 22; p.push([Math.cos(a) * r, Math.sin(a) * r + 2]); } poly(p); g.strokeStyle = RIM; g.lineWidth = 4; g.stroke(); g.fillStyle = '#fff'; g.fill(); });
    cell(FR.heart, function () { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, 20); g.bezierCurveTo(-30, 0, -14, -26, 0, -10); g.bezierCurveTo(14, -26, 30, 0, 0, 20); g.fill(); g.fillStyle = 'rgba(255,255,255,0.6)'; g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.ellipse(-9, -8, 4, 6, -0.5, 0, TAU); g.fill(); g.globalCompositeOperation = 'source-over'; });
    cell(FR.leaf, function () { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -24); g.quadraticCurveTo(22, -4, 0, 24); g.quadraticCurveTo(-22, -4, 0, -24); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(0, -18); g.lineTo(0, 22); g.stroke(); });
    cell(FR.snow, function () { g.strokeStyle = RIM; g.lineWidth = 7; for (var j = 0; j < 6; j++) { var b0 = j * PI / 3; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(b0) * 24, Math.sin(b0) * 24); g.stroke(); } g.strokeStyle = '#fff'; g.lineWidth = 4; for (var k = 0; k < 6; k++) { var b = k * PI / 3, cx = Math.cos(b), sy = Math.sin(b); g.beginPath(); g.moveTo(0, 0); g.lineTo(cx * 24, sy * 24); g.moveTo(cx * 13, sy * 13); g.lineTo(Math.cos(b + 0.6) * 20, Math.sin(b + 0.6) * 20); g.moveTo(cx * 13, sy * 13); g.lineTo(Math.cos(b - 0.6) * 20, Math.sin(b - 0.6) * 20); g.stroke(); } });
    cell(FR.note, function () { g.fillStyle = '#fff'; g.beginPath(); g.ellipse(-6, 14, 10, 7, -0.4, 0, TAU); g.fill(); g.fillRect(2, -22, 5, 36); poly([[2, -24], [18, -14], [18, -6], [7, -12]]); g.fill(); });
    cell(FR.coin, function () { g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, 22, 0, TAU); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 15, 0, TAU); g.stroke(); g.fillStyle = 'rgba(0,0,0,0.22)'; g.font = '900 20px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', 0, 1); g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.ellipse(-8, -9, 5, 3, -0.6, 0, TAU); g.fill(); });
    cell(FR.gem, function () { g.fillStyle = '#fff'; poly([[0, -24], [18, -6], [0, 24], [-18, -6]]); g.fill(); g.fillStyle = 'rgba(0,0,0,0.25)'; poly([[0, -6], [18, -6], [0, 24]]); g.fill(); g.fillStyle = 'rgba(0,0,0,0.12)'; poly([[-18, -6], [0, -6], [0, 24]]); g.fill(); });
    cell(FR.petal, function () { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, 20); g.bezierCurveTo(-20, 4, -12, -20, 0, -20); g.bezierCurveTo(12, -20, 20, 4, 0, 20); g.fill(); });
    cell(FR.bubble, function () { g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.arc(0, 0, 24, 0, TAU); g.fill(); g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 3; g.stroke(); g.fillStyle = '#fff'; g.beginPath(); g.ellipse(-9, -10, 6, 4, -0.7, 0, TAU); g.fill(); });
    cell(FR.smoke, function () { [[-8, 4, 16], [8, 2, 15], [0, -8, 16], [0, 8, 14]].forEach(function (b) { g.save(); g.translate(b[0], b[1]); softDisc(b[2] + 4, 0.75); g.restore(); }); });
    cell(FR.flame, function () { var gr = g.createRadialGradient(0, 8, 0, 0, 4, 24); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -28); g.quadraticCurveTo(20, 0, 14, 16); g.quadraticCurveTo(0, 30, -14, 16); g.quadraticCurveTo(-20, 0, 0, -28); g.fill(); });
    cell(FR.confetti, function () { g.fillStyle = '#fff'; g.fillRect(-14, -8, 28, 16); g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(-14, 3, 28, 5); });
    cell(FR.ring, function () { g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 5; g.beginPath(); g.arc(0, 0, 24, 0, TAU); g.stroke(); g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 10; g.stroke(); });
    cell(FR.bolt, function () { poly([[6, -28], [-12, 2], [0, 2], [-6, 28], [14, -6], [2, -6]]); g.strokeStyle = RIM; g.lineWidth = 4; g.stroke(); g.shadowColor = '#fff'; g.shadowBlur = 8; g.fillStyle = '#fff'; g.fill(); g.shadowBlur = 0; });
    cell(FR.rune, function () { g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.moveTo(-10, 22); g.lineTo(-10, -22); g.lineTo(10, -8); g.lineTo(-10, 4); g.moveTo(-10, 4); g.lineTo(12, 22); g.stroke(); g.beginPath(); g.arc(0, 0, 27, 0, TAU); g.lineWidth = 2; g.stroke(); });
    function bfly(open) { g.fillStyle = '#fff'; var w = open ? 1 : 0.35; g.beginPath(); g.ellipse(-12 * w, -8, 12 * w, 13, -0.4, 0, TAU); g.ellipse(12 * w, -8, 12 * w, 13, 0.4, 0, TAU); g.fill(); g.beginPath(); g.ellipse(-9 * w, 10, 8 * w, 9, 0.4, 0, TAU); g.ellipse(9 * w, 10, 8 * w, 9, -0.4, 0, TAU); g.fill(); g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(-2, -16, 4, 32); }
    cell(FR.butterfly, function () { bfly(true); });
    cell(FR.butterfly2, function () { bfly(false); });
    cell(FR.pixel, function () { g.fillStyle = '#fff'; g.fillRect(-16, -16, 32, 32); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(-16, 10, 32, 6); g.fillRect(10, -16, 6, 32); });
    cell(FR.drop, function () { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -24); g.quadraticCurveTo(18, 4, 0, 22); g.quadraticCurveTo(-18, 4, 0, -24); g.fill(); g.fillStyle = 'rgba(0,0,0,0.15)'; g.beginPath(); g.ellipse(5, 8, 6, 9, 0, 0, TAU); g.fill(); });
    cell(FR.ember, function () { softDisc(22, 0.7); g.beginPath(); g.arc(0, 0, 8, 0, TAU); g.strokeStyle = RIM; g.lineWidth = 3; g.stroke(); g.fillStyle = '#fff'; g.fill(); });
    cell(FR.note2, function () { g.fillStyle = '#fff'; g.beginPath(); g.ellipse(-12, 16, 8, 6, -0.4, 0, TAU); g.ellipse(10, 12, 8, 6, -0.4, 0, TAU); g.fill(); g.fillRect(-6, -18, 4, 34); g.fillRect(16, -22, 4, 34); poly([[-6, -18], [20, -22], [20, -14], [-6, -10]]); g.fill(); });
    cell(FR.claw, function () { g.fillStyle = '#fff'; g.beginPath(); g.ellipse(0, 10, 13, 11, 0, 0, TAU); g.fill(); [[-14, -10, -0.4], [0, -16, 0], [14, -10, 0.4]].forEach(function (t) { g.save(); g.translate(t[0], t[1]); g.rotate(t[2]); g.beginPath(); g.ellipse(0, 0, 5, 9, 0, 0, TAU); g.fill(); g.beginPath(); g.moveTo(-3, -7); g.lineTo(0, -18); g.lineTo(3, -7); g.fill(); g.restore(); }); });
    cell(FR.rune2, function () { g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.moveTo(0, -22); g.lineTo(18, 14); g.lineTo(-18, 14); g.closePath(); g.moveTo(0, -22); g.lineTo(0, 22); g.moveTo(-10, 0); g.lineTo(10, 0); g.stroke(); });
    cell(FR.spark, function () { var gr = g.createLinearGradient(-28, 0, 28, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0.4)'); g.fillStyle = gr; g.beginPath(); g.ellipse(0, 0, 28, 4, 0, 0, TAU); g.fill(); });
    cell(FR.cloud, function () { [[-12, 6, 14], [10, 6, 14], [0, -6, 17]].forEach(function (b) { g.fillStyle = '#fff'; g.beginPath(); g.arc(b[0], b[1], b[2], 0, TAU); g.fill(); }); });
    cell(FR.feather, function () { g.fillStyle = '#fff'; g.beginPath(); g.moveTo(0, -26); g.quadraticCurveTo(14, -4, 2, 24); g.lineTo(-2, 24); g.quadraticCurveTo(-14, -4, 0, -26); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -22); g.lineTo(0, 26); g.stroke(); });
    var t = new T.CanvasTexture(c);
    t.userData.shared = true;
    ATLAS = { tex: t, canvas: c };
    return ATLAS;
  }

  var PVS = [
    'attribute float psize; attribute float pang; attribute float pframe; attribute vec4 pcol;',
    'uniform float uPx; varying vec4 vCol; varying float vAng; varying float vFrame;',
    'void main(){ vCol = pcol; vAng = pang; vFrame = pframe;',
    ' vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    ' gl_PointSize = psize * projectionMatrix[1][1] * uPx / max(0.05, -mv.z);',
    ' gl_Position = projectionMatrix * mv; }'
  ].join('\n');
  var PFS = [
    'uniform sampler2D map; varying vec4 vCol; varying float vAng; varying float vFrame;',
    'void main(){ vec2 p = gl_PointCoord - 0.5; float c = cos(vAng), s = sin(vAng);',
    ' p = vec2(c * p.x - s * p.y, s * p.x + c * p.y) * 1.06 + 0.5;',
    ' if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) discard;',
    ' float col = mod(vFrame, 8.0), row = floor(vFrame / 8.0 + 0.001);',
    ' vec4 t = texture2D(map, vec2((col + p.x) / 8.0, 1.0 - (row + p.y) / 4.0));',
    ' gl_FragColor = vec4(vCol.rgb * t.rgb, vCol.a * t.a);',
    ' if (gl_FragColor.a < 0.004) discard;',
    ' #include <tonemapping_fragment>',
    ' #include <encodings_fragment>',
    '}'
  ].join('\n');
  var COLC = {};
  function col(hex) { return COLC[hex] || (COLC[hex] = new T.Color(hex)); }
  var _v2 = null;
  function Pool(n, additive) {
    this.n = n; this.count = 0; this.additive = additive;
    var geo = this.geo = new T.BufferGeometry();
    this.pos = new Float32Array(n * 3); this.pc = new Float32Array(n * 4); this.ps = new Float32Array(n); this.pa = new Float32Array(n); this.pf = new Float32Array(n);
    function at(arr, k) { var a = new T.BufferAttribute(arr, k); a.setUsage(T.DynamicDrawUsage); return a; }
    geo.setAttribute('position', at(this.pos, 3)); geo.setAttribute('pcol', at(this.pc, 4)); geo.setAttribute('psize', at(this.ps, 1)); geo.setAttribute('pang', at(this.pa, 1)); geo.setAttribute('pframe', at(this.pf, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
    var m = this.mat = new T.ShaderMaterial({
      uniforms: { map: { value: atlas().tex }, uPx: { value: 400 } },
      vertexShader: PVS, fragmentShader: PFS, transparent: true, depthWrite: false,
      blending: additive ? T.AdditiveBlending : T.NormalBlending
    });
    var pts = this.points = new T.Points(geo, m);
    pts.frustumCulled = false; pts.renderOrder = additive ? 12 : 11;
    pts.onBeforeRender = function (renderer) {
      _v2 = _v2 || new T.Vector2();
      renderer.getDrawingBufferSize(_v2);
      m.uniforms.uPx.value = _v2.y * 0.5;
    };
    var F32 = function (k) { return new Float32Array(n * (k || 1)); };
    this.vel = F32(3); this.life = F32(); this.max = F32(); this.s0 = F32(); this.s1 = F32(); this.c0 = F32(3); this.c1 = F32(3); this.a0 = F32();
    this.spin = F32(); this.grav = F32(); this.drag = F32(); this.wob = F32(); this.wobF = F32(); this.ph = F32(); this.floor = F32(); this.flags = F32(); this.fr = F32(); this.fr2 = F32();
    this.ox = F32(); this.oz = F32(); this.w = F32(); this.hold = F32();
  }
  var FL_TW = 1, FL_POP = 2, FL_ORB = 4, FL_FLAP = 8, FL_FADEIN = 16;
  Pool.prototype.spawn = function (o) {
    if (this.count >= this.n) return -1;
    var i = this.count++, i3 = i * 3;
    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx || 0; this.vel[i3 + 1] = o.vy || 0; this.vel[i3 + 2] = o.vz || 0;
    this.life[i] = 0; this.max[i] = o.life || 1;
    this.s0[i] = o.size || 0.5; this.s1[i] = o.size1 === undefined ? (o.size || 0.5) * 0.4 : o.size1;
    var c0 = col(o.color || '#ffffff'), c1 = col(o.color1 || o.color || '#ffffff');
    this.c0[i3] = c0.r; this.c0[i3 + 1] = c0.g; this.c0[i3 + 2] = c0.b; this.c1[i3] = c1.r; this.c1[i3 + 1] = c1.g; this.c1[i3 + 2] = c1.b;
    this.a0[i] = o.alpha === undefined ? 1 : o.alpha;
    this.pa[i] = o.ang === undefined ? R() * TAU : o.ang; this.spin[i] = o.spin || 0;
    this.grav[i] = o.grav || 0; this.drag[i] = o.drag || 0;
    this.wob[i] = o.wob || 0; this.wobF[i] = o.wobF || 3; this.ph[i] = R() * TAU;
    this.floor[i] = o.floor === undefined ? -1e9 : o.floor;
    this.fr[i] = o.frame || 0; this.fr2[i] = o.frame2 === undefined ? -1 : o.frame2;
    this.ox[i] = o.ox || 0; this.oz[i] = o.oz || 0; this.w[i] = o.w || 0;
    this.hold[i] = o.hold === undefined ? 0.6 : o.hold;
    this.flags[i] = (o.tw ? FL_TW : 0) | (o.pop ? FL_POP : 0) | (o.w ? FL_ORB : 0) | (o.frame2 !== undefined ? FL_FLAP : 0) | (o.fadeIn ? FL_FADEIN : 0);
    return i;
  };
  Pool.prototype.kill = function (i) {
    var j = --this.count;
    if (i === j) return;
    var self = this;
    ['pos', 'vel', 'c0', 'c1'].forEach(function (k) { var a = self[k]; a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; });
    ['life', 'max', 's0', 's1', 'a0', 'pa', 'spin', 'grav', 'drag', 'wob', 'wobF', 'ph', 'floor', 'flags', 'fr', 'fr2', 'ox', 'oz', 'w', 'hold'].forEach(function (k) { self[k][i] = self[k][j]; });
  };
  Pool.prototype.update = function (dt) {
    var i = 0;
    while (i < this.count) {
      var L = this.life[i] += dt, M = this.max[i];
      if (L >= M) { this.kill(i); continue; }
      var t = L / M, i3 = i * 3, f = this.flags[i];
      var vx = this.vel[i3], vy = this.vel[i3 + 1] - this.grav[i] * dt, vz = this.vel[i3 + 2];
      var dr = this.drag[i];
      if (dr) { var k = 1 / (1 + dr * dt); vx *= k; vy *= k; vz *= k; }
      var x = this.pos[i3] + vx * dt, y = this.pos[i3 + 1] + vy * dt, z = this.pos[i3 + 2] + vz * dt;
      var wb = this.wob[i];
      if (wb) { var ph = this.ph[i] + L * this.wobF[i]; x += Math.sin(ph) * wb * dt; z += Math.cos(ph * 1.3) * wb * dt; }
      if (f & FL_ORB) {
        var ang = this.w[i] * dt, dx = x - this.ox[i], dz = z - this.oz[i], cs = Math.cos(ang), sn = Math.sin(ang);
        x = this.ox[i] + dx * cs - dz * sn; z = this.oz[i] + dx * sn + dz * cs;
      }
      if (y < this.floor[i]) { y = this.floor[i]; if (vy < 0) vy = -vy * 0.32; vx *= 0.6; vz *= 0.6; this.spin[i] *= 0.5; }
      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
      this.pa[i] += this.spin[i] * dt;
      var s = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      if (f & FL_POP && t < 0.2) s *= easeBack(t / 0.2);
      this.ps[i] = s;
      var hold = this.hold[i], a = this.a0[i] * (t < hold ? 1 : 1 - (t - hold) / (1 - hold));
      if (f & FL_FADEIN) a *= Math.min(1, t / 0.15); else a *= Math.min(1, L / 0.04);
      if (f & FL_TW) a *= 0.55 + 0.45 * Math.sin(this.ph[i] + L * 18);
      var c4 = i * 4;
      this.pc[c4] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      this.pc[c4 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      this.pc[c4 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      this.pc[c4 + 3] = a;
      this.pf[i] = (f & FL_FLAP) && ((L * 10) | 0) % 2 ? this.fr2[i] : this.fr[i];
      i++;
    }
    var g = this.geo;
    g.setDrawRange(0, this.count);
    if (this.count || this._was) {
      g.attributes.position.needsUpdate = g.attributes.pcol.needsUpdate = g.attributes.psize.needsUpdate = g.attributes.pang.needsUpdate = g.attributes.pframe.needsUpdate = true;
    }
    this._was = this.count > 0;
  };
  Pool.prototype.dispose = function () { if (this.points.parent) this.points.parent.remove(this.points); this.geo.dispose(); this.mat.dispose(); };

  /* PSys: two pools + helpers. wind (vx, vz) is added to every new particle (previews run in place). */
  function PSys(container, caps) {
    caps = caps || {};
    this.add = new Pool(caps.add || 300, !caps.soft);
    this.norm = new Pool(caps.norm || 260, false);
    this.wx = 0; this.wz = 0; this.mul = 1; this.sizeMul = caps.sizeMul || 1;
    this.setContainer(container);
  }
  PSys.prototype.setContainer = function (c) {
    if (this.container === c) return;
    this.container = c;
    if (c) c.add(this.norm.points, this.add.points);
  };
  PSys.prototype.p = function (o) {
    if (this.wx || this.wz) { o.vx = (o.vx || 0) + this.wx; o.vz = (o.vz || 0) + this.wz; if (o.w) { o.w = 0; } }
    if (this.sizeMul !== 1) { o.size = (o.size || 0.5) * this.sizeMul; if (o.size1 !== undefined) o.size1 *= this.sizeMul; }
    return (o.add ? this.add : this.norm).spawn(o);
  };
  PSys.prototype.update = function (dt) { this.add.update(dt); this.norm.update(dt); };
  PSys.prototype.clear = function () { this.add.count = this.norm.count = 0; this.add.update(0); this.norm.update(0); };
  PSys.prototype.dispose = function () { this.add.dispose(); this.norm.dispose(); };
  PSys.prototype.live = function () { return this.add.count + this.norm.count; };

  /* Ribbon trail (rainbow): vertical band following a head point */
  function Ribbon(container, o) {
    this.n = o.n || 24; this.rows = o.colors.length; this.width = o.width || 1.6; this.life = o.life || 0.55;
    this.colors = o.colors.map(col); this.pts = [];
    var geo = this.geo = new T.BufferGeometry(), N = this.n * this.rows;
    this.posA = new Float32Array(N * 3); this.colA = new Float32Array(N * 4);
    geo.setAttribute('position', new T.BufferAttribute(this.posA, 3).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('color', new T.BufferAttribute(this.colA, 4).setUsage(T.DynamicDrawUsage));
    var idx = [];
    for (var i = 0; i < this.n - 1; i++) for (var r = 0; r < this.rows - 1; r++) {
      var a = i * this.rows + r, b = a + 1, c = a + this.rows, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    geo.setIndex(idx);
    geo.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
    this.mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, side: T.DoubleSide, depthWrite: false, toneMapped: true }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 10;
    this.setContainer(container);
  }
  Ribbon.prototype.setContainer = function (c) { if (this.container !== c) { this.container = c; if (c) c.add(this.mesh); } };
  Ribbon.prototype.update = function (dt, head, wx, wz) {
    var pts = this.pts, i;
    for (i = 0; i < pts.length; i++) { pts[i].age += dt; pts[i].x += (wx || 0) * dt; pts[i].z += (wz || 0) * dt; }
    while (pts.length && pts[0].age > this.life) pts.shift();
    if (head) {
      var last = pts[pts.length - 1];
      if (!last || Math.hypot(head.x - last.x, head.y - last.y, head.z - last.z) > 0.32) {
        if (pts.length >= this.n) pts.shift();
        pts.push({ x: head.x, y: head.y, z: head.z, age: 0 });
      }
    }
    var m = pts.length, R2 = this.rows;
    for (i = 0; i < this.n; i++) {
      var p = pts[Math.min(i, m - 1)] || { x: 0, y: -1e4, z: 0, age: 99 };
      var fade = m > 1 && i < m ? Math.max(0, 1 - p.age / this.life) * Math.min(1, i / 3) : 0;
      for (var r = 0; r < R2; r++) {
        var k = i * R2 + r, off = (r / (R2 - 1) - 0.5) * this.width, cc = this.colors[r];
        this.posA[k * 3] = p.x; this.posA[k * 3 + 1] = p.y + off; this.posA[k * 3 + 2] = p.z;
        this.colA[k * 4] = cc.r; this.colA[k * 4 + 1] = cc.g; this.colA[k * 4 + 2] = cc.b; this.colA[k * 4 + 3] = fade * 0.85;
      }
    }
    this.geo.attributes.position.needsUpdate = this.geo.attributes.color.needsUpdate = true;
  };
  Ribbon.prototype.dispose = function () { if (this.mesh.parent) this.mesh.parent.remove(this.mesh); this.geo.dispose(); this.mesh.material.dispose(); };

  /* Ground decals (dragon tracks, slime): flat quads in one draw call */
  function Decals(container, n) {
    this.n = n || 40; this.list = [];
    var geo = this.geo = new T.BufferGeometry();
    this.posA = new Float32Array(this.n * 12); this.uvA = new Float32Array(this.n * 8); this.colA = new Float32Array(this.n * 16);
    geo.setAttribute('position', new T.BufferAttribute(this.posA, 3).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('uv', new T.BufferAttribute(this.uvA, 2).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('color', new T.BufferAttribute(this.colA, 4).setUsage(T.DynamicDrawUsage));
    var idx = [];
    for (var i = 0; i < this.n; i++) idx.push(i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3);
    geo.setIndex(idx);
    geo.boundingSphere = new T.Sphere(new T.Vector3(), 1e6);
    this.mesh = new T.Mesh(geo, new T.MeshBasicMaterial({ map: atlas().tex, vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 9;
    this.setContainer(container);
  }
  Decals.prototype.setContainer = Ribbon.prototype.setContainer;
  Decals.prototype.add = function (o) { if (this.list.length >= this.n) this.list.shift(); o.age = 0; this.list.push(o); };
  Decals.prototype.update = function (dt, wx, wz) {
    var L = this.list, i;
    for (i = 0; i < L.length; i++) { L[i].age += dt; L[i].x += (wx || 0) * dt; L[i].z += (wz || 0) * dt; }
    while (L.length && L[0].age > L[0].life) L.shift();
    for (i = 0; i < this.n; i++) {
      var d = L[i], b = i * 12;
      if (!d) { for (var q = 0; q < 12; q++) this.posA[b + q] = 0; for (q = 0; q < 16; q++) this.colA[i * 16 + q] = 0; continue; }
      var cs = Math.cos(d.yaw) * d.size / 2, sn = Math.sin(d.yaw) * d.size / 2;
      var corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      var c = col(d.color), a = d.alpha * Math.min(1, 2 * (1 - d.age / d.life));
      var fc = d.frame % 8, fr = (d.frame / 8) | 0;
      for (var k = 0; k < 4; k++) {
        var lx = corners[k][0], lz = corners[k][1];
        this.posA[b + k * 3] = d.x + lx * cs + lz * sn; this.posA[b + k * 3 + 1] = d.y; this.posA[b + k * 3 + 2] = d.z - lx * sn + lz * cs;
        this.uvA[i * 8 + k * 2] = (fc + (lx + 1) / 2) / 8; this.uvA[i * 8 + k * 2 + 1] = 1 - (fr + (1 - (lz + 1) / 2)) / 4;
        this.colA[i * 16 + k * 4] = c.r; this.colA[i * 16 + k * 4 + 1] = c.g; this.colA[i * 16 + k * 4 + 2] = c.b; this.colA[i * 16 + k * 4 + 3] = a;
      }
    }
    var g = this.geo.attributes;
    g.position.needsUpdate = g.uv.needsUpdate = g.color.needsUpdate = true;
  };
  Decals.prototype.dispose = Ribbon.prototype.dispose;

  /* ---------------------------------------------------------------------- */
  /* Trails: fx -> { rate (per second while running), emit(sys, c) }         */
  /* c = { x, y, z (feet), dx, dz (facing), k (0..1.5 speed factor), fx }    */
  /* ---------------------------------------------------------------------- */
  function J(r) { return (R() - 0.5) * 2 * r; }
  var GEMS = ['#ff3a4a', '#3a8aff', '#2fd06a', '#b45cff', '#ffd23a', '#4ff0ff'];
  var BRIGHT = ['#ff4d6d', '#ffd23a', '#3fc8ff', '#7cf05a', '#b45cff', '#ff9a2e', '#ffffff'];
  var TRAILS = {
    sparkle: { rate: 26, emit: function (s, c) { s.p({ x: c.x + J(0.8), y: c.y + rr(0.3, 3.2), z: c.z + J(0.8), vx: J(0.5), vy: rr(0.3, 1.4), vz: J(0.5), life: rr(0.6, 1.0), size: rr(0.45, 0.85), size1: 0.05, color: pick(['#ffffff', '#fff3a0', '#a8f0ff', '#ffd0f8']), frame: FR.sparkle, add: true, spin: J(3), tw: 1 }); } },
    leaves: { rate: 10, emit: function (s, c) { s.p({ x: c.x + J(0.9), y: c.y + rr(1.2, 3.4), z: c.z + J(0.9), vx: J(0.8), vy: rr(0, 1), vz: J(0.8), life: rr(1.6, 2.2), size: rr(0.5, 0.75), size1: 0.5, color: pick(['#5fbf3a', '#8fd84a', '#e8a23a', '#3d9a2a']), frame: FR.leaf, spin: J(4), grav: 2.2, drag: 1.2, wob: 1.8, wobF: 4, floor: c.y + 0.05, hold: 0.75 }); } },
    bubbles: { rate: 11, emit: function (s, c) { s.p({ x: c.x + J(0.8), y: c.y + rr(0.5, 2.5), z: c.z + J(0.8), vx: J(0.4), vy: rr(0.6, 1.4), vz: J(0.4), life: rr(1.3, 2.0), size: rr(0.35, 0.75), size1: 0.9, color: pick(['#bff4ff', '#ffd6f4', '#e8fff8', '#c8d8ff']), alpha: 0.95, frame: FR.bubble, grav: -0.6, wob: 1, pop: 1, hold: 0.85 }); } },
    smoke: { rate: 13, emit: function (s, c) { s.p({ x: c.x + J(0.6), y: c.y + rr(0.2, 0.8), z: c.z + J(0.6), vx: J(0.8), vy: rr(0.6, 1.5), vz: J(0.8), life: rr(1.0, 1.5), size: rr(0.6, 1.0), size1: rr(2.0, 2.8), color: '#f2f2f2', color1: '#a8a8b0', alpha: 0.6, frame: FR.smoke, spin: J(1), drag: 1.5, hold: 0.3 }); } },
    hearts: { rate: 7, emit: function (s, c) { s.p({ x: c.x + J(0.7), y: c.y + rr(1.0, 3.0), z: c.z + J(0.7), vx: J(0.3), vy: rr(0.8, 1.6), vz: J(0.3), life: rr(1.2, 1.6), size: rr(0.55, 0.85), size1: 0.6, color: pick(['#ff4d6d', '#ff8fab', '#ff2a55', '#ffb3c8']), frame: FR.heart, wob: 0.8, ang: J(0.3), pop: 1 }); } },
    footprints: { rate: 0, perDist: 2.1, emit: function (s, c, D) {
      var px = -c.dz * 0.45 * c.side, pz = c.dx * 0.45 * c.side;
      D.add({ x: c.x + px, y: c.y + 0.04, z: c.z + pz, yaw: Math.atan2(c.dx, c.dz) + PI, size: 1.0, frame: FR.claw, color: '#5a3a22', alpha: 0.7, life: 3.2 });
      s.p({ x: c.x + px, y: c.y + 0.2, z: c.z + pz, vx: J(0.6), vy: rr(0.3, 0.8), vz: J(0.6), life: 0.6, size: 0.6, size1: 1.3, color: '#d8c8a8', alpha: 0.45, frame: FR.smoke, drag: 2 });
    } },
    confetti: { rate: 20, emit: function (s, c) { s.p({ x: c.x + J(0.7), y: c.y + rr(1, 3), z: c.z + J(0.7), vx: J(1.6), vy: rr(1, 3), vz: J(1.6), life: rr(1.3, 1.8), size: rr(0.3, 0.42), size1: 0.3, color: pick(BRIGHT), frame: FR.confetti, spin: J(10), grav: 4, drag: 1.4, floor: c.y + 0.05, hold: 0.8 }); } },
    fire: { rate: 34, emit: function (s, c) {
      s.p({ x: c.x + J(0.5), y: c.y + rr(0.1, 0.6), z: c.z + J(0.5), vx: J(0.6), vy: rr(2, 4), vz: J(0.6), life: rr(0.45, 0.65), size: rr(0.8, 1.2), size1: 0.15, color: '#ffe36a', color1: '#ff2a00', frame: FR.flame, add: true, ang: J(0.3), hold: 0.4 });
      if (R() < 0.25) s.p({ x: c.x + J(0.4), y: c.y + 0.5, z: c.z + J(0.4), vx: J(1), vy: rr(2, 4), vz: J(1), life: 1, size: 0.22, color: '#ffb347', frame: FR.ember, add: true, wob: 2, tw: 1 });
    } },
    frost: { rate: 22, emit: function (s, c) { var sn = R() < 0.6; s.p({ x: c.x + J(0.8), y: c.y + rr(0.2, 2.6), z: c.z + J(0.8), vx: J(0.4), vy: rr(-0.2, 0.6), vz: J(0.4), life: rr(0.9, 1.3), size: sn ? rr(0.4, 0.6) : rr(0.4, 0.7), size1: 0.1, color: sn ? '#e8fbff' : '#7fe0ff', frame: sn ? FR.snow : FR.sparkle, add: true, spin: J(2), grav: 0.6, tw: sn ? 0 : 1 }); } },
    stars: { rate: 13, emit: function (s, c) { s.p({ x: c.x + J(0.8), y: c.y + rr(0.5, 3), z: c.z + J(0.8), vx: J(1), vy: rr(1, 2.2), vz: J(1), life: rr(0.8, 1.1), size: rr(0.55, 0.85), size1: 0.15, color: pick(['#ffe14a', '#ffffff', '#ffd27a']), frame: FR.star, add: true, spin: J(4), grav: 1.5, tw: 1 }); } },
    notes: { rate: 6, emit: function (s, c) { s.p({ x: c.x + J(0.7), y: c.y + rr(1.5, 3.2), z: c.z + J(0.7), vx: J(0.3), vy: rr(0.8, 1.4), vz: J(0.3), life: rr(1.4, 1.8), size: rr(0.6, 0.8), size1: 0.6, color: pick(['#b45cff', '#3fa8ff', '#ff5aa0', '#2fd06a']), frame: R() < 0.5 ? FR.note : FR.note2, ang: J(0.4), wob: 1.4, pop: 1 }); } },
    petals: { rate: 12, emit: function (s, c) { s.p({ x: c.x + J(0.9), y: c.y + rr(1.5, 3.4), z: c.z + J(0.9), vx: J(0.6), vy: rr(0, 0.6), vz: J(0.6), life: rr(1.6, 2.1), size: rr(0.35, 0.5), size1: 0.35, color: pick(['#ffb3d1', '#ffffff', '#ffd1dc', '#ff8fb8']), frame: FR.petal, spin: J(4), grav: 1.2, drag: 1, wob: 1.6, floor: c.y + 0.04, hold: 0.75 }); } },
    snow: { rate: 18, emit: function (s, c) { s.p({ x: c.x + J(1.4), y: c.y + rr(5.5, 7.5), z: c.z + J(1.4), vx: J(0.3), vy: -rr(1, 2), vz: J(0.3), life: rr(1.6, 2.2), size: rr(0.3, 0.45), size1: 0.3, color: '#ffffff', frame: FR.snow, spin: J(1.5), wob: 0.9, floor: c.y + 0.04, hold: 0.8 }); } },
    coins: { rate: 8, emit: function (s, c) {
      s.p({ x: c.x + J(0.5), y: c.y + rr(1.2, 2.2), z: c.z + J(0.5), vx: J(2), vy: rr(3, 5), vz: J(2), life: rr(1.3, 1.6), size: 0.6, size1: 0.55, color: '#ffd23a', color1: '#ffb31a', frame: FR.coin, spin: J(6), grav: 14, floor: c.y + 0.25, hold: 0.8 });
      if (R() < 0.5) s.p({ x: c.x + J(0.6), y: c.y + rr(0.5, 2.5), z: c.z + J(0.6), vy: 0.5, life: 0.5, size: 0.5, size1: 0, color: '#fff3a0', frame: FR.sparkle, add: true });
    } },
    pixels: { rate: 18, emit: function (s, c) { s.p({ x: c.x + J(0.8), y: c.y + rr(0.3, 3.2), z: c.z + J(0.8), vx: J(0.3), vy: rr(0, 0.5), vz: J(0.3), life: rr(0.7, 1.0), size: rr(0.35, 0.5), size1: 0.12, color: pick(['#ff3a4a', '#3a8aff', '#2fd06a', '#ffd23a', '#ff5aff']), frame: FR.pixel, ang: 0, hold: 0.5 }); } },
    slime: { rate: 9, perDist: 2.6, emit: function (s, c, D) {
      if (D) { D.add({ x: c.x + J(0.3), y: c.y + 0.03, z: c.z + J(0.3), yaw: R() * TAU, size: rr(1.1, 1.6), frame: FR.soft, color: '#6aff5a', alpha: 0.6, life: 2.6 }); return; }
      s.p({ x: c.x + J(0.6), y: c.y + rr(0.8, 2), z: c.z + J(0.6), vx: J(0.4), vy: rr(0, 1), vz: J(0.4), life: 1.0, size: rr(0.35, 0.55), size1: 0.45, color: '#7cff5a', color1: '#3acf2a', frame: FR.drop, ang: 0, grav: 9, floor: c.y + 0.08, hold: 0.7 });
    } },
    rainbow: { rate: 8, ribbon: ['#ff4d4d', '#ff9f2e', '#ffe14a', '#5ad65a', '#3fa8ff', '#9b5cff'], emit: function (s, c) { s.p({ x: c.x + J(0.6), y: c.y + rr(1.5, 3.5), z: c.z + J(0.6), vy: 0.4, life: 0.7, size: 0.5, size1: 0, color: '#ffffff', frame: FR.sparkle, add: true, tw: 1 }); } },
    embers: { rate: 24, emit: function (s, c) { s.p({ x: c.x + J(0.7), y: c.y + rr(0.2, 1.5), z: c.z + J(0.7), vx: J(0.6), vy: rr(1.2, 2.6), vz: J(0.6), life: rr(1.0, 1.5), size: rr(0.2, 0.38), size1: 0.05, color: pick(['#ffb347', '#ff7a1f', '#ffe14a']), color1: '#ff3a0a', frame: FR.ember, add: true, wob: 2.4, wobF: 6, tw: 1 }); } },
    lightning: { rate: 14, emit: function (s, c) {
      if (R() < 0.5) s.p({ x: c.x + J(0.8), y: c.y + rr(0.6, 3), z: c.z + J(0.8), life: rr(0.12, 0.2), size: rr(0.9, 1.4), size1: 0.9, color: pick(['#bff4ff', '#ffffff', '#8fd8ff']), frame: FR.bolt, add: true, hold: 0.3 });
      for (var k = 0; k < 2; k++) s.p({ x: c.x + J(0.6), y: c.y + rr(0.3, 2.5), z: c.z + J(0.6), vx: J(4), vy: J(3), vz: J(4), life: rr(0.2, 0.35), size: 0.45, size1: 0.05, color: '#9ff0ff', frame: FR.spark, add: true, drag: 4 });
    } },
    gems: { rate: 10, emit: function (s, c) {
      s.p({ x: c.x + J(0.5), y: c.y + rr(1, 2), z: c.z + J(0.5), vx: J(2), vy: rr(3, 5), vz: J(2), life: rr(1.3, 1.7), size: rr(0.45, 0.65), size1: 0.45, color: pick(GEMS), frame: FR.gem, spin: J(5), grav: 12, floor: c.y + 0.22, hold: 0.8 });
      if (R() < 0.4) s.p({ x: c.x + J(0.6), y: c.y + rr(0.5, 2.5), z: c.z + J(0.6), life: 0.45, size: 0.55, size1: 0, color: '#ffffff', frame: FR.sparkle, add: true });
    } },
    runes: { rate: 8, emit: function (s, c) {
      if (R() < 0.14) s.p({ x: c.x, y: c.y + 0.1, z: c.z, life: 0.8, size: 0.6, size1: 2.6, color: '#b45cff', color1: '#4ff0ff', alpha: 0.7, frame: FR.ring, add: true, ang: 0 });
      s.p({ x: c.x + J(0.7), y: c.y + rr(0.6, 2.6), z: c.z + J(0.7), vy: rr(0.5, 1.2), life: rr(1.0, 1.4), size: rr(0.55, 0.8), size1: 0.3, color: pick(['#c08aff', '#7fe8ff']), frame: R() < 0.5 ? FR.rune : FR.rune2, add: true, ang: J(0.4), fadeIn: 1, tw: 1 });
    } },
    butterflies: { rate: 3.2, emit: function (s, c) { s.p({ x: c.x + J(0.8), y: c.y + rr(1.5, 3), z: c.z + J(0.8), vx: J(0.6), vy: rr(0.5, 1), vz: J(0.6), life: rr(2.2, 2.8), size: rr(0.6, 0.8), size1: 0.6, color: pick(['#3fa8ff', '#ff9a2e', '#ff5aa0', '#ffd23a', '#b45cff']), frame: FR.butterfly, frame2: FR.butterfly2, wob: 2.4, wobF: 2.5, ang: J(0.3), hold: 0.85 }); } },
    galaxy: { rate: 28, emit: function (s, c) {
      var a = R() * TAU, r = rr(0.6, 1.4);
      s.p({ x: c.x + Math.cos(a) * r, y: c.y + rr(0.4, 3.2), z: c.z + Math.sin(a) * r, vx: -Math.sin(a) * 1.5, vy: rr(0.1, 0.6), vz: Math.cos(a) * 1.5, life: rr(0.9, 1.4), size: rr(0.25, 0.6), size1: 0.05, color: pick(['#ffffff', '#c8b0ff', '#8fb8ff', '#ff9ae8']), frame: R() < 0.6 ? FR.sparkle : FR.star, add: true, tw: 1, ox: c.x, oz: c.z, w: 2.4 });
      if (R() < 0.3) s.p({ x: c.x + J(0.6), y: c.y + rr(0.6, 2.6), z: c.z + J(0.6), vy: 0.3, life: 1.2, size: rr(1.4, 2.2), size1: 2.6, color: pick(['#5a2aa8', '#2a3aa8', '#a82a8a']), alpha: 0.35, frame: FR.soft, add: true });
    } },
    dragonfire: { rate: 46, emit: function (s, c) {
      s.p({ x: c.x + J(0.6), y: c.y + rr(0.1, 0.8), z: c.z + J(0.6), vx: J(0.8) - c.dx * 1.5, vy: rr(2.5, 5), vz: J(0.8) - c.dz * 1.5, life: rr(0.5, 0.75), size: rr(1.1, 1.6), size1: 0.25, color: '#fff08a', color1: '#ff1a00', frame: FR.flame, add: true, ang: J(0.4), hold: 0.4 });
      if (R() < 0.2) s.p({ x: c.x + J(0.5), y: c.y + rr(1.5, 2.8), z: c.z + J(0.5), vx: J(0.5), vy: rr(1.5, 2.5), vz: J(0.5), life: rr(0.9, 1.2), size: rr(0.8, 1.1), size1: 1.9, color: '#5a4038', alpha: 0.28, frame: FR.smoke, spin: J(1), drag: 1 });
      if (R() < 0.4) s.p({ x: c.x + J(0.5), y: c.y + 0.6, z: c.z + J(0.5), vx: J(1.5), vy: rr(3, 5), vz: J(1.5), life: 1.2, size: 0.25, color: '#ffd23a', frame: FR.ember, add: true, wob: 2, tw: 1 });
    } }
  };

  /* ---------------------------------------------------------------------- */
  /* Victory effects                                                          */
  /* def { dur, thumbT, frame:{ cy, h }, start(v), tick(v, dt, t) }           */
  /* v: { sys, root (Group at the position, local space), x,y,z (container),  */
  /*      model, inGame, once(key), mesh(o), ring(...), burst(n, fn) }        */
  /* ---------------------------------------------------------------------- */
  function V(sys, container, pos, model, inGame) {
    this.sys = sys; this.container = container; this.model = model; this.inGame = inGame;
    this.x = pos.x; this.y = pos.y; this.z = pos.z;
    this.root = new T.Group(); this.root.position.set(pos.x, pos.y, pos.z);
    container.add(this.root);
    this.t = 0; this.done = false; this.flags = {}; this.anims = []; this.data = {};
  }
  V.prototype.once = function (k, at) { if (this.flags[k] || this.t < at) return false; this.flags[k] = true; return true; };
  V.prototype.mesh = function (o) {
    o.castShadow = false;
    o.traverse(function (n) { var m = n.material; if (m && !Array.isArray(m) && m.blending === T.AdditiveBlending && !m.userData.shared) m.blending = T.NormalBlending; });
    this.root.add(o);
    return o;
  };
  V.prototype.p = function (o) { o.x += this.x; o.y += this.y; o.z += this.z; if (o.ox !== undefined) { o.ox += this.x; o.oz += this.z; } return this.sys.p(o); };
  V.prototype.burst = function (n, fn) { n = Math.max(1, Math.round(n * (this.sys.mul || 1))); for (var i = 0; i < n; i++) this.p(fn(i, n)); };
  V.prototype.anim = function (fn) { this.anims.push(fn); };
  /* flat expanding ring on the ground (or vertical when vert) */
  V.prototype.ring = function (r0, r1, dur, color, y, vert, width) {
    var m = new T.Mesh(new T.RingGeometry(0.82, 1, 40), new T.MeshBasicMaterial({ color: col(color), transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    if (width) m.geometry = new T.RingGeometry(1 - width, 1, 40);
    if (!vert) m.rotation.x = -PI / 2;
    m.position.y = y || 0.08;
    this.mesh(m);
    var t0 = this.t;
    this.anim(function (v) {
      var k = (v.t - t0) / dur;
      if (k >= 1) { m.visible = false; return false; }
      var r = lerp(r0, r1, easeOut(k)); m.scale.set(r, r, r); m.material.opacity = 0.9 * (1 - k);
      return true;
    });
    return m;
  };
  V.prototype.flash = function (y, size, color, life) { this.p({ x: 0, y: y, z: 0, life: life || 0.3, size: size, size1: size * 1.3, color: color || '#ffffff', frame: FR.soft, add: true, hold: 0.2 }); };
  V.prototype.update = function (dt) {
    this.t += dt;
    for (var i = 0; i < this.anims.length; i++) if (this.anims[i](this, dt) === false) this.anims.splice(i--, 1);
    if (this.def.tick) this.def.tick(this, dt, this.t);
    if (this.t >= this.def.dur) this.finish();
  };
  V.prototype.finish = function () {
    if (this.done) return;
    this.done = true;
    if (this.data.rig && this.data.rig.dispose) { try { this.data.rig.dispose(); } catch (e) { /* ignore */ } }
    if (this.root.parent) this.root.parent.remove(this.root);
    disposeTree(this.root);
  };
  function popScale(o, t0, t, dur) { var k = clamp((t - t0) / (dur || 0.35), 0, 1); o.scale.setScalar(Math.max(0.001, easeBack(k))); }
  function fadeOutScale(o, t, from, to) { if (t > from) o.scale.multiplyScalar(Math.max(0.001, 1 - (t - from) / (to - from))); }
  function blockDragon(c1, c2, wingCol) {
    var g = new T.Group();
    g.add(P(bx(2.2, 1.7, 4.0, c1, { flat: true }), 0, 0, 0), P(bx(1.6, 1.0, 3.2, c2), 0, -0.5, 0.2));
    var neck = P(new T.Group(), 0, 0.6, 1.8, -0.6, 0, 0);
    neck.add(P(bx(0.9, 0.9, 2.0, c1), 0, 0, 1.0));
    var head = P(new T.Group(), 0, 0.2, 2.1, 0.6, 0, 0);
    head.add(P(bx(1.4, 1.1, 1.6, c1), 0, 0, 0.3), P(bx(1.0, 0.6, 1.0, c2), 0, -0.25, 1.2), P(co(0.2, 1.0, '#fff3c8', 5), -0.45, 0.8, -0.3, -0.7, 0, 0), P(co(0.2, 1.0, '#fff3c8', 5), 0.45, 0.8, -0.3, -0.7, 0, 0));
    head.add(P(bx(0.25, 0.22, 0.06, '#ffe14a', glow('#ffe14a', 1)), -0.45, 0.2, 1.1), P(bx(0.25, 0.22, 0.06, '#ffe14a', glow('#ffe14a', 1)), 0.45, 0.2, 1.1));
    neck.add(head); g.add(neck);
    var tail = P(new T.Group(), 0, 0.2, -2.0);
    tail.add(P(bx(0.9, 0.8, 2.4, c1), 0, 0, -1.2), P(bx(0.5, 0.5, 2.0, c1), 0, 0, -3.2), P(co(0.45, 1.0, c2, 4), 0, 0, -4.6, -PI / 2, 0, 0));
    g.add(tail);
    var wings = [];
    [-1, 1].forEach(function (sd) {
      var pv = P(new T.Group(), sd * 1.0, 0.7, 0.4);
      var w = shp([[0, 0], [2.6, 1.2], [5.6, 0.8], [4.4, -0.4], [5.0, -1.6], [3.0, -1.4], [1.0, -1.8]], 0.08, wingCol, { side: 2, emissive: wingCol, ei: 0.2 });
      w.rotation.x = -PI / 2;
      if (sd < 0) w.scale.x = -1;
      pv.add(w); g.add(pv); wings.push({ pv: pv, sd: sd });
    });
    g.userData.flap = function (t) { for (var i = 0; i < wings.length; i++) wings[i].pv.rotation.z = wings[i].sd * Math.sin(t * 6) * 0.6; tail.rotation.y = Math.sin(t * 3) * 0.3; };
    return g;
  }
  function rainbowArc(R0, R1) {
    var geo = new T.RingGeometry(R0, R1, 48, 6, 0, PI);
    var cols = ['#9b5cff', '#3fa8ff', '#5ad65a', '#ffe14a', '#ff9f2e', '#ff4d4d'], pos = geo.attributes.position, arr = new Float32Array(pos.count * 4);
    for (var i = 0; i < pos.count; i++) {
      var r = Math.hypot(pos.getX(i), pos.getY(i)), k = clamp((r - R0) / (R1 - R0), 0, 0.999), cc = col(cols[Math.floor(k * 6)]);
      arr[i * 4] = cc.r; arr[i * 4 + 1] = cc.g; arr[i * 4 + 2] = cc.b; arr[i * 4 + 3] = 0.85;
    }
    geo.setAttribute('color', new T.BufferAttribute(arr, 4));
    return new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, side: T.DoubleSide, depthWrite: false }));
  }
  function runeCircleTexture() {
    var c = cvs(256, 256), g = c.getContext('2d');
    g.translate(128, 128); g.strokeStyle = '#ffffff'; g.fillStyle = '#ffffff'; g.lineWidth = 5;
    g.beginPath(); g.arc(0, 0, 120, 0, TAU); g.stroke(); g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 100, 0, TAU); g.stroke(); g.beginPath(); g.arc(0, 0, 54, 0, TAU); g.stroke();
    g.beginPath(); for (var i = 0; i <= 5; i++) { var a = -PI / 2 + i * TAU * 2 / 5; g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * 100, Math.sin(a) * 100); } g.stroke();
    g.font = '900 18px serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    var runes = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃ';
    for (var k = 0; k < 12; k++) { g.save(); g.rotate(k * TAU / 12); g.fillText(runes[k], 0, -110); g.restore(); }
    var t = tex(c);
    return t;
  }
  var VICTORY = {
    _default: { dur: 1.6, thumbT: 0.3, frame: { cy: 4, h: 9 }, tick: function (v) {
      if (v.once('a', 0)) { v.burst(16, function (i, n) { var a = i / n * TAU; return { x: 0, y: 3, z: 0, vx: Math.cos(a) * rr(4, 6), vy: rr(2, 5), vz: Math.sin(a) * rr(4, 6), life: 1, size: 0.7, size1: 0.1, color: pick(['#ffe14a', '#ffffff']), frame: FR.star, add: true, drag: 2, spin: J(4) }; }); v.flash(3, 4, '#fff3a0'); }
    } },
    confetti: { dur: 3.2, thumbT: 0.75, frame: { cy: 5.5, h: 13 }, start: function (v) {
      v.data.cannons = [-1, 1].map(function (sd) {
        var c = v.mesh(grp(P(cy(0.45, 0.6, 1.8, '#3a3f47', 12, STEEL), 0, 0.9, 0), P(tor(0.46, 0.08, '#ffd24a', 5, 14, TAU, GOLD), 0, 1.8, 0, PI / 2, 0, 0), P(bx(1.0, 0.4, 1.0, '#c8302f'), 0, 0.2, 0)));
        c.position.set(sd * 2.6, 0, -0.4); c.rotation.z = sd * 0.42; c.scale.setScalar(0.001);
        return c;
      });
    }, tick: function (v, dt, t) {
      v.data.cannons.forEach(function (c, i) { popScale(c, 0, t, 0.25); if (t > 0.1 && t < 0.3) c.scale.y *= 0.85 + (t - 0.1) * 0.75; fadeOutScale(c, t, 2.6, 3.2); });
      [['a', 0.12], ['b', 0.55], ['c', 1.0]].forEach(function (b) {
        if (v.once(b[0], b[1])) {
          [-1, 1].forEach(function (sd) {
            v.burst(55, function () { return { x: sd * 3.2, y: 1.9, z: -0.4, vx: -sd * rr(2, 6), vy: rr(12, 19), vz: J(3), life: rr(2.2, 3), size: rr(0.38, 0.5), size1: 0.38, color: pick(BRIGHT), frame: FR.confetti, spin: J(12), grav: 9, drag: 0.9, floor: 0.05, hold: 0.85 }; });
          });
          sfx('pop', { volume: 0.6 });
        }
      });
    } },
    hearts: { dur: 2.8, thumbT: 1.0, frame: { cy: 5.5, h: 12 }, tick: function (v, dt, t) {
      if (t < 1.6) { v.data.acc = (v.data.acc || 0) + dt * 40 * v.sys.mul; while (v.data.acc >= 1) { v.data.acc--; v.p({ x: J(0.6), y: 1.5, z: J(0.6), vx: J(2.5), vy: rr(6, 10), vz: J(2.5), life: rr(1.4, 2), size: rr(0.6, 1.0), size1: 0.8, color: pick(['#ff4d6d', '#ff8fab', '#ff2a55', '#ffb3c8']), frame: FR.heart, grav: 5, drag: 0.6, wob: 0.8, pop: 1, ang: J(0.4) }); } }
      if (v.once('big', 0.15)) { v.p({ x: 0, y: 8.5, z: 0, vy: 0.4, life: 2.0, size: 3.6, size1: 3.2, color: '#ff4d6d', frame: FR.heart, ang: 0, pop: 1, hold: 0.7 }); v.flash(8.5, 6, '#ff8fab', 0.5); }
    } },
    bubbles: { dur: 2.8, thumbT: 0.9, frame: { cy: 4, h: 10 }, start: function (v) {
      var b = v.data.bub = v.mesh(sp(3.4, '#bfefff', { std: true, rough: 0.05, metal: 0.2, opacity: 0.22, emissive: '#4fc8ff', ei: 0.2 }, 20, 14));
      b.position.y = 3.2; b.scale.setScalar(0.001); b.renderOrder = 4;
    }, tick: function (v, dt, t) {
      var b = v.data.bub;
      if (t < 1.5) { popScale(b, 0, t, 0.45); b.scale.x *= 1 + Math.sin(t * 9) * 0.04; b.scale.y *= 1 - Math.sin(t * 9) * 0.04; }
      if (t < 1.5) { v.data.acc = (v.data.acc || 0) + dt * 18; while (v.data.acc >= 1) { v.data.acc--; v.p({ x: J(2.5), y: rr(0.3, 1), z: J(2.5), vy: rr(1.5, 3), life: rr(1.2, 1.8), size: rr(0.3, 0.7), size1: 0.8, color: pick(['#bff4ff', '#ffd6f4']), frame: FR.bubble, wob: 1, hold: 0.85 }); } }
      if (v.once('pop', 1.5)) {
        b.visible = false; sfx('pop');
        v.burst(60, function () { var a = R() * TAU, e = rr(-0.6, 1.2); return { x: Math.cos(a) * 3.3, y: 3.2 + e * 2.5, z: Math.sin(a) * 3.3, vx: Math.cos(a) * rr(3, 6), vy: rr(-1, 3), vz: Math.sin(a) * rr(3, 6), life: rr(0.8, 1.2), size: rr(0.3, 0.6), size1: 0.1, color: pick(['#bff4ff', '#ffffff', '#ffd6f4']), frame: R() < 0.5 ? FR.bubble : FR.drop, grav: 6, drag: 1.5 }; });
      }
    } },
    balloons: { dur: 3.8, thumbT: 1.3, frame: { cy: 6.5, h: 14 }, start: function (v) {
      v.data.b = [];
      for (var i = 0; i < 9; i++) {
        var c = BRIGHT[i % 6], a = i / 9 * TAU + 0.3, r = rr(1.6, 2.8);
        var g = v.mesh(grp(P(sp(0.62, c, { std: true, rough: 0.25 }, 14, 10), 0, 0, 0, 0, 0, 0, [1, 1.18, 1]), P(co(0.12, 0.2, c, 6), 0, -0.78, 0, PI, 0, 0), P(bx(0.025, 1.6, 0.025, '#f4f4f4'), 0, -1.65, 0)));
        g.position.set(Math.cos(a) * r, 1.2, Math.sin(a) * r);
        v.data.b.push({ g: g, sp: rr(2.6, 4.2), ph: R() * TAU, d: i * 0.08 });
      }
    }, tick: function (v, dt, t) {
      v.data.b.forEach(function (b) {
        var k = Math.max(0, t - b.d);
        popScale(b.g, b.d, t, 0.3);
        b.g.position.y = 1.2 + k * b.sp; b.g.position.x += Math.sin(t * 2 + b.ph) * dt * 0.6;
        b.g.rotation.z = Math.sin(t * 2.4 + b.ph) * 0.15;
        fadeOutScale(b.g, t, 3.2, 3.8);
      });
    } },
    flowers: { dur: 3.2, thumbT: 1.1, frame: { cy: 3.2, h: 9 }, start: function (v) {
      v.data.f = [];
      for (var i = 0; i < 12; i++) {
        var a = i / 12 * TAU, r = i % 2 ? 2.4 : 3.3, c = pick(['#ff5aa0', '#ffd23a', '#b45cff', '#ff7a4a', '#ffffff', '#4fc8ff']), h = rr(0.9, 1.6);
        var g = new T.Group();
        g.add(P(cy(0.06, 0.08, h, '#3d9a2a', 5), 0, h / 2, 0), P(sp(0.28, '#ffd23a', null, 8, 6), 0, h, 0.05));
        for (var k = 0; k < 6; k++) { var b = k / 6 * TAU; g.add(P(sp(0.28, c, null, 8, 6), Math.cos(b) * 0.38, h, Math.sin(b) * 0.38 * 0.4 + 0.02, 0, 0, b, [1, 0.6, 0.25])); }
        g.add(P(sp(0.25, '#5fbf3a', { flat: true }, 6, 4), 0.2, h * 0.45, 0, 0, 0, -0.8, [1, 0.35, 0.15]));
        g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r); g.rotation.y = -a + PI / 2;
        v.mesh(g); g.scale.setScalar(0.001);
        v.data.f.push({ g: g, d: i * 0.06 });
      }
    }, tick: function (v, dt, t) {
      v.data.f.forEach(function (f) { popScale(f.g, f.d, t, 0.45); fadeOutScale(f.g, t, 2.6, 3.2); });
      if (t < 2.4) { v.data.acc = (v.data.acc || 0) + dt * 14; while (v.data.acc >= 1) { v.data.acc--; var a = R() * TAU; v.p({ x: Math.cos(a) * 2.8, y: 1.4, z: Math.sin(a) * 2.8, vx: J(0.5), vy: rr(1, 2), vz: J(0.5), life: rr(1.4, 2), size: 0.4, size1: 0.35, color: pick(['#ffb3d1', '#ffffff', '#ffd23a']), frame: FR.petal, spin: J(3), wob: 1.5, grav: -0.2 }); } }
    } },
    fireworks: { dur: 3.4, thumbT: 1.25, frame: { cy: 7.5, h: 17 }, start: function (v) {
      v.data.r = [];
      var cols = [['#ff4d6d', '#ffd23a'], ['#3fc8ff', '#ffffff'], ['#7cf05a', '#ffe14a'], ['#b45cff', '#ff9ae8']];
      for (var i = 0; i < 4; i++) {
        var m = v.mesh(sp(0.22, '#fff3a0', glow('#ffcf5a', 2), 8, 6));
        m.visible = false;
        v.data.r.push({ m: m, t0: i * 0.32, x: (i - 1.5) * 2.6 + J(0.6), z: J(1.5) - 1, apex: rr(10.5, 13), c: cols[i], boom: false });
      }
    }, tick: function (v, dt, t) {
      v.data.r.forEach(function (r) {
        var k = (t - r.t0) / 0.7;
        if (k < 0 || r.boom) return;
        r.m.visible = true;
        var y = lerp(1.0, r.apex, easeOut(Math.min(1, k)));
        r.m.position.set(r.x, y, r.z);
        v.p({ x: r.x + J(0.1), y: y - 0.2, z: r.z + J(0.1), vy: -2, life: 0.4, size: 0.4, size1: 0.05, color: '#ffcf5a', frame: FR.ember, add: true });
        if (k >= 1) {
          r.boom = true; r.m.visible = false; sfx('pop', { volume: 0.8, rate: rr(0.8, 1.2) });
          v.flash(r.apex, 5, r.c[0], 0.35);
          v.burst(90, function () {
            var a = R() * TAU, e = Math.acos(rr(-1, 1)), s = rr(7, 9.5);
            return { x: r.x, y: r.apex, z: r.z, vx: Math.sin(e) * Math.cos(a) * s, vy: Math.cos(e) * s, vz: Math.sin(e) * Math.sin(a) * s, life: rr(1.1, 1.6), size: rr(0.45, 0.7), size1: 0.1, color: r.c[0], color1: r.c[1], frame: R() < 0.7 ? FR.sparkle : FR.ember, add: true, grav: 3.5, drag: 1.8, tw: 1 };
          });
        }
      });
    } },
    coin_rain: { dur: 3.0, thumbT: 1.1, frame: { cy: 5.5, h: 13 }, tick: function (v, dt, t) {
      if (t < 1.8) { v.data.acc = (v.data.acc || 0) + dt * 60 * v.sys.mul; while (v.data.acc >= 1) { v.data.acc--; var a = R() * TAU, r = Math.sqrt(R()) * 5; v.p({ x: Math.cos(a) * r, y: rr(11, 15), z: Math.sin(a) * r, vy: -rr(2, 6), life: rr(2.0, 2.6), size: 0.75, size1: 0.7, color: '#ffd23a', color1: '#ffb31a', frame: FR.coin, spin: J(8), grav: 14, floor: 0.3, hold: 0.8 }); if (R() < 0.3) v.p({ x: Math.cos(a) * r, y: rr(4, 10), z: Math.sin(a) * r, life: 0.4, size: 0.7, size1: 0, color: '#fff3a0', frame: FR.sparkle, add: true }); } }
      if (v.once('s', 0.3)) sfx('coin');
    } },
    star_burst: { dur: 2.2, thumbT: 0.32, frame: { cy: 4.5, h: 13 }, tick: function (v, dt, t) {
      [['a', 0.02, 1], ['b', 0.5, 0.6]].forEach(function (b) {
        if (v.once(b[0], b[1])) {
          var s = b[2];
          v.burst(36 * s, function (i, n) { var a = i / n * TAU; return { x: 0, y: 3.4, z: 0, vx: Math.cos(a) * rr(8, 11) * s, vy: rr(0, 3), vz: Math.sin(a) * rr(8, 11) * s, life: rr(1.0, 1.3), size: rr(0.8, 1.1), size1: 0.15, color: pick(['#ffe14a', '#ffffff', '#ffd27a']), frame: FR.star, add: true, drag: 2.2, spin: J(5), grav: 2 }; });
          v.burst(18 * s, function () { return { x: 0, y: 3.4, z: 0, vx: J(2), vy: rr(8, 13) * s, vz: J(2), life: 1.1, size: 0.8, size1: 0.1, color: '#fff3a0', frame: FR.sparkle, add: true, drag: 2, grav: 4, tw: 1 }; });
          v.ring(0.5, 9 * s, 0.6, '#ffe14a', 3.4, true, 0.12);
          v.ring(0.5, 7 * s, 0.6, '#fff3a0', 0.1, false, 0.2);
          v.flash(3.4, 7 * s, '#fff3a0', 0.3);
        }
      });
    } },
    snow_nova: { dur: 2.4, thumbT: 0.55, frame: { cy: 3.5, h: 10 }, start: function (v) {
      v.data.sp = [];
      for (var i = 0; i < 12; i++) {
        var a = i / 12 * TAU, h = rr(1.8, 3.0), m = v.mesh(co(0.42, h, i % 2 ? '#d8f4ff' : '#9fdcff', 5, crystal('#6fd0ff', 0.85)));
        m.position.set(Math.cos(a) * 3.0, -h, Math.sin(a) * 3.0); m.rotation.set(Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3);
        v.data.sp.push({ m: m, h: h, d: i * 0.02 });
      }
    }, tick: function (v, dt, t) {
      v.data.sp.forEach(function (s) { var up = easeBack(clamp((t - s.d) / 0.25, 0, 1)), down = clamp((t - 1.7) / 0.5, 0, 1); s.m.position.y = -s.h + s.h * 0.5 + (s.h * 0.5) * up - s.h * down * 1.2 - s.h * 0.5 * (1 - up); });
      if (v.once('a', 0.02)) {
        v.ring(0.5, 6, 0.7, '#8fe8ff', 0.1, false, 0.25);
        v.burst(60, function () { var a = R() * TAU; return { x: 0, y: rr(0.5, 3), z: 0, vx: Math.cos(a) * rr(5, 9), vy: rr(1, 4), vz: Math.sin(a) * rr(5, 9), life: rr(1.2, 1.6), size: rr(0.45, 0.7), size1: 0.2, color: pick(['#ffffff', '#bff4ff']), frame: FR.snow, spin: J(3), drag: 1.8, grav: 1.5 }; });
        v.flash(1.5, 6, '#bff4ff', 0.3); sfx('freeze', { volume: 0.6 });
      }
    } },
    magic_circle: { dur: 3.0, thumbT: 0.9, frame: { cy: 3.2, h: 9 }, start: function (v) {
      var m = v.data.c = v.mesh(new T.Mesh(new T.PlaneGeometry(7.5, 7.5), new T.MeshBasicMaterial({ map: runeCircleTexture(), color: col('#c08aff'), transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide })));
      m.rotation.x = -PI / 2; m.position.y = 0.08; m.scale.setScalar(0.001);
      var colm = v.data.col = v.mesh(new T.Mesh(new T.CylinderGeometry(3.4, 3.4, 9, 32, 1, true), new T.MeshBasicMaterial({ color: col('#7a4aff'), transparent: true, opacity: 0.0, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide })));
      colm.position.y = 4.5;
    }, tick: function (v, dt, t) {
      var m = v.data.c, k = Math.min(1, t / 0.4), out = clamp((t - 2.4) / 0.6, 0, 1);
      m.scale.setScalar(Math.max(0.001, easeBack(k) * (1 - out * 0.3))); m.rotation.z += dt * 1.2; m.material.opacity = 1 - out;
      v.data.col.material.opacity = 0.18 * Math.min(1, t / 0.5) * (1 - out);
      if (t < 2.4) { v.data.acc = (v.data.acc || 0) + dt * 50 * v.sys.mul; while (v.data.acc >= 1) { v.data.acc--; var a = R() * TAU; v.p({ x: Math.cos(a) * 3.3, y: 0.2, z: Math.sin(a) * 3.3, vy: rr(3, 6), life: rr(0.8, 1.2), size: rr(0.4, 0.7), size1: 0.1, color: pick(['#c08aff', '#7fe8ff', '#ffffff']), frame: R() < 0.8 ? FR.sparkle : FR.rune, add: true, tw: 1 }); } }
    } },
    rainbow: { dur: 3.0, thumbT: 1.0, frame: { cy: 4.2, h: 11 }, start: function (v) {
      var arc = v.data.arc = v.mesh(rainbowArc(4.8, 6.6));
      arc.scale.setScalar(0.001); arc.position.z = -1.5;
    }, tick: function (v, dt, t) {
      var arc = v.data.arc;
      popScale(arc, 0, t, 0.6);
      arc.material.opacity = 1 - clamp((t - 2.4) / 0.6, 0, 1);
      if (v.once('c', 0.3)) [-5.7, 5.7].forEach(function (x) { v.burst(12, function () { return { x: x + J(0.8), y: rr(0, 0.8), z: -1.5 + J(0.6), vx: J(0.6), vy: rr(0.2, 0.8), life: 2.4, size: rr(1.4, 2.2), size1: 2.4, color: '#ffffff', alpha: 0.9, frame: FR.cloud, hold: 0.8 }; }); });
      if (t > 0.3 && t < 2.4) { var a = R() * PI; v.p({ x: Math.cos(a) * 5.7, y: Math.sin(a) * 5.7, z: -1.5, vy: -0.5, life: 0.8, size: 0.7, size1: 0, color: '#ffffff', frame: FR.sparkle, add: true, tw: 1 }); }
    } },
    roar: { dur: 2.4, thumbT: 0.5, frame: { cy: 4.5, h: 12 }, start: function (v) {
      var m = new T.MeshBasicMaterial({ color: col('#ff8a2e'), transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });
      var head = new T.Group();
      head.add(P(mesh(new T.BoxGeometry(2.2, 1.6, 2.4), m), 0, 0, 0), P(mesh(new T.BoxGeometry(1.5, 0.8, 1.6), m), 0, 0.15, 1.8));
      var jaw = P(new T.Group(), 0, -0.6, 0.6); jaw.add(P(mesh(new T.BoxGeometry(1.4, 0.45, 2.0), m), 0, -0.1, 0.9));
      head.add(jaw, P(mesh(new T.ConeGeometry(0.3, 1.6, 5), m), -0.7, 1.2, -0.7, -0.8, 0, 0), P(mesh(new T.ConeGeometry(0.3, 1.6, 5), m), 0.7, 1.2, -0.7, -0.8, 0, 0));
      head.position.set(0, 4, -4.2); head.scale.setScalar(0.001);
      v.data.head = v.mesh(head); v.data.jaw = jaw;
    }, tick: function (v, dt, t) {
      var h = v.data.head, k = clamp(t / 0.5, 0, 1);
      h.position.y = 4 + easeOut(k) * 5; h.scale.setScalar(Math.max(0.001, easeBack(k) * 2.2 * (1 - clamp((t - 1.4) / 0.6, 0, 1))));
      h.rotation.x = -0.35; v.data.jaw.rotation.x = clamp((t - 0.2) / 0.25, 0, 1) * 0.7;
      if (v.once('a', 0.25)) {
        sfx('roar_big', { volume: 0.7 });
        if (v.inGame && SE.Game && typeof SE.Game.shake === 'function') { try { SE.Game.shake(0.6); } catch (e) { /* optional */ } }
        fxEmit('roar_wave', new T.Vector3(v.x, v.y + 3, v.z));
        v.ring(1, 13, 0.9, '#ffb347', 0.1, false, 0.18); v.ring(1, 10, 0.9, '#ffffff', 0.12, false, 0.08);
        v.ring(1, 9, 0.7, '#ff8a2e', 4, true, 0.1);
        v.burst(44, function () { var a = R() * TAU; return { x: Math.cos(a), y: 0.4, z: Math.sin(a), vx: Math.cos(a) * rr(7, 11), vy: rr(0.5, 2), vz: Math.sin(a) * rr(7, 11), life: rr(0.9, 1.3), size: rr(1.2, 1.8), size1: 3.2, color: '#d8c0a0', color1: '#a89070', alpha: 0.55, frame: FR.smoke, drag: 2.4, spin: J(1) }; });
      }
      if (v.once('b', 0.55)) v.ring(1, 13, 0.9, '#ffb347', 0.1, false, 0.14);
    } },
    lightning: { dur: 2.0, thumbT: 0.12, frame: { cy: 5.5, h: 12.5 }, start: function (v) { v.data.bolts = []; }, tick: function (v, dt, t) {
      [['a', 0.0, -0.9], ['b', 0.28, 1.1], ['c', 0.6, 0.2]].forEach(function (b) {
        if (v.once(b[0], b[1])) {
          var g = new T.Group(), x = b[2], y = 26, z = J(1.2) - 0.6;
          var m = new T.MeshBasicMaterial({ color: col(v.inGame ? '#e8fbff' : '#5fc8ff'), transparent: true, blending: T.AdditiveBlending, depthWrite: false });
          while (y > 0.2) {
            var ny = Math.max(0, y - rr(1.6, 3.2)), nx = x + J(1.2), nz = z + J(0.8), len = Math.hypot(nx - x, ny - y, nz - z);
            var seg = mesh(new T.CylinderGeometry(v.inGame ? 0.12 : 0.2, v.inGame ? 0.16 : 0.26, len, 4), m);
            seg.position.set((x + nx) / 2, (y + ny) / 2, (z + nz) / 2);
            seg.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), new T.Vector3(nx - x, ny - y, nz - z).normalize());
            g.add(seg); x = nx; y = ny; z = nz;
          }
          v.mesh(g); v.data.bolts.push({ g: g, t0: v.t });
          v.flash(1, 8, '#bff4ff', 0.25);
          v.burst(30, function () { var a = R() * TAU; return { x: x, y: 0.3, z: z, vx: Math.cos(a) * rr(4, 8), vy: rr(3, 7), vz: Math.sin(a) * rr(4, 8), life: rr(0.3, 0.6), size: 0.5, size1: 0.05, color: '#9ff0ff', frame: FR.spark, add: true, grav: 10, drag: 1 }; });
          v.ring(0.2, 2.6, 0.5, '#9ff0ff', 0.08, false, 0.3);
          sfx('whoosh', { volume: 0.6 });
        }
      });
      v.data.bolts.forEach(function (b) { var k = v.t - b.t0; b.g.visible = k < 0.22 && (((k * 40) | 0) % 3 !== 1); });
      if (t < 1.4 && R() < 0.5) v.p({ x: J(1.2), y: rr(0.5, 4.5), z: J(1.2), life: 0.15, size: rr(0.8, 1.2), size1: 0.8, color: '#bff4ff', frame: FR.bolt, add: true });
    } },
    gem_fountain: { dur: 2.8, thumbT: 0.95, frame: { cy: 5.5, h: 13 }, start: function (v) {
      var g = v.data.gem = v.mesh(oct(0.9, '#b45cff', { std: true, rough: 0.1, metal: 0.2, emissive: '#7a2aff', ei: 0.5 }));
      g.position.y = 9; g.scale.setScalar(0.001);
    }, tick: function (v, dt, t) {
      var g = v.data.gem; popScale(g, 0, t, 0.4); g.scale.y *= 1.4; g.rotation.y += dt * 3; fadeOutScale(g, t, 2.2, 2.8);
      if (t < 1.5) { v.data.acc = (v.data.acc || 0) + dt * 60 * v.sys.mul; while (v.data.acc >= 1) { v.data.acc--; v.p({ x: J(0.3), y: 8.4, z: J(0.3), vx: J(3.5), vy: rr(4, 9), vz: J(3.5), life: rr(2, 2.4), size: rr(0.55, 0.85), size1: 0.6, color: pick(GEMS), frame: FR.gem, spin: J(6), grav: 12, floor: 0.25, hold: 0.8 }); if (R() < 0.3) v.p({ x: J(1), y: rr(6, 10), z: J(1), life: 0.4, size: 0.7, size1: 0, color: '#ffffff', frame: FR.sparkle, add: true }); } }
      if (v.once('s', 0.1)) { fxEmit('gem_burst', new T.Vector3(v.x, v.y + 8, v.z)); sfx('gem'); }
    } },
    flame_ring: { dur: 2.6, thumbT: 0.9, frame: { cy: 4.5, h: 11 }, tick: function (v, dt, t) {
      if (t < 2.0) {
        v.data.acc = (v.data.acc || 0) + dt * 120 * v.sys.mul;
        while (v.data.acc >= 1) {
          v.data.acc--;
          var a = R() * TAU, r = rr(1.6, 2.4);
          v.p({ x: Math.cos(a) * r, y: rr(0, 0.6), z: Math.sin(a) * r, vx: Math.cos(a) * 0.6, vy: rr(4, 8), vz: Math.sin(a) * 0.6, life: rr(0.7, 1.0), size: rr(1.0, 1.5), size1: 0.3, color: '#fff08a', color1: '#ff2a00', frame: FR.flame, add: true, ox: 0, oz: 0, w: rr(4, 6), hold: 0.4 });
          if (R() < 0.25) v.p({ x: Math.cos(a) * 3.4, y: 0.1, z: Math.sin(a) * 3.4, vy: rr(1, 3), life: 0.6, size: rr(0.8, 1.2), size1: 0.2, color: '#ffd23a', color1: '#ff3a0a', frame: FR.flame, add: true });
        }
      }
      if (v.once('r', 0.05)) v.ring(0.5, 3.6, 0.6, '#ff8a2e', 0.1, false, 0.3);
    } },
    meteors: { dur: 3.0, thumbT: 0.55, frame: { cy: 6, h: 15 }, start: function (v) {
      v.data.m = [];
      for (var i = 0; i < 6; i++) {
        var a = i / 6 * TAU + 0.4, r = rr(3.2, 5.5), m = v.mesh(dod(rr(0.55, 0.85), '#5a2a1a', { flat: true, emissive: '#ff4a1a', ei: 0.7 }));
        var tx = Math.cos(a) * r, tz = Math.sin(a) * r;
        v.data.m.push({ m: m, t0: i * 0.2, sx: tx + 9, sy: 20, sz: tz - 7, tx: tx, tz: tz, hit: false });
        m.visible = false;
      }
    }, tick: function (v, dt, t) {
      v.data.m.forEach(function (m) {
        var k = (t - m.t0) / 0.65;
        if (k < 0 || m.hit) return;
        m.m.visible = true;
        var kk = Math.min(1, k), x = lerp(m.sx, m.tx, kk), y = lerp(m.sy, 0.4, kk), z = lerp(m.sz, m.tz, kk);
        m.m.position.set(x, y, z); m.m.rotation.x += dt * 6;
        v.p({ x: x, y: y, z: z, vx: J(1), vy: J(1), vz: J(1), life: 0.4, size: 1.4, size1: 0.3, color: '#fff08a', color1: '#ff2a00', frame: FR.flame, add: true });
        if (R() < 0.5) v.p({ x: x, y: y, z: z, vy: 0.5, life: 0.9, size: 0.9, size1: 2.2, color: '#4a3a38', alpha: 0.45, frame: FR.smoke });
        if (k >= 1) {
          m.hit = true; m.m.visible = false;
          v.ring(0.3, 3.2, 0.5, '#ff8a2e', 0.1, false, 0.3);
          v.p({ x: m.tx, y: 0.6, z: m.tz, life: 0.3, size: 5, size1: 6, color: '#ffb347', frame: FR.soft, add: true });
          v.burst(14, function () { return { x: m.tx, y: 0.4, z: m.tz, vx: J(4), vy: rr(4, 8), vz: J(4), life: 1, size: rr(0.3, 0.5), size1: 0.25, color: '#5a3a2a', frame: FR.pixel, grav: 14, floor: 0.1, spin: J(6) }; });
          v.burst(8, function () { return { x: m.tx + J(0.6), y: 0.6, z: m.tz + J(0.6), vx: J(1.5), vy: rr(0.5, 1.5), vz: J(1.5), life: 1.2, size: 1.2, size1: 2.6, color: '#7a6a60', alpha: 0.5, frame: FR.smoke, drag: 1.5 }; });
          if (v.inGame && SE.Game && SE.Game.shake) { try { SE.Game.shake(0.15); } catch (e) { /* optional */ } }
        }
      });
    } },
    gold_pillar: { dur: 2.8, thumbT: 0.75, frame: { cy: 6.5, h: 15 }, start: function (v) {
      function beam(r, h, c, a) {
        var geo = new T.CylinderGeometry(r, r, h, 24, 6, true), pos = geo.attributes.position, arr = new Float32Array(pos.count * 4), cc = col(c);
        for (var i = 0; i < pos.count; i++) { var k = (pos.getY(i) + h / 2) / h; arr[i * 4] = cc.r; arr[i * 4 + 1] = cc.g; arr[i * 4 + 2] = cc.b; arr[i * 4 + 3] = a * Math.pow(1 - k, 1.4); }
        geo.setAttribute('color', new T.BufferAttribute(arr, 4)); geo.translate(0, h / 2, 0);
        return new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
      }
      v.data.b1 = v.mesh(beam(2.3, 30, '#ffd23a', 0.9)); v.data.b2 = v.mesh(beam(0.9, 30, '#fff8d0', 1));
      v.data.b1.scale.set(0.001, 1, 0.001); v.data.b2.scale.set(0.001, 1, 0.001);
    }, tick: function (v, dt, t) {
      var s = easeBack(clamp(t / 0.3, 0, 1)) * (1 + Math.sin(t * 10) * 0.04) * (1 - clamp((t - 2.2) / 0.6, 0, 1));
      v.data.b1.scale.set(Math.max(0.001, s), 1, Math.max(0.001, s)); v.data.b2.scale.set(Math.max(0.001, s), 1, Math.max(0.001, s));
      if (v.once('r', 0.05)) { v.ring(0.5, 4.5, 0.6, '#ffd23a', 0.1, false, 0.3); v.flash(2, 7, '#fff3a0', 0.4); fxEmit('levelup', new T.Vector3(v.x, v.y, v.z)); }
      if (t < 2.2) { v.data.acc = (v.data.acc || 0) + dt * 70 * v.sys.mul; while (v.data.acc >= 1) { v.data.acc--; var a = R() * TAU, r = Math.sqrt(R()) * 2.1; v.p({ x: Math.cos(a) * r, y: rr(0, 2), z: Math.sin(a) * r, vy: rr(6, 12), life: rr(0.9, 1.3), size: rr(0.4, 0.7), size1: 0.1, color: pick(['#ffe14a', '#ffffff', '#ffd27a']), frame: R() < 0.7 ? FR.sparkle : FR.coin, add: true, tw: 1 }); } }
    } },
    dragon_flyby: { dur: 3.4, thumbT: 1.55, frame: { cy: 6.5, h: 16 }, start: function (v) {
      var obj = null, DM = SE.DragonModels;
      if (DM && typeof DM.create === 'function' && v.inGame && SE.Assets && SE.Assets.has && SE.Assets.has('dragon.aurora.adult')) {
        try { var rig = DM.create('aurora', {}); if (rig && rig.group) { if (rig.setState) rig.setState('fly'); obj = rig.group; obj.scale.setScalar(0.5); v.data.rig = rig; } } catch (e) { obj = null; }
      }
      if (!obj) { obj = blockDragon('#f6f1e3', '#ffd24a', '#2a3f9a'); obj.scale.setScalar(0.9); }
      v.data.d = v.mesh(obj);
      obj.traverse(function (n) { n.castShadow = !!v.inGame; });
    }, tick: function (v, dt, t) {
      var d = v.data.d, k = clamp(t / 3.0, 0, 1);
      var x = lerp(-26, 26, k), y = (v.inGame ? 10.5 : 7.2) + Math.sin(k * PI) * 2.5, z = lerp(-8, 6, k);
      d.position.set(x, y, z);
      d.rotation.set(-Math.cos(k * PI) * 0.12, Math.atan2(52, 14), Math.sin(t * 2) * 0.12);
      if (d.userData.flap) d.userData.flap(t);
      if (v.data.rig && v.data.rig.update) v.data.rig.update(dt, 20);
      if (t < 3.0) { v.p({ x: x + J(1.5), y: y + J(0.8), z: z + J(1.5), vy: -2, life: rr(0.8, 1.4), size: rr(0.4, 0.8), size1: 0.05, color: pick(['#ffe14a', '#ffffff', '#8fb8ff']), frame: R() < 0.6 ? FR.sparkle : FR.star, add: true, tw: 1, grav: 3 }); }
      if (v.once('roar', 1.2)) sfx('roar_small', { volume: 0.6 });
      if (v.once('dust', 1.5)) v.burst(30, function () { return { x: J(4), y: rr(8, 11), z: J(3), vx: J(1), vy: -rr(1, 3), vz: J(1), life: rr(1.4, 1.8), size: rr(0.4, 0.6), size1: 0.3, color: pick(['#ffe14a', '#ffffff']), frame: FR.sparkle, add: true, grav: 2, tw: 1 }; });
    } },
    aurora: { dur: 4.0, thumbT: 1.6, frame: { cy: 6.5, h: 15 }, start: function (v) {
      v.data.c = [];
      for (var i = 0; i < 3; i++) {
        var geo = new T.PlaneGeometry(22, 6, 30, 4), pos = geo.attributes.position, arr = new Float32Array(pos.count * 4);
        var top = col(i === 1 ? '#c86aff' : '#7a6aff'), bot = col(i === 1 ? '#5cffb0' : '#4fffd0');
        for (var k = 0; k < pos.count; k++) {
          var yy = (pos.getY(k) + 3) / 6, c = bot.clone().lerp(top, yy), ex = Math.abs(pos.getX(k)) / 11;
          arr[k * 4] = c.r; arr[k * 4 + 1] = c.g; arr[k * 4 + 2] = c.b; arr[k * 4 + 3] = Math.sin(yy * PI) * (1 - ex * ex) * 0.75;
        }
        geo.setAttribute('color', new T.BufferAttribute(arr, 4));
        var m = v.mesh(new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide })));
        m.position.set(0, 9.5 + i * 1.2, -4 - i * 2.5);
        v.data.c.push({ m: m, base: geo.attributes.position.array.slice(), ph: i * 1.7 });
      }
    }, tick: function (v, dt, t) {
      var fade = Math.min(1, t / 0.6) * (1 - clamp((t - 3.3) / 0.7, 0, 1));
      v.data.c.forEach(function (c) {
        c.m.material.opacity = fade;
        var a = c.m.geometry.attributes.position, b = c.base;
        for (var k = 0; k < a.count; k++) a.array[k * 3 + 2] = b[k * 3 + 2] + Math.sin(b[k * 3] * 0.35 + t * 1.6 + c.ph) * 1.4;
        a.needsUpdate = true;
      });
      if (t < 3.4 && R() < 0.6) v.p({ x: J(10), y: rr(7, 14), z: rr(-9, -2), life: rr(0.8, 1.4), size: rr(0.3, 0.6), size1: 0.1, color: '#ffffff', frame: FR.sparkle, add: true, tw: 1 });
    } },
    egg_hatch: { dur: 3.6, thumbT: 1.6, frame: { cy: 3.6, h: 9.5 }, start: function (v) {
      var c = cvs(128, 128), g = c.getContext('2d');
      g.fillStyle = '#ffd24a'; g.fillRect(0, 0, 128, 128);
      for (var i = 0; i < 14; i++) { g.fillStyle = i % 2 ? '#ff9a2e' : '#fff3b0'; g.beginPath(); g.arc((i * 37) % 128, (i * 53) % 128, 8 + (i % 3) * 4, 0, TAU); g.fill(); }
      var egg = v.mesh(new T.Mesh(new T.SphereGeometry(1.5, 20, 16), new T.MeshStandardMaterial({ map: tex(c), roughness: 0.4, metalness: 0.2, emissive: new T.Color('#5a3a00'), emissiveIntensity: 0.3 })));
      egg.scale.set(0.001, 0.001, 0.001); egg.position.set(3.2, 1.9, 0.8);
      v.data.egg = egg;
    }, tick: function (v, dt, t) {
      var egg = v.data.egg;
      if (t < 1.35) {
        var k = clamp(t / 0.35, 0, 1), s = Math.max(0.001, easeBack(k));
        egg.scale.set(s, s * 1.3, s);
        egg.rotation.z = Math.sin(t * 22) * 0.18 * clamp((t - 0.4) / 0.9, 0, 1);
      }
      if (v.once('crack', 1.35)) {
        egg.visible = false; sfx('hatch');
        v.flash(1.9, 7, '#fff3a0', 0.4); v.ring(0.4, 4, 0.6, '#ffd23a', 0.1, false, 0.3);
        v.data.sh = [];
        for (var i = 0; i < 12; i++) {
          var sh = v.mesh(bx(rr(0.4, 0.7), rr(0.4, 0.7), 0.12, i % 2 ? '#ffd24a' : '#fff3b0'));
          sh.position.set(3.2, 1.9, 0.8);
          v.data.sh.push({ m: sh, vx: J(5), vy: rr(4, 8), vz: J(5), r: J(8) });
        }
        var baby = null, DM = SE.DragonModels;
        if (DM && DM.create && v.inGame && SE.Assets && SE.Assets.has && SE.Assets.has('dragon.meadow.baby')) {
          try { var rig = DM.create(pick(['meadow', 'frost', 'ember', 'aurora']), { baby: true }); if (rig && rig.group) { rig.setState && rig.setState('happy'); baby = rig.group; v.data.rig = rig; } } catch (e) { baby = null; }
        }
        if (!baby) { baby = HATS.baby_dragon()[0]; baby.scale.setScalar(2.4); }
        baby.position.set(3.2, 0, 0.8); baby.rotation.y = -0.6;
        v.data.baby = v.mesh(baby);
        v.burst(40, function () { return { x: 3.2, y: 2, z: 0.8, vx: J(5), vy: rr(3, 8), vz: J(5), life: rr(1, 1.5), size: rr(0.4, 0.6), size1: 0.4, color: pick(BRIGHT), frame: FR.confetti, spin: J(10), grav: 8, floor: 0.05 }; });
      }
      if (v.data.sh) v.data.sh.forEach(function (s) { s.vy -= 16 * dt; s.m.position.x += s.vx * dt; s.m.position.y = Math.max(0.1, s.m.position.y + s.vy * dt); s.m.position.z += s.vz * dt; s.m.rotation.x += s.r * dt; s.m.rotation.y += s.r * dt; if (s.m.position.y <= 0.1) { s.vx *= 0.8; s.vz *= 0.8; s.r *= 0.8; } });
      if (v.data.baby) {
        var b = v.data.baby, k2 = t - 1.35, sc = (v.data.rig ? 1 : 2.4) * Math.max(0.001, easeBack(clamp(k2 / 0.35, 0, 1))) * (1 - clamp((t - 3.1) / 0.5, 0, 1));
        b.scale.setScalar(Math.max(0.001, sc)); b.position.y = Math.abs(Math.sin(k2 * 7)) * 0.8;
        if (v.data.rig && v.data.rig.update) v.data.rig.update(dt, 0);
        b.traverse(function (n) { if (n.userData.anim) n.userData.anim(n, dt, { time: t, moving: false, grounded: true }, t); });
        if (R() < 0.4) v.p({ x: 3.2 + J(1.4), y: rr(0.5, 3), z: 0.8 + J(1.4), life: 0.6, size: 0.6, size1: 0, color: '#fff3a0', frame: FR.sparkle, add: true });
      }
    } }
  };
  function fxEmit(name, pos) {
    var F = SE.FX;
    if (!F || typeof F.emit !== 'function' || !pos) return;
    var known = F.recipes ? (Array.isArray(F.recipes) ? F.recipes.indexOf(name) >= 0 : !!F.recipes[name]) : (typeof F.has === 'function' ? F.has(name) : false);
    if (!known) return;
    try { F.emit(name, pos, {}); } catch (e) { /* optional */ }
  }

  /* ---------------------------------------------------------------------- */
  /* Build & apply                                                            */
  /* ---------------------------------------------------------------------- */
  var SLOTS = ['outfit', 'hat', 'back', 'trail', 'victory'];
  var OUTFIT_CACHE = {};
  var Q = { mul: 1 };
  function buildKey(it) { return it && it.build ? (it.build.style || it.build.fx || null) : null; }
  function outfitStyle(id) {
    var s = buildKey(itemOf(id));
    if (!s && id) s = String(id).replace(/^outfit_/, '');
    return OUTFITS[s] ? s : 'classic';
  }
  function buildOutfit(model, id) {
    var style = outfitStyle(id), skin = model.look.skin;
    var p = new Painter(skin);
    var parts = OUTFITS[style](p) || [];
    var key = style + '|' + skin, cached = OUTFIT_CACHE[key];
    if (!cached) { p.finish(); cached = OUTFIT_CACHE[key] = { mats: p.materials(), shoe: p.shoe, sole: p.sole }; }
    model.setOutfit(cached.mats);
    model.setShoes(cached.shoe, cached.sole);
    return parts;
  }
  function hatStyle(id) { var s = buildKey(itemOf(id)); if (!s && id) s = String(id).replace(/^hat_/, ''); return HATS[s] ? s : null; }
  function buildHat(id) {
    var s = hatStyle(id);
    if (!s) return null;
    var r = HATS[s]();
    return { parts: [{ a: 'hat', o: r[0] }], hair: r[1], lift: r[2] };
  }
  function buildBack(id) {
    var it = itemOf(id), b = (it && it.build) || { style: String(id || '').replace(/^back_/, '') };
    var fn = BACKS[b.style];
    return fn ? fn(b) : [];
  }
  function cosState(model) {
    return model._cos || (model._cos = { ids: {}, nodes: { outfit: [], hat: [], back: [] }, anims: {}, lift: 0, trail: null, victory: null, skin: null });
  }
  function detach(model, slot) {
    var st = cosState(model);
    st.nodes[slot].forEach(function (o) { if (o.parent) o.parent.remove(o); disposeTree(o); });
    st.nodes[slot] = [];
    var fn = st.anims[slot];
    if (fn) { var i = model.anims.indexOf(fn); if (i >= 0) model.anims.splice(i, 1); st.anims[slot] = null; }
  }
  function attach(model, slot, parts) {
    var st = cosState(model), lives = [];
    var anchors = st.skinObj ? st.skinObj.anchors : model.anchors;
    (parts || []).forEach(function (p) {
      var anc = anchors && anchors[p.a];
      if (!anc && p.o) disposeTree(p.o);
      if (!anc || !p.o) return;
      if (!p.o.userData.live) bake(p.o);
      anc.add(p.o);
      st.nodes[slot].push(p.o);
      p.o.traverse(function (n) { if (n.userData.anim) lives.push(n); });
    });
    if (lives.length) {
      var fn = function (dt, m) { for (var i = 0; i < lives.length; i++) lives[i].userData.anim(lives[i], dt, m, m.time); };
      st.anims[slot] = fn;
      model.anims.push(fn);
    }
  }
  function adjustCarry(model, lift) {
    var a = model.group && model.group.getObjectByName('carry_anchor');
    if (!a) return;
    if (model._carryBase === undefined) model._carryBase = a.position.y;
    var sk = model._cos && model._cos.skinObj;
    if (sk && sk.carryY) a.position.y = sk.carryY + (sk.anchors.hat ? Math.max(0, lift - 0.4) : 0);
    else a.position.y = Math.max(model._carryBase, model.headTop + lift + 0.2);
  }
  function stateEquipped() {
    var d = SE.State && SE.State.data;
    return d && d.cosmetics && d.cosmetics.equipped ? d.cosmetics.equipped : null;
  }
  function equippedId(slot, model) {
    var eq = stateEquipped();
    if (eq && slot in eq) return eq[slot] || null;
    return model && model._cos ? model._cos[slot] : null;
  }
  function validFor(id, slot) {
    if (!id || typeof id !== 'string') return null;
    var C = CD(), it = itemOf(id);
    if (C && !it) return null;
    if (it && it.tab !== slot) return null;
    return id;
  }
  function apply(model, equipped) {
    if (!model || !model.anchors || typeof model.setOutfit !== 'function') return false;
    equipped = equipped || {};
    var st = cosState(model), C = CD();
    var def = (C && C.DEFAULT_OUTFIT) || 'outfit_classic';
    var o = validFor(equipped.outfit, 'outfit') || def;
    st.lastEq = {};
    SLOTS.forEach(function (k) { st.lastEq[k] = equipped[k] || null; });
    st.wantSkin = null;
    if (skinDef(o) && skinStatus(o) !== 'ready') {
      /* model not loaded yet: keep the blocky look, re-apply when the GLB arrives */
      var want = st.wantSkin = o;
      ensureSkin(o).then(function (ok) { if (ok && st.wantSkin === want && !st.disposed) apply(model, st.lastEq); });
      o = st.ids.outfit && !skinDef(st.ids.outfit) ? st.ids.outfit : (st.prevOutfit || def);
    }
    if (st.ids.outfit !== o || st.skin !== model.look.skin) {
      var hadSkin = !!st.skinObj;
      detach(model, 'outfit');
      st.skinObj = null;
      if (skinDef(o)) {
        var sk = buildSkinOn(model, o);
        if (sk) {
          st.skinObj = sk;
          st.nodes.outfit.push(sk.root);
          st.anims.outfit = sk.anim;
          model.anims.push(sk.anim);
          setBaseVisible(model, false);
        }
      } else {
        if (hadSkin) setBaseVisible(model, true);
        attach(model, 'outfit', buildOutfit(model, o));
        st.prevOutfit = o;
      }
      if (hadSkin || st.skinObj) { st.ids.hat = st.ids.back = '#'; }
      st.ids.outfit = o; st.skin = model.look.skin;
    }
    var h = validFor(equipped.hat, 'hat');
    if (st.ids.hat !== h) {
      detach(model, 'hat');
      st.ids.hat = h; st.lift = 0;
      var hb = h ? buildHat(h) : null;
      if (hb) { attach(model, 'hat', hb.parts); st.hair = hb.hair; st.lift = hb.lift; } else st.hair = 'keep';
      if (!st.skinObj) model.setHairMode(st.hair);
    }
    var b = validFor(equipped.back, 'back');
    if (st.ids.back !== b) {
      detach(model, 'back');
      st.ids.back = b;
      if (b) attach(model, 'back', buildBack(b));
    }
    st.trail = validFor(equipped.trail, 'trail');
    st.victory = validFor(equipped.victory, 'victory');
    adjustCarry(model, st.lift);
    model.height = st.skinObj ? st.skinObj.height + (st.skinObj.anchors.hat ? st.lift * 0.8 : 0) : model.headTop + 0.35 + st.lift;
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Mythic skins                                                             */
  /* ---------------------------------------------------------------------- */
  var SKINS = {};
  function skinDef(id) { var it = itemOf(id); return it && it.skin && it.build && it.build.key ? it : null; }
  function skinStatus(id) {
    var it = skinDef(id), A = SE.Assets;
    if (!it) return 'none';
    if (A && typeof A.has === 'function' && A.has(it.build.key)) return 'ready';
    return SKINS[id] ? SKINS[id].status : 'idle';
  }
  function ensureSkin(id) {
    var it = skinDef(id), A = SE.Assets;
    if (!it || !A || typeof A.load !== 'function' || typeof A.add !== 'function') return Promise.resolve(false);
    var key = it.build.key;
    if (A.has(key)) return Promise.resolve(true);
    var s = SKINS[id];
    if (s && (s.status === 'loading' || (s.status === 'missing' && Date.now() - s.at < 20000))) return s.promise;
    s = SKINS[id] = { status: 'loading', at: Date.now() };
    try { A.add(key, it.build.url, { optional: true }); } catch (e) { /* ignore */ }
    s.promise = Promise.resolve().then(function () { return A.load(key, { force: true }); })
      .then(function () { return A.has(key); }, function () { return false; })
      .then(function (ok) { s.status = ok ? 'ready' : 'missing'; s.at = Date.now(); return ok; });
    return s.promise;
  }
  function setBaseVisible(model, on) {
    var p = model.parts || {};
    ['torso', 'head', 'armL', 'armR', 'legL', 'legR', 'shoeL', 'shoeR'].forEach(function (k) { if (p[k]) p[k].visible = on; });
    if (on) model.setHairMode((model._cos && model._cos.hair) || 'keep');
    else { if (p.hairTop) p.hairTop.visible = false; if (p.hairSide) p.hairSide.visible = false; }
  }
  var _sq = new T.Quaternion(), _se = new T.Euler(), _sv = new T.Vector3();
  function buildSkinOn(model, id) {
    var it = skinDef(id), A = SE.Assets;
    if (!it || !A || !A.has(it.build.key)) return null;
    var root = A.get(it.build.key);
    root.traverse(function (n) {
      if (n.geometry) n.geometry.userData.shared = true;
      if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach(function (m) { m.userData.shared = true; });
    });
    var sk = { id: id, root: root, nodes: {}, rest: {}, anchors: {}, map: [], height: 7, carryY: 0 };
    ['body', 'head', 'arm_L', 'arm_R', 'leg_L', 'leg_R', 'tail', 'spin', 'carry', 'hat', 'back', 'hand_R', 'eye_L', 'eye_R', 'pupil_L', 'pupil_R'].forEach(function (n) {
      var o = A.getPart(root, n);
      if (o) { sk.nodes[n] = o; sk.rest[n] = o.quaternion.clone(); }
    });
    /* skins with separate pupil nodes get look-around + blink (SE.Models.makeEyeAnim) */
    if ((sk.nodes.pupil_L || sk.nodes.pupil_R) && SE.Models.makeEyeAnim) {
      sk.eyeAnim = SE.Models.makeEyeAnim();
      ['pupil_L', 'pupil_R'].forEach(function (n) { if (sk.nodes[n]) sk.nodes[n].userData.rest = sk.nodes[n].position.clone(); });
    }
    root.updateMatrixWorld(true);
    var box = new T.Box3().setFromObject(root), hgt = box.max.y - Math.min(0, box.min.y);
    if (hgt > 0.5 && (hgt < 5 || hgt > 9.5)) { root.scale.multiplyScalar(7 / hgt); root.updateMatrixWorld(true); box.setFromObject(root); }
    sk.height = Math.max(4, box.max.y);
    function xOf(n) { var o = sk.nodes[n]; if (!o) return 0; o.getWorldPosition(_sv); return _sv.x; }
    [['arm_L', 'arm_R', 'armL', 'armR'], ['leg_L', 'leg_R', 'legL', 'legR']].forEach(function (pr) {
      var aPlus = xOf(pr[0]) >= xOf(pr[1]);   // the node at +x follows the model's +x limb (armR / legR)
      if (sk.nodes[pr[0]]) sk.map.push([sk.nodes[pr[0]], sk.rest[pr[0]], aPlus ? pr[3] : pr[2]]);
      if (sk.nodes[pr[1]]) sk.map.push([sk.nodes[pr[1]], sk.rest[pr[1]], aPlus ? pr[2] : pr[3]]);
    });
    if (sk.nodes.head) sk.map.push([sk.nodes.head, sk.rest.head, 'head']);
    if (sk.nodes.carry) { sk.nodes.carry.getWorldPosition(_sv); sk.carryY = _sv.y; }
    else sk.carryY = sk.height + 0.6;
    sk.anchors = { hat: sk.nodes.hat || null, back: sk.nodes.back || null };
    /* per-skin arm pose (data build.pose): the carry / celebrate / walk arm rotations of the blocky character are
       scaled by a smoothed factor, plus an optional wing flap (z) while celebrating or carrying */
    var pose = it.build.pose || null;
    sk.armK = 1;
    sk.anim = function (dt, m) {
      var want = 1, flap = 0;
      if (pose) {
        want = m.carry ? pose.carry : (m.celebrateT > 0 ? pose.celebrate : (pose.walk !== undefined ? pose.walk : 1));
        if (pose.flap && (m.carry || m.celebrateT > 0)) flap = Math.sin(m.time * (m.carry ? 6 : 15)) * pose.flap;
        sk.armK += (want - sk.armK) * (1 - Math.exp(-10 * Math.min(dt, 0.1)));
      }
      for (var i = 0; i < sk.map.length; i++) {
        var e = sk.map[i], src = m[e[2]];
        if (!src) continue;
        if (pose && (e[2] === 'armL' || e[2] === 'armR')) {
          var sg = e[2] === 'armL' ? 1 : -1;
          _se.set(src.rotation.x * sk.armK, src.rotation.y, src.rotation.z * sk.armK + sg * flap, src.rotation.order);
          e[0].quaternion.copy(e[1]).multiply(_sq.setFromEuler(_se));
        } else e[0].quaternion.copy(e[1]).multiply(_sq.setFromEuler(src.rotation));
      }
      if (sk.nodes.tail) sk.nodes.tail.quaternion.copy(sk.rest.tail).multiply(_sq.setFromEuler(_se.set(0, Math.sin(m.time * (m.moving ? 9 : 2.2)) * (m.moving ? 0.35 : 0.15), 0)));
      if (sk.nodes.spin) sk.nodes.spin.rotateZ(dt * (m.moving ? 22 : 9));
      if (sk.eyeAnim) {
        var ea = sk.eyeAnim.update(dt, m.moving);
        ['pupil_L', 'pupil_R'].forEach(function (n) { var o = sk.nodes[n]; if (o) { o.position.x = o.userData.rest.x + ea.x * 0.13; o.position.y = o.userData.rest.y + ea.y * 0.13; } });
        ['eye_L', 'eye_R'].forEach(function (n) { if (sk.nodes[n]) sk.nodes[n].scale.y = ea.blink; });
      }
    };
    model.body.add(root);
    return sk;
  }
  /* skin thumbnails: the render icon if it exists, else a render of the GLB, else a "soon" card */
  var PLACEHOLDERS = {};
  function loadImage(url) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () { res(img.naturalWidth ? img : null); };
      img.onerror = function () { res(null); };
      img.src = ROOT + url;
    });
  }
  function skinIcon(it) {
    var list = (it.build.icons || []).slice();
    function next() { if (!list.length) return Promise.resolve(null); return loadImage(list.shift()).then(function (img) { return img || next(); }); }
    if (!it.build._icon) it.build._icon = next();
    return it.build._icon;
  }
  function imageThumb(img, size) {
    var c = cvs(size, size), g = c.getContext('2d'), k = Math.min(size / img.naturalWidth, size / img.naturalHeight);
    var w = img.naturalWidth * k, h = img.naturalHeight * k;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return c.toDataURL('image/png');
  }
  function placeholderThumb(id, size, loading) {
    var c = cvs(size, size), g = c.getContext('2d'), s = size / 128;
    g.scale(s, s);
    var gr = g.createRadialGradient(64, 58, 6, 64, 64, 60);
    gr.addColorStop(0, '#ffd0f0'); gr.addColorStop(0.6, '#ff6ac8'); gr.addColorStop(1, 'rgba(160,40,200,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(64, 62, 58, 0, TAU); g.fill();
    g.fillStyle = 'rgba(60,20,90,0.55)';
    g.beginPath(); g.ellipse(64, 46, 17, 19, 0, 0, TAU); g.fill();
    g.beginPath(); g.moveTo(38, 104); g.quadraticCurveTo(40, 66, 64, 66); g.quadraticCurveTo(88, 66, 90, 104); g.closePath(); g.fill();
    g.font = '900 34px Nunito, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = '#2a1407'; g.strokeText('?', 64, 47); g.fillStyle = '#fff'; g.fillText('?', 64, 47);
    var txt = loading ? tt('cos.skinLoading', 'Loading…') : tt('cos.skinSoon', 'Soon!');
    g.font = '900 ' + (txt.length > 9 ? 13 : 16) + 'px Nunito, Arial Black, sans-serif';
    g.lineWidth = 5; g.strokeText(txt, 64, 114); g.fillStyle = '#ffe14a'; g.fillText(txt, 64, 114);
    var url = c.toDataURL('image/png');
    PLACEHOLDERS[url] = true;
    return url;
  }
  function skinPlaceholderObject(loading) {
    var g = new T.Group();
    var gem = oct(1.3, '#ff6ac8', { std: true, rough: 0.15, metal: 0.2, emissive: '#c0208a', ei: 0.45 });
    gem.scale.set(1, 1.5, 1); gem.position.y = 3.6; g.add(gem);
    var c = cvs(320, 96), x = c.getContext('2d'), t = tex(c);
    var spr = new T.Sprite(new T.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
    spr.scale.set(4.2, 1.26, 1); spr.position.y = 6.2; spr.renderOrder = 20; g.add(spr);
    g.userData.spin = gem;
    g.userData.setLoading = function (on) {
      if (g.userData.loading === on) return;
      g.userData.loading = on;
      var txt = on ? tt('cos.skinLoading', 'Loading…') : tt('cos.skinSoon', 'Soon!');
      x.clearRect(0, 0, 320, 96);
      x.font = '900 ' + (txt.length > 10 ? 38 : 46) + 'px Nunito, Arial Black, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.lineWidth = 10; x.strokeStyle = '#2a1407'; x.strokeText(txt, 160, 48); x.fillStyle = '#ffe14a'; x.fillText(txt, 160, 48);
      t.needsUpdate = true;
    };
    g.userData.setLoading(!!loading);
    return g;
  }

  /* ---------------------------------------------------------------------- */
  /* In-game trails & victories                                               */
  /* ---------------------------------------------------------------------- */
  var GAME = { sys: null, ribbon: null, ribbonKey: null, ribbonHead: null, decals: null, container: null, acc: 0, dist: 0, side: 1, last: null, vic: [], external: false };
  function ensureGame(container) {
    if (!container) return false;
    if (!GAME.sys) {
      var m = isMobile();
      /* soft: normal blending — additive glow washes out to white on the bright studded ground and sky */
      GAME.sys = new PSys(container, m ? { add: 260, norm: 220, soft: true } : { add: 560, norm: 440, soft: true });
      GAME.sys.mul = Q.mul;
      GAME.sys.sizeMul = 1.45;           /* read at the third-person camera distance (≈ 28 u) */
      GAME.decals = new Decals(container, 40);
    } else if (GAME.container !== container) {
      GAME.sys.container = null; GAME.sys.setContainer(container);
      GAME.decals.container = null; GAME.decals.setContainer(container);
      if (GAME.ribbon) { GAME.ribbon.container = null; GAME.ribbon.setContainer(container); }
    }
    GAME.container = container;
    return true;
  }
  function stepGame(dt) {
    if (!GAME.sys) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    GAME.sys.update(dt);
    if (GAME.ribbon) { GAME.ribbon.update(dt, GAME.ribbonHead, 0, 0); GAME.ribbonHead = null; }
    GAME.decals.update(dt);
    for (var i = 0; i < GAME.vic.length; i++) {
      var v = GAME.vic[i];
      try { v.update(dt); } catch (e) { console.error('[Cosmetics] victory failed', e); v.finish(); }
      if (v.done) GAME.vic.splice(i--, 1);
    }
  }
  function fxHas(name) {
    var F = SE.FX;
    if (!F || typeof F.emit !== 'function') return false;
    if (F.recipes) return Array.isArray(F.recipes) ? F.recipes.indexOf(name) >= 0 : !!F.recipes[name];
    return typeof F.has === 'function' ? !!F.has(name) : false;
  }
  var _hv = null;
  function updateTrail(dt, player) {
    if (!player) return;
    var grp = player.group || (player.model && player.model.group);
    var container = player.scene || (grp && grp.parent);
    if (!container || !ensureGame(container)) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    var id = equippedId('trail', player.model), it = itemOf(id);
    var fxName = it && it.build ? it.build.fx : null, def = fxName ? TRAILS[fxName] : null;
    var pos = player.pos || (grp && grp.position);
    var moving = !!player.moving && (player.speed === undefined || player.speed > 0.5) && !player.invisible;
    if (def && pos) {
      var yaw = grp ? grp.rotation.y : 0, dx = Math.sin(yaw), dz = Math.cos(yaw);
      var c = { x: pos.x - dx * 0.7, y: pos.y || 0, z: pos.z - dz * 0.7, dx: dx, dz: dz, side: GAME.side, k: 1 };
      var viaFx = fxHas('trail_' + fxName);
      if (moving) {
        var k = clamp((player.speed || 16) / 16, 0.6, 1.6);
        if (def.rate) {
          GAME.acc += dt * def.rate * k * Q.mul;
          while (GAME.acc >= 1) {
            GAME.acc -= 1;
            if (viaFx) { try { SE.FX.emit('trail_' + fxName, new T.Vector3(c.x, c.y, c.z), { dir: new T.Vector3(dx, 0, dz) }); } catch (e) { viaFx = false; } }
            else def.emit(GAME.sys, c);
          }
        }
        if (def.perDist && GAME.last) {
          GAME.dist += Math.hypot(pos.x - GAME.last.x, pos.z - GAME.last.z);
          if (GAME.dist >= def.perDist) { GAME.dist = 0; GAME.side = -GAME.side; c.side = GAME.side; def.emit(GAME.sys, c, GAME.decals); }
        }
      }
      if (def.ribbon) {
        if (!GAME.ribbon || GAME.ribbonKey !== fxName) {
          if (GAME.ribbon) GAME.ribbon.dispose();
          GAME.ribbon = new Ribbon(container, { colors: def.ribbon, width: 1.7, n: 28, life: 0.65 });
          GAME.ribbonKey = fxName;
        }
        _hv = _hv || new T.Vector3();
        GAME.ribbonHead = moving ? _hv.set(pos.x - dx * 0.6, (pos.y || 0) + 2.9, pos.z - dz * 0.6) : null;
      }
    }
    if (pos) { GAME.last = GAME.last || new T.Vector3(); GAME.last.set(pos.x, pos.y || 0, pos.z); }
    if (!GAME.external) stepGame(dt);
  }
  function update(dt) { GAME.external = true; stepGame(dt); }
  function playVictory(itemId, position, model) {
    if (itemId === undefined || itemId === null) itemId = equippedId('victory', model);
    var it = itemOf(itemId), name = it && it.build ? it.build.fx : null;
    var def = (name && VICTORY[name]) || VICTORY._default;
    var grp = model && model.group;
    var container = (grp && grp.parent) || (SE.Player && SE.Player.scene) || GAME.container;
    if (!container || !ensureGame(container)) return { stop: function () {}, duration: 0 };
    var pos = position || (grp && grp.position) || { x: 0, y: 0, z: 0 };
    var v = new V(GAME.sys, container, pos, model, true);
    v.def = def;
    try { if (def.start) def.start(v); } catch (e) { console.error('[Cosmetics] victory start failed', e); v.finish(); return { stop: function () {}, duration: 0 }; }
    GAME.vic.push(v);
    if (model && typeof model.celebrate === 'function') model.celebrate(2.0);
    return { stop: function () { v.finish(); }, duration: def.dur };
  }
  function clearEffects() {
    GAME.vic.forEach(function (v) { v.finish(); });
    GAME.vic.length = 0;
    if (GAME.sys) GAME.sys.clear();
    if (GAME.ribbon) { GAME.ribbon.pts.length = 0; GAME.ribbon.update(0, null); }
    if (GAME.decals) { GAME.decals.list.length = 0; GAME.decals.update(0); }
  }
  function setQuality(q) {
    Q.mul = q === 'low' ? 0.5 : q === 'medium' ? 0.75 : 1;
    if (GAME.sys) GAME.sys.mul = Q.mul;
  }
  if (isMobile()) Q.mul = 0.6;

  /* ---------------------------------------------------------------------- */
  /* Preview objects (shop stage, thumbnails)                                 */
  /* ---------------------------------------------------------------------- */
  function previewLook() {
    var pm = SE.Player && SE.Player.model && SE.Player.model.look;
    return pm ? { skin: pm.skin, hair: pm.hair, hairStyle: pm.hairStyle, face: pm.face } : { skin: '#ffd9b0', hair: '#7a4a1c', hairStyle: 'tousled', face: 'smile' };
  }
  function previewObject(itemId, equipped, opts) {
    opts = opts || {};
    var WIND = opts.thumb ? -6.5 : -10, RATE = opts.thumb ? 2.4 : 1.35;
    var it = itemOf(itemId), kind = it ? it.tab : 'outfit';
    var root = new T.Group();
    root.name = 'cos_preview';
    var model = Mo().makeCharacter(previewLook());
    root.add(model.group);
    var src = equipped || stateEquipped() || {}, eq = {};
    SLOTS.forEach(function (s) { eq[s] = src[s] || null; });
    if (it) eq[it.tab] = it.id;
    apply(model, eq);
    var sys = new PSys(root, { add: 360, norm: 320, soft: true, sizeMul: opts.thumb ? 1.9 : 1.35 });
    var fx = { acc: 0, dist: 0, side: 1, vic: null, timer: 0.5, ribbon: null, decals: null };
    var trailDef = kind === 'trail' && it && it.build ? TRAILS[it.build.fx] : null;
    var vicDef = kind === 'victory' ? ((it && it.build && VICTORY[it.build.fx]) || VICTORY._default) : null;
    if (trailDef) {
      sys.wz = WIND;
      if (trailDef.ribbon) fx.ribbon = new Ribbon(root, { colors: trailDef.ribbon, width: 1.7, n: 28, life: opts.thumb ? 1.2 : 0.75 });
      if (trailDef.perDist) fx.decals = new Decals(root, 24);
    }
    var head = new T.Vector3(0, 2.9, -0.6);
    var ph = null;
    if (it && it.skin && model._cos && model._cos.ids.outfit !== it.id) {
      ph = skinPlaceholderObject(skinStatus(it.id) === 'loading' || skinStatus(it.id) === 'idle');
      model.group.visible = false;
      root.add(ph);
    }
    root.userData = {
      kind: kind, itemId: itemId, model: model, sys: sys,
      height: vicDef ? clamp(vicDef.frame.h * 0.8, 7, 12) : model.height,
      update: function (dt) {
        dt = Math.min(Math.max(dt || 0, 0), 0.1);
        if (ph) {
          ph.userData.spin.rotation.y += dt * 1.4;
          var sst = skinStatus(it.id);
          ph.userData.setLoading(sst === 'loading' || sst === 'idle');
          if (model._cos && model._cos.ids.outfit === it.id) { root.remove(ph); disposeTree(ph); ph = null; model.group.visible = true; root.userData.height = model.height; }
        }
        if (trailDef) {
          model.update(dt, true, 1.3, true);
          var c = { x: 0, y: 0, z: -0.6, dx: 0, dz: 1, side: fx.side, k: 1 };
          if (trailDef.rate) { fx.acc += dt * trailDef.rate * RATE; while (fx.acc >= 1) { fx.acc -= 1; trailDef.emit(sys, c); } }
          if (trailDef.perDist) { fx.dist += dt * -WIND; if (fx.dist >= trailDef.perDist) { fx.dist = 0; fx.side = -fx.side; c.side = fx.side; trailDef.emit(sys, c, fx.decals); } }
          if (fx.ribbon) fx.ribbon.update(dt, head, 0, WIND);
          if (fx.decals) fx.decals.update(dt, 0, WIND);
        } else if (vicDef) {
          model.update(dt, false, 0, true);
          if (!fx.vic) {
            fx.timer -= dt;
            if (fx.timer <= 0) {
              fx.vic = new V(sys, root, { x: 0, y: 0, z: 0 }, model, false);
              fx.vic.def = vicDef;
              if (vicDef.start) vicDef.start(fx.vic);
              model.celebrate(1.8);
            }
          } else {
            fx.vic.update(dt);
            if (fx.vic.done) { fx.vic = null; fx.timer = 0.9; }
          }
        } else {
          model.update(dt, false, 0, true);
        }
        sys.update(dt);
      },
      dispose: function () {
        if (root.parent) root.parent.remove(root);
        if (model._cos) model._cos.disposed = true;
        if (ph) { disposeTree(ph); ph = null; }
        if (fx.vic) fx.vic.finish();
        sys.dispose();
        if (fx.ribbon) fx.ribbon.dispose();
        if (fx.decals) fx.decals.dispose();
        ['outfit', 'hat', 'back'].forEach(function (s) { detach(model, s); });
        model.dispose();
      }
    };
    return root;
  }
  function disposePreview(obj) {
    if (obj && obj.userData && typeof obj.userData.dispose === 'function') { try { obj.userData.dispose(); } catch (e) { /* ignore */ } }
  }

  /* ---------------------------------------------------------------------- */
  /* Thumbnails: one lazy offscreen renderer, serial queue, cached data URLs  */
  /* ---------------------------------------------------------------------- */
  var TH = { r: null, scene: null, cam: null, jobs: [], busy: false, cache: {}, lost: false, failed: false };
  function studioEnvironment(renderer, scene) {
    try {
      var pm = new T.PMREMGenerator(renderer), env = new T.Scene();
      var geo = new T.SphereGeometry(50, 16, 8), cols = [], pos = geo.attributes.position, c = new T.Color(), top = new T.Color('#bfe0ff'), mid = new T.Color('#fff2d8'), bot = new T.Color('#5a4630');
      for (var i = 0; i < pos.count; i++) { var y = pos.getY(i) / 50; if (y > 0) c.copy(mid).lerp(top, Math.min(1, y * 1.4)); else c.copy(mid).lerp(bot, Math.min(1, -y * 2)); cols.push(c.r * 0.8, c.g * 0.8, c.b * 0.8); }
      geo.setAttribute('color', new T.Float32BufferAttribute(cols, 3));
      var skyMat = new T.MeshBasicMaterial({ side: T.BackSide, vertexColors: true });
      env.add(new T.Mesh(geo, skyMat));
      scene.environment = pm.fromScene(env, 0.04).texture;
      pm.dispose(); geo.dispose(); skyMat.dispose();
    } catch (e) { /* environment is optional */ }
  }
  function studioLights(scene) {
    scene.add(new T.HemisphereLight('#e4f2ff', '#6b5a3e', 0.95));
    var key = new T.DirectionalLight('#fff1d6', 1.65); key.position.set(6, 12, 10); scene.add(key);
    var rim = new T.DirectionalLight('#9fd2ff', 1.05); rim.position.set(-8, 7, -9); scene.add(rim);
    var fill = new T.DirectionalLight('#ffd9a8', 0.4); fill.position.set(-6, 2, 8); scene.add(fill);
  }
  function thumbStage() {
    if (TH.r || TH.failed) return TH.r ? TH : null;
    try {
      var canvas = cvs(256, 256);
      var r = new T.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
      r.setPixelRatio(1); r.setClearColor(0x000000, 0);
      r.outputEncoding = T.sRGBEncoding; r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 1.08;
      canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); TH.lost = true; }, false);
      canvas.addEventListener('webglcontextrestored', function () { TH.lost = false; }, false);
      TH.r = r; TH.scene = new T.Scene(); TH.cam = new T.PerspectiveCamera(30, 1, 0.1, 500);
      studioLights(TH.scene); studioEnvironment(r, TH.scene);
      return TH;
    } catch (e) {
      TH.failed = true;
      console.warn('[Cosmetics] thumbnail renderer unavailable', e);
      return null;
    }
  }
  var _box = null, _v = null;
  function renderThumb(id, size) {
    var it = itemOf(id);
    if (!it) return null;
    var S = thumbStage();
    if (!S || TH.lost) return null;
    var eq = { outfit: 'outfit_classic' };
    eq[it.tab] = it.id;
    var obj = previewObject(id, eq, { thumb: true }), ud = obj.userData, model = ud.model;
    var steps = 4, yaw = 0.42, cy = 3.3, h = 7.3, tx = 0, tz = 0, pitch = 0.12;
    if (it.tab === 'trail') { steps = 54; yaw = -1.2; cy = 3.4; h = 9.4; tz = -1.4; pitch = 0.22; }
    if (it.skin && model._cos && model._cos.skinObj) { h = model.height * 1.12 + 0.3; cy = model.height * 0.5; }
    else if (it.tab === 'victory') { var vd = VICTORY[it.build && it.build.fx] || VICTORY._default; steps = Math.round((0.5 + vd.thumbT) * 30) + 1; yaw = -0.3; cy = vd.frame.cy; h = vd.frame.h; pitch = 0.1; }
    obj.rotation.y = it.tab === 'back' ? PI + 0.55 : -yaw;
    S.scene.add(obj);
    for (var i = 0; i < steps; i++) ud.update(1 / 30);
    obj.updateMatrixWorld(true);
    _box = _box || new T.Box3(); _v = _v || new T.Vector3();
    if (it.tab === 'hat' || it.tab === 'back') {
      _box.setFromObject(it.tab === 'hat' ? model.head : model.torsoGroup);
      if (it.tab === 'back') { _box.expandByObject(model.armL); _box.expandByObject(model.armR); _box.expandByObject(model.head); }
      var sz = _box.getSize(new T.Vector3()), ctr = _box.getCenter(new T.Vector3());
      cy = ctr.y; tx = ctr.x; tz = ctr.z;
      h = Math.max(sz.y, Math.max(sz.x, sz.z) * 1.02) * (it.tab === 'hat' ? 1.16 : 1.08) + 0.3;
      if (it.tab === 'hat') h = Math.max(h, 2.6);
      pitch = it.tab === 'hat' ? 0.22 : 0.15;
    } else if (it.tab === 'trail') {
      _v.set(0, 0, tz).applyAxisAngle(new T.Vector3(0, 1, 0), obj.rotation.y); tx = _v.x; tz = _v.z;
    }
    var cam = S.cam, dist = (h / 2) / Math.tan(15 * PI / 180);
    cam.aspect = 1; cam.updateProjectionMatrix();
    cam.position.set(tx, cy + Math.sin(pitch) * dist, tz + Math.cos(pitch) * dist);
    cam.lookAt(tx, cy, tz);
    S.r.setSize(size, size, false);
    S.r.render(S.scene, cam);
    var url = null;
    try { url = S.r.domElement.toDataURL('image/png'); } catch (e) { url = null; }
    S.scene.remove(obj);
    ud.dispose();
    return url;
  }
  function pumpThumbs() {
    if (TH.busy || !TH.jobs.length) return;
    TH.busy = true;
    setTimeout(function () {
      var job = TH.jobs.shift(), url = null;
      try { url = renderThumb(job.id, job.size); } catch (e) { console.warn('[Cosmetics] thumbnail failed', job.id, e); url = null; }
      if (!url) delete TH.cache[job.key];
      job.res(url);
      TH.busy = false;
      pumpThumbs();
    }, 0);
  }
  function thumbnail(itemId, size) {
    size = clamp(Math.round(size || 128), 32, 512);
    var key = itemId + '@' + size;
    if (TH.cache[key]) return TH.cache[key];
    if (!itemOf(itemId)) return Promise.resolve(null);
    var sd = skinDef(itemId);
    if (sd) {
      var sp = TH.cache[key] = skinIcon(sd).then(function (img) {
        if (img) return imageThumb(img, size);
        return ensureSkin(itemId).then(function (ok) {
          if (ok) return new Promise(function (res) { TH.jobs.push({ id: itemId, size: size, key: key, res: res }); pumpThumbs(); });
          delete TH.cache[key];
          return placeholderThumb(itemId, size, false);
        });
      });
      return sp;
    }
    var p = new Promise(function (res) { TH.jobs.push({ id: itemId, size: size, key: key, res: res }); });
    TH.cache[key] = p;
    pumpThumbs();
    return p;
  }

  /* ---------------------------------------------------------------------- */
  /* Random looks for bots                                                    */
  /* ---------------------------------------------------------------------- */
  function randomLook(seed) {
    var r = rng(typeof seed === 'number' ? (seed * 2654435761) >>> 0 : hashStr(seed));
    function pk(a) { return a[(r() * a.length) | 0]; }
    var skins = ['#ffd9b0', '#f2c08f', '#d99a66', '#a8693f', '#7a4a2a', '#ffe3c4', '#e8b88a'];
    var hairs = ['#2b1d14', '#5a3214', '#8a5a2b', '#c98a3a', '#e8c66a', '#1c1c1c', '#b03a2a', '#7a4ab8', '#3a6ad8'];
    var C = CD(), eq = { outfit: 'outfit_classic', hat: null, back: null, trail: null, victory: null };
    if (C && typeof C.shopItems === 'function') {
      var outs = C.shopItems('outfit').filter(function (it) { return it.rarity !== 'legendary'; });
      if (outs.length) eq.outfit = pk(outs).id;
      var hats = C.shopItems('hat'), backs = C.shopItems('back');
      if (hats.length && r() < 0.65) eq.hat = pk(hats).id;
      if (backs.length && r() < 0.35) eq.back = pk(backs).id;
    }
    return { skin: pk(skins), hair: pk(hairs), hairStyle: pk(['tousled', 'spiky', 'bob', 'ponytail', 'buzz', 'tousled']), face: pk(Mo().CHAR_FACES || ['smile']), equipped: eq };
  }
  function makeCharacter(look) {
    look = look || {};
    var m = Mo().makeCharacter(look);
    if (look.equipped) apply(m, look.equipped);
    return m;
  }

  SE.Cosmetics = {
    apply: apply,
    updateTrail: updateTrail,
    update: update,
    playVictory: playVictory,
    previewObject: previewObject,
    disposePreview: disposePreview,
    thumbnail: thumbnail,
    randomLook: randomLook,
    makeCharacter: makeCharacter,
    clearEffects: clearEffects,
    setQuality: setQuality,
    skinStatus: skinStatus,
    ensureSkin: ensureSkin,
    isPlaceholderThumb: function (url) { return !!PLACEHOLDERS[url]; },
    hatInfo: function (id) { var s = hatStyle(id); if (!s) return null; var r = HATS[s](); disposeTree(r[0]); return { hair: r[1], lift: r[2] }; },
    FX_NAMES: Object.keys(TRAILS),
    VICTORY_NAMES: Object.keys(VICTORY).filter(function (k) { return k !== '_default'; }),
    STYLES: { outfit: Object.keys(OUTFITS), hat: Object.keys(HATS), back: Object.keys(BACKS) },
    stats: function () { return { particles: GAME.sys ? GAME.sys.live() : 0, victories: GAME.vic.length, thumbsQueued: TH.jobs.length }; },
    _studioLights: studioLights,
    _studioEnvironment: studioEnvironment
  };
})(window);
