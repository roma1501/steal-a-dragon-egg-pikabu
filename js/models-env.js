/* =========================================================================
   Steal a Dragon Egg — environment builders (SE.Env)

   Blocky "Roblox stud" look + voxel fantasy decor used by world.js. No game
   logic here: every builder returns plain THREE objects. Static objects are
   meant to be baked into one merged mesh per material with SE.Env.Batch.

   Textures (shared, neutral grey, tinted by material colour; UVs in world units)
     tex.stud()  ground/wall studs      tex.wall()  big alternating wall blocks
     tex.cobble() cobblestone path      tex.lava()  scrolling lava (emissive)
     tex.belt()  treadmill belt stripes  tex.banners() banner atlas (6 species + neutral)
   Materials (cached by parameters → identical params share one material = one batch)
     mat(color, {rough, metal, emissive, emissiveIntensity, flat, transparent, opacity, side, fog})
     studMat(color[, {layer}]), wallMat(color), groundMat(color), cobbleMat(color[, {layer}])
       layer n → polygonOffset −n (ground overlays: pads 1, paths 2, decals 3) — never z-fights with the ground below
   Geometry
     box(w, h, d, material[, uvTile])  Mesh with a box; uvTile → UVs in world units (tiling textures)
     at(obj, x, y, z[, ry])            position (+ yaw) helper, returns obj
     groundPlane(x0, z0, x1, z1, mat, uvTile, y)   ground rectangle with WORLD-SPACE UVs (one aligned stud grid everywhere)
     worldBox(cx, cy, cz, w, h, d, mat, uvTile)    box with world-space UVs (walls / caps: seamless where pieces meet)
   Batching
     new Batch().add(object3D, { cast, receive, override:Material, remap:{ matName: Material } })
     batch.build() -> THREE.Group      one merged Mesh per (material, cast) pair, matrixAutoUpdate off
     batch.stats -> { meshes, tris }
   Decor builders (rng = () => 0..1; all return THREE.Group, origin on the ground)
     voxelTree(rng, {scale, leaf, leaf2, trunk, snow, tall}), pineTree(rng, {scale, snow, leaf}),
     bush(rng, {color, scale}), rock(rng, {color, scale}), flower(rng, color), grassTuft(rng, color),
     giantMushroom(rng, {cap, spots, stem, scale}), mossLog(rng, {wood, moss}), cactus(rng),
     dune(rng, {color, scale, size (exact)}), sandPillar(rng, {color}), amberCrystal(rng, {scale}), bones(rng),
     iceCrystal(rng, {scale}), obsidianSpike(rng, {scale}), lavaPool(w, d), goldPillar(rng, broken),
     ruinArch(rng), floatingCrystalGeo(), vine(h), torch(), lanternPost(), bannerPole(h),
     fenceLine(x0, z0, x1, z1, {post, rail, h}) -> { group, length },
     nest(rng, {scale}) (twig nest built from prop.great_nest when loaded), coinStack(n)
   Labelled / animated props
     textTexture(w, h, draw(ctx, w, h)) -> { texture, canvas, ctx, redraw(draw?) }
     fitText(ctx, text, maxW, size[, weight, maxH]) (ink width incl. outline), outlinedText(ctx, text, cx, cy, size, fill,
       stroke, maxW[, lw, maxH]) -> { size, w }, iconText(ctx, { x0, x1, cy, maxH, text, drawIcon, iconW, … }) (icon + text
       row measured and centred, never overlapping), boardPad(w, h[, noBoard]) -> { x, y } inner padding of a board
     signBoard({ w, h, style:'wood'|'navy'|'orange'|'stone', text|draw }) -> { mesh, setText(t), redraw() }
     textSprite(text, { size, color, bg, scale }) -> Sprite with userData.setText(text, color)
     stall({ stripeA, stripeB, title }) -> { group, sign }
     treadmill() -> { group, beltTexture }        (belt length along Z, top at y 0.6)
     upgradeBoard() -> { group, setText(levelText, priceText, title) }
     wheelStand() -> { group, wheel }             (wheel spins around its local Z)
     chest() -> { group, model, lid, gem, inner, glow, glb }   prop.gift_chest (Blender) when loaded, else a simple box chest
     bannerMesh(speciesIndex|-1) -> Mesh; setBannerEmblem(mesh, idx)  (UV into the banner atlas)
   Sky
     skyDome(radius) -> Mesh (ShaderMaterial; uniforms top, horizon, bottom, sunDir, sunColor, stars, time)
     clouds(rng, count) -> Mesh (one draw call, voxel clouds; rotate the mesh slowly)
   Kenney (optional GLBs registered by SE.World.registerAssets)
     kenney(key) -> Object3D|null (null when not loaded), NATURE_COLORS (material name → colour)
     castle(rng) -> Group (Kenney Castle Kit pieces measured & stacked flush, or a procedural fallback)
   ========================================================================= */
