/* =========================================================================
   Steal a Dragon Egg — dragon & egg rigs (SE.DragonModels)          SPEC §5.1, §7

   Procedural animation of the rigid-part Blender GLBs (no skinning). Every part node
   has identity rotation at rest (tools/blender/README.md), so poses are offsets:
     wing flap up wing_L.rotation.z = +a (wing_R −a) · jaw open jaw.rotation.x = +a ·
     head yaw/nod head.rotation.y / .x (+ = chin down) · tail sway tail_k.rotation.y ·
     leg swing leg_*.rotation.x (+ = foot backward) · +X = the dragon's LEFT, facing +Z.

   API
     SE.DragonModels.create(speciesId, opts) -> Rig
         opts { baby:false, variant:0, drake:false, lite:false, micro:false, fx:true (variant shimmer), shadows:true }
         drake = adult model × 0.55 with quicker motion. lite = meshes merged per animated part into one
         vertex-coloured mesh (+eye/pupil kept) → baby ≈ 12 draw calls, adult ≈ 19 (instead of 45–50); only the big
         parts cast shadows (baby: body/head/wings; adult: no eyes, jaw, wing tips, tail tip). micro (babies) = lite
         with legs + tail merged into the body (static) → ≈ 6 draw calls (followers on 'low').
     Rig = { group, model, species, baby, drake, lite, variant, state, placeholder,
             mouth (Object3D at the mouth, fx_mouth), head, size (hip height, world units at scale 1),
             height, length,
             setState(s[, { duration, next, fade, snap }]), update(dt, moveSpeed), setVariant(v), setAlert(bool),
             setSleeping(bool), setLookTarget(Vector3|null), setTimeScale(k), mergeStatic(), dispose(),
             onStateEnd: fn(state) | null }
         states: 'idle','walk','run','fly','sleep','wake','roar','sit','happy' (+ 'breath': jaw wide, head level — used
           by SE.DragonAI for the frost breath). snap:true jumps to the pose without a cross-fade.
           wake (default 1.4 s) and roar (1 s) are timed and then switch to opts.next || 'idle'.
           walk/run legs are synced to moveSpeed (u/s, world units) passed to update().
           roar emits SE.FX 'roar_wave' at the mouth (rig.roarFx = false to disable).
           sleep shows a Zzz (SE.FX 'zzz', sprite fallback); setAlert(true) shows a red "!" over the head.
     SE.DragonModels.createEgg(speciesId, variant, scale = 1, opts) -> { group, model, update(dt), setWobble(0..1),
         setVariant(v), dispose() }      opts { fx:true (variant shimmer) }; Aurora halo spins.
     SE.DragonModels.thumbnail('baby'|'adult'|'egg', speciesId, variant, size = 128) -> Promise<dataURL>
         One lazily created offscreen WebGLRenderer (transparent, sRGB + ACES like the game), cached results.
     SE.DragonModels.variantMaterial(srcMaterial, variant, scaleHint) -> Material   (shared cache; eye/pupil untouched)
     SE.DragonModels.STATES, VARIANT_FX ({1:'gold_glints',2:'crystal_glints',3:'rainbow_motes',4:'galaxy_stars'}),
     SE.DragonModels.tick(dt) (advances the shared shader clock; called by Rig.update anyway)

   Variants (SE.DragonData.VARIANTS): 1 golden — gold metallic + warm emissive + moving glints;
   2 crystal — translucent cyan with fresnel rim and glints; 3 rainbow — animated hue bands (onBeforeCompile);
   4 galaxy — deep violet nebula with drifting twinkling stars (emissive). Materials are cached per source
   material + variant and shared by every rig. 'eye' and 'pupil' are never overridden.
   A missing GLB never throws: a missing baby falls back to the adult model scaled to baby size, anything
   else gets SE.Assets' placeholder (rig.placeholder = true) and the rig still answers every call.
   ========================================================================= */
