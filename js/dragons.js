/* =========================================================================
   Steal a Dragon Egg — dragon AI (SE.DragonAI)                     SPEC §7, BALANCE §4

   Guardians (one adult per lair) sleep in the great nest; drakes (small adults ×0.55) patrol.
   States: guardian sleep → stir (wakeDelay) → roar (1 s, game.shake) → chase → return → sleep;
           drake patrol → alert (0.5 s, small roar) → chase → return → patrol.
   Chase ends when the target is in the safe zone, has no egg, is invisible, after 35 s of aggro or
   beyond 260 u. Catch distance: guardian 5.5, drake 3.5 (2-D, from the dragon's origin).
   Abilities: dash (5 s cd, 1.2 s × 1.6, ≤ 60 u, leaves / sand particles), frostBreath (≤ 18 u, 35° half-angle
   cone, 0.5 s telegraph, 4 s cd → game.applyStatus('chilled', 2.5)), fireball (3 s cd, ≤ 100 u, lob to the
   predicted spot with a red ground circle for 0.9 s, radius 4 → game.applyStatus('stunned', 0.5) + 6 u
   knockback), fly (Aurora hovers ≈ 9 u up and ignores colliders while chasing, lands within 14 u to catch).
   Speeds: guardian SPECIES.dragonSpeed, drake SPECIES.drakeSpeed; game.tutorialSlow → Meadow guardian × 0.6.
   dragonSleep boost: guardians do not wake for the player and drakes ignore the player.

   API
     SE.DragonAI.init(scene, world)       spawns every lair's guardian + drakes (uses world.lairs[i]
                                          .guardianSpawn / .greatNest / .drakeSpawns / .patrol / .gate)
     SE.DragonAI.update(dt, player, game) player = { pos:Vector3, invisible? } (SE.Player); game = SE.Game
     SE.DragonAI.alarm(lair, target)      lair = lair object or index; target = { kind:'player' } | { kind:'bot', bot }
     SE.DragonAI.calmPlayer() / calmBot(bot) / calmAll()
     SE.DragonAI.anyChasing(kind?) -> bool    ('player' | 'bot' | any; includes stir/roar)
     SE.DragonAI.threatLevel() -> 0..1         closest chaser of the player (music intensity / vignette)
     SE.DragonAI.reset()                       everyone home (guardians asleep, drakes patrolling)
     SE.DragonAI.forLair(i) -> [dragon]; SE.DragonAI.list -> [dragon]
     SE.DragonAI.onEvent = fn(type, dragon, data)   optional hook: 'state' | 'dash' | 'frostBreath' | 'fireball' | 'hit' | 'caught'
     dragon = { id, rig, lair, lairIndex, species, role:'guardian'|'drake', state, x, z, y, yaw, speed,
                target, catchDist, aggro, visible }
   Callbacks invoked: game.onCaught(dragon) · SE.Bots.onCaught(bot, dragon) · game.applyStatus(name, secs) ·
   game.shake(amount) · game.knockback?(dirX, dirZ, dist) (else the player is pushed via SE.Player.resolve) ·
   SE.Bots.applyStatus?(bot, name, secs) (else bot.status[name] = secs) · SE.Audio.play(key, { pos }) ·
   SE.FX (roar_wave via the rig, zzz, dash_leaves/dash_sand, frost_breath, freeze_hit, fireball_trail,
   fireball_hit, telegraphs). Collision: SE.Player.resolve(x, z, y, r) when present, else world.nearColliders.
   Section culling: dragons farther than 240 u (z) from the player and not chasing are hidden and not animated.
   ========================================================================= */
