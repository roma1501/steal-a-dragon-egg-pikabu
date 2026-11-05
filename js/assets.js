/*
 * SE.Assets — GLB model manifest + loader (SPEC §5.2).
 *
 * Requires (load order): js/lib/three.min.js, js/lib/BufferGeometryUtils.js, js/lib/GLTFLoader.js.
 *
 * Keys (MANIFEST):
 *   'dragon.<species>.adult'  assets/models/dragons/<species>_adult.glb   species: meadow mosswood amber frost ember aurora
 *   'dragon.<species>.baby'   assets/models/dragons/<species>_baby.glb
 *   'egg.<species>'           assets/models/eggs/<species>_egg.glb
 *   'prop.<name>'             assets/models/props/<name>.glb            name: hatchery great_nest base_gate lair_gate
 *   Helpers: SE.Assets.dragonKey(species, baby), eggKey(species), propKey(name).
 *   More models (e.g. Kenney decor): SE.Assets.add(key, url[, { optional:true }]) before loadAll(),
 *   or add() + load(key) later. Optional entries never make loadAll() reject.
 *
 * API:
 *   SE.Assets.loadAll(onProgress(loaded, total, fraction), opts?) -> Promise<{ loaded:[key], failed:[{key,url,error}] }>
 *       Loads every manifest entry in parallel (max 6 at a time), 1 retry per file, 60 s timeout per attempt.
 *       `loaded` counts finished files; `fraction` (0..1) is byte-weighted, for smooth loading bars.
 *       Rejects with an Error listing every failed required file (err.failed = [{key,url,error}]) unless
 *       opts.tolerant is true (then it resolves and the failures are in the result).
 *   SE.Assets.get(key, { cloneMaterials:false }) -> THREE.Object3D
 *       Deep clone (Object3D.clone(true)): geometries are always shared, materials are shared unless
 *       cloneMaterials:true (then each source material is cloned once per call, sharing preserved inside
 *       the clone). Never throws: an unknown / not loaded key returns a pink placeholder box
 *       (userData.placeholder = true) and logs one warning — check has(key) when it matters.
 *   SE.Assets.getPart(root, name) -> Object3D|null      (exact node name, e.g. 'wing_L', 'sign_board')
 *   SE.Assets.has(key) -> bool                          (loaded and usable)
 *   SE.Assets.stats(key) -> { tris, nodes, meshes, drawCalls, materials:[names], size:{x,y,z}, bytes } | null
 *   SE.Assets.add(key, url, opts) / add({ key:url, … })  -> SE.Assets
 *   SE.Assets.load(key | [keys], { force }) -> Promise   (load a subset on demand; force re-fetches)
 *   SE.Assets.loadFile(url, { force }) -> Promise<key>    (any GLB by URL; key = 'file:' + url; dev tools)
 *   SE.Assets.parseBuffer(arrayBuffer, name) -> Promise<key>  (key = 'drop:' + name; dev tools)
 *   SE.Assets.source(key) -> the shared original scene (read-only!), status(key), url(key), keys(prefix),
 *   SE.Assets.measure(object3D) -> stats of any object, SE.Assets.baseUrl (get/set).
 *
 * Loaded models are prepared once: meshes cast and receive shadows; colour maps (map, emissiveMap) are
 * kept in sRGB encoding; normals are used exactly as exported (never recomputed, so faceted/flat-shaded
 * models stay faceted; meshes without normals get material.flatShading). Model colours come from the
 * GLB as linear factors, which is correct with renderer.outputEncoding = THREE.sRGBEncoding.
 *
 * URLs in the manifest are relative to the game root (the folder of index.html). The root is derived
 * from this script's own URL (…/js/assets.js), so dev pages in sub-folders (dev/model-viewer.html) work
 * too; override with SE.Assets.baseUrl = '…/' if the build concatenates scripts.
 */
