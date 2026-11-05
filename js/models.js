/* =========================================================================
   Steal a Dragon Egg — shared procedural models (SE.Models)

   Primitives: mat(color, opts), box(w,h,d,color,opts{studs,emissive,opacity,flat}),
     cyl, sph, cone, at(mesh,x,y,z), studTexture, studMat.
   Character:  makeCharacter(opts) -> model (see the block comment below; cosmetics
     attach to model.anchors and repaint the outfit through model.setOutfit).
     CHAR_UV / CHAR_DIMS / remapBoxUV / canvasTexture / shadeHex are shared with
     SE.Cosmetics (js/cosmetics.js).
   Props: makeLabel, makeSignPost, makeArrow, makeCoin, fenceRect, fenceSegment,
     makeStall, makeTreadmill, makeTrailStand, makeTree, makeBush, makeRock, makeCactus,
     makeCandyProp, makeIceCrystal, makeLavaRock, makeCloudProp, makeGate, makeEgg, makeNest.
   Legacy (old game, still used by the old bots/game code until it is replaced):
     makeGuard, GUARD_STYLES, makePet.
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var U = SE.U;
  var T = global.THREE;

  var matCache = {};
  var studCache = {};

  /* Square raised studs, with a small bevel on the upper/left edges. */
  function studTexture(base, dark, size, cells) {
    size = size || 256; cells = cells || 4;
    var canvas = U.canvas(size, size), ctx = canvas.getContext('2d');
    var step = size / cells;
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    for (var y = 0; y < cells; y++) {
      for (var x = 0; x < cells; x++) {
        var sx = x * step + step * 0.28, sy = y * step + step * 0.27;
        var sw = step * 0.42, bevel = Math.max(1, step * 0.07);
        ctx.fillStyle = dark || '#000000'; ctx.globalAlpha = 0.32;
        ctx.fillRect(sx + bevel, sy + bevel, sw, sw);
        ctx.fillStyle = base; ctx.globalAlpha = 1;
        ctx.fillRect(sx, sy, sw, sw);
        ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.24;
        ctx.fillRect(sx, sy, sw, bevel);
        ctx.fillRect(sx, sy, bevel, sw);
        ctx.fillStyle = dark || '#000000'; ctx.globalAlpha = 0.25;
        ctx.fillRect(sx + sw - bevel, sy + bevel, bevel, sw - bevel);
        ctx.fillRect(sx + bevel, sy + sw - bevel, sw - bevel, bevel);
      }
    }
    ctx.globalAlpha = 0.13; ctx.strokeStyle = dark || '#000000'; ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, size, size); ctx.globalAlpha = 1;
    return canvas;
  }

  function studMat(color, width, height, density) {
    density = density || 0.8;
    var key = color + ':' + width + ':' + height + ':' + density;
    if (studCache[key]) return studCache[key];
    var texture = new T.CanvasTexture(studTexture(color, '#182000', 128, 4));
    texture.wrapS = texture.wrapT = T.RepeatWrapping;
    texture.repeat.set(width / (4 * density), height / (4 * density));
    texture.anisotropy = 4;
    if (T.sRGBEncoding !== undefined) texture.encoding = T.sRGBEncoding;
    return studCache[key] = new T.MeshLambertMaterial({ map: texture });
  }

  function mat(color, opts) {
    opts = opts || {};
    var key = color + '|' + (opts.emissive || '') + '|' + (opts.opacity === undefined ? 1 : opts.opacity) + '|' + (opts.flat ? 1 : 0);
    if (matCache[key]) return matCache[key];
    var m = new T.MeshLambertMaterial({
      color: new T.Color(color),
      emissive: new T.Color(opts.emissive || '#000000'),
      transparent: opts.opacity !== undefined && opts.opacity < 1,
      opacity: opts.opacity === undefined ? 1 : opts.opacity,
      flatShading: !!opts.flat
    });
    matCache[key] = m;
    return m;
  }

  function box(w, h, d, color, opts) {
    var geometry = new T.BoxGeometry(w, h, d);
    var material = mat(color, opts);
    if (opts && opts.studs) {
      /* Scale UVs per face, keeping one material and one draw call per block. */
      material = studMat(color, 3.2, 3.2);
      var faceSizes = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
      var uv = geometry.attributes.uv;
      for (var face = 0; face < 6; face++) {
        for (var vertex = 0; vertex < 4; vertex++) {
          var index = face * 4 + vertex;
          uv.setXY(index, uv.getX(index) * faceSizes[face][0] / 3.2, uv.getY(index) * faceSizes[face][1] / 3.2);
        }
      }
    }
    var m = new T.Mesh(geometry, material);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  }

  function cyl(rt, rb, h, color, seg, opts) {
    var m = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg || 10), mat(color, opts));
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  function sph(r, color, opts, seg) {
    var m = new T.Mesh(new T.SphereGeometry(r, seg || 12, seg || 10), mat(color, opts));
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  function cone(r, h, color, seg, opts) {
    var m = new T.Mesh(new T.ConeGeometry(r, h, seg || 8), mat(color, opts));
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }

  function at(mesh, x, y, z) { mesh.position.set(x, y, z); return mesh; }

  /* =======================================================================
     Character — Roblox-like blocky avatar for the player, bots and NPCs,
     built to carry cosmetics (SE.Cosmetics paints the outfit textures and
     attaches hats / back items / armour pieces to the anchors below).

     makeCharacter(opts) -> model
       opts  { skin, hair, hairStyle:'tousled'|'spiky'|'bob'|'ponytail'|'buzz'|'none',
               face:'smile'|'grin'|'cool'|'happy'|'brave'|'wink',
               shirt, undershirt, pants, shoes, sole }      (legacy colour opts keep working)
       model { group (feet at y=0, faces +Z), body (animated root),
               head (Group), torso (Mesh), armL/armR/legL/legR (pivots at the joints),
               parts { torso, head, armL, armR, legL, legR, shoeL, shoeR, hairTop, hairSide },
               anchors { hat, face, neck, chest, back, waist, tail, shoulderL, shoulderR,
                         handL, handR, kneeL, kneeR, footL, footR },
               headTop (6.22), carryHeight (7.05), height (≈6.5 without a hat), look,
               carry      truthy → both arms up holding the egg above the head
               moving, grounded, speedFactor, time      (read by cosmetic animations)
               anims[]    fn(dt, model) — called every update (SE.Cosmetics registers here)
               update(dt, moving, speedFactor, grounded)  walk/run/jump/idle/carry/celebrate
               celebrate(secs=1.8)   victory hop + spin + waving arms
               setSkin(c), setHair(color, style), setFace(style),
               setHairMode('keep'|'flat'|'hide')   (hats hide the top / all hair)
               setOutfit({ torso, arm, leg } materials | null = default look),
               setShoes(upper, sole), dispose() }
     Texture layouts (CHAR_UV) are shared with SE.Cosmetics: torso 256×256 atlas
     (front, back, right, left, top, bottom), limbs 64×128 (wrapped on the 4 sides),
     head 256×128 (face on the left half, plain skin on the right).
     Draw calls per character: torso, head, 2 hair, 2 arms, 2 legs, 2 shoes.
     ======================================================================= */
  var CH = {
    legW: 1.0, legH: 2.4, hipX: 0.52,
    torsoW: 2.1, torsoH: 2.3, torsoD: 1.05,
    armW: 0.95, armH: 2.3, shoulderX: 1.555, shoulderY: 4.65,
    head: 1.5, headY: 5.47
  };
  CH.torsoY = CH.legH + CH.torsoH / 2;
  CH.headTop = CH.headY + CH.head / 2;
  CH.carryHeight = 7.05;

  var CHAR_UV = {
    shirt: { W: 256, H: 256, pz: [0, 0, 128, 128], nz: [128, 0, 128, 128], px: [0, 128, 64, 128], nx: [64, 128, 64, 128], py: [128, 128, 128, 64], ny: [128, 192, 128, 64] },
    limb: { W: 64, H: 128, side: [0, 0, 64, 128], top: [6, 1, 52, 6], bottom: [6, 121, 52, 6] },
    head: { W: 256, H: 128, face: [0, 0, 128, 128], skin: [140, 12, 104, 104] }
  };

  function cvs(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function canvasTexture(c) {
    var t = new T.CanvasTexture(c);
    if (T.sRGBEncoding !== undefined) t.encoding = T.sRGBEncoding;
    t.anisotropy = 4;
    return t;
  }
  /* regions: [px, nx, py, ny, pz, nz] as [x, y, w, h] canvas pixels (1 px inset against bleeding) */
  function remapBoxUV(geo, regions, W, H) {
    var uv = geo.attributes.uv;
    for (var f = 0; f < 6; f++) {
      var r = regions[f], x = r[0] + 1, y = r[1] + 1, w = r[2] - 2, h = r[3] - 2;
      for (var k = 0; k < 4; k++) {
        var i = f * 4 + k;
        uv.setXY(i, (x + uv.getX(i) * w) / W, 1 - (y + (1 - uv.getY(i)) * h) / H);
      }
    }
    uv.needsUpdate = true;
    return geo;
  }
  function shadeHex(hex, f) {
    var c = new T.Color(hex);
    var hsl = {}; c.getHSL(hsl);
    hsl.l = Math.max(0, Math.min(1, hsl.l + f));
    return '#' + new T.Color().setHSL(hsl.h, hsl.s, hsl.l).getHexString();
  }
  function toyShade(g, x, y, w, h, strength) {
    var s = strength === undefined ? 1 : strength;
    var gr = g.createLinearGradient(0, y, 0, y + h);
    gr.addColorStop(0, 'rgba(255,255,255,' + 0.13 * s + ')');
    gr.addColorStop(0.45, 'rgba(255,255,255,0)');
    gr.addColorStop(1, 'rgba(0,0,0,' + 0.16 * s + ')');
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.strokeStyle = 'rgba(0,0,0,' + 0.22 * s + ')'; g.lineWidth = 3;
    g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  }

  var charGeo = null;
  function charGeometries() {
    if (charGeo) return charGeo;
    var S = CHAR_UV.shirt, L = CHAR_UV.limb, Hd = CHAR_UV.head;
    charGeo = {
      torso: remapBoxUV(new T.BoxGeometry(CH.torsoW, CH.torsoH, CH.torsoD), [S.px, S.nx, S.py, S.ny, S.pz, S.nz], S.W, S.H),
      arm: remapBoxUV(new T.BoxGeometry(CH.armW, CH.armH, CH.armW), [L.side, L.side, L.top, L.bottom, L.side, L.side], L.W, L.H),
      leg: remapBoxUV(new T.BoxGeometry(CH.legW, CH.legH, CH.legW), [L.side, L.side, L.top, L.bottom, L.side, L.side], L.W, L.H),
      head: remapBoxUV(new T.BoxGeometry(CH.head, CH.head, CH.head), [Hd.skin, Hd.skin, Hd.skin, Hd.skin, Hd.face, Hd.skin], Hd.W, Hd.H)
    };
    charGeo.arm.translate(0, -CH.armH / 2, 0);
    charGeo.leg.translate(0, -CH.legH / 2, 0);
    for (var k in charGeo) charGeo[k].userData.shared = true;
    return charGeo;
  }
  var vcMat = null;
  function vertexColorMat() {
    if (!vcMat) { vcMat = new T.MeshLambertMaterial({ vertexColors: true }); vcMat.userData.shared = true; }
    return vcMat;
  }

  /* --- default (legacy colour) outfit: jacket over a tee, plain trousers --- */
  function paintBasicOutfit(o) {
    var S = CHAR_UV.shirt, shirt = o.shirt || '#2f6fd6';
    var c = cvs(S.W, S.H), g = c.getContext('2d');
    g.fillStyle = shirt; g.fillRect(0, 0, S.W, S.H);
    if (o.undershirt) {
      var f = S.pz;
      g.fillStyle = o.undershirt; g.fillRect(f[0] + 42, f[1], 44, f[3]);
      g.fillStyle = shadeHex(shirt, -0.08);
      g.beginPath(); g.moveTo(f[0] + 42, 0); g.lineTo(f[0] + 58, 0); g.lineTo(f[0] + 42, 46); g.fill();
      g.beginPath(); g.moveTo(f[0] + 86, 0); g.lineTo(f[0] + 70, 0); g.lineTo(f[0] + 86, 46); g.fill();
    }
    ['pz', 'nz', 'px', 'nx', 'py', 'ny'].forEach(function (k) { var r = S[k]; toyShade(g, r[0], r[1], r[2], r[3], k === 'py' || k === 'ny' ? 0.4 : 1); });
    var arm = cvs(64, 128), ga = arm.getContext('2d');
    ga.fillStyle = o.skin || '#ffd9b0'; ga.fillRect(0, 0, 64, 128);
    ga.fillStyle = shirt; ga.fillRect(0, 0, 64, 92);
    ga.fillStyle = shadeHex(shirt, -0.12); ga.fillRect(0, 84, 64, 8);
    toyShade(ga, 0, 0, 64, 128, 0.8);
    var leg = cvs(64, 128), gl = leg.getContext('2d');
    gl.fillStyle = o.pants || '#2a3550'; gl.fillRect(0, 0, 64, 128);
    gl.fillStyle = 'rgba(0,0,0,0.12)'; gl.fillRect(30, 0, 3, 128);
    toyShade(gl, 0, 0, 64, 128, 0.8);
    return { torso: c, arm: arm, leg: leg };
  }
  var basicMatCache = {};
  function basicOutfitMats(o) {
    var key = [o.shirt, o.undershirt, o.pants, o.skin].join('|');
    if (basicMatCache[key]) return basicMatCache[key];
    var p = paintBasicOutfit(o);
    var mats = basicMatCache[key] = {
      torso: new T.MeshLambertMaterial({ map: canvasTexture(p.torso) }),
      arm: new T.MeshLambertMaterial({ map: canvasTexture(p.arm) }),
      leg: new T.MeshLambertMaterial({ map: canvasTexture(p.leg) })
    };
    for (var k in mats) mats[k].userData.shared = true;
    return mats;
  }

  /* --- head: face on the front, plain skin elsewhere --- */
  var FACES = ['smile', 'grin', 'cool', 'happy', 'brave', 'wink'];
  /* faces whose open eyes are animated meshes (look-around + blink) instead of painted dots: [left, right] */
  var ANIM_EYES = { smile: [1, 1], grin: [1, 1], brave: [1, 1], wink: [1, 0] };

  /* Eye animator: quick saccades to random spots, a slight forward look while running, blinks
     (sometimes double). update(dt, moving) -> { x, y } in -1..1 and blink scale 1..0.1. */
  function makeEyeAnim() {
    var e = { x: 0, y: 0, tx: 0, ty: 0, blink: 1, nextLook: 0.4 + Math.random(), nextBlink: 1 + Math.random() * 3, bt: 0 };
    e.update = function (dt, moving) {
      e.nextLook -= dt;
      if (e.nextLook <= 0) {
        var r = Math.random();
        if (moving) { e.tx = (Math.random() - 0.5) * 0.7; e.ty = -0.15 + (Math.random() - 0.5) * 0.4; e.nextLook = 0.5 + Math.random() * 1.2; }
        else if (r < 0.18) { e.tx = e.tx > 0 ? -1 : 1; e.ty = 0.1; e.nextLook = 0.25 + Math.random() * 0.2; }   // funny quick glance
        else if (r < 0.35) { e.tx = 0; e.ty = 0; e.nextLook = 1 + Math.random() * 1.5; }                          // look at the camera
        else { e.tx = (Math.random() * 2 - 1); e.ty = (Math.random() * 2 - 1) * 0.8; e.nextLook = 0.6 + Math.random() * 2.2; }
      }
      var k = Math.min(1, dt * 20);
      e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k;
      e.nextBlink -= dt;
      if (e.nextBlink <= 0) { e.bt = 0.14; e.nextBlink = Math.random() < 0.15 ? 0.22 : 2 + Math.random() * 3.5; }
      if (e.bt > 0) { e.bt = Math.max(0, e.bt - dt); e.blink = 1 - 0.9 * Math.sin(Math.PI * (1 - e.bt / 0.14)); } else e.blink = 1;
      return e;
    };
    return e;
  }
  function paintHead(skin, face) {
    var c = cvs(256, 128), g = c.getContext('2d');
    g.fillStyle = skin; g.fillRect(0, 0, 256, 128);
    var gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, 'rgba(255,255,255,0.10)'); gr.addColorStop(1, 'rgba(0,0,0,0.10)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 128);
    var ink = '#1c1e24';
    function eye(x, y) {
      if (ANIM_EYES[face]) return;   // drawn as animated meshes (makeCharacter)
      g.fillStyle = ink; g.beginPath(); g.ellipse(x, y, 6.5, 11, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(x + 2, y - 4, 2.8, 0, Math.PI * 2); g.fill();
    }
    function closedEye(x, y) {
      g.strokeStyle = ink; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.arc(x, y + 4, 8, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
    }
    function brow(x, y, a) {
      g.strokeStyle = ink; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x - 9 * Math.cos(a), y - 9 * Math.sin(a)); g.lineTo(x + 9 * Math.cos(a), y + 9 * Math.sin(a)); g.stroke();
    }
    g.fillStyle = 'rgba(255,110,110,0.22)';
    g.beginPath(); g.arc(28, 80, 10, 0, Math.PI * 2); g.arc(100, 80, 10, 0, Math.PI * 2); g.fill();
    g.strokeStyle = ink; g.lineWidth = 5; g.lineCap = 'round';
    switch (face) {
      case 'grin':
        eye(44, 52); eye(84, 52);
        g.fillStyle = '#5a1e22'; g.beginPath(); g.moveTo(42, 70); g.quadraticCurveTo(64, 104, 86, 70); g.closePath(); g.fill();
        g.fillStyle = '#ffffff'; g.fillRect(46, 70, 36, 6);
        break;
      case 'cool':
        g.fillStyle = ink; g.fillRect(34, 50, 20, 9); g.fillRect(74, 50, 20, 9);
        brow(44, 40, -0.15); brow(84, 40, 0.15);
        g.beginPath(); g.moveTo(50, 80); g.quadraticCurveTo(70, 88, 84, 74); g.stroke();
        break;
      case 'happy':
        closedEye(44, 54); closedEye(84, 54);
        g.beginPath(); g.arc(64, 68, 20, 0.15, Math.PI - 0.15); g.stroke();
        break;
      case 'brave':
        eye(44, 54); eye(84, 54); brow(44, 39, 0.3); brow(84, 39, -0.3);
        g.beginPath(); g.moveTo(52, 82); g.quadraticCurveTo(64, 88, 76, 82); g.stroke();
        break;
      case 'wink':
        eye(44, 52); closedEye(84, 52);
        g.beginPath(); g.arc(64, 68, 18, 0.2, Math.PI - 0.2); g.stroke();
        g.fillStyle = '#e8606a'; g.beginPath(); g.arc(70, 86, 6, 0, Math.PI); g.fill();
        break;
      default:
        eye(44, 52); eye(84, 52);
        g.beginPath(); g.arc(64, 66, 22, 0.2, Math.PI - 0.2); g.stroke();
    }
    return c;
  }
  var _eyeGeo = null, _eyeMat = null;
  function eyeGeo() {
    if (_eyeGeo) return _eyeGeo;
    var a = new T.BoxGeometry(0.15, 0.26, 0.02), b = new T.BoxGeometry(0.05, 0.06, 0.02);
    b.translate(0.03, 0.07, 0.006);
    function paint(g, hex) { var c = new T.Color(hex), n = g.attributes.position.count, arr = new Float32Array(n * 3); for (var i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; } g.setAttribute('color', new T.BufferAttribute(arr, 3)); }
    paint(a, '#1c1e24'); paint(b, '#ffffff');
    var BGU = T.BufferGeometryUtils; _eyeGeo = (BGU.mergeBufferGeometries || BGU.mergeGeometries)([a.toNonIndexed(), b.toNonIndexed()]);
    _eyeGeo.userData.shared = true;
    return _eyeGeo;
  }
  function eyeMat() {
    if (!_eyeMat) { _eyeMat = new T.MeshBasicMaterial({ vertexColors: true }); _eyeMat.userData.shared = true; }
    return _eyeMat;
  }
  var headMatCache = {};
  function headMaterial(skin, face) {
    var key = skin + '|' + face;
    if (!headMatCache[key]) { headMatCache[key] = new T.MeshLambertMaterial({ map: canvasTexture(paintHead(skin, face)) }); headMatCache[key].userData.shared = true; }
    return headMatCache[key];
  }

  /* --- hair & shoes: merged boxes with vertex colours (one shared material) --- */
  function coloredGeo(parts) {
    var geos = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], geo = p.geo.toNonIndexed ? p.geo : p.geo;
      if (p.rot) geo.applyMatrix4(new T.Matrix4().makeRotationFromEuler(new T.Euler(p.rot[0], p.rot[1], p.rot[2])));
      geo.translate(p.pos[0], p.pos[1], p.pos[2]);
      var col = new T.Color(p.color), n = geo.attributes.position.count, arr = new Float32Array(n * 3);
      for (var k = 0; k < n; k++) { arr[k * 3] = col.r; arr[k * 3 + 1] = col.g; arr[k * 3 + 2] = col.b; }
      geo.setAttribute('color', new T.BufferAttribute(arr, 3));
      if (geo.index) geo = geo.toNonIndexed();
      geos.push(geo);
    }
    var BGU = T.BufferGeometryUtils;
    if (BGU && BGU.mergeBufferGeometries && geos.length) {
      var merged = BGU.mergeBufferGeometries(geos, false);
      geos.forEach(function (g2) { g2.dispose(); });
      if (merged) return merged;
    }
    /* no merge utility: fall back to the first part only (never crash) */
    return geos[0] || new T.BoxGeometry(0.01, 0.01, 0.01);
  }
  function hairParts(style, color) {
    var hi = shadeHex(color, 0.08), lo = shadeHex(color, -0.07);
    var top = [], side = [];
    function B(list, w, h, d, x, y, z, c, rot) { list.push({ geo: new T.BoxGeometry(w, h, d), pos: [x, y, z], color: c || color, rot: rot }); }
    function K(list, r, h, x, y, z, c, rot) { list.push({ geo: new T.ConeGeometry(r, h, 4), pos: [x, y, z], color: c || color, rot: rot }); }
    if (style === 'none') return { top: top, side: side };
    if (style === 'buzz') {
      B(top, 1.56, 0.12, 1.56, 0, 0.8, 0);
      B(side, 1.56, 0.5, 0.08, 0, 0.5, -0.78, lo);
      return { top: top, side: side };
    }
    B(top, 1.6, 0.26, 1.6, 0, 0.85, 0);
    if (style === 'spiky') {
      [[-0.42, 0.06, -0.2, 0.25], [0, 0.12, -0.3, 0.08], [0.42, 0.06, -0.2, -0.25], [-0.25, 0.1, 0.28, 0.3], [0.25, 0.1, 0.28, -0.3], [0, 0.14, 0.05, 0]].forEach(function (s, i) {
        K(top, 0.26, 0.5, s[0], 1.1 + s[1], s[2], i % 2 ? hi : color, [s[2] * -0.7, 0.785, s[3]]);
      });
      B(top, 1.1, 0.22, 0.2, 0.1, 0.68, 0.78, hi, [0, 0, -0.12]);
    } else if (style === 'bob') {
      B(top, 1.7, 0.26, 1.2, 0, 0.62, 0.32, hi);
      B(side, 0.24, 1.25, 1.5, -0.84, 0.15, -0.05);
      B(side, 0.24, 1.25, 1.5, 0.84, 0.15, -0.05);
      B(side, 1.66, 1.35, 0.26, 0, 0.12, -0.8, lo);
    } else {
      /* tousled (default) & ponytail share the top */
      [[-0.38, 0.25, 0.14], [0.28, 0.3, -0.12], [0.42, -0.3, 0.1], [-0.3, -0.32, -0.1]].forEach(function (s, i) {
        B(top, 0.62, 0.18, 0.66, s[0], 1.02, s[1], i % 2 ? hi : color, [s[1] * 0.25, s[2], -s[0] * 0.25]);
      });
      B(top, 1.24, 0.24, 0.2, 0.12, 0.68, 0.78, hi, [0, 0, -0.1]);
      B(top, 0.42, 0.22, 0.18, -0.5, 0.64, 0.78, color, [0, 0, 0.14]);
      B(side, 1.62, 0.92, 0.22, 0, 0.36, -0.78, lo);
      B(side, 0.14, 0.62, 1.2, -0.79, 0.46, -0.14);
      B(side, 0.14, 0.62, 1.2, 0.79, 0.46, -0.14);
      if (style === 'ponytail') {
        B(side, 0.42, 1.15, 0.42, 0, -0.05, -1.08, color, [0.42, 0, 0]);
        B(side, 0.46, 0.16, 0.46, 0, 0.5, -0.92, '#e24a6a', [0.42, 0, 0]);
      }
    }
    return { top: top, side: side };
  }
  function shoeGeo(upper, sole) {
    return coloredGeo([
      { geo: new T.BoxGeometry(1.08, 0.34, 1.22), pos: [0, 0.27, 0.1], color: upper },
      { geo: new T.BoxGeometry(1.12, 0.14, 1.28), pos: [0, 0.07, 0.11], color: sole }
    ]);
  }

  function makeCharacter(opts) {
    opts = opts || {};
    var G = charGeometries();
    var look = {
      skin: opts.skin || '#ffd9b0', hair: opts.hair || '#7a4a1c', hairStyle: opts.hairStyle || 'tousled',
      face: FACES.indexOf(opts.face) >= 0 ? opts.face : 'smile',
      shirt: opts.shirt || '#2f6fd6', undershirt: opts.undershirt || null, pants: opts.pants || '#2a3550',
      shoes: opts.shoes || '#30343a', sole: opts.sole || '#f4f1e8'
    };
    var g = new T.Group();
    var body = new T.Group();
    g.add(body);
    function shadowed(m) { m.castShadow = true; m.receiveShadow = true; return m; }
    function anchor(parent, name, x, y, z) { var a = new T.Group(); a.name = 'anchor_' + name; a.position.set(x, y, z); parent.add(a); return a; }

    var defaultMats = basicOutfitMats(look);
    /* torso */
    var torsoGroup = new T.Group();
    torsoGroup.position.y = CH.torsoY;
    body.add(torsoGroup);
    var torso = shadowed(new T.Mesh(G.torso, defaultMats.torso));
    torsoGroup.add(torso);
    /* head */
    var headGroup = new T.Group();
    headGroup.position.y = CH.headY;
    body.add(headGroup);
    var headMesh = shadowed(new T.Mesh(G.head, headMaterial(look.skin, look.face)));
    headGroup.add(headMesh);
    /* animated eyes: front face at z = head/2; painted eye centres were at (44,52) / (84,52) of the 128 px face */
    var eyeAnim = makeEyeAnim(), eyeMeshes = [];
    [-1, 1].forEach(function (sx) {
      var m = new T.Mesh(eyeGeo(), eyeMat());
      m.position.set(sx * 0.234, 0.14, CH.head / 2 + 0.012);
      m.userData.restX = m.position.x; m.userData.restY = m.position.y;
      headGroup.add(m); eyeMeshes.push(m);
    });
    function syncEyes() {
      var on = ANIM_EYES[look.face] || [0, 0];
      eyeMeshes[0].visible = !!on[0]; eyeMeshes[1].visible = !!on[1];
    }
    syncEyes();
    var hairTop = shadowed(new T.Mesh(new T.BufferGeometry(), vertexColorMat()));
    var hairSide = shadowed(new T.Mesh(new T.BufferGeometry(), vertexColorMat()));
    headGroup.add(hairTop, hairSide);
    /* limbs */
    function limb(x, y, geo, mat) {
      var pivot = new T.Group(); pivot.position.set(x, y, 0); body.add(pivot);
      var mesh = shadowed(new T.Mesh(geo, mat)); pivot.add(mesh);
      return { pivot: pivot, mesh: mesh };
    }
    var aL = limb(-CH.shoulderX, CH.shoulderY, G.arm, defaultMats.arm);
    var aR = limb(CH.shoulderX, CH.shoulderY, G.arm, defaultMats.arm);
    var lL = limb(-CH.hipX, CH.legH, G.leg, defaultMats.leg);
    var lR = limb(CH.hipX, CH.legH, G.leg, defaultMats.leg);
    var shoeL = shadowed(new T.Mesh(shoeGeo(look.shoes, look.sole), vertexColorMat()));
    var shoeR = shadowed(new T.Mesh(shoeGeo(look.shoes, look.sole), vertexColorMat()));
    shoeL.position.y = shoeR.position.y = -CH.legH;
    lL.pivot.add(shoeL); lR.pivot.add(shoeR);

    var anchors = {
      hat: anchor(headGroup, 'hat', 0, CH.head / 2, 0),
      face: anchor(headGroup, 'face', 0, 0, CH.head / 2),
      neck: anchor(torsoGroup, 'neck', 0, CH.torsoH / 2, 0),
      chest: anchor(torsoGroup, 'chest', 0, 0.35, CH.torsoD / 2),
      back: anchor(torsoGroup, 'back', 0, 0.35, -CH.torsoD / 2),
      waist: anchor(torsoGroup, 'waist', 0, -CH.torsoH / 2 + 0.2, 0),
      tail: anchor(torsoGroup, 'tail', 0, -CH.torsoH / 2 + 0.3, -CH.torsoD / 2),
      shoulderL: anchor(aL.pivot, 'shoulderL', 0, 0, 0),
      shoulderR: anchor(aR.pivot, 'shoulderR', 0, 0, 0),
      handL: anchor(aL.pivot, 'handL', 0, -CH.armH + 0.2, 0),
      handR: anchor(aR.pivot, 'handR', 0, -CH.armH + 0.2, 0),
      kneeL: anchor(lL.pivot, 'kneeL', 0, -CH.legH * 0.55, 0),
      kneeR: anchor(lR.pivot, 'kneeR', 0, -CH.legH * 0.55, 0),
      footL: anchor(lL.pivot, 'footL', 0, -CH.legH, 0),
      footR: anchor(lR.pivot, 'footR', 0, -CH.legH, 0)
    };

    var armL = aL.pivot, armR = aR.pivot, legL = lL.pivot, legR = lR.pivot;
    var hairMode = 'keep';

    function rebuildHair() {
      var parts = hairParts(look.hairStyle, look.hair);
      var old1 = hairTop.geometry, old2 = hairSide.geometry;
      hairTop.geometry = parts.top.length ? coloredGeo(parts.top) : new T.BufferGeometry();
      hairSide.geometry = parts.side.length ? coloredGeo(parts.side) : new T.BufferGeometry();
      old1.dispose(); old2.dispose();
      hairTop.visible = parts.top.length > 0 && hairMode === 'keep';
      hairSide.visible = parts.side.length > 0 && hairMode !== 'hide';
    }
    rebuildHair();

    function approach(obj, prop, target, k) { obj[prop] += (target - obj[prop]) * k; }

    var api = {
      group: g, body: body, torsoGroup: torsoGroup,
      head: headGroup, torso: torso,
      armL: armL, armR: armR, legL: legL, legR: legR,
      parts: { torso: torso, head: headMesh, armL: aL.mesh, armR: aR.mesh, legL: lL.mesh, legR: lR.mesh, shoeL: shoeL, shoeR: shoeR, hairTop: hairTop, hairSide: hairSide },
      anchors: anchors,
      dims: CH,
      headTop: CH.headTop, carryHeight: CH.carryHeight, height: CH.headTop + 0.3,
      look: look,
      t: 0, time: 0, carry: null, moving: false, grounded: true, speedFactor: 0,
      celebrateT: 0, celebrateDur: 0,
      anims: [],

      update: function (dt, moving, speedFactor, grounded) {
        dt = Math.min(Math.max(dt || 0, 0), 0.1);
        grounded = grounded !== false;
        this.moving = !!moving; this.grounded = grounded; this.speedFactor = speedFactor || 0;
        this.time += dt;
        eyeAnim.update(dt, moving);
        var eon = ANIM_EYES[look.face] || [0, 0];
        for (var ei = 0; ei < 2; ei++) {
          var em = eyeMeshes[ei];
          em.visible = !!eon[ei] && headMesh.visible;      // hidden with the head (e.g. under a full-body skin)
          em.position.x = em.userData.restX + eyeAnim.x * 0.07;
          em.position.y = em.userData.restY + eyeAnim.y * 0.05;
          em.scale.y = eyeAnim.blink;
        }
        var sf = Math.min(2.2, Math.max(0.4, speedFactor || 1));
        this.t += dt * (moving ? 9 * sf : 2.2);
        var s = Math.sin(this.t), amp = moving ? Math.min(1.05, 0.7 + sf * 0.18) : 0.045;
        var aLx = s * amp, aRx = -s * amp, aLz = 0, aRz = 0, lLx = -s * amp, lRx = s * amp;
        var bodyY = 0, lean = 0, spin = 0, headYaw = 0, headPitch = 0;
        if (moving && grounded) { bodyY = Math.abs(Math.cos(this.t)) * 0.16; lean = 0.05 + 0.03 * sf; }
        else if (!moving) { headYaw = Math.sin(this.time * 0.6) * 0.14; headPitch = Math.sin(this.time * 0.9) * 0.03; aLz = 0.03; aRz = -0.03; }
        if (!grounded) { aLx = aRx = -2.35; aLz = -0.2; aRz = 0.2; lLx = 0.5; lRx = -0.3; lean = 0; }
        if (this.celebrateT > 0) {
          this.celebrateT = Math.max(0, this.celebrateT - dt);
          var p = 1 - this.celebrateT / (this.celebrateDur || 1), wave = Math.sin(this.time * 15);
          aLx = -2.75 + wave * 0.22; aRx = -2.75 - wave * 0.22; aLz = -0.5; aRz = 0.5;
          var hop = Math.abs(Math.sin(p * Math.PI * 3));
          bodyY = hop * 0.85; lLx = -0.35 * hop; lRx = 0.25 * hop; lean = -0.06; headPitch = -0.12;
          spin = p < 0.42 ? (1 - Math.pow(1 - p / 0.42, 3)) * Math.PI * 2 : 0;
        }
        if (this.carry) { aLx = aRx = -2.95; aLz = 0.3; aRz = -0.3; }
        var k = 1 - Math.exp(-(moving ? 18 : 11) * dt);
        approach(armL.rotation, 'x', aLx, k); approach(armR.rotation, 'x', aRx, k);
        approach(armL.rotation, 'z', aLz, k); approach(armR.rotation, 'z', aRz, k);
        approach(legL.rotation, 'x', lLx, k); approach(legR.rotation, 'x', lRx, k);
        approach(body.position, 'y', bodyY, Math.min(1, k * 1.6));
        approach(body.rotation, 'x', lean, k);
        approach(headGroup.rotation, 'y', headYaw, k * 0.5);
        approach(headGroup.rotation, 'x', headPitch, k * 0.5);
        body.rotation.y = spin;
        torsoGroup.rotation.y = moving && grounded ? s * 0.07 : 0;
        torso.scale.y = 1 + Math.sin(this.time * 2.1) * (moving ? 0 : 0.012);
        for (var i = 0; i < this.anims.length; i++) {
          try { this.anims[i](dt, this); } catch (e) { this.anims.splice(i--, 1); console.error('[Models] character anim failed', e); }
        }
      },
      celebrate: function (secs) {
        this.celebrateDur = this.celebrateT = Math.max(0.5, secs || 1.8);
      },
      setSkin: function (c) {
        if (!c || c === look.skin) return;
        look.skin = c;
        headMesh.material = headMaterial(look.skin, look.face);
        if (!this._outfit) { defaultMats = basicOutfitMats(look); this.setOutfit(null); }
      },
      setFace: function (f) {
        look.face = FACES.indexOf(f) >= 0 ? f : 'smile';
        headMesh.material = headMaterial(look.skin, look.face);
        syncEyes();
      },
      setHair: function (color, style) {
        if (color) look.hair = color;
        if (style) look.hairStyle = style;
        rebuildHair();
      },
      setHairMode: function (mode) {
        hairMode = mode === 'flat' || mode === 'hide' ? mode : 'keep';
        hairTop.visible = hairMode === 'keep' && hairTop.geometry.attributes.position !== undefined;
        hairSide.visible = hairMode !== 'hide' && hairSide.geometry.attributes.position !== undefined;
      },
      setOutfit: function (mats) {
        this._outfit = mats || null;
        var m = mats || defaultMats;
        torso.material = m.torso;
        aL.mesh.material = aR.mesh.material = m.arm;
        lL.mesh.material = lR.mesh.material = m.leg;
      },
      setShoes: function (upper, sole) {
        look.shoes = upper || look.shoes; look.sole = sole || look.sole;
        [shoeL, shoeR].forEach(function (s) { var old = s.geometry; s.geometry = shoeGeo(look.shoes, look.sole); old.dispose(); });
      },
      dispose: function () {
        [hairTop, hairSide, shoeL, shoeR].forEach(function (m) { if (m.geometry) m.geometry.dispose(); });
        this.anims.length = 0;
        if (g.parent) g.parent.remove(g);
      }
    };
    return api;
  }


  /* ---------------- Охранники ---------------- */
  function makeGuard(type, colorSet) {
    var g = new T.Group();
    var c = colorSet || {};
    var body = c.body || '#ffffff';
    var accent = c.accent || '#ff9f1a';
    var dark = c.dark || '#e05a1a';
    var scale = c.scale || 1;

    var root = new T.Group();
    g.add(root);

    /* тело */
    var b = box(2.6 * scale, 2.2 * scale, 3.6 * scale, body);
    b.position.y = 2.4 * scale;
    root.add(b);

    /* хвост */
    var tail = box(1.2 * scale, 1.4 * scale, 0.5 * scale, body);
    tail.position.set(0, 3.2 * scale, -1.9 * scale);
    tail.rotation.x = -0.4;
    root.add(tail);

    /* шея + голова */
    var neck = box(1.1 * scale, 1.4 * scale, 1.1 * scale, body);
    neck.position.set(0, 3.6 * scale, 1.2 * scale);
    root.add(neck);

    var headG = new T.Group();
    headG.position.set(0, 4.6 * scale, 1.4 * scale);
    var head = box(1.5 * scale, 1.4 * scale, 1.5 * scale, body);
    headG.add(head);

    /* глаза */
    var eyeL = box(0.28 * scale, 0.36 * scale, 0.1 * scale, '#1a1a1a');
    eyeL.position.set(-0.4 * scale, 0.15 * scale, 0.78 * scale);
    headG.add(eyeL);
    var eyeR = eyeL.clone();
    eyeR.position.x = 0.4 * scale;
    headG.add(eyeR);

    /* клюв / морда */
    if (type === 'chicken' || type === 'ostrich' || type === 'griffin') {
      var beak = box(0.6 * scale, 0.45 * scale, 0.7 * scale, accent);
      beak.position.set(0, -0.25 * scale, 1.0 * scale);
      headG.add(beak);
      var comb = box(0.25 * scale, 0.5 * scale, 0.9 * scale, dark);
      comb.position.set(0, 0.9 * scale, 0.1 * scale);
      headG.add(comb);
      var wattle = box(0.3 * scale, 0.45 * scale, 0.25 * scale, dark);
      wattle.position.set(0, -0.7 * scale, 0.72 * scale);
      headG.add(wattle);
    } else {
      var snout = box(0.9 * scale, 0.6 * scale, 0.8 * scale, accent);
      snout.position.set(0, -0.3 * scale, 0.95 * scale);
      headG.add(snout);
      var horn1 = cone(0.24 * scale, 0.8 * scale, dark, 6);
      horn1.position.set(-0.45 * scale, 0.95 * scale, 0);
      headG.add(horn1);
      var horn2 = horn1.clone();
      horn2.position.x = 0.45 * scale;
      headG.add(horn2);
    }
    root.add(headG);

    /* крылья */
    var wingL = box(0.35 * scale, 1.3 * scale, 2.4 * scale, body);
    wingL.position.set(-1.45 * scale, 2.5 * scale, 0);
    root.add(wingL);
    var wingR = wingL.clone();
    wingR.position.x = 1.45 * scale;
    root.add(wingR);

    if (type === 'griffin' || type === 'magma') {
      var bigWingL = box(0.2 * scale, 1.8 * scale, 3.4 * scale, accent);
      bigWingL.position.set(-2.1 * scale, 3.4 * scale, -0.4 * scale);
      bigWingL.rotation.z = 0.4;
      root.add(bigWingL);
      var bigWingR = bigWingL.clone();
      bigWingR.position.x = 2.1 * scale;
      bigWingR.rotation.z = -0.4;
      root.add(bigWingR);
    }

    /* лапы */
    function foot(side) {
      var p = new T.Group();
      p.position.set(side * 0.7 * scale, 1.4 * scale, 0);
      var l = box(0.35 * scale, 1.4 * scale, 0.35 * scale, accent);
      l.position.y = -0.7 * scale;
      p.add(l);
      var f = box(0.5 * scale, 0.2 * scale, 0.9 * scale, accent);
      f.position.set(0, -1.4 * scale, 0.25 * scale);
      p.add(f);
      root.add(p);
      return p;
    }
    var footL = foot(-1), footR = foot(1);

    /* «!» над головой (тревога) */
    var alertTex = new T.CanvasTexture(U.signTexture('!', {
      width: 128, height: 256, fontSize: 200, color: '#ff1010', outlineColor: '#080808', outlineWidth: 25
    }));
    var alert = new T.Sprite(new T.SpriteMaterial({ map: alertTex, transparent: true, depthTest: false }));
    alert.scale.set(2.1, 4.2, 1);
    alert.position.set(0, 8.2 * scale, 0);
    alert.visible = false;
    alert.renderOrder = 20;
    g.add(alert);

    return {
      group: g,
      root: root,
      head: headG,
      alert: alert,
      wings: [wingL, wingR],
      feet: [footL, footR],
      t: Math.random() * 10,
      update: function (dt, moving, speed) {
        this.t += dt * (moving ? 10 : 2.5);
        var s = Math.sin(this.t);
        footL.rotation.x = s * (moving ? 1.0 : 0.1);
        footR.rotation.x = -s * (moving ? 1.0 : 0.1);
        wingL.rotation.z = 0.25 + Math.abs(s) * (moving ? 0.5 : 0.08);
        wingR.rotation.z = -0.25 - Math.abs(s) * (moving ? 0.5 : 0.08);
        headG.position.y = 4.6 * scale + Math.sin(this.t * 0.7) * 0.12;
        root.rotation.z = moving ? s * 0.05 : 0;
      }
    };
  }

  var GUARD_STYLES = {
    chicken:   { body: '#ffffff', accent: '#ffb300', dark: '#e02f2f', scale: 1.05 },
    ostrich:   { body: '#f0dcb0', accent: '#ff8a3d', dark: '#b05a2a', scale: 1.15 },
    gummy:     { body: '#ff7fd0', accent: '#fff0f6', dark: '#c0247f', scale: 1.1 },
    yetiguard: { body: '#e8f6ff', accent: '#7fc8f0', dark: '#3a86b8', scale: 1.25 },
    magma:     { body: '#8a2b1a', accent: '#ff8a1f', dark: '#ffcf4a', scale: 1.2 },
    griffin:   { body: '#e8d8a8', accent: '#ffd24a', dark: '#a07a20', scale: 1.3 }
  };

  /* ---------------- Питомцы ---------------- */
  function makePet(def, scale) {
    scale = scale || 1;
    var g = new T.Group();
    var glow = def.flags.indexOf('g') >= 0;
    var opts = glow ? { emissive: def.accent } : {};
    var body = def.body, accent = def.accent;
    var legs = [];

    function addLegs(w, h, z1, z2, color) {
      [[-w, z1], [w, z1], [-w, z2], [w, z2]].forEach(function (p) {
        var l = box(0.24, h, 0.24, color);
        l.position.set(p[0], h / 2, p[1]);
        g.add(l);
        legs.push(l);
      });
    }

    if (def.shape === 'quad') {
      var b = box(0.9, 0.72, 1.4, body, opts);
      b.position.y = 0.85;
      g.add(b);
      var h = box(0.72, 0.66, 0.66, body, opts);
      h.position.set(0, 1.28, 0.85);
      g.add(h);
      var snout = box(0.34, 0.28, 0.3, accent);
      snout.position.set(0, 1.16, 1.24);
      g.add(snout);
      var e1 = box(0.16, 0.2, 0.1, '#141414');
      e1.position.set(-0.2, 1.38, 1.02); g.add(e1);
      var e2 = e1.clone(); e2.position.x = 0.2; g.add(e2);
      addLegs(0.32, 0.5, 0.45, -0.45, accent);
      /* уши */
      var earH = def.flags.indexOf('e') >= 0 ? 0.7 : 0.3;
      var earL = box(0.2, earH, 0.12, accent);
      earL.position.set(-0.24, 1.62 + earH / 2 - 0.15, 0.8);
      g.add(earL);
      var earR = earL.clone(); earR.position.x = 0.24; g.add(earR);
      /* хвост */
      var tail = box(0.2, 0.2, 0.5, accent);
      tail.position.set(0, 1.0, -0.85);
      g.add(tail);
    } else if (def.shape === 'bird') {
      var bb = sph(0.55, body, opts);
      bb.scale.set(1, 0.95, 1.15);
      bb.position.y = 0.85;
      g.add(bb);
      var bh = sph(0.34, body, opts);
      bh.position.set(0, 1.42, 0.28);
      g.add(bh);
      var beak = cone(0.14, 0.3, accent, 6);
      beak.rotation.x = Math.PI / 2;
      beak.position.set(0, 1.38, 0.62);
      g.add(beak);
      var eb1 = box(0.1, 0.12, 0.08, '#141414');
      eb1.position.set(-0.14, 1.5, 0.3); g.add(eb1);
      var eb2 = eb1.clone(); eb2.position.x = 0.14; g.add(eb2);
      var f1 = box(0.14, 0.32, 0.14, accent);
      f1.position.set(-0.2, 0.2, 0); g.add(f1); legs.push(f1);
      var f2 = f1.clone(); f2.position.x = 0.2; g.add(f2); legs.push(f2);
    } else if (def.shape === 'blob') {
      var s1 = sph(0.62, body, opts);
      s1.scale.set(1.1, 0.9, 1);
      s1.position.y = 0.62;
      g.add(s1);
      var s2 = sph(0.36, body, opts);
      s2.position.set(0, 1.16, 0.05);
      g.add(s2);
      var be1 = box(0.12, 0.14, 0.1, '#141414');
      be1.position.set(-0.18, 1.2, 0.32); g.add(be1);
      var be2 = be1.clone(); be2.position.x = 0.18; g.add(be2);
      var mouth = box(0.3, 0.06, 0.06, '#141414');
      mouth.position.set(0, 1.02, 0.34); g.add(mouth);
    } else if (def.shape === 'dragon') {
      var db = box(0.85, 0.72, 1.5, body, opts);
      db.position.y = 0.95; g.add(db);
      var dh = box(0.7, 0.6, 0.8, body, opts);
      dh.position.set(0, 1.5, 0.95); g.add(dh);
      var jaw = box(0.5, 0.24, 0.5, accent);
      jaw.position.set(0, 1.22, 1.2); g.add(jaw);
      var de1 = box(0.14, 0.16, 0.1, '#ffe27a');
      de1.position.set(-0.2, 1.62, 1.2); g.add(de1);
      var de2 = de1.clone(); de2.position.x = 0.2; g.add(de2);
      addLegs(0.35, 0.55, 0.5, -0.5, accent);
      var dtail = box(0.24, 0.24, 0.9, body, opts);
      dtail.position.set(0, 1.0, -1.1); g.add(dtail);
    } else { /* bug */
      var ub = sph(0.5, body, opts);
      ub.scale.set(1.2, 0.7, 1.4);
      ub.position.y = 0.55; g.add(ub);
      var uh = sph(0.3, accent, opts);
      uh.position.set(0, 0.6, 0.72); g.add(uh);
      for (var i = 0; i < 6; i++) {
        var l2 = box(0.1, 0.36, 0.1, accent);
        l2.position.set((i % 2 ? 1 : -1) * 0.5, 0.2, -0.4 + Math.floor(i / 2) * 0.4);
        g.add(l2); legs.push(l2);
      }
    }

    /* Дополнительные детали */
    if (def.flags.indexOf('w') >= 0) {
      var wl = box(0.08, 0.6, 1.0, accent, { emissive: glow ? accent : '#000' });
      wl.position.set(-0.55, 1.25, -0.1);
      wl.rotation.z = 0.5; g.add(wl);
      var wr = wl.clone(); wr.position.x = 0.55; wr.rotation.z = -0.5; g.add(wr);
    }
    if (def.flags.indexOf('h') >= 0) {
      var horn = cone(0.12, 0.55, '#ffe27a', 6, { emissive: glow ? '#ffb300' : '#000' });
      horn.position.set(0, 1.85, 0.75);
      horn.rotation.x = -0.35;
      g.add(horn);
    }
    if (def.flags.indexOf('c') >= 0) {
      var crown = cyl(0.26, 0.3, 0.22, '#ffd24a', 8, { emissive: '#8a5a00' });
      crown.position.set(0, 1.82, 0.5);
      g.add(crown);
      for (var k = 0; k < 5; k++) {
        var spike = cone(0.06, 0.18, '#ffd24a', 5);
        var a = (k / 5) * Math.PI * 2;
        spike.position.set(Math.cos(a) * 0.24, 2.0, 0.5 + Math.sin(a) * 0.24);
        g.add(spike);
      }
    }
    if (def.flags.indexOf('s') >= 0) {
      for (var m = 0; m < 4; m++) {
        var sp = cone(0.1, 0.3, accent, 5);
        sp.position.set(0, 1.35, 0.4 - m * 0.35);
        g.add(sp);
      }
    }

    g.scale.setScalar(scale);
    return {
      group: g,
      legs: legs,
      t: Math.random() * 6,
      update: function (dt, moving) {
        this.t += dt * (moving ? 11 : 3);
        var s = Math.sin(this.t);
        for (var i = 0; i < legs.length; i++) {
          legs[i].rotation.x = s * (i % 2 ? 0.6 : -0.6) * (moving ? 1 : 0.15);
        }
        g.position.y = moving ? Math.abs(s) * 0.12 : Math.sin(this.t * 0.5) * 0.05;
        g.rotation.z = moving ? s * 0.05 : 0;
      }
    };
  }

  /* ---------------- Яйцо ---------------- */
  function makeEgg(colorA, colorB, scale, striped) {
    scale = scale || 1;
    var g = new T.Group();
    var geometry = new T.SphereGeometry(0.62, 24, 24);
    var points = geometry.attributes.position;
    for (var p = 0; p < points.count; p++) {
      var py = points.getY(p), taper = 1 - py * 0.26;
      points.setXYZ(p, points.getX(p) * taper, py * 1.43, points.getZ(p) * taper);
    }
    geometry.computeVertexNormals();
    var eggMaterial = mat(colorA);
    if (striped !== false) {
      var stripeCanvas = U.canvas(32, 256), stripeCtx = stripeCanvas.getContext('2d');
      stripeCtx.fillStyle = colorA; stripeCtx.fillRect(0, 0, 32, 256);
      stripeCtx.fillStyle = colorB;
      for (var stripe = 0; stripe < 5; stripe++) stripeCtx.fillRect(0, 22 + stripe * 49, 32, 22);
      var stripeMap = new T.CanvasTexture(stripeCanvas);
      if (T.sRGBEncoding !== undefined) stripeMap.encoding = T.sRGBEncoding;
      eggMaterial = new T.MeshLambertMaterial({ map: stripeMap });
    }
    var shell = new T.Mesh(geometry, eggMaterial);
    shell.castShadow = true;
    g.add(shell);
    g.scale.setScalar(scale);
    return g;
  }

  /* ---------------- Гнездо ---------------- */
  function makeNest(eggColor, eggStripe, big) {
    var g = new T.Group();
    var s = big ? 1.8 : 1;
    var dirt = new T.Mesh(new T.CylinderGeometry(3.2 * s, 3.8 * s, 0.7, 14), mat('#5a3a22'));
    dirt.position.y = 0.35;
    dirt.receiveShadow = true;
    g.add(dirt);
    var rim = new T.Mesh(new T.TorusGeometry(2.9 * s, 0.42 * s, 6, 16), mat('#6b4526'));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.72;
    rim.castShadow = true;
    g.add(rim);
    /* веточки */
    for (var i = 0; i < 18; i++) {
      var a = (i / 18) * Math.PI * 2;
      var stick = box(2.6 * s, 0.28, 0.4 * s, i % 3 ? '#8c642f' : '#b29250');
      stick.position.set(Math.cos(a) * 2.8 * s, 0.78 + (i % 3) * 0.12, Math.sin(a) * 2.8 * s);
      stick.rotation.y = -a + Math.PI / 2 + (i % 2 ? 0.15 : -0.15);
      g.add(stick);
    }
    return g;
  }

  /* ---------------- Забор ---------------- */
  function fenceSegment(len, colorPost, colorRail) {
    var g = new T.Group();
    var post = box(1.0, 3.8, 1.0, colorPost || '#744323', { studs: true });
    post.position.set(-len / 2, 1.7, 0);
    g.add(post);
    var post2 = post.clone();
    post2.position.x = len / 2;
    g.add(post2);
    [-len / 2, len / 2].forEach(function (x) {
      var cap = box(1.4, 0.3, 1.4, colorPost || '#744323', { studs: true });
      cap.position.set(x, 3.7, 0); g.add(cap);
    });
    for (var i = 0; i < 3; i++) {
      var rail = box(len, 0.45, 0.42, colorRail || '#b97631', { studs: true });
      rail.position.set(0, 0.9 + i * 0.9, 0);
      g.add(rail);
    }
    return g;
  }

  /* Прямоугольная ограда с разрывом (вход) */
  function fenceRect(w, d, opts) {
    opts = opts || {};
    var g = new T.Group();
    var seg = opts.seg || 8;
    var gapSide = opts.gapSide; /* 'north'|'south'|'east'|'west' */
    var post = opts.post, rail = opts.rail;

    function line(x0, z0, x1, z1, skipMiddle) {
      var dx = x1 - x0, dz = z1 - z0;
      var len = Math.sqrt(dx * dx + dz * dz);
      if (skipMiddle) {
        var gap = Math.min(opts.gap || 8, len - 2);
        var edge = (len - gap) / (2 * len);
        line(x0, z0, x0 + dx * edge, z0 + dz * edge, false);
        line(x1 - dx * edge, z1 - dz * edge, x1, z1, false);
        return;
      }
      var count = Math.max(1, Math.round(len / seg));
      for (var i = 0; i < count; i++) {
        var t0 = i / count, t1 = (i + 1) / count;
        var cx = x0 + dx * (t0 + t1) / 2;
        var cz = z0 + dz * (t0 + t1) / 2;
        var s = fenceSegment(len / count, post, rail);
        s.position.set(cx, 0, cz);
        s.rotation.y = -Math.atan2(dz, dx);
        g.add(s);
      }
    }
    line(-w / 2, -d / 2, w / 2, -d / 2, gapSide === 'north');
    line(-w / 2, d / 2, w / 2, d / 2, gapSide === 'south');
    line(-w / 2, -d / 2, -w / 2, d / 2, gapSide === 'west');
    line(w / 2, -d / 2, w / 2, d / 2, gapSide === 'east');
    return g;
  }

  /* ---------------- Прилавок продажи ---------------- */
  function makeStall(labelText, npcOptions) {
    var g = new T.Group();
    /* стойка */
    var counter = box(8, 2.95, 3.4, '#74471f', { studs: true });
    counter.position.y = 1.475;
    g.add(counter);
    var top = box(8.6, 0.4, 3.8, '#825322', { studs: true });
    top.position.y = 3.15;
    g.add(top);
    /* столбы */
    [-3.7, 3.7].forEach(function (x) {
      [-1.4, 1.4].forEach(function (z) {
        var p = box(0.5, 6.5, 0.5, '#8a5a2e', { studs: true });
        p.position.set(x, 3.2, z);
        g.add(p);
      });
    });
    /* полосатая крыша */
    for (var i = 0; i < 8; i++) {
      var stripe = box(1.15, 0.65, 5.4, i % 2 ? '#ff3a0d' : '#f8f7ec', { studs: true });
      stripe.position.set(-4.6 + 0.575 + i * 1.15, 6.6, 0);
      stripe.rotation.x = 0.13;
      g.add(stripe);
    }
    /* фонарь */
    var lamp = box(0.7, 1.0, 0.7, '#ffd24a', { emissive: '#ff9a00' });
    lamp.position.set(-3.2, 4.9, 1.5);
    g.add(lamp);
    [4.28, 5.51].forEach(function (y) { g.add(at(cyl(0.46, 0.46, 0.22, '#454840', 10), -3.2, y, 1.5)); });
    /* A complete avatar stands on the ground behind the back edge of the
       counter. Its arms and legs never pass through the wooden front. */
    var npcModel = makeCharacter(npcOptions || {
      shirt: '#32653a', undershirt: '#f6d877', pants: '#2d3027',
      skin: '#fff0d5', hair: '#75451e'
    });
    var npc = npcModel.group;
    npc.scale.setScalar(0.9);
    npc.position.set(0, 0, -2.55);
    g.add(npc);
    return { group: g, npc: npc, npcModel: npcModel };
  }

  /* ---------------- Беговая дорожка ---------------- */
  function makeTreadmill() {
    var g = new T.Group();
    var base = box(5, 0.8, 9, '#2f3640');
    base.position.y = 0.4;
    g.add(base);
    var belt = box(4.2, 0.35, 8.2, '#1b1f26');
    belt.position.y = 0.95;
    g.add(belt);
    /* полосы ленты */
    var stripes = [];
    for (var i = 0; i < 10; i++) {
      var s = box(4.0, 0.06, 0.35, '#4a5464');
      s.position.set(0, 1.16, -3.8 + i * 0.85);
      g.add(s);
      stripes.push(s);
    }
    /* поручни */
    [-2.2, 2.2].forEach(function (x) {
      var post = box(0.35, 3.4, 0.35, '#c0c8d0');
      post.position.set(x, 2.1, -3.6);
      g.add(post);
    });
    var bar = box(5, 0.35, 0.35, '#c0c8d0');
    bar.position.set(0, 3.7, -3.6);
    g.add(bar);
    var panel = box(4.2, 1.6, 0.4, '#12161c');
    panel.position.set(0, 4.6, -3.6);
    g.add(panel);
    var screen = box(3.4, 1.0, 0.1, '#3ad07a', { emissive: '#1d7a44' });
    screen.position.set(0, 4.6, -3.36);
    g.add(screen);
    return { group: g, stripes: stripes };
  }

  /* ---------------- Стенд магазина трейлов ---------------- */
  function makeTrailStand() {
    var stand = makeStall(null, {
      shirt: '#354c83', undershirt: '#ffdf58', pants: '#242f47',
      skin: '#ffead0', hair: '#4f3023'
    }), g = stand.group;
    /* Same wooden booth, with the yellow/white awning from the reference. */
    g.children.forEach(function (child) {
      if (child.isMesh && child.position.y === 6.6 && child.position.x > -4.7) {
        var stripeIndex = Math.round((child.position.x + 4.025) / 1.15);
        /* The box UVs already carry the face dimensions. Reusing the same
           density as the original awning avoids scaling its studs twice. */
        child.material = studMat(stripeIndex % 2 ? '#ffda00' : '#fffef2', 3.2, 3.2);
      }
    });
    /* «ленты» трейлов на витрине */
    var colors = ['#4ade4a', '#3a8ef6', '#c04fff', '#ffd24a', '#ff6ad5'];
    var ribbons = [];
    for (var i = 0; i < colors.length; i++) {
      var r = box(0.6, 0.18, 1.8, colors[i], { emissive: colors[i] });
      r.position.set(-2.4 + i * 1.2, 3.72, 0.4);
      r.rotation.x = -0.3;
      g.add(r);
      ribbons.push(r);
    }
    return { group: g, ribbons: ribbons, npc: stand.npc, npcModel: stand.npcModel };
  }

  /* ---------------- Декор ---------------- */
  function makeTree(kind) {
    var g = new T.Group();
    var trunk = cyl(0.55, 0.75, 4.5, '#7a4a26', 7);
    trunk.position.y = 2.25;
    g.add(trunk);
    if (kind === 'pine') {
      for (var i = 0; i < 3; i++) {
        var c = cone(3.2 - i * 0.8, 3.0, i % 2 ? '#2e9e3f' : '#37b94c', 8);
        c.position.y = 4.6 + i * 1.9;
        g.add(c);
      }
    } else {
      var b1 = box(5, 3.4, 5, '#22c522', { studs: true });
      b1.position.y = 6.0; g.add(b1);
      var b2 = box(3.4, 2.4, 3.4, '#36db18', { studs: true });
      b2.position.y = 8.0; g.add(b2);
      var b3 = box(2.2, 1.6, 2.2, '#2e9e3f');
      b3.position.set(1.4, 6.6, 1.2); g.add(b3);
    }
    return g;
  }

  function makeBush() {
    var g = new T.Group();
    var b = box(3.4, 2.3, 3.4, '#2ccd0b', { studs: true });
    b.position.y = 0.9; g.add(b);
    var b2 = box(1.6, 1.2, 1.6, '#22c808', { studs: true });
    b2.position.set(0.7, 1.7, -0.4); g.add(b2);
    return g;
  }

  function makeRock(scale, color) {
    var g = new T.Group();
    var r = box(2.2 * (scale || 1), 1.6 * (scale || 1), 2.0 * (scale || 1), color || '#8a8f96', { flat: true });
    r.rotation.y = Math.random() * 3;
    r.position.y = 0.8 * (scale || 1);
    g.add(r);
    var r2 = box(1.2 * (scale || 1), 1.0 * (scale || 1), 1.2 * (scale || 1), color || '#9aa0a8', { flat: true });
    r2.position.set(0.8 * (scale || 1), 1.4 * (scale || 1), -0.5 * (scale || 1));
    r2.rotation.y = Math.random() * 3;
    g.add(r2);
    return g;
  }

  function makeCactus() {
    var g = new T.Group();
    var body = box(1.5, 6, 1.5, '#3f9f4f');
    body.position.y = 3; g.add(body);
    var armA = box(1.0, 2.6, 1.0, '#3f9f4f');
    armA.position.set(-1.2, 4.2, 0); g.add(armA);
    var armA2 = box(1.0, 1.0, 1.0, '#3f9f4f');
    armA2.position.set(-1.2, 5.6, 0); g.add(armA2);
    var armB = box(1.0, 2.0, 1.0, '#3f9f4f');
    armB.position.set(1.2, 3.4, 0); g.add(armB);
    return g;
  }

  function makeCandyProp(kind) {
    var g = new T.Group();
    if (kind === 'lollipop') {
      var stick = cyl(0.22, 0.22, 6, '#ffffff', 8);
      stick.position.y = 3; g.add(stick);
      var head = cyl(2.2, 2.2, 0.6, '#ff5fa2', 16);
      head.rotation.x = Math.PI / 2;
      head.position.y = 6.6; g.add(head);
      var swirl = cyl(1.4, 1.4, 0.7, '#fff0f6', 16);
      swirl.rotation.x = Math.PI / 2;
      swirl.position.set(0, 6.6, 0.05); g.add(swirl);
    } else {
      var body = box(5.5, 2.6, 2.6, '#c04fff');
      body.position.y = 1.6; g.add(body);
      [-3.4, 3.4].forEach(function (x) {
        var wrap = cone(1.4, 1.8, '#ff9ad5', 6);
        wrap.rotation.z = x > 0 ? -Math.PI / 2 : Math.PI / 2;
        wrap.position.set(x, 1.6, 0);
        g.add(wrap);
      });
      var stripe = box(1.0, 2.7, 2.7, '#ffffff');
      stripe.position.set(0, 1.6, 0); g.add(stripe);
    }
    return g;
  }

  function makeIceCrystal(scale) {
    var g = new T.Group();
    var s = scale || 1;
    var c = cone(1.2 * s, 5 * s, '#8fd8ff', 6, { opacity: 0.92 });
    c.position.y = 2.5 * s; g.add(c);
    var c2 = cone(0.7 * s, 3 * s, '#cfeeff', 6, { opacity: 0.92 });
    c2.position.set(1.2 * s, 1.5 * s, 0.5 * s);
    c2.rotation.z = 0.2; g.add(c2);
    return g;
  }

  function makeLavaRock() {
    var g = new T.Group();
    var r = box(3, 2, 2.6, '#3a221c', { flat: true });
    r.position.y = 1; g.add(r);
    var glow = box(2.4, 0.3, 2.0, '#ff5a1f', { emissive: '#ff3b00' });
    glow.position.y = 2.05; g.add(glow);
    return g;
  }

  function makeCloudProp(scale) {
    var g = new T.Group();
    var s = scale || 1;
    var m = mat('#ffffff', { opacity: 0.95 });
    for (var i = 0; i < 5; i++) {
      var p = new T.Mesh(new T.BoxGeometry((3 + Math.random() * 3) * s, (1.6 + Math.random()) * s, (2.6 + Math.random() * 2) * s), m);
      p.position.set((Math.random() - 0.5) * 6 * s, (Math.random() - 0.5) * 1.2 * s, (Math.random() - 0.5) * 4 * s);
      g.add(p);
    }
    return g;
  }

  /* ---------------- Указатели и таблички ---------------- */
  function fitLabelFont(text, opts) {
    var size = opts.fontSize || 84;
    var lines = String(text).split('\n');
    var ctx = U.canvas(1, 1).getContext('2d');
    ctx.font = '900 ' + size + 'px Nunito, Arial Black, sans-serif';
    var width = 0;
    for (var i = 0; i < lines.length; i++) width = Math.max(width, ctx.measureText(lines[i]).width);
    var available = (opts.tw || 640) - 2 * (opts.outlineWidth || 16) - 18;
    if (width > available) size *= available / width;
    return Math.min(size, ((opts.th || 160) - 20) / (lines.length * 1.05));
  }

  function makeLabel(text, opts) {
    opts = opts || {};
    var tex = new T.CanvasTexture(U.signTexture(text, {
      width: opts.tw || 640, height: opts.th || 160,
      fontSize: fitLabelFont(text, opts),
      color: opts.color || '#ffffff',
      outlineColor: opts.outlineColor || '#2a1a06',
      outlineWidth: opts.outlineWidth || 16,
      bg: opts.bg, border: opts.border, borderWidth: opts.borderWidth, radius: opts.radius
    }));
    tex.needsUpdate = true;
    var w = opts.w || 9;
    var labelHeight = w * ((opts.th || 160) / (opts.tw || 640));
    var spr = opts.fixed
      ? new T.Mesh(new T.PlaneGeometry(w, labelHeight), new T.MeshBasicMaterial({ map: tex, transparent: true, side: T.DoubleSide }))
      : new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: opts.depthTest !== false }));
    if (!opts.fixed) spr.scale.set(w, labelHeight, 1);
    spr.userData.setText = function (newText) {
      var c = U.signTexture(newText, {
        width: opts.tw || 640, height: opts.th || 160,
        fontSize: fitLabelFont(newText, opts),
        color: opts.color || '#ffffff',
        outlineColor: opts.outlineColor || '#2a1a06',
        outlineWidth: opts.outlineWidth || 16,
        bg: opts.bg, border: opts.border, borderWidth: opts.borderWidth, radius: opts.radius
      });
      spr.material.map.image = c;
      spr.material.map.needsUpdate = true;
    };
    return spr;
  }

  /* Табличка на стойке (как «Открыть: $500») */
  function makeSignPost(w, h) {
    var g = new T.Group();
    var post = box(0.5, 2.4, 0.5, '#4a5464');
    post.position.y = 1.2;
    g.add(post);
    var board = box(w || 7, h || 3.2, 0.4, '#183674', { studs: true });
    board.position.y = (h || 3.2) / 2 + 2.2;
    g.add(board);
    var frame = box((w || 7) + 0.4, (h || 3.2) + 0.4, 0.2, '#1b3768');
    frame.position.set(0, (h || 3.2) / 2 + 2.2, -0.12);
    g.add(frame);
    return { group: g, board: board, labelY: (h || 3.2) / 2 + 2.2 };
  }

  /* Жёлтая стрелка-указатель на земле */
  function makeArrow() {
    var g = new T.Group();
    var canvas = U.canvas(128, 128), ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#3c4218'; ctx.lineWidth = 30; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(27, 83); ctx.lineTo(64, 45); ctx.lineTo(101, 83); ctx.stroke();
    ctx.strokeStyle = '#ffff37'; ctx.lineWidth = 22; ctx.stroke();
    var map = new T.CanvasTexture(canvas);
    var arrow = new T.Mesh(new T.PlaneGeometry(4.9, 4.9), new T.MeshBasicMaterial({ map: map, transparent: true, depthWrite: false }));
    arrow.rotation.x = -Math.PI / 2; arrow.rotation.z = Math.PI;
    g.add(arrow);
    return g;
  }

  function makeCoin() {
    var g = new T.Group();
    var c = cyl(0.55, 0.55, 0.16, '#ffd24a', 12, { emissive: '#8a5a00' });
    c.rotation.x = Math.PI / 2;
    g.add(c);
    var inner = cyl(0.36, 0.36, 0.2, '#ffe98a', 12, { emissive: '#a07a00' });
    inner.rotation.x = Math.PI / 2;
    g.add(inner);
    return g;
  }

  /* Ворота-барьер зоны */
  function makeGate(colorA, colorB) {
    var g = new T.Group();
    [-5, 5].forEach(function (x) {
      var p = box(1.4, 7, 1.4, '#5a3a22');
      p.position.set(x, 3.5, 0);
      g.add(p);
    });
    var bar = box(11, 1.6, 1.0, colorA || '#ff3b30');
    bar.position.y = 5.6;
    g.add(bar);
    for (var i = 0; i < 6; i++) {
      var s = box(1.5, 1.65, 1.05, i % 2 ? '#ffffff' : (colorB || '#ff3b30'));
      s.position.set(-4.5 + i * 1.8, 4.0, 0);
      g.add(s);
    }
    return g;
  }

  SE.Models = {
    mat: mat, box: box, cyl: cyl, sph: sph, cone: cone, at: at,
    studTexture: studTexture, studMat: studMat,
    makeCharacter: makeCharacter,
    makeEyeAnim: makeEyeAnim,
    CHAR_UV: CHAR_UV,
    CHAR_DIMS: CH,
    CHAR_FACES: FACES,
    remapBoxUV: remapBoxUV,
    canvasTexture: canvasTexture,
    shadeHex: shadeHex,
    toyShade: toyShade,
    coloredGeo: coloredGeo,
    vertexColorMat: vertexColorMat,
    makeGuard: makeGuard,
    GUARD_STYLES: GUARD_STYLES,
    makePet: makePet,
    makeEgg: makeEgg,
    makeNest: makeNest,
    fenceSegment: fenceSegment,
    fenceRect: fenceRect,
    makeStall: makeStall,
    makeTreadmill: makeTreadmill,
    makeTrailStand: makeTrailStand,
    makeTree: makeTree,
    makeBush: makeBush,
    makeRock: makeRock,
    makeCactus: makeCactus,
    makeCandyProp: makeCandyProp,
    makeIceCrystal: makeIceCrystal,
    makeLavaRock: makeLavaRock,
    makeCloudProp: makeCloudProp,
    makeLabel: makeLabel,
    makeSignPost: makeSignPost,
    makeArrow: makeArrow,
    makeCoin: makeCoin,
    makeGate: makeGate
  };
})(window);
