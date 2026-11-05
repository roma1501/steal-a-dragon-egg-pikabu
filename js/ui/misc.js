/* =========================================================================
   Steal a Dragon Egg — misc panels (SE.MiscUI): 'settings', 'leaders',
   'result', 'offer', 'boosts', 'upgrade'                 SPEC §7, §8, §10

   Uses SE.UI (core: btn, adButton, open/close) and SE.PanelKit (ui/collection.js:
   art, chips, countUp, in-panel confirm, live loops). Registers as soon as both exist.

   Panel data contracts
     open('result', { win:true,  egg:{species,variant,uid}, cash, gems, hatchery:i|-1 })
         WIN: egg reveal (variant glow + rarity), count-up rewards, where the egg went,
         upgradeEgg offer (SE.Ads.claim('upgradeEgg', { egg, hatchery })) when the egg can
         still be upgraded. «Далее» → SE.Ads.next(close) (double-click safe).
     open('result', { win:false, dragon:'amber'|{species}, lostEgg:{species,variant,uid} })
         LOSE: "Caught!" with the guardian portrait and the lost egg, revive offer
         (SE.Ads.claim('revive', { egg }) — on success the panel closes at once; the game
         keeps the egg and escapes), «Далее» → SE.Ads.next(close).
         The result panel never calls SE.Ads.roundEnded (the game does it once per round).
         Also accepted: data.reward = { cash, gems } (legacy), data.egg for the lost egg.
     open('offer', { id:'cashBonus', ctx, onGranted(ctx), onDone(granted) })
         generic rewarded dialog: icon, title, concrete reward, «Посмотреть рекламу» / «Позже».
     open('boosts')    every Boosts-panel offer (SE.Ads.list) with active timers / cooldowns.
     open('upgrade')   treadmill: level, training rate now → next, price, buy
                       (SE.Game.upgradeTreadmill() or SE.State.buyTreadmillUpgrade()), speedUp ad.
     open('settings')  sound / music / quality / shadows, «Как играть», reset progress
                       (two-step confirm → SE.Game.resetProgress()), version. No language switch.
                       Applies settings via SE.Audio.setSfx/setMusic and SE.Game.applySettings(s)
                       (or SE.Game.setQuality(q, shadows)) when present; saves the state.
     open('leaders')   «Рекорды» via SE.Platform.getLeaderboard(10); only when hasLeaderboard().
   Public: SE.MiscUI = { register(), applySettings() }
   Strings: set.*, res.*, offer.* (panel texts only), msg.* — ru/en/tr.
   ========================================================================= */