(function () {
  'use strict';
  const SE = window.SE = window.SE || {};
  const THREE = window.THREE;
  if (!THREE) { console.error('SE.DragonModels: THREE missing'); return; }

  const PARTS = ['body', 'neck', 'head', 'jaw', 'wing_L', 'wing_L_tip', 'wing_R', 'wing_R_tip',
    'tail_1', 'tail_2', 'tail_3', 'tail_4', 'leg_FL', 'leg_FR', 'leg_BL', 'leg_BR'];
  const NP = PARTS.length, NC = NP * 6;
  const PI = { };
  PARTS.forEach((n, i) => { PI[n] = i; });
  const B = PI.body, NK = PI.neck, HD = PI.head, JW = PI.jaw, WL = PI.wing_L, WLT = PI.wing_L_tip, WR = PI.wing_R, WRT = PI.wing_R_tip,
    T1 = PI.tail_1, FL = PI.leg_FL, FR = PI.leg_FR, BL = PI.leg_BL, BR = PI.leg_BR;
  const NODE_NAMES = new Set(PARTS.concat(['root', 'fx_mouth', 'fx_back', 'halo']));
  const STATES = ['idle', 'walk', 'run', 'fly', 'sleep', 'wake', 'roar', 'sit', 'happy', 'breath'];
  const KEEP_MATS = new Set(['eye', 'pupil']);
  const VARIANT_FX = { 1: 'gold_glints', 2: 'crystal_glints', 3: 'rainbow_motes', 4: 'galaxy_stars' };
  const TAU = Math.PI * 2;

  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

  /* ------------------------------------------------------------------ shared clock */
  const U_TIME = { value: 0 };
  let lastTickFrame = -1;
  function tick(dt) { U_TIME.value += dt; }
  function autoTick() {
    const f = (window.performance ? performance.now() : Date.now()) / 1000;
    if (lastTickFrame < 0) { lastTickFrame = f; return; }
    const d = f - lastTickFrame;
    if (d > 0.001) { U_TIME.value += Math.min(0.1, d); lastTickFrame = f; }
  }

  /* ------------------------------------------------------------------ variant materials */
  const SHADER_HELPERS = `
  varying vec3 vVWPos;
  uniform float uTime;
  uniform float uVScale;
  vec3 sadeHue( float h ) { return clamp( abs( mod( h * 6.0 + vec3( 0.0, 4.0, 2.0 ), 6.0 ) - 3.0 ) - 1.0, 0.0, 1.0 ); }
  float sadeHash( vec3 p ) { p = fract( p * 0.3183099 + 0.1 ); p *= 17.0; return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) ); }`;
  const COLOR_CODE = {
    rainbow: `
      vec3 sdP = vVWPos * uVScale;
      float sdLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
      vec3 sdHue = sadeHue( fract( uTime * 0.12 + sdP.y * 0.33 + sdP.x * 0.17 + sdP.z * 0.21 ) );
      sdHue = mix( vec3( 1.0 ), sdHue, 0.8 );
      diffuseColor.rgb = sdHue * ( 0.22 + 1.05 * sqrt( sdLum ) );`,
    galaxy: `
      vec3 sdP = vVWPos * uVScale * 5.5 + vec3( uTime * 0.16, uTime * 0.07, -uTime * 0.05 );
      vec3 sdC = floor( sdP ); vec3 sdF = fract( sdP );
      float sdH = sadeHash( sdC );
      vec3 sdO = vec3( sadeHash( sdC + 1.7 ), sadeHash( sdC + 3.1 ), sadeHash( sdC + 5.3 ) ) * 0.6 + 0.2;
      float sdStar = step( 0.8, sdH ) * smoothstep( 0.17, 0.0, length( sdF - sdO ) ) * ( 0.55 + 0.45 * sin( uTime * 3.0 + sdH * 40.0 ) );
      float sdLum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
      vec3 sdBase = mix( vec3( 0.025, 0.01, 0.10 ), vec3( 0.16, 0.05, 0.46 ), clamp( sdLum * 1.4, 0.0, 1.0 ) );
      float sdNeb = 0.5 + 0.5 * sin( sdP.x * 0.8 + sin( sdP.y * 0.7 + uTime * 0.25 ) * 2.0 + sdP.z * 0.5 );
      sdBase += mix( vec3( 0.20, 0.03, 0.30 ), vec3( 0.03, 0.10, 0.30 ), 0.5 + 0.5 * sin( sdP.y * 0.6 - uTime * 0.2 ) ) * sdNeb * 0.55;
      diffuseColor.rgb = sdBase;`,
    glints: ``,
  };
  const EMIT_CODE = {
    rainbow: `totalEmissiveRadiance += sdHue * 0.14;`,
    galaxy: `totalEmissiveRadiance += sdBase * 0.4 + vec3( 1.0, 0.95, 1.0 ) * sdStar * 2.4;`,
    crystal: `{
      float sdFr = pow( 1.0 - abs( dot( normalize( vViewPosition ), normal ) ), 2.2 );
      vec3 sdL = normalize( vec3( sin( uTime * 0.8 ), 0.7, cos( uTime * 0.8 ) ) );
      float sdG = pow( max( 0.0, dot( normal, sdL ) ), 48.0 );
      totalEmissiveRadiance += vec3( 0.55, 0.92, 1.0 ) * sdFr * 0.9 + vec3( 1.0 ) * sdG * 1.4;
    }`,
    golden: `{
      vec3 sdL = normalize( vec3( sin( uTime * 0.7 ), 0.8, cos( uTime * 0.7 ) ) );
      float sdG = pow( max( 0.0, dot( normal, sdL ) ), 40.0 );
      float sdFr = pow( 1.0 - abs( dot( normalize( vViewPosition ), normal ) ), 3.0 );
      totalEmissiveRadiance += vec3( 1.0, 0.85, 0.45 ) * ( sdG * 1.2 + sdFr * 0.35 );
    }`,
  };
  function patchShader(mat, kind, scale) {
    mat.userData.sadeKind = kind;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = U_TIME;
      sh.uniforms.uVScale = { value: scale || 1 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vVWPos;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvVWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + SHADER_HELPERS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + (COLOR_CODE[kind] || ''))
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + (EMIT_CODE[kind] || ''));
      if (mat.userData.glowAttr) {   // lite meshes: per-vertex emissive mask + per-vertex "shiny" (gold / crystal parts)
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aGlow;\nattribute float aShiny;\nvarying float vGlow;\nvarying float vShiny;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvGlow = aGlow; vShiny = aShiny;');
        sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vGlow;\nvarying float vShiny;')
          .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix( metalnessFactor, 0.55, vShiny ); roughnessFactor = mix( roughnessFactor, 0.26, vShiny );')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * vGlow * 1.7;');
      }
    };
    mat.customProgramCacheKey = () => 'sade-' + kind + (mat.userData.glowAttr ? '-g' : '');
    return mat;
  }

  const VLOOK = {
    1: { kind: 'golden', metal: 0.5, rough: 0.28, emissive: '#5a3400', emissiveI: 0.55,
      colors: { skin: '#f6b928', skin2: '#d98e10', belly: '#ffe27a', membrane: '#f3a92a', horn: '#fff0b0', spike: '#ffd34a', claw: '#a8701a',
        glow: '#fff0a0', gold: '#fff2b8', crystal: '#ffe680', shell: '#f6c22e', shell2: '#d9940f' } },
    2: { kind: 'crystal', metal: 0.05, rough: 0.12, opacity: 0.86, emissive: '#1488b8', emissiveI: 0.4,
      colors: { skin: '#8fe9ff', skin2: '#4fc6f2', belly: '#dcfbff', membrane: '#62d4ff', horn: '#ffffff', spike: '#c6f7ff', claw: '#3aa2d6',
        glow: '#c8fbff', gold: '#e8fdff', crystal: '#ffffff', shell: '#a6efff', shell2: '#56cdf5' } },
    3: { kind: 'rainbow', rough: 0.45, metal: 0.05 },
    4: { kind: 'galaxy', rough: 0.4, metal: 0.1 },
  };
  const EGG_OVERRIDE = new Set(['shell', 'shell2']);
  const matCache = new Map();
  function variantMaterial(src, v, scaleHint, egg) {
    if (!src || !v || !VLOOK[v]) return src;
    const name = src.name || '';
    if (KEEP_MATS.has(name)) return src;
    if (egg && !EGG_OVERRIDE.has(name) && !(v >= 3 && name === 'detail')) return src;
    const key = src.uuid + '|' + v + '|' + (scaleHint || 1).toFixed(3);
    let m = matCache.get(key);
    if (m) return m;
    const L = VLOOK[v];
    if (L.colors) {
      m = new THREE.MeshStandardMaterial({
        name, color: L.colors[name] || L.colors.skin, metalness: L.metal, roughness: L.rough,
        emissive: name === 'glow' ? (L.colors.glow) : L.emissive, emissiveIntensity: name === 'glow' ? 1.6 : L.emissiveI,
        flatShading: !!src.flatShading, side: src.side, map: null,
      });
      if (L.opacity && name !== 'gold') { m.transparent = true; m.opacity = name === 'membrane' ? L.opacity - 0.14 : L.opacity; }
      patchShader(m, L.kind, scaleHint);
    } else {
      m = src.clone();
      m.name = name;
      if (m.map && L.kind) m.map = null;
      m.roughness = L.rough; m.metalness = L.metal;
      if (name === 'glow') { m.emissive = new THREE.Color(L.kind === 'galaxy' ? '#9a6bff' : '#ffffff'); m.emissiveIntensity = 1.2; }
      patchShader(m, L.kind, scaleHint);
    }
    matCache.set(key, m);
    return m;
  }

  /* ------------------------------------------------------------------ sprites (alert "!", Zzz fallback) */
  const texCache = {};
  function spriteTex(kind) {
    if (texCache[kind]) return texCache[kind];
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const g = cv.getContext('2d');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (kind === 'alert') {
      g.beginPath(); g.arc(64, 64, 54, 0, TAU); g.fillStyle = '#ffffff'; g.fill();
      g.beginPath(); g.arc(64, 64, 46, 0, TAU); g.fillStyle = '#e8261a'; g.fill();
      g.font = '900 86px "Nunito", "Arial Black", sans-serif';
      g.lineWidth = 8; g.strokeStyle = '#7a0a04'; g.strokeText('!', 64, 70);
      g.fillStyle = '#ffffff'; g.fillText('!', 64, 70);
    } else {
      g.font = '900 96px "Nunito", "Arial Black", sans-serif';
      g.lineWidth = 12; g.strokeStyle = '#26324a'; g.strokeText('Z', 64, 68);
      g.fillStyle = '#ffffff'; g.fillText('Z', 64, 68);
    }
    const t = new THREE.CanvasTexture(cv);
    t.encoding = THREE.sRGBEncoding;
    texCache[kind] = t;
    return t;
  }

  /* ------------------------------------------------------------------ helpers */
  function ownMeshes(node) {
    const out = [];
    if (!node) return out;
    if (node.isMesh) out.push(node);
    node.children.forEach((c) => { if (c.isMesh && !NODE_NAMES.has(c.name) && !c.children.length) out.push(c); });
    return out;
  }
  function matName(mesh) { return (mesh.material && mesh.material.name) || ''; }
  function assetModel(species, baby) {
    const A = SE.Assets;
    const key = A ? A.dragonKey(species, baby) : 'dragon.' + species + '.' + (baby ? 'baby' : 'adult');
    if (A && A.has(key)) return { obj: A.get(key), key, fallback: false };
    if (baby && A && A.has(A.dragonKey(species, false))) {
      if (!assetModel.warned[key]) { assetModel.warned[key] = true; console.warn('SE.DragonModels: ' + key + ' missing — using the adult model at baby size'); }
      return { obj: A.get(A.dragonKey(species, false)), key: A.dragonKey(species, false), fallback: 'adult' };
    }
    return { obj: A ? A.get(key) : new THREE.Group(), key, fallback: 'placeholder' };
  }
  assetModel.warned = {};

  /* ------------------------------------------------------------------ lite merge (per animated part) */
  const HIDDEN = new THREE.MeshBasicMaterial({ visible: false });
  const LITE_BABY = { body: ['body', 'neck'], head: ['head', 'jaw'], wing_L: ['wing_L', 'wing_L_tip'], wing_R: ['wing_R', 'wing_R_tip'],
    tail_1: ['tail_1', 'tail_2', 'tail_3', 'tail_4'], leg_FL: ['leg_FL'], leg_FR: ['leg_FR'], leg_BL: ['leg_BL'], leg_BR: ['leg_BR'], halo: ['halo'] };
  /* micro (followers on 'low'): legs + tail merged into the body → 4–5 draw calls + eyes; legs/tail stay at rest */
  const LITE_MICRO = { body: ['body', 'neck', 'tail_1', 'tail_2', 'tail_3', 'tail_4', 'leg_FL', 'leg_FR', 'leg_BL', 'leg_BR'],
    head: ['head', 'jaw'], wing_L: ['wing_L', 'wing_L_tip'], wing_R: ['wing_R', 'wing_R_tip'], halo: ['halo'] };
  const LITE_ADULT = {};
  PARTS.concat(['halo']).forEach((p) => { LITE_ADULT[p] = [p]; });
  /* shadow casters of lite rigs (draw-call budget, SPEC §9): the big shapes only — eyes, jaw, wing tips, tail tip
     and (for babies) legs add shadow-pass draw calls without a visible difference */
  const SHADOW_BABY = new Set(['body', 'head', 'wing_L', 'wing_R']);
  const SHADOW_ADULT = new Set(['body', 'neck', 'head', 'wing_L', 'wing_R', 'tail_1', 'tail_2', 'leg_FL', 'leg_FR', 'leg_BL', 'leg_BR']);
  const liteGeoCache = new Map();
  const liteMatCache = new Map();

  function isShiny(m) { return m && (m.name === 'gold' || m.name === 'crystal' || (m.metalness || 0) >= 0.3); }
  function liteMaterial(v, shiny, transparent, scaleHint) {
    const key = v + '|' + (shiny ? 's' : 'm') + '|' + (transparent ? 't' : 'o') + '|' + (scaleHint || 1).toFixed(3);
    let m = liteMatCache.get(key);
    if (m) return m;
    const L = VLOOK[v];
    m = new THREE.MeshStandardMaterial({
      vertexColors: true, side: THREE.DoubleSide,
      roughness: L ? L.rough : (shiny ? 0.3 : 0.62), metalness: L ? L.metal : (shiny ? 0.45 : 0.02),
    });
    if (L && L.emissive && L.colors) { m.emissive = new THREE.Color(L.emissive); m.emissiveIntensity = L.emissiveI; }
    if (transparent) { m.transparent = true; m.opacity = L && L.opacity ? L.opacity : 0.85; }
    m.userData.glowAttr = true;
    patchShader(m, L ? L.kind : 'plain', scaleHint);
    liteMatCache.set(key, m);
    return m;
  }

  // Build merged geometries for one asset + variant: { partName: [{ geo, shiny }] }
  function buildLite(srcRoot, map, v, scaleHint) {
    const out = {};
    srcRoot.updateMatrixWorld(true);
    const inv = new THREE.Matrix4(), rel = new THREE.Matrix4(), col = new THREE.Color();
    Object.keys(map).forEach((target) => {
      const tNode = SE.Assets.getPart(srcRoot, target);
      if (!tNode) return;
      inv.copy(tNode.matrixWorld).invert();
      const buckets = { m: [], s: [] };
      map[target].forEach((srcName) => {
        const node = SE.Assets.getPart(srcRoot, srcName);
        ownMeshes(node).forEach((mesh) => {
          const nm = matName(mesh);
          if (KEEP_MATS.has(nm)) return;
          const vm = variantMaterial(mesh.material, v, scaleHint) || mesh.material;
          rel.multiplyMatrices(inv, mesh.matrixWorld);
          let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
          g.applyMatrix4(rel);
          const n = g.attributes.position.count;
          const glow = nm === 'glow' || (vm.emissive && vm.emissiveIntensity * (vm.emissive.r + vm.emissive.g + vm.emissive.b) > 0.6 && nm !== 'skin');
          col.copy(glow && vm.emissive && !(VLOOK[v] && !VLOOK[v].colors) ? (nm === 'glow' ? vm.emissive : vm.color) : vm.color);
          const ca = new Float32Array(n * 3), ga = new Float32Array(n), sa = new Float32Array(n);
          const shiny = isShiny(vm) ? 1 : 0;
          for (let i = 0; i < n; i++) { ca[i * 3] = col.r; ca[i * 3 + 1] = col.g; ca[i * 3 + 2] = col.b; ga[i] = glow ? 1 : 0; sa[i] = shiny; }
          const clean = new THREE.BufferGeometry();
          clean.setAttribute('position', g.attributes.position);
          if (g.attributes.normal) clean.setAttribute('normal', g.attributes.normal);
          clean.setAttribute('color', new THREE.BufferAttribute(ca, 3));
          clean.setAttribute('aGlow', new THREE.BufferAttribute(ga, 1));
          clean.setAttribute('aShiny', new THREE.BufferAttribute(sa, 1));
          buckets.m.push(clean);                       // one mesh per part (shininess is per vertex)
        });
      });
      out[target] = [];
      ['m', 's'].forEach((k) => {
        if (!buckets[k].length) return;
        const merged = buckets[k].length === 1 ? buckets[k][0] : THREE.BufferGeometryUtils.mergeBufferGeometries(buckets[k], false);
        if (!merged) return;
        if (!merged.attributes.normal) merged.computeVertexNormals();
        merged.computeBoundingSphere();
        out[target].push({ geo: merged, shiny: k === 's' });
      });
    });
    return out;
  }

  function applyLite(rig) {
    if (rig.placeholder || !THREE.BufferGeometryUtils || !SE.Assets || !SE.Assets.source) return false;
    const src = SE.Assets.source(rig.assetKey);
    if (!src) return false;
    const map = rig.baby ? (rig.micro ? LITE_MICRO : LITE_BABY) : LITE_ADULT;
    const key = rig.assetKey + '|' + rig.variant + '|' + (rig.baby ? (rig.micro ? 'm' : 'b') : 'a');
    let lite = liteGeoCache.get(key);
    if (!lite) { lite = buildLite(src, map, rig.variant, rig.vscale); liteGeoCache.set(key, lite); }
    const transparent = !!(VLOOK[rig.variant] && VLOOK[rig.variant].opacity);
    // remove the original (non-eye) meshes of every merged node
    Object.keys(map).forEach((target) => {
      map[target].forEach((srcName) => {
        const node = rig.nodes[srcName] || SE.Assets.getPart(rig.model, srcName);
        ownMeshes(node).forEach((mesh) => {
          if (KEEP_MATS.has(matName(mesh)) && !mesh.userData.liteMerged) return;
          if (mesh === node) { mesh.material = HIDDEN; mesh.castShadow = false; }
          else if (mesh.parent) mesh.parent.remove(mesh);
        });
      });
    });
    // eyes of merged-away nodes (jaw has none; head keeps its own)
    Object.keys(lite).forEach((target) => {
      const tNode = rig.nodes[target] || SE.Assets.getPart(rig.model, target);
      if (!tNode) return;
      lite[target].forEach((L) => {
        const m = new THREE.Mesh(L.geo, liteMaterial(rig.variant, L.shiny, transparent, rig.vscale));
        m.name = target + '_lite';
        m.userData.liteMerged = true;
        m.userData.castOK = (rig.baby ? SHADOW_BABY : SHADOW_ADULT).has(target);
        m.castShadow = rig.shadows && m.userData.castOK; m.receiveShadow = false;
        tNode.add(m);
      });
    });
    if (rig.baby) rig.frozen = new Set([NK, JW, WLT, WRT, PI.tail_2, PI.tail_3, PI.tail_4]);
    if (rig.micro) [T1, FL, FR, BL, BR].forEach((i) => rig.frozen.add(i));
    rig.lite = true;
    return true;
  }

  /* ------------------------------------------------------------------ poses */
  const SLEEP_FIT0 = { dx: 0, dz: 0, tail: 0, wing: 0, tip: 0 };
  const sleepFitCache = new Map();
  const _sv = new THREE.Vector3();
  /* Measure the pure sleep pose of a rig once (cached per model): lift the tail / wing tips until they stay above the
     ground, then centre the curled footprint (XZ bounding box) on the rig origin. Values in body-parent units. */
  function fitSleep(rig) {
    if (rig.placeholder || rig.baby || !rig.nodes.body) return SLEEP_FIT0;
    const key = rig.assetKey + (rig.drake ? '|d' : '');
    if (sleepFitCache.has(key)) return sleepFitCache.get(key);
    const F = { dx: 0, dz: 0, tail: 0, wing: 0, tip: 0 }, body = rig.nodes.body, frame = body.parent;
    const TAILS = ['tail_1', 'tail_2', 'tail_3', 'tail_4'], WINGS = ['wing_L', 'wing_L_tip', 'wing_R', 'wing_R_tip'];
    rig.sleepFit = F;
    const measure = function () {
      rig.P.fill(0); POSES.sleep(rig.P, rig, 0); rig.apply();
      rig.group.updateMatrixWorld(true);
      const m = { tail: Infinity, wing: Infinity, x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
      rig.model.traverse(function (o) {
        if (!o.isMesh || o.material === HIDDEN || !o.visible) return;
        let q = o; while (q && TAILS.indexOf(q.name) < 0 && WINGS.indexOf(q.name) < 0 && q !== rig.model) q = q.parent;
        const grp = q && TAILS.indexOf(q.name) >= 0 ? 'tail' : q && WINGS.indexOf(q.name) >= 0 ? 'wing' : '';
        const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 1500));
        for (let k = 0; k < pos.count; k += step) {
          _sv.fromBufferAttribute(pos, k).applyMatrix4(o.matrixWorld);
          if (grp) m[grp] = Math.min(m[grp], _sv.y);
          frame.worldToLocal(_sv);
          m.x0 = Math.min(m.x0, _sv.x); m.x1 = Math.max(m.x1, _sv.x); m.z0 = Math.min(m.z0, _sv.z); m.z1 = Math.max(m.z1, _sv.z);
        }
      });
      return m;
    };
    const ground = 0.08 * rig.S * rig.modelScale;
    let m = measure();
    for (let it = 0; it < 14 && m.tail < ground; it++) { F.tail += 0.04; m = measure(); }
    for (let it = 0; it < 14 && m.wing < ground; it++) { F.wing += 0.06; F.tip += 0.04; m = measure(); }
    F.dx = -(m.x0 + m.x1) / 2; F.dz = -(m.z0 + m.z1) / 2;
    rig.P.fill(0); rig.apply();
    sleepFitCache.set(key, F);
    return F;
  }
  function P6(P, i, rx, ry, rz) { const o = i * 6; P[o] += rx; P[o + 1] += ry; P[o + 2] += rz; }
  function PP(P, i, px, py, pz) { const o = i * 6; P[o + 3] += px; P[o + 4] += py; P[o + 5] += pz; }
  function wings(P, rz, rx, ry, tip) { P6(P, WL, rx, ry, rz); P6(P, WR, rx, -ry, -rz); P6(P, WLT, 0, 0, tip); P6(P, WRT, 0, 0, -tip); }
  function tail(P, k, rx, ry) { P6(P, T1 + k, rx, ry, 0); }

  const POSES = {
    idle(P, r, t) {
      const S = r.S, br = Math.sin(t * (r.baby ? 2.4 : 1.7));
      const amp = r.baby ? 2.2 : 1;
      PP(P, B, 0, 0.012 * S * br * amp, 0); P6(P, B, 0.012 * br * amp, 0, 0);
      P6(P, NK, -0.03 * br, r.idleYaw * 0.35, 0);
      P6(P, HD, 0.03 * br + r.idlePitch, r.idleYaw * 0.65, r.baby ? 0.12 * Math.sin(t * 0.6) : 0.03 * Math.sin(t * 0.5));
      P6(P, JW, 0.02 + 0.02 * Math.sin(t * 0.9), 0, 0);
      wings(P, 0.03 * Math.sin(t * 1.7 + 1), -0.05, 0, 0.02 * Math.sin(t * 1.7));
      for (let k = 0; k < 4; k++) tail(P, k, 0.02 * Math.sin(t * 0.8 - k * 0.4), Math.sin(t * 1.1 - k * 0.55) * (0.06 + 0.03 * k));
    },
    walk(P, r, t) {
      const S = r.S, f = r.gait, s = Math.sin(f), c = Math.cos(f), c2 = Math.cos(2 * f);
      const A = r.baby ? 0.5 : 0.42, lift = 0.06 * S;
      P6(P, FL, A * s, 0, 0); P6(P, BR, A * s, 0, 0); P6(P, FR, -A * s, 0, 0); P6(P, BL, -A * s, 0, 0);
      PP(P, FL, 0, lift * Math.max(0, -c), 0); PP(P, BR, 0, lift * Math.max(0, -c), 0);
      PP(P, FR, 0, lift * Math.max(0, c), 0); PP(P, BL, 0, lift * Math.max(0, c), 0);
      PP(P, B, 0, -0.02 * S * c2 * (r.baby ? 2 : 1), 0); P6(P, B, 0.01 * c2, 0.03 * s, 0.025 * s);
      P6(P, NK, 0.05 + 0.03 * Math.cos(2 * f + 0.6), -0.04 * s + r.idleYaw * 0.15, 0);
      P6(P, HD, -0.03 * Math.cos(2 * f + 1.0), -0.03 * s + r.idleYaw * 0.3, 0);
      P6(P, JW, 0.04, 0, 0);
      wings(P, -0.06 + 0.04 * c2, -0.12, 0, 0.03 * c2);
      for (let k = 0; k < 4; k++) tail(P, k, 0.02 * Math.cos(2 * f - k * 0.5), Math.sin(f - k * 0.7) * (0.07 + 0.035 * k));
    },
    run(P, r, t) {
      const S = r.S, f = r.gait, A = r.baby ? 0.85 : 0.75, lift = 0.09 * S;
      const fl = Math.sin(f), fr = Math.sin(f + 0.35), bl = Math.sin(f + Math.PI), br = Math.sin(f + Math.PI + 0.35);
      P6(P, FL, A * fl, 0, 0); P6(P, FR, A * fr, 0, 0); P6(P, BL, A * bl, 0, 0); P6(P, BR, A * br, 0, 0);
      PP(P, FL, 0, lift * Math.max(0, -Math.cos(f)), 0); PP(P, FR, 0, lift * Math.max(0, -Math.cos(f + 0.35)), 0);
      PP(P, BL, 0, lift * Math.max(0, Math.cos(f)), 0); PP(P, BR, 0, lift * Math.max(0, Math.cos(f + 0.35)), 0);
      P6(P, B, 0.09 * Math.cos(f), 0.02 * Math.sin(f), 0.02 * Math.sin(f * 0.5));
      PP(P, B, 0, -0.045 * S * Math.cos(2 * f) + 0.01 * S, 0);
      P6(P, NK, 0.18 + 0.06 * Math.sin(f + 1.2), r.idleYaw * 0.1, 0);
      P6(P, HD, -0.14 - 0.07 * Math.sin(f + 1.5), r.idleYaw * 0.2, 0);
      P6(P, JW, 0.14, 0, 0);
      wings(P, -0.32 + 0.12 * Math.sin(2 * f), -0.18, 0, 0.1 * Math.sin(2 * f - 0.8));
      for (let k = 0; k < 4; k++) tail(P, k, 0.1 + 0.06 * Math.sin(f - k * 0.6), 0.05 * Math.sin(f * 0.5 - k * 0.5));
    },
    fly(P, r, t) {
      const S = r.S, w = TAU * (r.baby ? 3.2 : (r.drake ? 2.1 : 1.55)) * r.flap, ph = r.flyT * w;
      const f = Math.sin(ph);
      wings(P, -1.0 + 0.68 * f, -0.08 + 0.12 * Math.cos(ph), 0, 0.36 * Math.sin(ph - 1.0));
      PP(P, B, 0, -0.06 * S * f, 0); P6(P, B, -0.06 + 0.03 * Math.cos(ph), 0, 0);
      P6(P, FL, 1.05, 0, 0); P6(P, FR, 1.05, 0, 0); P6(P, BL, 1.25, 0, 0); P6(P, BR, 1.25, 0, 0);
      PP(P, BL, 0, 0.05 * S, 0); PP(P, BR, 0, 0.05 * S, 0);
      P6(P, NK, 0.12, r.idleYaw * 0.15, 0); P6(P, HD, -0.08 + 0.03 * f, r.idleYaw * 0.3, 0);
      P6(P, JW, 0.05, 0, 0);
      for (let k = 0; k < 4; k++) tail(P, k, 0.04 + 0.05 * Math.sin(ph * 0.5 - k * 0.6), 0.08 * Math.sin(t * 1.3 - k * 0.6));
    },
    sleep(P, r, t) {
      // curled up like a cat (head and tail both wrap to the dragon's left). r.sleepFit (measured once per model,
      // fitSleep) recentres the curled shape on the rig origin (= the nest centre) and lifts the tail / wing tips so
      // nothing dips below the ground.
      const S = r.S, b = Math.sin(t * 0.9), F = r.sleepFit || SLEEP_FIT0;
      PP(P, B, F.dx, -r.lieDrop + 0.01 * S * b, F.dz); P6(P, B, 0.03 + 0.01 * b, 0, 0.04);
      P6(P, FL, -1.2, 0.3, 0); P6(P, FR, -1.2, -0.05, 0);
      P6(P, BL, -1.4, 0, 0.42); P6(P, BR, -1.4, 0, -0.42);
      P6(P, NK, r.sleepNeck, 0.62, 0); P6(P, HD, 0.3 + 0.02 * b, 0.55, 0.12);
      wings(P, -1.25 + F.wing, -0.12, 1.0, 0.08 + F.tip);       // arm out flat, swept back over the flank
      for (let k = 0; k < 4; k++) tail(P, k, -0.06 + F.tail, -0.52);
    },
    wake(P, r, t) {
      POSES.idle(P, r, t);
      const u = clamp(r.stateT / r.stateDur, 0, 1), env = Math.sin(Math.PI * u);
      const shake = u < 0.6 ? Math.sin(t * 16) * smooth(0, 0.15, u) * (1 - smooth(0.4, 0.6, u)) : 0;
      P6(P, HD, -0.25 * env, 0.3 * shake, 0.1 * shake);
      P6(P, JW, 0.5 * smooth(0.2, 0.4, u) * (1 - smooth(0.55, 0.75, u)), 0, 0);
      wings(P, -0.55 * env, 0, 0, 0.2 * env);
      P6(P, B, -0.08 * env, 0, 0); PP(P, B, 0, 0.02 * r.S * env, 0);
      for (let k = 0; k < 4; k++) tail(P, k, 0.15 * env, 0);
    },
    roar(P, r, t) {
      const S = r.S, u = clamp(r.stateT / r.stateDur, 0, 1);
      const rise = smooth(0, 0.18, u) * (1 - smooth(0.82, 1, u));
      const vib = Math.sin(t * 34) * rise;
      P6(P, B, -0.22 * rise, 0, 0); PP(P, B, 0, 0.05 * S * rise, 0);
      P6(P, NK, -0.35 * rise, 0, 0); P6(P, HD, -0.3 * rise + 0.03 * vib, 0.05 * vib, 0);
      P6(P, JW, 0.8 * rise, 0, 0);
      wings(P, -0.75 * rise + 0.07 * Math.sin(t * 25) * rise, -0.05 * rise, 0, 0.25 * rise);
      P6(P, FL, -0.25 * rise, 0, 0); P6(P, FR, -0.25 * rise, 0, 0); P6(P, BL, 0.12 * rise, 0, 0); P6(P, BR, 0.12 * rise, 0, 0);
      for (let k = 0; k < 4; k++) tail(P, k, 0.25 * rise / (k + 1), 0.15 * Math.sin(t * 12 - k) * rise);
    },
    breath(P, r, t) {           // jaw wide, head level and thrust forward (frost breath / fire spit)
      const u = clamp(r.stateT / Math.max(0.1, r.stateDur || 0.8), 0, 1);
      const k = smooth(0, 0.12, u) * (1 - smooth(0.85, 1, u));
      P6(P, B, -0.06 * k, 0, 0); PP(P, B, 0, 0.02 * r.S * k, 0);
      P6(P, NK, 0.12 * k, 0.04 * Math.sin(t * 9) * k, 0); P6(P, HD, 0.02 * k, 0.05 * Math.sin(t * 7) * k, 0);
      P6(P, JW, 0.7 * k, 0, 0);
      wings(P, -0.45 * k, -0.1, 0, 0.15 * k);
      P6(P, FL, -0.2 * k, 0, 0); P6(P, FR, -0.2 * k, 0, 0); P6(P, BL, 0.15 * k, 0, 0); P6(P, BR, 0.15 * k, 0, 0);
      for (let k2 = 0; k2 < 4; k2++) tail(P, k2, 0.12 * k, 0.1 * Math.sin(t * 6 - k2) * k);
    },
    sit(P, r, t) {
      const S = r.S;
      P6(P, B, -0.42, 0, 0); PP(P, B, 0, -0.16 * S, -0.05 * S);
      P6(P, BL, -1.15, 0, 0.12); P6(P, BR, -1.15, 0, -0.12); P6(P, FL, 0.42, 0, 0); P6(P, FR, 0.42, 0, 0);
      P6(P, NK, 0.25, r.idleYaw * 0.3, 0); P6(P, HD, 0.12 + 0.05 * Math.sin(t * 1.3), r.idleYaw * 0.5, 0.18 * Math.sin(t * 0.7));
      P6(P, JW, 0.06, 0, 0);
      wings(P, 0.04 * Math.sin(t * 2), -0.05, 0, 0);
      for (let k = 0; k < 4; k++) tail(P, k, k === 0 ? -0.25 : -0.05, 0.2 * Math.sin(t * 1.5 - k * 0.6));
    },
    happy(P, r, t) {
      const S = r.S, hop = Math.abs(Math.sin(t * 7.5));
      PP(P, B, 0, 0.22 * S * hop, 0); P6(P, B, -0.08 * hop, 0, 0);
      P6(P, FL, -0.3 * hop, 0, 0); P6(P, FR, -0.3 * hop, 0, 0); P6(P, BL, 0.35 * hop, 0, 0); P6(P, BR, 0.35 * hop, 0, 0);
      wings(P, -0.55 + 0.35 * Math.sin(t * 28), 0, 0, 0.15 * Math.sin(t * 28 - 1));
      P6(P, HD, -0.1, 0, 0.2 * Math.sin(t * 3.2)); P6(P, JW, 0.35, 0, 0);
      for (let k = 0; k < 4; k++) tail(P, k, 0.05, 0.35 * Math.sin(t * 14 - k * 0.5));
    },
  };
  const TIMED = { wake: 1.4, roar: 1.0 };
  const FADE_IN = { idle: 0.3, walk: 0.22, run: 0.2, fly: 0.35, sleep: 0.9, wake: 0.7, roar: 0.12, sit: 0.35, happy: 0.15, breath: 0.1 };

  /* ------------------------------------------------------------------ Rig */
  function Rig(species, opts) {
    opts = opts || {};
    this.species = species;
    this.baby = !!opts.baby;
    this.drake = !this.baby && !!opts.drake;
    this.variant = opts.variant | 0;
    this.fxOn = opts.fx !== false;
    this.shadows = opts.shadows !== false;
    this.micro = this.baby && !!opts.micro;
    this.roarFx = true;
    this.onStateEnd = null;
    this.group = new THREE.Group();
    this.group.name = 'dragon_' + species + (this.baby ? '_baby' : (this.drake ? '_drake' : '_adult'));
    const a = assetModel(species, this.baby);
    this.model = a.obj;
    this.assetKey = a.key;
    this.placeholder = a.fallback === 'placeholder' || !!(a.obj.userData && a.obj.userData.placeholder);
    this.group.add(this.model);
    let scale = 1;
    if (a.fallback === 'adult') scale = 0.24;
    if (this.drake) scale = 0.55;
    this.model.scale.setScalar(scale);
    this.modelScale = scale;
    // nodes
    this.nodes = {};
    this.parts = [];
    PARTS.forEach((n, i) => {
      const o = this.placeholder ? null : SE.Assets.getPart(this.model, n);
      this.parts[i] = o;
      this.nodes[n] = o;
      if (o && (n === 'neck' || n === 'head' || n.indexOf('tail') === 0 || n === 'body')) o.rotation.order = 'YXZ';
    });
    ['fx_mouth', 'fx_back', 'halo', 'root'].forEach((n) => { this.nodes[n] = this.placeholder ? null : SE.Assets.getPart(this.model, n); });
    this.rest = new Float32Array(NC);
    this.parts.forEach((o, i) => {
      if (!o) return;
      this.rest[i * 6] = o.rotation.x; this.rest[i * 6 + 1] = o.rotation.y; this.rest[i * 6 + 2] = o.rotation.z;
      this.rest[i * 6 + 3] = o.position.x; this.rest[i * 6 + 4] = o.position.y; this.rest[i * 6 + 5] = o.position.z;
    });
    this.head = this.nodes.head;
    this.mouth = this.nodes.fx_mouth || this.nodes.head || this.model;
    // measurements (model units)
    const body = this.nodes.body;
    this.S = body ? body.position.y : 1.5;
    this.lieDrop = this.S * 0.45;
    if (body) {
      let minY = Infinity;
      ownMeshes(body).forEach((m) => { if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); minY = Math.min(minY, m.geometry.boundingBox.min.y + (m === body ? 0 : m.position.y)); });
      if (isFinite(minY)) this.lieDrop = clamp(this.S + minY - 0.04 * this.S, this.S * 0.25, this.S * 0.85);
    }
    this.sleepNeck = this.baby ? 0.75 : 1.05;
    this.model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.model);
    const sz = box.getSize(new THREE.Vector3());
    this.size = this.S * scale;
    this.height = Math.max(0.5, box.max.y);
    this.length = sz.z;
    this.vscale = 1 / Math.max(0.2, this.S * scale);       // shader pattern scale (≈ per hip height)
    // head top above the head pivot, in head-local (model) units
    this.headTop = this.head ? (new THREE.Box3().setFromObject(this.head).max.y - this.head.getWorldPosition(new THREE.Vector3()).y) / scale : this.S;
    this.shadowsSet();
    // eyes (blink)
    this.eyes = [];
    if (this.head) {
      ownMeshes(this.head).forEach((m) => {
        if (!KEEP_MATS.has(matName(m))) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox;
        this.eyes.push({ mesh: m, cy: (bb.min.y + bb.max.y) / 2, py: m.position.y, sy: m.scale.y });
      });
    }
    // animation state
    this.P = new Float32Array(NC);
    this.T = new Float32Array(NC);
    this.weights = {}; STATES.forEach((s) => { this.weights[s] = 0; });
    this.state = 'idle'; this.weights.idle = 1;
    this.stateT = 0; this.stateDur = 0; this.next = null; this.fade = FADE_IN.idle;
    this.t = Math.random() * 10; this.gait = 0; this.flyT = 0; this.flap = 1;
    this.timeScale = this.drake ? 1.25 : 1;
    this.idleYaw = 0; this.idlePitch = 0; this.idleTarget = 0; this.idleTimer = 1 + Math.random() * 2;
    this.lookTarget = null; this.lookYaw = 0; this.lookPitch = 0; this.lookW = 1;
    this.blinkT = 2 + Math.random() * 3; this.blinkK = 1;
    this.frozen = null;
    this.fxHandles = [];
    this.zzz = null; this.alert = null; this.alertOn = false; this.alertT = 0;
    this.lite = false;
    this.applyVariant(this.variant);
    if (opts.lite || this.micro) applyLite(this);
    if (this.lite) this.shadowsSet();
    this.startVariantFx();
    this.sleepFit = fitSleep(this);
    this.apply();
  }

  Rig.prototype = {
    shadowsSet() {
      const on = this.shadows;
      const lite = this.lite;
      this.model.traverse((o) => { if (o.isMesh) { o.castShadow = on && o.material !== HIDDEN && (!lite || !!o.userData.castOK); o.receiveShadow = false; } });
    },
    applyVariant(v) {
      if (this.placeholder) return;
      this.model.traverse((o) => {
        if (!o.isMesh || o.userData.liteMerged || o.material === HIDDEN) return;
        if (!o.userData.srcMat) o.userData.srcMat = o.material;
        o.material = v ? variantMaterial(o.userData.srcMat, v, this.vscale) : o.userData.srcMat;
      });
    },
    setVariant(v) {
      v = v | 0;
      if (v === this.variant) return this;
      this.variant = v;
      if (this.lite) {
        // rebuild merged meshes for the new variant
        this.model.traverse((o) => { if (o.userData && o.userData.liteMerged) this._dead = (this._dead || []).concat(o); });
        (this._dead || []).forEach((o) => o.parent && o.parent.remove(o));
        this._dead = null;
        this.applyVariant(v);
        applyLite(this);
      } else this.applyVariant(v);
      this.stopVariantFx();
      this.startVariantFx();
      return this;
    },
    startVariantFx() {
      const name = VARIANT_FX[this.variant];
      if (!this.fxOn || !name || !SE.FX) return;
      // babies: one emitter around the body; adults: body + head + tail so the shimmer covers the length
      const anchors = this.baby ? [[this.nodes.body, 0.92, [0, 0.2, 0]]]
        : [[this.nodes.body, 2.4, [0, 0.5, 0]], [this.nodes.head, 1.5, [0, 0.8, 0.6]], [this.nodes.tail_2, 1.6, [0, 0, -1]]];
      const hs = anchors.filter((a) => a[0]).map((a) => SE.FX.attach(name, a[0], { scale: a[1] * this.modelScale, offset: a[2] }));
      this.variantFx = { stop() { hs.forEach((h) => h.stop()); } };
    },
    stopVariantFx() { if (this.variantFx) { this.variantFx.stop(); this.variantFx = null; } },

    setState(s, o) {
      if (!POSES[s]) return this;
      o = o || {};
      if (s === this.state && !TIMED[s]) return this;
      const prev = this.state;
      this.state = s;
      this.stateT = 0;
      this.stateDur = o.duration || TIMED[s] || 0;
      this.next = o.next || null;
      this.fade = o.fade != null ? o.fade : (prev === 'sleep' ? 0.7 : FADE_IN[s]);
      if (s === 'fly' && prev !== 'fly') this.flyT = 0;
      if (s === 'roar') this.roarFxAt = 0.14;
      if (s === 'sleep') this.startZzz(); else if (prev === 'sleep') this.stopZzz();
      if (o.snap) { STATES.forEach((k) => { this.weights[k] = k === s ? 1 : 0; }); }
      return this;
    },
    setSleeping(on) { return this.setState(on ? 'sleep' : (this.state === 'sleep' ? 'wake' : this.state)); },
    setLookTarget(v) { this.lookTarget = v ? (this.lookTarget || new THREE.Vector3()).copy(v) : null; return this; },
    setTimeScale(k) { this.timeScale = k || 1; return this; },
    mergeStatic() { if (!this.lite) applyLite(this); this.shadowsSet(); return this; },

    startZzz() {
      if (this.zzz || !this.head) return;
      const anchor = new THREE.Object3D();
      anchor.position.set(0, this.headTop * 0.9 / 1, 0);
      this.head.add(anchor);
      this.zzz = { anchor };
      if (SE.FX && SE.FX.attach) {
        this.zzz.h = SE.FX.attach('zzz', anchor, { scale: this.baby ? 0.6 : 2.0 * this.modelScale, cull: 140 });
      } else {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTex('z'), transparent: true, depthWrite: false }));
        const k = this.baby ? 0.8 : 3;
        sp.scale.set(k, k, k);
        anchor.add(sp);
        this.zzz.sprite = sp;
      }
    },
    stopZzz() {
      if (!this.zzz) return;
      if (this.zzz.h) this.zzz.h.stop();
      if (this.zzz.anchor.parent) this.zzz.anchor.parent.remove(this.zzz.anchor);
      this.zzz = null;
    },
    setAlert(on) {
      on = !!on;
      if (on === this.alertOn) return this;
      this.alertOn = on; this.alertT = 0;
      if (on && !this.alert) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTex('alert'), transparent: true, depthWrite: false, depthTest: false }));
        sp.renderOrder = 40;
        this.alert = sp;
        (this.head || this.model).add(sp);
        sp.position.set(0, this.headTop + (this.baby ? 0.7 : 2.4), 0);
      }
      if (this.alert) this.alert.visible = on;
      return this;
    },

    update(dt, moveSpeed) {
      autoTick();
      dt = Math.min(Math.max(dt || 0, 0), 0.1) * this.timeScale;
      const ws = this.modelScale * (this.group.scale.x || 1);
      this.t += dt;
      this.stateT += dt;
      // timed states
      if (this.stateDur && this.stateT >= this.stateDur) {
        const ended = this.state;
        this.setState(this.next || 'idle');
        if (this.onStateEnd) { try { this.onStateEnd(ended); } catch (e) { console.error(e); } }
      }
      if (this.state === 'roar' && this.roarFxAt != null && this.stateT >= this.roarFxAt) {
        this.roarFxAt = null;
        if (this.roarFx && SE.FX && this.mouth) {
          const p = this.mouth.getWorldPosition(new THREE.Vector3());
          const q = this.group.getWorldQuaternion(new THREE.Quaternion());
          const dir = new THREE.Vector3(0, 0.15, 1).applyQuaternion(q).normalize();
          SE.FX.emit('roar_wave', p, { dir, groundY: this.group.getWorldPosition(new THREE.Vector3()).y, scale: this.baby ? 0.25 : ws });
        }
      }
      // gait phase (world units: stride ≈ 2.2 / 3 hip heights)
      const speed = Math.max(0, moveSpeed || 0);
      const Sw = Math.max(0.1, this.S * ws);
      if (this.state === 'walk' || this.state === 'run') {
        const stride = (this.state === 'run' ? 3.0 : 2.2) * Sw;
        const v = Math.max(speed, this.state === 'run' ? 0.6 * Sw * 2 : 0.3 * Sw);
        this.gait += TAU * v / stride * dt / this.timeScale * (this.drake ? 1.0 : 1);
      }
      this.flyT += dt;
      // idle look-around
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) {
        this.idleTimer = 1.8 + Math.random() * 2.8;
        this.idleTarget = (Math.random() - 0.5) * (this.baby ? 1.1 : 0.9);
        this.idlePitchT = (Math.random() - 0.6) * 0.18;
      }
      this.idleYaw = damp(this.idleYaw, this.lookTarget ? 0 : this.idleTarget, 2.2, dt);
      this.idlePitch = damp(this.idlePitch, this.lookTarget ? 0 : (this.idlePitchT || 0), 2, dt);
      // weights
      let sum = 0;
      const step = dt / Math.max(0.05, this.fade);
      for (let i = 0; i < STATES.length; i++) {
        const s = STATES[i];
        let w = this.weights[s];
        w = s === this.state ? Math.min(1, w + step) : Math.max(0, w - step);
        this.weights[s] = w; sum += w;
      }
      // pose
      const P = this.P;
      P.fill(0);
      const T = this.T;
      for (let i = 0; i < STATES.length; i++) {
        const s = STATES[i], w = this.weights[s];
        if (w < 0.001) continue;
        T.fill(0);
        POSES[s](T, this, this.t);
        const k = w / Math.max(1e-4, sum);
        for (let c = 0; c < NC; c++) P[c] += T[c] * k;
      }
      // look-at
      const sleepW = this.weights.sleep / Math.max(1e-4, sum);
      this.lookW = damp(this.lookW, this.lookTarget && this.state !== 'sleep' ? (this.state === 'roar' ? 0.5 : 1) : 0, 5, dt);
      if (this.lookTarget && this.head) {
        const lp = this.group.worldToLocal(_v1.copy(this.lookTarget));
        const hy = this.height * 0.8;
        const yaw = clamp(Math.atan2(lp.x, lp.z - this.length * 0.15), -1.1, 1.1);
        const pitch = clamp(Math.atan2(lp.y - hy, Math.hypot(lp.x, lp.z)), -0.45, 0.45);
        this.lookYaw = damp(this.lookYaw, yaw, 6, dt);
        this.lookPitch = damp(this.lookPitch, pitch, 6, dt);
      } else {
        this.lookYaw = damp(this.lookYaw, 0, 3, dt); this.lookPitch = damp(this.lookPitch, 0, 3, dt);
      }
      const lw = this.lookW * (1 - sleepW);
      P[NK * 6 + 1] += this.lookYaw * 0.35 * lw; P[HD * 6 + 1] += this.lookYaw * 0.65 * lw;
      P[NK * 6] -= this.lookPitch * 0.3 * lw; P[HD * 6] -= this.lookPitch * 0.7 * lw;
      // blink (eyes closed while asleep)
      this.blinkT -= dt;
      let eye = 1;
      if (this.blinkT < 0) { eye = Math.abs(this.blinkT + 0.07) / 0.07; if (this.blinkT < -0.14) this.blinkT = 2.2 + Math.random() * 3.5; }
      eye = Math.min(eye, 1 - 0.9 * sleepW);
      this.blinkK = clamp(eye, 0.1, 1);
      // alert pop
      if (this.alert && this.alertOn) {
        this.alertT += dt;
        const k0 = this.baby ? 0.9 : 3.2;
        const pop = this.alertT < 0.25 ? 1.35 * Math.sin(this.alertT / 0.25 * Math.PI * 0.75) : 1 + 0.06 * Math.sin(this.alertT * 9);
        this.alert.scale.setScalar(k0 * Math.max(0.05, pop));
      }
      // halo spin
      if (this.nodes.halo) this.nodes.halo.rotation.y += dt * 1.1;
      this.apply();
    },

    apply() {
      const P = this.P, R = this.rest, fz = this.frozen;
      for (let i = 0; i < NP; i++) {
        const o = this.parts[i];
        if (!o) continue;
        const k = i * 6;
        if (fz && fz.has(i)) {
          o.rotation.set(R[k], R[k + 1], R[k + 2]);
          o.position.set(R[k + 3], R[k + 4], R[k + 5]);
          continue;
        }
        o.rotation.set(R[k] + P[k], R[k + 1] + P[k + 1], R[k + 2] + P[k + 2]);
        o.position.set(R[k + 3] + P[k + 3], R[k + 4] + P[k + 4], R[k + 5] + P[k + 5]);
      }
      for (let i = 0; i < this.eyes.length; i++) {
        const e = this.eyes[i];
        e.mesh.scale.y = e.sy * this.blinkK;
        e.mesh.position.y = e.py + e.cy * (1 - this.blinkK);
      }
    },

    dispose() {
      this.stopZzz();
      this.stopVariantFx();
      if (this.group.parent) this.group.parent.remove(this.group);
      if (this.alert) { this.alert.material.dispose(); this.alert = null; }
      this.onStateEnd = null;
    },
  };
  const _v1 = new THREE.Vector3();

  function create(speciesId, opts) {
    return new Rig(speciesId, opts);
  }

  /* ------------------------------------------------------------------ eggs */
  function createEgg(speciesId, variant, scale, opts) {
    opts = opts || {};
    const A = SE.Assets;
    const key = A ? A.eggKey(speciesId) : 'egg.' + speciesId;
    const model = A ? A.get(key) : new THREE.Group();
    const group = new THREE.Group();
    group.name = 'egg_' + speciesId;
    const pivot = new THREE.Group();          // wobble pivot at the bottom centre
    group.add(pivot);
    pivot.add(model);
    model.scale.setScalar(scale || 1);
    const halo = A ? A.getPart(model, 'halo') : null;
    const sparkles = A ? A.getPart(model, 'sparkles') : null;
    const egg = {
      group, model, species: speciesId, variant: variant | 0, wobble: 0, t: Math.random() * 10, fx: null,
      update(dt) {
        autoTick();
        dt = Math.min(Math.max(dt || 0, 0), 0.1);
        this.t += dt;
        const w = this.wobble;
        if (w > 0.001) {
          const t = this.t, f = 1 + w * 1.6;
          pivot.rotation.z = (Math.sin(t * 9 * f) * 0.11 + Math.sin(t * 5.3 * f) * 0.05) * w;
          pivot.rotation.x = Math.sin(t * 7.1 * f + 1) * 0.07 * w;
          pivot.position.y = w > 0.75 ? Math.max(0, Math.sin(t * 14)) * 0.12 * (w - 0.75) * 4 * (scale || 1) : 0;
        } else { pivot.rotation.set(0, 0, 0); pivot.position.y = 0; }
        if (halo) { halo.rotation.y += dt * 1.3; halo.position.y = haloY + Math.sin(this.t * 2) * 0.06; }
        if (sparkles) sparkles.rotation.y -= dt * 0.5;
      },
      setWobble(k) { this.wobble = clamp(+k || 0, 0, 1); return this; },
      setVariant(v) {
        this.variant = v | 0;
        model.traverse((o) => {
          if (!o.isMesh) return;
          if (!o.userData.srcMat) o.userData.srcMat = o.material;
          o.material = this.variant ? variantMaterial(o.userData.srcMat, this.variant, 1.4 / (scale || 1), true) : o.userData.srcMat;
        });
        if (this.fx) { this.fx.stop(); this.fx = null; }
        const name = VARIANT_FX[this.variant];
        if (name && opts.fx !== false && SE.FX) this.fx = SE.FX.attach(name, model, { scale: 0.8 * (scale || 1), offset: [0, 1, 0] });
        return this;
      },
      dispose() { if (this.fx) this.fx.stop(); this.fx = null; if (group.parent) group.parent.remove(group); },
    };
    const haloY = halo ? halo.position.y : 0;
    if (egg.variant) egg.setVariant(egg.variant);
    return egg;
  }

  /* ------------------------------------------------------------------ thumbnails */
  const thumbCache = new Map();
  let thumbR = null, thumbScene = null, thumbCam = null, thumbQueue = Promise.resolve();
  function thumbSetup() {
    if (thumbR) return;
    const cv = document.createElement('canvas');
    thumbR = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: true, preserveDrawingBuffer: true });
    thumbR.setPixelRatio(1);
    thumbR.outputEncoding = THREE.sRGBEncoding;
    thumbR.toneMapping = THREE.ACESFilmicToneMapping;
    thumbR.toneMappingExposure = 1.08;
    thumbR.setClearColor(0x000000, 0);
    thumbScene = new THREE.Scene();
    thumbScene.add(new THREE.HemisphereLight('#e8f4ff', '#6a5a48', 0.9));
    const key = new THREE.DirectionalLight('#fff2dc', 1.6); key.position.set(-3, 5, 6); thumbScene.add(key);
    const rim = new THREE.DirectionalLight('#cfe4ff', 0.9); rim.position.set(4, 3, -5); thumbScene.add(rim);
    try {   // soft environment for gold / crystal
      const pm = new THREE.PMREMGenerator(thumbR);
      const es = new THREE.Scene();
      const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 12), new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying vec3 d; void main(){ float h = d.y; vec3 c = mix(vec3(0.35,0.3,0.25), vec3(0.75,0.85,1.0), smoothstep(-0.3,0.6,h)); c += vec3(1.0,0.9,0.7) * pow(max(0.0, dot(d, normalize(vec3(-0.4,0.6,0.7)))), 12.0) * 2.0; gl_FragColor = vec4(c, 1.0); }',
      }));
      es.add(sky);
      thumbScene.environment = pm.fromScene(es, 0.03).texture;
      pm.dispose();
    } catch (e) { /* environment optional */ }
    thumbCam = new THREE.PerspectiveCamera(28, 1, 0.05, 500);
  }
  function renderThumb(kind, species, variant, size) {
    thumbSetup();
    thumbR.setSize(size, size, false);
    let obj, egg = null, rig = null;
    if (kind === 'egg') { egg = createEgg(species, variant, 1, { fx: false }); obj = egg.group; egg.update(0); }
    else {
      rig = create(species, { baby: kind !== 'adult', variant, fx: false, shadows: false });
      rig.lookW = 0;
      rig.idleTarget = 0; rig.idleYaw = 0; rig.t = 0.7;
      rig.update(0, 0);
      obj = rig.group;
    }
    thumbScene.add(obj);
    obj.rotation.y = kind === 'egg' ? 0.5 : -0.62;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const radius = Math.max(s.x, s.y, s.z) * 0.5;
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(thumbCam.fov / 2)) * (kind === 'egg' ? 0.9 : 0.95);
    const el = THREE.MathUtils.degToRad(kind === 'egg' ? 12 : 16);
    thumbCam.position.set(c.x, c.y + Math.sin(el) * dist, c.z + Math.cos(el) * dist);
    thumbCam.lookAt(c);
    thumbR.render(thumbScene, thumbCam);
    const url = thumbR.domElement.toDataURL('image/png');
    thumbScene.remove(obj);
    if (rig) rig.dispose();
    if (egg) egg.dispose();
    return url;
  }
  function thumbnail(kind, species, variant, size) {
    kind = kind === 'adult' || kind === 'egg' ? kind : 'baby';
    variant = variant | 0; size = Math.max(16, Math.min(1024, size | 0 || 128));
    const key = kind + ':' + species + ':' + variant + ':' + size;
    if (thumbCache.has(key)) return thumbCache.get(key);
    const p = thumbQueue.then(() => new Promise((res, rej) => {
      const run = () => { try { res(renderThumb(kind, species, variant, size)); } catch (e) { rej(e); } };
      if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 200 }); else setTimeout(run, 0);
    }));
    thumbQueue = p.catch(() => null);
    p.catch((e) => { console.warn('SE.DragonModels.thumbnail failed', key, e); thumbCache.delete(key); });
    thumbCache.set(key, p);
    return p;
  }

  SE.DragonModels = {
    create, createEgg, thumbnail, variantMaterial: (m, v, s) => variantMaterial(m, v, s), tick,
    STATES: STATES.slice(), PARTS: PARTS.slice(), VARIANT_FX, Rig,
    get time() { return U_TIME.value; },
  };
})();