(function () {
  'use strict';
  const SE = window.SE = window.SE || {};
  const THREE = window.THREE;

  const AGGRO = 35, GIVE_UP = 260, CATCH_G = 5.5, CATCH_D = 3.5;
  const DASH = { cd: 5, dur: 1.2, mul: 1.6, range: 60 };
  const FROST = { cd: 4, range: 18, half: 35 * Math.PI / 180, tele: 0.5, breath: 0.7 };
  const FIRE = { cd: 3, range: 100, flight: 0.9, radius: 4, stun: 0.5, knock: 6 };
  const FLY = { alt: 9, landDist: 14 };
  const DRAKE_SEE = 30;
  const CULL_Z = 240;
  const CULL_OTHER = 120;   // dragons of another lair than the player's: drawn only when this close (behind walls/gates)
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const dist2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

  let scene = null, world = null, list = [], projectiles = [], uid = 0, inited = false;
  let lastPlayer = null, lastGame = null, sleepBoostWas = false;
  const tmpV = THREE ? new THREE.Vector3() : null;

  /* ------------------------------------------------------------------ helpers */
  function sound(key, x, z, opts) {
    const A = SE.Audio;
    if (!A || typeof A.play !== 'function') return;
    try { A.play(key, Object.assign({ pos: { x, z } }, opts || {})); } catch (e) { /* audio optional */ }
  }
  function boost(id) { try { return !!(SE.Boosts && SE.Boosts.isActive && SE.Boosts.isActive(id)); } catch (e) { return false; } }
  function lairOf(l) { if (typeof l === 'number') return world && world.lairs ? world.lairs[l] : null; return l || null; }
  function lairIndexOf(L) { return L ? (L.index != null ? L.index : world.lairs.indexOf(L)) : -1; }
  function speciesDef(L, i) {
    const DD = SE.DragonData;
    return (DD && (DD.species(L && L.species) || DD.SPECIES[i])) || { id: 'meadow', dragonSpeed: 18, drakeSpeed: 15, wakeDelay: 2, abilities: [], drakes: 0 };
  }
  /* step: dragons stride over low decor (rocks, logs ≤ step + 0.4 tall) instead of getting pinned on it */
  function resolve(x, z, r, step) {
    step = step || 0;
    if (SE.Player && typeof SE.Player.resolve === 'function') {
      try { return SE.Player.resolve(x, z, step, r); } catch (e) { /* fall through */ }
    }
    if (!world || typeof world.nearColliders !== 'function') return { x, z };
    const cols = world.nearColliders(x, z);
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c.solid || c.disabled || c.topY < 0.5 || c.topY <= step + 0.4) continue;
      const minX = c.minX - r, maxX = c.maxX + r, minZ = c.minZ - r, maxZ = c.maxZ + r;
      if (x > minX && x < maxX && z > minZ && z < maxZ) {
        const dl = x - minX, dr = maxX - x, dtp = z - minZ, db = maxZ - z, m = Math.min(dl, dr, dtp, db);
        if (m === dl) x = minX; else if (m === dr) x = maxX; else if (m === dtp) z = minZ; else z = maxZ;
      }
    }
    return { x, z };
  }
  function blocked(x, z, r, step) {
    if (!world || typeof world.nearColliders !== 'function') return false;
    const cols = world.nearColliders(x, z);
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i];
      if (!c.solid || c.disabled || c.topY < 1.2 || c.topY <= (step || 0) + 0.4) continue;
      if (x > c.minX - r && x < c.maxX + r && z > c.minZ - r && z < c.maxZ + r) return true;
    }
    return false;
  }
  function safeAt(x, z) {
    try { return !!(world && world.inSafeZone && world.inSafeZone(x, z)); } catch (e) { return false; }
  }
  // gates / chokepoints along the valley (south boundary of every lair)
  function chokepoints() {
    if (!world || !world.lairs) return [];
    return world.lairs.map((L, i) => {
      const g = L.gate || {};
      const hw = g.halfWidth || (g.width ? g.width / 2 : (i === 0 ? 16 : 11));
      return { z: g.z != null ? g.z : L.zMax, x: g.x != null ? g.x : (L.x || 0), hw };
    });
  }
  function sectionHalfWidth(x, z) {
    const L = world && world.lairAt ? world.lairAt(x, z) : null;
    if (L && L.halfWidth) return L.halfWidth;
    return 18;
  }

  /* ------------------------------------------------------------------ spawning */
  function makeDragon(L, i, role, k) {
    const def = speciesDef(L, i);
    const DM = SE.DragonModels;
    const drake = role === 'drake';
    const rig = DM ? DM.create(def.id, { drake, lite: true }) : null;
    const home = drake
      ? ((L.drakeSpawns && L.drakeSpawns[k]) || { x: (L.x || 0) + (k - 1) * 20, z: (L.z != null ? L.z : (L.zMin + L.zMax) / 2) })
      : (L.guardianSpawn || L.greatNest || { x: L.x || 0, z: (L.zMin || 0) + 20 });
    const d = {
      id: ++uid, rig, lair: L, lairIndex: i, species: def.id, def, role,
      state: drake ? 'patrol' : 'sleep', stateT: 0, x: home.x, z: home.z, y: 0, yaw: home.yaw != null ? home.yaw : Math.PI * (drake ? 1 : 0),
      vx: 0, vz: 0, speed: 0, target: null, aggro: 0, visible: true,
      home: { x: home.x, z: home.z, yaw: home.yaw != null ? home.yaw : 0, y: drake ? 0 : ((L.greatNest && L.greatNest.y) || 0.45) },
      catchDist: drake ? CATCH_D : CATCH_G, radius: drake ? 1.8 : 3.2,
      baseSpeed: drake ? (def.drakeSpeed || def.dragonSpeed * 0.85) : def.dragonSpeed,
      canFly: (def.abilities || []).indexOf('fly') >= 0,
      ab: { dash: (def.abilities || []).indexOf('dash') >= 0, frost: (def.abilities || []).indexOf('frostBreath') >= 0, fire: (def.abilities || []).indexOf('fireball') >= 0 },
      dashCd: 2 + Math.random() * 2, dashT: 0, dashFx: null,
      frostCd: 1.5, frostPhase: null, frostT: 0, frostHit: false, tele: null, breathFx: null,
      fireCd: 0.9 + Math.random() * 1.2,
      patrolIdx: k || 0, pauseT: 0, snoreT: 3 + Math.random() * 5, flapT: 0, alertT: 0, seeT: 0,
      tvx: 0, tvz: 0, lastTx: null, lastTz: null,
    };
    if (rig) {
      rig.group.position.set(d.x, drake ? 0 : d.home.y, d.z);
      rig.group.rotation.y = d.yaw;
      if (!drake) rig.setState('sleep', { snap: true });
      else rig.setState('walk');
      if (scene) scene.add(rig.group);
    }
    return d;
  }

  function init(sc, w) {
    if (inited) clearAll();
    scene = sc; world = w || SE.World;
    list = []; projectiles = [];
    inited = true;
    if (!world || !world.lairs) { console.warn('SE.DragonAI.init: world.lairs missing'); return api; }
    world.lairs.forEach((L, i) => {
      list.push(makeDragon(L, i, 'guardian', 0));
      const def = speciesDef(L, i);
      const n = def.drakes || 0;
      for (let k = 0; k < n; k++) list.push(makeDragon(L, i, 'drake', k));
    });
    return api;
  }
  function clearAll() {
    list.forEach((d) => { stopFx(d); if (d.rig) d.rig.dispose(); });
    projectiles.forEach(killProjectile);
    list = []; projectiles = [];
  }

  /* ------------------------------------------------------------------ state changes */
  function emitEvent(type, d, data) {
    if (typeof api.onEvent === 'function') { try { api.onEvent(type, d, data); } catch (e) { console.error(e); } }
  }
  function setState(d, s) {
    if (d.state === s) return;
    d.state = s; d.stateT = 0;
    emitEvent('state', d, s);
    const r = d.rig;
    if (!r) return;
    switch (s) {
      case 'stir':
        r.setState('wake', { duration: Math.max(0.3, d.def.wakeDelay || 1.5), next: 'idle' });
        r.setAlert(true);
        sound('stir', d.x, d.z);
        break;
      case 'roar':
        r.setState('roar', { duration: d.role === 'drake' ? 0.6 : 1.0, next: 'run' });
        r.setAlert(true);
        sound(d.role === 'drake' ? 'roar_small' : 'roar_big', d.x, d.z, { volume: d.role === 'drake' ? 0.7 : 1 });
        if (d.target && d.target.kind === 'player' && lastGame && typeof lastGame.shake === 'function' && lastPlayer && lastPlayer.pos) {
          const dd = dist2(d.x, d.z, lastPlayer.pos.x, lastPlayer.pos.z);
          try { lastGame.shake((d.role === 'drake' ? 0.25 : 0.7) * clamp(1.4 - dd / 160, 0.25, 1)); } catch (e) { /* optional */ }
        }
        break;
      case 'chase':
        d.aggro = 0;
        break;
      case 'return':
        d.target = null; r.setAlert(false); r.setLookTarget(null); stopFx(d);
        break;
      case 'sleep':
        r.setState('sleep'); r.setAlert(false); r.setLookTarget(null);
        break;
      case 'patrol':
        r.setAlert(false); r.setLookTarget(null);
        break;
      default:
    }
  }
  function stopFx(d) {
    if (d.dashFx) { d.dashFx.stop(); d.dashFx = null; }
    if (d.breathFx) { d.breathFx.stop(); d.breathFx = null; }
    if (d.tele) { d.tele.stop(); d.tele = null; }
    d.frostPhase = null; d.dashT = 0;
  }

  function targetPos(t, player) {
    if (!t) return null;
    if (t.kind === 'player') return player && player.pos ? player.pos : null;
    if (t.kind === 'bot' && t.bot) return t.bot.pos || (t.bot.x != null ? t.bot : null);
    return null;
  }
  function targetValid(d, t, player, game) {
    if (!t) return false;
    if (t.kind === 'player') {
      if (!player || !player.pos) return false;
      if (!game || !game.carrying) return false;
      if (player.invisible || boost('invisible')) return false;
      if (boost('dragonSleep')) return false;
      return true;
    }
    const b = t.bot;
    if (!b || !(b.pos || b.x != null)) return false;
    return !!b.carrying;
  }

  /* ------------------------------------------------------------------ alarm / calm */
  function alarm(lair, target) {
    const L = lairOf(lair);
    if (!L || !target) return;
    const isPlayer = target.kind === 'player';
    if (isPlayer && boost('dragonSleep')) return;
    const i = lairIndexOf(L);
    list.forEach((d) => {
      if (d.lairIndex !== i) return;
      const busyWithPlayer = d.target && d.target.kind === 'player' && (d.state === 'chase' || d.state === 'roar' || d.state === 'stir');
      if (!isPlayer && busyWithPlayer) return;           // the player has priority
      const t = isPlayer ? { kind: 'player' } : { kind: 'bot', bot: target.bot };
      if (d.role === 'guardian') {
        if (d.state === 'sleep') { d.target = t; setState(d, 'stir'); }
        else if (d.state === 'return' || d.state === 'idle') { d.target = t; setState(d, 'roar'); }
        else d.target = t;
      } else {
        if (d.state === 'patrol' || d.state === 'return') { d.target = t; d.alertT = 0.5; setState(d, 'alert'); }
        else d.target = t;
      }
    });
  }
  function calmWhere(pred) { list.forEach((d) => { if (d.target && pred(d.target) && d.state !== 'sleep' && d.state !== 'patrol') setState(d, 'return'); }); }
  function calmPlayer() { calmWhere((t) => t.kind === 'player'); projectiles.forEach((p) => { if (p.target && p.target.kind === 'player') p.target = null; }); }
  function calmBot(bot) { calmWhere((t) => t.kind === 'bot' && (!bot || t.bot === bot)); }
  function calmAll() { list.forEach((d) => { if (d.state !== 'sleep' && d.state !== 'patrol') setState(d, 'return'); }); }
  function anyChasing(kind) {
    return list.some((d) => (d.state === 'chase' || d.state === 'roar' || d.state === 'stir' || d.state === 'alert') && d.target && (!kind || d.target.kind === kind));
  }
  function threatLevel() {
    const p = lastPlayer && lastPlayer.pos;
    if (!p) return 0;
    let best = 0;
    list.forEach((d) => {
      if (!d.target || d.target.kind !== 'player') return;
      if (d.state !== 'chase' && d.state !== 'roar' && d.state !== 'stir' && d.state !== 'alert') return;
      const dd = dist2(d.x, d.z, p.x, p.z);
      const k = 1 - clamp((dd - d.catchDist) / 70, 0, 1);
      best = Math.max(best, d.state === 'chase' ? k : k * 0.6);
    });
    return best;
  }
  function reset() {
    projectiles.forEach(killProjectile); projectiles = [];
    list.forEach((d) => {
      stopFx(d);
      d.target = null; d.x = d.home.x; d.z = d.home.z; d.y = 0; d.yaw = d.home.yaw; d.speed = 0;
      if (d.role === 'guardian') { d.state = ''; setState(d, 'sleep'); if (d.rig) d.rig.setState('sleep', { snap: true }); }
      else { d.state = ''; setState(d, 'patrol'); }
    });
  }

  /* ------------------------------------------------------------------ movement */
  function steerPoint(d, tx, tz) {
    // route through the gate between the dragon and the target when they are in different sections
    if (d.y > 4) return { x: tx, z: tz };
    const cps = chokepoints();
    let best = null;
    for (let k = 0; k < cps.length; k++) {
      const c = cps[k];
      const between = (d.z < c.z - 1 && tz > c.z + 1) || (d.z > c.z + 1 && tz < c.z - 1);
      if (!between) continue;
      if (!best || Math.abs(c.z - d.z) < Math.abs(best.z - d.z)) best = c;
    }
    if (!best) return { x: tx, z: tz };
    const margin = Math.max(1, best.hw - d.radius - 1);
    const side = d.z < best.z ? -1 : 1;            // dragon's side of the gate line (north = −1)
    const aligned = Math.abs(d.x - best.x) < margin;
    // line up in front of the opening first, then aim a little beyond it to pass straight through
    if (!aligned) return { x: best.x + clamp(d.x - best.x, -margin, margin) * 0.3, z: best.z + side * 7 };
    return { x: best.x + clamp(tx - best.x, -margin, margin), z: best.z - side * 10 };
  }

  function moveToward(d, px, pz, speed, dt, turnRate) {
    let dx = px - d.x, dz = pz - d.z;
    const L = Math.hypot(dx, dz);
    if (L < 0.01) { d.speed = Math.max(0, d.speed - 60 * dt); return L; }
    let want = Math.atan2(dx, dz);
    const stepH = d.role === 'guardian' ? 3.2 : 2.2;
    // whisker avoidance on the ground (a near and a far probe, so an obstacle right at the body is seen too)
    if (d.y < 4 && d.detourT > 0) { d.detourT -= dt; want = d.detourA; }
    else if (d.y < 4) {
      const probe = d.radius + 6 + d.speed * 0.25, near = d.radius + 1.5;
      const hit = (a, pr) => blocked(d.x + Math.sin(a) * pr, d.z + Math.cos(a) * pr, d.radius * 0.7, stepH);
      if (hit(want, near) || hit(want, probe)) {
        const side = angDiff(d.yaw, want) >= 0 ? 1 : -1;
        const tries = [0.6, -0.6, 1.1, -1.1, 1.6, -1.6];
        for (let k = 0; k < tries.length; k++) {
          const a = want + tries[k] * side;
          if (!hit(a, near) && !hit(a, probe)) { want = a; break; }
        }
      }
    }
    const turn = clamp(angDiff(d.yaw, want), -turnRate * dt, turnRate * dt);
    d.yaw += turn;
    // accelerate (slower while turning hard)
    const align = Math.max(0.35, Math.cos(angDiff(d.yaw, want)));
    const target = speed * align;
    const acc = Math.max(45, speed * 2.2);              // full speed in ≈ 0.45 s
    d.speed += clamp(target - d.speed, -acc * 1.6 * dt, acc * dt);
    const step = Math.min(d.speed * dt, L);
    let nx = d.x + Math.sin(d.yaw) * step, nz = d.z + Math.cos(d.yaw) * step;
    if (d.y < 4) {
      const r = resolve(nx, nz, d.radius, stepH); nx = r.x; nz = r.z;
      // pinned against a collider (moved < 25 % of the step for 0.45 s): side-step around it for 0.7 s
      if (step > 0.05 && Math.hypot(nx - d.x, nz - d.z) < step * 0.25) d.blockT = (d.blockT || 0) + dt;
      else d.blockT = Math.max(0, (d.blockT || 0) - dt * 2);
      if (d.blockT > 0.45) {
        d.blockT = 0; d.detourT = 0.7;
        d.detourA = Math.atan2(dx, dz) + (Math.random() < 0.5 ? 1 : -1) * Math.PI * 0.5;
      }
    } else {
      const hw = sectionHalfWidth(nx, nz) - 4;
      nx = clamp(nx, -hw, hw);
    }
    d.vx = (nx - d.x) / Math.max(1e-4, dt); d.vz = (nz - d.z) / Math.max(1e-4, dt);
    d.x = nx; d.z = nz;
    return L;
  }

  /* ------------------------------------------------------------------ abilities */
  function doDash(d, dt, dist) {
    if (!d.ab.dash) return 1;
    if (d.dashT > 0) {
      d.dashT -= dt;
      if (d.dashT <= 0 && d.dashFx) { d.dashFx.stop(); d.dashFx = null; }
      return DASH.mul;
    }
    d.dashCd -= dt;
    if (d.dashCd <= 0 && dist < DASH.range && dist > d.catchDist + 4 && d.y < 4) {
      d.dashCd = DASH.cd; d.dashT = DASH.dur;
      if (SE.FX && d.rig) {
        const name = d.species === 'amber' ? 'dash_sand' : (d.species === 'aurora' ? 'dash_sand' : 'dash_leaves');
        d.dashFx = SE.FX.attach(name, d.rig.group, { offset: [0, 0.3, 0], scale: d.role === 'drake' ? 0.55 : 1, duration: DASH.dur, color: d.species === 'aurora' ? '#f0e6ff' : undefined });
      }
      sound('dash', d.x, d.z);
      emitEvent('dash', d);
      return DASH.mul;
    }
    return 1;
  }

  function frostLogic(d, dt, tp, player, game) {
    if (!d.ab.frost) return 1;
    d.frostCd -= dt;
    const mouth = d.rig && d.rig.mouth;
    const groundMouth = () => {
      if (mouth) { mouth.getWorldPosition(tmpV); return { x: tmpV.x, z: tmpV.z }; }
      return { x: d.x + Math.sin(d.yaw) * 6, z: d.z + Math.cos(d.yaw) * 6 };
    };
    if (!d.frostPhase) {
      if (d.frostCd > 0 || !tp) return 1;
      const dist = dist2(d.x, d.z, tp.x, tp.z);
      const ang = Math.abs(angDiff(d.yaw, Math.atan2(tp.x - d.x, tp.z - d.z)));
      if (dist <= FROST.range && ang < FROST.half * 0.8) {
        d.frostPhase = 'tele'; d.frostT = FROST.tele; d.frostHit = false;
        const gm = groundMouth();
        if (SE.FX) d.tele = SE.FX.telegraph({ x: gm.x, y: 0, z: gm.z }, { shape: 'cone', radius: FROST.range, angle: FROST.half, yaw: d.yaw, life: FROST.tele, color: '#2fa8ff' });
      }
      return 1;
    }
    d.frostT -= dt;
    const gm = groundMouth();
    if (d.tele) d.tele.set({ x: gm.x, z: gm.z, yaw: d.yaw });
    if (d.frostPhase === 'tele') {
      if (d.frostT <= 0) {
        d.frostPhase = 'breath'; d.frostT = FROST.breath;
        if (d.tele) { d.tele.stop(); d.tele = null; }
        if (SE.FX && mouth) d.breathFx = SE.FX.attach('frost_breath', mouth, { orient: true, duration: FROST.breath, scale: d.role === 'drake' ? 0.6 : 1 });
        if (d.rig) d.rig.setState('breath', { duration: FROST.breath + 0.1, next: 'run' });
        sound('frost_breath', d.x, d.z);
        emitEvent('frostBreath', d);
      }
      return 0.85;                 // keeps closing in while it inhales
    }
    // breath: hit once while the target is inside the cone (measured from the mouth)
    if (!d.frostHit && tp) {
      const range = (FROST.range + 2) * (d.role === 'drake' ? 0.7 : 1);
      const dx = tp.x - gm.x, dz = tp.z - gm.z, dist = Math.hypot(dx, dz);
      const ang = Math.abs(angDiff(d.yaw, Math.atan2(dx, dz)));
      if (dist <= range && (ang <= FROST.half || dist < 3)) {
        d.frostHit = true;
        applyStatus(d.target, 'chilled', 2.5, player, game);
        if (SE.FX) SE.FX.emit('freeze_hit', { x: tp.x, y: 0, z: tp.z });
        emitEvent('hit', d, 'chilled');
        sound('freeze', tp.x, tp.z);
      }
    }
    if (d.frostT <= 0) {
      d.frostPhase = null; d.frostCd = FROST.cd;
      if (d.breathFx) { d.breathFx.stop(); d.breathFx = null; }
    }
    return 0.7;
  }

  function applyStatus(t, name, secs, player, game) {
    if (!t) return;
    if (t.kind === 'player') {
      if (game && typeof game.applyStatus === 'function') { try { game.applyStatus(name, secs); } catch (e) { console.error(e); } }
    } else if (t.bot) {
      const B = SE.Bots;
      if (B && typeof B.applyStatus === 'function') { try { B.applyStatus(t.bot, name, secs); } catch (e) { console.error(e); } }
      else { t.bot.status = t.bot.status || {}; t.bot.status[name] = secs; }
    }
  }

  function fireLogic(d, dt, tp, player, game) {
    if (!d.ab.fire || !tp) return;
    d.fireCd -= dt;
    const dist = dist2(d.x, d.z, tp.x, tp.z);
    if (d.fireCd > 0 || dist > FIRE.range || dist < 8) return;
    d.fireCd = FIRE.cd * (d.role === 'drake' ? 1.6 : 1) + Math.random() * 0.4;
    // predict where the target will be when the fireball lands
    const lead = FIRE.flight;
    let lx = tp.x + d.tvx * lead, lz = tp.z + d.tvz * lead;
    const lerr = 1.6;
    lx += (Math.random() - 0.5) * lerr * 2; lz += (Math.random() - 0.5) * lerr * 2;
    const r = resolve(lx, lz, 1); lx = r.x; lz = r.z;
    const from = new THREE.Vector3();
    if (d.rig && d.rig.mouth) d.rig.mouth.getWorldPosition(from); else from.set(d.x, 8, d.z);
    const obj = new THREE.Group();
    const core = new THREE.Mesh(fireGeo(), fireMat());
    obj.add(core);
    obj.position.copy(from);
    if (scene) scene.add(obj);
    const p = {
      obj, from, to: new THREE.Vector3(lx, 0.3, lz), t: 0, dur: FIRE.flight, arc: 8 + dist * 0.12,
      target: d.target ? Object.assign({}, d.target) : null, owner: d,
      trail: SE.FX ? SE.FX.attach('fireball_trail', obj, { scale: d.role === 'drake' ? 0.7 : 1 }) : null,
      tele: SE.FX ? SE.FX.telegraph({ x: lx, y: 0, z: lz }, { radius: FIRE.radius, life: FIRE.flight, color: '#ff2a1a' }) : null,
      scale: d.role === 'drake' ? 0.7 : 1,
    };
    core.scale.setScalar(p.scale);
    projectiles.push(p);
    if (SE.FX) SE.FX.flash(from, '#ffb050', { size: 6 * p.scale, life: 0.2 });
    sound('fireball_cast', d.x, d.z);
    emitEvent('fireball', d, { x: lx, z: lz });
  }
  let _fireGeo = null, _fireMat = null;
  function fireGeo() { return _fireGeo || (_fireGeo = new THREE.IcosahedronGeometry(1.25, 1)); }
  function fireMat() { return _fireMat || (_fireMat = new THREE.MeshBasicMaterial({ color: '#ffd27a', toneMapped: false })); }
  function killProjectile(p) {
    if (p.trail) p.trail.stop();
    if (p.tele) p.tele.stop();
    if (p.obj && p.obj.parent) p.obj.parent.remove(p.obj);
  }
  function updateProjectiles(dt, player, game) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.t += dt;
      const u = Math.min(1, p.t / p.dur);
      p.obj.position.lerpVectors(p.from, p.to, u);
      p.obj.position.y += Math.sin(Math.PI * u) * p.arc;
      p.obj.rotation.x += dt * 9; p.obj.rotation.y += dt * 7;
      if (u >= 1) {
        const x = p.to.x, z = p.to.z;
        if (SE.FX) SE.FX.emit('fireball_hit', { x, y: 0, z }, { scale: p.scale });
        sound('fireball_hit', x, z);
        const tp = p.target ? targetPos(p.target, player) : null;
        if (tp) {
          const dd = dist2(tp.x, tp.z, x, z);
          if (dd <= FIRE.radius * p.scale + 0.5) {
            applyStatus(p.target, 'stunned', FIRE.stun, player, game);
            const nx = (tp.x - x) / (dd || 1), nz = (tp.z - z) / (dd || 1);
            knockback(p.target, dd > 0.01 ? nx : Math.sin(p.owner.yaw), dd > 0.01 ? nz : Math.cos(p.owner.yaw), FIRE.knock, player, game);
            if (SE.FX) SE.FX.emit('stun_stars', { x: tp.x, y: 7.6, z: tp.z });
            emitEvent('hit', p.owner, 'stunned');
          }
        }
        if (p.target && p.target.kind === 'player' && game && game.shake && player && player.pos && dist2(player.pos.x, player.pos.z, x, z) < 30) {
          try { game.shake(0.35); } catch (e) { /* optional */ }
        }
        killProjectile(p);
        projectiles.splice(i, 1);
      }
    }
  }
  function knockback(t, nx, nz, distU, player, game) {
    if (t.kind === 'player') {
      if (game && typeof game.knockback === 'function') { try { game.knockback(nx, nz, distU); return; } catch (e) { /* fall back */ } }
      if (player && player.pos) { const r = resolve(player.pos.x + nx * distU, player.pos.z + nz * distU, 1.4); player.pos.x = r.x; player.pos.z = r.z; }
    } else if (t.bot && t.bot.pos) {
      const r = resolve(t.bot.pos.x + nx * distU, t.bot.pos.z + nz * distU, 1.4); t.bot.pos.x = r.x; t.bot.pos.z = r.z;
    }
  }

  /* ------------------------------------------------------------------ catch */
  function caught(d, player, game) {
    const t = d.target;
    if (!t) return;
    emitEvent('caught', d, t);
    if (t.kind === 'player') {
      calmPlayer();
      if (game && typeof game.onCaught === 'function') { try { game.onCaught(d); } catch (e) { console.error(e); } }
    } else if (t.bot) {
      const bot = t.bot;
      calmBot(bot);
      const B = SE.Bots;
      if (B && typeof B.onCaught === 'function') { try { B.onCaught(bot, d); } catch (e) { console.error(e); } }
    }
    setState(d, 'return');
  }

  /* ------------------------------------------------------------------ per-dragon update */
  function updateDragon(d, dt, player, game) {
    d.stateT += dt;
    const r = d.rig;
    const tp = targetPos(d.target, player);
    // target velocity estimate (for leads / fireball prediction)
    if (tp) {
      if (d.lastTx != null && dt > 0) {
        d.tvx += ((tp.x - d.lastTx) / dt - d.tvx) * Math.min(1, dt * 6);
        d.tvz += ((tp.z - d.lastTz) / dt - d.tvz) * Math.min(1, dt * 6);
      }
      d.lastTx = tp.x; d.lastTz = tp.z;
    } else { d.lastTx = null; d.tvx = d.tvz = 0; }
    const tutorial = !!(game && game.tutorialSlow) && d.lairIndex === 0 && d.target && d.target.kind === 'player';
    let moveState = 'idle', moveSpeed = 0, wantAlt = 0;

    switch (d.state) {
      case 'sleep': {
        d.speed = 0;
        d.snoreT -= dt;
        if (d.snoreT <= 0) {
          d.snoreT = 5 + Math.random() * 5;
          if (player && player.pos && dist2(d.x, d.z, player.pos.x, player.pos.z) < 90) sound('snore', d.x, d.z, { volume: 0.6 });
        }
        if (r && r.state !== 'sleep') r.setState('sleep');
        break;
      }
      case 'stir': {
        if (tp && r) r.setLookTarget(tmpV.set(tp.x, 4, tp.z));
        if (d.stateT >= Math.max(0.3, d.def.wakeDelay || 1.5)) setState(d, 'roar');
        d.speed = 0;
        break;
      }
      case 'alert': {             // drakes: 0.5 s reaction + quick roar
        if (tp) { d.yaw += clamp(angDiff(d.yaw, Math.atan2(tp.x - d.x, tp.z - d.z)), -6 * dt, 6 * dt); }
        if (r && d.stateT < dt * 1.5) { r.setAlert(true); r.setState('roar', { duration: 0.55, next: 'run' }); sound('roar_small', d.x, d.z, { volume: 0.6 }); }
        d.speed = Math.max(0, d.speed - 40 * dt);
        if (d.stateT >= (d.alertT || 0.5)) setState(d, 'chase');
        break;
      }
      case 'roar': {
        if (tp) d.yaw += clamp(angDiff(d.yaw, Math.atan2(tp.x - d.x, tp.z - d.z)), -3 * dt, 3 * dt);
        if (tp && r) r.setLookTarget(tmpV.set(tp.x, 4, tp.z));
        d.speed = Math.max(0, d.speed - 40 * dt);
        if (d.stateT >= (d.role === 'drake' ? 0.6 : 1.0)) setState(d, 'chase');
        break;
      }
      case 'chase': {
        if (!targetValid(d, d.target, player, game) || !tp) { setState(d, 'return'); break; }
        d.aggro += dt;
        const dist = dist2(d.x, d.z, tp.x, tp.z);
        if (safeAt(tp.x, tp.z) || d.aggro > AGGRO || dist > GIVE_UP) { setState(d, 'return'); break; }
        if (d.aggro > 2.5 && r) r.setAlert(false);
        // abilities
        let mul = doDash(d, dt, dist);
        mul *= frostLogic(d, dt, tp, player, game);
        fireLogic(d, dt, tp, player, game);
        if (tutorial) mul *= 0.6;
        // flying (Aurora): hover while far, land to catch
        if (d.canFly) wantAlt = dist > FLY.landDist ? FLY.alt : 0;
        // steering with a lead on the target
        const lead = clamp(dist / Math.max(10, d.baseSpeed) * 0.35, 0, 0.6);
        const sp = steerPoint(d, tp.x + d.tvx * lead, tp.z + d.tvz * lead);
        moveToward(d, sp.x, sp.z, d.baseSpeed * mul, dt, d.role === 'drake' ? 6.5 : 4.6);
        if (r) r.setLookTarget(tmpV.set(tp.x, 4, tp.z));
        moveState = d.y > 1.5 ? 'fly' : 'run'; moveSpeed = d.speed;
        // catch
        const cd = dist2(d.x, d.z, tp.x, tp.z);
        if (cd <= d.catchDist && d.y < 3) caught(d, player, game);
        break;
      }
      case 'return': {
        const hx = d.home.x, hz = d.home.z;
        const dist = dist2(d.x, d.z, hx, hz);
        if (d.canFly) wantAlt = dist > 12 ? FLY.alt : 0;
        if (dist < 2.5) {
          if (d.role === 'guardian') {
            d.yaw += clamp(angDiff(d.yaw, d.home.yaw), -2 * dt, 2 * dt);
            d.speed = 0;
            if (Math.abs(angDiff(d.yaw, d.home.yaw)) < 0.15 && d.y < 0.5) setState(d, 'sleep');
          } else setState(d, 'patrol');
          break;
        }
        const sp = steerPoint(d, hx, hz);
        const spd = Math.max(8, d.baseSpeed * (d.role === 'drake' ? 0.45 : 0.4));
        moveToward(d, sp.x, sp.z, Math.min(spd, dist * 2 + 3), dt, 3.5);
        moveState = d.y > 1.5 ? 'fly' : 'walk'; moveSpeed = d.speed;
        // drakes passing an egg carrier on the way back can re-engage
        if (d.role === 'drake') drakeLook(d, dt, player, game);
        break;
      }
      case 'patrol': {
        const pts = d.lair.patrol && d.lair.patrol.length ? d.lair.patrol : [d.home];
        if (d.pauseT > 0) {
          d.pauseT -= dt; d.speed = Math.max(0, d.speed - 30 * dt);
        } else {
          const p = pts[d.patrolIdx % pts.length];
          const dist = moveToward(d, p.x, p.z, clamp(d.baseSpeed * 0.22, 4, 9), dt, 2.5);
          moveState = 'walk'; moveSpeed = d.speed;
          if (dist < 3) { d.patrolIdx = (d.patrolIdx + 1) % pts.length; d.pauseT = 1.2 + Math.random() * 2.2; }
        }
        drakeLook(d, dt, player, game);
        break;
      }
      default:
    }
    // altitude (fly)
    const altRate = wantAlt > d.y ? 10 : 14;
    d.y += clamp(wantAlt - d.y, -altRate * dt, altRate * dt);
    if (d.y > 1.5 && d.state === 'chase' || d.y > 1.5 && d.state === 'return') {
      d.flapT -= dt;
      if (d.flapT <= 0) { d.flapT = 0.65; sound('wing_flap', d.x, d.z, { volume: 0.5 }); }
    }
    // rig
    if (r) {
      const g = r.group;
      const baseY = d.state === 'sleep' || (d.role === 'guardian' && d.state === 'stir') ? d.home.y : 0;
      g.position.set(d.x, baseY + d.y, d.z);
      g.rotation.y = d.yaw;
      if (d.state === 'chase' || d.state === 'return' || d.state === 'patrol') {
        // timed rig states (roar / breath / wake) finish first while chasing
        if (!r.stateDur || d.state !== 'chase') r.setState(moveState === 'idle' ? 'idle' : moveState);
      }
    }
    d.moveSpeed = moveSpeed;
  }

  function drakeLook(d, dt, player, game) {
    if (!player || !player.pos || !game || !game.carrying || boost('dragonSleep') || player.invisible || boost('invisible')) { d.seeT = 0; return; }
    const p = player.pos;
    if (safeAt(p.x, p.z)) return;
    const dist = dist2(d.x, d.z, p.x, p.z);
    const L = d.lair;
    const inLair = !L || L.zMin == null || (p.z >= L.zMin - 4 && p.z <= L.zMax + 8);
    if (dist < DRAKE_SEE && inLair) {
      d.seeT += dt;
      if (d.seeT > 0.25) { d.target = { kind: 'player' }; d.alertT = 0.5; setState(d, 'alert'); d.seeT = 0; }
    } else d.seeT = 0;
  }

  /* ------------------------------------------------------------------ main update */
  function update(dt, player, game) {
    if (!inited) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    lastPlayer = player; lastGame = game;
    // dragonSleep boost started: everybody chasing the player goes home
    const sb = boost('dragonSleep');
    if (sb && !sleepBoostWas) calmPlayer();
    sleepBoostWas = sb;
    const pz = player && player.pos ? player.pos.z : 0;
    const pl = player && player.pos && world && world.lairAt ? world.lairAt(player.pos.x, player.pos.z) : null;
    const pLair = pl ? pl.index : 0;        // base / valley: the Meadow lair is the one in view
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      updateDragon(d, dt, player, game);
      // section culling
      const busy = d.state === 'chase' || d.state === 'roar' || d.state === 'stir' || d.state === 'alert' || d.state === 'return';
      const lairHidden = d.lair && d.lair.group && d.lair.group.visible === false;
      const vis = busy || (!lairHidden && Math.abs(d.z - pz) < (d.lairIndex === pLair ? CULL_Z : CULL_OTHER));
      d.visible = vis;
      if (d.rig) {
        d.rig.group.visible = vis;
        if (vis) d.rig.update(dt, d.moveSpeed || 0);
      }
    }
    updateProjectiles(dt, player, game);
  }

  const api = {
    init, update, alarm, calmPlayer, calmBot, calmAll, anyChasing, threatLevel, reset,
    forLair: (i) => list.filter((d) => d.lairIndex === i),
    onEvent: null,   // optional hook (type: 'state'|'dash'|'frostBreath'|'fireball'|'hit'|'caught', dragon, data)
    list,
    CONST: { AGGRO, GIVE_UP, CATCH_G, CATCH_D, DASH, FROST, FIRE, FLY },
  };
  Object.defineProperty(api, 'list', { get: () => list, enumerable: true });
  SE.DragonAI = api;
})();
