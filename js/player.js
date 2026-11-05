/* =========================================================================
   Steal a Dragon Egg — input, player character, camera, followers
   (SE.Input, SE.Player)

   SE.Input
     mode                      'kbd' | 'touch' — last used input; on change fires
                               window event 'sade-input-mode' (detail { mode }) and sets
                               <html data-input="kbd|touch">. Initial: Platform.isMobile → 'touch'.
     init(canvas)              keyboard (WASD/arrows move, Space jump, E action, F sell-all),
                               mouse drag (left or right button) orbits the camera, wheel zooms,
                               touch: free finger on the canvas orbits, two fingers pinch-zoom.
                               On-screen controls are found by event delegation, so the HUD may be
                               created later: joystick  #joystick | [data-input="joystick"]
                               (knob: #joyKnob | [data-input="joystick-knob"] | .joy-knob | first child),
                               buttons  #btnAction | [data-input="action"],  #btnJump | [data-input="jump"],
                               #btnAction2 | #btnSellAll | [data-input="action2"].  Pointer events,
                               multitouch-safe, mouse works on them too (Playables).
     reset()                   releases every key / touch (blur, 'lory-release-input', pause, teleport)
     axis() -> { x, z, len }   x right, z back (screen space); len 0..1
     consumeJump(), consumeAction(), consumeAction2()
     press('action'|'action2'|'jump'), setJoystick(x, y, active)   (UI / tests)
     setMode(mode)

   SE.Player
     pos (Vector3), vel, yaw, grounded, moving, speed (current u/s), camYaw, camPitch, camDist,
     model (character API: group, update(dt, moving, speedFactor, grounded), carry), group,
     carry (egg|null), carryRig, followers [{ uid, species, variant, rig, x, z, y }], invisible
     init(scene)                         creates the character (SE.Models), followers, cosmetics
     update(dt, game, camera)            movement, physics, camera, followers, trail, footsteps
     walkSpeed(game) -> u/s              State.walkSpeed() × speedBoost 2 × slow 0.5 × chilled 0.6
     resolve(x, z, y[, radius]) -> {x,z} push a point out of solid colliders (used by AI too)
     setCarry(egg|null[, rig])           egg above the head (rig from SE.DragonModels.createEgg)
     refreshFollowers()                  equipped baby dragons (max 6) follow / fly around
     refreshCosmetics()                  SE.Cosmetics.apply(model, equipped)
     celebrate(secs)                     followers play 'happy'
     setGhost(on)                        semi-transparent (invisible status)
     teleport(x, z[, yaw]), teleportHome(), snapCamera()
     knockback(dirX, dirZ, power)        impulse (fireball hits); decays in ≈ 0.4 s
     setSpeedStat(v)                     legacy no-op (speed always comes from SE.State)
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var T = global.THREE;

  var GRAVITY = 78, JUMP_VEL = 26, RADIUS = 1.4;
  var CAM_MIN = 12, CAM_MAX = 62, PITCH_MIN = 0.06, PITCH_MAX = 1.25;
  var FOCUS_H = 5.2;
  var MAX_FOLLOWERS = 6;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function damp(a, b, lambda, dt) { return a + (b - a) * (1 - Math.exp(-lambda * dt)); }
  function angleDamp(from, to, lambda, dt) {
    var d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
    return from + d * (1 - Math.exp(-lambda * dt));
  }
  function call(obj, name) {
    if (!obj || typeof obj[name] !== 'function') return undefined;
    try { return obj[name].apply(obj, Array.prototype.slice.call(arguments, 2)); } catch (e) { console.error('[Player] ' + name + ' failed', e); }
    return undefined;
  }
  function audio(key, opts) { if (SE.Audio && SE.Audio.play) { try { SE.Audio.play(key, opts); } catch (e) {} } }
  var _fxV = T ? new T.Vector3() : null;
  function fxAt(name, x, y, z, opts) {
    if (!SE.FX || typeof SE.FX.emit !== 'function') return;
    try { SE.FX.emit(name, _fxV.set(x, y, z).clone(), opts); } catch (e) { /* optional */ }
  }
  function isTyping(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }

  /* ====================================================================== */
  /* Input                                                                   */
  /* ====================================================================== */
  var SEL = {
    joystick: '#joystick, [data-input="joystick"]',
    knob: '#joyKnob, [data-input="joystick-knob"], .joy-knob',
    action: '#btnAction, [data-input="action"]',
    action2: '#btnAction2, #btnSellAll, [data-input="action2"], [data-input="sell"]',
    jump: '#btnJump, [data-input="jump"]'
  };

  var Input = {
    mode: 'kbd',
    keys: {},
    move: { x: 0, y: 0 },
    jumpPressed: false,
    actionPressed: false,
    action2Pressed: false,
    camDelta: { x: 0, y: 0 },
    zoomDelta: 0,
    joyActive: false,
    joyId: null,
    camPointers: {},       // pointerId -> { x, y }
    pinchDist: 0,
    enabled: true,
    canvas: null,
    _inited: false,
    _joy: null,

    canUse: function () { return this.enabled && !(SE.Game && SE.Game.paused); },

    setMode: function (m) {
      if (m !== 'kbd' && m !== 'touch') return;
      if (SE.Platform && SE.Platform.id === 'playables') m = 'touch';   // Playables: joystick + buttons on PC too
      var changed = m !== this.mode;
      this.mode = m;
      try { document.documentElement.setAttribute('data-input', m); } catch (e) {}
      if (changed) {
        try { global.dispatchEvent(new CustomEvent('sade-input-mode', { detail: { mode: m } })); } catch (e) {}
      }
    },

    reset: function () {
      this.keys = {};
      this.jumpPressed = this.actionPressed = this.action2Pressed = false;
      this.camDelta.x = this.camDelta.y = 0;
      this.zoomDelta = 0;
      this.camPointers = {};
      this.pinchDist = 0;
      this.endJoystick();
      var pressed = document.querySelectorAll('.pressed[data-input], #btnAction.pressed, #btnAction2.pressed, #btnJump.pressed, #btnSellAll.pressed');
      for (var i = 0; i < pressed.length; i++) pressed[i].classList.remove('pressed');
    },

    press: function (name) {
      if (!this.canUse()) return;
      if (name === 'jump') this.jumpPressed = true;
      else if (name === 'action') this.actionPressed = true;
      else if (name === 'action2') this.action2Pressed = true;
    },

    setJoystick: function (x, y, active) {
      this.joyActive = !!active;
      this.move.x = active ? clamp(x, -1, 1) : 0;
      this.move.y = active ? clamp(y, -1, 1) : 0;
    },

    init: function (canvas) {
      var self = this;
      this.canvas = canvas;
      this.setMode(SE.Platform && SE.Platform.isMobile ? 'touch' : 'kbd');
      if (this._inited) return;
      this._inited = true;

      /* ---- keyboard ---- */
      global.addEventListener('keydown', function (e) {
        if (isTyping(e.target)) return;
        var code = e.code || '';
        if (/^(Key[WASDEF]|Arrow|Space)/.test(code)) self.setMode('kbd');
        if (!self.canUse()) return;
        self.keys[code] = true;
        if (code === 'Space' || code.indexOf('Arrow') === 0) e.preventDefault();
        if (e.repeat) return;
        if (code === 'Space') self.jumpPressed = true;
        if (code === 'KeyE') self.actionPressed = true;
        if (code === 'KeyF') self.action2Pressed = true;
      });
      global.addEventListener('keyup', function (e) { self.keys[e.code] = false; });
      global.addEventListener('lory-release-input', function () { self.reset(); });
      global.addEventListener('sade-release-input', function () { self.reset(); });
      /* Playables (pauseOnHidden false) must not use the Page Visibility API / blur: there the platform pause
         releases the input (SE.Game.setPaused → SE.Input.reset) */
      if (!(SE.Platform && SE.Platform.pauseOnHidden === false)) {
        global.addEventListener('blur', function () { self.reset(); });
        document.addEventListener('visibilitychange', function () { if (document.hidden) self.reset(); });
      }

      /* ---- pointer: delegated on-screen controls + canvas camera ---- */
      document.addEventListener('pointerdown', function (e) { self.onPointerDown(e); }, { capture: true, passive: false });
      global.addEventListener('pointermove', function (e) { self.onPointerMove(e); }, { passive: true });
      global.addEventListener('pointerup', function (e) { self.onPointerUp(e); }, { passive: true });
      global.addEventListener('pointercancel', function (e) { self.onPointerUp(e); }, { passive: true });
      document.addEventListener('touchstart', function () { self.setMode('touch'); }, { capture: true, passive: true });

      if (canvas) {
        canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        canvas.addEventListener('wheel', function (e) {
          if (!self.canUse()) return;
          var d = e.deltaY;
          if (e.deltaMode === 1) d *= 30;
          self.zoomDelta += clamp(d / 100, -3, 3) * 3.2;
          e.preventDefault();
        }, { passive: false });
        canvas.style.touchAction = 'none';
      }
    },

    controlOf: function (target) {
      if (!target || !target.closest) return null;
      var el;
      if ((el = target.closest(SEL.joystick))) return { kind: 'joystick', el: el };
      if ((el = target.closest(SEL.action))) return { kind: 'action', el: el };
      if ((el = target.closest(SEL.action2))) return { kind: 'action2', el: el };
      if ((el = target.closest(SEL.jump))) return { kind: 'jump', el: el };
      return null;
    },

    onPointerDown: function (e) {
      if (e.pointerType === 'touch' || e.pointerType === 'pen') this.setMode('touch');
      var c = this.controlOf(e.target);
      if (c) {
        if (e.cancelable) e.preventDefault();
        if (!this.canUse()) return;
        if (c.kind === 'joystick') { this.startJoystick(c.el, e); return; }
        this.press(c.kind);
        var el = c.el, id = e.pointerId;
        el.classList.add('pressed');
        var up = function (ev) {
          if (ev.pointerId !== id) return;
          el.classList.remove('pressed');
          global.removeEventListener('pointerup', up);
          global.removeEventListener('pointercancel', up);
        };
        global.addEventListener('pointerup', up);
        global.addEventListener('pointercancel', up);
        return;
      }
      if (!this.canvas || e.target !== this.canvas || !this.canUse()) return;
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      /* floating joystick: a touch anywhere on the left half of the screen grabs the joystick there */
      if (this.mode === 'touch' && this.joyId === null && e.clientX < global.innerWidth * 0.5 && (e.pointerType !== 'mouse' || e.button === 0)) {
        var jel = document.querySelector(SEL.joystick);
        if (jel && jel.offsetParent !== null) {
          if (e.cancelable) e.preventDefault();
          var jr = jel.getBoundingClientRect();
          jel.style.translate = (e.clientX - (jr.left + jr.width / 2)).toFixed(1) + 'px ' + (e.clientY - (jr.top + jr.height / 2)).toFixed(1) + 'px';
          this.startJoystick(jel, e);
          return;
        }
      }
      this.camPointers[e.pointerId] = { x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
      this.pinchDist = this.pinchDistance();
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) {}
    },

    pinchDistance: function () {
      var ids = Object.keys(this.camPointers);
      if (ids.length < 2) return 0;
      var a = this.camPointers[ids[0]], b = this.camPointers[ids[1]];
      return Math.hypot(a.x - b.x, a.y - b.y);
    },

    onPointerMove: function (e) {
      if (this.joyId !== null && e.pointerId === this.joyId) { this.moveJoystick(e.clientX, e.clientY); return; }
      var p = this.camPointers[e.pointerId];
      if (!p) return;
      if (!this.canUse()) { delete this.camPointers[e.pointerId]; return; }
      var n = Object.keys(this.camPointers).length;
      if (n >= 2) {
        p.x = e.clientX; p.y = e.clientY;
        var d = this.pinchDistance();
        if (this.pinchDist > 0 && d > 0) this.zoomDelta -= (d - this.pinchDist) * 0.09;
        this.pinchDist = d;
        return;
      }
      var k = p.touch ? 1.15 : 1;
      this.camDelta.x += (e.clientX - p.x) * 0.0052 * k;
      this.camDelta.y += (e.clientY - p.y) * 0.0042 * k;
      p.x = e.clientX; p.y = e.clientY;
    },

    onPointerUp: function (e) {
      if (this.joyId !== null && e.pointerId === this.joyId) this.endJoystick();
      if (this.camPointers[e.pointerId]) {
        delete this.camPointers[e.pointerId];
        this.pinchDist = this.pinchDistance();
      }
    },

    startJoystick: function (el, e) {
      if (this.joyId !== null) return;
      var knob = el.querySelector(SEL.knob) || el.firstElementChild;
      var r = el.getBoundingClientRect();
      this._joy = { el: el, knob: knob, cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: Math.max(24, r.width * 0.38) };
      this.joyId = e.pointerId;
      this.joyActive = true;
      el.classList.add('active');
      try { el.setPointerCapture(e.pointerId); } catch (err) {}
      this.moveJoystick(e.clientX, e.clientY);
    },

    moveJoystick: function (x, y) {
      var j = this._joy;
      if (!j) return;
      var dx = x - j.cx, dy = y - j.cy;
      var d = Math.hypot(dx, dy);
      var k = d > j.radius ? j.radius / d : 1;
      if (j.knob) j.knob.style.transform = 'translate(' + (dx * k).toFixed(1) + 'px,' + (dy * k).toFixed(1) + 'px)';
      var nx = (dx * k) / j.radius, ny = (dy * k) / j.radius;
      var len = Math.hypot(nx, ny);
      if (len < 0.12) { nx = 0; ny = 0; }                      // dead zone
      this.move.x = nx; this.move.y = ny;
    },

    endJoystick: function () {
      var j = this._joy;
      if (j) {
        if (j.knob) j.knob.style.transform = 'translate(0px,0px)';
        j.el.classList.remove('active');
        j.el.style.translate = '';                               // back to its home spot after a floating grab
      }
      this._joy = null;
      this.joyId = null;
      this.joyActive = false;
      this.move.x = 0; this.move.y = 0;
    },

    axis: function () {
      if (!this.canUse()) return { x: 0, z: 0, len: 0 };
      var x = 0, z = 0, k = this.keys;
      if (k.KeyW || k.ArrowUp) z -= 1;
      if (k.KeyS || k.ArrowDown) z += 1;
      if (k.KeyA || k.ArrowLeft) x -= 1;
      if (k.KeyD || k.ArrowRight) x += 1;
      if (this.joyActive) { x += this.move.x; z += this.move.y; }
      var len = Math.sqrt(x * x + z * z);
      if (len > 1) { x /= len; z /= len; len = 1; }
      return { x: x, z: z, len: len };
    },

    consumeJump: function () { var j = this.jumpPressed; this.jumpPressed = false; return j; },
    consumeAction: function () { var a = this.actionPressed; this.actionPressed = false; return a; },
    consumeAction2: function () { var a = this.action2Pressed; this.action2Pressed = false; return a; }
  };

  /* ====================================================================== */
  /* Fallback blocky character (only when SE.Models has no character)       */
  /* ====================================================================== */
  function fallbackCharacter(opts) {
    opts = opts || {};
    var g = new T.Group();
    function m(c) { return new T.MeshLambertMaterial({ color: c }); }
    function box(w, h, d, c) { var mesh = new T.Mesh(new T.BoxGeometry(w, h, d), m(c)); mesh.castShadow = true; return mesh; }
    var torso = box(2, 2.1, 1.1, opts.shirt || '#2f6fd6'); torso.position.y = 3.6; g.add(torso);
    var head = new T.Group(); head.position.y = 5.3; g.add(head);
    var hm = box(1.4, 1.4, 1.4, opts.skin || '#ffd27a'); head.add(hm);
    function limb(x, y, w, h, c) {
      var p = new T.Group(); p.position.set(x, y, 0);
      var b = box(w, h, w, c); b.position.y = -h / 2; p.add(b); g.add(p); return p;
    }
    var armL = limb(-1.45, 4.6, 0.9, 2.0, opts.skin || '#ffd27a');
    var armR = limb(1.45, 4.6, 0.9, 2.0, opts.skin || '#ffd27a');
    var legL = limb(-0.5, 2.5, 0.95, 2.5, opts.pants || '#2a3550');
    var legR = limb(0.5, 2.5, 0.95, 2.5, opts.pants || '#2a3550');
    return {
      group: g, head: head, torso: torso, armL: armL, armR: armR, legL: legL, legR: legR,
      t: 0, carry: null, headTop: 6.1,
      update: function (dt, moving, speedFactor, grounded) {
        this.t += dt * (moving ? 9 * Math.min(2.2, speedFactor || 1) : 3);
        var s = Math.sin(this.t), amp = moving ? 0.85 : 0.06;
        armL.rotation.x = s * amp; armR.rotation.x = -s * amp;
        legL.rotation.x = -s * amp; legR.rotation.x = s * amp;
        if (grounded === false) { legL.rotation.x = 0.4; legR.rotation.x = -0.4; }
        if (this.carry) { armL.rotation.x = -2.9; armR.rotation.x = -2.9; }
        else if (grounded === false) { armL.rotation.x = -2.2; armR.rotation.x = -2.2; }
      }
    };
  }

  function makeCharacter(opts) {
    var M = SE.Models || {};
    var fn = M.character || M.makeCharacter || M.createCharacter;
    if (typeof fn === 'function') {
      try {
        var c = fn.call(M, opts || {});
        if (c && c.group) return c;
      } catch (e) { console.error('[Player] SE.Models character failed, using the fallback', e); }
    }
    return fallbackCharacter(opts);
  }

  /* ====================================================================== */
  /* Player                                                                  */
  /* ====================================================================== */
  var _ray = { o: [0, 0, 0], d: [0, 0, 0] };
  var _seen = typeof Set !== 'undefined' ? new Set() : null;

  var Player = {
    pos: new T.Vector3(0, 0, 60),
    vel: new T.Vector3(0, 0, 0),
    yaw: Math.PI,
    grounded: true,
    moving: false,
    speed: 0,
    camYaw: Math.PI,
    camPitch: 0.34,
    camDist: 28,
    camTargetDist: 28,
    camCollideDist: 1e9,
    focus: new T.Vector3(),
    model: null,
    group: null,
    scene: null,
    carry: null,
    carryRig: null,
    carryAnchor: null,
    followers: [],
    invisible: false,
    stepTimer: 0,
    stepIndex: 0,
    movedDist: 0,
    jumps: 0,
    cameraReady: false,
    _ghost: false,
    _ghostMats: null,
    kb: { x: 0, z: 0 },
    _dustT: 0,

    init: function (scene) {
      this.scene = scene;
      this.model = makeCharacter({ player: true });
      this.group = this.model.group;
      this.group.name = 'player';
      scene.add(this.group);
      var W = SE.World || {};
      if (W.spawn) this.pos.set(W.spawn.x, 0, W.spawn.z);
      this.camYaw = this.yaw = typeof W.spawnYaw === 'number' ? W.spawnYaw : Math.PI;
      this.group.position.copy(this.pos);
      this.group.rotation.y = this.yaw;
      this.camTargetDist = this.camDist = SE.Platform && SE.Platform.isMobile ? 32 : 28;

      this.carryAnchor = new T.Group();
      this.carryAnchor.name = 'carry_anchor';
      var top = typeof this.model.carryHeight === 'number' ? this.model.carryHeight
        : (typeof this.model.headTop === 'number' ? this.model.headTop + 1.0 : 7.4);
      this.carryAnchor.position.set(0, top, 0.15);
      this.group.add(this.carryAnchor);

      this.refreshCosmetics();
      this.refreshFollowers();
      this.cameraReady = false;
    },

    setSpeedStat: function () {},

    statusOf: function (game, name) {
      if (!game || !game.statuses) return 0;
      return game.statuses[name] || 0;
    },

    walkSpeed: function (game) {
      var St = SE.State;
      var base = St && typeof St.walkSpeed === 'function' ? St.walkSpeed()
        : 12 + ((St && St.data && St.data.speed) || 20) * 0.28;
      if (SE.Boosts && SE.Boosts.isActive('speedBoost')) base *= 2;
      if (game && game.slowMode) base *= 0.5;
      if (this.statusOf(game, 'chilled') > 0) base *= 0.6;
      if (this.statusOf(game, 'stunned') > 0) base = 0;
      return base;
    },

    update: function (dt, game, camera) {
      var ax = Input.axis();
      var speed = this.walkSpeed(game);
      var stunned = this.statusOf(game, 'stunned') > 0;

      /* camera orbit / zoom input */
      this.camYaw -= Input.camDelta.x;
      this.camPitch = clamp(this.camPitch + Input.camDelta.y, PITCH_MIN, PITCH_MAX);
      Input.camDelta.x = 0; Input.camDelta.y = 0;
      if (Input.zoomDelta) {
        this.camTargetDist = clamp(this.camTargetDist + Input.zoomDelta, CAM_MIN, CAM_MAX);
        Input.zoomDelta = 0;
      }

      /* movement relative to the camera */
      var dirX = 0, dirZ = 0;
      if (ax.len > 0.02 && !stunned) {
        var sin = Math.sin(this.camYaw), cos = Math.cos(this.camYaw);
        dirX = -ax.x * cos - ax.z * sin;
        dirZ = ax.x * sin - ax.z * cos;
        var l = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
        dirX /= l; dirZ /= l;
        this.yaw = Math.atan2(dirX, dirZ);
      }
      var tvx = dirX * speed * ax.len, tvz = dirZ * speed * ax.len;
      var kbDecay = Math.exp(-6 * dt);
      this.kb.x *= kbDecay; this.kb.z *= kbDecay;
      var accel = this.grounded ? 16 : 7;
      this.vel.x = damp(this.vel.x, tvx, accel, dt);
      this.vel.z = damp(this.vel.z, tvz, accel, dt);
      if (stunned) { this.vel.x *= 0.85; this.vel.z *= 0.85; }

      /* jump + gravity */
      if (Input.consumeJump() && this.grounded && !stunned) {
        this.vel.y = JUMP_VEL;
        this.grounded = false;
        this.jumps++;
        audio('jump', { volume: 0.45 });
        if (SE.Tutorial && SE.Tutorial.notify) call(SE.Tutorial, 'notify', 'jumped');
      }
      this.vel.y -= GRAVITY * dt;

      var nx = this.pos.x, nz = this.pos.z;
      var ny = this.pos.y + this.vel.y * dt;
      var vx = this.vel.x + this.kb.x, vz = this.vel.z + this.kb.z;
      var steps = Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(vz)) * dt / 0.7));
      for (var s = 0; s < steps; s++) {
        var r = this.resolve(nx + vx * dt / steps, nz + vz * dt / steps, this.pos.y, RADIUS);
        nx = r.x; nz = r.z;
      }

      /* ground: floor or the top of a walkable collider */
      var groundY = this.groundAt(nx, nz, this.pos.y);
      var wasGrounded = this.grounded;
      if (ny <= groundY) {
        if (!wasGrounded && this.vel.y < -18) { audio('land', { volume: 0.35 }); fxAt('dust', this.pos.x, 0.3, this.pos.z, { count: 0.6 }); }
        ny = groundY;
        this.vel.y = 0;
        this.grounded = true;
      } else {
        this.grounded = ny - groundY < 0.05;
      }

      var W = SE.World || {};
      if (W.bounds) {
        nx = clamp(nx, W.bounds.minX + RADIUS, W.bounds.maxX - RADIUS);
        nz = clamp(nz, W.bounds.minZ + RADIUS, W.bounds.maxZ - RADIUS);
      }

      var moved = Math.hypot(nx - this.pos.x, nz - this.pos.z);
      this.movedDist += moved;
      this.speed = dt > 0 ? moved / dt : 0;
      this.pos.set(nx, ny, nz);
      this.moving = ax.len > 0.05 && this.speed > 0.5;

      this.group.position.copy(this.pos);
      this.group.rotation.y = angleDamp(this.group.rotation.y, this.yaw, 14, dt);
      if (this.model.update) this.model.update(dt, this.moving && this.grounded, speed / 17, this.grounded);

      /* running dust */
      if (this.moving && this.grounded && this.speed > 30) {
        this._dustT -= dt;
        if (this._dustT <= 0) { this._dustT = 0.12; fxAt('dust', this.pos.x, 0.2, this.pos.z, { count: 0.25, scale: 0.8 }); }
      }

      /* footsteps */
      if (this.moving && this.grounded) {
        if (SE.Audio && typeof SE.Audio.step === 'function') {
          try { SE.Audio.step(Math.max(0.6, this.speed / 16)); } catch (e) {}
        } else {
          this.stepTimer -= dt * Math.max(0.6, this.speed / 16);
          if (this.stepTimer <= 0) {
            this.stepTimer = 0.32;
            this.stepIndex = (this.stepIndex % 4) + 1;
            audio('step' + this.stepIndex, { volume: 0.22 });
          }
        }
      }

      /* carried egg */
      if (this.carryRig) {
        if (this.carryRig.update) this.carryRig.update(dt);
        var bob = this.moving ? Math.abs(Math.sin(this.movedDist * 0.55)) * 0.25 : Math.sin((game ? game.time : 0) * 2) * 0.06;
        this.carryRig.group.position.y = bob;
      }

      /* cosmetics trail */
      if (SE.Cosmetics && typeof SE.Cosmetics.updateTrail === 'function') {
        try { SE.Cosmetics.updateTrail(dt, this); } catch (e) { if (!this._trailErr) { this._trailErr = true; console.error(e); } }
      }

      this.updateFollowers(dt, game);
      if (camera) this.updateCamera(dt, camera);
    },

    groundAt: function (x, z, y) {
      var W = SE.World;
      var g = 0;
      if (!W || typeof W.nearColliders !== 'function') return g;
      var cols = W.nearColliders(x, z);
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        if (c.disabled || (!c.solid && !c.platform && !c.walkable)) continue;
        if (c.topY > 3.2 && !c.platform && !c.walkable) continue;        // walls: never stand on them
        if (x > c.minX - 0.9 && x < c.maxX + 0.9 && z > c.minZ - 0.9 && z < c.maxZ + 0.9) {
          if (y + 0.6 >= c.topY && c.topY > g) g = c.topY;
        }
      }
      return g;
    },

    /* Push (x, z) out of solid colliders the body at height y collides with. */
    resolve: function (x, z, y, radius) {
      var W = SE.World;
      if (!W || typeof W.nearColliders !== 'function') return { x: x, z: z };
      radius = radius || RADIUS;
      y = y || 0;
      var cols = W.nearColliders(x, z);
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        if (!c.solid || c.disabled) continue;
        if (y >= c.topY - 0.4) continue;                                  // standing on top
        var minX = c.minX - radius, maxX = c.maxX + radius;
        var minZ = c.minZ - radius, maxZ = c.maxZ + radius;
        if (x > minX && x < maxX && z > minZ && z < maxZ) {
          var dl = x - minX, dr = maxX - x, dtp = z - minZ, db = maxZ - z;
          var m = Math.min(dl, dr, dtp, db);
          if (m === dl) x = minX; else if (m === dr) x = maxX; else if (m === dtp) z = minZ; else z = maxZ;
        }
      }
      return { x: x, z: z };
    },

    /* ---------------- camera ---------------- */
    updateCamera: function (dt, camera) {
      var fx = this.pos.x, fy = this.pos.y + FOCUS_H, fz = this.pos.z;
      if (!this.cameraReady) {
        this.focus.set(fx, fy, fz);
      } else {
        this.focus.x = damp(this.focus.x, fx, 16, dt);
        this.focus.y = damp(this.focus.y, fy, 9, dt);
        this.focus.z = damp(this.focus.z, fz, 16, dt);
      }
      this.camDist = damp(this.camDist, this.camTargetDist, 8, dt);
      /* backed against a wall (the wall is right behind the player): the camera climbs (more pitch) so it looks down
         over the player instead of ending up inside the wall; it settles back slowly once there is room again */
      var sy = Math.sin(this.camYaw), cy = Math.cos(this.camYaw);
      var lift = 0, pitch0 = this.camPitch;
      var h0 = this.cameraHit(this.focus, -sy * Math.cos(pitch0), Math.sin(pitch0), -cy * Math.cos(pitch0), this.camDist + 0.8);
      if (h0 - 0.8 < 6) {
        var tries = [0.45, 0.9, 1.5 - pitch0];
        for (var ti = 0; ti < tries.length; ti++) {
          var pt = Math.min(1.5, pitch0 + tries[ti]);
          lift = pt - pitch0;
          if (this.cameraHit(this.focus, -sy * Math.cos(pt), Math.sin(pt), -cy * Math.cos(pt), this.camDist + 0.8) - 0.8 >= 6) break;
        }
      }
      this.camLift = this.camLift || 0;
      this.camLift = lift > this.camLift ? damp(this.camLift, lift, 14, dt) : damp(this.camLift, lift, 2.5, dt);
      var pitch = Math.min(1.5, pitch0 + this.camLift);
      var cp = Math.cos(pitch), sp = Math.sin(pitch);
      var dx = -sy * cp, dy = sp, dz = -cy * cp;
      var hit = this.cameraHit(this.focus, dx, dy, dz, this.camDist + 0.8);
      var want = Math.max(Math.min(2.5, hit - 0.5), 1.2, Math.min(this.camDist, hit - 0.8));
      /* snap closer at once (no peeking through walls), ease back out */
      if (!this.cameraReady || want < this.camCollideDist) this.camCollideDist = want;
      else this.camCollideDist = damp(this.camCollideDist, want, 4, dt);
      var d = this.camCollideDist;
      camera.position.set(this.focus.x + dx * d, Math.max(1.2, this.focus.y + dy * d), this.focus.z + dz * d);
      camera.lookAt(this.focus.x, this.focus.y, this.focus.z);
      this.cameraReady = true;
    },

    snapCamera: function () { this.cameraReady = false; this.camCollideDist = 1e9; },

    /* Distance along the ray (unit direction) to the first solid collider box. */
    cameraHit: function (o, dx, dy, dz, maxDist) {
      var W = SE.World;
      if (!W || typeof W.nearColliders !== 'function') return maxDist;
      var best = maxDist;
      var samples = Math.max(1, Math.ceil(maxDist / 7));
      if (_seen) _seen.clear();
      _ray.o[0] = o.x; _ray.o[1] = o.y; _ray.o[2] = o.z;
      _ray.d[0] = dx; _ray.d[1] = dy; _ray.d[2] = dz;
      for (var s = 0; s <= samples; s++) {
        var t = (s / samples) * maxDist;
        var cols = W.nearColliders(o.x + dx * t, o.z + dz * t);
        for (var i = 0; i < cols.length; i++) {
          var c = cols[i];
          if (!c.solid || c.disabled || c.noCamera || c.topY < 2.5) continue;
          if (_seen) { if (_seen.has(c)) continue; _seen.add(c); }
          var hit = rayBox(_ray.o, _ray.d, c.minX - 0.3, -1, c.minZ - 0.3, c.maxX + 0.3, c.topY + 0.3, c.maxZ + 0.3);
          if (hit >= 0 && hit < best) best = hit;
        }
      }
      return best;
    },

    /* ---------------- carried egg ---------------- */
    setCarry: function (egg, rig) {
      if (this.carryRig) {
        if (this.carryRig.group && this.carryRig.group.parent) this.carryRig.group.parent.remove(this.carryRig.group);
        if (this.carryRig !== rig && typeof this.carryRig.dispose === 'function') { try { this.carryRig.dispose(); } catch (e) {} }
      }
      this.carryRig = null;
      this.carry = egg || null;
      if (this.model) this.model.carry = egg || null;
      if (!egg) return;
      if (!rig) {
        var DM = SE.DragonModels;
        if (DM && typeof DM.createEgg === 'function') {
          try { rig = DM.createEgg(egg.species, egg.variant, 1.15); } catch (e) { console.error('[Player] createEgg failed', e); }
        }
      }
      if (!rig || !rig.group) {
        var mesh = new T.Mesh(new T.SphereGeometry(1, 14, 10), new T.MeshLambertMaterial({ color: (SE.DragonData && SE.DragonData.species(egg.species) || {}).color || '#f0e2b6' }));
        mesh.scale.set(0.85, 1.1, 0.85); mesh.position.y = 1.1;
        var g = new T.Group(); g.add(mesh);
        rig = { group: g, update: function () {}, setWobble: function () {} };
      }
      this.carryRig = rig;
      rig.group.position.set(0, 0, 0);
      this.carryAnchor.add(rig.group);
      if (this.invisible) this.setGhost(true, true);
    },

    /* ---------------- followers (equipped baby dragons) ---------------- */
    refreshFollowers: function () {
      if (!this.scene) return;
      var St = SE.State;
      var eq = St && St.data ? St.data.equipped.slice(0, MAX_FOLLOWERS) : [];
      var keep = [], i;
      var byUid = {};
      for (i = 0; i < this.followers.length; i++) byUid[this.followers[i].uid] = this.followers[i];
      for (i = 0; i < eq.length; i++) {
        var item = St.getDragon(eq[i]);
        if (!item) continue;
        var f = byUid[item.uid];
        if (f && f.species === item.species && f.variant === item.variant) { delete byUid[item.uid]; keep.push(f); continue; }
        f = this.makeFollower(item, i);
        if (f) keep.push(f);
      }
      for (var k in byUid) if (Object.prototype.hasOwnProperty.call(byUid, k)) this.disposeFollower(byUid[k]);
      this.followers = keep;
      for (i = 0; i < keep.length; i++) keep[i].slot = i;
    },

    makeFollower: function (item, slot) {
      var DM = SE.DragonModels, rig = null;
      if (DM && typeof DM.create === 'function') {
        var micro = !!(SE.Game && SE.Game.quality === 'low');      // draw-call budget on phones (legs/tail static)
        try { rig = DM.create(item.species, { baby: true, variant: item.variant, lite: true, micro: micro }); } catch (e) { console.error('[Player] follower rig failed', e); }
      }
      if (!rig || !rig.group) return null;
      rig.group.scale.multiplyScalar(0.78);
      var a = this.group ? this.group.rotation.y : 0;
      var f = {
        uid: item.uid, species: item.species, variant: item.variant, rig: rig, slot: slot,
        x: this.pos.x - Math.sin(a) * 5 + (Math.random() - 0.5) * 3, z: this.pos.z - Math.cos(a) * 5 + (Math.random() - 0.5) * 3,
        y: 0, phase: Math.random() * 6.28, happy: 0, nextHappy: 6 + Math.random() * 10, state: '', flyer: slot % 2 === 1
      };
      rig.group.position.set(f.x, 0, f.z);
      this.scene.add(rig.group);
      this.setRigState(f, f.flyer ? 'fly' : 'idle');
      return f;
    },

    disposeFollower: function (f) {
      if (!f || !f.rig) return;
      if (f.rig.group && f.rig.group.parent) f.rig.group.parent.remove(f.rig.group);
      if (typeof f.rig.dispose === 'function') { try { f.rig.dispose(); } catch (e) {} }
      f.rig = null;
    },

    setRigState: function (f, s) {
      if (f.state === s || !f.rig) return;
      f.state = s;
      if (typeof f.rig.setState === 'function') { try { f.rig.setState(s); } catch (e) {} }
    },

    celebrate: function (secs) {
      for (var i = 0; i < this.followers.length; i++) this.followers[i].happy = secs || 2;
    },

    updateFollowers: function (dt, game) {
      var n = this.followers.length;
      if (!n) return;
      var yaw = this.group.rotation.y;
      var sin = Math.sin(yaw), cos = Math.cos(yaw);
      var t = game ? game.time : 0;
      var pspeed = this.walkSpeed(null);
      for (var i = 0; i < n; i++) {
        var f = this.followers[i];
        if (!f.rig) continue;
        /* formation: two rows behind, flyers higher and a little wider */
        var row = i < 3 ? 0 : 1;
        var col = (i % 3) - 1;
        var offX = col * (f.flyer ? 4.6 : 3.4);
        var offZ = -4.6 - row * 3.8 - (col === 0 ? 0.8 : 0);
        var tx = this.pos.x + offX * cos + offZ * sin;
        var tz = this.pos.z - offX * sin + offZ * cos;
        var dx = tx - f.x, dz = tz - f.z;
        var d = Math.sqrt(dx * dx + dz * dz);
        if (d > 70) { f.x = tx; f.z = tz; d = 0; }
        var moving = d > 0.7;
        if (moving) {
          var sp = Math.min(Math.max(pspeed * 1.35, 10), 4 + d * 4.5);
          var step = Math.min(d, sp * dt);
          var nx = f.x + (dx / d) * step, nz = f.z + (dz / d) * step;
          if (!f.flyer) { var r = this.resolve(nx, nz, 0, 0.9); nx = r.x; nz = r.z; }
          f.x = nx; f.z = nz;
          f.rig.group.rotation.y = angleDamp(f.rig.group.rotation.y, Math.atan2(dx, dz), 9, dt);
        } else {
          f.rig.group.rotation.y = angleDamp(f.rig.group.rotation.y, yaw, 3, dt);
        }
        f.phase += dt * (moving ? 9 : 2.2);
        var y;
        if (f.flyer) {
          y = this.pos.y + 3.6 + Math.sin(t * 2.2 + i) * 0.45 + (row ? 0.9 : 0);
        } else {
          y = moving ? Math.abs(Math.sin(f.phase)) * 0.9 : 0;
          if (f.happy > 0) y = Math.abs(Math.sin(f.phase * 1.7)) * 1.2;
        }
        f.y = damp(f.y, y, 12, dt);
        f.rig.group.position.set(f.x, f.y, f.z);

        /* state */
        if (f.happy > 0) {
          f.happy -= dt;
          this.setRigState(f, 'happy');
        } else if (f.flyer) {
          this.setRigState(f, 'fly');
        } else if (moving) {
          this.setRigState(f, d > 6 ? 'run' : 'walk');
        } else {
          f.nextHappy -= dt;
          if (f.nextHappy <= 0) { f.nextHappy = 8 + Math.random() * 12; f.happy = 1.4; }
          this.setRigState(f, 'idle');
        }
        if (typeof f.rig.update === 'function') f.rig.update(dt, moving ? Math.min(d * 3, pspeed) : 0);
      }
    },

    /* ---------------- cosmetics ---------------- */
    refreshCosmetics: function () {
      var C = SE.Cosmetics, St = SE.State;
      if (!C || typeof C.apply !== 'function' || !this.model || !St || !St.data) return;
      var ghost = this._ghost;
      if (ghost) this.setGhost(false);
      try { C.apply(this.model, St.data.cosmetics.equipped); } catch (e) { console.error('[Player] Cosmetics.apply failed', e); }
      if (ghost) this.setGhost(true);
    },

    /* Semi-transparent look for the invisible status (materials are swapped, never mutated). */
    setGhost: function (on, force) {
      on = !!on;
      if (on === this._ghost && !force) return;
      this._ghost = on;
      this.invisible = on;
      var cache = this._ghostMats || (this._ghostMats = typeof Map !== 'undefined' ? new Map() : null);
      function ghostOf(mat) {
        if (!cache) return mat;
        var g = cache.get(mat);
        if (!g) {
          g = mat.clone();
          g.transparent = true;
          g.opacity = 0.32;
          g.depthWrite = false;
          cache.set(mat, g);
        }
        return g;
      }
      this.group.traverse(function (o) {
        if (!o.isMesh) return;
        if (on) {
          if (!o.userData._origMat || force) {
            var cur = o.userData._origMat || o.material;
            o.userData._origMat = cur;
            o.material = Array.isArray(cur) ? cur.map(ghostOf) : ghostOf(cur);
          }
          o.castShadow = false;
        } else if (o.userData._origMat) {
          o.material = o.userData._origMat;
          delete o.userData._origMat;
          o.castShadow = true;
        }
      });
    },

    /* ---------------- teleports ---------------- */
    teleport: function (x, z, yaw) {
      this.pos.set(x, 0, z);
      this.vel.set(0, 0, 0);
      this.kb.x = 0; this.kb.z = 0;
      this.grounded = true;
      this.moving = false;
      if (typeof yaw === 'number') { this.yaw = yaw; this.camYaw = yaw; this.group.rotation.y = yaw; }
      this.group.position.copy(this.pos);
      Input.reset();
      for (var i = 0; i < this.followers.length; i++) {
        this.followers[i].x = x + (Math.random() - 0.5) * 4;
        this.followers[i].z = z + 3 + Math.random() * 3;
      }
      this.snapCamera();
    },

    knockback: function (dx, dz, power) {
      var l = Math.sqrt(dx * dx + dz * dz) || 1;
      power = typeof power === 'number' ? power : 22;
      this.kb.x = dx / l * power;
      this.kb.z = dz / l * power;
      if (this.grounded) { this.vel.y = 9; this.grounded = false; }
    },

    teleportHome: function () {
      var W = SE.World || {};
      var sp = W.spawn || { x: 0, z: 60 };
      this.teleport(sp.x, sp.z, typeof W.spawnYaw === 'number' ? W.spawnYaw : Math.PI);
    }
  };

  /* Slab test: distance along a unit ray to an AABB (-1 if missed or behind). */
  function rayBox(o, d, minX, minY, minZ, maxX, maxY, maxZ) {
    var tmin = 0, tmax = 1e9;
    var mins = [minX, minY, minZ], maxs = [maxX, maxY, maxZ];
    for (var a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-6) {
        if (o[a] < mins[a] || o[a] > maxs[a]) return -1;
      } else {
        var t1 = (mins[a] - o[a]) / d[a], t2 = (maxs[a] - o[a]) / d[a];
        if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return -1;
      }
    }
    return tmin > 0 ? tmin : -1;       // focus inside a box → ignore that box
  }

  SE.Input = Input;
  SE.Player = Player;
  SE.Player.makeCharacter = makeCharacter;
})(window);
