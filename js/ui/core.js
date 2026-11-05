/* =========================================================================
   Steal a Dragon Egg — UI framework + HUD (SE.UI)          SPEC §7 SE.UI, §10

   DOM lives in index.html (#ui HUD, #toasts, #modals, #mobile, #pause, #rwWait,
   #loading). Styles: css/base.css (tokens, buttons, chips, overlays, loading),
   css/hud.css (HUD layout, responsive), css/panels.css (panel chrome + kit).

   Core API (SPEC §7)
     init(game)                         binds HUD buttons, Esc/back, input mode; idempotent
     registerPanel(id, def)             def = { titleKey, icon, size:'s'|'m'|'l', render(body, data, panel),
                                          onOpen(data, panel), onClose(panel), refresh(body, data, panel)?,
                                          tabs?, cls?, flush? (no body padding), closable? (default true),
                                          backdropClose? (default true), pause? (default true) }
     open(id, data) -> panel|null       one main panel at a time (opening another replaces it);
                                        open('confirm', opts) → confirm layer (see confirm)
     close([id]) -> bool                closes the main panel (only if it is `id`, when given)
     isOpen([id]) -> bool ; current (getter: id|null) ; refresh([id])
     toast(text, type:'good'|'error'|'info'|'gem'|'cash'[, { icon, ms }])
     setHint(text | { kbd, touch } | ''[, { key:'E', icon }])   '[E]' inside text → key cap
     updateHUD()                        money/gems/speed (count-up), income, egg & dragon counts, badges
     updateBoosts()                     SE.Boosts.list() chips with icons + m:ss
     setZoneBanner(zone|null)           zone = { key, color, emoji, name? } (key: i18n key or id)
     showAlarm(on) ; setThreat(0..1)    RUN! + red edge vignette
     showAdWait(on)
     adButton({ placement, labelKey|label, onGranted, onDone, ctx, reward, cls, icon }) -> HTMLElement
         rewarded via SE.Ads.rewarded(placement, onGranted, onDone) when onGranted is given, otherwise
         SE.Ads.claim(placement, ctx, onDone) (offer ids). Live state: cooldown "in 0:45", unavailable
         (aria-disabled + tooltip; a tap explains it with a toast), spinner while the ad runs,
         double-click guard. Hidden when SE.Config.ADS === false.
     btn(text, cls, onClick[, { icon, html, sound, title }]) -> <button class="ui-btn …">
         cls: green | blue | gold | red | purple | orange | grey | big | small | wide
     icon(name, cls) -> html            SE.Icons keys: 'shop', 'render/gem', 'concept/egg-amber', 'svg/close'
   Extras
     confirm({ title, text, icon, yes, no, danger, onYes, onNo }) -> Promise<bool>
     chip(kind:'cash'|'gems'|'speed'|'income', value[, cls]) -> html
     floatText(text, x, y[, cls]) | floatText(text, worldPos:Vector3[, cls])   "+$120" popups
         cls: 'cash' | 'gem' | 'speed' | 'bad' | 'good'
     fmt(n) -> '1.25K' ; money(n) -> '$1.25K'
     showPause(on) ; togglePause()      #pause overlay (Continue / How to play / Settings)
     setMobile(on)                      legacy: forces touch / keyboard mode
     setAction({ icon, label } | null)  mobile action button look (null → dimmed)
     setAction2(visible)                mobile sell-all button
     setHUDVisible(on)                  hides HUD widgets (tutorial cut-ins, result screens)
     highlight(hudId, on)               attention pulse on a HUD button (#btnShop …)
     hudRect(hudId) -> DOMRect|null     for tutorial pointers
     on(fn(type, id)) / off(fn)         'open' | 'close' panel events (also window 'sade-ui')
     inputMode() -> 'kbd' | 'touch'     body has class kbd | touch
     loading.progress(0..1[, stage]) / .stage(keyOrText) / .error(keyOrText, onRetry) / .hide() -> Promise
     panels (registry), PANEL_SIZES

   Panel object passed to render/onOpen:
     { id, def, data, el (modal root), win (.panel), body, tabs, foot, titleEl,
       setTitle(text), setTabs([{ id, label, icon, color, count }], activeId, onSelect(id)), setTab(id),
       setFooter(node|[nodes]|null), close(), refresh() }

   HUD element ids: btnMenu, btnSettings, btnLeaders, btnShop(+shopBadge), btnIndex(+indexBadge),
     slowSwitch, btnWheel(+wheelBadge), btnDaily(+dailyBadge), btnEggs(+eggCount, eggsBadge),
     btnDragons(+dragonCount), btnBoosts(+boostsBadge), statSpeed, statMoney, statGems, statIncome,
     boostList, zoneBanner, hint, alarm, vignette, floaters, toasts, modals,
     mobile: joystick, joyKnob, btnAction, btnAction2, btnJump.
   Game hooks used (all optional): game.setPaused(on, reason) — 'ui' for panels, 'manual' for the
     pause menu; game.slowMode / game.setSlowMode(on); game.camera (floatText world positions).
   Strings: hud.*, ui.*, pause.* (ru/en/tr).
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var doc = global.document;

  /* ---------------------------------------------------------------------- */
  /* Strings                                                                 */
  /* ---------------------------------------------------------------------- */
  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: {
        'hud.menu': 'Меню', 'hud.settings': 'Настройки', 'hud.records': 'Рекорды',
        'hud.shop': 'Магазин', 'hud.index': 'Индекс', 'hud.slow': 'Медленно',
        'hud.wheel': 'Колесо', 'hud.daily': 'Подарок', 'hud.eggs': 'Яйца', 'hud.dragons': 'Драконы',
        'hud.boosts': 'Бусты', 'hud.speed': 'Скорость', 'hud.income': 'Доход в секунду',
        'hud.run': 'БЕГИ!', 'hud.action': 'Действие', 'hud.jump': 'Прыжок', 'hud.sellAll': 'Продать всех',
        'hud.zone.base': 'Твоя база', 'hud.zone.passage': 'Долина драконов',
        'hud.slowOn': 'Медленный режим включён', 'hud.slowOff': 'Медленный режим выключен',
        'pause.title': 'Пауза', 'pause.resume': 'Продолжить', 'pause.howto': 'Как играть', 'pause.settings': 'Настройки',
        'ui.adWait': 'Реклама загружается…', 'ui.adUnavailable': 'Реклама сейчас недоступна, попробуй позже',
        'ui.adCooldown': 'Снова через {0}', 'ui.adBusy': 'Смотрим рекламу…', 'ui.soon': 'Скоро будет!',
        'ui.confirm': 'Точно?', 'ui.new': 'NEW', 'ui.free': 'Бесплатно'
      },
      en: {
        'hud.menu': 'Menu', 'hud.settings': 'Settings', 'hud.records': 'Records',
        'hud.shop': 'Shop', 'hud.index': 'Index', 'hud.slow': 'Slow Mode',
        'hud.wheel': 'Wheel', 'hud.daily': 'Gift', 'hud.eggs': 'Eggs', 'hud.dragons': 'Dragons',
        'hud.boosts': 'Boosts', 'hud.speed': 'Speed', 'hud.income': 'Income per second',
        'hud.run': 'RUN!', 'hud.action': 'Action', 'hud.jump': 'Jump', 'hud.sellAll': 'Sell all',
        'hud.zone.base': 'Your Base', 'hud.zone.passage': 'Dragon Valley',
        'hud.slowOn': 'Slow mode on', 'hud.slowOff': 'Slow mode off',
        'pause.title': 'Paused', 'pause.resume': 'Continue', 'pause.howto': 'How to play', 'pause.settings': 'Settings',
        'ui.adWait': 'Loading the ad…', 'ui.adUnavailable': 'No ad available right now, try later',
        'ui.adCooldown': 'Again in {0}', 'ui.adBusy': 'Watching the ad…', 'ui.soon': 'Coming soon!',
        'ui.confirm': 'Are you sure?', 'ui.new': 'NEW', 'ui.free': 'Free'
      },
      tr: {
        'hud.menu': 'Menü', 'hud.settings': 'Ayarlar', 'hud.records': 'Rekorlar',
        'hud.shop': 'Mağaza', 'hud.index': 'Dizin', 'hud.slow': 'Yavaş Mod',
        'hud.wheel': 'Çark', 'hud.daily': 'Hediye', 'hud.eggs': 'Yumurtalar', 'hud.dragons': 'Ejderhalar',
        'hud.boosts': 'Güçler', 'hud.speed': 'Hız', 'hud.income': 'Saniye başı gelir',
        'hud.run': 'KAÇ!', 'hud.action': 'Eylem', 'hud.jump': 'Zıpla', 'hud.sellAll': 'Hepsini sat',
        'hud.zone.base': 'Üssün', 'hud.zone.passage': 'Ejderha Vadisi',
        'hud.slowOn': 'Yavaş mod açık', 'hud.slowOff': 'Yavaş mod kapalı',
        'pause.title': 'Duraklatıldı', 'pause.resume': 'Devam et', 'pause.howto': 'Nasıl oynanır', 'pause.settings': 'Ayarlar',
        'ui.adWait': 'Reklam yükleniyor…', 'ui.adUnavailable': 'Şu anda reklam yok, sonra dene',
        'ui.adCooldown': '{0} sonra tekrar', 'ui.adBusy': 'Reklam izleniyor…', 'ui.soon': 'Yakında!',
        'ui.confirm': 'Emin misin?', 'ui.new': 'YENİ', 'ui.free': 'Ücretsiz'
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Helpers                                                                 */
  /* ---------------------------------------------------------------------- */
  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function has(key) { return !!(SE.I18N && SE.I18N.has && SE.I18N.has(key)); }
  function tr(keyOrText) { return keyOrText && has(keyOrText) ? t(keyOrText) : (keyOrText == null ? '' : String(keyOrText)); }
  function $(id) { return doc.getElementById(id); }
  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nowMs() { return global.performance && performance.now ? performance.now() : Date.now(); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function play(key, opts) {
    try { if (SE.Audio && typeof SE.Audio.play === 'function') SE.Audio.play(key, opts || {}); } catch (e) { /* optional */ }
  }
  function call(obj, fn) {
    if (!obj || typeof obj[fn] !== 'function') return undefined;
    try { return obj[fn].apply(obj, Array.prototype.slice.call(arguments, 2)); } catch (e) { console.error('[UI] ' + fn + ' failed', e); return undefined; }
  }
  function iconHtml(name, cls) {
    if (!name) return '';
    if (SE.Icons && SE.Icons.html) return SE.Icons.html(name, { cls: cls || '' });
    return '<span class="ic ' + (cls || '') + '"><img src="assets/ui/' + esc(name) + '.png" alt=""></span>';
  }
  function setText(node, s) { if (node && node.textContent !== s) node.textContent = s; }
  function show(node, on) { if (node && node.hidden === !!on) node.hidden = !on; }

  var SUF = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp'];
  function fmt(n) {
    n = Number(n) || 0;
    var neg = n < 0;
    n = Math.abs(n);
    var s;
    if (n < 1000) s = n < 10 && n % 1 ? (Math.floor(n * 10) / 10).toString() : String(Math.floor(n));
    else {
      var i = 0;
      while (n >= 1000 && i < SUF.length - 1) { n /= 1000; i++; }
      var v = n >= 100 ? Math.floor(n) : (n >= 10 ? Math.floor(n * 10) / 10 : Math.floor(n * 100) / 100);
      s = String(v) + SUF[i];
    }
    return (neg ? '-' : '') + s;
  }
  function money(n) { return '$' + fmt(n); }
  function clock(sec) {
    sec = Math.max(0, Math.ceil(sec || 0));
    if (SE.I18N && SE.I18N.clock) return SE.I18N.clock(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* ---------------------------------------------------------------------- */
  /* State                                                                   */
  /* ---------------------------------------------------------------------- */
  var UI = {
    game: null,
    panels: {},
    PANEL_SIZES: ['s', 'm', 'l'],
    inited: false
  };
  var cur = null;            // open main panel object
  var confirmCur = null;     // open confirm layer
  var listeners = [];
  var hud = {};              // element cache
  var hintRaw = null, hintOpts = null, hintHtml = '';
  var zoneCur = null, zoneKey = null;
  var badgeAt = 0;
  var pauseShown = false, pauseReturn = false;
  var mode = 'kbd';

  function emit(type, id) {
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](type, id); } catch (e) { console.error(e); } }
    try { global.dispatchEvent(new CustomEvent('sade-ui', { detail: { type: type, id: id } })); } catch (e) { /* old browsers */ }
  }
  function game() { return UI.game || SE.Game || null; }
  function setPaused(on, reason) {
    var g = game();
    if (g && typeof g.setPaused === 'function') { try { g.setPaused(on, reason); } catch (e) { console.error(e); } }
  }

  /* ---------------------------------------------------------------------- */
  /* Input mode (kbd / touch) — mirrors SE.Input (player.js) on <body>       */
  /* ---------------------------------------------------------------------- */
  function applyMode(m) {
    if (m !== 'touch' && m !== 'kbd') return;
    mode = m;
    if (!doc.body) return;
    doc.body.classList.toggle('touch', m === 'touch');
    doc.body.classList.toggle('kbd', m === 'kbd');
    if (hintRaw !== null) renderHint(true);
  }
  function detectMode() {
    var attr = doc.documentElement.getAttribute('data-input');
    if (attr === 'touch' || attr === 'kbd') return attr;
    if (SE.Input && SE.Input.mode) return SE.Input.mode;
    if (SE.Platform && SE.Platform.isMobile) return 'touch';
    try { if (global.matchMedia && matchMedia('(pointer: coarse)').matches) return 'touch'; } catch (e) { /* ignore */ }
    return 'kbd';
  }
  global.addEventListener('sade-input-mode', function (e) { applyMode(e.detail && e.detail.mode); });

  /* ---------------------------------------------------------------------- */
  /* Buttons, icons, chips                                                   */
  /* ---------------------------------------------------------------------- */
  function btn(text, cls, onClick, opts) {
    opts = opts || {};
    var b = el('button', 'ui-btn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    var inner = (opts.icon ? iconHtml(opts.icon, 'btn-ic') : '') +
      (text !== undefined && text !== null && text !== '' ? '<span class="btn-lbl">' + (opts.html ? text : esc(text)) + '</span>' : '');
    b.innerHTML = inner;
    if (opts.title) b.title = opts.title;
    var last = 0;
    b.addEventListener('click', function (ev) {
      var tm = nowMs();
      if (tm - last < 350) { ev.preventDefault(); return; }    // double-click guard
      last = tm;
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') return;
      if (opts.sound !== false) play(opts.sound || 'click');
      if (typeof onClick === 'function') onClick(ev, b);
    });
    return b;
  }

  function chip(kind, value, cls) {
    var ic = { cash: 'svg/cash', gems: 'render/gem', speed: 'shoe', income: 'svg/cash' }[kind] || 'svg/cash';
    var txt = kind === 'cash' ? money(value) : (kind === 'income' ? '+' + money(value) + t('time.perSec') : fmt(value));
    return '<span class="chip chip-' + kind + (cls ? ' ' + cls : '') + '">' + iconHtml(ic, 'chip-ic') + '<b>' + esc(txt) + '</b></span>';
  }

  /* ---------------------------------------------------------------------- */
  /* Rewarded ad button                                                      */
  /* ---------------------------------------------------------------------- */
  function adsOn() { return !(SE.Config && SE.Config.ADS === false); }
  function adReady(id) {
    if (SE.Ads && typeof SE.Ads.ready === 'function') { try { return !!SE.Ads.ready(id); } catch (e) { return false; } }
    return !!(SE.Platform && typeof SE.Platform.canRewarded === 'function' && SE.Platform.canRewarded());
  }
  function adCooldown(id) {
    if (SE.Ads && typeof SE.Ads.cooldownLeft === 'function') { try { return SE.Ads.cooldownLeft(id) || 0; } catch (e) { return 0; } }
    return 0;
  }
  function isOffer(id) { return !!(SE.Ads && typeof SE.Ads.get === 'function' && SE.Ads.get(id)); }

  function adButton(o) {
    o = o || {};
    var placement = o.placement || 'reward';
    var b = el('button', 'ui-btn rw-btn ' + (o.cls || 'purple'));
    b.type = 'button';
    b.setAttribute('data-rw', placement);
    var label = o.label || t(o.labelKey || 'btn.watchAd');
    b.innerHTML = '<span class="rw-ic">' + iconHtml(o.icon || 'watch-video', 'btn-ic') + '<i class="spinner sm"></i></span>' +
      '<span class="rw-txt"><span class="btn-lbl">' + esc(label) + '</span>' +
      (o.reward ? '<small class="rw-reward">' + (o.rewardHtml ? o.reward : esc(o.reward)) + '</small>' : '') +
      '<small class="rw-state"></small></span>';
    var busy = false, reason = '';

    function update() {
      if (!b.isConnected && b._adBound) return;
      if (!adsOn()) { b.hidden = true; return; }
      var cd = adCooldown(placement);
      var ready = !busy && adReady(placement);
      var stateTxt = '';
      if (busy) { reason = t('ui.adBusy'); }
      else if (cd > 0) { reason = t('ui.adCooldown', clock(cd)); stateTxt = clock(cd); }
      else if (!ready) { reason = t('ui.adUnavailable'); stateTxt = ''; }
      else reason = '';
      var off = busy || !ready;
      b.classList.toggle('is-busy', busy);
      b.classList.toggle('is-off', off && !busy);
      b.classList.toggle('is-cd', cd > 0 && !busy);
      b.setAttribute('aria-disabled', off ? 'true' : 'false');
      if (reason) b.title = reason; else b.removeAttribute('title');
      var st = b.querySelector('.rw-state');
      setText(st, stateTxt);
    }
    b._adUpdate = update;
    b._adBound = true;
    var last = 0;
    b.addEventListener('click', function () {
      var tm = nowMs();
      if (tm - last < 500) return;
      last = tm;
      if (busy) return;
      update();
      if (b.getAttribute('aria-disabled') === 'true') {
        play('error');
        toast(reason || t('ui.adUnavailable'), 'info');
        return;
      }
      play('click');
      busy = true;
      update();
      var finished = false;
      function done(granted) {
        if (finished) return;
        finished = true;
        busy = false;
        update();
        if (typeof o.onDone === 'function') { try { o.onDone(!!granted); } catch (e) { console.error(e); } }
        updateHUD();
      }
      try {
        if (SE.Ads && typeof SE.Ads.rewarded === 'function' && (typeof o.onGranted === 'function' || !isOffer(placement) || typeof SE.Ads.claim !== 'function')) {
          SE.Ads.rewarded(placement, function () { if (typeof o.onGranted === 'function') o.onGranted(o.ctx); }, done);
        } else if (SE.Ads && typeof SE.Ads.claim === 'function') {
          SE.Ads.claim(placement, o.ctx || null, done);
        } else if (SE.Platform && typeof SE.Platform.showRewarded === 'function') {
          var got = false;
          SE.Platform.showRewarded(placement, function () { got = true; if (typeof o.onGranted === 'function') o.onGranted(o.ctx); }, function () { done(got); });
        } else { done(false); }
      } catch (e) { console.error('[UI] ad failed', e); done(false); }
    });
    update();
    return b;
  }
  function updateAdButtons(root) {
    var list = (root || doc).querySelectorAll('.rw-btn');
    for (var i = 0; i < list.length; i++) if (list[i]._adUpdate) list[i]._adUpdate();
  }

  /* ---------------------------------------------------------------------- */
  /* Toasts                                                                  */
  /* ---------------------------------------------------------------------- */
  var TOAST_ICON = { good: 'svg/check', error: 'svg/close', info: 'svg/info', gem: 'render/gem', cash: 'svg/cash' };
  function toast(text, type, opts) {
    var box = hud.toasts || $('toasts');
    if (!box || text === undefined || text === null || text === '') return null;
    opts = opts || {};
    type = type || 'info';
    text = String(text);
    var kids = box.children;
    for (var i = 0; i < kids.length; i++) {        // same text already visible → bump it
      if (kids[i]._text === text && !kids[i].classList.contains('out')) {
        kids[i].classList.remove('bump'); void kids[i].offsetWidth; kids[i].classList.add('bump');
        clearTimeout(kids[i]._timer);
        kids[i]._timer = setTimeout(dismiss.bind(null, kids[i]), opts.ms || 2600);
        return kids[i];
      }
    }
    var n = el('div', 'toast t-' + type, iconHtml(opts.icon || TOAST_ICON[type] || TOAST_ICON.info, 'toast-ic') + '<span class="toast-txt"></span>');
    n.querySelector('.toast-txt').textContent = text;
    n._text = text;
    n.setAttribute('role', type === 'error' ? 'alert' : 'status');
    box.appendChild(n);
    while (box.children.length > 3) dismiss(box.firstElementChild, true);
    n._timer = setTimeout(dismiss.bind(null, n), opts.ms || (type === 'error' ? 3000 : 2600));
    n.addEventListener('click', function () { dismiss(n); });
    syncToasting();
    return n;
  }
  function dismiss(n, now) {
    if (!n || !n.parentNode) return;
    clearTimeout(n._timer);
    if (now) { n.parentNode.removeChild(n); syncToasting(); return; }
    n.classList.add('out');
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); syncToasting(); }, 260);
  }
  /* body.toasting while a toast is up: on small screens the toast takes the hint's slot (css/hud.css) */
  function syncToasting() {
    var box = hud.toasts || $('toasts');
    if (doc.body) doc.body.classList.toggle('toasting', !!(box && box.querySelector('.toast')));
  }

  /* ---------------------------------------------------------------------- */
  /* Hint                                                                    */
  /* ---------------------------------------------------------------------- */
  function keycaps(html) {
    return html.replace(/\[([A-Za-zА-Яа-яЁё0-9 ]{1,8}|Space|Esc|Tab|Shift)\]/g, function (m, k) { return '<kbd>' + k + '</kbd>'; });
  }
  function renderHint(force) {
    var h = hud.hint;
    if (!h) return;
    var raw = hintRaw, opts = hintOpts || {};
    if (raw && typeof raw === 'object') raw = mode === 'touch' ? (raw.touch || raw.mobile || raw.kbd || raw.text || '') : (raw.kbd || raw.text || raw.touch || '');
    raw = raw ? String(raw) : '';
    var html = '';
    if (raw) {
      var body = keycaps(esc(raw));
      if (mode === 'touch') body = body.replace(/<kbd>[^<]*<\/kbd>\s*[—–-]?\s*/g, '');
      var lead = '';
      if (opts.icon) lead = iconHtml(opts.icon, 'hint-ic');
      else if (opts.key && mode !== 'touch') lead = '<kbd>' + esc(opts.key) + '</kbd>';
      else if (opts.key && mode === 'touch') lead = iconHtml('interact-hand', 'hint-ic');
      html = lead + '<span>' + body + '</span>';
    }
    if (!force && html === hintHtml) return;
    hintHtml = html;
    h.innerHTML = html;
    h.classList.toggle('show', !!html);
  }
  var hintSig = '';
  function setHint(text, opts) {
    var sig = (text && typeof text === 'object' ? JSON.stringify(text) : String(text || '')) + '|' + (opts ? JSON.stringify(opts) : '');
    if (sig === hintSig) return;               // called every frame by the game: cheap no-op
    hintSig = sig;
    hintRaw = text || '';
    hintOpts = opts || null;
    renderHint(false);
  }

  /* ---------------------------------------------------------------------- */
  /* HUD numbers with smooth count-up                                        */
  /* ---------------------------------------------------------------------- */
  var NUMS = {
    money: { id: 'statMoney', fmt: money, box: 'statMoneyBox' },
    gems: { id: 'statGems', fmt: fmt, box: 'statGemsBox' },
    speed: { id: 'statSpeed', fmt: function (v) { return String(Math.floor(v)); }, box: 'statSpeedBox' }
  };
  var tweening = false;
  function writeNum(n) {
    var s = n.fmt(n.cur);
    if (s !== n.last) { n.last = s; if (n.node) n.node.textContent = s; }
  }
  function setNum(key, value) {
    var n = NUMS[key];
    if (!n.node) { n.node = $(n.id); n.boxNode = $(n.box); }
    if (!n.node) return;
    value = Number(value) || 0;
    if (n.cur === undefined) { n.cur = n.to = value; writeNum(n); return; }
    if (value === n.to) return;
    var up = value > n.to;
    n.from = n.cur; n.to = value; n.t0 = nowMs();
    n.dur = up ? (key === 'speed' ? 300 : 700) : 260;
    if (up && n.boxNode && key !== 'speed' && value - n.from >= Math.max(1, n.from * 0.002)) {
      n.boxNode.classList.remove('bump'); void n.boxNode.offsetWidth; n.boxNode.classList.add('bump');
    }
    if (!tweening) { tweening = true; global.requestAnimationFrame(tweenFrame); }
  }
  function tweenFrame() {
    var tm = nowMs(), active = false;
    for (var k in NUMS) {
      var n = NUMS[k];
      if (n.cur === undefined || n.cur === n.to) continue;
      var p = clamp((tm - n.t0) / n.dur, 0, 1);
      var e = 1 - Math.pow(1 - p, 3);
      n.cur = p >= 1 ? n.to : n.from + (n.to - n.from) * e;
      writeNum(n);
      if (p < 1) active = true;
    }
    if (active) global.requestAnimationFrame(tweenFrame); else tweening = false;
  }

  function setBadge(node, value) {
    if (!node) return;
    var on = !!value;
    show(node, on);
    if (on) setText(node, value === true ? '!' : (typeof value === 'number' && value > 99 ? '99+' : String(value)));
  }
  function setCount(node, n) { if (node) { setText(node, fmt(n)); node.classList.toggle('zero', !n); } }

  function updateBadges() {
    var d = SE.State && SE.State.data;
    var calm = !!(d && d.tutorialDone === false) || !!(SE.Tutorial && typeof SE.Tutorial.isActive === 'function' && SE.Tutorial.isActive());
    try { setBadge(hud.dailyBadge, !calm && !!(SE.Daily && typeof SE.Daily.canClaim === 'function' && SE.Daily.canClaim())); } catch (e) { /* optional */ }
    try { setBadge(hud.wheelBadge, !calm && !!(SE.Wheel && typeof SE.Wheel.freeAvailable === 'function' && SE.Wheel.freeAvailable())); } catch (e) { /* optional */ }
    try { setBadge(hud.indexBadge, SE.CollectionUI && typeof SE.CollectionUI.indexBadge === 'function' ? SE.CollectionUI.indexBadge() : 0); } catch (e) { /* optional */ }
    try { setBadge(hud.shopBadge, SE.ShopUI && typeof SE.ShopUI.newCount === 'function' && SE.ShopUI.newCount() > 0 ? t('ui.new') : 0); } catch (e) { /* optional */ }
    try {
      var any = false;
      if (!calm && adsOn() && SE.Ads && typeof SE.Ads.list === 'function') {
        var list = SE.Ads.list('panel') || [];
        for (var i = 0; i < list.length && !any; i++) any = adReady(list[i].id);
      }
      setBadge(hud.boostsBadge, any ? '▶' : 0);
    } catch (e) { /* optional */ }
    if (hud.btnLeaders) {
      var lb = false;
      try { lb = !!(SE.Platform && typeof SE.Platform.hasLeaderboard === 'function' && SE.Platform.hasLeaderboard()); } catch (e) { lb = false; }
      show(hud.btnLeaders, lb && !!UI.panels.leaders);
      /* the stats row starts after the visible round buttons (records adds a third one) */
      doc.documentElement.style.setProperty('--nround', lb && UI.panels.leaders ? '3' : '2');
    }
  }

  function updateHUD() {
    if (!hud.ready) cacheHud();
    if (doc.body && doc.body.classList.contains('is-loading')) {      // the game hid #loading itself
      var ld = $('loading');
      if (!ld || ld.hidden || ld.style.display === 'none' || ld.classList.contains('done') || ld.classList.contains('hide')) doc.body.classList.remove('is-loading');
    }
    var S = SE.State, d = S && S.data;
    if (!d) return;
    setNum('money', d.money);
    setNum('gems', d.gems);
    setNum('speed', d.speed);
    var inc = 0;
    try { inc = typeof S.incomePerSec === 'function' ? S.incomePerSec(SE.Boosts) : 0; } catch (e) { inc = 0; }
    setText(hud.statIncome, '+' + money(inc) + t('time.perSec'));
    var eggs = 0, ready = 0;
    var hs = d.hatcheries || [];
    for (var i = 0; i < hs.length; i++) {
      var h = hs[i];
      if (!h) continue;
      if (h.baby) { eggs++; ready++; }
      else if (h.egg) {
        eggs++;
        try { if (typeof S.isReady === 'function' && S.isReady(i)) ready++; } catch (e) { /* ignore */ }
      }
    }
    setCount(hud.eggCount, eggs);
    setBadge(hud.eggsBadge, ready);
    setCount(hud.dragonCount, (d.dragons || []).length);
    var g = game();
    if (g && hud.slowSwitch) {
      var slow = !!g.slowMode;
      hud.slowSwitch.classList.toggle('on', slow);
      hud.slowSwitch.setAttribute('aria-checked', slow ? 'true' : 'false');
    }
    var tm = nowMs();
    if (tm - badgeAt > 900) { badgeAt = tm; updateBadges(); }
    updateBoosts();
  }

  /* ---------------------------------------------------------------------- */
  /* Active boosts (bottom-right)                                            */
  /* ---------------------------------------------------------------------- */
  var BOOST_ICON = {
    x2income: 'money-bag', x2hatch: 'fast-hatch', speedBoost: 'lightning', luckyEgg: 'clover',
    dragonSleep: 'moon', magnet: 'magnet', doubleSell: 'banknotes', lairDiscount: 'map',
    revive: 'heart', invisible: 'ghost', shield: 'shield'
  };
  var BOOST_TAG = { x2income: '×2', x2hatch: '×2', speedBoost: '×2', doubleSell: '×2', luckyEgg: '×2', lairDiscount: '−30%' };
  var boostEls = {};
  function boostIcon(id) {
    var o = SE.Ads && typeof SE.Ads.get === 'function' ? SE.Ads.get(id) : null;
    return BOOST_ICON[id] || (o && o.icon) || 'sparkles';
  }
  function updateBoosts() {
    var box = hud.boostList;
    if (!box || !SE.Boosts || typeof SE.Boosts.list !== 'function') return;
    var list;
    try { list = SE.Boosts.list() || []; } catch (e) { list = []; }
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !b.id || !(b.left > 0)) continue;
      seen[b.id] = true;
      var n = boostEls[b.id];
      if (!n) {
        n = el('button', 'bst', iconHtml(boostIcon(b.id), 'bst-ic') +
          (BOOST_TAG[b.id] ? '<span class="bst-tag">' + BOOST_TAG[b.id] + '</span>' : '') + '<b class="bst-t"></b>');
        n.type = 'button';
        n.setAttribute('data-id', b.id);
        var title = has('offer.' + b.id + '.t') ? t('offer.' + b.id + '.t') : '';
        if (title) { n.title = title; n.setAttribute('aria-label', title); }
        n.addEventListener('click', function () { play('click'); openSafe('boosts'); });
        boostEls[b.id] = n;
        box.appendChild(n);
      }
      setText(n.lastChild, clock(b.left));
      n.classList.toggle('low', b.left <= 10);
    }
    for (var id in boostEls) {
      if (!seen[id]) {
        var old = boostEls[id];
        delete boostEls[id];
        old.classList.add('out');
        setTimeout(function (o) { return function () { if (o.parentNode) o.parentNode.removeChild(o); }; }(old), 250);
      }
    }
    /* the list clips what does not fit (css: overflow hidden, ≤ 2 rows); hide those timers whole instead of showing
       a cut-off icon (the Boosts panel lists every active boost) */
    var lr = box.getBoundingClientRect();
    for (var c = box.firstElementChild; c; c = c.nextElementSibling) {
      c.style.visibility = '';
      var r = c.getBoundingClientRect();
      if (r.width && lr.width && (r.left < lr.left - 1 || r.top < lr.top - 1 || r.right > lr.right + 1)) c.style.visibility = 'hidden';
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Zone banner, alarm, vignette, ad wait                                   */
  /* ---------------------------------------------------------------------- */
  function zoneName(z) {
    if (!z) return '';
    if (z.name) return String(z.name);
    var k = String(z.key || '');
    if (!k) return '';
    if (has(k)) return t(k);
    if (has('world.zone.' + k)) return t('world.zone.' + k);
    if (has('hud.zone.' + k)) return t('hud.zone.' + k);
    var DD = SE.DragonData;
    if (DD && typeof DD.lairName === 'function' && DD.species && (function () { try { return DD.species(k); } catch (e) { return null; } })()) {
      try { return DD.lairName(k); } catch (e) { /* fall through */ }
    }
    return k;
  }
  function setZoneBanner(zone) {
    var b = hud.zoneBanner;
    if (!b) return;
    var key = zone ? String(zone.key || zone.name || '') : '';
    if (key === zoneKey) { zoneCur = zone; return; }
    zoneKey = key;
    zoneCur = zone;
    if (!zone || !key) { b.classList.remove('show'); return; }
    b.classList.remove('show', 'swap');
    void b.offsetWidth;
    setText(hud.zoneText, zoneName(zone));
    setText(hud.zoneEmoji, zone.emoji || '');
    b.style.setProperty('--zone-c', zone.color || '#ffd34d');
    b.classList.add('show', 'swap');
    fitZone();
  }
  /* the zone name always fits the banner (whose max-width respects the HUD columns): the font steps down to
     13 px before anything could be cut (long names, small windows, every language) */
  function fitZone() {
    var tx = hud.zoneText;
    if (!tx || !tx.textContent) return;
    tx.style.fontSize = '';
    if (!tx.clientWidth) return;
    var fs = parseFloat(global.getComputedStyle(tx).fontSize) || 21;
    while (tx.scrollWidth > tx.clientWidth + 1 && fs > 13) { fs -= 1; tx.style.fontSize = fs + 'px'; }
  }
  global.addEventListener('resize', function () { if (hud.ready) fitZone(); });
  function showAlarm(on) {
    on = !!on;
    if (hud.alarm) hud.alarm.classList.toggle('show', on);
    if (hud.vignette) hud.vignette.classList.toggle('on', on);
    if (doc.body) doc.body.classList.toggle('chased', on);
    if (!on) setThreat(0);
  }
  function setThreat(v) {
    if (hud.vignette) hud.vignette.style.setProperty('--threat', String(clamp(Number(v) || 0, 0, 1).toFixed(2)));
  }
  function showAdWait(on) {
    var w = $('rwWait');
    if (w) w.classList.toggle('show', !!on);
  }

  /* ---------------------------------------------------------------------- */
  /* Floating texts                                                          */
  /* ---------------------------------------------------------------------- */
  var tmpV = null;
  function floatText(text, x, y, cls) {
    var box = hud.floaters || $('floaters');
    if (!box) return;
    if (x && typeof x === 'object') {
      cls = y;
      var g = game(), cam = g && (g.camera || (g.cam && g.cam.camera));
      if (!cam || !global.THREE) return;
      tmpV = tmpV || new global.THREE.Vector3();
      tmpV.set(x.x, x.y, x.z).project(cam);
      if (tmpV.z > 1 || tmpV.z < -1) return;
      x = (tmpV.x * 0.5 + 0.5) * global.innerWidth;
      y = (-tmpV.y * 0.5 + 0.5) * global.innerHeight;
    }
    if (box.children.length > 24) box.removeChild(box.firstChild);
    var n = el('div', 'float-txt ' + (cls || 'cash'));
    n.textContent = String(text);
    n.style.left = Math.round(x) + 'px';
    n.style.top = Math.round(y) + 'px';
    n.style.setProperty('--dx', ((Math.random() - 0.5) * 40).toFixed(0) + 'px');
    box.appendChild(n);
    setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 1400);
  }

  /* ---------------------------------------------------------------------- */
  /* Panels                                                                  */
  /* ---------------------------------------------------------------------- */
  function registerPanel(id, def) {
    if (!id || !def) return;
    UI.panels[id] = def;
    if (id === 'leaders') badgeAt = 0;
  }

  function buildPanel(id, def, data) {
    var size = UI.PANEL_SIZES.indexOf(def.size) >= 0 ? def.size : 'm';
    var root = el('div', 'modal');
    root.setAttribute('data-panel', id);
    var win = el('section', 'panel panel-' + size + ' panel-' + id + (def.cls ? ' ' + def.cls : '') + (def.flush ? ' flush' : ''));
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-modal', 'true');
    win.setAttribute('aria-labelledby', 'ptitle-' + id);
    win.innerHTML =
      '<i class="rivet r1"></i><i class="rivet r2"></i><i class="rivet r3"></i><i class="rivet r4"></i>' +
      '<header class="panel-head"><div class="panel-ribbon"><span class="pr-ic"></span><h2 class="pr-title" id="ptitle-' + esc(id) + '"></h2></div></header>' +
      '<nav class="panel-tabs" hidden></nav>' +
      '<div class="panel-body"></div>' +
      '<footer class="panel-foot" hidden></footer>';
    var bg = el('div', 'modal-bg');
    root.appendChild(bg);
    root.appendChild(win);
    var p = {
      id: id, def: def, data: data, el: root, win: win,
      body: win.querySelector('.panel-body'),
      tabs: win.querySelector('.panel-tabs'),
      foot: win.querySelector('.panel-foot'),
      titleEl: win.querySelector('.pr-title'),
      iconEl: win.querySelector('.pr-ic'),
      tabCb: null,
      setTitle: function (s) { setText(p.titleEl, s == null ? '' : String(s)); fitTitle(p.win); },
      setIcon: function (name) { p.iconEl.innerHTML = name ? iconHtml(name) : ''; p.iconEl.hidden = !name; },
      setTabs: function (list, active, onSelect) { return setTabs(p, list, active, onSelect); },
      setTab: function (tid) { markTab(p, tid); },
      setFooter: function (nodes) {
        while (p.foot.firstChild) p.foot.removeChild(p.foot.firstChild);
        if (nodes) [].concat(nodes).forEach(function (n) { if (n) p.foot.appendChild(typeof n === 'string' ? el('span', '', n) : n); });
        p.foot.hidden = !p.foot.firstChild;
      },
      close: function () { if (cur === p) close(); },
      refresh: function () { if (cur === p) refresh(); }
    };
    p.setTitle(def.titleKey ? t(def.titleKey) : (def.title || ''));
    p.setIcon(def.icon || null);
    if (def.closable !== false) {
      var x = el('button', 'panel-close', iconHtml('svg/close'));
      x.type = 'button';
      x.setAttribute('aria-label', t('btn.close'));
      x.addEventListener('click', function () { play('close', { volume: 0.7 }); if (cur === p) close(); });
      win.appendChild(x);
      p.closeBtn = x;
    }
    bg.addEventListener('click', function () {
      if (cur === p && def.closable !== false && def.backdropClose !== false && !confirmCur) { play('close', { volume: 0.6 }); close(); }
    });
    if (Array.isArray(def.tabs)) p.setTabs(def.tabs, def.tabs[0] && def.tabs[0].id, def.onTab);
    return p;
  }

  function setTabs(p, list, active, onSelect) {
    var box = p.tabs;
    while (box.firstChild) box.removeChild(box.firstChild);
    p.tabCb = onSelect || null;
    (list || []).forEach(function (tb) {
      var b = el('button', 'gem-tab');
      b.type = 'button';
      b.setAttribute('data-tab', tb.id);
      b.setAttribute('role', 'tab');
      if (tb.color) b.style.setProperty('--tab-c', tb.color);
      b.innerHTML = '<span class="gt-face">' + (tb.icon ? iconHtml(tb.icon, 'gt-ic') : '') +
        '<span class="gt-lbl">' + esc(tb.label || (tb.labelKey ? t(tb.labelKey) : tb.id)) + '</span>' +
        (tb.count !== undefined && tb.count !== null ? '<small class="gt-count">' + esc(tb.count) + '</small>' : '') + '</span>' +
        (tb.badge ? '<span class="badge">' + esc(tb.badge === true ? '!' : tb.badge) + '</span>' : '');
      b.addEventListener('click', function () {
        if (b.classList.contains('on')) return;
        play('tab');
        markTab(p, tb.id);
        if (typeof p.tabCb === 'function') p.tabCb(tb.id);
      });
      box.appendChild(b);
    });
    box.hidden = !box.firstChild;
    box.setAttribute('role', 'tablist');
    markTab(p, active);
    return box;
  }
  function markTab(p, tid) {
    var kids = p.tabs.children;
    for (var i = 0; i < kids.length; i++) {
      var on = kids[i].getAttribute('data-tab') === String(tid);
      kids[i].classList.toggle('on', on);
      kids[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  /* the ribbon title always fits between the corners (close button): the font steps down to 15 px, then
     the title takes two lines (css .panel-ribbon.is-two) — long titles, narrow phones, every language */
  function fitTitle(win) {
    var tl = win && win.querySelector('.pr-title');
    if (!tl || !tl.isConnected) return;
    var rb = tl.parentNode;
    rb.classList.remove('is-two');
    tl.style.fontSize = '';
    if (!tl.textContent || !tl.clientWidth) return;
    var fs = parseFloat(global.getComputedStyle(tl).fontSize) || 20;
    while (tl.scrollWidth > tl.clientWidth + 1 && fs > 15) { fs -= 1; tl.style.fontSize = fs + 'px'; }
    if (tl.scrollWidth > tl.clientWidth + 1) { tl.style.fontSize = ''; rb.classList.add('is-two'); }
  }
  global.addEventListener('resize', function () {
    if (cur) fitTitle(cur.win);
    if (confirmCur && confirmCur.el) fitTitle(confirmCur.el.querySelector('.panel'));
  });

  function renderPanel(p) {
    var def = p.def;
    try { if (typeof def.render === 'function') def.render(p.body, p.data, p); }
    catch (e) {
      console.error('[UI] panel "' + p.id + '" render failed', e);
      p.body.appendChild(el('div', 'pn-empty', esc(t('loading.error.generic'))));
    }
  }

  function open(id, data) {
    if (id === 'confirm') { confirm(data || {}); return null; }
    if (id === 'pause' && !UI.panels.pause) { showPause(true); return null; }
    var def = UI.panels[id];
    if (!def) { console.warn('[UI] unknown panel "' + id + '"'); toast(t('ui.soon'), 'info'); return null; }
    if (!UI.inited) cacheHud();
    if (cur && cur.id === id) {                // same panel again: re-render with new data
      cur.data = data;
      while (cur.body.firstChild) cur.body.removeChild(cur.body.firstChild);
      renderPanel(cur);
      try { if (typeof def.onOpen === 'function') def.onOpen(data, cur); } catch (e) { console.error(e); }
      return cur;
    }
    if (cur) closeNow(cur, true);
    if (pauseShown) { showPause(false, true); pauseReturn = true; }
    var p = buildPanel(id, def, data);
    var host = hud.modals || $('modals') || doc.body;
    host.appendChild(p.el);
    cur = p;
    renderPanel(p);
    if (def.pause !== false) setPaused(true, 'ui');
    if (SE.Input && typeof SE.Input.reset === 'function') { try { SE.Input.reset(); } catch (e) { /* ignore */ } }
    if (doc.body) doc.body.classList.add('panel-open');
    void p.el.offsetWidth;
    p.el.classList.add('in');
    fitTitle(p.win);
    play('pop', { volume: 0.6 });
    try { if (typeof def.onOpen === 'function') def.onOpen(data, p); } catch (e) { console.error('[UI] onOpen "' + id + '" failed', e); }
    updateAdButtons(p.el);
    setTimeout(function () { if (cur === p && p.closeBtn && mode === 'kbd') { try { p.closeBtn.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }, 30);
    emit('open', id);
    return p;
  }

  function closeNow(p, swapping) {
    if (!p) return;
    if (cur === p) cur = null;
    try { if (typeof p.def.onClose === 'function') p.def.onClose(p); } catch (e) { console.error('[UI] onClose "' + p.id + '" failed', e); }
    var node = p.el;
    if (swapping) { if (node.parentNode) node.parentNode.removeChild(node); }
    else {
      node.classList.remove('in');
      node.classList.add('out');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 200);
    }
    emit('close', p.id);
  }

  function close(id) {
    if (!cur || (id && cur.id !== id)) return false;
    if (confirmCur) closeConfirm(false);
    var p = cur;
    closeNow(p, false);
    if (doc.body) doc.body.classList.remove('panel-open');
    if (p.def.pause !== false) setPaused(false, 'ui');
    if (pauseReturn) { pauseReturn = false; showPause(true, true); }   // back to the pause menu ('manual' still held)
    updateHUD();
    return true;
  }

  function refresh(id) {
    if (!cur || (id && cur.id !== id)) return;
    var def = cur.def;
    if (typeof def.refresh === 'function') { try { def.refresh(cur.body, cur.data, cur); } catch (e) { console.error(e); } return; }
    var keep = cur.body.scrollTop;
    while (cur.body.firstChild) cur.body.removeChild(cur.body.firstChild);
    renderPanel(cur);
    cur.body.scrollTop = keep;
    updateAdButtons(cur.el);
  }

  function openSafe(id, data) {
    if (UI.panels[id]) return open(id, data);
    toast(t('ui.soon'), 'info');
    return null;
  }

  /* ---------------------------------------------------------------------- */
  /* Confirm layer                                                           */
  /* ---------------------------------------------------------------------- */
  function confirm(o) {
    o = o || {};
    if (confirmCur) closeConfirm(false);
    return new Promise(function (resolve) {
      var root = el('div', 'modal confirm-layer');
      var win = el('section', 'panel panel-s panel-confirm');
      win.setAttribute('role', 'alertdialog');
      win.setAttribute('aria-modal', 'true');
      win.innerHTML = '<i class="rivet r1"></i><i class="rivet r2"></i><i class="rivet r3"></i><i class="rivet r4"></i>' +
        '<header class="panel-head"><div class="panel-ribbon' + (o.danger ? ' danger' : '') + '"><h2 class="pr-title"></h2></div></header>' +
        '<div class="panel-body"><div class="cf-box">' + (o.icon ? iconHtml(o.icon, 'cf-ic') : '') + '<p class="cf-text"></p></div></div>' +
        '<footer class="panel-foot cf-foot"></footer>';
      win.querySelector('.pr-title').textContent = o.title || t('ui.confirm');
      var tx = win.querySelector('.cf-text');
      if (o.html) tx.innerHTML = o.html; else tx.textContent = o.text || '';
      var foot = win.querySelector('.cf-foot');
      var c = { el: root, resolve: resolve, o: o };
      foot.appendChild(btn(o.no || t('btn.cancel'), 'grey', function () { closeConfirm(false); }));
      foot.appendChild(btn(o.yes || t('btn.yes'), o.danger ? 'red' : 'green', function () { closeConfirm(true); }));
      var bg = el('div', 'modal-bg');
      bg.addEventListener('click', function () { closeConfirm(false); });
      root.appendChild(bg);
      root.appendChild(win);
      (hud.modals || $('modals') || doc.body).appendChild(root);
      confirmCur = c;
      if (!cur) setPaused(true, 'ui');
      void root.offsetWidth;
      root.classList.add('in');
      fitTitle(win);
      play('pop', { volume: 0.5 });
    });
  }
  function closeConfirm(yes) {
    var c = confirmCur;
    if (!c) return;
    confirmCur = null;
    c.el.classList.remove('in');
    c.el.classList.add('out');
    setTimeout(function () { if (c.el.parentNode) c.el.parentNode.removeChild(c.el); }, 200);
    if (!cur && !pauseShown) setPaused(false, 'ui');
    try { if (yes && typeof c.o.onYes === 'function') c.o.onYes(); if (!yes && typeof c.o.onNo === 'function') c.o.onNo(); } catch (e) { console.error(e); }
    c.resolve(!!yes);
  }

  /* ---------------------------------------------------------------------- */
  /* Pause menu                                                              */
  /* ---------------------------------------------------------------------- */
  function showPause(on, internal) {
    var p = $('pause');
    if (!p) return;
    on = !!on;
    if (on && cur) return;                 // a panel is open: Esc closes it instead
    if (!on) pauseReturn = false;
    pauseShown = on;
    p.classList.toggle('show', on);
    if (!internal) setPaused(on, 'manual');
    if (on) {
      if (SE.Input && typeof SE.Input.reset === 'function') { try { SE.Input.reset(); } catch (e) { /* ignore */ } }
      setTimeout(function () { var b = $('btnResume'); if (b && pauseShown && mode === 'kbd') { try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }, 30);
    }
    emit(on ? 'open' : 'close', 'pause');
  }

  /* ---------------------------------------------------------------------- */
  /* Loading screen (usable before init)                                     */
  /* ---------------------------------------------------------------------- */
  var loading = {
    frac: 0, tipTimer: null, tipIdx: 0, hidden: false,
    progress: function (frac, stage) {
      frac = clamp(Number(frac) || 0, 0, 1);
      this.frac = Math.max(this.frac, frac);
      var pct = Math.round(this.frac * 100);
      var fill = $('loadFill'), bar = doc.querySelector('#loadBar > i'), txt = $('loadPct'), root = $('loading');
      if (fill) fill.style.height = (8 + this.frac * 92).toFixed(1) + '%';
      if (bar) bar.style.width = pct + '%';
      setText(txt, pct + '%');
      if (root) root.setAttribute('aria-valuenow', String(pct));
      if (stage) this.stage(stage);
      this.startTips();
    },
    stage: function (keyOrText) {
      var s = $('loadStage');
      if (!s) return;
      s.removeAttribute('data-i18n');
      if (keyOrText && has(keyOrText)) s.setAttribute('data-i18n', keyOrText);
      setText(s, tr(keyOrText));
    },
    error: function (keyOrText, onRetry) {
      var box = $('loadError'), txt = $('loadErrorText'), b = $('btnRetry'), root = $('loading');
      if (root) root.classList.add('failed');
      if (txt) txt.textContent = tr(keyOrText || 'loading.error.generic');
      if (box) box.hidden = false;
      if (b) {
        b.onclick = function () {
          if (box) box.hidden = true;
          if (root) root.classList.remove('failed');
          loading.stage('loading.retrying');
          if (typeof onRetry === 'function') onRetry(); else global.location.reload();
        };
      }
    },
    startTips: function () {
      if (this.tipTimer || this.hidden) return;
      var tip = $('loadTip');
      if (!tip) return;
      var self = this;
      var n = 0;
      while (has('loading.tip' + (n + 1))) n++;
      if (!n) return;
      this.tipIdx = Math.floor(Math.random() * n);
      function next() {
        self.tipIdx = (self.tipIdx + 1) % n;
        tip.classList.remove('show');
        setTimeout(function () { tip.textContent = t('loading.tip' + (self.tipIdx + 1)); tip.classList.add('show'); }, 220);
      }
      next();
      this.tipTimer = setInterval(next, 4800);
      /* the language may switch while loading (SDK answer): re-translate the visible tip at once */
      if (SE.I18N && SE.I18N.onChange) SE.I18N.onChange(function () { if (!self.hidden) tip.textContent = t('loading.tip' + (self.tipIdx + 1)); });
    },
    hide: function () {
      var root = $('loading');
      this.hidden = true;
      clearInterval(this.tipTimer);
      this.tipTimer = null;
      if (doc.body) doc.body.classList.remove('is-loading');
      return new Promise(function (resolve) {
        if (!root || root.style.display === 'none') { resolve(); return; }
        root.classList.add('done');
        setTimeout(function () { root.style.display = 'none'; resolve(); }, 450);
      });
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Misc HUD control                                                        */
  /* ---------------------------------------------------------------------- */
  function setAction(info) {
    var b = $('btnAction');
    if (!b) return;
    var ic = info && info.icon ? info.icon : 'interact-hand';
    if (b.getAttribute('data-icon') !== ic) {
      b.setAttribute('data-icon', ic);
      b.innerHTML = iconHtml(ic);
    }
    b.classList.toggle('idle', !info);
    if (info && info.label) b.setAttribute('aria-label', info.label);
  }
  function setAction2(visible) { var b = $('btnAction2'); if (b) b.classList.toggle('gone', !visible); }
  function setHUDVisible(on) { if (doc.body) doc.body.classList.toggle('hud-off', !on); }
  function highlight(id, on) { var b = $(id); if (b) b.classList.toggle('attn', on !== false); }
  function hudRect(id) { var b = $(id); return b ? b.getBoundingClientRect() : null; }

  function toggleSlow() {
    var g = game();
    if (!g) return;
    var on = !g.slowMode;
    if (typeof g.setSlowMode === 'function') g.setSlowMode(on); else g.slowMode = on;
    play('toggle');
    toast(t(on ? 'hud.slowOn' : 'hud.slowOff'), 'info', { icon: 'shoe', ms: 1400 });
    updateHUD();
  }

  /* ---------------------------------------------------------------------- */
  /* Init                                                                    */
  /* ---------------------------------------------------------------------- */
  var HUD_IDS = ['toasts', 'modals', 'hint', 'alarm', 'vignette', 'floaters', 'zoneBanner', 'zoneText', 'zoneEmoji',
    'boostList', 'statIncome', 'eggCount', 'dragonCount', 'eggsBadge', 'dailyBadge', 'wheelBadge', 'indexBadge',
    'shopBadge', 'boostsBadge', 'btnLeaders', 'slowSwitch'];
  function cacheHud() {
    for (var i = 0; i < HUD_IDS.length; i++) hud[HUD_IDS[i]] = $(HUD_IDS[i]);
    hud.ready = !!hud.modals;
  }

  function bindClick(id, fn) {
    var b = $(id);
    if (!b || b._bound) return;
    b._bound = true;
    var last = 0;
    b.addEventListener('click', function (ev) {
      var tm = nowMs();
      if (tm - last < 300) return;
      last = tm;
      fn(ev);
    });
  }

  function onKey(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    if (confirmCur) { closeConfirm(false); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (cur) {
      if (cur.def.closable !== false) { play('close', { volume: 0.6 }); close(); }
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (pauseShown) { showPause(false); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (doc.body && doc.body.classList.contains('is-loading')) return;
    if (SE.Tutorial && typeof SE.Tutorial.isActive === 'function' && SE.Tutorial.isActive()) return;
    showPause(true);
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function init(g) {
    if (g) UI.game = g;
    cacheHud();
    applyMode(detectMode());
    if (UI.inited) { updateHUD(); return UI; }
    UI.inited = true;
    if (SE.Icons && SE.Icons.mount) SE.Icons.mount(doc);
    if (SE.I18N && SE.I18N.apply) SE.I18N.apply(doc);

    bindClick('btnMenu', function () { play('click'); showPause(true); });
    bindClick('btnSettings', function () { play('click'); openSafe('settings'); });
    bindClick('btnLeaders', function () { play('click'); openSafe('leaders'); });
    bindClick('btnShop', function () { play('click'); openSafe('shop'); });
    bindClick('btnIndex', function () { play('click'); openSafe('index'); });
    bindClick('btnWheel', function () { play('click'); openSafe('wheel'); });
    bindClick('btnDaily', function () { play('click'); openSafe('daily'); });
    bindClick('btnEggs', function () { play('click'); openSafe('eggs'); });
    bindClick('btnDragons', function () { play('click'); openSafe('dragons'); });
    bindClick('btnBoosts', function () { play('click'); openSafe('boosts'); });
    bindClick('slowSwitch', toggleSlow);
    bindClick('btnResume', function () { play('click'); showPause(false); });
    bindClick('btnHowTo', function () {
      play('click');
      showPause(false);
      if (SE.Tutorial && typeof SE.Tutorial.start === 'function') { try { SE.Tutorial.start(true); } catch (e) { console.error(e); } }
    });
    bindClick('btnPauseSettings', function () { play('click'); openSafe('settings'); });
    var pz = $('pause');
    if (pz) pz.addEventListener('click', function (e) { if (e.target === pz) { play('click'); showPause(false); } });

    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener('contextmenu', function (e) { if (!(e.target && e.target.closest && e.target.closest('input,textarea'))) e.preventDefault(); });
    global.addEventListener('popstate', function () { if (cur && cur.def.closable !== false) close(); });

    if (SE.I18N && SE.I18N.onChange) SE.I18N.onChange(function () {
      if (SE.Icons && SE.Icons.refreshLabels) SE.Icons.refreshLabels(doc);
      if (zoneCur) { setText(hud.zoneText, zoneName(zoneCur)); }
      renderHint(true);
      if (cur && cur.def.titleKey) cur.setTitle(t(cur.def.titleKey));
      for (var id in boostEls) { if (has('offer.' + id + '.t')) boostEls[id].title = t('offer.' + id + '.t'); }
      badgeAt = 0;
      updateHUD();
    });

    setInterval(function () {
      if (doc.hidden) return;
      updateAdButtons(hud.modals || doc);
      if (!UI.game) updateBoosts();
    }, 1000);

    updateHUD();
    return UI;
  }

  /* ---------------------------------------------------------------------- */
  /* Public object                                                           */
  /* ---------------------------------------------------------------------- */
  UI.init = init;
  UI.registerPanel = registerPanel;
  UI.open = open;
  UI.close = close;
  UI.isOpen = function (id) { return id ? !!(cur && cur.id === id) || (id === 'pause' && pauseShown) || (id === 'confirm' && !!confirmCur) : !!cur || !!confirmCur; };
  UI.refresh = refresh;
  UI.toast = toast;
  UI.setHint = setHint;
  UI.updateHUD = updateHUD;
  UI.updateBoosts = updateBoosts;
  UI.updateBadges = function () { badgeAt = 0; updateBadges(); };
  UI.setZoneBanner = setZoneBanner;
  UI.fitZone = fitZone;
  UI.showAlarm = showAlarm;
  UI.setThreat = setThreat;
  UI.showAdWait = showAdWait;
  UI.adButton = adButton;
  UI.updateAdButtons = updateAdButtons;
  UI.btn = btn;
  UI.icon = iconHtml;
  UI.chip = chip;
  UI.confirm = confirm;
  UI.floatText = floatText;
  UI.fmt = fmt;
  UI.money = money;
  UI.clock = clock;
  UI.showPause = function (on) { showPause(on); };
  UI.togglePause = function () { showPause(!pauseShown); };
  UI.isPaused = function () { return pauseShown; };
  UI.setMobile = function (on) {
    var m = on ? 'touch' : 'kbd';
    if (SE.Input && typeof SE.Input.setMode === 'function') { try { SE.Input.setMode(m); } catch (e) { /* ignore */ } }
    applyMode(m);
  };
  UI.inputMode = function () { return mode; };
  UI.setAction = setAction;
  UI.setAction2 = setAction2;
  UI.setHUDVisible = setHUDVisible;
  UI.highlight = highlight;
  UI.hudRect = hudRect;
  UI.on = function (fn) { if (typeof fn === 'function') listeners.push(fn); };
  UI.off = function (fn) { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  UI.loading = loading;
  Object.defineProperty(UI, 'current', { get: function () { return cur ? cur.id : null; }, enumerable: true });
  Object.defineProperty(UI, 'panel', { get: function () { return cur; }, enumerable: false });

  SE.UI = UI;

  /* Static DOM (icons, texts, input mode) is prepared as soon as the document is parsed so the
     loading screen is translated before SE.Game calls init(). */
  function early() {
    cacheHud();
    applyMode(detectMode());
    if (SE.Icons && SE.Icons.mount) SE.Icons.mount(doc);
    if (SE.I18N && SE.I18N.apply) SE.I18N.apply(doc);
    if (!$('loading') || $('loading').style.display === 'none') return;
    loading.startTips();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', early); else early();
})(window);