(function (global) {
  'use strict';

  var SE = global.SE = global.SE || {};
  var doc = global.document;

  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: {
        'set.title': 'Настройки', 'set.sfx': 'Звуки', 'set.music': 'Музыка', 'set.quality': 'Графика',
        'set.q.auto': 'Авто', 'set.q.high': 'Высокая', 'set.q.medium': 'Средняя', 'set.q.low': 'Низкая',
        'set.shadows': 'Тени', 'set.on': 'Вкл', 'set.off': 'Выкл', 'set.howto': 'Как играть',
        'set.reset': 'Сбросить прогресс', 'set.reset.q': 'Сбросить весь прогресс?',
        'set.reset.text': 'Деньги, драконы, яйца и покупки пропадут навсегда. Это нельзя отменить!',
        'set.reset.ok': 'Сбросить', 'set.version': 'Версия {0}',
        'set.lb.title': 'Рекорды', 'set.lb.loading': 'Загружаем таблицу…', 'set.lb.empty': 'Пока нет рекордов',
        'set.lb.error': 'Не удалось загрузить рекорды', 'set.lb.you': 'Твой рекорд', 'set.lb.rank': 'Место: {0}',
        'set.up.title': 'Беговая дорожка', 'set.up.level': 'Уровень {0}', 'set.up.rate': 'Тренировка',
        'set.up.rateHint': 'Скорость растёт, пока бежишь по дорожке', 'set.up.buy': 'Улучшить',
        'set.up.max': 'Максимальный уровень!', 'set.up.speed': 'Скорость', 'set.up.speedMax': 'Максимум {0}',
        'set.up.need': 'Не хватает {0}', 'set.up.ad': '+{0} скорости',
        'res.winTitle': 'Яйцо добыто!', 'res.loseTitle': 'Пойман!', 'res.next': 'Далее',
        'res.toHatchery': 'Яйцо греется в инкубаторе №{0}', 'res.noSlot': 'Все инкубаторы заняты — открой новый!',
        'res.lostEgg': 'Яйцо вернулось в гнездо', 'res.caughtBy': 'Тебя поймал {0}',
        'res.revive': 'Сбежать с яйцом', 'res.reviveHint': 'Оставь яйцо себе и убегай невидимкой {0} с!',
        'res.upgrade': 'Улучшить яйцо', 'res.rewards': 'Награда',
        'offer.panel.title': 'Бусты', 'offer.active': 'Активно', 'offer.activeNow': 'Сейчас работают',
        'offer.notNeeded': 'Сейчас не нужно', 'offer.later': 'Позже', 'offer.lasts': 'Действует {0}', 'offer.for': 'на {0}',
        'offer.instant': 'Сразу', 'offer.empty': 'Сейчас нет доступных бустов',
        'offer.cat.all': 'Все',
        'msg.reviveOk': 'Спасён! Беги на базу!', 'msg.boostOn': 'Буст включён: {0}', 'msg.upgraded': 'Дорожка улучшена до уровня {0}!',
        'msg.speedUp': '+{0} скорости!'
      },
      en: {
        'set.title': 'Settings', 'set.sfx': 'Sounds', 'set.music': 'Music', 'set.quality': 'Graphics',
        'set.q.auto': 'Auto', 'set.q.high': 'High', 'set.q.medium': 'Medium', 'set.q.low': 'Low',
        'set.shadows': 'Shadows', 'set.on': 'On', 'set.off': 'Off', 'set.howto': 'How to play',
        'set.reset': 'Reset progress', 'set.reset.q': 'Reset all progress?',
        'set.reset.text': 'Cash, dragons, eggs and purchases will be lost forever. This cannot be undone!',
        'set.reset.ok': 'Reset', 'set.version': 'Version {0}',
        'set.lb.title': 'Records', 'set.lb.loading': 'Loading the table…', 'set.lb.empty': 'No records yet',
        'set.lb.error': 'Could not load the records', 'set.lb.you': 'Your record', 'set.lb.rank': 'Rank: {0}',
        'set.up.title': 'Treadmill', 'set.up.level': 'Level {0}', 'set.up.rate': 'Training',
        'set.up.rateHint': 'Your speed grows while you run on the treadmill', 'set.up.buy': 'Upgrade',
        'set.up.max': 'Max level!', 'set.up.speed': 'Speed', 'set.up.speedMax': 'Max {0}',
        'set.up.need': 'You need {0} more', 'set.up.ad': '+{0} speed',
        'res.winTitle': 'Egg stolen!', 'res.loseTitle': 'Caught!', 'res.next': 'Next',
        'res.toHatchery': 'The egg is warming in hatchery #{0}', 'res.noSlot': 'All hatcheries are busy — unlock a new one!',
        'res.lostEgg': 'The egg went back to its nest', 'res.caughtBy': 'Caught by {0}',
        'res.revive': 'Escape with the egg', 'res.reviveHint': 'Keep the egg and run away invisible for {0} s!',
        'res.upgrade': 'Upgrade the egg', 'res.rewards': 'Reward',
        'offer.panel.title': 'Boosts', 'offer.active': 'Active', 'offer.activeNow': 'Active now',
        'offer.notNeeded': 'Not needed right now', 'offer.later': 'Later', 'offer.lasts': 'Lasts {0}', 'offer.for': 'for {0}',
        'offer.instant': 'Instant', 'offer.empty': 'No boosts available right now',
        'offer.cat.all': 'All',
        'msg.reviveOk': 'Saved! Run to your base!', 'msg.boostOn': 'Boost on: {0}', 'msg.upgraded': 'Treadmill upgraded to level {0}!',
        'msg.speedUp': '+{0} speed!'
      },
      tr: {
        'set.title': 'Ayarlar', 'set.sfx': 'Sesler', 'set.music': 'Müzik', 'set.quality': 'Grafik',
        'set.q.auto': 'Otomatik', 'set.q.high': 'Yüksek', 'set.q.medium': 'Orta', 'set.q.low': 'Düşük',
        'set.shadows': 'Gölgeler', 'set.on': 'Açık', 'set.off': 'Kapalı', 'set.howto': 'Nasıl oynanır',
        'set.reset': 'İlerlemeyi sıfırla', 'set.reset.q': 'Tüm ilerleme sıfırlansın mı?',
        'set.reset.text': 'Para, ejderhalar, yumurtalar ve satın alımlar sonsuza dek silinir. Geri alınamaz!',
        'set.reset.ok': 'Sıfırla', 'set.version': 'Sürüm {0}',
        'set.lb.title': 'Rekorlar', 'set.lb.loading': 'Tablo yükleniyor…', 'set.lb.empty': 'Henüz rekor yok',
        'set.lb.error': 'Rekorlar yüklenemedi', 'set.lb.you': 'Senin rekorun', 'set.lb.rank': 'Sıra: {0}',
        'set.up.title': 'Koşu bandı', 'set.up.level': 'Seviye {0}', 'set.up.rate': 'Antrenman',
        'set.up.rateHint': 'Bantta koştukça hızın artar', 'set.up.buy': 'Geliştir',
        'set.up.max': 'En yüksek seviye!', 'set.up.speed': 'Hız', 'set.up.speedMax': 'En fazla {0}',
        'set.up.need': '{0} daha gerekiyor', 'set.up.ad': '+{0} hız',
        'res.winTitle': 'Yumurta çalındı!', 'res.loseTitle': 'Yakalandın!', 'res.next': 'İleri',
        'res.toHatchery': 'Yumurta {0}. kuluçkalıkta ısınıyor', 'res.noSlot': 'Tüm kuluçkalıklar dolu — yenisini aç!',
        'res.lostEgg': 'Yumurta yuvasına döndü', 'res.caughtBy': 'Seni yakalayan: {0}',
        'res.revive': 'Yumurtayla kaç', 'res.reviveHint': 'Yumurtayı koru ve {0} sn görünmez kaç!',
        'res.upgrade': 'Yumurtayı geliştir', 'res.rewards': 'Ödül',
        'offer.panel.title': 'Güçler', 'offer.active': 'Aktif', 'offer.activeNow': 'Şu an aktif',
        'offer.notNeeded': 'Şu an gerekmiyor', 'offer.later': 'Sonra', 'offer.lasts': '{0} sürer', 'offer.for': '{0} boyunca',
        'offer.instant': 'Anında', 'offer.empty': 'Şu anda güç yok',
        'offer.cat.all': 'Tümü',
        'msg.reviveOk': 'Kurtuldun! Üsse koş!', 'msg.boostOn': 'Güç açıldı: {0}', 'msg.upgraded': 'Koşu bandı {0}. seviyeye yükseldi!',
        'msg.speedUp': '+{0} hız!'
      }
    });
  }

  /* Music credit — required by CC BY 4.0 (assets/licenses/audio-incompetech-CC-BY-4.0.txt). */
  if (SE.I18N && SE.I18N.add) {
    SE.I18N.add({
      ru: { 'set.credits.music': 'Музыка: «Monkeys Spinning Monkeys», «Sneaky Snitch», «Run Amok», «Carefree» — Kevin MacLeod (incompetech.com). Лицензия Creative Commons: By Attribution 4.0 (CC BY 4.0, creativecommons.org/licenses/by/4.0)' },
      en: { 'set.credits.music': 'Music: "Monkeys Spinning Monkeys", "Sneaky Snitch", "Run Amok", "Carefree" — Kevin MacLeod (incompetech.com). Licensed under Creative Commons: By Attribution 4.0 (CC BY 4.0, creativecommons.org/licenses/by/4.0)' },
      tr: { 'set.credits.music': 'Müzik: "Monkeys Spinning Monkeys", "Sneaky Snitch", "Run Amok", "Carefree" — Kevin MacLeod (incompetech.com). Lisans: Creative Commons Atıf 4.0 (CC BY 4.0, creativecommons.org/licenses/by/4.0)' }
    });
  }

  function t() { return SE.t ? SE.t.apply(null, arguments) : String(arguments[0]); }
  function K() { return SE.PanelKit; }
  function U() { return SE.UI; }
  function St() { return SE.State; }
  function el(tag, cls, html) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined && html !== null) e.innerHTML = html;
    return e;
  }
  function txt(tag, cls, s) { var e = el(tag, cls); e.textContent = s == null ? '' : String(s); return e; }
  function play(k, o) { try { if (SE.Audio && SE.Audio.play) SE.Audio.play(k, o || {}); } catch (e) { /* optional */ } }
  function save() { try { if (St() && St().save) St().save(); } catch (e) { /* ignore */ } }
  function hud() { try { if (U() && U().updateHUD) U().updateHUD(); } catch (e) { /* ignore */ } }
  function toast(s, type) { try { if (U() && U().toast) U().toast(s, type || 'info'); } catch (e) { /* ignore */ } }
  function adsOn() { return !(SE.Config && SE.Config.ADS === false) && !!SE.Ads; }
  function offer(id) { return SE.Ads && SE.Ads.get ? SE.Ads.get(id) : null; }
  function offerIcon(id) { var k = K(); return k ? k.offerIcon(id) : 'watch-video'; }
  function money(n) { return K() ? K().money(n) : '$' + Math.floor(n); }
  function dur(sec) { return K() ? K().duration(sec) : Math.ceil(sec) + 's'; }
  function clock(sec) { return K() ? K().clock(Math.ceil(sec)) : String(Math.ceil(sec)); }
  function icon(name, cls) { return U() && U().icon ? U().icon(name, cls) : ''; }
  function newRoot(body, cls) { while (body.firstChild) body.removeChild(body.firstChild); var r = el('div', 'pk-root ' + cls); body.appendChild(r); return r; }

  /* ====================================================================== */
  /* settings                                                                */
  /* ====================================================================== */
  function settings() {
    var d = St() && St().data;
    return d && d.settings ? d.settings : { sfx: true, music: true, quality: 'auto', shadows: true };
  }
  function applySettings() {
    var s = settings();
    try {
      if (SE.Audio) {
        if (SE.Audio.setSfx) SE.Audio.setSfx(!!s.sfx);
        if (SE.Audio.setMusic) SE.Audio.setMusic(!!s.music);
      }
    } catch (e) { console.error(e); }
    try {
      var g = SE.Game;
      if (g && typeof g.applySettings === 'function') g.applySettings(s);
      else if (g && typeof g.setQuality === 'function') g.setQuality(s.quality, s.shadows);
    } catch (e) { console.error(e); }
    save();
  }

  function toggleRow(label, iconName, on, onChange) {
    var row = el('div', 'set-row');
    row.appendChild(el('span', 'set-ic', icon(iconName)));
    row.appendChild(txt('span', 'set-lbl', label));
    var sw = el('button', 'set-switch' + (on ? ' on' : ''), '<i></i><b class="set-on"></b><b class="set-off"></b>');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.setAttribute('aria-label', label);
    sw.querySelector('.set-on').textContent = t('set.on');
    sw.querySelector('.set-off').textContent = t('set.off');
    sw.addEventListener('click', function () {
      on = !on;
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      onChange(on);
      play('toggle');
    });
    row.appendChild(sw);
    return row;
  }

  function renderSettings(body) {
    var root = newRoot(body, 'set-root');
    var s = settings();
    var box = el('div', 'set-list');
    box.appendChild(toggleRow(t('set.sfx'), 'svg/sound', s.sfx !== false, function (on) { s.sfx = on; applySettings(); }));
    box.appendChild(toggleRow(t('set.music'), 'svg/music', s.music !== false, function (on) { s.music = on; applySettings(); }));
    var q = el('div', 'set-row set-row-q');
    q.appendChild(el('span', 'set-ic', icon('sparkles')));
    q.appendChild(txt('span', 'set-lbl', t('set.quality')));
    var seg = el('div', 'set-seg');
    seg.setAttribute('role', 'radiogroup');
    ['auto', 'high', 'medium', 'low'].forEach(function (k) {
      var b = txt('button', 'set-seg-b' + (s.quality === k ? ' on' : ''), t('set.q.' + k));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', s.quality === k ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (s.quality === k) return;
        s.quality = k;
        [].forEach.call(seg.children, function (c) { c.classList.toggle('on', c === b); c.setAttribute('aria-checked', c === b ? 'true' : 'false'); });
        play('tab');
        applySettings();
      });
      seg.appendChild(b);
    });
    q.appendChild(seg);
    box.appendChild(q);
    box.appendChild(toggleRow(t('set.shadows'), 'svg/info', s.shadows !== false, function (on) { s.shadows = on; applySettings(); }));
    var sh = box.lastChild.querySelector('.set-ic');
    if (sh) sh.innerHTML = '<span class="set-shadow-ic"></span>';
    root.appendChild(box);

    var acts = el('div', 'set-acts');
    acts.appendChild(U().btn(t('set.howto'), 'blue', function () {
      U().close();
      if (U().showPause) U().showPause(false);
      if (SE.Tutorial && typeof SE.Tutorial.start === 'function') { try { SE.Tutorial.start(true); } catch (e) { console.error(e); } }
    }, { icon: 'question' }));
    acts.appendChild(U().btn(t('set.reset'), 'red small', function () {
      var k = K();
      var ask = k ? k.confirm(root, { title: t('set.reset.q'), text: t('set.reset.text'), ok: t('set.reset.ok'), danger: true, icon: 'render/lock', delay: 3000 })
        : U().confirm({ title: t('set.reset.q'), text: t('set.reset.text'), yes: t('set.reset.ok'), danger: true });
      ask.then(function (yes) {
        if (!yes) return;
        U().close();
        if (U().showPause) U().showPause(false);
        if (SE.Game && typeof SE.Game.resetProgress === 'function') SE.Game.resetProgress();
        else if (St()) { St().reset(); St().save(); global.location.reload(); }
      });
    }));
    root.appendChild(acts);
    var ver = (SE.Config && SE.Config.VERSION) || '1.0.0';
    root.appendChild(txt('div', 'set-ver', t('set.version', ver) + ' · ' + ((SE.Platform && SE.Platform.id) || (SE.Config && SE.Config.PLATFORM) || 'local')));
    var credit = txt('div', 'set-ver set-credits', t('set.credits.music'));
    credit.style.cssText = 'font-weight:700;font-size:11px;margin-top:4px;opacity:.85';
    root.appendChild(credit);
  }

  /* ====================================================================== */
  /* leaders                                                                 */
  /* ====================================================================== */
  function renderLeaders(body) {
    var root = newRoot(body, 'lb-root');
    var box = el('div', 'lb-box');
    box.appendChild(el('div', 'lb-wait', '<span class="spinner"></span><span></span>'));
    box.lastChild.lastChild.textContent = t('set.lb.loading');
    root.appendChild(box);
    var P = SE.Platform;
    if (!P || typeof P.getLeaderboard !== 'function' || !(P.hasLeaderboard && P.hasLeaderboard())) {
      box.innerHTML = '';
      box.appendChild(txt('div', 'pn-empty', t('set.lb.empty')));
      return;
    }
    var my = St() && St().data ? (St().computeScore ? St().computeScore() : St().data.score) : 0;
    Promise.resolve().then(function () { return P.getLeaderboard(10); }).then(function (res) {
      if (!root.isConnected) return;
      box.innerHTML = '';
      var rows = res && Array.isArray(res.entries) ? res.entries : [];
      if (!rows.length) { box.appendChild(txt('div', 'pn-empty', t('set.lb.empty'))); return; }
      var list = el('ol', 'lb-list');
      rows.forEach(function (r, i) {
        var rank = r.rank || i + 1;
        var li = el('li', 'lb-row' + (rank <= 3 ? ' lb-top lb-top' + rank : '') + (r.isUser ? ' is-me' : ''));
        li.appendChild(el('span', 'lb-rank', rank <= 3 ? icon('render/crown', 'lb-crown') + '<b>' + rank + '</b>' : '<b>' + rank + '</b>'));
        var name = (r.player && (r.player.publicName || r.player.name)) || '—';
        li.appendChild(txt('span', 'lb-name', name));
        li.appendChild(txt('span', 'lb-score', K() ? K().fmt(r.score || 0) : String(r.score || 0)));
        list.appendChild(li);
      });
      box.appendChild(list);
      var me = el('div', 'lb-me');
      me.appendChild(txt('span', 'lb-me-l', t('set.lb.you')));
      me.appendChild(txt('b', 'lb-me-v', K() ? K().fmt(my) : String(my)));
      if (res.userRank) me.appendChild(txt('span', 'lb-me-r', t('set.lb.rank', res.userRank)));
      root.appendChild(me);
    }).catch(function () {
      if (!root.isConnected) return;
      box.innerHTML = '';
      box.appendChild(txt('div', 'pn-empty', t('set.lb.error')));
    });
  }

  /* ====================================================================== */
  /* result                                                                  */
  /* ====================================================================== */
  var resBusy = false;
  function speciesOf(x) {
    if (!x) return null;
    if (typeof x === 'string') return x;
    return x.species && typeof x.species === 'string' ? x.species : (x.species && x.species.id) || x.id || null;
  }
  function renderResult(body, data, panel) {
    data = data || {};
    resBusy = false;
    var k = K(), D = SE.DragonData;
    var win = !!data.win;
    var root = newRoot(body, 'res-root ' + (win ? 'res-win' : 'res-lose'));
    panel.setTitle(t(win ? 'res.winTitle' : 'res.loseTitle'));
    panel.setIcon(win ? 'trophy' : null);
    panel.win.classList.toggle('res-lose-panel', !win);
    var ribbon = panel.win.querySelector('.panel-ribbon');
    if (ribbon) ribbon.classList.toggle('danger', !win);
    var egg = data.egg || data.lostEgg || null;
    var reward = data.reward || {};
    var cash = data.cash != null ? data.cash : (reward.cash || reward.money || 0);
    var gems = data.gems != null ? data.gems : (reward.gems || 0);

    var stage = el('div', 'res-stage');
    stage.appendChild(el('span', 'pk-rays res-rays'));
    if (win && egg && k && D) {
      var v = egg.variant | 0;
      stage.classList.add('pk-v' + v);
      stage.style.setProperty('--vc', D.variant(v).color);
      stage.style.setProperty('--rc', D.rarityColor(egg.species));
      stage.appendChild(k.art('egg', egg.species, v, { size: 256, cls: 'res-egg' }));
      root.appendChild(stage);
      var nm = el('div', 'res-name');
      nm.appendChild(txt('div', 'res-title', D.fullEggName ? D.fullEggName(egg.species, v) : D.eggName(egg.species)));
      var tags = el('div', 'res-tags');
      tags.appendChild(k.rarityTag(egg.species));
      if (v > 0) tags.appendChild(k.variantTag(v));
      nm.appendChild(tags);
      root.appendChild(nm);
      var rw = el('div', 'res-rewards');
      if (cash > 0) {
        var c = k.cash(0, 'res-chip');
        rw.appendChild(c);
        k.countUp(c.querySelector('.pk-num'), cash, 900, k.fmt, function () { play('coin', { volume: 0.6 }); });
      }
      if (gems > 0) {
        var g = k.gem(0, 'res-chip');
        rw.appendChild(g);
        setTimeout(function () { k.countUp(g.querySelector('.pk-num'), gems, 700, k.fmt, function () { play('gem', { volume: 0.6 }); }); }, 250);
      }
      if (rw.firstChild) root.appendChild(rw);
      var where = typeof data.hatchery === 'number' ? data.hatchery : (typeof data.slot === 'number' ? data.slot : null);
      if (where !== null) root.appendChild(txt('div', 'res-note' + (where < 0 ? ' is-warn' : ''), where >= 0 ? t('res.toHatchery', where + 1) : t('res.noSlot')));
      if (adsOn() && v < D.VARIANTS.length - 1 && SE.Ads.available && SE.Ads.available('upgradeEgg', { egg: egg, hatchery: where >= 0 ? where : undefined })) {
        var up = el('div', 'res-offer');
        up.appendChild(el('span', 'res-offer-ic', icon('sparkles')));
        var ut = el('div', 'res-offer-t');
        ut.appendChild(txt('b', '', t('res.upgrade')));
        ut.appendChild(txt('span', '', SE.Ads.desc ? SE.Ads.desc('upgradeEgg', { egg: egg }) : ''));
        up.appendChild(ut);
        up.appendChild(U().adButton({
          placement: 'upgradeEgg', ctx: { egg: egg, hatchery: where >= 0 ? where : undefined }, cls: 'purple small',
          onDone: function (ok) { if (ok && root.isConnected) { var e2 = findEgg(egg) || egg; renderResult(body, Object.assign({}, data, { egg: e2 }), panel); play('levelup'); } }
        }));
        root.appendChild(up);
      }
    } else {
      var sp = speciesOf(data.dragon) || (egg && egg.species) || 'meadow';
      stage.classList.add('res-caught');
      if (k) stage.appendChild(k.art('adult', sp, 0, { size: 256, cls: 'res-dragon', noModel: true }));
      if (egg && k) {
        var lost = el('span', 'res-lost');
        lost.appendChild(k.art('egg', egg.species, egg.variant | 0, { size: 128, cls: 'res-lost-egg', noModel: true }));
        lost.appendChild(el('span', 'res-lost-x', icon('svg/close')));
        stage.appendChild(lost);
      }
      root.appendChild(stage);
      var nm2 = el('div', 'res-name');
      nm2.appendChild(txt('div', 'res-title', D ? t('res.caughtBy', D.name(sp)) : ''));
      if (egg) nm2.appendChild(txt('div', 'res-sub', t('res.lostEgg')));
      root.appendChild(nm2);
      if (adsOn() && egg && (!SE.Ads.available || SE.Ads.available('revive', { egg: egg }))) {
        var rv = el('div', 'res-offer res-offer-revive');
        rv.appendChild(el('span', 'res-offer-ic', icon('heart')));
        var rt = el('div', 'res-offer-t');
        rt.appendChild(txt('b', '', t('res.revive')));
        var secs = SE.Ads.REWARD && SE.Ads.REWARD.reviveSecs ? SE.Ads.REWARD.reviveSecs : 20;
        rt.appendChild(txt('span', '', t('res.reviveHint', secs)));
        rv.appendChild(rt);
        rv.appendChild(U().adButton({
          placement: 'revive', ctx: { egg: egg }, cls: 'green',
          onDone: function (ok) { if (ok) { resBusy = true; toast(t('msg.reviveOk'), 'good'); U().close('result'); } }
        }));
        root.appendChild(rv);
      }
    }
    var next = U().btn(t('res.next'), 'green big res-next', function () {
      if (resBusy) return;
      resBusy = true;
      next.setAttribute('aria-disabled', 'true');
      var go = function () { U().close('result'); };
      if (SE.Ads && typeof SE.Ads.next === 'function') SE.Ads.next(go); else go();
    }, { icon: 'svg/arrow-right' });
    panel.setFooter(next);
    play(win ? 'win' : 'caught', { volume: 0.8 });
  }
  function findEgg(egg) {
    var d = St() && St().data;
    if (!d || !egg || !egg.uid) return null;
    for (var i = 0; i < d.hatcheries.length; i++) if (d.hatcheries[i].egg && d.hatcheries[i].egg.uid === egg.uid) return d.hatcheries[i].egg;
    return SE.Game && SE.Game.carrying && SE.Game.carrying.uid === egg.uid ? SE.Game.carrying : null;
  }

  /* ====================================================================== */
  /* offer (generic rewarded dialog)                                         */
  /* ====================================================================== */
  function renderOffer(body, data, panel) {
    data = data || {};
    var id = data.id || data.offer || 'cashBonus';
    var o = offer(id) || {};
    var root = newRoot(body, 'of-root');
    panel.setTitle(data.title || (SE.Ads && SE.Ads.title ? SE.Ads.title(id) : t('offer.panel.title')));
    var stage = el('div', 'of-stage');
    stage.appendChild(el('span', 'pk-rays'));
    stage.appendChild(el('span', 'of-ic', icon(data.icon || offerIcon(id))));
    root.appendChild(stage);
    root.appendChild(txt('p', 'of-desc', data.text || (SE.Ads && SE.Ads.desc ? SE.Ads.desc(id, data.ctx) : '')));
    if (o.dur > 0) root.appendChild(el('div', 'of-dur', icon('svg/clock') + '<b></b>')).lastChild.textContent = t('offer.lasts', dur(o.dur));   // a duration, not a wait
    var ad = U().adButton({
      placement: id, ctx: data.ctx || null, labelKey: 'btn.watchAdLong', cls: 'purple big',
      onGranted: typeof data.onGranted === 'function' ? data.onGranted : undefined,
      onDone: function (ok) {
        if (typeof data.onDone === 'function') { try { data.onDone(ok); } catch (e) { console.error(e); } }
        if (ok) { U().close('offer'); }
      }
    });
    panel.setFooter([U().btn(t('offer.later'), 'grey', function () { U().close('offer'); }), ad]);
  }

  /* ====================================================================== */
  /* boosts                                                                  */
  /* ====================================================================== */
  function boostSig() {
    var l = SE.Boosts && SE.Boosts.list ? SE.Boosts.list() : [];
    return l.map(function (b) { return b.id; }).sort().join(',');
  }
  function renderBoosts(body, data, panel) {
    var k = K();
    var root = newRoot(body, 'bo-root');
    var sig = boostSig();
    var active = SE.Boosts && SE.Boosts.list ? SE.Boosts.list().filter(function (b) { return b.left > 0; }) : [];
    if (active.length) {
      var act = el('div', 'bo-active');
      act.appendChild(txt('div', 'bo-active-t', t('offer.activeNow')));
      var strip = el('div', 'bo-strip');
      active.forEach(function (b) {
        var c = el('div', 'bo-chip', icon(offerIcon(b.id), 'bo-chip-ic') + '<span class="bo-chip-n"></span><b class="bo-chip-t" data-boost="' + b.id + '"></b>');
        c.querySelector('.bo-chip-n').textContent = SE.Ads && SE.Ads.title ? SE.Ads.title(b.id) : b.id;
        c.querySelector('.bo-chip-t').textContent = clock(b.left);
        strip.appendChild(c);
      });
      act.appendChild(strip);
      root.appendChild(act);
    }
    var list = adsOn() && SE.Ads.list ? SE.Ads.list(function (o) { return o.panel; }) : [];
    var grid = el('div', 'bo-grid');
    if (!list.length) grid.appendChild(txt('div', 'pn-empty', t('offer.empty')));
    list.sort(function (a, b) {
      var av = SE.Ads.available(a.id) ? 0 : 1, bv = SE.Ads.available(b.id) ? 0 : 1;
      return av - bv;
    });
    list.forEach(function (o) {
      var avail = !SE.Ads.available || SE.Ads.available(o.id);
      var on = SE.Boosts && SE.Boosts.isActive && SE.Boosts.isActive(o.id);
      var card = el('div', 'bo-card bo-cat-' + o.cat + (avail ? '' : ' is-na') + (on ? ' is-on' : ''));
      card.appendChild(el('span', 'bo-ic', icon(offerIcon(o.id))));
      var info = el('div', 'bo-info');
      info.appendChild(txt('b', 'bo-title', SE.Ads.title(o.id)));
      info.appendChild(txt('span', 'bo-desc', SE.Ads.desc(o.id)));
      card.appendChild(info);
      var meta = el('div', 'bo-meta');
      if (on) meta.appendChild(el('span', 'bo-on', '<span></span><b data-boost="' + o.id + '"></b>'));
      else meta.appendChild(txt('span', 'bo-dur', o.dur > 0 ? dur(o.dur) : t('offer.instant')));
      if (on) { meta.firstChild.firstChild.textContent = t('offer.active'); meta.firstChild.lastChild.textContent = clock(SE.Boosts.remaining(o.id)); }
      card.appendChild(meta);
      if (avail) card.appendChild(U().adButton({ placement: o.id, cls: 'purple small bo-btn', onDone: function (ok) { if (ok && root.isConnected) { toast(t('msg.boostOn', SE.Ads.title(o.id)), 'good'); renderBoosts(body, data, panel); } } }));
      else card.appendChild(txt('span', 'bo-na', t('offer.notNeeded')));
      grid.appendChild(card);
    });
    root.appendChild(grid);
    if (k) k.loop('boosts', root, function () {
      if (boostSig() !== sig) { renderBoosts(body, data, panel); return; }
      [].forEach.call(root.querySelectorAll('[data-boost]'), function (n) { n.textContent = clock(SE.Boosts.remaining(n.getAttribute('data-boost'))); });
    }, 1000);
  }

  /* ====================================================================== */
  /* upgrade (treadmill)                                                     */
  /* ====================================================================== */
  function renderUpgrade(body, data, panel) {
    var S = St(), k = K();
    var root = newRoot(body, 'up-root');
    if (!S || !S.data) { root.appendChild(txt('div', 'pn-empty', '…')); return; }
    var lvl = S.treadmillLevel ? S.treadmillLevel() : S.data.treadmill;
    var price = S.treadmillUpgradePrice ? S.treadmillUpgradePrice() : null;
    var rate = function (l) { return S.trainRate ? S.trainRate(true, l) : 0; };
    var head = el('div', 'up-head');
    head.appendChild(el('span', 'up-ic', icon('shoe')));
    var ht = el('div', 'up-ht');
    ht.appendChild(txt('b', 'up-name', t('set.up.title')));
    ht.appendChild(txt('span', 'up-hint', t('set.up.rateHint')));
    head.appendChild(ht);
    root.appendChild(head);

    var cmp = el('div', 'up-cmp');
    function lv(l, cls) {
      var c = el('div', 'up-lv ' + cls);
      c.appendChild(txt('span', 'up-lv-l', t('set.up.level', l)));
      c.appendChild(txt('b', 'up-lv-v', '+' + (Math.round(rate(l) * 100) / 100) + t('time.perSec')));
      c.appendChild(txt('span', 'up-lv-s', t('set.up.rate')));
      return c;
    }
    cmp.appendChild(lv(lvl, 'is-now'));
    if (price !== null) {
      cmp.appendChild(el('span', 'up-arrow', icon('svg/arrow-right')));
      cmp.appendChild(lv(lvl + 1, 'is-next'));
    }
    root.appendChild(cmp);

    var sp = el('div', 'up-speed');
    var max = S.MAX_SPEED || 500;
    sp.appendChild(el('span', 'up-speed-ic', icon('lightning')));
    sp.appendChild(txt('span', 'up-speed-l', t('set.up.speed')));
    var b = el('span', 'pk-bar up-speed-bar', '<span class="pk-bar-fill"></span>');
    b.firstChild.style.width = Math.min(100, S.data.speed / max * 100).toFixed(1) + '%';
    sp.appendChild(b);
    sp.appendChild(txt('b', 'up-speed-v', Math.floor(S.data.speed) + ' / ' + max));
    root.appendChild(sp);

    var foot = [];
    if (price === null) {
      root.appendChild(txt('div', 'up-max', t('set.up.max')));
    } else {
      var afford = S.canAfford(price);
      var buy = U().btn(money(price) + ' · ' + t('set.up.buy'), 'green big up-buy', function () {
        if (!S.canAfford(price)) { play('error'); toast(t('set.up.need', money(price - S.data.money)), 'error'); return; }
        var ok = false;
        if (SE.Game && typeof SE.Game.upgradeTreadmill === 'function') { var r = SE.Game.upgradeTreadmill(); ok = r !== false; }
        else { ok = S.buyTreadmillUpgrade ? !!S.buyTreadmillUpgrade() : false; if (ok) { play('levelup'); toast(t('msg.upgraded', S.treadmillLevel()), 'good'); save(); } }
        hud();
        if (root.isConnected) renderUpgrade(body, data, panel);
      }, { icon: 'svg/arrow-up', sound: 'click' });
      if (!afford) { buy.classList.add('is-off'); buy.title = t('set.up.need', money(price - S.data.money)); }
      foot.push(buy);
    }
    if (adsOn() && (!SE.Ads.available || SE.Ads.available('speedUp'))) {
      var amt = SE.Ads.REWARD && SE.Ads.REWARD.speedUp ? SE.Ads.REWARD.speedUp : 15;
      foot.push(U().adButton({ placement: 'speedUp', cls: 'purple', reward: t('set.up.ad', amt), onDone: function (ok) { if (ok) { toast(t('msg.speedUp', amt), 'good'); if (root.isConnected) renderUpgrade(body, data, panel); } } }));
    }
    panel.setFooter(foot);
  }

  /* ====================================================================== */
  /* registration                                                            */
  /* ====================================================================== */
  var registered = false;
  function register() {
    if (registered) return true;
    if (!SE.UI || typeof SE.UI.registerPanel !== 'function' || !SE.PanelKit) return false;
    registered = true;
    var R = SE.UI.registerPanel;
    R('settings', { titleKey: 'set.title', icon: 'gear', size: 's', render: function (b) { renderSettings(b); } });
    R('leaders', { titleKey: 'set.lb.title', icon: 'trophy', size: 's', render: function (b) { renderLeaders(b); } });
    R('result', {
      titleKey: 'res.winTitle', icon: 'trophy', size: 'm', closable: true, backdropClose: false, cls: 'res-panel',
      render: function (b, d, p) { renderResult(b, d, p); }
    });
    R('offer', { titleKey: 'offer.panel.title', icon: 'watch-video', size: 's', render: function (b, d, p) { renderOffer(b, d, p); } });
    R('boosts', {
      titleKey: 'offer.panel.title', icon: 'lightning', size: 'l', render: function (b, d, p) { renderBoosts(b, d, p); },
      onClose: function () { if (K()) K().stop('boosts'); }
    });
    R('upgrade', { titleKey: 'set.up.title', icon: 'shoe', size: 's', render: function (b, d, p) { renderUpgrade(b, d, p); } });
    return true;
  }

  SE.MiscUI = { register: register, applySettings: applySettings, render: { settings: renderSettings, leaders: renderLeaders, result: renderResult, offer: renderOffer, boosts: renderBoosts, upgrade: renderUpgrade } };

  if (!register()) {
    var tries = 0;
    var iv = setInterval(function () { if (register() || ++tries > 200) clearInterval(iv); }, 50);
  }
})(window);