(function (global) {
  'use strict';
  const SE = global.SE = global.SE || {};
  const T = global.THREE;

  /* ------------------------------------------------------------------ */
  /* small helpers                                                        */
  /* ------------------------------------------------------------------ */
  function seeded(seed) {
    let s = (seed >>> 0) || 1;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function at(o, x, y, z, ry) { o.position.set(x, y, z); if (ry) o.rotation.y = ry; return o; }
  function rr(rng, a, b) { return a + rng() * (b - a); }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  // 'SE Nunito' is the game's @font-face name (css/base.css), 'Nunito' the labs' one
  const FONT = '"SE Nunito", "Nunito", "Arial Black", "Segoe UI", sans-serif';
  let ANISO = 4;

  function canvasTex(c, repeat) {
    const t = new T.CanvasTexture(c);
    t.encoding = T.sRGBEncoding;
    t.anisotropy = ANISO;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; }
    return t;
  }

  /* ------------------------------------------------------------------ */
  /* textures                                                             */
  /* ------------------------------------------------------------------ */
  const texCache = {};
  const tex = {
    /* 4×4 raised studs on a light grey tile (multiplied by the material colour). Perfectly periodic: every stud
       sits centred in its 64 px cell, no tile border / seam lines, so neighbouring tiles (and every ground
       layer using world-space UVs, see groundPlane) form ONE continuous stud grid (1 stud = uvTile / 4). */
    stud: function () {
      if (texCache.stud) return texCache.stud;
      const S = 256, n = 4, step = S / n, c = canvas(S, S), g = c.getContext('2d');
      g.fillStyle = 'rgb(236,236,236)'; g.fillRect(0, 0, S, S);
      const sw = Math.round(step * 0.54), o = Math.round((step - sw) / 2), b = 4;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const sx = x * step + o, sy = y * step + o;
        g.fillStyle = 'rgba(0,0,0,0.13)'; roundRect(g, sx + 2, sy + 3, sw, sw, 6); g.fill();          // soft drop shadow
        g.fillStyle = 'rgb(247,247,247)'; roundRect(g, sx, sy, sw, sw, 6); g.fill();                  // stud top
        g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(sx + 5, sy + 2, sw - 10, b - 1); g.fillRect(sx + 2, sy + 5, b - 1, sw - 10);
        g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(sx + 5, sy + sw - b + 1, sw - 10, b - 1); g.fillRect(sx + sw - b + 1, sy + 5, b - 1, sw - 10);
      }
      return (texCache.stud = canvasTex(c, true));
    },
    /* Big 2×2 block tiles with alternating shade + one stud per block (stud walls of the refs). */
    wall: function () {
      if (texCache.wall) return texCache.wall;
      const S = 256, h = S / 2, c = canvas(S, S), g = c.getContext('2d');
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        const v = (x + y) % 2 ? 236 : 222;
        g.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; g.fillRect(x * h, y * h, h, h);
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x * h, y * h, h, 5); g.fillRect(x * h, y * h, 5, h);
        g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x * h, y * h + h - 5, h, 5); g.fillRect(x * h + h - 5, y * h, 5, h);
        const s0 = h * 0.3, sw = h * 0.4, ox = x * h + s0, oy = y * h + s0;
        g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(ox + 5, oy + 5, sw, sw);
        g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(ox, oy, sw, sw);
      }
      return (texCache.wall = canvasTex(c, true));
    },
    cobble: function () {
      if (texCache.cobble) return texCache.cobble;
      const S = 256, c = canvas(S, S), g = c.getContext('2d'), rng = seeded(77);
      g.fillStyle = 'rgb(150,140,128)'; g.fillRect(0, 0, S, S);
      const rows = 6, rh = S / rows;
      for (let r = 0; r < rows; r++) {
        let x = r % 2 ? -rh * 0.5 : 0;
        while (x < S) {
          const w = rh * (0.9 + rng() * 0.7), v = 215 + Math.floor(rng() * 30);
          const draw = function (ox) {
            g.fillStyle = 'rgb(' + v + ',' + (v - 6) + ',' + (v - 16) + ')';
            roundRect(g, ox + 3, r * rh + 3, w - 6, rh - 6, 8); g.fill();
            g.fillStyle = 'rgba(255,255,255,0.25)'; roundRect(g, ox + 6, r * rh + 5, w - 14, 5, 3); g.fill();
          };
          draw(x); if (x + w > S) draw(x - S);
          x += w;
        }
      }
      return (texCache.cobble = canvasTex(c, true));
    },
    lava: function () {
      if (texCache.lava) return texCache.lava;
      const S = 128, c = canvas(S, S), g = c.getContext('2d'), rng = seeded(5);
      g.fillStyle = '#e8400a'; g.fillRect(0, 0, S, S);
      for (let i = 0; i < 60; i++) {
        const x = rng() * S, y = rng() * S, r = 4 + rng() * 14;
        const col = rng() < 0.5 ? 'rgba(255,190,40,0.55)' : (rng() < 0.5 ? 'rgba(255,240,140,0.5)' : 'rgba(120,20,0,0.45)');
        for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) {
          g.fillStyle = col; g.beginPath(); g.ellipse(x + ox, y + oy, r, r * 0.6, rng() * 3, 0, Math.PI * 2); g.fill();
        }
      }
      return (texCache.lava = canvasTex(c, true));
    },
    belt: function () {
      const c = canvas(64, 64), g = c.getContext('2d');
      g.fillStyle = '#2a2d34'; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#3d414b'; for (let y = 0; y < 64; y += 16) g.fillRect(0, y, 64, 6);
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, 0, 64, 2);
      return canvasTex(c, true);
    },
    /* Banner atlas: 7 cells (6 species emblems + neutral egg), each 64×128. */
    banners: function () {
      if (texCache.banners) return texCache.banners;
      const CW = 64, CH = 128, c = canvas(CW * 8, CH), g = c.getContext('2d');
      const SPEC = [
        ['#4f9a2a', '#f0e2b6', 'leaf'], ['#2f6e44', '#3fd6d0', 'mushroom'], ['#d0781a', '#ffe08a', 'sun'],
        ['#2f6fd6', '#ffffff', 'flake'], ['#b02a14', '#ffb040', 'flame'], ['#1f3a9a', '#f0c040', 'star'],
        ['#a88a5c', '#f6ead0', 'egg']
      ];
      SPEC.forEach(function (s, i) {
        const x0 = i * CW;
        g.save(); g.beginPath();
        g.moveTo(x0 + 2, 0); g.lineTo(x0 + CW - 2, 0); g.lineTo(x0 + CW - 2, CH - 2); g.lineTo(x0 + CW / 2, CH - 22); g.lineTo(x0 + 2, CH - 2); g.closePath();
        g.fillStyle = s[0]; g.fill();
        g.lineWidth = 5; g.strokeStyle = '#e8b830'; g.stroke(); g.clip();
        g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x0, 0, CW, 10);
        drawEmblem(g, s[2], x0 + CW / 2, 52, 19, s[1]);
        g.restore();
      });
      const t = canvasTex(c, false);
      return (texCache.banners = t);
    }
  };

  function roundRect(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  function drawEmblem(g, kind, cx, cy, r, color) {
    g.save(); g.fillStyle = color; g.strokeStyle = color; g.lineCap = 'round'; g.lineJoin = 'round';
    if (kind === 'leaf') {
      g.beginPath(); g.moveTo(cx, cy - r * 1.2); g.quadraticCurveTo(cx + r * 1.1, cy - r * 0.2, cx, cy + r * 1.1);
      g.quadraticCurveTo(cx - r * 1.1, cy - r * 0.2, cx, cy - r * 1.2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(cx, cy - r * 0.9); g.lineTo(cx, cy + r * 1.2); g.stroke();
    } else if (kind === 'mushroom') {
      g.beginPath(); g.arc(cx, cy, r, Math.PI, 0); g.closePath(); g.fill();
      g.fillStyle = '#f6ead0'; g.fillRect(cx - r * 0.3, cy, r * 0.6, r * 0.9);
      g.beginPath(); g.arc(cx - r * 0.4, cy - r * 0.45, r * 0.18, 0, 7); g.arc(cx + r * 0.35, cy - r * 0.6, r * 0.14, 0, 7); g.fill();
    } else if (kind === 'sun') {
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4; g.lineWidth = 4;
        g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.7, cy + Math.sin(a) * r * 0.7); g.lineTo(cx + Math.cos(a) * r * 1.2, cy + Math.sin(a) * r * 1.2); g.stroke();
      }
      g.beginPath(); g.moveTo(cx, cy - r * 0.6); g.lineTo(cx + r * 0.5, cy); g.lineTo(cx, cy + r * 0.6); g.lineTo(cx - r * 0.5, cy); g.closePath(); g.fill();
    } else if (kind === 'flake') {
      g.lineWidth = 4;
      for (let k = 0; k < 3; k++) {
        const a = k * Math.PI / 3, dx = Math.cos(a) * r * 1.1, dy = Math.sin(a) * r * 1.1;
        g.beginPath(); g.moveTo(cx - dx, cy - dy); g.lineTo(cx + dx, cy + dy); g.stroke();
        for (const sgn of [-1, 1]) {
          const bx = cx + sgn * dx * 0.6, by = cy + sgn * dy * 0.6, a2 = a + Math.PI / 2;
          g.lineWidth = 3; g.beginPath(); g.moveTo(bx + Math.cos(a2) * r * 0.3, by + Math.sin(a2) * r * 0.3);
          g.lineTo(bx - Math.cos(a2) * r * 0.3, by - Math.sin(a2) * r * 0.3); g.stroke(); g.lineWidth = 4;
        }
      }
    } else if (kind === 'flame') {
      g.beginPath(); g.moveTo(cx, cy - r * 1.3);
      g.bezierCurveTo(cx + r * 1.2, cy - r * 0.2, cx + r * 0.9, cy + r * 1.1, cx, cy + r * 1.1);
      g.bezierCurveTo(cx - r * 0.9, cy + r * 1.1, cx - r * 1.1, cy, cx - r * 0.3, cy - r * 0.5);
      g.quadraticCurveTo(cx - r * 0.2, cy, cx, cy - r * 1.3); g.fill();
      g.fillStyle = '#fff2a0'; g.beginPath(); g.ellipse(cx, cy + r * 0.5, r * 0.35, r * 0.5, 0, 0, 7); g.fill();
    } else if (kind === 'star') {
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + k * Math.PI / 5, rad = k % 2 ? r * 0.45 : r * 1.15;
        g.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      }
      g.closePath(); g.fill();
    } else {
      g.beginPath(); g.ellipse(cx, cy + 2, r * 0.75, r, 0, 0, 7); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.15)'; g.beginPath(); g.ellipse(cx + 4, cy + 6, r * 0.4, r * 0.6, 0, 0, 7); g.fill();
    }
    g.restore();
  }

  /* ------------------------------------------------------------------ */
  /* materials                                                            */
  /* ------------------------------------------------------------------ */
  const matCache = {};
  function mat(color, o) {
    o = o || {};
    const key = 'm|' + color + '|' + JSON.stringify(o);
    if (matCache[key]) return matCache[key];
    const m = new T.MeshStandardMaterial({
      color: color, roughness: o.rough !== undefined ? o.rough : 0.88, metalness: o.metal || 0,
      flatShading: o.flat !== false
    });
    if (o.emissive) { m.emissive = new T.Color(o.emissive); m.emissiveIntensity = o.emissiveIntensity !== undefined ? o.emissiveIntensity : 1; }
    if (o.transparent) { m.transparent = true; m.opacity = o.opacity !== undefined ? o.opacity : 0.7; m.depthWrite = !!o.depthWrite; }
    if (o.side === 'double') m.side = T.DoubleSide;
    if (o.fog === false) m.fog = false;
    if (o.map) m.map = o.map;
    if (o.emissiveMap) m.emissiveMap = o.emissiveMap;
    if (o.alphaTest) m.alphaTest = o.alphaTest;
    if (o.layer) layerize(m, o.layer);
    m.name = o.name || ('env_' + color);
    return (matCache[key] = m);
  }
  /* o.layer = n (1, 2 …): ground overlay drawn over lower layers without z-fighting (polygonOffset −n),
     use it for pads / paths lying (almost) flat on another ground plane. */
  function texturedMat(kind, color, o) {
    const key = 't|' + kind + '|' + color + '|' + JSON.stringify(o || {});
    if (matCache[key]) return matCache[key];
    o = o || {};
    const m = new T.MeshStandardMaterial({ color: color, map: tex[kind](), roughness: o.rough !== undefined ? o.rough : 0.92, metalness: 0 });
    m.name = 'env_' + kind + '_' + color + (o.layer ? '_L' + o.layer : '');
    if (o.layer) layerize(m, o.layer);
    return (matCache[key] = m);
  }
  function layerize(m, n) { m.polygonOffset = true; m.polygonOffsetFactor = -n; m.polygonOffsetUnits = -2 * n; return m; }
  const studMat = function (color, o) { return texturedMat('stud', color, o); };
  const wallMat = function (color, o) { return texturedMat('wall', color, o); };
  const groundMat = studMat;
  const cobbleMat = function (color, o) { return texturedMat('cobble', color || '#ffffff', o); };

  /* ------------------------------------------------------------------ */
  /* geometry                                                             */
  /* ------------------------------------------------------------------ */
  const unitBox = new T.BoxGeometry(1, 1, 1);
  /* Box mesh; with uvTile the UVs are in world units / uvTile (seamless tiling across merged boxes). */
  function box(w, h, d, material, uvTile) {
    if (!uvTile) {
      const m = new T.Mesh(unitBox, material);
      m.scale.set(w, h, d);
      return m;
    }
    const g = new T.BoxGeometry(w, h, d);
    const uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * dims[f][0] / uvTile, uv.getY(i) * dims[f][1] / uvTile);
    }
    return new T.Mesh(g, material);
  }
  /* Flat ground rectangle (top face only) with world-unit UVs. */
  function plane(w, d, material, uvTile) {
    const g = new T.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    if (uvTile) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / uvTile, uv.getY(i) * d / uvTile);
    }
    return new T.Mesh(g, material);
  }
  /* Ground rectangle x0..x1 × z0..z1 at height y with WORLD-SPACE UVs (u = x / uvTile, v = −z / uvTile):
     every ground piece / overlay built with it shares one continuous, aligned texture grid. */
  function groundPlane(x0, z0, x1, z1, material, uvTile, y) {
    const w = x1 - x0, d = z1 - z0, tile = uvTile || 5.6;
    const g = new T.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position, uv = g.attributes.uv, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (cx + pos.getX(i)) / tile, -(cz + pos.getZ(i)) / tile);
    const m = new T.Mesh(g, material);
    m.position.set(cx, y || 0, cz);
    return m;
  }
  /* Box centred at (cx, cy, cz) with WORLD-SPACE UVs on every face (walls, caps): overlapping / touching
     boxes with the same material show the same texels, so seams and coplanar overlaps are invisible. */
  function worldBox(cx, cy, cz, w, h, d, material, uvTile) {
    const g = new T.BoxGeometry(w, h, d), tile = uvTile || 5.6;
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const x = cx + pos.getX(i), y = cy + pos.getY(i), z = cz + pos.getZ(i), nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
      if (Math.abs(nx) > 0.5) uv.setXY(i, -z * Math.sign(nx) / tile, y / tile);
      else if (Math.abs(ny) > 0.5) uv.setXY(i, x / tile, -z * Math.sign(ny) / tile);
      else uv.setXY(i, x * Math.sign(nz) / tile, y / tile);
    }
    const m = new T.Mesh(g, material);
    m.position.set(cx, cy, cz);
    return m;
  }
  function geoMesh(geo, material) { return new T.Mesh(geo, material); }

  /* ------------------------------------------------------------------ */
  /* static batching: merge everything by material                        */
  /* ------------------------------------------------------------------ */
  function matKey(m) {
    if (m.userData.__bk) return m.userData.__bk;
    const img = m.map && m.map.image;
    const mapKey = m.map ? ((img && (img.currentSrc || img.src)) || m.map.uuid) : '';
    const k = [m.type, m.color ? m.color.getHexString() : '', m.emissive ? m.emissive.getHexString() + m.emissiveIntensity : '',
      mapKey, m.emissiveMap ? m.emissiveMap.uuid : '', m.transparent ? 't' + m.opacity : '', m.side, m.alphaTest,
      m.vertexColors ? 'vc' : '', m.roughness, m.metalness, m.flatShading ? 'f' : '', m.fog === false ? 'nf' : '',
      m.polygonOffset ? 'po' + m.polygonOffsetFactor + ',' + m.polygonOffsetUnits : '', m.depthWrite === false ? 'nd' : ''].join('|');
    m.userData.__bk = k;
    return k;
  }
  function plainAttr(attr, itemSize) {
    const n = attr.count, out = new Float32Array(n * itemSize);
    for (let i = 0; i < n; i++) {
      out[i * itemSize] = attr.getX(i);
      if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i);
      if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i);
    }
    return new T.BufferAttribute(out, itemSize);
  }
  function normGeo(src, matrix, withColor) {
    const g = new T.BufferGeometry();
    const pos = src.attributes.position;
    if (!pos) return null;
    g.setAttribute('position', plainAttr(pos, 3));
    if (src.attributes.normal) g.setAttribute('normal', plainAttr(src.attributes.normal, 3));
    g.setAttribute('uv', src.attributes.uv ? plainAttr(src.attributes.uv, 2) : new T.BufferAttribute(new Float32Array(pos.count * 2), 2));
    if (withColor) {
      if (src.attributes.color) g.setAttribute('color', plainAttr(src.attributes.color, 3));
      else { const c = new Float32Array(pos.count * 3).fill(1); g.setAttribute('color', new T.BufferAttribute(c, 3)); }
    }
    if (src.index) g.setIndex(new T.BufferAttribute(new Uint32Array(src.index.array), 1));
    else { const idx = new Uint32Array(pos.count); for (let i = 0; i < pos.count; i++) idx[i] = i; g.setIndex(new T.BufferAttribute(idx, 1)); }
    g.applyMatrix4(matrix);
    if (!src.attributes.normal) g.computeVertexNormals();
    return g;
  }

  /* Colour baking (draw-call budget, SPEC §9): plain untextured opaque MeshStandardMaterials (no emissive, no maps,
     no custom shader) are merged into ONE shared vertex-colour material per (roughness, metalness, flat, side, fog)
     bucket, with the material colour written into the vertex colours (linear, exactly what the material would use).
     A section's dozens of flat-colour decor materials then cost a handful of draw calls instead of one each.
     Opt out per batch with add(obj, { bake:false }) or per material with material.userData.noBake = true. */
  const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'lightMap', 'bumpMap', 'alphaMap',
    'emissiveMap', 'displacementMap', 'envMap'];
  const bakedCache = {};
  const NO_BAKE = /[?&]nobake(?:[=&#]|$)/.test(String((typeof location !== 'undefined' && location.search) || ''));   // QA A/B
  function bakeable(m) {
    if (NO_BAKE || !m || m.type !== 'MeshStandardMaterial' || m.transparent || m.alphaTest > 0 || m.polygonOffset || m.depthWrite === false ||
        m.userData.noBake || m.onBeforeCompile !== T.Material.prototype.onBeforeCompile) return false;
    for (let i = 0; i < MAP_SLOTS.length; i++) if (m[MAP_SLOTS[i]]) return false;
    if (m.emissive && m.emissiveIntensity > 0 && (m.emissive.r + m.emissive.g + m.emissive.b) > 0.004) return false;
    return true;
  }
  function bakedMaterial(m) {
    const rough = Math.round(m.roughness * 10) / 10, metal = Math.round(m.metalness * 10) / 10;
    const key = rough + '|' + metal + '|' + (m.flatShading ? 'f' : 's') + '|' + m.side + '|' + (m.fog === false ? 'nf' : 'f');
    let b = bakedCache[key];
    if (!b) {
      b = bakedCache[key] = new T.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: metal,
        flatShading: !!m.flatShading, side: m.side, fog: m.fog !== false });
      b.name = 'baked';
    }
    return b;
  }
  function tintColors(g, c) {
    const a = g.attributes.color.array;
    for (let i = 0; i < a.length; i += 3) { a[i] *= c.r; a[i + 1] *= c.g; a[i + 2] *= c.b; }
  }

  function Batch() { this.groups = new Map(); this.stats = { meshes: 0, tris: 0, sources: 0 }; }
  Batch.prototype.add = function (obj, o) {
    o = o || {};
    if (!obj) return this;
    obj.updateMatrixWorld(true);
    const self = this, cast = o.cast !== false, receive = o.receive !== false;
    obj.traverse(function (m) {
      if (!m.isMesh || m.isInstancedMesh || m.isSkinnedMesh) return;
      let hidden = false; for (let p = m; p; p = p.parent) if (p.visible === false) { hidden = true; break; }
      if (hidden || Array.isArray(m.material)) return;
      let material = m.material;
      if (o.override) material = typeof o.override === 'function' ? o.override(material, m) : o.override;
      else if (o.remap && material.name && o.remap[material.name]) material = o.remap[material.name];
      if (!material) return;
      const src = material, bake = o.bake !== false && bakeable(material);
      if (bake) material = bakedMaterial(material);
      const key = matKey(material) + (cast ? '|C' : '') + (receive ? '|R' : '');
      let e = self.groups.get(key);
      if (!e) { e = { material: material, geos: [], cast: cast, receive: receive }; self.groups.set(key, e); }
      const g = normGeo(m.geometry, m.matrixWorld, bake || !!material.vertexColors);
      if (!g) return;
      if (bake) {
        if (!src.vertexColors) g.attributes.color.array.fill(1);
        tintColors(g, src.color);
      }
      e.geos.push(g); self.stats.sources++;
    });
    return this;
  };
  Batch.prototype.build = function (name) {
    const group = new T.Group();
    group.name = name || 'batch';
    const merge = T.BufferGeometryUtils.mergeBufferGeometries || T.BufferGeometryUtils.mergeGeometries;
    this.groups.forEach((e) => {
      if (!e.geos.length) return;
      const geo = e.geos.length === 1 ? e.geos[0] : merge(e.geos, false);
      if (!geo) return;
      e.geos.forEach(function (g) { if (g !== geo) g.dispose(); });
      geo.computeBoundingSphere(); geo.computeBoundingBox();
      const mesh = new T.Mesh(geo, e.material);
      mesh.castShadow = e.cast; mesh.receiveShadow = e.receive;
      mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      mesh.name = 'merged:' + (e.material.name || '');
      group.add(mesh);
      this.stats.meshes++; this.stats.tris += geo.index.count / 3;
    });
    this.groups.clear();
    return group;
  };

  /* ------------------------------------------------------------------ */
  /* Kenney models (optional)                                             */
  /* ------------------------------------------------------------------ */
  function kenney(key) {
    const A = SE.Assets;
    if (!A || !A.has || !A.has(key)) return null;
    return A.get(key);
  }
  const NATURE_COLORS = {
    grass: '#5cb83a', leafsGreen: '#4fae3a', leafsDark: '#2f7a32', colorRed: '#ff5a64', colorPurple: '#b07aff',
    colorYellow: '#ffd84a', colorBlue: '#5aa8ff', woodBark: '#7a4a2a', woodInner: '#e3bd85', dirt: '#9a6a3a',
    stone: '#b4aea8', stoneDark: '#7c7570', colorTan: '#e8c890', _defaultMat: '#f4f0e8', wood: '#8b5d3e',
    woodDark: '#5b3d29', woodBarkDark: '#5b3d29', corn: '#f0d060', Water: '#5fc8f0'
  };
  /* Material remap for Nature Kit models: name → cached env material (overrides allowed). */
  function natureRemap(over) {
    const r = {};
    const cols = Object.assign({}, NATURE_COLORS, over || {});
    Object.keys(cols).forEach(function (k) { r[k] = mat(cols[k]); });
    return r;
  }

  /* ------------------------------------------------------------------ */
  /* decor builders                                                       */
  /* ------------------------------------------------------------------ */
  function voxelTree(rng, o) {
    o = o || {};
    const s = o.scale || 1, g = new T.Group();
    const trunk = mat(o.trunk || '#7a4a2a'), leaf = mat(o.leaf || '#4fae3a'), leaf2 = mat(o.leaf2 || '#3e9932');
    const th = (o.tall ? 8 : 5) * s + rng() * 2 * s;
    g.add(at(box(1.7 * s, th, 1.7 * s, trunk), 0, th / 2, 0));
    const c = (6 + rng() * 1.6) * s;
    g.add(at(box(c, c * 0.78, c, leaf), 0, th + c * 0.3, 0));
    g.add(at(box(c * 0.66, c * 0.5, c * 0.66, leaf2), (rng() - 0.5) * s, th + c * 0.9, (rng() - 0.5) * s));
    const n = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const a = rng() * Math.PI * 2, cs = c * (0.36 + rng() * 0.2);
      g.add(at(box(cs, cs, cs, k % 2 ? leaf : leaf2), Math.cos(a) * c * 0.5, th + c * (0.05 + rng() * 0.45), Math.sin(a) * c * 0.5));
    }
    if (o.snow) g.add(at(box(c * 0.7, 0.6 * s, c * 0.7, mat('#ffffff')), 0, th + c * 1.18, 0));
    g.rotation.y = rng() * Math.PI;
    return g;
  }
  function pineTree(rng, o) {
    o = o || {};
    const s = o.scale || 1, g = new T.Group();
    const leaf = mat(o.leaf || '#2f7a46'), snow = mat('#ffffff'), trunk = mat(o.trunk || '#6a4024');
    g.add(at(box(1.4 * s, 4 * s, 1.4 * s, trunk), 0, 2 * s, 0));
    let y = 3 * s;
    const tiers = 3 + Math.floor(rng() * 2);
    for (let k = 0; k < tiers; k++) {
      const w = (7 - k * 1.6) * s, h = 2.6 * s;
      g.add(at(box(w, h, w, leaf), 0, y + h / 2, 0));
      if (o.snow) g.add(at(box(w * 0.86, 0.5 * s, w * 0.86, snow), 0, y + h + 0.2 * s, 0));
      y += h * 0.92;
    }
    g.add(at(box(1.2 * s, 2 * s, 1.2 * s, o.snow ? snow : leaf), 0, y + s, 0));
    g.rotation.y = rng() * Math.PI;
    return g;
  }
  function bush(rng, o) {
    o = o || {};
    const s = o.scale || 1, g = new T.Group(), m = mat(o.color || '#3f9a30'), m2 = mat(o.color2 || '#56b23e');
    const c = (2.6 + rng() * 1.4) * s;
    g.add(at(box(c, c * 0.8, c, m), 0, c * 0.4, 0));
    g.add(at(box(c * 0.7, c * 0.6, c * 0.7, m2), c * 0.45, c * 0.3, c * 0.2));
    if (rng() < 0.4) g.add(at(box(0.5 * s, 0.5 * s, 0.5 * s, mat(o.berry || '#ff5a64')), c * 0.2, c * 0.82, c * 0.35));
    g.rotation.y = rng() * Math.PI;
    return g;
  }
  const dodeca = new T.DodecahedronGeometry(1, 0);
  function rock(rng, o) {
    o = o || {};
    const s = (o.scale || 1) * (1 + rng() * 0.8), g = new T.Group(), m = mat(o.color || '#9d9790');
    const r1 = new T.Mesh(dodeca, m); r1.scale.set(2.2 * s, 1.5 * s, 1.9 * s); r1.position.y = 0.8 * s; r1.rotation.set(rng(), rng() * 3, rng());
    g.add(r1);
    if (rng() < 0.6) { const r2 = new T.Mesh(dodeca, m); r2.scale.set(1.1 * s, 0.9 * s, 1.2 * s); r2.position.set(2 * s, 0.4 * s, 0.6 * s); r2.rotation.set(rng(), rng(), rng()); g.add(r2); }
    if (o.cap) { const c = new T.Mesh(dodeca, mat(o.cap)); c.scale.set(1.9 * s, 0.5 * s, 1.6 * s); c.position.y = 1.9 * s; c.rotation.y = rng() * 3; g.add(c); }
    return g;
  }
  function flower(rng, color) {
    const k = ['kenney.nature.flower_redA', 'kenney.nature.flower_yellowA', 'kenney.nature.flower_purpleA'];
    const pick = color === 'yellow' ? 1 : color === 'purple' ? 2 : color === 'red' ? 0 : Math.floor(rng() * 3);
    const kn = kenney(k[pick]);
    if (kn) { const s = 7 + rng() * 3; kn.scale.set(s, s, s); kn.rotation.y = rng() * 6.28; const g = new T.Group(); g.add(kn); g.userData.nature = true; return g; }
    const g = new T.Group(), cols = ['#ff5a64', '#ffd84a', '#b07aff', '#ffffff', '#ff9ad0'];
    const c = mat(cols[Math.floor(rng() * cols.length)]);
    g.add(at(box(0.25, 1.4, 0.25, mat('#3f9a30')), 0, 0.7, 0));
    g.add(at(box(0.9, 0.35, 0.9, c), 0, 1.5, 0));
    g.add(at(box(0.4, 0.4, 0.4, mat('#ffe14a')), 0, 1.6, 0));
    return g;
  }
  function grassTuft(rng, color) {
    const kn = kenney('kenney.nature.grass_large');
    if (kn) { const s = 7 + rng() * 4; kn.scale.set(s, s, s); kn.rotation.y = rng() * 6.28; const g = new T.Group(); g.add(kn); g.userData.nature = true; return g; }
    const g = new T.Group(), m = mat(color || '#56b23e');
    for (let k = 0; k < 3; k++) g.add(at(box(0.35, 1 + rng(), 0.35, m), (rng() - 0.5) * 1.2, 0.6, (rng() - 0.5) * 1.2));
    return g;
  }
  const capGeo = new T.SphereGeometry(1, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  function giantMushroom(rng, o) {
    o = o || {};
    const s = (o.scale || 1) * (0.8 + rng() * 0.6), g = new T.Group();
    const stemH = 6 * s;
    const stem = new T.Mesh(new T.CylinderGeometry(0.9 * s, 1.3 * s, stemH, 7), mat(o.stem || '#efe6cf'));
    stem.position.y = stemH / 2; g.add(stem);
    const cap = new T.Mesh(capGeo, mat(o.cap || '#2fc8c0', { emissive: o.cap || '#2fc8c0', emissiveIntensity: 0.18 }));
    cap.scale.set(4.2 * s, 2.6 * s, 4.2 * s); cap.position.y = stemH - 0.4 * s; g.add(cap);
    const under = new T.Mesh(new T.CylinderGeometry(4.0 * s, 1.2 * s, 0.8 * s, 9), mat('#cdeee6'));
    under.position.y = stemH - 0.6 * s; g.add(under);
    const spot = mat(o.spots || '#e6fffb');
    for (let k = 0; k < 5; k++) {
      const a = rng() * 6.28, el = 0.35 + rng() * 0.8, r = 4.2 * s;
      const sp = box(0.9 * s, 0.4 * s, 0.9 * s, spot);
      sp.position.set(Math.cos(a) * Math.cos(el) * r, stemH - 0.4 * s + Math.sin(el) * 2.6 * s, Math.sin(a) * Math.cos(el) * r);
      sp.lookAt(0, stemH - 3 * s, 0); g.add(sp);
    }
    g.rotation.z = (rng() - 0.5) * 0.18;
    return g;
  }
  function mossLog(rng, o) {
    o = o || {};
    const g = new T.Group(), s = o.scale || 1;
    const L = (7 + rng() * 4) * s;
    const log = new T.Mesh(new T.CylinderGeometry(1.2 * s, 1.3 * s, L, 7), mat(o.wood || '#6a4628'));
    log.rotation.z = Math.PI / 2; log.position.y = 1.15 * s; g.add(log);
    const ring = new T.Mesh(new T.CylinderGeometry(1.0 * s, 1.0 * s, 0.1, 7), mat('#d8b07a'));
    ring.rotation.z = Math.PI / 2; ring.position.set(L / 2 + 0.03, 1.15 * s, 0); g.add(ring);
    g.add(at(box(L * 0.7, 0.5 * s, 2.0 * s, mat(o.moss || '#4fa83a')), -L * 0.08, 2.35 * s, 0));
    g.add(at(box(L * 0.3, 0.4 * s, 1.4 * s, mat(o.moss || '#4fa83a')), L * 0.2, 2.55 * s, 0.2));
    g.rotation.y = rng() * Math.PI;
    return g;
  }
  function cactus(rng) {
    const g = new T.Group(), m = mat('#4f9a3a'), m2 = mat('#3f8a30');
    const h = 6 + rng() * 4;
    g.add(at(box(1.8, h, 1.8, m), 0, h / 2, 0));
    const arms = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < arms; k++) {
      const side = k ? -1 : 1, y = h * (0.4 + rng() * 0.25), ah = 2.5 + rng() * 2;
      g.add(at(box(1.8, 1.2, 1.2, m2), side * 1.7, y, 0));
      g.add(at(box(1.2, ah, 1.2, m), side * 2.5, y + ah / 2 - 0.4, 0));
    }
    if (rng() < 0.4) g.add(at(box(0.8, 0.6, 0.8, mat('#ff7ab0')), 0, h + 0.3, 0));
    g.rotation.y = rng() * Math.PI;
    return g;
  }
  function dune(rng, o) {
    o = o || {};
    const s = o.size !== undefined ? o.size : (o.scale || 1) * (1 + rng()), m = new T.Mesh(dodeca, mat(o.color || '#f0c470'));
    m.scale.set(9 * s, 2.2 * s, 6 * s); m.position.y = -0.4 * s; m.rotation.y = rng() * 3;
    const g = new T.Group(); g.add(m); return g;
  }
  function sandPillar(rng, o) {
    o = o || {};
    const g = new T.Group(), a = mat(o.color || '#d9a85a'), b = mat(o.color2 || '#c48e45');
    let y = 0; const n = 3 + Math.floor(rng() * 4);
    for (let k = 0; k < n; k++) {
      const w = 4.2 - k * 0.25 + rng() * 0.6, h = 2.4 + rng() * 1.2;
      const p = box(w, h, w, k % 2 ? a : b); p.position.set((rng() - 0.5) * 0.6, y + h / 2, (rng() - 0.5) * 0.6); p.rotation.y = rng() * 0.4;
      g.add(p); y += h;
    }
    if (rng() < 0.5) g.add(at(box(5.4, 1, 5.4, a), 0, y + 0.5, 0));
    return g;
  }
  const octa = new T.OctahedronGeometry(1, 0);
  function amberCrystal(rng, o) {
    o = o || {};
    const s = (o.scale || 1) * (0.8 + rng() * 0.7), g = new T.Group();
    const m = mat('#ffa21a', { emissive: '#ff7a00', emissiveIntensity: 0.45, rough: 0.35, metal: 0.1 });
    const n = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const c = new T.Mesh(octa, m); const h = (2 + rng() * 2.5) * s;
      c.scale.set(0.9 * s, h, 0.9 * s); c.position.set((rng() - 0.5) * 2.5 * s, h * 0.7, (rng() - 0.5) * 2.5 * s);
      c.rotation.set((rng() - 0.5) * 0.7, rng() * 3, (rng() - 0.5) * 0.7); g.add(c);
    }
    g.add(at(box(3 * s, 0.8 * s, 3 * s, mat('#8a5a2a')), 0, 0.3 * s, 0));
    return g;
  }
  function bones(rng) {
    const g = new T.Group(), m = mat('#f4ecd8');
    const L = 9 + rng() * 5;
    g.add(at(box(L, 0.8, 0.8, m), 0, 0.5, 0));
    for (let k = 0; k < 5; k++) {
      const x = -L / 2 + 1.5 + k * (L - 3) / 4, h = 4 - Math.abs(k - 2) * 0.6;
      for (const sd of [-1, 1]) {
        const rib = box(0.5, h, 0.5, m); rib.position.set(x, h / 2, sd * 1.4); rib.rotation.x = sd * 0.5; g.add(rib);
      }
    }
    const skull = box(2.4, 2, 2.2, m); skull.position.set(L / 2 + 1.2, 1.1, 0); g.add(skull);
    g.add(at(box(1.6, 0.9, 1.6, m), L / 2 + 2.6, 0.6, 0));
    g.rotation.y = rng() * Math.PI;
    return g;
  }
  function iceCrystal(rng, o) {
    o = o || {};
    const s = (o.scale || 1) * (0.8 + rng() * 0.8), g = new T.Group();
    const m = mat('#a8e4ff', { rough: 0.15, metal: 0.05, emissive: '#5ab8ff', emissiveIntensity: 0.25 });
    const m2 = mat('#e6f8ff', { rough: 0.2 });
    const n = 3 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const h = (3 + rng() * 5) * s, r = (0.7 + rng() * 0.5) * s;
      const c = new T.Mesh(new T.CylinderGeometry(0, r, h * 0.35, 6), k % 3 ? m : m2);
      const body = new T.Mesh(new T.CylinderGeometry(r, r * 1.05, h, 6), k % 3 ? m : m2);
      const p = new T.Group(); body.position.y = h / 2; c.position.y = h + h * 0.175; p.add(body); p.add(c);
      p.position.set((rng() - 0.5) * 3 * s, 0, (rng() - 0.5) * 3 * s); p.rotation.set((rng() - 0.5) * 0.6, rng() * 3, (rng() - 0.5) * 0.6);
      g.add(p);
    }
    return g;
  }
  function obsidianSpike(rng, o) {
    o = o || {};
    const s = (o.scale || 1) * (0.8 + rng() * 0.8), g = new T.Group();
    const m = mat('#1e1a22', { rough: 0.3, metal: 0.2 }), glow = mat('#ff5a1a', { emissive: '#ff4a00', emissiveIntensity: 1.2 });
    const n = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const h = (4 + rng() * 6) * s, r = (0.9 + rng() * 0.8) * s;
      const c = new T.Mesh(new T.ConeGeometry(r, h, 5), m);
      c.position.set((rng() - 0.5) * 3 * s, h / 2, (rng() - 0.5) * 3 * s); c.rotation.set((rng() - 0.5) * 0.5, rng() * 3, (rng() - 0.5) * 0.5);
      g.add(c);
    }
    if (rng() < 0.5) g.add(at(box(1.4 * s, 0.3, 1.4 * s, glow), 0, 0.12, 0));
    return g;
  }
  function lavaMaterial() {
    if (matCache.lava) return matCache.lava;
    const t = tex.lava();
    const m = new T.MeshStandardMaterial({ color: '#ff7a1a', map: t, emissive: '#ff6a10', emissiveMap: t, emissiveIntensity: 1.25, roughness: 0.6 });
    m.name = 'env_lava';
    return (matCache.lava = m);
  }
  function lavaPool(w, d) {
    const g = new T.Group();
    const p = plane(w, d, lavaMaterial(), 10); p.position.y = 0.12; g.add(p);
    const rim = mat('#2a2224');
    g.add(at(box(w + 2, 0.6, 1.2, rim), 0, 0.3, d / 2 + 0.6)); g.add(at(box(w + 2, 0.6, 1.2, rim), 0, 0.3, -d / 2 - 0.6));
    g.add(at(box(1.2, 0.6, d, rim), w / 2 + 0.6, 0.3, 0)); g.add(at(box(1.2, 0.6, d, rim), -w / 2 - 0.6, 0.3, 0));
    return g;
  }
  function goldPillar(rng, broken) {
    const g = new T.Group(), stone = mat('#f4efe4'), gold = mat('#e8b830', { metal: 0.55, rough: 0.35 });
    const h = broken ? 5 + rng() * 5 : 13 + rng() * 3;
    g.add(at(box(3.6, 1, 3.6, gold), 0, 0.5, 0));
    const col = new T.Mesh(new T.CylinderGeometry(1.25, 1.35, h, 8), stone); col.position.y = 1 + h / 2; g.add(col);
    for (let y = 3; y < h; y += 4) { const r = new T.Mesh(new T.CylinderGeometry(1.42, 1.42, 0.4, 8), gold); r.position.y = 1 + y; g.add(r); }
    if (!broken) { g.add(at(box(3.8, 1, 3.8, gold), 0, h + 1.5, 0)); g.add(at(box(3, 0.8, 3, stone), 0, h + 2.4, 0)); }
    else { const chunk = box(2.4, 1.4, 2, stone); chunk.position.set(2.6, 0.7, 1.4); chunk.rotation.y = rng(); g.add(chunk); }
    return g;
  }
  function ruinArch(rng) {
    const g = new T.Group(), stone = mat('#efe8da'), gold = mat('#e8b830', { metal: 0.55, rough: 0.35 });
    for (const sx of [-5, 5]) { g.add(at(box(2.4, 12, 2.4, stone), sx, 6, 0)); g.add(at(box(2.8, 0.6, 2.8, gold), sx, 12.3, 0)); }
    g.add(at(box(13, 1.8, 2.6, stone), 0, 13.4, 0));
    g.add(at(box(13.4, 0.5, 3, gold), 0, 14.5, 0));
    if (rng() < 0.5) { const b = box(4, 1.6, 2.4, stone); b.position.set(7, 0.8, 3); b.rotation.y = 0.6; g.add(b); }
    g.rotation.y = rng() * 0.6 - 0.3;
    return g;
  }
  function floatingCrystalGeo() { return new T.OctahedronGeometry(1, 0); }
  function vine(h, color) {
    const g = new T.Group(), m = mat(color || '#3f9a3a'), lf = mat('#5cbf45');
    g.add(at(box(0.5, h, 0.5, m), 0, -h / 2, 0));
    for (let y = 1.5; y < h; y += 2.2) g.add(at(box(1.2, 0.7, 0.4, lf), (y % 4 < 2 ? 0.6 : -0.6), -y, 0));
    return g;
  }
  function torch() {
    const g = new T.Group();
    g.add(at(box(0.5, 2.2, 0.5, mat('#4a3020')), 0, 1.1, 0));
    g.add(at(box(0.9, 0.5, 0.9, mat('#43444d', { metal: 0.4 })), 0, 2.3, 0));
    g.add(at(box(0.6, 0.9, 0.6, mat('#ffb030', { emissive: '#ff8a10', emissiveIntensity: 2 })), 0, 2.9, 0));
    return g;
  }
  function lanternPost(o) {
    o = o || {};
    const g = new T.Group(), post = mat(o.post || '#4a3020'), iron = mat('#2f3036', { metal: 0.4, rough: 0.5 });
    const h = o.h || 6.5;
    g.add(at(box(0.7, h, 0.7, post), 0, h / 2, 0));
    g.add(at(box(2.2, 0.5, 0.5, post), 0.8, h - 0.4, 0));
    g.add(at(box(1.1, 0.25, 1.1, iron), 1.6, h - 0.9, 0));
    g.add(at(box(0.9, 1.1, 0.9, mat('#ffd060', { emissive: '#ffb030', emissiveIntensity: 1.6 })), 1.6, h - 1.6, 0));
    g.add(at(box(1.1, 0.25, 1.1, iron), 1.6, h - 2.25, 0));
    g.add(at(box(1.1, 0.3, 1.1, mat('#6a6a6a')), 0, 0.15, 0));
    return g;
  }
  function bannerPole(h) {
    const g = new T.Group();
    g.add(at(box(0.5, h, 0.5, mat('#5b3d29')), 0, h / 2, 0));
    g.add(at(box(3.4, 0.35, 0.35, mat('#5b3d29')), 0, h - 0.4, 0.1));
    g.add(at(box(0.7, 0.7, 0.7, mat('#e8b830', { metal: 0.5, rough: 0.4 })), 0, h + 0.3, 0));
    return g;
  }
  /* Chunky Roblox-like fence between two points (posts dark, 3 rails). */
  function fenceLine(x0, z0, x1, z1, o) {
    o = o || {};
    const g = new T.Group(), post = mat(o.post || '#4a2f1e'), rail = mat(o.rail || '#9a6a40');
    const dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz), H = o.h || 4.4;
    const ang = Math.atan2(dz, dx);
    const n = Math.max(1, Math.round(L / 4.4));
    for (let i = 0; i <= n; i++) {
      const t = i / n, p = box(1.1, H, 1.1, post);
      p.position.set(x0 + dx * t, H / 2, z0 + dz * t); g.add(p);
    }
    [0.32, 0.58, 0.84].forEach(function (f) {
      const r = box(L, 0.62, 0.42, rail);
      r.position.set(x0 + dx / 2, H * f, z0 + dz / 2); r.rotation.y = -ang; g.add(r);
    });
    return { group: g, length: L };
  }
  function coinStack(n) {
    const g = new T.Group(), gold = mat('#ffc928', { metal: 0.6, rough: 0.35 });
    for (let k = 0; k < n; k++) { const c = new T.Mesh(new T.CylinderGeometry(0.55, 0.55, 0.22, 10), gold); c.position.set((k % 2) * 0.08, 0.11 + k * 0.24, 0); g.add(c); }
    return g;
  }
  /* Small egg nest: scaled great nest when loaded, else a faceted twig ring. */
  function nest(rng, o) {
    o = o || {};
    const s = o.scale || 0.36, g = new T.Group();
    const gn = SE.Assets && SE.Assets.has && SE.Assets.has('prop.great_nest') ? SE.Assets.get('prop.great_nest') : null;
    if (gn) { gn.scale.set(s, s * 1.2, s); gn.rotation.y = rng() * 6.28; g.add(gn); return g; }
    const ring = new T.Mesh(new T.TorusGeometry(2.3, 0.85, 5, 10), mat('#7a5230'));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.6; g.add(ring);
    const bed = new T.Mesh(new T.CylinderGeometry(2.2, 2.2, 0.5, 10), mat('#d7b35e')); bed.position.y = 0.35; g.add(bed);
    return g;
  }

  /* ------------------------------------------------------------------ */
  /* text: canvas textures, boards, sprites                               */
  /* ------------------------------------------------------------------ */
  function textTexture(w, h, draw) {
    const c = canvas(w, h), ctx = c.getContext('2d');
    const t = canvasTex(c, false);
    t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter;
    const api = {
      texture: t, canvas: c, ctx: ctx, draw: draw,
      redraw: function (d) { if (d) api.draw = d; ctx.clearRect(0, 0, w, h); api.draw(ctx, w, h); t.needsUpdate = true; }
    };
    api.redraw();
    return api;
  }
  /* Text fitting. Every world label goes through these, so text never leaves its board:
       strokeW(size)  outline width used by outlinedText for that font size
       fitText(ctx, text, maxW, size[, weight, maxH]) -> font size (≤ size) whose ink width INCLUDING the
         outline is ≤ maxW and whose glyph height (ascent + descent, outline included) is ≤ maxH; sets ctx.font */
  function strokeW(size) { return Math.max(4, Math.round(size * 0.2)); }
  function inkBox(ctx, text) {
    const m = ctx.measureText(text);
    const asc = m.actualBoundingBoxAscent !== undefined ? m.actualBoundingBoxAscent : parseFloat(ctx.font) * 0.74;
    const desc = m.actualBoundingBoxDescent !== undefined ? m.actualBoundingBoxDescent : parseFloat(ctx.font) * 0.06;
    const l = m.actualBoundingBoxLeft !== undefined ? m.actualBoundingBoxLeft : m.width / 2;
    const r = m.actualBoundingBoxRight !== undefined ? m.actualBoundingBoxRight : m.width / 2;
    return { w: Math.max(m.width, l + r), asc: asc, desc: desc };
  }
  function fitText(ctx, text, maxW, size, weight, maxH, sw) {
    let s = Math.max(8, Math.round(size));
    const set = function () { ctx.font = (weight || 900) + ' ' + s + 'px ' + FONT; };
    set();
    while (s > 8) {
      const k = inkBox(ctx, text), lw = sw === undefined || sw === null ? strokeW(s) : (sw || 0);
      if (k.w + lw <= maxW && (!maxH || k.asc + k.desc + lw <= maxH)) break;
      s -= s > 40 ? 2 : 1; set();
    }
    return s;
  }
  /* Centred outlined text (x, y = centre of the ink box). maxH optional. Returns { size, w } (ink width incl. outline). */
  function outlinedText(ctx, text, x, y, size, fill, stroke, maxW, lw, maxH) {
    const s = fitText(ctx, text, maxW || 9999, size, 900, maxH, stroke ? (lw || undefined) : 0);
    const k = inkBox(ctx, text);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
    const by = y + (k.asc - k.desc) / 2;
    const L = stroke ? (lw || strokeW(s)) : 0;
    if (stroke) { ctx.lineWidth = L; ctx.strokeStyle = stroke; ctx.strokeText(text, x, by); }
    ctx.fillStyle = fill; ctx.fillText(text, x, by);
    return { size: s, w: k.w + L };
  }
  /* Icon + text in one centred row inside [x0, x1] around cy: the icon is drawIcon(ctx, cx, cy, s) with a box of
     iconW·s × s; the row (icon, gap, text) is scaled down together until it fits maxH and the width. */
  function iconText(ctx, o) {
    const x0 = o.x0, x1 = o.x1, cy = o.cy, maxH = o.maxH, iw = o.iconW || 1, gapK = o.gap !== undefined ? o.gap : 0.18;
    let size = o.size || maxH;
    let s = 0, tw = 0, total = 0;
    for (let it = 0; it < 60; it++) {
      s = fitText(ctx, o.text, 99999, size, 900, maxH, o.stroke ? undefined : 0);
      const k = inkBox(ctx, o.text);
      tw = k.w + (o.stroke ? strokeW(s) : 0);
      const ih = Math.min(maxH, (k.asc + k.desc) * (o.iconScale || 1.25));
      total = ih * iw + ih * gapK + tw;
      if (total <= x1 - x0 || size <= 10) { s = ih; break; }
      size = Math.max(10, size * 0.94);
    }
    const left = (x0 + x1) / 2 - total / 2, ih = s;
    o.drawIcon(ctx, left + ih * iw / 2, cy, ih);
    const tx = left + ih * iw + ih * gapK + tw / 2;
    outlinedText(ctx, o.text, tx, cy, size, o.fill, o.stroke, tw + 2, undefined, maxH);
    return { left: left, width: total };
  }
  const BOARD = {
    wood: { bg: '#9a6a40', bg2: '#7a5030', border: '#4a2f1e', text: '#fff4d6', stroke: '#3a2416' },
    navy: { bg: '#1e2a52', bg2: '#16203f', border: '#0c1226', text: '#ffffff', stroke: '#0c1226' },
    orange: { bg: '#e07a2a', bg2: '#c8601a', border: '#7a3a10', text: '#ffffff', stroke: '#5a2a08' },
    stone: { bg: '#8a8790', bg2: '#77747c', border: '#4a4850', text: '#fff8e6', stroke: '#2a2830' },
    cream: { bg: '#f6ead0', bg2: '#ead8b2', border: '#7a5030', text: '#5a3a20', stroke: null }
  };
  function drawBoard(ctx, w, h, style, plank) {
    const s = BOARD[style] || BOARD.wood;
    ctx.fillStyle = s.border; roundRect(ctx, 0, 0, w, h, h * 0.16); ctx.fill();
    ctx.fillStyle = s.bg; roundRect(ctx, 6, 6, w - 12, h - 12, h * 0.12); ctx.fill();
    if (plank) { ctx.fillStyle = s.bg2; for (let y = h * 0.33; y < h - 10; y += h * 0.33) ctx.fillRect(8, y, w - 16, 3); }
    ctx.fillStyle = 'rgba(255,255,255,0.13)'; roundRect(ctx, 10, 9, w - 20, h * 0.18, 6); ctx.fill();
    return s;
  }
  /* Inner padding (px) of a board canvas: text / icons stay inside the frame with a visible margin. */
  function boardPad(w, h, noBoard) {
    return { x: Math.round(Math.max(noBoard ? h * 0.12 : h * 0.32, noBoard ? 8 : 22)), y: Math.round(Math.max(h * (noBoard ? 0.1 : 0.17), 8)) };
  }
  /* Flat sign board (plane facing +Z). text may be a string, a function returning a string, or draw(ctx,w,h). */
  function signBoard(o) {
    o = o || {};
    const W = o.w || 8, H = o.h || 2.2, PX = o.px || 64;
    const cw = Math.min(1024, Math.round(W * PX)), ch = Math.round(cw * H / W);
    const style = o.style || 'wood';
    let text = o.text || '';
    const drawFn = o.draw || function (ctx, w, h) {
      const s = o.noBoard ? BOARD[style] : drawBoard(ctx, w, h, style, true);
      const t = typeof text === 'function' ? text() : text;
      const pad = boardPad(w, h, o.noBoard);
      outlinedText(ctx, t, w / 2, h / 2, Math.round(h * 0.6), s.text, s.stroke, w - 2 * pad.x, 0, h - 2 * pad.y);
    };
    const tt = textTexture(cw, ch, drawFn);
    const m = new T.MeshBasicMaterial({ map: tt.texture, transparent: !!o.transparent, alphaTest: o.transparent ? 0.1 : 0, side: o.double ? T.DoubleSide : T.FrontSide });
    m.color.setScalar(o.bright || 0.92);
    const mesh = new T.Mesh(new T.PlaneGeometry(W, H), m);
    mesh.userData.label = tt;
    return {
      mesh: mesh, tt: tt,
      setText: function (t) { text = t; tt.redraw(); },
      redraw: function () { tt.redraw(); }
    };
  }
  /* Floating label sprite (constant world size). */
  function textSprite(text, o) {
    o = o || {};
    const cw = o.cw || 512, ch = o.ch || 128;
    let cur = text || '', color = o.color || '#ffffff';
    const tt = textTexture(cw, ch, function (ctx, w, h) {
      if (!cur) return;
      if (o.bg) {
        fitText(ctx, cur, w - 60, Math.round(h * 0.56));
        const tw = Math.min(w - 8, ctx.measureText(cur).width + 56);
        ctx.fillStyle = o.bg; roundRect(ctx, (w - tw) / 2, h * 0.1, tw, h * 0.8, h * 0.3); ctx.fill();
      }
      outlinedText(ctx, cur, w / 2, h / 2 + 3, Math.round(h * 0.56), color, o.stroke || '#1a1a22', w - 70, Math.round(h * 0.12));
    });
    const m = new T.SpriteMaterial({ map: tt.texture, transparent: true, depthWrite: false, fog: false });
    const sp = new T.Sprite(m);
    const sc = o.scale || 6;
    sp.scale.set(sc, sc * ch / cw, 1);
    sp.renderOrder = 5;
    sp.userData.setText = function (t, c) { if (t === cur && (!c || c === color)) return; cur = t || ''; if (c) color = c; tt.redraw(); sp.visible = !!cur; };
    sp.userData.label = tt;
    sp.visible = !!cur;
    return sp;
  }

  /* ------------------------------------------------------------------ */
  /* stalls, treadmill, boards, wheel, chest, banners                     */
  /* ------------------------------------------------------------------ */
  function stall(o) {
    o = o || {};
    const g = new T.Group();
    const wood = mat('#8b5d3e'), dark = mat('#5b3d29'), a = mat(o.stripeA || '#e8463a'), b = mat(o.stripeB || '#ffffff');
    const W = 10, D = 6;
    for (const sx of [-W / 2 + 0.5, W / 2 - 0.5]) for (const sz of [-D / 2 + 0.5, D / 2 - 0.5]) g.add(at(box(0.8, 8.4, 0.8, dark), sx, 4.2, sz));
    g.add(at(box(W, 2.6, 2.4, wood), 0, 1.3, D / 2 - 1.2));
    g.add(at(box(W + 0.6, 0.4, 2.8, dark), 0, 2.75, D / 2 - 1.2));
    g.add(at(box(W - 1, 0.8, 0.3, mat(o.trim || '#e8b830', { metal: 0.4, rough: 0.4 })), 0, 1.6, D / 2 + 0.02));
    g.add(at(box(W, 5, 0.6, wood), 0, 2.5, -D / 2 + 0.3));
    // striped awning (slanted)
    const aw = new T.Group(), n = 8;
    for (let k = 0; k < n; k++) {
      const s = box(W / n, 0.35, D + 1.8, k % 2 ? b : a);
      s.position.set(-W / 2 + W / n * (k + 0.5), 0, 0); aw.add(s);
      const flap = box(W / n, 1.0, 0.3, k % 2 ? b : a); flap.position.set(-W / 2 + W / n * (k + 0.5), -0.55, (D + 1.8) / 2); aw.add(flap);
    }
    aw.position.set(0, 8.9, 0.3); aw.rotation.x = 0.2; g.add(aw);
    // title board: dark backing box, text plane in front of it, the two hangers BEHIND the board (never over the text)
    const sign = signBoard({ w: 8.4, h: 2.2, style: o.signStyle || 'wood', text: o.title || '' });
    sign.mesh.position.set(0, 11.1, 0.24); g.add(sign.mesh);
    g.add(at(box(8.7, 2.45, 0.3, dark), 0, 11.1, 0.02));
    g.add(at(box(0.45, 2.2, 0.4, dark), -3, 9.95, -0.3)); g.add(at(box(0.45, 2.2, 0.4, dark), 3, 9.95, -0.3));
    return { group: g, sign: sign };
  }
  function treadmill() {
    const g = new T.Group();
    const frame = mat('#8f95a3', { rough: 0.6, metal: 0.25 }), dark = mat('#4a4f5a', { rough: 0.6, metal: 0.2 });
    const bt = tex.belt(); bt.repeat.set(1, 3);
    const beltMat = new T.MeshStandardMaterial({ color: '#ffffff', map: bt, roughness: 0.8 });
    g.add(at(box(5.2, 0.45, 10, frame), 0, 0.22, 0));
    const belt = box(3.8, 0.12, 9.2, beltMat); belt.position.set(0, 0.52, 0); g.add(belt);
    for (const sx of [-2.35, 2.35]) {
      g.add(at(box(0.6, 0.35, 10, dark), sx, 0.6, 0));
      g.add(at(box(0.45, 5.2, 0.45, frame), sx, 2.8, -4.4));
      g.add(at(box(0.4, 0.4, 3.2, frame), sx, 3.9, -2.9));
    }
    g.add(at(box(5.1, 0.45, 0.45, frame), 0, 5.3, -4.4));
    const con = box(2.6, 1.4, 0.6, dark); con.position.set(0, 5.4, -4.2); con.rotation.x = -0.4; g.add(con);
    g.add(at(box(2, 0.8, 0.1, mat('#5ad0ff', { emissive: '#3ab0ff', emissiveIntensity: 0.9 })), 0, 5.5, -3.88));
    return { group: g, beltTexture: bt, belt: belt };
  }
  function upgradeBoard() {
    const g = new T.Group();
    let title = 'Upgrade', level = 'Level 1 → Level 2', price = '$500';
    const board = signBoard({
      w: 6, h: 4.2, px: 80, style: 'navy',
      draw: function (ctx, w, h) {
        drawBoard(ctx, w, h, 'navy', false);
        outlinedText(ctx, title, w / 2, h * 0.17, Math.round(h * 0.15), '#ffffff', '#0c1226', w - 40);
        outlinedText(ctx, level, w / 2, h * 0.39, Math.round(h * 0.12), '#bfe0ff', '#0c1226', w - 40);
        // red cash button + purple ad button (as in map-ref-4)
        const bw = w * 0.5, bh = h * 0.24, bx = w * 0.08, by = h * 0.58;
        ctx.fillStyle = '#7a1010'; roundRect(ctx, bx, by + 6, bw, bh, 14); ctx.fill();
        ctx.fillStyle = '#e8322a'; roundRect(ctx, bx, by, bw, bh, 14); ctx.fill();
        outlinedText(ctx, price, bx + bw / 2, by + bh / 2 + 2, Math.round(bh * 0.62), '#ffffff', '#5a0a0a', bw - 20);
        const ax = bx + bw + w * 0.06, aw = w * 0.28;
        ctx.fillStyle = '#4a1a7a'; roundRect(ctx, ax, by + 6, aw, bh, 14); ctx.fill();
        ctx.fillStyle = '#9a4ae0'; roundRect(ctx, ax, by, aw, bh, 14); ctx.fill();
        ctx.fillStyle = '#ffffff'; ctx.beginPath();
        ctx.moveTo(ax + aw * 0.4, by + bh * 0.25); ctx.lineTo(ax + aw * 0.68, by + bh * 0.5); ctx.lineTo(ax + aw * 0.4, by + bh * 0.75); ctx.closePath(); ctx.fill();
      }
    });
    board.mesh.position.set(0, 5.6, 0.36); g.add(board.mesh);
    g.add(at(box(6.4, 4.6, 0.6, mat('#121a33')), 0, 5.6, 0));
    g.add(at(box(0.8, 3.6, 0.8, mat('#121a33')), 0, 1.8, 0));
    g.add(at(box(2.6, 0.5, 2.6, mat('#2a3048')), 0, 0.25, 0));
    return {
      group: g, board: board,
      setText: function (lv, pr, ti) { if (lv !== undefined) level = lv; if (pr !== undefined) price = pr; if (ti) title = ti; board.redraw(); }
    };
  }
  function wheelStand() {
    const g = new T.Group(), wood = mat('#8b5d3e'), dark = mat('#5b3d29'), gold = mat('#e8b830', { metal: 0.5, rough: 0.4 });
    const S = 512, cols = ['#9a4ae0', '#ffc928', '#4fc23a', '#3a8aff', '#ff4a5a', '#ff9a1a', '#2fc8c0', '#ff7ad0'];
    const tt = textTexture(S, S, function (ctx) {
      const c = S / 2, r = S / 2 - 6;
      for (let k = 0; k < 8; k++) {
        ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, r, k * Math.PI / 4, (k + 1) * Math.PI / 4); ctx.closePath();
        ctx.fillStyle = cols[k]; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        const a = (k + 0.5) * Math.PI / 4;
        ctx.save(); ctx.translate(c + Math.cos(a) * r * 0.66, c + Math.sin(a) * r * 0.66); ctx.rotate(a + Math.PI / 2);
        if (k % 2) drawEmblem(ctx, 'star', 0, 0, 26, '#ffffff');
        else { ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(0, -28); ctx.lineTo(22, 0); ctx.lineTo(0, 28); ctx.lineTo(-22, 0); ctx.closePath(); ctx.fill(); }
        ctx.restore();
      }
      ctx.lineWidth = 16; ctx.strokeStyle = '#e8b830'; ctx.beginPath(); ctx.arc(c, c, r - 4, 0, 7); ctx.stroke();
      for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8; ctx.fillStyle = '#fff6c0'; ctx.beginPath(); ctx.arc(c + Math.cos(a) * (r - 4), c + Math.sin(a) * (r - 4), 7, 0, 7); ctx.fill(); }
      ctx.fillStyle = '#e8b830'; ctx.beginPath(); ctx.arc(c, c, 46, 0, 7); ctx.fill();
      ctx.fillStyle = '#c8901a'; ctx.beginPath(); ctx.arc(c, c, 26, 0, 7); ctx.fill();
    });
    const wheel = new T.Group();
    const face = new T.Mesh(new T.CircleGeometry(6, 40), new T.MeshStandardMaterial({ map: tt.texture, roughness: 0.6 }));
    face.position.z = 0.42; wheel.add(face);
    const rim = new T.Mesh(new T.CylinderGeometry(6.2, 6.2, 0.8, 32), gold); rim.rotation.x = Math.PI / 2; wheel.add(rim);
    wheel.position.set(0, 9.2, 0.6); g.add(wheel);
    for (const sx of [-4.6, 4.6]) { const p = box(1, 10, 1, wood); p.position.set(sx, 5, -0.4); p.rotation.z = -sx * 0.05; g.add(p); }
    g.add(at(box(10.5, 0.8, 1, dark), 0, 3.2, -0.4));
    g.add(at(box(1.2, 1.2, 1.8, dark), 0, 9.2, -0.3));
    g.add(at(box(12, 1, 4, mat('#7a7480')), 0, 0.5, 0));
    const ptr = new T.Mesh(new T.ConeGeometry(0.9, 2.2, 4), mat('#e8322a')); ptr.rotation.z = Math.PI; ptr.position.set(0, 15.6, 1.1); g.add(ptr);
    g.add(at(box(1.6, 1, 1.6, gold), 0, 16.6, 1.1));
    return { group: g, wheel: wheel };
  }
  /* Daily gift chest. With prop.gift_chest (tools/blender/chest.py) loaded: the Blender chest, `lid` = its hinge node
     (rotation.x = −a opens it), `gem` = the front gem part (or null); else a simple procedural box chest.
     glow = additive ground disc (opacity animated by the world). */
  function chest() {
    const g = new T.Group();
    const glow = new T.Mesh(new T.CircleGeometry(3.8, 28), new T.MeshBasicMaterial({ color: '#ffe680', transparent: true, opacity: 0.35, depthWrite: false, blending: T.AdditiveBlending }));
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.07; glow.renderOrder = 2; g.add(glow);
    const A = SE.Assets;
    if (A && A.has && A.has('prop.gift_chest')) {
      const model = A.get('prop.gift_chest', { cloneMaterials: true });
      const lid = A.getPart ? A.getPart(model, 'lid') : model.getObjectByName('lid');
      const gem = A.getPart ? A.getPart(model, 'gem') : model.getObjectByName('gem');
      const inner = A.getPart ? A.getPart(model, 'fx_inner') : model.getObjectByName('fx_inner');
      g.add(model);
      if (lid) return { group: g, model: model, lid: lid, gem: gem || null, inner: inner || null, glow: glow, glb: true };
      g.remove(model);
    }
    const wood = mat('#a0602e'), dark = mat('#6a3a1a'), gold = mat('#ffc928', { metal: 0.6, rough: 0.35 });
    g.add(at(box(4.2, 2.4, 2.8, wood), 0, 1.4, 0));
    for (const sx of [-1.5, 1.5]) g.add(at(box(0.4, 2.5, 2.9, gold), sx, 1.4, 0));
    g.add(at(box(4.3, 0.3, 2.9, dark), 0, 0.15, 0));
    const lid = new T.Group();
    lid.add(at(box(4.2, 1.1, 2.8, wood), 0, 0.55, 1.4));
    for (const sx of [-1.5, 1.5]) lid.add(at(box(0.42, 1.2, 2.9, gold), sx, 0.55, 1.4));
    lid.position.set(0, 2.6, -1.4); g.add(lid);
    g.add(at(box(0.9, 1.1, 0.3, gold), 0, 2.4, 1.45));
    return { group: g, lid: lid, gem: null, inner: null, glow: glow, glb: false };
  }
  /* Banner cloth (2.8 × 5) using the atlas; idx -1 → neutral cell. */
  function bannerMesh(idx) {
    const geo = new T.PlaneGeometry(2.8, 5);
    const m = matCache.bannerCloth || (matCache.bannerCloth = new T.MeshStandardMaterial({ map: tex.banners(), alphaTest: 0.4, side: T.DoubleSide, roughness: 0.9 }));
    const mesh = new T.Mesh(geo, m);
    setBannerEmblem(mesh, idx);
    return mesh;
  }
  function setBannerEmblem(mesh, idx) {
    const cell = idx === undefined || idx === null || idx < 0 ? 6 : idx;
    const uv = mesh.geometry.attributes.uv, u0 = cell / 8, u1 = (cell + 1) / 8;
    // PlaneGeometry uv order: (0,1),(1,1),(0,0),(1,0)
    uv.setXY(0, u0, 1); uv.setXY(1, u1, 1); uv.setXY(2, u0, 0); uv.setXY(3, u1, 0);
    uv.needsUpdate = true;
  }

  /* ------------------------------------------------------------------ */
  /* sky                                                                  */
  /* ------------------------------------------------------------------ */
  function skyDome(radius) {
    const m = new T.ShaderMaterial({
      uniforms: {
        top: { value: new T.Color('#4aa6f0') }, horizon: { value: new T.Color('#a6dcff') }, bottom: { value: new T.Color('#cfeeff') },
        sunDir: { value: new T.Vector3(0.3, 0.6, 0.4).normalize() }, sunColor: { value: new T.Color('#fff3d6') },
        stars: { value: 0 }, time: { value: 0 }
      },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w * 0.99999; }',
      fragmentShader: [
        'uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; uniform float stars; uniform float time;',
        'varying vec3 vDir;',
        'float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719)))*43758.5453); }',
        'void main(){',
        '  vec3 d = normalize(vDir); float h = d.y;',
        '  vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h*1.25,0.0,1.0), 0.62)) : mix(horizon, bottom, clamp(-h*5.0,0.0,1.0));',
        '  float s = max(dot(d, normalize(sunDir)), 0.0);',
        '  c += sunColor * (pow(s, 900.0) * 3.0 + pow(s, 60.0) * 0.35 + pow(s, 8.0) * 0.12);',
        '  if (stars > 0.0) { vec3 q = floor(d * 220.0); float n = hash(q); float st = step(0.9965, n) * smoothstep(0.02, 0.35, h);',
        '    c += vec3(st) * stars * (0.55 + 0.45 * sin(time * 2.5 + n * 80.0)); }',
        '  gl_FragColor = vec4(c, 1.0);',
        '  #include <encodings_fragment>',
        '}'
      ].join('\n'),
      side: T.BackSide, depthWrite: false, fog: false, toneMapped: false
    });
    const mesh = new T.Mesh(new T.SphereGeometry(radius || 900, 32, 16), m);
    mesh.renderOrder = -10; mesh.frustumCulled = false; mesh.name = 'sky';
    return mesh;
  }
  function clouds(rng, count) {
    const geos = [];
    const add = function (x, y, z, w, h, d) {
      const g = new T.BoxGeometry(w, h, d).toNonIndexed();
      const n = g.attributes.normal, col = new Float32Array(n.count * 3);
      for (let i = 0; i < n.count; i++) {
        const ny = n.getY(i), v = ny > 0.5 ? 1 : ny < -0.5 ? 0.78 : 0.9;
        col[i * 3] = v * 0.97; col[i * 3 + 1] = v * 0.985; col[i * 3 + 2] = v;
      }
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.translate(x, y, z); geos.push(g);
    };
    for (let c = 0; c < (count || 22); c++) {
      const a = rng() * Math.PI * 2, r = 380 + rng() * 380, y = 150 + rng() * 110;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r, s = 1.2 + rng() * 1.6;
      const n = 3 + Math.floor(rng() * 4);
      for (let k = 0; k < n; k++) add(cx + (rng() - 0.5) * 50 * s, y + rng() * 8 * s, cz + (rng() - 0.5) * 24 * s, (22 + rng() * 26) * s, (9 + rng() * 9) * s, (16 + rng() * 18) * s);
    }
    const merge = T.BufferGeometryUtils.mergeBufferGeometries || T.BufferGeometryUtils.mergeGeometries;
    const geo = merge(geos, false);
    const m = new T.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false, transparent: true, opacity: 0.96, depthWrite: false });
    const mesh = new T.Mesh(geo, m);
    mesh.frustumCulled = false; mesh.renderOrder = -9; mesh.name = 'clouds';
    return mesh;
  }

  /* Distant castle: Kenney Castle Kit pieces (falls back to blocks). Origin at the castle centre on its base.
     Every piece is MEASURED (Box3 of the GLB at scale 1) and stacked flush on the previous one: nothing floats,
     no gaps between tower floors / roof / flag; walls exactly fill the gaps between the towers. */
  function castle(rng) {
    const g = new T.Group(), S = 12;
    const sizeCache = {};
    const dims = function (name) {
      if (sizeCache[name]) return sizeCache[name];
      const o = kenney('kenney.castle.' + name); if (!o) return null;
      o.updateMatrixWorld(true);
      const b = new T.Box3().setFromObject(o);
      return (sizeCache[name] = { minY: b.min.y, h: b.max.y - b.min.y, w: b.max.x - b.min.x, d: b.max.z - b.min.z });
    };
    // place piece `name` with its bottom at y (scale s); returns the y of its top
    const piece = function (name, x, y, z, s, ry) {
      const o = kenney('kenney.castle.' + name), d = dims(name);
      if (!o || !d) return y;
      s = s || S;
      o.scale.setScalar(s); o.rotation.y = ry || 0; o.position.set(x, y - d.minY * s, z); g.add(o);
      return y + d.h * s;
    };
    if (kenney('kenney.castle.tower-square-base') && kenney('kenney.castle.tower-square-top-roof-high')) {
      const sink = 0.06 * S;   // each stacked piece sinks a hair into the one below (no hairline gaps)
      const tower = function (x, z, floors) {
        let y = piece('tower-square-base', x, 0, z);
        for (let f = 0; f < floors; f++) y = piece('tower-square-mid-windows', x, y - sink, z);
        y = piece('tower-square-top-roof-high', x, y - sink, z);
        piece('flag', x, y - 0.12 * S, z, S * 0.7);
      };
      // 4 corner towers; the walls between them are exactly one wall piece long (tower width = wall width = S)
      tower(-2 * S, -S, 2); tower(2 * S, -S, 2); tower(-2 * S, S, 1); tower(2 * S, S, 1);
      for (let x = -1; x <= 1; x++) { piece('wall', x * S, 0, S); piece('wall', x * S, 0, -S); }
      for (const sx of [-2, 2]) piece('wall', sx * S, 0, 0, S, Math.PI / 2);
      // keep (hexagon tower) in the middle: base + 2 mids + roof + flag, stacked flush
      const K = S * 1.3;
      let y = piece('tower-hexagon-base', 0, 0, 0, K);
      for (let f = 0; f < 2; f++) y = piece('tower-hexagon-mid', 0, y - 0.04 * K, 0, K);
      y = piece('tower-hexagon-roof', 0, y - 0.04 * K, 0, K);
      piece('flag', 0, y - 0.12 * K, 0, S * 0.8);
      return g;
    }
    const st = mat('#b8b4c0'), roof = mat('#3a5ab8');
    const t = function (x, z, h) {
      g.add(at(box(10, h, 10, st), x, h / 2, z));
      const r = new T.Mesh(new T.ConeGeometry(8, 12, 4), roof); r.position.set(x, h + 6, z); r.rotation.y = Math.PI / 4; g.add(r);
    };
    t(-24, -12, 36); t(24, -12, 36); t(-24, 18, 26); t(24, 18, 26); t(0, 0, 50);
    g.add(at(box(48, 16, 4, st), 0, 8, 18)); g.add(at(box(48, 16, 4, st), 0, 8, -12));
    return g;
  }

  SE.Env = {
    seeded: seeded, at: at, rr: rr, tex: tex, roundRect: roundRect, drawEmblem: drawEmblem,
    setAnisotropy: function (n) { ANISO = n || 4; Object.keys(texCache).forEach(function (k) { texCache[k].anisotropy = ANISO; texCache[k].needsUpdate = true; }); },
    mat: mat, studMat: studMat, wallMat: wallMat, groundMat: groundMat, cobbleMat: cobbleMat, lavaMaterial: lavaMaterial,
    box: box, plane: plane, groundPlane: groundPlane, worldBox: worldBox, layerize: layerize, geoMesh: geoMesh, unitBox: unitBox,
    Batch: Batch, kenney: kenney, NATURE_COLORS: NATURE_COLORS, natureRemap: natureRemap,
    voxelTree: voxelTree, pineTree: pineTree, bush: bush, rock: rock, flower: flower, grassTuft: grassTuft,
    giantMushroom: giantMushroom, mossLog: mossLog, cactus: cactus, dune: dune, sandPillar: sandPillar,
    amberCrystal: amberCrystal, bones: bones, iceCrystal: iceCrystal, obsidianSpike: obsidianSpike,
    lavaPool: lavaPool, goldPillar: goldPillar, ruinArch: ruinArch, floatingCrystalGeo: floatingCrystalGeo,
    vine: vine, torch: torch, lanternPost: lanternPost, bannerPole: bannerPole, fenceLine: fenceLine,
    coinStack: coinStack, nest: nest,
    textTexture: textTexture, fitText: fitText, outlinedText: outlinedText, iconText: iconText, boardPad: boardPad, strokeW: strokeW,
    drawBoard: drawBoard, FONT: FONT,
    signBoard: signBoard, textSprite: textSprite,
    stall: stall, treadmill: treadmill, upgradeBoard: upgradeBoard, wheelStand: wheelStand, chest: chest,
    bannerMesh: bannerMesh, setBannerEmblem: setBannerEmblem,
    skyDome: skyDome, clouds: clouds, castle: castle
  };
})(window);