(function () {
  'use strict';
  const SE = window.SE = window.SE || {};
  const THREE = window.THREE;

  const SPECIES = ['meadow', 'mosswood', 'amber', 'frost', 'ember', 'aurora'];
  const PROPS = ['hatchery', 'great_nest', 'base_gate', 'lair_gate'];
  const CONCURRENCY = 6;
  const TIMEOUT_MS = 60000;
  const RETRY_DELAY_MS = 400;

  const dragonKey = (species, baby) => 'dragon.' + species + '.' + (baby ? 'baby' : 'adult');
  const eggKey = (species) => 'egg.' + species;
  const propKey = (name) => 'prop.' + name;

  const MANIFEST = {};
  const OPTIONAL = {};
  SPECIES.forEach((s) => {
    MANIFEST[dragonKey(s, false)] = 'assets/models/dragons/' + s + '_adult.glb';
    MANIFEST[dragonKey(s, true)] = 'assets/models/dragons/' + s + '_baby.glb';
  });
  SPECIES.forEach((s) => { MANIFEST[eggKey(s)] = 'assets/models/eggs/' + s + '_egg.glb'; });
  PROPS.forEach((p) => { MANIFEST[propKey(p)] = 'assets/models/props/' + p + '.glb'; });

  // Game root = folder that contains js/assets.js.
  let baseUrl = '';
  try {
    const src = document.currentScript && document.currentScript.src;
    const m = src && /^(.*\/)js\/assets\.js(?:[?#].*)?$/.exec(src);
    if (m) baseUrl = m[1];
  } catch (e) { /* keep '' */ }

  function resolveUrl(url) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(url)) return url; // absolute, data:, blob:, http:
    return baseUrl + url;
  }

  // key -> { key, url, status:'idle'|'loading'|'loaded'|'failed', promise, scene, gltf, stats, error, frac, bytes }
  const entries = Object.create(null);
  const warned = Object.create(null);
  let loader = null;

  function getLoader() {
    if (loader) return loader;
    if (!THREE || !THREE.GLTFLoader) throw new Error('SE.Assets: THREE.GLTFLoader is missing — load js/lib/BufferGeometryUtils.js and js/lib/GLTFLoader.js after three.min.js');
    loader = new THREE.GLTFLoader();
    loader.setCrossOrigin('anonymous');
    return loader;
  }

  function entry(key) {
    let e = entries[key];
    if (!e && MANIFEST[key]) e = entries[key] = { key, url: MANIFEST[key], status: 'idle', frac: 0 };
    return e || null;
  }

  function add(key, url, opts) {
    if (key && typeof key === 'object') { Object.keys(key).forEach((k) => add(k, key[k], url)); return api; }
    if (typeof key !== 'string' || !key || typeof url !== 'string' || !url) throw new Error('SE.Assets.add(key, url): bad arguments');
    MANIFEST[key] = url;
    if (opts && opts.optional) OPTIONAL[key] = true; else delete OPTIONAL[key];
    const e = entries[key];
    if (e && e.url !== url) delete entries[key]; // re-pointed: reload on next load()
    return api;
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchBuffer(url, onFrac) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
      if (!res.ok) throw new Error('HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
      const total = Number(res.headers.get('content-length')) || 0;
      if (!res.body || !res.body.getReader || !total) {
        const buf = await res.arrayBuffer();
        onFrac(1);
        return buf;
      }
      const reader = res.body.getReader();
      const out = new Uint8Array(total);
      let got = 0;      // bytes received
      let filled = 0;   // bytes stored in `out` (contiguous prefix)
      const chunks = []; // overflow when Content-Length is not the decoded size (compressed responses)
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!chunks.length && filled + value.length <= total) { out.set(value, filled); filled += value.length; }
        else chunks.push(value);
        got += value.length;
        onFrac(Math.min(0.99, got / total));
      }
      onFrac(1);
      if (!chunks.length && filled === total) return out.buffer;
      const all = new Uint8Array(got);
      all.set(out.subarray(0, filled), 0);
      let off = filled;
      chunks.forEach((c) => { all.set(c, off); off += c.length; });
      return all.buffer;
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error('timeout after ' + (TIMEOUT_MS / 1000) + ' s');
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function parse(buffer, url) {
    const path = url.slice(0, url.lastIndexOf('/') + 1);
    return new Promise((resolve, reject) => {
      try { getLoader().parse(buffer, path, resolve, (err) => reject(err instanceof Error ? err : new Error(String(err && err.message || err)))); }
      catch (err) { reject(err); }
    });
  }

  function prepare(scene) {
    scene.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh && !o.isInstancedMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      const flat = !o.geometry || !o.geometry.attributes.normal;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (!m) return;
        let dirty = false;
        ['map', 'emissiveMap'].forEach((slot) => {
          const t = m[slot];
          if (t && t.encoding !== THREE.sRGBEncoding) { t.encoding = THREE.sRGBEncoding; t.needsUpdate = true; dirty = true; }
        });
        if (flat && !m.flatShading) { m.flatShading = true; dirty = true; }
        if (dirty) m.needsUpdate = true;
      });
    });
  }

  function trisOf(o) {
    const g = o.geometry;
    if (!g) return 0;
    let n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    if (g.drawRange && isFinite(g.drawRange.count)) n = Math.min(n, g.drawRange.count);
    let t = Math.floor(n / 3);
    if (o.isInstancedMesh) t *= o.count;
    return t;
  }

  function measure(object) {
    const s = { tris: 0, nodes: 0, meshes: 0, drawCalls: 0, materials: [], size: { x: 0, y: 0, z: 0 } };
    const names = new Set();
    object.updateMatrixWorld(true);
    object.traverse((o) => {
      if (o !== object) s.nodes++;
      if (!o.isMesh) return;
      s.meshes++;
      s.tris += trisOf(o);
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      s.drawCalls += Array.isArray(o.material) ? Math.max(1, o.geometry.groups.length) : 1;
      mats.forEach((m) => { if (m) names.add(m.name || '(unnamed)'); });
    });
    s.materials = Array.from(names).sort();
    const box = new THREE.Box3().setFromObject(object, true);
    if (!box.isEmpty()) {
      const v = box.getSize(new THREE.Vector3());
      s.size = { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) };
    }
    return s;
  }

  async function fetchAndParse(e, opts) {
    const bust = opts && opts.force ? (e.url.includes('?') ? '&' : '?') + 'v=' + Date.now() : '';
    const url = resolveUrl(e.url);
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const buffer = e.buffer || await fetchBuffer(url + bust, (f) => { e.frac = f; if (e.onFrac) e.onFrac(); });
        const gltf = await parse(buffer, url);
        return { gltf, bytes: buffer.byteLength };
      } catch (err) {
        lastErr = err;
        e.frac = 0;
        if (e.buffer) break; // in-memory buffer: retrying cannot help
        if (attempt === 0) await delay(RETRY_DELAY_MS);
      }
    }
    throw lastErr || new Error('unknown error');
  }

  function loadEntry(e, opts) {
    if (e.promise && !(opts && opts.force)) return e.promise;
    e.status = 'loading';
    e.frac = 0;
    e.error = null;
    e.promise = fetchAndParse(e, opts).then(({ gltf, bytes }) => {
      const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
      if (!scene) throw new Error('the file contains no scene');
      scene.name = scene.name || e.key;
      prepare(scene);
      e.gltf = gltf;
      e.scene = scene;
      e.stats = Object.assign(measure(scene), { bytes });
      e.status = 'loaded';
      e.frac = 1;
      e.buffer = null;
      return scene;
    }, (err) => {
      e.status = 'failed';
      e.error = (err && err.message) || String(err);
      e.promise = null;
      e.frac = 1;
      throw new Error(e.key + ' (' + e.url + '): ' + e.error);
    });
    return e.promise;
  }

  function failureError(failed, total) {
    const lines = failed.map((f) => '  - ' + f.key + ' -> ' + f.url + ': ' + f.error);
    const err = new Error('SE.Assets: failed to load ' + failed.length + ' of ' + total + ' model file(s):\n' + lines.join('\n'));
    err.failed = failed;
    return err;
  }

  async function runAll(keys, onProgress, opts) {
    const list = keys.map(entry).filter(Boolean);
    const total = list.length;
    let loaded = 0;
    const report = () => {
      if (!onProgress) return;
      const frac = total ? list.reduce((a, e) => a + (e.status === 'loaded' || e.status === 'failed' ? 1 : e.frac || 0), 0) / total : 1;
      try { onProgress(loaded, total, Math.min(1, frac)); } catch (err) { console.error(err); }
    };
    list.forEach((e) => { e.onFrac = report; });
    report();
    const failed = [];
    const done = [];
    let next = 0;
    async function worker() {
      while (next < list.length) {
        const e = list[next++];
        try { await loadEntry(e, opts); done.push(e.key); }
        catch (err) { failed.push({ key: e.key, url: e.url, error: e.error || err.message, optional: !!OPTIONAL[e.key] }); }
        loaded++;
        report();
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, list.length); i++) workers.push(worker());
    await Promise.all(workers);
    list.forEach((e) => { e.onFrac = null; });
    const hard = failed.filter((f) => !f.optional);
    if (hard.length && !(opts && opts.tolerant)) throw failureError(hard, total);
    if (failed.length) console.warn(failureError(failed, total).message);
    return { loaded: done, failed };
  }

  function loadAll(onProgress, opts) {
    return runAll(Object.keys(MANIFEST), onProgress, opts || {});
  }

  function load(keys, opts) {
    const single = typeof keys === 'string';
    const list = single ? [keys] : keys;
    const missing = list.filter((k) => !entry(k));
    if (missing.length) return Promise.reject(new Error('SE.Assets.load: unknown key(s): ' + missing.join(', ')));
    return Promise.all(list.map((k) => loadEntry(entry(k), opts))).then((scenes) => (single ? scenes[0] : scenes));
  }

  function loadFile(url, opts) {
    const key = 'file:' + url;
    let e = entries[key];
    if (!e) e = entries[key] = { key, url, status: 'idle', frac: 0 };
    return loadEntry(e, opts).then(() => key);
  }

  function parseBuffer(buffer, name) {
    const key = 'drop:' + (name || 'model.glb');
    const e = entries[key] = { key, url: name || 'model.glb', status: 'idle', frac: 0, buffer };
    return loadEntry(e, { force: true }).then(() => key);
  }

  const PLACEHOLDER_SIZE = { dragon_adult: [8, 12, 24], dragon_baby: [2, 3.2, 3], egg: [1.4, 2, 1.4],
    'prop.hatchery': [10, 1, 10], 'prop.great_nest': [14, 3, 14], 'prop.base_gate': [36, 18, 3], 'prop.lair_gate': [30, 20, 4] };
  let placeholderMat = null;
  function placeholder(key) {
    const k = String(key);
    const size = PLACEHOLDER_SIZE[k] || (/^dragon\..*\.adult$/.test(k) ? PLACEHOLDER_SIZE.dragon_adult
      : /^dragon\..*\.baby$/.test(k) ? PLACEHOLDER_SIZE.dragon_baby : /^egg\./.test(k) ? PLACEHOLDER_SIZE.egg : [2, 2, 2]);
    if (!placeholderMat) placeholderMat = new THREE.MeshStandardMaterial({ color: 0xff3fb4, roughness: 0.6, name: 'placeholder' });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), placeholderMat);
    mesh.position.y = size[1] / 2;
    mesh.castShadow = true;
    const g = new THREE.Group();
    g.name = k;
    g.userData.placeholder = true;
    g.add(mesh);
    return g;
  }

  function get(key, opts) {
    const e = entries[key];
    if (!e || !e.scene) { // (a previous scene stays usable while a forced reload runs)
      if (!warned[key]) {
        warned[key] = true;
        console.warn('SE.Assets.get: "' + key + '" is ' + (!e && !MANIFEST[key] ? 'not in the manifest' : (e && e.status === 'failed' ? 'missing (' + e.error + ')' : 'not loaded')) + ' — using a placeholder');
      }
      return placeholder(key);
    }
    const clone = e.scene.clone(true);
    if (opts && opts.cloneMaterials) {
      const map = new Map();
      const cloneMat = (m) => {
        if (!m) return m;
        if (!map.has(m)) map.set(m, m.clone());
        return map.get(m);
      };
      clone.traverse((o) => {
        if (!o.material) return;
        o.material = Array.isArray(o.material) ? o.material.map(cloneMat) : cloneMat(o.material);
      });
    }
    clone.userData.assetKey = key;
    return clone;
  }

  function getPart(root, name) {
    if (!root || !name) return null;
    return root.getObjectByName(name) || null;
  }

  function has(key) {
    const e = entries[key];
    return !!(e && e.scene);
  }

  function stats(key) {
    const e = entries[key];
    if (!e || !e.stats) return null;
    const s = e.stats;
    return { tris: s.tris, nodes: s.nodes, meshes: s.meshes, drawCalls: s.drawCalls, materials: s.materials.slice(), size: Object.assign({}, s.size), bytes: s.bytes };
  }

  const api = {
    MANIFEST, SPECIES, PROPS,
    dragonKey, eggKey, propKey,
    add, loadAll, load, loadFile, parseBuffer,
    get, getPart, has, stats, measure,
    source: (key) => (entries[key] && entries[key].scene) || null,
    gltf: (key) => (entries[key] && entries[key].gltf) || null,
    status: (key) => (entries[key] ? entries[key].status : (MANIFEST[key] ? 'idle' : 'unknown')),
    error: (key) => (entries[key] && entries[key].error) || null,
    url: (key) => (MANIFEST[key] ? resolveUrl(MANIFEST[key]) : (entries[key] ? resolveUrl(entries[key].url) : null)),
    keys: (prefix) => Object.keys(MANIFEST).filter((k) => !prefix || k.indexOf(prefix) === 0),
    isOptional: (key) => !!OPTIONAL[key],
    resolveUrl,
  };
  Object.defineProperty(api, 'baseUrl', { get: () => baseUrl, set: (v) => { baseUrl = v ? String(v).replace(/\/?$/, '/') : ''; }, enumerable: true });

  SE.Assets = api;
})();
