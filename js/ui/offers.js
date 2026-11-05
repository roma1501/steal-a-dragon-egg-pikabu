/* =========================================================================
   Steal a Dragon Egg — rewarded-offer HUD (SE.OffersUI)          SPEC §7, §8, §10

   Everything here only SHOWS rewarded offers; ads and rewards go through
   SE.Ads.claim(id, ctx) (reward granted once, only after the platform confirms)
   and SE.Game.applyReward. The reward and its condition are always visible before
   the ad: HUD buttons say what they give and «За рекламу»; everything else opens
   the generic 'offer' dialog (ui/misc.js) first. Nothing shows during the
   tutorial; without ads the buttons are disabled with the reason and the bubble
   never appears.

   Parts (DOM is created here, styles in css/offers.css):
     #ofxTeleport  «Телепорт домой · За рекламу» — while carrying an egg outside the base;
                   claims 'teleportHome' directly (cooldown / unavailable shown on the button).
     chips in #boostList (same look as the boost timers):
                   .ofx-chest   free chest, ready every SE.Ads.REWARD.chestEvery s (timer persisted
                                in State.data.rewards.cd) → 'offer' dialog for 'freeChest' → reveal
                   .ofx-golden  the next stolen egg is at least Golden (goldenEgg charge)
                   .ofx-trial   trial raid timer
                   (dragonShield / turboTrain / gemsX2 are SE.Boosts timers → core chips; this file
                    adds their ×N tags and the shield colour in CSS)
     #ofxBubble    contextual offer bubble: SE.Game.contextOffer() → small dismissible card next
                   to the Boosts button (portrait phones: between the top HUD columns); at most
                   every BUBBLE_GAP s, never during the tutorial / a chase / a panel / pause.
                   Tap → 'offer' dialog; ✕ → hidden, that offer is snoozed.
     #ofxReveal    chest reveal (chest shakes, opens, prize pops) — chestReveal(result)
     result panel  extra offers from SE.Game.resultOffers(data) ('tripleReward') rendered into the
                   open 'result' panel via SE.UI.on('open') (ui/misc.js untouched); a re-render of
                   the panel re-inserts them; skipped if the panel already shows that placement.
   API
     SE.OffersUI.init()                    idempotent; runs by itself once SE.UI exists
     SE.OffersUI.chestReveal(result)       result = SE.Game.rollChest() output
     SE.OffersUI.bubbleState() -> { visible, id, reason } ; forceBubble() (QA: skip the timers)
     SE.OffersUI.BUBBLE_GAP, FIRST_DELAY, BUBBLE_LIFE (s)
   Strings: ofx.* (ru/en/tr).
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var doc = global.document;

  var BUBBLE_GAP = 150;        // s between two bubbles
  var FIRST_DELAY = 45;        // s of play (after the tutorial) before the first bubble
  var BUBBLE_LIFE = 12;        // s a bubble stays
  var SNOOZE = 360;            // s an offer is skipped after ✕
  var TICK_MS = 250;

  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: {
        'ofx.tp': 'Телепорт домой', 'ofx.tpShort': 'Домой', 'ofx.forAd': 'За рекламу', 'ofx.in': 'Через {0}',
        'ofx.noAds': 'Реклама недоступна', 'ofx.busy': 'Реклама…', 'ofx.chest': 'Сундук',
        'ofx.chestIn': 'Сундук будет готов через {0}', 'ofx.chestTitle': 'Награда из сундука!', 'ofx.take': 'Забрать',
        'ofx.newItem': 'Новый предмет: {0}', 'ofx.newItemHint': 'Надень его в магазине', 'ofx.boostFor': 'на {0}',
        'ofx.trialChip': 'Пробный набег: ещё {0}', 'ofx.trialRound': 'Пробный набег: донеси яйцо до базы!',
        'ofx.tripleDone': '×3 получено!', 'ofx.cashPrize': 'Мешок денег',
        'ofx.pitch.dragonSleep': 'Драконы не проснутся 45 с', 'ofx.pitch.dragonShield': 'Поймают — яйцо останется у тебя',
        'ofx.pitch.teleportHome': 'Мгновенно домой вместе с яйцом', 'ofx.pitch.trialRaid': 'Ворота откроются на один набег',
        'ofx.pitch.lairDiscount': 'Логова дешевле на 30 %', 'ofx.pitch.turboTrain': 'Тренировка ×3 на 3 минуты',
        'ofx.pitch.freeHatchery': 'Новый инкубатор бесплатно', 'ofx.pitch.instantHatch': 'Яйцо вылупится прямо сейчас',
        'ofx.pitch.x2income': 'Доход ×2 на 3 минуты', 'ofx.pitch.luckyEgg': 'Редкие яйца ×2 на 3 минуты',
        'ofx.pitch.goldenEgg': 'Следующее яйцо — минимум Золотое'
      },
      en: {
        'ofx.tp': 'Teleport home', 'ofx.tpShort': 'Home', 'ofx.forAd': 'Watch ad', 'ofx.in': 'In {0}',
        'ofx.noAds': 'No ads now', 'ofx.busy': 'Ad…', 'ofx.chest': 'Chest',
        'ofx.chestIn': 'The chest is ready in {0}', 'ofx.chestTitle': 'Chest reward!', 'ofx.take': 'Collect',
        'ofx.newItem': 'New item: {0}', 'ofx.newItemHint': 'Equip it in the shop', 'ofx.boostFor': 'for {0}',
        'ofx.trialChip': 'Trial raid: {0} left', 'ofx.trialRound': 'Trial raid: bring the egg home!',
        'ofx.tripleDone': '×3 collected!', 'ofx.cashPrize': 'Bag of cash',
        'ofx.pitch.dragonSleep': 'Dragons stay asleep for 45 s', 'ofx.pitch.dragonShield': 'Get caught — keep the egg',
        'ofx.pitch.teleportHome': 'Warp home with the egg', 'ofx.pitch.trialRaid': 'The gate opens for one raid',
        'ofx.pitch.lairDiscount': 'Lairs 30% cheaper', 'ofx.pitch.turboTrain': 'Training ×3 for 3 minutes',
        'ofx.pitch.freeHatchery': 'A new hatchery for free', 'ofx.pitch.instantHatch': 'Hatch an egg right now',
        'ofx.pitch.x2income': 'Income ×2 for 3 minutes', 'ofx.pitch.luckyEgg': 'Rare eggs ×2 for 3 minutes',
        'ofx.pitch.goldenEgg': 'Next egg is at least Golden'
      },
      tr: {
        'ofx.tp': 'Eve ışınlan', 'ofx.tpShort': 'Eve', 'ofx.forAd': 'Reklam izle', 'ofx.in': '{0} sonra',
        'ofx.noAds': 'Reklam yok', 'ofx.busy': 'Reklam…', 'ofx.chest': 'Sandık',
        'ofx.chestIn': 'Sandık {0} sonra hazır', 'ofx.chestTitle': 'Sandık ödülü!', 'ofx.take': 'Al',
        'ofx.newItem': 'Yeni eşya: {0}', 'ofx.newItemHint': 'Mağazada giyebilirsin', 'ofx.boostFor': '{0} boyunca',
        'ofx.trialChip': 'Deneme baskını: {0} kaldı', 'ofx.trialRound': 'Deneme baskını: yumurtayı üsse götür!',
        'ofx.tripleDone': '×3 alındı!', 'ofx.cashPrize': 'Para çuvalı',
        'ofx.pitch.dragonSleep': 'Ejderhalar 45 sn uyanmaz', 'ofx.pitch.dragonShield': 'Yakalansan da yumurta sende',
        'ofx.pitch.teleportHome': 'Yumurtayla anında eve', 'ofx.pitch.trialRaid': 'Kapı tek baskın için açılır',
        'ofx.pitch.lairDiscount': 'İnler %30 daha ucuz', 'ofx.pitch.turboTrain': '3 dakika ×3 antrenman',
        'ofx.pitch.freeHatchery': 'Bedava yeni kuluçka', 'ofx.pitch.instantHatch': 'Yumurta hemen çatlasın',
        'ofx.pitch.x2income': '3 dakika gelir ×2', 'ofx.pitch.luckyEgg': '3 dakika nadir yumurta ×2',
        'ofx.pitch.goldenEgg': 'Sonraki yumurta en az Altın'
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* helpers                                                                 */
  /* ---------------------------------------------------------------------- */
  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function has(k) { return !!(SE.I18N && SE.I18N.has && SE.I18N.has(k)); }
  function $(id) { return doc.getElementById(id); }
  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }
  function setText(node, s) { if (node && node.textContent !== s) node.textContent = s; }
  function icon(name, cls) { return SE.UI && SE.UI.icon ? SE.UI.icon(name, cls) : ''; }
  function nowMs() { return Date.now(); }
  function clock(sec) {
    sec = Math.max(0, Math.ceil(sec || 0));
    if (SE.I18N && SE.I18N.clock) return SE.I18N.clock(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function money(n) { return SE.UI && SE.UI.money ? SE.UI.money(n) : '$' + Math.floor(n || 0); }
  function fmt(n) { return SE.UI && SE.UI.fmt ? SE.UI.fmt(n) : String(Math.floor(n || 0)); }
  function play(k, o) { try { if (SE.Audio && SE.Audio.play) SE.Audio.play(k, o || {}); } catch (e) { /* optional */ } }
  function toast(s, type, opts) { try { if (SE.UI && SE.UI.toast) SE.UI.toast(s, type || 'info', opts); } catch (e) { /* optional */ } }
  function tutActive() {
    try { return !!(SE.Tutorial && SE.Tutorial.isActive && SE.Tutorial.isActive()); } catch (e) { return false; }
  }
  function adsOff() { return !!(SE.Config && SE.Config.ADS === false) || !SE.Ads; }
  function A() { return SE.Ads; }
  function G() { return SE.Game && SE.Game.booted ? SE.Game : null; }
  function tutorialDone() { var d = SE.State && SE.State.data; return !!(d && d.tutorialDone); }
  function panelOpen() { try { return !!(SE.UI && SE.UI.isOpen && SE.UI.isOpen()); } catch (e) { return false; } }
  function chased() {
    if (doc.body && doc.body.classList.contains('chased')) return true;
    try { return !!(SE.DragonAI && SE.DragonAI.anyChasing && SE.DragonAI.anyChasing('player')); } catch (e) { return false; }
  }
  function offerIcon(id) { var o = A() && A().get ? A().get(id) : null; return o && o.icon ? o.icon : 'watch-video'; }
  function title(id) { return A() && A().title ? A().title(id) : id; }
  /* 'ready' | 'busy' | 'cd' | 'off' for one offer */
  function adState(id) {
    var a = A();
    if (!a || !a.canShow()) return 'off';
    if (a.busy || a.interstitialBusy) return 'busy';
    return a.cooldownLeft(id) > 0 ? 'cd' : 'ready';
  }
  function stateLine(id, st) {
    if (st === 'off') return t('ofx.noAds');
    if (st === 'busy') return t('ofx.busy');
    if (st === 'cd') return t('ofx.in', clock(A().cooldownLeft(id)));
    return t('ofx.forAd');
  }
  function reasonText(id, st) {
    if (st === 'off') return t('ads.unavailable');
    if (st === 'cd') return t('ads.cooldown', Math.ceil(A().cooldownLeft(id)));
    return '';
  }

  /* inline SVG chest (lid is a separate group so it can open) */
  var CHEST_SVG = '<svg class="ofx-chest-svg" viewBox="0 0 64 58" aria-hidden="true">' +
    '<g class="ch-glow"><ellipse cx="32" cy="26" rx="22" ry="9" fill="#fff3b0"/></g>' +
    '<g class="ch-body">' +
    '<rect x="6" y="27" width="52" height="27" rx="4" fill="#a7652a" stroke="#2a1407" stroke-width="3"/>' +
    '<rect x="8.5" y="29" width="47" height="6" fill="#7a4216"/>' +
    '<path d="M10 42h44" stroke="#7a4216" stroke-width="2"/>' +
    '<rect x="12" y="27" width="7" height="27" fill="#f5bf2a" stroke="#2a1407" stroke-width="2.4"/>' +
    '<rect x="45" y="27" width="7" height="27" fill="#f5bf2a" stroke="#2a1407" stroke-width="2.4"/>' +
    '</g>' +
    '<g class="ch-lid">' +
    '<path d="M6 28V19C6 9 16 5 32 5s26 4 26 14v9z" fill="#c07a34" stroke="#2a1407" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M10 17c2-6 9-8.5 22-8.5" stroke="#e7a964" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
    '<path d="M12 28V14.2c0-2.6 2.2-4.6 7-5.6V28z" fill="#f5bf2a" stroke="#2a1407" stroke-width="2.4" stroke-linejoin="round"/>' +
    '<path d="M52 28V14.2c0-2.6-2.2-4.6-7-5.6V28z" fill="#f5bf2a" stroke="#2a1407" stroke-width="2.4" stroke-linejoin="round"/>' +
    '</g>' +
    '<g class="ch-lock"><rect x="26.5" y="22.5" width="11" height="13" rx="2.4" fill="#ffd34d" stroke="#2a1407" stroke-width="2.6"/>' +
    '<circle cx="32" cy="28.2" r="1.9" fill="#2a1407"/><path d="M32 29.5v3" stroke="#2a1407" stroke-width="1.8" stroke-linecap="round"/></g>' +
    '</svg>';

  /* ---------------------------------------------------------------------- */
  /* state                                                                   */
  /* ---------------------------------------------------------------------- */
  var inited = false;
  var hudRoot = null;
  var tp = { el: null, st: '', busy: false, vis: false, txt: null, sub: null };
  var chips = { chest: null, golden: null, trial: null };
  var bub = { el: null, visible: false, id: null, ctx: null, reason: null, shownAt: 0, lastAt: -1e12, readySince: 0, snooze: {} };
  var rv = { el: null, open: false, timer: null };
  var resultObs = null;

  /* ---------------------------------------------------------------------- */
  /* teleport button                                                         */
  /* ---------------------------------------------------------------------- */
  function buildTeleport() {
    var b = el('button', 'ofx-tp');
    b.type = 'button';
    b.id = 'ofxTeleport';
    b.hidden = true;
    b.innerHTML = '<span class="ofx-tp-ic">' + icon('pen-house') + '<i class="ofx-tp-egg">' + icon('egg') + '</i></span>' +
      '<span class="ofx-tp-txt"><b class="ofx-tp-t"><span class="lbl-long"></span><span class="lbl-short"></span></b>' +
      '<small class="ofx-tp-s"><span class="ofx-play">' + icon('svg/play') + '</span><span class="ofx-tp-st"></span></small></span>' +
      '<i class="spinner sm"></i>';
    tp.el = b;
    tp.txt = b.querySelector('.ofx-tp-t');
    tp.sub = b.querySelector('.ofx-tp-st');
    var last = 0;
    b.addEventListener('click', function () {
      var tm = nowMs();
      if (tm - last < 500 || tp.busy) return;
      last = tm;
      var st = adState('teleportHome');
      if (st !== 'ready') { play('error'); toast(reasonText('teleportHome', st) || t('ads.unavailable'), 'info'); return; }
      if (!A().available('teleportHome', {})) { play('error'); toast(t('ads.notNow'), 'info'); return; }
      play('click');
      tp.busy = true;
      updateTeleport(true);
      A().claim('teleportHome', {}, function () { tp.busy = false; updateTeleport(true); });
    });
    return b;
  }
  function updateTeleport(force) {
    var g = G(), b = tp.el;
    if (!b) return;
    var vis = !!(g && !adsOff() && !tutActive() && g.carrying && !g.carryDelivered && !g.atBase());
    vis = vis || tp.busy;
    if (vis !== tp.vis) {
      tp.vis = vis;
      b.hidden = !vis;
      if (vis) { b.classList.remove('in'); void b.offsetWidth; b.classList.add('in'); }
    }
    if (!vis && !force) return;
    var st = tp.busy ? 'busy' : adState('teleportHome');
    setText(b.querySelector('.lbl-long'), t('ofx.tp'));
    setText(b.querySelector('.lbl-short'), t('ofx.tpShort'));
    setText(tp.sub, stateLine('teleportHome', st));
    if (st !== tp.st) {
      tp.st = st;
      b.classList.toggle('is-busy', st === 'busy');
      b.classList.toggle('is-off', st === 'off' || st === 'cd');
      b.setAttribute('aria-disabled', st === 'ready' ? 'false' : 'true');
    }
    var far = !!(g && SE.World && typeof SE.World.safeLineZ === 'number' && SE.Player && SE.World.safeLineZ - SE.Player.pos.z > 120);
    b.classList.toggle('attn-tp', st === 'ready' && (far || chased()));
    var reason = reasonText('teleportHome', st);
    b.title = t('offer.teleportHome.d') + (reason ? ' — ' + reason : '');
    b.setAttribute('aria-label', t('ofx.tp') + ' · ' + stateLine('teleportHome', st));
  }

  /* ---------------------------------------------------------------------- */
  /* chips in #boostList                                                     */
  /* ---------------------------------------------------------------------- */
  function makeChip(cls, inner, onClick) {
    var n = el('button', 'bst ofx-chip ' + cls, inner);
    n.type = 'button';
    n.hidden = true;
    var last = 0;
    n.addEventListener('click', function () {
      var tm = nowMs();
      if (tm - last < 350) return;
      last = tm;
      onClick(n);
    });
    return n;
  }
  function buildChips() {
    chips.chest = makeChip('ofx-chest', '<span class="bst-ic ofx-chest-ic">' + CHEST_SVG + '</span><span class="badge badge-rw ofx-chest-badge">▶</span><b class="bst-t"></b>', function () {
      var st = adState('freeChest');
      if (st === 'ready' && SE.Game && SE.Game.offer && SE.Game.offer('freeChest', {})) { play('click'); return; }
      play('error');
      if (st === 'cd') toast(t('ofx.chestIn', clock(A().cooldownLeft('freeChest'))), 'info');
      else if (st === 'off') toast(t('ads.unavailable'), 'info');
    });
    chips.golden = makeChip('ofx-golden', '<span class="bst-ic">' + icon('star') + '</span><span class="bst-tag">★</span><b class="bst-t">×1</b>', function () {
      play('click');
      toast(t('offer.goldenEgg.d'), 'good', { icon: 'star' });
    });
    chips.trial = makeChip('ofx-trial', '<span class="bst-ic">' + icon('map') + '</span><b class="bst-t"></b>', function () {
      play('click');
      var g = G(), tr = g && g.trial;
      if (!tr) return;
      toast(tr.token ? t('ofx.trialRound') : t('ofx.trialChip', clock((tr.endAt - nowMs()) / 1000)), 'info', { icon: 'map' });
    });
  }
  function mountChips() {
    var box = $('boostList');
    if (!box) return;
    /* first children = right end of the row (row-reverse): chest, golden, trial */
    [chips.trial, chips.golden].forEach(function (c) {
      if (c && c.parentNode !== box) box.insertBefore(c, box.firstChild);
    });
    /* the chest: in the boost row on landscape screens; on tall screens (phones / tablets in
       portrait) the row is short and shares its height with the hint, so the chest goes under
       the Boosts button at the end of the right column instead */
    var col = $('hudRight'), tall = global.innerHeight > global.innerWidth;
    var want = tall && col ? col : box, c = chips.chest;
    if (!c) return;
    if (want === box) { if (c.parentNode !== box || box.firstChild !== c) box.insertBefore(c, box.firstChild); }
    else if (c.parentNode !== col) col.appendChild(c);
    c.classList.toggle('in-col', want === col);
  }
  function showChip(n, on) {
    if (!n) return;
    if (n.hidden === !on) return;
    n.hidden = !on;
    if (on) { n.classList.remove('out'); n.style.animation = 'none'; void n.offsetWidth; n.style.animation = ''; }
  }
  function updateChips() {
    mountChips();
    var g = G(), a = A();
    var base = !!(g && !tutActive() && tutorialDone());
    /* chest */
    var c = chips.chest;
    if (c) {
      var showC = base && !adsOff();
      showChip(c, showC);
      if (showC) {
        var st = adState('freeChest');
        c.classList.toggle('is-ready', st === 'ready');
        c.classList.toggle('is-off', st === 'off');
        c.classList.toggle('is-cd', st === 'cd' || st === 'busy');
        setText(c.querySelector('.bst-t'), st === 'cd' ? clock(a.cooldownLeft('freeChest')) : (st === 'off' ? '—' : t('ofx.chest')));
        var tt = title('freeChest') + ' — ' + (st === 'ready' ? t('ofx.forAd') : (st === 'cd' ? t('ofx.chestIn', clock(a.cooldownLeft('freeChest'))) : t('ads.unavailable')));
        if (c.title !== tt) { c.title = tt; c.setAttribute('aria-label', tt); }
      }
    }
    /* golden egg charge */
    var gd = chips.golden;
    if (gd) {
      var showG = base && !!(g && g.goldenPending && g.goldenPending());
      showChip(gd, showG);
      if (showG && gd.title !== title('goldenEgg')) { gd.title = title('goldenEgg'); gd.setAttribute('aria-label', title('goldenEgg')); }
    }
    /* trial raid */
    var tc = chips.trial;
    if (tc) {
      var tr = g && g.trial;
      var showT = !!(tr && !tr.done && !tr.expired) || !!(tr && tr.token && g.carrying);
      showChip(tc, showT && !tutActive());
      if (showT) {
        var left = Math.max(0, (tr.endAt - nowMs()) / 1000);
        setText(tc.querySelector('.bst-t'), tr.token ? '…' : clock(left));
        tc.classList.toggle('low', !tr.token && left <= 20);
        if (tc.title !== title('trialRaid')) { tc.title = title('trialRaid'); tc.setAttribute('aria-label', title('trialRaid')); }
      }
    }
  }

  /* ---------------------------------------------------------------------- */
  /* offer bubble                                                            */
  /* ---------------------------------------------------------------------- */
  function buildBubble() {
    var b = el('div', 'ofx-bubble');
    b.id = 'ofxBubble';
    b.hidden = true;
    b.setAttribute('role', 'status');
    b.innerHTML = '<button type="button" class="ofx-bb-main"><span class="ofx-bb-ic"></span>' +
      '<b class="ofx-bb-t"></b><small class="ofx-bb-d"></small>' +
      '<span class="ofx-bb-ad"><span class="ofx-play">' + icon('svg/play') + '</span><span class="ofx-bb-adl"></span></span></button>' +
      '<button type="button" class="ofx-bb-x">' + icon('svg/close') + '</button><i class="ofx-bb-bar"></i>';
    b.querySelector('.ofx-bb-main').addEventListener('click', function () {
      var id = bub.id, ctx = bub.ctx;
      hideBubble(false);
      if (!id) return;
      play('click');
      var ok = SE.Game && SE.Game.offer ? SE.Game.offer(id, ctx || {}) : false;
      if (!ok) toast(reasonText(id, adState(id)) || t('ads.notNow'), 'info');
    });
    b.querySelector('.ofx-bb-x').addEventListener('click', function () {
      play('close', { volume: 0.6 });
      if (bub.id) bub.snooze[bub.id] = nowMs() + SNOOZE * 1000;
      hideBubble(false);
    });
    bub.el = b;
    return b;
  }
  function bubbleAllowed() {
    var g = G(), a = A();
    if (!g || !a || adsOff() || !a.canShow() || tutActive() || !tutorialDone()) return false;
    if (panelOpen() || g.paused || chased() || doc.hidden) return false;
    if (doc.body && doc.body.classList.contains('hud-off')) return false;
    if (rv.open) return false;
    return true;
  }
  /* HUD boxes the bubble must never cover (with a small margin) */
  var OBSTACLES = '#hudTL > *, #hudLeft > *, #hudRight > *, #hudRight .badge, #hudRight .hs-count, #hudStats .st-speed, #hudStats .st-cash, ' +
    '#hudStats .st-chip, #boostList > *, #zoneBanner.show .zb-txt, #zoneBanner.show .zb-emo, #hint.show, #toasts .toast, #alarm.show span, ' +
    '#mobile > :not(.gone), #ofxTeleport, #tutLayer .tut-card';
  function obstacles() {
    var out = [], list = doc.querySelectorAll(OBSTACLES);
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.hidden || n.offsetParent === null && n.id !== 'ofxTeleport') continue;
      var cs = global.getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      var r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ l: r.left - 6, t: r.top - 6, r: r.right + 6, b: r.bottom + 10 });   /* + the 3D bottom edge */
    }
    return out;
  }
  function hits(obs, l, t, r, bt) {
    for (var i = 0; i < obs.length; i++) { var o = obs[i]; if (l < o.r && r > o.l && t < o.b && bt > o.t) return true; }
    return false;
  }
  function placeBubble() {
    var b = bub.el;
    if (!b || b.hidden) return;
    var vw = global.innerWidth, vh = global.innerHeight;
    var portrait = vw <= 600 && vh >= 521, short = vh <= 520;
    var compact = portrait || short;
    b.classList.toggle('compact', compact);
    b.style.left = ''; b.style.right = ''; b.style.top = ''; b.style.width = '';
    var r = SE.UI && SE.UI.hudRect ? SE.UI.hudRect('btnBoosts') : null;
    var obs = obstacles();
    /* the box (+ the ✕ that pokes 11 px out of the top-right corner) */
    var fits = function (l, t, w, h) { return l >= 8 && t >= 8 && l + w <= vw - 8 && t + h <= vh - 8 && !hits(obs, l - 2, t - 12, l + w + 12, t + h); };
    /* desktop / tablets: next to the Boosts button with the arrow, when that spot is free */
    if (!compact && r && r.width) {
      var bh = b.offsetHeight || 64, bw = b.offsetWidth || 280;
      var rightPx = Math.round(vw - r.left + 14), left = vw - rightPx - bw;
      var top = Math.max(8, Math.min(vh - bh - 8, r.top + r.height / 2 - bh / 2));
      if (left >= 8 && !hits(obs, left, top - 2, left + bw, top + bh)) {
        b.style.right = rightPx + 'px';
        b.style.top = Math.round(top) + 'px';
        var ay = Math.round(r.top + r.height / 2 - top);
        b.style.setProperty('--arrow-y', ay + 'px');
        b.classList.toggle('arrow', ay > 14 && ay < bh - 14);
        return;
      }
    }
    b.classList.remove('arrow');
    /* everywhere else: the first free spot, scanning down from the top, right next to the right HUD column
       first (where the offers live), then next to the left column; narrower cards when the window is small */
    var col = $('hudRight'), cr = col ? col.getBoundingClientRect() : null;
    var lc = $('hudLeft'), lr = lc ? lc.getBoundingClientRect() : null;
    var colLeft = cr && cr.width ? cr.left - 16 : vw - 80;
    var leftEdge = lr && lr.width ? lr.right + 14 : 8;
    var widths = compact ? [238, 210, 180, 156] : [296, 260, 230];
    b.classList.remove('mini', 'no-room');
    /* small windows: a second pass without the description line (the "mini" card) */
    for (var pass = 0; pass < (compact ? 2 : 1); pass++) {
      b.classList.toggle('mini', pass === 1);
      for (var k = 0; k < widths.length; k++) {
        var w = Math.min(widths[k], vw - 16);
        b.style.width = w + 'px';
        var h = b.offsetHeight || 80;
        var xs = [Math.round(colLeft - w), Math.round(leftEdge)];
        for (var y = 8; y + h <= vh - 8; y += 6) {
          for (var j = 0; j < xs.length; j++) {
            var x = xs[j];
            if (x < 8 || x + w > colLeft + 1) continue;
            if (fits(x, y, w, h)) { b.style.left = x + 'px'; b.style.top = y + 'px'; return; }
          }
        }
      }
    }
    /* nothing free (tiny window with everything on screen at once): the optional bubble waits, invisible,
       instead of covering the HUD (re-checked every tick while its offer is valid) */
    b.classList.remove('mini');
    b.classList.add('no-room');
  }
  function showBubble(c) {
    var b = bub.el, a = A();
    if (!b || !c) return;
    bub.id = c.id; bub.ctx = c.ctx || {}; bub.reason = c.reason || ''; bub.lostAt = 0;
    bub.visible = true;
    bub.shownAt = nowMs();
    bub.lastAt = bub.shownAt;
    b.setAttribute('data-offer', c.id);
    b.setAttribute('data-reason', bub.reason);
    b.querySelector('.ofx-bb-ic').innerHTML = icon(offerIcon(c.id));
    setText(b.querySelector('.ofx-bb-t'), title(c.id));
    setText(b.querySelector('.ofx-bb-d'), has('ofx.pitch.' + c.id) ? t('ofx.pitch.' + c.id) : (a.desc ? a.desc(c.id, bub.ctx) : ''));
    setText(b.querySelector('.ofx-bb-adl'), t('ofx.forAd'));
    b.querySelector('.ofx-bb-x').setAttribute('aria-label', t('btn.close'));
    b.querySelector('.ofx-bb-main').setAttribute('aria-label', title(c.id) + ' — ' + (a.desc ? a.desc(c.id, bub.ctx) : '') + ' · ' + t('ofx.forAd'));
    b.style.setProperty('--life', BUBBLE_LIFE + 's');
    b.hidden = false;
    b.classList.remove('out', 'in');
    placeBubble();
    void b.offsetWidth;
    b.classList.add('in');
    play('pop', { volume: 0.5 });
  }
  function hideBubble(animated) {
    var b = bub.el;
    bub.visible = false;
    bub.id = null;
    if (!b || b.hidden) return;
    if (animated === false) { b.hidden = true; b.classList.remove('in', 'out'); return; }
    b.classList.remove('in');
    b.classList.add('out');
    setTimeout(function () { if (!bub.visible) { b.hidden = true; b.classList.remove('out'); } }, 220);
  }
  function tickBubble() {
    var a = A(), tm = nowMs();
    if (bub.visible) {
      var stale = !bubbleAllowed() || !a.ready(bub.id) || !a.available(bub.id, bub.ctx || {}) || tm - bub.shownAt > BUBBLE_LIFE * 1000;
      /* the situation is over (left the lair / the gate / the treadmill …): fade out after a short grace */
      if (!stale && bub.reason && bub.reason !== 'idle') {
        var c0 = null;
        try { c0 = SE.Game.contextOffer ? SE.Game.contextOffer() : null; } catch (e) { c0 = null; }
        if (c0 && c0.id === bub.id) bub.lostAt = 0;
        else if (!bub.lostAt) bub.lostAt = tm;
        else if (tm - bub.lostAt > 2500) stale = true;
      }
      if (stale) hideBubble(true);
      else placeBubble();                              // follows HUD changes (teleport button, rotation)
      return;
    }
    if (!bubbleAllowed()) return;
    if (!bub.readySince) { bub.readySince = tm; return; }
    if (tm - bub.readySince < FIRST_DELAY * 1000 || tm - bub.lastAt < BUBBLE_GAP * 1000) return;
    var c = null;
    try { c = SE.Game.contextOffer ? SE.Game.contextOffer() : null; } catch (e) { c = null; }
    if (!c || (bub.snooze[c.id] && bub.snooze[c.id] > tm)) return;
    showBubble(c);
  }

  /* ---------------------------------------------------------------------- */
  /* chest reveal                                                            */
  /* ---------------------------------------------------------------------- */
  function buildReveal() {
    var r = el('div', 'ofx-reveal');
    r.id = 'ofxReveal';
    r.hidden = true;
    r.setAttribute('role', 'dialog');
    r.setAttribute('aria-modal', 'true');
    r.innerHTML = '<div class="ofx-rv-card"><div class="ofx-rv-ribbon"></div>' +
      '<div class="ofx-rv-stage"><span class="ofx-rv-rays"></span><span class="ofx-rv-chest">' + CHEST_SVG + '</span><span class="ofx-rv-prize"></span></div>' +
      '<div class="ofx-rv-name"></div><div class="ofx-rv-sub"></div><div class="ofx-rv-foot"></div></div>';
    r.addEventListener('click', function (e) { if (e.target === r && r.classList.contains('opened')) closeReveal(); });
    rv.el = r;
    return r;
  }
  function prizeView(res) {
    var a = A(), D = SE.I18N;
    switch (res && res.kind) {
      case 'gems':
        return { icon: 'render/gems-pile', name: '+' + (D && D.plural ? D.plural(res.amount, 'cur.gemsUnit') : res.amount + ' 💎'), sub: '' };
      case 'cash':
        return { icon: 'cash-bonus', name: '+' + money(res.amount), sub: t('ofx.cashPrize') };
      case 'boost': {
        var dur = D && D.duration ? D.duration(res.secs, { short: true }) : Math.round(res.secs / 60) + ' min';
        return { icon: offerIcon(res.id), name: title(res.id), sub: t('ofx.boostFor', dur) };
      }
      case 'item':
        return { icon: 'star', name: t('ofx.newItem', res.name || res.id), sub: t('ofx.newItemHint'), item: res.id };
      default:
        return { icon: 'gift', name: a ? title('freeChest') : '', sub: '' };
    }
  }
  function chestReveal(res, tries) {
    var r = rv.el;
    if (!r || !res) return;
    /* the prize is already granted; wait until the ad and the offer dialog are gone */
    tries = tries || 0;
    if (tries < 40 && ((A() && A().busy) || panelOpen())) { setTimeout(function () { chestReveal(res, tries + 1); }, 150); return; }
    var v = prizeView(res);
    clearTimeout(rv.timer);
    r.classList.remove('opened', 'shake', 'out');
    r.setAttribute('data-kind', res.kind || '');
    setText(r.querySelector('.ofx-rv-ribbon'), t('ofx.chestTitle'));
    var prize = r.querySelector('.ofx-rv-prize');
    prize.innerHTML = icon(v.icon, 'ofx-rv-ic');
    if (v.item && SE.Cosmetics && typeof SE.Cosmetics.thumbnail === 'function') {
      try {
        Promise.resolve(SE.Cosmetics.thumbnail(v.item, 192)).then(function (u) {
          if (u && rv.open) prize.innerHTML = '<img class="ofx-rv-thumb" alt="" src="' + u + '">';
        }, function () {});
      } catch (e) { /* keep the star */ }
    }
    setText(r.querySelector('.ofx-rv-name'), v.name);
    setText(r.querySelector('.ofx-rv-sub'), v.sub);
    var foot = r.querySelector('.ofx-rv-foot');
    foot.innerHTML = '';
    if (SE.UI && SE.UI.btn) foot.appendChild(SE.UI.btn(t('ofx.take'), 'green big ofx-rv-ok', function () { closeReveal(); }));
    r.hidden = false;
    rv.open = true;
    hideBubble(false);
    if (SE.Game && SE.Game.setPaused) SE.Game.setPaused(true, 'ui');       // soft pause: the world waits, the HUD stays
    if (SE.Input && SE.Input.reset) { try { SE.Input.reset(); } catch (e) { /* ignore */ } }
    void r.offsetWidth;
    r.classList.add('shake');
    play('pop', { volume: 0.7 });
    rv.timer = setTimeout(function () {
      r.classList.remove('shake');
      r.classList.add('opened');
      play('gift_open');
      play(res.kind === 'gems' ? 'gem' : (res.kind === 'cash' ? 'coin' : 'reward'), { delay: 0.15 });
      if (SE.RewardFX && SE.RewardFX.burst) {
        try {
          var st = r.querySelector('.ofx-rv-stage'), card = r.querySelector('.ofx-rv-card');
          var sr = st.getBoundingClientRect(), cr = card.getBoundingClientRect();
          SE.RewardFX.burst(card, { x: sr.left - cr.left + sr.width / 2, y: sr.top - cr.top + sr.height / 2, count: res.kind === 'item' ? 110 : 70 });
        } catch (e) { /* optional */ }
      }
      var ok = r.querySelector('.ofx-rv-ok');
      if (ok && SE.UI && SE.UI.inputMode && SE.UI.inputMode() === 'kbd') { try { ok.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      rv.timer = setTimeout(closeReveal, 6500);
    }, 750);
    if (SE.UI && SE.UI.updateHUD) SE.UI.updateHUD();
  }
  function closeReveal() {
    var r = rv.el;
    if (!r || !rv.open) return;
    clearTimeout(rv.timer);
    rv.open = false;
    r.classList.add('out');
    setTimeout(function () { if (!rv.open) { r.hidden = true; r.classList.remove('out', 'opened', 'shake'); } }, 220);
    if (!panelOpen() && SE.Game && SE.Game.setPaused) SE.Game.setPaused(false, 'ui');
    if (SE.UI && SE.UI.updateHUD) SE.UI.updateHUD();
  }

  /* ---------------------------------------------------------------------- */
  /* result panel: extra offers (tripleReward)                               */
  /* ---------------------------------------------------------------------- */
  var claimedTokens = {};
  function decorateResult() {
    var p = SE.UI && SE.UI.panel;
    if (!p || p.id !== 'result' || !p.body || !p.el.isConnected) return;
    var data = p.data || {};
    if (!data.win) return;
    if (p.win.querySelector('.ofx-res')) return;
    var root = p.body.querySelector('.res-root') || p.body;
    var after = root.querySelector('.res-rewards') || root.querySelector('.res-name');
    /* short landscape (800×360): the body has no room for another row — a footer button next to «Далее» */
    var short = global.innerHeight <= 520 && p.foot;
    if (data.round && claimedTokens[data.round]) {
      var done = el(short ? 'span' : 'div', 'res-note ofx-res ofx-res-done');
      done.textContent = '✓ ' + t('ofx.tripleDone');
      if (short) p.foot.insertBefore(done, p.foot.firstChild); else insertAfter(root, done, after);
      return;
    }
    var list = [];
    try { list = SE.Game && SE.Game.resultOffers ? SE.Game.resultOffers(data) : (data.offers || []); } catch (e) { list = []; }
    list.forEach(function (o) {
      if (!o || !o.placement || p.win.querySelector('[data-rw="' + o.placement + '"]')) return;
      if (short) {
        var fb = SE.UI.adButton({
          placement: o.placement, ctx: o.ctx, cls: 'gold ofx-res ofx-res-foot', icon: o.icon || offerIcon(o.id),
          label: (o.title || title(o.id)) + ' · ' + t('ofx.forAd'),
          reward: '+' + money(o.extraCash || 0) + ' · +' + fmt(o.extraGems || 0) + ' 💎',
          onDone: function (ok) { if (ok) afterTriple(p, data, o); }
        });
        fb.title = o.text || '';
        p.foot.insertBefore(fb, p.foot.firstChild);
        p.foot.hidden = false;
        return;
      }
      var row = el('div', 'res-offer ofx-res ofx-res-' + o.id);
      row.appendChild(el('span', 'res-offer-ic', icon(o.icon || offerIcon(o.id))));
      var tx = el('div', 'res-offer-t');
      var b = el('b'); b.textContent = o.title || title(o.id);
      var s = el('span'); s.textContent = o.text || (A().desc ? A().desc(o.id, o.ctx) : '');
      tx.appendChild(b); tx.appendChild(s);
      row.appendChild(tx);
      var btn = SE.UI.adButton({
        placement: o.placement, ctx: o.ctx, cls: 'gold small', labelKey: 'btn.watchAd',
        onDone: function (ok) { if (ok) afterTriple(p, data, o); }
      });
      row.appendChild(btn);
      insertAfter(root, row, after);
    });
  }
  function insertAfter(root, node, ref) {
    if (ref && ref.parentNode === root) root.insertBefore(node, ref.nextSibling);
    else root.appendChild(node);
  }
  function afterTriple(p, data, o) {
    var k = A() && A().REWARD ? A().REWARD.tripleMult : 3;
    if (data.round) claimedTokens[data.round] = true;
    /* the panel's data object is reused by its own re-render: show the new totals there too */
    if (typeof data.cash === 'number') data.cash = (o.ctx.cash || 0) * k;
    if (typeof data.gems === 'number') data.gems = (o.ctx.gems || 0) * k;
    if (!p.el.isConnected) return;
    var K = SE.PanelKit;
    var nums = p.body.querySelectorAll('.res-rewards .pk-num');
    if (nums[0] && K && K.countUp) K.countUp(nums[0], data.cash, 800, K.fmt || fmt);
    if (nums[1] && K && K.countUp) K.countUp(nums[1], data.gems, 800, K.fmt || fmt);
    var rw = p.body.querySelector('.res-rewards');
    if (rw) { rw.classList.remove('ofx-bump'); void rw.offsetWidth; rw.classList.add('ofx-bump'); }
    var row = p.win.querySelector('.ofx-res');
    if (row) {
      var done = el(row.parentNode === p.foot ? 'span' : 'div', 'res-note ofx-res ofx-res-done');
      done.textContent = '✓ ' + t('ofx.tripleDone');
      row.parentNode.replaceChild(done, row);
    }
    if (SE.RewardFX && SE.RewardFX.burst && rw) {
      try {
        var wr = p.win.getBoundingClientRect(), rr = rw.getBoundingClientRect();
        SE.RewardFX.burst(p.win, { x: rr.left - wr.left + rr.width / 2, y: rr.top - wr.top + rr.height / 2, count: 60 });
      } catch (e) { /* optional */ }
    }
  }
  function watchResult(type, id) {
    if (id !== 'result') return;
    if (resultObs) { resultObs.disconnect(); resultObs = null; }
    if (type !== 'open') return;
    var p = SE.UI && SE.UI.panel;
    if (!p || p.id !== 'result') return;
    decorateResult();
    if (global.MutationObserver) {
      resultObs = new MutationObserver(function () { if (!p.win.querySelector('.ofx-res')) decorateResult(); });
      resultObs.observe(p.body, { childList: true, subtree: false });
      if (p.foot) resultObs.observe(p.foot, { childList: true, subtree: false });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* init + loop                                                             */
  /* ---------------------------------------------------------------------- */
  function tick() {
    if (!inited) return;
    try {
      updateTeleport(false);
      updateChips();
      tickBubble();
      if (rv.open && (tutActive())) closeReveal();
    } catch (e) { console.error('[OffersUI] tick failed', e); }
  }

  function init() {
    if (inited) return true;
    var ui = $('ui');
    if (!ui || !SE.UI || !SE.UI.on) return false;
    inited = true;
    hudRoot = ui;
    var before = $('toasts') || null;
    ui.insertBefore(buildTeleport(), before);
    ui.insertBefore(buildBubble(), before);
    buildChips();
    mountChips();
    var host = doc.body;
    host.appendChild(buildReveal());
    if (SE.Icons && SE.Icons.mount) { try { SE.Icons.mount(ui); } catch (e) { /* optional */ } }
    SE.UI.on(watchResult);
    global.addEventListener('resize', function () { placeBubble(); });
    global.addEventListener('keydown', function (e) {
      if (!rv.open) return;
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        if (rv.el.classList.contains('opened')) closeReveal();
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
    if (SE.I18N && SE.I18N.onChange) SE.I18N.onChange(function () { tp.st = ''; updateTeleport(true); updateChips(); });
    setInterval(tick, TICK_MS);
    tick();
    return true;
  }

  SE.OffersUI = {
    BUBBLE_GAP: BUBBLE_GAP, FIRST_DELAY: FIRST_DELAY, BUBBLE_LIFE: BUBBLE_LIFE,
    init: init,
    chestReveal: chestReveal,
    closeReveal: closeReveal,
    bubbleState: function () { return { visible: bub.visible, id: bub.id, reason: bub.reason, lastAt: bub.lastAt }; },
    /* QA: drop the first-delay / gap timers so the next tick may show a bubble */
    forceBubble: function () {
      var keep = { readySince: bub.readySince, lastAt: bub.lastAt };
      hideBubble(false);
      bub.readySince = 1; bub.lastAt = -1e12; bub.snooze = {};
      tickBubble();
      if (!bub.visible) { bub.readySince = keep.readySince; bub.lastAt = keep.lastAt; }   // nothing shown: timers unchanged
      return this.bubbleState();
    },
    hideBubble: function () { hideBubble(false); },
    revealOpen: function () { return rv.open; }
  };

  function boot() {
    if (init()) return;
    var tries = 0;
    var iv = setInterval(function () { if (init() || ++tries > 400) clearInterval(iv); }, 50);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
})(window);
