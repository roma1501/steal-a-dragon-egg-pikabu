/* =========================================================================
   Steal a Dragon Egg — in-world rewarded boost pads at the base (SE.AdPads)

   2–3 glowing golden pads with a floating offer icon and a «За рекламу» label
   (SPEC §8). Stepping on a pad opens the generic 'offer' dialog for its offer
   (reward + condition first, the ad only after «Посмотреть рекламу») — once per
   visit: the player has to step off before the pad reacts again. While the
   offer cools down the pad dims and its label shows the countdown; without
   ads it shows «Реклама недоступна» and a tap explains it with a toast.
   Hidden during the tutorial, in builds with SE.Config.ADS === false and far
   from the base. Never opens anything while carrying an egg, during a chase,
   over a panel or while paused.

   Placement comes from SE.World markers only (world.js is not touched):
     speedBoost  next to the base gate     (World.safeLineZ, inside the safe zone, off the path)
     turboTrain  next to the treadmills    (World.treadmills)
     luckyEgg    between the hatchery pens (World.hatcheries[i].entry)
   Each pad tries a list of candidate spots and takes the first one that is in the
   safe zone, clear of colliders / decor keep-outs (World.isClear) and away from every
   interactable, the spawn point and the other pads.

   API
     SE.AdPads.init(scene, world, game)   builds the pads (SE.Game.buildScene)
     SE.AdPads.update(dt, game)            visibility, label state, step-on trigger (SE.Game frame)
     SE.AdPads.pads                        [{ id, x, z, r, group, inside, state }]
     SE.AdPads.PADS                        definitions [{ id, near }]
   Strings: pads.* (ru/en/tr).
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var T = global.THREE;

  var PADS = [
    { id: 'speedBoost', near: 'gate' },
    { id: 'turboTrain', near: 'treadmill' },
    { id: 'luckyEgg', near: 'hatcheries' }
  ];
  var R = 2.7;                   // pad radius = trigger radius
  var LABEL_EVERY = 0.5;

  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: { 'pads.forAd': 'За рекламу', 'pads.in': 'Через {0}', 'pads.noAds': 'Реклама недоступна', 'pads.active': 'Активно {0}' },
      en: { 'pads.forAd': 'Watch ad', 'pads.in': 'In {0}', 'pads.noAds': 'No ads now', 'pads.active': 'Active {0}' },
      tr: { 'pads.forAd': 'Reklam izle', 'pads.in': '{0} sonra', 'pads.noAds': 'Reklam yok', 'pads.active': 'Aktif {0}' }
    });
  }

  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function clock(sec) {
    sec = Math.max(0, Math.ceil(sec || 0));
    if (SE.I18N && SE.I18N.clock) return SE.I18N.clock(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function tutActive() {
    try { return !!(SE.Tutorial && SE.Tutorial.isActive && SE.Tutorial.isActive()); } catch (e) { return false; }
  }
  function adsOff() { return !!(SE.Config && SE.Config.ADS === false) || !SE.Ads; }
  function toast(text, type) { try { if (SE.UI && SE.UI.toast) SE.UI.toast(text, type || 'info'); } catch (e) { /* optional */ } }
  function iconUrl(key) {
    if (SE.Icons && typeof SE.Icons.url === 'function') { try { var u = SE.Icons.url(key); if (u) return u; } catch (e) { /* fall through */ } }
    return 'assets/ui/' + key + '.png';
  }

  /* ---------------------------------------------------------------------- */
  /* placement                                                               */
  /* ---------------------------------------------------------------------- */
  function candidates(kind, W) {
    var out = [];
    if (kind === 'gate') {
      var z0 = typeof W.safeLineZ === 'number' ? W.safeLineZ : -27;
      [[-14, 16], [14, 16], [-17, 24], [17, 24], [-12, 9], [12, 9], [-22, 12], [22, 12]].forEach(function (c) { out.push({ x: c[0], z: z0 + c[1] }); });
    } else if (kind === 'treadmill') {
      var tm = W.treadmills || [];
      if (tm.length) {
        var minX = Infinity, maxX = -Infinity, z = tm[0].z, w = tm[0].w || 4, d = tm[0].d || 9;
        tm.forEach(function (m) { minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x); });
        var mid = (minX + maxX) / 2;
        out.push({ x: maxX + w / 2 + 5.5, z: z }, { x: minX - w / 2 - 5.5, z: z },
          { x: maxX + w / 2 + 8, z: z - d / 2 }, { x: maxX + w / 2 + 8, z: z + d / 2 },
          { x: minX - w / 2 - 5.5, z: z - d / 2 }, { x: mid, z: z - d / 2 - 7 }, { x: minX - w / 2 - 7, z: z + d / 2 });
      }
    } else if (kind === 'hatcheries') {
      var hs = W.hatcheries || [];
      [1, 3, 0, 2, 5, 4].forEach(function (i) {        // right side first: the gate pad usually sits left
        var h = hs[i];
        if (!h || !h.entry) return;
        var side = h.entry.x < 0 ? 1 : -1;            // towards the lawn
        out.push({ x: h.entry.x + side * 9, z: h.entry.z + 12 });
        out.push({ x: h.entry.x + side * 9, z: h.entry.z - 12 });
      });
    }
    return out;
  }
  function spotFree(W, x, z, taken) {
    if (W.inSafeZone && !W.inSafeZone(x, z)) return false;
    if (typeof W.isClear === 'function') { try { if (!W.isClear(x, z, R + 0.4)) return false; } catch (e) { /* optional */ } }
    var near = typeof W.nearColliders === 'function' ? W.nearColliders(x, z) : [];
    for (var i = 0; i < near.length; i++) {
      var c = near[i];
      if (!c || c.disabled || c.walkable) continue;
      var dx = Math.max(c.minX - x, 0, x - c.maxX), dz = Math.max(c.minZ - z, 0, z - c.maxZ);
      if (dx * dx + dz * dz < (R + 0.6) * (R + 0.6)) return false;
    }
    var its = W.interactables || [];
    for (var j = 0; j < its.length; j++) {
      var it = its[j];
      if (!it || it.type === 'nest' || it.type === 'lairGate') continue;
      var ix = it.x - x, iz = it.z - z, rr = (it.r || 4) + R + (it.type === 'treadmill' ? 0.3 : 1.5);   // next to the belt is fine
      if (ix * ix + iz * iz < rr * rr) return false;
    }
    var sp = W.spawn;
    if (sp && (sp.x - x) * (sp.x - x) + (sp.z - z) * (sp.z - z) < 9 * 9) return false;
    for (var k = 0; k < taken.length; k++) {
      var p = taken[k];
      if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 12 * 12) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* visuals                                                                 */
  /* ---------------------------------------------------------------------- */
  var shared = null;
  function sharedRes() {
    if (shared) return shared;
    var c = document.createElement('canvas');
    c.width = 4; c.height = 64;
    var g = c.getContext('2d');
    var gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.35)');
    gr.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 4, 64);
    var beamTex = new T.CanvasTexture(c);
    shared = {
      disc: new T.CylinderGeometry(R, R + 0.25, 0.32, 40),
      top: new T.CylinderGeometry(R * 0.74, R * 0.74, 0.36, 40),
      ring: new T.RingGeometry(R * 0.8, R * 0.98, 48),
      beam: new T.CylinderGeometry(R * 0.92, R * 0.98, 6.5, 32, 1, true),
      beamTex: beamTex,
      loader: new T.TextureLoader()
    };
    return shared;
  }

  function buildPad(def, spot) {
    var S = sharedRes();
    var g = new T.Group();
    g.name = 'adPad:' + def.id;
    g.position.set(spot.x, 0, spot.z);
    var discMat = new T.MeshStandardMaterial({ color: '#f2b51e', emissive: '#a86d00', emissiveIntensity: 0.55, metalness: 0.35, roughness: 0.42 });
    var topMat = new T.MeshStandardMaterial({ color: '#ffe27a', emissive: '#ffb000', emissiveIntensity: 0.75, metalness: 0.2, roughness: 0.35 });
    var disc = new T.Mesh(S.disc, discMat);
    disc.position.y = 0.16;
    disc.receiveShadow = true;
    var top = new T.Mesh(S.top, topMat);
    top.position.y = 0.2;
    var ringMat = new T.MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.8, depthWrite: false, blending: T.AdditiveBlending });
    var ring = new T.Mesh(S.ring, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.4;
    var beamMat = new T.MeshBasicMaterial({ color: '#ffd34d', map: S.beamTex, transparent: true, opacity: 0.32, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide });
    var beam = new T.Mesh(S.beam, beamMat);
    beam.position.y = 3.6;
    beam.renderOrder = 4;
    g.add(disc); g.add(top); g.add(ring); g.add(beam);

    var o = SE.Ads && SE.Ads.get ? SE.Ads.get(def.id) : null;
    var iconKey = o && o.icon ? o.icon : 'watch-video';
    var tex = S.loader.load(iconUrl(iconKey));
    if (T.sRGBEncoding !== undefined) tex.encoding = T.sRGBEncoding;
    var iconMat = new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    var icon = new T.Sprite(iconMat);
    icon.scale.set(3.1, 3.1, 1);
    icon.position.y = 4.3;
    icon.renderOrder = 5;
    g.add(icon);

    var label = null;
    if (SE.Models && typeof SE.Models.makeLabel === 'function') {
      try {
        label = SE.Models.makeLabel(labelText(def.id, t('pads.forAd')), {
          w: 7.2, tw: 512, th: 192, bg: 'rgba(42,20,7,0.82)', border: '#ffd34d', borderWidth: 10, radius: 34,
          color: '#ffffff', outlineColor: '#2a1407', outlineWidth: 10
        });
        label.position.y = 7.6;
        label.renderOrder = 6;
        g.add(label);
      } catch (e) { label = null; }
    }
    return {
      id: def.id, near: def.near, x: spot.x, z: spot.z, r: R, group: g, disc: disc, top: top, ring: ring, beam: beam,
      icon: icon, label: label, mats: { disc: discMat, top: topMat, ring: ringMat, beam: beamMat, icon: iconMat },
      inside: false, state: '', labelText: '', phase: Math.random() * 6
    };
  }
  function labelText(id, line2) {
    var title = SE.Ads && SE.Ads.title ? SE.Ads.title(id) : id;
    return title + '\n' + line2;
  }

  /* ---------------------------------------------------------------------- */
  /* module                                                                  */
  /* ---------------------------------------------------------------------- */
  var AdPads = {
    PADS: PADS,
    pads: [],
    root: null,
    built: false,
    _t: 0,
    _label: 0,

    init: function (scene, W) {
      if (this.built || !T || !scene) return false;
      W = W || SE.World;
      if (!W) return false;
      var root = new T.Group();
      root.name = 'adPads';
      var taken = [], self = this;
      PADS.forEach(function (def) {
        if (SE.Ads && SE.Ads.get && !SE.Ads.get(def.id)) return;
        var list = candidates(def.near, W), spot = null;
        for (var i = 0; i < list.length && !spot; i++) if (spotFree(W, list[i].x, list[i].z, taken)) spot = list[i];
        if (!spot) { console.warn('[AdPads] no free spot for the ' + def.id + ' pad'); return; }
        taken.push(spot);
        var pad = buildPad(def, spot);
        root.add(pad.group);
        self.pads.push(pad);
      });
      scene.add(root);
      this.root = root;
      this.built = true;
      return true;
    },

    /* 'ready' | 'cd' | 'off' (no ads) | 'busy' (an ad runs) */
    padState: function (pad) {
      var A = SE.Ads;
      if (!A || !A.canShow()) return 'off';
      if (A.busy || A.interstitialBusy) return 'busy';
      return A.cooldownLeft(pad.id) > 0 ? 'cd' : 'ready';
    },

    update: function (dt, game) {
      if (!this.built) return;
      var Pl = SE.Player, W = SE.World;
      var show = !adsOff() && !tutActive() && !!Pl && !!Pl.pos;
      var nearBase = show && W && typeof W.safeLineZ === 'number' ? Pl.pos.z > W.safeLineZ - 90 : show;
      this.root.visible = show && nearBase;
      if (!this.root.visible) { this.pads.forEach(function (p) { p.inside = false; }); return; }
      this._t += dt;
      this._label -= dt;
      var doLabel = this._label <= 0;
      if (doLabel) this._label = LABEL_EVERY;
      for (var i = 0; i < this.pads.length; i++) {
        var p = this.pads[i];
        var st = this.padState(p);
        if (doLabel || st !== p.state) this.refresh(p, st);
        /* animation */
        var ready = st === 'ready';
        var ph = this._t * 2.4 + p.phase;
        p.icon.position.y = 4.3 + Math.sin(ph) * 0.35;
        p.icon.material.rotation = Math.sin(ph * 0.5) * 0.12;
        p.ring.material.opacity = ready ? 0.55 + 0.4 * Math.sin(ph * 1.6) : 0.18;
        p.ring.scale.setScalar(ready ? 1 + 0.05 * Math.sin(ph * 1.6) : 1);
        p.beam.material.opacity = ready ? 0.26 + 0.1 * Math.sin(ph) : 0.08;
        /* step-on trigger, once per visit */
        var dx = Pl.pos.x - p.x, dz = Pl.pos.z - p.z, d2 = dx * dx + dz * dz;
        var on = d2 < R * R && (Pl.pos.y || 0) < 1.5;
        if (on && !p.inside) { p.inside = true; this.trigger(p, st, game || SE.Game); }
        else if (!on && d2 > (R + 1.2) * (R + 1.2)) p.inside = false;
      }
    },

    refresh: function (p, st) {
      var A = SE.Ads;
      p.state = st;
      var line;
      if (st === 'off') line = t('pads.noAds');
      else if (st === 'cd') line = t('pads.in', clock(A.cooldownLeft(p.id)));
      else if (SE.Boosts && SE.Boosts.isActive(p.id)) line = t('pads.active', clock(SE.Boosts.remaining(p.id)));
      else line = t('pads.forAd');
      var txt = labelText(p.id, line);
      if (p.label && txt !== p.labelText) {
        p.labelText = txt;
        try { p.label.userData.setText(txt); } catch (e) { /* optional */ }
      }
      var dim = st !== 'ready';
      p.mats.icon.opacity = dim ? 0.55 : 1;
      p.mats.top.emissiveIntensity = dim ? 0.15 : 0.75;
      p.mats.disc.emissiveIntensity = dim ? 0.12 : 0.55;
      p.mats.top.color.set(dim ? '#c9b47a' : '#ffe27a');
    },

    trigger: function (p, st, game) {
      if (!game || game.carrying || (game.paused) || tutActive()) return;
      if (SE.UI && SE.UI.isOpen && SE.UI.isOpen()) return;
      if (SE.DragonAI && SE.DragonAI.anyChasing && SE.DragonAI.anyChasing('player')) return;
      var A = SE.Ads;
      if (!A) return;
      if (st === 'off') { toast(t('ads.unavailable'), 'info'); return; }
      if (st === 'busy') return;
      if (st === 'cd') { toast(t('ads.cooldown', Math.ceil(A.cooldownLeft(p.id))), 'info'); return; }
      if (!A.available(p.id, { source: 'pad' })) { toast(t('ads.notNow'), 'info'); return; }
      if (typeof game.offer === 'function') game.offer(p.id, { source: 'pad' });
    }
  };

  SE.AdPads = AdPads;
})(window);
